import { readRpcSettings, type RpcSettings } from './providers.js';

export type Network = 'sandbox' | 'testnet' | 'mainnet';
export type ContractRole = 'market' | 'rounds' | 'oracle' | 'council' | 'verifier';
export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  webOrigin: string;
  network: Network;
  rpc: RpcSettings;
  deployment: null | {
    id: string;
    startBlock: string;
    contracts: Partial<Record<ContractRole, string>>;
    collateralTokenId: string;
    collateralDecimals: number;
  };
}

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
  return { databaseUrl, network, rpc, host, port, webOrigin, deployment };
}

// Deliberate allowlist: never spread process.env or expose database credentials.
export function publicConfig(config: Config) {
  return {
    apiVersion: 'v1', network: config.network, deployment: config.deployment,
    capabilities: { trading: false, funding: false, indexing: config.network === 'mainnet' && config.deployment !== null, walletSessions: true },
  };
}
