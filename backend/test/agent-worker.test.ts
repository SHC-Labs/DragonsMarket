import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { agentGateway } from '../src/agent-gateway.js';
import { createAgentWorkerServer } from '../src/agent-worker-server.js';
import type { AgentRoutes, Body } from '../src/agent-paths.js';
import { ReadError } from '../src/read-api.js';

const TOKEN = 'w'.repeat(32);
const LINK = { url: 'http://agent-worker.test', token: TOKEN };
const OWNER = { account: 'alice.near', publicKey: 'ed25519:key' };
const OWNER_PATH = `/v1/agents/${'a'.repeat(64)}/actions`;
const noBody: Body = () => Promise.reject(new ReadError(400, 'invalid_json'));

function recording(answer: () => Promise<unknown> = () => Promise.resolve({ ok: true })) {
  const calls: unknown[][] = [];
  const routes: AgentRoutes = {
    owner: (...args) => { calls.push(['owner', ...args.slice(0, 3)]); return args[3]().catch(() => null).then(answer); },
    access: (...args) => { calls.push(['access', ...args.slice(0, 3)]); return args[3]().catch(() => null).then(answer); },
  };
  return { calls, routes };
}

async function withWorker(routes: AgentRoutes, run: (url: string) => Promise<void>, ready?: () => Promise<void>) {
  const server = createAgentWorkerServer(routes, TOKEN, ready);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise(done => { server.close(done); });
  }
}

const post = (url: string, authorization: string | undefined, body: unknown) =>
  fetch(`${url}/internal/agents`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) } });

