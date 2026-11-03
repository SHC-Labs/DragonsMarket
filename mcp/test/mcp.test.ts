import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Backend } from '../src/backend.js';
import { readMcpConfig } from '../src/config.js';
import { createMcpApp, loadSkill } from '../src/server.js';
import { fromUnits, toUnits } from '../src/units.js';

type Json = Record<string, unknown>;
const TOKEN = `dmk_${'a'.repeat(43)}`;
const AGENT_ID = 'c'.repeat(64);

function fakeBackend() {
  const seen: { method: string; path: string; auth: string | undefined; body: Json | null }[] = [];
  const state: { revoked: boolean; cut: boolean; answer: { status: number; body: unknown } } =
    { revoked: false, cut: false, answer: { status: 200, body: { operation: 'o1', state: 'confirmed', evidence: {} } } };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Json : null;
    const path = (req.url ?? '').replace('/v1/agent-access/', '');
    seen.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (state.revoked || req.headers.authorization !== `Bearer ${TOKEN}`) {
      return reply(401, { error: { code: 'access_token_invalid' } });
    }
    if (path === 'session') {
      return reply(200, { agent_id: AGENT_ID, label: 'Claude', expires_at: '2099-01-01T00:00:00.000Z',
        collateral: { token_id: 'nep141:usdc.test.near', decimals: 6 } });
    }
    if (path === 'agent') {
      return reply(200, { agent_id: AGENT_ID, near_account_id: 'd'.repeat(64), frozen: false,
        authorized_until: '2099-01-01T00:00:00.000Z', collateral: { token_id: 'nep141:usdc.test.near', decimals: 6 },
        balances: { near_for_gas: '150000000000000000000000', rounds_available: '12500000',
          rounds_pending_withdrawals: '0', intents: '3000000', registered_with_rounds: true, open_stakes: 1 },
        limits: { max_stake: '5000000', daily_limit: '20000000', staked_today: '7500000',
          expires_at: '2099-01-01T00:00:00.000Z' } });
    }
    if (path === 'rounds') {
      return reply(200, { rules: { min_stake: '100000', paused: false, max_open_stakes: 20 },
        series: [{ series: 0, asset: 'BTC/USD', next_round: '7' }] });
    }
    if (path === 'quote') return reply(200, { ...body, shares: '4950000' });
    if (path === 'actions' && state.cut) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.flushHeaders();
      res.write('{"operation":');
      setTimeout(() => res.socket?.destroy(), 100);
      return;
    }
    if (path === 'actions') return reply(state.answer.status, state.answer.body);
    if (path === 'operations') return reply(200, { data: [] });
    return reply(404, { error: { code: 'not_found' } });
  });
  return { server, seen, state };
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function withMcp(run: (h: { base: string; client: Client; fake: ReturnType<typeof fakeBackend> }) =>
  Promise<void>) {
  const fake = fakeBackend(), backendUrl = await listen(fake.server);
  const config = readMcpConfig({ DRAGONS_API_URL: backendUrl, MCP_PUBLIC_URL: 'http://127.0.0.1:1' });
  const node = toNodeHandler(createMcpApp(config, new Backend(config.backendUrl), await loadSkill()));
  const mcp = createServer((req, res) => void node(req as Parameters<typeof node>[0], res));
  const base = await listen(mcp);
  const client = new Client({ name: 'dragons-market-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    await run({ base, client, fake });
  } finally {
    await client.close();
    mcp.close();
    fake.server.close();
  }
}

function raw(base: string, path: string, headers: Record<string, string>, body = '') {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, fail) => {
    const url = new URL(path, base);
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } },
    res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers,
        body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

const text = (result: unknown) => {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map(c => c.text ?? '').join('');
};
const structured = (result: unknown) => (result as { structuredContent?: Json }).structuredContent ?? {};

