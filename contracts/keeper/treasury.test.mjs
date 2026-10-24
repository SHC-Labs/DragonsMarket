// Run with: node --test keeper/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED, CLOSE_GRACE_DAYS, CONTRACT_LIMITS, GUARDED_KINDS, TARGETS, codeHash, prepareAdministrationProposal, prepareStageCode,
  prepareTreasuryVote, reviewKind, storageRunway, prepareStorageTopUp,
} from "./treasury.mjs";
import { b58encode } from "./chain.mjs";

const DAO = "dao.sputnik-dao.near";
const CONTRACTS = { market: "market.example.near", oracle: "oracle.example.near", council: "council.example.near" };
const IDS = { treasuryId: DAO, contracts: CONTRACTS };
const BOND = "2500000000000000000000000";
const TGAS = 10n ** 12n;
const HASH = b58encode(Buffer.alloc(32, 9));
const ED_KEY = `ed25519:${b58encode(Buffer.alloc(32, 7))}`;
const SECP_KEY = `secp256k1:${b58encode(Buffer.alloc(64, 5))}`;
const CONTRACTS_DIR = path.resolve(import.meta.dirname, "..");
const NEXT_SWEEP_ID = "5";
const MARKET_STORAGE_DEPOSIT = "50090000000000000000000";

// A DAO and three contracts that answer only the views the helper is meant to ask.
function chain({ bond = BOND, proposals = [], staged = true, proven = true } = {}) {
  const byId = new Map(proposals.map((p) => [p.id, p]));
  return async (account, method, args) => {
    if (account === DAO && method === "get_policy") return { roles: [], proposal_bond: bond, proposal_period: "259200000000000" };
    if (account === DAO && method === "get_proposal") {
      if (!byId.has(args.id)) throw new Error("ERR_NO_PROPOSAL");
      return byId.get(args.id);
    }
    if (Object.values(CONTRACTS).includes(account) && method === "is_staged") return staged;
    if (Object.values(CONTRACTS).includes(account) && method === "config") return { upgrade_proven: proven, next_sweep_id: NEXT_SWEEP_ID, market_storage_deposit: MARKET_STORAGE_DEPOSIT };
    throw new Error(`unexpected view ${account}.${method}`);
  };
}

const encode = (args) => Buffer.from(JSON.stringify(args)).toString("base64");
const functionCall = (receiver, method, args, { deposit = "0", gas = "30000000000000", raw } = {}) => ({
  FunctionCall: { receiver_id: receiver, actions: [{ method_name: method, args: raw ?? encode(args), deposit, gas }] },
});
const stored = (id, kind, status = "InProgress") => ({
  id, proposer: "alice.near", description: "d", kind, status, vote_counts: {}, votes: {}, submission_time: "1", last_actions_log: [],
});
const propose = (target, methodName, args, extra = {}) =>
  prepareAdministrationProposal({ ...IDS, target, methodName, args, description: "why", view: chain(), ...extra });
const vote = (proposal, extra = {}) =>
  prepareTreasuryVote({ ...IDS, proposalId: proposal.id, approve: true, view: chain({ proposals: [proposal] }), ...extra });
const proposalOf = (tx) => tx.actions[0].params.args.proposal;
const callOf = (tx) => proposalOf(tx).kind.FunctionCall.actions[0];

// One valid argument set for every entry of the allow-list.
const SAMPLES = {
  market: {
    upgrade: { code_hash: HASH },
    seal: { public_key: ED_KEY },
    propose_owner: { new_owner: DAO },
    accept_owner: {},
    set_operator: { operator_id: "keeper.example.near" },
    set_fee_recipients: { revenue_pool: CONTRACTS.council, treasury: DAO },
    set_revenue_share_bps: { revenue_share_bps: 2500 },
    set_min_sweep: { min_sweep: "1000000" },
    set_next_sweep_id: { next_sweep_id: "50" },
    set_fee_rate_bps: { fee_rate_bps: 150 },
    set_create_fee: { create_fee: "1000000" },
    set_storage_policy: { market_storage_deposit: MARKET_STORAGE_DEPOSIT, reserve: "1000000000000000000000000" },
    reconcile_leg: { sweep_id: "3", leg: "council", arrived: true },
    reconcile_withdrawal: { id: "3", paid: false },
    set_paused: { paused: true },
    set_sells_paused: { sells_paused: true },
    set_void_rules: { price_window_ns: "86400000000000", grace_ns: "604800000000000" },
    set_sweep_timing: { settle_wait_minutes: 10, reconcile_wait_minutes: 60, min_interval_minutes: 60 },
    set_open_price_bounds: { min: "10000", max: "990000" },
    set_max_positions: { max_positions: 20 },
    set_fee_limits: { max_fee_rate_bps: 500, max_create_fee: "10000000", min_revenue_share_bps: 1000, max_revenue_share_bps: 5000, max_min_sweep: "100000000" },
    halt: { market_id: "3", reason: "the source is down" },
    resume: { market_id: "3" },
    claim_residual: { market_id: "3" },
    retry_register: { market_id: "3" },
    create_market: {
      title: "Will it rain?", rule_text: "Yes if it rains.", resolution_source: "https://example.com", void_policy: "Void if cancelled.",
      category: "weather", subcategory: "rain", close_at: "1000", resolve_by: "2000",
    },
    withdraw: { amount: "100" },
  },
  oracle: {
    upgrade: { code_hash: HASH },
    seal: { public_key: SECP_KEY },
    propose_owner: { new_owner: DAO },
    accept_owner: {},
    set_operator: { operator_id: "keeper.example.near" },
    allow_market: { market: "second-market.example.near" },
    disallow_market: { market: "old-market.example.near" },
    set_bond: { bond: "1000000" },
    set_window_ms: { window_ms: "7200000" },
    set_panel_deadline_ms: { panel_deadline_ms: "172800000" },
    set_min_proposal_ms: { min_proposal_ms: "60000" },
    set_draw_window_ms: { draw_window_ms: "3600000" },
    set_draw_delay_blocks: { draw_delay_blocks: "2" },
    set_jury_size: { jury_size: 11 },
    set_juror_shares: { decided_bps: 2500, no_decision_bps: 5000 },
    set_apply_buffer_ms: { apply_buffer_ms: "30000" },
    set_max_publishers: { max_publishers: 10 },
    set_no_decision_recipient: { recipient: DAO },
    add_publisher: { key: ED_KEY },
    remove_publisher: { key: ED_KEY },
    set_price_threshold: { threshold: 2 },
    set_reconcile_wait_ns: { reconcile_wait_ns: "3600000000000" },
    reconcile_bond_payout: { id: "3", paid: true },
    withdraw_bond: {},
  },
  council: {
    upgrade: { code_hash: HASH },
    seal: { public_key: ED_KEY },
    propose_owner: { new_owner: DAO },
    accept_owner: {},
    set_cooldown_ns: { cooldown_ns: "172800000000000" },
    set_close_grace_ns: { close_grace_ns: "604800000000000" },
    allow_market: { market: CONTRACTS.market },
    disallow_market: { market: "old-market.example.near" },
    set_max_seats_per_account: { max_seats_per_account: 2 },
    set_nft_contract: { nft_contract: "dragons.example.near" },
    allow_tokens: { token_ids: ["1", "2"] },
    set_token_range: { first: "1", last: "100" },
    clear_token_range: {},
    reconcile_claim: { quarter: 8107, token_id: "1", owner: "holder.example.near", paid: false },
    set_allowlist_enabled: { enabled: true },
    set_reconcile_wait_ns: { reconcile_wait_ns: "3600000000000" },
  },
};
const entries = () => TARGETS.flatMap((target) => Object.keys(ALLOWED[target]).map((method) => [target, method]));

