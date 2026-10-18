#!/usr/bin/env node
// Keeper for the Council contracts. Several steps only happen when someone calls them, and each has a deadline after
// which the case goes Void: drawing a jury, finalizing, writing a final answer to the market, releasing a jury's
// seats, and voiding a market nobody answered. Every one of those calls is open to anyone, so this script watches
// the chain and sends each one when it is due.
//
//   node keeper.mjs run   --rpc URL --market ID --oracle ID --council ID --account ID --key ed25519:... [--dry-run]
//   node keeper.mjs check --rpc URL --oracle ID --council ID
//
// `run` needs an account with a little NEAR for gas and its secret key. The calls it makes move no money of the
// keeper's own. `check` reads only, and reports whether the council can seat a jury at all.
// No dependencies: Node 22 built-ins only.
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const TGAS = 10n ** 12n;
const PAGE = 50;

// ---- what is due -------------------------------------------------------------------------------------------------

// snapshot: { now, height, markets: [{ id, outcome, resolve_by }], cases: { [id]: case | null }, locked: { [id]: bool } }
// Times are BigInt nanoseconds, height is BigInt. Returns the calls to send now, in the order to send them.
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
        const drawable = c.panel.length === 0 && snapshot.height >= BigInt(c.draw_after_height) && snapshot.now < BigInt(c.commit_ends_at);
        if (drawable) call("oracle", "resolve_draw", id, 300);
        if (snapshot.now > BigInt(c.panel_deadline)) call("oracle", "finalize", id, 100);
      }
      if (c.stage === "final" && !c.applied) call("oracle", "retry_apply", id, 100);
      if (c.stage === "final" && c.challenger && snapshot.locked[id]) call("oracle", "retry_unlock", id, 100);
    } else if (market.outcome === null && snapshot.now >= BigInt(market.resolve_by)) {
      call("market", "void_if_unresolved", id, 100);
    }
  }
  return actions;
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

async function snapshot(opts) {
  const block = await rpc(opts.rpc, "block", { finality: "final" });
  const markets = [];
  for (let from = 0; ; from += PAGE) {
    const page = await view(opts.rpc, opts.market, "list_markets", { from_index: String(from), limit: String(PAGE) });
    markets.push(...page.map((m) => ({ id: m.id, outcome: m.outcome ?? null, resolve_by: m.resolve_by })));
    if (page.length < PAGE) break;
  }
  const cases = {};
  const locked = {};
  for (const m of markets) {
    cases[m.id] = await view(opts.rpc, opts.oracle, "get_case", { market_id: m.id });
    const settledDispute = cases[m.id] && cases[m.id].stage === "final" && cases[m.id].challenger;
    locked[m.id] = settledDispute ? (await view(opts.rpc, opts.council, "jury_of", { case_key: m.id })).length > 0 : false;
  }
  return { now: BigInt(block.header.timestamp_nanosec), height: BigInt(block.header.height), markets, cases, locked };
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

async function send(opts, action) {
  const secret = b58decode(opts.key.replace(/^ed25519:/, ""));
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

// Returns a list of problems; empty means fine. A jury is drawn from distinct accounts and leaves out whoever proposed
// and whoever challenged, so with fewer holders than the jury size every draw fails and every dispute ends Void. With
// exactly the jury size, a proposer or challenger who holds a seat leaves too few.
export function juryProblems({ jurySize, holders }) {
  const problems = [];
  if (holders < jurySize) problems.push(`only ${holders} different seat holders for a jury of ${jurySize}: every draw will fail and every dispute will end Void`);
  else if (holders < jurySize + 2) problems.push(`${holders} different seat holders for a jury of ${jurySize}: a dispute whose proposer and challenger both hold seats cannot be drawn, so ${jurySize + 2} are needed to be safe`);
  return problems;
}

async function check(opts) {
  const oracle = await view(opts.rpc, opts.oracle, "config");
  const owners = new Set();
  for (let from = 0; ; from += PAGE) {
    const tokens = await view(opts.rpc, opts.council, "staked_tokens", { from_index: from, limit: PAGE });
    for (const token_id of tokens) owners.add((await view(opts.rpc, opts.council, "stake_of", { token_id })).owner);
    if (tokens.length < PAGE) break;
  }
  const problems = juryProblems({ jurySize: oracle.jury_size, holders: owners.size });
  if (oracle.publishers.length < oracle.price_threshold) problems.push(`${oracle.publishers.length} price publishers but ${oracle.price_threshold} must sign: no price market can open`);
  console.log(`jury size ${oracle.jury_size}, ${owners.size} different seat holders, ${oracle.publishers.length} publishers (${oracle.price_threshold} must sign)`);
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = options(rest);
  if (command === "check") process.exit(await check(opts));
  if (command !== "run") {
    console.error("usage: keeper.mjs run|check --rpc URL --market ID --oracle ID --council ID [--account ID --key KEY] [--dry-run]");
    process.exit(2);
  }
  const actions = dueActions(await snapshot(opts));
  if (!actions.length) console.log("nothing due");
  for (const action of actions) {
    const line = `${action.contract}.${action.method}(${action.args.market_id})`;
    console.log(opts.dryRun ? `due ${line}` : `${line}: ${await send(opts, action)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
