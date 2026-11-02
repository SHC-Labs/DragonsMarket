import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { migrate, migrationFiles } from '../src/migrate.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createReadApi } from '../src/read-api.js';
import { verifyDatabase } from '../src/database.js';
import { registerDeployment, ingestionStatus } from '../src/ingestion/store.js';
import { ingest } from '../src/ingestion/engine.js';
import { FixtureSource, type BlockSource } from '../src/ingestion/source.js';
import { checkChain } from '../src/verify-chain.js';
import { runPreflight } from '../src/preflight.js';
import { generateKeyPairSync } from 'node:crypto';
import { base58Encode } from '../src/base58.js';
import { loadPublisherKey, publishOnce, reserveDecision, roundPriceMessage } from '../src/round-publisher.js';
import { createHash } from 'node:crypto';

async function setup(work: (pool: pg.Pool, root: string, read: ReturnType<typeof createReadApi>) => Promise<void>) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL; temporary schemas are removed after each test');
  const schema = `reads_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const config = readConfig({ DATABASE_URL: databaseUrl, DEPLOYMENT_ID: 'reads', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  const read = createReadApi(pool, config);
  const app = createApp(config, () => verifyDatabase(pool, config), () => ingestionStatus(pool, config), read);
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await registerDeployment(pool, config);
    await ingest(pool, config, new FixtureSource('test/fixtures/blocks.jsonl'));
    // Same network and entirely separate deployment must not appear through this API.
    await registerDeployment(pool, { ...config, deployment: { ...config.deployment!, id: 'other', startBlock: '0' } });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const address = app.address();
    assert.ok(address && typeof address !== 'string');
    await work(pool, `http://127.0.0.1:${address.port}`, read);
  } finally {
    app.closeAllConnections();
    if (app.listening) await new Promise<void>((resolve, reject) => app.close(e => e ? reject(e) : resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
async function get(root: string, path: string) {
  const response = await fetch(root + path);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('HTTP evidence reads: deployment scope, all event pages, filters and failed receipt outcomes', async () => setup(async (_pool, root) => {
  const deployments = await get(root, '/v1/deployments');
  assert.deepEqual(deployments.data.map((d: any) => d.id), ['reads']);
  assert.equal(deployments.indexing.source.mode, 'fixture');
  assert.equal(deployments.indexing.live, false);
  assert.equal(deployments.asOf.height, '103');
  assert.equal(deployments.asOf.timestampNs, '1700000103000000000');
  assert.equal(deployments.indexing.lagBlocks, null);
  let next = '/v1/events?limit=1';
  const events: any[] = [];
  do {
    const page = await get(root, next);
    events.push(...page.data);
    next = page.nextCursor ? `/v1/events?limit=1&cursor=${page.nextCursor}` : '';
  } while (next);
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map(e => `${e.receipt_id}:${e.log_index}:${e.data_index}`)).size, 4);
  assert.equal(events[0].payload.amount, '9007199254740993');
  assert.equal((await get(root, '/v1/events?event=missing')).data.length, 0);
  assert.equal((await get(root, '/v1/events?receiver=other.near')).data.length, 0);
  assert.equal((await get(root, '/v1/events?standard=rounds&event=staked&fromBlock=103&toBlock=103')).data.length, 1);
  assert.deepEqual((await get(root, '/v1/blocks')).data.map((b: any) => b.block_height), ['100', '101', '103']);
  assert.equal((await get(root, '/v1/blocks')).data[1].event_count, 0);
  const receipts: string[] = [];
  let receiptNext = '/v1/receipts?limit=1';
  while (receiptNext) {
    const page = await get(root, receiptNext);
    receipts.push(...page.data.map((r: any) => r.receipt_id));
    receiptNext = page.nextCursor ? `/v1/receipts?limit=1&cursor=${page.nextCursor}` : '';
  }
  assert.deepEqual(receipts, ['A'.repeat(32), 'B'.repeat(32), 'D'.repeat(32)]);
  const failure = await get(root, `/v1/receipts/${'B'.repeat(32)}`);
  assert.deepEqual(failure.data.outcome, { Failure: { ActionError: {} } });
  assert.equal((await get(root, `/v1/events?receiptId=${'B'.repeat(32)}`)).data.length, 0);
  assert.equal((await fetch(`${root}/v1/receipts/${'C'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(root + '/v1/events', { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(root + '/v1/events', { method: 'POST' })).status, 405);
  assert.equal((await fetch(root + '/v1/transactions/unknown')).status, 404);
}));

test('cursor walks keep a fixed checkpoint as new blocks arrive; cursors cannot change filters or routes', async () => setup(async (pool, root) => {
  const first = await get(root, '/v1/blocks?limit=1');
  assert.ok(first.nextCursor);
  const url = new URL(root);
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, DEPLOYMENT_ID: 'reads', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  const appended: BlockSource = { id: 'fixture-jsonl-v1', mode: 'fixture', network: 'sandbox', async *blocks() {
    yield { network: 'sandbox', finalized: true, header: { height: '1000', hash: '5'.repeat(32), prev_hash: '4'.repeat(32), timestamp_nanosec: '1700000104000000000' }, receipts: [] };
  } };
  await ingest(pool, config, appended);
  let cursor = first.nextCursor;
  const heights = [first.data[0].block_height];
  while (cursor) {
    const page = await get(root, `/v1/blocks?limit=1&cursor=${cursor}`);
    assert.equal(page.asOf.height, '103');
    assert.equal(page.indexing.latestCheckpoint.height, '1000');
    heights.push(...page.data.map((r: any) => r.block_height));
    cursor = page.nextCursor;
  }
  assert.deepEqual(heights, ['100', '101', '103']);
  assert.equal((await get(root, '/v1/blocks')).data.at(-1).block_height, '1000');
  for (const path of [`/v1/events?cursor=${first.nextCursor}`, `/v1/blocks?fromBlock=101&cursor=${first.nextCursor}`]) {
    assert.equal((await fetch(root + path)).status, 400);
  }
  const forged = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  forged.anchor.hash = '9'.repeat(32);
  url.pathname = '/v1/blocks';
  url.searchParams.set('cursor', Buffer.from(JSON.stringify(forged)).toString('base64url'));
  assert.equal((await fetch(url)).status, 400);
}));

test('invalid input is rejected, SQL failures are sanitized and unconfigured deployments are explicit', async () => setup(async (pool, root) => {
  for (const path of ['/v1/events?limit=101', '/v1/events?limit=1.1', '/v1/events?limit=0', '/v1/events?limit=01', '/v1/events?limit=1&limit=2', '/v1/events?cursor=bad', '/v1/events?deployment=other', '/v1/events?receiver=INVALID!', '/v1/events?standard=other', '/v1/blocks?fromBlock=18446744073709551616', '/v1/blocks?fromBlock=103&toBlock=100', '/v1/receipts/not-a-receipt', '/v1/deployments?limit=1', '/v1/events?event=%27%3BDROP%20TABLE%20deployments']) {
    assert.equal((await fetch(root + path)).status, 400, path);
  }
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! });
  const unconfigured = createReadApi(pool, config);
  assert.deepEqual((await unconfigured(new URL('http://localhost/v1/deployments')) as { data: unknown[] }).data, []);
  await assert.rejects(unconfigured(new URL('http://localhost/v1/events')), /deployment_not_configured/);
  await pool.query('ALTER TABLE raw_events RENAME TO private_secret_table');
  const response = await fetch(root + '/v1/events');
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.ok(body.includes('read_api_unavailable'));
  assert.ok(!body.includes('raw_events') && !body.includes('secret') && !body.includes('postgres'));
}));

test('receipt migration backfills existing journals without changing block checkpoints', async () => setup(async (pool, _root) => {
  // Recreate exactly the pre-004 shape, leaving journal/checkpoint evidence intact.
  const before = (await pool.query('SELECT * FROM indexer_checkpoints')).rows;
  await pool.query('DROP TRIGGER deployments_immutable ON deployments');
  await pool.query('DROP FUNCTION refuse_deployment_change()');
  await pool.query('DROP TABLE indexed_receipts');
  await pool.query('DROP TABLE chain_integrity_reports,source_heads,feed_exports,backend_jobs,user_operations,price_evidence,signing_decisions,reconciliation_reports,wallet_challenges,wallet_sessions,wallet_watchlist,policy_acknowledgements');
  await pool.query('DROP INDEX raw_events_read_page');
  await pool.query("DELETE FROM schema_migrations WHERE version >= '004_receipt_reads.sql'");
  assert.equal(await migrate(pool), 8);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM indexed_receipts')).rows[0].n, 3);
  assert.deepEqual((await pool.query('SELECT * FROM indexer_checkpoints')).rows, before);
  assert.equal((await migrationFiles()).length, 11);
}));

test('pending settlements: requests stay listed until their own terminal event lands', async () => setup(async (pool, root) => {
  let n = 0;
  const add = (standard: string, event: string, block: number, payload: object, receiver = `${standard}.fixture.near`) => pool.query(
    `INSERT INTO raw_events (network, receipt_id, log_index, data_index, deployment_id, receiver_id, block_height, block_hash, block_timestamp_ns, standard, version, event, raw_log, payload)
     VALUES ('sandbox', $1, 0, 0, 'reads', $2, $3, 'h', $3, $4, '1.0.0', $5, 'EVENT_JSON:{}', $6)`, [`r${++n}`.padEnd(32, 'x'), receiver, block, standard, event, JSON.stringify(payload)]);
  await add('market', 'withdraw', 101, { id: '1', account: 'a.near', amount: '5' });
  await add('market', 'withdraw', 101, { id: '2', account: 'b.near', amount: '7' });
  await add('market', 'withdraw_confirmed', 102, { id: '1', account: 'a.near', amount: '5' });
  await add('rounds', 'withdraw', 101, { id: '5', account: 'd.near', amount: '9' });
  await add('oracle', 'bond_payout_requested', 101, { id: '7', account: 'e.near', amount: '3' });
  await add('oracle', 'bond_paid', 102, { id: '7', account: 'e.near', amount: '3' });
  const claim = { quarter: 3, token_id: '9', owner: 'c.near', amount: '4', requested_at: '1' };
  await add('council', 'claim_requested', 101, claim);
  await add('council', 'claim_failed', 102, claim);
  await add('council', 'claim_requested', 102, { ...claim, requested_at: '2' });
  const pending = await get(root, '/v1/settlements/pending');
  assert.deepEqual(pending.data.map((r: any) => [r.kind, r.event, r.payload.id ?? r.payload.token_id]), [['withdrawal', 'withdraw', '2'], ['withdrawal', 'withdraw', '5'], ['claim', 'claim_requested', '9']]);
  assert.equal(pending.data[2].payload.requested_at, '2', 'a retry in the same block as the earlier failure is still pending');
  assert.equal(pending.truncated, false);
  const mine = await get(root, '/v1/settlements/pending?account=d.near');
  assert.deepEqual(mine.data.map((r: any) => r.payload.id), ['5'], 'only the named account\'s items');
  assert.equal((await fetch(root + '/v1/settlements/pending?account=Bad Account')).status, 400);
  const events = await get(root, '/v1/events?standard=market');
  assert.deepEqual(events.data.map((e: any) => e.settlement), [{ kind: 'withdrawal', phase: 'request' }, { kind: 'withdrawal', phase: 'request' }, { kind: 'withdrawal', phase: 'terminal' }]);
  assert.match(events.note, /not settlement/);
  assert.equal((await fetch(root + '/v1/settlements/pending?cursor=x')).status, 400);
}));

test('chain integrity check passes on a clean history and names what tampering broke', async () => setup(async (pool) => {
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, DEPLOYMENT_ID: 'reads', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  const clean = await checkChain(pool, config);
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.equal(clean.lastHeight, '103');
  await pool.query("UPDATE indexed_blocks SET prev_hash = 'tampered' WHERE block_height = 101");
  await pool.query('DELETE FROM raw_events WHERE ctid IN (SELECT ctid FROM raw_events LIMIT 1)');
  const broken = await checkChain(pool, config);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.problems.sort(), ['broken_parent_links', 'event_count_mismatch']);
}));

test('preflight passes on a consistent chain and names what is wrong on an inconsistent one', async () => setup(async (pool) => {
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, DEPLOYMENT_ID: 'reads', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  const hash = '2'.repeat(32);
  const chain = (opts: { code?: string; verifier?: string } = {}) => ({
    async call(method: string, params: object) {
      const p = params as { request_type?: string; method_name?: string; block_id?: string };
      if (method === 'status') return { chain_id: 'localnet' };
      if (method === 'block') return { header: { hash, height: 1000, timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) } };
      if (p.request_type === 'view_account') return { code_hash: opts.code ?? 'CodeHash1111' };
      const values: Record<string, unknown> = {
        config: { verifier: opts.verifier ?? 'verifier.fixture.near', collateral_token_id: 'nep141:usdc.fixture.near', paused: false, state_version: 6, owner: 'owner.near', publishers: ['ed25519:a', 'ed25519:b', 'ed25519:c'], price_threshold: 2, series: 1, network: 'sandbox' },
        get_series: { asset: 'btc-usd', decimals: 8, first_start: '0', interval: '300000000000', price_window: '600000000000', close_before: '30000000000' },
        total_owed: '0', owed_breakdown: { pending_withdrawals: '0' }, mt_balance_of: '0',
      };
      return { block_hash: p.block_id, result: [...Buffer.from(JSON.stringify(values[p.method_name!]))] };
    },
  });
  const good = await runPreflight(config, chain(), pool, null);
  assert.deepEqual(good.filter(c => c.status !== 'pass' && !['network', 'links'].includes(c.name)), [], JSON.stringify(good));
  const bad = await runPreflight(config, chain({ code: '1'.repeat(32), verifier: 'someone.else.near' }), pool, null);
  assert.ok(bad.some(c => c.name === 'contract:rounds' && c.status === 'fail' && /no contract deployed/.test(c.detail)));
  const wrongVerifier = await runPreflight(config, chain({ verifier: 'someone.else.near' }), pool, null);
  assert.ok(wrongVerifier.some(c => c.name === 'contract:rounds' && c.status === 'fail' && /verifier is someone.else.near/.test(c.detail)));
}));

test('round publisher signs one price per round from an exchange quorum, serves it, and refuses a conflicting second price', async () => setup(async (pool, root) => {
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, DEPLOYMENT_ID: 'reads', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = loadPublisherKey(`ed25519:${base58Encode(Buffer.concat([seed, pub]))}`);
  const boundary = BigInt(Math.floor((Date.now() - 120000) / 300000) * 300) * 1_000_000_000n;
  const series = { asset: 'btc-usd', decimals: 8, first_start: boundary.toString(), interval: '300000000000', price_window: '600000000000', close_before: '30000000000' };
  const view = async (_c: string, method: string) => ({
    config: { publishers: [key.publicKey], network: 'mainnet', series: 1 }, get_series: series, get_price: null,
  } as Record<string, unknown>)[method];
  let prices: Record<string, string> = { coinbase: '80809.12345678', kraken: '80813.9', bitstamp: '80809.44' };
  const exchange: typeof fetch = async input => {
    const url = new URL(String(input));
    const source = url.hostname.includes('coinbase') ? 'coinbase' : url.hostname.includes('kraken') ? 'kraken' : 'bitstamp';
    const start = source === 'coinbase' ? String(Date.parse(url.searchParams.get('start')!) / 1000) : source === 'kraken' ? url.searchParams.get('since')! : url.searchParams.get('start')!;
    const close = prices[source]!;
    if (source === 'coinbase') return new Response(`[[${start},1,2,3,${close},0.5]]`);
    if (source === 'kraken') return new Response(`{"error":[],"result":{"XXBTZUSD":[[${start},"1","2","3","${close}","4","0.2",9]],"last":${start}}}`);
    return new Response(`{"data":{"pair":"BTC/USD","ohlc":[{"timestamp":"${start}","open":"1","high":"2","low":"3","close":"${close}","volume":"0.3"}]}}`);
  };
  const policy = { minimumSources: 3, maxDeviationBps: 50 };
  const ctx = { config, pool, view, key, policy, nowNs: BigInt(Date.now()) * 1_000_000n, transport: exchange };
  const first = await publishOnce(ctx);
  assert.ok(first.length >= 1, 'signed the round that just settled');
  assert.equal(first[0]!.round, '0');
  assert.equal(first[0]!.price, '8080944000000', 'the median of the three closes, at the series decimals');
  const served = await get(root, '/v1/price-signatures?seriesId=0&round=0');
  assert.equal(served.quotes.length, 1);
  const quote = served.quotes[0];
  assert.equal(quote.message, roundPriceMessage('rounds.fixture.near', 'mainnet', 'btc-usd', boundary.toString(), '8080944000000', 8));
  assert.equal(quote.price, '8080944000000');
  const [entryKey, signature] = quote.entry.split('.');
  assert.equal(entryKey, key.publicKey);
  assert.equal(signature, key.sign(quote.message));
  assert.equal((await publishOnce(ctx)).filter(s => s.round === '0').length, 0, 'a round already signed is not signed twice');
  prices = { coinbase: '81000.00000000', kraken: '81000.00000000', bitstamp: '81000.00000000' };
  assert.equal((await publishOnce(ctx)).filter(s => s.round === '0').length, 0, 'a different price for a signed round is refused');
  assert.equal((await get(root, '/v1/price-signatures?seriesId=0&round=0')).quotes[0].message, quote.message);
  assert.equal((await fetch(root + '/v1/price-signatures?seriesId=9&round=9')).status, 404);
  assert.equal((await fetch(root + '/v1/price-signatures?seriesId=x&round=0')).status, 400);
  const rows = (await pool.query("SELECT count(*)::int AS n FROM price_evidence WHERE boundary_ns=$1", [boundary.toString()])).rows[0].n;
  assert.ok(rows >= 3, 'every exchange response is kept as evidence');
}));

test('round publisher does not sign when the exchanges disagree or too few answer', async () => setup(async (pool) => {
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, DEPLOYMENT_ID: 'reads', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = loadPublisherKey(`ed25519:${base58Encode(Buffer.concat([privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]))}`);
  const boundary = BigInt(Math.floor((Date.now() - 120000) / 300000) * 300) * 1_000_000_000n;
  const view = async (_c: string, method: string) => ({
    config: { publishers: [key.publicKey], network: 'mainnet', series: 1 },
    get_series: { asset: 'btc-usd', decimals: 8, first_start: boundary.toString(), interval: '300000000000', price_window: '600000000000', close_before: '30000000000' }, get_price: null,
  } as Record<string, unknown>)[method];
  const down: typeof fetch = async () => new Response('nope', { status: 500 });
  const ctx = { config, pool, view, key, policy: { minimumSources: 3, maxDeviationBps: 50 }, nowNs: BigInt(Date.now()) * 1_000_000n, transport: down };
  assert.deepEqual(await publishOnce(ctx), []);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM signing_decisions')).rows[0].n, 0);
  const notPublisher = { ...ctx, view: async (c: string, m: string) => (m === 'config' ? { publishers: ['ed25519:someoneelse'], network: 'mainnet', series: 1 } : view(c, m)) };
  await assert.rejects(publishOnce(notPublisher), /is not a publisher/);
}));

test('a signed decision is write-once in the database, and a replaced reservation cannot be signed over', async () => setup(async pool => {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  await reserveDecision(pool, 'reads', 'ed25519:k', 'round:0:1', 'P1');
  assert.equal((await reserveDecision(pool, 'reads', 'ed25519:k', 'round:0:1', 'P2')).conflict, false, 'an unsigned reservation can be replaced');
  const stale = await pool.query('UPDATE signing_decisions SET signature=$4 WHERE deployment_id=$1 AND publisher_key=$2 AND boundary_key=$3 AND payload_hash=$5 AND signature IS NULL', ['reads', 'ed25519:k', 'round:0:1', 'sig-of-P1', hash('P1')]);
  assert.equal(stale.rowCount, 0, 'a signature over the replaced payload is not stored');
  await pool.query("UPDATE signing_decisions SET signature='sig-of-P2' WHERE boundary_key='round:0:1'");
  assert.equal((await reserveDecision(pool, 'reads', 'ed25519:k', 'round:0:1', 'P3')).conflict, true, 'a different price for a signed round is refused');
  await assert.rejects(pool.query("UPDATE signing_decisions SET signature=NULL WHERE boundary_key='round:0:1'"), /signed decision cannot be changed/);
  await assert.rejects(pool.query("UPDATE signing_decisions SET payload='P9' WHERE boundary_key='round:0:1'"), /signed decision cannot be changed/);
  await assert.rejects(pool.query("DELETE FROM signing_decisions WHERE boundary_key='round:0:1'"), /signed decision cannot be changed/);
}));
