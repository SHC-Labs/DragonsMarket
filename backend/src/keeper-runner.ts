import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { queuedRun, setRpcPace, setRpcCredentials, type KeeperKeys, type KeeperOptions } from '@dragons-market/keeper';
import type pg from 'pg';
import { readConfig, type Config } from './config.js';
import { createPool, verifyDatabase, verifyRuntimeLogin } from './database.js';
import { exportFeed } from './ingestion/feed.js';
import { LOCK } from './locks.js';
import { isAccount } from './validate.js';

export type KeeperMode = 'prepare' | 'check';

export function keeperSettings(env: NodeJS.ProcessEnv, config: Config) {
  const mode = env.KEEPER_MODE ?? 'prepare';
  if (mode !== 'prepare' && mode !== 'check') throw new Error('Keeper signing is not enabled in this release');
  if (config.network !== 'mainnet' || !config.deployment) throw new Error('A registered mainnet deployment is required');
  const { market, oracle, council } = config.deployment.contracts;
  if (![market, oracle, council].every(isAccount)) throw new Error('Keeper requires market, oracle and Council accounts');
  if (env.KEEPER_KEY || env.KEEPER_ORACLE_KEY || env.KEEPER_MARKET_KEY || env.KEEPER_COUNCIL_KEY) {
    throw new Error('Read-only keeper preparation must not receive signing keys');
  }
  const options: KeeperOptions = {
    rpc: [config.rpc.primaryUrl, config.rpc.secondUrl].filter(Boolean).join(','),
    market: market!, oracle: oracle!, council: council!,
    'state-file': `.local/feeds/${config.deployment.id}.queue.json`,
    'events-file': `.local/feeds/${config.deployment.id}.jsonl`,
    'require-live-feed': true, 'require-scoped-keys': true, workers: 1, 'job-batch': 50,
  };
  return { mode: mode as KeeperMode, options };
}

export async function withKeeperLock<T>(pool: pg.Pool, deployment: string, work: () => Promise<T>,
  lost: () => void = () => process.exit(1)): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  const onError = () => { console.error('Keeper database lock connection lost'); lost(); };
  client.on('error', onError);
  try {
    locked = (await client.query(`SELECT pg_try_advisory_lock(${LOCK.keeper},hashtext($1)) AS locked`, [deployment])).rows[0].locked === true;
    if (!locked) throw new Error('Another keeper runner owns this deployment');
    return await work();
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock(${LOCK.keeper},hashtext($1))`, [deployment]).catch(() => {});
    client.off('error', onError);
    client.release();
  }
}

export async function prepareKeeper(pool: pg.Pool, config: Config, options: KeeperOptions, mode: KeeperMode,
  run: (options: KeeperOptions, keys: KeeperKeys) => ReturnType<typeof queuedRun> = queuedRun) {
  return withKeeperLock(pool, config.deployment!.id, async () => {
    let exported = 0;
    for (let batch = 0; batch < 50; batch++) {
      const result = await exportFeed(pool, config.deployment!.id, options['events-file'], 100);
      exported += result.exported;
      if (result.exported < 100) break;
    }
    const preparation = await run({ ...options, 'prepare-feed': true }, {});
    if (mode === 'check' && preparation.current) {
      const checked = await run({ ...options, 'dry-run': true }, {});
      return { mode, exported, current: checked.current !== false, height: checked.state.cursor?.height ?? null,
        dueActions: checked.actions.length, signing: false };
    }
    return { mode, exported, current: preparation.current === true,
      height: preparation.state.cursor?.height ?? null, signing: false };
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Keeper runner accepts configuration through environment variables only');
  if (process.getuid?.() === 0) throw new Error('Keeper must run as a non-root user');
  const config = readConfig(process.env);
  const { mode, options } = keeperSettings(process.env, config);
  setRpcPace(config.rpc.intervalMs);
  const credentials: [string, string][] = [];
  if (config.rpc.primaryBearerToken) credentials.push([config.rpc.primaryUrl, config.rpc.primaryBearerToken]);
  if (config.rpc.secondUrl && config.rpc.secondBearerToken) credentials.push([config.rpc.secondUrl, config.rpc.secondBearerToken]);
  setRpcCredentials(credentials);
  const pool = createPool(config.databaseUrl, 2);
  const timeout = setTimeout(() => { console.error('Keeper preparation exceeded its three-minute limit'); process.exit(1); }, 180000);
  timeout.unref();
  try {
    await verifyRuntimeLogin(pool, 'dm_keeper_login');
    await verifyDatabase(pool, config);
    const { rows } = await pool.query(`SELECT current_user = 'dm_keeper_login' AND NOT rolsuper AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
      AND NOT has_table_privilege(current_user, 'wallet_sessions', 'SELECT')
      AND NOT has_table_privilege(current_user, 'agent_grants', 'SELECT') AS restricted
      FROM pg_roles WHERE rolname = current_user`);
    if (rows[0]?.restricted !== true) throw new Error('Keeper requires its dedicated restricted database login');
    console.log(JSON.stringify({ service: 'keeper', ...await prepareKeeper(pool, config, options, mode) }));
  } finally { clearTimeout(timeout); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Keeper preparation failed; verify its manifest, database role, feed and RPC'); process.exitCode = 1; });
}
