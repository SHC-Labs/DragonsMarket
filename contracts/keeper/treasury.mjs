// Prepares wallet requests for the Trezu/SputnikDAO that owns the market, oracle and council. It reads the DAO and the
// contracts and never signs or submits anything.
// ABI: near-daos/sputnik-dao-contract, revision 5434a59dec23ee0c49df8c8c4350c208a7e75b0b.
//
// Everything the DAO may call on the three contracts is in ALLOWED, with the arguments, deposit and gas each call takes.
// A method that is not there is refused, so a method added to a contract stays out until someone adds it here. The vote
// helper applies the same table to a stored proposal, and refuses to approve any other kind of proposal unless the caller
// names the kind. `view` is a function (account, method, args) that returns a contract view as JSON; see viewer() in
// chain.mjs. The treasury account is always an input: there is no default.
//
// Staging code is not a proposal. stage_code is open to anyone and carries the wasm as its raw input, so a stager sends it
// (prepareStageCode) and the upgrade proposal then carries only the 32 byte hash (codeHash).
import crypto from "node:crypto";
import { b58decode, b58encode } from "./chain.mjs";

const TGAS = 10n ** 12n;
// No transaction carries more, and act_proposal needs all it can get when the vote that reaches the threshold runs the call.
const MAX_TX_TGAS = 300n;
const U32_MAX = 2 ** 32 - 1;
const NS_PER_DAY = 86_400n * 10n ** 9n;
// The ranges the market accepts for the void rules, in nanoseconds: the window is 1 hour to 7 days, the grace 1 to 60 days.
const VOID_WINDOW_NS = { min: NS_PER_DAY / 24n, max: 7n * NS_PER_DAY };
const VOID_GRACE_NS = { min: NS_PER_DAY, max: 60n * NS_PER_DAY };
// The range the Council and the oracle accept for their reconcile wait: 10 minutes to 7 days.
const RECONCILE_WAIT_NS = { min: 600n * 10n ** 9n, max: 7n * NS_PER_DAY };
// The Council's grace period, 1 to 30 days (MIN_CLOSE_GRACE_NS and MAX_CLOSE_GRACE_NS in its source).
export const CLOSE_GRACE_DAYS = { min: 1n, max: 30n };
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;
const NS_PER_MS = 1_000_000n;
const YOCTO_PER_BYTE = 10n ** 19n;
// upgrade::stage_code keeps the wasm under "staged_code:" plus the 32 byte hash, and the network adds 40 bytes to every
// stored key. Whatever is attached beyond the real cost is refunded to the stager.
const STAGE_KEY_BYTES = "staged_code:".length + 32;
const STAGE_RECORD_BYTES = 40;
const STAGE_DEPOSIT_MARGIN = 10n ** 23n;
const SLUG_MAX = 32;
const ID_TEXT_MAX = 128;
const REASON_MAX = 500;
const ED25519_KEY_BYTES = 32;
const SECP256K1_KEY_BYTES = 64;
const HASH_BYTES = 32;
const MAX_DECIMALS = 18;
const WASM_MAGIC = Buffer.from("\0asm", "latin1");

export const TARGETS = ["market", "oracle", "council"];

// The ceilings the contracts enforce, by the names the contract source gives them. A test reads the source and fails when
// one of these differs.
export const CONTRACT_LIMITS = {
  market: {
    HARD_MAX_FEE_RATE_BPS: 2_000,
    HARD_MIN_REVENUE_SHARE_BPS: 500,
    HARD_MAX_REVENUE_SHARE_BPS: 9_000,
    HARD_MAX_MIN_SWEEP: 1_000_000_000n,
    HARD_MAX_CREATE_FEE: 100_000_000n,
    HARD_MIN_OPEN_PRICE: 1_000n,
    HARD_MAX_OPEN_PRICE: 999_000n,
    HARD_MIN_POSITIONS: 5,
    HARD_MAX_POSITIONS: 100,
    HARD_MAX_SETTLE_WAIT_MINUTES: 1_440,
    HARD_MIN_RECONCILE_WAIT_MINUTES: 10,
    HARD_MAX_RECONCILE_WAIT_MINUTES: 10_080,
    HARD_MAX_SWEEP_INTERVAL_MINUTES: 1_440,
    MAX_TITLE: 200,
    MAX_RULE: 2000,
    MAX_SOURCE: 300,
    MAX_VOID: 500,
  },
  oracle: {
    MAX_PANEL: 21,
    MIN_MAX_PUBLISHERS: 1,
    MAX_MAX_PUBLISHERS: 25,
    MIN_JUROR_SHARE_BPS: 500,
    MAX_JUROR_SHARE_BPS: 5_000,
    MIN_NO_DECISION_JUROR_SHARE_BPS: 1_000,
    MAX_NO_DECISION_JUROR_SHARE_BPS: 10_000,
    MIN_APPLY_BUFFER_NS: 5_000_000_000n,
    MAX_APPLY_BUFFER_NS: 300_000_000_000n,
  },
  council: { MAX_ALLOW_BATCH: 100 },
};
const { market: LIMIT_MARKET, oracle: LIMIT_ORACLE, council: LIMIT_COUNCIL } = CONTRACT_LIMITS;

