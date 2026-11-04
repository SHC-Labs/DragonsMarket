import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { GenerateIntentRequest, IntentType, Policy } from '@near-intents-agent-api/sdk';
import { canonical, object } from './ingestion/block.js';
import { isAccount as account } from './validate.js';
import { agentCashOut, type Config } from './config.js';
import { transaction } from './database.js';
import { LOCK } from './locks.js';
import { ReadError } from './read-api.js';
import { AgentApiUnavailable, type AgentApiClient, type AgentStatus, type OwnerIntent } from './agent-api.js';
import {
  InvalidAction, parseAgentAction, runAgentAction, type ActionKind, type AgentAction, type AgentRunner,
} from './agents.js';
import { openGrant, sealNewGrant } from './agent-grants.js';

type Deployment = NonNullable<Config['deployment']>;
type Queryable = Pick<pg.Pool, 'query'>;
export interface Owner { account: string; publicKey: string }
export interface OwnerSigning { walletContract: string; messageRecipient: string }
export interface AgentAccounts {
  db: pg.Pool;
  deployment: Deployment;
  api: Pick<AgentApiClient, 'generateIntent' | 'submitIntent' | 'status' | 'wallet'>;
  runner: AgentRunner;
  chain: { nearBalance(account: string): Promise<string> };
  grantKey: Buffer;
  signing: OwnerSigning;
}

const NEAR = 10n ** 24n;
const WRAPPED_NEAR = 'nep141:wrap.near';
const LIMITS = { openAgents: 3, agentsPerDay: 10, pendingGrantsPerDay: 5 };
const GRANT = { label: 'Dragons Market', lifetimeMs: 90 * 24 * 3600 * 1000 };
const AGENT_NAME = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;
const ACTION_KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
const GRANT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const OWNER_KINDS: readonly ActionKind[] = ['stake', 'claim', 'withdraw', 'cash_out'];
const WHILE_FROZEN = new Set<ActionKind>(['claim', 'withdraw', 'cash_out']);

const nearDestination = (address: string) => ({ action: 'withdraw' as const, chain: 'near', address, memo: null });

