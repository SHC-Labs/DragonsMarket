import { grantCommitment } from '@near-intents-agent-api/sdk';
import { canonical, object } from './ingestion/block.js';
import { isAccount as account } from './validate.js';
import type { Config } from './config.js';
import {
  parseAgentAction, planAgentAction, type AgentAction, type EventProof, type Plan,
} from './agent-actions.js';
import type { FinalTransaction } from './agent-chain.js';
import {
  expectedOf, finalRefusal, refusalCode, sentNothing, settled, type AgentApiError, type AgentGrant, type AgentStatus,
  type Expected, type GrantCalls, type NativeCall,
} from './agent-api.js';
import { OperationRefused, TransactionClaimed, type DailyCap } from './operations.js';
import { AgentAuthorizationRefused, type AgentAuthorization } from './agent-authorization.js';

type Deployment = NonNullable<Config['deployment']>;

export interface OperationRef { id: string; agent: string }
export interface Lease { token: string; state: string; evidence: unknown; sent: boolean; correlation: string | null }
export interface Change { txHash: string | null; evidence: unknown; correlation?: string }
export interface Operations {
  seen(agent: string, key: string): Promise<boolean>;
  prepare(agent: string, kind: Plan['operation'], key: string, request: unknown, cap?: DailyCap):
    Promise<{ id: string; state: string; evidence: unknown }>;
  lease(op: OperationRef): Promise<Lease | null>;
  release(op: OperationRef, token: string): Promise<void>;
  sent(op: OperationRef): Promise<void>;
  transition(op: OperationRef, from: string, to: string, change: Change): Promise<void>;
}

export interface AgentRunner {
  deployment: Deployment;
  authorize(grant: AgentGrant, job: AgentAuthorization): Promise<void>;
  api: {
    forGrant(grant: AgentGrant): GrantCalls;
    status(correlationId: string, waitMs: number, expected: Expected, refresh?: boolean): Promise<AgentStatus>;
  };
  transaction: (transactionHash: string, sender: string) => Promise<FinalTransaction>;
  operations: Operations;
  waitMs: number;
}

interface Run { r: AgentRunner; op: OperationRef; plan: Plan; expected: Expected; authorization: AgentAuthorization }
type Result = { operation: string; state: string; evidence: unknown };
type Outcome = { to: string; txHash: string | null; evidence: Record<string, unknown> };

async function settle(r: AgentRunner, correlation: string, expected: Expected, refresh: boolean) {
  const deadline = Date.now() + r.waitMs;
  let status: AgentStatus;
  do status = await r.api.status(correlation, Math.min(25000, Math.max(0, deadline - Date.now())), expected, refresh);
  while (!settled(status.status) && Date.now() < deadline);
  return status;
}

function sentAs(tx: FinalTransaction, call: NativeCall, agent: string) {
  const [only] = tx.calls;
  return tx.signer === agent && tx.receiver === call.receiver_id && tx.calls.length === 1 && !!only
    && only.method === call.method_name && only.deposit === call.deposit
    && canonical(only.args) === canonical(call.args);
}

function eventOutcome(proof: EventProof, tx: FinalTransaction, txHash: string, evidence: Record<string, unknown>):
  Outcome {
  const { contract: target, standard, name, match, inFlight } = proof;
  const logged = (event: string) => tx.events.find(e => e.executor === target && e.standard === standard
    && e.event === event && Object.entries(match).every(([k, v]) => e.data[k] === v));
  const found = logged(name);
  if (found) return { to: 'confirmed', txHash, evidence: { ...evidence, event: { name, data: found.data } } };
  const reported = inFlight && logged(inFlight.failed);
  if (inFlight && logged(inFlight.started) && !reported) {
    return { to: 'reconcile', txHash, evidence: { ...evidence, reason: 'callback_not_seen' } };
  }
  const events = tx.events.filter(e => e.executor === target).map(e => e.event);
  if (!reported && !tx.failed.includes(target)) {
    return { to: 'reconcile', txHash, evidence: { ...evidence, reason: 'no_proof_either_way', events } };
  }
  return { to: 'failed', txHash, evidence: { ...evidence, reason: 'contract_did_not_take_it', events } };
}

