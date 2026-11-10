import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import type { Config } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { createApp } from '../src/app.js';
import { createPrivateApi } from '../src/private-api.js';
import { challenge, login } from '../src/auth.js';
import { AgentApiClient, type OwnerIntent } from '../src/agent-api.js';
import { agentGateway } from '../src/agent-gateway.js';
import { createAgentRoutes } from '../src/agent-routes.js';
import { sweepAgents } from '../src/agent-sweep.js';
import { readAgentWorkerConfig } from '../src/agent-worker-config.js';
import { createAgentWorkerServer } from '../src/agent-worker-server.js';
import {
  issueGrant, ownerIntentStatus, runOwnedAction, sessionLimits, submitOwnerIntent, type AgentAccounts,
} from '../src/agent-accounts.js';
import { operationStore } from '../src/operations.js';
import type { AgentRunner } from '../src/agents.js';

type Body = Record<string, unknown>;
const WALLET_CONTRACT = 'wallets.example.near';
const MARKET = 'market.test.near';
const WORKER_TOKEN = 'w'.repeat(32);
const nearAccountOf = (agentId: string) => `d${agentId.slice(1)}`;
const at = '2030-01-01T00:00:00.000Z';

function fakeAgentApi() {
  const requests: { path: string; headers: Headers; body: Body | null }[] = [];
  const intents = new Map<string, { type: string; agentId: string; credential?: unknown; submitted: boolean }>();
  const operations = new Map<string, { type: string; agentId: string; details: Body; call: Body }>();
  const owners = new Map<string, unknown>();
  const policies = new Map<string, Body>();
  const frozen = new Set<string>();
  const state = { created: 0, forge: false, widen: false, foreignGrant: false, reuseHash: false, slowSend: false,
    busy: false, settling: false, refuse: null as string | null, event: 'staked' };
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
    if (type === 'agent_create') {
      owners.set(agentId, body.owner);
      policies.set(agentId, body.policy as Body);
    }
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
  const land = (id: string) => {
    const intent = intents.get(id)!;
    intent.submitted = true;
    if (intent.type === 'agent_freeze') frozen.add(intent.agentId);
    if (intent.type === 'agent_unfreeze') frozen.delete(intent.agentId);
    return intent;
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
    const calls = [{ method: String(call.method_name), args, deposit: String(call.deposit) }];
    if (call.receiver_id === MARKET) {
      const logged: Record<string, [string, Body]> = {
        buy: ['buy', { market_id: args.market_id, side: args.side, collateral: args.amount }],
        sell: ['sell', { market_id: args.market_id, side: args.side, shares: args.shares }],
        redeem: ['redeemed', { market_id: args.market_id }],
        withdraw: ['withdraw_confirmed', { amount: args.amount }],
        storage_unregister: ['unregistered', {}],
      };
      const [event, data] = logged[String(call.method_name)]!;
      return { signer: sender, receiver: MARKET, calls, failed: state.event === 'nothing' ? [MARKET] : [],
        events: state.event === 'nothing' ? []
          : [{ executor: MARKET, standard: 'market', event, data: { account: sender, ...data } }] };
    }
    const data = call.method_name === 'claim' ? { account: sender, series_id: args.series_id, round: args.round }
      : { account: sender, series_id: 0, round: args.round ?? '42', side: 'up',
        amount: typeof args.amount === 'string' ? args.amount : '5000000' };
    const event = call.method_name === 'claim' ? 'claimed' : state.event;
    return { signer: sender, receiver: String(call.receiver_id), calls,
      failed: state.event === 'nothing' ? ['rounds.test.near'] : [],
      events: [{ executor: 'rounds.test.near', standard: 'rounds', event, data }] };
  };
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input as URL, init), url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() as Body : null;
    requests.push({ path: url.pathname, headers: request.headers, body });
    const reply = (code: number, value: unknown) => new Response(JSON.stringify(value), { status: code });
    const refused = (code: number, name: string, retryable = false) => reply(code, { errors: [{ status: String(code),
      code: name, layer: 'request', title: name, meta: { retryable } }], meta: {} });
    const wallet = /^\/v1\/agents\/([0-9a-f]{64})\/wallet$/.exec(url.pathname);
    const policy = /^\/v1\/agents\/([0-9a-f]{64})\/policy$/.exec(url.pathname);
    const write = /^\/v1\/agents\/([0-9a-f]{64})\/(native\/near\/call|withdraw)$/.exec(url.pathname);
    if (url.pathname === '/v1/generate-intent' && body) return reply(201, generated(body));
    if (url.pathname === '/v1/submit-intent' && body) {
      const intent = land(String(body.correlation_id));
      return reply(202, status(String(body.correlation_id), intent.type, intent.agentId, 'PROCESSING', {}));
    }
    if (url.pathname === '/v1/status') {
      const id = url.searchParams.get('correlation_id')!, op = operations.get(id);
      if (!op) return reply(200, intentStatus(id));
      const txHash = state.reuseHash ? 'tx-reused' : `tx-${id}`;
      const s = state.settling ? 'PROCESSING' : 'SUCCESS';
      return reply(200, status(id, op.type, op.agentId, s, { ...op.details, tx_hash: txHash }));
    }
    if (wallet) return reply(200, { wallet_id: 'w1', near_account_id: nearAccountOf(wallet[1]!) });
    if (policy) return reply(200, { wallet_id: 'w1', revision: 1, status: 'APPLIED', provider_policy_synced: true,
      policy: { ...policies.get(policy[1]!), frozen: frozen.has(policy[1]!) } });
    if (write && frozen.has(write[1]!)) return refused(409, 'wallet_frozen');
    if (write && state.refuse) return refused(409, state.refuse);
    if (write && state.busy) return refused(409, 'operation_in_flight', true);
    if (write && state.slowSend) await new Promise(resolve => setTimeout(resolve, 300));
    if (write && body) return reply(202, send(write[1]!, write[2]!, body));
    return refused(404, 'not_found');
  };
  return { transport, requests, state, transaction, land, frozen, policies };
}

