import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { b58encode } from "./chain.mjs";
import { VENUES } from "./prices.mjs";
import { priceMessage, publisherKey, quoter, server, SETTLE_NS, signerOf } from "./publisher.mjs";

const OBSERVATION = 1_793_135_160n * 1_000_000_000n;

function secretOf(seed) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seed)]), format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return "ed25519:" + b58encode(Buffer.concat([Buffer.alloc(32, seed), publicKey]));
}

function chain(options) {
  const { publishers, markets = ["market.near"], priceRule = { observation_time: String(OBSERVATION), strike: "8000000", decimals: 2, above: true }, source = "Median of BTC-USD one minute closes on Coinbase, Kraken and Bitstamp" } = options;
  const views = {
    config: () => ({ markets, publishers, network: "mainnet" }),
    get_market_info: () => (priceRule === null ? { price_rule: null } : { price_rule: priceRule }),
    get_market: () => ({ id: "7", resolution_source: source }),
  };
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const result = method === "block"
        ? { header: { timestamp_nanosec: String(options.now ?? OBSERVATION + SETTLE_NS), height: 10, hash: "11111111111111111111111111111111" } }
        : { result: [...Buffer.from(JSON.stringify(views[params.method_name]()))] };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "keeper", result }));
    });
  });
}

function exchanges(closes) {
  const minute = 1_793_135_160;
  const bodies = {
    coinbase: [[minute - 60, 0, 0, 0, closes.coinbase, 1]],
    kraken: { error: [], result: { XXBTZUSD: [[minute - 60, "0", "0", "0", closes.kraken, "0", "1", 3]], last: minute } },
    bitstamp: { data: { ohlc: [{ timestamp: String(minute - 60), close: closes.bitstamp, volume: "1" }] } },
  };
  let calls = 0;
  const fetch = async (url) => {
    calls++;
    const venue = Object.keys(VENUES).find((v) => url.startsWith(VENUES[v]));
    if (closes[venue] === null) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => bodies[venue] };
  };
  return { fetch, calls: () => calls };
}

async function withChain(options, run) {
  const rpcServer = chain(options);
  await new Promise((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${rpcServer.address().port}`);
  } finally {
    rpcServer.close();
  }
}

const key = publisherKey(secretOf(7));
const CLOSES = { coinbase: 80646.07, kraken: "80652.6", bitstamp: "80653.19" };

test("a publisher key signs, the signature checks out under its public key, and a tampered one does not", () => {
  const entry = key.sign("price:v2:oracle.near:mainnet:market.near:7:1:2:3");
  assert.equal(signerOf(entry, "price:v2:oracle.near:mainnet:market.near:7:1:2:3"), key.publicKey);
  assert.equal(signerOf(entry, "price:v2:oracle.near:mainnet:market.near:7:1:9:3"), null, "another price");
  assert.equal(signerOf(entry.replace(/.$/, (c) => (c === "0" ? "1" : "0")), "price:v2:oracle.near:mainnet:market.near:7:1:2:3"), null, "a changed byte");
  for (const bad of ["", "nodot", `${key.publicKey}.zz`, `ed25519:abc.${"0".repeat(128)}`, `secp256k1:abc.${"0".repeat(128)}`]) {
    assert.equal(signerOf(bad, "m"), null, bad);
  }
});

test("a secret key whose public half is not its seed's is refused, as is anything but 64 bytes", () => {
  const raw = secretOf(7).slice("ed25519:".length);
  assert.throws(() => publisherKey("ed25519:" + b58encode(Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(32, 1)]))), /does not match its seed/);
  assert.throws(() => publisherKey("ed25519:" + raw.slice(0, 20)), /must be an ed25519 secret key/);
});

test("the signed text is the oracle's price:v2 message", () => {
  assert.equal(
    priceMessage({ oracle: "oracle.near", network: "mainnet", market: "market.near", marketId: "7", observationTime: "100", price: "8065260", decimals: 2 }),
    "price:v2:oracle.near:mainnet:market.near:7:100:8065260:2",
  );
});

test("a settled price market is priced from the exchanges, signed over the oracle's message, and kept once all exchanges agree", async () => {
  const venues = exchanges(CLOSES);
  await withChain({ publishers: [key.publicKey] }, async (rpcUrl) => {
    const quote = quoter({ rpcUrl, oracle: "oracle.near", key, venues: VENUES, fetch: venues.fetch });
    const first = await quote("market.near", "7");
    assert.deepEqual({ ...first, signature: undefined }, {
      market: "market.near", market_id: "7", pair: "BTC-USD", observation_time: String(OBSERVATION), decimals: 2, price: "8065260", sources: 3, signature: undefined,
    });
    const message = priceMessage({ oracle: "oracle.near", network: "mainnet", market: "market.near", marketId: "7", observationTime: String(OBSERVATION), price: "8065260", decimals: 2 });
    assert.equal(signerOf(first.signature, message), key.publicKey);
    assert.deepEqual(await quote("market.near", "7"), first);
    assert.equal(venues.calls(), 3, "the second answer comes from the kept quote");
  });
});

test("one market gets one signature, even when the exchanges move or only some answered the first time", async () => {
  let venues = exchanges({ ...CLOSES, kraken: null });
  await withChain({ publishers: [key.publicKey] }, async (rpcUrl) => {
    const quote = quoter({ rpcUrl, oracle: "oracle.near", key, venues: VENUES, fetch: (url) => venues.fetch(url) });
    const first = await quote("market.near", "7");
    assert.equal(first.sources, 2);
    venues = exchanges({ coinbase: 90000, kraken: "90010", bitstamp: "90020" });
    assert.deepEqual(await quote("market.near", "7"), first);
    assert.equal((await quote("market.near", "7")).signature, first.signature);
  });
});

const tempPriceFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "publisher-")), "prices.json");

test("a restarted publisher returns the signature it saved, even after prices changed", async () => {
  const priceFile = tempPriceFile();
  await withChain({ publishers: [key.publicKey] }, async (rpcUrl) => {
    const before = quoter({ rpcUrl, oracle: "oracle.near", key, venues: VENUES, fetch: exchanges(CLOSES).fetch, priceFile });
    const first = await before("market.near", "7");
    const moved = exchanges({ coinbase: 90000, kraken: "90010", bitstamp: "90020" });
    const after = quoter({ rpcUrl, oracle: "oracle.near", key, venues: VENUES, fetch: moved.fetch, priceFile });
    assert.deepEqual(await after("market.near", "7"), first);
    assert.equal(moved.calls(), 0);
    assert.equal(fs.existsSync(`${priceFile}.tmp`), false);
  });
});

test("a corrupt or unreadable price file stops the publisher instead of signing again", () => {
  const priceFile = tempPriceFile();
  const make = () => quoter({ rpcUrl: "http://127.0.0.1:1", oracle: "oracle.near", key, venues: VENUES, fetch: exchanges(CLOSES).fetch, priceFile });
  for (const content of ["{not json", "[]", JSON.stringify({ "market.near:7": { market: "market.near", market_id: "8", price: "1", signature: "x" } })]) {
    fs.writeFileSync(priceFile, content);
    assert.throws(make, /is not a publisher price file/);
  }
  fs.rmSync(priceFile);
  fs.mkdirSync(priceFile);
  assert.throws(make, /EISDIR/);
});

test("two requests arriving together share one signing", async () => {
  const venues = exchanges(CLOSES);
  await withChain({ publishers: [key.publicKey] }, async (rpcUrl) => {
    const quote = quoter({ rpcUrl, oracle: "oracle.near", key, venues: VENUES, fetch: venues.fetch });
    const [a, b] = await Promise.all([quote("market.near", "7"), quote("market.near", "7")]);
    assert.equal(a.signature, b.signature);
    assert.equal(venues.calls(), 3);
  });
});

test("a refused request is not kept, so the next one can sign", async () => {
  const state = { publishers: [key.publicKey], now: OBSERVATION + SETTLE_NS - 1n };
  const rpcServer = chain(state);
  await new Promise((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
  try {
    const quote = quoter({ rpcUrl: `http://127.0.0.1:${rpcServer.address().port}`, oracle: "oracle.near", key, venues: VENUES, fetch: exchanges(CLOSES).fetch });
    await assert.rejects(quote("market.near", "7"), (e) => e.status === 425);
    state.now = OBSERVATION + SETTLE_NS;
    assert.equal((await quote("market.near", "7")).sources, 3);
  } finally {
    rpcServer.close();
  }
});

