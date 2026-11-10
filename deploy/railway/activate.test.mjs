import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keeperFixture } from '../../backend/dist/test/keeper-fixture.js';
import { projectId, environmentId, services } from './release.mjs';
import { postgresId } from './backups.mjs';
import { activatedRelease, activationSnapshot, checkOperational, json, verifyOperational } from './activate.mjs';
import { activationServices, agentService, digest, expectedBrowser, manifestVariables, origins,
  parseActivation, pricesService, verifyActivationVariables, workerServices } from './activation-plan.mjs';

const settings = JSON.parse(readFileSync(new URL('./services.json', import.meta.url), 'utf8'));
const keeperId = '22222222-2222-4222-8222-222222222222';
const deploymentId = '11111111-1111-4111-8111-111111111111';

function fixture(stage = 'launch', profile = 'human') {
  const keeper = keeperFixture();
  const raw = JSON.stringify({ version: 1, sourceCommit: 'b'.repeat(40), profile, keeperServiceId: keeperId,
    publicRpcUrl: 'https://free.rpc.fastnear.com', keeperApproval: keeper.approval,
    launchEvidence: 'https://review.invalid/funded-and-operations', ...(profile === 'agents' ? {
      agent: { apiUrl: 'https://agents.example.com', walletContract: 'wallets.near',
        acceptanceEvidence: 'https://review.invalid/partner-acceptance' } } : {}) });
  const plan = parseActivation(raw, digest(raw));
  const all = [...services, ...workerServices, { name: 'keeper', id: keeperId }, agentService, pricesService];
  const inventory = Object.fromEntries(all.map(service => [service.name, {}]));
  const passwords = Object.fromEntries(['api', 'indexer', 'worker', 'publisher', 'agent', 'keeper']
    .map((role, index) => [`dm_${role}_login`, String(index + 1).repeat(64)]));
  const activeAgents = stage === 'launch' && profile === 'agents';
  for (const [name, role] of Object.entries({ 'database-release': 'postgres', server: 'dm_api_login',
    indexer: 'dm_indexer_login', reconcile: 'dm_worker_login', 'verify-chain': 'dm_worker_login',
    keeper: 'dm_keeper_login', ...(activeAgents ? { 'agent-worker': 'dm_agent_login' } : {}) })) {
    inventory[name] = { ...manifestVariables(plan.approval.deployment),
      DATABASE_URL: `postgresql://${role}:${passwords[role] ?? 'owner-fixture'}@postgres.railway.internal:5432/railway`,
      RPC_URL: 'https://first.invalid', RPC_SECOND_URL: 'https://second.invalid' };
  }
  Object.assign(inventory.server, { HOST: '::', PORT: '3500', WEB_ORIGIN: origins.web,
    TRUSTED_PROXY_HOPS: '1', TRUSTED_PROXY_ADDRESSES: '0.0.0.0/0,::/0', TRUSTED_PROXY_HEADER: 'x-real-ip',
    OPERATOR_TOKEN: 'o'.repeat(32) });
  Object.assign(inventory.mcp, { HOST: '::', PORT: '3700', DRAGONS_API_URL: 'http://server.railway.internal:3500',
    MCP_PUBLIC_URL: origins.mcp, MCP_TRUSTED_PROXY_ADDRESSES: '0.0.0.0/0,::/0' });
  Object.assign(inventory['database-release'], keeper.encode(), { REGISTER_DEPLOYMENT: 'true' });
  for (const [login, password] of Object.entries(passwords)) {
    inventory['database-release'][`${login.slice(3, -6).toUpperCase()}_DB_PASSWORD`] = password;
  }
  Object.assign(inventory.keeper, keeper.encode(), { KEEPER_MODE: stage === 'prepare' ? 'prepare' : 'sign' },
    stage === 'launch' ? { KEEPER_MARKET_KEY: null, KEEPER_ORACLE_KEY: null, KEEPER_COUNCIL_KEY: null, KEEPER_ROUNDS_KEY: null } : {});
  if (activeAgents) {
    Object.assign(inventory['agent-worker'], { AGENT_API_URL: plan.agent.apiUrl,
      AGENT_API_KEY: null, AGENT_API_WALLET_CONTRACT: 'wallets.near',
      AGENT_GRANT_KEY: null, AGENT_WORKER_TOKEN: 'w'.repeat(32),
      AGENT_WORKER_HOST: '::' });
    Object.assign(inventory.server, { AGENT_WORKER_URL: 'http://agent-worker.railway.internal:3510', AGENT_WORKER_TOKEN: 'w'.repeat(32) });
  }
  if (stage === 'launch') inventory.web = {
    NEXT_PUBLIC_RELEASE_COMMIT: plan.sourceCommit,
    NEXT_PUBLIC_NETWORK: 'mainnet', NEXT_PUBLIC_MARKET_ID: 'market.near', NEXT_PUBLIC_ORACLE_ID: 'oracle.near',
    NEXT_PUBLIC_COUNCIL_ID: 'council.near', NEXT_PUBLIC_VERIFIER_ID: 'intents.near', NEXT_PUBLIC_NFT_ID: 'nft.near',
    NEXT_PUBLIC_COLLATERAL_TOKEN_ID: 'nep141:usdc.near', NEXT_PUBLIC_TOKEN_ID: 'usdc.near',
    NEXT_PUBLIC_RPC_URL: plan.publicRpcUrl, NEXT_PUBLIC_BACKEND_URL: origins.server, NEXT_PUBLIC_MCP_URL: origins.mcp,
    ...(activeAgents ? { NEXT_PUBLIC_AGENT_WALLET_CONTRACT: 'wallets.near', NEXT_PUBLIC_AGENT_API_HOST: 'agents.example.com' } : {}),
  };
  const config = { services: {} };
  for (const service of all) {
    const value = config.services[service.id] = {};
    for (const [path, expected] of Object.entries(settings[service.name])) {
      const keys = path.split('.');
      let current = value;
      for (const key of keys.slice(0, -1)) current = current[key] ??= {};
      current[keys.at(-1)] = structuredClone(expected);
    }
  }
  const target = { projectToken: { projectId, environmentId }, environmentStagedChanges: null,
    environment: { id: environmentId, projectId, config,
      variables: { edges: all.flatMap(service => Object.entries(inventory[service.name]).map(([name, value]) => ({
        node: { id: `${service.id}:${name}`, name, serviceId: service.id, isSealed: value === null,
          updatedAt: '2026-11-08T00:00:00.000Z' },
      }))) },
      serviceInstances: { edges: [...all, { id: postgresId }].map(service => ({ node: { serviceId: service.id, numReplicas: 1,
        domains: { serviceDomains: [], customDomains: [] }, latestDeployment: null } })) },
      volumeInstances: { edges: [{ node: { serviceId: keeperId, mountPath: '/app/.local/feeds' } }] } } };
  const events = [];
  const options = { plan, stage, checkOnly: false,
    query: async (_query, variables) => variables.serviceId === postgresId ? { tcpProxies: [] } : variables.serviceId
      ? { variables: structuredClone(inventory[all.find(service => service.id === variables.serviceId).name]), tcpProxies: [] } : structuredClone(target),
    upload: async service => { events.push(`upload:${service.name}`); return { deploymentId }; },
    wait: async (_query, service) => { events.push(`ready:${service.name}`); },
    backups: async () => { events.push('backups'); }, contracts: async () => { events.push('contracts'); },
    operational: async (_plan, token, signed) => { assert.equal(token, inventory.server.OPERATOR_TOKEN); events.push(`health:${signed}`); },
    probe: async () => ({ version: 1, ...Object.fromEntries(['marketId', 'oracleId', 'councilId', 'verifierId',
      'nftId', 'collateralTokenId', 'tokenId', 'agentWalletContract', 'agentApiHost'].map(key => [key, ''])) }),
    smokeCheck: async (_web, _server, _mcp, _origin, expected) => {
      assert.deepEqual(expected.browser, expectedBrowser(plan)); events.push('smoke');
    }, report() {},
  };
  return { raw, plan, target, inventory, events, options };
}

