import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { readConfig, type Config } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { createApp } from '../src/app.js';
import { createPrivateApi } from '../src/private-api.js';
import { challenge, login } from '../src/auth.js';
import { AgentApiClient } from '../src/agent-api.js';
import { createAgentRoutes } from '../src/agent-routes.js';
import {
  issueGrant, ownerIntentStatus, runOwnedAction, submitOwnerIntent, type AgentAccounts,
} from '../src/agent-accounts.js';
import { operationStore } from '../src/operations.js';
import type { AgentRunner } from '../src/agents.js';

type Body = Record<string, unknown>;
const WALLET_CONTRACT = 'wallets.example.near';
const nearAccountOf = (agentId: string) => `d${agentId.slice(1)}`;
const at = '2030-01-01T00:00:00.000Z';

function fakeAgentApi() {
  const requests: { path: string; headers: Headers; body: Body | null }[] = [];
  const intents = new Map<string, { type: string; agentId: string; credential?: unknown; submitted: boolean }>();
  const operations = new Map<string, { type: string; agentId: string; details: Body; call: Body }>();
  const owners = new Map<string, unknown>();
  const state = { created: 0, forge: false, widen: false, foreignGrant: false, reuseHash: false, slowSend: false,
    busy: false };
  const payload = (type: string) => {
    if (type === 'grant_issue') {
      return { message: '{"grant":1}', recipient: 'agents.example.com', nonce: randomBytes(32).toString('base64') };
    }
    const call = { methodName: state.forge ? 'ft_transfer' : 'store_wallet_policy', args: {}, gas: '1', deposit: '0' };
    const receiverId = state.forge ? 'usdc.test.near' : WALLET_CONTRACT;
    return { receiverId, actions: [{ type: 'FunctionCall', params: call }] };
  };
  const status = (id: string, type: string, agentId: string, s: string, details: Body) => ({ correlation_id: id,
    agent_id: agentId, type, status: s, failure_code: null, created_at: at, updated_at: at,
    dispatch_committed_at: null, grant: null, details });
  const generated = (body: Body) => {
    const id = `intent_${randomUUID()}`, type = String(body.type);
    const agentId = type === 'agent_create' ? (++state.created).toString(16).padStart(64, 'c') : String(body.agent_id);
    if (type === 'agent_create') owners.set(agentId, body.owner);
    intents.set(id, { type, agentId, credential: body.credential, submitted: false });
    const policy = state.widen && body.policy ? { ...body.policy as Body, actions: ['withdraw', 'swap'] } : body.policy;
    return { correlation_id: id, type, agent_id: agentId, status: 'PENDING_SIGNATURE',
      expires_at: new Date(Date.now() + 600000).toISOString(), signer: owners.get(agentId),
      intent: { standard: type === 'grant_issue' ? 'nep413' : 'nep366', payload: payload(type) },
      preview: { summary: `Sign ${type}`, ...(policy ? { policy } : {}) } };
  };
  const intentStatus = (id: string) => {
    const intent = intents.get(id)!;
    const credential = state.foreignGrant ? 'f'.repeat(64) : intent.credential;
    const details = intent.type === 'grant_issue' ? { grant: { grant_id: `grant-${id}`, agent_id: intent.agentId,
      revoked_at: null, owner_message: { credential } } } : {};
    return status(id, intent.type, intent.agentId, intent.submitted ? 'SUCCESS' : 'PENDING_SIGNATURE', details);
  };
  const send = (agentId: string, kind: string, body: Body) => {
    const id = `op_${randomUUID()}`, type = kind === 'withdraw' ? 'withdraw' : 'native';
    const details = type === 'withdraw' ? { action: 'withdraw', request: body }
      : { method: 'near_call', chain: 'near', account_id: nearAccountOf(agentId), target: body.receiver_id,
        method_name: body.method_name, tx_hash: null };
    operations.set(id, { type, agentId, details, call: body });
    return status(id, type, agentId, 'PROCESSING', details);
  };
  const transaction = (hash: string, sender: string) => {
    const latest = [...operations.values()].filter(o => o.type === 'native').at(-1);
    const call = (operations.get(hash.slice('tx-'.length)) ?? latest)?.call ?? {}, args = (call.args ?? {}) as Body;
    return { signer: sender, receiver: String(call.receiver_id),
      calls: [{ method: String(call.method_name), args, deposit: String(call.deposit) }],
      events: [{ executor: 'rounds.test.near', standard: 'rounds', event: 'staked', data: { account: sender,
        series_id: 0, round: '42', side: 'up', amount: typeof args.amount === 'string' ? args.amount : '5000000' } }] };
  };
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input as URL, init), url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() as Body : null;
    requests.push({ path: url.pathname, headers: request.headers, body });
    const reply = (code: number, value: unknown) => new Response(JSON.stringify(value), { status: code });
    const wallet = /^\/v1\/agents\/([0-9a-f]{64})\/wallet$/.exec(url.pathname);
    const write = /^\/v1\/agents\/([0-9a-f]{64})\/(native\/near\/call|withdraw)$/.exec(url.pathname);
    if (url.pathname === '/v1/generate-intent' && body) return reply(201, generated(body));
    if (url.pathname === '/v1/submit-intent' && body) {
      const intent = intents.get(String(body.correlation_id))!;
      intent.submitted = true;
      return reply(202, status(String(body.correlation_id), intent.type, intent.agentId, 'PROCESSING', {}));
    }
    if (url.pathname === '/v1/status') {
      const id = url.searchParams.get('correlation_id')!, op = operations.get(id);
      if (!op) return reply(200, intentStatus(id));
      const txHash = state.reuseHash ? 'tx-reused' : `tx-${id}`;
      return reply(200, status(id, op.type, op.agentId, 'SUCCESS', { ...op.details, tx_hash: txHash }));
    }
    if (wallet) return reply(200, { wallet_id: 'w1', near_account_id: nearAccountOf(wallet[1]!) });
    if (write && state.busy) {
      return reply(409, { errors: [{ status: '409', code: 'operation_in_flight', layer: 'request', title: 'Busy',
        meta: { retryable: true } }], meta: {} });
    }
    if (write && state.slowSend) await new Promise(resolve => setTimeout(resolve, 300));
    if (write && body) return reply(202, send(write[1]!, write[2]!, body));
    return reply(404, { errors: [{ status: '404', code: 'not_found', layer: 'request', title: 'Not found' }],
      meta: {} });
  };
  return { transport, requests, state, transaction };
}

