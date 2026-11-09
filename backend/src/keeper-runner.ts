import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { queuedRun, keeperFeedCurrent, setRpcPace, setRpcCredentials, type KeeperExecution, type KeeperKeys, type KeeperOptions } from '@dragons-market/keeper';
import type pg from 'pg';
import { readConfig, type Config } from './config.js';
import { createPool, verifyDatabase, verifyRuntimeLogin } from './database.js';
import { exportFeed } from './ingestion/feed.js';
import { LOCK } from './locks.js';
import { isAccount } from './validate.js';
import { ReadRpcClient } from './providers.js';
import { parseKeeperApproval, verifyKeeperApproval } from './keeper-approval.js';
import { createKeeperSigner, keeperSigningKeys } from './keeper-signer.js';

export type KeeperMode = 'prepare' | 'check' | 'sign';

export function keeperSettings(env: NodeJS.ProcessEnv, config: Config) {
  const mode = env.KEEPER_MODE ?? 'prepare';
  if (!['prepare', 'check', 'sign'].includes(mode)) throw new Error('Invalid keeper mode');
  if (config.network !== 'mainnet' || !config.deployment) throw new Error('A registered mainnet deployment is required');
  const { market, oracle, council, rounds } = config.deployment.contracts;
  if (![market, oracle, council].every(isAccount)) throw new Error('Keeper requires market, oracle and Council accounts');
  if (mode !== 'sign' && (env.KEEPER_KEY || env.KEEPER_ORACLE_KEY || env.KEEPER_MARKET_KEY || env.KEEPER_COUNCIL_KEY || env.KEEPER_ROUNDS_KEY)) {
    throw new Error('Read-only keeper preparation must not receive signing keys');
  }
  const approval = mode === 'sign' ? parseKeeperApproval(env.KEEPER_APPROVAL_JSON, env.KEEPER_APPROVAL_SHA256, config) : null;
  if (approval && (!config.rpc.secondUrl || !config.rpc.secondUrl.startsWith('https:') || !config.rpc.primaryUrl.startsWith('https:')))
    throw new Error('Signing requires two independent HTTPS RPC providers');
  const options: KeeperOptions = {
    rpc: [config.rpc.primaryUrl, config.rpc.secondUrl].filter(Boolean).join(','),
    market: market!, oracle: oracle!, council: council!,
    ...(rounds ? { rounds } : {}),
    'state-file': `.local/feeds/${config.deployment.id}.queue.json`,
    'events-file': `.local/feeds/${config.deployment.id}.jsonl`,
    'require-live-feed': true, 'require-scoped-keys': true, workers: 1, 'job-batch': approval ? 1 : 50,
    ...(approval ? { account: approval.keeper.accountId } : {}),
  };
  return { mode: mode as KeeperMode, options, approval };
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
  run: typeof queuedRun = queuedRun, signing?: () => { keys: KeeperKeys; execution: KeeperExecution }) {
  if ((mode === 'sign') !== Boolean(signing)) throw new Error('Keeper signing execution must match its mode');
  return withKeeperLock(pool, config.deployment!.id, async () => {
    const deployment = config.deployment!.id;
    await pool.query(`INSERT INTO keeper_status(deployment_id,mode,state) VALUES($1,$2,'running')
      ON CONFLICT(deployment_id) DO UPDATE SET mode=excluded.mode,state='running',started_at=now(),finished_at=NULL`, [deployment, mode]);
    try {
      const report = await keeperPass(pool, config, options, mode, run, signing);
      await pool.query(`UPDATE keeper_status SET state=$2,height=$3,finished_at=now(),
        last_success_at=CASE WHEN $4 THEN now() ELSE last_success_at END WHERE deployment_id=$1`,
      [deployment, report.current ? 'ready' : 'catching_up', report.height, report.current]);
      return report;
    } catch (error) {
      await pool.query(`UPDATE keeper_status SET state='failed',finished_at=now() WHERE deployment_id=$1`, [deployment]).catch(() => {});
      throw error;
    }
  });
}

