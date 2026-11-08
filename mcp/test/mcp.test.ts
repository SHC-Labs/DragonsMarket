import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Backend } from '../src/backend.js';
import { readMcpConfig } from '../src/config.js';
import { createMcpApp, createMcpHttpServer, loadSkill } from '../src/server.js';
import { clientKey } from '../src/client-address.js';
import { TokenBudget } from '../src/token-budget.js';
import { fromUnits, toUnits } from '../src/units.js';

type Json = Record<string, unknown>;
const TOKEN = `dmk_${'a'.repeat(43)}`;
const AGENT_ID = 'c'.repeat(64);

function fakeBackend() {
  const seen: { method: string; path: string; auth: string | undefined; body: Json | null }[] = [];
  const state: { revoked: boolean; cut: boolean; shares: string; collateral: string;
    answer: { status: number; body: unknown } } = { revoked: false, cut: false, shares: '4000000', collateral: '2000000',
    answer: { status: 200, body: { operation: 'o1', state: 'confirmed', evidence: {} } } };
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
          rounds_pending_withdrawals: '0', intents: '3000000', registered_with_rounds: true, open_stakes: 1,
          market_available: '6000000', market_pending_withdrawals: '0', registered_with_market: true, positions: 2 },
        limits: { max_spend: '5000000', daily_limit: '20000000', spent_today: '7500000',
          expires_at: '2099-01-01T00:00:00.000Z' } });
    }
    if (path === 'markets') {
      return reply(200, { rules: { fee_rate_bps: 200, paused: false, sells_paused: false },
        markets: [{ market: '7', title: 'Will it rain?', rule: 'If it rains.', resolution_source: 'https://x.test',
          category: 'world', closes_at: '2030-01-01T00:00:00.000Z', price_yes: '620000', price_no: '380000',
          locked: '1500000' }] });
    }
    if (path === 'positions') {
      return reply(200, { data: [{ market_id: '7', yes: '4000000', no: '0', status: 'resolved', outcome: 'yes',
        redeemable: '6250000' }] });
    }
    if (path === 'quote-buy') return reply(200, { ...body, shares: state.shares, fee: '100000' });
    if (path === 'quote-sell') return reply(200, { ...body, collateral: state.collateral, fee: '40000' });
    if (path === 'rounds') {
      return reply(200, { rules: { min_stake: '100000', paused: false, max_open_stakes: 20 },
        series: [{ series: 0, asset: 'BTC/USD', round: '7', opens_at: '2030-01-01T00:00:00.000Z',
          closes_at: '2030-01-01T00:02:30.000Z', taking_stakes: false }] });
    }
    if (path === 'claimable') {
      return reply(200, { data: [{ series: 0, round: '6', side: 'up', amount: '5000000', outcome: 'up' }] });
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
  Promise<void>, budget?: TokenBudget) {
  const fake = fakeBackend(), backendUrl = await listen(fake.server);
  const config = readMcpConfig({ DRAGONS_API_URL: backendUrl, MCP_PUBLIC_URL: 'http://127.0.0.1:1' });
  const mcp = createMcpHttpServer(config, new Backend(config.backendUrl), await loadSkill(), budget);
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

test('MCP readiness verifies backend schema, uses no credentials, and rejects bad answers', async () => {
  const healthy = { status: 'ready', checks: { database: 'ok', schema: 'current' }, deploymentConfigured: false };
  await new Backend('https://api.example.com', async (url, init) => {
    assert.equal(url, 'https://api.example.com/health/ready');
    assert.equal(init?.headers, undefined);
    assert.equal(init?.redirect, 'error');
    return Response.json(healthy);
  }).ready();
  for (const response of [Response.json(healthy, { status: 503 }), Response.json({ ok: true }),
    Response.json({ ...healthy, checks: { database: 'ok', schema: 'outdated' } }),
    new Response('not json'), new Response('x'.repeat((1 << 20) + 1))]) {
    await assert.rejects(new Backend('https://api.example.com', async () => response).ready(), /backend_unavailable/);
  }
  await assert.rejects(new Backend('https://api.example.com', async () => { throw new Error('private details'); }).ready(),
    error => error instanceof Error && error.message === 'backend_unavailable');
});

test('MCP readiness coalesces probes, caches failures, recovers, and keeps liveness independent', async () => {
  let probes = 0, available = false;
  const backend = new Backend('https://api.example.com', async () => {
    probes++;
    if (!available) throw new Error('database credentials must never appear in health output');
    return Response.json({ status: 'ready', checks: { database: 'ok', schema: 'current' } });
  });
  const app = createMcpApp(readMcpConfig({ DRAGONS_API_URL: 'https://api.example.com', MCP_PUBLIC_URL: 'https://mcp.example.com' }), backend, 'skill');
  const probe = () => app.fetch(new Request('https://healthcheck.railway.app/health/ready'));
  const responses = await Promise.all(Array.from({ length: 20 }, probe));
  assert.equal(probes, 1);
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.deepEqual(await response.json(), { status: 'not_ready', scope: 'foundation', checks: { backend: 'unavailable' } });
  }
  assert.equal((await app.fetch(new Request('https://healthcheck.railway.app/health'))).status, 200);
  available = true;
  assert.equal((await probe()).status, 503, 'failure is cached briefly to protect the API');
  assert.equal(probes, 1);
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal((await probe()).status, 200);
  assert.equal(probes, 2);
});