interface Harness {
  pool: pg.Pool;
  config: Config;
  fake: ReturnType<typeof fakeAgentApi>;
  services: (grantKey?: Buffer) => AgentAccounts;
  signIn: (accountId: string) => Promise<{ token: string; publicKey: string }>;
  call: (token: string, method: string, path: string, body?: unknown, origin?: string) => Promise<Reply>;
  raw: (method: string, path: string, body: unknown, headers: Record<string, string>) => Promise<Reply>;
}
type Reply = { status: number; body: Body & { error?: { code: string } } };

async function withAgents(run: (h: Harness) => Promise<void>) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Set TEST_DATABASE_URL explicitly; tests create and remove an isolated schema');
  const schema = `agents_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const config = readConfig({ DATABASE_URL: url, DEPLOYMENT_ID: 'agents-test', DEPLOYMENT_START_BLOCK: '0',
    ROUNDS_CONTRACT_ID: 'rounds.test.near', VERIFIER_CONTRACT_ID: 'verifier.test.near',
    COLLATERAL_TOKEN_ID: 'nep141:usdc.test.near', AGENT_API_URL: 'https://agents.example.com',
    AGENT_API_KEY: `naa_${'k'.repeat(43)}`, AGENT_GRANT_KEY: randomBytes(32).toString('base64'),
    AGENT_API_WALLET_CONTRACT: WALLET_CONTRACT });
  const deployment = config.deployment!, fake = fakeAgentApi();
  const api = new AgentApiClient(config.agentApi!, fake.transport);
  const runner: AgentRunner = {
    deployment, api, waitMs: 0,
    view: async (_contract, method) => (method === 'config' ? { storage_deposit: '7' } : null),
    transaction: async (hash, sender) => fake.transaction(hash, sender),
    operations: operationStore(pool, deployment.id),
  };
  const chain = { nearBalance: async () => '200000000000000000000000' };
  const services = (grantKey = config.agentAccounts!.grantKey): AgentAccounts => ({ db: pool, deployment, api, runner,
    chain, grantKey, signing: { walletContract: WALLET_CONTRACT, messageRecipient: 'agents.example.com' } });
  const app = createApp(config, async () => {}, undefined, undefined,
    createPrivateApi(pool, config, async () => true, null, createAgentRoutes(services())));
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await registerDeployment(pool, config);
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const address = app.address();
    assert.ok(address && typeof address !== 'string');
    const signIn = async (accountId: string) => {
      const key = KeyPair.fromRandom('ed25519'), signer = new KeyPairSigner(key);
      const c = await challenge(pool, config, accountId);
      const s = await signer.signNep413Message(accountId, { message: c.request.message,
        nonce: Buffer.from(c.request.nonce, 'base64'), recipient: c.request.recipient });
      const token = await login(pool, config, c.request.id, s.publicKey.toString(),
        Buffer.from(s.signature).toString('base64'), c.browser, async () => true);
      return { token, publicKey: key.getPublicKey().toString() };
    };
    const raw: Harness['raw'] = async (method, path, body, headers) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as Reply['body'] };
    };
    const call: Harness['call'] = (token, method, path, body, origin = config.webOrigin) =>
      raw(method, path, body, { Origin: origin, Cookie: `dm_session=${token}` });
    await run({ pool, config, fake, services, signIn, call, raw });
  } finally {
    app.closeAllConnections();
    if (app.listening) await new Promise<void>((resolve, reject) => app.close(e => (e ? reject(e) : resolve())));
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

const refresh = (h: Harness, token: string, correlationId: unknown) =>
  h.call(token, 'POST', `/v1/agent-intents/${correlationId}/status`);

async function sign(h: Harness, token: string, correlationId: unknown, standard = 'nep366') {
  await h.call(token, 'POST', `/v1/agent-intents/${correlationId}`, { signed_data: { standard } });
  return (await refresh(h, token, correlationId)).body.status;
}

async function openAgent(h: Harness, token: string, name = 'Round trader') {
  const created = await h.call(token, 'POST', '/v1/agents', { name });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const agentId = String(created.body.agent_id);
  assert.equal(await sign(h, token, created.body.correlation_id), 'SUCCESS');
  const grant = await h.call(token, 'POST', `/v1/agents/${agentId}/grant`);
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal(await sign(h, token, grant.body.correlation_id, 'nep413'), 'SUCCESS');
  return agentId;
}

const STAKE = { kind: 'stake', series: 0, round: '42', side: 'up', amount: '5000000', minShares: '0' };

test('an owner creates an agent, authorizes Dragons Market and has it stake and cash out, all scoped to the owner',
  { timeout: 60000 }, () => withAgents(async h => {
    const [alice, bob] = [await h.signIn('alice.near'), await h.signIn('bob.near')];
    const sentTo = (path: string) => h.fake.requests.filter(r => r.path === path);
    const created = await h.call(alice.token, 'POST', '/v1/agents', { name: 'Round trader' });
    assert.equal(created.status, 200);
    const agentId = String(created.body.agent_id), intentId = String(created.body.correlation_id);
    const asked = sentTo('/v1/generate-intent')[0]!;
    assert.equal(asked.headers.get('x-grant-token'), null);
    assert.deepEqual([asked.body!.owner, asked.body!.external_user_id],
      [{ type: 'near', account_id: 'alice.near', public_key: alice.publicKey }, 'alice.near'],
      'the owner is the signed-in wallet and the key it signed in with');
    const policy = asked.body!.policy as { destinations: unknown; native: { near: { call: string[] } } };
    assert.deepEqual(policy.native.near.call, ['rounds.test.near'], 'the agent is not given the token to call');
    assert.deepEqual(policy.destinations, { mode: 'only', list: [
      { action: 'withdraw', chain: 'near', address: 'alice.near', memo: null },
      { action: 'withdraw', chain: 'near', address: 'rounds.test.near', memo: null },
    ] });

    const crossSite = await h.call(alice.token, 'POST', '/v1/agents', { name: 'x' }, 'https://attacker.example');
    assert.equal(crossSite.status, 403);
    const padded = await h.call(alice.token, 'POST', '/v1/agents', { name: ' padded' });
    assert.equal(padded.body.error?.code, 'invalid_agent_name');
    assert.equal((await refresh(h, bob.token, intentId)).status, 404, 'not bob\'s intent');
    const bobSubmits = await h.call(bob.token, 'POST', `/v1/agent-intents/${intentId}`,
      { signed_data: { standard: 'nep366' } });
    assert.equal(bobSubmits.status, 404);
    const listed = await h.call(alice.token, 'GET', '/v1/agents');
    assert.deepEqual((listed.body.data as Body[]).map(a => [a.agent_id, a.state, a.frozen]),
      [[agentId, 'pending', false]]);
    assert.ok(!('id' in (listed.body.data as Body[])[0]!), 'the row id stays inside the backend');
    assert.deepEqual((await h.call(bob.token, 'GET', '/v1/agents')).body.data, []);
    const early = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/grant`);
    assert.equal(early.body.error?.code, 'agent_not_active');

    const wrongStandard = await h.call(alice.token, 'POST', `/v1/agent-intents/${intentId}`,
      { signed_data: { standard: 'nep413' } });
    assert.equal(wrongStandard.body.error?.code, 'invalid_signed_data');
    const submitted = await h.call(alice.token, 'POST', `/v1/agent-intents/${intentId}`,
      { signed_data: { standard: 'nep366', payload: {}, signed_delegate: 'AAAA' } });
    assert.equal(submitted.body.status, 'PROCESSING');
    assert.equal((await refresh(h, alice.token, intentId)).body.status, 'SUCCESS');
    const walletReads = sentTo(`/v1/agents/${agentId}/wallet`).length;
    await refresh(h, alice.token, intentId);
    assert.equal(sentTo(`/v1/agents/${agentId}/wallet`).length, walletReads, 'a recorded outcome is not applied twice');
    const active = (await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[];
    assert.deepEqual([active[0]!.state, active[0]!.near_account_id], ['active', nearAccountOf(agentId)]);

    const act = (who: { token: string }, key: string, action: unknown) =>
      h.call(who.token, 'POST', `/v1/agents/${agentId}/actions`, { key, action });
    const ungranted = await act(alice, 'stake-0001', STAKE);
    assert.equal(ungranted.body.error?.code, 'grant_required');
    const grant = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/grant`);
    assert.equal(grant.status, 200);
    assert.ok(!JSON.stringify(grant.body).includes('ngt_'), 'the grant token never reaches the browser');
    const issued = sentTo('/v1/generate-intent')[1]!.body!;
    assert.deepEqual([issued.type, issued.agent_id, issued.label], ['grant_issue', agentId, 'Dragons Market']);
    assert.match(String(issued.credential), /^[0-9a-f]{64}$/);
    assert.equal(await sign(h, alice.token, grant.body.correlation_id, 'nep413'), 'SUCCESS');
    assert.ok(((await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[])[0]!.authorized_until);
    const second = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/grant`);
    assert.equal(second.body.error?.code, 'grant_already_live');

    const staked = await act(alice, 'stake-0001', STAKE);
    assert.equal(staked.body.state, 'confirmed', JSON.stringify(staked.body));
    const [stake] = sentTo(`/v1/agents/${agentId}/native/near/call`);
    assert.deepEqual([stake!.body!.receiver_id, stake!.body!.method_name], ['rounds.test.near', 'stake'],
      'the stake is paid from the rounds balance');
    const token = stake!.headers.get('x-grant-token')!;
    assert.equal(createHash('sha256').update(token).digest('hex'), issued.credential,
      'the agent acts with exactly the token whose commitment the owner signed');
    assert.match(stake!.headers.get('idempotency-key')!, /^dm-[0-9a-f-]{36}$/);
    assert.equal(sentTo(`/v1/agents/${agentId}/wallet`).length, walletReads, 'an action uses the account on record');
    const sealed = (await h.pool.query('SELECT sealed_token FROM agent_grants')).rows[0].sealed_token as Buffer;
    assert.ok(!sealed.includes(Buffer.from(token)), 'the database holds the token sealed');

    const paid = await act(alice, 'cash-out-0001', { kind: 'cash_out', amount: '3000000', recipient: 'mallory.near' });
    assert.equal(paid.body.state, 'confirmed');
    assert.equal(sentTo(`/v1/agents/${agentId}/withdraw`)[0]!.body!.recipient, 'alice.near');
    for (const [action, code] of [[{ kind: 'fund', amount: '1' }, 'invalid_action'],
      [{ kind: 'deposit', amount: '1' }, 'invalid_action'], [{ kind: 'register', contract: 'rounds' }, 'invalid_action'],
      [{ kind: 'buy', market: '1', side: 'yes', amount: '1', minShares: '1' }, 'invalid_action'],
      [{ kind: 'withdraw', contract: 'market', amount: '1' }, 'invalid_contract'],
      [{ ...STAKE, round: '042' }, 'invalid_round']]) {
      const refused = await act(alice, 'refused-0001', action);
      assert.deepEqual([refused.status, refused.body.error?.code], [400, code], JSON.stringify(action));
    }
    assert.equal((await act(bob, 'stake-0003', STAKE)).status, 404, 'bob cannot act for alice\'s agent');
    assert.equal((await h.call(bob.token, 'GET', `/v1/agents/${agentId}/operations`)).status, 404);
    const operations = (await h.call(alice.token, 'GET', `/v1/agents/${agentId}/operations`)).body.data as Body[];
    assert.deepEqual(operations.map(o => o.state), ['confirmed', 'confirmed']);
  }));