async function keeperPass(pool: pg.Pool, config: Config, options: KeeperOptions, mode: KeeperMode,
  run: typeof queuedRun, signing?: () => { keys: KeeperKeys; execution: KeeperExecution }) {
  let exported = 0;
  for (let batch = 0; batch < 50; batch++) {
    const result = await exportFeed(pool, config.deployment!.id, options['events-file'], 100);
    exported += result.exported;
    if (result.exported < 100) break;
  }
  const preparation = await run({ ...options, 'prepare-feed': true }, {});
  if (mode === 'sign' && preparation.current) {
    const signer = signing!();
    const result = await run(options, signer.keys, signer.execution);
    return { mode, exported, current: result.current !== false, height: result.state.cursor?.height ?? null,
      dueActions: result.actions.length, signing: result.current !== false };
  }
  if (mode === 'check' && preparation.current) {
    const checked = await run({ ...options, 'dry-run': true }, {});
    return { mode, exported, current: checked.current !== false, height: checked.state.cursor?.height ?? null,
      dueActions: checked.actions.length, signing: false };
  }
  return { mode, exported, current: preparation.current === true,
    height: preparation.state.cursor?.height ?? null, signing: false };
}

export async function requireKeeperReports(pool: pg.Pool, deployment: string) {
  const { rows } = await pool.query(`SELECT
    (SELECT solvent AND checked_at > now() - interval '15 minutes' AND checked_at <= now()
      FROM reconciliation_reports WHERE deployment_id=$1 ORDER BY checked_at DESC LIMIT 1) AS solvent,
    (SELECT ok AND checked_at > now() - interval '13 hours' AND checked_at <= now()
      FROM chain_integrity_reports WHERE deployment_id=$1 ORDER BY checked_at DESC LIMIT 1) AS intact`, [deployment]);
  if (rows[0]?.solvent !== true || rows[0]?.intact !== true) throw new Error('Keeper requires current successful reconciliation and integrity reports');
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Keeper runner accepts configuration through environment variables only');
  if (process.getuid?.() === 0) throw new Error('Keeper must run as a non-root user');
  const config = readConfig(process.env);
  const { mode, options, approval } = keeperSettings(process.env, config);
  setRpcPace(config.rpc.intervalMs);
  const credentials: [string, string][] = [];
  if (config.rpc.primaryBearerToken) credentials.push([config.rpc.primaryUrl, config.rpc.primaryBearerToken]);
  if (config.rpc.secondUrl && config.rpc.secondBearerToken) credentials.push([config.rpc.secondUrl, config.rpc.secondBearerToken]);
  setRpcCredentials(credentials);
  const pool = createPool(config.databaseUrl, 2);
  const timeout = setTimeout(() => { console.error('Keeper exceeded its runtime limit'); process.exit(1); }, mode === 'sign' ? 600000 : 180000);
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
    let signing: (() => { keys: KeeperKeys; execution: KeeperExecution }) | undefined;
    if (approval) {
      const primary = new ReadRpcClient(config.rpc.primaryUrl, config.rpc, config.rpc.primaryBearerToken);
      const secondary = new ReadRpcClient(config.rpc.secondUrl!, config.rpc, config.rpc.secondBearerToken);
      const keys = keeperSigningKeys(process.env, approval);
      const verify = async () => {
        await requireKeeperReports(pool, config.deployment!.id);
        const head = await verifyKeeperApproval(approval, config, primary, secondary);
        if (!keeperFeedCurrent(options, { height: head.height, hash: head.hash, timestamp_nanosec: head.timestampNs }))
          throw new Error('Keeper feed became stale before signing');
      };
      signing = () => ({ keys, execution: createKeeperSigner({ approval, options, keys, primary, secondary, verify,
        journalFile: `.local/feeds/${config.deployment!.id}.submission.json` }) });
    }
    console.log(JSON.stringify({ service: 'keeper', ...await prepareKeeper(pool, config, options, mode, queuedRun, signing) }));
  } finally { clearTimeout(timeout); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Keeper failed; verify approval, reports, journal, role, feed, RPC and key permissions'); process.exitCode = 1; });
}
