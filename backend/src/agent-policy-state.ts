import type pg from 'pg';
import { AgentApiUnavailable, appliedFreeze, type AccountPolicy, type AgentApiClient } from './agent-api.js';
import { ReadError } from './read-api.js';
import { canonical } from './ingestion/block.js';

type Queryable = Pick<pg.Pool, 'query'>;
interface Account { id: string; agent_id: string }
export interface PolicyObservation {
  account: string;
  version: string;
  frozen: boolean;
  confirmed: boolean;
  policy: AccountPolicy;
}

export async function observePolicyFreeze(db: Queryable, api: Pick<AgentApiClient, 'policy'>,
  account: Account): Promise<PolicyObservation> {
  const { rows: [row] } = await db.query('SELECT policy_observation::text FROM agent_accounts WHERE id=$1',
    [account.id]);
  if (!row) throw new ReadError(404, 'agent_not_found');
  const policy = await api.policy(account.agent_id), frozen = appliedFreeze(policy);
  return { account: account.id, version: row.policy_observation, frozen: frozen ?? true,
    confirmed: frozen !== null, policy };
}

export async function savePolicyFreeze(db: Queryable, observation: PolicyObservation) {
  const saved = await db.query(`UPDATE agent_accounts SET frozen=$2,
    policy_observation=policy_observation+1,updated_at=now() WHERE id=$1 AND policy_observation=$3`,
  [observation.account, observation.frozen, observation.version]);
  if (saved.rowCount !== 1) throw new AgentApiUnavailable('owner_policy_observation_stale');
}

export async function policyForTransition(api: Pick<AgentApiClient, 'policyHistory'>, agentId: string,
  current: AccountPolicy): Promise<{ revision: number; policy: Record<string, unknown> }> {
  if (current.revision !== null && current.policy && appliedFreeze(current) !== null) {
    return { revision: current.revision, policy: current.policy };
  }
  if (current.status !== 'FAILED' || current.revision === null || current.revision < 1) {
    throw new ReadError(409, 'policy_not_ready');
  }
  // A failed proposal consumes a revision, but its rules never replace the last applied policy.
  // Read a bounded history and require the same latest snapshot before restating applied rules.
  const history = await api.policyHistory(agentId), latest = history[0];
  if (!latest || latest.revision !== current.revision || latest.status !== current.status
    || canonical(latest.policy) !== canonical(current.policy)) {
    throw new AgentApiUnavailable('owner_policy_observation_stale');
  }
  let revision = current.revision;
  for (const entry of history) {
    if (entry.revision !== revision--) throw new AgentApiUnavailable('owner_policy_history_incomplete');
    if (entry.status === 'FAILED') continue;
    if (entry.status === 'APPLIED' && entry.policy) return { revision: current.revision, policy: entry.policy };
    break;
  }
  throw new ReadError(409, 'policy_not_ready');
}
