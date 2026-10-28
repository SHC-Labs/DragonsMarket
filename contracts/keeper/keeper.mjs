#!/usr/bin/env node
// Keeper for the Council contracts. Several steps only happen when someone calls them, and each has a deadline after
// which the case ends with no decision: drawing a jury, finalizing, writing a final answer to the market, releasing a
// jury's seats, and answering a market nobody answered once its resolve_by has passed. Every one of those calls is open
// to anyone, so this script watches the chain and sends each one when it is due. It also sweeps the market's fees to the
// Council and the treasury once enough have built up. It also moves the Council's seat-time ledger forward, finalizes its
// quarters in order once their grace period has passed, and settles a fee leg whose result the market lost.
//
//   node keeper.mjs run   --rpc URL --market ID --oracle ID --council ID --account ID [--dry-run]
//                         [--key-file PATH] [--oracle-key-file PATH] [--market-key-file PATH] [--council-key-file PATH]
//                         --state-file PATH [--events-file PATH] [--workers 2] [--job-batch 50] [--min-sweep UNITS]
//   node keeper.mjs check --rpc URL --market ID --oracle ID --council ID [--treasury ID] [--min-margin NEAR] [--release FILE|-]
//                         [--expect-sealed] [--watch-dao] [--runway-config PATH]
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
// for the oracle, --market-key-file or KEEPER_MARKET_KEY for the market, --council-key-file or KEEPER_COUNCIL_KEY for the
// Council. A scoped key replaces the default for that
// contract only. Create scoped keys on the keeper account with near-cli-rs, limited to one receiver, the methods the
// keeper calls there and a small allowance (the gas the keeper attaches is charged against it, so watch what is left
// with view_access_key and top up by adding a fresh key):
//
//   near account add-key KEEPER.near grant-function-call-access --allowance '1 NEAR' \
//     --receiver-account-id ORACLE.near \
//     --method-names 'finalize,resolve_draw,retry_apply,retry_unlock,resolve_by_deadline' \
//     autogenerate-new-keypair print-to-terminal network-config mainnet sign-with-keychain send
//   near account add-key KEEPER.near grant-function-call-access --allowance '0.5 NEAR' \
//     --receiver-account-id MARKET.near --method-names 'sweep_fees,settle_leg' \
//     autogenerate-new-keypair print-to-terminal network-config mainnet sign-with-keychain send
//   near account add-key KEEPER.near grant-function-call-access --allowance '0.5 NEAR' \
//     --receiver-account-id COUNCIL.near --method-names 'advance_quarters,finalize_quarter' \
//     autogenerate-new-keypair print-to-terminal network-config mainnet sign-with-keychain send
//
// Legacy cursor helpers below are kept for inspecting old state files. Runtime uses the due-queue.
// Each old run read every market and case unless --state-file was given. The file holds the highest market id N such that
// every market up to N is finished (resolved, its answer applied, its jury released), and later runs start after N.
// It advances only over an unbroken run of finished markets, so one stuck market is looked at again every run.
// No dependencies: Node 22 built-ins only.
import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { b58decode, b58encode, rpc, view, viewer } from "./chain.mjs";
import { compareCodeHashes, describeRelease, liveCodeHashes, parseReleaseHashes } from "./release-check.mjs";
import { reviewKind, storageRunway } from "./treasury.mjs";
import { readQueue, writeQueue, withQueueLock, touch, finish, retry, selectJobs, bounded, serializeByKey, ingestFile } from "./due-queue.mjs";

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
const NS_PER_MINUTE = 60n * 10n ** 9n;
// settle_leg needs 30 TGas; the measured cost is 6 in all.
const SETTLE_GAS_TGAS = 50;

// One book write and no transfer: 2 TGas in all, measured, with 30 attached. advance_quarters writes up to eight books.
const FINALIZE_GAS_TGAS = 50;
const ADVANCE_GAS_TGAS = 50;
// The most quarters one advance_quarters call moves across (MAX_QUARTER_STEPS in the council).
const MAX_QUARTER_STEPS = 8;
const JURY_OPEN_REFUSAL = "a jury drawn in this quarter is still open";
const CONTRACTS = ["market", "oracle", "council"];
// The verifier pauses transfers under this feature key, and a paused verifier refuses every mt_transfer and mt_transfer_call
// (pause_and_lock_stop_payouts_but_not_receipts in intents_verifier.rs).
const VERIFIER_PAUSE_KEY = "mt_transfer";
const NEP141_PREFIX = "nep141:";
// A shortfall is read again this many times, each time this many blocks later, before it is reported. The wait ends after the
// timeout even if the chain has not moved.
const SHORTFALL_RECHECKS = 2;
const RECHECK_BLOCKS = 3;
const BLOCK_POLL_MS = 1000;
const RECHECK_TIMEOUT_MS = 30_000;
const BRIEF_MAX = 200;

