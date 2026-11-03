import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ApiErrorLayer, Status } from '@near-intents-agent-api/sdk';
import {
  AgentApiClient, AgentApiError, AgentApiUnavailable, expectedOf, readAgentApiSettings, refusalCode,
  type AgentStatus, type Expected, type NativeCall, type Send,
} from '../src/agent-api.js';
import {
  InvalidAction, finalTransaction, nearBalance, parseAgentAction, planAgentAction, runAgentAction, type AgentAction,
  type AgentRunner, type ContractEvent, type FinalTransaction,
} from '../src/agents.js';
import { RpcError } from '../src/providers.js';
import { parseAction } from '../src/agent.js';

const AGENT_ID = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const KEY = `naa_${'k'.repeat(43)}`;
const grant = { agentId: AGENT_ID, token: `ngt_${'g'.repeat(43)}` };
const deployment = {
  id: 'agents', startBlock: '1', collateralTokenId: 'nep141:usdc.fixture.near', collateralDecimals: 6,
  contracts: { rounds: 'rounds.fixture.near', market: 'market.fixture.near', verifier: 'intents.fixture.near' },
};
const views = async (contract: string, method: string) => {
  if (method === 'storage_balance_bounds') return { min: '1250000000000000000000', max: '1250000000000000000000' };
  if (method === 'config') return { storage_deposit: '50000000000000000000000' };
  if (method === 'storage_balance_of') return { total: '1', available: '0' };
  throw new Error(`unexpected view ${contract}.${method}`);
};
const native = async (action: AgentAction) => {
  const plan = await planAgentAction(deployment, AGENT, action, views);
  assert.ok('native' in plan.send);
  return plan.send.native;
};
const apiError = (status: number, code: string, retryable = false, layer: ApiErrorLayer = 'policy') =>
  new AgentApiError(status, { errors: [{ status: String(status), code, layer, title: code, meta: { retryable } }],
    meta: {} });

test('each action is the one native call the contracts take from an agent account', async () => {
  const stake = await native({ kind: 'stake', series: 0, round: '42', side: 'up', amount: '5000000', minShares: '0' });
  assert.deepEqual(stake, { receiver_id: 'rounds.fixture.near', method_name: 'stake', gas: '50000000000000',
    deposit: '1', args: { series_id: 0, round: '42', side: 'up', amount: '5000000', min_shares: '0' } },
  'a stake is paid from the rounds balance, not sent by token');
  assert.deepEqual(await native({ kind: 'deposit', amount: '5000000' }), { receiver_id: 'usdc.fixture.near',
    method_name: 'ft_transfer_call', gas: '100000000000000', deposit: '1',
    args: { receiver_id: 'rounds.fixture.near', amount: '5000000', msg: 'deposit' } });
  const buy = await native({ kind: 'buy', market: '7', side: 'no', amount: '2000000', minShares: '1900000' });
  assert.deepEqual(buy.args, { receiver_id: 'market.fixture.near', amount: '2000000', msg: 'buy:7:no:1900000' });
  assert.deepEqual(await native({ kind: 'claim', series: 0, round: '42' }), { receiver_id: 'rounds.fixture.near',
    method_name: 'claim', args: { series_id: 0, round: '42', account_id: AGENT }, gas: '50000000000000',
    deposit: '0' });
  assert.equal((await native({ kind: 'redeem', market: '7' })).deposit, '0', 'redeem takes no deposit');
  const withdraw = await native({ kind: 'withdraw', contract: 'market', amount: '3000000' });
  assert.deepEqual([withdraw.receiver_id, withdraw.method_name, withdraw.deposit],
    ['market.fixture.near', 'withdraw', '1']);
  const register = await native({ kind: 'register', contract: 'rounds' });
  assert.deepEqual([register.receiver_id, register.deposit], ['rounds.fixture.near', '50000000000000000000000']);
  const token = await native({ kind: 'register_token' });
  assert.deepEqual(token.args, { account_id: AGENT, registration_only: true });
  assert.equal(token.deposit, '1250000000000000000000');
  const fund = await planAgentAction(deployment, AGENT, { kind: 'fund', amount: '5000000' }, views);
  assert.deepEqual(fund.send, { withdraw: { asset: 'nep141:usdc.fixture.near', amount: '5000000', chain: 'near',
    recipient: AGENT } });
});

