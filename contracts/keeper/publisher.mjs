#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { b58decode, b58encode, rpc, view } from "./chain.mjs";
import { options, readKeyFile } from "./keeper.mjs";
import { pairIn, priceAt, VENUES } from "./prices.mjs";

export const SETTLE_NS = 120n * 10n ** 9n;
const ACCOUNT_ID = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

export function priceMessage({ oracle, network, market, marketId, observationTime, price, decimals }) {
  return `price:v2:${oracle}:${network}:${market}:${marketId}:${observationTime}:${price}:${decimals}`;
}

export function publisherKey(secret) {
  const raw = b58decode(secret.replace(/^ed25519:/, ""));
  if (raw.length !== 64) throw new Error("the publisher key must be an ed25519 secret key");
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const derived = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  if (!derived.equals(raw.subarray(32))) throw new Error("the publisher key's public half does not match its seed");
  const publicKey = "ed25519:" + b58encode(derived);
  return { publicKey, sign: (message) => `${publicKey}.${crypto.sign(null, Buffer.from(message), key).toString("hex")}` };
}

export function signerOf(entry, message) {
  const dot = entry.lastIndexOf(".");
  const publicKey = entry.slice(0, dot);
  const signature = entry.slice(dot + 1);
  if (dot < 0 || !/^[0-9a-f]{128}$/.test(signature) || !publicKey.startsWith("ed25519:")) return null;
  const raw = b58decode(publicKey.slice("ed25519:".length));
  if (raw.length !== 32) return null;
  const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature, "hex")) ? publicKey : null;
}

function refusal(status, message) {
  return Object.assign(new Error(message), { status });
}

async function refusing(status, work) {
  try {
    return await work();
  } catch (e) {
    throw refusal(status, e.message);
  }
}

export const DEFAULT_PRICE_FILE = "publisher-prices.json";

export function loadSigned(file) {
  if (!fs.existsSync(file)) return {};
  const fail = (why) => new Error(`${file} is not a publisher price file (${why}); refusing to start rather than sign a market twice. Fix or move the file`);
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw fail(e.message);
  }
  if (saved === null || typeof saved !== "object" || Array.isArray(saved)) throw fail("expected an object keyed by market:id");
  for (const [cacheKey, quote] of Object.entries(saved)) {
    if (quote?.market === undefined || `${quote.market}:${quote.market_id}` !== cacheKey || typeof quote.signature !== "string" || typeof quote.price !== "string") {
      throw fail(`the entry ${cacheKey} is not a signed quote`);
    }
  }
  return saved;
}

function saveSigned(file, entries) {
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(entries) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(path.resolve(file)), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

export function quoter({ rpcUrl, oracle, key, venues, fetch, priceFile }) {
  const kept = priceFile ? loadSigned(priceFile) : {};
  const signed = new Map(Object.entries(kept).map(([cacheKey, quote]) => [cacheKey, Promise.resolve(quote)]));
  const persist = (cacheKey, quote) => {
    if (!priceFile) return;
    kept[cacheKey] = quote;
    saveSigned(priceFile, kept);
  };

  async function sign(market, marketId) {
    const config = await view(rpcUrl, oracle, "config");
    if (!config.markets.includes(market)) throw refusal(404, `${market} is not a market ${oracle} serves`);
    if (!config.publishers.includes(key.publicKey)) throw refusal(503, `${key.publicKey} is not a publisher on ${oracle}`);
    const info = await view(rpcUrl, oracle, "get_market_info", { market, market_id: marketId });
    const rule = info?.price_rule;
    if (!rule) throw refusal(404, `market ${marketId} of ${market} is not a price market`);
    const block = await rpc(rpcUrl, "block", { finality: "final" });
    if (BigInt(block.header.timestamp_nanosec) < BigInt(rule.observation_time) + SETTLE_NS) {
      throw refusal(425, `the candles for observation time ${rule.observation_time} are not final yet`);
    }
    const listed = await view(rpcUrl, market, "get_market", { market_id: marketId });
    const pair = await refusing(422, () => pairIn(listed.resolution_source));
    const priced = await refusing(503, () => priceAt({ pair, observationNs: rule.observation_time, decimals: rule.decimals, venues, fetch }));
    const message = priceMessage({
      oracle, network: config.network, market, marketId, observationTime: rule.observation_time, price: priced.price, decimals: rule.decimals,
    });
    return {
      market, market_id: marketId, pair, observation_time: rule.observation_time, decimals: rule.decimals,
      price: String(priced.price), sources: priced.sources, signature: key.sign(message),
    };
  }

  // One price per market, kept in the price file when there is one: a second price signed for the same market could count
  // toward a different answer. The promise is cached, so two requests arriving together share one signing, and the quote is
  // written to disk before anyone sees it. A failure is not kept.
  return (market, marketId) => {
    const cacheKey = `${market}:${marketId}`;
    if (!signed.has(cacheKey)) {
      const pending = sign(market, marketId).then((quote) => {
        persist(cacheKey, quote);
        return quote;
      });
      signed.set(cacheKey, pending);
      pending.catch(() => signed.delete(cacheKey));
    }
    return signed.get(cacheKey);
  };
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body) + "\n");
}

export function server(quote) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://publisher");
    if (req.method !== "GET" || url.pathname !== "/price") return reply(res, 404, { error: "GET /price?market=<market account>&id=<market id>" });
    const market = url.searchParams.get("market") ?? "";
    const id = url.searchParams.get("id") ?? "";
    if (!ACCOUNT_ID.test(market) || !/^\d{1,20}$/.test(id)) return reply(res, 400, { error: "market must be an account id and id a market id" });
    try {
      reply(res, 200, await quote(market, id));
    } catch (e) {
      reply(res, e.status ?? 502, { error: e.message });
    }
  });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = options(rest);
  if (command !== "serve" || !opts.rpc || !opts.oracle) {
    console.error(`usage: publisher.mjs serve --rpc URL --oracle ID [--host 127.0.0.1] [--port 8790] [--key-file PATH] [--price-file PATH] [--coinbase-url URL] [--kraken-url URL] [--bitstamp-url URL]; the key is PUBLISHER_KEY or --key-file, the signed prices are kept in --price-file or PUBLISHER_PRICE_FILE (default ${DEFAULT_PRICE_FILE})`);
    process.exit(2);
  }
  if ("key" in opts) throw new Error("--key is refused: a key on the command line shows in the process list. Use PUBLISHER_KEY or --key-file");
  const secret = opts["key-file"] !== undefined ? readKeyFile(opts["key-file"]) : process.env.PUBLISHER_KEY;
  if (!secret) throw new Error("no key: set PUBLISHER_KEY or pass --key-file");
  const key = publisherKey(secret);
  const venues = Object.fromEntries(Object.entries(VENUES).map(([venue, base]) => [venue, opts[`${venue}-url`] ?? base]));
  const priceFile = opts["price-file"] ?? process.env.PUBLISHER_PRICE_FILE ?? DEFAULT_PRICE_FILE;
  const host = opts.host ?? "127.0.0.1";
  const listening = server(quoter({ rpcUrl: opts.rpc, oracle: opts.oracle, key, venues, priceFile })).listen(Number(opts.port ?? 8790), host);
  listening.on("listening", () => console.log(`publisher ${key.publicKey} listening on http://${host}:${listening.address().port}`));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