function operationalStatus(plan, signed = true, now = Date.now()) {
  return { deploymentConfigured: true, indexing: { deploymentId: plan.approval.deployment.id, live: true,
    source: { mode: 'live' }, lagBlocks: '2', checkpoint: { timestampNs: String(BigInt(now - 1000) * 1000000n) } },
  reconciliation: { solvent: true, checked_at: new Date(now - 1000).toISOString() },
  chainIntegrity: { ok: true, checked_at: new Date(now - 1000).toISOString() },
  keeper: { state: 'ready', mode: signed ? 'sign' : 'prepare', last_success_at: new Date(now - 1000).toISOString() },
  alerts: signed ? [] : ['keeper_signing_disabled'] };
}

test('activation pins exact reviewed bytes, commit, identity and public destinations', () => {
  const { raw } = fixture();
  assert.throws(() => parseActivation(raw + ' ', digest(raw)), /digest/);
  for (const changed of [{ sourceCommit: 'main' }, { sourceCommit: '0'.repeat(40) }, { profile: 'mock' },
    { keeperServiceId: services[0].id }, { publicRpcUrl: 'https://rpc.invalid/?secret=test' },
    { publicRpcUrl: 'https://user:password@rpc.invalid' }, { agent: {} }, { keeperApproval: {} }]) {
    const bad = JSON.stringify({ ...JSON.parse(raw), ...changed });
    assert.throws(() => parseActivation(bad, digest(bad)));
  }
});

