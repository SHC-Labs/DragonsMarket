import { readConfig } from './config.js';
import { createPool, verifyDatabase } from './database.js';

const config = readConfig(process.env);
const pool = createPool(config.databaseUrl);
try {
  const { rows } = await pool.query(`SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
    pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'public'
      AND tablename = 'schema_migrations'), 'MEMBER') AS owns_schema
    FROM pg_roles WHERE rolname = current_user`);
  const role = rows[0];
  if (!role || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolbypassrls || role.owns_schema) {
    throw new Error('Runtime database credentials must use a restricted service login');
  }
  await verifyDatabase(pool, config);
  console.log('Database schema and restricted service login verified');
} catch {
  console.error('Database readiness check failed; complete the database release before deploying this service');
  process.exitCode = 1;
} finally {
  await pool.end();
}
