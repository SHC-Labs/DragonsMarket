import type pg from 'pg';
import { LOCK } from './locks.js';

export interface RelayRecord {
  until: number;
  hash: string;
  nonce: bigint;
  signed: string;
  settled: boolean;
  error: { status: number; code: string; reason?: string } | null;
}

export interface RelayLease {
  lastNonce: bigint | null;
  records: Map<string, RelayRecord>;
  assertOwned(): void;
  save(payload: string, record: RelayRecord): Promise<void>;
}
export interface RelayJournal {
  read(scope: string, payloads: string[]): Promise<Map<string, RelayRecord>>;
  withKey<T>(scope: string, payloads: string[], work: (lease: RelayLease) => Promise<T>): Promise<T>;
}

async function readSubmissions(client: Pick<pg.Pool, 'query'>, scope: string, payloads: string[]) {
  const rows = await client.query<{ payload_hash: string; record: Omit<RelayRecord, 'nonce'> & { nonce: string } }>(
    'SELECT payload_hash,record FROM relay_submissions WHERE scope=$1 AND payload_hash=ANY($2::text[])', [scope, payloads]);
  return new Map(rows.rows.map(row => [row.payload_hash, { ...row.record, nonce: BigInt(row.record.nonce) }]));
}

// Records commit before a signed transaction leaves the process. A successor can
// retransmit those bytes, but cannot allocate their access-key nonce again.
export function relayJournal(pool: pg.Pool): RelayJournal {
  return { read: (scope, payloads) => readSubmissions(pool, scope, payloads), async withKey(scope, payloads, work) {
    const client = await pool.connect();
    let lost = false;
    let locked = false;
    const onError = () => { lost = true; };
    const assertOwned = () => { if (lost || !locked) throw new Error('Relay signing lock unavailable'); };
    client.on('error', onError);
    try {
      const result = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(${LOCK.relay},hashtext($1)) AS acquired`, [scope]);
      locked = result.rows[0]?.acquired === true;
      assertOwned();
      const cursor = await client.query<{ nonce: string | null }>(
        'SELECT nonce::text FROM relay_keys WHERE scope=$1', [scope]);
      const records = await readSubmissions(client, scope, payloads);
      const lease: RelayLease = {
        lastNonce: cursor.rows[0]?.nonce == null ? null : BigInt(cursor.rows[0].nonce),
        records,
        assertOwned,
        async save(payload, record) {
          assertOwned();
          // Both statements share one transaction: a durable submission always
          // advances the cursor, including when a process dies before broadcast.
          await client.query('BEGIN');
          try {
            await client.query(`INSERT INTO relay_keys(scope,nonce) VALUES($1,$2)
              ON CONFLICT(scope) DO UPDATE SET nonce=GREATEST(relay_keys.nonce,EXCLUDED.nonce)`, [scope, record.nonce.toString()]);
            const saved = await client.query(`INSERT INTO relay_submissions(scope,payload_hash,record) VALUES($1,$2,$3)
              ON CONFLICT(scope,payload_hash) DO UPDATE SET record=EXCLUDED.record
              WHERE relay_submissions.record->>'hash'=EXCLUDED.record->>'hash'
                AND relay_submissions.record->>'signed'=EXCLUDED.record->>'signed'
              RETURNING payload_hash`, [scope, payload, JSON.stringify({ ...record, nonce: record.nonce.toString() })]);
            if (saved.rowCount !== 1) throw new Error('Relay transaction identity changed');
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK').catch(onError);
            throw error;
          }
          assertOwned();
          lease.lastNonce = lease.lastNonce === null || record.nonce > lease.lastNonce ? record.nonce : lease.lastNonce;
          lease.records.set(payload, record);
        },
      };
      return await work(lease);
    } finally {
      if (locked && !lost) await client.query(`SELECT pg_advisory_unlock(${LOCK.relay},hashtext($1))`, [scope]).catch(onError);
      client.removeListener('error', onError);
      client.release(lost);
    }
  } };
}
