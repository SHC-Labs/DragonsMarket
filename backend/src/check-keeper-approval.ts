import { readConfig } from './config.js';
import { createPool, verifyDatabase, verifyRuntimeLogin } from './database.js';
import { parseKeeperApproval, verifyKeeperApproval } from './keeper-approval.js';
import { requireKeeperReports } from './keeper-runner.js';
import { ReadRpcClient } from './providers.js';

async function main() {
  if (process.argv.length !== 2) throw new Error('Approval verification accepts environment configuration only');
  if (['KEEPER_KEY', 'KEEPER_ORACLE_KEY', 'KEEPER_MARKET_KEY', 'KEEPER_COUNCIL_KEY'].some(key => process.env[key]))
    throw new Error('Approval verification must not receive private signing keys');
  const config = readConfig(process.env);
  const approval = parseKeeperApproval(process.env.KEEPER_APPROVAL_JSON, process.env.KEEPER_APPROVAL_SHA256, config);
  if (!config.rpc.secondUrl || !config.rpc.secondUrl.startsWith('https:') || !config.rpc.primaryUrl.startsWith('https:'))
    throw new Error('Approval verification requires independent HTTPS RPC providers');
  const pool = createPool(config.databaseUrl, 1);
  try {
    await verifyRuntimeLogin(pool, 'dm_keeper_login');
    await verifyDatabase(pool, config);
    await requireKeeperReports(pool, approval.deployment.id);
    const head = await verifyKeeperApproval(approval, config,
      new ReadRpcClient(config.rpc.primaryUrl, config.rpc, config.rpc.primaryBearerToken),
      new ReadRpcClient(config.rpc.secondUrl, config.rpc, config.rpc.secondBearerToken));
    console.log(JSON.stringify({ service: 'keeper-approval', matches: true, deployment: approval.deployment.id,
      approvalSha256: process.env.KEEPER_APPROVAL_SHA256, block: head.hash, height: head.height, signing: false }));
  } finally { await pool.end(); }
}

main().catch(() => { console.error('Keeper approval verification failed; no transactions submitted'); process.exitCode = 1; });