interface Wallet { token: string; publicKey: string; account: string; signer: KeyPairSigner }
interface Harness {
  pool: pg.Pool;
  config: Config;
  fake: ReturnType<typeof fakeAgentApi>;
  chain: {
    stakes: Map<string, Body | null>; outcome: string | null; quote: string;
    bought: string; sold: { collateral_out: string; fee: string }; positions: Body[]; markets: Body[];
  };
  services: (grantKey?: Buffer) => AgentAccounts;
  signIn: (accountId: string) => Promise<Wallet>;
  call: (token: string, method: string, path: string, body?: unknown, origin?: string) => Promise<Reply>;
  raw: (method: string, path: string, body: unknown, headers: Record<string, string>) => Promise<Reply>;
  port: number;
}
type Reply = { status: number; body: Body & { error?: { code: string } } };

async function withAgents(run: (h: Harness) => Promise<void>) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Set TEST_DATABASE_URL explicitly; tests create and remove an isolated schema');
  const schema = `agents_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const worker = readAgentWorkerConfig({ DATABASE_URL: url, DEPLOYMENT_ID: 'agents-test', DEPLOYMENT_START_BLOCK: '0',
    ROUNDS_CONTRACT_ID: 'rounds.test.near', MARKET_CONTRACT_ID: MARKET, VERIFIER_CONTRACT_ID: 'verifier.test.near',
    COLLATERAL_TOKEN_ID: 'nep141:usdc.test.near', AGENT_API_URL: 'https://agents.example.com',
    AGENT_API_KEY: `naa_${'k'.repeat(43)}`, AGENT_GRANT_KEY: randomBytes(32).toString('base64'),
    AGENT_API_WALLET_CONTRACT: WALLET_CONTRACT, AGENT_WORKER_TOKEN: WORKER_TOKEN });
  const config = worker.shared, { deployment } = worker, fake = fakeAgentApi();
  const api = new AgentApiClient(worker.agentApi, fake.transport);
  const runner: AgentRunner = {
    deployment, api, waitMs: 0,
    transaction: async (hash, sender) => fake.transaction(hash, sender),
    operations: operationStore(pool, deployment.id),
  };
  const held: Harness['chain'] = { stakes: new Map(), outcome: 'up', quote: '0', bought: '1000000',
    sold: { collateral_out: '1000000', fee: '20000' }, positions: [], markets: [] };
  const view = async (contract: string, method: string, args: unknown) => {
    const where = args as { series_id: number; round: string };
    if (method === 'get_stake') {
      const key = `${where.series_id}:${where.round}`;
      return held.stakes.has(key) ? held.stakes.get(key) : { side: 'up', amount: '5000000' };
    }
    if (method === 'round_outcome') return held.outcome;
    if (method === 'quote_stake') return held.quote;
    if (method === 'quote_buy') return { shares_out: held.bought, fee: '20000' };
    if (method === 'quote_sell') return { ...held.sold, shares_in: '1' };
    if (method === 'get_positions') return held.positions;
    if (method === 'list_markets') {
      const page = args as { from_index: string; limit: string };
      return held.markets.filter(m => BigInt(String(m.id)) >= BigInt(page.from_index)
        && BigInt(String(m.id)) < BigInt(page.from_index) + BigInt(page.limit));
    }
    if (method === 'config' && contract === MARKET) {
      const total = held.markets.reduce((n, m) => BigInt(String(m.id)) >= n ? BigInt(String(m.id)) + 1n : n, 0n);
      return { markets: String(total), fee_rate_bps: 200, paused: false, sells_paused: false };
    }
    if (method === 'get_account' && contract === MARKET) {
      return { registered: true, available: '7000000', pending_withdrawals: '0', positions: held.positions.length };
    }
    return null;
  };
  const chain = { view, nearBalance: async () => '200000000000000000000000' };
  const keys = new Set<string>();
  const checkKey = async (account: string, publicKey: string) => keys.has(`${account}:${publicKey}`);
  const services = (grantKey = worker.grantKey): AgentAccounts => ({ db: pool, deployment, api, runner,
    chain, grantKey, checkKey, webOrigin: config.webOrigin,
    signing: { walletContract: WALLET_CONTRACT, messageRecipient: 'agents.example.com' } });
  const agentServer = createAgentWorkerServer(createAgentRoutes(services()), WORKER_TOKEN);
  agentServer.listen(0, '127.0.0.1');
  await once(agentServer, 'listening');
  const gateway = agentGateway({ url: `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}`,
    token: WORKER_TOKEN });
  const app = createApp(config, async () => {}, undefined, undefined,
    createPrivateApi(pool, config, async () => true, null, gateway));
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
      const publicKey = key.getPublicKey().toString();
      keys.add(`${accountId}:${publicKey}`);
      return { token, publicKey, account: accountId, signer };
    };
    const raw: Harness['raw'] = async (method, path, body, headers) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as Reply['body'] };
    };
    const call: Harness['call'] = (token, method, path, body, origin = config.webOrigin) =>
      raw(method, path, body, { Origin: origin, Cookie: `dm_session=${token}` });
    await run({ pool, config, fake, chain: held, services, signIn, call, raw, port: address.port });
  } finally {
    app.closeAllConnections();
    if (app.listening) await new Promise<void>((resolve, reject) => app.close(e => (e ? reject(e) : resolve())));
    agentServer.closeAllConnections();
    await new Promise(resolve => { agentServer.close(resolve); });
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

const refresh = (h: Harness, token: string, correlationId: unknown) =>
  h.call(token, 'POST', `/v1/agent-intents/${correlationId}/status`);

const signedData = (generated: Body) => {
  const { standard, payload } = generated.intent as OwnerIntent['intent'];
  return { signed_data: { standard, payload } };
};

async function sign(h: Harness, token: string, generated: Body) {
  await h.call(token, 'POST', `/v1/agent-intents/${generated.correlation_id}`, signedData(generated));
  return (await refresh(h, token, generated.correlation_id)).body.status;
}

async function openAgent(h: Harness, token: string, name = 'Round trader') {
  const created = await h.call(token, 'POST', '/v1/agents', { name });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const agentId = String(created.body.agent_id);
  assert.equal(await sign(h, token, created.body), 'SUCCESS');
  const grant = await h.call(token, 'POST', `/v1/agents/${agentId}/grant`);
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal(await sign(h, token, grant.body), 'SUCCESS');
  return agentId;
}

async function giveAccess(h: Harness, who: Wallet, agentId: string, limits: Body) {
  const asked = await h.call(who.token, 'POST', `/v1/agents/${agentId}/access`, limits);
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const signed = await signedRequest(who, asked.body);
  return h.call(who.token, 'POST', `/v1/agents/${agentId}/access/${asked.body.id}/sign`, signed);
}

async function signedRequest(who: Wallet, asked: Body, message = String(asked.message)) {
  const s = await who.signer.signNep413Message(who.account, { message, recipient: String(asked.recipient),
    nonce: Buffer.from(String(asked.nonce), 'base64') });
  return { public_key: s.publicKey.toString(), signature: Buffer.from(s.signature).toString('base64') };
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
    assert.deepEqual(policy.native.near.call, ['rounds.test.near', MARKET], 'the agent is not given the token to call');
    assert.deepEqual(policy.destinations, { mode: 'only', list: [
      { action: 'withdraw', chain: 'near', address: 'alice.near', memo: null },
      { action: 'withdraw', chain: 'near', address: 'rounds.test.near', memo: null },
      { action: 'withdraw', chain: 'near', address: MARKET, memo: null },
    ] });

    const crossSite = await h.call(alice.token, 'POST', '/v1/agents', { name: 'x' }, 'https://attacker.example');
    assert.equal(crossSite.status, 403);
    const padded = await h.call(alice.token, 'POST', '/v1/agents', { name: ' padded' });
    assert.equal(padded.body.error?.code, 'invalid_agent_name');
    assert.equal((await refresh(h, bob.token, intentId)).status, 404, 'not bob\'s intent');
    const bobSubmits = await h.call(bob.token, 'POST', `/v1/agent-intents/${intentId}`, signedData(created.body));
    assert.equal(bobSubmits.status, 404);
    const listed = await h.call(alice.token, 'GET', '/v1/agents');
    assert.deepEqual((listed.body.data as Body[]).map(a => [a.agent_id, a.state, a.frozen]),
      [[agentId, 'pending', false]]);
    assert.ok(!('id' in (listed.body.data as Body[])[0]!), 'the row id stays inside the backend');
    assert.deepEqual((await h.call(bob.token, 'GET', '/v1/agents')).body.data, []);
    const early = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/grant`);
    assert.equal(early.body.error?.code, 'agent_not_active');

    const { standard, payload } = created.body.intent as OwnerIntent['intent'];
    for (const signed of [{ standard: 'nep413', payload }, { standard }, { standard, payload: { other: true } }]) {
      const wrong = await h.call(alice.token, 'POST', `/v1/agent-intents/${intentId}`, { signed_data: signed });
      assert.equal(wrong.body.error?.code, 'invalid_signed_data', 'only exactly the intent that was generated goes on');
    }
    assert.equal(sentTo('/v1/submit-intent').length, 0);
    const submitted = await h.call(alice.token, 'POST', `/v1/agent-intents/${intentId}`,
      { signed_data: { standard, payload, signed_delegate: 'AAAA' } });
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
    assert.equal(await sign(h, alice.token, grant.body), 'SUCCESS');
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
      [{ kind: 'buy', market: '1', side: 'yes', amount: '1', minShares: '0' }, 'invalid_min_shares'],
      [{ ...STAKE, round: '042' }, 'invalid_round']]) {
      const refused = await act(alice, 'refused-0001', action);
      assert.deepEqual([refused.status, refused.body.error?.code], [400, code], JSON.stringify(action));
    }
    assert.equal((await act(bob, 'stake-0003', STAKE)).status, 404, 'bob cannot act for alice\'s agent');
    assert.equal((await h.call(bob.token, 'GET', `/v1/agents/${agentId}/operations`)).status, 404);
    assert.equal((await h.call(bob.token, 'GET', `/v1/agents/${agentId}/claimable`)).status, 404);
    const operations = (await h.call(alice.token, 'GET', `/v1/agents/${agentId}/operations`)).body.data as Body[];
    assert.deepEqual(operations.map(o => o.state), ['confirmed', 'confirmed']);
    assert.equal((await act(alice, 'leave-0001', { kind: 'leave', venue: 'rounds' })).body.state, 'reconcile',
      'an owner may leave rounds, and this test chain logged no unregistered event');
    assert.equal(sentTo(`/v1/agents/${agentId}/native/near/call`).at(-1)!.body!.method_name, 'storage_unregister');
  }));

