import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readConfig } from '../src/config.js';
import { createApp, operatorAuthorized } from '../src/app.js';

const base = { DATABASE_URL: 'postgresql://user:secret@localhost:55432/dragons' };
const TOKEN = 'operator-token-0123456789-abcdefghijklmnop';
const DETAIL = { alerts: [] as string[], indexing: { state: 'live', lagBlocks: '3' }, jobs: [{ state: 'queued', count: '2' }] };

async function serve(env: Record<string, string>, status: () => Promise<{ alerts: string[] }>) {
  const app = createApp(readConfig({ ...base, ...env }), async () => {}, undefined, undefined, undefined, status);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  return { root: `http://127.0.0.1:${address.port}`, close: () => (app.closeAllConnections(), new Promise<void>(resolve => app.close(() => resolve()))) };
}

test('the public health route says only ok or degraded', async () => {
  let alerts: string[] = [];
  const { root, close } = await serve({}, async () => ({ ...DETAIL, alerts }));
  try {
    let response = await fetch(`${root}/v1/health/services`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    alerts = ['indexer_lagging', 'reconciliation_stale'];
    response = await fetch(`${root}/v1/health/services`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'degraded' });
    assert.equal((await fetch(`${root}/v1/health/services?detail=1`)).status, 400);
    assert.equal((await fetch(`${root}/v1/health/services`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  } finally {
    await close();
  }
});

test('the public health route is unavailable, with no detail, when the status cannot be read', async () => {
  const { root, close } = await serve({}, async () => {
    throw new Error('password=secret');
  });
  try {
    const response = await fetch(`${root}/v1/health/services`);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.ok(!text.includes('secret'));
    assert.equal(JSON.parse(text).error.code, 'health_unavailable');
  } finally {
    await close();
  }
});

test('the detailed route answers 404 unless the operator token matches', async () => {
  const configured = await serve({ OPERATOR_TOKEN: TOKEN }, async () => DETAIL);
  const unconfigured = await serve({}, async () => DETAIL);
  try {
    const missing = await fetch(`${configured.root}/v1/operator/services`);
    const unknown = await fetch(`${configured.root}/v1/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, (await unknown.json()).error.code, 'indistinguishable from a route that does not exist');
    for (const header of [`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, TOKEN, 'Bearer ', `Basic ${TOKEN}`, 'Bearer'])
      assert.equal((await fetch(`${configured.root}/v1/operator/services`, { headers: { Authorization: header } })).status, 404, header);
    assert.equal((await fetch(`${unconfigured.root}/v1/operator/services`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 404);
    assert.equal((await fetch(`${unconfigured.root}/v1/operator/services`, { headers: { Authorization: 'Bearer ' } })).status, 404);
    const ok = await fetch(`${configured.root}/v1/operator/services`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), DETAIL);
  } finally {
    await configured.close();
    await unconfigured.close();
  }
});

test('the operator token compare accepts only the exact token', () => {
  assert.ok(operatorAuthorized(TOKEN, `Bearer ${TOKEN}`));
  assert.ok(!operatorAuthorized(TOKEN, undefined));
  assert.ok(!operatorAuthorized(TOKEN, `Bearer ${TOKEN} `));
  assert.ok(!operatorAuthorized(null, 'Bearer '));
  assert.ok(!operatorAuthorized(null, `Bearer ${TOKEN}`));
});

test('configuration refuses a short operator token and inconsistent session limits', () => {
  assert.equal(readConfig(base).operatorToken, null);
  assert.equal(readConfig({ ...base, OPERATOR_TOKEN: TOKEN }).operatorToken, TOKEN);
  assert.throws(() => readConfig({ ...base, OPERATOR_TOKEN: 'short' }), /OPERATOR_TOKEN/);
  const defaults = readConfig(base);
  assert.equal(defaults.sessionAbsoluteSeconds, 7 * 24 * 3600);
  assert.equal(defaults.sessionIdleSeconds, 12 * 3600);
  const custom = readConfig({ ...base, SESSION_ABSOLUTE_SECONDS: '7200', SESSION_IDLE_SECONDS: '600' });
  assert.equal(custom.sessionAbsoluteSeconds, 7200);
  assert.equal(custom.sessionIdleSeconds, 600);
  assert.throws(() => readConfig({ ...base, SESSION_ABSOLUTE_SECONDS: '600', SESSION_IDLE_SECONDS: '7200' }), /cannot exceed/);
  assert.throws(() => readConfig({ ...base, SESSION_IDLE_SECONDS: '10' }), /SESSION_IDLE_SECONDS/);
  assert.throws(() => readConfig({ ...base, SESSION_ABSOLUTE_SECONDS: 'soon' }), /SESSION_ABSOLUTE_SECONDS/);
});
