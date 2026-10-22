#!/usr/bin/env node
// Keeper for the Council contracts. Several steps only happen when someone calls them, and each has a deadline after
// which the case ends with no decision: drawing a jury, finalizing, writing a final answer to the market, releasing a
// jury's seats, and answering a market nobody answered once its resolve_by has passed. Every one of those calls is open
// to anyone, so this script watches the chain and sends each one when it is due. It also sweeps the market's fees to the
// Council and the treasury once enough have built up.
//
//   node keeper.mjs run   --rpc URL --market ID --oracle ID --council ID --account ID [--dry-run]
//                         [--key-file PATH] [--oracle-key-file PATH] [--market-key-file PATH]
//                         [--state-file PATH] [--min-sweep UNITS]
//   node keeper.mjs check --rpc URL --market ID --oracle ID --council ID [--treasury ID] [--min-margin NEAR]
//                         [--expect-sealed] [--watch-dao]
//
// `run` needs an account with a little NEAR for gas. The calls it makes move no money of the keeper's own, and none
// of them attach a deposit, so a function call access key is enough. `check` reads only. It reports whether the
// council can seat a jury and a second jury; whether the market, the oracle and the council each hold in the verifier at
// least what they owe, both read at one finalized block and read again a few blocks later before a shortfall is reported
// (more than they owe is reported and never credited); whether the verifier has a key registered for any of the three, lets
// them pay by their own calls, has locked them or has paused transfers; how many NEAR access keys each has (--expect-sealed
// makes any key a problem, for use after seal); and how much NEAR each contract account has left after paying for the
// storage it uses. --watch-dao lists the open proposals of the --treasury DAO that name these contracts and flags any that is
// not on the treasury helper's allow-list. It never votes. `check` exits 1 if anything is wrong.
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
import { b58decode, b58encode, rpc, view, viewer } from "./chain.mjs";
import { reviewKind } from "./treasury.mjs";

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
// sweep_fees refuses less than 87 TGas.
const SWEEP_GAS_TGAS = 100;
const CONTRACTS = ["market", "oracle", "council"];
// The verifier pauses transfers under this feature key, and a paused verifier refuses every mt_transfer and mt_transfer_call
// (pause_and_lock_stop_payouts_but_not_receipts in intents_verifier.rs).
const VERIFIER_PAUSE_KEY = "mt_transfer";
// A shortfall is read again this many times, each time this many blocks later, before it is reported. The wait ends after the
// timeout even if the chain has not moved.
const SHORTFALL_RECHECKS = 2;
const RECHECK_BLOCKS = 3;
const BLOCK_POLL_MS = 1000;
const RECHECK_TIMEOUT_MS = 30_000;
const BRIEF_MAX = 200;

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
  const feesDue = BigInt(fees.collected) + BigInt(fees.revenue_due) + BigInt(fees.treasury_due);
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

// What a contract owes against what the verifier holds for it, both read at one finalized block. The market and the oracle
// keep a total, so `owed` is exact. The Council's `owed` is a floor (see councilFloor). Less in the verifier
// than owed means money is missing. More is surplus nobody is credited for, such as a plain deposit or a payout on its way, and
// is only reported.
export function reconciliation({ name, owed, held, exact = true }) {
  const surplus = BigInt(held) - BigInt(owed);
  const owes = exact ? "owes" : "owes at least";
  const extra = surplus > 0n ? `, ${surplus} more than it ${exact ? "owes" : "needs"} (surplus nobody is credited for, or a payout in flight)` : "";
  return {
    line: `${name} ${owes} ${owed} and holds ${held} in the verifier${extra}`,
    problem: surplus < 0n ? `the ${name} ${owes} ${owed} but the verifier holds only ${held} for it: ${-surplus} is missing` : null,
  };
}

// Reads the books, and while the verifier holds less than is owed reads them again a few blocks later, so that a shortfall
// is reported only when it is still there. `read` returns { owed, held } from one block.
export async function reconcile(read, waitForBlocks) {
  let books = await read();
  for (let attempt = 0; attempt < SHORTFALL_RECHECKS && BigInt(books.held) < BigInt(books.owed); attempt++) {
    await waitForBlocks(RECHECK_BLOCKS);
    books = await read();
  }
  return books;
}

// What the verifier says about one contract's account, as problems. A key registered there can move the funds without the
// contract's rules. Without predecessor authentication the contract's own payout calls are refused. A locked account can
// still be paid but cannot pay out.
export function verifierProblems({ name, id, keys, predecessorAuth, locked }) {
  const problems = [];
  if (keys.length) problems.push(`${name} ${id} has ${keys.length} public key${keys.length === 1 ? "" : "s"} registered in the verifier: a key can move its funds without the contract's rules`);
  if (!predecessorAuth) problems.push(`${name} ${id} does not authenticate by predecessor in the verifier: its own payout calls are refused`);
  if (locked) problems.push(`${name} ${id} is locked in the verifier: it keeps receiving money it cannot pay out, so stop advertising deposits`);
  return problems;
}