test('a stake is claimable once the round has an outcome, however much happened since', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const act = (key: string, action: unknown) =>
      h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`, { key, action });
    const claimable = async () => (await h.call(alice.token, 'GET', `/v1/agents/${agentId}/claimable`)).body.data as Body[];
    assert.deepEqual(await claimable(), []);
    h.chain.outcome = null;
    assert.equal((await act('stake-0001', STAKE)).body.state, 'confirmed');
    assert.deepEqual(await claimable(), [], 'no outcome yet');
    h.chain.outcome = 'up';
    const ready = { series: 0, round: '42', side: 'up', amount: '5000000', outcome: 'up' };
    assert.deepEqual(await claimable(), [ready]);

    const account = nearAccountOf(agentId);
    await h.pool.query(`INSERT INTO user_operations(id,deployment_id,account_id,kind,idempotency_key,request_hash,
      request,state) SELECT gen_random_uuid(),'agents-test',$1,'withdraw','newer-'||n,'h','{}','failed'
      FROM generate_series(1,60) n`, [account]);
    assert.deepEqual(await claimable(), [ready], 'sixty newer operations do not hide a stake that is owed');

    assert.equal((await act('stake-0002', { ...STAKE, round: '43' })).body.state, 'confirmed');
    h.chain.stakes.set('0:43', null);
    assert.deepEqual(await claimable(), [ready], 'a stake someone else already claimed is not offered');

    const claim = { kind: 'claim', series: 0, round: '42' };
    assert.equal((await act('claim-0001', claim)).body.state, 'confirmed');
    assert.deepEqual(await claimable(), []);
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
    await h.pool.query(`UPDATE agent_intents SET expires_at=now()-interval '9 minutes'
      WHERE status='PENDING_SIGNATURE'`);
    const soon = await h.call(carol.token, 'POST', '/v1/agents', { name: 'Too soon' });
    assert.equal(soon.body.error?.code, 'agent_limit_reached', 'a request may have landed just as it expired');
    await h.pool.query(`UPDATE agent_intents SET expires_at=now()-interval '11 minutes'
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
    await sign(h, alice.token, created.body);
    const agentId = String(created.body.agent_id);
    const grant = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/grant`);
    h.fake.state.foreignGrant = true;
    assert.equal(await sign(h, alice.token, grant.body), 'SUCCESS');
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
      "SELECT state,sent_at IS NOT NULL AS sent FROM user_operations WHERE idempotency_key='stake-0001'");
    assert.deepEqual(rows, [{ state: 'prepared', sent: true }]);
    h.fake.state.busy = false;
    assert.equal((await act()).body.state, 'confirmed', 'asked again under the same key, it goes through');
  }));

test('the sweep finishes what a closed tab left behind, and owner intents whose answer was lost', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const old = (table: string) => h.pool.query(`UPDATE ${table} SET updated_at=now()-interval '1 minute'`);
    h.fake.state.settling = true;
    const left = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`,
      { key: 'stake-0001', action: STAKE });
    assert.equal(left.body.state, 'unknown');
    await sweepAgents(h.services());
    const state = async () => (await h.pool.query('SELECT state FROM user_operations')).rows[0].state;
    assert.equal(await state(), 'unknown', 'a fresh operation is left to the caller that made it');
    await old('user_operations');
    h.fake.state.settling = false;
    await sweepAgents(h.services());
    assert.equal(await state(), 'confirmed', 'no caller came back, and it settled anyway');

    const bob = await h.signIn('bob.near');
    const created = await h.call(bob.token, 'POST', '/v1/agents', { name: 'Lost answer' });
    h.fake.land(String(created.body.correlation_id));
    await sweepAgents(h.services());
    const opened = (await h.call(bob.token, 'GET', '/v1/agents')).body.data as Body[];
    assert.deepEqual(opened.map(a => a.state), ['active'], 'the API has the signature, so the agent is open');

    const frozen = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/freeze`);
    h.fake.land(String(frozen.body.correlation_id));
    await sweepAgents(h.services());
    const row = (await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[];
    assert.equal(row[0]!.frozen, true, 'a freeze whose answer was lost still shows');
    const calls = () => h.fake.requests.filter(r => r.path === '/v1/status').length, before = calls();
    await sweepAgents(h.services());
    assert.equal(calls(), before, 'a settled intent is not asked about again');
  }));

test('the owner can stop Dragons Market at once, and a frozen agent moves nothing until it thaws', { timeout: 60000 },
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
    await h.call(alice.token, 'POST', `/v1/agent-intents/${frozen.body.correlation_id}`, signedData(frozen.body));
    const listed = (await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[];
    assert.equal(listed[0]!.frozen, true, 'a signed freeze shows before the API settles it');
    const sends = () => sentTo('/native/near/call').length + sentTo('/withdraw').length, sentBefore = sends();
    for (const [key, action] of [['stake-0001', STAKE], ['cash-out-0001', cashOut],
      ['claim-0001', { kind: 'claim', series: 0, round: '42' }]] as const) {
      assert.equal((await act(key, action)).body.error?.code, 'wallet_frozen', key);
    }
    assert.equal(sends(), sentBefore, 'a frozen agent sends nothing, whatever the Agent API would say');
    assert.equal((await refresh(h, alice.token, frozen.body.correlation_id)).body.status, 'SUCCESS');
    assert.equal((await h.call(alice.token, 'POST', `/v1/agents/${agentId}/freeze`)).body.error?.code,
      'agent_frozen');
    const thawed = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/unfreeze`);
    assert.equal(await sign(h, alice.token, thawed.body), 'SUCCESS');
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
    assert.equal(await sign(h, alice.token, asked[0]!), 'SUCCESS');
    assert.ok(!((await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[])[0]!.authorized_until);

    const unsigned = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/freeze`);
    await h.pool.query("UPDATE agent_intents SET expires_at=now()-interval '1 second' WHERE correlation_id=$1",
      [unsigned.body.correlation_id]);
    const after = (await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[];
    assert.deepEqual(after[0]!.open_intents, [], 'a request no one can sign any more does not hide the agent');
  }));

test('freezing reads the API, so a freeze that landed unseen cannot leave the owner stuck', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    h.fake.frozen.add(agentId);
    const again = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/freeze`);
    assert.equal(again.body.error?.code, 'agent_frozen');
    const row = (await h.call(alice.token, 'GET', '/v1/agents')).body.data as Body[];
    assert.equal(row[0]!.frozen, true, 'the page learns the truth, so it offers Unfreeze');
    const thawed = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/unfreeze`);
    assert.equal(thawed.body.type, 'agent_unfreeze');
  }));

test('after the grant key is replaced, an old grant neither acts nor stops the owner authorizing again',
  { timeout: 60000 }, () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const owner = { account: 'alice.near', publicKey: alice.publicKey };
    const first = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`,
      { key: 'stake-0001', action: STAKE });
    assert.equal(first.body.state, 'confirmed');
    const action = { kind: 'stake', series: 0, round: '42', side: 'up', amount: '5000000', minShares: '0' } as const;
    const rotated = h.services(randomBytes(32)), limits = sessionLimits(rotated, owner);
    await assert.rejects(runOwnedAction(rotated, owner, agentId, { key: 'stake-0002', action, limits }),
      /grant_required/);
    const again = await issueGrant(rotated, owner, agentId);
    assert.equal(again.type, 'grant_issue');
    await assert.rejects(issueGrant(h.services(), owner, agentId), /grant_already_live/,
      'the old key still opens the old grant');
    await submitOwnerIntent(rotated, owner, again.correlation_id,
      { standard: 'nep413', payload: again.intent.payload });
    assert.equal((await ownerIntentStatus(rotated, owner, again.correlation_id)).status, 'SUCCESS');
    const calls = () => h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).length;
    const before = calls();
    await assert.rejects(runOwnedAction(rotated, owner, agentId, { key: 'stake-0001', action, limits }),
      /operation_idempotency_conflict/,
      'an operation sent under one grant is never sent again under another, where the API would take it as new');
    assert.equal(calls(), before);
    const resumed = await runOwnedAction(rotated, owner, agentId, { key: 'stake-0003', action, limits });
    assert.equal(resumed.state, 'confirmed');
  }));

