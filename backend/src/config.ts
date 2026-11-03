import { isIP } from 'node:net';
import { readRpcSettings, type RpcSettings } from './providers.js';
import { readAgentApiSettings, type AgentApiSettings } from './agent-api.js';
import { isAccount } from './validate.js';

export type Network = 'sandbox' | 'testnet' | 'mainnet';
export type ContractRole = 'market' | 'rounds' | 'oracle' | 'council' | 'verifier';
export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  webOrigin: string;
  trustedProxyHops: number;
  trustedProxyAddresses: string[];
  operatorToken: string | null;
  sessionAbsoluteSeconds: number;
  sessionIdleSeconds: number;
  network: Network;
  rpc: RpcSettings;
  agentApi: AgentApiSettings | null;
  agentAccounts: { grantKey: Buffer; walletContract: string } | null;
  deployment: null | {
    id: string;
    startBlock: string;
    contracts: Partial<Record<ContractRole, string>>;
    collateralTokenId: string;
    collateralDecimals: number;
  };
}

const DEFAULT_SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600;
const DEFAULT_SESSION_IDLE_SECONDS = 12 * 3600;
const MIN_SESSION_SECONDS = 300;
const MAX_SESSION_SECONDS = 30 * 24 * 3600;
const MIN_OPERATOR_TOKEN_LENGTH = 32;

