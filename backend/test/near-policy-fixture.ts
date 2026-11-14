import { policyFixture, policyHash } from './evm-policy-fixture.js';
import type { PolicyApproval } from '../src/agent-policy-approval.js';

export function nearPolicyFixture(type: 'agent_create' | 'agent_freeze' | 'agent_unfreeze' = 'agent_create',
  options: { approval?: Partial<PolicyApproval>; agentId?: string } = {}) {
  const { generated, approval, args } = policyFixture(type);
  Object.assign(approval, options.approval);
  generated.agent_id = options.agentId ?? generated.agent_id;
  generated.policy_approval = structuredClone(approval);
  generated.preview = { summary: 'Agent policy', revision: approval.revision,
    previous_revision: approval.revision - 1, policy_hash: policyHash(approval.policy), policy: approval.policy };
  args.wallet_pubkey = `ed25519:${approval.walletAccount}`;
  args.agent_policy_hash = policyHash({ domain: 'near-intents-agent-api.policy.v1', tenantId: approval.tenantId,
    agentId: generated.agent_id, revision: approval.revision, policy: approval.policy });
  delete args.storage_refund_to;
  if (approval.storageRefundTo !== null) args.storage_refund_to = approval.storageRefundTo;
  generated.signer = { type: 'near', account_id: 'alice.near', public_key: 'ed25519:key' };
  const call = (methodName: string, value: Record<string, unknown>, deposit = '0') => ({
    type: 'FunctionCall', params: { methodName, args: value, gas: '50000000000000', deposit },
  });
  const actions = [call('store_wallet_policy', args, '10000000000000000000000')];
  if (type !== 'agent_create') actions.push(call(type === 'agent_freeze' ? 'freeze_wallet' : 'unfreeze_wallet',
    { wallet_pubkey: args.wallet_pubkey }));
  generated.intent = { standard: 'nep366', payload: { receiverId: approval.walletContract, actions } };
  return { generated, approval, actions, args };
}
