#!/usr/bin/env node
// Production deploy tooling for market, oracle, council and rounds. Nothing here signs for the DAO: the DAO proposals are
// printed for its members to submit.
//
//   node deploy-production.mjs plan      --manifest FILE                        validate and print every transaction (default, sends nothing)
//   node deploy-production.mjs deploy    --manifest FILE [--send --rpc URL --parent-key-file FILE [--key-dir DIR]]
//   node deploy-production.mjs proposals --manifest FILE --rpc URL [--json]             DAO proposals: upgrade, then seal, then the NFT collection
//   node deploy-production.mjs verify    --manifest FILE --rpc URL              read-only, exits 1 on any failed line
//   node deploy-production.mjs nft-ready --manifest FILE --rpc URL              after the mint: the token allowlist proposal and the collection's keys
//
// deploy --send creates each child from the parent with a fresh key kept in --key-dir (outside the repository, mode 0600),
// then signs as the child: deploy the wasm and call `new` in one transaction (the initializer is private), and stage the same
// wasm so the DAO can prove the upgrade path. It reads config() back and stops on any difference. Re-running it continues
// where it stopped. No dependencies: Node 22 built-ins only.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { b58decode, b58encode, rpc, viewer } from "./keeper/chain.mjs";
import { formatNear, nearToYocto, readKeyFile, str, u128, u32, u64 } from "./keeper/keeper.mjs";
import { CONTRACT_LIMITS, TARGETS, codeHash, prepareAdministrationProposal, prepareStageCode } from "./keeper/treasury.mjs";

const ROLES = TARGETS;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CHAIN_IDS = { mainnet: /^mainnet$/, testnet: /^testnet$/, sandbox: /^(localnet|test-chain-.+)$/ };
const ZERO_HASH = "1".repeat(32);
const TGAS = 10n ** 12n;
const NEW_GAS = 100n * TGAS;
const ONE_NEAR = 10n ** 24n;
const YOCTO_PER_BYTE = 10n ** 19n;
const WASM_MAGIC = Buffer.from("\0asm", "latin1");
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const MAX_WINDOW_MS = 365n * 86_400_000n;
const MAX_COOLDOWN_NS = MAX_WINDOW_MS * 1_000_000n;
const MAX_SEATS = 1000;
const MAX_PUBLISHERS = CONTRACT_LIMITS.oracle.MAX_MAX_PUBLISHERS;
const NFT_PAGE = 50;
const NFT_ENUMERATION_CAP = 10_000;
const ALLOW_BATCH = CONTRACT_LIMITS.council.MAX_ALLOW_BATCH;
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const PLACEHOLDER = /FILL/;

const ensure = (ok, message) => {
  if (!ok) throw new Error(message);
};

// ---- manifest -----------------------------------------------------------------------------------------------------

const isAccount = (v) => typeof v === "string" && ACCOUNT.test(v);
const isHash = (v) => {
  try {
    return typeof v === "string" && b58decode(v).length === 32;
  } catch {
    return false;
  }
};
const equal = (get) => (v, m) => ensure(v === get(m), `must be ${get(m)}`);
const account = (v) => ensure(isAccount(v), "must be a NEAR account ID");
const units = (min, max) => (v) => {
  ensure(typeof v === "string" && DECIMAL.test(v), "must be a decimal string");
  ensure(BigInt(v) >= min && BigInt(v) <= max, `must be from ${min} to ${max}`);
};
const whole = (min, max, odd = false) => (v) => {
  ensure(Number.isInteger(v) && v >= min && v <= max, `must be an integer from ${min} to ${max}`);
  ensure(!odd || v % 2 === 1, "must be odd");
};
const windowMs = units(BigInt(CONTRACT_LIMITS.oracle.MIN_WINDOW_MS), MAX_WINDOW_MS);

