import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { migrate, migrationFiles } from '../src/migrate.js';
import { verifyDatabase } from '../src/database.js';
import { readConfig } from '../src/config.js';

test('real PostgreSQL migrations, deduplication, atomic rollback and reconnect persistence', async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL explicitly; tests create and remove an isolated schema');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool: pg.Pool | undefined;
  const connect = () => new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = connect();
    assert.equal(await migrate(pool), (await migrationFiles()).length);
    assert.equal(await migrate(pool), 0);
    const config = readConfig({ DATABASE_URL: databaseUrl });
    await verifyDatabase(pool, config);
    await pool.query(`INSERT INTO deployments (id, network, start_block, contracts, collateral_token_id, collateral_decimals)
      VALUES ('test', 'sandbox', 0, '{"rounds":"rounds.test.near","verifier":"intents.test.near"}', 'nep141:usdc.test.near', 6)`);
    const insert = `INSERT INTO raw_events (network, receipt_id, log_index, data_index, deployment_id, receiver_id, block_height, block_hash, block_timestamp_ns, standard, version, event, raw_log, payload)
      VALUES ('sandbox', $1, 0, 0, 'test', 'rounds.test.near', 18446744073709551615, 'hash', 18446744073709551615, 'rounds', '1.0.0', 'staked', 'EVENT_JSON:{}', '{}')`;
    await pool.query(insert, ['receipt-1']);
    await assert.rejects(pool.query(insert, ['receipt-1']), (e: unknown) => (e as {code: string}).code === '23505');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(insert, ['receipt-rollback']);
      await client.query(`INSERT INTO indexed_blocks (deployment_id, block_height, block_hash, prev_hash, block_timestamp_ns, content_hash, event_count, keeper_payload)
        VALUES ('test', 10, 'hash', 'prev', 10, repeat('a', 64), 0, '{}')`);
      await client.query(`INSERT INTO indexer_checkpoints VALUES ('test', 10, 'hash', 10, now())`);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM indexer_checkpoints')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM raw_events')).rows[0].n, 1);
    const { rows } = await pool.query('SELECT block_height::text FROM raw_events');
    assert.equal(rows[0].block_height, '18446744073709551615');
    // A second deployment on the same network indexes the same receipt without colliding with the first.
    await pool.query(`INSERT INTO deployments (id, network, start_block, contracts, collateral_token_id, collateral_decimals)
      VALUES ('test2', 'sandbox', 0, '{"rounds":"rounds.test.near","verifier":"intents.test.near"}', 'nep141:usdc.test.near', 6)`);
    await pool.query(insert.replace("'test'", "'test2'"), ['receipt-1']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM raw_events')).rows[0].n, 2);
    await pool.end();
    pool = connect();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM raw_events')).rows[0].n, 2);
    const configured = readConfig({ DATABASE_URL: databaseUrl, DEPLOYMENT_ID: 'test', DEPLOYMENT_START_BLOCK: '0', ROUNDS_CONTRACT_ID: 'rounds.test.near', VERIFIER_CONTRACT_ID: 'intents.test.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.test.near', RPC_URL: 'http://localhost:3030' });
    await verifyDatabase(pool, configured);
    await assert.rejects(verifyDatabase(pool, { ...configured, network: 'testnet' }));
    await pool.query("UPDATE schema_migrations SET checksum = 'changed'");
    await assert.rejects(migrate(pool), /Applied migration changed/);
    await assert.rejects(verifyDatabase(pool, config), /migrations are not current/);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('policy observation migration preserves existing accounts and supports atomic observation updates', async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Set TEST_DATABASE_URL explicitly; tests use an isolated schema');
  const schema = `policy_upgrade_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const previous = await mkdtemp(join(tmpdir(), 'dragons-policy-migrations-'));
  try {
    for (const file of (await migrationFiles()).filter(file => file.name < '016_')) {
      await symlink(resolve('migrations', file.name), join(previous, file.name));
    }
    await admin.query(`CREATE SCHEMA ${schema}`);
    assert.equal(await migrate(pool, previous), 15);
    await pool.query(`INSERT INTO deployments(id,network,start_block,contracts,collateral_token_id,collateral_decimals)
      VALUES('upgrade','sandbox',0,'{"market":"market.test.near","verifier":"intents.test.near"}',
        'nep141:usdc.test.near',6)`);
    const id = randomUUID();
    await pool.query(`INSERT INTO agent_accounts(id,deployment_id,owner_account_id,name,agent_id,near_account_id,state,frozen)
      VALUES($1,'upgrade','alice.near','Existing agent',$2,'agent.near','active',true)`, [id, 'a'.repeat(64)]);
    const before = (await pool.query('SELECT * FROM agent_accounts WHERE id=$1', [id])).rows[0];
    assert.equal(await migrate(pool), (await migrationFiles()).length - 15);
    const after = (await pool.query('SELECT * FROM agent_accounts WHERE id=$1', [id])).rows[0];
    assert.deepEqual(after, { ...before, policy_observation: '0' });
    await assert.rejects(pool.query('UPDATE agent_accounts SET policy_observation=-1 WHERE id=$1', [id]),
      (error: unknown) => (error as { code: string }).code === '23514');
    const advance = () => pool.query(`UPDATE agent_accounts SET policy_observation=policy_observation+1
      WHERE id=$1 AND policy_observation=0`, [id]);
    const results = await Promise.all([advance(), advance()]);
    assert.deepEqual(results.map(result => result.rowCount).sort(), [0, 1]);
    assert.equal(await migrate(pool), 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(previous, { recursive: true, force: true });
  }
});
