import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { migrate } from './migrate.js';
import { LOCK } from './locks.js';
import { readConfig } from './config.js';
import { parseKeeperApproval } from './keeper-approval.js';
import { registerDeployment } from './ingestion/store.js';

const services = ['api', 'indexer', 'worker', 'publisher', 'agent'] as const;

function credentials(env: NodeJS.ProcessEnv) {
  const requested = [...services, ...(['keeper', 'backup', 'relay_topup'] as const).filter(service =>
    env[`${service.toUpperCase()}_DB_PASSWORD`] !== undefined)];
  return requested.map(service => {
    const name = `${service.toUpperCase()}_DB_PASSWORD`;
    const password = env[name];
    if (!password || !/^[a-f0-9]{64}$/.test(password)) {
      throw new Error(`${name} must contain 32 random bytes encoded as lowercase hex`);
    }
    return { service, password };
  });
}

let pool: ReturnType<typeof createPool> | undefined;
try {
  if (process.env.REGISTER_DEPLOYMENT && process.env.REGISTER_DEPLOYMENT !== 'true') throw new Error('Invalid registration mode');
  const registration = process.env.REGISTER_DEPLOYMENT === 'true' ? readConfig(process.env) : null;
  if (registration) parseKeeperApproval(process.env.KEEPER_APPROVAL_JSON, process.env.KEEPER_APPROVAL_SHA256, registration);
  const logins = credentials(process.env);
  pool = createPool(readConfig({ DATABASE_URL: process.env.DATABASE_URL }).databaseUrl);
  const count = await migrate(pool);
  const sql = await readFile('ops/roles.sql', 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(${LOCK.roles})`);
    await client.query(sql);
    for (const { service, password } of logins) {
      const role = `dm_${service}_login`;
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (!exists.rowCount) await client.query(`CREATE ROLE ${role}`);
      await client.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await client.query(`GRANT dm_${service} TO ${role}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (registration) {
    await registerDeployment(pool, registration);
    console.log(JSON.stringify({ service: 'database-release', registered: registration.deployment!.id }));
  }
  console.log(`Applied ${count} migration(s); service database roles are ready`);
} catch {
  console.error('Database release failed; check the migration owner connection and service password settings');
  process.exitCode = 1;
} finally {
  await pool?.end();
}
