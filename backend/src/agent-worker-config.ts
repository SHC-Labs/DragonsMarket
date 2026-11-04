import { readAgentApiSettings, type AgentApiSettings } from './agent-api.js';
import { agentWorkerToken, readConfig, type Config } from './config.js';
import { isAccount } from './validate.js';

export interface AgentWorkerConfig {
  shared: Config;
  deployment: NonNullable<Config['deployment']>;
  agentApi: AgentApiSettings;
  grantKey: Buffer;
  walletContract: string;
  host: string;
  port: number;
  token: string;
}

function readGrantKey(key: string | undefined) {
  const grantKey = Buffer.from(key ?? '', 'base64');
  if (grantKey.length !== 32 || grantKey.toString('base64') !== key) {
    throw new Error('AGENT_GRANT_KEY must be 32 bytes of base64');
  }
  return grantKey;
}

function readPort(value: string) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Invalid AGENT_WORKER_PORT');
  return Number(value);
}

export function readAgentWorkerConfig(env: NodeJS.ProcessEnv): AgentWorkerConfig {
  const { AGENT_API_KEY, AGENT_GRANT_KEY, AGENT_WORKER_TOKEN, AGENT_WORKER_URL, ...rest } = env;
  const shared = readConfig(rest), { deployment } = shared;
  if (!deployment) throw new Error('The agent worker needs a deployment');
  const agentApi = readAgentApiSettings(env);
  if (!agentApi) throw new Error('The agent worker needs AGENT_API_URL and AGENT_API_KEY');
  const walletContract = env.AGENT_API_WALLET_CONTRACT ?? '';
  if (!isAccount(walletContract) || ['intents.near', 'intents.far'].includes(walletContract)) {
    throw new Error('Invalid AGENT_API_WALLET_CONTRACT');
  }
  return { shared, deployment, agentApi, grantKey: readGrantKey(AGENT_GRANT_KEY), walletContract,
    host: env.AGENT_WORKER_HOST || '127.0.0.1', port: readPort(env.AGENT_WORKER_PORT || '3510'),
    token: agentWorkerToken(AGENT_WORKER_TOKEN) };
}
