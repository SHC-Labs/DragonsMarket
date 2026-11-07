import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OAuthError, OAuthErrorCode, createMcpHandler, hostHeaderValidationResponse, originValidationResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Backend, BackendRefusal } from './backend.js';
import { readMcpConfig, type McpConfig } from './config.js';
import { TokenBudget } from './token-budget.js';
import { buildServer } from './tools.js';

const TOKEN = /^dmk_[A-Za-z0-9_-]{43}$/;
const MAX_BODY = 64 * 1024;

export function createMcpApp(config: McpConfig, backend: Backend, skill: string, budget = new TokenBudget()) {
  const verifier = {
    verifyAccessToken: (token: string) => {
      if (!TOKEN.test(token)) {
        return Promise.reject(new OAuthError(OAuthErrorCode.InvalidToken, 'Not a Dragons Market access token'));
      }
      if (!budget.allows(token)) {
        return Promise.reject(new OAuthError(OAuthErrorCode.TemporarilyUnavailable, 'Too many requests, try again soon'));
      }
      return backend.session(token).then(session => {
        budget.accepted(token);
        return { token, clientId: session.agentId, scopes: [], expiresAt: session.expiresAt,
          extra: { decimals: session.decimals } };
      }, (error: unknown) => {
        if (error instanceof BackendRefusal && error.status === 401) {
          budget.refused(token);
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is not live');
        }
        throw error;
      });
    },
  };
  const gate = requireBearerAuth({ verifier });
  const handler = createMcpHandler(() => buildServer(backend, skill), { maxRequestBodySize: MAX_BODY });
  const hosts = [config.publicUrl.hostname];
  let readiness: { expires: number; result: Promise<boolean> } | undefined;
  const fetchRequest = async (request: Request) => {
    if (new URL(request.url).pathname === '/health/ready' && ['GET', 'HEAD'].includes(request.method)) {
      if (!readiness || readiness.expires <= Date.now()) {
        const check = { expires: Infinity, result: Promise.resolve(false) };
        check.result = Promise.resolve().then(() => backend.ready()).then(() => true, () => false)
          .finally(() => { check.expires = Date.now() + 2000; });
        readiness = check;
      }
      const ready = await readiness.result;
      return Response.json({ status: ready ? 'ready' : 'not_ready', scope: 'foundation',
        checks: { backend: ready ? 'ok' : 'unavailable' } }, { status: ready ? 200 : 503 });
    }
    return appRequest(request);
  };
  const appRequest = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    // Railway probes use their own Host header. These routes expose health only;
    // MCP and skill requests retain the public-host and origin checks below.
    if (pathname === '/health' && ['GET', 'HEAD'].includes(request.method)) return Response.json({ ok: true });
    const rejected = hostHeaderValidationResponse(request, hosts) ?? originValidationResponse(request, []);
    if (rejected) return rejected;
    if (pathname === '/skill.md' && request.method === 'GET') {
      return new Response(skill, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
    }
    if (pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const auth = await gate(request);
    return auth instanceof Response ? auth : handler.fetch(request, { authInfo: auth });
  };
  return {
    fetch: async (request: Request) => {
      const response = await fetchRequest(request);
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('X-Frame-Options', 'DENY');
      response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      response.headers.set('Referrer-Policy', 'no-referrer');
      if (config.publicUrl.protocol === 'https:') response.headers.set('Strict-Transport-Security', 'max-age=31536000');
      return response;
    },
  };
}

export const loadSkill = () => readFile(new URL('../../skill/SKILL.md', import.meta.url), 'utf8');

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = readMcpConfig(process.env);
    const app = createMcpApp(config, new Backend(config.backendUrl), await loadSkill());
    const node = toNodeHandler(app, { maxRequestBodySize: MAX_BODY });
    const server = createServer((req, res) => void node(req as Parameters<typeof node>[0], res));
    server.requestTimeout = 120000;
    server.listen(config.port, config.host, () => console.log(JSON.stringify({ service: 'mcp', port: config.port, node: process.version, uid: process.getuid?.() })));
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid MCP configuration');
    process.exitCode = 1;
  }
}
