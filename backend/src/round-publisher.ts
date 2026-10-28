import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { readConfig, type Config } from './config.js';
import { createPool, verifyDatabase } from './database.js';
import { ReadRpcClient } from './providers.js';
import { finalizedHead, viewAt, type View } from './chain-view.js';
import { base58Encode, base58Decode } from './base58.js';
import { object } from './ingestion/block.js';
import { candidate, recordEvidence, usdBoundary, type Asset, type Exchange, type Observation } from './prices.js';
import { isUint } from './validate.js';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// The exchanges publish a candle only once its minute has closed. Waiting this long after the boundary lets all three settle.
const SETTLE_DELAY_NS = 20n * 10n ** 9n;
// A signature that reaches the chain after the price window closes records nothing, so stop signing a little before it ends.
const WINDOW_MARGIN_NS = 30n * 10n ** 9n;
const BOUNDARY_NS = 300n * 10n ** 9n;
// Rounds older than their price window cannot be recorded, so how far back to look follows the window, with a bound for a very long one.
const MAX_LOOKBACK_ROUNDS = 1000n;
const POLL_INTERVAL_MS = 10_000;
const EXCHANGES: readonly Exchange[] = ['coinbase', 'kraken', 'bitstamp'];
const SERIES_ASSET = /^(btc|eth|near)-usd$/;

export interface Series {
  asset: string;
  decimals: number;
  first_start: string;
  interval: string;
  price_window: string;
  close_before: string;
}
export interface PricePolicy {
  minimumSources: number;
  maxDeviationBps: number;
}

/** The exact string a publisher signs, as the rounds contract builds it in `price_message`. */
export function roundPriceMessage(contract: string, network: string, asset: string, at: string, price: string, decimals: number) {
  return `round-price:v1:${contract}:${network}:${asset}:${at}:${price}:${decimals}`;
}

export interface PublisherKey {
  publicKey: string;
  sign(message: string): string;
}

/** Reads a NEAR secret key (`ed25519:<base58 of seed and public key>`) and checks its halves belong together. */
export function loadPublisherKey(secret: string): PublisherKey {
  const raw = base58Decode(secret.trim().replace(/^ed25519:/, ''));
  if (raw.length !== 64) throw new Error('the publisher key must be an ed25519 secret key');
  const key: KeyObject = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const derived = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (!Buffer.from(derived).equals(raw.subarray(32))) throw new Error("the publisher key's public half does not match its seed");
  return { publicKey: `ed25519:${base58Encode(derived)}`, sign: message => sign(null, Buffer.from(message), key).toString('hex') };
}

/** Refuses a key file anyone but its owner can read: a leaked publisher key signs prices the chain accepts. */
export async function readKeyFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('the publisher key file must be a regular file readable only by its owner (chmod 600)');
  return readFile(path, 'utf8');
}

/** Rounds whose start price can be signed now: the moment has settled and the price window has not nearly closed. */
export function signableRounds(series: Series, nowNs: bigint): bigint[] {
  const first = BigInt(series.first_start),
    interval = BigInt(series.interval),
    window = BigInt(series.price_window);
  if (interval <= 0n || nowNs < first) return [];
  const latest = (nowNs - first) / interval;
  const rounds: bigint[] = [];
  for (let r = latest; r >= 0n && latest - r < MAX_LOOKBACK_ROUNDS; r--) {
    const at = first + r * interval;
    if (nowNs > at + window - WINDOW_MARGIN_NS) break;
    if (nowNs >= at + SETTLE_DELAY_NS) rounds.push(r);
  }
  return rounds.reverse();
}

export const boundaryKey = (seriesId: number | string, round: bigint | string) => `round:${seriesId}:${round}`;

/**
 * Records the intent to sign before signing. A second, different price for the same round is refused once a signature exists,
 * so a restart or a flapping exchange can never produce two signed prices for one moment. An unsigned reservation (a crash
 * between the two steps) can still be replaced.
 */
