#!/usr/bin/env node
// Keeper for the Council contracts. Several steps only happen when someone calls them, and each has a deadline after
// which the case ends with no decision: drawing a jury, finalizing, writing a final answer to the market, releasing a
// jury's seats, and answering a market nobody answered once its resolve_by has passed. Every one of those calls is open
// to anyone, so this script watches the chain and sends each one when it is due. It also sweeps the market's fees to the
// Council and the business wallet once enough have built up.
//
//   node keeper.mjs run   --rpc URL --market ID --oracle ID --council ID --account ID [--dry-run]
//                         [--key-file PATH] [--oracle-key-file PATH] [--market-key-file PATH]
//                         [--state-file PATH] [--min-sweep UNITS]
//   node keeper.mjs check --rpc URL --market ID --oracle ID --council ID [--treasury ID] [--min-margin NEAR]
//
// `run` needs an account with a little NEAR for gas. The calls it makes move no money of the keeper's own, and none
// of them attach a deposit, so a function call access key is enough. `check` reads only. It reports whether the
// council can seat a jury and a second jury, and how much NEAR each contract account has left after paying for the
// storage it uses, and exits 1 if anything is wrong.
//
// The secret key is never taken from the command line, where it would sit in the process list and shell history.
// Give it as the environment variable KEEPER_KEY, or as --key-file naming a file that only its owner can read
// (chmod 600). --key is refused. The calls to one contract can use their own key: --oracle-key-file or KEEPER_ORACLE_KEY
// for the oracle, --market-key-file or KEEPER_MARKET_KEY for the market. A scoped key replaces the default for that
// contract only. Create scoped keys on the keeper account with near-cli-rs, limited to one receiver, the methods the
// keeper calls there and a small allowance (the gas the keeper attaches is charged against it, so watch what is left
// with view_access_key and top up by adding a fresh key):
//
//   near account add-key KEEPER.near grant-function-call-access --allowance '1 NEAR' \
//     --receiver-account-id ORACLE.near \
//     --method-names 'finalize,resolve_draw,retry_apply,retry_unlock,resolve_by_deadline' \
//     autogenerate-new-keypair print-to-terminal network-config mainnet sign-with-keychain send
//   near account add-key KEEPER.near grant-function-call-access --allowance '0.5 NEAR' \
//     --receiver-account-id MARKET.near --method-names 'sweep_fees' \
//     autogenerate-new-keypair print-to-terminal network-config mainnet sign-with-keychain send
//
// Each run reads every market and case unless --state-file is given. The file holds the highest market id N such that
// every market up to N is finished (resolved, its answer applied, its jury released), and later runs start after N.
// It advances only over an unbroken run of finished markets, so one stuck market is looked at again every run.
// No dependencies: Node 22 built-ins only.
import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const TGAS = 10n ** 12n;
const PAGE = 50;
// The council keeps a case's second jury under the market id with this bit set (SECOND_ROUND_KEY in oracle).
const SECOND_ROUND_KEY = 1n << 63n;
const MAX_JURY_SIZE = 21;
const YOCTO_PER_NEAR = 10n ** 24n;
// What the network charges to keep one byte of account state.
const STORAGE_BYTE_COST = 10n ** 19n;
// 5 NEAR pays for 500 KB of new state, which is what trading, registrations and new markets add to a contract account
// between two checks, with room over the 1 yoctoNEAR the contracts attach to their own calls.
const DEFAULT_MIN_MARGIN_NEAR = "5";
// In the collateral token's smallest unit. 10,000,000 is 10 tokens at 6 decimals. It only keeps the keeper from
// paying for a sweep of dust.
const DEFAULT_MIN_SWEEP = 10_000_000n;
// sweep_fees refuses less than 95 TGas.
const SWEEP_GAS_TGAS = 100;

// ---- what is due -------------------------------------------------------------------------------------------------

