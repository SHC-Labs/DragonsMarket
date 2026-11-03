import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig } from './config.js';
import { createPool, verifyDatabase } from './database.js';
import { ReadRpcClient } from './providers.js';
import { AgentApiClient, type AgentGrant } from './agent-api.js';
import { InvalidAction, finalTransaction, finalView, parseAgentAction, runAgentAction,
  type AgentAction } from './agents.js';
import { operationStore } from './operations.js';

const USAGE = 'npm run agent -- <register-token | register rounds|market | fund | deposit | stake | buy | claim'
  + ' | redeem | withdraw rounds|market | cash-out> --key <idempotency key>'
  + ' [--series --round --side --amount --min-shares --market --recipient]';
const FIELDS: Record<string, string> = {
  series: 'series', round: 'round', side: 'side', amount: 'amount', 'min-shares': 'minShares', market: 'market',
  recipient: 'recipient',
};

function flags(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!name?.startsWith('--') || value === undefined || values.has(name.slice(2))) throw new Error(USAGE);
    values.set(name.slice(2), value);
  }
  return values;
}

export function parseAction(argv: string[]): { key: string; action: AgentAction } {
  const [kind = '', ...rest] = argv;
  const raw: Record<string, unknown> = { kind: kind.replace('-', '_') };
  if (kind === 'register' || kind === 'withdraw') raw.contract = rest.shift();
  const values = flags(rest), key = values.get('key');
  if (!key) throw new Error('--key is required');
  for (const [flag, value] of values) {
    if (flag === 'key') continue;
    const field = FIELDS[flag];
    if (!field) throw new Error(USAGE);
    raw[field] = field === 'series' && /^\d+$/.test(value) ? Number(value) : value;
  }
  try {
    return { key, action: parseAgentAction(raw) };
  } catch (error) {
    throw error instanceof InvalidAction ? new Error(`${error.message}\n${USAGE}`) : error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    const config = readConfig(process.env);
    if (!config.deployment || !config.agentApi) {
      throw new Error('A deployment and AGENT_API_URL/AGENT_API_KEY are required');
    }
    const grant: AgentGrant = { agentId: process.env.AGENT_ID ?? '', token: process.env.AGENT_GRANT_TOKEN ?? '' };
    const { key, action } = parseAction(process.argv.slice(2));
    pool = createPool(config.databaseUrl);
    await verifyDatabase(pool, config);
    const api = new AgentApiClient(config.agentApi);
    const rpc = new ReadRpcClient(config.rpc.primaryUrl, config.rpc, config.rpc.primaryBearerToken);
    const agent = (await api.wallet(grant.agentId)).near_account_id;
    const result = await runAgentAction({
      deployment: config.deployment, api, view: finalView(rpc), waitMs: 120000,
      transaction: (hash, sender) => finalTransaction(rpc, hash, sender),
      operations: operationStore(pool, config.deployment.id),
    }, grant, { agent, key, action });
    console.log(JSON.stringify(result));
    if (result.state !== 'confirmed') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'agent_action_unavailable');
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
