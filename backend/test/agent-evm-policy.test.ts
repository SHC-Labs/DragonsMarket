import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import type { Policy } from '@near-intents-agent-api/sdk';
import { AgentApiClient, AgentApiUnavailable, type OwnerIntent } from '../src/agent-api.js';
import { evmAuthorityAccount, evmPolicyRequest } from '../src/agent-evm-policy.js';
import { verifyEvmSignature } from '../src/agent-evm-consent.js';
import { fitsOwnerFlow } from '../src/agent-policy.js';
import { policyArgs, policyFixture, policyOwner, policyWallet } from './evm-policy-fixture.js';

const signing = { network: 'mainnet' as const, walletContract: 'wallets.example.near',
  messageRecipient: 'agents.example.com' };
const accepts = (g: OwnerIntent) => fitsOwnerFlow(signing, g, g.type, g.agent_id);

test('create and freeze policy requests bind the derived authority, custody key and exact policy revision', async () => {
  assert.equal(evmAuthorityAccount(policyOwner.public_key), '0sd6fd8ebcac51e9b978ae03b01f89037bb30dd5d8');
  assert.throws(() => evmAuthorityAccount(policyWallet.publicKey), /invalid_evm_public_key/);
  for (const type of ['agent_create', 'agent_freeze', 'agent_unfreeze'] as const) {
    const { generated, approval, payload } = policyFixture(type);
    assert.ok(accepts(generated));
    const typed = evmPolicyRequest(generated, approval.walletContract, approval)!;
    assert.deepEqual(typed, payload);
    const signature = await policyWallet.signTypedData(typed);
    assert.ok(await verifyEvmSignature(policyOwner, typed, signature));
    const other = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
    assert.equal(await verifyEvmSignature(policyOwner, typed, await other.signTypedData(typed)), false);
    assert.equal(fitsOwnerFlow({ ...signing, network: 'testnet' }, generated, type), false);
  }
});

test('wallet requests reject unapproved policy evidence and unsupported operations', () => {
  const { generated } = policyFixture();
  const missing = structuredClone(generated);
  delete missing.policy_approval;
  assert.equal(accepts(missing), false);
  for (const patch of [{ tenantId: 'another-tenant' }, { walletAccount: 'e'.repeat(64) },
    { walletContract: 'intents.near' }, { revision: 2 }, { policy: { frozen: false, actions: ['transfer'] } },
    { storageRefundTo: 'mallory.near' }, { storageRefundTo: null }]) {
    const bad = structuredClone(generated);
    Object.assign(bad.policy_approval!, patch);
    assert.equal(accepts(bad), false, JSON.stringify(patch));
  }
  for (const patch of [{ revision: 0 }, { previous_revision: 1 }, { policy_hash: 'f'.repeat(64) },
    { policy: { frozen: true } }]) {
    const bad = structuredClone(generated);
    Object.assign(bad.preview, patch);
    assert.equal(accepts(bad), false);
  }
  for (const type of ['agent_freeze', 'grant_issue', 'policy_update', 'agent_delete'] as const) {
    assert.equal(accepts({ ...generated, type }), false);
  }
  assert.equal(accepts({ ...generated, agent_id: 'b'.repeat(64) }), false);
});

