import type pg from 'pg';
import type { Config } from '../config.js';
import { canonical, IngestionError, type PreparedBlock } from './block.js';

export async function registerDeployment(pool: pg.Pool, config: Config) {
  const d = config.deployment;
  if (!d) throw new IngestionError('deployment_required');
  const accounts = Object.values(d.contracts);
  if (new Set(accounts).size !== accounts.length) throw new IngestionError('ambiguous_contract_roles');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO deployments (id, network, start_block, contracts, collateral_token_id, collateral_decimals)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [d.id, config.network, d.startBlock, JSON.stringify(d.contracts), d.collateralTokenId, d.collateralDecimals]);
    await assertDeployment(client, config);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function assertDeployment(client: pg.PoolClient, config: Config) {
  const d = config.deployment;
  if (!d) throw new IngestionError('deployment_required');
  const { rows } = await client.query('SELECT network, start_block::text, contracts, collateral_token_id, collateral_decimals FROM deployments WHERE id=$1', [d.id]);
  const row = rows[0];
  if (!row || row.network !== config.network || row.start_block !== d.startBlock || canonical(row.contracts) !== canonical(d.contracts) || row.collateral_token_id !== d.collateralTokenId || row.collateral_decimals !== d.collateralDecimals) throw new IngestionError('deployment_not_registered_or_changed');
}

export async function commitBlock(client: pg.PoolClient, config: Config, prepared: PreparedBlock): Promise<'committed' | 'replayed'> {
  const d = config.deployment!;
  const { block, events, digest } = prepared;
  const h = block.header;
  await client.query('BEGIN');
  try {
    await assertDeployment(client, config);
    const previous = await client.query('SELECT block_hash, content_hash FROM indexed_blocks WHERE deployment_id=$1 AND block_height=$2', [d.id, h.height]);
    if (previous.rows.length) {
      if (previous.rows[0].block_hash !== h.hash || previous.rows[0].content_hash !== digest) throw new IngestionError('replayed_block_changed');
      await client.query('COMMIT');
      return 'replayed';
    }
    const cursor = await client.query('SELECT block_height::text, block_hash, block_timestamp_ns::text FROM indexer_checkpoints WHERE deployment_id=$1', [d.id]);
    const last = cursor.rows[0];
    if (last) {
      if (BigInt(h.height) <= BigInt(last.block_height)) throw new IngestionError('unknown_old_block');
      if (h.prev_hash !== last.block_hash) throw new IngestionError('block_gap');
      if (BigInt(h.timestamp_nanosec) <= BigInt(last.block_timestamp_ns)) throw new IngestionError('non_monotonic_timestamp');
    } else if (h.height !== d.startBlock) throw new IngestionError('start_block_mismatch');
    await client.query(`INSERT INTO indexed_blocks (deployment_id, block_height, block_hash, prev_hash, block_timestamp_ns, content_hash, event_count, keeper_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [d.id, h.height, h.hash, h.prev_hash, h.timestamp_nanosec, digest, events.length, JSON.stringify({ finalized: true, header: h, receipts: block.receipts })]);
    for (const receipt of block.receipts) {
      await client.query(`INSERT INTO indexed_receipts (deployment_id, receipt_id, block_height, receiver_id, outcome, transaction_hash, child_receipt_ids)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [d.id, receipt.receipt_id, h.height, receipt.receiver_id, JSON.stringify(receipt.status), receipt.transaction_hash ?? null, receipt.child_receipt_ids ? JSON.stringify(receipt.child_receipt_ids) : null]);
    }
    for (const event of events) {
      await client.query(`INSERT INTO raw_events (network, receipt_id, log_index, data_index, deployment_id, receiver_id, block_height, block_hash, block_timestamp_ns, standard, version, event, raw_log, payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [config.network, event.receiptId, event.logIndex, event.dataIndex, d.id, event.receiverId, h.height, h.hash, h.timestamp_nanosec, event.standard, event.version, event.event, event.rawLog, JSON.stringify(event.payload)]);
    }
    await client.query(`INSERT INTO indexer_checkpoints (deployment_id, block_height, block_hash, block_timestamp_ns) VALUES ($1,$2,$3,$4)
      ON CONFLICT (deployment_id) DO UPDATE SET block_height=EXCLUDED.block_height, block_hash=EXCLUDED.block_hash, block_timestamp_ns=EXCLUDED.block_timestamp_ns, updated_at=now()`, [d.id, h.height, h.hash, h.timestamp_nanosec]);
    await client.query(`UPDATE indexer_status SET blocks_committed=blocks_committed+1, events_committed=events_committed+$2, updated_at=now() WHERE deployment_id=$1`, [d.id, events.length]);
    await client.query('COMMIT');
    return 'committed';
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function ingestionStatus(pool: Pick<pg.Pool, 'query'>, config: Config) {
  if (!config.deployment) return { state: 'unconfigured', live: false, lagBlocks: null };
  const { rows } = await pool.query(`SELECT s.source_id, s.source_mode, s.state, s.blocks_committed::text, s.events_committed::text,
    s.last_error_code, s.last_error_at, s.updated_at, h.height::text AS head_height, h.hash AS head_hash, h.timestamp_ns::text AS head_timestamp_ns, h.observed_at, h.heartbeat_at, c.block_height::text, c.block_hash, c.block_timestamp_ns::text, c.updated_at AS checkpoint_updated_at
    FROM deployments d LEFT JOIN indexer_status s ON s.deployment_id=d.id LEFT JOIN indexer_checkpoints c ON c.deployment_id=d.id LEFT JOIN source_heads h ON h.deployment_id=d.id WHERE d.id=$1`, [config.deployment.id]);
  if (!rows.length) return { state: 'unregistered', live: false, lagBlocks: null };
  const row = rows[0];
  return {
    deploymentId: config.deployment.id, state: row.state ?? 'not_started',
    live: row.source_mode === 'live' && row.heartbeat_at != null && Date.now()-new Date(row.heartbeat_at).getTime() < 30000 && Date.now()-new Date(row.observed_at).getTime() < 30000 && row.state !== 'error',
    source: row.source_id ? { id: row.source_id, mode: row.source_mode } : null,
    blocksCommitted: row.blocks_committed ?? '0', eventsCommitted: row.events_committed ?? '0',
    checkpoint: row.block_height ? { height: row.block_height, hash: row.block_hash, timestampNs: row.block_timestamp_ns, committedAt: row.checkpoint_updated_at } : null,
    lastError: row.last_error_code ? { code: row.last_error_code, at: row.last_error_at } : null,
    reportedAt: row.updated_at ?? null,
    sourceHead: row.head_height ? { height: row.head_height, hash: row.head_hash, timestampNs: row.head_timestamp_ns, observedAt: row.observed_at } : null,
    lagBlocks: row.head_height && row.block_height ? (BigInt(row.head_height) > BigInt(row.block_height) ? BigInt(row.head_height)-BigInt(row.block_height) : 0n).toString() : null,
    lagMeaning: 'height_difference_not_produced_block_count',
  };
}
