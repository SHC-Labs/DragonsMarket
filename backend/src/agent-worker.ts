import { accessKeyChecker } from './access-key.js';
import type { AgentAccounts } from './agent-accounts.js';
import { AgentApiClient } from './agent-api.js';
import { finalTransaction, nearBalance } from './agent-chain.js';
import { createAgentRoutes } from './agent-routes.js';
import { startAgentSweep } from './agent-sweep.js';
import { readAgentWorkerConfig, type AgentWorkerConfig } from './agent-worker-config.js';
import { createAgentWorkerServer } from './agent-worker-server.js';
import type { AgentRunner } from './agents.js';
import { finalView } from './chain-view.js';
import { createPool, verifyDatabase, verifyRuntimeLogin } from './database.js';
import { operationStore } from './operations.js';
import { ReadRpcClient } from './providers.js';

function agentAccounts(config: AgentWorkerConfig, pool: ReturnType<typeof createPool>): AgentAccounts {
  const { shared, deployment, agentApi, grantKey, walletContract } = config;
  const api = new AgentApiClient(agentApi);
  const rpc = () => new ReadRpcClient(shared.rpc.primaryUrl, shared.rpc, shared.rpc.primaryBearerToken);
  const runner: AgentRunner = {
    deployment, api, waitMs: 0,
    transaction: (hash, sender) => finalTransaction(rpc(), hash, sender),
    operations: operationStore(pool, deployment.id),
  };
  const chain = {
    view: (contract: string, method: string, args: unknown) => finalView(rpc())(contract, method, args),
    nearBalance: (account: string) => nearBalance(rpc())(account),
  };
  return { db: pool, deployment, api, runner, chain, grantKey, checkKey: accessKeyChecker(shared),
    webOrigin: shared.webOrigin,
    signing: { walletContract, messageRecipient: new URL(agentApi.url).hostname } };
}

let pool: ReturnType<typeof createPool> | undefined;
try {
  const config = readAgentWorkerConfig(process.env);
  const database = pool = createPool(config.shared.databaseUrl);
  await verifyRuntimeLogin(pool, 'dm_agent_login');
  await verifyDatabase(pool, config.shared);
  const agents = agentAccounts(config, pool);
  const server = createAgentWorkerServer(createAgentRoutes(agents), config.token,
    () => verifyDatabase(database, config.shared));
  let sweep: ReturnType<typeof startAgentSweep> | undefined;
  server.on('error', () => {
    console.error('The agent worker failed to listen');
    void database.end();
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    sweep = startAgentSweep(agents);
    console.log(`Agent worker listening on port ${config.port}`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(() => {
      void (sweep?.stop() ?? Promise.resolve()).then(() => database.end()).then(() => clearTimeout(timeout));
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch {
  await pool?.end();
  console.error('Agent worker startup failed; check its configuration, restricted database role and deployment');
  process.exitCode = 1;
}
