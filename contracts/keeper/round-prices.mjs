#!/usr/bin/env node
// Collects the publishers' signatures for the start price of a round and records it at the rounds contract. Recording is
// open to anyone, so this holds no price authority: it only carries signatures that at least `price_threshold` of the
// contract's own publishers made over the same price.
import { pathToFileURL } from "node:url";
import { b58decode, b58encode, rpc, view } from "./chain.mjs";
import { options, readKeyFile, signedFunctionCall } from "./keeper.mjs";
import { bestSigned } from "./resolver.mjs";

const TGAS = 10n ** 12n;
const RECORD_GAS = 60n * TGAS;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_LOOKBACK_ROUNDS = 1000n;
const USAGE = [
  "usage: round-prices.mjs run     --rpc URL --rounds ID --account ID --publishers URL[,URL...] [--dry-run] [--key-file PATH]",
  "       round-prices.mjs pending --rpc URL --rounds ID",
  "Each publisher URL is a backend that serves GET /v1/price-signatures?seriesId=N&round=R. The key is ROUND_PRICES_KEY or --key-file (chmod 600).",
].join("\n");

export function roundPriceMessage({ rounds, network, asset, at, price, decimals }) {
  return `round-price:v1:${rounds}:${network}:${asset}:${at}:${price}:${decimals}`;
}

// Rounds whose start price can still be recorded: the moment has come and the price window has not closed.
export function openRounds(series, now) {
  const first = BigInt(series.first_start);
  const interval = BigInt(series.interval);
  const window = BigInt(series.price_window);
  if (now < first) return [];
  const latest = (now - first) / interval;
  const rounds = [];
  for (let r = latest; r >= 0n && latest - r < MAX_LOOKBACK_ROUNDS; r--) {
    const at = first + r * interval;
    if (now > at + window) break;
    if (now >= at) rounds.push(r);
  }
  return rounds.reverse();
}

