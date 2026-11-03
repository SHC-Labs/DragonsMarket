import type pg from 'pg';
import { readConfig, type Config } from './config.js';
import { createPool, verifyDatabase } from './database.js';
import { createApp } from './app.js';
import { createReadApi } from './read-api.js';
import { cleanupExpiredAuth } from './auth.js';
import { backendStatus } from './monitoring.js';
import { createPrivateApi } from './private-api.js';
import { accessKeyChecker } from './access-key.js';
import { ingestionStatus } from './ingestion/store.js';
import { ReadRpcClient } from './providers.js';
import { AgentApiClient } from './agent-api.js';
import { finalTransaction, finalView, nearBalance, type AgentRunner } from './agents.js';
import { createAgentRoutes } from './agent-routes.js';
import { operationStore } from './operations.js';

function agentRoutes(pool: pg.Pool, config: Config) {
  const { agentApi, agentAccounts, deployment } = config;
  if (!agentApi || !agentAccounts || !deployment) return null;
  const api = new AgentApiClient(agentApi);
  const rpc = () => new ReadRpcClient(config.rpc.primaryUrl, config.rpc, config.rpc.primaryBearerToken);
  const runner: AgentRunner = {
    deployment, api, waitMs: 0,
    view: (contract, method, args) => finalView(rpc())(contract, method, args),
    transaction: (hash, sender) => finalTransaction(rpc(), hash, sender),
    operations: operationStore(pool, deployment.id),
  };
  const chain = { nearBalance: (account: string) => nearBalance(rpc())(account) };
  return createAgentRoutes({ db: pool, deployment, api, runner, chain, grantKey: agentAccounts.grantKey,
    signing: { walletContract: agentAccounts.walletContract, messageRecipient: new URL(agentApi.url).hostname } });
}

const READ_POOL_SIZE = 4;
const STATUS_POOL_SIZE = 2;
const HOUSEKEEPING_INTERVAL_MS = 10 * 60 * 1000;

try {
  const config = readConfig(process.env);
  const pool = createPool(config.databaseUrl);
  // Evidence reads get their own connections, so a burst of slow queries cannot starve login, health checks or housekeeping.
  const readPool = createPool(config.databaseUrl, READ_POOL_SIZE);
  // Public status routes also get their own, so a flood on them cannot take the connections login needs.
  const statusPool = createPool(config.databaseUrl, STATUS_POOL_SIZE);
  const evidence = createReadApi(readPool, config);
  const server = createApp(
    config,
    () => verifyDatabase(statusPool, config),
    async () => {
      await verifyDatabase(statusPool, config);
      return ingestionStatus(statusPool, config);
    },
    evidence,
    createPrivateApi(
      pool,
      config,
      accessKeyChecker(config),
      process.env.POLICY_TERMS_HASH && process.env.POLICY_PRIVACY_HASH
        ? { terms: process.env.POLICY_TERMS_HASH, privacy: process.env.POLICY_PRIVACY_HASH }
        : null,
      agentRoutes(pool, config),
    ),
    async () => {
      await verifyDatabase(statusPool, config);
      return backendStatus(statusPool, config);
    },
  );
  server.on('error', () => {
    console.error('API failed to listen');
    void pool.end();
    void readPool.end();
    void statusPool.end();
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => console.log(`Dragons Market backend listening on port ${config.port}`));
  const housekeeping = setInterval(() => {
    void cleanupExpiredAuth(pool).catch(() => console.error('Expired credential cleanup unavailable'));
  }, HOUSEKEEPING_INTERVAL_MS);
  housekeeping.unref();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(housekeeping);
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(() => {
      void Promise.all([pool.end(), readPool.end(), statusPool.end()]).then(() => clearTimeout(timeout));
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid backend configuration');
  process.exitCode = 1;
}
