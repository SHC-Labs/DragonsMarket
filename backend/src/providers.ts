import { randomUUID } from 'node:crypto';
import type { Network } from './config.js';

export interface RpcSettings {
  primaryUrl: string;
  archivalUrl: string | null;
  primaryBearerToken: string | null;
  timeoutMs: number;
  intervalMs: number;
}

const defaults = {
  sandbox: { primary: 'http://127.0.0.1:3030', archive: null },
  testnet: { primary: 'https://test.rpc.fastnear.com', archive: 'https://archival-rpc.testnet.near.org' },
  mainnet: { primary: 'https://free.rpc.fastnear.com', archive: 'https://archival-rpc.mainnet.near.org' },
} as const;

function endpoint(value: string, name: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`Invalid ${name}: use a URL without credentials or query parameters`);
  return parsed.href;
}
function bounded(value: string, name: string, min: number, max: number) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}`);
  return Number(value);
}
export function readRpcSettings(env: NodeJS.ProcessEnv, network: Network): RpcSettings {
  const primaryUrl = endpoint(env.RPC_URL || defaults[network].primary, 'RPC_URL');
  const archive = env.RPC_ARCHIVAL_URL || defaults[network].archive;
  const archivalUrl = archive ? endpoint(archive, 'RPC_ARCHIVAL_URL') : null;
  const primaryBearerToken = env.RPC_PRIMARY_BEARER_TOKEN || null;
  if (primaryBearerToken && (/[\r\n]/.test(primaryBearerToken) || !primaryUrl.startsWith('https://'))) throw new Error('RPC bearer token requires HTTPS and must not contain newlines');
  return {
    primaryUrl, archivalUrl, primaryBearerToken,
    timeoutMs: bounded(env.RPC_TIMEOUT_MS || '10000', 'RPC_TIMEOUT_MS', 100, 60000),
    intervalMs: bounded(env.RPC_INTERVAL_MS || '1000', 'RPC_INTERVAL_MS', 1000, 60000),
  };
}

export class RpcError extends Error {
  constructor(public readonly code: string | number) { super(`RPC request failed (${code})`); }
}

// Only read operations are allowed in this provider diagnostic. No wallet or signing keys.
type ReadMethod = 'status' | 'block' | 'EXPERIMENTAL_indexer_block' | 'query';
export class ReadRpcClient {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  constructor(
    private readonly url: string,
    private readonly settings: Pick<RpcSettings, 'timeoutMs' | 'intervalMs'>,
    private readonly bearerToken: string | null = null,
    private readonly transport: typeof fetch = fetch,
  ) {}
  call(method: ReadMethod, params: object | unknown[]): Promise<unknown> {
    const run = this.tail.then(async () => {
      const delay = this.nextAt - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      this.nextAt = Date.now() + this.settings.intervalMs;
      const id = randomUUID();
      let response: Response;
      try {
        response = await this.transport(this.url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.settings.timeoutMs),
          headers: { 'Content-Type': 'application/json', ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        });
      } catch { throw new RpcError('transport_or_timeout'); }
      // nearcore can return JSON-RPC errors with HTTP 400, including method-not-found.
      let body: unknown;
      try { body = await response.json(); } catch { throw new RpcError(`http_${response.status}_invalid_json`); }
      if (!isObject(body) || body.id !== id || body.jsonrpc !== '2.0') throw new RpcError('invalid_envelope');
      if (isObject(body.error) && typeof body.error.code === 'number') throw new RpcError(body.error.code);
      if (!response.ok) throw new RpcError(`http_${response.status}`);
      if (!Object.hasOwn(body, 'result')) throw new RpcError('missing_result');
      return body.result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export interface ProviderReport {
  role: 'primary' | 'archive';
  networkVerified: boolean;
  finalizedBlock: { height: string; hash: string } | null;
  indexerMethod: 'not_checked' | 'unsupported' | 'responded_unverified' | 'unavailable';
  error: string | null;
}

export async function checkProvider(client: ReadRpcClient, network: Network, role: ProviderReport['role']): Promise<ProviderReport> {
  const report: ProviderReport = { role, networkVerified: false, finalizedBlock: null, indexerMethod: 'not_checked', error: null };
  try {
    const status = await client.call('status', []);
    if (!isObject(status) || typeof status.chain_id !== 'string') throw new RpcError('invalid_status');
    const matches = network === 'sandbox' ? !['mainnet', 'testnet'].includes(status.chain_id) : status.chain_id === network;
    if (!matches) throw new RpcError('network_mismatch');
    report.networkVerified = true;
    const block = await client.call('block', { finality: 'final' });
    const header = isObject(block) && isObject(block.header) ? block.header : null;
    if (!header || typeof header.hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(header.hash)) throw new RpcError('invalid_header');
    const height = header.height;
    if (!(typeof height === 'number' && Number.isSafeInteger(height) && height >= 0) && !(typeof height === 'string' && /^(0|[1-9]\d*)$/.test(height))) throw new RpcError('invalid_height');
    if (BigInt(height as string | number) > 18446744073709551615n) throw new RpcError('invalid_height');
    report.finalizedBlock = { height: String(height), hash: header.hash };
    try {
      await client.call('EXPERIMENTAL_indexer_block', { block_hash: header.hash });
      // A successful response is not proof of complete shard coverage or retained history.
      report.indexerMethod = 'responded_unverified';
    } catch (error) {
      report.indexerMethod = error instanceof RpcError && error.code === -32601 ? 'unsupported' : 'unavailable';
      if (report.indexerMethod === 'unavailable') report.error = error instanceof RpcError ? error.message : 'Indexer check failed';
    }
  } catch (error) { report.error = error instanceof RpcError ? error.message : 'Provider check failed'; }
  return report;
}