const reject = (message) => {
  throw new Error(message);
};

// ---- argument checks ---------------------------------------------------------------------------------------------
// Each takes the value and the DAO's account ids, returns the value, and throws what the value should have been.

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ACCOUNT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SLUG = /^[a-z0-9-]+$/;

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function accountId(value, what = "account") {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 || !ACCOUNT.test(value)) {
    reject(`${what}: a verified NEAR account ID is required, there is no default`);
  }
  return value;
}

const flag = (v) => (typeof v === "boolean" ? v : reject("true or false"));
const account = (v) => accountId(v);
const exactly = (name) => (v, ids) => (v === ids[name] ? v : reject(`the ${name} account ${ids[name]}`));
const integer = (max, min = 0) => (v) =>
  Number.isInteger(v) && v >= min && v <= max ? v : reject(`an integer from ${min} to ${max}`);
const decimal = (max, min = 0n) => (v) => {
  if (typeof v !== "string" || !DECIMAL.test(v)) reject("a decimal string in base units");
  return BigInt(v) >= min && BigInt(v) <= max ? v : reject(`a decimal string from ${min} to ${max}`);
};
const u64 = (min = 0n, max = U64_MAX) => decimal(max, min);
const u128 = (min = 0n, max = U128_MAX) => decimal(max, min);
const text = (max) => (v) =>
  typeof v === "string" && v.trim() !== "" && Buffer.byteLength(v) <= max ? v : reject(`non-blank text of at most ${max} bytes`);
const slug = (v) =>
  typeof v === "string" && v.length > 0 && v.length <= SLUG_MAX && SLUG.test(v)
    ? v
    : reject(`a slug of at most ${SLUG_MAX} lowercase letters, digits and hyphens`);
const oddUpTo = (max) => (v) =>
  Number.isInteger(v) && v >= 1 && v <= max && v % 2 === 1 ? v : reject(`an odd number from 1 to ${max}`);
const oneOf = (...values) => (v) => (values.includes(v) ? v : reject(`one of ${values.join(", ")}`));
const optional = (check) => Object.assign((v, ids) => (v === null ? null : check(v, ids)), { optional: true });

function base58Bytes(encoded, length) {
  if (typeof encoded !== "string") reject("a base58 string");
  let bytes;
  try {
    bytes = b58decode(encoded);
  } catch (e) {
    reject(e.message);
  }
  if (bytes.length !== length) reject(`base58 for exactly ${length} bytes`);
}

const hash32 = (v) => {
  base58Bytes(v, HASH_BYTES);
  return v;
};

const publicKey = (...curves) => (v) => {
  const sizes = { ed25519: ED25519_KEY_BYTES, secp256k1: SECP256K1_KEY_BYTES };
  const match = typeof v === "string" ? /^(ed25519|secp256k1):(.+)$/.exec(v) : null;
  if (!match || !curves.includes(match[1])) reject(`a ${curves.join(" or ")} public key like ${curves[0]}:<base58>`);
  base58Bytes(match[2], sizes[match[1]]);
  return v;
};
const ed25519 = publicKey("ed25519");
const anyKey = publicKey("ed25519", "secp256k1");

// Runs a check on a part of a value and says which part failed.
function within(part, check, v, ids) {
  try {
    return check(v, ids);
  } catch (e) {
    return reject(`${part}${e.message}`);
  }
}

const list = (check, max) => (v, ids) =>
  Array.isArray(v) && v.length >= 1 && v.length <= max
    ? v.map((item) => within("a list whose items are ", check, item, ids))
    : reject(`a list of 1 to ${max} items`);