test("every allow-list entry has a sample, so a new entry cannot go untested", () => {
  assert.deepEqual(
    Object.fromEntries(TARGETS.map((t) => [t, Object.keys(SAMPLES[t]).sort()])),
    Object.fromEntries(TARGETS.map((t) => [t, Object.keys(ALLOWED[t]).sort()])),
  );
});

test("each entry prepares one FunctionCall proposal to the DAO with its own deposit and gas and the bond from the DAO's policy", async () => {
  for (const [target, method] of entries()) {
    const tx = await propose(target, method, SAMPLES[target][method]);
    const label = `${target}.${method}`;
    assert.equal(tx.receiverId, DAO, label);
    assert.equal(tx.actions.length, 1, label);
    const call = tx.actions[0].params;
    assert.deepEqual([call.methodName, call.deposit, call.gas], ["add_proposal", BOND, (300n * TGAS).toString()], label);
    const { kind, description } = call.args.proposal;
    assert.equal(description, "why", label);
    assert.deepEqual(Object.keys(kind), ["FunctionCall"], label);
    assert.equal(kind.FunctionCall.receiver_id, CONTRACTS[target], label);
    assert.equal(kind.FunctionCall.actions.length, 1, label);
    const action = kind.FunctionCall.actions[0];
    assert.equal(action.method_name, method, label);
    assert.deepEqual(JSON.parse(Buffer.from(action.args, "base64")), SAMPLES[target][method], label);
    const owns = ["market.withdraw", "oracle.withdraw_bond"].includes(label);
    assert.equal(action.deposit, label === "market.create_market" ? MARKET_STORAGE_DEPOSIT : owns ? "1" : "0", `${label} deposit`);
    assert.equal(action.gas, (BigInt(ALLOWED[target][method].gas.def) * TGAS).toString(), `${label} gas`);
  }
});

test("the bond is read from the DAO's policy and a caller cannot supply one", async () => {
  const tx = await propose("market", "set_paused", { paused: true }, { proposalBond: "1", view: chain({ bond: "7" }) });
  assert.equal(tx.actions[0].params.deposit, "7");
  await assert.rejects(propose("market", "set_paused", { paused: true }, { view: async () => ({ roles: [] }) }), /proposal_bond/);
});

test("arguments the contract would refuse, or that it does not take, are refused before a proposal exists", async () => {
  for (const [target, method] of entries()) {
    const sample = SAMPLES[target][method];
    const label = `${target}.${method}`;
    await assert.rejects(propose(target, method, { ...sample, extra: 1 }), /unknown argument extra/, `${label} extra key`);
    await assert.rejects(propose(target, method, [sample]), /must be an object/, `${label} array`);
    await assert.rejects(propose(target, method, undefined), /must be an object/, `${label} none`);
    for (const key of Object.keys(sample)) {
      const { [key]: _gone, ...rest } = sample;
      await assert.rejects(propose(target, method, rest), new RegExp(`missing argument ${key}`), `${label} without ${key}`);
      await assert.rejects(propose(target, method, { ...sample, [key]: {} }), new RegExp(`${key} must be`), `${label} ${key} as an object`);
    }
  }
});

