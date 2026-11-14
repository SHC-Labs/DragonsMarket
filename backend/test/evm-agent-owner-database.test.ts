import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import pg from 'pg';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentApiClient, type OwnerIntent } from '../src/agent-api.js';
import type { AgentAccounts } from '../src/agent-accounts.js';
import { agentGateway } from '../src/agent-gateway.js';
import { createAgentRoutes } from '../src/agent-routes.js';
import { createAgentWorkerServer } from '../src/agent-worker-server.js';
import { evmConsent } from '../src/agent-evm-consent.js';
import { createApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { migrate } from '../src/migrate.js';
import { operationStore } from '../src/operations.js';
import { createPrivateApi } from '../src/private-api.js';
import { consentFixture, evmConsentFixture } from './owner-intent-fixture.js';
import { policyFixture, policyOwner, policyWallet } from './evm-policy-fixture.js';

const AGENT = 'a'.repeat(64), WORKER_TOKEN = 'w'.repeat(32);
const PRINCIPAL = `eip155:8453:${policyOwner.address}`;
const OTHER = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
const PATH = `/v1/agents/${AGENT}`;
const unexpected = () => { throw new Error('inspection and revocation must not execute or fund an agent'); };

function provider() {
  const requests: string[] = [], generated = new Map<string, OwnerIntent>();
  const submitted = new Set<string>();
  const state = { fail: false, wrongOwner: false, wrongTarget: false };
  const status = (id: string) => ({ correlation_id: id, type: 'grant_revoke', agent_id: AGENT,
    status: submitted.has(id) ? 'SUCCESS' : 'PENDING_SIGNATURE', failure_code: null, details: {} });
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input as URL, init), url = new URL(request.url);
    requests.push(url.pathname);
    if (url.pathname === '/v1/generate-intent') {
      if (state.fail) return Response.json({}, { status: 503 });
      const asked = await request.json() as Record<string, unknown>;
      assert.equal(asked.type, 'grant_revoke');
      assert.equal(asked.agent_id, AGENT);
      const signer = { ...policyOwner, ...(state.wrongOwner ? { chain_id: 1 } : {}) };
      const consent = consentFixture({ ...asked, ...(state.wrongTarget ? { grant_id: 'wrong-grant' } : {}) }, signer);
      const intent: OwnerIntent = { correlation_id: `intent_${randomUUID()}`, type: 'grant_revoke',
        agent_id: AGENT, signer, status: 'PENDING_SIGNATURE',
        expires_at: new Date(Date.now() + 300000).toISOString(), preview: { summary: 'Revoke grant' },
        intent: { standard: 'eip712', payload: evmConsentFixture(consent.payload.message) } };
      generated.set(intent.correlation_id, intent);
      return Response.json(intent, { status: 201 });
    }
    if (url.pathname === '/v1/submit-intent') {
      const body = await request.json() as { correlation_id: string; signed_data: { signature: string } };
      assert.ok(generated.has(body.correlation_id));
      assert.match(body.signed_data.signature, /^0x[0-9a-f]{130}$/);
      submitted.add(body.correlation_id);
      return Response.json(status(body.correlation_id), { status: 202 });
    }
    if (url.pathname === '/v1/status') return Response.json(status(url.searchParams.get('correlation_id')!));
    throw new Error(`Unexpected provider request: ${url.pathname}`);
  };
  return { transport, requests, submitted, state };
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function stop(server: Server) {
  server.closeAllConnections();
  return server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
}

