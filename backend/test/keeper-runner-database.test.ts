import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { ingest } from '../src/ingestion/engine.js';
import { FixtureSource } from '../src/ingestion/source.js';
import { keeperSettings, prepareKeeper, withKeeperLock } from '../src/keeper-runner.js';

test('keeper resumes its database-backed feed and queue after restart, excluding concurrent runners', async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  const schema = `keeper_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 3 });
  const config = readConfig({ DATABASE_URL: url, DEPLOYMENT_ID: schema, DEPLOYMENT_START_BLOCK: '100',
    ROUNDS_CONTRACT_ID: 'rounds.fixture.near', MARKET_CONTRACT_ID: 'market.fixture.near',
    ORACLE_CONTRACT_ID: 'oracle.fixture.near', COUNCIL_CONTRACT_ID: 'council.fixture.near',
    VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  const { options } = keeperSettings({}, { ...config, network: 'mainnet' });
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).method, 'block', 'preparation never submits a transaction');
    reads++;
    return Response.json({ result: { header: { height: 103, hash: '4'.repeat(32),
      timestamp_nanosec: String(BigInt(Date.now()) * 1000000n) } } });
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await registerDeployment(pool, config);
    await ingest(pool, config, new FixtureSource('test/fixtures/blocks.jsonl'));
    const first = await prepareKeeper(pool, config, options, 'prepare');
    assert.deepEqual(first, { mode: 'prepare', exported: 3, current: false, height: '103', signing: false });
    const feed = await readFile(options['events-file'], 'utf8');
    const queue = await readFile(options['state-file'], 'utf8');
    const second = await prepareKeeper(pool, config, options, 'check');
    assert.equal(second.exported, 0);
    assert.equal(second.current, false);
    assert.equal(await readFile(options['events-file'], 'utf8'), feed);
    assert.equal(await readFile(options['state-file'], 'utf8'), queue);
    assert.equal(reads, 2);
    await withKeeperLock(pool, schema, async () => {
      await assert.rejects(prepareKeeper(pool, config, options, 'prepare'), /Another keeper runner/);
    });
    await assert.rejects(withKeeperLock(pool, schema, async () => { throw new Error('simulated failure'); }), /simulated failure/);
    assert.equal((await prepareKeeper(pool, config, options, 'prepare')).height, '103');
    const stale = await prepareKeeper(pool, config, options, 'check', async opts => ({
      actions: [], state: { cursor: { height: '103', hash: '4'.repeat(32) } }, current: opts['prepare-feed'] === true,
    }));
    assert.equal(stale.current, false, 'a feed that becomes stale during the check must not report ready');
  } finally {
    globalThis.fetch = originalFetch;
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(options['events-file'], { force: true });
    await rm(options['state-file'], { force: true });
  }
});