test('a change of state is never a GET, and every POST needs the site\'s origin', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const created = await h.call(alice.token, 'POST', '/v1/agents', { name: 'Trader' });
    const id = created.body.correlation_id;
    for (const path of [`/v1/agent-intents/${id}`, `/v1/agent-intents/${id}/status`]) {
      assert.equal((await h.call(alice.token, 'GET', path)).status, 405, path);
    }
    assert.equal((await h.call(alice.token, 'POST', `/v1/agent-intents/${id}/status`, undefined,
      'https://attacker.example')).status, 403);
    const agentId = String(created.body.agent_id);
    for (const path of ['freeze', 'unfreeze', 'revoke', 'grant']) {
      assert.equal((await h.call(alice.token, 'GET', `/v1/agents/${agentId}/${path}`)).status, 405, path);
    }
  }));

test('limits hold under a burst of requests, and expired, forged or widened creations stop counting',
  { timeout: 60000 }, () => withAgents(async h => {
    const carol = await h.signIn('carol.near');
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      h.call(carol.token, 'POST', '/v1/agents', { name: `Agent ${i}` })));
    assert.equal(burst.filter(r => r.status === 200).length, 3, 'three agents, however many arrive at once');
    assert.ok(burst.filter(r => r.status !== 200).every(r => r.body.error?.code === 'agent_limit_reached'));
    assert.equal(h.fake.requests.filter(r => r.path === '/v1/generate-intent').length, 3,
      'refused requests never reach the Agent API');
    await h.pool.query(`UPDATE agent_intents SET expires_at=now()-interval '1 second'
      WHERE status='PENDING_SIGNATURE'`);
    assert.equal((await h.call(carol.token, 'POST', '/v1/agents', { name: 'After expiry' })).status, 200);

    const dave = await h.signIn('dave.near');
    for (const flag of ['forge', 'widen'] as const) {
      h.fake.state[flag] = true;
      const refused = await h.call(dave.token, 'POST', '/v1/agents', { name: flag });
      assert.deepEqual([refused.status, refused.body.error?.code], [502, 'agent_api_unavailable'],
        `a ${flag}d request is never passed to the owner`);
      h.fake.state[flag] = false;
    }
    const states = (await h.pool.query("SELECT state FROM agent_accounts WHERE owner_account_id='dave.near'")).rows;
    assert.deepEqual(states.map(r => r.state), ['abandoned', 'abandoned'], 'neither refused creation counts');
    assert.deepEqual((await h.call(dave.token, 'GET', '/v1/agents')).body.data, []);

    const erin = await h.signIn('erin.near');
    await h.pool.query(`INSERT INTO agent_accounts(id,deployment_id,owner_account_id,name,state)
      SELECT gen_random_uuid(),'agents-test','erin.near','old','abandoned' FROM generate_series(1,10)`);
    const capped = await h.call(erin.token, 'POST', '/v1/agents', { name: 'Eleventh' });
    assert.deepEqual([capped.status, capped.body.error?.code], [429, 'agent_daily_limit_reached']);
  }));

