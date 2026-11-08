import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ApiErrorLayer, Status } from '@near-intents-agent-api/sdk';
import {
  AgentApiClient, AgentApiError, AgentApiUnavailable, expectedOf, readAgentApiSettings, refusalCode,
  type AgentStatus, type Expected, type NativeCall, type Send,
} from '../src/agent-api.js';
import { InvalidAction, parseAgentAction, planAgentAction, spendOf, type AgentAction } from '../src/agent-actions.js';
import { finalTransaction, nearBalance, type ContractEvent, type FinalTransaction } from '../src/agent-chain.js';
import { followOperation, runAgentAction, type AgentRunner } from '../src/agents.js';
import { TransactionClaimed } from '../src/operations.js';
import { RpcError } from '../src/providers.js';

const AGENT_ID = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const KEY = `naa_${'k'.repeat(43)}`;
const grant = { agentId: AGENT_ID, token: `ngt_${'g'.repeat(43)}` };
const deployment = {
  id: 'agents', startBlock: '1', collateralTokenId: 'nep141:usdc.fixture.near', collateralDecimals: 6,
  contracts: { rounds: 'rounds.fixture.near', market: 'market.fixture.near', verifier: 'intents.fixture.near' },
};
const native = (action: AgentAction) => {
  const plan = planAgentAction(deployment, AGENT, action);
  assert.ok('native' in plan.send);
  return plan.send.native;
};
const apiError = (status: number, code: string, retryable = false, layer: ApiErrorLayer = 'policy') =>
  new AgentApiError(status, { errors: [{ status: String(status), code, layer, title: code, meta: { retryable } }],
    meta: {} });

test('each action is the one call the rounds contract takes from an agent account', () => {
  const stake = native({ kind: 'stake', series: 0, round: '42', side: 'up', amount: '5000000', minShares: '0' });
  assert.deepEqual(stake, { receiver_id: 'rounds.fixture.near', method_name: 'stake', gas: '50000000000000',
    deposit: '1', args: { series_id: 0, round: '42', side: 'up', amount: '5000000', min_shares: '0' } },
  'a stake is paid from the rounds balance, not sent by token');
  assert.deepEqual(native({ kind: 'claim', series: 0, round: '42' }), { receiver_id: 'rounds.fixture.near',
    method_name: 'claim', args: { series_id: 0, round: '42', account_id: AGENT }, gas: '50000000000000',
    deposit: '0' });
  const withdraw = native({ kind: 'withdraw', venue: 'rounds', amount: '3000000' });
  assert.deepEqual([withdraw.receiver_id, withdraw.method_name, withdraw.deposit],
    ['rounds.fixture.near', 'withdraw', '1']);
  const leave = native({ kind: 'leave', venue: 'rounds' });
  assert.deepEqual([leave.receiver_id, leave.method_name, leave.args, leave.deposit],
    ['rounds.fixture.near', 'storage_unregister', {}, '1']);
  const cashOut = planAgentAction(deployment, AGENT, { kind: 'cash_out', amount: '5000000', recipient: 'alice.near' });
  assert.deepEqual(cashOut.send, { withdraw: { asset: 'nep141:usdc.fixture.near', amount: '5000000', chain: 'near',
    recipient: 'alice.near' } });
});

test('each market action is the one call the market contract takes from a balance', () => {
  const at = 'market.fixture.near', gas = '50000000000000';
  assert.deepEqual(native({ kind: 'buy', market: '7', side: 'yes', amount: '2000000', minShares: '1900000' }),
    { receiver_id: at, method_name: 'buy', gas, deposit: '1',
      args: { market_id: '7', side: 'yes', amount: '2000000', min_shares: '1900000' } });
  assert.deepEqual(native({ kind: 'sell', market: '7', side: 'no', shares: '500', minCollateral: '400' }),
    { receiver_id: at, method_name: 'sell', gas, deposit: '1',
      args: { market_id: '7', side: 'no', shares: '500', min_collateral: '400' } });
  assert.deepEqual(native({ kind: 'redeem', market: '7' }),
    { receiver_id: at, method_name: 'redeem', gas, deposit: '0', args: { market_id: '7' } });
  assert.deepEqual(native({ kind: 'withdraw', venue: 'market', amount: '3' }),
    { receiver_id: at, method_name: 'withdraw', gas, deposit: '1', args: { amount: '3' } });
  assert.deepEqual(native({ kind: 'leave', venue: 'market' }),
    { receiver_id: at, method_name: 'storage_unregister', gas, deposit: '1', args: {} });
  assert.deepEqual([spendOf({ kind: 'buy', market: '7', side: 'yes', amount: '2', minShares: '1' }),
    spendOf({ kind: 'sell', market: '7', side: 'yes', shares: '9', minCollateral: '1' }),
    spendOf({ kind: 'withdraw', venue: 'market', amount: '9' })], [2n, 0n, 0n],
  'only money going into a position is spending');
});

