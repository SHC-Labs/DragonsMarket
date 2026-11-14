#!/usr/bin/env node
// Production deploy tooling for market, oracle, council and rounds. Nothing here signs for the DAO: the DAO proposals are
// printed for its members to submit.
//
//   node deploy-production.mjs plan      --manifest FILE                        validate and print every transaction (default, sends nothing)
//   node deploy-production.mjs deploy    --manifest FILE [--send --rpc URL --rpc-second URL --parent-key-file FILE [--key-dir DIR]]
//   node deploy-production.mjs proposals --manifest FILE --rpc URL --rpc-second URL [--json]  DAO upgrades, configuration and sealing
//   node deploy-production.mjs verify    --manifest FILE --rpc URL --rpc-second URL           read-only, exits 1 on any failed line
//   node deploy-production.mjs nft-ready --manifest FILE --rpc URL --rpc-second URL           after the mint: allowlist proposals
//
// deploy --send creates each child from the parent with a fresh key kept in --key-dir (outside the repository, mode 0600),
// then signs as the child: deploy the wasm and call `new` in one transaction (the initializer is private), and stage the same
// wasm so the DAO can prove the upgrade path. It reads config() back and stops on any difference. Re-running it continues
// where it stopped. No dependencies: Node 24 built-ins only.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { b58decode, b58encode, rpc } from "./keeper/chain.mjs";
import { formatNear, nearToYocto, readKeyFile, str, u128, u32, u64 } from "./keeper/keeper.mjs";
import { CONTRACT_LIMITS, TARGETS, codeHash, prepareAdministrationProposal, prepareStageCode } from "./keeper/treasury.mjs";
import { checkBuildInfo, extractSourceMetadata } from "./verify-build.mjs";
import { assertDaoPolicy } from "./keeper/dao-policy.mjs";
import { parseNftCustody, verifyNftCustody } from "./keeper/nft-custody.mjs";

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
  check("nftCustody", () => parseNftCustody(m.nftCustody, m.nft));
  check("collateral", () => {
    ensure(typeof m.collateral === "string" && m.collateral.startsWith("nep141:"), "must look like nep141:<token account>");
    account(m.collateral.slice(7));
  });
  check("operator", () => ensure(m.operator !== m.dao, "must not be the DAO"));
  check("daoMinApprovals", () => whole(2, 100)(m.daoMinApprovals));
  if (m.network !== "sandbox") {
    check("daoCodeHash", () => ensure(isHash(m.daoCodeHash), "must pin the reviewed DAO code hash"));
    check("release.sourceCommit", () => ensure(/^[0-9a-f]{40}$/.test(m.release?.sourceCommit ?? ""), "must pin the reviewed source commit"));
    check("release.imageDigest", () => ensure(/^sha256:[0-9a-f]{64}$/.test(m.release?.imageDigest ?? ""), "must pin the build image digest"));
  }
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
  check(at("account"), () => ensure(isAccount(c.account) && c.account.endsWith(`.${m.parent}`)
    && !c.account.slice(0, -m.parent.length - 1).includes("."), `must be a direct child of ${m.parent}`));
  check(at("codeHash"), () => ensure(isHash(c.codeHash), "must be the base58 sha256 of the approved wasm"));
  check(at("wasm"), () => {
    ensure(c.bytes && c.bytes.subarray(0, 4).equals(WASM_MAGIC), "must be a readable wasm file");
    ensure(codeHash(c.bytes) === c.codeHash, `the file hashes to ${codeHash(c.bytes)}, not the approved ${c.codeHash}`);
    if (m.network !== "sandbox") {
      const info = checkBuildInfo(extractSourceMetadata(c.bytes));
      ensure(info.commit === m.release?.sourceCommit, "build source commit differs from the approved release");
      ensure(info.digest === m.release?.imageDigest, "build image differs from the approved release");
      ensure(info.contractPath === role || info.contractPath === `contracts/${role}`, "build metadata names a different contract");
    }
  });
  check(at("fundingNear"), () => {
    ensure(typeof c.fundingNear === "string", "must be a decimal string");
    const funding = nearToYocto(c.fundingNear);
    ensure(funding < 2n ** 128n && funding >= minFunding(c.bytes ?? Buffer.alloc(0)),
      `must fit u128 and cover the code twice over plus 1 NEAR (${formatNear(minFunding(c.bytes ?? Buffer.alloc(0)))})`);
  });
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
  check("contracts", () => ensure(accounts.every(id => ![m.parent, m.dao, m.operator, m.verifier, m.nft].includes(id)),
    "contract accounts must be separate from deployment, operator, DAO, verifier and NFT accounts"));
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
  ensure(text.startsWith("ed25519:"), "only ed25519 keys are supported");
  const bytes = b58decode(text.slice(8));
  ensure(bytes.length === 32 || bytes.length === 64, "a secret key is the base58 of 32 or 64 bytes");
  if (bytes.length === 64) ensure(keyFromSeed(bytes.subarray(0, 32), "").publicKey.equals(bytes.subarray(32)), "secret key public half does not match its seed");
  return bytes.subarray(0, 32);
}