test('a grant the API reports for another commitment never goes live', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const created = await h.call(alice.token, 'POST', '/v1/agents', { name: 'Trader' });
    await sign(h, alice.token, created.body.correlation_id);
    const agentId = String(created.body.agent_id);
    const grant = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/grant`);
    h.fake.state.foreignGrant = true;
    assert.equal(await sign(h, alice.token, grant.body.correlation_id, 'nep413'), 'SUCCESS');
    const { rows } = await h.pool.query('SELECT state,api_grant_id FROM agent_grants');
    assert.deepEqual(rows, [{ state: 'failed', api_grant_id: null }]);
    const act = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`,
      { key: 'stake-0001', action: STAKE });
    assert.equal(act.body.error?.code, 'grant_required');
  }));

test('one transaction settles one operation, and one run at a time sends an operation', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const act = (key: string) => h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`, { key, action: STAKE });
    const calls = () => h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).length;
    h.fake.state.slowSend = true;
    const together = await Promise.all([act('stake-0001'), act('stake-0001'), act('stake-0001')]);
    h.fake.state.slowSend = false;
    assert.equal(calls(), 1, 'the same operation asked three times while its send is in flight is sent once');
    assert.ok(together.every(r => r.body.state === 'confirmed' || r.body.error?.code === 'operation_in_progress'),
      JSON.stringify(together.map(r => r.body)));
    assert.equal((await act('stake-0001')).body.state, 'confirmed');

    h.fake.state.reuseHash = true;
    assert.equal((await act('stake-0002')).body.state, 'confirmed');
    const replayed = await act('stake-0003');
    assert.deepEqual([replayed.body.state, (replayed.body.evidence as Body).reason],
      ['reconcile', 'transaction_already_claimed'],
      'an answer naming a transaction another operation settled stops this one for a check');
    const { rows } = await h.pool.query(
      "SELECT state,transaction_hash FROM user_operations WHERE idempotency_key='stake-0003'");
    assert.deepEqual(rows, [{ state: 'reconcile', transaction_hash: null }]);
  }));

test('a refusal the same key can outlast keeps the action unsettled, so the page asks again', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const act = () => h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`,
      { key: 'stake-0001', action: STAKE });
    h.fake.state.busy = true;
    const busy = await act();
    assert.deepEqual([busy.status, busy.body.error?.code], [502, 'agent_api_unavailable'],
      'never a final 409 the page would show as refused, inviting a second send under a new key');
    const { rows } = await h.pool.query(
      "SELECT state,evidence FROM user_operations WHERE idempotency_key='stake-0001'");
    assert.deepEqual(rows, [{ state: 'prepared', evidence: { sent: true } }]);
    h.fake.state.busy = false;
    assert.equal((await act()).body.state, 'confirmed', 'asked again under the same key, it goes through');
  }));