test('typed wallet framing rejects network, authority, nonce, deadline and nested signing ambiguity', () => {
  const { generated, payload, message } = policyFixture();
  const changes = [{ chainId: 'testnet' }, { signerId: policyOwner.address }, { signerId: 'mallory.near' },
    { nonce: -1 }, { nonce: 0x100000000 }, { nonce: 1.5 }, { nonce: '123' }, { timeoutSecs: 601 },
    { timeoutSecs: 0 }, { timeoutSecs: 3600 }, { timeoutSecs: '600' }, { ops: '[{}]' },
    { createdAt: new Date(Date.now() + 120000).toISOString() }, { createdAt: 'invalid' },
    { createdAt: new Date(Date.now() - 700000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
    { createdAt: '2026-02-30T10:00:00Z' }, { extra: true },
    { out: ` ${message.out}` }, { out: message.out.replace('{', '{"after":["hidden"],') }];
  for (const patch of changes) {
    const bad = structuredClone(generated);
    bad.intent.payload.message = { ...message, ...patch };
    assert.equal(accepts(bad), false, JSON.stringify(patch));
  }
  for (const patch of [{ primaryType: 'Authorization' }, { callback: 'https://phish.example' },
    { domain: { ...payload.domain, chainId: 8453 } },
    { types: { ...payload.types, WalletMessage: [...payload.types.WalletMessage].reverse() } }]) {
    const bad = structuredClone(generated);
    Object.assign(bad.intent.payload, patch);
    assert.equal(accepts(bad), false);
  }
  for (const expires_at of ['invalid', new Date(Date.now() - 1).toISOString(),
    new Date(Date.now() + 601000).toISOString()]) {
    assert.equal(accepts({ ...generated, expires_at }), false);
  }
});

test('a policy signature cannot add transfers, receivers, callbacks, methods or unbounded spend', () => {
  for (const type of ['agent_create', 'agent_freeze', 'agent_unfreeze'] as const) {
    const { generated, out, actions, message } = policyFixture(type);
    const checks = [
      { ...out, after: [{ receiver_id: 'mallory.near' }] }, { ...out, ops: [] },
      { ...out, then: [...out.then, ...out.then] },
      { ...out, then: [{ receiver_id: 'mallory.near', actions }] },
      { ...out, then: [{ ...out.then[0], callback: 'steal' }] },
      { ...out, then: [{ ...out.then[0], actions: [...actions, { action: 'transfer', amount: '1' }] }] },
    ];
    for (const patch of [{ function_name: 'delete_wallet' }, { deposit: '1000000000000000000000001' },
      { deposit: '01' }, { deposit: '-1' }, { min_gas: '100000000000001' }, { min_gas: '0' },
      { min_gas: '1e14' }, { min_gas: undefined }, { refund_to: 'mallory.near' },
      { args: 'invalid' }, { args: policyArgs({}) }, { action: 'transfer' }]) {
      checks.push({ ...out, then: [{ ...out.then[0]!, actions: [{ ...actions[0], ...patch }, ...actions.slice(1)] }] });
    }
    for (const altered of checks) {
      const bad = structuredClone(generated);
      bad.intent.payload.message = { ...message, out: JSON.stringify(altered) };
      assert.equal(accepts(bad), false, JSON.stringify(altered));
    }
  }
});

test('every policy argument is checked, including custody, lock, commitment, refund and freeze target', () => {
  for (const type of ['agent_create', 'agent_freeze', 'agent_unfreeze'] as const) {
    const { generated, out, actions, message, args } = policyFixture(type);
    for (const patch of [{ wallet_pubkey: `ed25519:${'f'.repeat(64)}` }, { locked: true }, { version: 0 },
      { version: Number.MAX_SAFE_INTEGER + 1 }, { valid_until: 1 }, { valid_until: '9999999999' },
      { encrypted_data: '' }, { encrypted_data: 'AAEC Aw==' }, { wallet_signature: 'bad' },
      { storage_refund_to: 'mallory.near' }, { agent_policy_hash: 'f'.repeat(64) }, { new_owner: 'mallory.near' }]) {
      const altered = structuredClone(out);
      altered.then[0]!.actions[0]!.args = policyArgs({ ...args, ...patch });
      const bad = structuredClone(generated);
      bad.intent.payload.message = { ...message, out: JSON.stringify(altered) };
      assert.equal(accepts(bad), false, JSON.stringify(patch));
    }
    if (type === 'agent_create') continue;
    for (const patch of [{ deposit: '1' }, { function_name: 'store_wallet_policy' },
      { args: policyArgs({ wallet_pubkey: `ed25519:${'f'.repeat(64)}` }) },
      { args: policyArgs({ wallet_pubkey: args.wallet_pubkey, caller: 'mallory.near' }) }]) {
      const altered = structuredClone(out);
      altered.then[0]!.actions[1] = { ...actions[1], ...patch };
      const bad = structuredClone(generated);
      bad.intent.payload.message = { ...message, out: JSON.stringify(altered) };
      assert.equal(accepts(bad), false);
    }
  }
});

test('provider policy generation needs caller-owned evidence and preserves the raw SDK proof', async () => {
  const { generated, approval } = policyFixture('agent_freeze');
  const bodies: unknown[] = [];
  let response: unknown = generated;
  const api = new AgentApiClient({ url: 'https://agents.example.com', key: `naa_${'k'.repeat(43)}`, timeoutMs: 1000 },
    async (url, init) => {
      if (String(url).endsWith(`/agents/${generated.agent_id}`)) return new Response(JSON.stringify({
        id: generated.agent_id, owner: policyOwner, wallet: { near_account_id: approval.walletAccount } }));
      if (String(url).endsWith('/whoami')) return new Response(JSON.stringify({ tenant_id: approval.tenantId }));
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(response), { status: 200 }); });
  const request = { type: 'agent_freeze' as const, agent_id: generated.agent_id };
  await assert.rejects(api.generateIntent(request, policyOwner, 'dm-policy'), AgentApiUnavailable);
  const accepted = await api.generateIntent(request, policyOwner, 'dm-policy', approval);
  assert.deepEqual(accepted.policy_approval, approval);
  assert.deepEqual(bodies.at(-1), request);
  await assert.rejects(api.generateIntent(request, policyOwner, 'dm-policy', { ...approval,
    walletAccount: 'f'.repeat(64) }), AgentApiUnavailable);
  const payload = evmPolicyRequest(accepted, approval.walletContract, approval)!;
  const signed = { standard: 'eip712', payload, signature: await policyWallet.signTypedData(payload) };
  response = { correlation_id: generated.correlation_id, type: generated.type, agent_id: generated.agent_id,
    status: 'PROCESSING', failure_code: null, details: {} };
  await api.submitIntent(accepted, signed);
  assert.deepEqual((bodies.at(-1) as Record<string, unknown>).signed_data, signed);
});

test('creation discovers the pending custody wallet without needing an already-bound owner', async () => {
  const policy: Policy = { frozen: false, actions: [], assets: [], confidential: false, owner_approval: true,
    limits: { per_transaction: {}, daily: {} }, destinations: { mode: 'only', list: [] }, max_actions_per_hour: 1,
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0,
    native: { near: { sign_message: [], transfer: false, call: [] },
      evm: { sign_typed_data: [], sign_message: false, sign_transaction: false },
      solana: { sign_message: false, sign_transaction: false } } };
  const { generated, approval } = policyFixture('agent_create', Date.now(), policy);
  const expected = { walletContract: approval.walletContract, policy, revision: 1,
    storageRefundTo: approval.storageRefundTo };
  let agent: unknown = { id: generated.agent_id, owner: null, wallet: { near_account_id: approval.walletAccount } };
  let tenant = approval.tenantId;
  const paths: string[] = [];
  const api = new AgentApiClient({ url: 'https://agents.example.com', key: `naa_${'k'.repeat(43)}`, timeoutMs: 1000 },
    async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      const value = path.endsWith('/whoami') ? { tenant_id: tenant }
        : path.endsWith(`/agents/${generated.agent_id}`) ? agent : generated;
      return new Response(JSON.stringify(value));
    });
  const request = { type: 'agent_create' as const, name: 'Test', owner: policyOwner, policy };
  await assert.rejects(api.generateIntent(request, policyOwner, 'dm-create'), /policy_approval_required/);
  assert.equal(paths.length, 0, 'missing expectations must not provision an orphan agent');
  assert.deepEqual((await api.generateIntent(request, policyOwner, 'dm-create', expected)).policy_approval, approval);
  assert.equal(paths.some(path => path.endsWith('/wallet')), false, 'that route requires completed onboarding');
  for (const bad of [null, { id: 'f'.repeat(64), wallet: { near_account_id: approval.walletAccount } },
    { id: generated.agent_id, owner: { ...policyOwner, chain_id: 1 },
      wallet: { near_account_id: approval.walletAccount } },
    { id: generated.agent_id, wallet: null }, { id: generated.agent_id, wallet: { near_account_id: 'other.near' } },
    { id: generated.agent_id, wallet: { near_account_id: 'f'.repeat(64) } }]) {
    agent = bad;
    await assert.rejects(api.generateIntent(request, policyOwner, 'dm-create', expected), AgentApiUnavailable);
  }
  agent = { id: generated.agent_id, owner: null, wallet: { near_account_id: approval.walletAccount } };
  tenant = 'another-tenant';
  await assert.rejects(api.generateIntent(request, policyOwner, 'dm-create', expected), AgentApiUnavailable);
  await assert.rejects(api.generateIntent(request, policyOwner, 'dm-create', { ...expected,
    policy: { ...policy, frozen: true } }), /policy_approval_mismatch/);
});