export function prepareKeyDirectory(dir) {
  const resolved = path.resolve(dir);
  // Resolve the existing ancestor before mkdir: an outside symlink must not create keys inside the checkout.
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonical = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, resolved));
  const relative = path.relative(fs.realpathSync(REPO_ROOT), canonical);
  ensure(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    `${dir} is inside the repository; keep keys outside it`);
  fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(canonical);
  ensure(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0,
    "key directory must be owned by the current user and inaccessible to group and others");
  return canonical;
}

function childKey(dir, accountId, mayCreate) {
  const file = path.join(dir, `${accountId}.key`);
  if (fs.existsSync(file)) {
    const info = fs.lstatSync(file);
    ensure(info.isFile() && info.uid === process.getuid() && info.nlink === 1, "child key must be a regular, privately owned file, not a link");
    return keyFromSeed(parseSecret(readKeyFile(file)), accountId);
  }
  ensure(mayCreate, `missing deployment key for existing account ${accountId}; restore the original key file`);
  const key = keyFromSeed(crypto.randomBytes(32), accountId);
  fs.writeFileSync(file, `ed25519:${b58encode(Buffer.concat([key.seed, key.publicKey]))}\n`, { mode: 0o600, flag: "wx", flush: true });
  const directory = fs.openSync(dir, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
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
  const ok = outcome.final_execution_status === "FINAL" && status(outcome.status)
    && status(outcome.transaction_outcome?.outcome?.status) && Array.isArray(outcome.receipts_outcome)
    && outcome.receipts_outcome.every((r) => status(r.outcome.status));
  ensure(ok, `${name} failed: ${JSON.stringify(outcome.status)}`);
}

// ---- reading the chain --------------------------------------------------------------------------------------------

export async function connect(url, m, secondUrl) {
  const endpoint = new URL(url);
  const second = secondUrl ? new URL(secondUrl) : null;
  for (const address of [endpoint, second].filter(Boolean)) {
    ensure(!address.username && !address.password && !address.search && !address.hash
      && (address.protocol === "https:" || (m.network === "sandbox" && address.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname))), "RPC must use HTTPS without URL credentials; sandbox HTTP is loopback only");
  }
  ensure(m.network === "sandbox" || (second && endpoint.hostname !== second.hostname), "deployment requires two independent RPC hosts");
  const status = await rpc(url, "status", []);
  ensure(CHAIN_IDS[m.network].test(status.chain_id), `the endpoint is on ${status.chain_id}, the manifest is for ${m.network}`);
  if (secondUrl) ensure((await rpc(secondUrl, "status", [])).chain_id === status.chain_id, "RPC networks disagree");
  const query = async (params) => {
    const first = await rpc(url, "query", { finality: "final", ...params });
    ensure(first && !first.error && isHash(first.block_hash), "invalid finalized RPC query result");
    if (secondUrl) {
      const other = await rpc(secondUrl, "query", { block_id: first.block_hash, ...params });
      ensure(isDeepStrictEqual(first, other), "RPC providers disagree at the finalized block");
    }
    return first;
  };
  return {
    url,
    view: async (account, method, args = {}) => {
      const result = await query({ request_type: "call_function", account_id: account, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      ensure(Array.isArray(result.result) && result.result.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), "invalid view bytes");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(result.result)));
    },
    async account(id) {
      try {
        const result = await query({ request_type: "view_account", account_id: id });
        return result;
      } catch (e) {
        if (e.message === "query: UNKNOWN_ACCOUNT") {
          if (secondUrl) {
            try { await rpc(secondUrl, "query", { request_type: "view_account", account_id: id, finality: "final" }); }
            catch (other) { if (other.message === "query: UNKNOWN_ACCOUNT") return null; throw other; }
            throw new Error("RPC providers disagree about account existence");
          }
          return null;
        }
        throw e;
      }
    },
    keys: async (id) => (await query({ request_type: "view_access_key_list", account_id: id })).keys,
    accessKey: (id, publicKey) => query({ request_type: "view_access_key", account_id: id, public_key: publicKey }),
    transaction: async (hash, signer) => {
      const params = { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" };
      const outcome = await rpc(url, "EXPERIMENTAL_tx_status", params);
      if (secondUrl) ensure(isDeepStrictEqual(outcome, await rpc(secondUrl, "EXPERIMENTAL_tx_status", params)),
        "RPC providers disagree about the deployment transaction");
      return outcome;
    },
  };
}

