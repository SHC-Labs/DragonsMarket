import { grantCommitment } from '@near-intents-agent-api/sdk';
import { canonical, object, parseJson } from './ingestion/block.js';
import { isAccount as account } from './validate.js';
import type { Config } from './config.js';
import { RpcError, type ReadRpcClient } from './providers.js';
import {
  expectedOf, finalRefusal, refusalCode, sentNothing, settled, type AgentApiError, type AgentGrant, type AgentStatus,
  type Expected, type GrantCalls, type NativeCall, type Send,
} from './agent-api.js';

export type AgentAction =
  | { kind: 'register_token' }
  | { kind: 'register'; contract: Role }
  | { kind: 'fund'; amount: string }
  | { kind: 'deposit'; amount: string }
  | { kind: 'stake'; series: number; round: string; side: 'up' | 'down'; amount: string; minShares: string }
  | { kind: 'buy'; market: string; side: 'yes' | 'no'; amount: string; minShares: string }
  | { kind: 'claim'; series: number; round: string }
  | { kind: 'redeem'; market: string }
  | { kind: 'withdraw'; contract: Role; amount: string }
  | { kind: 'cash_out'; amount: string; recipient: string };
export type ActionKind = AgentAction['kind'];
type Role = 'rounds' | 'market';

type Deployment = NonNullable<Config['deployment']>;
export type ContractView = (contract: string, method: string, args: Record<string, unknown>) => Promise<unknown>;
export interface ContractEvent { executor: string; standard: string; event: string; data: Record<string, unknown> }
export interface CallAction { method: string; args: unknown; deposit: string }
export interface FinalTransaction {
  signer: string; receiver: string; calls: (CallAction | null)[]; events: ContractEvent[];
}
interface EventProof {
  contract: string; standard: Role; name: string; match: Record<string, unknown>;
  inFlight?: { started: string; failed: string };
}
type Proof = { event: EventProof } | { registered: string };
export interface Plan { operation: 'fund' | 'trade' | 'claim' | 'withdraw'; send: Send; proof: Proof | null }

export interface Lease { token: string; state: string; evidence: unknown }
export interface Operations {
  prepare(agent: string, kind: Plan['operation'], key: string, request: unknown):
    Promise<{ id: string; state: string; evidence: unknown }>;
  lease(id: string, agent: string): Promise<Lease | null>;
  release(id: string, agent: string, token: string): Promise<void>;
  sent(id: string, agent: string): Promise<void>;
  transition(id: string, agent: string, from: string, to: string, transactionHash: string | null, evidence: unknown):
    Promise<void>;
}

export interface AgentRunner {
  deployment: Deployment;
  api: {
    forGrant(grant: AgentGrant): GrantCalls;
    status(correlationId: string, waitMs: number, expected: Expected): Promise<AgentStatus>;
  };
  view: ContractView;
  transaction: (transactionHash: string, sender: string) => Promise<FinalTransaction>;
  operations: Operations;
  waitMs: number;
}

export class InvalidAction extends Error {}
const refuse = (code: string): never => { throw new InvalidAction(code); };

const STORAGE_GAS = '30000000000000';
const TOKEN_CALL_GAS = '100000000000000';
const CALL_GAS = '50000000000000';
const MAX_STORAGE_DEPOSIT = 10n ** 23n;
const U128_MAX = 2n ** 128n - 1n;
const ROLES: readonly Role[] = ['rounds', 'market'];

const U128_DIGITS = /^(0|[1-9]\d{0,38})$/, U64_DIGITS = /^(0|[1-9]\d{0,19})$/;
const integer = (v: unknown, digits: RegExp, max: bigint) =>
  typeof v === 'string' && digits.test(v) && BigInt(v) <= max;
const units = (v: unknown, what: string, least = 1n) =>
  integer(v, U128_DIGITS, U128_MAX) && BigInt(v as string) >= least ? v as string : refuse(`invalid_${what}`);
const u64 = (v: unknown, what: string) =>
  (integer(v, U64_DIGITS, 2n ** 64n - 1n) ? v as string : refuse(`invalid_${what}`));
const u32 = (v: unknown, what: string) =>
  (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < 2 ** 32 ? v as number : refuse(`invalid_${what}`));
const oneOf = <T extends string>(v: unknown, options: readonly T[], what: string) =>
  (options.includes(v as T) ? v as T : refuse(`invalid_${what}`));
const nearAccount = (v: unknown, what: string) => (account(v) ? v as string : refuse(`invalid_${what}`));

