import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { keeperFixture } from './keeper-fixture.js';

const run = promisify(execFile);
const services = ['api', 'indexer', 'worker', 'publisher', 'agent'];
const roles = [...[...services, 'keeper', 'backup'].map(name => `dm_${name}_login`),
  ...[...services, 'keeper', 'backup'].map(name => `dm_${name}`)];

test('database release is repeatable and runtime checks reject owner credentials and schema drift', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Use a disposable PostgreSQL cluster for release tests');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const database = `release_${randomBytes(12).toString('hex')}`;
  let created = false;
  try {
    const existing = await admin.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [roles]);
    assert.equal(existing.rowCount, 0, 'Release tests require a disposable cluster without dm_* roles');
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${database}`;
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url.href };
    for (const service of services) env[`${service.toUpperCase()}_DB_PASSWORD`] = randomBytes(32).toString('hex');
    const release = () => run(process.execPath, ['dist/src/release.js'], { env });
    assert.match((await release()).stdout, /service database roles are ready/);
    assert.match((await release()).stdout, /Applied 0 migration/);
    assert.equal((await admin.query("SELECT 1 FROM pg_roles WHERE rolname IN ('dm_keeper_login','dm_backup_login')")).rowCount, 0);
    env.KEEPER_DB_PASSWORD = randomBytes(32).toString('hex');
    env.BACKUP_DB_PASSWORD = randomBytes(32).toString('hex');
    assert.match((await release()).stdout, /Applied 0 migration/);
    const check = (databaseUrl: string, args: string[] = [], settings: NodeJS.ProcessEnv = {}) =>
      run(process.execPath, ['dist/src/check-database.js', ...args], {
      env: { ...settings, DATABASE_URL: databaseUrl },
    });
    await assert.rejects(check(url.href), /Database readiness check failed/);
    const runtime = new URL(url);
    runtime.username = 'dm_api_login';
    runtime.password = env.API_DB_PASSWORD!;
    assert.match((await check(runtime.href)).stdout, /restricted service login verified/);
    const workerArgs = ['--require-mainnet-deployment'];
    await assert.rejects(check(runtime.href, workerArgs), /Database readiness check failed/);
    await assert.rejects(check(runtime.href, ['--require-mainnet-deploymnt']), /Usage:/);
    const api = new pg.Pool({ connectionString: runtime.href });
    try {
      await api.query('SELECT version FROM schema_migrations');
      for (const sql of ['SELECT sealed_token FROM agent_grants', 'UPDATE user_operations SET state=state WHERE false', 'CREATE TABLE forbidden(id int)']) {
        await assert.rejects(api.query(sql), (error: unknown) => (error as { code: string }).code === '42501');
      }
    } finally { await api.end(); }
    const owner = new pg.Pool({ connectionString: url.href });
    try {
      const approval = keeperFixture();
      const deployment = approval.approval.deployment;
      const registration = { ...env, NETWORK: 'mainnet', REGISTER_DEPLOYMENT: 'true', ...approval.encode(),
        DEPLOYMENT_ID: deployment.id, DEPLOYMENT_START_BLOCK: deployment.startBlock,
        COLLATERAL_TOKEN_ID: deployment.collateralTokenId,
        ...Object.fromEntries(Object.entries(deployment.contracts).map(([role, account]) =>
          [`${role.toUpperCase()}_CONTRACT_ID`, account])),
      };
      const register = (settings: NodeJS.ProcessEnv = {}) => run(process.execPath,
        ['dist/src/release.js'], { env: { ...registration, ...settings } });
      for (const invalid of [{ KEEPER_APPROVAL_JSON: '' }, { KEEPER_APPROVAL_SHA256: '0'.repeat(64) },
        { DEPLOYMENT_START_BLOCK: '101' }, { REGISTER_DEPLOYMENT: 'yes' }]) {
        await assert.rejects(register(invalid), /Database release failed/);
      }
      assert.equal((await owner.query('SELECT 1 FROM deployments')).rowCount, 0);
      for (let run = 0; run < 2; run++) {
        assert.match((await register()).stdout, /"registered":"keeper-fixture"/);
      }
      assert.equal((await owner.query('SELECT 1 FROM deployments WHERE id = $1', [deployment.id])).rowCount, 1);
      const changed = structuredClone(approval.approval);
      changed.deployment.startBlock = '101';
      await assert.rejects(register({ ...approval.encode(changed), DEPLOYMENT_START_BLOCK: '101' }),
        /Database release failed/);
      const stored = await owner.query('SELECT start_block::text FROM deployments WHERE id = $1', [deployment.id]);
      assert.equal(stored.rows[0].start_block, '100');
      const manifest = { NETWORK: 'mainnet', DEPLOYMENT_ID: 'worker-readiness',
        DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near',
        VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near',
        RPC_URL: 'http://127.0.0.1:1' };
      await assert.rejects(check(runtime.href, workerArgs, manifest), /Database readiness check failed/);
      await registerDeployment(owner, readConfig({ ...manifest, DATABASE_URL: url.href }));
      const workerSettings = { ...manifest, AGENT_API_URL: 'https://agents.example.com',
        AGENT_API_KEY: `naa_${'t'.repeat(43)}`, AGENT_API_WALLET_CONTRACT: 'wallets.near',
        AGENT_GRANT_KEY: Buffer.alloc(32, 1).toString('base64'), AGENT_WORKER_TOKEN: 'w'.repeat(32) };
      const agentCheck = (databaseUrl: string) => run(process.execPath, ['dist/src/check-agent-worker.js'], {
        env: { ...workerSettings, DATABASE_URL: databaseUrl },
      });
      for (const databaseUrl of [url.href, runtime.href]) await assert.rejects(agentCheck(databaseUrl), /Agent worker readiness failed/);
      const agentUrl = new URL(url);
      agentUrl.username = 'dm_agent_login';
      agentUrl.password = env.AGENT_DB_PASSWORD!;
      assert.match((await agentCheck(agentUrl.href)).stdout, /restricted login and deployment verified/);
      for (const service of ['indexer', 'worker', 'keeper', 'backup']) {
        const worker = new URL(url);
        worker.username = `dm_${service}_login`;
        worker.password = env[`${service.toUpperCase()}_DB_PASSWORD`]!;
        assert.match((await check(worker.href, workerArgs, manifest)).stdout, /restricted service login verified/);
        await assert.rejects(check(worker.href, workerArgs, { ...manifest, NETWORK: 'sandbox' }),
          /Database readiness check failed/);
        await assert.rejects(check(worker.href, workerArgs, { ...manifest, DEPLOYMENT_START_BLOCK: '101' }),
          /Database readiness check failed/);
      }
      await owner.query('ALTER ROLE dm_api_login REPLICATION');
      await assert.rejects(check(runtime.href), /Database readiness check failed/);
      await owner.query('ALTER ROLE dm_api_login NOREPLICATION');
      await owner.query("UPDATE schema_migrations SET checksum = repeat('0', 64)");
    }
    finally { await owner.end(); }
    await assert.rejects(check(runtime.href), /Database readiness check failed/);
    await assert.rejects(release(), /Database release failed/);
  } finally {
    if (created) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.end();
  }
});
