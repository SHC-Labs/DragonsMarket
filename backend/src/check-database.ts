import { readConfig } from './config.js';
import { createPool, verifyDatabase, verifyRuntimeLogin } from './database.js';

let pool: ReturnType<typeof createPool> | undefined;
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--require-mainnet-deployment')) {
    throw new Error('Usage: check-database.js [--require-mainnet-deployment]');
  }
  const config = readConfig(process.env);
  if (args.length && (config.network !== 'mainnet' || !config.deployment)) {
    throw new Error('Mainnet deployment required');
  }
  pool = createPool(config.databaseUrl);
  await verifyRuntimeLogin(pool);
  await verifyDatabase(pool, config);
  console.log('Database schema and restricted service login verified');
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Usage:') ? error.message :
    'Database readiness check failed; verify the release, restricted login and deployment configuration');
  process.exitCode = 1;
} finally {
  await pool?.end();
}