type Parsers = { [K in ActionKind]: (i: Record<string, unknown>) => Extract<AgentAction, { kind: K }> };
const parsers: Parsers = {
  register_token: () => ({ kind: 'register_token' }),
  register: i => ({ kind: 'register', contract: oneOf(i.contract, ROLES, 'contract') }),
  fund: i => ({ kind: 'fund', amount: units(i.amount, 'amount') }),
  deposit: i => ({ kind: 'deposit', amount: units(i.amount, 'amount') }),
  stake: i => ({ kind: 'stake', series: u32(i.series, 'series'), round: u64(i.round, 'round'),
    side: oneOf(i.side, ['up', 'down'], 'side'), amount: units(i.amount, 'amount'),
    minShares: units(i.minShares, 'min_shares', 0n) }),
  buy: i => ({ kind: 'buy', market: u64(i.market, 'market'), side: oneOf(i.side, ['yes', 'no'], 'side'),
    amount: units(i.amount, 'amount'), minShares: units(i.minShares, 'min_shares') }),
  claim: i => ({ kind: 'claim', series: u32(i.series, 'series'), round: u64(i.round, 'round') }),
  redeem: i => ({ kind: 'redeem', market: u64(i.market, 'market') }),
  withdraw: i => ({ kind: 'withdraw', contract: oneOf(i.contract, ROLES, 'contract'),
    amount: units(i.amount, 'amount') }),
  cash_out: i => ({ kind: 'cash_out', amount: units(i.amount, 'amount'),
    recipient: nearAccount(i.recipient, 'recipient') }),
};
const ACTION_KINDS = Object.keys(parsers) as ActionKind[];

export function parseAgentAction(input: unknown, kinds: readonly ActionKind[] = ACTION_KINDS): AgentAction {
  if (!object(input) || !kinds.includes(input.kind as ActionKind)) return refuse('invalid_action');
  return parsers[input.kind as ActionKind](input);
}

function contract(d: Deployment, role: Role) {
  return d.contracts[role] ?? refuse(`${role}_not_configured`);
}
const tokenOf = (d: Deployment) => d.collateralTokenId.slice('nep141:'.length);
const call = (receiver_id: string, method_name: string, args: Record<string, unknown>, gas: string, deposit: string) =>
  ({ native: { receiver_id, method_name, args, gas, deposit } });
const event = (contract: string, standard: Role, name: string, match: Record<string, unknown>,
  inFlight?: EventProof['inFlight']) =>
  ({ event: { contract, standard, name, match, ...(inFlight ? { inFlight } : {}) } });

function storageDeposit(value: unknown, what: string) {
  if (!integer(value, U128_DIGITS, U128_MAX)) throw new Error(`invalid_${what}`);
  return BigInt(value as string) <= MAX_STORAGE_DEPOSIT ? value as string : refuse(`${what}_too_high`);
}

const byToken = (d: Deployment, receiver: string, amount: string, msg: string) =>
  call(tokenOf(d), 'ft_transfer_call', { receiver_id: receiver, amount, msg }, TOKEN_CALL_GAS, '1');

interface PlanContext { d: Deployment; agent: string; view: ContractView }
type Planners = { [K in ActionKind]: (c: PlanContext, a: Extract<AgentAction, { kind: K }>) => Plan | Promise<Plan> };

function registration(target: string, args: Record<string, unknown>, asked: unknown, what: string): Plan {
  return { operation: 'fund', proof: { registered: target },
    send: call(target, 'storage_deposit', args, STORAGE_GAS, storageDeposit(asked, what)) };
}