const shared = {
  owner_id: equal((m) => m.dao),
  verifier_id: equal((m) => m.verifier),
  collateral_token_id: equal((m) => m.collateral),
};
const operator = { operator_id: equal((m) => m.operator) };
const network = equal((m) => m.network);
const INIT_RULES = {
  market: { ...shared, ...operator, oracle_id: equal((m) => m.contracts.oracle.account) },
  oracle: {
    ...shared,
    ...operator,
    market_contract: equal((m) => m.contracts.market.account),
    bond: units(CONTRACT_LIMITS.oracle.MIN_BOND, 2n ** 128n - 1n),
    window_ms: windowMs,
    panel_deadline_ms: windowMs,
    draw_window_ms: windowMs,
    council: equal((m) => m.contracts.council.account),
    jury_size: whole(CONTRACT_LIMITS.oracle.MIN_JURY_SIZE, CONTRACT_LIMITS.oracle.MAX_PANEL, true),
    draw_delay_blocks: units(0n, BigInt(CONTRACT_LIMITS.oracle.MAX_DRAW_DELAY_BLOCKS)),
    min_proposal_ms: windowMs,
    network,
    price_threshold: whole(2, MAX_PUBLISHERS),
    no_decision_recipient: equal((m) => m.dao),
  },
  council: {
    ...shared,
    oracle_id: equal((m) => m.contracts.oracle.account),
    cooldown_ns: units(1n, MAX_COOLDOWN_NS),
    max_seats_per_account: whole(1, MAX_SEATS),
    allowlist_enabled: (v) => ensure(typeof v === "boolean", "must be true or false"),
  },
  rounds: { ...shared, ...operator, network, price_threshold: whole(2, MAX_PUBLISHERS) },
};

// What config() must return after `new`: the config key, the manifest field it comes from, and how the value is stored.
const field = (key, from = key, map = (v) => v) => ({ key, from, map });
const ns = (ms) => (BigInt(ms) * 1_000_000n).toString();
const CONFIG = {
  market: [field("owner", "owner_id"), field("operator", "operator_id"), field("oracle", "oracle_id"),
    field("verifier", "verifier_id"), field("collateral_token_id")],
  oracle: [field("owner", "owner_id"), field("markets", "market_contract", (v) => [v]), field("verifier", "verifier_id"),
    field("collateral_token_id"), field("bond"), field("window_ns", "window_ms", ns),
    field("panel_deadline_ns", "panel_deadline_ms", ns), field("draw_window_ns", "draw_window_ms", ns),
    field("min_proposal_ns", "min_proposal_ms", ns), field("council"), field("jury_size"), field("draw_delay_blocks"),
    field("operator", "operator_id"), field("network"), field("price_threshold"), field("no_decision_recipient")],
  council: [field("owner", "owner_id"), field("oracle", "oracle_id"), field("verifier", "verifier_id"),
    field("collateral_token_id"), field("cooldown_ns"), field("max_seats_per_account"), field("allowlist_enabled")],
  rounds: [field("owner", "owner_id"), field("operator", "operator_id"), field("verifier", "verifier_id"),
    field("collateral_token_id"), field("network"), field("price_threshold")],
};

const minFunding = (bytes) => BigInt(bytes.length) * YOCTO_PER_BYTE * 2n + ONE_NEAR;

function placeholders(value, where, found = []) {
  if (typeof value === "string" && PLACEHOLDER.test(value)) found.push(where);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) placeholders(item, where ? `${where}.${key}` : key, found);
  }
  return found;
}

export function loadManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const dir = path.dirname(path.resolve(file));
  manifest.placeholders = placeholders(manifest, "");
  for (const role of ROLES) {
    const c = manifest.contracts?.[role];
    if (typeof c?.wasm === "string") c.bytes = fs.existsSync(path.resolve(dir, c.wasm)) ? fs.readFileSync(path.resolve(dir, c.wasm)) : undefined;
  }
  return manifest;
}

function validateTop(m, check) {
  check("network", () => ensure(Object.hasOwn(CHAIN_IDS, m.network), `must be one of ${Object.keys(CHAIN_IDS).join(", ")}`));
  for (const key of ["parent", "dao", "nft", "verifier", "operator"]) check(key, () => account(m[key]));
  check("collateral", () => {
    ensure(typeof m.collateral === "string" && m.collateral.startsWith("nep141:"), "must look like nep141:<token account>");
    account(m.collateral.slice(7));
  });
  check("operator", () => ensure(m.operator !== m.dao, "must not be the DAO"));
  for (const where of m.placeholders ?? []) check(where, () => ensure(false, "still a placeholder, fill it in"));
}