async function send(chain, signer, step, beforeSend) {
  const access = await chain.accessKey(signer.account, signer.publicKeyString);
  ensure(access.permission === "FullAccess" && Number.isSafeInteger(access.nonce) && access.nonce >= 0,
    "deployment requires the expected full-access key and a safe nonce");
  const tx = signTransaction({ signer, nonce: BigInt(access.nonce) + 1n, receiver: step.receiver,
    blockHash: b58decode(access.block_hash), actions: step.actions });
  const hash = b58encode(crypto.createHash("sha256").update(Buffer.from(tx, "base64").subarray(0, -65)).digest());
  beforeSend(hash);
  await rpc(chain.url, "send_tx", { signed_tx_base64: tx, wait_until: "FINAL" });
  const outcome = await chain.transaction(hash, signer.account);
  ensure(outcome.transaction?.hash === hash && outcome.transaction.signer_id === signer.account
    && outcome.transaction.receiver_id === step.receiver, "RPC returned a different deployment transaction");
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
  if (state !== "deployed") return true;
  return !(await chain.view(c.account, "is_staged", { code_hash: c.codeHash }));
}

async function readBack(chain, role, c) {
  const live = await chain.view(c.account, "config");
  const differences = CONFIG[role]
    .filter(({ key, from, map }) => !isDeepStrictEqual(live[key], map(c.init[from])))
    .map(({ key, from, map }) => `${key} is ${JSON.stringify(live[key])}, the manifest says ${JSON.stringify(map(c.init[from]))}`);
  ensure(differences.length === 0, `${role} config differs from the manifest: ${differences.join("; ")}`);
  ensure(live.pending_owner === null, `${role} has an unexpected pending ownership transfer`);
}

