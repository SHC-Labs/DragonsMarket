import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { readConfig, type Config, type ContractRole } from './config.js';
import { createPool, verifyDatabase } from './database.js';
import { ReadRpcClient, RpcError } from './providers.js';
import { finalizedHead, viewAt, type View } from './chain-view.js';
import { reconcile } from './reconcile.js';
import { object } from './ingestion/block.js';
import { NeardataReader, normalizeNeardata } from './ingestion/neardata.js';

type Rpc = Pick<ReadRpcClient, 'call'>;
export interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

const MAX_HEAD_AGE_MS = 60_000;
const MAX_SOURCE_LAG_BLOCKS = 100n;
// What the follower manages against live mainnet (about 2.5 blocks a second); only used to warn about a long catch-up.
const CATCH_UP_BLOCKS_PER_SECOND = 2.5;
const LONG_CATCH_UP_HOURS = 24;
const EMPTY_CODE_HASH = '11111111111111111111111111111111';
const ROLES: readonly ContractRole[] = ['market', 'rounds', 'oracle', 'council', 'verifier'];

const ok = (name: string, detail: string): Check => ({ name, status: 'pass', detail });
const warn = (name: string, detail: string): Check => ({ name, status: 'warn', detail });
const fail = (name: string, detail: string): Check => ({ name, status: 'fail', detail });
const reason = (error: unknown) => (error instanceof Error ? error.message.slice(0, 160) : 'unknown');

async function attempt(name: string, work: () => Promise<Check[] | Check>): Promise<Check[]> {
  try {
    const result = await work();
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    return [fail(name, reason(error))];
  }
}

async function hasCode(rpc: Rpc, hash: string, account: string) {
  const result = await rpc.call('query', { request_type: 'view_account', block_id: hash, account_id: account });
  return object(result) && typeof result.code_hash === 'string' && result.code_hash !== EMPTY_CODE_HASH;
}

async function checkContract(config: Config, rpc: Rpc, view: View, hash: string, role: ContractRole, account: string): Promise<Check[]> {
  const name = `contract:${role}`;
  const deployed = await hasCode(rpc, hash, account).catch(error => {
    if (error instanceof RpcError && error.code === -32000) return false;
    throw error;
  });
  if (!deployed) return [fail(name, `${account} does not exist or has no contract deployed`)];
  if (role === 'verifier') return [ok(name, `${account} has code`)];
  const settings = await view(account, 'config', {});
  if (!object(settings)) return [fail(name, 'config view did not return an object')];
  const checks: Check[] = [];
  const d = config.deployment!;
  if (settings.verifier !== d.contracts.verifier) checks.push(fail(name, `verifier is ${String(settings.verifier)}, configured ${d.contracts.verifier}`));
  if (settings.collateral_token_id !== d.collateralTokenId)
    checks.push(fail(name, `collateral is ${String(settings.collateral_token_id)}, configured ${d.collateralTokenId}`));
  if (settings.paused === true) checks.push(warn(name, 'contract is paused'));
  if (settings.upgrade_in_flight === true) checks.push(warn(name, 'an upgrade is in flight'));
  if (!checks.length) checks.push(ok(name, `${account} state version ${String(settings.state_version)}, owner ${String(settings.owner)}`));
  return checks;
}

// Each contract names the others it works with. A wrong link makes calls fail on the chain, not here.
async function checkLinks(config: Config, view: View): Promise<Check[]> {
  const c = config.deployment!.contracts;
  const checks: Check[] = [];
  if (c.market && c.oracle) {
    const market = await view(c.market, 'config', {});
    if (object(market) && market.oracle !== c.oracle)
      checks.push(fail('link:market-oracle', `market points at ${String(market.oracle)}, configured ${c.oracle}`));
    const oracle = await view(c.oracle, 'config', {});
    if (object(oracle) && !(Array.isArray(oracle.markets) && oracle.markets.includes(c.market)))
      checks.push(fail('link:oracle-allowlist', `oracle does not allow market ${c.market}`));
  }
  if (c.council && c.oracle) {
    const council = await view(c.council, 'config', {});
    if (object(council) && council.oracle !== c.oracle)
      checks.push(fail('link:council-oracle', `council points at ${String(council.oracle)}, configured ${c.oracle}`));
    if (object(council) && c.market && !(Array.isArray(council.markets) && council.markets.includes(c.market)))
      checks.push(fail('link:council-allowlist', `council does not allow market ${c.market}`));
  }
  if (!c.market && !c.council) return [warn('links', 'not checked: no market or Council configured')];
  return checks.length ? checks : [ok('links', 'oracle, Council and market name each other')];
}

