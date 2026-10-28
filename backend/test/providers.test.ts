import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, publicConfig } from '../src/config.js';
import { readRpcSettings, ReadRpcClient, RpcError, checkProvider } from '../src/providers.js';

const local = { timeoutMs: 1000, intervalMs: 0 };
const hash = '11111111111111111111111111111111';
function transport(handler: (body: Record<string, unknown>, init: RequestInit | undefined) => { status?: number; result?: unknown; error?: unknown }): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const output = handler(body, init);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(output.error ? { error: output.error } : { result: output.result }) }), { status: output.status ?? 200 });
  };
}

test('free RPC defaults are isolated by network and do not create a deployment', () => {
  assert.equal(readRpcSettings({}, 'mainnet').primaryUrl, 'https://free.rpc.fastnear.com/');
  assert.equal(readRpcSettings({}, 'testnet').primaryUrl, 'https://test.rpc.fastnear.com/');
  assert.equal(readRpcSettings({}, 'mainnet').archivalUrl, 'https://archival-rpc.mainnet.near.org/');
  assert.equal(readRpcSettings({}, 'sandbox').archivalUrl, null);
  const config = readConfig({ DATABASE_URL: 'postgres://user:pass@localhost/db', NETWORK: 'testnet', RPC_URL: 'https://paid.example/private-path', RPC_PRIMARY_BEARER_TOKEN: 'secret-token' });
  assert.equal(config.deployment, null);
  assert.ok(!JSON.stringify(publicConfig(config)).includes('secret-token'));
  assert.ok(!JSON.stringify(publicConfig(config)).includes('private-path'));
  for (const env of [{ RPC_INTERVAL_MS: '0' }, { RPC_TIMEOUT_MS: 'NaN' }, { RPC_ARCHIVAL_URL: 'ftp://example.com' }, { RPC_PRIMARY_BEARER_TOKEN: 'token', RPC_URL: 'http://example.com' }]) assert.throws(() => readRpcSettings(env, 'testnet'));
});

test('method-not-found with HTTP 400 is classified without hiding valid RPC access', async () => {
  const client = new ReadRpcClient('https://example.com', local, null, transport(body => {
    if (body.method === 'status') return { result: { chain_id: 'testnet' } };
    if (body.method === 'block') return { result: { header: { height: '18446744073709551615', hash } } };
    assert.deepEqual(body.params, { block_hash: hash });
    return { status: 400, error: { code: -32601, message: 'Provider secret must never appear' } };
  }));
  const report = await checkProvider(client, 'testnet', 'primary');
  assert.equal(report.networkVerified, true);
  assert.equal(report.indexerMethod, 'unsupported');
  assert.equal(report.error, null);
  assert.equal(report.finalizedBlock?.height, '18446744073709551615');
});

test('wrong network stops the diagnostic before block requests', async () => {
  let calls = 0;
  const client = new ReadRpcClient('https://example.com', local, null, transport(() => { calls++; return { result: { chain_id: 'mainnet' } }; }));
  const report = await checkProvider(client, 'testnet', 'primary');
  assert.equal(calls, 1);
  assert.equal(report.networkVerified, false);
  assert.equal(report.finalizedBlock, null);
  assert.match(report.error!, /network_mismatch/);
});

test('primary authentication is explicit; another client receives no token', async () => {
  const headers: Headers[] = [];
  const fake = transport((_body, init) => { headers.push(new Headers(init?.headers)); return { result: {} }; });
  await new ReadRpcClient('https://primary.example', local, 'private-token', fake).call('status', []);
  await new ReadRpcClient('https://archive.example', local, null, fake).call('status', []);
  assert.equal(headers[0]?.get('authorization'), 'Bearer private-token');
  assert.equal(headers[1]?.get('authorization'), null);
});

test('successful indexer response remains unverified, not declared a complete source', async () => {
  const client = new ReadRpcClient('https://example.com', local, null, transport(body => {
    if (body.method === 'status') return { result: { chain_id: 'testnet' } };
    if (body.method === 'block') return { result: { header: { height: 10, hash } } };
    return { result: { block: {}, shards: [] } };
  }));
  assert.equal((await checkProvider(client, 'testnet', 'primary')).indexerMethod, 'responded_unverified');
});

test('transport errors and mismatched response IDs do not expose provider messages', async () => {
  const failing: typeof fetch = async () => { throw new Error('https://provider.example/private-token'); };
  const client = new ReadRpcClient('https://example.com', local, null, failing);
  await assert.rejects(client.call('status', []), (error: unknown) => error instanceof RpcError && error.message === 'RPC request failed (transport_or_timeout)');
  const mismatch: typeof fetch = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'wrong', result: {} }));
  await assert.rejects(new ReadRpcClient('https://example.com', local, null, mismatch).call('status', []), /invalid_envelope/);
});