async function deployRole(ctx, role) {
  const { m, chain } = ctx, c = m.contracts[role];
  const state = await childState(chain, c);
  if (state === "deployed") await readBack(chain, role, c);
  const steps = [];
  for (const step of ctx.plan.filter(s => s.role === role)) if (await needed(step, state, chain, c)) steps.push(step);
  const saved = ctx.record[role];
  if (!steps.length) {
    ctx.log(`${role}: already deployed and staged; record preserved`);
    return;
  }
  const key = childKey(ctx.keyDir, c.account, state === "absent"), signers = { [m.parent]: ctx.parent, [c.account]: key };
  ensure(!saved || saved.publicKey === key.publicKeyString, `${role} deployment key differs from the recorded key`);
  const transactions = { ...saved?.transactions };
  ctx.record[role] = { account: c.account, publicKey: key.publicKeyString,
    wasmSha256: crypto.createHash("sha256").update(c.bytes).digest("hex"), transactions };
  for (const step of steps) {
    const actions = step.actions.map((a) => (a.type === "AddKey" ? { ...a, publicKey: key.publicKey } : a));
    transactions[step.name] = await send(chain, signers[step.signer], { ...step, actions }, hash => {
      ctx.record.pending = { step: step.name, hash };
      saveRecord(ctx);
    });
    ctx.record.pending = null;
    saveRecord(ctx);
    ctx.log(`sent ${step.name} ${transactions[step.name]}`);
  }
  await readBack(chain, role, c);
  const onChain = (await chain.account(c.account)).code_hash;
  ensure(onChain === c.codeHash, `${role} on-chain code hash ${onChain} is not the approved ${c.codeHash}`);
  ctx.record[role] = { account: c.account, publicKey: key.publicKeyString, wasmSha256: crypto.createHash("sha256").update(c.bytes).digest("hex"),
    onChainCodeHash: onChain, transactions };
  saveRecord(ctx);
  ctx.log(`${role}: config matches the manifest, code hash ${onChain}`);
}