const record = (shape) => (v, ids) => {
  if (!isRecord(v) || Object.keys(v).some((k) => !Object.hasOwn(shape, k))) reject(`an object with the keys ${Object.keys(shape).join(", ")}`);
  return Object.fromEntries(Object.entries(shape).map(([k, check]) => [k, within(`an object whose ${k} is `, check, v[k], ids)]));
};

const priceRule = record({
  observation_time: u64(),
  strike: u128(1n),
  decimals: integer(MAX_DECIMALS),
  above: flag,
});

// ---- the allow-list ----------------------------------------------------------------------------------------------
// gas is in TGas: the least the DAO may attach, what a prepared proposal attaches, and the most. deposit is yoctoNEAR.
// needs names a condition read from the chain before the proposal is prepared or approved.

const SETTER_GAS = { min: 5, def: 30, max: 30 };
// For a method that sends a promise of its own. 33 TGas is the least withdraw_bond accepts.
const CALLING_GAS = { min: 50, def: 100, max: 150 };
// The contract refuses less than 100 TGas (upgrade::GAS_UPGRADE).
const UPGRADE_GAS = { min: 100, def: 150, max: 250 };

const call = (args, extra = {}) => ({ deposit: "0", gas: SETTER_GAS, args, ...extra });
const calling = (args, extra = {}) => call(args, { gas: CALLING_GAS, ...extra });
const ownDeposit = { deposit: "1" };
const windowMs = u64(1n, U64_MAX / NS_PER_MS);

const upgradePath = {
  upgrade: call({ code_hash: hash32 }, { gas: UPGRADE_GAS, needs: "staged" }),
  seal: call({ public_key: anyKey }, { needs: "upgrade_proven" }),
  propose_owner: call({ new_owner: account }),
  accept_owner: call({}),
};
const setOperator = call({ operator_id: account });
const ordered = (first, last) => (args) => {
  if (BigInt(args[first]) > BigInt(args[last])) reject(`${first} must not be above ${last}`);
};