test("a value past what the contract allows is refused, and the value at the limit is not", async () => {
  const limit = CONTRACT_LIMITS;
  const cases = [
    ["market", "set_fee_rate_bps", { fee_rate_bps: limit.market.HARD_MAX_FEE_RATE_BPS }, { fee_rate_bps: limit.market.HARD_MAX_FEE_RATE_BPS + 1 }],
    ["market", "set_fee_rate_bps", { fee_rate_bps: 0 }, { fee_rate_bps: -1 }],
    ["market", "set_fee_rate_bps", { fee_rate_bps: 1 }, { fee_rate_bps: "150" }],
    ["market", "set_fee_rate_bps", { fee_rate_bps: 1 }, { fee_rate_bps: 1.5 }],
    ["market", "set_create_fee", { create_fee: "100000000" }, { create_fee: "100000001" }],
    ["market", "set_create_fee", { create_fee: "0" }, { create_fee: 1000000 }],
    ["market", "set_create_fee", { create_fee: "5" }, { create_fee: "05" }],
    ["market", "reconcile_leg", { sweep_id: "1", leg: "council", arrived: false }, { sweep_id: "0", leg: "council", arrived: false }],
    ["market", "reconcile_leg", { sweep_id: "1", leg: "treasury", arrived: false }, { sweep_id: "1", leg: "business", arrived: false }],
    ["market", "reconcile_leg", { sweep_id: "1", leg: "council", arrived: false }, { sweep_id: "1", leg: "council", arrived: "no" }],
    ["market", "reconcile_withdrawal", { id: "1", paid: false }, { id: "0", paid: false }],
    ["market", "reconcile_withdrawal", { id: "1", paid: false }, { id: "1", paid: "no" }],
    ["oracle", "reconcile_bond_payout", { id: "1", paid: true }, { id: "0", paid: true }],
    ["oracle", "reconcile_bond_payout", { id: "1", paid: true }, { id: "1", paid: 1 }],
    ["oracle", "set_reconcile_wait_ns", { reconcile_wait_ns: "600000000000" }, { reconcile_wait_ns: "599999999999" }],
    ["oracle", "set_reconcile_wait_ns", { reconcile_wait_ns: "604800000000000" }, { reconcile_wait_ns: "604800000000001" }],
    ["market", "set_revenue_share_bps", { revenue_share_bps: limit.market.HARD_MIN_REVENUE_SHARE_BPS }, { revenue_share_bps: limit.market.HARD_MIN_REVENUE_SHARE_BPS - 1 }],
    ["market", "set_revenue_share_bps", { revenue_share_bps: limit.market.HARD_MAX_REVENUE_SHARE_BPS }, { revenue_share_bps: limit.market.HARD_MAX_REVENUE_SHARE_BPS + 1 }],
    ["market", "set_revenue_share_bps", { revenue_share_bps: 2500 }, { revenue_share_bps: "2500" }],
    ["market", "set_min_sweep", { min_sweep: "1" }, { min_sweep: "0" }],
    ["market", "set_min_sweep", { min_sweep: String(limit.market.HARD_MAX_MIN_SWEEP) }, { min_sweep: String(limit.market.HARD_MAX_MIN_SWEEP + 1n) }],
    ["market", "set_next_sweep_id", { next_sweep_id: "5" }, { next_sweep_id: "0" }],
    ["council", "set_close_grace_ns", { close_grace_ns: "86400000000000" }, { close_grace_ns: "86399999999999" }],
    ["council", "set_close_grace_ns", { close_grace_ns: "2592000000000000" }, { close_grace_ns: "2592000000000001" }],
    ["council", "allow_market", { market: CONTRACTS.market }, { market: "Not A Market" }],
    ["council", "disallow_market", { market: CONTRACTS.market }, { market: 7 }],
    ["oracle", "allow_market", { market: CONTRACTS.market }, { market: "x" }],
    ["oracle", "disallow_market", { market: CONTRACTS.market }, { market: "bad name.near" }],
    ["market", "withdraw", { amount: "340282366920938463463374607431768211455" }, { amount: "340282366920938463463374607431768211456" }],
    ["market", "halt", { market_id: "0", reason: "x" }, { market_id: "0", reason: "   " }],
    ["market", "halt", { market_id: "0", reason: "x" }, { market_id: "-1", reason: "x" }],
    ["market", "set_fee_recipients", SAMPLES.market.set_fee_recipients, { revenue_pool: CONTRACTS.oracle, treasury: DAO }],
    ["market", "set_fee_recipients", SAMPLES.market.set_fee_recipients, { revenue_pool: CONTRACTS.council, treasury: "typo.near" }],
    ["market", "set_operator", { operator_id: "a.near" }, { operator_id: "Upper.near" }],
    ["market", "set_operator", { operator_id: "a.near" }, { operator_id: "a" }],
    ["market", "propose_owner", { new_owner: "a.near" }, { new_owner: "a..near" }],
    ["market", "upgrade", { code_hash: HASH }, { code_hash: b58encode(Buffer.alloc(31, 9)) }],
    ["market", "upgrade", { code_hash: HASH }, { code_hash: `${HASH.slice(1)}0` }],
    ["market", "seal", { public_key: SECP_KEY }, { public_key: "ed25519:short" }],
    ["market", "seal", { public_key: ED_KEY }, { public_key: ED_KEY.replace("ed25519", "rsa") }],
    ["oracle", "set_jury_size", { jury_size: 1 }, { jury_size: 4 }],
    ["oracle", "set_jury_size", { jury_size: limit.oracle.MAX_PANEL }, { jury_size: limit.oracle.MAX_PANEL + 2 }],
    ["oracle", "set_jury_size", { jury_size: 3 }, { jury_size: 0 }],
    ["oracle", "set_price_threshold", { threshold: limit.oracle.MAX_MAX_PUBLISHERS }, { threshold: limit.oracle.MAX_MAX_PUBLISHERS + 1 }],
    ["oracle", "set_price_threshold", { threshold: 1 }, { threshold: 0 }],
    ["oracle", "set_bond", { bond: "1" }, { bond: "0" }],
    ["oracle", "set_window_ms", { window_ms: "1" }, { window_ms: "0" }],
    ["oracle", "set_window_ms", { window_ms: "18446744073709" }, { window_ms: "18446744073710" }],
    ["oracle", "set_draw_delay_blocks", { draw_delay_blocks: "0" }, { draw_delay_blocks: "18446744073709551616" }],
    ["oracle", "set_no_decision_recipient", { recipient: DAO }, { recipient: "typo.near" }],
    ["oracle", "add_publisher", { key: ED_KEY }, { key: SECP_KEY }],
    ["oracle", "remove_publisher", { key: ED_KEY }, { key: `ed25519:${b58encode(Buffer.alloc(33, 7))}` }],
    ["council", "set_cooldown_ns", { cooldown_ns: "1" }, { cooldown_ns: "0" }],
    ["council", "set_max_seats_per_account", { max_seats_per_account: 4294967295 }, { max_seats_per_account: 0 }],
    ["council", "allow_tokens", { token_ids: Array(limit.council.MAX_ALLOW_BATCH).fill("7") }, { token_ids: Array(limit.council.MAX_ALLOW_BATCH + 1).fill("7") }],
    ["council", "allow_tokens", { token_ids: ["7"] }, { token_ids: [] }],
    ["council", "allow_tokens", { token_ids: ["7"] }, { token_ids: [7] }],
    ["council", "allow_tokens", { token_ids: ["7"] }, { token_ids: [" "] }],
    ["council", "set_token_range", { first: "5", last: "5" }, { first: "6", last: "5" }],
    ["council", "set_nft_contract", { nft_contract: "n.near" }, { nft_contract: "" }],
  ];
  for (const [target, method, fine, bad] of cases) {
    await propose(target, method, fine);
    await assert.rejects(propose(target, method, bad), Error, `${target}.${method} ${JSON.stringify(bad)}`);
  }
});

test("the next sweep id can only move up from where the market is", async () => {
  await propose("market", "set_next_sweep_id", { next_sweep_id: NEXT_SWEEP_ID });
  await propose("market", "set_next_sweep_id", { next_sweep_id: String(BigInt(NEXT_SWEEP_ID) + 1n) });
  await assert.rejects(propose("market", "set_next_sweep_id", { next_sweep_id: "4" }), /can only move up from 5/);
  const kind = functionCall(CONTRACTS.market, "set_next_sweep_id", { next_sweep_id: "4" });
  await assert.rejects(vote(stored(1, kind)), /can only move up from 5/);
});