export function dragonsPolicy(d: Deployment, owner: string): Policy {
  const rounds = d.contracts.rounds ? [d.contracts.rounds] : [];
  const cashOut = agentCashOut(d);
  return {
    frozen: false, actions: ['withdraw'], confidential: false, owner_approval: false,
    assets: [...new Set([d.collateralTokenId, WRAPPED_NEAR])],
    limits: {
      per_transaction: { [d.collateralTokenId]: cashOut.perTransaction, [WRAPPED_NEAR]: String(NEAR / 10n) },
      daily: { [d.collateralTokenId]: cashOut.daily, [WRAPPED_NEAR]: String(NEAR / 2n) },
    },
    max_actions_per_hour: 60,
    destinations: { mode: 'only', list: [owner, ...rounds].map(nearDestination) },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0,
    native: {
      near: { sign_message: [], transfer: false, call: rounds },
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

function refused(what: string): never {
  console.error(`Refused ${what} from the Agent API that Dragons Market did not ask for`);
  throw new AgentApiUnavailable('unexpected_intent');
}

function signable(s: AgentAccounts, generated: OwnerIntent, type: IntentType, agentId?: string) {
  return fitsOwnerFlow(s.signing, generated, type, agentId) ? generated : refused('an owner request');
}

async function reserved<T>(s: AgentAccounts, release: string, id: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    await s.db.query(release, [id]).catch(() => {});
    throw error;
  }
}

const recordIntent = (q: Queryable, agentAccount: string, i: OwnerIntent, agentGrant: string | null) =>
  q.query(`INSERT INTO agent_intents(correlation_id,agent_account,type,agent_grant,intent,status,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
  [i.correlation_id, agentAccount, i.type, agentGrant, JSON.stringify(i), i.status, i.expires_at]);

const STILL_SIGNABLE = `EXISTS (SELECT 1 FROM agent_intents i
  WHERE i.agent_account=a.id AND (i.expires_at>now() OR i.status<>'PENDING_SIGNATURE'))`;

const abandonStale = (q: Queryable, d: Deployment, owner: Owner) =>
  q.query(`UPDATE agent_accounts a SET state='abandoned',updated_at=now()
    WHERE a.deployment_id=$1 AND a.owner_account_id=$2
    AND ((a.state='creating' AND a.created_at<now()-interval '5 minutes')
      OR (a.state='pending' AND NOT ${STILL_SIGNABLE}))`, [d.id, owner.account]);

function reserveAgent(s: AgentAccounts, owner: Owner, name: string) {
  const id = randomUUID(), d = s.deployment;
  return transaction(s.db, async c => {
    await c.query(`SELECT pg_advisory_xact_lock(${LOCK.agents},hashtext($1))`, [`agents:${d.id}:${owner.account}`]);
    await abandonStale(c, d, owner);
    const { rows: [taken] } = await c.query(`SELECT count(*) FILTER (WHERE state<>'abandoned')::int AS open,
      count(*) FILTER (WHERE created_at>now()-interval '1 day')::int AS today
      FROM agent_accounts WHERE deployment_id=$1 AND owner_account_id=$2`, [d.id, owner.account]);
    if (taken.open >= LIMITS.openAgents) throw new ReadError(409, 'agent_limit_reached');
    if (taken.today >= LIMITS.agentsPerDay) throw new ReadError(429, 'agent_daily_limit_reached');
    await c.query('INSERT INTO agent_accounts(id,deployment_id,owner_account_id,name) VALUES($1,$2,$3,$4)',
      [id, d.id, owner.account, name]);
    return id;
  });
}

export async function createAgent(s: AgentAccounts, owner: Owner, name: unknown) {
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) throw new ReadError(400, 'invalid_agent_name');
  const id = await reserveAgent(s, owner, name);
  const policy = dragonsPolicy(s.deployment, owner.account);
  const release = "UPDATE agent_accounts SET state='abandoned',updated_at=now() WHERE id=$1 AND state='creating'";
  return reserved(s, release, id, async () => {
    const generated = signable(s, await s.api.generateIntent({ type: 'agent_create', name,
      external_user_id: owner.account, owner: { type: 'near', account_id: owner.account, public_key: owner.publicKey },
      policy }, owner.account, `dm-agent-${id}`), 'agent_create');
    if (!grantsNoMore(generated.preview.policy, policy)) refused('a policy');
    await transaction(s.db, async c => {
      const opened = await c.query(`UPDATE agent_accounts SET agent_id=$2,state='pending',updated_at=now()
        WHERE id=$1 AND state='creating'`, [id, generated.agent_id]);
      if (opened.rowCount !== 1) throw new Error('agent_reservation_lost');
      await recordIntent(c, id, generated, null);
    });
    return generated;
  });
}

export interface AgentRow {
  id: string; agent_id: string; state: string; frozen: boolean; near_account_id: string | null;
}
type OwnerAccount = Pick<Owner, 'account'>;

export async function ownedAgent(s: AgentAccounts, owner: OwnerAccount, agentId: string): Promise<AgentRow> {
  const { rows } = await s.db.query(`SELECT id,agent_id,state,frozen,near_account_id FROM agent_accounts
    WHERE agent_id=$1 AND deployment_id=$2 AND owner_account_id=$3`, [agentId, s.deployment.id, owner.account]);
  if (!rows[0]) throw new ReadError(404, 'agent_not_found');
  return rows[0];
}

export async function activeAgent(s: AgentAccounts, owner: OwnerAccount, agentId: string) {
  const agent = await ownedAgent(s, owner, agentId);
  if (agent.state !== 'active' || !agent.near_account_id) throw new ReadError(409, 'agent_not_active');
  return { ...agent, near_account_id: agent.near_account_id };
}

async function usableGrant(q: Queryable, key: Buffer, agent: Pick<AgentRow, 'id' | 'agent_id'>) {
  const { rows } = await q.query(`SELECT commitment,sealed_token,expires_at FROM agent_grants
    WHERE agent_account=$1 AND state='live' AND expires_at>now() ORDER BY expires_at DESC`, [agent.id]);
  for (const grant of rows) {
    const token = openGrant(key, agent.agent_id, grant.commitment, grant.sealed_token);
    if (token) return { token, expiresAt: grant.expires_at as Date };
  }
  return null;
}

export const authorizedUntil = (s: AgentAccounts, agent: Pick<AgentRow, 'id' | 'agent_id'>) =>
  usableGrant(s.db, s.grantKey, agent).then(grant => grant?.expiresAt ?? null);

function ownerRequest(s: AgentAccounts, owner: Owner, agent: AgentRow, request: GenerateIntentRequest,
  agentGrant: string | null) {
  return s.api.generateIntent(request, owner.account, `dm-${request.type}-${randomUUID()}`).then(async generated => {
    signable(s, generated, request.type, agent.agent_id);
    await recordIntent(s.db, agent.id, generated, agentGrant);
    return generated;
  });
}

export async function issueGrant(s: AgentAccounts, owner: Owner, agentId: string) {
  const agent = await activeAgent(s, owner, agentId);
  const { commitment, sealed } = sealNewGrant(s.grantKey, agentId);
  const id = randomUUID(), expiresAt = new Date(Date.now() + GRANT.lifetimeMs).toISOString();
  await transaction(s.db, async c => {
    await c.query(`SELECT pg_advisory_xact_lock(${LOCK.agents},hashtext($1))`, [`grants:${agent.id}`]);
    if (await usableGrant(c, s.grantKey, agent)) throw new ReadError(409, 'grant_already_live');
    const { rows: [pending] } = await c.query(`SELECT count(*)::int AS n FROM agent_grants
      WHERE agent_account=$1 AND state='pending' AND created_at>now()-interval '1 day'`, [agent.id]);
    if (pending.n >= LIMITS.pendingGrantsPerDay) throw new ReadError(429, 'grant_daily_limit_reached');
    await c.query(`INSERT INTO agent_grants(id,agent_account,commitment,sealed_token,label,expires_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [id, agent.id, commitment, sealed, GRANT.label, expiresAt]);
  });
  return reserved(s, "UPDATE agent_grants SET state='failed' WHERE id=$1 AND state='pending'", id, () =>
    ownerRequest(s, owner, agent, { type: 'grant_issue', agent_id: agentId, label: GRANT.label, credential: commitment,
      expires_at: expiresAt }, id));
}

