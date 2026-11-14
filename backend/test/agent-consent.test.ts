import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateIntentRequest } from '@near-intents-agent-api/sdk';
import { consentMatches } from '../src/agent-consent.js';
import { fitsOwnerFlow } from '../src/agent-policy.js';
import type { OwnerIntent } from '../src/agent-api.js';
import { canonical } from '../src/ingestion/block.js';
import { consentFixture, delegateFixture } from './owner-intent-fixture.js';
import { nearPolicyFixture } from './near-policy-fixture.js';

const owner = { account: 'alice.near', publicKey: 'ed25519:11111111111111111111111111111111' };
const identity = { type: 'near', account_id: owner.account, public_key: owner.publicKey };
const signing = { walletContract: 'wallets.example.near', messageRecipient: 'agents.example.com', network: 'mainnet' as const };
const agentId = 'a'.repeat(64);

function example(type: 'grant_issue' | 'grant_revoke', now = Date.now()) {
  const request: GenerateIntentRequest = type === 'grant_issue'
    ? { type, agent_id: agentId, label: 'Dragons trading', credential: 'b'.repeat(64),
      expires_at: new Date(now + 86400000).toISOString() }
    : { type, agent_id: agentId, grant_id: 'c'.repeat(64) };
  const generated: OwnerIntent = { correlation_id: 'intent_example', type, agent_id: agentId,
    signer: { ...identity, type: 'near' },
    status: 'PENDING_SIGNATURE', expires_at: new Date(now + 590000).toISOString(),
    intent: consentFixture(request, identity, 'mainnet', now), preview: { summary: 'Sign' } };
  return { request, generated };
}

function changed(generated: OwnerIntent, patch: Record<string, unknown>): OwnerIntent {
  const copy = structuredClone(generated);
  copy.intent.payload.message = canonical({ ...JSON.parse(String(copy.intent.payload.message)), ...patch });
  return copy;
}

test('owner consent accepts the API wire formats, including a grant lasting beyond its signing window', () => {
  for (const type of ['grant_issue', 'grant_revoke'] as const) {
    const { request, generated } = example(type);
    assert.ok(fitsOwnerFlow(signing, generated, type, agentId));
    assert.ok(consentMatches(signing, generated, request, owner));
  }
});

test('grant and revoke consent reject changes of signer, authority, network, freshness and hidden fields', () => {
  for (const type of ['grant_issue', 'grant_revoke'] as const) {
    const { request, generated } = example(type), now = Date.now();
    const mutations = [
      { owner: { ...identity, account_id: 'mallory.near' } },
      { owner: { ...identity, public_key: 'another-key' } },
      { owner: { ...identity, type: 'evm' } },
      { agent_id: 'd'.repeat(64) }, { network: 'testnet' }, { recipient: 'intents.near' },
      { domain: 'near-intents-agent-api.owner-change.v1' }, { owner_epoch: 0 }, { owner_epoch: 1.5 },
      { owner_epoch: Number.MAX_SAFE_INTEGER + 1 }, { tenant_id: '' }, { tenant_id: 't'.repeat(65) },
      { nonce: '08'.repeat(32) }, { nonce: 'f' },
      { issued_at_ms: now - 16 * 60000 }, { issued_at_ms: now + 120000 },
      { expires_at_ms: now - 1 }, { expires_at_ms: '2030-01-01' }, { hidden_permission: 'transfer' },
    ];
    for (const patch of mutations) {
      assert.equal(consentMatches(signing, changed(generated, patch), request, owner), false,
        `${type}: ${JSON.stringify(patch)}`);
    }
    for (const deadline of [now - 1, now + 16 * 60000, NaN]) {
      const expires_at = Number.isNaN(deadline) ? 'invalid' : new Date(deadline).toISOString();
      assert.equal(consentMatches(signing, { ...generated, expires_at }, request, owner), false);
    }
    const stale = example(type, now - 16 * 60000);
    assert.equal(consentMatches(signing, stale.generated, stale.request, owner), false);
  }
});