test('one parser lets through only well-formed actions of an allowed kind, with only the fields they use', () => {
  const stake = { kind: 'stake', series: 0, round: '1', side: 'up', amount: '1', minShares: '0' };
  const buy = { kind: 'buy', market: '7', side: 'yes', amount: '1', minShares: '1' };
  const sell = { kind: 'sell', market: '7', side: 'yes', shares: '1', minCollateral: '1' };
  const refused: [unknown, string][] = [
    [{ ...stake, side: 'sideways' }, 'invalid_side'], [{ ...stake, series: -1 }, 'invalid_series'],
    [{ ...stake, series: '0' }, 'invalid_series'], [{ ...stake, series: 2 ** 32 }, 'invalid_series'],
    [{ ...stake, round: '01' }, 'invalid_round'], [{ ...stake, round: '18446744073709551616' }, 'invalid_round'],
    [{ ...stake, amount: '0' }, 'invalid_amount'], [{ ...stake, amount: String(2n ** 128n) }, 'invalid_amount'],
    [{ ...stake, minShares: '-1' }, 'invalid_min_shares'], [{ kind: 'deposit', amount: '5' }, 'invalid_action'],
    [{ kind: 'withdraw', venue: 'rounds', amount: '1:2' }, 'invalid_amount'],
    [{ kind: 'withdraw', amount: '1' }, 'invalid_venue'], [{ kind: 'leave', venue: 'verifier' }, 'invalid_venue'],
    [{ ...buy, market: '07' }, 'invalid_market'], [{ ...buy, market: 7 }, 'invalid_market'],
    [{ ...buy, side: 'up' }, 'invalid_side'], [{ ...buy, minShares: '0' }, 'invalid_min_shares'],
    [{ ...sell, side: 'down' }, 'invalid_side'], [{ ...sell, shares: '0' }, 'invalid_shares'],
    [{ ...sell, minCollateral: '0' }, 'invalid_min_collateral'],
    [{ kind: 'redeem', market: '-1' }, 'invalid_market'],
    [{ kind: 'cash_out', amount: '1', recipient: 'Not An Account' }, 'invalid_recipient'],
    [{ kind: '__proto__' }, 'invalid_action'], [{ kind: 'constructor' }, 'invalid_action'], [null, 'invalid_action'],
    [[stake], 'invalid_action'], [stake.kind, 'invalid_action'],
  ];
  for (const [input, code] of refused) {
    assert.throws(() => parseAgentAction(input), (e: unknown) => e instanceof InvalidAction && e.message === code,
      JSON.stringify(input));
  }
  assert.deepEqual(parseAgentAction({ ...stake, note: 'dropped', recipient: 'mallory.near' }), stake);
  assert.deepEqual(parseAgentAction({ ...buy, note: 'dropped' }), buy);
  assert.throws(() => parseAgentAction({ kind: 'leave', venue: 'rounds' }, ['stake']), /invalid_action/);
  const noVenues = { ...deployment, contracts: { verifier: 'intents.fixture.near' } };
  assert.throws(() => planAgentAction(noVenues, AGENT, { kind: 'leave', venue: 'rounds' }),
    (e: unknown) => e instanceof InvalidAction && e.message === 'rounds_not_configured');
  assert.throws(() => planAgentAction(noVenues, AGENT, { kind: 'redeem', market: '7' }),
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

test('a status read can ask the API to look again, and frozen is read from the policy in force', async () => {
  const seen: Seen = [];
  const policy = (value: unknown) => ({ status: 200, body: { wallet_id: 'w', revision: 1, status: 'APPLIED',
    policy: value } });
  const api = new AgentApiClient(settings, transport([
    { status: 200, body: answered('SUCCESS', { tx_hash: 'tx1' }) },
    policy({ frozen: true }), policy({ frozen: false }), policy(null), policy({ frozen: 'yes' }),
  ], seen));
  await api.status('op_1', 0, expectedOf({ native: CLAIM }, AGENT_ID, AGENT), true);
  assert.equal(new URL(seen[0]!.url).searchParams.get('refresh'), 'true');
  assert.equal(await api.frozen(AGENT_ID), true);
  assert.equal(seen[1]!.url, `https://agents.example.com/v1/agents/${AGENT_ID}/policy`);
  assert.equal(await api.frozen(AGENT_ID), false);
  for (const why of ['no policy', 'a flag that is not a boolean']) {
    await assert.rejects(api.frozen(AGENT_ID), AgentApiUnavailable, why);
  }
  await assert.rejects(api.frozen('A'.repeat(64)), /invalid_agent_id/);
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
  refreshes: (boolean | undefined)[];
}
interface FakeOptions {
  replies: AgentStatus[];
  events?: ContractEvent[];
  tx?: Partial<FinalTransaction>;
  existing?: { state: string; sent?: boolean; correlation?: string };
  sendError?: unknown;
  held?: boolean;
  claimed?: boolean;
}
function fake(opts: FakeOptions): Fake {
  const sent: Fake['sent'] = [], transitions: string[] = [], order: string[] = [], requests: unknown[] = [];
  const released: string[] = [], refreshes: Fake['refreshes'] = [], replies = [...opts.replies];
  let state = opts.existing?.state ?? 'prepared';
  const reply = () => { const r = replies.shift(); assert.ok(r, 'an unexpected status read'); return r; };
  const runner: AgentRunner = {
    deployment, waitMs: 0,
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
      status: async (_id, _wait, _expected, refresh) => {
        refreshes.push(refresh);
        return reply();
      },
    },
    transaction: async () => {
      order.push('final transaction');
      const call = sent[0] && 'native' in sent[0].send ? sent[0].send.native : STAKE_CALL;
      return { signer: AGENT, receiver: call.receiver_id,
        calls: [{ method: call.method_name, args: call.args, deposit: call.deposit }], events: opts.events ?? [],
        failed: [], ...opts.tx };
    },
    operations: {
      seen: async () => opts.existing !== undefined,
      prepare: async (_agent, _kind, _key, request) => {
        requests.push(request);
        return { id: '00000000-0000-4000-8000-000000000001', state: 'prepared', evidence: null };
      },
      lease: async ({ agent }) => {
        assert.equal(agent, AGENT);
        return opts.held ? null : { token: 'lease-1', state, evidence: null, sent: opts.existing?.sent ?? false,
          correlation: opts.existing?.correlation ?? null };
      },
      release: async (_op, token) => { released.push(token); },
      sent: async ({ agent }) => {
        assert.equal(agent, AGENT);
        assert.equal(state, 'prepared');
        order.push('marked sent');
      },
      transition: async ({ agent }, from, to, { txHash }) => {
        assert.equal(agent, AGENT);
        assert.equal(from, state, `a transition from ${from} while the operation is ${state}`);
        if (opts.claimed && txHash !== null) throw new TransactionClaimed();
        transitions.push(`${from}>${to}`);
        state = to;
      },
    },
  };
  return { runner, sent, transitions, order, requests, released, refreshes };
}
const status = (s: Status, details: Record<string, unknown> = {}): AgentStatus =>
  ({ correlation_id: 'op_1', type: 'native', status: s, failure_code: null, details });
const STAKE = { kind: 'stake', series: 0, round: '42', side: 'up', amount: '5000000', minShares: '0' } as const;
const STAKE_CALL: NativeCall = { receiver_id: 'rounds.fixture.near', method_name: 'stake', gas: '50000000000000',
  deposit: '1', args: { series_id: 0, round: '42', side: 'up', amount: '5000000', min_shares: '0' } };
const staked: ContractEvent = { executor: 'rounds.fixture.near', standard: 'rounds', event: 'staked',
  data: { series_id: 0, round: '42', account: AGENT, side: 'up', amount: '5000000' } };
const run = (f: Fake, action: AgentAction = STAKE) => runAgentAction(f.runner, grant, { agent: AGENT, key: 'stake-1', action });
const settledWith = (events: ContractEvent[], last = status('SUCCESS', { tx_hash: 'tx1' })) =>
  fake({ replies: [status('PROCESSING'), last], events });
const refusedWith = (events: ContractEvent[], last = status('SUCCESS', { tx_hash: 'tx1' })) =>
  fake({ replies: [status('PROCESSING'), last], events, tx: { failed: ['rounds.fixture.near', 'market.fixture.near'] } });
const resend =(sendError: unknown) => fake({ replies: [], sendError, existing: { state: 'prepared', sent: true } });

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
    existing: { state: 'submitted', correlation: 'op_1' } });
  assert.equal((await run(moved)).state, 'confirmed');
  assert.deepEqual(moved.sent, [], 'a send another run already made is only polled');
});

