import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { GenerateIntentRequest, IntentType } from '@near-intents-agent-api/sdk';
import { canonical, object } from './ingestion/block.js';
import { agentSpend, type Config } from './config.js';
import type { CheckAccessKey } from './auth.js';
import type { View } from './chain-view.js';
import { transaction } from './database.js';
import { agentLock } from './locks.js';
import { ReadError } from './read-api.js';
import { isUnits } from './validate.js';
import {
  AgentApiUnavailable, type AgentApiClient, type AgentGrant, type AgentStatus, type OwnerIntent,
} from './agent-api.js';
import { parseAgentAction, spendOf, type ActionKind, type AgentAction } from './agent-actions.js';
import { dragonsPolicy, fitsOwnerFlow, grantsNoMore, type OwnerSigning } from './agent-policy.js';
import { runAgentAction, type AgentRunner } from './agents.js';
import { openGrant, sealNewGrant } from './agent-grants.js';
import type { Owner } from './agent-paths.js';

type Deployment = NonNullable<Config['deployment']>;
type Queryable = Pick<pg.Pool, 'query'>;
export interface AgentAccounts {
  db: pg.Pool;
  deployment: Deployment;
  api: Pick<AgentApiClient, 'generateIntent' | 'submitIntent' | 'status' | 'wallet' | 'frozen' | 'policy'>;
  runner: AgentRunner;
  chain: { view: View; nearBalance(account: string): Promise<string> };
  grantKey: Buffer;
  signing: OwnerSigning;
  checkKey: CheckAccessKey;
  webOrigin: string;
}

const LIMITS = { openAgents: 3, agentsPerDay: 10, pendingGrantsPerDay: 5 };
const GRANT = { label: 'Dragons Market', lifetimeMs: 90 * 24 * 3600 * 1000 };
const AGENT_NAME = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;
const ACTION_KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
const GRANT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

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

const MAY_STILL_LAND = `EXISTS (SELECT 1 FROM agent_intents i
  WHERE i.agent_account=a.id AND (i.expires_at>now()-interval '10 minutes' OR i.status<>'PENDING_SIGNATURE'))`;

const abandonStale = (q: Queryable, d: Deployment, owner: Owner) =>
  q.query(`UPDATE agent_accounts a SET state='abandoned',updated_at=now()
    WHERE a.deployment_id=$1 AND a.owner_account_id=$2
    AND ((a.state='creating' AND a.created_at<now()-interval '5 minutes')
      OR (a.state='pending' AND NOT ${MAY_STILL_LAND}))`, [d.id, owner.account]);