test('the consent must authorize exactly the requested grant credential and lifetime or revocation target', () => {
  const grant = example('grant_issue');
  for (const patch of [{ credential: 'd'.repeat(64) }, { label: 'Hidden permissions' }, { wallet_id: '' },
    { wallet_id: 'w'.repeat(257) }, { expires_at_ms: Date.now() + 90 * 86400000 }]) {
    assert.equal(consentMatches(signing, changed(grant.generated, patch), grant.request, owner), false);
  }
  const revoke = example('grant_revoke');
  for (const patch of [{ target_id: 'd'.repeat(64) }, { action: 'delete_agent' },
    { expires_at_ms: Date.now() + 86400000 }]) {
    assert.equal(consentMatches(signing, changed(revoke.generated, patch), revoke.request, owner), false);
  }
});

test('ambiguous JSON and mismatched nonce bytes are refused before reaching a wallet', () => {
  const { request, generated } = example('grant_issue');
  const payload = generated.intent.payload, text = String(payload.message);
  for (const message of ['not json', 'null', '[]', ` ${text}`, text.replace('{', '{"domain":"hidden",')]) {
    const bad = { ...generated, intent: { ...generated.intent, payload: { ...payload, message } } };
    assert.equal(consentMatches(signing, bad, request, owner), false);
  }
  for (const nonce of [Buffer.alloc(32, 8).toString('base64'), 'invalid']) {
    const bad = { ...generated, intent: { ...generated.intent, payload: { ...payload, nonce } } };
    assert.equal(consentMatches(signing, bad, request, owner), false);
  }
  const callback = { ...generated, intent: { ...generated.intent,
    payload: { ...payload, callbackUrl: 'https://phish.example.com' } } };
  assert.equal(fitsOwnerFlow(signing, callback, request.type, agentId), false);
});

test('wallet delegates cannot smuggle extra methods, funds, gas or a different signing family', () => {
  const create = nearPolicyFixture().generated;
  const accepts = (v: OwnerIntent) => fitsOwnerFlow(signing, v, v.type, agentId);
  assert.ok(accepts(create));
  assert.equal(accepts({ ...create, intent: { ...create.intent,
    payload: { ...create.intent.payload, senderId: 'mallory.near' } } }), false);
  for (const methodName of ['transfer', 'ft_transfer', 'execute', 'freeze_wallet', 'delete_wallet']) {
    const bad = structuredClone(create);
    const actions = bad.intent.payload.actions as { params: Record<string, unknown> }[];
    actions[0]!.params.methodName = methodName;
    assert.equal(accepts(bad), false, methodName);
  }
  for (const patch of [{ gas: '300000000000001' }, { gas: '0' }, { gas: '-1' }, { gas: '1e14' },
    { gas: '1'.repeat(1000) }, { deposit: '1000000000000000000000001' }, { args: 'encoded elsewhere' }]) {
    const bad = structuredClone(create);
    const actions = bad.intent.payload.actions as { params: Record<string, unknown> }[];
    Object.assign(actions[0]!.params, patch);
    assert.equal(accepts(bad), false, JSON.stringify(patch));
  }
  const duplicate = structuredClone(create);
  const calls = duplicate.intent.payload.actions as unknown[];
  calls.push(calls[0]);
  assert.equal(accepts(duplicate), false);
  for (const type of ['agent_freeze', 'agent_unfreeze'] as const) {
    const generated = nearPolicyFixture(type).generated;
    assert.ok(accepts(generated));
    const second = (generated.intent.payload.actions as { params: Record<string, unknown> }[])[1]!;
    second.params.deposit = '1';
    assert.equal(accepts(generated), false, 'no deposit to the state transition');
    second.params.deposit = '0';
    second.params.methodName = type === 'agent_freeze' ? 'unfreeze_wallet' : 'freeze_wallet';
    assert.equal(accepts(generated), false, 'the transition must match the owner request');
    assert.equal(accepts({ ...generated, intent: delegateFixture('agent_create') }), false, 'transition required');
  }
  assert.equal(accepts({ ...create, type: 'grant_revoke' }), false);
  assert.equal(accepts({ ...example('grant_issue').generated, type: 'agent_create' }), false);
});
