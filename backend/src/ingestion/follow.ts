import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { readConfig, type Config } from '../config.js';
import { createPool, verifyDatabase } from '../database.js';
import { IngestionError, type Header } from './block.js';
import { NeardataReader, normalizeNeardata } from './neardata.js';
import { LiveNeardataSource } from './live-source.js';
import { ingest } from './engine.js';
import { ReadRpcClient } from '../providers.js';
import { LOCK } from '../locks.js';

// Outages that end by themselves. A database restart or a slow source must not end the follower; everything else needs a person.
const RETRYABLE_CODES = ['neardata_unavailable', 'neardata_rate_limited', 'neardata_request_budget', 'source_or_database_unavailable', 'database_or_worker_error', 'database_connection_lost'];

export async function followCycle(pool: pg.Pool, config: Config, reader: NeardataReader, signal?: AbortSignal) {
  if (config.network !== 'mainnet' || !config.deployment) throw new IngestionError('mainnet_deployment_required');
  await verifyDatabase(pool, config);
  reader.resetBudget();
  const head = normalizeNeardata(await reader.document('/v0/last_block/final'));
  const d = config.deployment;
  const { rows } = await pool.query('SELECT block_height::text,block_hash,block_timestamp_ns::text FROM indexer_checkpoints WHERE deployment_id=$1', [d.id]);
  const row = rows[0];
  const checkpoint: Header | null = row ? { height: row.block_height, hash: row.block_hash, prev_hash: '', timestamp_nanosec: row.block_timestamp_ns } : null;
  if (checkpoint && BigInt(checkpoint.height) > BigInt(head.header.height)) throw new IngestionError('source_head_behind_checkpoint');
  if (checkpoint?.height === head.header.height && checkpoint.hash !== head.header.hash) throw new IngestionError('source_head_conflict');
  if (!checkpoint && BigInt(d.startBlock) > BigInt(head.header.height)) throw new IngestionError('deployment_start_in_future');
  await pool.query(`INSERT INTO source_heads(deployment_id,height,hash,timestamp_ns) VALUES($1,$2,$3,$4)
    ON CONFLICT(deployment_id) DO UPDATE SET height=EXCLUDED.height,hash=EXCLUDED.hash,timestamp_ns=EXCLUDED.timestamp_ns,observed_at=now(),heartbeat_at=now()`, [d.id,head.header.height,head.header.hash,head.header.timestamp_nanosec]);
  return ingest(pool, config, new LiveNeardataSource(reader, head, d.startBlock, checkpoint, signal));
}
export async function follow(pool: pg.Pool, config: Config, signal: AbortSignal) {
  if (config.network !== 'mainnet' || !config.deployment) throw new IngestionError('mainnet_deployment_required');
  const lock = await pool.connect();
  let acquired = false, lost=false;
  const disconnected=()=>{lost=true;};lock.on('error',disconnected);
  try {
    acquired = (await lock.query(`SELECT pg_try_advisory_lock(${LOCK.follow},hashtext($1)) AS ok`,[config.deployment.id])).rows[0].ok;
    if (!acquired) throw new IngestionError('follower_already_running');
    const rpc = new ReadRpcClient(config.rpc.primaryUrl, config.rpc, config.rpc.primaryBearerToken);
    const status = await rpc.call('status', {}) as { chain_id?: string };
    if (status.chain_id !== 'mainnet') throw new IngestionError('network_mismatch');
    const reader = new NeardataReader(fetch,sleep,400);
    let failures = 0;
    while (!signal.aborted) {
      try {
        // Ensure the lock's connection has not silently disappeared before starting another batch.
        if(lost)throw new IngestionError('follower_lock_lost');
        await lock.query('SELECT 1');
        const result = await followCycle(pool, config, reader, signal);
        failures = 0; console.log(JSON.stringify({ service:'indexer', ...result }));
      } catch (error) {
        if (signal.aborted) break;
        failures++;
        const code = error instanceof IngestionError ? error.code : 'source_or_database_unavailable';
        console.error(JSON.stringify({ service:'indexer',error:code,attempt:failures }));
        await pool.query("UPDATE indexer_status SET state='error',last_error_code=$2,last_error_at=now(),updated_at=now() WHERE deployment_id=$1",[config.deployment.id,code]).catch(()=>{});
        // Schema/configuration/ancestry conflicts need intervention, not repeated retries.
        if (!RETRYABLE_CODES.includes(code)) throw error;
      }
      await sleep(Math.min(60000, failures ? 1000*2**Math.min(failures,6) : 200), undefined, { signal }).catch(() => {});
    }
  } finally {
    if (acquired) await lock.query(`SELECT pg_advisory_unlock(${LOCK.follow},hashtext($1))`,[config.deployment.id]).catch(() => {});
    lock.removeListener('error',disconnected);lock.release(lost);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stop = new AbortController();
  process.on('SIGINT',()=>stop.abort()); process.on('SIGTERM',()=>stop.abort());
  let pool: pg.Pool | undefined;
  try { const config = readConfig(process.env); pool=createPool(config.databaseUrl); await follow(pool,config,stop.signal); }
  catch (e) { console.error(e instanceof IngestionError ? e.code : 'follower_failed'); process.exitCode=1; }
  finally { await pool?.end(); }
}