test('only a refusal documented as sending nothing fails an operation before it is sent', async () => {
  for (const code of ['policy_destination_denied', 'spend_budget_exceeded', 'insufficient_balance', 'wallet_busy',
    'provider_refused', 'policy_transaction_limit_exceeded', 'wallet_frozen', 'policy_not_ready',
    'authorization_stale', 'provider_policy_mismatch', 'custody_native_balance_required', 'agent_grant_required',
    'native_method_denied', 'invalid_request']) {
    const f = fake({ replies: [], sendError: apiError(403, code) });
    const result = await run(f);
    assert.deepEqual([result.state, f.transitions], ['failed', ['prepared>failed']], code);
    assert.deepEqual(result.evidence, { reason: 'refused_before_sending', code });
  }
  for (const [error, why] of [[apiError(403, 'grant_revoked', false, 'grant'), 'a grant refusal'],
    [apiError(409, 'idempotency_conflict', false, 'request'), 'an earlier send under the key'],
    [apiError(409, 'operation_not_recoverable', false, 'request'), 'a refusal the API does not say sent nothing'],
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
    existing: { state: 'prepared', sent: true } });
  assert.equal((await run(f)).state, 'confirmed');
  assert.deepEqual([f.order[0], f.sent.map(s => s.key)], ['send', ['dm-00000000-0000-4000-8000-000000000001']]);
});