test('worker readiness follows database availability and exposes no failure details', async () => {
  let available = true;
  await withWorker(recording().routes, async url => {
    assert.equal((await fetch(`${url}/health/ready`)).status, 200);
    available = false;
    const response = await fetch(`${url}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'not_ready' });
    assert.equal((await fetch(`${url}/health`)).status, 200);
  }, async () => { if (!available) throw new Error('private database credential'); });
  await withWorker(recording().routes, async url => {
    assert.equal((await fetch(`${url}/health/ready`)).status, 503);
  });
});

test('the worker acts only for the holder of its token', () => withWorker(recording().routes, async url => {
  const asked = { method: 'POST', path: OWNER_PATH, owner: OWNER, body: {} };
  for (const authorization of [undefined, 'Bearer wrong', `Bearer ${TOKEN}x`, TOKEN, `bearer ${TOKEN}`]) {
    assert.equal((await post(url, authorization, asked)).status, 401, String(authorization));
  }
  assert.equal((await post(url, `Bearer ${TOKEN}`, asked)).status, 200);
  assert.equal((await fetch(`${url}/health`)).status, 200, 'its health check says nothing and needs nothing');
  assert.equal((await fetch(`${url}/internal/agents`)).status, 404);
  assert.equal((await fetch(`${url}/v1/agents`)).status, 404, 'it serves no public route');
}));

test('the worker refuses anything but a well-formed request, and says nothing about a failure', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const auth = `Bearer ${TOKEN}`;
    await withWorker(recording().routes, async url => {
      assert.equal((await post(url, auth, 'not json')).status, 500);
      assert.equal((await post(url, auth, { method: 'POST' })).status, 400);
      assert.equal((await post(url, auth, { method: 'POST', path: OWNER_PATH, body: {} })).status, 400,
        'an owner route names its owner');
      assert.equal((await post(url, auth, { method: 'POST', path: OWNER_PATH, owner: { account: 1 }, body: {} })).status,
        400);
      assert.equal((await post(url, auth, 'x'.repeat(131073))).status, 413);
    });
    await withWorker(recording(() => Promise.reject(new Error('naa_secret in a stack'))).routes, async url => {
      const answer = await post(url, auth, { method: 'POST', path: OWNER_PATH, owner: OWNER, body: {} });
      assert.equal(answer.status, 500);
      assert.deepEqual(await answer.json(), { error: { code: 'agent_worker_failed' } });
    });
    await withWorker(recording(() => Promise.reject(new ReadError(409, 'spend_over_limit'))).routes, async url => {
      const answer = await post(url, auth, { method: 'POST', path: OWNER_PATH, owner: OWNER, body: {} });
      assert.deepEqual([answer.status, await answer.json()], [409, { error: { code: 'spend_over_limit' } }]);
    });
  } finally {
    console.error = quiet;
  }
});

test('the gateway carries the owner, the token and the body through to the same routes', async () => {
  const seen = recording();
  await withWorker(seen.routes, async url => {
    const gateway = agentGateway({ url, token: TOKEN });
    const body: Body = () => Promise.resolve({ key: 'one' });
    assert.deepEqual(await gateway.owner('POST', OWNER_PATH, OWNER, body), { ok: true });
    assert.deepEqual(await gateway.access('GET', '/v1/agent-access/markets', 'Bearer dmk_x', noBody), { ok: true });
    assert.deepEqual(await gateway.access('POST', '/v1/agent-access/actions', undefined, body), { ok: true });
  });
  assert.deepEqual(seen.calls, [['owner', 'POST', OWNER_PATH, OWNER],
    ['access', 'GET', '/v1/agent-access/markets', 'Bearer dmk_x'],
    ['access', 'POST', '/v1/agent-access/actions', undefined]]);
});

test('a route that takes no body still works, and a body too large stops at the API', async () => {
  const seen = recording();
  await withWorker(seen.routes, async url => {
    const gateway = agentGateway({ url, token: TOKEN });
    assert.deepEqual(await gateway.owner('POST', OWNER_PATH, OWNER, noBody), { ok: true });
    await assert.rejects(gateway.owner('POST', OWNER_PATH, OWNER, () => Promise.reject(new ReadError(413, 'body_too_large'))),
      (e: unknown) => e instanceof ReadError && e.status === 413);
  });
  assert.equal(seen.calls.length, 1, 'nothing is forwarded for a body the API refused');
});

test('the worker\'s refusal is the API\'s refusal, and an unreadable worker fails closed', async () => {
  const answers: [() => Response, number, string][] = [
    [() => Response.json({ error: { code: 'daily_limit_reached' } }, { status: 409 }), 409, 'daily_limit_reached'],
    [() => Response.json({ error: { code: 'rounds_not_configured' } }, { status: 503 }), 503, 'rounds_not_configured'],
    [() => Response.json({ error: { code: 'Not A Code' } }, { status: 409 }), 502, 'agent_api_unavailable'],
    [() => Response.json({}, { status: 401 }), 502, 'agent_api_unavailable'],
    [() => new Response('<html>', { status: 200 }), 502, 'agent_api_unavailable'],
    [() => new Response('<html>', { status: 502 }), 502, 'agent_api_unavailable'],
  ];
  for (const [answer, status, code] of answers) {
    const gateway = agentGateway(LINK, async () => answer());
    await assert.rejects(gateway.access('GET', '/v1/agent-access/agent', 'Bearer x', noBody),
      (e: unknown) => e instanceof ReadError && e.status === status && e.code === code, code);
  }
  const down = agentGateway(LINK, async () => { throw new Error('connect ECONNREFUSED'); });
  await assert.rejects(down.owner('GET', OWNER_PATH, OWNER, noBody),
    (e: unknown) => e instanceof ReadError && e.status === 502 && e.code === 'agent_api_unavailable',
    'with the worker down the page says so, and a client retries under the same key');
});

test('the gateway sends the service token, and follows no redirect', async () => {
  let init: RequestInit | undefined, url = '';
  const gateway = agentGateway(LINK, async (input, options) => {
    url = String(input);
    init = options;
    return Response.json({ ok: true });
  });
  await gateway.owner('GET', OWNER_PATH, OWNER, noBody);
  assert.equal(url, 'http://agent-worker.test/internal/agents');
  assert.equal(init?.redirect, 'error');
  assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
});

test('oversized, invalid UTF-8 and interrupted worker replies fail without leaking their body', async () => {
  const responses = [new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    new Response(new Uint8Array([0xff])),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error('private upstream detail')); } }))];
  for (const response of responses) {
    const gateway = agentGateway(LINK, async () => response);
    await assert.rejects(gateway.access('GET', '/v1/agent-access/agent', 'Bearer x', noBody),
      (error: unknown) => error instanceof ReadError && error.status === 502 && error.code === 'agent_api_unavailable');
  }
});

async function reachable(entry: string, sources: string) {
  const seen = new Set<string>(), packages = new Set<string>(), queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, 'utf8');
    for (const [, kind, from] of text.matchAll(/^(?:import|export)\s+(type\s+)?(?:[^;']*?from\s+)?'([^']+)'/gm)) {
      if (kind) continue;
      if (from!.startsWith('.')) queue.push(resolve(dirname(file), from!.replace(/\.js$/, '.ts')));
      else packages.add(from!);
    }
  }
  return { files: [...seen].map(file => file.slice(sources.length + 1)), packages: [...packages] };
}

test('nothing the API process runs can reach the partner key, a grant or the Agent API', async () => {
  const sources = resolve('src'), { files, packages } = await reachable(resolve('src/main.ts'), sources);
  assert.ok(files.includes('agent-gateway.ts'), 'the walk followed the real imports');
  for (const privileged of ['agent-api.ts', 'agent-grants.ts', 'agent-accounts.ts', 'agent-access.ts', 'agents.ts',
    'agent-routes.ts', 'agent-worker-config.ts', 'operations.ts']) {
    assert.ok(!files.includes(privileged), `the API process must not load ${privileged}`);
  }
  assert.ok(!packages.includes('@near-intents-agent-api/sdk'), 'the API process does not load the Agent API SDK');
});

test('the worker\'s secrets stay in the worker\'s environment', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  const service = (name: string) => compose.slice(compose.indexOf(`\n  ${name}:\n`),
    compose.indexOf('\n  ', compose.indexOf('restart:', compose.indexOf(`\n  ${name}:\n`))));
  for (const secret of ['AGENT_API_KEY', 'AGENT_GRANT_KEY']) {
    assert.ok(!compose.includes(secret), `no service is handed ${secret} from the shared environment`);
  }
  assert.ok(service('agent-worker').includes('.env.agent-worker'));
  assert.ok(!service('api').includes('.env.agent-worker'));
  assert.ok(!service('agent-worker').includes('ports:'), 'the worker publishes no port');
});
