import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import type { Config } from './config.js';
import { challenge, isUuid, login, revokeAllSessions, session, tokenHash, type CheckAccessKey } from './auth.js';
import { isAccount as account } from './validate.js';
import { ReadError } from './read-api.js';
import { LOCK } from './locks.js';
export const isPrivateRoute = (p: string) =>
  p.startsWith('/v1/auth/') || p === '/v1/watchlist' || p === '/v1/policies/acknowledge' || /^\/v1\/operations\/[^/]+$/.test(p);
export type PrivateHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<unknown>;
// A cookie name sent twice is ambiguous (a sibling subdomain can plant a second one), so it counts as absent.
function cookie(req: IncomingMessage, name: string) {
  const found =
    req.headers.cookie
      ?.split(';')
      .map(s => s.trim())
      .filter(s => s.startsWith(name + '=')) ?? [];
  return found.length === 1 ? found[0]!.slice(name.length + 1) : '';
}
const LOGIN_REJECTIONS = ['invalid_login', 'challenge_used_or_expired', 'invalid_public_key', 'invalid_nonce'];
async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ReadError(415, 'json_required');
  let length = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    length += part.length;
    if (length > 16384) throw new ReadError(413, 'body_too_large');
    parts.push(part);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(parts).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ReadError(400, 'invalid_json');
  }
}
export function createPrivateApi(
  pool: pg.Pool,
  config: Config,
  checkKey: CheckAccessKey,
  policies: { terms: string; privacy: string } | null = null,
): PrivateHandler {
  // Over https the __Host- prefix makes browsers refuse a cookie set by a sibling subdomain; it requires Secure and Path=/.
  const https = config.webOrigin.startsWith('https:');
  const attrs = `; HttpOnly; SameSite=Strict; Path=${https ? '/' : '/v1'}${https ? '; Secure' : ''}`;
  const challengeCookie = https ? '__Host-dm_challenge' : 'dm_challenge',
    sessionCookie = https ? '__Host-dm_session' : 'dm_session';
  return async (req, res, url) => {
    const method = req.method ?? 'GET',
      path = url.pathname;
    if (url.search) throw new ReadError(400, 'invalid_query');
    if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== config.webOrigin) throw new ReadError(403, 'origin_required');
    if (path === '/v1/auth/challenge' && method === 'POST') {
      const b = await body(req);
      if (!account(b.accountId)) throw new ReadError(400, 'account_required');
      const c = await challenge(pool, config, b.accountId).catch(e => {
        throw e instanceof Error && e.message === 'invalid_account'
          ? new ReadError(400, 'invalid_account')
          : e instanceof Error && e.message === 'challenge_capacity'
            ? new ReadError(503, 'challenge_capacity')
            : e;
      });
      res.setHeader('Set-Cookie', `${challengeCookie}=${c.browser}; Max-Age=300${attrs}`);
      return c.request;
    }
    if (path === '/v1/auth/verify' && method === 'POST') {
      const b = await body(req);
      if (!['id', 'publicKey', 'signature'].every(k => typeof b[k] === 'string')) throw new ReadError(400, 'invalid_login');
      let token: string;
      try {
        token = await login(pool, config, b.id as string, b.publicKey as string, b.signature as string, cookie(req, challengeCookie), checkKey);
      } catch (e) {
        throw e instanceof Error && LOGIN_REJECTIONS.includes(e.message) ? new ReadError(401, 'login_rejected') : new ReadError(503, 'login_unavailable');
      }
      res.setHeader('Set-Cookie', [`${sessionCookie}=${token}; Max-Age=${config.sessionAbsoluteSeconds}${attrs}`, `${challengeCookie}=; Max-Age=0${attrs}`]);
      return { authenticated: true };
    }
    const token = cookie(req, sessionCookie),
      identity = await session(pool, config, token);
    if (path === '/v1/auth/session' && ['GET', 'HEAD'].includes(method)) return { session: identity };
    if (!identity) throw new ReadError(401, 'session_required');
    if (path === '/v1/auth/logout' && method === 'POST') {
      await pool.query('DELETE FROM wallet_sessions WHERE token_hash=$1', [tokenHash(token)]);
      res.setHeader('Set-Cookie', `${sessionCookie}=; Max-Age=0${attrs}`);
      return { authenticated: false };
    }
    if (path === '/v1/auth/logout-all' && method === 'POST') {
      await revokeAllSessions(pool, identity.account_id);
      res.setHeader('Set-Cookie', `${sessionCookie}=; Max-Age=0${attrs}`);
      return { authenticated: false };
    }
    if (path === '/v1/policies/acknowledge' && method === 'POST') {
      if (!policies) throw new ReadError(503, 'policy_hashes_not_configured');
      const b = await body(req);
      if (b.termsHash !== policies.terms || b.privacyHash !== policies.privacy) throw new ReadError(409, 'policy_changed');
      await pool.query(
        "INSERT INTO policy_acknowledgements(account_id,network,terms_hash,privacy_hash,method) VALUES($1,$2,$3,$4,'authenticated_session') ON CONFLICT DO NOTHING",
        [identity.account_id, config.network, policies.terms, policies.privacy],
      );
      return { acknowledged: true, method: 'authenticated_session' };
    }
    const deployment = config.deployment?.id;
    if (!deployment) throw new ReadError(503, 'deployment_not_configured');
    if (path === '/v1/watchlist') {
      if (['GET', 'HEAD'].includes(method))
        return {
          data: (
            await pool.query('SELECT item,created_at FROM wallet_watchlist WHERE deployment_id=$1 AND account_id=$2 ORDER BY created_at,item LIMIT 200', [
              deployment,
              identity.account_id,
            ])
          ).rows,
        };
      if (['PUT', 'DELETE'].includes(method)) {
        const b = await body(req);
        if (typeof b.item !== 'string' || !/^[a-z0-9_.:/-]{1,160}$/.test(b.item)) throw new ReadError(400, 'invalid_watch_item');
        if (method === 'DELETE')
          await pool.query('DELETE FROM wallet_watchlist WHERE deployment_id=$1 AND account_id=$2 AND item=$3', [deployment, identity.account_id, b.item]);
        else {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            await c.query(`SELECT pg_advisory_xact_lock(${LOCK.wallet},hashtext($1))`, [deployment + identity.account_id]);
            const count = (
              await c.query('SELECT count(*)::int AS n FROM wallet_watchlist WHERE deployment_id=$1 AND account_id=$2', [deployment, identity.account_id])
            ).rows[0].n;
            if (count >= 200) throw new ReadError(409, 'watchlist_limit');
            await c.query('INSERT INTO wallet_watchlist(deployment_id,account_id,item) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
              deployment,
              identity.account_id,
              b.item,
            ]);
            await c.query('COMMIT');
          } catch (e) {
            await c.query('ROLLBACK');
            throw e;
          } finally {
            c.release();
          }
        }
        return { saved: true };
      }
    }
    const operation = /^\/v1\/operations\/([^/]+)$/.exec(path);
    if (operation && ['GET', 'HEAD'].includes(method)) {
      if (!isUuid(operation[1]!)) throw new ReadError(404, 'operation_not_found');
      const row = (
        await pool.query('SELECT id,kind,state,transaction_hash,evidence,updated_at FROM user_operations WHERE id=$1 AND deployment_id=$2 AND account_id=$3', [
          operation[1],
          deployment,
          identity.account_id,
        ])
      ).rows[0];
      if (!row) throw new ReadError(404, 'operation_not_found');
      return row;
    }
    throw new ReadError(405, 'method_not_allowed');
  };
}