test('access takes the owner\'s wallet signature over its exact limits, and a session alone gives none',
  { timeout: 60000 }, () => withAgents(async h => {
    const [alice, mallory] = [await h.signIn('alice.near'), await h.signIn('mallory.near')];
    const agentId = await openAgent(h, alice.token);
    const limits = { label: 'Claude', max_spend: '5000000', daily_limit: '12000000' };
    const ask = () => h.call(alice.token, 'POST', `/v1/agents/${agentId}/access`, limits);
    const signPath = (id: unknown) => `/v1/agents/${agentId}/access/${id}/sign`;
    const asked = await ask();
    assert.ok(!('token' in asked.body), 'a stolen session gets no token, only a request a wallet must sign');
    assert.equal(asked.body.recipient, h.config.webOrigin);
    assert.match(String(asked.body.message), /Name: Claude\nMost for one stake or buy: 5 nep141:usdc\.test\.near\n/);
    assert.match(String(asked.body.message), /Most in 24 hours: 12 nep141:usdc\.test\.near/);
    assert.match(String(asked.body.message), /cover stakes and buys\. It can also sell what the agent holds/);
    assert.deepEqual((await h.call(alice.token, 'GET', `/v1/agents/${agentId}/access`)).body.data, [],
      'a request not yet signed is no connection');

    const good = await signedRequest(alice, asked.body);
    const refused = async (body: Body, code: string, status = 403) => {
      const reply = await h.call(alice.token, 'POST', signPath(asked.body.id), body);
      assert.deepEqual([reply.status, reply.body.error?.code], [status, code]);
    };
    await refused(await signedRequest(alice, asked.body, 'Most for one stake or buy: 500'), 'invalid_signature');
    await refused(await signedRequest(mallory, asked.body), 'invalid_signature');
    await refused({ public_key: good.public_key, signature: 'short' }, 'invalid_signature');
    await refused({ public_key: 'not a key', signature: good.signature }, 'invalid_signature');
    await refused({}, 'invalid_signature');
    assert.equal((await h.call(mallory.token, 'POST', signPath(asked.body.id), good)).status, 404);

    const issued = await h.call(alice.token, 'POST', signPath(asked.body.id), good);
    assert.match(String(issued.body.token), /^dmk_[A-Za-z0-9_-]{43}$/);
    await refused(good, 'access_request_not_found', 404);
    const late = await ask();
    await h.pool.query("UPDATE agent_access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
      [late.body.id]);
    const expired = await h.call(alice.token, 'POST', signPath(late.body.id), await signedRequest(alice, late.body));
    assert.deepEqual([expired.status, expired.body.error?.code], [404, 'access_request_not_found']);
  }));