test('the owner can stop Dragons Market at once, and freeze and thaw the agent', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const sentTo = (suffix: string) => h.fake.requests.filter(r => r.path.endsWith(suffix));
    const act = (key: string, action: unknown) =>
      h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`, { key, action });
    const cashOut = { kind: 'cash_out', amount: '1', recipient: 'alice.near' };

    const frozen = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/freeze`);
    assert.equal(frozen.body.type, 'agent_freeze');
    assert.equal((await h.call(alice.token, 'POST', `/v1/agents/${agentId}/unfreeze`)).body.error?.code,
      'agent_not_frozen');
    await h.call(alice.token, 'POST', `/v1/agent-intents/${frozen.body.correlation_id}`,
      { signed_data: { standard: 'nep366' } });
    const listed = (await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[];
    assert.equal(listed[0]!.frozen, true, 'a signed freeze stops Dragons Market before the API settles it');
    const sends = sentTo('/native/near/call').length;
    const held = await act('stake-0001', STAKE);
    assert.deepEqual([held.body.state, held.body.evidence], ['failed', { reason: 'agent_frozen' }]);
    assert.equal(sentTo('/native/near/call').length, sends, 'nothing is sent for a frozen agent');
    assert.equal((await act('cash-out-0001', cashOut)).body.state, 'confirmed', 'it still pays out to its owner');
    assert.equal((await refresh(h, alice.token, frozen.body.correlation_id)).body.status, 'SUCCESS');
    assert.equal((await h.call(alice.token, 'POST', `/v1/agents/${agentId}/freeze`)).body.error?.code,
      'agent_frozen');
    const thawed = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/unfreeze`);
    assert.equal(await sign(h, alice.token, thawed.body.correlation_id), 'SUCCESS');
    assert.equal((await act('stake-0002', STAKE)).body.state, 'confirmed');

    const revoked = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/revoke`);
    const asked = revoked.body.data as Body[];
    assert.deepEqual(asked.map(i => i.type), ['grant_revoke']);
    const request = sentTo('/v1/generate-intent').at(-1)!.body!;
    assert.deepEqual([request.type, request.agent_id], ['grant_revoke', agentId]);
    assert.match(String(request.grant_id), /^grant-intent_/);
    const { rows } = await h.pool.query('SELECT state,sealed_token FROM agent_grants');
    assert.deepEqual(rows, [{ state: 'revoked', sealed_token: null }], 'the token is destroyed, not just set aside');
    assert.equal((await act('stake-0003', STAKE)).body.error?.code, 'grant_required');
    assert.deepEqual((await h.call(alice.token, 'POST', `/v1/agents/${agentId}/revoke`)).body.data, [],
      'a revocation still waiting to be signed is not asked for twice');
    assert.equal(await sign(h, alice.token, asked[0]!.correlation_id), 'SUCCESS');
    assert.ok(!((await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[])[0]!.authorized_until);

    const unsigned = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/freeze`);
    await h.pool.query("UPDATE agent_intents SET expires_at=now()-interval '1 second' WHERE correlation_id=$1",
      [unsigned.body.correlation_id]);
    const after = (await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[];
    assert.deepEqual(after[0]!.open_intents, [], 'a request no one can sign any more does not hide the agent');
  }));

test('after the grant key is replaced, an old grant neither acts nor stops the owner authorizing again',
  { timeout: 60000 }, () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const owner = { account: 'alice.near', publicKey: alice.publicKey };
    const first = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`,
      { key: 'stake-0001', action: STAKE });
    assert.equal(first.body.state, 'confirmed');
    const rotated = h.services(randomBytes(32));
    await assert.rejects(runOwnedAction(rotated, owner, agentId, { key: 'stake-0002', action: STAKE }),
      /grant_required/);
    const again = await issueGrant(rotated, owner, agentId);
    assert.equal(again.type, 'grant_issue');
    await assert.rejects(issueGrant(h.services(), owner, agentId), /grant_already_live/,
      'the old key still opens the old grant');
    await submitOwnerIntent(rotated, owner, again.correlation_id, { standard: 'nep413' });
    assert.equal((await ownerIntentStatus(rotated, owner, again.correlation_id)).status, 'SUCCESS');
    const calls = () => h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).length;
    const before = calls();
    await assert.rejects(runOwnedAction(rotated, owner, agentId, { key: 'stake-0001', action: STAKE }),
      /operation_idempotency_conflict/,
      'an operation sent under one grant is never sent again under another, where the API would take it as new');
    assert.equal(calls(), before);
    const resumed = await runOwnedAction(rotated, owner, agentId, { key: 'stake-0003', action: STAKE });
    assert.equal(resumed.state, 'confirmed');
  }));

