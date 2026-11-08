import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFoundation } from './smoke.mjs';

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