test('an access token acts for its one agent within the owner\'s stake limits, and stops when the owner says',
  { timeout: 60000 }, () => withAgents(async h => {
    const [alice, bob] = [await h.signIn('alice.near'), await h.signIn('bob.near')];
    const agentId = await openAgent(h, alice.token);
    const ask = (limits: Body, who = alice) => h.call(who.token, 'POST', `/v1/agents/${agentId}/access`, limits);
    const limits = { label: 'Claude', max_spend: '5000000', daily_limit: '12000000' };
    for (const [asked, code] of [[{ ...limits, max_spend: '0' }, 'invalid_max_spend'],
      [{ ...limits, daily_limit: '1' }, 'daily_limit_below_max_spend'], [{ ...limits, label: '' }, 'invalid_label']]) {
      assert.equal((await ask(asked as Body)).body.error?.code, code);
    }
    assert.equal((await ask(limits, bob)).status, 404, 'only the owner gives access');
    const issued = await giveAccess(h, alice, agentId, limits);
    const token = String(issued.body.token);
    const stored = (await h.pool.query('SELECT token_hash FROM agent_access_tokens')).rows[0].token_hash;
    assert.equal(stored, createHash('sha256').update(token).digest('hex'), 'only the hash is kept');
    const listed = (await h.call(alice.token, 'GET', `/v1/agents/${agentId}/access`)).body.data as Body[];
    assert.deepEqual(listed.map(t => [t.label, t.max_spend, t.daily_limit, 'token' in t]),
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
    assert.deepEqual([summary.near_account_id, (summary.limits as Body).spent_today],
      [nearAccountOf(agentId), '0']);

    const stake = (requestId: string, amount: string) =>
      access('POST', 'actions', { request_id: requestId, action: { ...STAKE, amount } });
    assert.equal((await stake('too-much-0001', '5000001')).body.error?.code, 'spend_over_limit');
    assert.equal((await stake('first-00001', '5000000')).body.state, 'confirmed');
    assert.equal((await stake('first-00001', '5000000')).body.state, 'confirmed', 'a retry is not counted twice');
    assert.equal((await stake('second-0001', '5000000')).body.state, 'confirmed');
    assert.equal((await stake('third-00001', '5000000')).body.error?.code, 'daily_limit_reached');
    assert.equal((await stake('third-00002', '2000000')).body.state, 'confirmed', 'exactly up to the limit');
    assert.equal(((await access('GET', 'agent')).body.limits as Body).spent_today, '12000000');
    assert.deepEqual(((await access('GET', 'claimable')).body.data as Body[]).map(s => s.round), ['42']);
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
    for (const action of [{ kind: 'deposit', amount: '1' }, { kind: 'leave', venue: 'market' }]) {
      const refused = await access('POST', 'actions', { request_id: 'refused-001', action });
      assert.equal(refused.body.error?.code, 'invalid_action');
    }
    assert.equal((await access('POST', 'actions', { request_id: 'short', action: STAKE })).body.error?.code,
      'invalid_request_id');

    const expiring = await giveAccess(h, alice, agentId, limits);
    await h.pool.query("UPDATE agent_access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expiring.body.id]);
    const expired = await h.raw('GET', '/v1/agent-access/session', undefined,
      { Authorization: `Bearer ${String(expiring.body.token)}` });
    assert.equal(expired.body.error?.code, 'access_token_invalid', 'an expired token opens nothing');

    const revoked = await h.call(alice.token, 'POST', `/v1/agents/${agentId}/access/${issued.body.id}/revoke`);
    assert.equal(revoked.body.revoked, true);
    assert.equal((await access('GET', 'session')).body.error?.code, 'access_token_invalid');
    const second = String((await giveAccess(h, alice, agentId, limits)).body.token);
    await h.call(alice.token, 'POST', `/v1/agents/${agentId}/revoke`);
    const afterStop = await h.raw('GET', '/v1/agent-access/session', undefined, { Authorization: `Bearer ${second}` });
    assert.equal(afterStop.body.error?.code, 'access_token_invalid', 'stopping Dragons Market stops every token');
  }));

const spent = async (h: Harness) => (await h.pool.query(`SELECT COALESCE(sum((request->'action'->>'amount')::numeric),0)::text AS n
  FROM user_operations WHERE state<>'failed' AND request ? 'via'`)).rows[0].n;

test('stakes through one token cannot overrun its daily limit even all at once', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const issued = await giveAccess(h, alice, agentId, { label: 'Bot', max_spend: '5000000', daily_limit: '10000000' });
    const auth = { Authorization: `Bearer ${String(issued.body.token)}` };
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => h.raw('POST', '/v1/agent-access/actions',
      { request_id: `burst-000${i}`, action: { ...STAKE, amount: '5000000' } }, auth)));
    assert.equal(burst.filter(r => r.body.state === 'confirmed').length, 2);
    assert.equal(h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).length, 2,
      'the other four requests are refused before reaching the Agent API');
    assert.ok(burst.filter(r => r.body.state !== 'confirmed').every(r => r.body.error?.code === 'daily_limit_reached'));
    assert.equal(await spent(h), '10000000');
  }));

