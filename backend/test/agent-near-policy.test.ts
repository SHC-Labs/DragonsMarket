import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccountPolicy, OwnerIntent } from '../src/agent-api.js';
import { fitsOwnerFlow } from '../src/agent-policy.js';
import { AgentApiClient, AgentApiUnavailable } from '../src/agent-api.js';
import { dragonsPolicy } from '../src/agent-policy.js';
import { nearPolicyFixture } from './near-policy-fixture.js';
import { policyForTransition } from '../src/agent-policy-state.js';

const signing = { network: 'mainnet' as const, walletContract: 'wallets.example.near',
  messageRecipient: 'agents.example.com' };
const accepts = (g: OwnerIntent) => fitsOwnerFlow(signing, g, g.type, g.agent_id);

test('NEAR create, freeze and unfreeze bind the exact custody wallet and policy while preserving JSON values', () => {
  for (const type of ['agent_create', 'agent_freeze', 'agent_unfreeze'] as const) {
    const { generated, actions, args } = nearPolicyFixture(type);
    assert.ok(accepts(generated), type);
    actions[0]!.params.args = Object.fromEntries(Object.entries(args).reverse());
    assert.ok(accepts(JSON.parse(JSON.stringify(generated))), 'key order is not authority');
    actions[0]!.params.args.version = 12;
    assert.ok(accepts(generated), 'provider document version is distinct from the account policy revision');
  }
});

