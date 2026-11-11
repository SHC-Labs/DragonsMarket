// Run with: node --test deploy-production.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { contiguousRange, loadManifest, nftReady, validateManifest, verify } from "./deploy-production.mjs";

const NFT = "techdragons.nft.cookon.near";
const DAO = "dao.sputnik-dao.near";
const MANIFEST = {
  dao: DAO,
  nft: NFT,
  contracts: Object.fromEntries(["market", "oracle", "council", "rounds"].map((role) => [role, { account: `${role}.example.near`, codeHash: "x" }])),
};

function chain({ supply, keys = [], ids = [], nftContract = NFT }) {
  return {
    keys: async () => keys,
    account: async () => ({ code_hash: "x" }),
    view: async (account, method, args) => {
      if (method === "get_policy") return { proposal_bond: "100000000000000000000000" };
      if (method === "nft_total_supply") return String(supply);
      if (method === "nft_tokens") return ids.slice(Number(args.from_index), Number(args.from_index) + args.limit).map((token_id) => ({ token_id }));
      if (method === "config") return { nft_contract: nftContract, owner: DAO, upgrade_proven: true };
      throw new Error(`unexpected view ${method}`);
    },
  };
}

const proposalArgs = ({ request }) => request.actions[0].params.args.proposal.kind.FunctionCall.actions[0];

test("a contiguous decimal range is recognised in any order, anything else is not", () => {
  assert.deepEqual(contiguousRange(["3", "1", "2"]), { first: "1", last: "3" });
  assert.deepEqual(contiguousRange(["0"]), { first: "0", last: "0" });
  assert.equal(contiguousRange(["1", "3"]), null);
  assert.equal(contiguousRange(["1", "1"]), null);
  assert.equal(contiguousRange(["01", "2"]), null);
  assert.equal(contiguousRange(["a", "b"]), null);
  assert.equal(contiguousRange([]), null);
});

test("nft-ready waits while the supply is zero and proposes nothing", async () => {
  const result = await nftReady(MANIFEST, chain({ supply: 0 }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.items, []);
  assert.match(result.lines[0], /^FAIL .* supply is 0/);
  assert.match(result.lines[1], /^PASS .* 0 access keys/);
});

test("nft-ready reports the collection's keys and proposes nothing while one remains", async () => {
  const keys = [{ public_key: "ed25519:x", access_key: { permission: "FullAccess" } }];
  const result = await nftReady(MANIFEST, chain({ supply: 2, keys, ids: ["1", "2"] }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.items, []);
  assert.match(result.lines[1], /^FAIL .* 1 access keys/);
});

test("nft-ready proposes set_token_range for a contiguous range", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => String(i + 1)).reverse();
  const result = await nftReady(MANIFEST, chain({ supply: 150, ids }));
  assert.equal(result.ready, true);
  assert.equal(result.items.length, 1);
  const call = proposalArgs(result.items[0]);
  assert.equal(call.method_name, "set_token_range");
  assert.deepEqual(JSON.parse(Buffer.from(call.args, "base64")), { first: "1", last: "150" });
});

test("nft-ready batches allow_tokens at 100 ids for a gappy collection", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `t${i}`);
  const result = await nftReady(MANIFEST, chain({ supply: 250, ids }));
  assert.equal(result.ready, true);
  const sizes = result.items.map((item) => JSON.parse(Buffer.from(proposalArgs(item).args, "base64")).token_ids.length);
  assert.deepEqual(sizes, [100, 100, 50]);
});

test("nft-ready warns when the council has no collection yet", async () => {
  const result = await nftReady(MANIFEST, chain({ supply: 1, ids: ["1"], nftContract: null }));
  assert.ok(result.lines.some((line) => line.startsWith("WARN council nft_contract")));
});

test("nft-ready refuses a collection whose listing disagrees with its supply", async () => {
  await assert.rejects(nftReady(MANIFEST, chain({ supply: 3, ids: ["1", "2"] })), /listed 2 ids for a supply of 3/);
});

test("verify fails the keys line while a key remains", async () => {
  const keyed = { ...chain({ supply: 0 }), keys: async () => [{ public_key: "ed25519:x" }] };
  const results = await verify({ ...MANIFEST, contracts: { ...MANIFEST.contracts } }, keyed);
  assert.equal(results.filter(({ ok }) => !ok).length, 4);
  assert.ok(results.filter(({ ok }) => !ok).every(({ text }) => text.includes("no access keys")));
});

test("the example manifest names every placeholder and cannot pass plan until they are filled", () => {
  const example = loadManifest(path.join(import.meta.dirname, "deploy-production.example.json"));
  const problems = validateManifest(example);
  assert.ok(problems.some((problem) => problem.startsWith("operator: still a placeholder")));
  assert.ok(problems.some((problem) => problem.startsWith("contracts.market.account: still a placeholder")));
  assert.ok(example.decide.every((where) => where.split(".").reduce((v, k) => v?.[k], example) !== undefined));
});
