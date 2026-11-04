import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { grantCommitment, type IntentType } from '@near-intents-agent-api/sdk';
import { dragonsPolicy, fitsOwnerFlow, grantsNoMore } from '../src/agent-accounts.js';
import { openGrant, sealNewGrant } from '../src/agent-grants.js';
import { publicConfig, readConfig } from '../src/config.js';
import { AgentApiError, AgentApiUnavailable, type OwnerIntent } from '../src/agent-api.js';
import { InvalidAction } from '../src/agents.js';
import { refusal } from '../src/agent-routes.js';
import { ReadError } from '../src/read-api.js';

const deployment = {
  id: 'agents', startBlock: '1', collateralTokenId: 'nep141:usdc.fixture.near', collateralDecimals: 6,
  contracts: { rounds: 'rounds.fixture.near', market: 'market.fixture.near', verifier: 'intents.fixture.near' },
};
const AGENT_ID = 'a'.repeat(64);
const signing = { walletContract: 'wallets.example.near', messageRecipient: 'agents.example.com' };
const intent = (type: IntentType, standard: string, payload: Record<string, unknown>, agentId = AGENT_ID):
  OwnerIntent => ({ correlation_id: 'intent_1', type, agent_id: agentId, status: 'PENDING_SIGNATURE',
  expires_at: '2030-01-01T00:00:00.000Z', intent: { standard, payload }, preview: { summary: 'Sign' } });
const functionCall = (deposit: string) => ({ type: 'FunctionCall', params: { methodName: 'store_wallet_policy',
  args: {}, gas: '100000000000000', deposit } });
const delegate = (overrides: Record<string, unknown> = {}) =>
  ({ receiverId: 'wallets.example.near', actions: [functionCall('0')], ...overrides });
const message = (overrides: Record<string, unknown> = {}) => ({ message: '{"grant":1}',
  recipient: 'agents.example.com', nonce: Buffer.alloc(32, 9).toString('base64'), ...overrides });
const apiError = (status: number, code: string) =>
  new AgentApiError(status, { errors: [{ status: String(status), code, layer: 'policy', title: code }], meta: {} });

test('the owner\'s agent calls only rounds, and its money goes only to the owner or as a deposit to rounds', () => {
  const policy = dragonsPolicy(deployment, 'alice.near');
  assert.deepEqual(policy.native!.near, { sign_message: [], transfer: false, call: ['rounds.fixture.near'] },
    'the agent never holds the token, and the market is not part of the owner flow, so it can call neither');
  assert.deepEqual(policy.destinations, { mode: 'only', list: [
    { action: 'withdraw', chain: 'near', address: 'alice.near', memo: null },
    { action: 'withdraw', chain: 'near', address: 'rounds.fixture.near', memo: null },
  ] }, 'the API checks the yoctoNEAR that stake and withdraw attach against the same list');
  assert.deepEqual([policy.actions, policy.assets], [['withdraw'], ['nep141:usdc.fixture.near', 'nep141:wrap.near']]);
  assert.deepEqual(policy.limits, {
    per_transaction: { 'nep141:usdc.fixture.near': '100000000', 'nep141:wrap.near': '100000000000000000000000' },
    daily: { 'nep141:usdc.fixture.near': '500000000', 'nep141:wrap.near': '500000000000000000000000' },
  }, 'a payout sent to rounds is lost, so collateral leaves at most 100 at a time and 500 a day, NEAR 0.1 and 0.5');
  assert.equal(policy.max_actions_per_hour, 60);
  const { evm, solana } = policy.native!;
  assert.deepEqual([evm.sign_message, evm.sign_transaction, evm.sign_typed_data, solana],
    [false, false, [], { sign_message: false, sign_transaction: false }]);
});

test('without rounds the agent calls nothing and pays only the owner, and wNEAR collateral keeps the NEAR caps', () => {
  const owner = { action: 'withdraw', chain: 'near', address: 'alice.near', memo: null };
  const bare = dragonsPolicy({ ...deployment, contracts: {} }, 'alice.near');
  assert.deepEqual([bare.native!.near.call, bare.destinations], [[], { mode: 'only', list: [owner] }]);
  const wrapped = { ...deployment, collateralTokenId: 'nep141:wrap.near', collateralDecimals: 24 };
  assert.deepEqual(dragonsPolicy(wrapped, 'alice.near').limits, {
    per_transaction: { 'nep141:wrap.near': '100000000000000000000000' },
    daily: { 'nep141:wrap.near': '500000000000000000000000' },
  }, 'the tighter cap wins when the collateral is wNEAR');
});

