import { isIP } from 'node:net';
import { base58Decode, base58Encode } from './base58.js';
import { readRpcSettings, type RpcSettings } from './providers.js';
import { isAccount, isUnits } from './validate.js';

export type Network = 'sandbox' | 'testnet' | 'mainnet';
export type ContractRole = 'market' | 'rounds' | 'oracle' | 'council' | 'verifier';
export interface AgentWorkerLink { url: string; token: string }
export interface RelaySettings { accountId: string; key: string; minFee: bigint; maxFee: bigint; swapCostBps: bigint; keyAllowanceAlert: bigint }
export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  webOrigin: string;
  trustedProxyHops: number;
  trustedProxyAddresses: string[];
  trustedProxyHeader: 'x-forwarded-for' | 'x-real-ip';
  operatorToken: string | null;
  sessionAbsoluteSeconds: number;
  sessionIdleSeconds: number;
  network: Network;
  rpc: RpcSettings;
  agentWorker: AgentWorkerLink | null;
  relay: RelaySettings | null;
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
// 0.10 USDC per action. The automatic fee is about 0.009 at $3 a NEAR and the minimum gas price, so this cap is reached only
// at 11x either, and it is also what an action costs after an hour with no price, which is an overcharge users can bear.
const DEFAULT_RELAY_MAX_FEE = '100000';
// Converting collected USDC back into NEAR costs about 0.5-1% (1Click surcharge without a partner key, solver spread, one
// withdrawal per batch). 1.5% leaves room above that.
const DEFAULT_RELAY_SWAP_COST_BPS = '150';
const DEFAULT_KEY_ALLOWANCE_ALERT_NEAR = '1';
const YOCTO_PER_NEAR = 10n ** 24n;
const MAX_RELAY_SWAP_COST_BPS = 2000;
const PRIVATE_HOST = /^(127\.0\.0\.1|[a-z0-9-]+|[a-z0-9.-]+\.internal)$/;

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

export function agentWorkerToken(value: string | undefined) {
  if (!value || value.length < MIN_OPERATOR_TOKEN_LENGTH) throw new Error('AGENT_WORKER_TOKEN must be at least 32 characters');
  return value;
}

function readAgentWorkerLink(env: NodeJS.ProcessEnv): AgentWorkerLink | null {
  if (env.AGENT_API_KEY || env.AGENT_GRANT_KEY) {
    throw new Error('AGENT_API_KEY and AGENT_GRANT_KEY belong to the agent worker, never to this process');
  }
  if (!env.AGENT_WORKER_URL && !env.AGENT_WORKER_TOKEN) return null;
  const link = url(env.AGENT_WORKER_URL ?? '', 'AGENT_WORKER_URL', ['http:', 'https:']);
  if (link.origin !== env.AGENT_WORKER_URL) throw new Error('AGENT_WORKER_URL must be an exact origin');
  if (link.protocol === 'http:' && !PRIVATE_HOST.test(link.hostname)) {
    throw new Error('AGENT_WORKER_URL must be https outside a private network');
  }
  return { url: link.origin, token: agentWorkerToken(env.AGENT_WORKER_TOKEN) };
}

function keyAllowanceAlert(env: NodeJS.ProcessEnv): bigint {
  const value = env.RELAY_KEY_ALLOWANCE_ALERT_NEAR || DEFAULT_KEY_ALLOWANCE_ALERT_NEAR;
  if (!/^\d{1,9}(\.\d{1,24})?$/.test(value)) throw new Error('Invalid RELAY_KEY_ALLOWANCE_ALERT_NEAR: an amount of NEAR such as 1 or 0.5');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, '0'));
}

