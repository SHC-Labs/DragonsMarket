import { readAgentWorkerConfig } from './agent-worker-config.js';
import { createPool, verifyDatabase, verifyRuntimeLogin } from './database.js';

let pool: ReturnType<typeof createPool> | undefined;
try {
  if (process.argv.length !== 2) throw new Error('unexpected_arguments');
  const { shared } = readAgentWorkerConfig(process.env);
  if (shared.network !== 'mainnet') throw new Error('mainnet_required');
  pool = createPool(shared.databaseUrl);
  await verifyRuntimeLogin(pool, 'dm_agent_login');
  await verifyDatabase(pool, shared);
  console.log('Agent worker configuration, restricted login and deployment verified');
} catch {
  console.error('Agent worker readiness failed; check its private configuration, database role and deployment');
  process.exitCode = 1;
} finally { await pool?.end(); }
