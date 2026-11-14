// Run with: node --test deploy-production.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { contiguousRange, loadManifest, nftReady, validateManifest, verify, daoProposals, prepareKeyDirectory, connect } from "./deploy-production.mjs";
import { codeHash } from "./keeper/treasury.mjs";

const NFT = "techdragons.nft.cookon.near";
const DAO = "dao.sputnik-dao.near";
function manifest() {
  const m = loadManifest(path.join(import.meta.dirname, "deploy-production.example.json"));
  const raw = JSON.stringify(m).replaceAll("FILL_operator_account", "operator.near")
    .replaceAll("dragonsmarket.sputnik-dao.near", DAO).replaceAll("dragonsmarket.near", "example.near")
    .replaceAll("FILL_market.", "market.").replaceAll("FILL_oracle.", "oracle.")
    .replaceAll("FILL_council.", "council.").replaceAll("FILL_rounds.", "rounds.");
  const filled = JSON.parse(raw);
  filled.network = "sandbox";
  delete filled.nftCustody;
  filled.placeholders = [];
  for (const c of Object.values(filled.contracts)) {
    c.bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    c.codeHash = codeHash(c.bytes);
    if (c.init.network) c.init.network = "sandbox";
  }
  return filled;
}
const MANIFEST = manifest();
const CONFIG = {
  owner: DAO, pending_owner: null, upgrade_proven: true, operator: "operator.near",
  oracle: "oracle.example.near", verifier: MANIFEST.verifier, collateral_token_id: MANIFEST.collateral,
  markets: ["market.example.near"], bond: "100000000", window_ns: "86400000000000", panel_deadline_ns: "172800000000000",
  draw_window_ns: "86400000000000", min_proposal_ns: "3600000000000", council: "council.example.near",
  jury_size: 5, draw_delay_blocks: "2", network: "sandbox", price_threshold: 2, no_decision_recipient: DAO,
  cooldown_ns: "604800000000000", max_seats_per_account: 5, allowlist_enabled: true,
  revenue_pool: "council.example.near", treasury: DAO,
};

function chain({ supply, keys = [], ids = [], nftContract = NFT, config = {} }) {
  return {
    keys: async () => keys,
    account: async () => ({ code_hash: MANIFEST.contracts.market.codeHash }),
    view: async (account, method, args) => {
      if (method === "get_policy") return { proposal_bond: "100000000000000000000000",
        roles: [{ name: "Council", kind: { Group: ["one.near", "two.near", "three.near"] }, permissions: ["*:*"], vote_policy: {} }],
        default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "3" } };
      if (method === "nft_total_supply") return String(supply);
      if (method === "nft_tokens") return ids.slice(Number(args.from_index), Number(args.from_index) + args.limit).map((token_id) => ({ token_id }));
      if (method === "config") return { ...CONFIG, nft_contract: nftContract, ...config };
      if (method === "is_staged") return true;
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
  assert.match(result.lines[1], /^FAIL .* approved_nft_not_keyless/);
});

