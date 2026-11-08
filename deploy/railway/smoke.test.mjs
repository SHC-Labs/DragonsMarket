import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { verifyFoundation, verifyActivated, smoke } from './smoke.mjs';

const ready = { status: 'ready', checks: { database: 'ok', schema: 'current' },
  scope: 'foundation', deploymentConfigured: false, indexing: 'deployment_not_configured' };
const config = { deployment: null,
  capabilities: { trading: false, funding: false, indexing: false, agents: false } };

test('foundation smoke cannot certify missing, partial or active financial configuration', () => {
  verifyFoundation(ready, config);
  for (const changed of [{ status: 'unavailable' }, { checks: { database: 'ok', schema: 'old' } },
    { scope: 'chain' }, { deploymentConfigured: true }, { deploymentConfigured: undefined },
    { indexing: 'catching_up' }]) {
    assert.throws(() => verifyFoundation({ ...ready, ...changed }, config));
  }
  for (const deployment of [undefined, {}, { id: 'rehearsal' }]) {
    assert.throws(() => verifyFoundation(ready, { ...config, deployment }));
  }
  for (const capability of Object.keys(config.capabilities)) {
    for (const value of [true, undefined]) {
      const capabilities = { ...config.capabilities, [capability]: value };
      assert.throws(() => verifyFoundation(ready, { ...config, capabilities }));
    }
  }
});

test('active smoke requires the exact approved deployment and execution profile', () => {
  const deployment = { id: 'approved', startBlock: '123', contracts: { market: 'market.near' },
    collateralTokenId: 'nep141:usdc.near', collateralDecimals: 6 };
  const activeReady = { ...ready, deploymentConfigured: true, indexing: 'see_indexer_status' };
  const activeConfig = { network: 'mainnet', deployment, capabilities: { trading: false, funding: false,
    indexing: true, walletSessions: true, agents: false } };
  const expected = { deployment, agents: false };
  verifyActivated(activeReady, activeConfig, expected);
  for (const changed of [config, { ...activeConfig, network: 'testnet' },
    { ...activeConfig, deployment: { ...deployment, startBlock: '124' } },
    { ...activeConfig, capabilities: { ...activeConfig.capabilities, agents: true } },
    { ...activeConfig, capabilities: { ...activeConfig.capabilities, walletSessions: false } }]) {
    assert.throws(() => verifyActivated(activeReady, changed, expected));
  }
  assert.throws(() => verifyActivated(ready, activeConfig, expected));
  assert.throws(() => verifyFoundation(activeReady, activeConfig));
});

test('HTTP smoke rejects an old browser commit even when the API and all health routes pass', async () => {
  const deployment = { id: 'approved', startBlock: '123', contracts: { market: 'market.near' },
    collateralTokenId: 'nep141:usdc.near', collateralDecimals: 6 };
  const expected = { deployment, agents: false, browser: { version: 1, sourceCommit: 'a'.repeat(40) } };
  let built = expected.browser;
  const nonce = 'n'.repeat(32), browserOrigin = 'https://dragons.market';
  const http = createServer((req, res) => {
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'OPTIONS') {
      res.statusCode = req.headers.origin === browserOrigin ? 204 : 403;
      if (res.statusCode === 204) res.setHeader('Access-Control-Allow-Origin', browserOrigin);
      res.end(); return;
    }
    if (req.method === 'POST') { res.statusCode = 405; res.end(); return; }
    if (req.url === '/deployment.json') return json(built);
    if (req.url === '/health/ready') return json({ ...ready, deploymentConfigured: true, indexing: 'see_indexer_status' });
    if (req.url === '/v1/config') return json({ network: 'mainnet', deployment,
      capabilities: { trading: false, funding: false, indexing: true, walletSessions: true, agents: false } });
    if (req.url === '/v1/auth/session') {
      res.setHeader('Access-Control-Allow-Origin', browserOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      return json({ session: null });
    }
    if (req.url === '/v1/health/services') return json({ status: 'ok' });
    if (req.url === '/mcp/health') return json({ ok: true });
    if (req.url === '/mcp/health/ready') return json({ status: 'ready', scope: 'foundation', checks: { backend: 'ok' } });
    if (req.url === '/health/live') { res.end('ok'); return; }
    if (req.url === '/_next/static/test.js') { res.setHeader('Cache-Control', 'public, immutable'); res.end(''); return; }
    if (req.url === '/v1/operator/services' || req.url === '/__deployment-smoke-missing') res.statusCode = 404;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', `script-src 'nonce-${nonce}'`);
    res.end(`<html><script nonce="${nonce}" src="/_next/static/test.js"></script></html>`);
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const origin = `http://127.0.0.1:${http.address().port}`;
  try {
    await smoke(origin, origin, `${origin}/mcp`, browserOrigin, expected);
    built = { ...built, sourceCommit: 'b'.repeat(40) };
    await assert.rejects(smoke(origin, origin, `${origin}/mcp`, browserOrigin, expected), /different chain configuration/);
  } finally {
    const closed = once(http, 'close');
    http.close(); http.closeAllConnections();
    await closed;
  }
});
