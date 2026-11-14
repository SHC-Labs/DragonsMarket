import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentApiClient, AgentApiError, AgentApiUnavailable } from '../src/agent-api.js';
import { agentReadiness } from '../src/agent-readiness.js';

const settings = { url: 'https://agents.example.com', key: `naa_${'a'.repeat(43)}`, timeoutMs: 1000 };
const expected = { network: 'mainnet', walletContract: 'wallets.near' };
const network = { network: 'mainnet', contract_id: 'wallets.near', supported_owner_types: ['near', 'evm'],
  status: { overall: 'unknown', checked_at: null, components: [] } };
const identity = { api_key_id: 'key_fixture', tenant_id: 'tenant_fixture' };
const response = (networkAnswer: unknown = network, identityAnswer: unknown = identity): typeof fetch =>
  async input => Response.json(new URL(String(input)).pathname === '/v1/network' ? networkAnswer : identityAnswer);

test('readiness authenticates the partner key separately from public network discovery, using only reads', async () => {
  const seen: string[] = [];
  const api = new AgentApiClient(settings, async (input, init) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    assert.equal(url.origin, settings.url);
    assert.equal(init?.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('X-Api-Key'), settings.key);
    assert.equal(new Headers(init.headers).get('X-Grant-Token'), null);
    assert.ok(init.signal instanceof AbortSignal);
    return response()(input, init);
  });
  await api.verifyService(expected);
  assert.deepEqual(seen.sort(), ['/v1/network', '/v1/whoami']);
});

test('a responsive provider with a different network, wallet contract or missing NEAR owners is incompatible', async () => {
  for (const value of [null, {}, { ...network, network: 'testnet' }, { ...network, contract_id: 'intents.near' },
    { ...network, supported_owner_types: ['evm'] }, { ...network, supported_owner_types: 'near' }]) {
    await assert.rejects(new AgentApiClient(settings, response(value)).verifyService(expected),
      (error: unknown) => error instanceof AgentApiUnavailable && error.message === 'agent_api_incompatible');
  }
  await assert.rejects(new AgentApiClient(settings, response()).verifyService({ ...expected, network: 'testnet' }),
    /agent_api_incompatible/);
});

test('missing or malformed authenticated identity cannot pass on a successful public response', async () => {
  for (const value of [null, {}, { ...identity, tenant_id: '' }, { ...identity, tenant_id: ' '.repeat(2) },
    { ...identity, api_key_id: 42 }, { ...identity, api_key_id: 'x'.repeat(257) }]) {
    await assert.rejects(new AgentApiClient(settings, response(network, value)).verifyService(expected),
      /invalid_agent_api_identity/);
  }
  for (const status of [401, 403, 429, 503]) {
    const api = new AgentApiClient(settings, async input => new URL(String(input)).pathname === '/v1/network'
      ? Response.json(network) : Response.json({ errors: [{ status: String(status), code: 'unavailable',
        title: 'private detail', layer: 'auth' }], meta: {} }, { status }));
    await assert.rejects(api.verifyService(expected), (error: unknown) => error instanceof AgentApiError
      && error.status === status);
  }
});

test('unreadable and unavailable metadata fail closed, and a stalled probe honors its deadline', async () => {
  for (const fetcher of [async () => new Response('not json'),
    async () => { throw new Error('connection failed'); }]) {
    await assert.rejects(new AgentApiClient(settings, fetcher).verifyService(expected), AgentApiUnavailable);
  }
  const api = new AgentApiClient({ ...settings, timeoutMs: 20 }, (_input, init) => new Promise((_, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
  }));
  // AbortSignal timers are unref'd; keep the test alive without changing production's deadline.
  const timer = setTimeout(() => {}, 1000);
  try { await assert.rejects(api.verifyService(expected), AgentApiUnavailable); }
  finally { clearTimeout(timer); }
});

test('provider dependency status does not claim a failed payment or disable otherwise compatible integration', async () => {
  for (const overall of ['unknown', 'down', 'degraded', 'operational']) {
    const api = new AgentApiClient(settings, response({ ...network, status: { overall } }));
    await api.verifyService(expected);
  }
});

test('concurrent health checks coalesce and expire successes and failures, without retaining a stale success', async () => {
  let time = 0, calls = 0, reads = 0, available = true;
  let finish = () => {};
  const ready = agentReadiness(async () => { reads++; }, async () => {
    calls++;
    await new Promise<void>(resolve => { finish = resolve; });
    if (!available) throw new Error('secret provider detail');
  }, () => time);
  const first = ready(), second = ready();
  assert.equal(calls, 1);
  finish();
  await Promise.all([first, second]);
  time = 29999;
  await ready();
  assert.equal(calls, 1);
  time = 30000;
  available = false;
  const failed = ready();
  assert.equal(calls, 2);
  finish();
  await assert.rejects(failed, /agent_provider_not_ready/);
  await assert.rejects(ready(), /agent_provider_not_ready/);
  assert.equal(calls, 2, 'failures are cached too, so outages cannot cause a probe storm');
  time = 60000;
  available = true;
  const recovered = ready();
  finish();
  await recovered;
  assert.equal(calls, 3);
  assert.equal(reads, 6, 'the database is checked on every request');
});

test('a cached provider success never hides a database failure', async () => {
  let available = true, calls = 0;
  const ready = agentReadiness(async () => { if (!available) throw new Error('database unavailable'); },
    async () => { calls++; });
  await ready();
  available = false;
  await assert.rejects(ready(), /database unavailable/);
  available = true;
  await ready();
  assert.equal(calls, 1);
});
