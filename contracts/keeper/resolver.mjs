#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { b58decode, b58encode, rpc, view } from "./chain.mjs";
import { options, readKeyFile, signedFunctionCall } from "./keeper.mjs";
import { priceMessage, SETTLE_NS, signerOf } from "./publisher.mjs";

const TGAS = 10n ** 12n;
const BOND_GAS = 100n * TGAS;
const PAGE = 50;
const QUOTE_TIMEOUT_MS = 30_000;
const ANSWERS = ["yes", "no", "void"];
const MAX_EVIDENCE_BYTES = 512;
const USAGE = [
  "usage: resolver.mjs run     --rpc URL --market ID --oracle ID --account ID --publishers URL[,URL...] [--dry-run] [--key-file PATH]",
  "       resolver.mjs propose --rpc URL --market ID --oracle ID --account ID --market-id N --answer yes|no|void --evidence TEXT [--key-file PATH]",
  "       resolver.mjs pending --rpc URL --market ID --oracle ID",
  "The key is RESOLVER_KEY or --key-file (chmod 600): a full access key of --account, whose Intents balance pays each bond.",
].join("\n");

export function bestSigned(quotes, { messageFor, publishers }) {
  const byPrice = new Map();
  for (const quote of quotes) {
    if (typeof quote?.price !== "string" || !/^\d+$/.test(quote.price) || typeof quote.signature !== "string") continue;
    const signer = signerOf(quote.signature, messageFor(quote.price));
    if (!signer || !publishers.includes(signer)) continue;
    const group = byPrice.get(quote.price) ?? new Map();
    group.set(signer, quote.signature);
    byPrice.set(quote.price, group);
  }
  let best = null;
  for (const [price, group] of byPrice) {
    if (!best || group.size > best.entries.length) best = { price, entries: [...group.values()] };
  }
  return best;
}

export function priceMarketsDue(markets, now) {
  return markets.filter((m) => m.registered && m.price_rule && m.outcome === null && now >= BigInt(m.price_rule.observation_time) + SETTLE_NS);
}

export function eventMarketsClosed(markets, now) {
  return markets.filter((m) => m.registered && !m.price_rule && m.outcome === null && now >= BigInt(m.close_at));
}

export function refusalIn(outcome) {
  for (const step of [outcome.transaction_outcome, ...(outcome.receipts_outcome ?? [])]) {
    const failure = step?.outcome?.status?.Failure;
    if (failure) return failure.ActionError?.kind?.FunctionCallError?.ExecutionError ?? JSON.stringify(failure);
  }
  return null;
}

export function proposalProblem({ market, now, hasCase, answer, evidence }) {
  if (!ANSWERS.includes(answer)) return `--answer must be one of ${ANSWERS.join(", ")}`;
  if (!evidence) return "--evidence is required: a link or a short note the challenge window can be judged on";
  if (Buffer.byteLength(evidence) > MAX_EVIDENCE_BYTES) return `--evidence is over ${MAX_EVIDENCE_BYTES} bytes`;
  if (!market) return "no such market";
  if (market.price_rule) return `market ${market.id} is a price market: its answer is a signed price, which run submits`;
  if (market.outcome !== null) return `market ${market.id} is already resolved ${market.outcome}`;
  if (now < BigInt(market.close_at)) return `market ${market.id} has not closed`;
  if (hasCase) return `market ${market.id} already has a case at the oracle`;
  return null;
}

async function allMarkets(rpcUrl, market) {
  const { markets: count } = await view(rpcUrl, market, "config");
  const pages = [];
  for (let from = 0; from < Number(count); from += PAGE) {
    pages.push(view(rpcUrl, market, "list_markets", { from_index: String(from), limit: String(PAGE) }));
  }
  return (await Promise.all(pages)).flat();
}

async function context(opts) {
  for (const flag of ["rpc", "market", "oracle"]) if (!opts[flag]) throw new Error(`--${flag} is required\n${USAGE}`);
  const [config, block] = await Promise.all([view(opts.rpc, opts.oracle, "config"), rpc(opts.rpc, "block", { finality: "final" })]);
  if (!config.markets.includes(opts.market)) throw new Error(`${opts.market} is not in the market allow-list of ${opts.oracle}`);
  return { opts, config, now: BigInt(block.header.timestamp_nanosec) };
}

function signerKey(opts, env) {
  if ("key" in opts) throw new Error("--key is refused: a key on the command line shows in the process list. Use RESOLVER_KEY or --key-file");
  if (!opts.account) throw new Error(`--account is required\n${USAGE}`);
  const secret = opts["key-file"] !== undefined ? readKeyFile(opts["key-file"]) : env.RESOLVER_KEY;
  if (!secret) throw new Error("no key: set RESOLVER_KEY or pass --key-file");
  const raw = b58decode(secret.replace(/^ed25519:/, ""));
  if (raw.length !== 64) throw new Error("the resolver key must be an ed25519 secret key");
  return { seed: raw.subarray(0, 32), publicKey: raw.subarray(32) };
}

async function requireBond({ opts, config }) {
  const held = BigInt(await view(opts.rpc, config.verifier, "mt_balance_of", { account_id: opts.account, token_id: config.collateral_token_id }));
  if (held < BigInt(config.bond)) throw new Error(`${opts.account} holds ${held} in the verifier and a bond is ${config.bond}: fund its Intents account`);
}