function integer(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}`);
  return Number(value);
}
function url(value: string, name: string, protocols: string[]): URL {
  let result: URL;
  try { result = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  if (!protocols.includes(result.protocol) || !result.hostname) throw new Error(`Invalid ${name}`);
  return result;
}

function readAgentAccounts(env: NodeJS.ProcessEnv, agentApi: AgentApiSettings | null): Config['agentAccounts'] {
  const key = env.AGENT_GRANT_KEY, walletContract = env.AGENT_API_WALLET_CONTRACT;
  if (!key && !walletContract) return null;
  if (!key || !walletContract || !agentApi) {
    throw new Error('AGENT_GRANT_KEY and AGENT_API_WALLET_CONTRACT go together, with AGENT_API_URL and AGENT_API_KEY');
  }
  const grantKey = Buffer.from(key, 'base64');
  if (grantKey.length !== 32 || grantKey.toString('base64') !== key) {
    throw new Error('AGENT_GRANT_KEY must be 32 bytes of base64');
  }
  if (!isAccount(walletContract) || ['intents.near', 'intents.far'].includes(walletContract)) {
    throw new Error('Invalid AGENT_API_WALLET_CONTRACT');
  }
  return { grantKey, walletContract };
}

export function readNetwork(env: NodeJS.ProcessEnv): Network {
  const network = env.NETWORK || 'sandbox';
  if (!['sandbox', 'testnet', 'mainnet'].includes(network)) throw new Error('Invalid NETWORK');
  return network as Network;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const databaseUrl = env.DATABASE_URL ?? '';
  url(databaseUrl, 'DATABASE_URL', ['postgres:', 'postgresql:']);
  const network = readNetwork(env);
  const rpc = readRpcSettings(env, network);
  const host = env.HOST || '127.0.0.1';
  const port = integer(env.PORT || '3500', 'PORT', 1, 65535);
  const webOrigin = env.WEB_ORIGIN || 'http://localhost:3400';
  const origin = url(webOrigin, 'WEB_ORIGIN', ['http:', 'https:']);
  if (origin.origin !== webOrigin || origin.username || origin.password) throw new Error('WEB_ORIGIN must be an exact origin');
  const contracts: Partial<Record<ContractRole, string>> = {};
  for (const role of ['market', 'rounds', 'oracle', 'council', 'verifier'] as const) {
    const value = env[`${role.toUpperCase()}_CONTRACT_ID`];
    if (!value) continue;
    if (value.length < 2 || value.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) throw new Error(`Invalid ${role} contract account`);
    if (network === 'mainnet' && value.endsWith('.testnet')) throw new Error('Testnet account configured for mainnet');
    if (network === 'testnet' && value.endsWith('.near')) throw new Error('Mainnet account configured for testnet');
    contracts[role] = value;
  }
  const deploymentValues = [env.DEPLOYMENT_ID, env.DEPLOYMENT_START_BLOCK, env.COLLATERAL_TOKEN_ID];
  const configured = deploymentValues.some(Boolean) || Object.keys(contracts).length > 0;
  let deployment: Config['deployment'] = null;
  if (configured) {
    if (deploymentValues.some(v => !v) || !contracts.verifier || (!contracts.market && !contracts.rounds)) {
      throw new Error('Deployment requires ID, start block, collateral, verifier and a market or rounds contract');
    }
    const id = env.DEPLOYMENT_ID!;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid DEPLOYMENT_ID');
    const startBlock = env.DEPLOYMENT_START_BLOCK!;
    if (!/^(0|[1-9]\d*)$/.test(startBlock) || BigInt(startBlock) > 18446744073709551615n) throw new Error('Invalid DEPLOYMENT_START_BLOCK');
    const collateralTokenId = env.COLLATERAL_TOKEN_ID!;
    if (!/^nep141:[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(collateralTokenId) || collateralTokenId.length > 71) throw new Error('Invalid COLLATERAL_TOKEN_ID');
    deployment = { id, startBlock, contracts, collateralTokenId, collateralDecimals: integer(env.COLLATERAL_DECIMALS || '6', 'COLLATERAL_DECIMALS', 0, 38) };
  }
  const trustedProxyHops = integer(env.TRUSTED_PROXY_HOPS || '0', 'TRUSTED_PROXY_HOPS', 0, 5);
  const trustedProxyAddresses = (env.TRUSTED_PROXY_ADDRESSES || '').split(',').map(entry => entry.trim()).filter(Boolean);
  for (const entry of trustedProxyAddresses) {
    const [address = '', prefix] = entry.split('/');
    const version = isIP(address);
    if (!version || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (version === 6 ? 128 : 32)))) throw new Error('Invalid TRUSTED_PROXY_ADDRESSES');
  }
  if (trustedProxyHops > 0 && !trustedProxyAddresses.length) throw new Error('TRUSTED_PROXY_HOPS needs TRUSTED_PROXY_ADDRESSES: the addresses the proxy connects from');
  const operatorToken = env.OPERATOR_TOKEN || null;
  if (operatorToken !== null && operatorToken.length < MIN_OPERATOR_TOKEN_LENGTH) throw new Error('OPERATOR_TOKEN must be at least 32 characters');
  const sessionAbsoluteSeconds = integer(env.SESSION_ABSOLUTE_SECONDS || String(DEFAULT_SESSION_ABSOLUTE_SECONDS), 'SESSION_ABSOLUTE_SECONDS', MIN_SESSION_SECONDS, MAX_SESSION_SECONDS);
  const sessionIdleSeconds = integer(env.SESSION_IDLE_SECONDS || String(DEFAULT_SESSION_IDLE_SECONDS), 'SESSION_IDLE_SECONDS', MIN_SESSION_SECONDS, MAX_SESSION_SECONDS);
  if (sessionIdleSeconds > sessionAbsoluteSeconds) throw new Error('SESSION_IDLE_SECONDS cannot exceed SESSION_ABSOLUTE_SECONDS');
  const agentApi = readAgentApiSettings(env);
  return {
    databaseUrl, network, rpc, agentApi, agentAccounts: readAgentAccounts(env, agentApi), host, port, webOrigin,
    trustedProxyHops, trustedProxyAddresses, operatorToken, sessionAbsoluteSeconds, sessionIdleSeconds, deployment,
  };
}

// Deliberate allowlist: never spread process.env or expose database credentials.
export function publicConfig(config: Config) {
  return {
    apiVersion: 'v1', network: config.network, deployment: config.deployment,
    capabilities: { trading: false, funding: false, indexing: config.network === 'mainnet' && config.deployment !== null, walletSessions: true,
      agents: config.agentApi !== null && config.agentAccounts !== null && config.deployment !== null },
  };
}
