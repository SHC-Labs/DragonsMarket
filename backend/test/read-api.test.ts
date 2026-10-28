import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { migrate, migrationFiles } from '../src/migrate.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createReadApi } from '../src/read-api.js';
import { verifyDatabase } from '../src/database.js';
import { registerDeployment, ingestionStatus } from '../src/ingestion/store.js';
import { ingest } from '../src/ingestion/engine.js';
import { FixtureSource, type BlockSource } from '../src/ingestion/source.js';

async function setup(work: (pool: pg.Pool, root: string, read: ReturnType<typeof createReadApi>) => Promise<void>) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL; temporary schemas are removed after each test');
  const schema = `reads_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const config = readConfig({ DATABASE_URL: databaseUrl, DEPLOYMENT_ID: 'reads', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  const read = createReadApi(pool, config);
  const app = createApp(config, () => verifyDatabase(pool, config), () => ingestionStatus(pool, config), read);
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await registerDeployment(pool, config);
    await ingest(pool, config, new FixtureSource('test/fixtures/blocks.jsonl'));
    // Same network and entirely separate deployment must not appear through this API.
    await registerDeployment(pool, { ...config, deployment: { ...config.deployment!, id: 'other', startBlock: '0' } });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const address = app.address();
    assert.ok(address && typeof address !== 'string');
    await work(pool, `http://127.0.0.1:${address.port}`, read);
  } finally {
    app.closeAllConnections();
    if (app.listening) await new Promise<void>((resolve, reject) => app.close(e => e ? reject(e) : resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
async function get(root: string, path: string) {
  const response = await fetch(root + path);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('HTTP evidence reads: deployment scope, all event pages, filters and failed receipt outcomes', async () => setup(async (_pool, root) => {
  const deployments = await get(root, '/v1/deployments');
  assert.deepEqual(deployments.data.map((d: any) => d.id), ['reads']);
  assert.equal(deployments.indexing.source.mode, 'fixture');
  assert.equal(deployments.indexing.live, false);
  assert.equal(deployments.asOf.height, '103');
  assert.equal(deployments.asOf.timestampNs, '1700000103000000000');
  assert.equal(deployments.indexing.lagBlocks, null);
  let next = '/v1/events?limit=1';
  const events: any[] = [];
  do {
    const page = await get(root, next);
    events.push(...page.data);
    next = page.nextCursor ? `/v1/events?limit=1&cursor=${page.nextCursor}` : '';
  } while (next);
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map(e => `${e.receipt_id}:${e.log_index}:${e.data_index}`)).size, 4);
  assert.equal(events[0].payload.amount, '9007199254740993');
  assert.equal((await get(root, '/v1/events?event=missing')).data.length, 0);
  assert.equal((await get(root, '/v1/events?receiver=other.near')).data.length, 0);
  assert.equal((await get(root, '/v1/events?standard=rounds&event=staked&fromBlock=103&toBlock=103')).data.length, 1);
  assert.deepEqual((await get(root, '/v1/blocks')).data.map((b: any) => b.block_height), ['100', '101', '103']);
  assert.equal((await get(root, '/v1/blocks')).data[1].event_count, 0);
  const receipts: string[] = [];
  let receiptNext = '/v1/receipts?limit=1';
  while (receiptNext) {
    const page = await get(root, receiptNext);
    receipts.push(...page.data.map((r: any) => r.receipt_id));
    receiptNext = page.nextCursor ? `/v1/receipts?limit=1&cursor=${page.nextCursor}` : '';
  }
  assert.deepEqual(receipts, ['A'.repeat(32), 'B'.repeat(32), 'D'.repeat(32)]);
  const failure = await get(root, `/v1/receipts/${'B'.repeat(32)}`);
  assert.deepEqual(failure.data.outcome, { Failure: { ActionError: {} } });
  assert.equal((await get(root, `/v1/events?receiptId=${'B'.repeat(32)}`)).data.length, 0);
  assert.equal((await fetch(`${root}/v1/receipts/${'C'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(root + '/v1/events', { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(root + '/v1/events', { method: 'POST' })).status, 405);
  assert.equal((await fetch(root + '/v1/transactions/unknown')).status, 404);
}));

test('cursor walks keep a fixed checkpoint as new blocks arrive; cursors cannot change filters or routes', async () => setup(async (pool, root) => {
  const first = await get(root, '/v1/blocks?limit=1');
  assert.ok(first.nextCursor);
  const url = new URL(root);
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, DEPLOYMENT_ID: 'reads', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  const appended: BlockSource = { id: 'fixture-jsonl-v1', mode: 'fixture', network: 'sandbox', async *blocks() {
    yield { network: 'sandbox', finalized: true, header: { height: '1000', hash: '5'.repeat(32), prev_hash: '4'.repeat(32), timestamp_nanosec: '1700000104000000000' }, receipts: [] };
  } };
  await ingest(pool, config, appended);
  let cursor = first.nextCursor;
  const heights = [first.data[0].block_height];
  while (cursor) {
    const page = await get(root, `/v1/blocks?limit=1&cursor=${cursor}`);
    assert.equal(page.asOf.height, '103');
    assert.equal(page.indexing.latestCheckpoint.height, '1000');
    heights.push(...page.data.map((r: any) => r.block_height));
    cursor = page.nextCursor;
  }
  assert.deepEqual(heights, ['100', '101', '103']);
  assert.equal((await get(root, '/v1/blocks')).data.at(-1).block_height, '1000');
  for (const path of [`/v1/events?cursor=${first.nextCursor}`, `/v1/blocks?fromBlock=101&cursor=${first.nextCursor}`]) {
    assert.equal((await fetch(root + path)).status, 400);
  }
  const forged = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  forged.anchor.hash = '9'.repeat(32);
  url.pathname = '/v1/blocks';
  url.searchParams.set('cursor', Buffer.from(JSON.stringify(forged)).toString('base64url'));
  assert.equal((await fetch(url)).status, 400);
}));

test('invalid input is rejected, SQL failures are sanitized and unconfigured deployments are explicit', async () => setup(async (pool, root) => {
  for (const path of ['/v1/events?limit=101', '/v1/events?limit=1.1', '/v1/events?limit=0', '/v1/events?limit=01', '/v1/events?limit=1&limit=2', '/v1/events?cursor=bad', '/v1/events?deployment=other', '/v1/events?receiver=INVALID!', '/v1/events?standard=other', '/v1/blocks?fromBlock=18446744073709551616', '/v1/blocks?fromBlock=103&toBlock=100', '/v1/receipts/not-a-receipt', '/v1/deployments?limit=1', '/v1/events?event=%27%3BDROP%20TABLE%20deployments']) {
    assert.equal((await fetch(root + path)).status, 400, path);
  }
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! });
  const unconfigured = createReadApi(pool, config);
  assert.deepEqual((await unconfigured(new URL('http://localhost/v1/deployments')) as any).data, []);
  await assert.rejects(unconfigured(new URL('http://localhost/v1/events')), /deployment_not_configured/);
  await pool.query('ALTER TABLE raw_events RENAME TO private_secret_table');
  const response = await fetch(root + '/v1/events');
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.ok(body.includes('read_api_unavailable'));
  assert.ok(!body.includes('raw_events') && !body.includes('secret') && !body.includes('postgres'));
}));

test('receipt migration backfills existing journals without changing block checkpoints', async () => setup(async (pool, _root) => {
  // Recreate exactly the pre-004 shape, leaving journal/checkpoint evidence intact.
  const before = (await pool.query('SELECT * FROM indexer_checkpoints')).rows;
  await pool.query('DROP TRIGGER deployments_immutable ON deployments');
  await pool.query('DROP FUNCTION refuse_deployment_change()');
  await pool.query('DROP TABLE indexed_receipts');
  await pool.query('DROP TABLE source_heads,feed_exports,backend_jobs,user_operations,price_evidence,signing_decisions,reconciliation_reports,wallet_challenges,wallet_sessions,wallet_watchlist,policy_acknowledgements');
  await pool.query('DROP INDEX raw_events_read_page');
  await pool.query("DELETE FROM schema_migrations WHERE version >= '004_receipt_reads.sql'");
  assert.equal(await migrate(pool), 4);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM indexed_receipts')).rows[0].n, 3);
  assert.deepEqual((await pool.query('SELECT * FROM indexer_checkpoints')).rows, before);
  assert.equal((await migrationFiles()).length, 7);
}));
