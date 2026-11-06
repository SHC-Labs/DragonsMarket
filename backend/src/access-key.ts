import type {Config} from './config.js';
import type {CheckAccessKey} from './auth.js';
import {object} from './ingestion/block.js';

const RPC_TIMEOUT_MS = 10000;
const CHAIN_CACHE_MS = 5 * 60 * 1000;

function keyCheckAt(config: Config, url: string, token: string | null, fetcher: typeof fetch): CheckAccessKey {
  let chainVerifiedAt = 0;
  const rpc = async (id: string, method: string, params: unknown) => {
    const response = await fetcher(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

/** Confirms the key is a FullAccess key on the account at final state, on both RPC providers. A missing key is false; an RPC outage throws, so it is not mistaken for a bad signature. Mainnet refuses to answer from one provider. */
export function accessKeyChecker(config: Config, fetcher: typeof fetch = fetch): CheckAccessKey {
  const { primaryUrl, primaryBearerToken, secondUrl, secondBearerToken } = config.rpc;
  const primary = keyCheckAt(config, primaryUrl, primaryBearerToken, fetcher);
  const second = secondUrl ? keyCheckAt(config, secondUrl, secondBearerToken, fetcher) : null;
  return async (accountId, publicKey) => {
    if (!second) {
      if (config.network === 'mainnet') throw new Error('second_rpc_required');
      return primary(accountId, publicKey);
    }
    const [first, other] = await Promise.all([primary(accountId, publicKey), second(accountId, publicKey)]);
    if (first !== other) console.error('The two RPC providers disagree about an access key');
    return first && other;
  };
}
