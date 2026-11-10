import pg from 'pg';
import type { Config } from './config.js';

export function createPool(databaseUrl: string, max = 5) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10000, statement_timeout: 3000, application_name: 'dragons-market-backend' });
  // Idle connection failures must not crash the API or log connection secrets.
  pool.on('error', () => console.error('Database connection unavailable'));
  return pool;
}

export async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function verifyRuntimeLogin(pool: pg.Pool, expectedLogin?: string): Promise<void> {
  const { rows } = await pool.query(`SELECT current_user AS login, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
    pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'public'
      AND tablename = 'schema_migrations'), 'MEMBER') AS owns_schema
    FROM pg_roles WHERE rolname = current_user`);
  const role = rows[0];
  if (!role || (expectedLogin !== undefined && role.login !== expectedLogin) || role.rolsuper || role.rolcreaterole
    || role.rolcreatedb || role.rolreplication || role.rolbypassrls || role.owns_schema !== false) {
    throw new Error('Runtime database credentials must use a restricted service login');
  }
}

// The migration files cannot change while the process runs, so they are read and hashed once.
let expectedMigrations: Promise<Awaited<ReturnType<typeof import('./migrate.js').migrationFiles>>> | undefined;
function loadExpectedMigrations() {
  expectedMigrations ??= import('./migrate.js').then(({ migrationFiles }) => migrationFiles()).catch(error => { expectedMigrations = undefined; throw error; });
  return expectedMigrations;
}

export async function verifyDatabase(pool: pg.Pool, config: Config): Promise<void> {
  const result = await pool.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
  const expected = await loadExpectedMigrations();
  if (result.rows.length !== expected.length || expected.some((file, i) => result.rows[i]?.version !== file.name || result.rows[i]?.checksum !== file.checksum)) throw new Error('Database migrations are not current');
  if (config.deployment) {
    const { rows } = await pool.query('SELECT network, start_block::text, contracts, collateral_token_id, collateral_decimals FROM deployments WHERE id = $1', [config.deployment.id]);
    const row = rows[0];
    const d = config.deployment;
    if (!row || row.network !== config.network || row.start_block !== d.startBlock || row.collateral_token_id !== d.collateralTokenId || row.collateral_decimals !== d.collateralDecimals || JSON.stringify(Object.entries(row.contracts).sort()) !== JSON.stringify(Object.entries(d.contracts).sort())) throw new Error('Deployment configuration differs from database');
  }
}
