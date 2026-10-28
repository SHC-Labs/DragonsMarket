import { readConfig } from '../config.js';
import { createPool, verifyDatabase } from '../database.js';
import { IngestionError } from './block.js';
import { FixtureSource } from './source.js';
import { registerDeployment, ingestionStatus } from './store.js';
import { ingest } from './engine.js';

let pool: ReturnType<typeof createPool> | undefined;
try {
  const config = readConfig(process.env);
  const [command, path, ...extra] = process.argv.slice(2);
  if (!config.deployment) throw new IngestionError('deployment_required');
  if (!['register', 'replay', 'status'].includes(command ?? '') || extra.length || (command === 'replay' ? !path : path !== undefined)) throw new IngestionError('usage_register_or_replay_file_or_status');
  pool = createPool(config.databaseUrl);
  // Registration runs before the deployment identity check, but never before schema checks.
  await verifyDatabase(pool, { ...config, deployment: null });
  if (command === 'register') {
    await registerDeployment(pool, config);
    console.log(JSON.stringify({ deploymentId: config.deployment.id, registered: true }));
  } else {
    await verifyDatabase(pool, config);
    const result = command === 'replay' ? await ingest(pool, config, new FixtureSource(path!)) : await ingestionStatus(pool, config);
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof IngestionError ? error.code : 'configuration_or_database_error' }));
  process.exitCode = 1;
} finally { await pool?.end(); }