async function sendBond({ opts, config }, key, msg) {
  const [block, access] = await Promise.all([
    rpc(opts.rpc, "block", { finality: "optimistic" }),
    rpc(opts.rpc, "query", { request_type: "view_access_key", finality: "optimistic", account_id: opts.account, public_key: `ed25519:${b58encode(key.publicKey)}` }),
  ]);
  if (access.permission !== "FullAccess") throw new Error("the resolver key must be a full access key: a bond is an mt_transfer_call with 1 yoctoNEAR attached");
  const args = { receiver_id: opts.oracle, token_id: config.collateral_token_id, amount: config.bond, msg };
  const signed = signedFunctionCall({
    signer: opts.account, seed: key.seed, publicKey: key.publicKey, nonce: BigInt(access.nonce) + 1n, receiver: config.verifier,
    blockHash: b58decode(block.header.hash), method: "mt_transfer_call", args: Buffer.from(JSON.stringify(args)), gas: BOND_GAS, deposit: 1n,
  });
  return refusalIn(await rpc(opts.rpc, "broadcast_tx_commit", [signed]));
}

async function quoteFrom(url, market, id) {
  try {
    const res = await fetch(`${url}/price?market=${encodeURIComponent(market)}&id=${id}`, { signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) });
    const body = await res.json();
    if (res.ok) return body;
    console.log(`market ${id}: ${url} did not sign (${res.status}): ${body.error}`);
  } catch (e) {
    console.log(`market ${id}: ${url} did not answer: ${e.message}`);
  }
  return null;
}

async function answerPrice(ctx, key, publishers, id) {
  const { opts, config } = ctx;
  const { price_rule: rule } = await view(opts.rpc, opts.oracle, "get_market_info", { market: opts.market, market_id: id });
  const quotes = await Promise.all(publishers.map((url) => quoteFrom(url, opts.market, id)));
  const messageFor = (price) => priceMessage({
    oracle: opts.oracle, network: config.network, market: opts.market, marketId: id, observationTime: rule.observation_time, price, decimals: rule.decimals,
  });
  const best = bestSigned(quotes, { messageFor, publishers: config.publishers });
  const signed = best?.entries.length ?? 0;
  if (signed < config.price_threshold) {
    console.log(`market ${id}: at most ${signed} valid signatures agree on one price, and ${config.price_threshold} must`);
    return false;
  }
  if (!key) {
    console.log(`market ${id}: would submit price ${best.price} signed by ${signed} publishers`);
    return true;
  }
  await requireBond(ctx);
  const refused = await sendBond(ctx, key, `price:${opts.market}:${id}:${best.price}:${best.entries.join(",")}`);
  console.log(refused
    ? `market ${id}: the oracle refused price ${best.price} and the bond came back: ${refused}`
    : `market ${id}: submitted price ${best.price} signed by ${signed} publishers`);
  return !refused;
}

async function run(opts, env) {
  const ctx = await context(opts);
  const key = opts["dry-run"] ? null : signerKey(opts, env);
  const publishers = (opts.publishers ?? "").split(",").filter(Boolean);
  if (!publishers.length) throw new Error(`run needs --publishers\n${USAGE}`);
  const due = priceMarketsDue(await allMarkets(opts.rpc, opts.market), ctx.now);
  let unanswered = 0;
  for (const m of due) {
    if (await view(opts.rpc, opts.oracle, "get_case", { market: opts.market, market_id: m.id })) continue;
    if (!(await answerPrice(ctx, key, publishers, m.id))) unanswered++;
  }
  if (!due.length) console.log("no price market is waiting for its price");
  return unanswered ? 1 : 0;
}

async function propose(opts, env) {
  const ctx = await context(opts);
  const key = signerKey(opts, env);
  const id = opts["market-id"] ?? "";
  if (!/^\d{1,20}$/.test(id)) throw new Error(`--market-id must be a market id\n${USAGE}`);
  const [market, existing] = await Promise.all([
    view(opts.rpc, opts.market, "get_market", { market_id: id }),
    view(opts.rpc, opts.oracle, "get_case", { market: opts.market, market_id: id }),
  ]);
  const problem = proposalProblem({ market, now: ctx.now, hasCase: existing !== null, answer: opts.answer, evidence: opts.evidence });
  if (problem) throw new Error(problem);
  await requireBond(ctx);
  const refused = await sendBond(ctx, key, `propose:${opts.market}:${id}:${opts.answer}:${opts.evidence}`);
  if (refused) throw new Error(`the oracle refused the proposal and the bond came back: ${refused}`);
  console.log(`market ${id}: proposed ${opts.answer} with a bond of ${ctx.config.bond}`);
  return 0;
}

async function pending(opts) {
  const ctx = await context(opts);
  const markets = await allMarkets(opts.rpc, opts.market);
  const waiting = [...eventMarketsClosed(markets, ctx.now), ...priceMarketsDue(markets, ctx.now)];
  const cases = await Promise.all(waiting.map((m) => view(opts.rpc, opts.oracle, "get_case", { market: opts.market, market_id: m.id })));
  const open = waiting.filter((_, i) => cases[i] === null);
  for (const m of open) {
    const kind = m.price_rule ? "price market" : "event market";
    console.log(`${kind} ${m.id}, resolve by ${m.resolve_by}: ${m.title} (source: ${m.resolution_source})`);
  }
  if (!open.length) console.log("no closed market is waiting for an answer");
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = options(rest);
  const commands = { run, propose, pending };
  if (!commands[command]) {
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(await commands[command](opts, process.env));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