test("the grace period bounds are the ones in the Council's source", () => {
  const rust = source("council");
  const days = (name) => {
    const match = new RegExp(`const ${name}: u64 = (?:(\\d+) \\* )?NS_PER_DAY;`).exec(rust);
    assert.ok(match, `council has no constant ${name} in days`);
    return BigInt(match[1] ?? 1);
  };
  assert.equal(days("MIN_CLOSE_GRACE_NS"), CLOSE_GRACE_DAYS.min);
  assert.equal(days("MAX_CLOSE_GRACE_NS"), CLOSE_GRACE_DAYS.max);
});

test("a new market is checked the way the contract checks it", async () => {
  const sample = SAMPLES.market.create_market;
  const make = (change) => propose("market", "create_market", { ...sample, ...change });
  const { MAX_TITLE, MAX_RULE, MAX_SOURCE, MAX_VOID } = CONTRACT_LIMITS.market;
  await make({ title: "x".repeat(MAX_TITLE), rule_text: "x".repeat(MAX_RULE), resolution_source: "x".repeat(MAX_SOURCE), void_policy: "x".repeat(MAX_VOID) });
  for (const field of ["title", "rule_text", "resolution_source", "void_policy"]) {
    await assert.rejects(make({ [field]: " " }), new RegExp(`${field} must be`), `${field} blank`);
  }
  await assert.rejects(make({ title: "x".repeat(MAX_TITLE + 1) }), /title must be/);
  await assert.rejects(make({ title: "é".repeat(MAX_TITLE / 2 + 1) }), /title must be/, "the limit is in bytes");
  await assert.rejects(make({ category: "Weather" }), /category must be/);
  await assert.rejects(make({ subcategory: "x".repeat(33) }), /subcategory must be/);
  await assert.rejects(make({ resolve_by: "1000" }), /resolve_by must be after close_at/);
  await assert.rejects(make({ resolve_by: "999" }), /resolve_by must be after close_at/);

  const rule = { observation_time: "1000", strike: "5", decimals: 8, above: true };
  await make({ price_rule: rule });
  await make({ price_rule: { ...rule, observation_time: "1999" } });
  await make({ price_rule: null });
  await assert.rejects(make({ price_rule: { ...rule, observation_time: "999" } }), /observation_time must be/);
  await assert.rejects(make({ price_rule: { ...rule, observation_time: "2000" } }), /observation_time must be/);
  await assert.rejects(make({ price_rule: { ...rule, strike: "0" } }), /price_rule must be/);
  await assert.rejects(make({ price_rule: { ...rule, decimals: 19 } }), /price_rule must be/);
  await assert.rejects(make({ price_rule: { ...rule, extra: 1 } }), /price_rule must be/);
  await assert.rejects(make({ price_rule: { observation_time: "1000", strike: "5", decimals: 8 } }), /price_rule must be/);
});

test("a method that is not on the list is refused for every contract, whatever its name", async () => {
  const names = [
    "stage_code", "migrate", "new", "set_outcome", "ft_transfer", "mt_transfer", "mt_transfer_call", "storage_deposit", "sweep_fees",
    "reconcile_revenue", "settle_leg", "payout_bond", "constructor", "__proto__", "toString", "hasOwnProperty", "",
  ];
  for (const target of TARGETS) {
    for (const methodName of names) {
      if (Object.hasOwn(ALLOWED[target], methodName)) continue;
      await assert.rejects(propose(target, methodName, {}), /not on the allow-list|stage_code/, `${target}.${methodName}`);
    }
  }
  await assert.rejects(propose("market", "stage_code", {}), /prepareStageCode/);
  await assert.rejects(propose("oracle", ["set_bond"], { bond: "1" }), /not on the allow-list/);
  await assert.rejects(propose("governance", "set_bond", { bond: "1" }), /Unknown/);
  await assert.rejects(propose("market", "set_operator", { operator_id: "a.near" }, { description: " " }), /description/);
});

test("the DAO and the three contracts are always inputs, four different accounts, and a view is needed to read them", async () => {
  const sample = ["market", "set_paused", { paused: true }];
  await assert.rejects(propose(...sample, { treasuryId: undefined }), /treasury: a verified NEAR account ID is required, there is no default/);
  await assert.rejects(propose(...sample, { treasuryId: "Not An Account" }), /treasury/);
  await assert.rejects(propose(...sample, { contracts: { ...CONTRACTS, oracle: undefined } }), /oracle contract: a verified NEAR account ID/);
  await assert.rejects(propose(...sample, { contracts: undefined }), /market contract/);
  await assert.rejects(propose(...sample, { contracts: { ...CONTRACTS, market: DAO } }), /four different accounts/);
  await assert.rejects(propose(...sample, { contracts: { ...CONTRACTS, oracle: CONTRACTS.market } }), /four different accounts/);
  await assert.rejects(propose(...sample, { view: undefined }), /view function/);
  await assert.rejects(prepareTreasuryVote({ ...IDS, proposalId: 1, approve: false }), /view function/);
});

test("the gas of an action stays inside what its method takes, and an upgrade attaches at least the 100 TGas the contract needs", async () => {
  const bounds = [
    ["market", "set_fee_rate_bps", { fee_rate_bps: 1 }, 5, 30],
    ["market", "create_market", SAMPLES.market.create_market, 50, 150],
    ["market", "withdraw", { amount: "1" }, 50, 150],
    ["oracle", "withdraw_bond", {}, 50, 150],
    ["council", "upgrade", { code_hash: HASH }, 100, 250],
  ];
  for (const [target, method, args, min, max] of bounds) {
    const gasOf = async (gasTgas) => BigInt(callOf(await propose(target, method, args, { gasTgas })).gas) / TGAS;
    assert.equal(await gasOf(min), BigInt(min));
    assert.equal(await gasOf(max), BigInt(max));
    await assert.rejects(gasOf(min - 1), /TGas/);
    await assert.rejects(gasOf(max + 1), /TGas/);
    await assert.rejects(gasOf(max + 0.5), /TGas/);
  }
  for (const target of TARGETS) {
    const gas = BigInt(callOf(await propose(target, "upgrade", { code_hash: HASH })).gas);
    assert.ok(gas >= 100n * TGAS && gas <= 250n * TGAS, `${target} upgrade gas ${gas}`);
  }
});