test('amounts convert exactly between decimals and atomic units, with no floats', () => {
  assert.equal(toUnits('5', 6), '5000000');
  assert.equal(toUnits('2.5', 6), '2500000');
  assert.equal(toUnits('0.000001', 6), '1');
  for (const bad of ['0', '0.0', '1.0000001', '-1', '1e6', '', ' 1', '1.']) {
    assert.throws(() => toUnits(bad, 6), bad);
  }
  assert.equal(fromUnits('12500000', 6), '12.5');
  assert.equal(fromUnits('1', 6), '0.000001');
  assert.equal(fromUnits('0', 6), '0');
  assert.equal(fromUnits('150000000000000000000000', 24), '0.15');
  assert.equal(fromUnits('not a number', 6), null);
});

test('the MCP server takes only https origins and keeps the backend on a private address', () => {
  const ok = { DRAGONS_API_URL: 'http://backend.railway.internal', MCP_PUBLIC_URL: 'https://mcp.example.com' };
  assert.equal(readMcpConfig(ok).backendUrl, 'http://backend.railway.internal');
  for (const [name, value] of [['DRAGONS_API_URL', 'http://backend.example.com'],
    ['DRAGONS_API_URL', 'https://user:pass@backend.example.com'], ['MCP_PUBLIC_URL', 'http://mcp.example.com'],
    ['MCP_PUBLIC_URL', 'https://mcp.example.com/path'], ['MCP_PUBLIC_URL', 'not a url']]) {
    assert.throws(() => readMcpConfig({ ...ok, [name!]: value }), new RegExp(name!), `${name}=${value}`);
  }
});

