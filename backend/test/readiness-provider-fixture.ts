import assert from 'node:assert/strict';

const expectedKey = `naa_${'t'.repeat(43)}`;
const seen = new Set<string>();

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://agents.example.com');
  assert.equal(init?.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(new Headers(init.headers).get('X-Api-Key'), expectedKey);
  assert.ok(['/v1/network', '/v1/whoami'].includes(url.pathname));
  seen.add(url.pathname);
  if (process.env.READINESS_FIXTURE_STATUS === '401' && url.pathname === '/v1/whoami') {
    return Response.json({ errors: [{ status: '401', code: 'unauthorized',
      title: 'private fixture detail', layer: 'auth' }], meta: {} }, { status: 401 });
  }
  return Response.json(url.pathname === '/v1/network'
    ? { network: 'mainnet', contract_id: 'wallets.near', supported_owner_types: ['near'],
      status: { overall: 'unknown', checked_at: null, components: [] } }
    : { tenant_id: 'tenant_fixture', api_key_id: 'key_fixture' });
};

process.on('beforeExit', () => {
  if (!process.exitCode) assert.deepEqual([...seen].sort(), ['/v1/network', '/v1/whoami']);
});