const planners: Planners = {
  register_token: ({ d, agent, view }) => view(tokenOf(d), 'storage_balance_bounds', {}).then(bounds =>
    registration(tokenOf(d), { account_id: agent, registration_only: true }, object(bounds) ? bounds.min : null,
      'storage_bounds')),
  register: ({ d, view }, a) => {
    const target = contract(d, a.contract);
    return view(target, 'config', {}).then(config =>
      registration(target, {}, object(config) ? config.storage_deposit : null, 'storage_deposit'));
  },
  fund: ({ d, agent }, a) => ({ operation: 'fund', proof: null,
    send: { withdraw: { asset: d.collateralTokenId, amount: a.amount, chain: 'near', recipient: agent } } }),
  deposit: ({ d, agent }, a) => ({ operation: 'fund',
    send: byToken(d, contract(d, 'rounds'), a.amount, 'deposit'),
    proof: event(contract(d, 'rounds'), 'rounds', 'deposit', { account: agent }) }),
  stake: ({ d, agent }, a) => ({ operation: 'trade',
    send: call(contract(d, 'rounds'), 'stake', { series_id: a.series, round: a.round, side: a.side, amount: a.amount,
      min_shares: a.minShares }, CALL_GAS, '1'),
    proof: event(contract(d, 'rounds'), 'rounds', 'staked',
      { account: agent, series_id: a.series, round: a.round, side: a.side, amount: a.amount }) }),
  buy: ({ d, agent }, a) => ({ operation: 'trade',
    send: byToken(d, contract(d, 'market'), a.amount, `buy:${a.market}:${a.side}:${a.minShares}`),
    proof: event(contract(d, 'market'), 'market', 'buy', { account: agent, market_id: a.market }) }),
  claim: ({ d, agent }, a) => ({ operation: 'claim',
    send: call(contract(d, 'rounds'), 'claim', { series_id: a.series, round: a.round, account_id: agent }, CALL_GAS,
      '0'),
    proof: event(contract(d, 'rounds'), 'rounds', 'claimed',
      { account: agent, series_id: a.series, round: a.round }) }),
  redeem: ({ d, agent }, a) => ({ operation: 'claim',
    send: call(contract(d, 'market'), 'redeem', { market_id: a.market }, CALL_GAS, '0'),
    proof: event(contract(d, 'market'), 'market', 'redeemed', { account: agent, market_id: a.market }) }),
  withdraw: ({ d, agent }, a) => ({ operation: 'withdraw',
    send: call(contract(d, a.contract), 'withdraw', { amount: a.amount }, CALL_GAS, '1'),
    proof: event(contract(d, a.contract), a.contract, 'withdraw_confirmed', { account: agent, amount: a.amount },
      { started: 'withdraw', failed: 'withdraw_failed' }) }),
  cash_out: ({ d }, a) => ({ operation: 'withdraw', proof: null,
    send: { withdraw: { asset: d.collateralTokenId, amount: a.amount, chain: 'near', recipient: a.recipient } } }),
};

export async function planAgentAction(d: Deployment, agent: string, action: AgentAction, view: ContractView) {
  const plan = planners[action.kind] as (c: PlanContext, a: AgentAction) => Plan | Promise<Plan>;
  return plan({ d, agent, view }, action);
}

function callAction(action: unknown): CallAction | null {
  const call = object(action) && object(action.FunctionCall) ? action.FunctionCall : null;
  if (!call || typeof call.method_name !== 'string' || typeof call.args !== 'string'
    || typeof call.deposit !== 'string') return null;
  try {
    return { method: call.method_name, deposit: call.deposit,
      args: parseJson(Buffer.from(call.args, 'base64').toString('utf8')) };
  } catch { return null; }
}

export async function finalTransaction(rpc: Pick<ReadRpcClient, 'call'>, transactionHash: string, sender: string):
  Promise<FinalTransaction> {
  const outcome = await rpc.call('EXPERIMENTAL_tx_status', { tx_hash: transactionHash, sender_account_id: sender,
    wait_until: 'FINAL' });
  const tx = object(outcome) && object(outcome.transaction) ? outcome.transaction : null;
  if (!tx || tx.hash !== transactionHash || typeof tx.signer_id !== 'string' || typeof tx.receiver_id !== 'string'
    || !Array.isArray(tx.actions) || !object(outcome) || !Array.isArray(outcome.receipts_outcome)) {
    throw new Error('invalid_transaction_outcome');
  }
  return { signer: tx.signer_id, receiver: tx.receiver_id, calls: tx.actions.map(callAction),
    events: receiptEvents(outcome.receipts_outcome) };
}

export function nearBalance(rpc: Pick<ReadRpcClient, 'call'>) {
  return (accountId: string) => rpc.call('query', { request_type: 'view_account', finality: 'final',
    account_id: accountId }).then(result => {
    if (!object(result) || !integer(result.amount, U128_DIGITS, U128_MAX)) throw new Error('invalid_account_view');
    return result.amount as string;
  }, (error: unknown) => {
    if (error instanceof RpcError && error.causeName === 'UNKNOWN_ACCOUNT') return '0';
    throw error;
  });
}

function receiptEvents(receipts: unknown[]) {
  const events: ContractEvent[] = [];
  for (const receipt of receipts) {
    const o = object(receipt) && object(receipt.outcome) ? receipt.outcome : null;
    if (!o || typeof o.executor_id !== 'string' || !Array.isArray(o.logs) || !object(o.status)) {
      throw new Error('invalid_receipt_outcome');
    }
    if (!Object.hasOwn(o.status, 'SuccessValue') && !Object.hasOwn(o.status, 'SuccessReceiptId')) continue;
    for (const log of o.logs) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
      let parsed: unknown;
      try { parsed = parseJson(log.slice('EVENT_JSON:'.length)); } catch { continue; }
      if (object(parsed) && typeof parsed.standard === 'string' && typeof parsed.event === 'string'
        && object(parsed.data)) {
        events.push({ executor: o.executor_id, standard: parsed.standard, event: parsed.event, data: parsed.data });
      }
    }
  }
  return events;
}