test('the API alone judges a frozen agent: every action is refused and nothing is left in doubt', async () => {
  for (const action of [STAKE, { kind: 'claim', series: 0, round: '42' }, { kind: 'withdraw', venue: 'rounds', amount: '1' },
    { kind: 'buy', market: '7', side: 'yes', amount: '1', minShares: '1' },
    { kind: 'cash_out', amount: '1', recipient: 'alice.near' }] as const) {
    const held = await run(fake({ replies: [], sendError: apiError(409, 'wallet_frozen', false, 'request') }), action);
    assert.deepEqual([held.state, held.evidence], ['failed', { reason: 'refused_before_sending', code: 'wallet_frozen' }],
      action.kind);
  }
  const f = resend(apiError(409, 'wallet_frozen', false, 'request'));
  assert.equal((await run(f)).state, 'reconcile', 'a resend refused says nothing about the send before it');
});

test('a FAILED or REFUNDED status alone never fails an operation', async () => {
  const cases: [AgentStatus, ContractEvent[], string][] = [
    [status('FAILED'), [], 'reconcile'],
    [status('REFUNDED'), [], 'reconcile'],
    [status('FAILED', { never_executed: true }), [], 'failed'],
    [status('FAILED', { never_submitted: true }), [], 'failed'],
    [status('FAILED', { tx_hash: 'tx1' }), [], 'reconcile'],
    [status('FAILED', { tx_hash: 'tx1' }), [staked], 'confirmed'],
    [status('NEEDS_REVIEW'), [], 'reconcile'],
    [status('UNCERTAIN'), [], 'unknown'],
  ];
  for (const [last, events, state] of cases) {
    const result = await run(settledWith(events, last));
    assert.equal(result.state, state, JSON.stringify(last.details) + last.status);
  }
  assert.equal((await run(refusedWith([], status('FAILED', { tx_hash: 'tx1' })))).state, 'failed',
    'a contract that refused it on chain is the proof');
  const out = fake({ replies: [status('PROCESSING'), { ...status('FAILED', { tx_hash: 'tx1' }), type: 'withdraw' }] });
  const cashOut = { kind: 'cash_out', amount: '5', recipient: 'alice.near' } as const;
  assert.equal((await run(out, cashOut)).state, 'reconcile', 'a failed withdrawal has no transaction to read');
});

