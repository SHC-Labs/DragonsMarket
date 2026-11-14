import { grantCommitment } from '@near-intents-agent-api/sdk';
import type pg from 'pg';
import { agentSpend, type Config } from './config.js';
import { ACCESS_KINDS, spendOf, type AgentAction } from './agent-actions.js';
import { appliedFreeze, type AgentApiClient, type AgentGrant } from './agent-api.js';
import { dragonsPolicy, grantsNoMore } from './agent-policy.js';
import { isAccount } from './validate.js';

export interface AgentAuthorization { agent: string; action: AgentAction; via?: string }
export class AgentAuthorizationRefused extends Error {}

type Deployment = NonNullable<Config['deployment']>;
interface Authority extends pg.QueryResultRow {
  owner: string; frozen: boolean; token_live: boolean; max_spend: string | null;
}

const refuse = (code: string): never => { throw new AgentAuthorizationRefused(code); };

function spendingLimit(deployment: Deployment, row: Authority, job: AgentAuthorization) {
  if (job.via === `web:${row.owner}`) return BigInt(agentSpend(deployment).perTransaction);
  if (!row.token_live || !ACCESS_KINDS.includes(job.action.kind)) return refuse('access_token_invalid');
  if (row.max_spend === null) return refuse('spend_over_limit');
  return BigInt(row.max_spend);
}

function checkAuthority(deployment: Deployment, row: Authority, job: AgentAuthorization) {
  if (!isAccount(row.owner)) return refuse('agent_owner_wallet_not_supported');
  if (row.frozen) return refuse('wallet_frozen');
  if (spendOf(job.action) > spendingLimit(deployment, row, job)) return refuse('spend_over_limit');
  if (job.action.kind === 'cash_out' && job.action.recipient !== row.owner) return refuse('policy_destination_denied');
}

export function agentAuthorizer(db: pg.Pool, deployment: Deployment, api: Pick<AgentApiClient, 'policy'>) {
  async function local(grant: AgentGrant, job: AgentAuthorization) {
    const { rows: [row] } = await db.query<Authority>(`SELECT a.owner_account_id AS owner,a.frozen,
      t.id IS NOT NULL AS token_live,t.max_spend FROM agent_accounts a
      JOIN agent_grants g ON g.agent_account=a.id AND g.commitment=$3 AND g.state='live'
        AND g.expires_at>now() AND g.sealed_token IS NOT NULL
      LEFT JOIN agent_access_tokens t ON t.agent_account=a.id AND t.id::text=$4
        AND t.token_hash IS NOT NULL AND t.revoked_at IS NULL AND t.expires_at>now()
      WHERE a.agent_id=$1 AND a.deployment_id=$2 AND a.state='active' AND a.near_account_id=$5`,
    [grant.agentId, deployment.id, grantCommitment(grant.token), job.via ?? null, job.agent]);
    if (!row) return refuse('agent_authorization_stale');
    checkAuthority(deployment, row, job);
    return row;
  }

  return async (grant: AgentGrant, job: AgentAuthorization) => {
    const authority = await local(grant, job);
    const current = await api.policy(grant.agentId);
    if (current.policy?.frozen === true) return refuse('wallet_frozen');
    if (appliedFreeze(current) === null) return refuse('policy_not_ready');
    if (!grantsNoMore(current.policy, dragonsPolicy(deployment, authority.owner))) {
      return refuse('provider_policy_mismatch');
    }
    await local(grant, job);
  };
}
