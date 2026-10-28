import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { migrate } from '../src/migrate.js';
import { readConfig, type Config } from '../src/config.js';
import { IngestionError } from '../src/ingestion/block.js';
import { FixtureSource, type BlockSource } from '../src/ingestion/source.js';
import { registerDeployment, ingestionStatus } from '../src/ingestion/store.js';
import { ingest } from '../src/ingestion/engine.js';

async function withDatabase(work: (pool: pg.Pool, config: Config, reconnect: () => Promise<void>) => Promise<void>) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Set TEST_DATABASE_URL; each test uses its own temporary schema');
  const schema = `ingest_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 5 });
  const config = readConfig({ DATABASE_URL: url, DEPLOYMENT_ID: 'fixture-replay', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    // A fresh connection pool verifies persisted state without holding old connections.
    const reconnect = async () => {
      const other = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
      try { assert.equal((await other.query('SELECT block_height::text FROM indexer_checkpoints')).rows[0].block_height, '100'); }
      finally { await other.end(); }
    };
    await work(pool, config, reconnect);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
const fixture = () => new FixtureSource('test/fixtures/blocks.jsonl');
async function blocks(): Promise<any[]> { const data = []; for await (const block of fixture().blocks()) data.push(block); return data; }
function source(data: unknown[]): BlockSource { return { id: 'test-fixture', mode: 'fixture', network: 'sandbox', async *blocks() { yield* data; } }; }
async function cursor(pool: pg.Pool) { return (await pool.query('SELECT block_height::text FROM indexer_checkpoints')).rows[0]?.block_height; }

test('deployment registration is immutable and replays are idempotent, including empty blocks', async () => withDatabase(async (pool, config) => {
  await registerDeployment(pool, config);
  await registerDeployment(pool, config);
  await assert.rejects(registerDeployment(pool, { ...config, deployment: { ...config.deployment!, startBlock: '101' } }), /deployment_not_registered_or_changed/);
  assert.deepEqual(await ingest(pool, config, fixture()), { committed: 3, replayed: 0, mode: 'fixture', live: false });
  assert.deepEqual(await ingest(pool, config, fixture()), { committed: 0, replayed: 3, mode: 'fixture', live: false });
  assert.equal(await cursor(pool), '103');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM raw_events')).rows[0].n, 4);
  assert.equal((await pool.query('SELECT event_count FROM indexed_blocks WHERE block_height=101')).rows[0].event_count, 0);
  const status = await ingestionStatus(pool, config) as any;
  assert.equal(status.state, 'replay_complete');
  assert.equal(status.live, false);
  assert.equal(status.blocksCommitted, '3');
  assert.equal(status.eventsCommitted, '4');
  assert.equal(status.lagBlocks, null);
}));

test('missing ancestry, changed historical content and unsupported versions retain the last checkpoint', async () => withDatabase(async (pool, config) => {
  await registerDeployment(pool, config);
  const [a, b, c] = await blocks();
  await assert.rejects(ingest(pool, config, source([b])), /start_block_mismatch/);
  await ingest(pool, config, source([a]));
  await assert.rejects(ingest(pool, config, source([c])), /block_gap/);
  const changed = structuredClone(a);
  changed.receipts[0].logs.push('changed');
  await assert.rejects(ingest(pool, config, source([changed])), /replayed_block_changed/);
  changed.header.hash = '9'.repeat(32);
  await assert.rejects(ingest(pool, config, source([changed])), /replayed_block_changed/);
  const unsupported = structuredClone(b);
  unsupported.receipts = [{ ...a.receipts[0], receipt_id: 'E'.repeat(32), logs: ['EVENT_JSON:{"standard":"rounds","version":"2.0.0","event":"new"}'] }];
  await assert.rejects(ingest(pool, config, source([unsupported])), /unsupported_event_version/);
  assert.equal(await cursor(pool), '100');
  assert.equal((await ingestionStatus(pool, config) as any).lastError.code, 'unsupported_event_version');
  await ingest(pool, config, fixture());
  assert.equal(await cursor(pool), '103');
  assert.equal((await ingestionStatus(pool, config) as any).lastError, null);
}));

test('SQL failure after a partial block insert rolls back events, block journal, counters and checkpoint', async () => withDatabase(async (pool, config) => {
  await registerDeployment(pool, config);
  const [a, b] = await blocks();
  await ingest(pool, config, source([a]));
  const broken = structuredClone(b);
  // First receipt inserts successfully; the second conflicts with a receipt in the previous block.
  broken.receipts = [{ ...a.receipts[0], receipt_id: 'E'.repeat(32) }, a.receipts[0]];
  await assert.rejects(ingest(pool, config, source([broken])), /database_or_worker_error/);
  assert.equal(await cursor(pool), '100');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM raw_events')).rows[0].n, 3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM indexed_blocks')).rows[0].n, 1);
  assert.equal((await ingestionStatus(pool, config) as any).blocksCommitted, '1');
  await ingest(pool, config, fixture());
  assert.equal(await cursor(pool), '103');
}));

test('a source failure after commit resumes from durable history and accepts replay after reconnect', async () => withDatabase(async (pool, config, reconnect) => {
  await registerDeployment(pool, config);
  const [a] = await blocks();
  const interrupted: BlockSource = { ...source([]), async *blocks() { yield a; throw new IngestionError('source_read_failed'); } };
  await assert.rejects(ingest(pool, config, interrupted), /source_read_failed/);
  await reconnect();
  assert.equal(await cursor(pool), '100');
  assert.deepEqual(await ingest(pool, config, fixture()), { committed: 2, replayed: 1, mode: 'fixture', live: false });
  assert.equal((await ingestionStatus(pool, config) as any).eventsCommitted, '4');
}));

test('one writer owns a deployment and a rejected competitor cannot overwrite its status', async () => withDatabase(async (pool, config) => {
  await registerDeployment(pool, config);
  const [a] = await blocks();
  let release!: () => void;
  let announce!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const paused: BlockSource = { ...source([]), async *blocks() { yield a; announce(); await gate; } };
  const running = ingest(pool, config, paused);
  try {
    await entered;
    await assert.rejects(ingest(pool, config, fixture()), /indexer_already_running/);
    assert.equal((await ingestionStatus(pool, config) as any).state, 'running');
  } finally { release(); await running; }
  assert.equal((await ingestionStatus(pool, config) as any).state, 'replay_complete');
}));

test('fixtures cannot enter public networks, and no live source is silently accepted', async () => withDatabase(async (pool, config) => {
  await registerDeployment(pool, config);
  await assert.rejects(ingest(pool, { ...config, network: 'testnet' }, fixture()), /fixture_requires_sandbox/);
  await assert.rejects(ingest(pool, config, { ...source([]), mode: 'live' }), /live_source_not_configured/);
  assert.equal((await ingestionStatus(pool, config) as any).state, 'not_started');
  assert.equal(await cursor(pool), undefined);
}));


test('registration and replay CLI survive separate processes without duplicating persisted history', async () => withDatabase(async (pool, config) => {
  const schema = (await pool.query('SELECT current_schema() AS name')).rows[0].name;
  const connection = new URL(config.databaseUrl);
  connection.searchParams.set('options', `-c search_path=${schema}`);
  const env = { ...process.env, DATABASE_URL: connection.href, NETWORK: 'sandbox', DEPLOYMENT_ID: 'fixture-replay', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near', COLLATERAL_DECIMALS: '6', MARKET_CONTRACT_ID: '', ORACLE_CONTRACT_ID: '', COUNCIL_CONTRACT_ID: '' };
  const execute = promisify(execFile);
  const run = async (...args: string[]) => JSON.parse((await execute(process.execPath, ['dist/src/ingestion/cli.js', ...args], { env })).stdout);
  assert.equal((await run('register')).registered, true);
  assert.equal((await run('replay', 'test/fixtures/blocks.jsonl')).committed, 3);
  assert.equal((await run('replay', 'test/fixtures/blocks.jsonl')).replayed, 3);
  const status = await run('status');
  assert.equal(status.checkpoint.height, '103');
  assert.equal(status.eventsCommitted, '4');
  assert.equal(status.live, false);
}));


test('database disconnect between blocks releases the writer and resumes from the last commit', async () => withDatabase(async (pool, config) => {
  await registerDeployment(pool, config);
  const [a, b] = await blocks();
  let worker: pg.PoolClient | undefined;
  pool.once('acquire', client => { worker = client; });
  const disconnected: BlockSource = { ...source([]), async *blocks() {
    yield a;
    assert.ok(worker);
    const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const lost = once(worker, 'error');
    // Terminate only this test worker's own session, never another service's connection.
    await pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await lost;
    yield b;
  } };
  await assert.rejects(ingest(pool, config, disconnected), /database_connection_lost/);
  assert.equal(await cursor(pool), '100');
  assert.deepEqual(await ingest(pool, config, fixture()), { committed: 2, replayed: 1, mode: 'fixture', live: false });
}));