test('a contract asking more than 0.1 NEAR to register is not paid', async () => {
  const greedy = async () => ({ storage_deposit: '100000000000000000000001', min: '100000000000000000000001' });
  for (const action of [{ kind: 'register', contract: 'rounds' }, { kind: 'register_token' }] as const) {
    await assert.rejects(planAgentAction(deployment, AGENT, action, greedy),
      (e: unknown) => e instanceof InvalidAction && /_too_high$/.test(e.message), action.kind);
  }
  const exact = async () => ({ storage_deposit: '100000000000000000000000' });
  const plan = await planAgentAction(deployment, AGENT, { kind: 'register', contract: 'rounds' }, exact);
  assert.ok('native' in plan.send && plan.send.native.deposit === '100000000000000000000000');
});

test('one parser lets through only well-formed actions of an allowed kind, with only the fields they use', async () => {
  const stake = { kind: 'stake', series: 0, round: '1', side: 'up', amount: '1', minShares: '0' };
  const refused: [unknown, string][] = [
    [{ ...stake, side: 'sideways' }, 'invalid_side'], [{ ...stake, series: -1 }, 'invalid_series'],
    [{ ...stake, series: '0' }, 'invalid_series'], [{ ...stake, series: 2 ** 32 }, 'invalid_series'],
    [{ ...stake, round: '01' }, 'invalid_round'], [{ ...stake, round: '18446744073709551616' }, 'invalid_round'],
    [{ ...stake, amount: '0' }, 'invalid_amount'], [{ ...stake, amount: String(2n ** 128n) }, 'invalid_amount'],
    [{ kind: 'deposit', amount: '-5' }, 'invalid_amount'],
    [{ kind: 'buy', market: '1', side: 'yes', amount: '1', minShares: '0' }, 'invalid_min_shares'],
    [{ kind: 'withdraw', contract: 'rounds', amount: '1:2' }, 'invalid_amount'],
    [{ kind: 'register', contract: 'verifier' }, 'invalid_contract'],
    [{ kind: 'cash_out', amount: '1', recipient: 'Not An Account' }, 'invalid_recipient'],
    [{ kind: '__proto__' }, 'invalid_action'], [{ kind: 'constructor' }, 'invalid_action'], [null, 'invalid_action'],
    [[stake], 'invalid_action'], [stake.kind, 'invalid_action'],
  ];
  for (const [input, code] of refused) {
    assert.throws(() => parseAgentAction(input), (e: unknown) => e instanceof InvalidAction && e.message === code,
      JSON.stringify(input));
  }
  assert.deepEqual(parseAgentAction({ ...stake, note: 'dropped', recipient: 'mallory.near' }), stake);
  assert.throws(() => parseAgentAction({ kind: 'fund', amount: '1' }, ['stake']), /invalid_action/);
  const noMarket = { ...deployment, contracts: { rounds: 'rounds.fixture.near', verifier: 'intents.fixture.near' } };
  await assert.rejects(planAgentAction(noMarket, AGENT, { kind: 'redeem', market: '1' }, views),
    (e: unknown) => e instanceof InvalidAction && e.message === 'market_not_configured');
});

type Seen = { url: string; init: RequestInit }[];
function transport(replies: { status: number; body: unknown }[], seen: Seen): typeof fetch {
  return async (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    const reply = replies.shift();
    assert.ok(reply, 'an unexpected request');
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status });
  };
}
const settings = { url: 'https://agents.example.com', key: KEY, timeoutMs: 1000 };
const CLAIM: NativeCall =
  { receiver_id: 'rounds.fixture.near', method_name: 'claim', args: {}, gas: '1', deposit: '0' };
const answered = (status: string, details: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  correlation_id: 'op_1', agent_id: AGENT_ID, type: 'native', status, failure_code: null, grant: null,
  created_at: '2030-01-01T00:00:00.000Z', updated_at: '2030-01-01T00:00:00.000Z', dispatch_committed_at: null,
  details: { method: 'near_call', chain: 'near', account_id: AGENT, target: 'rounds.fixture.near', method_name: 'claim',
    tx_hash: null, ...details }, ...top });

