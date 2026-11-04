import { object } from './ingestion/block.js';
import { isAccount as account, isUint, isUnits } from './validate.js';
import type { Config } from './config.js';
import type { Send } from './agent-api.js';

export type Venue = 'rounds' | 'market';
export type AgentAction =
  | { kind: 'stake'; series: number; round: string; side: 'up' | 'down'; amount: string; minShares: string }
  | { kind: 'claim'; series: number; round: string }
  | { kind: 'buy'; market: string; side: 'yes' | 'no'; amount: string; minShares: string }
  | { kind: 'sell'; market: string; side: 'yes' | 'no'; shares: string; minCollateral: string }
  | { kind: 'redeem'; market: string }
  | { kind: 'withdraw'; venue: Venue; amount: string }
  | { kind: 'cash_out'; amount: string; recipient: string }
  | { kind: 'leave'; venue: Venue };
export type ActionKind = AgentAction['kind'];

type Deployment = NonNullable<Config['deployment']>;
export interface EventProof {
  contract: string; standard: Venue; name: string; match: Record<string, unknown>;
  inFlight?: { started: string; failed: string };
}
export interface Plan { operation: 'trade' | 'claim' | 'withdraw'; send: Send; proof: EventProof | null }

export class InvalidAction extends Error {}
const refuse = (code: string): never => { throw new InvalidAction(code); };

const CALL_GAS = '50000000000000';

const units = (v: unknown, what: string, least = 1n) =>
  (isUnits(v) && BigInt(v) >= least ? v : refuse(`invalid_${what}`));
const round = (v: unknown) => (isUint(v) ? v : refuse('invalid_round'));
const market = (v: unknown) => (isUint(v) ? v : refuse('invalid_market'));
const series = (v: unknown) =>
  (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < 2 ** 32 ? v as number : refuse('invalid_series'));
const side = (v: unknown) => (v === 'up' || v === 'down' ? v : refuse('invalid_side'));
const answer = (v: unknown) => (v === 'yes' || v === 'no' ? v : refuse('invalid_side'));
const venue = (v: unknown) => (v === 'rounds' || v === 'market' ? v : refuse('invalid_venue'));
const nearAccount = (v: unknown, what: string) => (account(v) ? v : refuse(`invalid_${what}`));

type Parsers = { [K in ActionKind]: (i: Record<string, unknown>) => Extract<AgentAction, { kind: K }> };
const parsers: Parsers = {
  stake: i => ({ kind: 'stake', series: series(i.series), round: round(i.round), side: side(i.side),
    amount: units(i.amount, 'amount'), minShares: units(i.minShares, 'min_shares', 0n) }),
  claim: i => ({ kind: 'claim', series: series(i.series), round: round(i.round) }),
  buy: i => ({ kind: 'buy', market: market(i.market), side: answer(i.side), amount: units(i.amount, 'amount'),
    minShares: units(i.minShares, 'min_shares') }),
  sell: i => ({ kind: 'sell', market: market(i.market), side: answer(i.side), shares: units(i.shares, 'shares'),
    minCollateral: units(i.minCollateral, 'min_collateral') }),
  redeem: i => ({ kind: 'redeem', market: market(i.market) }),
  withdraw: i => ({ kind: 'withdraw', venue: venue(i.venue), amount: units(i.amount, 'amount') }),
  cash_out: i => ({ kind: 'cash_out', amount: units(i.amount, 'amount'),
    recipient: nearAccount(i.recipient, 'recipient') }),
  leave: i => ({ kind: 'leave', venue: venue(i.venue) }),
};
export const OWNER_KINDS = Object.keys(parsers) as ActionKind[];
export const ACCESS_KINDS: readonly ActionKind[] =
  ['stake', 'claim', 'buy', 'sell', 'redeem', 'withdraw', 'cash_out'];

export function parseAgentAction(input: unknown, kinds: readonly ActionKind[] = OWNER_KINDS): AgentAction {
  if (!object(input) || !kinds.includes(input.kind as ActionKind)) return refuse('invalid_action');
  return parsers[input.kind as ActionKind](input);
}

export const spendOf = (a: AgentAction) => (a.kind === 'stake' || a.kind === 'buy' ? BigInt(a.amount) : 0n);

const call = (receiver_id: string, method_name: string, args: Record<string, unknown>, deposit: string) =>
  ({ native: { receiver_id, method_name, args, gas: CALL_GAS, deposit } });

export function planAgentAction(d: Deployment, agent: string, a: AgentAction): Plan {
  if (a.kind === 'cash_out') {
    return { operation: 'withdraw', proof: null,
      send: { withdraw: { asset: d.collateralTokenId, amount: a.amount, chain: 'near', recipient: a.recipient } } };
  }
  const at = (where: Venue) => d.contracts[where] ?? refuse(`${where}_not_configured`);
  const proof = (standard: Venue, name: string, match: Record<string, unknown>) =>
    ({ contract: at(standard), standard, name, match });
  switch (a.kind) {
    case 'stake':
      return { operation: 'trade',
        send: call(at('rounds'), 'stake', { series_id: a.series, round: a.round, side: a.side, amount: a.amount,
          min_shares: a.minShares }, '1'),
        proof: proof('rounds', 'staked',
          { account: agent, series_id: a.series, round: a.round, side: a.side, amount: a.amount }) };
    case 'claim':
      return { operation: 'claim',
        send: call(at('rounds'), 'claim', { series_id: a.series, round: a.round, account_id: agent }, '0'),
        proof: proof('rounds', 'claimed', { account: agent, series_id: a.series, round: a.round }) };
    case 'buy':
      return { operation: 'trade',
        send: call(at('market'), 'buy',
          { market_id: a.market, side: a.side, amount: a.amount, min_shares: a.minShares }, '1'),
        proof: proof('market', 'buy', { account: agent, market_id: a.market, side: a.side, collateral: a.amount }) };
    case 'sell':
      return { operation: 'trade',
        send: call(at('market'), 'sell',
          { market_id: a.market, side: a.side, shares: a.shares, min_collateral: a.minCollateral }, '1'),
        proof: proof('market', 'sell', { account: agent, market_id: a.market, side: a.side, shares: a.shares }) };
    case 'redeem':
      return { operation: 'claim', send: call(at('market'), 'redeem', { market_id: a.market }, '0'),
        proof: proof('market', 'redeemed', { account: agent, market_id: a.market }) };
    case 'withdraw':
      return { operation: 'withdraw', send: call(at(a.venue), 'withdraw', { amount: a.amount }, '1'),
        proof: { ...proof(a.venue, 'withdraw_confirmed', { account: agent, amount: a.amount }),
          inFlight: { started: 'withdraw', failed: 'withdraw_failed' } } };
    case 'leave':
      return { operation: 'withdraw', send: call(at(a.venue), 'storage_unregister', {}, '1'),
        proof: proof(a.venue, 'unregistered', { account: agent }) };
  }
}
