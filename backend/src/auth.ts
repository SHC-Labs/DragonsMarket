import { createHash, randomBytes, randomUUID, createPublicKey, verify } from 'node:crypto';
import type pg from 'pg';
import type { Config } from './config.js';
import { isAccount as account } from './validate.js';
import { base58Decode } from './base58.js';
// Challenges live five minutes, so this bounds the table however many addresses a client rotates through.
const MAX_PENDING_CHALLENGES = 100000;
// A session's idle clock is written at most this often, so a busy page does not turn every request into a row update.
const IDLE_TOUCH_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: string) => UUID.test(s);
export const tokenHash = (s: string) => createHash('sha256').update(s).digest('hex');
export function decodeKey(s: string) {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error('invalid_public_key');
  const bytes = base58Decode(s.slice(8));
  if (bytes.length !== 32) throw new Error('invalid_public_key');
  return bytes;
}
export function messageHash(message: string, nonce: string, recipient: string, callbackUrl?: string) {
  const str = (s: string) => {
    const b = Buffer.from(s);
    const n = Buffer.alloc(4);
    n.writeUInt32LE(b.length);
    return Buffer.concat([n, b]);
  };
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2147484061);
  const n = Buffer.from(nonce, 'base64');
  if (n.length !== 32) throw new Error('invalid_nonce');
  return createHash('sha256')
    .update(Buffer.concat([tag, str(message), n, str(recipient), callbackUrl ? Buffer.concat([Buffer.from([1]), str(callbackUrl)]) : Buffer.from([0])]))
    .digest();
}
export async function checkChallengeCapacity(pool: pg.Pool) {
  const pending = await pool.query('SELECT count(*)::int AS n FROM wallet_challenges WHERE expires_at>now() AND consumed_at IS NULL');
  if (pending.rows[0].n >= MAX_PENDING_CHALLENGES) throw new Error('challenge_capacity');
}
export async function challenge(pool: pg.Pool, config: Config, accountId: string) {
  if (!account(accountId) || (config.network === 'mainnet' && accountId.endsWith('.testnet')) || (config.network === 'testnet' && accountId.endsWith('.near')))
    throw new Error('invalid_account');
  await checkChallengeCapacity(pool);
  const id = randomUUID(),
    nonce = randomBytes(32).toString('base64'),
    browser = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 300000);
  const message = `Sign in to Dragons Market\nAccount: ${accountId}\nNetwork: ${config.network}\nOrigin: ${config.webOrigin}\nChallenge: ${id}\nExpires: ${expires.toISOString()}\nThis creates a website session. It does not authorize transactions.`;
  await pool.query('INSERT INTO wallet_challenges(id,account_id,network,origin,nonce,browser_hash,message,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [
    id,
    accountId,
    config.network,
    config.webOrigin,
    nonce,
    tokenHash(browser),
    message,
    expires,
  ]);
  return { browser, request: { id, accountId, message, nonce, recipient: config.webOrigin, callbackUrl: config.webOrigin, expiresAt: expires.toISOString() } };
}
export type CheckAccessKey = (accountId: string, publicKey: string) => Promise<boolean>;
// NEP-413 lets the payload carry a callback URL or not, and some wallet connectors cannot add one. Both forms bind the same
// message, so a signature over either one proves the same thing.
export function signedBy(publicKey: string, signature: string, proof: { message: string; nonce: string; recipient: string }) {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeKey(publicKey)]), format: 'der', type: 'spki' });
  const { message, nonce, recipient } = proof, bytes = Buffer.from(signature, 'base64');
  return [recipient, undefined].some(callbackUrl => verify(null, messageHash(message, nonce, recipient, callbackUrl), key, bytes));
}
export async function login(pool: pg.Pool, config: Config, id: string, publicKey: string, signature: string, browser: string, checkKey: CheckAccessKey) {
  if (!UUID.test(id) || !browser || !/^([A-Za-z0-9+/]{86}==)$/.test(signature)) throw new Error('invalid_login');
  const row = (await pool.query("SELECT * FROM wallet_challenges WHERE id=$1 AND wallet_type='near' AND consumed_at IS NULL AND expires_at>now()", [id])).rows[0];
  if (!row || row.origin !== config.webOrigin || row.network !== config.network || row.browser_hash !== tokenHash(browser)) throw new Error('invalid_login');
  // A definitive rejection spends the challenge, so one challenge cannot be replayed against the RPC. A failing RPC is not a rejection and leaves it usable.
  const signed = signedBy(publicKey, signature, { message: row.message, nonce: row.nonce, recipient: row.origin });
  if (!signed || !(await checkKey(row.account_id, publicKey))) {
    await pool.query('UPDATE wallet_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL', [id]);
    throw new Error('invalid_login');
  }
  return completeLogin(pool, config, { id, publicKey, walletType: 'near' });
}