export async function reserveDecision(pool: Pick<pg.Pool, 'query'>, deploymentId: string, publisher: string, boundary: string, payload: string) {
  const hash = createHash('sha256').update(payload).digest('hex');
  const inserted = await pool.query(
    `INSERT INTO signing_decisions(deployment_id,publisher_key,boundary_key,payload,payload_hash) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(deployment_id,publisher_key,boundary_key) DO UPDATE SET payload=EXCLUDED.payload,payload_hash=EXCLUDED.payload_hash WHERE signing_decisions.signature IS NULL
     RETURNING signature`,
    [deploymentId, publisher, boundary, payload, hash],
  );
  if (inserted.rowCount) return { signature: null as string | null, conflict: false };
  const { rows } = await pool.query('SELECT payload,signature FROM signing_decisions WHERE deployment_id=$1 AND publisher_key=$2 AND boundary_key=$3', [
    deploymentId,
    publisher,
    boundary,
  ]);
  const stored = rows[0];
  if (!stored || stored.payload !== payload) return { signature: null as string | null, conflict: true };
  return { signature: stored.signature as string | null, conflict: false };
}

async function observe(asset: Asset, boundaryNs: string, pool: pg.Pool, transport: typeof fetch): Promise<Observation[]> {
  const settled = await Promise.allSettled(EXCHANGES.map(source => usdBoundary(source, asset, boundaryNs, transport)));
  const observations = settled.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
  for (const o of observations) await recordEvidence(pool, o);
  return observations;
}

export interface PublishContext {
  config: Config;
  pool: pg.Pool;
  view: View;
  key: PublisherKey;
  policy: PricePolicy;
  nowNs: bigint;
  transport?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
}