test('an access token acts for its one agent within the owner\'s stake limits, and stops when the owner says',
  { timeout: 60000 }, () => withAgents(async h => {
    const [alice, bob] = [await h.signIn('alice.near'), await h.signIn('bob.near')];
    const agentId = await openAgent(h, alice.token);
    const issue = (limits: Body, who = alice) => h.call(who.token, 'POST', `/v1/agents/${agentId}/access`, limits);
    const limits = { label: 'Claude', max_stake: '5000000', daily_limit: '12000000' };
    for (const [asked, code] of [[{ ...limits, max_stake: '0' }, 'invalid_max_stake'],
      [{ ...limits, daily_limit: '1' }, 'daily_limit_below_max_stake'], [{ ...limits, label: '' }, 'invalid_label']]) {
      assert.equal((await issue(asked as Body)).body.error?.code, code);
    }
    assert.equal((await issue(limits, bob)).status, 404, 'only the owner gives access');
    const issued = await issue(limits);
    const token = String(issued.body.token);
    assert.match(token, /^dmk_[A-Za-z0-9_-]{43}$/);
    const stored = (await h.pool.query('SELECT token_hash FROM agent_access_tokens')).rows[0].token_hash;
    assert.equal(stored, createHash('sha256').update(token).digest('hex'), 'only the hash is kept');
    const listed = (await h.call(alice.token, 'GET', `/v1/agents/${agentId}/access`)).body.data as Body[];
    assert.deepEqual(listed.map(t => [t.label, t.max_stake, t.daily_limit, 'token' in t]),
      [['Claude', '5000000', '12000000', false]]);

    const access = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      h.raw(method, `/v1/agent-access/${path}`, body, { Authorization: `Bearer ${token}`, ...headers });
    assert.equal((await h.raw('GET', '/v1/agent-access/session', undefined, {})).body.error?.code,
      'access_token_required');
    assert.equal((await h.raw('GET', '/v1/agent-access/session', undefined,
      { Authorization: `Bearer dmk_${'x'.repeat(43)}` })).body.error?.code, 'access_token_invalid');
    for (const browser of [{ Origin: h.config.webOrigin }, { Cookie: `dm_session=${alice.token}` }]) {
      assert.equal((await access('GET', 'session', undefined, browser)).body.error?.code, 'server_to_server_only');
    }
    assert.deepEqual((await access('GET', 'session')).body.agent_id, agentId);
    const summary = (await access('GET', 'agent')).body;
    assert.deepEqual([summary.near_account_id, (summary.limits as Body).staked_today],
      [nearAccountOf(agentId), '0']);

    const stake = (requestId: string, amount: string) =>
      access('POST', 'actions', { request_id: requestId, action: { ...STAKE, amount } });
    assert.equal((await stake('too-much-0001', '5000001')).body.error?.code, 'stake_over_limit');
    assert.equal((await stake('first-00001', '5000000')).body.state, 'confirmed');
    assert.equal((await stake('first-00001', '5000000')).body.state, 'confirmed', 'a retry is not counted twice');
    assert.equal((await stake('second-0001', '5000000')).body.state, 'confirmed');
    assert.equal((await stake('third-00001', '5000000')).body.error?.code, 'daily_limit_reached');
    assert.equal((await stake('third-00002', '2000000')).body.state, 'confirmed', 'exactly up to the limit');
    const keys = (await h.pool.query('SELECT idempotency_key,request FROM user_operations ORDER BY idempotency_key'))
      .rows.filter(r => String(r.idempotency_key).startsWith('mcp-'));
    assert.deepEqual(keys.map(r => r.idempotency_key), ['mcp-first-00001', 'mcp-second-0001', 'mcp-third-00002'],
      'an agent\'s request ids live in a namespace of their own');
    assert.ok(keys.every(r => r.request.via === issued.body.id), 'each operation is bound to the token it came through');
    const cashOut = await access('POST', 'actions',
      { request_id: 'cash-out-01', action: { kind: 'cash_out', amount: '1', recipient: 'mallory.near' } });
    assert.equal(cashOut.body.state, 'confirmed');
    const withdrawals = h.fake.requests.filter(r => r.path.endsWith('/withdraw'));
    assert.equal(withdrawals.at(-1)!.body!.recipient, 'alice.near', 'a cash-out still pays only the owner');
    for (const action of [{ kind: 'deposit', amount: '1' }, { kind: 'register', contract: 'rounds' }]) {
      const refused = await access('POST', 'actions', { request_id: 'refused-001', action });
      assert.equal(refused.body.error?.code, 'invalid_action');
    }
    assert.equal((await access('POST', 'actions', { request_id: 'short', action: STAKE })).body.error?.code,
      'invalid_request_id');

    const expiring = await issue(limits);
    await h.pool.query("UPDATE agent_access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expiring.body.id]);
    const expired = await h.raw('GET', '/v1/agent-access/session', undefined,
      { Authorization: `Bearer ${String(expiring.body.token)}` });
    assert.equal(expired.body.error?.code, 'access_token_invalid', 'an expired token opens nothing');

    const revoked = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/access/${issued.body.id}/revoke`);
    assert.equal(revoked.body.revoked, true);
    assert.equal((await access('GET', 'session')).body.error?.code, 'access_token_invalid');
    const second = String((await issue(limits)).body.token);
    await h.call(alice.token, 'POST', `/v1/agents/${agentId}/revoke`);
    const afterStop = await h.raw('GET', '/v1/agent-access/session', undefined, { Authorization: `Bearer ${second}` });
    assert.equal(afterStop.body.error?.code, 'access_token_invalid', 'stopping Dragons Market stops every token');
  }));

test('stakes through one token cannot overrun its daily limit even all at once', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const issued = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/access`,
      { label: 'Bot', max_stake: '5000000', daily_limit: '10000000' });
    const auth = { Authorization: `Bearer ${String(issued.body.token)}` };
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => h.raw('POST', '/v1/agent-access/actions',
      { request_id: `burst-000${i}`, action: { ...STAKE, amount: '5000000' } }, auth)));
    assert.equal(burst.filter(r => r.body.state === 'confirmed').length, 2);
    assert.ok(burst.filter(r => r.body.state !== 'confirmed').every(r => r.body.error?.code === 'daily_limit_reached'));
    const { rows: [spent] } = await h.pool.query('SELECT sum(amount)::text AS n FROM agent_access_stakes');
    assert.equal(spent.n, '10000000');
  }));