test("upgrade is prepared only for code staged on that contract, and seal only once the upgrade path is proven", async () => {
  const tx = await propose("market", "upgrade", { code_hash: HASH });
  assert.equal(callOf(tx).method_name, "upgrade");
  await assert.rejects(propose("market", "upgrade", { code_hash: HASH }, { view: chain({ staged: false }) }), /no code with the hash .* is staged on market\.example\.near/);
  await propose("oracle", "seal", { public_key: ED_KEY });
  await assert.rejects(propose("oracle", "seal", { public_key: ED_KEY }, { view: chain({ proven: false }) }), /has not proven its upgrade path/);
  const kind = functionCall(CONTRACTS.market, "upgrade", { code_hash: HASH }, { gas: "150000000000000" });
  await assert.rejects(
    prepareTreasuryVote({ ...IDS, proposalId: 1, approve: true, view: chain({ proposals: [stored(1, kind)], staged: false }) }),
    /is staged/,
    "approving checks it again",
  );
  await vote(stored(1, kind));
});

test("an upgrade proposal carries only the hash, and staging a wasm builds a raw request that costs its storage", async () => {
  const wasm = Buffer.concat([Buffer.from("\0asm\x01\0\0\0"), Buffer.alloc(100_000, 3)]);
  const staged = prepareStageCode({ contracts: CONTRACTS, target: "council", wasm });
  const call = staged.actions[0].params;
  assert.equal(staged.receiverId, CONTRACTS.council);
  assert.deepEqual([call.methodName, call.gas], ["stage_code", (300n * TGAS).toString()]);
  assert.ok(Buffer.isBuffer(call.args) && call.args.equals(wasm), "the wasm is the raw call input");
  assert.equal(staged.codeHash, codeHash(wasm));
  // Measured with upgrade::stage_code: it charges for the wasm plus 84 bytes, a 44 byte key and 40 bytes the network adds.
  const storage = BigInt(wasm.length + 84) * 10n ** 19n;
  assert.equal(BigInt(call.deposit), storage + 10n ** 23n, "the storage plus a margin, which the contract refunds");
  const proposal = await propose("council", "upgrade", { code_hash: staged.codeHash });
  assert.deepEqual(JSON.parse(Buffer.from(callOf(proposal).args, "base64")), { code_hash: staged.codeHash });
  assert.ok(JSON.stringify(proposal).length < 1000, "no wasm in the proposal");
  for (const bad of [Buffer.alloc(0), Buffer.from("not wasm"), Buffer.from("\0as"), "\0asm", null]) {
    assert.throws(() => prepareStageCode({ contracts: CONTRACTS, target: "market", wasm: bad }), /wasm binary/);
  }
  assert.throws(() => prepareStageCode({ contracts: CONTRACTS, target: "governance", wasm }), /Unknown/);
  assert.throws(() => prepareStageCode({ contracts: {}, target: "market", wasm }), /market contract/);
});

