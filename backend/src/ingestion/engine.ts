import type pg from 'pg';
import type { Config } from '../config.js';
import type { BlockSource } from './source.js';
import { prepareBlock, IngestionError } from './block.js';
import { LiveNeardataSource } from './live-source.js';
import { assertDeployment, commitBlock } from './store.js';

export async function ingest(pool: pg.Pool, config: Config, source: BlockSource) {
  if (!config.deployment) throw new IngestionError('deployment_required');
  if (source.mode === 'live' && !(source instanceof LiveNeardataSource)) throw new IngestionError('live_source_not_configured');
  if (source.network !== config.network || (source.mode !== 'live' && config.network !== 'sandbox')) throw new IngestionError(source.mode === 'fixture' ? 'fixture_requires_sandbox' : 'local_capture_requires_sandbox');
  const d = config.deployment;
  const client = await pool.connect();
  let locked = false;
  let started = false;
  let destroy = false;
  // A worker holds this connection while awaiting source input; handle disconnects then too.
  const onConnectionError = () => { destroy = true; };
  client.on('error', onConnectionError);
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(704346942, hashtext($1)) AS acquired', [d.id]);
    if (!lock.rows[0].acquired) throw new IngestionError('indexer_already_running');
    locked = true;
    await client.query('BEGIN');
    await assertDeployment(client, config);
    const prior = await client.query('SELECT source_mode FROM indexer_status WHERE deployment_id=$1', [d.id]);
    if (prior.rows[0] && prior.rows[0].source_mode !== source.mode) throw new IngestionError('source_mode_changed');
    await client.query(`INSERT INTO indexer_status (deployment_id, source_id, source_mode, state) VALUES ($1,$2,$3,'running')
      ON CONFLICT (deployment_id) DO UPDATE SET source_id=EXCLUDED.source_id, state='running', last_error_code=NULL, last_error_at=NULL, updated_at=now()`, [d.id, source.id, source.mode]);
    await client.query('COMMIT');
    started = true;
    let committed = 0, replayed = 0;
    for await (const input of source.blocks()) {
      if (destroy) throw new IngestionError('database_connection_lost');
      const result = await commitBlock(client, config, prepareBlock(input, config));
      if (result === 'committed') committed++; else replayed++;
    }
    await client.query("UPDATE indexer_status SET state='replay_complete', updated_at=now() WHERE deployment_id=$1", [d.id]);
    return { committed, replayed, mode: source.mode, live: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (started) await client.query("UPDATE indexer_status SET state='error', last_error_code=$2, last_error_at=now(), updated_at=now() WHERE deployment_id=$1", [d.id, error instanceof IngestionError ? error.code : 'database_or_worker_error']).catch(() => {});
    throw error instanceof IngestionError ? error : new IngestionError('database_or_worker_error');
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(704346942, hashtext($1))', [d.id]); }
      catch { destroy = true; }
    }
    client.removeListener('error', onConnectionError);
    client.release(destroy);
  }
}