export async function revokeGrants(s: AgentAccounts, owner: Owner, agentId: string) {
  const agent = await ownedAgent(s, owner, agentId);
  const live = await transaction(s.db, async c => {
    await c.query(`SELECT pg_advisory_xact_lock(${LOCK.agents},hashtext($1))`, [`grants:${agent.id}`]);
    await c.query(`UPDATE agent_grants SET state='revoked',sealed_token=NULL
      WHERE agent_account=$1 AND state<>'revoked'`, [agent.id]);
    await c.query(`UPDATE agent_access_tokens SET revoked_at=now()
      WHERE agent_account=$1 AND revoked_at IS NULL`, [agent.id]);
    const { rows } = await c.query(`SELECT g.id,g.api_grant_id FROM agent_grants g
      WHERE g.agent_account=$1 AND g.api_grant_id IS NOT NULL AND g.expires_at>now()
      AND NOT EXISTS (SELECT 1 FROM agent_intents i WHERE i.agent_grant=g.id AND i.type='grant_revoke'
        AND (i.status NOT IN ('PENDING_SIGNATURE','FAILED','REFUNDED') OR i.expires_at>now()))
      ORDER BY g.created_at`, [agent.id]);
    return rows as { id: string; api_grant_id: string }[];
  });
  const data: OwnerIntent[] = [];
  for (const grant of live) {
    data.push(await ownerRequest(s, owner, agent, { type: 'grant_revoke', agent_id: agentId,
      grant_id: grant.api_grant_id }, grant.id));
  }
  return { data };
}

