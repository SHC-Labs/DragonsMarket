import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { b58encode } from "./chain.mjs";
import { assertNftCustody, parseNftCustody, verifyNftCustody } from "./nft-custody.mjs";
import { collectionCustodyReport } from "./keeper.mjs";

const policy = {
  mode: "platform-managed", accountId: "collection.near", ownerId: "platform.near",
  codeHash: b58encode(Buffer.alloc(32, 2)), publicKeys: [`ed25519:${b58encode(Buffer.alloc(32, 3))}`],
  custodian: "Platform operator", reviewEvidence: "https://review.example/nft",
};
const snapshot = {
  accountId: policy.accountId, account: { code_hash: policy.codeHash }, ownerId: policy.ownerId,
  keys: policy.publicKeys.map((public_key) => ({ public_key, access_key: { nonce: 50, permission: "FullAccess" } })),
};

test("NFT custody defaults to keyless and never treats malformed policy as an exception", () => {
  assert.deepEqual(parseNftCustody(undefined, policy.accountId), { mode: "keyless" });
  assertNftCustody(undefined, { ...snapshot, keys: [] });
  assert.throws(() => assertNftCustody(undefined, snapshot), /not_keyless/);
  for (const value of [null, false, "platform-managed", {}, { mode: "keyless", publicKeys: [] }])
    assert.throws(() => parseNftCustody(value, policy.accountId), /invalid_nft/);
  assert.throws(() => assertNftCustody(undefined, { ...snapshot, keys: null }), /invalid_nft_access_keys/);
});

test("platform approval binds every required field and rejects malformed keys or incomplete review records", () => {
  assert.deepEqual(parseNftCustody(policy, policy.accountId), policy);
  for (const field of Object.keys(policy)) {
    const value = structuredClone(policy); delete value[field];
    assert.throws(() => parseNftCustody(value, policy.accountId), /invalid_nft/);
  }
  for (const changed of [
    { accountId: "different.near" }, { ownerId: "INVALID" }, { codeHash: "1".repeat(32) },
    { publicKeys: [] }, { publicKeys: [...policy.publicKeys, ...policy.publicKeys] },
    { publicKeys: ["ed25519:wrong"] }, { publicKeys: ["secp256k1:" + policy.publicKeys[0].slice(8)] },
    { custodian: " " }, { reviewEvidence: "file:///tmp/approval" },
    { reviewEvidence: "https://user:password@review.example/approval" }, { allowAnyKey: true },
  ]) assert.throws(() => parseNftCustody({ ...policy, ...changed }, policy.accountId), /invalid_nft/);
});

test("approved platform custody tolerates transaction nonce increments but rejects authority and code drift", () => {
  assertNftCustody(policy, snapshot);
  const used = structuredClone(snapshot); used.keys[0].access_key.nonce++;
  assertNftCustody(policy, used);
  for (const changed of [
    { accountId: "market.near" }, { ownerId: "attacker.near" }, { ownerId: null },
    { account: { code_hash: b58encode(Buffer.alloc(32, 4)) } },
    { account: { ...snapshot.account, global_contract_account_id: "mutable.near" } },
    { keys: [] }, { keys: [...snapshot.keys, ...snapshot.keys] },
    { keys: [{ public_key: `ed25519:${b58encode(Buffer.alloc(32, 5))}`, access_key: { permission: "FullAccess" } }] },
    { keys: [{ public_key: policy.publicKeys[0], access_key: { permission: { FunctionCall: {} } } }] },
    { keys: [null] }, { keys: [{ public_key: policy.publicKeys[0] }] },
  ]) assert.throws(() => assertNftCustody(policy, { ...snapshot, ...changed }), /nft/);
});

test("multiple individually approved keys compare as a set without accepting duplicate entries", () => {
  const second = `ed25519:${b58encode(Buffer.alloc(32, 9))}`;
  const approved = { ...policy, publicKeys: [...policy.publicKeys, second] };
  const keys = [{ public_key: second, access_key: { permission: "FullAccess" } }, ...snapshot.keys];
  assertNftCustody(approved, { ...snapshot, keys });
  assert.throws(() => assertNftCustody(approved, { ...snapshot, keys: [...snapshot.keys, ...snapshot.keys] }), /keys_changed/);
});

test("live custody reader queries the pinned collection and get_owner, preserving provider failures", async () => {
  const seen = [];
  const chain = {
    keys: async (id) => { seen.push(["keys", id]); return snapshot.keys; },
    account: async (id) => { seen.push(["account", id]); return snapshot.account; },
    view: async (...args) => { seen.push(args); return snapshot.ownerId; },
  };
  assert.match(await verifyNftCustody(policy, policy.accountId, chain), /approved platform custody/);
  assert.deepEqual(seen, [["keys", policy.accountId], ["account", policy.accountId], [policy.accountId, "get_owner", {}]]);
  await assert.rejects(verifyNftCustody(policy, policy.accountId, {
    ...chain, view: async () => { throw new Error("unavailable"); },
  }), /unavailable/);
});

test("keeper check consumes the custody file, pins reads to one block and still reports drift", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nft-custody-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "custody.json");
  fs.writeFileSync(file, JSON.stringify(policy));
  let owner = policy.ownerId;
  const at = "finalized-block";
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { params } = JSON.parse(options.body);
    assert.equal(params.account_id, policy.accountId);
    assert.equal(params.block_id, at);
    let result;
    if (params.request_type === "view_access_key_list") result = { keys: snapshot.keys };
    else if (params.request_type === "view_account") result = snapshot.account;
    else {
      assert.equal(params.method_name, "get_owner");
      result = { result: [...Buffer.from(JSON.stringify(owner))] };
    }
    return Response.json({ result });
  });
  const opts = { rpc: "https://rpc.example", "expect-sealed": true, "nft-custody": file };
  const report = await collectionCustodyReport(opts, policy.accountId, at);
  assert.deepEqual(report.problems, []);
  assert.match(report.line, /approved platform custody/);
  owner = "changed.near";
  assert.match((await collectionCustodyReport(opts, policy.accountId, at)).problems[0], /owner_changed/);
  assert.match((await collectionCustodyReport(opts, null, at)).problems[0], /not configured/);
  delete opts["nft-custody"];
  assert.match((await collectionCustodyReport(opts, policy.accountId, at)).problems[0], /still has 1 access key/);
});
