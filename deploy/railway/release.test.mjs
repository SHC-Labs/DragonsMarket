import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectId, environmentId, services, verifySource, verifyTarget, railwayQuery, waitForDeployment, release, checkReleaseVariables, verifyFoundationVariables } from './release.mjs';

const sha = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'SHC-Labs/DragonsMarket', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: sha };
const id = '11111111-1111-4111-8111-111111111111';
const settings = JSON.parse(readFileSync(new URL('./services.json', import.meta.url), 'utf8'));

function target() {
  const config = { services: {} };
  for (const service of services) {
    const value = config.services[service.id] = {};
    for (const [path, expected] of Object.entries(settings[service.name])) {
      const keys = path.split('.');
      let current = value;
      for (const key of keys.slice(0, -1)) current = current[key] ??= {};
      current[keys.at(-1)] = structuredClone(expected);
    }
  }
  return { variables: { MCP_TRUSTED_PROXY_ADDRESSES: '0.0.0.0/0,::/0' },
    projectToken: { projectId, environmentId }, environmentStagedChanges: null,
    environment: { id: environmentId, projectId, unmergedChangesCount: 0, config } };
}

function deployment(service, state = {}) {
  return { deployment: { id, projectId, environmentId, serviceId: service.id, status: 'SUCCESS', deploymentStopped: false, ...state } };
}

test('only a manual main run from the intended repository and exact clean commit is accepted', () => {
  verifySource(env, `${sha}\n`, '');
  for (const changed of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'fork/DragonsMarket' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/tags/main' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_SHA: 'main' }]) {
    assert.throws(() => verifySource({ ...env, ...changed }, sha, ''));
  }
  assert.throws(() => verifySource(env, 'b'.repeat(40), ''), /clean commit/);
  assert.throws(() => verifySource(env, sha, '?? extra.js'), /clean commit/);
});

test('production scope and configured migration/health gates must match before any upload', () => {
  verifyTarget(target());
  for (const mutate of [
    data => { data.projectToken.projectId = 'another-project'; },
    data => { data.projectToken.environmentId = 'another-environment'; },
    data => { data.environment.projectId = 'another-project'; },
    data => { data.environmentStagedChanges = { patch: { services: {} } }; },
    data => { data.environment.config.services[services[0].id].deploy.startCommand = 'node unsafe.js'; },
    data => { data.environment.config.services[services[1].id].deploy.preDeployCommand = []; },
    data => { data.environment.config.services[services[1].id].deploy.healthcheckPath = '/health/live'; },
    data => { data.environment.config.services[services[2].id].source.repo = 'other/repo'; },
    data => { data.environment.config.services[services[3].id].build.builder = 'RAILPACK'; },
  ]) {
    const data = target(); mutate(data); assert.throws(() => verifyTarget(data));
  }
});

test('actual staged changes block releases even when Railway reports a null summary count', async () => {
  const data = target();
  data.environment.unmergedChangesCount = null;
  data.environmentStagedChanges = { patch: {} };
  verifyTarget(data);
  for (const staged of [undefined, {}, { patch: null }, { patch: [] },
    { patch: { services: { [services[0].id]: { deploy: { startCommand: 'unsafe' } } } } }]) {
    let uploads = 0;
    await assert.rejects(release({ query: async () => ({ ...data, environmentStagedChanges: staged }),
      backups: async () => {}, upload() { uploads++; } }), /staged Railway changes/);
    assert.equal(uploads, 0);
  }
});

test('omitted Railway defaults retain their documented meaning', () => {
  const data = target();
  delete data.environment.config.services[services[1].id].deploy.restartPolicyType;
  delete data.environment.config.services[services[1].id].deploy.sleepApplication;
  verifyTarget(data);
});

test('query transport uses a project token and refuses redirects without exposing API error contents', async () => {
  assert.throws(() => railwayQuery(''), /RAILWAY_TOKEN/);
  const query = railwayQuery('test-project-token', async (url, init) => {
    assert.equal(url, 'https://backboard.railway.com/graphql/v2');
    assert.equal(init.headers['Project-Access-Token'], 'test-project-token');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, 'error');
    return Response.json({ data: { value: true } });
  });
  assert.deepEqual(await query('query {}'), { value: true });
  for (const response of [Response.json({ errors: [{ message: 'sensitive-value' }] }), new Response('sensitive-value', { status: 403 })]) {
    await assert.rejects(railwayQuery('test', async () => response)('query {}'), error => !error.message.includes('sensitive-value'));
  }
});

test('a successful running migration container does not allow the API to deploy', async () => {
  const service = services[0];
  let polls = 0; let sleeps = 0;
  await waitForDeployment(async query => query.includes('deploymentLogs')
    ? { deploymentLogs: [{ message: 'Applied 0 migration(s); service database roles are ready' }] }
    : deployment(service, { deploymentStopped: ++polls > 1 }), service, id,
  { sleep: async () => { sleeps++; }, log() {} });
  assert.equal(polls, 2);
  assert.equal(sleeps, 1);
});

test('migration completion requires its success log, while application completion requires a running service', async () => {
  let time = 0;
  await assert.rejects(waitForDeployment(async query => query.includes('deploymentLogs')
    ? { deploymentLogs: [{ message: 'Starting Container' }] }
    : deployment(services[0], { deploymentStopped: true }), services[0], id,
  { now: () => time, timeout: 10, sleep: async () => { time += 10; }, log() {} }), /Timed out/);
  await assert.rejects(waitForDeployment(async () => deployment(services[1], { deploymentStopped: true }), services[1], id), /stopped/);
});

