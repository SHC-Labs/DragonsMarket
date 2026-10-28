import type pg from 'pg';
import { IngestionError } from './block.js';
import { account, type ScopedCaptureBlock } from './neardata.js';

/** Verification-only tables in an explicitly created temporary schema. Never app deployment data. */
export async function initializeCapture(client: pg.PoolClient, schema: string, receiver: string, startHeight: string) {
  if (!/^capture_[a-f0-9]{32}$/.test(schema) || !account(receiver) || !/^[0-9]{1,20}$/.test(startHeight)) throw new IngestionError('invalid_capture_scope');
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`CREATE TABLE capture_scope (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), network text NOT NULL CHECK(network='mainnet'),
    purpose text NOT NULL CHECK(purpose='source_verification'), receiver_id text NOT NULL, start_height numeric(20,0) NOT NULL
  );
  CREATE TABLE captured_blocks (
    block_height numeric(20,0) PRIMARY KEY, block_hash text NOT NULL UNIQUE, prev_hash text NOT NULL,
    timestamp_ns numeric(20,0) NOT NULL, digest text NOT NULL, shard_ids jsonb NOT NULL
  );
  CREATE TABLE captured_receipts (
    receipt_id text PRIMARY KEY, block_height numeric(20,0) NOT NULL REFERENCES captured_blocks,
    receiver_id text NOT NULL, transaction_hash text NOT NULL, child_receipt_ids jsonb NOT NULL,
    outcome jsonb NOT NULL, logs jsonb NOT NULL
  );
  CREATE INDEX captured_receipts_transaction ON captured_receipts(transaction_hash);
  CREATE TABLE captured_events (
    receipt_id text NOT NULL REFERENCES captured_receipts, log_index integer NOT NULL,
    raw_log text NOT NULL, envelope jsonb NOT NULL, malformed boolean NOT NULL,
    PRIMARY KEY(receipt_id,log_index)
  );
  CREATE TABLE capture_checkpoint (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), block_height numeric(20,0) NOT NULL REFERENCES captured_blocks,
    block_hash text NOT NULL, timestamp_ns numeric(20,0) NOT NULL
  );`);
  await client.query(`INSERT INTO capture_scope (network,purpose,receiver_id,start_height) VALUES ('mainnet','source_verification',$1,$2)`, [receiver, startHeight]);
}
export async function commitCapture(client: pg.PoolClient, block: ScopedCaptureBlock): Promise<'committed' | 'replayed'> {
  await client.query('BEGIN');
  try {
    const { rows: scope } = await client.query('SELECT receiver_id,start_height::text FROM capture_scope WHERE singleton FOR UPDATE');
    if (!scope[0] || block.receipts.some(r => r.receiverId !== scope[0].receiver_id)) throw new IngestionError('capture_scope_mismatch');
    const h = block.header;
    const { rows: existing } = await client.query('SELECT digest FROM captured_blocks WHERE block_height=$1', [h.height]);
    if (existing.length) {
      if (existing[0].digest !== block.digest) throw new IngestionError('capture_replay_changed');
      await client.query('COMMIT'); return 'replayed';
    }
    const { rows: cursor } = await client.query('SELECT block_height::text,block_hash,timestamp_ns::text FROM capture_checkpoint');
    if (!cursor.length && h.height !== scope[0].start_height) throw new IngestionError('capture_start_mismatch');
    if (cursor[0] && (h.prev_hash !== cursor[0].block_hash || BigInt(h.height) <= BigInt(cursor[0].block_height) || BigInt(h.timestamp_nanosec) <= BigInt(cursor[0].timestamp_ns))) throw new IngestionError('capture_gap');
    await client.query('INSERT INTO captured_blocks VALUES ($1,$2,$3,$4,$5,$6)', [h.height,h.hash,h.prev_hash,h.timestamp_nanosec,block.digest,JSON.stringify(block.shardIds)]);
    for (const r of block.receipts) await client.query('INSERT INTO captured_receipts VALUES ($1,$2,$3,$4,$5,$6,$7)', [r.receiptId,h.height,r.receiverId,r.transactionHash,JSON.stringify(r.childReceiptIds),JSON.stringify(r.status),JSON.stringify(r.logs)]);
    for (const e of block.events) await client.query('INSERT INTO captured_events VALUES ($1,$2,$3,$4,$5)', [e.receiptId,e.logIndex,e.rawLog,JSON.stringify(e.envelope),e.malformed]);
    await client.query(`INSERT INTO capture_checkpoint VALUES (true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET block_height=EXCLUDED.block_height,block_hash=EXCLUDED.block_hash,timestamp_ns=EXCLUDED.timestamp_ns`, [h.height,h.hash,h.timestamp_nanosec]);
    await client.query('COMMIT'); return 'committed';
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