test('a policy the API shows back may not grant the agent more than the one sent', () => {
  const sent = dragonsPolicy(deployment, 'alice.near');
  const native = sent.native!;
  const shown = { ...sent, assets: [...sent.assets as string[]].reverse() };
  assert.ok(grantsNoMore(shown, sent), 'the same lists in another order');
  const wider: [string, unknown][] = [
    ['another destination', { ...sent, destinations: { mode: 'any', list: [] } }],
    ['a destination added', { ...sent, destinations: { mode: 'only', list: [...sent.destinations.list,
      { action: 'withdraw', chain: 'near', address: 'mallory.near', memo: null }] } }],
    ['a swap', { ...sent, actions: ['withdraw', 'swap'] }],
    ['any asset', { ...sent, assets: 'any' }],
    ['the token contract', { ...sent, native: { ...native, near: { ...native.near,
      call: [...native.near.call, 'usdc.fixture.near'] } } }],
    ['NEAR transfers', { ...sent, native: { ...native, near: { ...native.near, transfer: true } } }],
    ['EVM transactions', { ...sent, native: { ...native, evm: { ...native.evm, sign_transaction: true } } }],
    ['a higher limit', { ...sent, limits: { per_transaction: { 'nep141:wrap.near': String(10n ** 24n) } } }],
    ['no cap on the collateral', { ...sent, limits: { ...sent.limits,
      per_transaction: { 'nep141:wrap.near': sent.limits.per_transaction!['nep141:wrap.near'] } } }],
    ['no hourly cap', { ...sent, max_actions_per_hour: null }],
    ['no policy at all', undefined],
  ];
  for (const [why, policy] of wider) assert.equal(grantsNoMore(policy, sent), false, why);
});

test('a grant token is sealed to its agent and commitment, and anything else opens to nothing', () => {
  const key = randomBytes(32);
  const { token, commitment, sealed } = sealNewGrant(key, AGENT_ID);
  assert.match(token, /^ngt_[A-Za-z0-9_-]{43}$/);
  assert.equal(commitment, createHash('sha256').update(token).digest('hex'));
  assert.ok(!sealed.includes(Buffer.from(token)), 'the token is not stored in the clear');
  assert.equal(openGrant(key, AGENT_ID, commitment, sealed), token);
  assert.equal(openGrant(key, 'b'.repeat(64), commitment, sealed), null, 'sealed to one agent');
  assert.equal(openGrant(randomBytes(32), AGENT_ID, commitment, sealed), null, 'only the grant key opens it');
  assert.equal(openGrant(key, AGENT_ID, grantCommitment(`ngt_${'x'.repeat(43)}`), sealed), null,
    'bound to its commitment');
  const flipped = Buffer.from(sealed);
  flipped.writeUInt8(flipped.readUInt8(20) ^ 1, 20);
  assert.equal(openGrant(key, AGENT_ID, commitment, flipped), null, 'a changed byte opens to nothing');
  assert.equal(openGrant(key, AGENT_ID, commitment, sealed.subarray(0, sealed.length - 4)), null,
    'a shortened tag opens to nothing');
  assert.equal(openGrant(key, AGENT_ID, commitment, Buffer.alloc(5)), null, 'a truncated seal opens to nothing');
  assert.equal(openGrant(key, AGENT_ID, commitment, null), null, 'a revoked grant keeps nothing to open');
  assert.notEqual(sealNewGrant(key, AGENT_ID).token, token, 'every grant gets its own token');
});

test('an owner is shown only what the Agent API\'s owner flow makes, never a request that could move their funds',
  () => {
    assert.ok(fitsOwnerFlow(signing, intent('agent_create', 'nep366', delegate()), 'agent_create'));
    assert.ok(fitsOwnerFlow(signing, intent('grant_issue', 'nep413', message()), 'grant_issue', AGENT_ID));
    for (const type of ['agent_freeze', 'agent_unfreeze', 'grant_revoke'] as const) {
      assert.ok(fitsOwnerFlow(signing, intent(type, 'nep366', delegate()), type, AGENT_ID), type);
    }
    const oneNear = delegate({
      actions: [functionCall('600000000000000000000000'), functionCall('400000000000000000000000')] });
    assert.ok(fitsOwnerFlow(signing, intent('agent_create', 'nep366', oneNear), 'agent_create'), 'up to 1 NEAR');
    const refused: [OwnerIntent, IntentType, string | undefined, string][] = [
      [intent('agent_create', 'nep366', delegate({ receiverId: 'usdc.fixture.near' })), 'agent_create', undefined,
        'a delegate to a token would move the owner\'s tokens'],
      [intent('agent_create', 'nep366', delegate({ receiverId: 'intents.near' })), 'agent_create', undefined,
        'a delegate to NEAR Intents'],
      [intent('agent_create', 'nep366', delegate({ actions: [functionCall('1000000000000000000000001')] })),
        'agent_create', undefined, 'more than 1 NEAR attached'],
      [intent('agent_create', 'nep366', delegate({ actions: [{ type: 'Transfer', params: { deposit: '1' } }] })),
        'agent_create', undefined, 'a transfer instead of a call'],
      [intent('agent_create', 'nep366', delegate({ actions: [] })), 'agent_create', undefined, 'no actions'],
      [intent('agent_create', 'nep366', delegate({ actions: [functionCall('-1')] })), 'agent_create', undefined,
        'a negative deposit'],
      [intent('grant_issue', 'nep413', message({ recipient: 'intents.near' })), 'grant_issue', AGENT_ID,
        'a message NEAR Intents would take as a signed transfer'],
      [intent('grant_issue', 'nep413', message({ nonce: 'short' })), 'grant_issue', AGENT_ID, 'a malformed nonce'],
      [intent('grant_issue', 'nep413', message()), 'grant_issue', 'b'.repeat(64), 'a grant for another agent'],
      [intent('grant_issue', 'nep413', message()), 'agent_create', undefined, 'another kind of request'],
      [intent('agent_freeze', 'nep366', delegate()), 'agent_unfreeze', AGENT_ID, 'a freeze is not a thaw'],
      [intent('agent_create', 'eip712', delegate()), 'agent_create', undefined,
        'a standard a NEAR wallet does not sign'],
    ];
    for (const [generated, type, agentId, why] of refused) {
      assert.equal(fitsOwnerFlow(signing, generated, type, agentId), false, why);
    }
  });