test("nft-ready accepts the reviewed platform key but emits no proposals after custody drift", async () => {
  const m = manifest();
  m.nftCustody = { mode: "platform-managed", accountId: NFT, ownerId: "cookon.near",
    codeHash: m.contracts.market.codeHash, publicKeys: ["ed25519:67k6LHXYbFdM5ikxUtAmoZwV7c7HqdYXepcKoDscx3AC"],
    custodian: "Cookon", reviewEvidence: "https://review.example/nft" };
  assert.deepEqual(validateManifest(m), []);
  const keys = m.nftCustody.publicKeys.map(public_key => ({ public_key, access_key: { permission: "FullAccess" } }));
  const live = chain({ supply: 2, keys, ids: ["1", "2"] });
  const view = live.view;
  let owner = m.nftCustody.ownerId;
  live.view = (id, method, args) => method === "get_owner" ? Promise.resolve(owner) : view(id, method, args);
  assert.equal((await nftReady(m, live)).ready, true);
  owner = "different.near";
  const refused = await nftReady(m, live);
  assert.equal(refused.ready, false);
  assert.deepEqual(refused.items, []);
  assert.match(refused.lines[1], /owner_changed/);
  owner = m.nftCustody.ownerId;
  live.keys = async () => [...keys, ...keys];
  assert.equal((await nftReady(m, live)).ready, false);
  m.nftCustody.accountId = "other.near";
  assert.ok(validateManifest(m).some(problem => problem.startsWith("nftCustody:")));
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

test("nft-ready refuses when the council has no collection yet", async () => {
  const result = await nftReady(MANIFEST, chain({ supply: 1, ids: ["1"], nftContract: null }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.items, []);
  assert.ok(result.lines.some((line) => line.startsWith("FAIL council nft_contract")));
});

test("verification rejects financial configuration drift even with approved code and sealed accounts", async () => {
  assert.ok((await verify(MANIFEST, chain({ supply: 0 }))).every(result => result.ok));
  for (const config of [
    { operator: "unexpected.near" }, { pending_owner: "unexpected.near" }, { verifier: "unexpected.near" },
    { bond: "1" }, { markets: [] }, { revenue_pool: "unexpected.near" }, { treasury: null },
    { allowlist_enabled: false }, { cooldown_ns: "1" },
  ]) assert.ok((await verify(MANIFEST, chain({ supply: 0, config }))).some(result => !result.ok), JSON.stringify(config));
});

test("proposals include fee routing and Council permissions, and can resume after some accounts are sealed", async () => {
  const incomplete = chain({ supply: 0, config: { upgrade_proven: false, treasury: null, revenue_pool: null } });
  const originalView = incomplete.view;
  incomplete.view = async (account, method, args) => {
    const result = await originalView(account, method, args);
    return method === "config" && account === MANIFEST.contracts.council.account ? { ...result, markets: [] } : result;
  };
  const first = await daoProposals(MANIFEST, incomplete);
  assert.equal(first.items.length, 7);
  assert.deepEqual(first.items.slice(4).map(item => proposalArgs(item).method_name), ["allow_market", "set_fee_recipients", "set_treasury"]);
  const sealed = chain({ supply: 0 });
  sealed.keys = async account => account === MANIFEST.contracts.rounds.account
    ? [{ public_key: "ed25519:" + "1".repeat(32), access_key: { permission: "FullAccess" } }] : [];
  const remaining = await daoProposals(MANIFEST, sealed);
  assert.equal(remaining.items.length, 1);
  assert.equal(proposalArgs(remaining.items[0]).method_name, "seal");
  const empty = await daoProposals(MANIFEST, chain({ supply: 0 }));
  assert.deepEqual(empty.items, []);
});

test("manifest rejects nested children, authority collisions and non-reproducible production artifacts", () => {
  assert.deepEqual(validateManifest(manifest()), []);
  const nested = manifest(); nested.contracts.market.account = "nested.market.example.near";
  assert.ok(validateManifest(nested).some(problem => problem.includes("direct child")));
  const collision = manifest(); collision.operator = collision.contracts.market.account;
  assert.ok(validateManifest(collision).some(problem => problem.includes("must be separate")));
  const production = manifest(); production.network = "mainnet";
  assert.ok(validateManifest(production).some(problem => problem.includes("source commit")));
  assert.ok(validateManifest(production).some(problem => problem.includes("no contract source metadata")));
});

test("production build metadata must match the approved commit, image and contract", () => {
  const m = manifest(); m.network = "mainnet";
  m.daoCodeHash = "1".repeat(32);
  m.release = { sourceCommit: "a".repeat(40), imageDigest: "sha256:" + "b".repeat(64) };
  for (const [role, c] of Object.entries(m.contracts)) {
    if (c.init.network) c.init.network = "mainnet";
    const metadata = { build_info: { build_environment: `builder@${m.release.imageDigest}`, build_command: ["cargo", "near", "build"],
      source_code_snapshot: `git+https://github.com/SHC-Labs/DragonsMarket?rev=${m.release.sourceCommit}`, contract_path: role } };
    c.bytes = Buffer.concat([c.bytes, Buffer.from(JSON.stringify(metadata))]); c.codeHash = codeHash(c.bytes);
  }
  assert.deepEqual(validateManifest(m), []);
  m.release.sourceCommit = "c".repeat(40);
  assert.equal(validateManifest(m).filter(problem => problem.includes("source commit differs")).length, 4);
  m.release.sourceCommit = "a".repeat(40); m.release.imageDigest = "sha256:" + "c".repeat(64);
  assert.equal(validateManifest(m).filter(problem => problem.includes("image differs")).length, 4);
});

test("a permissive requestor role blocks governance even when the approver role is strict", async () => {
  const weak = chain({ supply: 0 });
  const original = weak.view;
  weak.view = async (account, method, args) => {
    const result = await original(account, method, args);
    if (method === "get_policy") result.roles.push({ name: "Requestor", kind: { Group: ["one.near", "two.near", "three.near"] },
      permissions: ["call:AddProposal"], vote_policy: { call: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } } });
    return result;
  };
  await assert.rejects(daoProposals(MANIFEST, weak), /unsafe_dao_approval_threshold/);
  const results = await verify(MANIFEST, weak);
  assert.equal(results[0].ok, false);
  assert.match(results[0].text, /DAO governance/);
});

test("key directories cannot reach the repository through a symlink or a dot-dot-prefixed child", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-path-"));
  try {
    fs.symlinkSync(path.resolve(import.meta.dirname, ".."), path.join(dir, "alias"), "dir");
    assert.throws(() => prepareKeyDirectory(path.join(dir, "alias", "keys")), /inside the repository/);
    assert.throws(() => prepareKeyDirectory(path.resolve(import.meta.dirname, "..", "..keys")), /inside the repository/);
    fs.mkdirSync(path.join(dir, "open"), { mode: 0o755 });
    assert.throws(() => prepareKeyDirectory(path.join(dir, "open")), /inaccessible to group/);
    const privateDir = prepareKeyDirectory(path.join(dir, "private"));
    assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("production refuses single RPC or two paths on the same provider before reading the chain", async () => {
  await assert.rejects(connect("https://rpc.example.com", { network: "mainnet" }), /two independent RPC/);
  await assert.rejects(connect("https://rpc.example.com/one", { network: "mainnet" }, "https://rpc.example.com/two"), /two independent RPC/);
  await assert.rejects(connect("http://rpc.example.com", { network: "mainnet" }, "https://second.example.com"), /HTTPS/);
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
