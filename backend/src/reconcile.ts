import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig, type Config } from './config.js';
import { ReadRpcClient } from './providers.js';
import { object } from './ingestion/block.js';
import { finalizedHead, viewAt, type View } from './chain-view.js';
import { createPool, verifyDatabase } from './database.js';
import { U128_MAX } from './validate.js';
const amount = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{1,39}$/.test(v) || BigInt(v) > U128_MAX) throw new Error('invalid_liability_amount');
  return BigInt(v);
};
// A payout leaves the verifier before the contract's callback books it, so what is in flight is still owed but already gone.
async function pendingOut(view: View, role: 'market' | 'rounds' | 'oracle', receiver: string) {
  const [method, field] =
    role === 'market' ? ['in_flight', 'withdrawals'] : role === 'rounds' ? ['owed_breakdown', 'pending_withdrawals'] : ['bond_totals', 'pending_payouts'];
  const result = await view(receiver, method!, {});
  if (!object(result)) throw new Error('invalid_in_flight');
  return amount(result[field!]);
}
export async function reconcile(config: Config, rpc: Pick<ReadRpcClient, 'call'>) {
  if (!config.deployment) throw new Error('deployment_not_configured');
  const head = await finalizedHead(config, rpc);
  const hash = head.hash;
  const view = viewAt(rpc, hash);
  const d = config.deployment,
    contracts = [];
  for (const role of ['market', 'rounds', 'oracle', 'council'] as const) {
    const receiver = d.contracts[role];
    if (!receiver) continue;
    let owed: bigint,
      inFlight = 0n;
    if (role === 'council') {
      const totals = await view(receiver, 'reward_totals', {});
      if (!object(totals)) throw new Error('invalid_reward_totals');
      owed = amount(totals.total_received) - amount(totals.total_paid) - amount(totals.pending_claims);
      if (owed < 0n) throw new Error('invalid_reward_accounting');
    } else {
      owed = amount(await view(receiver, 'total_owed', {}));
      inFlight = await pendingOut(view, role, receiver);
    }
    const held = amount(await view(d.contracts.verifier!, 'mt_balance_of', { account_id: receiver, token_id: d.collateralTokenId }));
    const floor = owed - inFlight;
    contracts.push({
      role,
      contract: receiver,
      owed: owed.toString(),
      inFlight: inFlight.toString(),
      held: held.toString(),
      shortfall: (held < floor ? floor - held : 0n).toString(),
      surplus: (held > owed ? held - owed : 0n).toString(),
    });
  }
  return {
    blockHash: hash,
    height: head.height,
    collateralTokenId: d.collateralTokenId,
    solvent: contracts.every(c => c.shortfall === '0'),
    contracts,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  process.on('SIGINT', () => stop.abort());
  let pool: ReturnType<typeof createPool> | undefined;
  const follow = process.argv.includes('--follow');
  try {
    const config = readConfig(process.env);
    pool = createPool(config.databaseUrl);
    await verifyDatabase(pool, config);
    const rpc = new ReadRpcClient(config.rpc.primaryUrl, config.rpc, config.rpc.primaryBearerToken);
    do {
      // One failed read must not end a follower: the next pass reads again, and monitoring raises reconciliation_stale if passes keep failing.
      try {
        const report = await reconcile(config, rpc);
        await pool.query(
          'INSERT INTO reconciliation_reports(deployment_id,block_hash,report,solvent) VALUES($1,$2,$3,$4) ON CONFLICT(deployment_id,block_hash) DO NOTHING',
          [config.deployment!.id, report.blockHash, JSON.stringify(report), report.solvent],
        );
        console.log(JSON.stringify(report));
        if (!report.solvent) process.exitCode = 1;
      } catch (error) {
        console.error(JSON.stringify({ service: 'reconcile', error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
        process.exitCode = 1;
        if (!follow) break;
      }
      if (follow) await sleep(60000, undefined, { signal: stop.signal }).catch(() => {});
    } while (follow && !stop.signal.aborted);
  } catch (error) {
    console.error(JSON.stringify({ service: 'reconcile', error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
