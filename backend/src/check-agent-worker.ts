import { readAgentWorkerConfig } from './agent-worker-config.js';
import { AgentApiClient } from './agent-api.js';
import { createPool, verifyDatabase, verifyRuntimeLogin } from './database.js';

let pool: ReturnType<typeof createPool> | undefined;
try {
  if (process.argv.length !== 2) throw new Error('unexpected_arguments');
  const { shared, agentApi, walletContract } = readAgentWorkerConfig(process.env);
  if (shared.network !== 'mainnet') throw new Error('mainnet_required');
  pool = createPool(shared.databaseUrl);
  await verifyRuntimeLogin(pool, 'dm_agent_login');
  await verifyDatabase(pool, shared);
  await new AgentApiClient(agentApi).verifyService({ network: shared.network, walletContract });
  console.log('Agent worker database, deployment, API credential and provider configuration verified');
} catch {
  console.error('Agent worker readiness failed; check its database, deployment and Agent API credential/network/wallet contract');
  process.exitCode = 1;
} finally { await pool?.end(); }
