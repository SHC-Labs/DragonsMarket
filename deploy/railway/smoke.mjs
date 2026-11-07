import assert from 'node:assert/strict';

const [web, server, mcp] = process.argv.slice(2);
if (!web) throw new Error('Usage: node deploy/railway/smoke.mjs <web-origin> [server-origin] [mcp-origin]');
const request = (url, init) => fetch(url, { signal: AbortSignal.timeout(15000), ...init });
let html = '';
for (const path of ['/', '/market', '/agents', '/health/live', '/__deployment-smoke-missing']) {
  const response = await request(`${web}${path}`);
  assert.equal(response.status, path === '/__deployment-smoke-missing' ? 404 : 200, path);
  const body = await response.text();
  if (path === '/') html = body;
  if (path === '/market') assert.match(body, /<html/i);
  if (path === '/health/live') assert.equal(body, 'ok');
  if (path === '/') assert.equal(response.headers.get('cache-control'), 'no-cache');
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
  assert.equal(ready.checks?.database, 'ok');
  assert.equal(ready.checks?.schema, 'current');
  console.log(`Database ready; chain deployment configured: ${ready.deploymentConfigured === true}`);
}
if (mcp) {
  const response = await request(`${mcp}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  console.log('MCP liveness verified; authenticated agent tools have a separate activation gate');
}
