import { nearPolicyRequest } from './agent-near-policy.js';
import type { IntentType, Policy } from '@near-intents-agent-api/sdk';
import { canonical, object } from './ingestion/block.js';
import { agentCashOut, type Config } from './config.js';
import type { OwnerIntent } from './agent-api.js';
import { evmConsent, isEvmOwner } from './agent-evm-consent.js';
import { evmPolicyRequest } from './agent-evm-policy.js';

type Deployment = NonNullable<Config['deployment']>;
export interface OwnerSigning {
  walletContract: string; messageRecipient: string; network: Config['network']; policySponsor?: string | null;
}

const NEAR = 10n ** 24n;
const WRAPPED_NEAR = 'nep141:wrap.near';

const nearDestination = (address: string) => ({ action: 'withdraw' as const, chain: 'near', address, memo: null });

export function dragonsPolicy(d: Deployment, owner: string): Policy {
  const venues = [d.contracts.rounds, d.contracts.market].filter(contract => contract !== undefined);
  const cashOut = agentCashOut(d);
  return {
    frozen: false, actions: ['withdraw'], confidential: false, owner_approval: false,
    assets: [...new Set([d.collateralTokenId, WRAPPED_NEAR])],
    limits: {
      per_transaction: { [d.collateralTokenId]: cashOut.perTransaction, [WRAPPED_NEAR]: String(NEAR / 10n) },
      daily: { [d.collateralTokenId]: cashOut.daily, [WRAPPED_NEAR]: String(NEAR / 2n) },
    },
    max_actions_per_hour: 60,
    destinations: { mode: 'only', list: [owner, ...venues].map(nearDestination) },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0,
    native: {
      near: { sign_message: [], transfer: false, call: venues },
      evm: { sign_typed_data: [], sign_message: false, sign_transaction: false },
      solana: { sign_message: false, sign_transaction: false },
    },
  };
}

function powers(policy: unknown) {
  const set = (v: unknown) => (Array.isArray(v) ? v.map(canonical).sort() : v);
  if (!object(policy) || !object(policy.destinations) || !object(policy.native) || !object(policy.native.near)) {
    return null;
  }
  const { native, destinations } = policy, near = native.near as Record<string, unknown>;
  return canonical({ ...policy, actions: set(policy.actions), assets: set(policy.assets),
    destinations: { ...destinations, list: set(destinations.list) },
    native: { ...native, near: { ...near, call: set(near.call), sign_message: set(near.sign_message) } } });
}
export const grantsNoMore = (shown: unknown, asked: Policy) =>
  powers(shown) !== null && powers(shown) === powers(asked);

const messageFits = (payload: Record<string, unknown>, recipient: string) => payload.recipient === recipient
  && Object.keys(payload).every(key => ['message', 'recipient', 'nonce'].includes(key))
  && typeof payload.message === 'string' && typeof payload.nonce === 'string'
  && /^[A-Za-z0-9+/]{43}=$/.test(payload.nonce);

export function fitsOwnerFlow(signing: OwnerSigning, generated: OwnerIntent, type: IntentType, agentId?: string) {
  const { standard, payload } = generated.intent;
  if (generated.type !== type || (agentId !== undefined && generated.agent_id !== agentId)) return false;
  if (generated.signer.type === 'evm') {
    if (signing.network !== 'mainnet' || !isEvmOwner(generated.signer) || standard !== 'eip712') return false;
    return ['grant_issue', 'grant_revoke'].includes(type) ? evmConsent(payload, signing.messageRecipient) !== null
      : evmPolicyRequest(generated, signing.walletContract, generated.policy_approval) !== null;
  }
  return generated.signer.type === 'near'
    && (standard === 'nep366' ? nearPolicyRequest(generated, signing.walletContract, generated.policy_approval)
      : standard === 'nep413' && ['grant_issue', 'grant_revoke'].includes(type)
        && messageFits(payload, signing.messageRecipient));
}
