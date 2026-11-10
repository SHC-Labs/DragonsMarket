import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { object } from './ingestion/block.js';
import { ReadError } from './read-api.js';
import type { Forwarded } from './agent-gateway.js';
import { accessPath, type AgentRoutes, type Body } from './agent-paths.js';

const MAX_BODY_BYTES = 131072;

const digest = (value: string) => createHash('sha256').update(value).digest();

function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function requestOf(req: IncomingMessage): Promise<Forwarded> {
  let length = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    length += (part as Buffer).length;
    if (length > MAX_BODY_BYTES) throw new ReadError(413, 'body_too_large');
    parts.push(part as Buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(parts).toString());
  if (!object(value) || typeof value.method !== 'string' || typeof value.path !== 'string') {
    throw new ReadError(400, 'invalid_request');
  }
  return value as unknown as Forwarded;
}

function route(routes: AgentRoutes, { method, path, owner, authorization, body }: Forwarded) {
  const read: Body = () => (object(body) ? Promise.resolve(body) : Promise.reject(new ReadError(400, 'invalid_json')));
  if (accessPath.test(path)) return routes.access(method, path, authorization, read);
  if (!owner || typeof owner.account !== 'string' || typeof owner.publicKey !== 'string') {
    throw new ReadError(400, 'invalid_request');
  }
  return routes.owner(method, path, owner, read);
}

export function createAgentWorkerServer(routes: AgentRoutes, token: string, ready?: () => Promise<void>) {
  const expected = digest(`Bearer ${token}`);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/health/ready') {
      try {
        if (!ready) throw new Error('readiness_unconfigured');
        await ready();
        return reply(res, 200, { status: 'ready' });
      } catch { return reply(res, 503, { status: 'not_ready' }); }
    }
    if (req.method !== 'POST' || req.url !== '/internal/agents') throw new ReadError(404, 'not_found');
    if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) throw new ReadError(401, 'unauthorized');
    return reply(res, 200, await route(routes, await requestOf(req)) ?? null);
  };
  return createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof ReadError) return reply(res, error.status, { error: { code: error.code } });
      console.error('The agent worker could not finish a request');
      return reply(res, 500, { error: { code: 'agent_worker_failed' } });
    });
  });
}