export function finalView(rpc: Pick<ReadRpcClient, 'call'>): ContractView {
  return async (contractId, method, args) => {
    const result = await rpc.call('query', { request_type: 'call_function', finality: 'final', account_id: contractId,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    if (!object(result) || !Array.isArray(result.result) || result.result.length > 1024 * 1024
      || result.result.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('invalid_view');
    return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(result.result)));
  };
}

interface Run { r: AgentRunner; calls: GrantCalls; agent: string; plan: Plan; id: string; expected: Expected }
type Result = { operation: string; state: string; evidence: unknown };
type Outcome = { to: string; txHash: string | null; evidence: Record<string, unknown> };

async function settle(r: AgentRunner, correlation: string, expected: Expected) {
  const deadline = Date.now() + r.waitMs;
  let status: AgentStatus;
  do status = await r.api.status(correlation, Math.min(25000, Math.max(0, deadline - Date.now())), expected);
  while (!settled(status.status) && Date.now() < deadline);
  return status;
}

function sentAs(tx: FinalTransaction, call: NativeCall, agent: string) {
  const [only] = tx.calls;
  return tx.signer === agent && tx.receiver === call.receiver_id && tx.calls.length === 1 && !!only
    && only.method === call.method_name && only.deposit === call.deposit
    && canonical(only.args) === canonical(call.args);
}

function eventOutcome(proof: EventProof, events: ContractEvent[], txHash: string, evidence: Record<string, unknown>):
  Outcome {
  const { contract: target, standard, name, match, inFlight } = proof;
  const logged = (event: string) => events.find(e => e.executor === target && e.standard === standard
    && e.event === event && Object.entries(match).every(([k, v]) => e.data[k] === v));
  const found = logged(name);
  if (found) return { to: 'confirmed', txHash, evidence: { ...evidence, event: { name, data: found.data } } };
  if (inFlight && logged(inFlight.started) && !logged(inFlight.failed)) {
    return { to: 'reconcile', txHash, evidence: { ...evidence, reason: 'callback_not_seen' } };
  }
  const seen = events.filter(e => e.executor === target).map(e => e.event);
  return { to: 'failed', txHash, evidence: { ...evidence, reason: 'contract_did_not_take_it', events: seen } };
}

async function proven(r: AgentRunner, agent: string, plan: Plan, status: AgentStatus): Promise<Outcome> {
  const txHash = typeof status.details.tx_hash === 'string' ? status.details.tx_hash : null;
  const evidence = { correlation_id: status.correlation_id, status: status.status, tx_hash: txHash };
  const { proof, send } = plan;
  if (!proof) return { to: 'confirmed', txHash, evidence: { ...evidence, details: status.details } };
  if (!txHash) return { to: 'reconcile', txHash, evidence: { ...evidence, reason: 'no_transaction_hash' } };
  const tx = await r.transaction(txHash, agent);
  if (!('native' in send) || !sentAs(tx, send.native, agent)) {
    return { to: 'reconcile', txHash: null, evidence: { ...evidence, reason: 'transaction_not_this_call' } };
  }
  if ('event' in proof) return eventOutcome(proof.event, tx.events, txHash, evidence);
  const held = await r.view(proof.registered, 'storage_balance_of', { account_id: agent });
  return held === null ? { to: 'failed', txHash, evidence: { ...evidence, reason: 'not_registered' } }
    : { to: 'confirmed', txHash, evidence: { ...evidence, storage_balance: held } };
}

function settledOutcome(r: AgentRunner, agent: string, plan: Plan, status: AgentStatus): Promise<Outcome> {
  const evidence = { correlation_id: status.correlation_id, status: status.status, failure_code: status.failure_code };
  const { never_executed: neverExecuted, never_submitted: neverSubmitted, tx_hash: txHash } = status.details;
  if (status.status === 'SUCCESS') return proven(r, agent, plan, status);
  if (status.status === 'NEEDS_REVIEW') {
    return Promise.resolve({ to: 'reconcile', txHash: null, evidence: { ...evidence, reason: 'needs_review' } });
  }
  if (neverExecuted === true || neverSubmitted === true) {
    return Promise.resolve({ to: 'failed', txHash: null, evidence: { ...evidence, reason: 'never_executed' } });
  }
  if (plan.proof && typeof txHash === 'string') return proven(r, agent, plan, status);
  return Promise.resolve({ to: 'reconcile', txHash: null, evidence: { ...evidence, reason: 'failure_unproven' } });
}

async function record(run: Run, from: string, outcome: Outcome): Promise<Result> {
  const { r, agent, id } = run;
  try {
    await r.operations.transition(id, agent, from, outcome.to, outcome.txHash, outcome.evidence);
    return { operation: id, state: outcome.to, evidence: outcome.evidence };
  } catch (error) {
    if (!(error instanceof Error && error.message === 'transaction_already_claimed')) throw error;
    const evidence = { ...outcome.evidence, reason: 'transaction_already_claimed' };
    await r.operations.transition(id, agent, from, 'reconcile', null, evidence);
    return { operation: id, state: 'reconcile', evidence };
  }
}

async function submit(run: Run, sentBefore: boolean): Promise<Result | string> {
  const { r, calls, agent, plan, id, expected } = run;
  if (!sentBefore) await r.operations.sent(id, agent);
  try {
    const sent = await calls.send(`dm-${id}`, plan.send, expected);
    await r.operations.transition(id, agent, 'prepared', 'submitted', null, { correlation_id: sent.correlation_id });
    return sent.correlation_id;
  } catch (error) {
    const to = sentNothing(error) ? (sentBefore ? 'reconcile' : 'failed') : finalRefusal(error) ? 'reconcile' : null;
    if (!to) throw error;
    const reason = to === 'failed' ? 'refused_before_sending' : sentBefore ? 'resend_refused' : 'refusal_unproven';
    const evidence = { reason, code: refusalCode(error as AgentApiError) };
    await r.operations.transition(id, agent, 'prepared', to, null, evidence);
    return { operation: id, state: to, evidence };
  }
}

async function finish(run: Run, from: string, correlation: string): Promise<Result> {
  const { r, agent, plan, id, expected } = run;
  const status = await settle(r, correlation, expected);
  if (!settled(status.status)) {
    const evidence = { correlation_id: correlation, status: status.status, failure_code: status.failure_code };
    if (from === 'unknown') return { operation: id, state: from, evidence };
    await r.operations.transition(id, agent, from, 'unknown', null, evidence);
    return { operation: id, state: 'unknown', evidence };
  }
  return record(run, from, await settledOutcome(r, agent, plan, status));
}

async function advance(run: Run, op: Lease, holdNew: boolean): Promise<Result> {
  if (op.state === 'prepared') {
    const sentBefore = object(op.evidence) && op.evidence.sent === true;
    if (holdNew && !sentBefore) {
      const evidence = { reason: 'agent_frozen' };
      await run.r.operations.transition(run.id, run.agent, 'prepared', 'failed', null, evidence);
      return { operation: run.id, state: 'failed', evidence };
    }
    const sent = await submit(run, sentBefore);
    return typeof sent === 'string' ? finish(run, 'submitted', sent) : sent;
  }
  const correlation = object(op.evidence) ? op.evidence.correlation_id : null;
  if (!['submitted', 'unknown'].includes(op.state) || typeof correlation !== 'string') {
    return Promise.resolve({ operation: run.id, state: op.state, evidence: op.evidence });
  }
  return finish(run, op.state, correlation);
}

const UNSETTLED = ['prepared', 'submitted', 'unknown'];

export interface ActionRun { agent: string; key: string; action: AgentAction; holdNew?: boolean; via?: string }

export async function runAgentAction(r: AgentRunner, grant: AgentGrant, job: ActionRun): Promise<Result> {
  const { agent, key, action } = job;
  if (!account(agent)) throw new Error('invalid_agent_account');
  const calls = r.api.forGrant(grant);
  const plan = await planAgentAction(r.deployment, agent, action, r.view);
  const request = { agent_id: grant.agentId, grant: grantCommitment(grant.token), action, send: plan.send,
    ...(job.via ? { via: job.via } : {}) };
  const op = await r.operations.prepare(agent, plan.operation, key, request);
  if (!UNSETTLED.includes(op.state)) return { operation: op.id, state: op.state, evidence: op.evidence };
  const held = await r.operations.lease(op.id, agent);
  if (!held) throw new Error('operation_state_conflict');
  try {
    return await advance({ r, calls, agent, plan, id: op.id, expected: expectedOf(plan.send, grant.agentId, agent) },
      held, job.holdNew === true);
  } finally {
    await r.operations.release(op.id, agent, held.token).catch(() => {});
  }
}
