import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import type { Config } from './config.js';
import { isUuid, revokeAllSessions, session, tokenHash, type CheckAccessKey } from './auth.js';
import { challengeFor, isAuthChallenge, isAuthVerify, verifyLogin } from './auth-http.js';
import { ReadError } from './read-api.js';
import { LOCK } from './locks.js';
import { isAgentAccessRoute, isAgentRoute, type AgentRoutes } from './agent-paths.js';
import { allowOwnerRoute, sessionAgentOwner } from './agent-owner.js';
export const isPrivateRoute = (p: string) =>
  p.startsWith('/v1/auth/') || p === '/v1/watchlist' || p === '/v1/policies/acknowledge' || /^\/v1\/operations\/[^/]+$/.test(p) ||
  isAgentRoute(p) || isAgentAccessRoute(p);
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
export async function body(req: IncomingMessage, limit = 16384) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ReadError(415, 'json_required');
  let length = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    length += part.length;
    if (length > limit) throw new ReadError(413, 'body_too_large');
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
  agents: AgentRoutes | null = null,
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
    if (isAgentAccessRoute(path)) {
      if (!agents || !config.deployment) throw new ReadError(503, 'agents_not_configured');
      if (req.headers.origin !== undefined || req.headers.cookie !== undefined) throw new ReadError(403, 'server_to_server_only');
      return agents.access(method, path, req.headers.authorization, () => body(req));
    }
    if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== config.webOrigin) throw new ReadError(403, 'origin_required');
    if (isAuthChallenge(path) && method === 'POST') {
      const c = await challengeFor(pool, config, path, await body(req));
      res.setHeader('Set-Cookie', `${challengeCookie}=${c.browser}; Max-Age=300${attrs}`);
      return c.request;
    }
    if (isAuthVerify(path) && method === 'POST') {
      const token = await verifyLogin(pool, config, {
        path, body: await body(req), browser: cookie(req, challengeCookie),
      }, checkKey);
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
    if (isAgentRoute(path)) {
      const owner = sessionAgentOwner(identity);
      allowOwnerRoute(owner, method, path);
      if (!agents) throw new ReadError(503, 'agents_not_configured');
      return agents.owner(method, path, owner, () => body(req, 65536));
    }
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