function validateInit(m, role, check) {
  const rules = INIT_RULES[role], init = m.contracts[role].init ?? {};
  check(`contracts.${role}.init`, () => {
    const keys = Object.keys(init);
    ensure(keys.length === Object.keys(rules).length && keys.every((k) => Object.hasOwn(rules, k)),
      `fields must be exactly ${Object.keys(rules).join(", ")}`);
  });
  for (const [name, rule] of Object.entries(rules)) check(`contracts.${role}.init.${name}`, () => rule(init[name], m));
}

function validateContract(m, role, check) {
  const c = m.contracts?.[role], at = (name) => `contracts.${role}.${name}`;
  if (!c) return check(`contracts.${role}`, () => ensure(false, "missing"));
  check(at("account"), () => ensure(isAccount(c.account) && c.account.endsWith(`.${m.parent}`), `must be a child of ${m.parent}`));
  check(at("codeHash"), () => ensure(isHash(c.codeHash), "must be the base58 sha256 of the approved wasm"));
  check(at("wasm"), () => {
    ensure(c.bytes && c.bytes.subarray(0, 4).equals(WASM_MAGIC), "must be a readable wasm file");
    ensure(codeHash(c.bytes) === c.codeHash, `the file hashes to ${codeHash(c.bytes)}, not the approved ${c.codeHash}`);
  });
  check(at("fundingNear"), () => ensure(nearToYocto(c.fundingNear) >= minFunding(c.bytes ?? Buffer.alloc(0)),
    `must cover the code twice over plus 1 NEAR (${formatNear(minFunding(c.bytes ?? Buffer.alloc(0)))})`));
  return validateInit(m, role, check);
}

export function validateManifest(m) {
  const problems = [];
  const check = (where, fn) => {
    try {
      fn();
    } catch (e) {
      problems.push(`${where}: ${e.message}`);
    }
  };
  validateTop(m, check);
  for (const role of ROLES) validateContract(m, role, check);
  const accounts = ROLES.map((role) => m.contracts?.[role]?.account);
  check("contracts", () => ensure(new Set(accounts).size === accounts.length, "accounts must be different"));
  return problems;
}

const accountsOf = (m) => Object.fromEntries(ROLES.map((role) => [role, m.contracts[role].account]));

// ---- the transaction list -----------------------------------------------------------------------------------------

export function buildPlan(m) {
  const contracts = accountsOf(m);
  return ROLES.flatMap((role) => {
    const c = m.contracts[role], own = { role, signer: c.account, receiver: c.account };
    const [{ params }] = prepareStageCode({ contracts, target: role, wasm: c.bytes }).actions;
    return [
      { name: `${role}.create`, role, signer: m.parent, receiver: c.account,
        actions: [{ type: "CreateAccount" }, { type: "Transfer", deposit: nearToYocto(c.fundingNear) }, { type: "AddKey", publicKey: null }] },
      { name: `${role}.init`, ...own, actions: [{ type: "DeployContract", wasm: c.bytes },
        { type: "FunctionCall", method: "new", args: Buffer.from(JSON.stringify(c.init)), gas: NEW_GAS, deposit: 0n }] },
      { name: `${role}.stage`, ...own, actions: [{ type: "FunctionCall", method: "stage_code", args: params.args,
        gas: BigInt(params.gas), deposit: BigInt(params.deposit) }] },
    ];
  });
}

function describeAction(a) {
  if (a.type === "Transfer") return `Transfer ${formatNear(a.deposit)}`;
  if (a.type === "AddKey") return "AddKey full access (fresh key made at send time)";
  if (a.type === "DeployContract") return `DeployContract sha256:${crypto.createHash("sha256").update(a.wasm).digest("hex")} (${a.wasm.length} bytes)`;
  if (a.type !== "FunctionCall") return a.type;
  const args = a.method === "stage_code" ? `<${a.args.length} bytes of wasm>` : a.args.toString();
  return `FunctionCall ${a.method}(${args}) gas ${a.gas / TGAS} TGas, deposit ${formatNear(a.deposit)}`;
}