test('preparation and launch checks never upload; launch stages deploy serially with web last', async () => {
  for (const stage of ['prepare', 'launch']) for (const profile of ['human', 'agents']) {
    const f = fixture(stage, profile);
    await activatedRelease({ ...f.options, checkOnly: true });
    assert.equal(f.events.some(event => event.startsWith('upload:')), false);
    f.events.length = 0;
    await activatedRelease(f.options);
    const order = activationServices(f.plan, stage).flatMap(service => [`upload:${service.name}`, `ready:${service.name}`]);
    assert.deepEqual(f.events.filter(event => /^(upload|ready):/.test(event)), order);
    if (stage === 'prepare') assert.equal(f.events.includes('upload:web'), false);
    else {
      assert.ok(f.events.indexOf('health:true') < f.events.indexOf('upload:web'));
      assert.equal(f.events.at(-1), 'smoke');
    }
  }
});

test('missing approval, backups or live health blocks the very first upload', async () => {
  for (const gate of ['backups', 'contracts', 'operational']) {
    const f = fixture();
    await assert.rejects(activatedRelease({ ...f.options, [gate]: async () => { throw new Error(gate); } }), new RegExp(gate));
    assert.equal(f.events.some(event => event.startsWith('upload:')), false);
  }
  const f = fixture();
  delete f.plan.launchEvidence;
  await assert.rejects(activatedRelease(f.options), /evidence/);
  assert.equal(f.events.length, 0);
});

test('failed registration prevents workers; signing failure prevents publication', async () => {
  for (const failure of ['database-release', 'keeper']) {
    const f = fixture();
    await assert.rejects(activatedRelease({ ...f.options, wait: async (_query, service) => {
      if (service.name === failure) throw new Error('job failed');
    } }), /job failed/);
    assert.equal(f.events.at(-1), `upload:${failure}`);
    assert.equal(f.events.includes('upload:web'), false);
  }
});

test('completed jobs must emit their own successful result for the approved deployment and mode', async () => {
  for (const stage of ['prepare', 'launch']) {
    const f = fixture(stage);
    await activatedRelease({ ...f.options, wait: async (_query, service) => {
      if (!service.job) return;
      const messages = {
        'database-release': { service: 'database-release', registered: f.plan.approval.deployment.id },
        'verify-chain': { ok: true, problems: [] },
        keeper: { service: 'keeper', mode: stage === 'prepare' ? 'prepare' : 'sign', signing: stage === 'launch', current: true },
      };
      assert.equal(service.completed('Starting Container'), false);
      assert.equal(service.completed('{}'), false);
      assert.equal(service.completed('null'), false);
      assert.equal(service.completed(JSON.stringify(messages[service.name])), true);
      assert.equal(service.completed(JSON.stringify({ ...messages[service.name], registered: 'wrong', ok: false, mode: 'wrong' })), false);
    } });
  }
});

test('configuration and credential boundaries reject partial, leaking or incompatible activation', () => {
  for (const mutate of [
    v => { v.server.NETWORK = 'testnet'; }, v => { v.indexer.DEPLOYMENT_START_BLOCK = '101'; },
    v => { v.reconcile.RPC_SECOND_URL = 'https://different.invalid'; },
    v => { v.keeper.DATABASE_URL = v['database-release'].DATABASE_URL; },
    v => { v['database-release'].API_DB_PASSWORD = v['database-release'].WORKER_DB_PASSWORD; },
    v => { v['database-release'].KEEPER_DB_PASSWORD = '9'.repeat(64); },
    v => { v.server.AGENT_API_KEY = 'private-value'; }, v => { v.web.DATABASE_URL = 'private-value'; },
    v => { v.web.NEXT_PUBLIC_AGENT_API_KEY = 'private-value'; }, v => { v.mcp.OPERATOR_TOKEN = 'private-value'; },
    v => { v.prices.PUBLISH_ROUND_PRICES = 'true'; }, v => { v.server.TRUSTED_PROXY_HOPS = '0'; },
    v => { v.mcp.HOST = '127.0.0.1'; }, v => { v.keeper.RAILWAY_RUN_UID = '00'; },
    v => { v.web.RAILWAY_RUN_UID = '0'; },
    v => { v.keeper.KEEPER_MARKET_KEY = 'must-not-be-readable'; },
    v => { v['database-release'].KEEPER_APPROVAL_SHA256 = '0'.repeat(64); },
    v => { v.indexer.NEARDATA_INTERVAL_MS = '100'; }, v => { v.indexer.NEARDATA_CONCURRENCY = '10'; },
    v => { v.web.NEXT_PUBLIC_NFT_ID = 'unapproved.near'; }, v => { delete v.keeper; },
  ]) {
    const f = fixture(); mutate(f.inventory);
    assert.throws(() => verifyActivationVariables(f.plan, 'launch', f.inventory),
      error => !error.message.includes('private-value'));
  }
});