test('each failure reaches the owner as the code the page acts on, and only a busy operation reads as one', () => {
  const answered = (error: unknown) => {
    try { refusal(error); } catch (e) { return e instanceof ReadError ? [e.status, e.code] : e; }
  };
  assert.deepEqual(answered(new InvalidAction('invalid_round')), [400, 'invalid_round']);
  assert.deepEqual(answered(new Error('operation_idempotency_conflict')), [409, 'operation_idempotency_conflict']);
  assert.deepEqual(answered(new Error('operation_state_conflict')), [409, 'operation_in_progress'],
    'the same operation busy in another request is waited out by the page, not shown as a failure');
  assert.deepEqual(answered(apiError(403, 'policy_asset_denied')), [409, 'policy_asset_denied']);
  assert.deepEqual(answered(apiError(403, 'Evil <b>code</b>')), [409, 'agent_api_refused']);
  assert.deepEqual(answered(apiError(429, 'rate_limited')), [429, 'agent_api_rate_limited']);
  for (const outage of [apiError(401, 'unauthorized'), apiError(408, 'request_timeout'), apiError(503, 'http_503'),
    new AgentApiError(502, undefined), new AgentApiUnavailable('invalid_status_answer')]) {
    assert.deepEqual(answered(outage), [502, 'agent_api_unavailable'], outage.message);
  }
  const unexpected = new Error('database down');
  assert.equal(answered(unexpected), unexpected, 'anything else stays an internal error');
});

test('agent accounts need the grant key and the custody contract together, and switch the capability on', () => {
  const base = { DATABASE_URL: 'postgresql://localhost/test', AGENT_API_URL: 'https://agents.example.com',
    AGENT_API_KEY: `naa_${'k'.repeat(43)}`, DEPLOYMENT_ID: 'agents', DEPLOYMENT_START_BLOCK: '1',
    ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'intents.fixture.near',
    COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' };
  const key = randomBytes(32).toString('base64');
  const both = { ...base, AGENT_GRANT_KEY: key, AGENT_API_WALLET_CONTRACT: 'wallets.example.near' };
  const config = readConfig(both);
  assert.deepEqual(config.agentAccounts,
    { grantKey: Buffer.from(key, 'base64'), walletContract: 'wallets.example.near' });
  assert.equal(publicConfig(config).capabilities.agents, true);
  assert.deepEqual(publicConfig(config).agentCashOut, { perTransaction: '100000000', daily: '500000000' },
    'the web caps a cash out at what the policy allows');
  assert.equal(publicConfig(readConfig(base)).capabilities.agents, false);
  assert.ok(!JSON.stringify(publicConfig(config)).includes(key), 'the key is never public');
  assert.ok(!JSON.stringify(publicConfig(config)).includes(base.AGENT_API_KEY), 'the partner key is never public');
  assert.throws(() => readConfig({ ...base, AGENT_GRANT_KEY: key }), /go together/);
  assert.throws(() => readConfig({ ...both, AGENT_GRANT_KEY: randomBytes(16).toString('base64') }), /32 bytes/);
  assert.throws(() => readConfig({ ...both, AGENT_GRANT_KEY: `${key.slice(0, -2)}!!` }), /32 bytes/);
  assert.throws(() => readConfig({ ...both, AGENT_API_WALLET_CONTRACT: 'intents.near' }), /WALLET_CONTRACT/);
  assert.throws(() => readConfig({ ...both, AGENT_API_WALLET_CONTRACT: 'Wallets..near' }), /WALLET_CONTRACT/);
  const { AGENT_API_URL: _url, AGENT_API_KEY: _key, ...noApi } = both;
  assert.throws(() => readConfig(noApi), /go together/);
});