function planText(m, plan) {
  const lines = [`network ${m.network}, parent ${m.parent}, owner ${m.dao}, NFT collection ${m.nft} (not deployed)`, "",
    "Owner decisions (the value in the manifest is a default until confirmed):"];
  for (const where of m.decide ?? []) lines.push(`  ${where} = ${JSON.stringify(where.split(".").reduce((v, k) => v?.[k], m))}`);
  lines.push("", "Transactions in order:");
  plan.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.name}: ${step.signer} -> ${step.receiver}`);
    for (const a of step.actions) lines.push(`     ${describeAction(a)}`);
  });
  const total = ROLES.reduce((sum, role) => sum + nearToYocto(m.contracts[role].fundingNear), 0n);
  lines.push("", `The parent needs at least ${formatNear(total)} plus gas. Nothing was sent.`);
  return lines;
}

// ---- keys and signing ---------------------------------------------------------------------------------------------

function keyFromSeed(seed, accountId) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { account: accountId, seed, privateKey, publicKey, publicKeyString: `ed25519:${b58encode(publicKey)}` };
}

function parseSecret(text) {
  const bytes = b58decode(text.replace(/^ed25519:/, ""));
  ensure(bytes.length === 32 || bytes.length === 64, "a secret key is the base58 of 32 or 64 bytes");
  return bytes.subarray(0, 32);
}

function assertOutsideRepo(dir) {
  const relative = path.relative(REPO_ROOT, path.resolve(dir));
  ensure(relative.startsWith("..") || path.isAbsolute(relative), `${dir} is inside the repository; keep keys outside it`);
}

function childKey(dir, accountId) {
  const file = path.join(dir, `${accountId}.key`);
  if (fs.existsSync(file)) return keyFromSeed(parseSecret(readKeyFile(file)), accountId);
  const key = keyFromSeed(crypto.randomBytes(32), accountId);
  fs.writeFileSync(file, `ed25519:${b58encode(Buffer.concat([key.seed, key.publicKey]))}\n`, { mode: 0o600, flag: "wx" });
  return key;
}

const ENCODE = {
  CreateAccount: () => Buffer.from([0]),
  DeployContract: (a) => Buffer.concat([Buffer.from([1]), u32(a.wasm.length), a.wasm]),
  FunctionCall: (a) => Buffer.concat([Buffer.from([2]), str(a.method), u32(a.args.length), a.args, u64(a.gas), u128(a.deposit)]),
  Transfer: (a) => Buffer.concat([Buffer.from([3]), u128(a.deposit)]),
  AddKey: (a) => Buffer.concat([Buffer.from([5, 0]), a.publicKey, u64(0), Buffer.from([1])]),
};

function signTransaction({ signer, nonce, receiver, blockHash, actions }) {
  const tx = Buffer.concat([str(signer.account), Buffer.from([0]), signer.publicKey, u64(nonce), str(receiver), blockHash,
    u32(actions.length), ...actions.map((a) => ENCODE[a.type](a))]);
  const signature = crypto.sign(null, crypto.createHash("sha256").update(tx).digest(), signer.privateKey);
  return Buffer.concat([tx, Buffer.from([0]), signature]).toString("base64");
}

function assertLanded(outcome, name) {
  const status = (s) => typeof s === "object" && s !== null && ("SuccessValue" in s || "SuccessReceiptId" in s);
  const ok = status(outcome.status) && outcome.receipts_outcome.every((r) => status(r.outcome.status));
  ensure(ok, `${name} failed: ${JSON.stringify(outcome.status)}`);
}

// ---- reading the chain --------------------------------------------------------------------------------------------

export async function connect(url, m) {
  const status = await rpc(url, "status", []);
  ensure(CHAIN_IDS[m.network].test(status.chain_id), `the endpoint is on ${status.chain_id}, the manifest is for ${m.network}`);
  const query = (params) => rpc(url, "query", { finality: "final", ...params });
  return {
    url,
    view: viewer(url),
    async account(id) {
      try {
        const result = await query({ request_type: "view_account", account_id: id });
        return result.error ? null : result;
      } catch (e) {
        if (/HANDLER_ERROR|UNKNOWN_ACCOUNT/.test(e.message)) return null;
        throw e;
      }
    },
    keys: async (id) => (await query({ request_type: "view_access_key_list", account_id: id })).keys,
    accessKey: (id, publicKey) => query({ request_type: "view_access_key", account_id: id, public_key: publicKey }),
  };
}

async function send(chain, signer, step) {
  const access = await chain.accessKey(signer.account, signer.publicKeyString);
  const tx = signTransaction({ signer, nonce: BigInt(access.nonce) + 1n, receiver: step.receiver,
    blockHash: b58decode(access.block_hash), actions: step.actions });
  const outcome = await rpc(chain.url, "send_tx", { signed_tx_base64: tx, wait_until: "FINAL" });
  assertLanded(outcome, step.name);
  return outcome.transaction.hash;
}

// ---- deploy -------------------------------------------------------------------------------------------------------

async function childState(chain, c) {
  const live = await chain.account(c.account);
  if (!live) return "absent";
  if (live.code_hash === ZERO_HASH) return "empty";
  ensure(live.code_hash === c.codeHash, `${c.account} already holds other code (${live.code_hash})`);
  return "deployed";
}

async function needed(step, state, chain, c) {
  const kind = step.name.split(".")[1];
  if (kind === "create") return state === "absent";
  if (kind === "init") return state !== "deployed";
  return !(await chain.view(c.account, "is_staged", { code_hash: c.codeHash }).catch(() => false));
}

async function readBack(chain, role, c) {
  const live = await chain.view(c.account, "config");
  const differences = CONFIG[role]
    .filter(({ key, from, map }) => !isDeepStrictEqual(live[key], map(c.init[from])))
    .map(({ key, from, map }) => `${key} is ${JSON.stringify(live[key])}, the manifest says ${JSON.stringify(map(c.init[from]))}`);
  ensure(differences.length === 0, `${role} config differs from the manifest: ${differences.join("; ")}`);
}

async function deployRole(ctx, role) {
  const { m, chain } = ctx, c = m.contracts[role];
  const key = childKey(ctx.keyDir, c.account), signers = { [m.parent]: ctx.parent, [c.account]: key };
  const state = await childState(chain, c), transactions = {};
  for (const step of ctx.plan.filter((s) => s.role === role)) {
    if (!(await needed(step, state, chain, c))) continue;
    const actions = step.actions.map((a) => (a.type === "AddKey" ? { ...a, publicKey: key.publicKey } : a));
    transactions[step.name] = await send(chain, signers[step.signer], { ...step, actions });
    ctx.log(`sent ${step.name} ${transactions[step.name]}`);
  }
  await readBack(chain, role, c);
  const onChain = (await chain.account(c.account)).code_hash;
  ensure(onChain === c.codeHash, `${role} on-chain code hash ${onChain} is not the approved ${c.codeHash}`);
  ctx.record[role] = { account: c.account, publicKey: key.publicKeyString, wasmSha256: crypto.createHash("sha256").update(c.bytes).digest("hex"),
    onChainCodeHash: onChain, transactions };
  fs.writeFileSync(ctx.recordFile, `${JSON.stringify(ctx.record, null, 2)}\n`);
  ctx.log(`${role}: config matches the manifest, code hash ${onChain}`);
}

async function deploy(m, chain, options, log) {
  assertOutsideRepo(options.keyDir);
  fs.mkdirSync(options.keyDir, { recursive: true, mode: 0o700 });
  const parent = keyFromSeed(parseSecret(readKeyFile(options.parentKeyFile)), m.parent);
  const funding = ROLES.reduce((sum, role) => sum + nearToYocto(m.contracts[role].fundingNear), 0n);
  const balance = BigInt((await chain.account(m.parent))?.amount ?? 0);
  ensure(balance > funding + ONE_NEAR, `${m.parent} holds ${formatNear(balance)}, the plan funds ${formatNear(funding)} and needs gas on top`);
  const ctx = { m, chain, parent, plan: buildPlan(m), keyDir: options.keyDir, log, record: {},
    recordFile: path.join(options.keyDir, `deployment-${m.network}.json`) };
  for (const role of ROLES) await deployRole(ctx, role);
  log(`record written to ${ctx.recordFile}`);
}

// ---- DAO proposals ------------------------------------------------------------------------------------------------

const cliLine = (request) => {
  const { methodName, args, gas, deposit } = request.actions[0].params;
  return `near contract call-function as-transaction ${request.receiverId} ${methodName} json-args '${JSON.stringify(args)}' `
    + `prepaid-gas '${BigInt(gas) / TGAS} Tgas' attached-deposit '${deposit} yoctoNEAR' sign-as <MEMBER> network-config <NETWORK> sign-with-keychain send`;
};

async function propose(ctx, target, methodName, args, description) {
  const request = await prepareAdministrationProposal({ ...ctx, target, methodName, args, description });
  return { description, request, command: cliLine(request) };
}

async function sealKey(chain, c) {
  const keys = await chain.keys(c.account);
  ensure(keys.length === 1 && keys[0].access_key.permission === "FullAccess",
    `${c.account} has ${keys.length} access keys, expected only the deployer's full access key`);
  return keys[0].public_key;
}