test('the skill is served openly, and /mcp needs a live Dragons Market token on this host only', () =>
  withMcp(async ({ base, fake }) => {
    const skill = await raw(base, '/skill.md', {});
    assert.equal(skill.status, 200);
    assert.match(String(skill.headers['content-type']), /text\/markdown/);
    assert.match(skill.body, /^---\nname: dragons-market\n/);
    assert.equal((await raw(base, '/elsewhere', {})).status, 404);
    const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    const anonymous = await raw(base, '/mcp', {}, initialize);
    assert.equal(anonymous.status, 401);
    assert.match(String(anonymous.headers['www-authenticate']), /^Bearer/);
    assert.equal((await raw(base, '/mcp', { Authorization: 'Bearer ngt_wrong-kind' }, initialize)).status, 401);
    const before = fake.seen.length;
    assert.equal((await raw(base, '/mcp', { Authorization: 'Bearer nope' }, initialize)).status, 401);
    assert.equal(fake.seen.length, before, 'a malformed token never reaches the backend');
    assert.equal((await raw(base, '/mcp', { Authorization: `Bearer ${TOKEN}`, Host: 'evil.example' }, initialize))
      .status, 403);
    assert.equal((await raw(base, '/mcp', { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' },
      initialize)).status, 403, 'a browser page cannot drive it');
    fake.state.revoked = true;
    assert.equal((await raw(base, '/mcp', { Authorization: `Bearer ${TOKEN}` }, initialize)).status, 401,
      'a revoked token stops at once');
  }));

test('an agent reads its account and the rounds, with amounts in the token and its limits left', () =>
  withMcp(async ({ client }) => {
    assert.match(client.getInstructions() ?? '', /request_id/);
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(tools, ['cash_out', 'claim', 'get_agent', 'list_operations', 'list_rounds', 'quote_stake',
      'stake', 'withdraw']);
    const agent = structured(await client.callTool({ name: 'get_agent', arguments: {} }));
    assert.deepEqual(agent.balances, { rounds_available: '12.5', rounds_pending_withdrawals: '0', intents: '3',
      near_for_gas: '0.15', open_stakes: 1, registered_with_rounds: true });
    assert.deepEqual([(agent.limits as Json).max_stake, (agent.limits as Json).left_last_24h], ['5', '12.5']);
    const rounds = structured(await client.callTool({ name: 'list_rounds', arguments: {} }));
    assert.deepEqual((rounds.rules as Json).min_stake, '0.1');
    const skill = await client.readResource({ uri: 'dragons-market://skill' });
    assert.match(String((skill.contents[0] as { text?: string }).text), /## request_id/);
    const prompt = await client.getPrompt({ name: 'trade-rounds' });
    assert.match(JSON.stringify(prompt.messages), /dragons-market/);
  }));

test('a stake goes out once, as quoted, under the agent\'s request id, and settling is never a failure', () =>
  withMcp(async ({ client, fake }) => {
    const quoted = structured(await client.callTool({ name: 'quote_stake',
      arguments: { series: 0, round: '7', side: 'up', amount: '5' } }));
    assert.deepEqual([quoted.shares, quoted.min_shares], ['4950000', '4900500']);
    assert.deepEqual(fake.seen.at(-1)!.body, { series: 0, round: '7', side: 'up', amount: '5000000' });
    const staked = structured(await client.callTool({ name: 'stake', arguments: { request_id: 'stake-round-7',
      series: 0, round: '7', side: 'up', amount: '5', min_shares: quoted.min_shares } }));
    assert.equal(staked.outcome, 'done');
    const sent = fake.seen.at(-1)!;
    assert.deepEqual([sent.method, sent.path, sent.auth], ['POST', 'actions', `Bearer ${TOKEN}`]);
    assert.deepEqual(sent.body, { request_id: 'stake-round-7', action: { kind: 'stake', series: 0, round: '7',
      side: 'up', amount: '5000000', minShares: '4900500' } });

    fake.state.answer = { status: 200, body: { operation: 'o2', state: 'submitted', evidence: {} } };
    const settling = structured(await client.callTool({ name: 'cash_out',
      arguments: { request_id: 'cash-out-0001', amount: '3' } }));
    assert.equal(settling.outcome, 'settling');
    assert.match(String(settling.next), /same request_id/);
    assert.deepEqual(fake.seen.at(-1)!.body, { request_id: 'cash-out-0001',
      action: { kind: 'cash_out', amount: '3000000' } });

    fake.state.answer = { status: 409, body: { error: { code: 'daily_limit_reached' } } };
    const limited = await client.callTool({ name: 'stake', arguments: { request_id: 'stake-round-8', series: 0,
      round: '7', side: 'up', amount: '5', min_shares: '1' } });
    assert.equal((limited as { isError?: boolean }).isError, true);
    assert.match(text(limited), /^daily_limit_reached: /);
    assert.equal(structured(limited).retry_same_request_id, false);
    fake.state.answer = { status: 502, body: { error: { code: 'agent_api_unavailable' } } };
    const down = await client.callTool({ name: 'withdraw', arguments: { request_id: 'withdraw-0001', amount: '1' } });
    assert.equal(structured(down).retry_same_request_id, true, 'an outage may follow a send');

    const actions = () => fake.seen.filter(r => r.path === 'actions').length, before = actions();
    const tooPrecise = await client.callTool({ name: 'stake', arguments: { request_id: 'stake-round-9', series: 0,
      round: '7', side: 'up', amount: '1.0000001', min_shares: '1' } });
    assert.equal((tooPrecise as { isError?: boolean }).isError, true);
    assert.equal(actions(), before, 'an amount the token cannot hold is never sent');
    const badId = await client.callTool({ name: 'claim', arguments: { request_id: 'x', series: 0, round: '7' } });
    assert.equal((badId as { isError?: boolean }).isError, true);
    assert.equal(actions(), before);
  }));

test('an action stopped for a check is never retried, and an answer cut off is retried under the same id', () =>
  withMcp(async ({ client, fake }) => {
    fake.state.answer = { status: 200, body: { operation: 'o3', state: 'reconcile',
      evidence: { reason: 'failure_unproven' } } };
    const stopped = structured(await client.callTool({ name: 'stake', arguments: { request_id: 'stake-round-10',
      series: 0, round: '7', side: 'up', amount: '5', min_shares: '1' } }));
    assert.equal(stopped.outcome, 'needs_owner');
    assert.match(String(stopped.next), /Do not retry/);
    assert.match(client.getInstructions() ?? '', /needs_owner/);
    fake.state.cut = true;
    const cut = await client.callTool({ name: 'claim', arguments: { request_id: 'claim-round-7', series: 0,
      round: '7' } });
    assert.equal((cut as { isError?: boolean }).isError, true);
    assert.deepEqual(structured(cut), { error: 'backend_unavailable', retry_same_request_id: true },
      'an answer cut off mid-body may follow a send');
  }));