export async function freezeAgent(s: AgentAccounts, owner: Owner, agentId: string, frozen: boolean) {
  const agent = await activeAgent(s, owner, agentId);
  if (agent.frozen === frozen) throw new ReadError(409, frozen ? 'agent_frozen' : 'agent_not_frozen');
  return ownerRequest(s, owner, agent, { type: frozen ? 'agent_freeze' : 'agent_unfreeze', agent_id: agentId }, null);
}

type OwnerIntentType = 'agent_create' | 'grant_issue' | 'grant_revoke' | 'agent_freeze' | 'agent_unfreeze';
interface IntentRow {
  correlation_id: string; agent_account: string; agent_id: string; type: OwnerIntentType;
  agent_grant: string | null; commitment: string | null; intent: OwnerIntent; recorded: string;
}

async function ownedIntent(s: AgentAccounts, owner: Owner, correlationId: string): Promise<IntentRow> {
  const { rows } = await s.db.query(`SELECT i.correlation_id,i.agent_account,a.agent_id,i.type,i.agent_grant,
    g.commitment,i.intent,i.status AS recorded FROM agent_intents i JOIN agent_accounts a ON a.id=i.agent_account
    LEFT JOIN agent_grants g ON g.id=i.agent_grant
    WHERE i.correlation_id=$1 AND a.owner_account_id=$2 AND a.deployment_id=$3`,
  [correlationId, owner.account, s.deployment.id]);
  if (!rows[0]) throw new ReadError(404, 'intent_not_found');
  return rows[0];
}

type Change = [string, unknown[]] | null;

function grantLive(row: IntentRow, status: AgentStatus): Change {
  const grant = object(status.details.grant) ? status.details.grant : null;
  const ours = grant && typeof grant.grant_id === 'string' && GRANT_ID.test(grant.grant_id)
    && grant.agent_id === row.agent_id && grant.revoked_at === null && object(grant.owner_message)
    && grant.owner_message.credential === row.commitment;
  if (ours) {
    return ["UPDATE agent_grants SET state='live',api_grant_id=$2 WHERE id=$1 AND state='pending'",
      [row.agent_grant, grant.grant_id]];
  }
  console.error('Refused a grant the Agent API reports that is not the one Dragons Market issued');
  return ["UPDATE agent_grants SET state='failed' WHERE id=$1 AND state='pending'", [row.agent_grant]];
}

async function consequence(s: AgentAccounts, row: IntentRow, status: AgentStatus): Promise<Change> {
  const succeeded = status.status === 'SUCCESS', failed = status.status === 'FAILED' || status.status === 'REFUNDED';
  const agentRow = (set: string) => [`UPDATE agent_accounts SET ${set},updated_at=now() WHERE id=$1`,
    [row.agent_account]] as [string, unknown[]];
  switch (row.type) {
    case 'agent_create': {
      if (failed) {
        return ["UPDATE agent_accounts SET state='abandoned',updated_at=now() WHERE id=$1 AND state='pending'",
          [row.agent_account]];
      }
      if (!succeeded) return null;
      const near = (await s.api.wallet(row.agent_id)).near_account_id;
      return [`UPDATE agent_accounts SET state='active',near_account_id=$2,updated_at=now()
        WHERE id=$1 AND state='pending'`, [row.agent_account, near]];
    }
    case 'grant_issue':
      if (failed) return ["UPDATE agent_grants SET state='failed' WHERE id=$1 AND state='pending'", [row.agent_grant]];
      return succeeded ? grantLive(row, status) : null;
    case 'agent_freeze':
      if (failed) return agentRow('frozen=false');
      return status.status === 'PENDING_SIGNATURE' ? null : agentRow('frozen=true');
    case 'agent_unfreeze':
      return succeeded ? agentRow('frozen=false') : null;
    case 'grant_revoke':
      return null;
  }
}

