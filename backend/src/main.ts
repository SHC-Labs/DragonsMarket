import { readConfig } from './config.js';
import { createPool, verifyDatabase } from './database.js';
import { createApp } from './app.js';
import { createReadApi, ReadError } from './read-api.js';
import { cleanupExpiredAuth } from './auth.js';
import { backendStatus } from './monitoring.js';
import { createPrivateApi } from './private-api.js';
import { accessKeyChecker } from './access-key.js';
import { ingestionStatus } from './ingestion/store.js';

const READ_POOL_SIZE = 4;
const HOUSEKEEPING_INTERVAL_MS = 10 * 60 * 1000;

try {
  const config = readConfig(process.env);
  const pool = createPool(config.databaseUrl);
  // Evidence reads get their own connections, so a burst of slow queries cannot starve login, health checks or housekeeping.
  const readPool = createPool(config.databaseUrl, READ_POOL_SIZE);
  const evidence = createReadApi(readPool, config);
  const server = createApp(
    config,
    () => verifyDatabase(pool, config),
    async () => {
      await verifyDatabase(pool, config);
      return ingestionStatus(pool, config);
    },
    async url => {
      if (url.pathname === '/v1/health/services') {
        if (url.search) throw new ReadError(400, 'invalid_query');
        await verifyDatabase(pool, config);
        return backendStatus(pool, config);
      }
      return evidence(url);
    },
    createPrivateApi(
      pool,
      config,
      accessKeyChecker(config),
      process.env.POLICY_TERMS_HASH && process.env.POLICY_PRIVACY_HASH
        ? { terms: process.env.POLICY_TERMS_HASH, privacy: process.env.POLICY_PRIVACY_HASH }
        : null,
    ),
  );
  server.on('error', () => {
    console.error('API failed to listen');
    void pool.end();
    void readPool.end();
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
      void Promise.all([pool.end(), readPool.end()]).then(() => clearTimeout(timeout));
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid backend configuration');
  process.exitCode = 1;
}
