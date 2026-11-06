import { isPrivateRoute, type PrivateHandler } from './private-api.js';
import { isAgentAccessRoute } from './agent-paths.js';
import { createServer, type IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { publicConfig } from './config.js';
import { isReadRoute, ReadError, type ReadHandler } from './read-api.js';

const WINDOW_MS = 60000;
const REQUESTS_PER_WINDOW = 120;
const ACCESS_REQUESTS_PER_WINDOW = 6000;
const REQUESTS_PER_ACCESS_TOKEN = 120;
const CHALLENGES_PER_WINDOW = 5;
const MAX_TRACKED_CLIENTS = 10000;

const digest = (value: string) => createHash('sha256').update(value).digest();
/** Compares through fixed-length digests so neither the token's content nor its length shows in the timing. */
export function operatorAuthorized(configured: string | null, header: string | undefined): boolean {
  const supplied = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
  const matches = timingSafeEqual(digest(supplied), digest(configured ?? ''));
  return configured !== null && matches;
}

export interface ServiceStatus {
  alerts: string[];
}
export type ServiceStatusReader = () => Promise<ServiceStatus>;

type Counters = Map<string, { start: number; count: number }>;
/** Counts a hit in the client's current window and says whether it is still within `max`. The oldest entry is dropped when the map is full. */
function withinLimit(counters: Counters, client: string, max: number, now: number): boolean {
  const entry = counters.get(client);
  if (!entry || now - entry.start >= WINDOW_MS) {
    if (counters.size >= MAX_TRACKED_CLIENTS) counters.delete(counters.keys().next().value!);
    counters.set(client, { start: now, count: 1 });
    return true;
  }
  return ++entry.count <= max;
}

function pathOf(url: string | undefined) {
  if ((url?.length ?? 0) > 8192) return null;
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

// An IPv6 client usually holds a whole /64, so each address in it would otherwise get a fresh budget.
// Challenges are limited per /48 as well, because a single IPv6 allocation holds thousands of /64s to rotate through.
export function challengeKey(key: string): string {
  return key.endsWith('::/64') ? key.split(':').slice(0, 3).join(':') + '::/48' : key;
}

export function limitKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIP(address) !== 6) return address;
  const [head = '', tail = ''] = address.split('::');
  const first = head ? head.split(':') : [];
  const last = address.includes('::') && tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last] : first;
  return (
    groups
      .slice(0, 4)
      .map(group => group.toLowerCase().padStart(4, '0'))
      .join(':') + '::/64'
  );
}

export function trustedProxyList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

// X-Forwarded-For is read only when the connection comes from a configured proxy, and then only the entry that proxy appended.
// Entries to its left are client-controlled. Anyone else connecting directly is limited by the socket address.
function clientAddress(req: IncomingMessage, hops: number, proxies: BlockList): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const bare = peer.replace(/^::ffff:/i, '');
  const family = isIP(bare) === 6 ? 'ipv6' : 'ipv4';
  if (hops > 0 && isIP(bare) && proxies.check(bare, family)) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
    const candidate = forwarded[forwarded.length - hops];
    if (candidate && isIP(candidate)) return limitKey(candidate);
  }
  return limitKey(peer);
}

