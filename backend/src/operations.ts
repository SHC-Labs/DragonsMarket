import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { canonical } from './ingestion/block.js';
import { transaction } from './database.js';
import { agentLock } from './locks.js';

const KINDS = ['trade', 'claim', 'withdraw'];
const KEY = /^[a-zA-Z0-9_.:/-]{1,160}$/;
const MAX_REQUEST_BYTES = 16384;
const NEXT: Record<string, readonly string[]> = {
  prepared: ['submitted', 'failed', 'reconcile'],
  submitted: ['unknown', 'confirmed', 'failed', 'reconcile'],
  unknown: ['confirmed', 'failed', 'reconcile'],
  reconcile: ['confirmed', 'failed'],
};

export class OperationRefused extends Error {}
export class TransactionClaimed extends Error {}
export interface DailyCap { via: string; limit: bigint; amount: bigint }
interface Ref { id: string; agent: string }
interface Change { txHash: string | null; evidence: unknown; correlation?: string }
type Queryable = Pick<pg.Pool, 'query'>;

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export const spentToday = (q: Queryable, deployment: string, via: string) =>
  q.query(`SELECT COALESCE(sum((request->'action'->>'amount')::numeric),0)::text AS n FROM user_operations
    WHERE deployment_id=$1 AND request ? 'via' AND request->>'via'=$2 AND request->'action'->>'kind' IN ('stake','buy')
    AND state<>'failed' AND (state<>'confirmed' OR updated_at>now()-interval '1 day')`,
  [deployment, via]).then(({ rows: [row] }) =>
    BigInt(row.n));

export function operationStore(pool: pg.Pool, deployment: string) {
  const insert = (q: Queryable, account: string, kind: string, key: string, request: unknown) =>
    q.query(`INSERT INTO user_operations(id,deployment_id,account_id,kind,idempotency_key,request_hash,request)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(deployment_id,account_id,idempotency_key)
      DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,state,evidence,request_hash`,
    [randomUUID(), deployment, account, kind, key, digest({ kind, request }), JSON.stringify(request)])
      .then(({ rows: [row] }) => row);

  const seen = (q: Queryable, account: string, key: string) =>
    q.query(`SELECT 1 FROM user_operations WHERE deployment_id=$1 AND account_id=$2 AND idempotency_key=$3`,
      [deployment, account, key]).then(({ rowCount }) => (rowCount ?? 0) > 0);

  async function admit(c: pg.PoolClient, account: string, key: string, cap: DailyCap) {
    await agentLock(c, `spend:${cap.via}`);
    if (await seen(c, account, key)) return;
    const spent = await spentToday(c, deployment, cap.via);
    if (spent + cap.amount > cap.limit) throw new OperationRefused('daily_limit_reached');
  }

  return {
    seen: (account: string, key: string) => seen(pool, account, key),

    async prepare(account: string, kind: string, key: string, request: unknown, cap?: DailyCap) {
      if (!KINDS.includes(kind) || !KEY.test(key) || Buffer.byteLength(canonical(request)) > MAX_REQUEST_BYTES) {
        throw new Error('invalid_operation');
      }
      const row = await (cap
        ? transaction(pool, c => admit(c, account, key, cap).then(() => insert(c, account, kind, key, request)))
        : insert(pool, account, kind, key, request));
      if (row.request_hash !== digest({ kind, request })) throw new OperationRefused('operation_idempotency_conflict');
      return { id: row.id as string, state: row.state as string, evidence: row.evidence as unknown };
    },

    lease({ id, agent }: Ref) {
      const token = randomUUID();
      return pool.query(`UPDATE user_operations SET lease_token=$3,leased_until=now()+interval '5 minutes'
        WHERE id=$1 AND account_id=$2 AND (leased_until IS NULL OR leased_until<now())
        RETURNING state,evidence,sent_at,correlation_id`, [id, agent, token]).then(({ rows: [row] }) => (row
        ? { token, state: row.state as string, evidence: row.evidence as unknown, sent: row.sent_at !== null,
          correlation: row.correlation_id as string | null }
        : null));
    },

    release({ id, agent }: Ref, token: string) {
      return pool.query(`UPDATE user_operations SET lease_token=NULL,leased_until=NULL
        WHERE id=$1 AND account_id=$2 AND lease_token=$3`, [id, agent, token]).then(() => {});
    },

    sent({ id, agent }: Ref) {
      return pool.query(`UPDATE user_operations SET sent_at=now(),updated_at=now()
        WHERE id=$1 AND account_id=$2 AND state='prepared'`, [id, agent]).then(({ rowCount }) => {
        if (rowCount !== 1) throw new OperationRefused('operation_state_conflict');
      });
    },

    async transition({ id, agent }: Ref, from: string, to: string, change: Change) {
      if (!NEXT[from]?.includes(to)) throw new Error('invalid_operation_transition');
      if (to === 'confirmed' && change.evidence === null) throw new Error('confirmation_evidence_required');
      const { rowCount } = await pool.query(`UPDATE user_operations SET state=$4,
        transaction_hash=COALESCE($5,transaction_hash),correlation_id=COALESCE($6,correlation_id),evidence=$7,
        updated_at=now() WHERE id=$1 AND account_id=$2 AND state=$3`,
      [id, agent, from, to, change.txHash, change.correlation ?? null, JSON.stringify(change.evidence)])
        .catch((error: unknown) => {
          throw (error as { constraint?: unknown }).constraint === 'user_operations_transaction'
            ? new TransactionClaimed() : error;
        });
      if (rowCount !== 1) throw new OperationRefused('operation_state_conflict');
    },
  };
}

export function strandedOperations(pool: pg.Pool, deployment: string) {
  return pool.query(`UPDATE user_operations SET followed_at=now() WHERE id IN (SELECT id FROM user_operations
    WHERE deployment_id=$1 AND request ? 'agent_id' AND updated_at<now()-interval '30 seconds'
    AND (followed_at IS NULL OR followed_at<now()-interval '1 minute')
    AND (leased_until IS NULL OR leased_until<now())
    AND (state IN ('prepared','submitted','unknown')
      OR (state='reconcile' AND correlation_id IS NOT NULL AND updated_at>now()-interval '7 days'))
    ORDER BY followed_at NULLS FIRST LIMIT 50 FOR UPDATE SKIP LOCKED)
    RETURNING id,account_id AS agent,request`, [deployment]).then(({ rows }) =>
    rows as { id: string; agent: string; request: unknown }[]);
}
