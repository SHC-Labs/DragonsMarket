import test from 'node:test';
import assert from 'node:assert/strict';
import { NeardataReader, normalizeNeardata, parseNeardata, scopeCapture, readNeardataSettings } from '../src/ingestion/neardata.js';
import { LiveNeardataSource } from '../src/ingestion/live-source.js';

function raw(height = 100, parent = 99) {
  const blockHash = (height === 100 ? '3' : '2').repeat(32);
  const receipt = (id: string, failed = false) => ({ tx_hash: 'T'.repeat(32), receipt: { receipt_id: id, receiver_id: 'intents.near' }, execution_outcome: {
    id, block_hash: blockHash, outcome: { executor_id: 'intents.near', receipt_ids: ['D'.repeat(32)], status: failed ? { Failure: { ActionError: {} } } : { SuccessValue: '' },
      logs: ['EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[{"amount":"9007199254740993"}]}'] },
  } });
  return { block: { header: { height, hash: blockHash, prev_hash: (height === 100 ? '2' : '1').repeat(32), prev_height: parent, timestamp_nanosec: String(1700000000000000000n + BigInt(height)) }, chunks: [{ shard_id: 0 }, { shard_id: 1 }] },
    shards: [{ shard_id: 0, receipt_execution_outcomes: [receipt('A'.repeat(32)), receipt('B'.repeat(32), true)] }, { shard_id: 1, receipt_execution_outcomes: [] }] };
}

test('NEAR Data normalization retains exact integers, transaction provenance and failure outcomes', () => {
  const large = parseNeardata('{"timestamp":1793138919331894540,"amount":"9007199254740993"}') as { timestamp: string; amount: string };
  assert.equal(large.timestamp, '1793138919331894540');
  assert.equal(large.amount, '9007199254740993');
  assert.throws(() => parseNeardata('{"n":1e999}'), /invalid_neardata_json/);
  const block = normalizeNeardata(raw());
  assert.equal(block.header.height, '100');
  assert.deepEqual(block.shardIds, ['0', '1']);
  assert.equal(block.receipts[0]!.transactionHash, 'T'.repeat(32));
  assert.deepEqual(block.receipts[0]!.childReceiptIds, ['D'.repeat(32)]);
  const selected = scopeCapture(block, 'intents.near');
  assert.equal(selected.receipts.length, 2);
  assert.equal(selected.events.length, 1, 'Failed receipt logs must not become events');
  assert.equal((selected.events[0]!.envelope as { data: { amount: string }[] }).data[0]!.amount, '9007199254740993');
  assert.equal(scopeCapture(block, 'another.near').receipts.length, 0);
  const malformed = structuredClone(block);
  malformed.receipts[0]!.logs = ['EVENT_JSON:broken'];
  assert.equal(scopeCapture(malformed, 'intents.near').events[0]!.malformed, true);
});

test('incomplete shards, inconsistent receipts, missing transaction hashes and unfinished outcomes are refused', () => {
  for (const change of [
    (r: any) => r.shards.pop(),
    (r: any) => r.shards.push(r.shards[0]),
    (r: any) => delete r.shards[0].receipt_execution_outcomes[0].tx_hash,
    (r: any) => r.shards[0].receipt_execution_outcomes[0].execution_outcome.block_hash = '9'.repeat(32),
    (r: any) => r.shards[0].receipt_execution_outcomes[0].receipt.receiver_id = 'wrong.near',
    (r: any) => r.shards[0].receipt_execution_outcomes[0].execution_outcome.outcome.status = { Unknown: null },
    (r: any) => r.shards[0].receipt_execution_outcomes.push(r.shards[0].receipt_execution_outcomes[0]),
  ]) { const changed = raw(); change(changed); assert.throws(() => normalizeNeardata(changed)); }
});

test('bounded capture follows parent heights across skipped slots and checks ancestry', async () => {
  const paths: string[] = [];
  const reader = new NeardataReader(async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    const data = url.pathname === '/v0/last_block/final' ? raw(100, 98) : raw(98, 97);
    return new Response(JSON.stringify(data));
  }, async () => {});
  assert.deepEqual((await reader.capture(2)).map(b => b.header.height), ['98', '100']);
  assert.deepEqual(paths, ['/v0/last_block/final', '/v0/block/98']);
  const changed = raw(98, 97); changed.block.header.hash = '9'.repeat(32);
  changed.shards[0]!.receipt_execution_outcomes.forEach(r => { r.execution_outcome.block_hash = changed.block.header.hash; });
  const bad = new NeardataReader(async input => new Response(JSON.stringify(String(input).endsWith('/final') ? raw(100, 98) : changed)), async () => {});
  await assert.rejects(bad.capture(2), /neardata_ancestry_mismatch/);
  await assert.rejects(reader.capture(21), /invalid_neardata_count/);
});

test('transport enforces redirect origin/path, response bounds and safe rate-limit errors', async () => {
  const redirect = new NeardataReader(async () => new Response(null, { status: 302, headers: { location: 'https://other.example/v0/block/100' } }), async () => {});
  await assert.rejects(redirect.capture(1), /invalid_neardata_redirect/);
  const rate = new NeardataReader(async () => new Response('secret provider body', { status: 429 }), async () => {});
  await assert.rejects(rate.capture(1), /neardata_rate_limited/);
  const oversized = new NeardataReader(async () => new Response(new Uint8Array(32 * 1024 * 1024 + 1)), async () => {});
  await assert.rejects(oversized.capture(1), /neardata_size_limit/);
  const redirected = new NeardataReader(async input => String(input).endsWith('/final')
    ? new Response(null, { status: 302, headers: { location: '/v0/block/100' } }) : new Response(JSON.stringify(raw())), async () => {});
  assert.equal((await redirected.capture(1))[0]!.header.height, '100');
  const missing = new NeardataReader(async () => new Response('null'), async () => {});
  await assert.rejects(missing.capture(1), /invalid_neardata_block/);
});