export const ALLOWED = {
  market: {
    ...upgradePath,
    set_operator: setOperator,
    set_fee_recipients: call({ revenue_pool: exactly("council"), treasury: exactly("treasury") }),
    set_revenue_share_bps: call({ revenue_share_bps: integer(LIMIT_MARKET.HARD_MAX_REVENUE_SHARE_BPS, LIMIT_MARKET.HARD_MIN_REVENUE_SHARE_BPS) }),
    set_min_sweep: call({ min_sweep: u128(1n, LIMIT_MARKET.HARD_MAX_MIN_SWEEP) }),
    set_next_sweep_id: call({ next_sweep_id: u64(1n) }, { needs: "sweep_id_forward" }),
    set_fee_rate_bps: call({ fee_rate_bps: integer(LIMIT_MARKET.HARD_MAX_FEE_RATE_BPS) }),
    set_create_fee: call({ create_fee: u128(0n, LIMIT_MARKET.HARD_MAX_CREATE_FEE) }),
    reconcile_leg: call({ sweep_id: u64(1n), leg: oneOf("council", "treasury"), arrived: flag }),
    reconcile_withdrawal: call({ id: u64(1n), paid: flag }),
    set_paused: call({ paused: flag }),
    set_sells_paused: call({ sells_paused: flag }),
    set_void_rules: call({
      price_window_ns: u64(VOID_WINDOW_NS.min, VOID_WINDOW_NS.max),
      grace_ns: u64(VOID_GRACE_NS.min, VOID_GRACE_NS.max),
    }),
    set_sweep_timing: call(
      {
        settle_wait_minutes: integer(LIMIT_MARKET.HARD_MAX_SETTLE_WAIT_MINUTES, 1),
        reconcile_wait_minutes: integer(LIMIT_MARKET.HARD_MAX_RECONCILE_WAIT_MINUTES, LIMIT_MARKET.HARD_MIN_RECONCILE_WAIT_MINUTES),
        min_interval_minutes: integer(LIMIT_MARKET.HARD_MAX_SWEEP_INTERVAL_MINUTES, 1),
      },
      { check: ordered("settle_wait_minutes", "reconcile_wait_minutes") },
    ),
    set_open_price_bounds: call(
      { min: u128(LIMIT_MARKET.HARD_MIN_OPEN_PRICE, LIMIT_MARKET.HARD_MAX_OPEN_PRICE), max: u128(LIMIT_MARKET.HARD_MIN_OPEN_PRICE, LIMIT_MARKET.HARD_MAX_OPEN_PRICE) },
      { check: ordered("min", "max") },
    ),
    set_max_positions: call({ max_positions: integer(LIMIT_MARKET.HARD_MAX_POSITIONS, LIMIT_MARKET.HARD_MIN_POSITIONS) }),
    set_fee_limits: call(
      {
        max_fee_rate_bps: integer(LIMIT_MARKET.HARD_MAX_FEE_RATE_BPS),
        max_create_fee: u128(0n, LIMIT_MARKET.HARD_MAX_CREATE_FEE),
        min_revenue_share_bps: integer(LIMIT_MARKET.HARD_MAX_REVENUE_SHARE_BPS, LIMIT_MARKET.HARD_MIN_REVENUE_SHARE_BPS),
        max_revenue_share_bps: integer(LIMIT_MARKET.HARD_MAX_REVENUE_SHARE_BPS, LIMIT_MARKET.HARD_MIN_REVENUE_SHARE_BPS),
        max_min_sweep: u128(1n, LIMIT_MARKET.HARD_MAX_MIN_SWEEP),
      },
      { check: ordered("min_revenue_share_bps", "max_revenue_share_bps") },
    ),
    halt: call({ market_id: u64(), reason: text(REASON_MAX) }),
    resume: call({ market_id: u64() }),
    claim_residual: call({ market_id: u64() }),
    retry_register: calling({ market_id: u64() }),
    create_market: calling(
      {
        title: text(LIMIT_MARKET.MAX_TITLE),
        rule_text: text(LIMIT_MARKET.MAX_RULE),
        resolution_source: text(LIMIT_MARKET.MAX_SOURCE),
        void_policy: text(LIMIT_MARKET.MAX_VOID),
        category: slug,
        subcategory: slug,
        close_at: u64(1n),
        resolve_by: u64(1n),
        price_rule: optional(priceRule),
      },
      {
        check: ({ close_at, resolve_by, price_rule }) => {
          if (BigInt(resolve_by) <= BigInt(close_at)) reject("resolve_by must be after close_at");
          if (price_rule && (BigInt(price_rule.observation_time) < BigInt(close_at) || BigInt(price_rule.observation_time) >= BigInt(resolve_by))) {
            reject("observation_time must be from close_at up to, not including, resolve_by");
          }
        },
      },
    ),
    withdraw: calling({ amount: u128(1n) }, ownDeposit),
  },
  oracle: {
    ...upgradePath,
    set_operator: setOperator,
    set_bond: call({ bond: u128(1n) }),
    set_window_ms: call({ window_ms: windowMs }),
    set_panel_deadline_ms: call({ panel_deadline_ms: windowMs }),
    set_min_proposal_ms: call({ min_proposal_ms: windowMs }),
    set_draw_window_ms: call({ draw_window_ms: windowMs }),
    set_draw_delay_blocks: call({ draw_delay_blocks: u64() }),
    set_jury_size: call({ jury_size: oddUpTo(LIMIT_ORACLE.MAX_PANEL) }),
    set_juror_shares: call({
      decided_bps: integer(LIMIT_ORACLE.MAX_JUROR_SHARE_BPS, LIMIT_ORACLE.MIN_JUROR_SHARE_BPS),
      no_decision_bps: integer(LIMIT_ORACLE.MAX_NO_DECISION_JUROR_SHARE_BPS, LIMIT_ORACLE.MIN_NO_DECISION_JUROR_SHARE_BPS),
    }),
    set_apply_buffer_ms: call({
      apply_buffer_ms: u64(LIMIT_ORACLE.MIN_APPLY_BUFFER_NS / 1_000_000n, LIMIT_ORACLE.MAX_APPLY_BUFFER_NS / 1_000_000n),
    }),
    set_max_publishers: call({ max_publishers: integer(LIMIT_ORACLE.MAX_MAX_PUBLISHERS, LIMIT_ORACLE.MIN_MAX_PUBLISHERS) }),
    set_no_decision_recipient: call({ recipient: exactly("treasury") }),
    add_publisher: call({ key: ed25519 }),
    remove_publisher: call({ key: ed25519 }),
    set_price_threshold: call({ threshold: integer(LIMIT_ORACLE.MAX_MAX_PUBLISHERS, 1) }),
    set_reconcile_wait_ns: call({ reconcile_wait_ns: u64(RECONCILE_WAIT_NS.min, RECONCILE_WAIT_NS.max) }),
    reconcile_bond_payout: call({ id: u64(1n), paid: flag }),
    withdraw_bond: calling({}, ownDeposit),
  },
  council: {
    ...upgradePath,
    set_cooldown_ns: call({ cooldown_ns: u64(1n) }),
    set_close_grace_ns: call({ close_grace_ns: u64(CLOSE_GRACE_DAYS.min * NS_PER_DAY, CLOSE_GRACE_DAYS.max * NS_PER_DAY) }),
    set_market: call({ market: exactly("market") }),
    set_max_seats_per_account: call({ max_seats_per_account: integer(U32_MAX, 1) }),
    set_nft_contract: call({ nft_contract: account }),
    allow_tokens: call({ token_ids: list(text(ID_TEXT_MAX), LIMIT_COUNCIL.MAX_ALLOW_BATCH) }),
    set_token_range: call({ first: u64(), last: u64() }, { check: ordered("first", "last") }),
    clear_token_range: call({}),
    set_allowlist_enabled: call({ enabled: flag }),
    set_reconcile_wait_ns: call({ reconcile_wait_ns: u64(RECONCILE_WAIT_NS.min, RECONCILE_WAIT_NS.max) }),
    reconcile_claim: call({ quarter: integer(U32_MAX), token_id: text(ID_TEXT_MAX), owner: account, paid: flag }),
  },
};