// snapshot: { now, height, markets: [{ id, outcome, resolve_by }], cases: { [id]: case | null }, locked: { [id]: bool },
// feesDue, minSweep }. feesDue is what a sweep would send now, in token units.
// A disputed case that has no jury yet can be drawn until draw_by and is over after it. One that has a jury is over once
// its panel_deadline has passed. Finalizing a round that is over calls for the second jury or settles the case.
// Times are BigInt nanoseconds, height, feesDue and minSweep are BigInt. Returns the calls to send now, in the order to
// send them.
export function dueActions(snapshot) {
  const actions = [];
  const call = (contract, method, id, tgas) =>
    actions.push({ contract, method, args: { market_id: String(id) }, gas: BigInt(tgas) * TGAS });
  for (const market of snapshot.markets) {
    const id = market.id;
    const c = snapshot.cases[id];
    if (c) {
      if (c.stage === "proposed" && snapshot.now >= BigInt(c.window_ends_at)) call("oracle", "finalize", id, 100);
      if (c.stage === "disputed") {
        const drawable = c.panel.length === 0 && snapshot.height >= BigInt(c.draw_after_height) && snapshot.now <= BigInt(c.draw_by);
        if (drawable) call("oracle", "resolve_draw", id, 300);
        const over = snapshot.now > BigInt(c.panel.length === 0 ? c.draw_by : c.panel_deadline);
        if (over) call("oracle", "finalize", id, 100);
      }
      if (c.stage === "final" && !c.applied) call("oracle", "retry_apply", id, 100);
      if (c.stage === "final" && c.challenger && snapshot.locked[id]) call("oracle", "retry_unlock", id, 100);
    } else if (market.outcome === null && snapshot.now >= BigInt(market.resolve_by)) {
      call("oracle", "resolve_by_deadline", id, 100);
    }
  }
  if (snapshot.feesDue > 0n && snapshot.feesDue >= snapshot.minSweep) {
    actions.push({ contract: "market", method: "sweep_fees", args: {}, gas: BigInt(SWEEP_GAS_TGAS) * TGAS });
  }
  return actions;
}

// A market is finished when nothing more can be asked of the keeper for it: it has an answer, and its case, if it has
// one, is final, applied, and no longer holds a jury.
export function isFinished(market, c, locked) {
  if (market.outcome === null) return false;
  return !c || (c.stage === "final" && c.applied && !locked);
}

// The new cursor: `doneThrough` (-1n for none) moved over the unbroken run of finished markets that follows it.
// snapshot.markets must be in id order, starting after `doneThrough`.
export function advanceCursor(snapshot, doneThrough) {
  let done = doneThrough;
  for (const m of snapshot.markets) {
    const id = BigInt(m.id);
    if (id !== done + 1n || !isFinished(m, snapshot.cases[m.id], snapshot.locked[m.id])) break;
    done = id;
  }
  return done;
}

export function readCursor(path) {
  if (!path || !fs.existsSync(path)) return -1n;
  const saved = JSON.parse(fs.readFileSync(path, "utf8"));
  if (typeof saved.finished_through !== "string" || !/^\d+$/.test(saved.finished_through)) {
    throw new Error(`${path} is not a keeper state file (finished_through must be a market id as a string)`);
  }
  return BigInt(saved.finished_through);
}