function logFailure(requestId: string, where: string, error: unknown) {
  console.error(JSON.stringify({ service: 'api', requestId, where, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
}

export function createApp(
  config: Config,
  ready: () => Promise<void>,
  indexerStatus: () => Promise<unknown> = async () => ({ state: 'not_configured', live: false }),
  read?: ReadHandler,
  privateRead?: PrivateHandler,
  serviceStatus?: ServiceStatusReader,
) {
  const limits: Counters = new Map(),
    challengeLimits: Counters = new Map(),
    tokenLimits: Counters = new Map();
  const proxies = trustedProxyList(config.trustedProxyAddresses);
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Vary', 'Origin');
    if (req.headers.origin === config.webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.webOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    const reply = (status: number, body: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    const client = clientAddress(req, config.trustedProxyHops, proxies);
    const now = Date.now();
    const privatePath = pathOf(req.url);
    const access = privatePath !== null && isAgentAccessRoute(privatePath);
    const token = access ? createHash('sha256').update(String(req.headers.authorization)).digest('hex') : '';
    if (
      !withinLimit(limits, client, access ? ACCESS_REQUESTS_PER_WINDOW : REQUESTS_PER_WINDOW, now) ||
      (access && !withinLimit(tokenLimits, token, REQUESTS_PER_ACCESS_TOKEN, now))
    ) {
      res.setHeader('Retry-After', '60');
      reply(429, { error: { code: 'rate_limited', requestId } });
      return;
    }
    if (privatePath === null) {
      reply(400, { error: { code: 'invalid_url', requestId } });
      return;
    }
    if (privatePath === '/v1/auth/challenge' && !withinLimit(challengeLimits, challengeKey(client), CHALLENGES_PER_WINDOW, now)) {
      reply(429, { error: { code: 'challenge_rate_limited', requestId } });
      return;
    }
    if (req.method === 'OPTIONS' && isPrivateRoute(privatePath)) {
      if (req.headers.origin !== config.webOrigin) {
        reply(403, { error: { code: 'origin_required', requestId } });
        return;
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      reply(204, null);
      return;
    }
    if (isPrivateRoute(privatePath) && privateRead) {
      try {
        const url = new URL(req.url!, 'http://localhost');
        reply(200, await privateRead(req, res, url));
      } catch (e) {
        if (!(e instanceof ReadError) || e.status >= 500) logFailure(requestId, 'private', e);
        reply(e instanceof ReadError ? e.status : 503, { error: { code: e instanceof ReadError ? e.code : 'private_service_unavailable', requestId } });
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method ?? '')) {
      res.setHeader('Allow', 'GET, HEAD');
      reply(405, { error: { code: 'method_not_allowed', requestId } });
      return;
    }
    let path: string;
    let url: URL;
    try {
      if ((req.url?.length ?? 0) > 8192) throw new Error();
      url = new URL(req.url ?? '/', 'http://localhost');
      path = url.pathname;
    } catch {
      reply(400, { error: { code: 'invalid_url', requestId } });
      return;
    }
    if (path === '/health/live') {
      reply(200, { status: 'ok' });
      return;
    }
    if (path === '/v1/config') {
      reply(200, publicConfig(config));
      return;
    }
    if (path === '/v1/indexer/status') {
      try {
        reply(200, await indexerStatus());
      } catch (error) {
        logFailure(requestId, 'indexer_status', error);
        reply(503, { error: { code: 'indexer_status_unavailable', requestId } });
      }
      return;
    }
    if (path === '/health/ready') {
      try {
        await ready();
        reply(200, {
          status: 'ready',
          checks: { database: 'ok', schema: 'current' },
          deploymentConfigured: config.deployment !== null,
          scope: 'foundation',
          indexing: config.deployment ? 'see_indexer_status' : 'deployment_not_configured',
        });
      } catch (error) {
        logFailure(requestId, 'ready', error);
        reply(503, { status: 'not_ready', error: { code: 'database_or_configuration_unavailable', requestId } });
      }
      return;
    }
    if (path === '/v1/health/services' || path === '/v1/operator/services') {
      const detailed = path === '/v1/operator/services';
      if (detailed && !operatorAuthorized(config.operatorToken, req.headers.authorization)) {
        reply(404, { error: { code: 'not_found', requestId } });
        return;
      }
      if (url.search) {
        reply(400, { error: { code: 'invalid_query', requestId } });
        return;
      }
      try {
        if (!serviceStatus) throw new Error('service_status_not_configured');
        const status = await serviceStatus();
        reply(200, detailed ? status : { status: status.alerts.length ? 'degraded' : 'ok' });
      } catch (error) {
        logFailure(requestId, 'services', error);
        reply(503, { error: { code: 'health_unavailable', requestId } });
      }
      return;
    }
    if (isReadRoute(path)) {
      try {
        if (!read) throw new ReadError(503, 'read_api_unavailable');
        reply(200, await read(url));
      } catch (error) {
        if (!(error instanceof ReadError) || error.status >= 500) logFailure(requestId, 'read', error);
        reply(error instanceof ReadError ? error.status : 503, {
          error: { code: error instanceof ReadError ? error.code : 'read_api_unavailable', requestId },
        });
      }
      return;
    }
    reply(404, { error: { code: 'not_found', requestId } });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