test('the skill is served openly, and /mcp needs a live Dragons Market token on this host only', () =>
  withMcp(async ({ base, fake }) => {
    assert.equal((await raw(base, '/health', { Host: 'healthcheck.railway.app' })).status, 200);
    assert.equal((await raw(base, '/mcp', { Host: 'healthcheck.railway.app' })).status, 403);
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

test('made-up tokens stop at their budget, and an agent already connected keeps working', () =>
  withMcp(async ({ base, client, fake }) => {
    const sessions = () => fake.seen.filter(s => s.path === 'session').length;
    const attempt = (n: number) =>
      raw(base, '/mcp', { Authorization: `Bearer dmk_${String(n).padStart(43, 'b')}` }, '{}');
    assert.equal((await attempt(1)).status, 401);
    assert.equal((await attempt(2)).status, 401);
    const before = sessions(), late = await attempt(3);
    assert.equal(late.status, 429);
    assert.equal(late.headers['retry-after'], '60');
    assert.match(late.body, /temporarily_unavailable/);
    assert.equal(sessions(), before, 'past the budget a made-up token never reaches the backend');
    const agent = structured(await client.callTool({ name: 'get_agent', arguments: {} }));
    assert.equal(agent.agent_id, AGENT_ID);
  }, new TokenBudget({ newPerWindow: 3 })));

test('the token budget refills each minute, and a real token cannot flood the server either', () => {
  let now = 1000;
  const budget = new TokenBudget({ newPerWindow: 1, perToken: 2, now: () => now });
  const allows = (token: string) => { const release = budget.acquire(token, 'client'); release?.(); return !!release; };
  assert.equal(allows('one'), true);
  assert.equal(allows('two'), false);
  budget.accepted('good');
  assert.equal(allows('good'), true, 'a known token spends none of the new tokens\' budget');
  assert.equal(allows('good'), false, 'and it has a limit of its own');
  budget.refused('good');
  assert.equal(allows('good'), false, 'a revoked token is new again');
  now += 60000;
  assert.equal(allows('three'), true);
  budget.accepted('good');
  assert.equal(allows('good'), true);
});

test('fresh-token floods are isolated at the HTTP peer boundary, including trusted proxies', async () => {
  for (const trusted of [false, true]) {
    const fake = fakeBackend(), backendUrl = await listen(fake.server);
    const config = readMcpConfig({ DRAGONS_API_URL: backendUrl, MCP_PUBLIC_URL: 'http://127.0.0.1',
      ...(trusted ? { MCP_TRUSTED_PROXY_ADDRESSES: '127.0.0.1/32' } : {}) });
    const mcp = createMcpHttpServer(config, new Backend(backendUrl), 'skill', new TokenBudget({ newPerWindow: 2 }));
    const base = await listen(mcp);
    const attempt = (token: string, ip: string) => raw(base, '/mcp', {
      Authorization: `Bearer ${token}`, 'X-Real-IP': ip, 'X-Forwarded-For': ip,
    }, '{}');
    try {
      for (const token of ['b', 'c']) assert.equal((await attempt(`dmk_${token.repeat(43)}`, '198.51.100.1')).status, 401);
      assert.equal((await attempt(`dmk_${'d'.repeat(43)}`, '198.51.100.1')).status, 429);
      const before = fake.seen.length;
      const response = await attempt(TOKEN, '203.0.113.2');
      if (trusted) {
        assert.notEqual(response.status, 429, 'first-ever legitimate token from another caller is admitted');
        assert.equal(fake.seen.length, before + 1);
        assert.equal(fake.seen.at(-1)?.auth, `Bearer ${TOKEN}`);
        fake.state.revoked = true;
        assert.equal((await attempt(TOKEN, '203.0.113.2')).status, 401, 'accepted tokens are still checked for revocation');
        assert.equal((await attempt(TOKEN, '203.0.113.2, 203.0.113.3')).status, 503);
      } else {
        assert.equal(response.status, 429, 'spoofed forwarding headers cannot mint another peer budget');
        assert.equal(fake.seen.length, before);
      }
    } finally { mcp.close(); fake.server.close(); }
  }
});

test('caller identities normalize IPv6 aliases, mapped IPv4, and privacy addresses', () => {
  assert.equal(clientKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(clientKey('0:0:0:0:0:ffff:c000:0201'), '192.0.2.1');
  assert.equal(clientKey('2001:DB8:0:1::1'), clientKey('2001:db8:0000:0001:1234::ffff'));
  assert.notEqual(clientKey('2001:db8:0:1::1'), clientKey('2001:db8:0:2::1'));
  for (const address of ['', 'unknown', '192.0.2.1, 192.0.2.2', 'fe80::1%eth0']) assert.equal(clientKey(address), null);
  for (const value of ['*', '127.0.0.1/33', '::/129', '127.0.0.1/1/2', '127.0.0.1,']) {
    assert.throws(() => readMcpConfig({ DRAGONS_API_URL: 'http://localhost', MCP_PUBLIC_URL: 'http://localhost',
      MCP_TRUSTED_PROXY_ADDRESSES: value }), /MCP_TRUSTED_PROXY_ADDRESSES/);
  }
});

test('admission state and concurrent verification stay bounded without evicting active callers', () => {
  let now = 1000;
  const budget = new TokenBudget({ newPerWindow: 1, maxCallers: 2, maxPending: 2, pendingPerCaller: 1, now: () => now });
  const first = budget.acquire('bad1', 'a')!;
  assert.equal(budget.acquire('bad2', 'a'), undefined, 'one caller cannot occupy all checks');
  const second = budget.acquire('good', 'b')!;
  assert.equal(typeof second, 'function', 'another caller still gets a check');
  assert.equal(budget.acquire('bad3', 'c'), undefined, 'state has a fixed maximum');
  first(); first(); second();
  assert.equal(budget.acquire('bad4', 'a'), undefined, 'releasing a check does not reset rate limits');
  now += 60000;
  const third = budget.acquire('good2', 'c')!;
  assert.equal(typeof third, 'function', 'expired state can be reclaimed');
  third();
});

test('verification leases are released on backend failures and do not mix concurrent callers', async () => {
  let calls = 0, finish: (() => void) | undefined;
  const backend = new Backend('https://api.example.com', async () => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { finish = resolve; });
    throw new Error('backend disconnected');
  });
  const app = createMcpApp(readMcpConfig({ DRAGONS_API_URL: 'https://api.example.com', MCP_PUBLIC_URL: 'https://mcp.example.com' }),
    backend, 'skill', new TokenBudget({ pendingPerCaller: 1, maxPending: 2 }));
  const attempt = (client: string) => app.fetch(new Request('https://mcp.example.com/mcp', {
    method: 'POST', headers: { Host: 'mcp.example.com', Authorization: `Bearer ${TOKEN}` }, body: '{}',
  }), client);
  const first = attempt('a');
  for (let tries = 0; !finish && tries < 100; tries++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(finish, 'verification started');
  assert.equal((await attempt('a')).status, 429);
  assert.notEqual((await attempt('b')).status, 429);
  finish(); await first;
  assert.notEqual((await attempt('a')).status, 429, 'failed check releases its lease');
  assert.equal(calls, 3);
});

test('the widest slippage a quote offers clears the backend\'s 10% limit', () =>
  withMcp(async ({ client, fake }) => {
    fake.state.shares = '1234567';
    fake.state.collateral = '1234567';
    const buy = structured(await client.callTool({ name: 'quote_buy',
      arguments: { market: '7', side: 'yes', amount: '5', max_slippage_bps: 1000 } }));
    const sell = structured(await client.callTool({ name: 'quote_sell',
      arguments: { market: '7', side: 'yes', shares: '4000000', max_slippage_bps: 1000 } }));
    for (const least of [buy.min_shares, sell.min_collateral]) {
      assert.ok(BigInt(String(least)) * 10000n >= 1234567n * 9000n, String(least));
    }
  }));

test('an agent reads its account and the rounds, with amounts in the token and its limits left', () =>
  withMcp(async ({ client }) => {
    assert.match(client.getInstructions() ?? '', /request_id/);
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(tools, ['buy', 'cash_out', 'claim', 'get_agent', 'list_claimable', 'list_markets',
      'list_operations', 'list_positions', 'list_rounds', 'quote_buy', 'quote_sell', 'quote_stake', 'redeem', 'sell',
      'stake', 'withdraw']);
    const agent = structured(await client.callTool({ name: 'get_agent', arguments: {} }));
    assert.deepEqual(agent.balances, { market_available: '6', market_pending_withdrawals: '0',
      registered_with_market: true, positions: 2, rounds_available: '12.5', rounds_pending_withdrawals: '0',
      open_stakes: 1, registered_with_rounds: true, intents: '3', near_for_gas: '0.15' });
    assert.deepEqual([(agent.limits as Json).max_spend, (agent.limits as Json).left_last_24h], ['5', '12.5']);
    const rounds = structured(await client.callTool({ name: 'list_rounds', arguments: {} }));
    assert.deepEqual((rounds.rules as Json).min_stake, '0.1');
    assert.deepEqual((rounds.series as Json[]).map(s => [s.round, s.taking_stakes]), [['7', false]],
      'an agent is told when a round is not taking stakes, before it spends gas finding out');
    const claimable = structured(await client.callTool({ name: 'list_claimable', arguments: {} }));
    assert.deepEqual(claimable.stakes, [{ series: 0, round: '6', side: 'up', amount: '5', outcome: 'up' }]);
    const skill = await client.readResource({ uri: 'dragons-market://skill' });
    assert.match(String((skill.contents[0] as { text?: string }).text), /## request_id/);
    const prompt = await client.getPrompt({ name: 'trade-dragons-market' });
    assert.match(JSON.stringify(prompt.messages), /dragons-market/);
  }));

test('an agent reads the markets, then buys, sells and redeems as quoted', () =>
  withMcp(async ({ client, fake }) => {
    const listed = structured(await client.callTool({ name: 'list_markets', arguments: {} }));
    assert.deepEqual((listed.markets as Json[]).map(m => [m.market, m.title, m.price_yes, m.price_no, m.locked]),
      [['7', 'Will it rain?', '0.62', '0.38', '1.5']]);
    const held = structured(await client.callTool({ name: 'list_positions', arguments: {} }));
    assert.deepEqual(held.positions, [{ market_id: '7', yes: '4000000', no: '0', status: 'resolved', outcome: 'yes',
      redeemable: '6.25' }]);

    const quoted = structured(await client.callTool({ name: 'quote_buy',
      arguments: { market: '7', side: 'yes', amount: '5' } }));
    assert.deepEqual([quoted.shares, quoted.fee, quoted.min_shares], ['4000000', '0.1', '3960000']);
    assert.deepEqual(fake.seen.at(-1)!.body, { market: '7', side: 'yes', amount: '5000000' });
    const bought = structured(await client.callTool({ name: 'buy', arguments: { request_id: 'buy-market-7', market: '7',
      side: 'yes', amount: '5', min_shares: quoted.min_shares } }));
    assert.equal(bought.outcome, 'done');
    assert.deepEqual(fake.seen.at(-1)!.body, { request_id: 'buy-market-7', action: { kind: 'buy', market: '7',
      side: 'yes', amount: '5000000', minShares: '3960000' } });

    const sale = structured(await client.callTool({ name: 'quote_sell',
      arguments: { market: '7', side: 'yes', shares: '4000000', max_slippage_bps: 200 } }));
    assert.deepEqual([sale.collateral, sale.fee, sale.min_collateral], ['2', '0.04', '1960000']);
    await client.callTool({ name: 'sell', arguments: { request_id: 'sell-market-7', market: '7', side: 'yes',
      shares: '4000000', min_collateral: sale.min_collateral } });
    assert.deepEqual(fake.seen.at(-1)!.body, { request_id: 'sell-market-7', action: { kind: 'sell', market: '7',
      side: 'yes', shares: '4000000', minCollateral: '1960000' } });

    await client.callTool({ name: 'redeem', arguments: { request_id: 'redeem-market-7', market: '7' } });
    assert.deepEqual(fake.seen.at(-1)!.body, { request_id: 'redeem-market-7', action: { kind: 'redeem', market: '7' } });
    await client.callTool({ name: 'withdraw', arguments: { request_id: 'withdraw-market', from: 'market', amount: '6' } });
    assert.deepEqual(fake.seen.at(-1)!.body, { request_id: 'withdraw-market',
      action: { kind: 'withdraw', venue: 'market', amount: '6000000' } });

    fake.state.shares = '0';
    const noBuy = await client.callTool({ name: 'quote_buy', arguments: { market: '7', side: 'yes', amount: '5' } });
    assert.match(text(noBuy), /^market_takes_no_buy: /, 'a quote of nothing is no minimum to send');
    fake.state.collateral = '0';
    const noSell = await client.callTool({ name: 'quote_sell', arguments: { market: '7', side: 'yes', shares: '1' } });
    assert.match(text(noSell), /^market_takes_no_sell: /);

    fake.state.answer = { status: 409, body: { error: { code: 'slippage_too_wide' } } };
    const wide = await client.callTool({ name: 'buy', arguments: { request_id: 'buy-market-8', market: '7', side: 'yes',
      amount: '5', min_shares: '1' } });
    assert.match(text(wide), /^slippage_too_wide: .*Quote again/);
    assert.equal(structured(wide).retry_same_request_id, false, 'nothing was sent, so a fresh quote is safe');
    const actions = fake.seen.filter(r => r.path === 'actions').length;
    const badSide = await client.callTool({ name: 'buy', arguments: { request_id: 'buy-market-9', market: '7',
      side: 'up', amount: '5', min_shares: '1' } });
    assert.equal((badSide as { isError?: boolean }).isError, true);
    assert.equal(fake.seen.filter(r => r.path === 'actions').length, actions, 'a market is traded yes or no');
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
    fake.state.answer = { status: 409, body: { error: { code: 'operation_idempotency_conflict' } } };
    const conflict = await client.callTool({ name: 'stake', arguments: { request_id: 'stake-round-8', series: 0,
      round: '7', side: 'up', amount: '5', min_shares: '1' } });
    assert.match(text(conflict), /Read list_operations first/, 'never an invitation to send it again under a new id');
    assert.doesNotMatch(text(conflict), /^operation_idempotency_conflict: .*Use a new request_id\.$/);
    fake.state.answer = { status: 502, body: { error: { code: 'agent_api_unavailable' } } };
    const down = await client.callTool({ name: 'withdraw', arguments: { request_id: 'withdraw-0001', from: 'rounds',
      amount: '1' } });
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
