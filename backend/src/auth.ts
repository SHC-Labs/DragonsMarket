import { createHash, randomBytes, randomUUID, createPublicKey, verify } from 'node:crypto';
import type pg from 'pg';
import type { Config } from './config.js';
import { isAccount as account } from './validate.js';
// Challenges live five minutes, so this bounds the table however many addresses a client rotates through.
const MAX_PENDING_CHALLENGES = 20000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: string) => UUID.test(s);
export const tokenHash = (s: string) => createHash('sha256').update(s).digest('hex');
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decodeKey(s: string) {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error('invalid_public_key');
  let value = 0n;
  const encoded = s.slice(8);
  for (const c of encoded) value = value * 58n + BigInt(alphabet.indexOf(c));
  const bytes: number[] = [];
  while (value) {
    bytes.unshift(Number(value & 255n));
    value >>= 8n;
  }
  for (const c of encoded) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  if (bytes.length !== 32) throw new Error('invalid_public_key');
  return Buffer.from(bytes);
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
export async function challenge(pool: pg.Pool, config: Config, accountId: string) {
  if (!account(accountId) || (config.network === 'mainnet' && accountId.endsWith('.testnet')) || (config.network === 'testnet' && accountId.endsWith('.near')))
    throw new Error('invalid_account');
  const pending = await pool.query('SELECT count(*)::int AS n FROM wallet_challenges WHERE expires_at>now() AND consumed_at IS NULL');
  if (pending.rows[0].n >= MAX_PENDING_CHALLENGES) throw new Error('challenge_capacity');
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
export async function login(pool: pg.Pool, config: Config, id: string, publicKey: string, signature: string, browser: string, checkKey: CheckAccessKey) {
  if (!UUID.test(id) || !browser || !/^([A-Za-z0-9+/]{86}==)$/.test(signature)) throw new Error('invalid_login');
  const row = (await pool.query('SELECT * FROM wallet_challenges WHERE id=$1 AND consumed_at IS NULL AND expires_at>now()', [id])).rows[0];
  if (!row || row.origin !== config.webOrigin || row.network !== config.network || row.browser_hash !== tokenHash(browser)) throw new Error('invalid_login');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeKey(publicKey)]), format: 'der', type: 'spki' });
  // A definitive rejection spends the challenge, so one challenge cannot be replayed against the RPC. A failing RPC is not a rejection and leaves it usable.
  const signed = verify(null, messageHash(row.message, row.nonce, row.origin, row.origin), key, Buffer.from(signature, 'base64'));
  if (!signed || !(await checkKey(row.account_id, publicKey))) {
    await pool.query('UPDATE wallet_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL', [id]);
    throw new Error('invalid_login');
  }
  const c = await pool.connect(),
    token = randomBytes(32).toString('base64url');
  try {
    await c.query('BEGIN');
    const consumed = await c.query('UPDATE wallet_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at>now()', [id]);
    if (consumed.rowCount !== 1) throw new Error('challenge_used_or_expired');
    await c.query("INSERT INTO wallet_sessions(token_hash,account_id,network,public_key,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours')", [
      tokenHash(token),
      row.account_id,
      config.network,
      publicKey,
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
  return (
    (
      await pool.query('SELECT account_id,network,expires_at FROM wallet_sessions WHERE token_hash=$1 AND network=$2 AND expires_at>now()', [
        tokenHash(token),
        config.network,
      ])
    ).rows[0] ?? null
  );
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