export async function daoProposals(m, chain) {
  const ctx = { treasuryId: m.dao, contracts: accountsOf(m), view: chain.view };
  const items = [], notes = [];
  for (const role of ROLES) {
    const c = m.contracts[role], config = await chain.view(c.account, "config");
    if (!config.upgrade_proven) {
      items.push(await propose(ctx, role, "upgrade", { code_hash: c.codeHash },
        `Upgrade ${role} to its approved code hash ${c.codeHash} to prove the upgrade path`));
      notes.push(`${role}: submit and execute the upgrade, then run proposals again for its seal`);
      continue;
    }
    items.push(await propose(ctx, role, "seal", { public_key: await sealKey(chain, c) },
      `Seal ${role}: delete the deployer's access key`));
  }
  const council = await chain.view(m.contracts.council.account, "config");
  if (council.nft_contract !== m.nft) {
    items.push(await propose(ctx, "council", "set_nft_contract", { nft_contract: m.nft }, `Set the NFT collection to ${m.nft}`));
  }
  return { items, notes };
}

function printProposals({ items, notes }, log, json = false) {
  if (json) return log(JSON.stringify(items.map(({ description, request }) => ({ description, request }))));
  for (const { description, request, command } of items) log(`# ${description}\n${JSON.stringify(request, null, 2)}\n${command}\n`);
  for (const note of notes) log(`note: ${note}`);
  log(`${items.length} proposals prepared. Set the network in the near CLI lines; nothing was signed or sent.`);
}

