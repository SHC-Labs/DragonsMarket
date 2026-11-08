import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { feedIsCurrent, readQueue } from './due-queue.mjs';
import { options, queuedRun, validateActionKeys } from './keeper.mjs';
import { b58encode } from './chain.mjs';

test('guarded keeper catches up in bounded passes and persists without signing stale evidence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-feed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scope = { rpc: 'https://rpc.invalid', market: 'market.near', oracle: 'oracle.near', council: 'council.near' };
  const opts = { ...scope, 'state-file': path.join(dir, 'queue.json'), 'events-file': path.join(dir, 'feed.jsonl'), 'require-live-feed': true };
  const now = BigInt(Date.now()) * 1_000_000n;
  const blocks = Array.from({ length: 6001 }, (_, i) => ({ finalized: true, receipts: [], header: {
    height: String(i + 1), hash: `hash-${i + 1}`, prev_hash: `hash-${i}`,
    timestamp_nanosec: String(now - BigInt(6000 - i) * 100_000_000n),
  } }));
  fs.writeFileSync(opts['events-file'], blocks.map(block => JSON.stringify(block) + '\n').join(''));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request.method);
    assert.equal(request.method, 'block', 'preparation must not read signing keys or broadcast');
    return Response.json({ result: { header: blocks.at(-1).header } });
  });
  const first = await queuedRun(opts, {});
  assert.equal(first.current, false);
  assert.equal(first.state.cursor.height, '5000');
  assert.deepEqual(first.actions, []);
  assert.equal(readQueue(opts['state-file'], scope).cursor.height, '5000');
  const second = await queuedRun({ ...opts, 'prepare-feed': true }, {});
  assert.equal(second.current, true);
  assert.equal(second.state.cursor.height, '6001');
  assert.equal(second.state.eventOffset, fs.statSync(opts['events-file']).size);
  assert.deepEqual(calls, ['block', 'block']);
  await assert.rejects(queuedRun({ ...opts, 'events-file': undefined }, {}), /event feed/);
});

test('feed freshness rejects missing, old, future or conflicting evidence', () => {
  const wall = 1_000_000, at = String(BigInt(wall) * 1_000_000n);
  const header = { height: '200', hash: 'head', timestamp_nanosec: at };
  const state = { cursor: { height: '200', hash: 'head', timestampNs: at } };
  assert.equal(feedIsCurrent(state, header, wall), true);
  for (const cursor of [null, { ...state.cursor, timestampNs: undefined }, { ...state.cursor, hash: 'fork' },
    { ...state.cursor, height: '99' }, { ...state.cursor, height: '201' },
    { ...state.cursor, timestampNs: String(BigInt(at) - 61_000_000_000n) },
    { ...state.cursor, timestampNs: String(BigInt(at) + 1n) }]) {
    assert.equal(feedIsCurrent({ cursor }, header, wall), false);
  }
  assert.equal(feedIsCurrent(state, header, wall + 60_001), false);
  assert.equal(feedIsCurrent(state, header, wall - 5_001), false);
});

test('a current feed reaches due work while dry-run never loads or uses a signing key', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-current-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = BigInt(Date.now()) * 1_000_000n;
  const header = { height: '1', hash: 'head', prev_hash: 'parent', timestamp_nanosec: String(now) };
  const file = path.join(dir, 'feed.jsonl');
  fs.writeFileSync(file, JSON.stringify({ finalized: true, header, receipts: [] }) + '\n');
  const market = { id: '0', outcome: null, resolve_by: String(now - 1n) };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'block') return Response.json({ result: { header } });
    assert.equal(request.method, 'query');
    assert.equal(request.params.request_type, 'call_function', 'no access-key reads or broadcasts in dry-run');
    const { account_id, method_name } = request.params;
    const data = method_name === 'config'
      ? account_id === 'council.near' ? { last_day: String(now / 86_400_000_000_000n) }
        : { markets: '1', next_sweep_id: '0', min_sweep: '1', min_sweep_interval_minutes: '60', settle_wait_minutes: '1' }
      : { get_fees: { collected: '0', revenue_due: '0', treasury_due: '0' },
        list_markets: [market], list_cases: [], get_market: market, get_case: null }[method_name];
    assert.notEqual(data, undefined, method_name);
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(data))] } });
  });
  const result = await queuedRun({ rpc: 'https://rpc.invalid', market: 'market.near', oracle: 'oracle.near',
    council: 'council.near', 'events-file': file, 'require-live-feed': true, 'dry-run': true }, {});
  assert.deepEqual(result.actions.map(action => action.method), ['resolve_by_deadline']);
});

test('production key mode refuses full access, unbounded allowance and unrelated methods', async t => {
  const opts = { rpc: 'https://rpc.invalid', account: 'keeper.near', oracle: 'oracle.near', 'require-scoped-keys': true };
  const keys = { oracle: 'ed25519:' + b58encode(Buffer.alloc(64, 7)) };
  const actions = [{ contract: 'oracle', method: 'finalize' }];
  let permission;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: { permission } }));
  permission = 'FullAccess';
  await assert.rejects(validateActionKeys(opts, keys, actions), /Full-access/);
  for (const [method_names, allowance] of [[[], '1000'], [['finalize'], null], [['finalize'], '0'], [['finalize'], '-1'],
    [['finalize'], String(2n ** 128n)], [['finalize', 'upgrade'], '1000']]) {
    permission = { FunctionCall: { receiver_id: opts.oracle, method_names, allowance } };
    await assert.rejects(validateActionKeys(opts, keys, actions), /finite allowance/);
  }
  permission = { FunctionCall: { receiver_id: opts.oracle, method_names: ['finalize'], allowance: '1000' } };
  await validateActionKeys(opts, keys, actions);
  assert.deepEqual(options(['--prepare-feed', '--require-live-feed', '--require-scoped-keys']), {
    'prepare-feed': true, 'require-live-feed': true, 'require-scoped-keys': true,
  });
});
