import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { gather, openRounds, roundPriceMessage } from "./round-prices.mjs";
import { publisherKey } from "./publisher.mjs";
import { b58encode } from "./chain.mjs";

const SECOND = 10n ** 9n;
const series = { asset: "btc-usd", decimals: 8, first_start: String(1000n * SECOND), interval: String(300n * SECOND), price_window: String(600n * SECOND), close_before: String(30n * SECOND) };

function newPublisher() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return publisherKey(b58encode(Buffer.concat([seed, pub])));
}

function serve(body, status = 200) {
  const server = http.createServer((req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

test("a round can be recorded from its moment until its price window closes", () => {
  const at = (r) => 1000n * SECOND + r * 300n * SECOND;
  assert.deepEqual(openRounds(series, 999n * SECOND), []);
  assert.deepEqual(openRounds(series, at(0n)), [0n]);
  assert.deepEqual(openRounds(series, at(1n) + 10n * SECOND), [0n, 1n]);
  assert.deepEqual(openRounds(series, at(0n) + 601n * SECOND), [1n, 2n], "round 0's window has closed");
});

test("signatures made by publishers are gathered only when enough of them agree on one price", async () => {
  const [a, b, c] = [newPublisher(), newPublisher(), newPublisher()];
  const config = { network: "mainnet", price_threshold: 2, publishers: [a.publicKey, b.publicKey] };
  const at = (1000n * SECOND).toString();
  const message = (price) => roundPriceMessage({ rounds: "rounds.near", network: "mainnet", asset: "btc-usd", at, price, decimals: 8 });
  const answers = [
    await serve({ quotes: [{ message: message("100"), price: "100", entry: a.sign(message("100")) }] }),
    await serve({ quotes: [{ message: message("100"), price: "100", entry: b.sign(message("100")) }] }),
    await serve({ quotes: [{ message: message("100"), price: "100", entry: c.sign(message("100")) }] }),
    await serve({ quotes: [{ message: message("999"), price: "999", entry: b.sign(message("100")) }] }),
  ];
  try {
    const urls = answers.map((s) => s.url);
    const args = { publishers: config.publishers, seriesId: 0, round: 0n, series, config, rounds: "rounds.near" };
    const two = await gather({ ...args, urls: urls.slice(0, 2) });
    assert.equal(two.price, "100");
    assert.equal(two.entries.length, 2);
    assert.equal(await gather({ ...args, urls: [urls[0], urls[2]] }), null, "a key the contract does not list counts for nothing");
    assert.equal(await gather({ ...args, urls: [urls[0], urls[3]] }), null, "a signature over another price counts for nothing");
    assert.equal(await gather({ ...args, urls: [urls[0]] }), null, "one publisher is below the threshold");
    assert.equal(await gather({ ...args, urls: ["http://127.0.0.1:1"] }), null, "an unreachable publisher is skipped");
  } finally {
    answers.forEach((s) => s.close());
  }
});