export async function completeLogin(
  pool: pg.Pool,
  config: Config,
  proof: { id: string; publicKey: string; walletType: 'near' | 'evm' },
) {
  const c = await pool.connect(),
    token = randomBytes(32).toString('base64url');
  try {
    await c.query('BEGIN');
    const consumed = await c.query(
      `UPDATE wallet_challenges SET consumed_at=now()
       WHERE id=$1 AND wallet_type=$2 AND network=$3 AND origin=$4
         AND consumed_at IS NULL AND expires_at>now()
       RETURNING account_id, wallet_type, evm_chain_id`,
      [proof.id, proof.walletType, config.network, config.webOrigin],
    );
    if (consumed.rowCount !== 1) throw new Error('challenge_used_or_expired');
    const row = consumed.rows[0];
    await c.query(`INSERT INTO wallet_sessions
      (token_hash,account_id,network,public_key,expires_at,wallet_type,evm_chain_id)
      VALUES($1,$2,$3,$4,now()+make_interval(secs=>$5),$6,$7)`, [
      tokenHash(token),
      row.account_id,
      config.network,
      proof.publicKey,
      config.sessionAbsoluteSeconds,
      row.wallet_type,
      row.evm_chain_id,
    ]);
    await c.query('COMMIT');
    return token;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function session(pool: pg.Pool, config: Config, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const found = (
    await pool.query(
      `SELECT account_id,network,public_key,wallet_type,evm_chain_id,expires_at,
        last_seen_at<now()-make_interval(secs=>$4) AS stale FROM wallet_sessions
       WHERE token_hash=$1 AND network=$2 AND expires_at>now() AND last_seen_at>now()-make_interval(secs=>$3)`,
      [tokenHash(token), config.network, config.sessionIdleSeconds, IDLE_TOUCH_SECONDS],
    )
  ).rows[0];
  if (!found) return null;
  const { stale, ...identity } = found;
  if (stale) await pool.query('UPDATE wallet_sessions SET last_seen_at=now() WHERE token_hash=$1', [tokenHash(token)]);
  return identity;
}

/** Ends every session the account has, on every device. Returns how many were revoked. */
export async function revokeAllSessions(pool: pg.Pool, accountId: string) {
  return (await pool.query('DELETE FROM wallet_sessions WHERE account_id=$1', [accountId])).rowCount ?? 0;
}

/** Bounded housekeeping for expired credentials only. Legal acknowledgements and signing decisions are retained. */
const CLEANUP_BATCH = 1000;
const CLEANUP_MAX_BATCHES = 50;
async function deleteExpired(pool: pg.Pool, table: 'wallet_challenges' | 'wallet_sessions', key: 'id' | 'token_hash') {
  let total = 0;
  for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
    const result =
      await pool.query(`WITH old AS (SELECT ${key} FROM ${table} WHERE expires_at<now()-interval '1 hour' ORDER BY expires_at LIMIT ${CLEANUP_BATCH})
   DELETE FROM ${table} t USING old WHERE t.${key}=old.${key}`);
    total += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < CLEANUP_BATCH) break;
  }
  return total;
}
export async function cleanupExpiredAuth(pool: pg.Pool) {
  return { challenges: await deleteExpired(pool, 'wallet_challenges', 'id'), sessions: await deleteExpired(pool, 'wallet_sessions', 'token_hash') };
}
