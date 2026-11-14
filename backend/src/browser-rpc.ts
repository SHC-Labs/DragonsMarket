import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { isAccount, isHash } from './validate.js';
import { ReadError } from './read-api.js';

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
export const MAINNET_READ_FALLBACKS = [
  'https://free.rpc.fastnear.com', 'https://near.drpc.org', 'https://rpc.intea.rs',
  'https://rpc.shitzuapes.xyz', 'https://api.zan.top/near-mainnet',
];
export type BrowserRpc = (input: Record<string, unknown>) => Promise<unknown>;
const MAX_RESPONSE = 2 * 1024 * 1024;

function valid(method: unknown, p: unknown): p is Record<string, unknown> {
  if (!record(p)) return false;
  if (method === 'status') return Object.keys(p).length === 0;
  if (method === 'block') return only(p, ['finality']) && p.finality === 'final';
  if (method === 'EXPERIMENTAL_tx_status') return only(p, ['tx_hash', 'sender_account_id', 'wait_until'])
    && isHash(p.tx_hash) && isAccount(p.sender_account_id) && p.wait_until === 'FINAL';
  if (method !== 'query' || p.finality !== 'final' || !isAccount(p.account_id)) return false;
  if (p.request_type === 'view_account') return only(p, ['request_type', 'account_id', 'finality']);
  return p.request_type === 'call_function' && only(p, ['request_type', 'account_id', 'finality', 'method_name', 'args_base64'])
    && typeof p.method_name === 'string' && /^[a-zA-Z0-9_]{1,128}$/.test(p.method_name)
    && typeof p.args_base64 === 'string' && p.args_base64.length <= 16384
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.args_base64);
}

export function createBrowserRpc(config: Config, transport: typeof fetch = fetch): BrowserRpc {
  const fallbacks = config.network === 'mainnet' ? MAINNET_READ_FALLBACKS
    : config.network === 'testnet' ? ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'] : [];
  const providers = [{ url: config.rpc.primaryUrl, token: config.rpc.primaryBearerToken },
    ...fallbacks.filter(url => new URL(url).origin !== new URL(config.rpc.primaryUrl).origin).map(url => ({ url, token: null }))];
  const cooling = new Map<string, number>();
  const inFlight = new Map<string, Promise<Record<string, unknown>>>();
  const cache = new Map<string, { expires: number; value: Record<string, unknown>; bytes: number }>();
  let cacheBytes = 0;

  async function forward(method: string, params: Record<string, unknown>) {
    let pendingError: Record<string, unknown> | undefined;
    for (const [index, provider] of providers.entries()) {
      if ((cooling.get(provider.url) ?? 0) > Date.now()) continue;
      const id = randomUUID();
      try {
        const response = await transport(provider.url, { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(index === 0 ? 4000 : 2500),
          headers: { 'Content-Type': 'application/json', ...(provider.token ? { Authorization: `Bearer ${provider.token}` } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
        if (!response.ok) { await response.body?.cancel(); throw new Error('upstream_http'); }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for await (const chunk of response.body ?? []) {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE) throw new Error('upstream_size');
          chunks.push(chunk);
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!record(value) || value.jsonrpc !== '2.0' || value.id !== id) throw new Error('upstream_envelope');
        if (record(value.error)) {
          if (value.error.code === -32602) return { error: { code: -32602, message: 'Invalid RPC parameters.' } };
          if (record(value.error.cause) && value.error.cause.name === 'UNKNOWN_ACCOUNT')
            return { error: { code: -32000, message: 'UNKNOWN_ACCOUNT' } };
          if (record(value.error.cause) && value.error.cause.name === 'UNKNOWN_TRANSACTION') {
            pendingError = { error: { code: -32000, message: 'UNKNOWN_TRANSACTION' } };
            continue;
          }
          throw new Error('upstream_rpc');
        }
        if (!Object.hasOwn(value, 'result')) throw new Error('upstream_result');
        cooling.delete(provider.url);
        return { result: value.result };
      } catch {
        cooling.set(provider.url, Date.now() + 15000);
      }
    }
    if (pendingError) return pendingError;
    throw new ReadError(503, 'rpc_temporarily_unavailable');
  }

  return async input => {
    const params = input.method === 'status' && Array.isArray(input.params) && input.params.length === 0 ? {} : input.params;
    if (input.jsonrpc !== '2.0' || !only(input, ['jsonrpc', 'id', 'method', 'params'])
      || !(typeof input.id === 'string' && input.id.length <= 128 || Number.isSafeInteger(input.id))
      || typeof input.method !== 'string' || !valid(input.method, params)) throw new ReadError(400, 'read_rpc_request_required');
    const key = JSON.stringify([input.method, params]);
    const cached = cache.get(key);
    let value: Record<string, unknown>;
    if (cached && cached.expires > Date.now()) value = cached.value;
    else {
      let task = inFlight.get(key);
      if (!task) {
        if (inFlight.size >= 32) throw new ReadError(503, 'rpc_busy');
        task = forward(input.method, params).then(result => {
          if (Object.hasOwn(result, 'result')) {
            const bytes = Buffer.byteLength(JSON.stringify(result));
            const previous = cache.get(key);
            if (previous) { cacheBytes -= previous.bytes; cache.delete(key); }
            while (cache.size && (cache.size >= 256 || cacheBytes + bytes > 16 * 1024 * 1024)) {
              const oldest = cache.keys().next().value!;
              cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
            }
            const final = input.method === 'EXPERIMENTAL_tx_status' && record(result.result) && result.result.final_execution_status === 'FINAL';
            cache.set(key, { expires: Date.now() + (final ? 60000 : 1000), value: result, bytes }); cacheBytes += bytes;
          }
          return result;
        }).finally(() => { inFlight.delete(key); });
        inFlight.set(key, task);
      }
      value = await task;
    }
    return { jsonrpc: '2.0', id: input.id, ...value };
  };
}