test('a withdrawal whose callback has not come is still owed, not failed', async () => {
  for (const [venue, executor] of [['rounds', 'rounds.fixture.near'], ['market', 'market.fixture.near']] as const) {
    const out = { kind: 'withdraw', venue, amount: '3000000' } as const;
    const logged = (event: string): ContractEvent => ({ executor, standard: venue, event,
      data: { account: AGENT, amount: '3000000', id: '7' } });
    const cases: [ContractEvent[], string][] = [[[logged('withdraw')], 'reconcile'],
      [[logged('withdraw'), logged('withdraw_failed')], 'failed'],
      [[logged('withdraw'), logged('withdraw_confirmed')], 'confirmed']];
    for (const [events, state] of cases) {
      assert.equal((await run(settledWith(events), out)).state, state, venue + events.map(e => e.event).join());
    }
  }
});

const BUY = { kind: 'buy', market: '7', side: 'yes', amount: '2000000', minShares: '1900000' } as const;
const bought: ContractEvent = { executor: 'market.fixture.near', standard: 'market', event: 'buy',
  data: { market_id: '7', account: AGENT, side: 'yes', shares: '2000000', collateral: '2000000', fee: '40000' } };

test('a trade is proven only by its own market, side and size, logged by the market', async () => {
  assert.equal((await run(settledWith([bought]), BUY)).state, 'confirmed');
  const wrong: [Partial<ContractEvent>, string][] = [
    [{ data: { ...bought.data, market_id: '8' } }, 'another market'],
    [{ data: { ...bought.data, side: 'no' } }, 'the other side'],
    [{ data: { ...bought.data, collateral: '1999999' } }, 'another size'],
    [{ data: { ...bought.data, account: 'other.near' } }, 'someone else'],
    [{ executor: 'rounds.fixture.near' }, 'another contract logging it'],
    [{ standard: 'rounds' }, 'another standard'],
    [{ event: 'sell' }, 'another event'],
  ];
  for (const [change, what] of wrong) {
    assert.equal((await run(settledWith([{ ...bought, ...change }]), BUY)).state, 'reconcile', what);
  }
  const sell = { kind: 'sell', market: '7', side: 'yes', shares: '500', minCollateral: '400' } as const;
  const sold: ContractEvent = { ...bought, event: 'sell', data: { market_id: '7', account: AGENT, side: 'yes',
    shares: '500', collateral: '420', fee: '8' } };
  assert.equal((await run(settledWith([sold]), sell)).state, 'confirmed');
  assert.equal((await run(settledWith([{ ...sold, data: { ...sold.data, shares: '499' } }]), sell)).state, 'reconcile');
  const redeem = { kind: 'redeem', market: '7' } as const;
  const paid: ContractEvent = { ...bought, event: 'redeemed', data: { market_id: '7', account: AGENT, amount: '9' } };
  assert.equal((await run(settledWith([paid]), redeem)).state, 'confirmed');
  assert.equal((await run(refusedWith([]), redeem)).state, 'failed', 'a redeem the market refused');
});

test('the fence runs before anything is prepared, and never between a retry and its own send', async () => {
  const fenced = async (f: Fake) => {
    let asked = 0;
    await runAgentAction(f.runner, grant, { agent: AGENT, key: 'stake-1', action: STAKE, fence: async () => {
      asked++;
      throw new Error('slippage_too_wide');
    } }).catch(() => {});
    return asked;
  };
  const fresh = fake({ replies: [] });
  assert.equal(await fenced(fresh), 1);
  assert.deepEqual([fresh.requests.length, fresh.sent.length], [0, 0], 'a fenced action leaves nothing to follow');
  const retry = fake({ replies: [status('PROCESSING'), status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    existing: { state: 'prepared', sent: true } });
  assert.equal(await fenced(retry), 0, 'a key already on record may have been sent, so the price cannot refuse it');
  assert.equal(retry.sent.length, 1);
});

test('a stake the round refused fails with what the contract logged, though the API reports success', async () => {
  const someoneElse: ContractEvent = { ...staked, data: { ...staked.data, account: 'other.near' } };
  const result = await run(refusedWith([someoneElse]));
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.evidence, { correlation_id: 'op_1', status: 'SUCCESS', tx_hash: 'tx1',
    reason: 'contract_did_not_take_it', events: ['staked'] });
});