test('a send goes out under its grant and key, and only an answer naming that call is taken', async () => {
  const seen: Seen = [];
  const api = new AgentApiClient(settings, transport([
    { status: 202, body: answered('PROCESSING') },
    { status: 202, body: answered('PROCESSING', { target: 'market.fixture.near' }) },
    { status: 202, body: answered('PROCESSING', { method_name: 'withdraw' }) },
    { status: 202, body: answered('PROCESSING', { account_id: 'mallory.near' }) },
    { status: 202, body: answered('PROCESSING', {}, { agent_id: 'c'.repeat(64) }) },
    { status: 202, body: answered('PROCESSING', {}, { type: 'withdraw' }) },
    { status: 202, body: answered('DONE_PROBABLY') },
    { status: 202, body: answered('PROCESSING', {}, { correlation_id: 'op_1/../x' }) },
  ], seen));
  const send: Send = { native: CLAIM }, expected = expectedOf(send, AGENT_ID, AGENT);
  const calls = api.forGrant(grant);
  assert.equal((await calls.send('dm-0001-key', send, expected)).status, 'PROCESSING');
  const { url, init } = seen[0]!, headers = init.headers as Record<string, string>;
  assert.equal(url, `https://agents.example.com/v1/agents/${AGENT_ID}/native/near/call`);
  assert.deepEqual([init.method, headers['x-api-key'], headers['x-grant-token'], headers['idempotency-key']],
    ['POST', KEY, grant.token, 'dm-0001-key']);
  assert.deepEqual([init.redirect, init.credentials], ['error', 'omit']);
  assert.deepEqual(JSON.parse(String(init.body)), CLAIM);
  for (const why of ['another contract', 'another method', 'another account', 'another agent', 'another kind',
    'a status the API does not have', 'a malformed id']) {
    await assert.rejects(calls.send('dm-0001-key', send, expected), AgentApiUnavailable, why);
  }
  assert.throws(() => api.forGrant({ ...grant, token: 'ngt_short' }), /invalid_grant_token/);
  assert.throws(() => api.forGrant({ ...grant, agentId: 'A'.repeat(64) }), /invalid_agent_id/);
  assert.equal(seen.length, 8, 'a malformed grant is refused before anything is sent');
});

test('a withdrawal answer must name the asset, amount and recipient that were asked for', async () => {
  const w = { asset: 'nep141:usdc.fixture.near', amount: '5', chain: 'near' as const, recipient: 'alice.near' };
  const body = (recipient: string) => ({ ...answered('QUEUED'), type: 'withdraw',
    details: { action: 'withdraw', request: { ...w, recipient } } });
  const seen: Seen = [];
  const calls = new AgentApiClient(settings, transport([{ status: 202, body: body('alice.near') },
    { status: 202, body: body('mallory.near') }], seen)).forGrant(grant);
  const send: Send = { withdraw: w };
  assert.equal((await calls.send('dm-0002-key', send, expectedOf(send, AGENT_ID, AGENT))).status, 'QUEUED');
  assert.equal(seen[0]!.url, `https://agents.example.com/v1/agents/${AGENT_ID}/withdraw`);
  await assert.rejects(calls.send('dm-0002-key', send, expectedOf(send, AGENT_ID, AGENT)), AgentApiUnavailable);
});

test('a status is the one asked about, and a long poll waits at most 25 seconds', async () => {
  const seen: Seen = [];
  const api = new AgentApiClient(settings, transport([
    { status: 200, body: answered('SUCCESS', { tx_hash: 'tx1' }) },
    { status: 200, body: answered('SUCCESS', {}, { correlation_id: 'op_2' }) },
  ], seen));
  const expected = expectedOf({ native: CLAIM }, AGENT_ID, AGENT);
  assert.equal((await api.status('op_1', 99999, expected)).details.tx_hash, 'tx1');
  assert.equal(new URL(seen[0]!.url).searchParams.get('wait_ms'), '25000');
  await assert.rejects(api.status('op_1', 0, expected), AgentApiUnavailable, 'the status of another operation');
  await assert.rejects(api.status('op_1&refresh=true', 0, expected), /invalid_correlation_id/);
  assert.equal(seen.length, 2);
});

