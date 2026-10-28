import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { b58encode } from "./chain.mjs";
import { publisherKey, SETTLE_NS } from "./publisher.mjs";
import { bestSigned, eventMarketsClosed, priceMarketsDue, proposalProblem, refusalIn } from "./resolver.mjs";

function keyOf(seed) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seed)]), format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return publisherKey("ed25519:" + b58encode(Buffer.concat([Buffer.alloc(32, seed), publicKey])));
}

const [a, b, c, outsider] = [1, 2, 3, 4].map(keyOf);
const messageFor = (price) => `price:v2:oracle.near:mainnet:market.near:7:100:${price}:2`;
const quote = (key, price) => ({ price, signature: key.sign(messageFor(price)) });
const publishers = [a.publicKey, b.publicKey, c.publicKey];

test("signatures are grouped by price and the price most publishers signed wins, with each publisher counted once", () => {
  const best = bestSigned([quote(a, "100"), quote(b, "101"), quote(c, "100"), quote(a, "100")], { messageFor, publishers });
  assert.equal(best.price, "100");
  assert.deepEqual(best.entries, [quote(a, "100").signature, quote(c, "100").signature]);
});

test("a signature from a key that is not a publisher, over another price, or malformed does not count", () => {
  const forged = { price: "100", signature: quote(a, "999").signature };
  const quotes = [quote(outsider, "100"), forged, null, { price: "1e2", signature: "x" }, { price: "100" }, quote(b, "100")];
  assert.deepEqual(bestSigned(quotes, { messageFor, publishers }), { price: "100", entries: [quote(b, "100").signature] });
  assert.equal(bestSigned([null, null], { messageFor, publishers }), null);
});

test("a price market is due once its observation time has settled, and only while it is registered and has no outcome", () => {
  const rule = (at) => ({ observation_time: String(at) });
  const markets = [
    { id: "1", registered: true, outcome: null, price_rule: rule(100n) },
    { id: "2", registered: true, outcome: null, price_rule: rule(101n) },
    { id: "3", registered: true, outcome: "yes", price_rule: rule(0n) },
    { id: "4", registered: true, outcome: null, price_rule: null, close_at: "0" },
    { id: "5", registered: false, outcome: null, price_rule: rule(0n) },
    { id: "6", registered: false, outcome: null, price_rule: null, close_at: "0" },
  ];
  assert.deepEqual(priceMarketsDue(markets, 100n + SETTLE_NS).map((m) => m.id), ["1"]);
  assert.deepEqual(eventMarketsClosed(markets, 0n).map((m) => m.id), ["4"]);
  assert.deepEqual(eventMarketsClosed([{ ...markets[3], close_at: "5" }], 4n), []);
});

test("the first failed step of a transaction is its refusal, and a clean one has none", () => {
  const failed = (message) => ({ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: message } } } } } } });
  const ok = { outcome: { status: { SuccessValue: "" } } };
  assert.equal(refusalIn({ transaction_outcome: ok, receipts_outcome: [ok, failed("Smart contract panicked: send exactly the bond"), failed("later")] }), "Smart contract panicked: send exactly the bond");
  assert.equal(refusalIn({ transaction_outcome: ok, receipts_outcome: [ok] }), null);
  assert.equal(refusalIn({ transaction_outcome: { outcome: { status: { Failure: { InvalidTxError: "x" } } } } }), '{"InvalidTxError":"x"}');
});

test("a proposal is checked before any bond moves", () => {
  const market = { id: "4", price_rule: null, outcome: null, close_at: "10" };
  const ask = { market, now: 10n, hasCase: false, answer: "yes", evidence: "https://example.com/result" };
  assert.equal(proposalProblem(ask), null);
  assert.match(proposalProblem({ ...ask, answer: "maybe" }), /must be one of yes, no, void/);
  assert.match(proposalProblem({ ...ask, evidence: undefined }), /--evidence is required/);
  assert.match(proposalProblem({ ...ask, evidence: "x".repeat(513) }), /over 512 bytes/);
  assert.equal(proposalProblem({ ...ask, evidence: "x".repeat(512) }), null);
  assert.match(proposalProblem({ ...ask, market: null }), /no such market/);
  assert.match(proposalProblem({ ...ask, market: { ...market, price_rule: {} } }), /is a price market/);
  assert.match(proposalProblem({ ...ask, market: { ...market, outcome: "no" } }), /already resolved no/);
  assert.match(proposalProblem({ ...ask, now: 9n }), /has not closed/);
  assert.match(proposalProblem({ ...ask, hasCase: true }), /already has a case/);
});