test('a cycle stops asking for blocks before its request budget runs out, so the next cycle carries on', async () => {
  const reader = new NeardataReader(async () => new Response('null'), async () => {}, 400);
  assert.equal(reader.hasBudget(), true);
  for (let i = 0; i < 31; i++) await reader.document(`/v0/block/${i}`);
  assert.equal(reader.hasBudget(), false);
  reader.resetBudget();
  assert.equal(reader.hasBudget(), true);
});

test('historical redirects preserve the requested height and never send credentials to unapproved hosts', async () => {
  const headers: unknown[] = [];
  const reader = new NeardataReader(async (input, init) => {
    headers.push(init?.headers);
    return new URL(String(input)).hostname === 'mainnet.neardata.xyz'
      ? new Response(null, { status: 302, headers: { location: 'https://a3.mainnet.neardata.xyz/v0/block/100' } })
      : new Response(JSON.stringify(raw()));
  }, async () => {}, 100, { bearerToken: 'fixture-token' });
  assert.equal(normalizeNeardata(await reader.document('/v0/block/100')).header.height, '100');
  assert.deepEqual(headers, [{ Authorization: 'Bearer fixture-token' }, { Authorization: 'Bearer fixture-token' }]);
  for (const location of ['https://a3.mainnet.neardata.xyz.evil.test/v0/block/100',
    'https://a3.mainnet.neardata.xyz/v0/block/101', 'https://a3.mainnet.neardata.xyz/v0/block/100?key=x',
    'http://a3.mainnet.neardata.xyz/v0/block/100', 'https://user@a3.mainnet.neardata.xyz/v0/block/100']) {
    let calls = 0;
    const bad = new NeardataReader(async () => {
      calls++; return new Response(null, { status: 302, headers: { location } });
    }, async () => {}, 400, { bearerToken: 'fixture-token' });
    await assert.rejects(bad.document('/v0/block/100'), /invalid_neardata_redirect/);
    assert.equal(calls, 1);
  }
});

test('parallel requests reserve separate rate slots and reject unbounded source settings', async () => {
  const waits: number[] = [];
  const reader = new NeardataReader(async () => new Response('null'), async ms => { waits.push(ms); }, 400);
  await Promise.all([reader.document('/v0/block/1'), reader.document('/v0/block/2'), reader.document('/v0/block/3')]);
  assert.ok(waits[1]! - waits[0]! >= 350);
  assert.ok(waits[2]! - waits[1]! >= 350);
  assert.throws(() => new NeardataReader(fetch, undefined, 100), /authenticated_source_required/);
  assert.throws(() => new NeardataReader(fetch, undefined, 99, { bearerToken: 'fixture-token' }), /invalid_source_interval/);
  assert.throws(() => new NeardataReader(fetch, undefined, 400, { concurrency: 5 }), /invalid_source_concurrency/);
  assert.throws(() => new NeardataReader(fetch, undefined, 400, { bearerToken: 'bad\nheader' }), /invalid_source_token/);
  assert.throws(() => readNeardataSettings({ NEARDATA_INTERVAL_MS: '1e3' }), /invalid_source_settings/);
  assert.deepEqual(readNeardataSettings({}), { intervalMs: 400, concurrency: 1, bearerToken: undefined });
});

test('prefetched blocks commit in height order and stop before missing or conflicting evidence', async () => {
  const block = (height: number) => {
    const data = raw(height, height - 1);
    data.block.header.hash = String(height - 96).repeat(32);
    data.block.header.prev_hash = String(height - 97).repeat(32);
    data.shards.forEach(shard => { shard.receipt_execution_outcomes = []; });
    return data;
  };
  for (const mode of ['normal', 'failure', 'conflict'] as const) {
    const completed: number[] = [], emitted: string[] = [];
    const reader = new NeardataReader(async input => {
      const height = Number(new URL(String(input)).pathname.split('/').pop());
      await new Promise(resolve => setTimeout(resolve, (103 - height) * 10));
      completed.push(height);
      if (height === 101 && mode === 'failure') throw new Error('provider credential must not appear');
      const value = block(height);
      if (height === 101 && mode === 'conflict') value.block.header.prev_hash = 'Z'.repeat(32);
      return new Response(JSON.stringify(value));
    }, async () => {}, 400, { concurrency: 4 });
    const source = new LiveNeardataSource(reader, normalizeNeardata(block(103)), '100', null);
    const consume = async () => { for await (const item of source.blocks()) emitted.push(item.header.height); };
    if (mode === 'normal') { await consume(); assert.deepEqual(emitted, ['100', '101', '102', '103']); }
    else {
      await assert.rejects(consume(), mode === 'failure' ? /neardata_unavailable/ : /source_ancestry_mismatch/);
      assert.deepEqual(emitted, ['100']);
    }
    assert.deepEqual(completed, [102, 101, 100]);
  }
});
