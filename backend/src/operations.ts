import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { canonical } from './ingestion/block.js';

const KINDS = ['fund', 'trade', 'claim', 'withdraw'];
const KEY = /^[a-zA-Z0-9_.:/-]{1,160}$/;
const MAX_REQUEST_BYTES = 16384;
const NEXT: Record<string, readonly string[]> = {
  prepared: ['submitted', 'failed', 'reconcile'],
  submitted: ['unknown', 'confirmed', 'failed', 'reconcile'],
  unknown: ['confirmed', 'failed', 'reconcile'],
  reconcile: ['confirmed', 'failed'],
};

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export async function prepareOperation(pool: pg.Pool, deployment: string, account: string, kind: string, key: string,
  request: unknown) {
  if (!KINDS.includes(kind) || !KEY.test(key) || Buffer.byteLength(canonical(request)) > MAX_REQUEST_BYTES) {
    throw new Error('invalid_operation');
  }
  const hash = digest({ kind, request });
  const { rows: [row] } = await pool.query(`INSERT INTO user_operations(id,deployment_id,account_id,kind,idempotency_key,
    request_hash,request) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(deployment_id,account_id,idempotency_key)
    DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,state,evidence,request_hash`,
  [randomUUID(), deployment, account, kind, key, hash, JSON.stringify(request)]);
  if (row.request_hash !== hash) throw new Error('operation_idempotency_conflict');
  return { id: row.id as string, state: row.state as string, evidence: row.evidence as unknown };
}

export function leaseOperation(pool: pg.Pool, id: string, account: string) {
  const token = randomUUID();
  return pool.query(`UPDATE user_operations SET lease_token=$3,leased_until=now()+interval '5 minutes'
    WHERE id=$1 AND account_id=$2 AND (leased_until IS NULL OR leased_until<now()) RETURNING state,evidence`,
  [id, account, token]).then(({ rows: [row] }) =>
    (row ? { token, state: row.state as string, evidence: row.evidence as unknown } : null));
}

export function releaseOperation(pool: pg.Pool, id: string, account: string, token: string) {
  return pool.query(`UPDATE user_operations SET lease_token=NULL,leased_until=NULL
    WHERE id=$1 AND account_id=$2 AND lease_token=$3`, [id, account, token]).then(() => {});
}

export async function markOperationSent(pool: pg.Pool, id: string, account: string) {
  const { rowCount } = await pool.query(`UPDATE user_operations SET evidence=jsonb_build_object('sent',true),
    updated_at=now() WHERE id=$1 AND account_id=$2 AND state='prepared'`, [id, account]);
  if (rowCount !== 1) throw new Error('operation_state_conflict');
}

export async function transitionOperation(pool: pg.Pool, id: string, account: string, from: string, to: string,
  transactionHash: string | null, evidence: unknown) {
  if (!NEXT[from]?.includes(to)) throw new Error('invalid_operation_transition');
  if (to === 'confirmed' && evidence === null) throw new Error('confirmation_evidence_required');
  const { rowCount } = await pool.query(`UPDATE user_operations SET state=$4,
    transaction_hash=COALESCE($5,transaction_hash),evidence=$6,updated_at=now()
    WHERE id=$1 AND account_id=$2 AND state=$3`,
  [id, account, from, to, transactionHash, JSON.stringify(evidence)]).catch((error: unknown) => {
    throw (error as { constraint?: unknown }).constraint === 'user_operations_transaction'
      ? new Error('transaction_already_claimed') : error;
  });
  if (rowCount !== 1) throw new Error('operation_state_conflict');
}

export const operationStore = (pool: pg.Pool, deployment: string) => ({
  prepare: (account: string, kind: string, key: string, request: unknown) =>
    prepareOperation(pool, deployment, account, kind, key, request),
  lease: (id: string, account: string) => leaseOperation(pool, id, account),
  release: (id: string, account: string, token: string) => releaseOperation(pool, id, account, token),
  sent: (id: string, account: string) => markOperationSent(pool, id, account),
  transition: (id: string, account: string, from: string, to: string, hash: string | null, evidence: unknown) =>
    transitionOperation(pool, id, account, from, to, hash, evidence),
});
