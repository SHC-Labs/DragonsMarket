import type { OwnerIntent } from './agent-api.js';
import { approvalMatches, storeMatches, type PolicyApproval } from './agent-policy-approval.js';
import { canonical, object } from './ingestion/block.js';
import { isAccount } from './validate.js';

const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));

function callOf(value: unknown) {
  if (!object(value) || value.type !== 'FunctionCall' || !only(value, ['type', 'params'])
    || !object(value.params)) return null;
  const params = value.params;
  if (!only(params, ['methodName', 'args', 'deposit', 'gas']) || !object(params.args)
    || typeof params.deposit !== 'string' || !/^(0|[1-9]\d{0,24})$/.test(params.deposit)
    || typeof params.gas !== 'string' || !/^[1-9]\d{0,14}$/.test(params.gas)) return null;
  return { method: params.methodName, args: params.args, deposit: BigInt(params.deposit), gas: BigInt(params.gas) };
}

function callMatches(call: NonNullable<ReturnType<typeof callOf>>, g: OwnerIntent, a: PolicyApproval, index: number) {
  if (index === 0) return call.method === 'store_wallet_policy' && storeMatches(call.args, g, a);
  return call.method === (g.type === 'agent_freeze' ? 'freeze_wallet' : 'unfreeze_wallet')
    && call.deposit === 0n && canonical(call.args) === canonical({ wallet_pubkey: `ed25519:${a.walletAccount}` });
}

export function nearPolicyRequest(g: OwnerIntent, contract: string, a: PolicyApproval | undefined, now = Date.now()) {
  if (!a || a.walletContract !== contract || !isAccount(contract) || g.signer?.type !== 'near'
    || !isAccount(g.signer.account_id) || g.intent.standard !== 'nep366'
    || !/^[0-9a-f]{64}$/.test(g.agent_id) || !approvalMatches(g, a)) return false;
  if (a.storageRefundTo !== null && !isAccount(a.storageRefundTo)) return false;
  const deadline = Date.parse(g.expires_at);
  if (!(deadline > now && deadline <= now + 600000)) return false;
  const payload = g.intent.payload;
  if (!only(payload, ['receiverId', 'actions']) || payload.receiverId !== contract
    || !Array.isArray(payload.actions) || payload.actions.length !== (g.type === 'agent_create' ? 1 : 2)) return false;
  let gas = 0n, deposit = 0n;
  for (const [index, value] of payload.actions.entries()) {
    const call = callOf(value);
    if (!call || !callMatches(call, g, a, index)) return false;
    gas += call.gas;
    deposit += call.deposit;
  }
  return gas <= 300_000_000_000_000n && deposit <= 10n ** 24n;
}