async function harness(run: (h: {
  pool: pg.Pool; account: string; fake: ReturnType<typeof provider>;
  call: (cookie: string, method: string, path: string, body?: unknown) => Promise<Response>;
  login: (wallet?: typeof policyWallet, chainId?: number) => Promise<string>;
}) => Promise<void>) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Set TEST_DATABASE_URL; this test uses an isolated schema');
  const schema = `evm_owner_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const config = readConfig({ DATABASE_URL: url, NETWORK: 'mainnet', WEB_ORIGIN: 'https://dragons.example',
    DEPLOYMENT_ID: 'evm-owner-test', DEPLOYMENT_START_BLOCK: '0', MARKET_CONTRACT_ID: 'market.example.near',
    VERIFIER_CONTRACT_ID: 'verifier.example.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.example.near' });
  const deployment = config.deployment!, fake = provider();
  const api = new AgentApiClient({ url: 'https://agents.example.com', key: `naa_${'k'.repeat(43)}`,
    timeoutMs: 1000 }, fake.transport);
  const services: AgentAccounts = { db: pool, deployment, api, grantKey: Buffer.alloc(32, 1),
    webOrigin: config.webOrigin,
    signing: { network: 'mainnet', messageRecipient: 'agents.example.com', walletContract: 'wallets.example.near' },
    checkKey: unexpected, chain: { view: unexpected, nearBalance: unexpected },
    runner: { deployment, api, waitMs: 0, operations: operationStore(pool, deployment.id),
      authorize: unexpected, transaction: unexpected } };
  const worker = createAgentWorkerServer(createAgentRoutes(services), WORKER_TOKEN);
  const workerUrl = await listen(worker);
  const gateway = agentGateway({ url: workerUrl, token: WORKER_TOKEN });
  const app = createApp(config, async () => {}, undefined, undefined,
    createPrivateApi(pool, config, unexpected, null, gateway));
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await registerDeployment(pool, config);
    const account = randomUUID();
    await pool.query(`INSERT INTO agent_accounts
      (id,deployment_id,owner_account_id,name,agent_id,near_account_id,state)
      VALUES($1,$2,$3,'EVM agent',$4,$5,'active')`, [account, deployment.id, PRINCIPAL, AGENT, 'd'.repeat(64)]);
    const root = await listen(app);
    const call = (cookie: string, method: string, path: string, body?: unknown) => fetch(root + path, {
      method, headers: { Cookie: cookie, Origin: config.webOrigin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const login = async (wallet = policyWallet, chainId = 8453) => {
      const response = await call('', 'POST', '/v1/auth/evm/challenge', { address: wallet.address, chainId });
      assert.equal(response.status, 200);
      const challenge = await response.json();
      const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
      const proof = { id: challenge.id, signature: await wallet.signMessage({ message: challenge.message }) };
      const verified = await call(cookie, 'POST', '/v1/auth/evm/verify', proof);
      assert.equal(verified.status, 200);
      return verified.headers.getSetCookie()[0]!.split(';')[0]!;
    };
    await run({ pool, account, fake, call, login });
  } finally {
    await stop(app);
    await stop(worker);
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function delegation(pool: pg.Pool, account: string) {
  const grant = randomUUID(), access = randomUUID();
  await pool.query(`INSERT INTO agent_grants
    (id,agent_account,commitment,sealed_token,label,api_grant_id,state,expires_at)
    VALUES($1,$2,$3,$4,'Dragons Market','provider-grant','live',now()+interval '1 day')`,
  [grant, account, 'b'.repeat(64), Buffer.from('test-only-sealed-token')]);
  await pool.query(`INSERT INTO agent_access_tokens
    (id,agent_account,token_hash,label,max_spend,daily_limit,message,nonce,expires_at)
    VALUES($1,$2,$3,'MCP',1000000,2000000,'previous consent','nonce',now()+interval '1 day')`,
  [access, account, tokenHash('dmk_test')]);
  return { grant, access };
}

const revocationState = (pool: pg.Pool, account: string) => pool.query(`SELECT g.state,g.sealed_token,
  t.revoked_at IS NOT NULL AS access_revoked FROM agent_grants g
  JOIN agent_access_tokens t ON t.agent_account=g.agent_account WHERE g.agent_account=$1`, [account])
  .then(result => result.rows[0]);

test('SIWE sessions traverse the API and private worker without sharing agents across wallets or chains',
  () => harness(async ({ pool, call, login, fake }) => {
    const owner = await login(), differentChain = await login(policyWallet, 1), other = await login(OTHER);
    const ours = await call(owner, 'GET', '/v1/agents');
    assert.equal(ours.status, 200);
    assert.equal((await ours.json()).data[0].agent_id, AGENT);
    for (const cookie of [differentChain, other]) {
      const response = await call(cookie, 'GET', '/v1/agents');
      assert.deepEqual((await response.json()).data, []);
      assert.equal((await call(cookie, 'GET', `${PATH}/operations`)).status, 404);
      assert.equal((await call(cookie, 'POST', `${PATH}/revoke`)).status, 404);
    }
    assert.equal((await call(owner, 'GET', `${PATH}/operations`)).status, 200);
    assert.deepEqual((await (await call(owner, 'GET', `${PATH}/claimable`)).json()).data, []);
    assert.deepEqual(fake.requests, []);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_accounts')).rows[0].n, 1);
  }));

test('EVM sessions cannot provision agents, grant authority, approve MCP or route a cash-out',
  () => harness(async ({ call, login, fake, pool }) => {
    const cookie = await login();
    for (const path of ['/v1/agents', `${PATH}/grant`, `${PATH}/actions`, `${PATH}/freeze`,
      `${PATH}/unfreeze`, `${PATH}/access`, `${PATH}/access/${randomUUID()}/sign`]) {
      const response = await call(cookie, 'POST', path, { name: 'Agent', owner: 'attacker.near',
        action: { kind: 'cash_out', amount: '1', recipient: 'attacker.near' } });
      assert.equal(response.status, 409, path);
      assert.equal((await response.json()).error.code, 'agent_owner_wallet_not_supported');
    }
    assert.deepEqual(fake.requests, []);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_grants')).rows[0].n, 0);
  }));

test('EVM owners can inspect and revoke a connection without disclosing its bearer token',
  () => harness(async ({ pool, account, call, login, fake }) => {
    const { access } = await delegation(pool, account);
    const cookie = await login(), other = await login(OTHER);
    const list = await (await call(cookie, 'GET', `${PATH}/access`)).json();
    assert.equal(list.data[0].id, access);
    assert.ok(!JSON.stringify(list).includes('token_hash'));
    assert.equal((await call(other, 'POST', `${PATH}/access/${access}/revoke`)).status, 404);
    assert.equal((await call(cookie, 'POST', `${PATH}/access/${access}/revoke`)).status, 200);
    assert.deepEqual((await (await call(cookie, 'GET', `${PATH}/access`)).json()).data, []);
    assert.deepEqual(fake.requests, []);
  }));

test('EVM grant revocation disables local authority before signing and submits only the exact owner proof',
  () => harness(async ({ pool, account, call, login, fake }) => {
    await delegation(pool, account);
    const cookie = await login(), otherChain = await login(policyWallet, 1);
    const response = await call(cookie, 'POST', `${PATH}/revoke`);
    assert.equal(response.status, 200);
    assert.deepEqual(await revocationState(pool, account), { state: 'revoked', sealed_token: null, access_revoked: true });
    const generated = (await response.json()).data[0] as OwnerIntent;
    assert.deepEqual(generated.signer, policyOwner);
    const typed = evmConsent(generated.intent.payload, 'agents.example.com')!;
    const signed = { standard: 'eip712', payload: typed, signature: await policyWallet.signTypedData(typed) };
    const path = `/v1/agent-intents/${generated.correlation_id}`;
    assert.equal((await call(otherChain, 'POST', path, { signed_data: signed })).status, 404);
    assert.equal((await call(cookie, 'POST', path, { signed_data: { ...signed,
      signature: await OTHER.signTypedData(typed) } })).status, 400);
    assert.equal((await call(cookie, 'POST', path, { signed_data: { ...signed,
      payload: { ...typed, message: { ...typed.message, recipient: 'attacker.example' } } } })).status, 400);
    await pool.query('UPDATE agent_intents SET intent=$2 WHERE correlation_id=$1',
      [generated.correlation_id, { ...generated, signer: { ...policyOwner, chain_id: 1 } }]);
    assert.equal((await call(cookie, 'POST', path, { signed_data: signed })).status, 403);
    await pool.query('UPDATE agent_intents SET intent=$2 WHERE correlation_id=$1',
      [generated.correlation_id, { ...generated, intent: { ...generated.intent, standard: 'nep366' } }]);
    assert.equal((await call(cookie, 'POST', path, {
      signed_data: { ...signed, standard: 'nep366' },
    })).status, 400);
    await pool.query('UPDATE agent_intents SET intent=$2 WHERE correlation_id=$1',
      [generated.correlation_id, { ...generated, expires_at: new Date(Date.now() - 1000).toISOString() }]);
    assert.equal((await call(cookie, 'POST', path, { signed_data: signed })).status, 409);
    await pool.query('UPDATE agent_intents SET intent=$2 WHERE correlation_id=$1',
      [generated.correlation_id, generated]);
    assert.equal(fake.submitted.size, 0);
    const submitted = await call(cookie, 'POST', path, { signed_data: signed });
    assert.equal(submitted.status, 200);
    assert.equal((await submitted.json()).status, 'SUCCESS');
    assert.equal(fake.submitted.size, 1);
    assert.equal((await (await call(cookie, 'POST', path + '/status')).json()).status, 'SUCCESS');
    assert.equal((await pool.query('SELECT status FROM agent_intents WHERE correlation_id=$1',
      [generated.correlation_id])).rows[0].status, 'SUCCESS');
  }));

test('provider failure or substituted revocation consent cannot restore local authority',
  () => harness(async ({ pool, account, call, login, fake }) => {
    await delegation(pool, account);
    const cookie = await login();
    for (const flag of ['fail', 'wrongOwner', 'wrongTarget'] as const) {
      fake.state[flag] = true;
      assert.equal((await call(cookie, 'POST', `${PATH}/revoke`)).status, 502, flag);
      assert.deepEqual(await revocationState(pool, account), {
        state: 'revoked', sealed_token: null, access_revoked: true,
      });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_intents')).rows[0].n, 0);
      fake.state[flag] = false;
    }
    assert.equal((await call(cookie, 'POST', `${PATH}/revoke`)).status, 200);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_intents')).rows[0].n, 1);
    assert.equal(fake.submitted.size, 0);
  }));

test('the generic intent submission path cannot bypass the EVM activation guard',
  () => harness(async ({ pool, account, call, login, fake }) => {
    const { generated } = policyFixture('agent_freeze');
    await pool.query(`INSERT INTO agent_intents(correlation_id,agent_account,type,intent,status,expires_at)
      VALUES($1,$2,$3,$4,'PENDING_SIGNATURE',$5)`,
    [generated.correlation_id, account, generated.type, generated, generated.expires_at]);
    const cookie = await login();
    const response = await call(cookie, 'POST', `/v1/agent-intents/${generated.correlation_id}`, {
      signed_data: { standard: generated.intent.standard, payload: generated.intent.payload },
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'agent_owner_wallet_not_supported');
    assert.deepEqual(fake.requests, []);
  }));