test("the code hash is the sha256 in base58, which is how upgrade::stage_code files the wasm", () => {
  assert.equal(codeHash(Buffer.from("abc")), "DYu3G8aGTMBW1WrTw76zxQJQU4DHLw9MLyy7peG4LKkY");
  assert.equal(codeHash(Buffer.from("\0asm\x01\0\0\0")), "AwLEfgaHQguPVVLGUV9Sf5QKGrMMMr2N6MVSjBj9dJAh");
  assert.equal(b58encode(Buffer.alloc(32, 7)), "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
  assert.equal(b58encode(Buffer.concat([Buffer.alloc(2), Buffer.alloc(30, 7)])), "112QftUJC9yYkE7xr4ikuFmaHKhLCxkpK5RL1J2QqC2");
  assert.equal(b58encode(Buffer.alloc(0)), "");
});

// ---- the vote helper ---------------------------------------------------------------------------------------------

const SETTER = functionCall(CONTRACTS.market, "set_fee_rate_bps", { fee_rate_bps: 150 });
// All 17 variants of ProposalKind at proposals.rs:67-121 of the pinned revision.
const KIND_SAMPLES = {
  FunctionCall: SETTER,
  Vote: "Vote",
  ChangeConfig: { ChangeConfig: { config: { name: "n", purpose: "p", metadata: "" } } },
  ChangePolicy: { ChangePolicy: { policy: { roles: [] } } },
  AddMemberToRole: { AddMemberToRole: { member_id: "eve.near", role: "council" } },
  RemoveMemberFromRole: { RemoveMemberFromRole: { member_id: "bob.near", role: "council" } },
  UpgradeSelf: { UpgradeSelf: { hash: HASH } },
  UpgradeRemote: { UpgradeRemote: { receiver_id: CONTRACTS.market, method_name: "upgrade", hash: HASH } },
  Transfer: { Transfer: { token_id: "", receiver_id: "eve.near", amount: "1000000000000000000000000", msg: null } },
  SetStakingContract: { SetStakingContract: { staking_id: "staking.near" } },
  AddBounty: { AddBounty: { bounty: { description: "d", token: "", amount: "1", times: 1, max_deadline: "1" } } },
  BountyDone: { BountyDone: { bounty_id: 0, receiver_id: "eve.near" } },
  FactoryInfoUpdate: { FactoryInfoUpdate: { factory_info: { factory_id: "f.near", auto_update: true } } },
  ChangePolicyAddOrUpdateRole: { ChangePolicyAddOrUpdateRole: { role: { name: "all", kind: "Everyone", permissions: ["*:*"] } } },
  ChangePolicyRemoveRole: { ChangePolicyRemoveRole: { role: "council" } },
  ChangePolicyUpdateDefaultVotePolicy: { ChangePolicyUpdateDefaultVotePolicy: { vote_policy: { threshold: 1 } } },
  ChangePolicyUpdateParameters: { ChangePolicyUpdateParameters: { parameters: { proposal_period: "1" } } },
};

test("the guard table covers all 17 Sputnik proposal kinds", () => {
  assert.equal(Object.keys(KIND_SAMPLES).length, 17);
  assert.deepEqual(
    [...Object.keys(GUARDED_KINDS), "FunctionCall", "Vote"].sort(),
    Object.keys(KIND_SAMPLES).sort(),
  );
});

test("approving any kind except an allow-listed call or a signalling Vote is refused until the caller names that kind", async () => {
  for (const [name, kind] of Object.entries(KIND_SAMPLES)) {
    const proposal = stored(4, kind);
    const approve = (extra) => vote(proposal, extra);
    if (name === "FunctionCall" || name === "Vote") {
      await approve({});
      continue;
    }
    await assert.rejects(approve({}), new RegExp(`^Error: ${name} `), `${name} unnamed`);
    await assert.rejects(approve({ acknowledge: [] }), new RegExp(`${name} `), `${name} empty list`);
    const other = Object.keys(GUARDED_KINDS).find((n) => n !== name);
    await assert.rejects(approve({ acknowledge: [other] }), new RegExp(`${name} `), `${name} another kind named`);
    const tx = await approve({ acknowledge: [name] });
    assert.deepEqual(tx.actions[0].params.args.proposal, kind, `${name} named`);
  }
});

test("rejecting is allowed for every kind, and a kind or a name the table does not know is refused", async () => {
  for (const [name, kind] of Object.entries(KIND_SAMPLES)) {
    const tx = await vote(stored(4, kind), { approve: false });
    assert.equal(tx.actions[0].params.args.action, "VoteReject", name);
  }
  for (const kind of [{ Frobnicate: {} }, "Frobnicate", "FunctionCall", { Vote: {} }, { FunctionCall: SETTER.FunctionCall, Vote: null }, {}, [], null, 7]) {
    await assert.rejects(vote(stored(4, kind)), /not a kind this helper knows|acknowledge names|FunctionCall/, JSON.stringify(kind));
  }
  for (const acknowledge of [["FunctionCall"], ["Vote"], ["Frobnicate"], "Transfer", [7]]) {
    await assert.rejects(vote(stored(4, KIND_SAMPLES.Transfer), { acknowledge }), /acknowledge names proposal kinds/, JSON.stringify(acknowledge));
  }
});

test("a vote binds to the kind the DAO stores, whatever the caller passes, and builds act_proposal", async () => {
  const proposal = stored(9, SETTER);
  const tx = await vote(proposal, { proposalKind: KIND_SAMPLES.Transfer });
  assert.equal(tx.receiverId, DAO);
  const call = tx.actions[0].params;
  assert.deepEqual([call.methodName, call.deposit, call.gas], ["act_proposal", "0", (300n * TGAS).toString()]);
  assert.deepEqual(call.args, { id: 9, action: "VoteApprove", proposal: SETTER, memo: null });
  const rejected = await vote(proposal, { approve: false });
  assert.deepEqual(rejected.actions[0].params.args, { id: 9, action: "VoteReject", proposal: SETTER, memo: null });
  await assert.rejects(prepareTreasuryVote({ ...IDS, proposalId: 9, view: chain({ proposals: [proposal] }) }), /explicit/);
  await assert.rejects(prepareTreasuryVote({ ...IDS, proposalId: 9, approve: "yes", view: chain({ proposals: [proposal] }) }), /explicit/);
  for (const proposalId of [-1, 1.5, "9", undefined, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(prepareTreasuryVote({ ...IDS, proposalId, approve: false, view: chain({ proposals: [proposal] }) }), /Invalid proposal ID/);
  }
  await assert.rejects(prepareTreasuryVote({ ...IDS, proposalId: 10, approve: false, view: chain({ proposals: [proposal] }) }), /ERR_NO_PROPOSAL/);
  const wrong = { ...proposal, id: 8 };
  await assert.rejects(prepareTreasuryVote({ ...IDS, proposalId: 9, approve: false, view: async () => wrong }), /different proposal/);
});

test("only a proposal still in progress can be approved", async () => {
  for (const status of ["Approved", "Rejected", "Removed", "Expired", "Moved", "Failed"]) {
    await assert.rejects(vote(stored(2, SETTER, status)), new RegExp(`is ${status}`));
    await vote(stored(2, SETTER, status), { approve: false });
  }
});

test("a function call is approved only when its receiver is a configured contract and its one action is on the allow-list", async () => {
  const bad = [
    ["another account", functionCall("intents.near", "mt_transfer", { receiver_id: "eve.near", token_id: "x", amount: "1" }), /is not the market, oracle or council/],
    ["the DAO itself", functionCall(DAO, "set_fee_rate_bps", { fee_rate_bps: 1 }), /is not the market, oracle or council/],
    ["a method that is not listed", functionCall(CONTRACTS.market, "stage_code", {}), /market\.stage_code is not on the allow-list/],
    ["a name every object has", functionCall(CONTRACTS.market, "constructor", {}), /market\.constructor is not on the allow-list/],
    ["a name that sets the prototype", functionCall(CONTRACTS.oracle, "__proto__", {}), /oracle\.__proto__ is not on the allow-list/],
    ["a method of another contract", functionCall(CONTRACTS.market, "set_jury_size", { jury_size: 3 }), /market\.set_jury_size is not on the allow-list/],
    ["a deposit on a setter", functionCall(CONTRACTS.market, "set_paused", { paused: true }, { deposit: "1" }), /deposit of 0, not 1/],
    ["no deposit on a withdrawal", functionCall(CONTRACTS.market, "withdraw", { amount: "1" }, { gas: "100000000000000" }), /deposit of 1, not 0/],
    ["too much gas", functionCall(CONTRACTS.market, "set_paused", { paused: true }, { gas: "31000000000000" }), /5 to 30 TGas/],
    ["too little gas", functionCall(CONTRACTS.market, "set_paused", { paused: true }, { gas: "4999999999999" }), /5 to 30 TGas/],
    ["an upgrade with 99 TGas", functionCall(CONTRACTS.oracle, "upgrade", { code_hash: HASH }, { gas: "99000000000000" }), /100 to 250 TGas/],
    ["gas that is not a number", functionCall(CONTRACTS.market, "set_paused", { paused: true }, { gas: "lots" }), /not a whole number/],
    ["an extra argument", functionCall(CONTRACTS.market, "set_paused", { paused: true, also: 1 }), /unknown argument also/],
    ["an argument over the cap", functionCall(CONTRACTS.market, "set_fee_rate_bps", { fee_rate_bps: 2001 }), /fee_rate_bps must be/],
    ["a wrong recipient", functionCall(CONTRACTS.market, "set_fee_recipients", { revenue_pool: CONTRACTS.council, treasury: "typo.near" }), /treasury must be/],
    ["arguments that are not base64", functionCall(CONTRACTS.market, "set_paused", null, { raw: "eyJwYXVzZWQiOnRydWV9 " }), /canonical base64/],
    ["arguments that are not JSON", functionCall(CONTRACTS.market, "set_paused", null, { raw: Buffer.from("paused").toString("base64") }), /not JSON/],
    ["arguments with spacing", functionCall(CONTRACTS.market, "set_paused", null, { raw: Buffer.from('{"paused": true}').toString("base64") }), /canonical JSON/],
    ["a repeated key", functionCall(CONTRACTS.market, "set_paused", null, { raw: Buffer.from('{"paused":false,"paused":true}').toString("base64") }), /canonical JSON/],
    ["arguments that are a list", functionCall(CONTRACTS.market, "set_paused", [true]), /must be an object/],
    ["no arguments", functionCall(CONTRACTS.market, "set_paused", null, { raw: "" }), /not JSON/],
  ];
  for (const [what, kind, message] of bad) {
    await assert.rejects(vote(stored(5, kind)), message, what);
    await vote(stored(5, kind), { approve: false });
  }

  const action = SETTER.FunctionCall.actions[0];
  const two = { FunctionCall: { receiver_id: CONTRACTS.market, actions: [action, action] } };
  const none = { FunctionCall: { receiver_id: CONTRACTS.market, actions: [] } };
  const odd = { FunctionCall: { receiver_id: CONTRACTS.market, actions: [{ ...action, extra: 1 }] } };
  const lone = { FunctionCall: { receiver_id: CONTRACTS.market } };
  const mixed = { FunctionCall: { receiver_id: CONTRACTS.market, actions: [action, { ...functionCall(CONTRACTS.oracle, "set_bond", { bond: "1" }).FunctionCall.actions[0] }] } };
  await assert.rejects(vote(stored(5, two)), /exactly one action/);
  await assert.rejects(vote(stored(5, none)), /exactly one action/);
  await assert.rejects(vote(stored(5, mixed)), /exactly one action/);
  await assert.rejects(vote(stored(5, odd)), /method_name, args, deposit and gas/);
  await assert.rejects(vote(stored(5, lone)), /receiver_id and a list of actions/);

  const numeric = functionCall(CONTRACTS.market, "set_paused", { paused: true });
  numeric.FunctionCall.actions[0].gas = 30_000_000_000_000;
  await vote(stored(5, numeric));
});

test("review says what an approved call does, and the keeper can use it on a pending proposal", async () => {
  const summary = await reviewKind(functionCall(CONTRACTS.council, "set_token_range", { first: "1", last: "9" }), { ...IDS, view: chain() });
  assert.deepEqual(summary, {
    kind: "FunctionCall", target: "council", method: "set_token_range", args: { first: "1", last: "9" }, deposit: "0", gasTgas: 30,
  });
  assert.deepEqual(await reviewKind("Vote", { ...IDS, view: chain() }), { kind: "Vote" });
  assert.deepEqual(await reviewKind(KIND_SAMPLES.Transfer, { ...IDS, view: chain(), acknowledge: ["Transfer"] }), { kind: "Transfer", acknowledged: true });
});

// ---- the contract sources ----------------------------------------------------------------------------------------

const source = (contract) => fs.readFileSync(path.join(CONTRACTS_DIR, contract, "src", "lib.rs"), "utf8");

// The public methods of a contract with the lines of their bodies. rustfmt puts a method's closing brace at four spaces.
function publicMethods(rust) {
  const lines = rust.split("\n");
  const found = [];
  lines.forEach((line, i) => {
    const name = /^    pub fn (\w+)\(/.exec(line)?.[1];
    if (!name) return;
    const end = lines.findIndex((l, j) => j > i && l === "    }");
    found.push({ name, body: lines.slice(i, end + 1).join("\n") });
  });
  return found;
}

const OWNER_CHECKS = [
  /self\.only_owner\(\)/,
  /self\.only_operator_or_owner\(\)/,
  /== self\.owner\b/,
  /self\.pending_owner\.as_ref\(\) == Some/,
  /upgrade::(stage_code|take_staged|deploy_and_migrate|delete_key|require_state_version)\b/,
  /env::state_read\(/, // Explicit previous-layout migrations are upgrade paths too.
];
const guardedMethods = (rust) => publicMethods(rust).filter(({ body }) => OWNER_CHECKS.some((check) => check.test(body))).map(({ name }) => name);

// Methods that check the owner or belong to the upgrade path and are deliberately not prepared by the helper.
const UPGRADE_PATH_EXCLUDED = {
  stage_code: "open to anyone and takes the wasm as its raw input, so it is sent by a stager (prepareStageCode) and the proposal carries only the hash",
  migrate: "private: it runs inside the batch that upgrade sends, in the new code, and nobody can call it",
};
const EXCLUDED = {
  market: {
    ...UPGRADE_PATH_EXCLUDED,
    mt_on_transfer: "only the verifier calls it, and its seed message compares the sender with the owner and operator; the DAO would send that through intents.near, which is not one of the three contracts",
  },
  oracle: UPGRADE_PATH_EXCLUDED,
  council: UPGRADE_PATH_EXCLUDED,
};

test("the scan finds owner-checked and upgrade-path methods in source text", () => {
  const rust = [
    "impl X {",
    "    pub fn a(&mut self) {",
    "        self.only_owner();",
    "    }",
    "    pub fn b(&self) -> u32 {",
    "        1",
    "    }",
    "    pub fn c(&mut self, k: u32) {",
    "        require!(env::predecessor_account_id() == self.owner, \"owner only\");",
    "    }",
    "    pub fn d(&mut self) {",
    "        self.only_operator_or_owner();",
    "    }",
    "    pub fn e(&mut self) {",
    "        require!(self.pending_owner.as_ref() == Some(&who));",
    "    }",
    "    pub fn f() -> Self {",
    "        upgrade::require_state_version(1);",
    "    }",
    "    pub fn g(\n        &mut self,\n    ) -> U64 {",
    "        self.only_owner();",
    "    }",
    "    fn hidden(&mut self) {",
    "        self.only_owner();",
    "    }",
    "}",
  ].join("\n");
  assert.deepEqual(guardedMethods(rust), ["a", "c", "d", "e", "f", "g"]);
});

test("every owner or upgrade-path method in the contract sources is prepared by the helper or deliberately excluded with a reason", () => {
  for (const target of TARGETS) {
    const methods = publicMethods(source(target));
    const names = methods.map((m) => m.name);
    const guarded = guardedMethods(source(target));
    for (const required of ["upgrade", "seal", "propose_owner", "accept_owner", "stage_code", "migrate"]) {
      assert.ok(guarded.includes(required), `${target}: the scan should find ${required}, found ${guarded}`);
    }
    for (const method of guarded) {
      const prepared = Object.hasOwn(ALLOWED[target], method);
      const excluded = Object.hasOwn(EXCLUDED[target], method);
      assert.ok(prepared !== excluded, `${target}.${method} is ${prepared ? "both prepared and excluded" : "neither prepared nor excluded"}: add it to ALLOWED in treasury.mjs or to EXCLUDED here with a reason`);
      if (excluded) assert.ok(EXCLUDED[target][method].length > 20, `${target}.${method} needs a reason`);
    }
    for (const method of Object.keys(EXCLUDED[target])) assert.ok(guarded.includes(method), `${target}.${method} is excluded but is not an owner method`);
    for (const method of Object.keys(ALLOWED[target])) assert.ok(names.includes(method), `${target}.${method} is on the allow-list but the contract has no such method`);
  }
});

test("the methods the DAO calls for itself, and not as the owner, are the two that take 1 yocto", () => {
  for (const [target, method] of [["market", "withdraw"], ["oracle", "withdraw_bond"]]) {
    const body = publicMethods(source(target)).find((m) => m.name === method).body;
    assert.match(body, /assert_one_yocto\(\)/, `${target}.${method}`);
    assert.doesNotMatch(body, /only_owner|== self\.owner/, `${target}.${method} has no owner check`);
  }
  const takesOneYocto = entries().filter(([t, m]) => ALLOWED[t][m].deposit === "1").map(([t, m]) => `${t}.${m}`);
  assert.deepEqual(takesOneYocto, ["market.withdraw", "oracle.withdraw_bond"]);
});

test("the limits and the gas floor the helper enforces are the ones in the contract source", () => {
  for (const [contract, limits] of Object.entries(CONTRACT_LIMITS)) {
    for (const [name, value] of Object.entries(limits)) {
      const match = new RegExp(`const ${name}: \\w+ = ([0-9_]+);`).exec(source(contract));
      assert.ok(match, `${contract} has no constant ${name}`);
      assert.equal(BigInt(match[1].replaceAll("_", "")), BigInt(value), `${contract}.${name}`);
    }
  }
  const upgradeGas = /pub const GAS_UPGRADE: Gas = Gas::from_tgas\((\d+)\);/.exec(fs.readFileSync(path.join(CONTRACTS_DIR, "upgrade", "src", "lib.rs"), "utf8"));
  assert.equal(Number(upgradeGas[1]), ALLOWED.market.upgrade.gas.min);
  const withdrawFloor = /GAS_WITHDRAW_OVERHEAD: Gas = Gas::from_tgas\((\d+)\)/.exec(source("oracle"));
  assert.ok(Number(withdrawFloor[1]) + 15 + 10 <= ALLOWED.oracle.withdraw_bond.gas.min, "withdraw_bond needs 15 + 10 + its own overhead");
});

test("market creation pays live storage policy and refuses underfunded stored proposals", async () => {
  const tx = await propose("market", "create_market", SAMPLES.market.create_market);
  assert.equal(callOf(tx).deposit, MARKET_STORAGE_DEPOSIT);
  const kind = functionCall(CONTRACTS.market, "create_market", SAMPLES.market.create_market, { gas: "100000000000000", deposit: "0" });
  await assert.rejects(vote(stored(9, kind)), /takes a deposit/);
});

test("storage policy mirrors hard ranges and sweep frequency cannot fall below an hour", async () => {
  await assert.rejects(propose("market", "set_storage_policy", { market_storage_deposit: "1", reserve: SAMPLES.market.set_storage_policy.reserve }), /market_storage_deposit/);
  await assert.rejects(propose("market", "set_sweep_timing", { ...SAMPLES.market.set_sweep_timing, min_interval_minutes: 59 }), /min_interval_minutes/);
});

test("runway accounts for locked storage, reserve and all configured daily growth", () => {
  const inputs = { amount: "1000000000000000000000000", storageUsage: 1000, reserve: "100000000000000000000000", marketsPerDay: 10, bytesPerMarket: 200, fixedBytesPerDay: 1000, alarmDays: 30 };
  const report = storageRunway(inputs);
  assert.equal(report.bytesPerDay, "3000");
  assert.equal(report.available, "890000000000000000000000");
  assert.equal(report.days, "29");
  assert.equal(report.alarm, true);
  assert.equal(storageRunway({ ...inputs, alarmDays: 29 }).alarm, false);
  assert.equal(storageRunway({ ...inputs, marketsPerDay: 0, fixedBytesPerDay: 0 }).days, null);
  assert.equal(storageRunway({ ...inputs, amount: "0", marketsPerDay: 0, fixedBytesPerDay: 0 }).alarm, true);
  for (const invalid of [{ alarmDays: 0 }, { marketsPerDay: -1 }, { bytesPerMarket: 0.5 }, { fixedBytesPerDay: NaN }, { reserve: "-1" }]) {
    assert.throws(() => storageRunway({ ...inputs, ...invalid }));
  }
});

test("native storage top-ups prepare only a scoped treasury vote, without sending funds", async () => {
  for (const target of ["oracle", "council"]) {
    const request = await prepareStorageTopUp({ ...IDS, target, amount: "1000000000000000000000000", description: "Fund contract storage", view: chain() });
    assert.equal(request.receiverId, DAO);
    assert.equal(request.actions[0].params.deposit, BOND);
    assert.deepEqual(proposalOf(request).kind, { Transfer: { token_id: "", receiver_id: CONTRACTS[target], amount: "1000000000000000000000000" } });
    await assert.rejects(reviewKind(proposalOf(request).kind, { ...IDS, view: chain() }), /acknowledge/);
  }
  for (const invalid of [{ target: "market" }, { target: "foreign.near" }, { amount: "0" }, { amount: "1.0" }, { description: "" }]) {
    await assert.rejects(prepareStorageTopUp({ ...IDS, target: "oracle", amount: "1", description: "Fund storage", view: chain(), ...invalid }));
  }
});
