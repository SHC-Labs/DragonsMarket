import type { IntentType, Policy } from '@near-intents-agent-api/sdk';
import { canonical, object } from './ingestion/block.js';
import { agentCashOut, type Config } from './config.js';
import type { OwnerIntent } from './agent-api.js';

type Deployment = NonNullable<Config['deployment']>;
export interface OwnerSigning { walletContract: string; messageRecipient: string }

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
  const { native: { near, evm, solana }, destinations } = policy;
  return canonical({ frozen: policy.frozen, actions: set(policy.actions), confidential: policy.confidential,
    owner_approval: policy.owner_approval, assets: set(policy.assets), limits: policy.limits,
    max_actions_per_hour: policy.max_actions_per_hour, destinations: [destinations.mode, set(destinations.list)],
    call: set(near.call), transfer: near.transfer, sign_message: set(near.sign_message), evm, solana });
}
export const grantsNoMore = (shown: unknown, asked: Policy) =>
  powers(shown) !== null && powers(shown) === powers(asked);

function delegateFits(payload: Record<string, unknown>, walletContract: string) {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const deposits = actions.map(a => (object(a) && a.type === 'FunctionCall' && object(a.params)
    && typeof a.params.deposit === 'string' && /^\d{1,39}$/.test(a.params.deposit) ? BigInt(a.params.deposit) : null));
  return payload.receiverId === walletContract && deposits.length > 0 && !deposits.includes(null)
    && deposits.reduce<bigint>((sum, d) => sum + d!, 0n) <= NEAR;
}

const messageFits = (payload: Record<string, unknown>, recipient: string) => payload.recipient === recipient
  && typeof payload.message === 'string' && typeof payload.nonce === 'string'
  && /^[A-Za-z0-9+/]{43}=$/.test(payload.nonce);

export function fitsOwnerFlow(signing: OwnerSigning, generated: OwnerIntent, type: IntentType, agentId?: string) {
  const { standard, payload } = generated.intent;
  return generated.type === type && (agentId === undefined || generated.agent_id === agentId)
    && (standard === 'nep366' ? delegateFits(payload, signing.walletContract)
      : standard === 'nep413' && messageFits(payload, signing.messageRecipient));
}