async function applyIntentStatus(s: AgentAccounts, row: IntentRow, status: AgentStatus) {
  if (status.status !== row.recorded) {
    const change = await consequence(s, row, status);
    await transaction(s.db, async c => {
      await c.query('UPDATE agent_intents SET status=$2,updated_at=now() WHERE correlation_id=$1',
        [row.correlation_id, status.status]);
      if (change) await c.query(...change);
    });
  }
  return { correlation_id: row.correlation_id, type: row.type, agent_id: row.agent_id, status: status.status,
    failure_code: status.failure_code };
}

const expected = (row: IntentRow) => ({ type: row.type, agentId: row.agent_id });

export async function submitOwnerIntent(s: AgentAccounts, owner: Owner, correlationId: string, signed: unknown) {
  const row = await ownedIntent(s, owner, correlationId);
  if (!object(signed) || signed.standard !== row.intent.intent.standard) {
    throw new ReadError(400, 'invalid_signed_data');
  }
  return applyIntentStatus(s, row, await s.api.submitIntent(row.intent, signed));
}

export async function ownerIntentStatus(s: AgentAccounts, owner: Owner, correlationId: string) {
  const row = await ownedIntent(s, owner, correlationId);
  return applyIntentStatus(s, row, await s.api.status(row.correlation_id, 0, expected(row)));
}

export async function listAgents(s: AgentAccounts, owner: Owner) {
  const { rows } = await s.db.query(`SELECT a.id,a.agent_id,a.name,a.state,a.frozen,a.near_account_id,a.created_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('status',i.status,'generated',i.intent) ORDER BY i.created_at)
      FROM agent_intents i WHERE i.agent_account=a.id AND i.status NOT IN ('SUCCESS','FAILED','REFUNDED')
      AND NOT (i.status='PENDING_SIGNATURE' AND i.expires_at<=now())
      AND i.created_at>now()-interval '1 day'),'[]'::jsonb) AS open_intents
    FROM agent_accounts a WHERE a.deployment_id=$1 AND a.owner_account_id=$2
    AND (a.state='active' OR (a.state='pending' AND ${STILL_SIGNABLE}))
    ORDER BY a.created_at DESC LIMIT 10`, [s.deployment.id, owner.account]);
  const data = await Promise.all(rows.map(async ({ id, ...agent }) => {
    const until = agent.state === 'active' ? await authorizedUntil(s, { id, agent_id: agent.agent_id }) : null;
    return { ...agent, authorized_until: until };
  }));
  return { data };
}

export interface OwnedRequest {
  key: unknown; action: unknown; via?: string; admit?: (action: AgentAction) => Promise<void>;
}

export async function runOwnedAction(s: AgentAccounts, owner: OwnerAccount, agentId: string, request: OwnedRequest) {
  const { key, via, admit } = request;
  if (typeof key !== 'string' || !ACTION_KEY.test(key)) throw new ReadError(400, 'invalid_key');
  const body = request.action;
  const action = parseAgentAction(object(body) ? { ...body, recipient: owner.account } : body, OWNER_KINDS);
  if ('contract' in action && action.contract !== 'rounds') throw new InvalidAction('invalid_contract');
  const agent = await activeAgent(s, owner, agentId);
  const grant = await usableGrant(s.db, s.grantKey, agent);
  if (!grant) throw new ReadError(409, 'grant_required');
  await admit?.(action);
  const holdNew = agent.frozen && !WHILE_FROZEN.has(action.kind);
  return runAgentAction(s.runner, { agentId, token: grant.token },
    { agent: agent.near_account_id, key, action, holdNew, ...(via ? { via } : {}) });
}

export async function agentOperations(s: AgentAccounts, owner: OwnerAccount, agentId: string) {
  const agent = await ownedAgent(s, owner, agentId);
  if (!agent.near_account_id) return { data: [] };
  const { rows } = await s.db.query(`SELECT id,kind,state,transaction_hash,evidence,request->'action' AS action,
    updated_at FROM user_operations WHERE deployment_id=$1 AND account_id=$2 ORDER BY updated_at DESC LIMIT 50`,
  [s.deployment.id, agent.near_account_id]);
  return { data: rows };
}