// ---- verify -------------------------------------------------------------------------------------------------------

const expectEqual = (actual, wanted) => ensure(isDeepStrictEqual(actual, wanted), `got ${JSON.stringify(actual)}, want ${JSON.stringify(wanted)}`);

function roleChecks(m, role, chain) {
  const c = m.contracts[role];
  const config = () => chain.view(c.account, "config");
  const checks = [
    ["owner is the DAO", async () => expectEqual((await config()).owner, m.dao)],
    ["upgrade path proven", async () => expectEqual((await config()).upgrade_proven, true)],
    ["no access keys", async () => expectEqual((await chain.keys(c.account)).length, 0)],
    ["code hash matches the manifest", async () => expectEqual((await chain.account(c.account))?.code_hash, c.codeHash)],
  ];
  if (role === "council") checks.push(["NFT collection is set", async () => expectEqual((await config()).nft_contract, m.nft)]);
  return checks;
}

export async function verify(m, chain) {
  const results = [];
  for (const role of ROLES) {
    for (const [name, run] of roleChecks(m, role, chain)) {
      try {
        await run();
        results.push({ ok: true, text: `PASS ${role} ${name}` });
      } catch (e) {
        results.push({ ok: false, text: `FAIL ${role} ${name}: ${e.message}` });
      }
    }
  }
  return results;
}

// ---- after the mint -----------------------------------------------------------------------------------------------

export function contiguousRange(ids) {
  if (ids.length === 0 || !ids.every((id) => DECIMAL.test(id))) return null;
  const numbers = ids.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const first = numbers[0], last = numbers.at(-1);
  return last - first + 1n === BigInt(numbers.length) && new Set(ids).size === ids.length ? { first: first.toString(), last: last.toString() } : null;
}

async function listTokens(chain, nft, supply) {
  ensure(supply <= NFT_ENUMERATION_CAP, `${supply} tokens is more than this tool lists (${NFT_ENUMERATION_CAP})`);
  const ids = [];
  for (let from = 0; from < supply; from += NFT_PAGE) {
    const page = await chain.view(nft, "nft_tokens", { from_index: String(from), limit: NFT_PAGE });
    ids.push(...page.map((token) => token.token_id));
  }
  ensure(ids.length === supply && new Set(ids).size === supply, `the collection listed ${ids.length} ids for a supply of ${supply}`);
  return ids;
}

