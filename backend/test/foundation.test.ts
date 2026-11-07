import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readConfig, publicConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const base = { DATABASE_URL: 'postgresql://user:secret@localhost:55432/dragons' };
const deployment = { ...base, NETWORK: 'testnet', DEPLOYMENT_ID: 'demo-1', DEPLOYMENT_START_BLOCK: '18446744073709551615', ROUNDS_CONTRACT_ID: 'rounds.testnet', VERIFIER_CONTRACT_ID: 'verifier.testnet', COLLATERAL_TOKEN_ID: 'nep141:usdc.testnet', RPC_URL: 'https://rpc.testnet.near.org' };

test('unconfigured foundation is explicit and public config cannot leak database credentials', () => {
  const config = readConfig(base);
  assert.equal(config.deployment, null);
  assert.equal(publicConfig(config).capabilities.trading, false);
  assert.ok(!JSON.stringify(publicConfig(config)).includes('secret'));
});

test('deployment validates identity and preserves u64 values without rounding', () => {
  assert.equal(readConfig(deployment).deployment?.startBlock, deployment.DEPLOYMENT_START_BLOCK);
  for (const patch of [
    { NETWORK: 'invalid' }, { PORT: 'NaN' }, { PORT: '65536' },
    { DEPLOYMENT_START_BLOCK: '18446744073709551616' },
    { NETWORK: 'mainnet' }, { COLLATERAL_DECIMALS: '-1' },
    { ROUNDS_CONTRACT_ID: 'INVALID!' }, { RPC_URL: 'https://user:secret@example.com' },
    { RPC_URL: 'https://example.com?key=secret' }, { WEB_ORIGIN: 'https://example.com/path' },
  ]) assert.throws(() => readConfig({ ...deployment, ...patch }));
  assert.throws(() => readConfig({ ...base, ROUNDS_CONTRACT_ID: 'rounds.testnet' }));
  assert.throws(() => readConfig({ DATABASE_URL: 'secret-not-a-url' }), /Invalid DATABASE_URL/);
});

test('API separates liveness from readiness, restricts origin/methods and sanitizes errors', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  let available = true;
  const app = createApp(readConfig(base), async () => { if (!available) throw new Error('password=secret'); }, async () => {
    if (!available) throw new Error('password=secret');
    return { state: 'replay_complete', live: false };
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  const root = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${root}/health/live`)).status, 200);
    let response = await fetch(`${root}/health/ready`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).scope, 'foundation');
    response = await fetch(`${root}/v1/indexer/status`);
    assert.deepEqual(await response.json(), { state: 'replay_complete', live: false });
    available = false;
    response = await fetch(`${root}/v1/indexer/status`);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('secret'));
    t.mock.timers.tick(2001);
    response = await fetch(`${root}/health/ready`);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('secret'));
    assert.equal((await fetch(`${root}/health/live`)).status, 200);
    response = await fetch(`${root}/v1/config`, { headers: { Origin: 'http://localhost:3400' } });
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3400');
    assert.equal((await response.json()).deployment, null);
    response = await fetch(`${root}/v1/config`, { headers: { Origin: 'https://other.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${root}/v1/config`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${root}/missing`)).status, 404);
    assert.equal((await fetch(`${root}/health/live`, { method: 'HEAD' })).status, 200);
  } finally {
    app.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  }
});