function readRelay(env: NodeJS.ProcessEnv, deployment: Config['deployment']): RelaySettings | null {
  const { RELAYER_ACCOUNT_ID: accountId, RELAYER_KEY: key, RELAY_MIN_FEE: minFee } = env;
  const maxFee = env.RELAY_MAX_FEE || DEFAULT_RELAY_MAX_FEE;
  if (env.RELAY_TREASURY_KEY || env.RELAY_TOPUP_SUBMIT_KEY) throw new Error('RELAY_TREASURY_KEY and RELAY_TOPUP_SUBMIT_KEY belong to the relay top-up job, never to this process');
  if (!accountId && !key && !minFee) return null;
  if (!accountId || !key || !minFee) throw new Error('RELAYER_ACCOUNT_ID, RELAYER_KEY and RELAY_MIN_FEE are set together');
  if (!isAccount(accountId)) throw new Error('Invalid RELAYER_ACCOUNT_ID');
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(key) || base58Decode(key.slice(8)).length !== 64) throw new Error('RELAYER_KEY must be an ed25519 secret key');
  if (env.RELAYER_PUBLIC_KEY && env.RELAYER_PUBLIC_KEY !== 'ed25519:' + base58Encode(base58Decode(key.slice(8)).subarray(32))) {
    throw new Error('RELAYER_KEY does not match RELAYER_PUBLIC_KEY');
  }
  if (!isUnits(minFee) || minFee === '0') throw new Error('Invalid RELAY_MIN_FEE');
  if (!isUnits(maxFee) || BigInt(maxFee) < BigInt(minFee)) throw new Error('Invalid RELAY_MAX_FEE: it must be a whole number of collateral units, at least RELAY_MIN_FEE');
  if (!deployment?.contracts.verifier || !deployment.contracts.market) throw new Error('The relay needs a deployment with a verifier and a market');
  if (Object.values(deployment.contracts).includes(accountId)) throw new Error('RELAYER_ACCOUNT_ID must not be one of the deployment contracts');
  const swapCostBps = env.RELAY_SWAP_COST_BPS || DEFAULT_RELAY_SWAP_COST_BPS;
  if (!/^\d{1,4}$/.test(swapCostBps) || Number(swapCostBps) > MAX_RELAY_SWAP_COST_BPS) {
    throw new Error(`Invalid RELAY_SWAP_COST_BPS: a whole number of basis points from 0 to ${MAX_RELAY_SWAP_COST_BPS}`);
  }
  return { accountId, key, minFee: BigInt(minFee), maxFee: BigInt(maxFee), swapCostBps: BigInt(swapCostBps), keyAllowanceAlert: keyAllowanceAlert(env) };
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
  const trustedProxyHeader = env.TRUSTED_PROXY_HEADER || 'x-forwarded-for';
  if (trustedProxyHeader !== 'x-forwarded-for' && trustedProxyHeader !== 'x-real-ip') throw new Error('Invalid TRUSTED_PROXY_HEADER');
  if (trustedProxyHeader === 'x-real-ip' && trustedProxyHops !== 1) throw new Error('X-Real-IP requires exactly one trusted proxy hop');
  const operatorToken = env.OPERATOR_TOKEN || null;
  if (operatorToken !== null && operatorToken.length < MIN_OPERATOR_TOKEN_LENGTH) throw new Error('OPERATOR_TOKEN must be at least 32 characters');
  const sessionAbsoluteSeconds = integer(env.SESSION_ABSOLUTE_SECONDS || String(DEFAULT_SESSION_ABSOLUTE_SECONDS), 'SESSION_ABSOLUTE_SECONDS', MIN_SESSION_SECONDS, MAX_SESSION_SECONDS);
  const sessionIdleSeconds = integer(env.SESSION_IDLE_SECONDS || String(DEFAULT_SESSION_IDLE_SECONDS), 'SESSION_IDLE_SECONDS', MIN_SESSION_SECONDS, MAX_SESSION_SECONDS);
  if (sessionIdleSeconds > sessionAbsoluteSeconds) throw new Error('SESSION_IDLE_SECONDS cannot exceed SESSION_ABSOLUTE_SECONDS');
  return {
    databaseUrl, network, rpc, agentWorker: readAgentWorkerLink(env), relay: readRelay(env, deployment), host, port, webOrigin, trustedProxyHops,
    trustedProxyAddresses, trustedProxyHeader, operatorToken, sessionAbsoluteSeconds, sessionIdleSeconds, deployment,
  };
}

function wholeUnits(deployment: NonNullable<Config['deployment']>, one: bigint, daily: bigint) {
  const unit = 10n ** BigInt(deployment.collateralDecimals);
  return { perTransaction: String(one * unit), daily: String(daily * unit) };
}
export const agentCashOut = (deployment: NonNullable<Config['deployment']>) => wholeUnits(deployment, 100n, 500n);
export const agentSpend = (deployment: NonNullable<Config['deployment']>) => wholeUnits(deployment, 100n, 1000n);

// Deliberate allowlist: never spread process.env or expose database credentials.
export function publicConfig(config: Config) {
  return {
    apiVersion: 'v1', network: config.network, deployment: config.deployment,
    agentCashOut: config.deployment && agentCashOut(config.deployment),
    agentSpend: config.deployment && agentSpend(config.deployment),
    capabilities: { trading: false, funding: false, indexing: config.network === 'mainnet' && config.deployment !== null, walletSessions: true,
      agents: config.agentWorker !== null && config.deployment !== null },
  };
}