test('owner intents go out with the partner key alone and must be for this owner and agent', async () => {
  const seen: Seen = [];
  const generated = { correlation_id: 'intent_1', type: 'grant_issue', agent_id: AGENT_ID,
    status: 'PENDING_SIGNATURE', expires_at: '2030-01-01T00:00:00.000Z',
    signer: { type: 'near', account_id: 'alice.near', public_key: 'ed25519:key' },
    intent: { standard: 'nep413', payload: { message: 'm', recipient: 'agents.example.com', nonce: 'n' } },
    preview: { summary: 'Authorize' } };
  const api = new AgentApiClient(settings, transport([
    { status: 201, body: generated },
    { status: 201, body: { ...generated, signer: { ...generated.signer, account_id: 'mallory.near' } } },
    { status: 201, body: { ...generated, agent_id: 'c'.repeat(64) } },
    { status: 201, body: { ...generated, type: 'agent_create' } },
    { status: 201, body: { ...generated, correlation_id: 'op_1' } },
    { status: 201, body: { ...generated, intent: { standard: 'nep413' } } },
    { status: 202, body: { ...answered('PROCESSING'), correlation_id: 'intent_1', type: 'grant_issue',
      details: { grant: null } } },
  ], seen));
  const request = { type: 'grant_issue', agent_id: AGENT_ID, label: 'Dragons Market', credential: 'c'.repeat(64),
    expires_at: '2030-01-01T00:00:00.000Z' } as const;
  const intent = await api.generateIntent(request, 'alice.near', 'dm-grant-1');
  assert.deepEqual([intent.correlation_id, intent.intent.standard, intent.preview.summary],
    ['intent_1', 'nep413', 'Authorize']);
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.deepEqual([seen[0]!.url, headers['x-api-key'], headers['x-grant-token'], headers['idempotency-key']],
    ['https://agents.example.com/v1/generate-intent', KEY, undefined, 'dm-grant-1']);
  for (const why of ['another signer', 'another agent', 'another kind', 'an execution id', 'no payload']) {
    await assert.rejects(api.generateIntent(request, 'alice.near', 'dm-grant-1'), AgentApiUnavailable, why);
  }
  const signed = { standard: 'nep413', payload: generated.intent.payload, public_key: 'ed25519:key', signature: 's' };
  assert.equal((await api.submitIntent(intent, signed)).status, 'PROCESSING');
  assert.deepEqual(JSON.parse(String(seen[6]!.init.body)),
    { type: 'grant_issue', correlation_id: 'intent_1', signed_data: signed });
});

test('an oversized, unreadable or unreachable answer is no answer, and a refusal keeps its code', async () => {
  const expected: Expected = { type: 'native', agentId: AGENT_ID };
  const huge = async () => new Response(JSON.stringify({ padding: 'x'.repeat(1 << 20) }), { status: 200 });
  await assert.rejects(new AgentApiClient(settings, huge).status('op_1', 0, expected), AgentApiUnavailable);
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(new AgentApiClient(settings, down).status('op_1', 0, expected), AgentApiUnavailable);
  const seen: Seen = [];
  const api = new AgentApiClient(settings, transport([
    { status: 200, body: '<html>not json</html>' },
    { status: 502, body: '<html>Bad gateway</html>' },
    { status: 403, body: { errors: [{ status: '403', code: '<img src=x onerror=alert(1)>', layer: 'policy',
      title: 'x' }], meta: {} } },
    { status: 403, body: { errors: [{ status: '403', code: 'policy_asset_denied', layer: 'policy', title: 'x' }],
      meta: {} } },
  ], seen));
  await assert.rejects(api.status('op_1', 0, expected), AgentApiUnavailable);
  await assert.rejects(api.status('op_1', 0, expected),
    (e: unknown) => e instanceof AgentApiError && e.status === 502 && e.layer === undefined);
  await assert.rejects(api.status('op_1', 0, expected),
    (e: unknown) => e instanceof AgentApiError && refusalCode(e) === 'agent_api_refused');
  await assert.rejects(api.status('op_1', 0, expected),
    (e: unknown) => e instanceof AgentApiError && refusalCode(e) === 'policy_asset_denied');
});

test('the Agent API settings need both values, a plain https origin and a partner key', () => {
  assert.equal(readAgentApiSettings({}), null);
  assert.throws(() => readAgentApiSettings({ AGENT_API_URL: 'https://agents.example.com' }), /go together/);
  for (const url of ['http://agents.example.com', 'https://agents.example.com/v1', 'not a url']) {
    assert.throws(() => readAgentApiSettings({ AGENT_API_URL: url, AGENT_API_KEY: KEY }), /plain https origin/, url);
  }
  assert.throws(() => readAgentApiSettings({ AGENT_API_URL: settings.url, AGENT_API_KEY: grant.token }), /naa_ key/);
  assert.throws(() => readAgentApiSettings({ AGENT_API_URL: settings.url, AGENT_API_KEY: 'naa_short' }), /naa_ key/);
  assert.equal(readAgentApiSettings({ AGENT_API_URL: 'http://localhost:3600', AGENT_API_KEY: KEY })!.url,
    'http://localhost:3600');
});