test('a request id admitted for one amount is never sent for another', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const issued = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/access`,
      { label: 'Bot', max_stake: '5000000', daily_limit: '6000000' });
    const auth = { Authorization: `Bearer ${String(issued.body.token)}` };
    await h.pool.query(`INSERT INTO agent_access_stakes(token,idempotency_key,amount)
      VALUES($1,'mcp-crashed-0001',1000000)`, [issued.body.id]);
    const stake = (amount: string) => h.raw('POST', '/v1/agent-access/actions',
      { request_id: 'crashed-0001', action: { ...STAKE, amount } }, auth);
    const swapped = await stake('5000000');
    assert.deepEqual([swapped.status, swapped.body.error?.code], [409, 'operation_idempotency_conflict'],
      'admitted for one amount, a retry for more cannot skip the daily limit');
    assert.equal(h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).length, 0);
    assert.equal((await stake('1000000')).body.state, 'confirmed', 'the amount it was admitted for still goes');
    const { rows: [spent] } = await h.pool.query('SELECT sum(amount)::text AS n FROM agent_access_stakes');
    assert.equal(spent.n, '1000000');
  }));

test('one access token gets 120 requests a minute, and another token its own', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const give = () => h.call(alice.token, 'POST', `/v1/agents/${agentId}/access`,
      { label: 'Bot', max_stake: '1', daily_limit: '1' }).then(r => String(r.body.token));
    const [one, two] = [await give(), await give()];
    const session = (token: string) =>
      h.raw('GET', '/v1/agent-access/session', undefined, { Authorization: `Bearer ${token}` });
    const burst = await Promise.all(Array.from({ length: 121 }, () => session(one)));
    assert.equal(burst.filter(r => r.status === 429).length, 1);
    assert.equal((await session(two)).status, 200, 'another token is not slowed by the first');
  }));
