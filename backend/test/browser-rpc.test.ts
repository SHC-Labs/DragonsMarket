import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createBrowserRpc, MAINNET_READ_FALLBACKS } from '../src/browser-rpc.js';
import { readConfig } from '../src/config.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'mainnet',
  RPC_URL: 'https://primary.example/', RPC_PRIMARY_BEARER_TOKEN: 'primary-secret' });
const input = { jsonrpc: '2.0', id: 'browser', method: 'query',
  params: { request_type: 'view_account', account_id: 'alice.near', finality: 'final' } };
const answer = (init: RequestInit | undefined, result: unknown = { amount: '123' }) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, result }));

test('browser reads prefer the authenticated primary and deduplicate concurrent requests', async () => {
  const calls: string[] = [];
  const rpc = createBrowserRpc(config, async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer primary-secret');
    assert.equal(init?.redirect, 'error');
    return answer(init);
  });
  const [a, b] = await Promise.all([rpc(input), rpc({ ...input, id: 'other-tab' })]);
  assert.deepEqual(a, { jsonrpc: '2.0', id: 'browser', result: { amount: '123' } });
  assert.deepEqual(b, { jsonrpc: '2.0', id: 'other-tab', result: { amount: '123' } });
  await rpc(input);
  assert.deepEqual(calls, ['https://primary.example/']);
});

test('rate limits and malformed responses fall back without forwarding the primary credential', async () => {
  const calls: string[] = [];
  const rpc = createBrowserRpc(config, async (url, init) => {
    calls.push(String(url));
    if (String(url) === config.rpc.primaryUrl) return new Response('', { status: 429 });
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    if (String(url) === MAINNET_READ_FALLBACKS[0]) return new Response('{"result":{}}');
    return answer(init);
  });
  assert.deepEqual(await rpc(input), { jsonrpc: '2.0', id: 'browser', result: { amount: '123' } });
  assert.deepEqual(calls, [config.rpc.primaryUrl, ...MAINNET_READ_FALLBACKS.slice(0, 2)]);
  await rpc({ ...input, params: { ...input.params, account_id: 'another.near' } });
  assert.equal(calls.at(-1), MAINNET_READ_FALLBACKS[1], 'failed providers cool down between requests');
});

test('read proxy refuses transaction submission, batches and unbounded query parameters', async () => {
  let calls = 0;
  const rpc = createBrowserRpc(config, async (_url, init) => { calls++; return answer(init); });
  for (const request of [
    { ...input, method: 'broadcast_tx_commit' }, { ...input, method: 'send_tx' },
    { ...input, params: { ...input.params, block_id: 1 } },
    { ...input, params: { ...input.params, account_id: 'https://evil.example' } },
    { ...input, params: { ...input.params, request_type: 'view_state' } },
    { ...input, url: 'https://evil.example' }, { ...input, id: 'x'.repeat(129) },
    { ...input, params: { ...input.params, request_type: 'call_function', method_name: 'get', args_base64: 'x'.repeat(17000) } },
  ]) await assert.rejects(rpc(request), /read_rpc_request_required/);
  assert.equal(calls, 0);
});

test('all provider failures are bounded and hide provider error bodies', async () => {
  let calls = 0;
  const rpc = createBrowserRpc(config, async () => { calls++; throw new Error('primary-secret'); });
  await assert.rejects(rpc(input), /rpc_temporarily_unavailable/);
  assert.equal(calls, 1 + MAINNET_READ_FALLBACKS.length);
});

test('an unconfirmed transaction does not make healthy providers unavailable to market reads', async () => {
  const calls: string[] = [];
  const rpc = createBrowserRpc(config, async (url, init) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body));
    return body.method === 'EXPERIMENTAL_tx_status'
      ? new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id,
        error: { cause: { name: 'UNKNOWN_TRANSACTION' }, data: 'private diagnostic' } }))
      : answer(init);
  });
  const pending = await rpc({ ...input, method: 'EXPERIMENTAL_tx_status', params: {
    tx_hash: 'B'.repeat(44), sender_account_id: 'alice.near', wait_until: 'FINAL',
  } });
  assert.deepEqual(pending, { jsonrpc: '2.0', id: 'browser', error: { code: -32000, message: 'UNKNOWN_TRANSACTION' } });
  await rpc(input);
  assert.equal(calls.at(-1), config.rpc.primaryUrl);
});

test('RPC route enforces origin, body limit and method without blocking health checks', async () => {
  let calls = 0;
  const app = createApp(config, async () => {}, undefined, undefined, undefined, undefined, undefined,
    createBrowserRpc(config, async (_url, init) => { calls++; return answer(init); }));
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const address = app.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1/rpc`;
  const headers = { Origin: config.webOrigin, 'Content-Type': 'application/json' };
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), config.webOrigin);
    assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 'browser', result: { amount: '123' } });
    assert.equal((await fetch(url, { method: 'OPTIONS', headers })).status, 204);
    assert.equal((await fetch(url, { method: 'GET', headers })).status, 405);
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(input) })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify([input]) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(20001) })).status, 413);
    assert.equal((await fetch(new URL('/health/live', url))).status, 200);
    assert.equal(calls, 1);
  } finally { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); }
});