test("the publisher refuses what it cannot or must not sign, each with its own status", async () => {
  const cases = [
    [{ now: OBSERVATION + SETTLE_NS - 1n }, 425, /not final yet/],
    [{ markets: ["other.near"] }, 404, /is not a market oracle.near serves/],
    [{ publishers: ["ed25519:somebody"] }, 503, /is not a publisher on oracle.near/],
    [{ priceRule: null }, 404, /is not a price market/],
    [{ source: "Median of three exchanges" }, 422, /must name exactly one pair/],
  ];
  for (const [options, status, reason] of cases) {
    await withChain({ publishers: [key.publicKey], ...options }, async (rpcUrl) => {
      const quote = quoter({ rpcUrl, oracle: "oracle.near", key, venues: VENUES, fetch: exchanges(CLOSES).fetch });
      await assert.rejects(quote("market.near", "7"), (e) => e.status === status && reason.test(e.message));
    });
  }
  await withChain({ publishers: [key.publicKey] }, async (rpcUrl) => {
    const quote = quoter({ rpcUrl, oracle: "oracle.near", key, venues: VENUES, fetch: exchanges({ ...CLOSES, kraken: "90000" }).fetch });
    await assert.rejects(quote("market.near", "7"), (e) => e.status === 503 && /bps apart/.test(e.message));
  });
});

test("the server answers GET /price with the quote, and refuses other paths and malformed requests before quoting", async () => {
  const asked = [];
  const listening = server(async (market, id) => {
    asked.push([market, id]);
    if (id === "9") throw Object.assign(new Error("too early"), { status: 425 });
    return { price: "1" };
  });
  await new Promise((resolve) => listening.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${listening.address().port}`;
  try {
    const get = async (path) => {
      const res = await fetch(base + path);
      return [res.status, await res.json()];
    };
    assert.deepEqual(await get("/price?market=market.near&id=7"), [200, { price: "1" }]);
    assert.deepEqual(await get("/price?market=market.near&id=9"), [425, { error: "too early" }]);
    assert.equal((await get("/price?market=Market.near&id=7"))[0], 400);
    assert.equal((await get("/price?market=market.near&id=-1"))[0], 400);
    assert.equal((await get("/price?market=market.near"))[0], 400);
    assert.equal((await get("/sign?market=market.near&id=7"))[0], 404);
    assert.deepEqual(asked, [["market.near", "7"], ["market.near", "9"]]);
  } finally {
    listening.close();
  }
});