test('NEAR policy storage refuses substituted custody, commitment, refunds and hidden arguments', () => {
  for (const type of ['agent_create', 'agent_freeze', 'agent_unfreeze'] as const) {
    const changes = [{ wallet_pubkey: `ed25519:${'f'.repeat(64)}` }, { locked: true },
      { version: 0 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { valid_until: 1 }, { valid_until: '9999999999' },
      { encrypted_data: '' }, { encrypted_data: 'AAEC Aw==' }, { encrypted_data: 'A'.repeat(32769) },
      { wallet_signature: 'bad' }, { storage_refund_to: 'mallory.near' },
      { agent_policy_hash: 'f'.repeat(64) }, { new_owner: 'mallory.near' }];
    for (const patch of changes) {
      const { generated, actions } = nearPolicyFixture(type);
      Object.assign(actions[0]!.params.args, patch);
      assert.equal(accepts(generated), false, `${type}: ${Object.keys(patch)}`);
    }
    const { args } = nearPolicyFixture(type);
    for (const key of Object.keys(args).filter(k => k !== 'storage_refund_to')) {
      const { generated, actions } = nearPolicyFixture(type);
      delete actions[0]!.params.args[key];
      assert.equal(accepts(generated), false, `missing ${key}`);
    }
  }
});

test('NEAR delegates refuse altered approvals, previews, expired requests and different signing families', () => {
  for (const type of ['agent_create', 'agent_freeze', 'agent_unfreeze'] as const) {
    for (const patch of [{ tenantId: 'other-tenant' }, { walletAccount: 'f'.repeat(64) },
      { walletContract: 'other.near' }, { revision: 0 }, { revision: 9 }, { policy: { frozen: false } },
      { storageRefundTo: 'mallory.near' }]) {
      const { generated } = nearPolicyFixture(type);
      Object.assign(generated.policy_approval!, patch);
      assert.equal(accepts(generated), false);
    }
    for (const patch of [{ revision: 9 }, { previous_revision: 8 }, { policy_hash: 'e'.repeat(64) },
      { policy: { frozen: false } }]) {
      const { generated } = nearPolicyFixture(type);
      Object.assign(generated.preview, patch);
      assert.equal(accepts(generated), false);
    }
    const { generated } = nearPolicyFixture(type);
    for (const expires_at of ['invalid', new Date(0).toISOString(), new Date(Date.now() + 601000).toISOString()]) {
      assert.equal(accepts({ ...generated, expires_at }), false);
    }
    for (const standard of ['nep413', 'eip712']) {
      assert.equal(accepts({ ...generated, intent: { ...generated.intent, standard } }), false);
    }
    assert.equal(accepts({ ...generated, agent_id: 'b'.repeat(64) }), false);
    delete generated.policy_approval;
    assert.equal(accepts(generated), false, 'old unbound requests need regeneration');
  }
});

test('NEAR transition calls cannot target another wallet, attach funds or add arguments', () => {
  for (const type of ['agent_freeze', 'agent_unfreeze'] as const) {
    for (const patch of [{ args: { wallet_pubkey: `ed25519:${'f'.repeat(64)}` } },
      { args: { wallet_pubkey: `ed25519:${'d'.repeat(64)}`, owner: 'mallory.near' } },
      { args: '{}' }, { deposit: '1' }, { methodName: 'delete_wallet' },
      { methodName: type === 'agent_freeze' ? 'unfreeze_wallet' : 'freeze_wallet' }]) {
      const { generated, actions } = nearPolicyFixture(type);
      Object.assign(actions[1]!.params, patch);
      assert.equal(accepts(generated), false);
    }
    const { generated, actions } = nearPolicyFixture(type);
    actions.reverse();
    assert.equal(accepts(generated), false, 'storage precedes transition');
  }
});

test('NEAR framing and budgets refuse alternate encodings without changing legitimate bounds', () => {
  for (const patch of [{ gas: '0' }, { gas: '300000000000001' }, { gas: '1e14' }, { gas: '01' },
    { deposit: '01' }, { deposit: '-1' }, { deposit: '1000000000000000000000001' },
    { args: '{}' }, { args: [] }, { args: null }, { callback: 'hidden' }]) {
    const { generated, actions } = nearPolicyFixture();
    Object.assign(actions[0]!.params, patch);
    assert.equal(accepts(generated), false, JSON.stringify(patch));
  }
  const { generated, actions } = nearPolicyFixture();
  actions[0]!.params.gas = '300000000000000';
  actions[0]!.params.deposit = '1000000000000000000000000';
  assert.ok(accepts(generated));
  generated.intent.payload.senderId = 'mallory.near';
  assert.equal(accepts(generated), false);
});

test('the provider cannot supply its own approval or swap the account, tenant or requested policy', async () => {
  const policy = dragonsPolicy({ id: 'test', startBlock: '1', collateralTokenId: 'nep141:usdc.near',
    collateralDecimals: 6, contracts: { market: 'market.near' } }, 'alice.near');
  const { generated, approval, actions } = nearPolicyFixture('agent_create', { approval: { policy } });
  const owner = { account: 'alice.near', publicKey: 'ed25519:key' };
  let agent: unknown = { id: generated.agent_id, owner: null, wallet: { near_account_id: approval.walletAccount } };
  let tenant = approval.tenantId;
  const paths: string[] = [];
  const api = new AgentApiClient({ url: 'https://agents.example.com', key: `naa_${'k'.repeat(43)}`, timeoutMs: 1000 },
    async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      const value = path.endsWith('/whoami') ? { tenant_id: tenant }
        : path.endsWith(`/agents/${generated.agent_id}`) ? agent : generated;
      return new Response(JSON.stringify(value));
    });
  const request = { type: 'agent_create' as const, name: 'Test', policy,
    owner: { type: 'near' as const, account_id: owner.account, public_key: owner.publicKey } };
  await assert.rejects(api.generateIntent(request, owner, 'create'), /policy_approval_required/);
  assert.equal(paths.length, 0);
  const expected = { walletContract: approval.walletContract, revision: 1, policy,
    storageRefundTo: approval.storageRefundTo };
  generated.policy_approval = { ...approval, walletAccount: 'f'.repeat(64), tenantId: 'forged' };
  assert.deepEqual((await api.generateIntent(request, owner, 'create', expected)).policy_approval, approval);
  for (const patch of [{ wallet_pubkey: `ed25519:${'f'.repeat(64)}` },
    { agent_policy_hash: '0'.repeat(64) }, { storage_refund_to: 'mallory.near' }]) {
    const saved = { ...actions[0]!.params.args };
    Object.assign(actions[0]!.params.args, patch);
    await assert.rejects(api.generateIntent(request, owner, 'create', expected), AgentApiUnavailable);
    actions[0]!.params.args = saved;
  }
  for (const owner of [undefined, { ...request.owner, account_id: 'mallory.near' }]) {
    agent = { id: generated.agent_id, owner, wallet: { near_account_id: approval.walletAccount } };
    await assert.rejects(api.generateIntent(request, { account: 'alice.near', publicKey: 'ed25519:key' },
      'create', expected), AgentApiUnavailable);
  }
  agent = { id: generated.agent_id, owner: null, wallet: { near_account_id: 'e'.repeat(64) } };
  await assert.rejects(api.generateIntent(request, owner, 'create', expected), AgentApiUnavailable);
  agent = { id: generated.agent_id, owner: null, wallet: { near_account_id: approval.walletAccount } };
  tenant = 'other-tenant';
  await assert.rejects(api.generateIntent(request, owner, 'create', expected), AgentApiUnavailable);
  await assert.rejects(api.generateIntent(request, owner, 'create', { ...expected,
    policy: { ...policy, frozen: true } }), /policy_approval_mismatch/);
});

