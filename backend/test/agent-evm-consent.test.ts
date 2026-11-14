import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { AgentApiClient, AgentApiUnavailable, type OwnerIntent } from '../src/agent-api.js';
import { consentMatches, consentText } from '../src/agent-consent.js';
import { evmConsent, isEvmOwner, verifyEvmConsent } from '../src/agent-evm-consent.js';
import { fitsOwnerFlow } from '../src/agent-policy.js';
import { canonical } from '../src/ingestion/block.js';
import { consentFixture, evmConsentFixture } from './owner-intent-fixture.js';

const wallet = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const other = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
const owner = { type: 'evm' as const, address: wallet.address.toLowerCase(), chain_id: 8453,
  public_key: `0x${wallet.publicKey.slice(4)}` };
const signing = { walletContract: 'wallets.example.near', messageRecipient: 'agents.example.com',
  network: 'mainnet' as const };
const agentId = 'a'.repeat(64);

function example(type: 'grant_issue' | 'grant_revoke' = 'grant_issue', now = Date.now()) {
  const request = type === 'grant_issue'
    ? { type, agent_id: agentId, label: 'Dragons Market', credential: 'b'.repeat(64),
      expires_at: new Date(now + 86400000).toISOString() }
    : { type, agent_id: agentId, grant_id: 'c'.repeat(64) };
  const text = consentFixture(request, owner, 'mainnet', now).payload.message;
  const payload = evmConsentFixture(text, signing.messageRecipient);
  const generated: OwnerIntent = { correlation_id: 'intent_evm', type, agent_id: agentId,
    signer: owner, status: 'PENDING_SIGNATURE', expires_at: new Date(now + 290000).toISOString(),
    intent: { standard: 'eip712', payload }, preview: { summary: 'Authorize' } };
  return { request, generated, payload };
}

test('EVM consent uses the provider Authorization schema and exact grant or revocation terms', () => {
  for (const type of ['grant_issue', 'grant_revoke'] as const) {
    const { request, generated, payload } = example(type);
    assert.ok(isEvmOwner(owner));
    assert.ok(fitsOwnerFlow(signing, generated, type, agentId));
    assert.ok(consentMatches(signing, generated, request, owner));
    assert.equal(consentText(generated, signing.messageRecipient), payload.message.payload);
    assert.equal(consentMatches({ ...signing, network: 'testnet' }, generated, request, owner), false);
    for (const patch of [{ owner: { ...owner, chain_id: 1 } }, { owner: { ...owner, address: other.address } },
      { owner: { ...owner, public_key: `0x${other.publicKey.slice(4)}` } }, { owner_epoch: 0 },
      { agent_id: 'd'.repeat(64) }, { recipient: 'intents.near' }, { network: 'testnet' },
      { nonce: 'bad' }, { issued_at_ms: Date.now() + 120000 }, { issued_at_ms: Date.now() - 960000 },
      { expires_at_ms: Date.now() - 1 }, { credential: 'e'.repeat(64) }, { target_id: 'e'.repeat(64) },
      { hidden_permission: 'unlimited' }]) {
      const bad = structuredClone(generated);
      bad.intent.payload.message = { ...payload.message,
        payload: canonical({ ...JSON.parse(payload.message.payload), ...patch }) };
      assert.equal(consentMatches(signing, bad, request, owner), false, `${type}: ${JSON.stringify(patch)}`);
    }
    for (const text of ['null', '[]', 'bad', ` ${payload.message.payload}`,
      payload.message.payload.replace('{', '{"owner_epoch":999,')]) {
      const bad = { ...generated, intent: { standard: 'eip712', payload: { ...payload,
        message: { ...payload.message, payload: text } } } };
      assert.equal(consentMatches(signing, bad, request, owner), false);
    }
  }
});