/** One pass: signs the price of every round that needs one and has none yet. Returns what it signed. */
export async function publishOnce(ctx: PublishContext) {
  const { config, pool, view, key, policy, nowNs } = ctx;
  const log = ctx.log ?? (() => {});
  const rounds = config.deployment?.contracts.rounds;
  if (!config.deployment || !rounds) throw new Error('rounds_contract_not_configured');
  const settings = await view(rounds, 'config', {});
  if (!object(settings) || !Array.isArray(settings.publishers) || typeof settings.network !== 'string' || !Number.isInteger(settings.series))
    throw new Error('invalid_rounds_config');
  if (!settings.publishers.includes(key.publicKey)) throw new Error(`${key.publicKey} is not a publisher on ${rounds}`);
  const signed: { seriesId: number; round: string; price: string }[] = [];
  for (let seriesId = 0; seriesId < (settings.series as number); seriesId++) {
    const series = (await view(rounds, 'get_series', { series_id: seriesId })) as Series | null;
    const named = series && SERIES_ASSET.exec(series.asset);
    if (!series || !named) {
      log({ seriesId, skipped: 'series_asset_not_priced' });
      continue;
    }
    if (BigInt(series.first_start) % BOUNDARY_NS !== 0n || BigInt(series.interval) % BOUNDARY_NS !== 0n) {
      log({ seriesId, skipped: 'series_not_aligned_to_five_minutes' });
      continue;
    }
    const asset = named[1]!.toUpperCase() as Asset;
    for (const round of signableRounds(series, nowNs)) {
      const boundary = boundaryKey(seriesId, round);
      const at = (BigInt(series.first_start) + round * BigInt(series.interval)).toString();
      try {
        if (await view(rounds, 'get_price', { series_id: seriesId, round: round.toString() })) continue;
        // A round already signed is served from the database; asking the exchanges again would only add load and evidence rows.
        const done = await pool.query(
          'SELECT 1 FROM signing_decisions WHERE deployment_id=$1 AND publisher_key=$2 AND boundary_key=$3 AND signature IS NOT NULL',
          [config.deployment.id, key.publicKey, boundary],
        );
        if (done.rowCount) continue;
        const price = candidate(await observe(asset, at, pool, ctx.transport ?? fetch), {
          asset,
          quote: 'USD',
          boundaryNs: at,
          decimals: series.decimals,
          ...policy,
        });
        const message = roundPriceMessage(rounds, settings.network as string, series.asset, at, price, series.decimals);
        const decision = await reserveDecision(pool, config.deployment.id, key.publicKey, boundary, message);
        if (decision.conflict) {
          log({ seriesId, round: round.toString(), refused: 'conflicting_boundary_signature' });
          continue;
        }
        if (decision.signature) continue;
        const stored = await pool.query(
          'UPDATE signing_decisions SET signature=$4 WHERE deployment_id=$1 AND publisher_key=$2 AND boundary_key=$3 AND payload_hash=$5 AND signature IS NULL',
          [config.deployment.id, key.publicKey, boundary, key.sign(message), createHash('sha256').update(message).digest('hex')],
        );
        // Another process replaced the reservation first. Its price stands and this signature is dropped unused.
        if (!stored.rowCount) {
          log({ seriesId, round: round.toString(), refused: 'reservation_replaced' });
          continue;
        }
        signed.push({ seriesId, round: round.toString(), price });
        log({ seriesId, round: round.toString(), price, signed: true });
      } catch (error) {
        log({ seriesId, round: round.toString(), unsigned: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
      }
    }
  }
  return signed;
}

/** What `GET /v1/price-signatures` serves: every signature this backend holds for one round, each with the message it signed. */
export async function storedSignatures(pool: Pick<pg.Pool, 'query'>, deploymentId: string, seriesId: string, round: string) {
  if (!isUint(seriesId) || !isUint(round)) throw new Error('invalid_query');
  const { rows } = await pool.query(
    'SELECT publisher_key,payload,signature FROM signing_decisions WHERE deployment_id=$1 AND boundary_key=$2 AND signature IS NOT NULL ORDER BY publisher_key',
    [deploymentId, boundaryKey(seriesId, round)],
  );
  if (!rows.length) return null;
  const quotes = rows.map(row => {
    const fields = (row.payload as string).split(':');
    return { message: row.payload as string, price: fields[fields.length - 2]!, entry: `${row.publisher_key}.${row.signature}` };
  });
  return { seriesId, round, quotes };
}

function policyFrom(env: NodeJS.ProcessEnv): PricePolicy {
  // Signing waits for an explicit decision about the price source rules, so there is no default spread to fall back on.
  if (env.PUBLISH_ROUND_PRICES !== 'approved') throw new Error('PUBLISH_ROUND_PRICES must be "approved": the price source policy is a decision for the owner');
  const maxDeviationBps = Number(env.PRICE_MAX_DEVIATION_BPS);
  if (!Number.isInteger(maxDeviationBps)) throw new Error('set PRICE_MAX_DEVIATION_BPS');
  // A quorum forms only if publishers sign the same price, so every exchange has to answer: a different set of answering
  // exchanges would give a different median.
  return { minimumSources: EXCHANGES.length, maxDeviationBps };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stop = new AbortController();
  process.on('SIGINT', () => stop.abort());
  process.on('SIGTERM', () => stop.abort());
  let pool: pg.Pool | undefined;
  try {
    const config = readConfig(process.env);
    const policy = policyFrom(process.env);
    if (!process.env.PUBLISHER_KEY_FILE) throw new Error('set PUBLISHER_KEY_FILE');
    const key = loadPublisherKey(await readKeyFile(process.env.PUBLISHER_KEY_FILE));
    pool = createPool(config.databaseUrl);
    await verifyDatabase(pool, config);
    const rpc = new ReadRpcClient(config.rpc.primaryUrl, config.rpc, config.rpc.primaryBearerToken);
    const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ service: 'publisher', ...entry }));
    do {
      try {
        const head = await finalizedHead(config, rpc);
        await publishOnce({ config, pool, view: viewAt(rpc, head.hash), key, policy, nowNs: BigInt(Date.now()) * 1_000_000n, log });
      } catch (error) {
        log({ error: error instanceof Error ? error.message.slice(0, 160) : 'unknown' });
        process.exitCode = 1;
      }
      if (!process.argv.includes('--once')) await sleep(POLL_INTERVAL_MS, undefined, { signal: stop.signal }).catch(() => {});
    } while (!process.argv.includes('--once') && !stop.signal.aborted);
  } catch (error) {
    console.error(JSON.stringify({ service: 'publisher', error: error instanceof Error ? error.message.slice(0, 160) : 'unknown' }));
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