export function writeCursor(path, doneThrough) {
  const temp = `${path}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ finished_through: String(doneThrough) }) + "\n");
  fs.renameSync(temp, path);
}

// ---- reading the chain -------------------------------------------------------------------------------------------

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "keeper", method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function view(url, account, method, args = {}) {
  const result = await rpc(url, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (result.error) throw new Error(`${account}.${method}: ${result.error}`);
  return JSON.parse(Buffer.from(result.result).toString());
}

async function snapshot(opts, firstMarket) {
  const block = await rpc(opts.rpc, "block", { finality: "final" });
  const markets = [];
  for (let from = Number(firstMarket); ; from += PAGE) {
    const page = await view(opts.rpc, opts.market, "list_markets", { from_index: String(from), limit: String(PAGE) });
    markets.push(...page.map((m) => ({ id: m.id, outcome: m.outcome ?? null, resolve_by: m.resolve_by })));
    if (page.length < PAGE) break;
  }
  const cases = {};
  const locked = {};
  for (const m of markets) {
    cases[m.id] = await view(opts.rpc, opts.oracle, "get_case", { market_id: m.id });
    const settledDispute = cases[m.id] && cases[m.id].stage === "final" && cases[m.id].challenger;
    const secondKey = String(BigInt(m.id) | SECOND_ROUND_KEY);
    locked[m.id] = settledDispute
      ? (await view(opts.rpc, opts.council, "jury_of", { case_key: m.id })).length > 0 ||
        (await view(opts.rpc, opts.council, "jury_of", { case_key: secondKey })).length > 0
      : false;
  }
  const fees = await view(opts.rpc, opts.market, "get_fees");
  const feesDue = BigInt(fees.collected) + BigInt(fees.revenue_due) + BigInt(fees.business_due);
  const minSweep = opts["min-sweep"] === undefined ? DEFAULT_MIN_SWEEP : BigInt(opts["min-sweep"]);
  return {
    now: BigInt(block.header.timestamp_nanosec), height: BigInt(block.header.height), markets, cases, locked, feesDue, minSweep,
  };
}

// ---- keys --------------------------------------------------------------------------------------------------------

const KEY_SOURCES = {
  default: { file: "key-file", env: "KEEPER_KEY" },
  oracle: { file: "oracle-key-file", env: "KEEPER_ORACLE_KEY" },
  market: { file: "market-key-file", env: "KEEPER_MARKET_KEY" },
};

export function refuseKeyFlags(opts) {
  for (const flag of ["key", "oracle-key", "market-key"]) {
    if (flag in opts) throw new Error(`--${flag} is refused: a key on the command line shows in the process list. Use KEEPER_KEY or --key-file`);
  }
}

export function readKeyFile(path) {
  const mode = fs.statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`${path} can be read by group or others (mode ${mode.toString(8)}); run chmod 600 on it`);
  }
  return fs.readFileSync(path, "utf8").trim();
}

// The secret key for each contract the keeper calls. A key given for one contract replaces the default for it.
// Returns { default, oracle, market }, each a string or undefined.
export function resolveKeys(opts, env) {
  const keys = {};
  for (const [name, source] of Object.entries(KEY_SOURCES)) {
    keys[name] = opts[source.file] !== undefined ? readKeyFile(opts[source.file]) : env[source.env];
  }
  return keys;
}

function keyFor(keys, contract) {
  const secret = keys[contract] ?? keys.default;
  if (!secret) throw new Error(`no key for ${contract}: set ${KEY_SOURCES[contract].env} or ${KEY_SOURCES.default.env}, or pass a key file`);
  return secret;
}

// ---- sending a call ----------------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(text) {
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(B58.indexOf(ch));
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes]);
}

function b58encode(bytes) {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n) => Buffer.concat([u64(BigInt(n) & ((1n << 64n) - 1n)), u64(BigInt(n) >> 64n)]);
const str = (s) => { const b = Buffer.from(s); return Buffer.concat([u32(b.length), b]); };

// A signed transaction with one function call, borsh encoded as NEAR expects, base64 for the RPC.
function signedFunctionCall({ signer, seed, publicKey, nonce, receiver, blockHash, method, args, gas }) {
  const action = Buffer.concat([Buffer.from([2]), str(method), u32(args.length), args, u64(gas), u128(0)]);
  const tx = Buffer.concat([
    str(signer), Buffer.from([0]), publicKey, u64(nonce), str(receiver), blockHash, u32(1), action,
  ]);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const key = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const signature = crypto.sign(null, crypto.createHash("sha256").update(tx).digest(), key);
  return Buffer.concat([tx, Buffer.from([0]), signature]).toString("base64");
}

async function send(opts, keys, action) {
  const secret = b58decode(keyFor(keys, action.contract).replace(/^ed25519:/, ""));
  if (secret.length !== 64) throw new Error(`the ${action.contract} key is not an ed25519 secret key (expected 64 bytes, got ${secret.length})`);
  const seed = secret.subarray(0, 32);
  const publicKey = secret.subarray(32, 64);
  // Optimistic, not final: the nonce must include the call this keeper sent a moment ago, which final finality has not
  // seen yet, and a repeated nonce is refused. Decisions about what is due are still read at final.
  const [block, accessKey] = await Promise.all([
    rpc(opts.rpc, "block", { finality: "optimistic" }),
    rpc(opts.rpc, "query", { request_type: "view_access_key", finality: "optimistic", account_id: opts.account, public_key: `ed25519:${b58encode(publicKey)}` }),
  ]);
  const receiver = opts[action.contract];
  const signed = signedFunctionCall({
    signer: opts.account, seed, publicKey, nonce: BigInt(accessKey.nonce) + 1n, receiver,
    blockHash: b58decode(block.header.hash), method: action.method, args: Buffer.from(JSON.stringify(action.args)), gas: action.gas,
  });
  const outcome = await rpc(opts.rpc, "broadcast_tx_commit", [signed]);
  const failure = outcome.status && outcome.status.Failure;
  return failure ? `FAILED ${JSON.stringify(failure)}` : "ok";
}

// ---- the deploy check --------------------------------------------------------------------------------------------

// A failed first round calls for a second jury of this many.
export function secondJurySize(jurySize) {
  return Math.min(2 * jurySize + 1, MAX_JURY_SIZE);
}

// Returns a list of problems; empty means fine. A jury is drawn from distinct accounts and leaves out whoever proposed
// and whoever challenged, so with fewer holders than the jury size every draw fails and every dispute ends Void. With
// exactly the jury size, a proposer or challenger who holds a seat leaves too few. A first jury that does not decide
// is followed by a second one that leaves out the first jury as well, so escalating needs both juries and the two
// parties to be different accounts.
export function juryProblems({ jurySize, holders }) {
  const second = secondJurySize(jurySize);
  const needed = jurySize + second + 2;
  if (holders < jurySize) return [`only ${holders} different seat holders for a jury of ${jurySize}: every draw will fail and every dispute will end Void`];
  if (holders < jurySize + 2) return [`${holders} different seat holders for a jury of ${jurySize}: a dispute whose proposer and challenger both hold seats cannot be drawn, so ${jurySize + 2} are needed to be safe`];
  if (holders < needed) return [`${holders} different seat holders for a jury of ${jurySize}: a first jury that does not decide cannot escalate, because the second jury of ${second} leaves out the first ${jurySize}, the proposer and the challenger, so ${needed} are needed (${jurySize} + ${second} + 2). Until then such a dispute is not decided by a second jury`];
  return [];
}

export function nearToYocto(text) {
  const match = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text);
  if (!match) throw new Error(`"${text}" is not an amount of NEAR`);
  return BigInt(match[1]) * YOCTO_PER_NEAR + BigInt((match[2] ?? "").padEnd(24, "0"));
}

export function formatNear(yocto) {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = String(yocto % YOCTO_PER_NEAR).padStart(24, "0").slice(0, 3);
  return `${whole}.${frac} NEAR`;
}

// What an account has left after paying for the storage it uses. The chain only lets an account spend the rest.
export function storageMargin({ amount, storage_usage }) {
  return BigInt(amount) - BigInt(storage_usage) * STORAGE_BYTE_COST;
}

// One line per account, and a problem for each account whose margin is under `minMargin` (yocto).
export function marginReport(accounts, minMargin) {
  const lines = [];
  const problems = [];
  for (const { name, id, amount, storage_usage } of accounts) {
    const margin = storageMargin({ amount, storage_usage });
    lines.push(`${name} ${id}: balance ${formatNear(BigInt(amount))}, ${storage_usage} bytes of storage, ${formatNear(margin)} left after storage`);
    if (margin < minMargin) problems.push(`${name} ${id} has ${formatNear(margin)} left after paying for its storage, under the ${formatNear(minMargin)} margin: fund it before it runs out`);
  }
  return { lines, problems };
}

async function check(opts) {
  const minMargin = nearToYocto(opts["min-margin"] ?? DEFAULT_MIN_MARGIN_NEAR);
  const oracle = await view(opts.rpc, opts.oracle, "config");
  const owners = new Set();
  for (let from = 0; ; from += PAGE) {
    const tokens = await view(opts.rpc, opts.council, "staked_tokens", { from_index: from, limit: PAGE });
    for (const token_id of tokens) owners.add((await view(opts.rpc, opts.council, "stake_of", { token_id })).owner);
    if (tokens.length < PAGE) break;
  }
  const problems = juryProblems({ jurySize: oracle.jury_size, holders: owners.size });
  if (oracle.publishers.length < oracle.price_threshold) problems.push(`${oracle.publishers.length} price publishers but ${oracle.price_threshold} must sign: no price market can open`);
  console.log(`jury size ${oracle.jury_size} then ${secondJurySize(oracle.jury_size)}, ${owners.size} different seat holders, ${oracle.publishers.length} publishers (${oracle.price_threshold} must sign)`);

  const named = [["market", opts.market], ["oracle", opts.oracle], ["council", opts.council]];
  if (opts.treasury) named.push(["treasury", opts.treasury]);
  const accounts = [];
  for (const [name, id] of named) {
    const account = await rpc(opts.rpc, "query", { request_type: "view_account", finality: "final", account_id: id });
    accounts.push({ name, id, amount: account.amount, storage_usage: account.storage_usage });
  }
  const margins = marginReport(accounts, minMargin);
  for (const line of margins.lines) console.log(line);
  problems.push(...margins.problems);

  for (const p of problems) console.log(`PROBLEM: ${p}`);
  if (!problems.length) console.log("ok");
  return problems.length ? 1 : 0;
}

// ---- command line ------------------------------------------------------------------------------------------------

function options(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") opts.dryRun = true;
    else if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i];
  }
  return opts;
}

export function refuseRetiredController(opts) {
  if (Object.hasOwn(opts, "governance")) {
    throw new Error("--governance is retired; use --treasury with the verified Trezu/Sputnik account ID");
  }
}

function label(action) {
  return `${action.contract}.${action.method}(${action.args.market_id ?? ""})`;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = options(rest);
  refuseRetiredController(opts);
  if (command === "check") process.exit(await check(opts));
  if (command !== "run") {
    console.error("usage: keeper.mjs run|check --rpc URL --market ID --oracle ID --council ID [--account ID] [--dry-run] (see the top of the file)");
    process.exit(2);
  }
  refuseKeyFlags(opts);
  const keys = opts.dryRun ? {} : resolveKeys(opts, process.env);
  const finishedThrough = readCursor(opts["state-file"]);
  const snap = await snapshot(opts, finishedThrough + 1n);
  const actions = dueActions(snap);
  if (!actions.length) console.log("nothing due");
  for (const action of actions) {
    console.log(opts.dryRun ? `due ${label(action)}` : `${label(action)}: ${await send(opts, keys, action)}`);
  }
  if (opts["state-file"] && !opts.dryRun) {
    const advanced = advanceCursor(snap, finishedThrough);
    if (advanced !== finishedThrough) writeCursor(opts["state-file"], advanced);
    if (advanced >= 0n) console.log(`markets finished through id ${advanced}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