const NEEDS = {
  staged: async ({ view, receiver, args }) => {
    if ((await view(receiver, "is_staged", { code_hash: args.code_hash })) !== true) {
      reject(`no code with the hash ${args.code_hash} is staged on ${receiver}; stage it first`);
    }
  },
  sweep_id_forward: async ({ view, receiver, args }) => {
    const next = BigInt((await view(receiver, "config", {})).next_sweep_id);
    if (BigInt(args.next_sweep_id) < next) reject(`the next sweep id can only move up from ${next}, and a sweep id is never reused`);
  },
  upgrade_proven: async ({ view, receiver }) => {
    if ((await view(receiver, "config", {})).upgrade_proven !== true) {
      reject(`${receiver} has not proven its upgrade path yet, and seal is refused until it has`);
    }
  },
};

// Every other kind of Sputnik proposal at the pinned revision (proposals.rs:67-121), and what approving it does. Only
// FunctionCall, which the allow-list judges, and Vote, which does nothing, are left out of this table.
export const GUARDED_KINDS = {
  ChangeConfig: "replaces the DAO's name, purpose and metadata",
  ChangePolicy: "replaces the whole policy",
  AddMemberToRole: "changes who votes",
  RemoveMemberFromRole: "changes who votes",
  ChangePolicyAddOrUpdateRole: "adds or replaces a role with any permissions",
  ChangePolicyRemoveRole: "removes a role",
  ChangePolicyUpdateDefaultVotePolicy: "replaces the default threshold and quorum",
  ChangePolicyUpdateParameters: "changes the proposal bond and period and the bounty settings",
  UpgradeSelf: "upgrades the DAO's own code",
  UpgradeRemote: "deploys code from the DAO's blob store to another contract",
  FactoryInfoUpdate: "changes the factory's auto-update settings for the DAO",
  Transfer: "pays NEAR or a token out of the treasury",
  AddBounty: "creates a bounty paid from the treasury",
  BountyDone: "pays out a bounty",
  SetStakingContract: "sets the staking contract and with it the voting model",
};

// ---- checking one proposal ---------------------------------------------------------------------------------------

function daoIds(treasuryId, contracts, view) {
  if (typeof view !== "function") reject("A view function is required to read the DAO and the contracts");
  const ids = { treasury: accountId(treasuryId, "treasury") };
  for (const name of TARGETS) ids[name] = accountId(contracts?.[name], `${name} contract`);
  if (new Set(Object.values(ids)).size !== 1 + TARGETS.length) reject("the treasury, market, oracle and council must be four different accounts");
  return ids;
}

