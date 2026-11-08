import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { verifyDatabase } from '../src/database.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { ingest } from '../src/ingestion/engine.js';
import { FixtureSource } from '../src/ingestion/source.js';

const exec = promisify(execFile);
const services = ['api', 'indexer', 'worker', 'publisher', 'agent'];
const roles = [...services.map(name => `dm_${name}_login`),
  ...services.map(name => `dm_${name}`), 'dm_backup_test_login', 'dm_backup', 'dm_keeper'];
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

function pgEnvironment(url: URL, directory: string): NodeJS.ProcessEnv {
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGDATABASE: url.pathname.slice(1), PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '2', BACKUP_DIR: directory,
    BACKUP_KEEP: '2' };
}

async function backupLogin(pool: pg.Pool, source: URL) {
  const password = randomBytes(32).toString('hex');
  await pool.query(`CREATE ROLE dm_backup_test_login LOGIN NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  await pool.query('GRANT dm_backup TO dm_backup_test_login');
  const url = new URL(source);
  url.username = 'dm_backup_test_login';
  url.password = password;
  const backup = new pg.Pool({ connectionString: url.href });
  try {
    for (const sql of ['UPDATE agent_grants SET state=state WHERE false',
      "SELECT nextval('chain_integrity_reports_id_seq')", 'CREATE TABLE forbidden_backup(id int)']) {
      await assert.rejects(backup.query(sql), (error: unknown) => (error as { code: string }).code === '42501');
    }
  } finally { await backup.end(); }
  return url;
}

async function snapshot(pool: pg.Pool) {
  const tables = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const contents: Record<string, string[]> = {};
  for (const { tablename } of tables.rows) {
    contents[tablename] = (await pool.query<{ row: string }>(
      `SELECT row_to_json(t)::text AS row FROM public.${identifier(tablename)} t ORDER BY 1`
    )).rows.map(({ row }) => row);
  }
  const indexes = await pool.query(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname");
  const constraints = await pool.query(`SELECT conrelid::regclass::text AS relation,conname,
    pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE connamespace='public'::regnamespace ORDER BY relation,conname`);
  const sequences = await pool.query(`SELECT sequencename,last_value::text FROM pg_sequences
    WHERE schemaname='public' ORDER BY sequencename`);
  return { contents, indexes: indexes.rows, constraints: constraints.rows, sequences: sequences.rows };
}

async function recoveryEvidence(url: URL, directory: string) {
  const { stdout } = await exec('psql', ['-XqAt', '--pset=pager=off', '--no-password',
    '--set=ON_ERROR_STOP=1', '--file=ops/recovery-evidence.sql'], { env: pgEnvironment(url, directory) });
  const records = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].readOnly, 'on');
  assert.equal(records.at(-1).kind, 'complete');
  // The fixture restores into a different database; the production comparator does not normalize identity.
  records[0].database = 'restore-fixture';
  return records;
}

async function checkSequenceDefinitions(pool: pg.Pool, url: URL, directory: string) {
  const before = await recoveryEvidence(url, directory);
  const sequence = 'chain_integrity_reports_id_seq';
  const mutations = [
    ['AS integer', 'AS bigint'],
    ['START WITH 7', 'START WITH 1'],
    ['INCREMENT BY 2', 'INCREMENT BY 1'],
    ['MINVALUE 0', 'MINVALUE 1'],
    ['MAXVALUE 9007199254740993', 'NO MAXVALUE'],
    ['CACHE 4', 'CACHE 1'],
    ['CYCLE', 'NO CYCLE'],
    ['OWNED BY NONE', 'OWNED BY public.chain_integrity_reports.id'],
  ];
  for (const [change, undo] of mutations) {
    try {
      await pool.query(`ALTER SEQUENCE ${sequence} ${change}`);
      const after = await recoveryEvidence(url, directory);
      assert.deepEqual(after.filter(record => record.kind === 'sequence'),
        before.filter(record => record.kind === 'sequence'), 'counter values did not change');
      assert.notDeepEqual(after, before, `sequence definition change must be detected: ${change}`);
    } finally {
      await pool.query(`ALTER SEQUENCE ${sequence} ${undo}`);
    }
    assert.deepEqual(await recoveryEvidence(url, directory), before);
  }
}

async function checkPermissionDefinitions(pool: pg.Pool, url: URL, directory: string) {
  await pool.query('ALTER TABLE evidence ENABLE ROW LEVEL SECURITY');
  await pool.query('CREATE POLICY evidence_reader ON evidence FOR SELECT USING (false)');
  await pool.query('CREATE VIEW evidence_view AS SELECT amount FROM evidence WHERE false');
  try {
    const before = await recoveryEvidence(url, directory);
    const database = identifier(url.pathname.slice(1));
    const changes = [
      ['ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC',
        'ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC'],
      [`ALTER ROLE dm_api_login IN DATABASE ${database} SET search_path = public`,
        `ALTER ROLE dm_api_login IN DATABASE ${database} RESET search_path`],
      ['ALTER POLICY evidence_reader ON evidence USING (true)',
        'ALTER POLICY evidence_reader ON evidence USING (false)'],
      ['CREATE OR REPLACE VIEW evidence_view AS SELECT amount FROM evidence WHERE true',
        'CREATE OR REPLACE VIEW evidence_view AS SELECT amount FROM evidence WHERE false'],
    ];
    for (const [change, undo] of changes) {
      try {
        await pool.query(change!);
        assert.notDeepEqual(await recoveryEvidence(url, directory), before,
          `permission or view change must be detected: ${change}`);
      } finally { await pool.query(undo!); }
      assert.deepEqual(await recoveryEvidence(url, directory), before);
    }
  } finally {
    await pool.query('DROP VIEW evidence_view');
    await pool.query('DROP POLICY evidence_reader ON evidence');
    await pool.query('ALTER TABLE evidence DISABLE ROW LEVEL SECURITY');
  }
}

async function seed(pool: pg.Pool, url: URL) {
  const config = readConfig({ DATABASE_URL: url.href, DEPLOYMENT_ID: 'restore-test',
    DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near',
    VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  await registerDeployment(pool, config);
  await ingest(pool, config, new FixtureSource('test/fixtures/blocks.jsonl'));
  await pool.query(`INSERT INTO user_operations
    (id,deployment_id,account_id,kind,idempotency_key,request_hash,request,state)
    VALUES($1,'restore-test','alice.near','withdraw','restore-op',repeat('a',64),
    '{"amount":"9007199254740993"}','unknown')`, [randomUUID()]);
  await pool.query('CREATE TABLE evidence(id bigserial PRIMARY KEY,amount numeric(38,0),payload jsonb)');
  await pool.query(`INSERT INTO evidence(amount,payload)
    VALUES(900719925474099301,'{"state":"unknown"}')`);
  return config;
}

async function verifyLogins(url: URL, passwords: NodeJS.ProcessEnv) {
  const runtime = new URL(url);
  runtime.username = 'dm_api_login';
  runtime.password = passwords.API_DB_PASSWORD!;
  await exec(process.execPath, ['dist/src/check-database.js'], { env: { DATABASE_URL: runtime.href } });
  const api = new pg.Pool({ connectionString: runtime.href });
  try {
    assert.equal((await api.query('SELECT state FROM user_operations')).rows[0].state, 'unknown');
    for (const sql of ['SELECT sealed_token FROM agent_grants',
      'UPDATE user_operations SET state=state WHERE false', 'CREATE TABLE forbidden(id int)']) {
      await assert.rejects(api.query(sql), (error: unknown) => (error as { code: string }).code === '42501');
    }
  } finally { await api.end(); }
  runtime.username = 'dm_agent_login';
  runtime.password = passwords.AGENT_DB_PASSWORD!;
  const agent = new pg.Pool({ connectionString: runtime.href });
  try {
    await agent.query('SELECT sealed_token FROM agent_grants');
    await assert.rejects(agent.query('SELECT * FROM wallet_sessions'),
      (error: unknown) => (error as { code: string }).code === '42501');
  } finally { await agent.end(); }
}

async function checkArchiveHandling(env: NodeJS.ProcessEnv, directory: string) {
  const backup = (overrides: NodeJS.ProcessEnv = {}) => exec('bash', ['scripts/backup.sh'],
    { env: { ...env, ...overrides } });
  const first = (await backup()).stdout.trim();
  const second = (await backup()).stdout.trim();
  assert.notEqual(first, second);
  assert.equal((await stat(second)).mode & 0o777, 0o600);
  assert.equal((await stat(`${second}.sha256`)).mode & 0o777, 0o600);
  await exec('sha256sum', ['--check', `${basename(second)}.sha256`], { cwd: directory });
  for (const keep of ['0', '-1', '2+1', '1000']) {
    await assert.rejects(backup({ BACKUP_KEEP: keep }), /BACKUP_KEEP must/);
  }
  await assert.rejects(backup({ PGHOST: '' }), /set PGHOST/);
  await assert.rejects(backup({ PGDATABASE: 'backup_missing_database', BACKUP_KEEP: '1' }));
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.dump')).length, 2);
  assert.equal((await readdir(directory)).filter(name => name.startsWith('.dump-')).length, 0);
  const lock = spawn('flock', ['-x', resolve(directory, '.backup.lock'),
    'sh', '-c', 'printf ready; read -r release'], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await once(lock.stdout, 'data');
    await assert.rejects(backup(), /Another backup/);
  } finally {
    const exited = once(lock, 'exit');
    lock.stdin.end('release\n');
    await exited;
  }
  await chmod(directory, 0o755);
  await assert.rejects(backup(), /mode 700/);
  await chmod(directory, 0o700);
  const newest = (await backup({ BACKUP_KEEP: '1' })).stdout.trim();
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.dump')), [basename(newest)]);
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.sha256')),
    [`${basename(newest)}.sha256`]);
  await exec('sha256sum', ['--check', `${basename(newest)}.sha256`], { cwd: directory });
  return newest;
}

async function checkEncryptedArchive(env: NodeJS.ProcessEnv, directory: string) {
  const encryptedDirectory = resolve(directory, 'encrypted');
  const recipients = resolve(directory, 'recipients.txt');
  const keys = ['owner', 'custodian', 'wrong'].map(name => resolve(directory, `${name}.key`));
  const publicKeys: string[] = [];
  for (const key of keys) {
    await exec('age-keygen', ['--output', key]);
    publicKeys.push((await exec('age-keygen', ['-y', key])).stdout.trim());
  }
  await writeFile(recipients, publicKeys.slice(0, 2).join('\n') + '\n');
  const options = { env: { ...env, BACKUP_DIR: encryptedDirectory, BACKUP_AGE_RECIPIENTS_FILE: recipients } };
  await assert.rejects(exec('bash', ['scripts/backup.sh', '--encrypt'],
    { env: { ...options.env, BACKUP_AGE_RECIPIENTS_FILE: '' } }));
  await assert.rejects(exec('bash', ['scripts/backup.sh', '--encrypt'],
    { env: { ...options.env, PGDATABASE: 'missing_encrypted_backup_database' } }));
  const archive = (await exec('bash', ['scripts/backup.sh', '--encrypt'], options)).stdout.trim();
  assert.ok(archive.endsWith('.dump.age'));
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(encryptedDirectory)).sort(),
    ['.backup.lock', basename(archive), `${basename(archive)}.sha256`].sort());
  await exec('sha256sum', ['--check', `${basename(archive)}.sha256`], { cwd: encryptedDirectory });
  const decrypted = resolve(directory, 'decrypted-fixture.dump');
  await exec('age', ['--decrypt', '--identity', keys[0]!, '--output', decrypted, archive]);
  const second = await exec('age', ['--decrypt', '--identity', keys[1]!, archive], { encoding: 'buffer' });
  assert.deepEqual(second.stdout, await readFile(decrypted));
  await assert.rejects(exec('age', ['--decrypt', '--identity', keys[2]!, archive]));
  await appendFile(archive, 'corruption');
  await assert.rejects(exec('age', ['--decrypt', '--identity', keys[0]!, archive]));
  return decrypted;
}

test('the backup command restores all backend data and restricted access into a fresh database',
  { timeout: 60000 }, async () => {
    const connection = process.env.TEST_DATABASE_URL;
    assert.ok(connection, 'Use a disposable local PostgreSQL cluster for backup tests');
    const url = new URL(connection);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    const admin = new pg.Pool({ connectionString: url.href });
    const databases: string[] = [];
    const pools: pg.Pool[] = [];
    let ownsRoles = false;
    let directory: string | undefined;
    try {
      assert.equal((await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1)', [roles])).rowCount,
        0, 'Backup tests require a disposable cluster without dm_* roles');
      ownsRoles = true;
      await mkdir('.local/backups', { recursive: true });
      directory = await mkdtemp(resolve('.local/backups/restore-'));
      const passwords: NodeJS.ProcessEnv = {};
      for (const service of services) passwords[`${service.toUpperCase()}_DB_PASSWORD`] =
        randomBytes(32).toString('hex');
      const source = new URL(url), target = new URL(url), encryptedTarget = new URL(url);
      for (const destination of [source, target, encryptedTarget]) {
        const database = `backup_${randomBytes(12).toString('hex')}`;
        await admin.query(`CREATE DATABASE ${database}`);
        databases.push(database);
        destination.pathname = `/${database}`;
      }
      const release = (destination: URL) => exec(process.execPath, ['dist/src/release.js'],
        { env: { ...passwords, DATABASE_URL: destination.href } });
      await release(source);
      const sourcePool = new pg.Pool({ connectionString: source.href });
      const targetPool = new pg.Pool({ connectionString: target.href });
      const encryptedPool = new pg.Pool({ connectionString: encryptedTarget.href });
      pools.push(sourcePool, targetPool, encryptedPool);
      const config = await seed(sourcePool, source);
      await release(source);
      const backupUrl = await backupLogin(sourcePool, source);
      const before = await snapshot(sourcePool);
      const evidence = await recoveryEvidence(source, directory);
      const archive = await checkArchiveHandling(pgEnvironment(backupUrl, directory), directory);
      const decrypted = await checkEncryptedArchive(pgEnvironment(backupUrl, directory), directory);
      await exec('pg_restore', ['--no-password', '--no-owner', '--no-acl', '--single-transaction',
        '--exit-on-error', '--dbname', encryptedTarget.pathname.slice(1), decrypted],
      { env: pgEnvironment(encryptedTarget, directory) });
      await release(encryptedTarget);
      assert.deepEqual(await recoveryEvidence(encryptedTarget, directory), evidence);
      await verifyLogins(encryptedTarget, passwords);
      await exec('pg_restore', ['--no-password', '--no-owner', '--no-acl', '--single-transaction',
        '--exit-on-error', '--dbname', target.pathname.slice(1), archive],
      { env: pgEnvironment(target, directory) });
      assert.deepEqual(await snapshot(targetPool), before);
      await verifyDatabase(targetPool, config);
      assert.match((await release(target)).stdout, /Applied 0 migration/);
      await verifyLogins(target, passwords);
      assert.deepEqual(await snapshot(targetPool), before);
      assert.deepEqual(await recoveryEvidence(target, directory), evidence);
      await checkSequenceDefinitions(targetPool, target, directory);
      await checkPermissionDefinitions(targetPool, target, directory);
      await targetPool.query('UPDATE evidence SET amount=amount+1');
      assert.notDeepEqual(await recoveryEvidence(target, directory), evidence);
      await targetPool.query('UPDATE evidence SET amount=amount-1');
      await targetPool.query('GRANT SELECT ON agent_grants TO dm_api');
      assert.notDeepEqual(await recoveryEvidence(target, directory), evidence);
      await targetPool.query('REVOKE SELECT ON agent_grants FROM dm_api');
      assert.deepEqual(await recoveryEvidence(target, directory), evidence);
      await targetPool.query('GRANT SELECT(sealed_token) ON agent_grants TO dm_api');
      assert.notDeepEqual(await recoveryEvidence(target, directory), evidence);
      await targetPool.query('REVOKE SELECT(sealed_token) ON agent_grants FROM dm_api');
      assert.deepEqual(await recoveryEvidence(target, directory), evidence);
      assert.equal((await targetPool.query('SELECT amount::text FROM evidence')).rows[0].amount,
        '900719925474099301');
      assert.equal((await targetPool.query("INSERT INTO evidence(amount) VALUES(1) RETURNING id::text"))
        .rows[0].id, '2');
      await appendFile(archive, 'corruption');
      await assert.rejects(exec('sha256sum', ['--check', `${basename(archive)}.sha256`], { cwd: directory }));
    } finally {
      await Promise.all(pools.map(pool => pool.end()));
      for (const database of databases) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      if (ownsRoles) for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
