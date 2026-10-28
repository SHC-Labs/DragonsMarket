import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NeardataReader, scopeCapture } from '../src/ingestion/neardata.js';
import { initializeCapture, commitCapture } from '../src/ingestion/capture-store.js';
import { ReadRpcClient } from '../src/providers.js';
import { object } from '../src/ingestion/block.js';
import { isAccount as account } from '../src/validate.js';

// Explicit command only. Uses public mainnet reads and local temporary database tables, never keys.
test('actual finalized mainnet blocks -> contract-scoped evidence -> Postgres -> reconnect and duplicate-free replay', { timeout: 180000 }, async t => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL to local development PostgreSQL');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname));
  const count = process.env.CAPTURE_BLOCKS === undefined ? 5 : Number(process.env.CAPTURE_BLOCKS);
  const frames = await new NeardataReader().capture(count);
  const end = frames.at(-1)!.header;
  // Cross-check chain identity and the sampled finalized head against a separate RPC interface.
  // Both endpoints are FASTNEAR infrastructure; this is not independent consensus verification.
  const rpc = new ReadRpcClient('https://free.rpc.fastnear.com', { timeoutMs: 15000, intervalMs: 1000 });
  const status = await rpc.call('status', {});
  assert.ok(object(status) && status.chain_id === 'mainnet');
  const rpcBlock = await rpc.call('block', { block_id: end.hash });
  assert.ok(object(rpcBlock) && object(rpcBlock.header));
  assert.equal(rpcBlock.header.hash, end.hash);
  assert.equal(rpcBlock.header.timestamp_nanosec, end.timestamp_nanosec);

  const receivers = new Map<string, number>();
  for (const frame of frames) for (const receipt of frame.receipts) {
    if (!('Failure' in receipt.status)) receivers.set(receipt.receiverId, (receivers.get(receipt.receiverId) ?? 0) + receipt.logs.filter(l => l.startsWith('EVENT_JSON:')).length);
  }
  const selected = process.env.CAPTURE_RECEIVER ?? [...receivers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  assert.ok(account(selected), 'No active account found in bounded sample; rerun or choose CAPTURE_RECEIVER');
  const blocks = frames.map(frame => scopeCapture(frame, selected));
  const expected = blocks.flatMap(b => b.receipts);
  const events = blocks.flatMap(b => b.events);
  assert.ok(expected.length, 'Selected account had no executions in sampled blocks');
  if (!process.env.CAPTURE_RECEIVER) assert.ok(events.length, 'Quiet sample: rerun rather than claiming an event path was exercised');
  const schema = `capture_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const connect = async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    await client.query(`SET search_path TO ${schema}`);
    return { pool, client };
  };
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    connection = await connect();
    await initializeCapture(connection.client, schema, selected, blocks[0]!.header.height);
    const half = Math.max(1, Math.floor(blocks.length / 2));
    for (const block of blocks.slice(0, half)) assert.equal(await commitCapture(connection.client, block), 'committed');
    connection.client.release(); await connection.pool.end(); connection = undefined;
    connection = await connect();
    let committed = 0, replayed = 0;
    for (const block of blocks) { const result = await commitCapture(connection.client, block); if (result === 'committed') committed++; else replayed++; }
    assert.equal(committed, blocks.length - half); assert.equal(replayed, half);
    for (const block of blocks) assert.equal(await commitCapture(connection.client, block), 'replayed');
    const receipts = (await connection.client.query('SELECT * FROM captured_receipts')).rows;
    assert.equal(receipts.length, expected.length);
    for (const r of expected) {
      const stored = receipts.find(row => row.receipt_id === r.receiptId);
      assert.ok(stored);
      assert.equal(stored.receiver_id, selected);
      assert.equal(stored.transaction_hash, r.transactionHash);
      assert.deepEqual(stored.child_receipt_ids, r.childReceiptIds);
      assert.deepEqual(stored.outcome, r.status);
      assert.deepEqual(stored.logs, r.logs);
    }
    const storedEvents = (await connection.client.query('SELECT * FROM captured_events')).rows;
    assert.equal(storedEvents.length, events.length);
    for (const e of events) {
      const stored = storedEvents.find(row => row.receipt_id === e.receiptId && row.log_index === e.logIndex);
      assert.ok(stored); assert.equal(stored.raw_log, e.rawLog); assert.deepEqual(stored.envelope, e.envelope); assert.equal(stored.malformed, e.malformed);
    }
    const storedBlocks = (await connection.client.query('SELECT block_height::text,block_hash,timestamp_ns::text FROM captured_blocks ORDER BY block_height')).rows;
    assert.deepEqual(storedBlocks.map(r => [r.block_height, r.block_hash, r.timestamp_ns]), blocks.map(b => [b.header.height, b.header.hash, b.header.timestamp_nanosec]));
    const checkpoint = (await connection.client.query('SELECT block_height::text,block_hash FROM capture_checkpoint')).rows[0];
    assert.deepEqual(checkpoint, { block_height: end.height, block_hash: end.hash });
    const failures = expected.filter(r => 'Failure' in r.status);
    assert.equal(storedEvents.some(e => failures.some(r => r.receiptId === e.receipt_id)), false);
    t.diagnostic(JSON.stringify({ network: 'mainnet', purpose: 'source_verification', startBlock: blocks[0]!.header.height, endBlock: end.height, blocks: blocks.length, selectedReceiver: selected, receipts: receipts.length, events: events.length, malformedEvents: events.filter(e => e.malformed).length, failures: failures.length, transactionHashes: new Set(expected.map(r => r.transactionHash)).size, sampledNetworkReceipts: frames.reduce((n, f) => n + f.receipts.length, 0), rpcAnchorMatched: true, reconnectReplay: 'passed', duplicateReplay: 'zero new rows', continuouslyFollowing: false }));
  } finally {
    connection?.client.release();
    await connection?.pool.end();
    try {
      if (created) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name=$1', [schema])).rows[0].n, 0);
        t.diagnostic('Temporary mainnet capture schema removed; app deployments and checkpoint unchanged.');
      }
    } finally { await admin.end(); }
  }
});