async function proven({ r, op, plan }: Run, status: AgentStatus): Promise<Outcome> {
  const txHash = typeof status.details.tx_hash === 'string' ? status.details.tx_hash : null;
  const evidence = { correlation_id: status.correlation_id, status: status.status, tx_hash: txHash };
  const { proof, send } = plan;
  if (!proof) return { to: 'confirmed', txHash, evidence: { ...evidence, details: status.details } };
  if (!txHash) return { to: 'reconcile', txHash, evidence: { ...evidence, reason: 'no_transaction_hash' } };
  const tx = await r.transaction(txHash, op.agent);
  if (!('native' in send) || !sentAs(tx, send.native, op.agent)) {
    return { to: 'reconcile', txHash: null, evidence: { ...evidence, reason: 'transaction_not_this_call' } };
  }
  return eventOutcome(proof, tx, txHash, evidence);
}

function withoutProof(plan: Plan, status: AgentStatus): Outcome | null {
  const evidence = { correlation_id: status.correlation_id, status: status.status, failure_code: status.failure_code };
  const { never_executed: neverExecuted, never_submitted: neverSubmitted, tx_hash: txHash } = status.details;
  if (status.status === 'SUCCESS') return null;
  if (status.status === 'NEEDS_REVIEW') {
    return { to: 'reconcile', txHash: null, evidence: { ...evidence, reason: 'needs_review' } };
  }
  if (neverExecuted === true || neverSubmitted === true) {
    return { to: 'failed', txHash: null, evidence: { ...evidence, reason: 'never_executed' } };
  }
  if (plan.proof && typeof txHash === 'string') return null;
  return { to: 'reconcile', txHash: null, evidence: { ...evidence, reason: 'failure_unproven' } };
}

async function record({ r, op }: Run, from: string, outcome: Outcome): Promise<Result> {
  const { to, txHash, evidence } = outcome;
  if (to === from) return { operation: op.id, state: to, evidence };
  try {
    await r.operations.transition(op, from, to, { txHash, evidence });
    return { operation: op.id, state: to, evidence };
  } catch (error) {
    if (!(error instanceof TransactionClaimed)) throw error;
    const stopped = { ...evidence, reason: 'transaction_already_claimed' };
    await r.operations.transition(op, from, 'reconcile', { txHash: null, evidence: stopped });
    return { operation: op.id, state: 'reconcile', evidence: stopped };
  }
}

async function authorizationRefusal(run: Run, grant: AgentGrant, sentBefore: boolean): Promise<Result | null> {
  try {
    await run.r.authorize(grant, run.authorization);
    return null;
  } catch (error) {
    if (!(error instanceof AgentAuthorizationRefused)) throw error;
    return record(run, 'prepared', { to: sentBefore ? 'reconcile' : 'failed', txHash: null,
      evidence: { reason: 'authorization_refused', code: error.message } });
  }
}

async function submit(run: Run, grant: AgentGrant, sentBefore: boolean): Promise<Result | string> {
  const { r, op, plan, expected } = run;
  const refused = await authorizationRefusal(run, grant, sentBefore);
  if (refused) return refused;
  const calls = r.api.forGrant(grant);
  if (!sentBefore) await r.operations.sent(op);
  try {
    const sent = await calls.send(`dm-${op.id}`, plan.send, expected);
    await r.operations.transition(op, 'prepared', 'submitted',
      { txHash: null, evidence: null, correlation: sent.correlation_id });
    return sent.correlation_id;
  } catch (error) {
    const to = sentNothing(error) ? (sentBefore ? 'reconcile' : 'failed') : finalRefusal(error) ? 'reconcile' : null;
    if (!to) throw error;
    const reason = to === 'failed' ? 'refused_before_sending' : sentBefore ? 'resend_refused' : 'refusal_unproven';
    const evidence = { reason, code: refusalCode(error as AgentApiError) };
    await r.operations.transition(op, 'prepared', to, { txHash: null, evidence });
    return { operation: op.id, state: to, evidence };
  }
}

async function finish(run: Run, from: string, correlation: string): Promise<Result> {
  const { r, op, plan, expected } = run;
  const status = await settle(r, correlation, expected, from === 'reconcile');
  if (settled(status.status)) return record(run, from, withoutProof(plan, status) ?? await proven(run, status));
  const evidence = { correlation_id: correlation, status: status.status, failure_code: status.failure_code };
  if (from !== 'submitted') return { operation: op.id, state: from, evidence };
  await r.operations.transition(op, from, 'unknown', { txHash: null, evidence });
  return { operation: op.id, state: 'unknown', evidence };
}