function checkArgs(entry, args, ids) {
  if (!isRecord(args)) reject("the arguments must be an object");
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(entry.args, key)) reject(`unknown argument ${key}`);
  }
  const clean = {};
  for (const [name, check] of Object.entries(entry.args)) {
    if (args[name] === undefined) {
      if (!check.optional) reject(`missing argument ${name}`);
      continue;
    }
    clean[name] = within(`${name} must be `, check, args[name], ids);
  }
  entry.check?.(clean);
  return clean;
}

// The arguments as the DAO stores them. Anything the JSON round trip would change (a repeated key, spacing, a number
// written another way) is refused, so what is checked is exactly what the contract will read.
function decodeArgs(encoded) {
  if (typeof encoded !== "string") reject("the action arguments must be a base64 string");
  const raw = Buffer.from(encoded, "base64");
  if (raw.toString("base64") !== encoded) reject("the action arguments are not canonical base64");
  const json = raw.toString("utf8");
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    reject("the action arguments are not JSON");
  }
  if (JSON.stringify(value) !== json) reject("the action arguments are not in canonical JSON form");
  return value;
}

const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));

async function reviewCall(functionCall, ids, view) {
  if (!exactKeys(functionCall, ["receiver_id", "actions"])) reject("a function call proposal has a receiver_id and a list of actions");
  const target = TARGETS.find((name) => ids[name] === functionCall.receiver_id);
  if (!target) reject(`${functionCall.receiver_id} is not the market, oracle or council: a function call to any other account is refused`);
  if (!Array.isArray(functionCall.actions) || functionCall.actions.length !== 1) reject("a proposal must carry exactly one action");
  const [action] = functionCall.actions;
  if (!exactKeys(action, ["method_name", "args", "deposit", "gas"])) reject("an action has a method_name, args, deposit and gas");
  const method = action.method_name;
  const entry = typeof method === "string" && Object.hasOwn(ALLOWED[target], method) ? ALLOWED[target][method] : null;
  if (!entry) reject(`${target}.${method} is not on the allow-list`);
  const args = checkArgs(entry, decodeArgs(action.args), ids);
  if (action.deposit !== entry.deposit) reject(`${target}.${method} takes a deposit of ${entry.deposit}, not ${action.deposit}`);
  if (!DECIMAL.test(String(action.gas))) reject("the action gas is not a whole number");
  const gas = BigInt(action.gas);
  if (gas < BigInt(entry.gas.min) * TGAS || gas > BigInt(entry.gas.max) * TGAS) {
    reject(`${target}.${method} takes ${entry.gas.min} to ${entry.gas.max} TGas, not ${action.gas} gas`);
  }
  if (entry.needs) await NEEDS[entry.needs]({ view, receiver: functionCall.receiver_id, args });
  return { kind: "FunctionCall", target, method, args, deposit: action.deposit, gasTgas: Number(gas / TGAS) };
}

// Throws unless approving this kind is fine: a function call the allow-list accepts, a signalling Vote, or a kind named in
// `acknowledge`. Returns what the proposal does.
export async function reviewKind(kind, { treasuryId, contracts, view, acknowledge = [] }) {
  const ids = daoIds(treasuryId, contracts, view);
  if (!Array.isArray(acknowledge) || acknowledge.some((name) => !Object.hasOwn(GUARDED_KINDS, name))) {
    reject(`acknowledge names proposal kinds from: ${Object.keys(GUARDED_KINDS).join(", ")}`);
  }
  const [name, body] = typeof kind === "string" ? [kind] : isRecord(kind) && Object.keys(kind).length === 1 ? Object.entries(kind)[0] : [];
  if (name === "FunctionCall" && body !== undefined) return reviewCall(body, ids, view);
  if (name === "Vote" && body === undefined) return { kind: name };
  if (!Object.hasOwn(GUARDED_KINDS, name)) reject("the proposal is not a kind this helper knows, so it is refused");
  if (!acknowledge.includes(name)) {
    reject(`${name} ${GUARDED_KINDS[name]}. It is not application administration. Approve it outside this helper, or pass acknowledge: ["${name}"] after reviewing it`);
  }
  return { kind: name, acknowledged: true };
}

// ---- requests ----------------------------------------------------------------------------------------------------

const walletCall = (receiverId, methodName, args, gas, deposit) => ({
  receiverId,
  actions: [{ type: "FunctionCall", params: { methodName, args, gas: (BigInt(gas) * TGAS).toString(), deposit } }],
});