async function allowlistProposals(ctx, nft, ids) {
  const range = contiguousRange(ids);
  if (range) {
    const item = await propose(ctx, "council", "set_token_range", range, `Allow council seats for ${nft} tokens ${range.first} to ${range.last}`);
    return { line: `PASS token ids are the decimal range ${range.first} to ${range.last}`, items: [item] };
  }
  const items = [];
  for (let i = 0; i < ids.length; i += ALLOW_BATCH) {
    const batch = ids.slice(i, i + ALLOW_BATCH);
    items.push(await propose(ctx, "council", "allow_tokens", { token_ids: batch },
      `Allow council seats for ${batch.length} ${nft} tokens (batch ${i / ALLOW_BATCH + 1})`));
  }
  return { line: `PASS token ids are not one decimal range; allowing them in batches of at most ${ALLOW_BATCH}`, items };
}

export async function nftReady(m, chain) {
  const ctx = { treasuryId: m.dao, contracts: accountsOf(m), view: chain.view };
  const supply = Number(await chain.view(m.nft, "nft_total_supply")), keys = await chain.keys(m.nft);
  const lines = [`${supply > 0 ? "PASS" : "FAIL"} ${m.nft} supply is ${supply}`,
    `${keys.length === 0 ? "PASS" : "FAIL"} ${m.nft} has ${keys.length} access keys (activation refuses a collection that still has keys)`];
  const council = await chain.view(m.contracts.council.account, "config");
  if (council.nft_contract !== m.nft) lines.push(`WARN council nft_contract is ${council.nft_contract}; set it first (proposals)`);
  if (supply === 0 || keys.length > 0) return { lines, items: [], ready: false };
  const { line, items } = await allowlistProposals(ctx, m.nft, await listTokens(chain, m.nft, supply));
  return { lines: [...lines, line], items, ready: true };
}

// ---- command line -------------------------------------------------------------------------------------------------

const OPTIONS = {
  manifest: { type: "string" },
  rpc: { type: "string" },
  "parent-key-file": { type: "string" },
  "key-dir": { type: "string" },
  send: { type: "boolean" },
  json: { type: "boolean" },
};

const needOption = (values, name) => values[name] ?? ensure(false, `--${name} is required`);

async function runPlan(m, values, log) {
  const plan = buildPlan(m);
  planText(m, plan).forEach((line) => log(line));
  return 0;
}

async function runDeploy(m, values, log) {
  if (!values.send) {
    await runPlan(m, values, log);
    log("Dry run. Add --send with --rpc and --parent-key-file to send these transactions.");
    return 0;
  }
  const chain = await connect(needOption(values, "rpc"), m);
  const keyDir = values["key-dir"] ?? path.join(os.homedir(), ".dragons-market", "keys", m.network);
  await deploy(m, chain, { keyDir, parentKeyFile: needOption(values, "parent-key-file") }, log);
  return 0;
}

async function runProposals(m, values, log) {
  printProposals(await daoProposals(m, await connect(needOption(values, "rpc"), m)), log, values.json);
  return 0;
}

async function runVerify(m, values, log) {
  const results = await verify(m, await connect(needOption(values, "rpc"), m));
  results.forEach(({ text }) => log(text));
  return results.every(({ ok }) => ok) ? 0 : 1;
}

async function runNftReady(m, values, log) {
  const { lines, items, ready } = await nftReady(m, await connect(needOption(values, "rpc"), m));
  lines.forEach((line) => log(line));
  if (ready) printProposals({ items, notes: [] }, log);
  return ready ? 0 : 1;
}

const COMMANDS = { plan: runPlan, deploy: runDeploy, proposals: runProposals, verify: runVerify, "nft-ready": runNftReady };

export async function main(argv, log = console.log) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  const command = positionals[0] ?? "plan";
  ensure(Object.hasOwn(COMMANDS, command), `unknown command ${command}; use ${Object.keys(COMMANDS).join(", ")}`);
  const m = loadManifest(needOption(values, "manifest"));
  const problems = validateManifest(m);
  if (problems.length > 0) {
    problems.forEach((problem) => log(`problem ${problem}`));
    return 1;
  }
  return COMMANDS[command](m, values, log);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
}