test('failed proposals recover from applied history without signing failed or uncertain permissions', async () => {
  const applied = { revision: 1, status: 'APPLIED', policy: { frozen: false, actions: ['withdraw'] } };
  const failed = { revision: 2, status: 'FAILED', policy: { frozen: true, actions: ['withdraw', 'swap'] } };
  const current: AccountPolicy = { ...failed, status: 'FAILED', synced: false };
  let data: unknown = [failed, applied], calls = 0;
  const api = new AgentApiClient({ url: 'https://agents.example.com', key: `naa_${'k'.repeat(43)}`, timeoutMs: 1000 },
    async url => {
      const path = new URL(String(url));
      assert.equal(path.pathname, `/v1/agents/${'a'.repeat(64)}/policy/history`);
      assert.equal(path.searchParams.get('limit'), '100');
      calls++;
      return new Response(JSON.stringify({ data, next_cursor: null }));
    });
  const read = (snapshot = current) => policyForTransition(api, 'a'.repeat(64), snapshot);
  assert.deepEqual(await read(), { revision: 2, policy: applied.policy });
  assert.deepEqual(await read({ ...current, status: 'APPLIED', synced: true, policy: applied.policy }),
    { revision: 2, policy: applied.policy });
  assert.equal(calls, 1, 'applied policies need no extra read');
  for (const snapshot of [{ ...current, status: 'SIGNED' as const },
    { ...current, status: 'APPLIED' as const }, { ...current, revision: null }]) {
    await assert.rejects(read(snapshot), /policy_not_ready/);
  }
  assert.equal(calls, 1, 'unknown or pending state cannot prepare another signature');
  const newer = { ...failed, revision: 3 };
  data = [newer, failed, applied];
  assert.deepEqual(await read({ ...current, revision: 3 }), { revision: 3, policy: applied.policy });
  data = [newer, applied];
  await assert.rejects(read({ ...current, revision: 3 }), /owner_policy_history_incomplete/);
  for (data of [[], null, [applied, failed], [failed, failed], [failed],
    [{ ...failed, revision: 3 }, applied], [{ ...failed, policy: applied.policy }, applied],
    [{ ...failed, status: ['FAILED'] }, applied], [failed, { ...applied, policy: null }],
    [failed, { ...applied, policy: { frozen: 'false' } }], [failed, { ...applied, status: 'SIGNED' }],
    Array(101).fill(failed)]) {
    await assert.rejects(read());
  }
});