test('execution credentials must be sealed on their owning service before any values are requested', async () => {
  for (const mutate of [
    rows => { rows.find(row => row.name === 'KEEPER_MARKET_KEY').isSealed = false; },
    rows => { rows.find(row => row.name === 'KEEPER_ORACLE_KEY').serviceId = services[1].id; },
    rows => { rows.find(row => row.name === 'KEEPER_COUNCIL_KEY').serviceId = null; },
    rows => { rows.find(row => row.name === 'KEEPER_ROUNDS_KEY').isSealed = false; },
    rows => { rows.find(row => row.name === 'KEEPER_ROUNDS_KEY').serviceId = agentService.id; },
    rows => { rows.splice(rows.findIndex(row => row.name === 'KEEPER_MARKET_KEY'), 1); },
    rows => { rows.push({ ...rows.find(row => row.name === 'KEEPER_MARKET_KEY'), id: 'duplicate' }); },
    rows => { rows.find(row => row.name === 'AGENT_API_KEY').isSealed = false; },
    rows => { rows.find(row => row.name === 'AGENT_GRANT_KEY').serviceId = keeperId; },
  ]) {
    const f = fixture('launch', 'agents');
    const rows = f.target.environment.variables.edges.map(({ node }) => node);
    mutate(rows);
    f.target.environment.variables.edges = rows.map(node => ({ node }));
    let reads = 0;
    await assert.rejects(activatedRelease({ ...f.options, query: (query, variables) => {
      if (variables.serviceId) reads++;
      return f.options.query(query, variables);
    } }), /sealed service boundary/);
    assert.equal(reads, 0);
    assert.equal(f.events.length, 0);
  }
  for (const [stage, profile, name, serviceId] of [
    ['prepare', 'human', 'KEEPER_MARKET_KEY', keeperId],
    ['prepare', 'human', 'KEEPER_ROUNDS_KEY', keeperId],
    ['prepare', 'agents', 'AGENT_API_KEY', agentService.id],
    ['launch', 'human', 'AGENT_GRANT_KEY', agentService.id],
  ]) {
    const f = fixture(stage, profile);
    f.target.environment.variables.edges.push({ node: { name, serviceId, isSealed: true } });
    await assert.rejects(activatedRelease(f.options), /sealed service boundary/);
    assert.equal(f.events.length, 0);
  }
});

test('wrong mounts, staged configuration and running deferred workers block preparation', async () => {
  for (const mutate of [
    f => { f.target.environment.volumeInstances.edges = []; },
    f => { f.target.environmentStagedChanges = { patch: { services: {} } }; },
    f => { f.target.environment.config.services[keeperId].deploy.cronSchedule = '* * * * *'; },
    f => { f.target.environment.serviceInstances.edges.find(edge => edge.node.serviceId === keeperId).node.numReplicas = 2; },
    f => { f.target.environment.serviceInstances.edges.find(edge => edge.node.serviceId === agentService.id)
      .node.domains.serviceDomains = [{ domain: 'worker.invalid' }]; },
    f => { f.target.environment.serviceInstances.edges.find(edge => edge.node.serviceId === pricesService.id)
      .node.latestDeployment = { deploymentStopped: false }; },
    f => { f.inventory.keeper.KEEPER_MARKET_KEY = 'unexpected'; },
    f => { f.inventory['agent-worker'].AGENT_API_KEY = 'unexpected'; },
    f => { f.inventory.web.NEXT_PUBLIC_MARKET_ID = 'market.near'; },
  ]) {
    const f = fixture('prepare'); mutate(f);
    await assert.rejects(activationSnapshot(f.options.query, f.plan, 'prepare'));
  }
  const f = fixture('prepare');
  await assert.rejects(activatedRelease({ ...f.options, probe: async () => expectedBrowser(f.plan) }), /inactive browser/);
  await assert.rejects(activationSnapshot(async (query, variables) => ({ ...await f.options.query(query, variables),
    ...(variables.serviceId && variables.serviceId !== postgresId
      ? { tcpProxies: [{ id: 'unexpected-public-proxy' }] } : {}) }), f.plan, 'prepare'), /TCP exposure/);
  await assert.rejects(activationSnapshot(async (query, variables) => ({ ...await f.options.query(query, variables),
    ...(variables.serviceId === postgresId ? { tcpProxies: [{ id: 'public-database' }] } : {}) }),
  f.plan, 'prepare'), /Postgres must remain private/);
});

