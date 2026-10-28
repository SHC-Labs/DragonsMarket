import type {Config} from './config.js';
import type {CheckAccessKey} from './auth.js';
import {object} from './ingestion/block.js';

const RPC_TIMEOUT_MS = 10000;
const CHAIN_CACHE_MS = 5 * 60 * 1000;

/** Confirms the key is a FullAccess key on the account at final state. A missing key is false; an RPC outage throws, so it is not mistaken for a bad signature. */
export function accessKeyChecker(config: Config): CheckAccessKey {
  let chainVerifiedAt = 0;
  const rpc = async (id: string, method: string, params: unknown) => {
    const response = await fetch(config.rpc.primaryUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', ...(config.rpc.primaryBearerToken ? { Authorization: `Bearer ${config.rpc.primaryBearerToken}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const body: unknown = await response.json();
    if (!object(body)) throw new Error('rpc_unavailable');
    return { ok: response.ok, body };
  };
  const verifyChain = async () => {
    if (Date.now() - chainVerifiedAt < CHAIN_CACHE_MS) return;
    const { ok, body } = await rpc('network', 'status', {});
    const chain = object(body.result) ? body.result.chain_id : undefined;
    if (!ok || typeof chain !== 'string') throw new Error('rpc_unavailable');
    if (config.network === 'sandbox' ? ['mainnet', 'testnet'].includes(chain) : chain !== config.network) throw new Error('network_mismatch');
    chainVerifiedAt = Date.now();
  };
  return async (accountId, publicKey) => {
    await verifyChain();
    const { ok, body } = await rpc('auth', 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
    if (object(body.result)) return body.result.permission === 'FullAccess';
    if (body.error !== undefined && /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/.test(JSON.stringify(body.error))) return false;
    throw new Error(ok ? 'rpc_error' : 'rpc_unavailable');
  };
}