// ---- what is due -------------------------------------------------------------------------------------------------

// The council's quarter id for a time in ns: year * 4 + (quarter - 1), UTC. A time on a boundary belongs to the quarter that
// starts there.
export function quarterOf(ns) {
  const d = new Date(Number(ns / 1_000_000n));
  return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
}

// Where the quarter ends, exclusive, in ns.
export function quarterEnd(quarter) {
  const next = quarter + 1;
  return BigInt(Date.UTC(Math.floor(next / 4), (next % 4) * 3, 1)) * 1_000_000n;
}

// snapshot: { market (the market account the oracle calls name), now, height, markets: [{ id, outcome, resolve_by }], cases: { [id]: case | null }, locked: { [id]: bool },
// feesDue, minSweep, council: { lastTick, nextToFinalize, closeGraceNs }, sweeps: [{ id, at, council: { status } }] oldest
// first, lastSweepAt, sweepIntervalNs, settleWaitNs }. feesDue is what a sweep would send now, in token units. lastSweepAt
// is null before the first sweep.
// A disputed case that has no jury yet can be drawn until draw_by and is over after it. One that has a jury is over once
// its panel_deadline has passed. Finalizing a round that is over calls for the second jury or settles the case.
// Times are BigInt nanoseconds, height, feesDue and minSweep are BigInt. Returns the calls to send now, in the order to
// send them.
export function dueActions(snapshot) {
  const actions = [];
  const call = (contract, method, id, tgas) =>
    actions.push({ contract, method, args: { market: snapshot.market, market_id: String(id) }, gas: BigInt(tgas) * TGAS });
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
  actions.push(...councilActions(snapshot));
  for (const sweep of snapshot.sweeps ?? []) {
    if (sweep.council.status === "unresolved" && snapshot.now >= BigInt(sweep.at) + snapshot.settleWaitNs) {
      actions.push({ contract: "market", method: "settle_leg", args: { sweep_id: String(sweep.id) }, gas: BigInt(SETTLE_GAS_TGAS) * TGAS });
    }
  }
  const sweepOpen = snapshot.lastSweepAt == null || snapshot.now >= BigInt(snapshot.lastSweepAt) + snapshot.sweepIntervalNs;
  if (sweepOpen && snapshot.feesDue > 0n && snapshot.feesDue >= snapshot.minSweep) {
    actions.push({ contract: "market", method: "sweep_fees", args: {}, gas: BigInt(SWEEP_GAS_TGAS) * TGAS });
  }
  return actions;
}