// accounts: [{ name, id, count }] of NEAR access keys. After seal there should be none, which is only a problem when asked for.
export function accessKeyReport(accounts, expectSealed) {
  const line = `access keys: ${accounts.map(({ name, count }) => `${name} ${count}`).join(", ")}`;
  const problems = expectSealed
    ? accounts.filter(({ count }) => count > 0).map(({ name, id, count }) => `${name} ${id} still has ${count} access key${count === 1 ? "" : "s"}: the owner has not sealed it`)
    : [];
  return { line, problems };
}

// Proposals that can still be voted on or retried: in progress or failed, and inside the voting period.
export function isOpen(proposal, now, period) {
  return ["InProgress", "Failed"].includes(proposal.status) && BigInt(proposal.submission_time) + BigInt(period) >= now;
}

const brief = (value) => {
  const text = JSON.stringify(value);
  return text.length > BRIEF_MAX ? `${text.slice(0, BRIEF_MAX)}...` : text;
};

// Lists the open DAO proposals that name one of the three contracts, and a problem for each the treasury helper would refuse
// to approve. Other open proposals are counted by kind, so a policy or membership change does not go unseen. Nothing is voted.
export async function daoReport({ proposals, treasuryId, contracts, view: read }) {
  const lines = [];
  const problems = [];
  const others = [];
  const ours = new Set(Object.values(contracts));
  for (const proposal of proposals) {
    const receiver = proposal.kind?.FunctionCall?.receiver_id;
    if (!ours.has(receiver)) {
      others.push(typeof proposal.kind === "string" ? proposal.kind : Object.keys(proposal.kind ?? {})[0]);
      continue;
    }
    const who = `DAO proposal ${proposal.id} (${proposal.status}, by ${proposal.proposer})`;
    try {
      const reviewed = await reviewKind(proposal.kind, { treasuryId, contracts, view: read });
      lines.push(`${who}: ${reviewed.target}.${reviewed.method} ${brief(reviewed.args)}`);
    } catch (e) {
      lines.push(`${who} names ${receiver}`);
      problems.push(`DAO proposal ${proposal.id} names ${receiver} and is not on the allow-list: ${e.message}`);
    }
  }
  if (others.length) lines.push(`${others.length} other open DAO proposals (${[...new Set(others)].join(", ")})`);
  if (!lines.length) lines.push("no open DAO proposals");
  return { lines, problems };
}

async function finalHeight(url) {
  return (await rpc(url, "block", { finality: "final" })).header.height;
}

async function waitForBlocks(url, count) {
  const target = (await finalHeight(url)) + count;
  const deadline = Date.now() + RECHECK_TIMEOUT_MS;
  while (Date.now() < deadline && (await finalHeight(url)) < target) {
    await new Promise((resolve) => setTimeout(resolve, BLOCK_POLL_MS));
  }
}

// What the Council must hold at least: everything it took in as revenue, less what it paid out, less the claims in flight
// (their transfers move the money before the Council books them as paid). Rounding left in finalized quarters and a plain
// deposit make it hold more, so the figure is a floor and the Council is allowed to hold more. A Council holding less has lost
// money.
export function councilFloor(totals) {
  return BigInt(totals.total_received) - BigInt(totals.total_paid) - BigInt(totals.pending_claims);
}

// The floor at one block, and the owners of the seats.
async function councilBooks(opts, at) {
  const owners = new Set();
  for (let from = 0; ; from += PAGE) {
    const tokens = await view(opts.rpc, opts.council, "staked_tokens", { from_index: from, limit: PAGE }, at);
    for (const token_id of tokens) owners.add((await view(opts.rpc, opts.council, "stake_of", { token_id }, at)).owner);
    if (tokens.length < PAGE) break;
  }
  return { owed: councilFloor(await view(opts.rpc, opts.council, "reward_totals", {}, at)), owners };
}

// Open proposals of the DAO, newest page first, until a page whose newest proposal is past its voting period.
async function openProposals(opts, read, now) {
  const period = (await read(opts.treasury, "get_policy")).proposal_period;
  const open = [];
  for (let to = await read(opts.treasury, "get_last_proposal_id"); to > 0; to -= PAGE) {
    const from = Math.max(0, to - PAGE);
    const page = await read(opts.treasury, "get_proposals", { from_index: from, limit: to - from });
    const newest = page.at(-1);
    if (newest && BigInt(newest.submission_time) + BigInt(period) < now) break;
    open.push(...page.filter((proposal) => isOpen(proposal, now, period)));
  }
  return open.sort((a, b) => a.id - b.id);
}