async function signaturesFrom(url, seriesId, round) {
  try {
    const res = await fetch(`${url}/v1/price-signatures?seriesId=${seriesId}&round=${round}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 404) return [];
    const body = await res.json();
    if (!res.ok || !Array.isArray(body.quotes)) throw new Error(`status ${res.status}`);
    return body.quotes
      .filter((q) => typeof q?.price === "string" && typeof q?.entry === "string")
      .map((q) => ({ price: q.price, signature: q.entry }));
  } catch (e) {
    console.log(`series ${seriesId} round ${round}: ${url} did not answer: ${e.message}`);
    return [];
  }
}

// The price enough publishers signed, or null. A signature over any other message, or from a key the contract does not list,
// counts for nothing.
export async function gather({ publishers, seriesId, round, series, config, rounds, urls }) {
  const quotes = (await Promise.all(urls.map((url) => signaturesFrom(url, seriesId, round)))).flat();
  const at = (BigInt(series.first_start) + BigInt(round) * BigInt(series.interval)).toString();
  const messageFor = (price) => roundPriceMessage({ rounds, network: config.network, asset: series.asset, at, price, decimals: series.decimals });
  const best = bestSigned(quotes, { messageFor, publishers });
  return best && best.entries.length >= config.price_threshold ? best : null;
}

function signerKey(opts, env) {
  if ("key" in opts) throw new Error("--key is refused: a key on the command line shows in the process list. Use ROUND_PRICES_KEY or --key-file");
  const secret = opts["key-file"] !== undefined ? readKeyFile(opts["key-file"]) : env.ROUND_PRICES_KEY;
  if (!secret) throw new Error("no key: set ROUND_PRICES_KEY or pass --key-file");
  const raw = b58decode(secret.replace(/^ed25519:/, ""));
  if (raw.length !== 64) throw new Error("the key must be an ed25519 secret key");
  return { seed: raw.subarray(0, 32), publicKey: raw.subarray(32) };
}

async function record(opts, key, { seriesId, round, price, entries }) {
  const [block, access] = await Promise.all([
    rpc(opts.rpc, "block", { finality: "optimistic" }),
    rpc(opts.rpc, "query", { request_type: "view_access_key", finality: "optimistic", account_id: opts.account, public_key: `ed25519:${b58encode(key.publicKey)}` }),
  ]);
  const args = { series_id: seriesId, round: round.toString(), price, signatures: entries.join(",") };
  const signed = signedFunctionCall({
    signer: opts.account, seed: key.seed, publicKey: key.publicKey, nonce: BigInt(access.nonce) + 1n, receiver: opts.rounds,
    blockHash: b58decode(block.header.hash), method: "record_price", args: Buffer.from(JSON.stringify(args)), gas: RECORD_GAS,
  });
  const outcome = await rpc(opts.rpc, "broadcast_tx_commit", [signed]);
  const failure = outcome.status?.Failure ?? outcome.receipts_outcome?.find((r) => r.outcome?.status?.Failure)?.outcome.status.Failure;
  return failure ? JSON.stringify(failure) : null;
}

// The contract records a price only while the round it starts, or the round before it, holds open stakes. A round is stored only
// once someone stakes, so a round with no record is one nobody is waiting on.
async function needsPrice(opts, seriesId, round) {
  const open = async (r) => {
    if (r < 0n) return false;
    const stored = await view(opts.rpc, opts.rounds, "get_round", { series_id: seriesId, round: r.toString() });
    return stored !== null && stored.outcome === null;
  };
  return (await open(round)) || (await open(round - 1n));
}

async function wanting(opts) {
  for (const flag of ["rpc", "rounds"]) if (!opts[flag]) throw new Error(`--${flag} is required\n${USAGE}`);
  const [config, head] = await Promise.all([view(opts.rpc, opts.rounds, "config"), rpc(opts.rpc, "block", { finality: "final" })]);
  const now = BigInt(head.header.timestamp_nanosec);
  const open = [];
  for (let seriesId = 0; seriesId < config.series; seriesId++) {
    const series = await view(opts.rpc, opts.rounds, "get_series", { series_id: seriesId });
    if (!series) continue;
    for (const round of openRounds(series, now)) {
      if ((await view(opts.rpc, opts.rounds, "get_price", { series_id: seriesId, round: round.toString() })) !== null) continue;
      if (await needsPrice(opts, seriesId, round)) open.push({ seriesId, round, series });
    }
  }
  return { config, open };
}

async function run(opts, env) {
  const key = opts["dry-run"] ? null : signerKey(opts, env);
  if (!opts.account) throw new Error(`--account is required\n${USAGE}`);
  const urls = (opts.publishers ?? "").split(",").filter(Boolean);
  if (!urls.length) throw new Error(`run needs --publishers\n${USAGE}`);
  const { config, open } = await wanting(opts);
  let missing = 0;
  for (const { seriesId, round, series } of open) {
    const best = await gather({ publishers: config.publishers, seriesId, round, series, config, rounds: opts.rounds, urls });
    if (!best) { missing++; console.log(`series ${seriesId} round ${round}: fewer than ${config.price_threshold} publishers signed one price`); continue; }
    if (!key) { console.log(`series ${seriesId} round ${round}: would record ${best.price} signed by ${best.entries.length} publishers`); continue; }
    // One failed broadcast must not stop the other rounds; recording again later is safe because the contract refuses a repeat.
    const refused = await record(opts, key, { seriesId, round, price: best.price, entries: best.entries }).catch((e) => e.message);
    console.log(refused ? `series ${seriesId} round ${round}: the contract refused ${best.price}: ${refused}` : `series ${seriesId} round ${round}: recorded ${best.price}`);
    if (refused) missing++;
  }
  if (!open.length) console.log("no round is waiting for a price");
  return missing ? 1 : 0;
}

async function pending(opts) {
  const { open } = await wanting(opts);
  for (const { seriesId, round, series } of open) console.log(`series ${seriesId} (${series.asset}) round ${round} has no recorded price`);
  if (!open.length) console.log("no round is waiting for a price");
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { run, pending };
  if (!commands[command]) {
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(await commands[command](options(rest), process.env));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