// The views do not say how many ticks are owed, so advance_quarters is sent once a run when the quarter of now differs from
// the quarter of last_tick. Within one quarter there is nothing a stake, an unstake or a finalize would have to catch up on.
// finalize_quarter is sent for next_to_finalize only, once its end plus the grace has passed, and only when one advance
// (eight quarters) can bring last_tick up to that end, because finalizing refuses until the ledger has reached it. The
// contract still refuses while a jury drawn inside that quarter is open and no view shows one, so that refusal is read when
// the call is sent (see JURY_OPEN_REFUSAL).
function councilActions(snapshot) {
  const c = snapshot.council;
  if (!c) return [];
  const actions = [];
  const lastTick = BigInt(c.lastTick);
  const behind = quarterOf(snapshot.now) !== quarterOf(lastTick);
  if (behind) actions.push({ contract: "council", method: "advance_quarters", args: {}, gas: BigInt(ADVANCE_GAS_TGAS) * TGAS });
  const quarter = Number(c.nextToFinalize);
  const end = quarterEnd(quarter);
  const reachable = lastTick >= end || quarter - quarterOf(lastTick) + 1 <= MAX_QUARTER_STEPS;
  if (snapshot.now >= end + BigInt(c.closeGraceNs) && reachable) {
    actions.push({ contract: "council", method: "finalize_quarter", args: { quarter }, gas: BigInt(FINALIZE_GAS_TGAS) * TGAS });
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

export function nextMarketAt(market, c, locked, now, height) {
  if (isFinished(market,c,locked)) return null;
  if (!c) return BigInt(market.resolve_by);
  if (c.stage === "proposed") return BigInt(c.window_ends_at);
  if (c.stage === "disputed") {
    if (!c.panel.length) {
      if (now > BigInt(c.draw_by)) return now;
      return height >= BigInt(c.draw_after_height) ? now : now + 1_000_000_000n;
    }
    return BigInt(c.panel_deadline) + 1n;
  }
  return now;
}

async function queuedRun(opts, keys) {
  if (!opts["state-file"] && !opts["dry-run"]) throw new Error("run needs --state-file for its durable due-queue");
  const scope = { rpc:opts.rpc, market:opts.market, oracle:opts.oracle, council:opts.council };
  const state = readQueue(opts["state-file"],scope);
  const workers = Number(opts.workers ?? 2);
  const batch = Number(opts["job-batch"] ?? 50);
  if (!Number.isInteger(batch)||batch<1||batch>500) throw new Error("Job batch must be 1 to 500");
  const block = await rpc(opts.rpc,"block",{finality:"final"});
  const at = block.header.height, now = BigInt(block.header.timestamp_nanosec), height = BigInt(at);
  const read = (account,method,args={})=>view(opts.rpc,account,method,args,at);
  const [marketConfig,council,fees] = await Promise.all([
    read(opts.market,"config"), read(opts.council,"config"), read(opts.market,"get_fees")
  ]);
  ingestFile(state,opts["events-file"],at);
  if (!opts["events-file"]) console.log("no event feed: using bounded bootstrap and rotating reconciliation; live deadlines need --events-file");
  // One page of markets and sweeps per run. Neither recovery cursor can be pinned by an open market.
  const marketFrom = BigInt(state.marketCursor);
  const marketEnd = BigInt(marketConfig.markets);
  if (marketFrom < marketEnd) {
    const [page,cases] = await Promise.all([
      read(opts.market,"list_markets",{from_index:String(marketFrom),limit:String(PAGE)}),
      read(opts.oracle,"list_cases",{market:opts.market,from_market_id:String(marketFrom),limit:PAGE})
    ]);
    const summaries = new Map(cases.map(c=>[c.market_id,c]));
    for(const m of page) {
      const job = state.jobs["market:"+m.id] ?? touch(state,"market",m.id,now);
      const c = summaries.get(m.id);
      if(c?.stage === "proposed")job.nextAt=c.window_ends_at;
      else if(!c && m.outcome===null)job.nextAt=m.resolve_by;
    }
    state.marketCursor=String(marketFrom+BigInt(PAGE)<marketEnd?marketFrom+BigInt(PAGE):marketEnd);
  }
  const sweepFrom = BigInt(state.sweepCursor), sweepEnd = BigInt(marketConfig.next_sweep_id);
  if(sweepFrom<sweepEnd){
    const page=await read(opts.market,"list_sweeps",{from_index:String(sweepFrom),limit:String(PAGE)});
    for(const sweep of page)if(["pending","unresolved"].includes(sweep.council.status)||["pending","unresolved"].includes(sweep.treasury.status))touch(state,"sweep",sweep.id,now);
    state.sweepCursor=String(sweepFrom+BigInt(PAGE)<sweepEnd?sweepFrom+BigInt(PAGE):sweepEnd);
  }
  const jobs=selectJobs(state,now,batch);
  const markets=[],cases={},locked={},sweeps=[],readErrors=new Set();
  await bounded(jobs,workers,async job=>{
    try{
      if(job.kind==="sweep"){
        const sweep=await read(opts.market,"get_sweep",{sweep_id:job.id});
        if(!sweep || (!["pending","unresolved"].includes(sweep.council.status)&&!["pending","unresolved"].includes(sweep.treasury.status)))finish(state,job);
        else sweeps.push(sweep);
        return;
      }
      const [m,c]=await Promise.all([
        read(opts.market,"get_market",{market_id:job.id}),
        read(opts.oracle,"get_case",{market:opts.market,market_id:job.id})
      ]);
      if(!m){finish(state,job);return;}
      cases[job.id]=c;
      if(c?.case_uid){job.caseUid=c.case_uid;state.caseMarkets[c.case_uid]=job.id;}
      const keys = c?.stage==="final"&&c.challenger ? [c.case_uid,String(BigInt(c.case_uid)|SECOND_ROUND_KEY)] : [];
      const juries=await Promise.all(keys.map(key=>read(opts.council,"jury_of",{case_key:key})));
      locked[job.id]=juries.some(j=>j.length>0);
      markets.push(m);
      if(isFinished(m,c,locked[job.id]))finish(state,job);
    }catch(error){readErrors.add(job.kind+":"+job.id);retry(job,now,error.message);console.log("read failed "+job.kind+"("+job.id+"): "+error.message);}
  });
  markets.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
  const configuredMin=BigInt(marketConfig.min_sweep), requestedMin=opts["min-sweep"]===undefined?DEFAULT_MIN_SWEEP:BigInt(opts["min-sweep"]);
  const snap = {
    market:opts.market,now,height,markets,cases,locked,sweeps,
    feesDue:BigInt(fees.collected)+BigInt(fees.revenue_due)+BigInt(fees.treasury_due),
    minSweep:configuredMin>requestedMin?configuredMin:requestedMin,
    lastSweepAt:marketConfig.last_sweep_at??null,
    sweepIntervalNs:BigInt(marketConfig.min_sweep_interval_minutes)*NS_PER_MINUTE,
    settleWaitNs:BigInt(marketConfig.settle_wait_minutes)*NS_PER_MINUTE,
    council:{lastTick:BigInt(council.last_tick),nextToFinalize:council.next_to_finalize,closeGraceNs:BigInt(council.close_grace_ns)}
  };
  state.globalRetry ??= {};
  const jobKey=a=>a.args.market_id!==undefined?"market:"+a.args.market_id:a.args.sweep_id!==undefined?"sweep:"+a.args.sweep_id:null;
  const dedupe = new Map();
  for(const action of dueActions(snap)){
    const key=jobKey(action),j=key?state.jobs[key]:state.globalRetry[action.method];
    if(j?.failures && BigInt(j.nextAt)>now)continue;
    dedupe.set(action.contract+":"+action.method+":"+JSON.stringify(action.args),action);
  }
  const actions=[...dedupe.values()];
  if (!opts["dry-run"]) await validateActionKeys(opts, keys, actions);
  const save=()=>{if(opts["state-file"]&&!opts["dry-run"])writeQueue(opts["state-file"],state);};
  // Persist a batch once before dispatch, rather than rewriting a large queue for every action.
  // After a crash, fresh contract views decide whether an unacknowledged attempt needs retrying.
  for (const action of actions) {
    const key = jobKey(action);
    const j = key ? state.jobs[key] : (state.globalRetry[action.method] ??= { nextAt: "0", failures: 0 });
    if (j) { j.attempting = true; j.lastAction = action.method; }
  }
  save();
  const failed=new Set(), acted=new Set(), serial=serializeByKey();
  let actionFailures = 0;
  if(!actions.length)console.log("nothing due");
  await bounded(actions,workers,async action=>{
    const key=jobKey(action),j=key?state.jobs[key]:(state.globalRetry[action.method]??={nextAt:"0",failures:0});
    if(opts["dry-run"]){console.log("due "+label(action));return;}
    try{
      // One nonce stream per actual key, even when several receivers share the default key.
      const identity=crypto.createHash("sha256").update(keyFor(keys,action.contract)).digest("hex");
      const outcome=await serial(identity,()=>send(opts,keys,action));
      console.log(label(action)+": "+describeOutcome(action,outcome));
      if(outcome.startsWith("FAILED") && !outcome.includes(JURY_OPEN_REFUSAL))throw new Error(outcome);
      if(j){j.failures=0;delete j.error;j.attempting=false;}
      if(key)acted.add(key);
    }catch(error){
      actionFailures++;
      if(j){j.attempting=false;retry(j,now,error.message);}
      if(key)failed.add(key);
      console.log("retry scheduled "+label(action)+": "+error.message);
    }
  });
  if(!opts["dry-run"]){
    for(const job of jobs){
      const key=job.kind+":"+job.id;
      if(!state.jobs[key]||failed.has(key)||readErrors.has(key))continue;
      if(acted.has(key)){job.nextAt=String(now+1_000_000_000n);continue;}
      if(job.failures&&BigInt(job.nextAt)>now)continue;
      if(job.kind==="market"){
        const m=markets.find(m=>m.id===job.id);if(!m)continue;
        const next=nextMarketAt(m,cases[job.id],locked[job.id],now,height);
        if(next===null)finish(state,job);else job.nextAt=String(next>now?next:now+1_000_000_000n);
      }else{
        const sweep=sweeps.find(s=>s.id===job.id);
        const settle=sweep?BigInt(sweep.at)+snap.settleWaitNs:now;
        job.nextAt=String(settle>now?settle:now+60_000_000_000n);
      }
    }
    save();
    console.log("queue "+Object.keys(state.jobs).length+" jobs; bootstrap markets "+state.marketCursor+", sweeps "+state.sweepCursor);
  }
  if (actionFailures || readErrors.size) throw new Error(`Keeper scheduled retries: ${actionFailures} failed actions, ${readErrors.size} failed reads`);
  return {actions,state};
}

// ---- keys --------------------------------------------------------------------------------------------------------

const KEY_SOURCES = {
  default: { file: "key-file", env: "KEEPER_KEY" },
  oracle: { file: "oracle-key-file", env: "KEEPER_ORACLE_KEY" },
  market: { file: "market-key-file", env: "KEEPER_MARKET_KEY" },
  council: { file: "council-key-file", env: "KEEPER_COUNCIL_KEY" },
};

export function refuseKeyFlags(opts) {
  for (const flag of ["key", "oracle-key", "market-key", "council-key"]) {
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
// Returns { default, oracle, market, council }, each a string or undefined.
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
export function signedFunctionCall({ signer, seed, publicKey, nonce, receiver, blockHash, method, args, gas, deposit = 0n }) {
  const action = Buffer.concat([Buffer.from([2]), str(method), u32(args.length), args, u64(gas), u128(deposit)]);
  const tx = Buffer.concat([
    str(signer), Buffer.from([0]), publicKey, u64(nonce), str(receiver), blockHash, u32(1), action,
  ]);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const key = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const signature = crypto.sign(null, crypto.createHash("sha256").update(tx).digest(), key);
  return Buffer.concat([tx, Buffer.from([0]), signature]).toString("base64");
}

// Refuse missing or mis-scoped keys before any action in a batch can send.
export async function validateActionKeys(opts, keys, actions) {
  const permissions = new Map();
  for (const action of actions) {
    const encoded = keyFor(keys, action.contract);
    const raw = b58decode(encoded.replace(/^ed25519:/, ""));
    if (raw.length !== 64) throw new Error("Expected an ed25519 secret key for " + action.contract);
    const publicKey = "ed25519:" + b58encode(raw.subarray(32));
    if (!permissions.has(publicKey)) permissions.set(publicKey, await rpc(opts.rpc, "query", {
      request_type: "view_access_key", finality: "optimistic", account_id: opts.account, public_key: publicKey,
    }));
    const permission = permissions.get(publicKey).permission;
    if (permission === "FullAccess") continue;
    const limited = permission?.FunctionCall;
    if (!limited || limited.receiver_id !== opts[action.contract]) throw new Error("Receiver permission does not allow " + action.contract);
    if (limited.method_names.length && !limited.method_names.includes(action.method)) throw new Error("Access key does not allow " + action.method);
    if (limited.allowance !== null && BigInt(limited.allowance) === 0n) throw new Error("Access key allowance is exhausted for " + action.contract);
  }
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
  if (holders < jurySize) return [`only ${holders} drawable seat holders for a jury of ${jurySize}: every draw will fail and every dispute will end Void`];
  if (holders < jurySize + 2) return [`${holders} drawable seat holders for a jury of ${jurySize}: a dispute whose proposer and challenger both hold seats cannot be drawn, so ${jurySize + 2} are needed to be safe`];
  if (holders < needed) return [`${holders} drawable seat holders for a jury of ${jurySize}: a first jury that does not decide cannot escalate, because the second jury of ${second} leaves out the first ${jurySize}, the proposer and the challenger, so ${needed} are needed (${jurySize} + ${second} + 2). Until then such a dispute is not decided by a second jury`];
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
// keep a total, so `owed` is exact. The Council's `owed` is a floor (see councilFloor). A payout leaves the verifier before
// the contract's callback books it, so up to `inFlight` of what is owed is already gone: the verifier must hold at least
// owed less inFlight. Less than that means money is missing. More than owed is surplus nobody is credited for, such as a
// plain deposit, and is only reported.
export function reconciliation({ name, owed, held, inFlight = 0n, exact = true }) {
  const floor = BigInt(owed) - BigInt(inFlight);
  const surplus = BigInt(held) - BigInt(owed);
  const owes = exact ? "owes" : "owes at least";
  const flying = BigInt(inFlight) > 0n ? `, ${inFlight} of it in flight` : "";
  const extra = surplus > 0n ? `, ${surplus} more than it ${exact ? "owes" : "needs"} (surplus nobody is credited for)` : "";
  return {
    line: `${name} ${owes} ${owed}${flying} and holds ${held} in the verifier${extra}`,
    problem: BigInt(held) < floor
      ? `the ${name} ${owes} ${owed}${flying} but the verifier holds only ${held} for it: ${floor - BigInt(held)} is missing`
      : null,
  };
}

// Reads the books, and while the verifier holds less than is owed less what is in flight reads them again a few blocks
// later, so that a shortfall is reported only when it is still there. `read` returns { owed, held, inFlight } from one block.
export async function reconcile(read, waitForBlocks) {
  const short = (books) => BigInt(books.held) < BigInt(books.owed) - BigInt(books.inFlight ?? 0n);
  let books = await read();
  for (let attempt = 0; attempt < SHORTFALL_RECHECKS && short(books); attempt++) {
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

export function tokenProblems({ token, market, marketRegistered, verifier, verifierRegistered }) {
  const problems = [];
  if (!marketRegistered) problems.push(`market ${market} is not registered with the token ${token}: the token refuses every deposit and buy by ft_transfer_call, so register it with storage_deposit on the token`);
  if (!verifierRegistered) problems.push(`the verifier ${verifier} is not registered with the token ${token}: the market cannot move a token deposit into Intents, so every one goes back to its sender`);
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

// The accounts a draw can pick from: those with a seat that is neither serving on a case nor asking to leave.
export function drawableHolders(stakes) {
  return new Set(stakes.filter((stake) => stake.unlock_requested_at == null && stake.serving == null).map((stake) => stake.owner));
}

// What the market and the oracle have sent out and not yet booked. The Council has none: its claims in flight are already
// taken off its floor.
async function inFlightAmount(opts, name, at) {
  if (name === "market") return BigInt((await view(opts.rpc, opts.market, "in_flight", {}, at)).withdrawals);
  if (name === "oracle") return BigInt((await view(opts.rpc, opts.oracle, "bond_totals", {}, at)).pending_payouts);
  return 0n;
}

// The floor at one block, and the owners of the drawable seats.
async function councilBooks(opts, at) {
  const stakes = [];
  for (let from = 0; ; from += PAGE) {
    const tokens = await view(opts.rpc, opts.council, "staked_tokens", { from_index: from, limit: PAGE }, at);
    for (const token_id of tokens) stakes.push(await view(opts.rpc, opts.council, "stake_of", { token_id }, at));
    if (tokens.length < PAGE) break;
  }
  return { owed: councilFloor(await view(opts.rpc, opts.council, "reward_totals", {}, at)), owners: drawableHolders(stakes) };
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

// The release hash list from a file, or from stdin when the flag is "-".
function readReleaseList(source) {
  return fs.readFileSync(source === "-" ? 0 : source, "utf8");
}

// The live code hashes of the three contracts against a parsed release list: the lines to print, and whether any differ.
export async function releaseReport(opts, expected) {
  const live = await liveCodeHashes(opts.rpc, { market: opts.market, oracle: opts.oracle, council: opts.council });
  const problems = compareCodeHashes({ expected, live });
  return { lines: describeRelease(problems), differs: problems.length > 0 };
}

async function check(opts) {
  const minMargin = nearToYocto(opts["min-margin"] ?? DEFAULT_MIN_MARGIN_NEAR);
  if (opts["watch-dao"] && !opts.treasury) throw new Error("--watch-dao needs --treasury, the DAO whose proposals to list");
  const expectedRelease = opts.release === undefined ? null : parseReleaseHashes(readReleaseList(opts.release));
  const block = await rpc(opts.rpc, "block", { finality: "final" });
  const at = block.header.height;
  const configs = {};
  for (const name of CONTRACTS) configs[name] = await view(opts.rpc, opts[name], "config", {}, at);
  const oracle = configs.oracle;
  const problems = [];
  for (const name of ["oracle", "council"]) {
    if (!configs[name].markets.includes(opts.market)) problems.push(`${opts.market} is not in the ${name}'s market allow-list (${configs[name].markets.join(", ") || "empty"}): it will refuse this market`);
  }

  const books = {};
  let owners;
  for (const name of CONTRACTS) {
    const read = async () => {
      const height = await finalHeight(opts.rpc);
      const council = name === "council" ? await councilBooks(opts, height) : null;
      owners ??= council?.owners;
      const owed = council ? council.owed : BigInt(await view(opts.rpc, opts[name], "total_owed", {}, height));
      const inFlight = await inFlightAmount(opts, name, height);
      const held = BigInt(await view(opts.rpc, configs[name].verifier, "mt_balance_of", { account_id: opts[name], token_id: configs[name].collateral_token_id }, height));
      return { owed, held, inFlight };
    };
    books[name] = reconciliation({ name, ...(await reconcile(read, () => waitForBlocks(opts.rpc, RECHECK_BLOCKS))), exact: name !== "council" });
  }

  problems.push(...juryProblems({ jurySize: oracle.jury_size, holders: owners.size }));
  if (oracle.publishers.length < oracle.price_threshold) problems.push(`${oracle.publishers.length} price publishers but ${oracle.price_threshold} must sign: no price market can open`);
  console.log(`jury size ${oracle.jury_size} then ${secondJurySize(oracle.jury_size)}, ${owners.size} drawable seat holders, ${oracle.publishers.length} publishers (${oracle.price_threshold} must sign)`);
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

  const token = configs.market.collateral_token_id.slice(NEP141_PREFIX.length);
  const registered = async (id) => (await view(opts.rpc, token, "storage_balance_of", { account_id: id }, at)) !== null;
  const tokenTrouble = tokenProblems({
    token, market: opts.market, marketRegistered: await registered(opts.market), verifier: configs.market.verifier, verifierRegistered: await registered(configs.market.verifier),
  });
  if (!tokenTrouble.length) console.log(`token ${token}: the market and the verifier are registered, so deposits and buys by ft_transfer_call can arrive`);
  problems.push(...tokenTrouble);

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
  if (opts["runway-config"]) {
    const budget = JSON.parse(fs.readFileSync(opts["runway-config"], "utf8"));
    for (const name of ["oracle", "council"]) {
      const account = accounts.find((entry) => entry.name === name);
      if (!budget[name]) throw new Error("runway-config needs oracle and council budgets");
      const report = storageRunway({ ...budget[name], marketsPerDay: budget.marketsPerDay, alarmDays: budget.alarmDays, amount: account.amount, storageUsage: account.storage_usage });
      console.log(name + " storage runway: " + (report.days ?? "unbounded at zero budgeted growth") + " days, " + report.bytesPerDay + " budgeted bytes/day after reserve");
      if (report.alarm) problems.push(name + " storage runway is below " + budget.alarmDays + " days; prepare a Treasury native top-up");
    }
  } else console.log("Storage runway not configured; --runway-config is required before operating a live deployment");

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

  let releaseDiffers = false;
  if (expectedRelease) {
    const release = await releaseReport(opts, expectedRelease);
    for (const line of release.lines) console.log(line);
    releaseDiffers = release.differs;
  }

  for (const p of problems) console.log(`PROBLEM: ${p}`);
  if (!problems.length && !releaseDiffers) console.log("ok");
  return problems.length || releaseDiffers ? 1 : 0;
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
  return `${action.contract}.${action.method}(${action.args.market_id ?? action.args.quarter ?? action.args.sweep_id ?? ""})`;
}

// A finalize the contract refused only because a jury drawn in the quarter is still open is not a fault: the next run asks again.
export function describeOutcome(action, outcome) {
  return action.method === "finalize_quarter" && outcome.includes(JURY_OPEN_REFUSAL) ? "waiting, a jury drawn in this quarter is still open" : outcome;
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
  const work=()=>queuedRun(opts,keys);
  await (opts["dry-run"] ? work() : withQueueLock(opts["state-file"],work));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