test('failed, removed, unknown and mismatched deployments fail closed', async () => {
  for (const status of ['FAILED', 'CRASHED', 'REMOVED', 'CANCELED', 'NEW_UNKNOWN_STATUS']) {
    await assert.rejects(waitForDeployment(async () => deployment(services[1], { status }), services[1], id, { log() {} }), /ended with/);
  }
  for (const changed of [{ id: 'different' }, { projectId: 'different' }, { environmentId: 'different' }, { serviceId: 'different' }]) {
    await assert.rejects(waitForDeployment(async () => deployment(services[1], changed), services[1], id), /identity mismatch/);
  }
});

test('release order is serial and excludes Postgres and all inactive workers', async () => {
  const events = [];
  await release({ query: async () => target(), backups: async () => { events.push('backup-check'); },
    upload: service => { events.push(`upload:${service.name}`); return { deploymentId: id }; },
    wait: async (_query, service) => { events.push(`ready:${service.name}`); }, report() {} });
  assert.deepEqual(events, ['backup-check', 'upload:database-release', 'ready:database-release', 'upload:server', 'ready:server',
    'upload:mcp', 'ready:mcp', 'upload:web', 'ready:web']);
});

test('a failed database release prevents every application upload', async () => {
  const uploaded = [];
  await assert.rejects(release({ query: async () => target(), backups: async () => {},
    upload: service => { uploaded.push(service.name); return { deploymentId: id }; },
    wait: async () => { throw new Error('Migration failed'); }, report() {} }), /Migration failed/);
  assert.deepEqual(uploaded, ['database-release']);
});

test('invalid target or upload result cannot be mistaken for a successful release', async () => {
  let uploads = 0;
  await assert.rejects(release({ query: async () => ({ ...target(), projectToken: null }), upload() { uploads++; } }), /project token/);
  assert.equal(uploads, 0);
  await assert.rejects(release({ query: async () => target(), backups: async () => {}, upload: () => ({ deploymentId: 'not-an-id' }) }), /deployment ID/);
});

test('a missing or stale backup prevents uploads and migrations', async () => {
  let uploads = 0;
  await assert.rejects(release({ query: async () => target(), backups: async () => { throw new Error('No recent backup'); },
    upload() { uploads++; } }), /No recent backup/);
  assert.equal(uploads, 0);
});

test('MCP ingress must be explicitly configured before any upload or migration', async () => {
  let uploads = 0;
  for (const value of [undefined, '', '127.0.0.1/32']) {
    await assert.rejects(release({ query: async () => ({ ...target(), variables: { MCP_TRUSTED_PROXY_ADDRESSES: value } }),
      backups: async () => {}, upload() { uploads++; } }), /MCP_TRUSTED_PROXY_ADDRESSES/);
  }
  assert.equal(uploads, 0);
  const checked = [];
  await checkReleaseVariables(async (_query, variables) => {
    assert.equal(variables.projectId, projectId);
    assert.equal(variables.environmentId, environmentId);
    checked.push(variables.serviceId);
    return target();
  });
  assert.deepEqual(checked, services.map(service => service.id));
});

test('foundation release refuses partial chain or agent activation before any migration or upload', async () => {
  const keys = ['REGISTER_DEPLOYMENT', 'KEEPER_MODE', 'KEEPER_APPROVAL_JSON', 'KEEPER_APPROVAL_SHA256',
    'KEEPER_KEY', 'KEEPER_MARKET_KEY', 'KEEPER_ORACLE_KEY', 'KEEPER_COUNCIL_KEY', 'KEEPER_ROUNDS_KEY',
    'DEPLOYMENT_ID', 'DEPLOYMENT_START_BLOCK', 'MARKET_CONTRACT_ID', 'ROUNDS_CONTRACT_ID',
    'ORACLE_CONTRACT_ID', 'COUNCIL_CONTRACT_ID', 'VERIFIER_CONTRACT_ID', 'NFT_CONTRACT_ID',
    'COLLATERAL_TOKEN_ID', 'AGENT_WORKER_URL', 'AGENT_WORKER_TOKEN', 'AGENT_API_KEY', 'AGENT_GRANT_KEY',
    'PUBLISH_ROUND_PRICES', 'NEXT_PUBLIC_MARKET_ID', 'NEXT_PUBLIC_ORACLE_ID', 'NEXT_PUBLIC_COUNCIL_ID',
    'NEXT_PUBLIC_VERIFIER_ID', 'NEXT_PUBLIC_NFT_ID', 'NEXT_PUBLIC_TOKEN_ID', 'NEXT_PUBLIC_COLLATERAL_TOKEN_ID',
    'NEXT_PUBLIC_AGENT_WALLET_CONTRACT', 'NEXT_PUBLIC_AGENT_API_HOST'];
  let uploads = 0;
  for (const service of services) {
    for (const key of keys) {
      await assert.rejects(release({ query: async (_query, variables) => {
        const data = target();
        if (variables.serviceId === service.id) data.variables[key] = 'private-value-never-log';
        return data;
      }, backups: async () => {}, upload() { uploads++; } }), error =>
        error.message.includes(`activation settings on ${service.name}`) &&
        error.message.includes(key) && !error.message.includes('private-value-never-log'));
    }
  }
  assert.equal(uploads, 0);
});

test('empty activation variables are inactive; missing variable inventories fail closed', () => {
  const service = services.find(service => service.name === 'server');
  verifyFoundationVariables(service, { DEPLOYMENT_ID: '', NEXT_PUBLIC_MARKET_ID: '', NETWORK: 'testnet' });
  for (const key of ['KEEPER_MARKET_KEY', 'AGENT_API_KEY', 'AGENT_GRANT_KEY']) {
    assert.throws(() => verifyFoundationVariables(service, { [key]: null }), /activation settings/);
  }
  for (const variables of [undefined, null, [], 'unreadable']) {
    assert.throws(() => verifyFoundationVariables(service, variables), /Missing variable inventory/);
  }
});