test('platform deployment metadata may change but application variables may not drift between uploads', async () => {
  const f = fixture();
  await activatedRelease({ ...f.options, upload: async service => {
    f.inventory[service.name].RAILWAY_DEPLOYMENT_ID = deploymentId;
    return f.options.upload(service);
  } });
  const changed = fixture();
  await assert.rejects(activatedRelease({ ...changed.options, upload: async service => {
    changed.inventory.server.OPERATOR_TOKEN = 'n'.repeat(32);
    return changed.options.upload(service);
  } }), /variables changed/);
  assert.deepEqual(changed.events.filter(event => event.startsWith('upload:')), ['upload:database-release']);

  const rotated = fixture();
  await assert.rejects(activatedRelease({ ...rotated.options, upload: async service => {
    rotated.target.environment.variables.edges.find(({ node }) => node.name === 'KEEPER_MARKET_KEY')
      .node.updatedAt = '2026-11-08T00:01:00.000Z';
    return rotated.options.upload(service);
  } }), /metadata changed/);
  assert.deepEqual(rotated.events.filter(event => event.startsWith('upload:')), ['upload:database-release']);
});

test('current indexing, solvency, integrity, keeper mode and alert status are all mandatory', () => {
  const { plan } = fixture(), now = Date.now();
  verifyOperational(operationalStatus(plan, false, now), plan, false, now);
  verifyOperational(operationalStatus(plan, true, now), plan, true, now);
  for (const mutate of [
    s => { s.deploymentConfigured = false; }, s => { s.indexing.deploymentId = 'old'; },
    s => { s.indexing.source.mode = 'historical'; }, s => { s.indexing.lagBlocks = '101'; },
    s => { s.indexing.checkpoint.timestampNs = '0'; },
    s => { s.indexing.checkpoint.timestampNs = String(BigInt(now + 1000) * 1000000n); },
    s => { s.reconciliation.solvent = false; }, s => { s.reconciliation.checked_at = '1970-01-01'; },
    s => { s.chainIntegrity.ok = false; }, s => { s.chainIntegrity.checked_at = new Date(now + 1000).toISOString(); },
    s => { s.keeper.mode = 'prepare'; }, s => { s.keeper.state = 'failed'; },
    s => { s.keeper.last_success_at = null; }, s => { s.alerts = ['keeper_signing_disabled']; },
    s => { delete s.alerts; },
  ]) {
    const status = operationalStatus(plan, true, now); mutate(status);
    assert.throws(() => verifyOperational(status, plan, true, now));
  }
});

test('operator credential goes only to the exact private health route; HTTP probes are bounded', async () => {
  const { plan } = fixture();
  const token = 'operator-fixture';
  await checkOperational(plan, token, true, async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, url.endsWith('/v1/operator/services') ? `Bearer ${token}` : undefined);
    assert.equal(new URL(url).origin, origins.server);
    if (url.endsWith('/health/ready')) return Response.json({ status: 'ready', checks: { database: 'ok', schema: 'current' },
      deploymentConfigured: true, indexing: 'see_indexer_status' });
    if (url.endsWith('/v1/config')) return Response.json({ network: 'mainnet', deployment: plan.approval.deployment,
      capabilities: { indexing: true, walletSessions: true, agents: false, trading: false, funding: false } });
    return Response.json(operationalStatus(plan));
  });
  await assert.rejects(json('https://test.invalid', null, async () => new Response('x'.repeat(65537))), /response limit/);
  await assert.rejects(json('https://test.invalid', token, async () => new Response('secret', { status: 403 })), /probe failed/);
});