function reserveAgent(s: AgentAccounts, owner: Owner, name: string) {
  const id = randomUUID(), d = s.deployment;
  return transaction(s.db, async c => {
    await agentLock(c, `agents:${d.id}:${owner.account}`);
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

export function grantByCommitment(s: AgentAccounts, agentId: string, commitment: string): Promise<AgentGrant | null> {
  return s.db.query(`SELECT g.sealed_token FROM agent_grants g JOIN agent_accounts a ON a.id=g.agent_account
    WHERE a.agent_id=$1 AND a.deployment_id=$2 AND g.commitment=$3 AND g.state='live' AND g.expires_at>now()`,
  [agentId, s.deployment.id, commitment]).then(({ rows: [row] }) => {
    const token = row ? openGrant(s.grantKey, agentId, commitment, row.sealed_token) : null;
    return token ? { agentId, token } : null;
  });
}

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
    await agentLock(c, `grants:${agent.id}`);
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
    await agentLock(c, `grants:${agent.id}`);
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

const recordFrozen = (q: Queryable, agentAccount: string, frozen: boolean) =>
  q.query('UPDATE agent_accounts SET frozen=$2,updated_at=now() WHERE id=$1', [agentAccount, frozen]);

export async function freezeAgent(s: AgentAccounts, owner: Owner, agentId: string, frozen: boolean) {
  const agent = await activeAgent(s, owner, agentId);
  const actual = await s.api.frozen(agentId);
  if (actual !== agent.frozen) await recordFrozen(s.db, agent.id, actual);
  if (actual === frozen) throw new ReadError(409, frozen ? 'agent_frozen' : 'agent_not_frozen');
  return ownerRequest(s, owner, agent, { type: frozen ? 'agent_freeze' : 'agent_unfreeze', agent_id: agentId }, null);
}

type OwnerIntentType = 'agent_create' | 'grant_issue' | 'grant_revoke' | 'agent_freeze' | 'agent_unfreeze';
export interface IntentRow {
  correlation_id: string; agent_account: string; agent_id: string; type: OwnerIntentType;
  agent_grant: string | null; commitment: string | null; intent: OwnerIntent; recorded: string;
}

const INTENT_ROW = `SELECT i.correlation_id,i.agent_account,a.agent_id,i.type,i.agent_grant,g.commitment,i.intent,
  i.status AS recorded FROM agent_intents i JOIN agent_accounts a ON a.id=i.agent_account
  LEFT JOIN agent_grants g ON g.id=i.agent_grant`;

async function ownedIntent(s: AgentAccounts, owner: Owner, correlationId: string): Promise<IntentRow> {
  const { rows } = await s.db.query(`${INTENT_ROW} WHERE i.correlation_id=$1 AND a.owner_account_id=$2
    AND a.deployment_id=$3`, [correlationId, owner.account, s.deployment.id]);
  if (!rows[0]) throw new ReadError(404, 'intent_not_found');
  return rows[0];
}

const FAILED = new Set(['FAILED', 'REFUNDED']);
const failGrant = (q: Queryable, row: IntentRow) =>
  q.query("UPDATE agent_grants SET state='failed' WHERE id=$1 AND state='pending'", [row.agent_grant]);

function grantLive(q: Queryable, row: IntentRow, status: AgentStatus) {
  const grant = object(status.details.grant) ? status.details.grant : null;
  const ours = grant && typeof grant.grant_id === 'string' && GRANT_ID.test(grant.grant_id)
    && grant.agent_id === row.agent_id && grant.revoked_at === null && object(grant.owner_message)
    && grant.owner_message.credential === row.commitment;
  if (ours) {
    return q.query("UPDATE agent_grants SET state='live',api_grant_id=$2 WHERE id=$1 AND state='pending'",
      [row.agent_grant, grant.grant_id]);
  }
  console.error('Refused a grant the Agent API reports that is not the one Dragons Market issued');
  return failGrant(q, row);
}

type Effect = (q: Queryable, row: IntentRow, status: AgentStatus, near: string | null) => Promise<unknown> | null;
const EFFECTS: Record<OwnerIntentType, Effect> = {
  agent_create(q, row, status, near) {
    if (FAILED.has(status.status)) {
      return q.query(`UPDATE agent_accounts SET state='abandoned',updated_at=now()
        WHERE id=$1 AND state='pending'`, [row.agent_account]);
    }
    return near ? q.query(`UPDATE agent_accounts SET state='active',near_account_id=$2,updated_at=now()
      WHERE id=$1 AND state='pending'`, [row.agent_account, near]) : null;
  },
  grant_issue(q, row, status) {
    if (FAILED.has(status.status)) return failGrant(q, row);
    return status.status === 'SUCCESS' ? grantLive(q, row, status) : null;
  },
  agent_freeze(q, row, status) {
    if (FAILED.has(status.status)) return recordFrozen(q, row.agent_account, false);
    return status.status === 'PENDING_SIGNATURE' ? null : recordFrozen(q, row.agent_account, true);
  },
  agent_unfreeze: (q, row, status) => (status.status === 'SUCCESS' ? recordFrozen(q, row.agent_account, false) : null),
  grant_revoke: () => null,
};

async function applyIntentStatus(s: AgentAccounts, row: IntentRow, status: AgentStatus) {
  if (status.status !== row.recorded) {
    const created = row.type === 'agent_create' && status.status === 'SUCCESS';
    const near = created ? (await s.api.wallet(row.agent_id)).near_account_id : null;
    await transaction(s.db, async c => {
      await c.query('UPDATE agent_intents SET status=$2,updated_at=now() WHERE correlation_id=$1',
        [row.correlation_id, status.status]);
      await EFFECTS[row.type](c, row, status, near);
    });
  }
  return { correlation_id: row.correlation_id, type: row.type, agent_id: row.agent_id, status: status.status,
    failure_code: status.failure_code };
}

const expected = (row: IntentRow) => ({ type: row.type, agentId: row.agent_id });

export async function submitOwnerIntent(s: AgentAccounts, owner: Owner, correlationId: string, signed: unknown) {
  const row = await ownedIntent(s, owner, correlationId);
  const { standard, payload } = row.intent.intent;
  if (!object(signed) || signed.standard !== standard || !object(signed.payload)
    || canonical(signed.payload) !== canonical(payload)) {
    throw new ReadError(400, 'invalid_signed_data');
  }
  return applyIntentStatus(s, row, await s.api.submitIntent(row.intent, signed));
}

export const followOwnerIntent = (s: AgentAccounts, row: IntentRow) =>
  s.api.status(row.correlation_id, 0, expected(row)).then(status => applyIntentStatus(s, row, status));

export async function ownerIntentStatus(s: AgentAccounts, owner: Owner, correlationId: string) {
  return followOwnerIntent(s, await ownedIntent(s, owner, correlationId));
}

export async function strandedIntents(s: AgentAccounts): Promise<IntentRow[]> {
  const { rows: due } = await s.db.query(`UPDATE agent_intents SET followed_at=now() WHERE correlation_id IN (
    SELECT i.correlation_id FROM agent_intents i JOIN agent_accounts a ON a.id=i.agent_account
    WHERE a.deployment_id=$1 AND i.status NOT IN ('SUCCESS','FAILED','REFUNDED')
    AND (i.status<>'PENDING_SIGNATURE' OR i.expires_at>now()-interval '10 minutes')
    AND i.created_at>now()-interval '7 days' AND (i.followed_at IS NULL OR i.followed_at<now()-interval '1 minute')
    ORDER BY i.followed_at NULLS FIRST LIMIT 50 FOR UPDATE OF i SKIP LOCKED) RETURNING correlation_id`,
  [s.deployment.id]);
  const ids = due.map(row => row.correlation_id as string);
  return ids.length ? (await s.db.query(`${INTENT_ROW} WHERE i.correlation_id=ANY($1)`, [ids])).rows : [];
}

export async function listAgents(s: AgentAccounts, owner: Owner) {
  const { rows } = await s.db.query(`SELECT a.id,a.agent_id,a.name,a.state,a.frozen,a.near_account_id,a.created_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('status',i.status,'generated',i.intent) ORDER BY i.created_at)
      FROM agent_intents i WHERE i.agent_account=a.id AND i.status NOT IN ('SUCCESS','FAILED','REFUNDED')
      AND NOT (i.status='PENDING_SIGNATURE' AND i.expires_at<=now())),'[]'::jsonb) AS open_intents
    FROM agent_accounts a WHERE a.deployment_id=$1 AND a.owner_account_id=$2
    AND (a.state='active' OR (a.state='pending' AND ${MAY_STILL_LAND}))
    ORDER BY a.created_at DESC LIMIT 10`, [s.deployment.id, owner.account]);
  const data = await Promise.all(rows.map(async ({ id, ...agent }) => {
    const until = agent.state === 'active' ? await authorizedUntil(s, { id, agent_id: agent.agent_id }) : null;
    return { ...agent, authorized_until: until };
  }));
  return { data };
}

export const parseOwnedAction = (body: unknown, owner: string, kinds?: readonly ActionKind[]) =>
  parseAgentAction(object(body) ? { ...body, recipient: owner } : body, kinds);

export interface SpendLimits { via: string; one: bigint; daily: bigint }
export interface OwnedRun { key: unknown; action: AgentAction; limits: SpendLimits }

export const sessionLimits = (s: Pick<AgentAccounts, 'deployment'>, owner: OwnerAccount): SpendLimits => {
  const { perTransaction, daily } = agentSpend(s.deployment);
  return { via: `web:${owner.account}`, one: BigInt(perTransaction), daily: BigInt(daily) };
};

const WIDEST_SLIPPAGE_BPS = 1000n;
const BPS = 10000n;
const quoted = (value: unknown) => {
  if (!isUnits(value)) throw new Error('invalid_quote');
  return BigInt(value);
};

function priced(s: AgentAccounts, a: AgentAction) {
  const { rounds, market } = s.deployment.contracts;
  if (a.kind === 'stake' && rounds) {
    return { least: a.minShares, quote: s.chain.view(rounds, 'quote_stake',
      { series_id: a.series, round: a.round, side: a.side, amount: a.amount }).then(quoted) };
  }
  if (a.kind === 'buy' && market) {
    return { least: a.minShares, quote: s.chain.view(market, 'quote_buy',
      { market_id: a.market, side: a.side, amount: a.amount }).then(q => quoted(object(q) ? q.shares_out : null)) };
  }
  if (a.kind === 'sell' && market) {
    return { least: a.minCollateral, quote: s.chain.view(market, 'quote_sell',
      { market_id: a.market, side: a.side, shares: a.shares })
      .then(q => (object(q) ? quoted(q.collateral_out) - quoted(q.fee) : quoted(null))) };
  }
  return null;
}

async function fenceAction(s: AgentAccounts, action: AgentAction) {
  const trade = priced(s, action);
  if (trade && BigInt(trade.least) * BPS < (await trade.quote) * (BPS - WIDEST_SLIPPAGE_BPS)) {
    throw new ReadError(409, 'slippage_too_wide');
  }
}

export async function runOwnedAction(s: AgentAccounts, owner: OwnerAccount, agentId: string, run: OwnedRun) {
  const { key, action, limits } = run;
  if (typeof key !== 'string' || !ACTION_KEY.test(key)) throw new ReadError(400, 'invalid_key');
  const spend = spendOf(action);
  if (spend > limits.one) throw new ReadError(409, 'spend_over_limit');
  const agent = await activeAgent(s, owner, agentId);
  if (agent.frozen) throw new ReadError(409, 'wallet_frozen');
  const grant = await usableGrant(s.db, s.grantKey, agent);
  if (!grant) throw new ReadError(409, 'grant_required');
  return runAgentAction(s.runner, { agentId, token: grant.token }, { agent: agent.near_account_id, key, action,
    via: limits.via, fence: () => fenceAction(s, action),
    ...(spend > 0n ? { cap: { via: limits.via, limit: limits.daily, amount: spend } } : {}) });
}

export async function agentOperations(s: AgentAccounts, owner: OwnerAccount, agentId: string) {
  const agent = await ownedAgent(s, owner, agentId);
  if (!agent.near_account_id) return { data: [] };
  const { rows } = await s.db.query(`SELECT id,kind,state,transaction_hash,evidence,request->'action' AS action,
    updated_at FROM user_operations WHERE deployment_id=$1 AND account_id=$2 ORDER BY updated_at DESC LIMIT 50`,
  [s.deployment.id, agent.near_account_id]);
  return { data: rows };
}

const UNCLAIMED = `SELECT (s.request->'action'->>'series')::int AS series, s.request->'action'->>'round' AS round
  FROM user_operations s WHERE s.deployment_id=$1 AND s.account_id=$2 AND s.state='confirmed'
  AND s.request->'action'->>'kind'='stake' AND NOT EXISTS (SELECT 1 FROM user_operations c
    WHERE c.deployment_id=s.deployment_id AND c.account_id=s.account_id AND c.state='confirmed'
    AND c.request->'action'->>'kind'='claim' AND c.request->'action'->>'series'=s.request->'action'->>'series'
    AND c.request->'action'->>'round'=s.request->'action'->>'round')
  GROUP BY 1,2 ORDER BY max(s.updated_at) DESC LIMIT 40`;

export async function claimableStakes(s: AgentAccounts, account: string) {
  const rounds = s.deployment.contracts.rounds;
  if (!rounds) return { data: [] };
  const { rows } = await s.db.query(UNCLAIMED, [s.deployment.id, account]);
  const found = await Promise.all(rows.map(async ({ series, round }: { series: number; round: string }) => {
    const where = { series_id: series, round };
    const [stake, outcome] = await Promise.all([s.chain.view(rounds, 'get_stake', { ...where, account_id: account }),
      s.chain.view(rounds, 'round_outcome', where)]);
    return object(stake) && outcome ? { series, round, side: stake.side, amount: stake.amount, outcome } : null;
  }));
  return { data: found.filter(stake => stake !== null) };
}

export async function agentClaimable(s: AgentAccounts, owner: OwnerAccount, agentId: string) {
  const { near_account_id: account } = await ownedAgent(s, owner, agentId);
  return account ? claimableStakes(s, account) : { data: [] };
}

const POSITION_PAGE = '100';

export async function marketPositions(s: AgentAccounts, account: string) {
  const market = s.deployment.contracts.market;
  if (!market) return { data: [] };
  const held = await s.chain.view(market, 'get_positions', { account_id: account, limit: POSITION_PAGE });
  if (!Array.isArray(held)) throw new Error('invalid_positions');
  return { data: held };
}