interface Fake {
  runner: AgentRunner;
  sent: { key: string; send: Send; expected: Expected }[];
  transitions: string[];
  order: string[];
  requests: unknown[];
  released: string[];
}
interface FakeOptions {
  replies: AgentStatus[];
  events?: ContractEvent[];
  tx?: Partial<FinalTransaction>;
  existing?: { state: string; evidence: unknown };
  sendError?: unknown;
  held?: boolean;
  claimed?: boolean;
}
function fake(opts: FakeOptions): Fake {
  const sent: Fake['sent'] = [], transitions: string[] = [], order: string[] = [], requests: unknown[] = [];
  const released: string[] = [], replies = [...opts.replies];
  let state = opts.existing?.state ?? 'prepared';
  const reply = () => { const r = replies.shift(); assert.ok(r, 'an unexpected status read'); return r; };
  const runner: AgentRunner = {
    deployment, view: views, waitMs: 0,
    api: {
      forGrant: g => {
        assert.deepEqual(g, grant);
        return { send: async (key, send, expected) => {
          sent.push({ key, send, expected });
          order.push('send');
          if (opts.sendError) throw opts.sendError;
          return reply();
        } };
      },
      status: async () => reply(),
    },
    transaction: async () => {
      order.push('final transaction');
      const call = sent[0] && 'native' in sent[0].send ? sent[0].send.native : STAKE_CALL;
      return { signer: AGENT, receiver: call.receiver_id,
        calls: [{ method: call.method_name, args: call.args, deposit: call.deposit }], events: opts.events ?? [],
        ...opts.tx };
    },
    operations: {
      prepare: async (_agent, _kind, _key, request) => {
        requests.push(request);
        return { id: '00000000-0000-4000-8000-000000000001', state: 'prepared', evidence: null };
      },
      lease: async (_id, agent) => {
        assert.equal(agent, AGENT);
        return opts.held ? null : { token: 'lease-1', state, evidence: opts.existing?.evidence ?? null };
      },
      release: async (_id, _agent, token) => { released.push(token); },
      sent: async (_id, agent) => {
        assert.equal(agent, AGENT);
        assert.equal(state, 'prepared');
        order.push('marked sent');
      },
      transition: async (_id, agent, from, to, hash) => {
        assert.equal(agent, AGENT);
        assert.equal(from, state, `a transition from ${from} while the operation is ${state}`);
        if (opts.claimed && hash !== null) throw new Error('transaction_already_claimed');
        transitions.push(`${from}>${to}`);
        state = to;
      },
    },
  };
  return { runner, sent, transitions, order, requests, released };
}
const status = (s: Status, details: Record<string, unknown> = {}): AgentStatus =>
  ({ correlation_id: 'op_1', type: 'native', status: s, failure_code: null, details });
const STAKE = { kind: 'stake', series: 0, round: '42', side: 'up', amount: '5000000', minShares: '0' } as const;
const STAKE_CALL: NativeCall = { receiver_id: 'rounds.fixture.near', method_name: 'stake', gas: '50000000000000',
  deposit: '1', args: { series_id: 0, round: '42', side: 'up', amount: '5000000', min_shares: '0' } };
const staked: ContractEvent = { executor: 'rounds.fixture.near', standard: 'rounds', event: 'staked',
  data: { series_id: 0, round: '42', account: AGENT, side: 'up', amount: '5000000' } };
const run = (f: Fake, action: AgentAction = STAKE, holdNew = false) =>
  runAgentAction(f.runner, grant, { agent: AGENT, key: 'stake-1', action, holdNew });
const settledWith = (events: ContractEvent[], last = status('SUCCESS', { tx_hash: 'tx1' })) =>
  fake({ replies: [status('PROCESSING'), last], events });
const resend = (sendError: unknown) =>
  fake({ replies: [], sendError, existing: { state: 'prepared', evidence: { sent: true } } });

test('a stake is sent once under the operation key and done only when the round logged it for the agent', async () => {
  const f = settledWith([staked]);
  const result = await run(f);
  assert.equal(result.state, 'confirmed');
  assert.deepEqual(f.sent.map(s => s.key), ['dm-00000000-0000-4000-8000-000000000001']);
  assert.deepEqual(f.order, ['marked sent', 'send', 'final transaction'], 'the send is on record before it leaves');
  assert.deepEqual(f.transitions, ['prepared>submitted', 'submitted>confirmed']);
  assert.deepEqual(f.released, ['lease-1'], 'the hold is let go');
  assert.deepEqual((result.evidence as { event: unknown }).event, { name: 'staked', data: staked.data });
  assert.equal((f.requests[0] as { grant: string }).grant, createHash('sha256').update(grant.token).digest('hex'),
    'the operation is bound to the grant it is sent under');
  assert.equal(f.sent[0]!.expected.type, 'native');
  assert.ok(f.sent[0]!.expected.fits!({ method: 'near_call', target: 'rounds.fixture.near', account_id: AGENT }));
});

