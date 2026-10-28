import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { initializeCapture, commitCapture } from '../src/ingestion/capture-store.js';
import { scopeCapture, type ObservedBlock } from '../src/ingestion/neardata.js';

// Synthetic database failure cases are kept separate from actual mainnet evidence.
test('capture persistence rolls back partial inserts and refuses changed history, scope and gaps', async () => {
  const url = process.env.TEST_DATABASE_URL; assert.ok(url);
  const schema = `capture_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await initializeCapture(client, schema, 'intents.near', '100');
    const a: ObservedBlock = { header: { height: '100', hash: '2'.repeat(32), prev_hash: '1'.repeat(32), timestamp_nanosec: '1700000000000000000' }, previousHeight: '99', shardIds: ['0'], receipts: [{ receiptId: 'A'.repeat(32), receiverId: 'intents.near', transactionHash: 'T'.repeat(32), childReceiptIds: [], status: { SuccessValue: '' }, logs: [] }] };
    const first = scopeCapture(a, 'intents.near');
    assert.equal(await commitCapture(client, first), 'committed');
    const b = structuredClone(a);
    b.header = { height: '102', hash: '3'.repeat(32), prev_hash: a.header.hash, timestamp_nanosec: '1700000000000000001' };
    b.previousHeight = '100';
    b.receipts.unshift({ ...b.receipts[0]!, receiptId: 'B'.repeat(32) });
    // The first receipt inserts, the second conflicts with a receipt in the previous committed block.
    await assert.rejects(commitCapture(client, scopeCapture(b, 'intents.near')), (e: unknown) => (e as { code?: string }).code === '23505');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM captured_receipts')).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM captured_blocks')).rows[0].n, 1);
    assert.equal((await client.query('SELECT block_height::text FROM capture_checkpoint')).rows[0].block_height, '100');
    const changed = structuredClone(a); changed.receipts[0]!.transactionHash = 'U'.repeat(32);
    await assert.rejects(commitCapture(client, scopeCapture(changed, 'intents.near')), /capture_replay_changed/);
    const foreign = structuredClone(first); foreign.receipts[0]!.receiverId = 'another.near';
    await assert.rejects(commitCapture(client, foreign), /capture_scope_mismatch/);
    const gap = structuredClone(b); gap.header.prev_hash = '9'.repeat(32);
    await assert.rejects(commitCapture(client, scopeCapture(gap, 'intents.near')), /capture_gap/);
    b.receipts = [];
    assert.equal(await commitCapture(client, scopeCapture(b, 'intents.near')), 'committed', 'Skipped numeric slots with valid ancestry are accepted');
    assert.equal(await commitCapture(client, first), 'replayed');
  } finally {
    await client.query('ROLLBACK');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release(); await pool.end();
  }
});