async function check(opts) {
  const minMargin = nearToYocto(opts["min-margin"] ?? DEFAULT_MIN_MARGIN_NEAR);
  if (opts["watch-dao"] && !opts.treasury) throw new Error("--watch-dao needs --treasury, the DAO whose proposals to list");
  const block = await rpc(opts.rpc, "block", { finality: "final" });
  const at = block.header.height;
  const configs = {};
  for (const name of CONTRACTS) configs[name] = await view(opts.rpc, opts[name], "config", {}, at);
  const oracle = configs.oracle;

  const books = {};
  let owners;
  for (const name of CONTRACTS) {
    const read = async () => {
      const height = await finalHeight(opts.rpc);
      const council = name === "council" ? await councilBooks(opts, height) : null;
      owners ??= council?.owners;
      const owed = council ? council.owed : BigInt(await view(opts.rpc, opts[name], "total_owed", {}, height));
      const held = BigInt(await view(opts.rpc, configs[name].verifier, "mt_balance_of", { account_id: opts[name], token_id: configs[name].collateral_token_id }, height));
      return { owed, held };
    };
    books[name] = reconciliation({ name, ...(await reconcile(read, () => waitForBlocks(opts.rpc, RECHECK_BLOCKS))), exact: name !== "council" });
  }

  const problems = juryProblems({ jurySize: oracle.jury_size, holders: owners.size });
  if (oracle.publishers.length < oracle.price_threshold) problems.push(`${oracle.publishers.length} price publishers but ${oracle.price_threshold} must sign: no price market can open`);
  console.log(`jury size ${oracle.jury_size} then ${secondJurySize(oracle.jury_size)}, ${owners.size} different seat holders, ${oracle.publishers.length} publishers (${oracle.price_threshold} must sign)`);
  for (const name of CONTRACTS) {
    console.log(books[name].line);
    if (books[name].problem) problems.push(books[name].problem);
  }

  const verifiers = new Set(CONTRACTS.map((name) => configs[name].verifier));
  const trouble = [];
  for (const name of CONTRACTS) {
    const args = { account_id: opts[name] };
    const read = (method) => view(opts.rpc, configs[name].verifier, method, args, at);
    trouble.push(...verifierProblems({
      name, id: opts[name], keys: await read("public_keys_of"), predecessorAuth: await read("is_auth_by_predecessor_id_enabled"), locked: await read("is_account_locked"),
    }));
  }
  for (const verifier of verifiers) {
    if (await view(opts.rpc, verifier, "pa_is_paused", { key: VERIFIER_PAUSE_KEY }, at)) {
      trouble.push(`the verifier ${verifier} has ${VERIFIER_PAUSE_KEY} paused: every payout and every transfer call to the contracts fails`);
    }
  }
  if (!trouble.length) console.log(`verifier ${[...verifiers].join(", ")}: no keys registered, predecessor authentication on, not locked and ${VERIFIER_PAUSE_KEY} running for the market, oracle and council`);
  problems.push(...trouble);

  const keyCounts = [];
  for (const name of CONTRACTS) {
    const { keys } = await rpc(opts.rpc, "query", { request_type: "view_access_key_list", block_id: at, account_id: opts[name] });
    keyCounts.push({ name, id: opts[name], count: keys.length });
  }
  const keys = accessKeyReport(keyCounts, opts["expect-sealed"] === true);
  console.log(keys.line);
  problems.push(...keys.problems);

  const named = CONTRACTS.map((name) => [name, opts[name]]);
  if (opts.treasury) named.push(["treasury", opts.treasury]);
  const accounts = [];
  for (const [name, id] of named) {
    const account = await rpc(opts.rpc, "query", { request_type: "view_account", finality: "final", account_id: id });
    accounts.push({ name, id, amount: account.amount, storage_usage: account.storage_usage });
  }
  const margins = marginReport(accounts, minMargin);
  for (const line of margins.lines) console.log(line);
  problems.push(...margins.problems);

  if (opts["watch-dao"]) {
    const read = viewer(opts.rpc, at);
    const now = BigInt(block.header.timestamp_nanosec);
    const dao = await daoReport({
      proposals: await openProposals(opts, read, now),
      treasuryId: opts.treasury,
      contracts: Object.fromEntries(CONTRACTS.map((name) => [name, opts[name]])),
      view: read,
    });
    for (const line of dao.lines) console.log(line);
    problems.push(...dao.problems);
  }

  for (const p of problems) console.log(`PROBLEM: ${p}`);
  if (!problems.length) console.log("ok");
  return problems.length ? 1 : 0;
}

// ---- command line ------------------------------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(["dry-run", "expect-sealed", "watch-dao"]);

export function options(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    opts[name] = BOOLEAN_FLAGS.has(name) ? true : argv[++i];
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
  const keys = opts["dry-run"] ? {} : resolveKeys(opts, process.env);
  const finishedThrough = readCursor(opts["state-file"]);
  const snap = await snapshot(opts, finishedThrough + 1n);
  const actions = dueActions(snap);
  if (!actions.length) console.log("nothing due");
  for (const action of actions) {
    console.log(opts["dry-run"] ? `due ${label(action)}` : `${label(action)}: ${await send(opts, keys, action)}`);
  }
  if (opts["state-file"] && !opts["dry-run"]) {
    const advanced = advanceCursor(snap, finishedThrough);
    if (advanced !== finishedThrough) writeCursor(opts["state-file"], advanced);
    if (advanced >= 0n) console.log(`markets finished through id ${advanced}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
