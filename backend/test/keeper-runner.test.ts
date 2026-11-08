import test from 'node:test';
import assert from 'node:assert/strict';
import { keeperSettings } from '../src/keeper-runner.js';
import { readConfig } from '../src/config.js';
import { keeperAlerts } from '../src/monitoring.js';

const env = { DATABASE_URL: 'postgres://localhost/test', NETWORK: 'mainnet', DEPLOYMENT_ID: 'approved-market',
  DEPLOYMENT_START_BLOCK: '100', MARKET_CONTRACT_ID: 'market.near', ORACLE_CONTRACT_ID: 'oracle.near',
  COUNCIL_CONTRACT_ID: 'council.near', VERIFIER_CONTRACT_ID: 'intents.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.near' };

test('keeper preparation requires a complete registered-mainnet manifest and cannot receive signing keys', () => {
  const config = readConfig(env);
  const settings = keeperSettings({}, config);
  assert.equal(settings.mode, 'prepare');
  assert.equal(settings.options['require-live-feed'], true);
  assert.equal(settings.options['require-scoped-keys'], true);
  assert.equal(settings.options['events-file'], '.local/feeds/approved-market.jsonl');
  assert.equal(keeperSettings({ KEEPER_MODE: 'check' }, config).mode, 'check');
  for (const key of ['KEEPER_KEY', 'KEEPER_ORACLE_KEY', 'KEEPER_MARKET_KEY', 'KEEPER_COUNCIL_KEY']) {
    assert.throws(() => keeperSettings({ [key]: 'never-use-this-key' }, config), /must not receive signing keys/);
  }
  assert.throws(() => keeperSettings({ KEEPER_MODE: 'sign' }, config), /approval_digest_mismatch/);
  assert.throws(() => keeperSettings({}, { ...config, network: 'testnet' }), /mainnet deployment/);
  assert.throws(() => keeperSettings({}, { ...config, deployment: null }), /mainnet deployment/);
  assert.throws(() => keeperSettings({}, readConfig({ ...env, COUNCIL_CONTRACT_ID: '' })), /Council/);
  const authenticated = readConfig({ ...env, RPC_URL: 'https://first.example', RPC_PRIMARY_BEARER_TOKEN: 'primary-secret',
    RPC_SECOND_URL: 'https://second.example', RPC_SECOND_BEARER_TOKEN: 'secondary-secret' });
  assert.equal(keeperSettings({}, authenticated).options.rpc, 'https://first.example/,https://second.example/');
});

test('service monitoring distinguishes an operating signer from preparation, stale work and a failed pass', () => {
  const now = Date.now();
  const ready = { mode: 'sign', state: 'ready', last_success_at: new Date(now - 1000) };
  assert.deepEqual(keeperAlerts(false, null), []);
  assert.deepEqual(keeperAlerts(true, ready, now), []);
  assert.deepEqual(keeperAlerts(true, { ...ready, state: 'running' }, now), [], 'a new bounded pass does not erase the previous success');
  assert.deepEqual(keeperAlerts(true, null, now), ['keeper_stale', 'keeper_signing_disabled']);
  assert.deepEqual(keeperAlerts(true, { ...ready, mode: 'check' }, now), ['keeper_signing_disabled']);
  assert.deepEqual(keeperAlerts(true, { ...ready, state: 'failed' }, now), ['keeper_failed']);
  assert.deepEqual(keeperAlerts(true, { ...ready, state: 'catching_up' }, now), ['keeper_feed_stale']);
  for (const last_success_at of [null, 'bad-date', new Date(now - 900001), new Date(now + 1000)])
    assert.deepEqual(keeperAlerts(true, { ...ready, last_success_at }, now), ['keeper_stale']);
});