test('EVM consent rejects additional domain fields, types, purpose and unsupported wallet requests', () => {
  const { generated, payload } = example();
  const variants = [
    { ...payload, primaryType: 'WalletMessage' },
    { ...payload, domain: { ...payload.domain, chainId: 8453 } },
    { ...payload, domain: { ...payload.domain, version: '2' } },
    { ...payload, types: { ...payload.types, Permit: [{ name: 'spender', type: 'address' }] } },
    { ...payload, types: { ...payload.types, Authorization: [...payload.types.Authorization].reverse() } },
    { ...payload, message: { ...payload.message, purpose: 'EXECUTE' } },
    { ...payload, message: { ...payload.message, recipient: 'intents.near' } },
    { ...payload, message: { ...payload.message, value: '100' } },
    { ...payload, message: { ...payload.message, payload: 'x'.repeat(16385) } },
    { ...payload, callbackUrl: 'https://phish.example.com' },
  ];
  for (const bad of variants) {
    assert.equal(evmConsent(bad, signing.messageRecipient), null);
    assert.equal(fitsOwnerFlow(signing, { ...generated, intent: { standard: 'eip712', payload: bad } },
      generated.type, agentId), false);
  }
  for (const type of ['agent_create', 'agent_freeze', 'agent_unfreeze', 'policy_update'] as const) {
    assert.equal(fitsOwnerFlow(signing, { ...generated, type }, type, agentId), false);
  }
  for (const standard of ['nep413', 'nep366', 'webauthn']) {
    assert.equal(fitsOwnerFlow(signing, { ...generated, intent: { standard, payload } }, generated.type), false);
  }
});

test('EVM proof recovery binds the complete payload to the recovered session public key', async () => {
  const { payload } = example();
  const typed = evmConsent(payload, signing.messageRecipient)!;
  const signature = await wallet.signTypedData(typed);
  assert.ok(await verifyEvmConsent(owner, payload, signature));
  const parity = (Number.parseInt(signature.slice(-2), 16) - 27).toString(16).padStart(2, '0');
  assert.ok(await verifyEvmConsent(owner, payload, `${signature.slice(0, -2)}${parity}`));
  assert.equal(await verifyEvmConsent(owner, payload, await other.signTypedData(typed)), false);
  assert.equal(await verifyEvmConsent(owner, { ...payload,
    message: { ...payload.message, payload: `${payload.message.payload} ` } }, signature), false);
  assert.equal(await verifyEvmConsent({ ...owner, public_key: `0x${other.publicKey.slice(4)}` }, payload, signature), false);
  for (const invalid of ['', '0x', `0x${'00'.repeat(65)}`, `${signature.slice(0, -2)}02`,
    `${signature.slice(0, 66)}${'f'.repeat(64)}1b`, null, 123]) {
    assert.equal(await verifyEvmConsent(owner, payload, invalid), false);
  }
});

test('EVM signer descriptors cannot mix an address, key or chain from different identities', () => {
  for (const bad of [null, [], {}, { ...owner, chain_id: 0 }, { ...owner, chain_id: '8453' },
    { ...owner, chain_id: 1.5 }, { ...owner, chain_id: Number.MAX_SAFE_INTEGER + 1 },
    { ...owner, address: wallet.address }, { ...owner, address: other.address.toLowerCase() },
    { ...owner, public_key: wallet.publicKey }, { ...owner, public_key: `0x${other.publicKey.slice(4)}` },
    { ...owner, account_id: 'alice.near' }]) {
    assert.equal(isEvmOwner(bad), false, JSON.stringify(bad));
  }
});

test('the provider adapter retains the exact EVM signer and sends the wallet signature unchanged', async () => {
  const { request, generated, payload } = example();
  const calls: { url: string; init: RequestInit }[] = [];
  let response: unknown = generated;
  const api = new AgentApiClient({ url: 'https://agents.example.com', key: `naa_${'k'.repeat(43)}`, timeoutMs: 1000 },
    async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(response), { status: 200 });
    });
  const accepted = await api.generateIntent(request, owner, 'dm-grant-evm');
  assert.deepEqual(accepted.signer, owner);
  for (const signer of [{ ...owner, address: other.address.toLowerCase() }, { ...owner, chain_id: 1 },
    { ...owner, public_key: `0x${other.publicKey.slice(4)}` }, { ...owner, account_id: 'alice.near' },
    { type: 'near', account_id: 'alice.near', public_key: 'ed25519:key' }]) {
    response = { ...generated, signer };
    await assert.rejects(api.generateIntent(request, owner, 'dm-grant-evm'), AgentApiUnavailable);
  }
  response = { correlation_id: generated.correlation_id, type: 'grant_issue', agent_id: agentId,
    status: 'PROCESSING', failure_code: null, details: {} };
  const signature: Hex = await wallet.signTypedData(evmConsent(payload, signing.messageRecipient)!);
  const signed = { standard: 'eip712', payload, signature };
  await api.submitIntent(accepted, signed);
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)).signed_data, signed);
});