test('only money that may have moved counts against the daily limit', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const issued = await giveAccess(h, alice, agentId, { label: 'Bot', max_spend: '5000000', daily_limit: '5000000' });
    const auth = { Authorization: `Bearer ${String(issued.body.token)}` };
    const stake = (id: string) => h.raw('POST', '/v1/agent-access/actions', { request_id: id, action: STAKE }, auth);
    h.fake.state.refuse = 'insufficient_balance';
    assert.equal((await stake('refused-0001')).body.state, 'failed');
    h.fake.state.refuse = null;
    h.fake.state.event = 'nothing';
    assert.equal((await stake('reverted-001')).body.state, 'failed', 'the round did not take it');
    h.fake.state.event = 'staked';
    assert.equal(await spent(h), '0');
    assert.equal((await stake('counted-0001')).body.state, 'confirmed', 'the whole limit is still there');
    assert.equal((await stake('over-000001')).body.error?.code, 'daily_limit_reached');
  }));

test('a request id for one action is never sent as another', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const issued = await giveAccess(h, alice, agentId, { label: 'Bot', max_spend: '5000000', daily_limit: '6000000' });
    const auth = { Authorization: `Bearer ${String(issued.body.token)}` };
    const stake = (amount: string) => h.raw('POST', '/v1/agent-access/actions',
      { request_id: 'crashed-0001', action: { ...STAKE, amount } }, auth);
    h.fake.state.busy = true;
    assert.equal((await stake('1000000')).status, 502);
    h.fake.state.busy = false;
    const swapped = await stake('5000000');
    assert.deepEqual([swapped.status, swapped.body.error?.code], [409, 'operation_idempotency_conflict'],
      'admitted for one amount, a retry for more cannot skip the daily limit');
    assert.equal((await stake('1000000')).body.state, 'confirmed', 'the amount it was admitted for still goes');
    assert.equal(await spent(h), '1000000');
  }));

const BUY = { kind: 'buy', market: '7', side: 'yes', amount: '5000000', minShares: '990000' };