const AWAITING_ANSWER = ['submitted', 'unknown'];

async function advance(run: Run, grant: AgentGrant, held: Lease): Promise<Result> {
  if (held.state === 'prepared') {
    const sent = await submit(run, grant, held.sent);
    return typeof sent === 'string' ? finish(run, 'submitted', sent) : sent;
  }
  if (AWAITING_ANSWER.includes(held.state) && held.correlation) return finish(run, held.state, held.correlation);
  return { operation: run.op.id, state: held.state, evidence: held.evidence };
}

export interface ActionRun {
  agent: string; key: string; action: AgentAction; via?: string; cap?: DailyCap; fence?: () => Promise<void>;
}

export async function runAgentAction(r: AgentRunner, grant: AgentGrant, job: ActionRun): Promise<Result> {
  const { agent, key, action, via, cap, fence } = job;
  if (!account(agent)) throw new Error('invalid_agent_account');
  const plan = planAgentAction(r.deployment, agent, action);
  if (fence && !(await r.operations.seen(agent, key))) await fence();
  const request = { agent_id: grant.agentId, grant: grantCommitment(grant.token), action, send: plan.send,
    ...(via ? { via } : {}) };
  const prepared = await r.operations.prepare(agent, plan.operation, key, request, cap);
  if (prepared.state !== 'prepared' && !AWAITING_ANSWER.includes(prepared.state)) {
    return { operation: prepared.id, state: prepared.state, evidence: prepared.evidence };
  }
  const op = { id: prepared.id, agent };
  const held = await r.operations.lease(op);
  if (!held) throw new OperationRefused('operation_state_conflict');
  try {
    return await advance({ r, op, plan, expected: expectedOf(plan.send, grant.agentId, agent),
      authorization: { agent, action, ...(via ? { via } : {}) } }, grant, held);
  } finally {
    await r.operations.release(op, held.token).catch(() => {});
  }
}

export interface Stranded { id: string; agent: string; request: unknown }
export type FindGrant = (agentId: string, commitment: string) => Promise<AgentGrant | null>;

function recorded(request: unknown) {
  if (!object(request) || typeof request.agent_id !== 'string' || typeof request.grant !== 'string') {
    throw new Error('invalid_operation_request');
  }
  if (request.via !== undefined && typeof request.via !== 'string') throw new Error('invalid_operation_request');
  return { agentId: request.agent_id, commitment: request.grant, action: parseAgentAction(request.action),
    send: request.send,
    ...(typeof request.via === 'string' ? { via: request.via } : {}) };
}

async function resume(run: Run, held: Lease, grant: () => ReturnType<FindGrant>) {
  const { r, op } = run;
  if (!held.sent) {
    return r.operations.transition(op, 'prepared', 'failed', { txHash: null, evidence: { reason: 'never_sent' } });
  }
  const found = await grant();
  if (found) return advance(run, found, held);
  return r.operations.transition(op, 'prepared', 'reconcile', { txHash: null, evidence: { reason: 'grant_gone' } });
}

export async function followOperation(r: AgentRunner, stranded: Stranded, findGrant: FindGrant) {
  const op = { id: stranded.id, agent: stranded.agent };
  const { agentId, commitment, action, via, send } = recorded(stranded.request);
  const plan = planAgentAction(r.deployment, op.agent, action);
  const held = await r.operations.lease(op);
  if (!held) return;
  const run = { r, op, plan, expected: expectedOf(plan.send, agentId, op.agent),
    authorization: { agent: op.agent, action, ...(via ? { via } : {}) } };
  try {
    if (canonical(plan.send) !== canonical(send)) {
      if (['prepared', ...AWAITING_ANSWER].includes(held.state)) {
        await r.operations.transition(op, held.state, 'reconcile',
          { txHash: null, evidence: { reason: 'operation_plan_changed' } });
      }
      return;
    }
    if (held.state === 'prepared') await resume(run, held, () => findGrant(agentId, commitment));
    else if ([...AWAITING_ANSWER, 'reconcile'].includes(held.state) && held.correlation) {
      await finish(run, held.state, held.correlation);
    }
  } finally {
    await r.operations.release(op, held.token).catch(() => {});
  }
}