test('a run waits while another holds the operation, and acts on the state it read under its own hold', async () => {
  const busy = fake({ replies: [], held: true });
  await assert.rejects(run(busy), /operation_state_conflict/);
  assert.deepEqual([busy.sent, busy.transitions], [[], []]);
  const moved = fake({ replies: [status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    existing: { state: 'submitted', evidence: { correlation_id: 'op_1' } } });
  assert.equal((await run(moved)).state, 'confirmed');
  assert.deepEqual(moved.sent, [], 'a send another run already made is only polled');
});

test('only a refusal documented as sending nothing fails an operation before it is sent', async () => {
  for (const code of ['policy_destination_denied', 'spend_budget_exceeded', 'insufficient_balance', 'wallet_busy',
    'provider_refused']) {
    const f = fake({ replies: [], sendError: apiError(403, code) });
    const result = await run(f);
    assert.deepEqual([result.state, f.transitions], ['failed', ['prepared>failed']], code);
    assert.deepEqual(result.evidence, { reason: 'refused_before_sending', code });
  }
  for (const [error, why] of [[apiError(403, 'grant_revoked', false, 'grant'), 'a grant refusal'],
    [apiError(409, 'idempotency_conflict', false, 'request'), 'an earlier send under the key'],
    [apiError(400, 'invalid_request', false, 'request'), 'a validation refusal'],
    [apiError(403, 'policy_destination_denied', false, 'policy'), 'a documented code on a resend']] as const) {
    const f = why.includes('resend') ? resend(error) : fake({ replies: [], sendError: error });
    assert.equal((await run(f)).state, 'reconcile', why);
  }
});

test('an outage, a timeout or a refusal the same key can outlast leaves the operation to send again', async () => {
  for (const error of [apiError(503, 'internal_error', true, 'api'), apiError(429, 'rate_limited', true, 'api'),
    apiError(408, 'request_timeout', false, 'api'), apiError(409, 'operation_in_flight', true, 'request'),
    new AgentApiUnavailable('agent_api_unavailable'), new Error('database down')]) {
    const f = fake({ replies: [], sendError: error });
    await assert.rejects(run(f), (e: unknown) => e === error);
    assert.deepEqual(f.transitions, [], `${error.message} leaves the operation prepared`);
    assert.deepEqual(f.released, ['lease-1']);
  }
});

test('a resend goes under the same key and grant, and its success is followed to the end', async () => {
  const f = fake({ replies: [status('PROCESSING'), status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    existing: { state: 'prepared', evidence: { sent: true } } });
  assert.equal((await run(f)).state, 'confirmed');
  assert.deepEqual([f.order[0], f.sent.map(s => s.key)], ['send', ['dm-00000000-0000-4000-8000-000000000001']]);
});

test('a frozen agent fails a stake not yet sent, and still follows one already sent', async () => {
  const fresh = fake({ replies: [] });
  const held = await run(fresh, STAKE, true);
  assert.deepEqual([held.state, held.evidence, fresh.sent], ['failed', { reason: 'agent_frozen' }, []]);
  const inFlight = fake({ replies: [status('PROCESSING'), status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    existing: { state: 'prepared', evidence: { sent: true } } });
  assert.equal((await run(inFlight, STAKE, true)).state, 'confirmed');
});

test('a FAILED or REFUNDED status alone never fails an operation', async () => {
  const cases: [AgentStatus, ContractEvent[], string][] = [
    [status('FAILED'), [], 'reconcile'],
    [status('REFUNDED'), [], 'reconcile'],
    [status('FAILED', { never_executed: true }), [], 'failed'],
    [status('FAILED', { never_submitted: true }), [], 'failed'],
    [status('FAILED', { tx_hash: 'tx1' }), [], 'failed'],
    [status('FAILED', { tx_hash: 'tx1' }), [staked], 'confirmed'],
    [status('NEEDS_REVIEW'), [], 'reconcile'],
    [status('UNCERTAIN'), [], 'unknown'],
  ];
  for (const [last, events, state] of cases) {
    const result = await run(settledWith(events, last));
    assert.equal(result.state, state, JSON.stringify(last.details) + last.status);
  }
  const out = fake({ replies: [status('PROCESSING'), { ...status('FAILED', { tx_hash: 'tx1' }), type: 'withdraw' }] });
  const cashOut = { kind: 'cash_out', amount: '5', recipient: 'alice.near' } as const;
  assert.equal((await run(out, cashOut)).state, 'reconcile', 'a failed withdrawal has no transaction to read');
});

test('a withdrawal whose callback has not come is still owed, not failed', async () => {
  const out = { kind: 'withdraw', contract: 'rounds', amount: '3000000' } as const;
  const logged = (event: string): ContractEvent => ({ executor: 'rounds.fixture.near', standard: 'rounds', event,
    data: { account: AGENT, amount: '3000000', id: '7' } });
  const cases: [ContractEvent[], string][] = [[[logged('withdraw')], 'reconcile'],
    [[logged('withdraw'), logged('withdraw_failed')], 'failed'],
    [[logged('withdraw'), logged('withdraw_confirmed')], 'confirmed']];
  for (const [events, state] of cases) {
    assert.equal((await run(settledWith(events), out)).state, state, events.map(e => e.event).join());
  }
});

test('a stake the round did not take fails with what the contract logged, though the API reports success', async () => {
  const someoneElse: ContractEvent = { ...staked, data: { ...staked.data, account: 'other.near' } };
  const result = await run(settledWith([someoneElse]));
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.evidence, { correlation_id: 'op_1', status: 'SUCCESS', tx_hash: 'tx1',
    reason: 'contract_did_not_take_it', events: ['staked'] });
});

test('a stake is proven only by its own round, series, side and amount', async () => {
  for (const other of [{ round: '41' }, { series_id: 1 }, { side: 'down' }, { amount: '4999999' }]) {
    const result = await run(settledWith([{ ...staked, data: { ...staked.data, ...other } }]));
    assert.equal(result.state, 'failed', JSON.stringify(other));
  }
});

test('a deposit is proven by the round crediting the agent, and only by that', async () => {
  const deposit = { kind: 'deposit', amount: '5000000' } as const;
  const credited: ContractEvent = { executor: 'rounds.fixture.near', standard: 'rounds', event: 'deposit',
    data: { account: AGENT, amount: '5000000' } };
  assert.equal((await run(settledWith([credited]), deposit)).state, 'confirmed');
  const elsewhere = { ...credited, executor: 'market.fixture.near' };
  assert.equal((await run(settledWith([elsewhere]), deposit)).state, 'failed');
  const out = { kind: 'withdraw', contract: 'rounds', amount: '5000000' } as const;
  assert.equal((await run(settledWith([credited]), out)).state, 'failed', 'a deposit is not the withdrawal');
});

test('a rerun after a crash polls the submitted operation and never sends it again', async () => {
  const f = fake({ replies: [status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    existing: { state: 'submitted', evidence: { correlation_id: 'op_1' } } });
  assert.equal((await run(f)).state, 'confirmed');
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.transitions, ['submitted>confirmed']);
  const still = fake({ replies: [status('PROCESSING')],
    existing: { state: 'unknown', evidence: { correlation_id: 'op_1' } } });
  assert.equal((await run(still)).state, 'unknown');
  assert.deepEqual(still.transitions, [], 'an unknown operation stays unknown until it settles');
});

test('registering is read on chain only once its transaction is final', async () => {
  const register = { kind: 'register', contract: 'rounds' } as const;
  const f = settledWith([]);
  assert.equal((await run(f, register)).state, 'confirmed');
  assert.equal((f.sent[0]!.send as { native: NativeCall }).native.method_name, 'storage_deposit');
  assert.deepEqual(f.order.slice(-1), ['final transaction']);
  const noHash = settledWith([], status('SUCCESS'));
  assert.equal((await run(noHash, register)).state, 'reconcile');
});

test('a final transaction is its signer, receiver and calls, with events only from receipts that succeeded',
  async () => {
    const log = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: 'rounds', version: '1.0.0', event,
      data: { account: AGENT } })}`;
    const ok = { SuccessValue: '' }, failed = { Failure: { ActionError: {} } };
    const args = Buffer.from(JSON.stringify(STAKE_CALL.args)).toString('base64');
    const reply = (tx: Record<string, unknown>) => ({ call: async (method: string, params: unknown) => {
      assert.equal(method, 'EXPERIMENTAL_tx_status');
      assert.deepEqual(params, { tx_hash: 'tx1', sender_account_id: AGENT, wait_until: 'FINAL' });
      return { transaction: { hash: 'tx1', signer_id: AGENT, receiver_id: 'rounds.fixture.near', ...tx },
        receipts_outcome: [
          { outcome: { executor_id: 'usdc.fixture.near', logs: ['Transfer 5000000'], status: ok } },
          { outcome: { executor_id: 'rounds.fixture.near', logs: [log('deposit'), 'EVENT_JSON:{broken'], status: ok } },
          { outcome: { executor_id: 'rounds.fixture.near', logs: [log('staked')], status: failed } },
        ] };
    } });
    const actions = [{ FunctionCall: { method_name: 'stake', args, gas: 50000000000000, deposit: '1' } }, 'CreateAccount',
      { FunctionCall: { method_name: 'stake', args: 'bm90IGpzb24=', gas: 1, deposit: '1' } }];
    const tx = await finalTransaction(reply({ actions }), 'tx1', AGENT);
    assert.deepEqual([tx.signer, tx.receiver], [AGENT, 'rounds.fixture.near']);
    assert.deepEqual(tx.calls, [{ method: 'stake', args: STAKE_CALL.args, deposit: '1' }, null, null]);
    assert.deepEqual(tx.events.map(e => [e.executor, e.event]), [['rounds.fixture.near', 'deposit']],
      'a failed receipt keeps its logs, and they prove nothing');
    await assert.rejects(finalTransaction(reply({ actions, hash: 'tx2' }), 'tx1', AGENT), /invalid_transaction_outcome/,
      'an answer about another transaction');
    await assert.rejects(finalTransaction(reply({ actions: null }), 'tx1', AGENT), /invalid_transaction_outcome/);
  });

test('only the one call that was asked for, signed by the agent, proves or fails an operation', async () => {
  const call = { method: 'stake', args: STAKE_CALL.args, deposit: '1' };
  const cases: [string, Partial<FinalTransaction>][] = [
    ['another signer', { signer: 'mallory.near' }], ['another contract', { receiver: 'market.fixture.near' }],
    ['another method', { calls: [{ ...call, method: 'withdraw' }] }],
    ['another amount', { calls: [{ ...call, args: { ...STAKE_CALL.args, amount: '1' } }] }],
    ['another deposit', { calls: [{ ...call, deposit: '2' }] }], ['two calls', { calls: [call, call] }],
    ['an action that is no call', { calls: [null] }], ['no actions', { calls: [] }],
  ];
  for (const [why, tx] of cases) {
    for (const last of [status('SUCCESS', { tx_hash: 'tx1' }), status('FAILED', { tx_hash: 'tx1' })]) {
      const result = await run(fake({ replies: [status('PROCESSING'), last], events: [staked], tx }));
      assert.equal(result.state, 'reconcile', `${why} after ${last.status}`);
      assert.equal((result.evidence as { reason: string }).reason, 'transaction_not_this_call', why);
    }
  }
  const reordered = { calls: [{ ...call, args: { min_shares: '0', amount: '5000000', side: 'up', round: '42',
    series_id: 0 } }] };
  assert.equal((await run(fake({ replies: [status('PROCESSING'), status('SUCCESS', { tx_hash: 'tx1' })],
    events: [staked], tx: reordered }))).state, 'confirmed', 'the same arguments in another order are the same call');
});

test('a transaction another operation already settled stops this one for a check', async () => {
  const f = fake({ replies: [status('PROCESSING'), status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    claimed: true });
  const result = await run(f);
  assert.deepEqual([result.state, f.transitions], ['reconcile', ['prepared>submitted', 'submitted>reconcile']]);
  assert.equal((result.evidence as { reason: string }).reason, 'transaction_already_claimed');
});

test('an account the chain has not seen holds no NEAR, and any other answer is an error', async () => {
  const rpc = (answer: () => unknown) => ({ call: async (method: string, params: unknown) => {
    assert.deepEqual([method, params], ['query', { request_type: 'view_account', finality: 'final',
      account_id: AGENT }]);
    return answer();
  } });
  assert.equal(await nearBalance(rpc(() => ({ amount: '150000000000000000000000' })))(AGENT),
    '150000000000000000000000');
  assert.equal(await nearBalance(rpc(() => { throw new RpcError(-32000, 'UNKNOWN_ACCOUNT'); }))(AGENT), '0');
  await assert.rejects(nearBalance(rpc(() => { throw new RpcError(-32000, 'UNKNOWN_BLOCK'); }))(AGENT), RpcError);
  for (const amount of [undefined, '-1', '1.5', 7]) {
    await assert.rejects(nearBalance(rpc(() => ({ amount })))(AGENT), /invalid_account_view/, String(amount));
  }
});

test('the command line names one action and the key that resumes it', () => {
  assert.deepEqual(parseAction(['stake', '--key', 'stake-1', '--series', '0', '--round', '42', '--side', 'up',
    '--amount', '5000000', '--min-shares', '0']), { key: 'stake-1', action: STAKE });
  assert.deepEqual(parseAction(['deposit', '--key', 'in-1', '--amount', '9']),
    { key: 'in-1', action: { kind: 'deposit', amount: '9' } });
  assert.deepEqual(parseAction(['withdraw', 'rounds', '--key', 'out-1', '--amount', '9']),
    { key: 'out-1', action: { kind: 'withdraw', contract: 'rounds', amount: '9' } });
  assert.throws(() => parseAction(['stake', '--series', '0']), /--key is required/);
  assert.throws(() => parseAction(['register', 'oracle', '--key', 'k']), /npm run agent/);
  assert.throws(() => parseAction(['sweep', '--key', 'k']), /npm run agent/);
});