test('an owner trades a market through the agent: each step goes to the market and is proven by it',
  { timeout: 60000 }, () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const act = (key: string, action: unknown) =>
      h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`, { key, action });
    const sell = { kind: 'sell', market: '7', side: 'yes', shares: '1000000', minCollateral: '970000' };
    const steps: [string, unknown, string, Body][] = [
      ['buy-000001', BUY, 'buy', { market_id: '7', side: 'yes', amount: '5000000', min_shares: '990000' }],
      ['sell-00001', sell, 'sell', { market_id: '7', side: 'yes', shares: '1000000', min_collateral: '970000' }],
      ['redeem-001', { kind: 'redeem', market: '7' }, 'redeem', { market_id: '7' }],
      ['out-000001', { kind: 'withdraw', venue: 'market', amount: '3000000' }, 'withdraw', { amount: '3000000' }],
      ['leave-0001', { kind: 'leave', venue: 'market' }, 'storage_unregister', {}],
    ];
    for (const [key, action, method, args] of steps) {
      const done = await act(key, action);
      assert.equal(done.body.state, 'confirmed', `${method}: ${JSON.stringify(done.body)}`);
      const sent = h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).at(-1)!;
      assert.deepEqual([sent.body!.receiver_id, sent.body!.method_name, sent.body!.args], [MARKET, method, args]);
    }
    h.fake.state.event = 'nothing';
    assert.equal((await act('buy-000002', BUY)).body.state, 'failed', 'the market did not take it');
    h.fake.state.event = 'staked';
    const history = (await h.call(alice.token, 'GET', `/v1/agents/${agentId}/operations`)).body.data as Body[];
    assert.equal(history.length, 6);
  }));

test('a website session spends at most the site limit, across all of the owner\'s agents and both venues',
  { timeout: 60000 }, () => withAgents(async h => {
    const [alice, bob] = [await h.signIn('alice.near'), await h.signIn('bob.near')];
    const [first, second] = [await openAgent(h, alice.token), await openAgent(h, alice.token, 'Other')];
    const act = (who: Wallet, agentId: string, key: string, action: unknown) =>
      h.call(who.token, 'POST', `/v1/agents/${agentId}/actions`, { key, action });
    const hundred = { ...BUY, amount: '100000000' };
    const over = await act(alice, first, 'over-00001', { ...hundred, amount: '100000001' });
    assert.deepEqual([over.status, over.body.error?.code], [409, 'spend_over_limit']);
    assert.equal(h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).length, 0);
    for (let i = 0; i < 9; i++) {
      assert.equal((await act(alice, first, `buy-00000${i}`, hundred)).body.state, 'confirmed');
    }
    const stake = { ...STAKE, amount: '100000000' };
    assert.equal((await act(alice, second, 'stake-0001', stake)).body.state, 'confirmed', 'a stake is the same budget');
    const done = await act(alice, second, 'buy-000009', { ...hundred, amount: '1' });
    assert.deepEqual([done.status, done.body.error?.code], [409, 'daily_limit_reached'],
      'a second agent is no way around it');
    assert.equal((await act(alice, first, 'buy-000000', hundred)).body.state, 'confirmed',
      'a retry of an admitted action is not refused for the limit it already counted in');
    const bobs = await openAgent(h, bob.token);
    assert.equal((await act(bob, bobs, 'buy-000001', hundred)).body.state, 'confirmed', 'each owner has their own');
    const sell = { kind: 'sell', market: '7', side: 'yes', shares: '1000000', minCollateral: '970000' };
    assert.equal((await act(alice, first, 'sell-00001', sell)).body.state, 'confirmed',
      'getting money out of a position is never blocked by the limit');
    const { rows: [row] } = await h.pool.query("SELECT request FROM user_operations WHERE idempotency_key='buy-000000'");
    assert.equal(row.request.via, 'web:alice.near');
  }));

test('no trade goes out more than 10% worse than the price now, and a retry is never refused for the price',
  { timeout: 60000 }, () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const act = (key: string, action: unknown) =>
      h.call(alice.token, 'POST', `/v1/agents/${agentId}/actions`, { key, action });
    const sends = () => h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).length;
    const refused = async (key: string, action: unknown) => {
      const before = sends(), answer = await act(key, action);
      assert.deepEqual([answer.status, answer.body.error?.code, sends()], [409, 'slippage_too_wide', before], key);
    };
    h.chain.bought = '1000000';
    await refused('wide-00001', { ...BUY, minShares: '899999' });
    assert.equal((await act('tight-0001', { ...BUY, minShares: '900000' })).body.state, 'confirmed', 'exactly 10% goes');
    const sell = { kind: 'sell', market: '7', side: 'yes', shares: '1000000' };
    await refused('wide-00002', { ...sell, minCollateral: '881999' });
    assert.equal((await act('tight-0002', { ...sell, minCollateral: '882000' })).body.state, 'confirmed',
      'a sell is judged on what it pays after the fee');
    h.chain.quote = '1000000';
    await refused('wide-00003', { ...STAKE, minShares: '0' });
    assert.equal((await act('tight-0003', { ...STAKE, minShares: '900000' })).body.state, 'confirmed');
    assert.equal((await h.pool.query("SELECT 1 FROM user_operations WHERE idempotency_key LIKE 'wide-%'")).rowCount, 0,
      'a refused trade leaves nothing to follow');

    h.fake.state.busy = true;
    assert.equal((await act('moved-0001', { ...BUY, minShares: '900000' })).status, 502);
    h.fake.state.busy = false;
    h.chain.bought = '9000000';
    assert.equal((await act('moved-0001', { ...BUY, minShares: '900000' })).body.state, 'confirmed',
      'the first try may have gone out, so its retry follows it, whatever the price did since');
  }));

test('an access token trades within the limits the owner signed', { timeout: 60000 }, () => withAgents(async h => {
  const alice = await h.signIn('alice.near');
  const agentId = await openAgent(h, alice.token);
  const issued = await giveAccess(h, alice, agentId, { label: 'Claude', max_spend: '5000000', daily_limit: '8000000' });
  const auth = { Authorization: `Bearer ${String(issued.body.token)}` };
  const access = (method: string, path: string, body?: unknown) =>
    h.raw(method, `/v1/agent-access/${path}`, body, auth);
  const act = (id: string, action: unknown) => access('POST', 'actions', { request_id: id, action });
  h.chain.markets = [
    { id: '7', status: 'open', title: 'Open one', rule_text: 'r', resolution_source: 's', category: 'world',
      close_at: '4102444800000000000', price_yes: '620000', price_no: '380000', locked: '1000000' },
    { id: '8', status: 'closed', title: 'Closed one', close_at: '1', price_yes: '0', price_no: '0', locked: '0' },
  ];
  const listed = (await access('GET', 'markets')).body;
  assert.deepEqual((listed.markets as Body[]).map(m => [m.market, m.title, m.price_yes]),
    [['7', 'Open one', '620000']], 'only a market open to trade is offered');
  assert.deepEqual((await access('POST', 'quote-buy', { market: '7', side: 'yes', amount: '5000000' })).body,
    { market: '7', side: 'yes', amount: '5000000', shares: '1000000', fee: '20000' });
  assert.deepEqual((await access('POST', 'quote-sell', { market: '7', side: 'no', shares: '10' })).body,
    { market: '7', side: 'no', shares: '10', fee: '20000', collateral: '980000' });
  assert.equal((await access('POST', 'quote-buy', { market: 'x', side: 'yes', amount: '1' })).body.error?.code,
    'invalid_market');
  h.chain.positions = [{ market_id: '7', yes: '5', no: '0', status: 'open', outcome: null, redeemable: '0' }];
  assert.deepEqual((await access('GET', 'positions')).body.data, h.chain.positions);
  const summary = (await access('GET', 'agent')).body;
  assert.deepEqual([(summary.balances as Body).market_available, (summary.balances as Body).registered_with_market,
    (summary.balances as Body).positions], ['7000000', true, 1]);

  assert.equal((await act('over-000001', { ...BUY, amount: '5000001' })).body.error?.code, 'spend_over_limit');
  assert.equal(h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).length, 0);
  assert.equal((await act('buy-0000001', BUY)).body.state, 'confirmed');
  assert.equal((await act('buy-0000002', { ...BUY, amount: '3000001' })).body.error?.code, 'daily_limit_reached');
  assert.equal(h.fake.requests.filter(r => r.path.endsWith('/native/near/call')).length, 1);
  assert.equal((await act('stake-00001', { ...STAKE, amount: '3000000' })).body.state, 'confirmed',
    'a stake and a buy draw on the one limit the owner signed');
  assert.equal(((await access('GET', 'agent')).body.limits as Body).spent_today, '8000000');
  const sell = { kind: 'sell', market: '7', side: 'yes', shares: '1000000', minCollateral: '970000' };
  assert.equal((await act('sell-000001', sell)).body.state, 'confirmed');
  assert.equal((await act('redeem-0001', { kind: 'redeem', market: '7' })).body.state, 'confirmed');
}));

test('MCP policy reads are scoped and distinguish provider policy from signed connection allowances',
  { timeout: 60000 }, () => withAgents(async h => {
    const alice = await h.signIn('alice.near'), agentId = await openAgent(h, alice.token);
    const issued = await giveAccess(h, alice, agentId,
      { label: 'Policy reader', max_spend: '3000000', daily_limit: '7000000' });
    const auth = { Authorization: `Bearer ${String(issued.body.token)}` };
    const read = () => h.raw('GET', '/v1/agent-access/policy', undefined, auth);
    const policy = await read();
    assert.equal(policy.status, 200);
    assert.equal((policy.body.account_policy as Body).matches_application_policy, true);
    assert.deepEqual([(policy.body.connection as Body).max_spend, (policy.body.connection as Body).daily_limit],
      ['3000000', '7000000']);
    assert.equal((policy.body.enforcement as Body).native_call_trade_amounts_visible_to_provider, false);
    assert.equal(h.fake.requests.at(-1)!.path, `/v1/agents/${agentId}/policy`);
    assert.ok(!JSON.stringify(policy.body).includes('ngt_'));
    h.fake.frozen.add(agentId);
    assert.match(String((await read()).body.next), /Stop/);
    h.fake.policies.set(agentId, { ...h.fake.policies.get(agentId)!, actions: ['withdraw', 'swap'] });
    const changed = (await read()).body.account_policy as Body;
    assert.deepEqual([changed.matches_application_policy, changed.policy], [false, null]);
    assert.equal((await h.raw('GET', '/v1/agent-access/policy', undefined, {})).status, 401);
  }));

test('MCP market pages include older markets and continue through an empty open-market page',
  { timeout: 60000 }, () => withAgents(async h => {
    const alice = await h.signIn('alice.near'), agentId = await openAgent(h, alice.token);
    const issued = await giveAccess(h, alice, agentId,
      { label: 'Market reader', max_spend: '1', daily_limit: '1' });
    const auth = { Authorization: `Bearer ${String(issued.body.token)}` };
    h.chain.markets = Array.from({ length: 103 }, (_, i) => ({ id: String(i),
      status: i === 7 || i === 102 ? 'open' : 'closed', title: `Market ${i}`, close_at: '4102444800000000000',
      price_yes: '500000', price_no: '500000', locked: '0' }));
    const read = (cursor: unknown) => h.raw('POST', '/v1/agent-access/markets', { from_market: cursor }, auth);
    const first = (await read('0')).body, middle = (await read('50')).body, last = (await read('100')).body;
    assert.deepEqual([(first.markets as Body[]).map(m => m.market), first.next_from_market], [['7'], '50']);
    assert.deepEqual([middle.markets, middle.next_from_market], [[], '100']);
    assert.deepEqual([(last.markets as Body[]).map(m => m.market), last.next_from_market], [['102'], null]);
    assert.deepEqual((await read('103')).body.markets, []);
    for (const cursor of ['-1', '01', '18446744073709551616', {}, null]) {
      assert.equal((await read(cursor)).body.error?.code, 'invalid_market_cursor');
    }
  }));

function rawRequest(port: number, path: string, authorization: string) {
  return new Promise<number>((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { Authorization: authorization } },
      res => { res.resume(); res.on('end', () => done(res.statusCode ?? 0)); });
    req.on('error', fail);
    req.end();
  });
}

test('one access token gets 120 requests a minute, and another token its own', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const give = () => giveAccess(h, alice, agentId, { label: 'Bot', max_spend: '1', daily_limit: '1' })
      .then(r => String(r.body.token));
    const [one, two] = [await give(), await give()];
    const session = (token: string) =>
      h.raw('GET', '/v1/agent-access/session', undefined, { Authorization: `Bearer ${token}` });
    const burst = await Promise.all(Array.from({ length: 121 }, () => session(one)));
    assert.equal(burst.filter(r => r.status === 429).length, 1);
    assert.equal((await session(two)).status, 200, 'another token is not slowed by the first');
  }));

test('a path is limited as the route it reaches, however it is spelled', { timeout: 60000 },
  () => withAgents(async h => {
    const alice = await h.signIn('alice.near');
    const agentId = await openAgent(h, alice.token);
    const issued = await giveAccess(h, alice, agentId, { label: 'Bot', max_spend: '1', daily_limit: '1' });
    const auth = `Bearer ${String(issued.body.token)}`;
    const spelled = await Promise.all(Array.from({ length: 121 }, () =>
      rawRequest(h.port, '/v1/./agent-access/session', auth)));
    assert.equal(spelled.filter(s => s === 429).length, 1, 'a spelling does not skip the limit of one token');
    const dodging = await Promise.all(Array.from({ length: 140 }, (_, i) =>
      rawRequest(h.port, '/v1/agent-access/../config', `Bearer ${i}`)));
    assert.ok(dodging.filter(s => s === 429).length >= 1, 'a spelling does not earn the higher limit of the access routes');
  }));
