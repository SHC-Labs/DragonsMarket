import { canonical } from '../src/ingestion/block.js';

// Agent API v6 grant / v2 administration wire formats. No signing keys are held here.
export function consentFixture(request: Record<string, unknown>, owner: unknown, network = 'mainnet', now = Date.now()) {
  const common = { owner, tenant_id: 'tenant-fixture', agent_id: request.agent_id, network,
    issued_at_ms: now, owner_epoch: 1, nonce: '09'.repeat(32), recipient: 'agents.example.com' };
  const message = request.type === 'grant_issue' ? {
    ...common, domain: 'near-intents-agent-api.agent-grant.v6', wallet_id: 'wallet-fixture',
    label: request.label, credential: request.credential, expires_at_ms: Date.parse(String(request.expires_at)),
  } : { ...common, domain: 'near-intents-agent-api.owner-admin.v2', action: 'revoke_grant',
    target_id: request.grant_id, expires_at_ms: now + 600000 };
  return { standard: 'nep413', payload: { message: canonical(message), recipient: common.recipient,
    nonce: Buffer.from(common.nonce, 'hex').toString('base64') } };
}

export function delegateFixture(type: string, forge = false) {
  const call = (methodName: string) => ({ type: 'FunctionCall', params: { methodName, args: {},
    gas: '50000000000000', deposit: '0' } });
  const actions = [call(forge ? 'ft_transfer' : 'store_wallet_policy')];
  if (type === 'agent_freeze') actions.push(call('freeze_wallet'));
  if (type === 'agent_unfreeze') actions.push(call('unfreeze_wallet'));
  return { standard: 'nep366', payload: { receiverId: forge ? 'usdc.test.near' : 'wallets.example.near', actions } };
}

export function evmConsentFixture(text: string, recipient = 'agents.example.com') {
  return { domain: { name: 'NEAR Wallet Contract', version: '1' }, primaryType: 'Authorization',
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }],
      Authorization: [{ name: 'purpose', type: 'string' }, { name: 'recipient', type: 'string' },
        { name: 'payload', type: 'string' }],
    }, message: { purpose: 'PROVE_OWNERSHIP', recipient, payload: text } };
}