test('a transaction that went through with no proof either way stops for the owner and never frees the limit', async () => {
  const result = await run(settledWith([]));
  assert.equal(result.state, 'reconcile', 'only a refusal on chain may read as failed');
  assert.deepEqual(result.evidence, { correlation_id: 'op_1', status: 'SUCCESS', tx_hash: 'tx1',
    reason: 'no_proof_either_way', events: [] });
  const elsewhere = fake({ replies: [status('PROCESSING'), status('SUCCESS', { tx_hash: 'tx1' })],
    tx: { failed: ['usdc.fixture.near'] } });
  assert.equal((await run(elsewhere)).state, 'reconcile', 'another contract\'s failure says nothing about this one');
});

test('a stake is proven only by its own round, series, side and amount', async () => {
  for (const other of [{ round: '41' }, { series_id: 1 }, { side: 'down' }, { amount: '4999999' }]) {
    const result = await run(settledWith([{ ...staked, data: { ...staked.data, ...other } }]));
    assert.equal(result.state, 'reconcile', JSON.stringify(other));
  }
});

test('leaving is proven by the round closing the agent\'s account, and only by that', async () => {
  const leave = { kind: 'leave', venue: 'rounds' } as const;
  const closed: ContractEvent = { executor: 'rounds.fixture.near', standard: 'rounds', event: 'unregistered',
    data: { account: AGENT, deposit_to: 'alice.near' } };
  assert.equal((await run(settledWith([closed]), leave)).state, 'confirmed');
  const elsewhere = { ...closed, executor: 'market.fixture.near' };
  assert.equal((await run(settledWith([elsewhere]), leave)).state, 'reconcile');
  assert.equal((await run(settledWith([]), leave)).state, 'reconcile', 'a call that closed nothing');
  const noHash = settledWith([closed], status('SUCCESS'));
  assert.equal((await run(noHash, leave)).state, 'reconcile');
});

test('a rerun after a crash polls the submitted operation and never sends it again', async () => {
  const f = fake({ replies: [status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    existing: { state: 'submitted', correlation: 'op_1' } });
  assert.equal((await run(f)).state, 'confirmed');
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.transitions, ['submitted>confirmed']);
  const still = fake({ replies: [status('PROCESSING')], existing: { state: 'unknown', correlation: 'op_1' } });
  assert.equal((await run(still)).state, 'unknown');
  assert.deepEqual(still.transitions, [], 'an unknown operation stays unknown until it settles');
});

const COMMITMENT = createHash('sha256').update(grant.token).digest('hex');
const stranded = (action: AgentAction = STAKE) => ({ id: 'op-1', agent: AGENT,
  request: { agent_id: AGENT_ID, grant: COMMITMENT, action } });
const noGrant = async () => null;