async function deploy(m, chain, options, log) {
  const keyDir = prepareKeyDirectory(options.keyDir);
  const lockFile = path.join(keyDir, `deployment-${m.network}.lock`);
  let fd;
  try { fd = fs.openSync(lockFile, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("deployment lock exists; verify no deployer is running and reconcile the recorded pending transaction before removing it");
    throw error;
  }
  try { await deployLocked(m, chain, { ...options, keyDir }, log); }
  finally { fs.closeSync(fd); fs.unlinkSync(lockFile); }
}

async function deployLocked(m, chain, options, log) {
  const keyDir = options.keyDir;
  await assertGovernance(m, chain);
  const parent = keyFromSeed(parseSecret(readKeyFile(options.parentKeyFile)), m.parent);
  let funding = 0n;
  for (const role of ROLES) if (await childState(chain, m.contracts[role]) === "absent") funding += nearToYocto(m.contracts[role].fundingNear);
  const parentAccount = await chain.account(m.parent);
  ensure(parentAccount, "parent account does not exist");
  const balance = BigInt(parentAccount.amount) - BigInt(parentAccount.storage_usage) * YOCTO_PER_BYTE;
  ensure(balance > funding + ONE_NEAR, `${m.parent} holds ${formatNear(balance)}, the plan funds ${formatNear(funding)} and needs gas on top`);
  const recordFile = path.join(keyDir, `deployment-${m.network}.json`);
  const identity = { parent: m.parent, dao: m.dao, nft: m.nft, network: m.network, operator: m.operator,
    verifier: m.verifier, collateral: m.collateral, release: m.release ?? null,
    daoCodeHash: m.daoCodeHash ?? null, daoMinApprovals: m.daoMinApprovals,
    contracts: Object.fromEntries(ROLES.map(role => { const c = m.contracts[role];
      return [role, { account: c.account, codeHash: c.codeHash, init: c.init, fundingNear: c.fundingNear }]; })) };
  const record = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : { identity };
  ensure(isDeepStrictEqual(record.identity, identity), "deployment record belongs to another manifest; use its original manifest or a separate key directory");
  const ctx = { m, chain, parent, plan: buildPlan(m), keyDir, log, record, recordFile };
  if (record.pending) {
    const step = ctx.plan.find(item => item.name === record.pending.step);
    ensure(step && isHash(record.pending.hash), "invalid pending deployment record");
    const outcome = await chain.transaction(record.pending.hash, step.signer);
    assertLanded(outcome, step.name);
    ensure(outcome.transaction.hash === record.pending.hash && outcome.transaction.signer_id === step.signer
      && outcome.transaction.receiver_id === step.receiver, "pending deployment transaction identity differs");
    ensure(record[step.role]?.transactions, "pending deployment has no role record");
    record[step.role].transactions[step.name] = record.pending.hash;
    record.pending = null;
    saveRecord(ctx);
  }
  for (const role of ROLES) await deployRole(ctx, role);
  log(`record written to ${ctx.recordFile}`);
}

function saveRecord(ctx) {
  const temporary = `${ctx.recordFile}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(ctx.record, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, ctx.recordFile);
  const directory = fs.openSync(ctx.keyDir, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

// ---- DAO proposals ------------------------------------------------------------------------------------------------

async function propose(ctx, target, methodName, args, description) {
  const request = await prepareAdministrationProposal({ ...ctx, target, methodName, args, description });
  return { description, request };
}

async function sealKey(chain, c) {
  const keys = await chain.keys(c.account);
  if (keys.length === 0) return null;
  ensure(keys.length === 1 && keys[0].access_key.permission === "FullAccess",
    `${c.account} has ${keys.length} access keys, expected only the deployer's full access key`);
  return keys[0].public_key;
}

export async function daoProposals(m, chain) {
  await assertGovernance(m, chain);
  const ctx = { treasuryId: m.dao, contracts: accountsOf(m), view: chain.view };
  const items = [], notes = [];
  for (const role of ROLES) {
    const c = m.contracts[role], config = await chain.view(c.account, "config");
    await readBack(chain, role, c);
    ensure((await chain.account(c.account))?.code_hash === c.codeHash, `${role} live code differs from the approved release`);
    if (!config.upgrade_proven) {
      ensure(await chain.view(c.account, "is_staged", { code_hash: c.codeHash }), `${role} approved code is not staged`);
      items.push(await propose(ctx, role, "upgrade", { code_hash: c.codeHash },
        `Upgrade ${role} to its approved code hash ${c.codeHash} to prove the upgrade path`));
      notes.push(`${role}: submit and execute the upgrade, then run proposals again for its seal`);
      continue;
    }
    const publicKey = await sealKey(chain, c);
    if (publicKey) items.push(await propose(ctx, role, "seal", { public_key: publicKey },
      `Seal ${role}: delete the deployer's access key`));
  }
  const council = await chain.view(m.contracts.council.account, "config");
  if (council.nft_contract !== m.nft) {
    items.push(await propose(ctx, "council", "set_nft_contract", { nft_contract: m.nft }, `Set the NFT collection to ${m.nft}`));
  }
  ensure(Array.isArray(council.markets), "Council returned invalid market permissions");
  if (!council.markets.includes(m.contracts.market.account)) {
    items.push(await propose(ctx, "council", "allow_market", { market: m.contracts.market.account }, "Allow the approved market to send Council revenue"));
  }
  const market = await chain.view(m.contracts.market.account, "config");
  if (market.revenue_pool !== m.contracts.council.account || market.treasury !== m.dao) {
    items.push(await propose(ctx, "market", "set_fee_recipients", { revenue_pool: m.contracts.council.account, treasury: m.dao },
      "Send market fees to the Council and DAO treasury"));
  }
  if ((await chain.view(m.contracts.rounds.account, "config")).treasury !== m.dao) {
    items.push(await propose(ctx, "rounds", "set_treasury", { treasury: m.dao }, "Send rounds fees to the DAO treasury"));
  }
  return { items, notes };
}

function printProposals({ items, notes }, log, json = false) {
  if (json) return log(JSON.stringify(items.map(({ description, request }) => ({ description, request }))));
  for (const { description, request } of items) log(`# ${description}\n${JSON.stringify(request, null, 2)}\n`);
  for (const note of notes) log(`note: ${note}`);
  log(`${items.length} wallet requests prepared for DAO members to review; nothing was signed or sent.`);
}

// ---- verify -------------------------------------------------------------------------------------------------------

const expectEqual = (actual, wanted) => ensure(isDeepStrictEqual(actual, wanted), `got ${JSON.stringify(actual)}, want ${JSON.stringify(wanted)}`);

function roleChecks(m, role, chain) {
  const c = m.contracts[role];
  const config = () => chain.view(c.account, "config");
  const checks = [
    ["configuration matches the manifest", () => readBack(chain, role, c)],
    ["owner is the DAO", async () => expectEqual((await config()).owner, m.dao)],
    ["upgrade path proven", async () => expectEqual((await config()).upgrade_proven, true)],
    ["no access keys", async () => expectEqual((await chain.keys(c.account)).length, 0)],
    ["code hash matches the manifest", async () => expectEqual((await chain.account(c.account))?.code_hash, c.codeHash)],
  ];
  if (role === "council") checks.push(["NFT collection is set", async () => expectEqual((await config()).nft_contract, m.nft)]);
  if (role === "council") checks.push(["only the approved market can send revenue", async () => expectEqual((await config()).markets, [m.contracts.market.account])]);
  if (role === "market") checks.push(["fee recipients are the Council and DAO", async () => {
    const live = await config();
    expectEqual(live.revenue_pool, m.contracts.council.account);
    expectEqual(live.treasury, m.dao);
  }]);
  if (role === "rounds") checks.push(["fee recipient is the DAO", async () => expectEqual((await config()).treasury, m.dao)]);
  return checks;
}

export async function verify(m, chain) {
  const results = [];
  try {
    await assertGovernance(m, chain);
    results.push({ ok: true, text: "PASS DAO governance matches the approved authority" });
  } catch (error) {
    results.push({ ok: false, text: `FAIL DAO governance: ${error.message}` });
  }
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

async function assertGovernance(m, chain) {
  assertDaoPolicy(await chain.view(m.dao, "get_policy"), m.daoMinApprovals);
  if (m.network !== "sandbox") {
    ensure((await chain.account(m.dao))?.code_hash === m.daoCodeHash, "DAO code differs from the approved code hash");
    ensure((await chain.keys(m.dao)).length === 0, "DAO has access keys that bypass voting");
  }
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
  await assertGovernance(m, chain);
  const ctx = { treasuryId: m.dao, contracts: accountsOf(m), view: chain.view };
  const supply = Number(await chain.view(m.nft, "nft_total_supply"));
  ensure(Number.isSafeInteger(supply) && supply >= 0 && supply <= NFT_ENUMERATION_CAP, "invalid or excessive NFT supply");
  const lines = [`${supply > 0 ? "PASS" : "FAIL"} ${m.nft} supply is ${supply}`];
  try {
    lines.push(`PASS ${await verifyNftCustody(m.nftCustody, m.nft, chain)}`);
  } catch (error) {
    return { lines: [...lines, `FAIL ${m.nft} custody: ${error.message}`], items: [], ready: false };
  }
  const council = await chain.view(m.contracts.council.account, "config");
  if (council.nft_contract !== m.nft) lines.push(`FAIL council nft_contract is ${council.nft_contract}; set it first (proposals)`);
  if (supply === 0 || council.nft_contract !== m.nft) return { lines, items: [], ready: false };
  const { line, items } = await allowlistProposals(ctx, m.nft, await listTokens(chain, m.nft, supply));
  return { lines: [...lines, line], items, ready: true };
}

// ---- command line -------------------------------------------------------------------------------------------------

const OPTIONS = {
  manifest: { type: "string" },
  rpc: { type: "string" },
  "rpc-second": { type: "string" },
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
  const chain = await connect(needOption(values, "rpc"), m, values["rpc-second"]);
  const keyDir = values["key-dir"] ?? path.join(os.homedir(), ".dragons-market", "keys", m.network);
  await deploy(m, chain, { keyDir, parentKeyFile: needOption(values, "parent-key-file") }, log);
  return 0;
}

async function runProposals(m, values, log) {
  printProposals(await daoProposals(m, await connect(needOption(values, "rpc"), m, values["rpc-second"])), log, values.json);
  return 0;
}

async function runVerify(m, values, log) {
  const results = await verify(m, await connect(needOption(values, "rpc"), m, values["rpc-second"]));
  results.forEach(({ text }) => log(text));
  return results.every(({ ok }) => ok) ? 0 : 1;
}

async function runNftReady(m, values, log) {
  const { lines, items, ready } = await nftReady(m, await connect(needOption(values, "rpc"), m, values["rpc-second"]));
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
