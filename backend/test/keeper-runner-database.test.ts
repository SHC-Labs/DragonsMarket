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
import { keeperSettings, prepareKeeper, requireKeeperReports, withKeeperLock } from '../src/keeper-runner.js';
import { backendStatus } from '../src/monitoring.js';

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
    await assert.rejects(requireKeeperReports(pool, schema), /requires current successful/);
    await pool.query(`INSERT INTO reconciliation_reports(deployment_id,block_hash,report,solvent) VALUES($1,'test','{}',true)`, [schema]);
    await pool.query(`INSERT INTO chain_integrity_reports(deployment_id,report,ok) VALUES($1,'{}',true)`, [schema]);
    await requireKeeperReports(pool, schema);
    await pool.query(`UPDATE reconciliation_reports SET checked_at=now() - interval '16 minutes' WHERE deployment_id=$1`, [schema]);
    await assert.rejects(requireKeeperReports(pool, schema), /requires current successful/);
    await pool.query(`UPDATE reconciliation_reports SET checked_at=now(),solvent=false WHERE deployment_id=$1`, [schema]);
    await assert.rejects(requireKeeperReports(pool, schema), /requires current successful/);
    await pool.query(`UPDATE reconciliation_reports SET solvent=true WHERE deployment_id=$1`, [schema]);
    await pool.query(`UPDATE chain_integrity_reports SET ok=false WHERE deployment_id=$1`, [schema]);
    await assert.rejects(requireKeeperReports(pool, schema), /requires current successful/);
    await pool.query(`UPDATE chain_integrity_reports SET ok=true,checked_at=now()+interval '1 hour' WHERE deployment_id=$1`, [schema]);
    await assert.rejects(requireKeeperReports(pool, schema), /requires current successful/);
    await ingest(pool, config, new FixtureSource('test/fixtures/blocks.jsonl'));
    const first = await prepareKeeper(pool, config, options, 'prepare');
    assert.deepEqual(first, { mode: 'prepare', exported: 3, current: false, height: '103', signing: false });
    assert.equal((await pool.query('SELECT state FROM keeper_status WHERE deployment_id=$1', [schema])).rows[0].state, 'catching_up');
    const monitored = await backendStatus(pool, config);
    assert.equal(monitored.keeper.height, '103');
    assert.ok(monitored.alerts.includes('keeper_feed_stale'));
    assert.ok(monitored.alerts.includes('keeper_signing_disabled'));
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
    await assert.rejects(prepareKeeper(pool, config, options, 'sign'), /must match its mode/);
    let initialized = 0;
    const signing = () => { initialized++; return { keys: {}, execution: { beforeBatch: async () => {}, send: async () => 'ok' } }; };
    await prepareKeeper(pool, config, options, 'sign', undefined, signing);
    assert.equal(initialized, 0, 'stale evidence cannot initialize a signer');
    await withKeeperLock(pool, schema, async () => {
      await assert.rejects(prepareKeeper(pool, config, options, 'sign', undefined, signing), /Another keeper runner/);
      assert.equal(initialized, 0, 'journal loading and signing remain inside the deployment lock');
    });
    await assert.rejects(prepareKeeper(pool, config, options, 'check', async () => { throw new Error('test RPC failure'); }), /test RPC failure/);
    assert.equal((await pool.query('SELECT state FROM keeper_status WHERE deployment_id=$1', [schema])).rows[0].state, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(options['events-file'], { force: true });
    await rm(options['state-file'], { force: true });
  }
});