test('the sweep finishes an operation nobody is waiting on, with no grant and no second send', async () => {
  const f = fake({ replies: [status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    existing: { state: 'unknown', correlation: 'op_1' } });
  await followOperation(f.runner, stranded(), noGrant);
  assert.deepEqual([f.transitions, f.sent, f.released], [['unknown>confirmed'], [], ['lease-1']]);
  const unsettled = fake({ replies: [status('PROCESSING')], existing: { state: 'submitted', correlation: 'op_1' } });
  await followOperation(unsettled.runner, stranded(), noGrant);
  assert.deepEqual(unsettled.transitions, ['submitted>unknown']);
  const busy = fake({ replies: [], held: true, existing: { state: 'unknown', correlation: 'op_1' } });
  await followOperation(busy.runner, stranded(), noGrant);
  assert.deepEqual(busy.transitions, [], 'a caller that holds the operation is left to finish it');
});

test('the sweep asks again about an operation stopped for a check, and clears it only on proof', async () => {
  const proven = fake({ replies: [status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    existing: { state: 'reconcile', correlation: 'op_1' } });
  await followOperation(proven.runner, stranded(), noGrant);
  assert.deepEqual([proven.transitions, proven.refreshes], [['reconcile>confirmed'], [true]]);
  const review = fake({ replies: [status('NEEDS_REVIEW')], existing: { state: 'reconcile', correlation: 'op_1' } });
  await followOperation(review.runner, stranded(), noGrant);
  assert.deepEqual(review.transitions, [], 'still under review, it stays stopped');
  const blind = fake({ replies: [], existing: { state: 'reconcile' } });
  await followOperation(blind.runner, stranded(), noGrant);
  assert.deepEqual(blind.transitions, [], 'with nothing to ask about, it waits for the owner');
});

test('the sweep fails what never left, resends what may have, and stops when the grant is gone', async () => {
  const never = fake({ replies: [] });
  await followOperation(never.runner, stranded(), noGrant);
  assert.deepEqual([never.transitions, never.sent], [['prepared>failed'], []]);
  const asked: string[] = [];
  const found = async (agentId: string, commitment: string) => {
    asked.push(`${agentId}:${commitment}`);
    return grant;
  };
  const again = fake({ replies: [status('PROCESSING'), status('SUCCESS', { tx_hash: 'tx1' })], events: [staked],
    existing: { state: 'prepared', sent: true } });
  await followOperation(again.runner, stranded(), found);
  assert.deepEqual(asked, [`${AGENT_ID}:${COMMITMENT}`], 'only the grant it was sent under may send it again');
  assert.equal(again.sent[0]!.key, 'dm-op-1');
  assert.deepEqual(again.transitions, ['prepared>submitted', 'submitted>confirmed']);
  const gone = fake({ replies: [], existing: { state: 'prepared', sent: true } });
  await followOperation(gone.runner, stranded(), noGrant);
  assert.deepEqual([gone.transitions, gone.sent], [['prepared>reconcile'], []]);
});

test('the sweep does not touch an operation whose recorded request it cannot read', async () => {
  const f = fake({ replies: [], existing: { state: 'unknown', correlation: 'op_1' } });
  for (const request of [null, { grant: COMMITMENT, action: STAKE }, { agent_id: AGENT_ID, grant: COMMITMENT },
    { agent_id: AGENT_ID, grant: COMMITMENT, action: { kind: 'fund' } }]) {
    await assert.rejects(followOperation(f.runner, { id: 'op-1', agent: AGENT, request }, noGrant));
  }
  assert.deepEqual(f.transitions, []);
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
      return { final_execution_status: 'FINAL', status: ok,
        transaction: { hash: 'tx1', signer_id: AGENT, receiver_id: 'rounds.fixture.near', ...tx },
        transaction_outcome: { id: 'tx1', outcome: { executor_id: AGENT,
          status: { SuccessReceiptId: 'r1' }, receipt_ids: ['r1', 'r2', 'r3'] } },
        receipts_outcome: [
          { id: 'r1', outcome: { executor_id: 'usdc.fixture.near', logs: ['Transfer 5000000'], status: ok, receipt_ids: [] } },
          { id: 'r2', outcome: { executor_id: 'rounds.fixture.near', logs: [log('deposit'), 'EVENT_JSON:{broken'], status: ok, receipt_ids: [] } },
          { id: 'r3', outcome: { executor_id: 'rounds.fixture.near', logs: [log('staked')], status: failed, receipt_ids: [] } },
        ] };
    } });
    const actions = [{ FunctionCall: { method_name: 'stake', args, gas: 50000000000000, deposit: '1' } }, 'CreateAccount',
      { FunctionCall: { method_name: 'stake', args: 'bm90IGpzb24=', gas: 1, deposit: '1' } }];
    const tx = await finalTransaction(reply({ actions }), 'tx1', AGENT);
    assert.deepEqual([tx.signer, tx.receiver], [AGENT, 'rounds.fixture.near']);
    assert.deepEqual(tx.calls, [{ method: 'stake', args: STAKE_CALL.args, deposit: '1' }, null, null]);
    assert.deepEqual(tx.events.map(e => [e.executor, e.event]), [['rounds.fixture.near', 'deposit']],
      'a failed receipt keeps its logs, and they prove nothing');
    assert.deepEqual(tx.failed, ['rounds.fixture.near']);
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