/** Everything a real run depends on, read from the live chain, the source and the database. Nothing is written. */
export async function runPreflight(config: Config, rpc: Rpc, pool: pg.Pool, source: Pick<NeardataReader, 'document'> | null): Promise<Check[]> {
  const checks: Check[] = [];
  if (!config.deployment)
    return [fail('config', 'no deployment configured: set DEPLOYMENT_ID, DEPLOYMENT_START_BLOCK, COLLATERAL_TOKEN_ID and the contract accounts')];
  const d = config.deployment;
  checks.push(config.network === 'mainnet' ? ok('network', 'mainnet') : warn('network', `${config.network}: the follower only runs on mainnet`));

  let head: Awaited<ReturnType<typeof finalizedHead>> | undefined;
  checks.push(
    ...(await attempt('rpc', async () => {
      head = await finalizedHead(config, rpc);
      const ageMs = Date.now() - Number(BigInt(head.timestampNs) / 1_000_000n);
      return ageMs > MAX_HEAD_AGE_MS
        ? warn('rpc', `finalized head ${head.height} is ${Math.round(ageMs / 1000)}s old`)
        : ok('rpc', `finalized head ${head.height}`);
    })),
  );
  if (!head) return checks;
  const finalized = head;
  const view = viewAt(rpc, finalized.hash);

  if (source) {
    checks.push(
      ...(await attempt('source', async () => {
        const latest = normalizeNeardata(await source.document('/v0/last_block/final'));
        const lag = BigInt(finalized.height) - BigInt(latest.header.height);
        return lag > MAX_SOURCE_LAG_BLOCKS || -lag > MAX_SOURCE_LAG_BLOCKS
          ? warn('source', `NEAR Data head ${latest.header.height} differs from the RPC head by ${lag} blocks`)
          : ok('source', `NEAR Data head ${latest.header.height}`);
      })),
    );
  }

  for (const role of ROLES) {
    const account = d.contracts[role];
    if (account) checks.push(...(await attempt(`contract:${role}`, () => checkContract(config, rpc, view, finalized.hash, role, account))));
  }
  checks.push(...(await attempt('links', () => checkLinks(config, view))));
  checks.push(
    ...(await attempt('reconcile', async () => {
      const report = await reconcile(config, rpc);
      return report.solvent
        ? ok('reconcile', `solvent at ${report.blockHash}`)
        : fail('reconcile', `shortfall at ${report.blockHash}: ${JSON.stringify(report.contracts.filter(c => c.shortfall !== '0'))}`);
    })),
  );

  checks.push(
    ...(await attempt('database', async () => {
      await verifyDatabase(pool, config);
      const { rows } = await pool.query('SELECT block_height::text AS height FROM indexer_checkpoints WHERE deployment_id=$1', [d.id]);
      return ok(
        'database',
        rows[0] ? `migrations current, deployment registered, checkpoint ${rows[0].height}` : 'migrations current, deployment registered, no checkpoint yet',
      );
    })),
  );

  const startGap = BigInt(finalized.height) - BigInt(d.startBlock);
  if (startGap < 0n) checks.push(fail('start-block', `start block ${d.startBlock} is ahead of the head ${finalized.height}`));
  else {
    const hours = Number(startGap) / CATCH_UP_BLOCKS_PER_SECOND / 3600;
    checks.push(
      hours > LONG_CATCH_UP_HOURS
        ? warn('start-block', `${startGap} blocks to index, about ${hours.toFixed(1)} hours to catch up`)
        : ok('start-block', `${startGap} blocks to index, about ${hours.toFixed(1)} hours`),
    );
  }
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let pool: pg.Pool | undefined;
  try {
    const config = readConfig(process.env);
    pool = createPool(config.databaseUrl);
    const rpc = new ReadRpcClient(config.rpc.primaryUrl, config.rpc, config.rpc.primaryBearerToken);
    const checks = await runPreflight(config, rpc, pool, config.network === 'mainnet' ? new NeardataReader(fetch, sleep, 400) : null);
    for (const check of checks) console.log(JSON.stringify(check));
    const failed = checks.filter(check => check.status === 'fail').length;
    console.log(JSON.stringify({ summary: failed ? 'not_ready' : 'ready', failed, warnings: checks.filter(check => check.status === 'warn').length }));
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ service: 'preflight', error: reason(error) }));
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
