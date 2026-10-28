import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { canonical } from './ingestion/block.js';
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const validKey = (v: string) => /^[a-zA-Z0-9_.:/-]{1,160}$/.test(v);
const kinds = new Set(['price_boundary','settle_round','claim','reconcile','keeper_check']);
export async function enqueue(client: Pick<pg.Pool,'query'>, deployment: string, kind: string, key: string, payload: unknown, due: Date, deadline: Date | null = null) {
  if (!kinds.has(kind) || !validKey(key) || Buffer.byteLength(canonical(payload))>16384 || !Number.isFinite(due.getTime()) || (deadline && (!Number.isFinite(deadline.getTime()) || deadline<=due))) throw new Error('invalid_job');
  const hash=digest(payload), id=randomUUID();
  const {rows}=await client.query(`INSERT INTO backend_jobs(id,deployment_id,kind,work_key,payload,payload_hash,due_at,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(deployment_id,kind,work_key) DO UPDATE SET work_key=EXCLUDED.work_key RETURNING id,payload_hash`,[id,deployment,kind,key,JSON.stringify(payload),hash,due,deadline]);
  if(rows[0].payload_hash!==hash) throw new Error('job_idempotency_conflict');
  return rows[0].id as string;
}
export async function leaseJob(pool: pg.Pool, deployment: string) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    // A worker may have sent before its lease expired. Never automatically resend ambiguous work.
    await c.query("UPDATE backend_jobs SET state='reconcile',last_error='lease_expired',lease_token=NULL,leased_until=NULL WHERE deployment_id=$1 AND state='leased' AND leased_until<now()",[deployment]);
    await c.query("UPDATE backend_jobs SET state='dead',last_error='deadline_expired' WHERE deployment_id=$1 AND state='queued' AND deadline<=now()",[deployment]);
    const {rows}=await c.query(`SELECT id FROM backend_jobs WHERE deployment_id=$1 AND state='queued' AND due_at<=now() AND attempts<8 ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[deployment]);
    if(!rows.length){await c.query('COMMIT');return null;}
    const token=randomUUID();
    const job=(await c.query("UPDATE backend_jobs SET state='leased',lease_token=$2,leased_until=now()+interval '60 seconds',attempts=attempts+1 WHERE id=$1 RETURNING *",[rows[0].id,token])).rows[0];
    await c.query('COMMIT');return job;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function finishJob(pool: pg.Pool, id: string, token: string, result: 'done'|'retry_before_send'|'unknown', code='worker_error') {
  if(!/^[a-z0-9_]{1,80}$/.test(code))throw new Error('invalid_error_code');
  const state=result==='done'?'done':result==='unknown'?'reconcile':'queued';
  const {rowCount}=await pool.query(`UPDATE backend_jobs SET state=CASE WHEN $3='queued' AND attempts>=8 THEN 'dead' ELSE $3 END,
    due_at=now()+make_interval(secs=>LEAST(300,power(2,attempts)::int)),lease_token=NULL,leased_until=NULL,last_error=$4
    WHERE id=$1 AND state='leased' AND lease_token=$2 AND leased_until>now()`,[id,token,state,result==='done'?null:code]);
  if(rowCount!==1)throw new Error('job_lease_lost');
}
// Persist operations before requesting a wallet signature. This does not authorize or relay them.
export async function prepareOperation(pool: pg.Pool, deployment: string, account: string, kind: string, key: string, request: unknown) {
  if(!['fund','trade','claim','withdraw','exit'].includes(kind)||!validKey(key)||Buffer.byteLength(canonical(request))>16384)throw new Error('invalid_operation');
  const hash=digest({kind,request});
  const {rows}=await pool.query(`INSERT INTO user_operations(id,deployment_id,account_id,kind,idempotency_key,request_hash,request)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(deployment_id,account_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,[randomUUID(),deployment,account,kind,key,hash,JSON.stringify(request)]);
  if(rows[0].request_hash!==hash)throw new Error('operation_idempotency_conflict');
  return rows[0];
}
const next: Record<string,string[]>={prepared:['awaiting_signature','failed'],awaiting_signature:['submitted','failed'],submitted:['unknown','confirmed','failed','reconcile'],unknown:['confirmed','failed','reconcile'],reconcile:['confirmed','failed'],confirmed:[],failed:[]};
export async function transitionOperation(pool: pg.Pool,id:string,account:string,from:string,to:string,transactionHash:string|null=null,evidence:unknown=null){
  if(!next[from]?.includes(to))throw new Error('invalid_operation_transition');
  if(to==='confirmed'&&evidence===null)throw new Error('confirmation_evidence_required');
  const {rowCount}=await pool.query(`UPDATE user_operations SET state=$4,transaction_hash=COALESCE($5,transaction_hash),evidence=$6,updated_at=now() WHERE id=$1 AND account_id=$2 AND state=$3`,[id,account,from,to,transactionHash,JSON.stringify(evidence)]);
  if(rowCount!==1)throw new Error('operation_state_conflict');
}
export function boundaries(nowNs: bigint, originNs: bigint, periodNs=300000000000n) {
  if(nowNs<originNs||periodNs<=0n)throw new Error('invalid_schedule');
  const round=(nowNs-originNs)/periodNs,start=originNs+round*periodNs;
  return {round:round.toString(),startNs:start.toString(),endNs:(start+periodNs).toString()};
}
/** A publisher may reserve one canonical payload per boundary forever, including after restart. */
export async function reserveSigningDecision(pool:pg.Pool,deployment:string,publisher:string,boundary:string,payload:string){
  if(!validKey(boundary)||payload.length>2048||publisher.length>128)throw new Error('invalid_signing_decision');
  const hash=digest(payload);
  const {rows}=await pool.query(`INSERT INTO signing_decisions(deployment_id,publisher_key,boundary_key,payload,payload_hash) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(deployment_id,publisher_key,boundary_key) DO UPDATE SET boundary_key=EXCLUDED.boundary_key RETURNING payload_hash,signature`,[deployment,publisher,boundary,payload,hash]);
  if(rows[0].payload_hash!==hash)throw new Error('conflicting_boundary_signature');
  return rows[0];
}