// A proposal that the DAO's members then vote on. The bond is the one in the DAO's policy, read here, because add_proposal
// refuses any other amount.
export async function prepareAdministrationProposal({ treasuryId, contracts, target, methodName, args, description, view, gasTgas }) {
  const ids = daoIds(treasuryId, contracts, view);
  if (!TARGETS.includes(target)) reject("Unknown application target");
  const entry = typeof methodName === "string" && Object.hasOwn(ALLOWED[target], methodName) ? ALLOWED[target][methodName] : null;
  if (!entry) {
    reject(
      methodName === "stage_code"
        ? "stage_code is open to anyone and carries the wasm as its input; stage it with prepareStageCode and propose upgrade with the hash"
        : `${target}.${methodName} is not on the allow-list`,
    );
  }
  if (typeof description !== "string" || !description.trim()) reject("A proposal description is required");
  const gas = gasTgas ?? entry.gas.def;
  if (!Number.isInteger(gas) || gas < entry.gas.min || gas > entry.gas.max) reject(`${target}.${methodName} takes ${entry.gas.min} to ${entry.gas.max} TGas`);
  const kind = {
    FunctionCall: {
      receiver_id: ids[target],
      actions: [{
        method_name: methodName,
        args: Buffer.from(JSON.stringify(checkArgs(entry, args, ids))).toString("base64"),
        deposit: entry.deposit,
        gas: (BigInt(gas) * TGAS).toString(),
      }],
    },
  };
  await reviewKind(kind, { treasuryId, contracts, view });
  const bond = (await view(ids.treasury, "get_policy", {})).proposal_bond;
  if (typeof bond !== "string" || !DECIMAL.test(bond)) reject("The DAO's policy has no proposal_bond");
  return walletCall(ids.treasury, "add_proposal", { proposal: { description, kind } }, MAX_TX_TGAS, bond);
}

// A vote on a stored proposal. The kind in the request is the one the DAO holds, read here, never one the caller supplies:
// act_proposal refuses a kind that differs from the stored one. Approval is judged by reviewKind. Rejecting needs no review.
export async function prepareTreasuryVote({ treasuryId, contracts, proposalId, approve, view, acknowledge }) {
  const ids = daoIds(treasuryId, contracts, view);
  if (!Number.isSafeInteger(proposalId) || proposalId < 0) reject("Invalid proposal ID");
  if (typeof approve !== "boolean") reject("An explicit approval decision is required");
  const stored = await view(ids.treasury, "get_proposal", { id: proposalId });
  if (stored?.id !== proposalId) reject("The DAO returned a different proposal");
  if (approve) {
    if (stored.status !== "InProgress") reject(`Proposal ${proposalId} is ${stored.status}, so it cannot be approved`);
    await reviewKind(stored.kind, { treasuryId, contracts, view, acknowledge });
  }
  return walletCall(
    ids.treasury,
    "act_proposal",
    { id: proposalId, action: approve ? "VoteApprove" : "VoteReject", proposal: stored.kind, memo: null },
    MAX_TX_TGAS,
    "0",
  );
}

// ---- staging code ------------------------------------------------------------------------------------------------

// The hash the contracts file the wasm under and that upgrade takes: the sha256 of the wasm in base58.
export function codeHash(wasm) {
  return b58encode(crypto.createHash("sha256").update(wasm).digest());
}

// stage_code takes the wasm as its raw call input, not JSON, so the request needs a signer that sends raw bytes (near-cli-rs
// has file-args for it). Anyone may stage, and the stager pays for the storage out of the deposit.
export function prepareStageCode({ contracts, target, wasm }) {
  if (!TARGETS.includes(target)) reject("Unknown application target");
  const receiver = accountId(contracts?.[target], `${target} contract`);
  if (!(wasm instanceof Uint8Array) || !Buffer.from(wasm.subarray(0, WASM_MAGIC.length)).equals(WASM_MAGIC)) reject("The code must be a wasm binary");
  const cost = BigInt(wasm.length + STAGE_KEY_BYTES + STAGE_RECORD_BYTES) * YOCTO_PER_BYTE;
  return { ...walletCall(receiver, "stage_code", Buffer.from(wasm), MAX_TX_TGAS, (cost + STAGE_DEPOSIT_MARGIN).toString()), codeHash: codeHash(wasm) };
}
