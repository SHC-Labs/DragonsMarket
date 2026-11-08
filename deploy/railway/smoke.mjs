import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyFoundation(ready, config) {
  assert.equal(ready.status, 'ready');
  assert.equal(ready.checks?.database, 'ok');
  assert.equal(ready.checks?.schema, 'current');
  assert.equal(ready.scope, 'foundation');
  assert.equal(ready.deploymentConfigured, false, 'Chain activation needs its own release and checks');
  assert.equal(ready.indexing, 'deployment_not_configured');
  assert.equal(config.deployment, null);
  for (const capability of ['trading', 'funding', 'indexing', 'agents']) {
    assert.equal(config.capabilities?.[capability], false, `Unexpected active capability: ${capability}`);
  }
}

export async function smoke(web, server, mcp, browserOrigin = 'https://dragons.market') {
if (!web) throw new Error('Usage: node deploy/railway/smoke.mjs <web-origin> [server-origin] [mcp-origin]');
const request = (url, init) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), ...init });
let html = '';
for (const path of ['/', '/market', '/agents', '/health/live', '/__deployment-smoke-missing']) {
  const response = await request(`${web}${path}`);
  assert.equal(response.status, path === '/__deployment-smoke-missing' ? 404 : 200, path);
  const body = await response.text();
  if (path === '/') html = body;
  if (path === '/market') assert.match(body, /<html/i);
  if (path === '/health/live') assert.equal(body, 'ok');
  if (path === '/') {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const nonce = response.headers.get('content-security-policy')?.match(/'nonce-([A-Za-z0-9]{32})'/)?.[1];
    assert.ok(nonce, 'HTML must have a response-local CSP nonce');
    assert.ok(body.includes(`nonce="${nonce}"`), 'HTML and policy nonces must match');
  }
  console.log(`${path}: ${response.status}`);
}
const asset = html.match(/src="([^" ]*\/_next\/static\/[^" ]+)"/)?.[1];
assert.ok(asset, 'The exported page must reference a Next.js static asset');
const response = await request(new URL(asset, web));
assert.equal(response.status, 200);
assert.match(response.headers.get('cache-control') ?? '', /immutable/);
assert.equal((await request(`${web}/market`, { method: 'POST' })).status, 405);
console.log('Static assets have immutable caching; unsupported POST returns 405');
if (server) {
  const response = await request(`${server}/health/ready`);
  assert.equal(response.status, 200);
  const ready = await response.json();
  const configuration = await request(`${server}/v1/config`);
  assert.equal(configuration.status, 200);
  verifyFoundation(ready, await configuration.json());
  console.log('Hosting foundation ready; chain trading and agent execution are inactive');
  const session = await request(`${server}/v1/auth/session`, { headers: { Origin: browserOrigin } });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(session.headers.get('access-control-allow-credentials'), 'true');
  assert.deepEqual(await session.json(), { session: null });
  const preflight = await request(`${server}/v1/auth/challenge`, {
    method: 'OPTIONS', headers: { Origin: browserOrigin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), browserOrigin);
  const rejected = await request(`${server}/v1/auth/challenge`, {
    method: 'OPTIONS', headers: { Origin: 'https://untrusted.invalid', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  const status = await request(`${server}/v1/health/services`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).status, 'ok', 'Background service status is degraded');
  assert.equal((await request(`${server}/v1/operator/services`)).status, 404);
  console.log('Browser session/CORS boundary and service health verified');
}
if (mcp) {
  const response = await request(`${mcp}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const readiness = await request(`${mcp}/health/ready`);
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), { status: 'ready', scope: 'foundation', checks: { backend: 'ok' } });
  if (new URL(mcp).hostname === 'mcp.dragons.market') {
    const skill = await request(`${mcp}/skill.md`);
    assert.equal(skill.status, 200);
    assert.match(await skill.text(), /^---\nname: dragons-market\n/);
    const anonymous = await request(`${mcp}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(anonymous.status, 401);
    const browser = await request(`${mcp}/mcp`, { method: 'POST', headers: { Origin: browserOrigin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(browser.status, 403);
  }
  console.log('MCP-to-API readiness verified; authenticated agent tools remain separately gated');
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  smoke(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
