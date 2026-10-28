import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { FixtureSource } from '../src/ingestion/source.js';
import { prepareBlock, IngestionError, parseJson } from '../src/ingestion/block.js';

const config = readConfig({ DATABASE_URL: 'postgres://local:local@localhost/db', DEPLOYMENT_ID: 'fixture-replay', DEPLOYMENT_START_BLOCK: '100', ROUNDS_CONTRACT_ID: 'rounds.fixture.near', VERIFIER_CONTRACT_ID: 'verifier.fixture.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.fixture.near' });
async function first(): Promise<any> { for await (const b of new FixtureSource('test/fixtures/blocks.jsonl').blocks()) return b; throw new Error('Empty fixture'); }

test('fixture parses actual envelope shapes, scopes receivers, ignores failed logs and retains exact values', async () => {
  const prepared = prepareBlock(await first(), config);
  assert.equal(prepared.events.length, 3);
  assert.deepEqual(prepared.events.map(e => [e.logIndex, e.dataIndex]), [[1, 0], [2, 0], [2, 1]]);
  assert.equal((prepared.events[0]?.payload as { amount: string }).amount, '9007199254740993');
  assert.equal(prepared.block.receipts.length, 2);
  assert.equal(prepared.block.header.timestamp_nanosec, '1700000100000000000');
});

test('replay fingerprint is independent of receipt ordering but detects changed scoped logs', async () => {
  const original = await first();
  const reversed = structuredClone(original);
  reversed.receipts.reverse();
  assert.equal(prepareBlock(original, config).digest, prepareBlock(reversed, config).digest);
  const changed = structuredClone(original);
  changed.receipts[0].logs.push('new diagnostic');
  assert.notEqual(prepareBlock(original, config).digest, prepareBlock(changed, config).digest);
});

test('nonfinal, wrong network, incomplete outcomes and duplicate receipts fail closed', async () => {
  const original = await first();
  for (const patch of [{ finalized: false }, { network: 'mainnet' }, { receipts: [{ ...original.receipts[0], status: { Unknown: null } }] }, { receipts: [original.receipts[0], original.receipts[0]] }]) assert.throws(() => prepareBlock({ ...original, ...patch }, config), IngestionError);
});


test('relevant unsupported versions block progress; unrelated standards are ignored', async () => {
  const b = await first();
  b.receipts[0].logs = ['EVENT_JSON:{"standard":"rounds","version":"2.0.0","event":"staked","data":{}}'];
  assert.throws(() => prepareBlock(b, config), /unsupported_event_version/);
  b.receipts[0].logs = ['EVENT_JSON:{"standard":"unrelated","version":"2.0.0","event":"other","data":{}}'];
  assert.equal(prepareBlock(b, config).events.length, 0);
  b.receipts[0].logs = ['EVENT_JSON:broken'];
  assert.throws(() => prepareBlock(b, config), /invalid_json/);
});

test('unsafe JSON numbers are refused and optional event data is retained as JSON null', async () => {
  assert.throws(() => parseJson('{"amount":9007199254740993}'), /unsafe_number/);
  const b = await first();
  b.receipts[0].status = { SuccessReceiptId: 'F'.repeat(32) };
  b.receipts[0].logs = ['EVENT_JSON:{"standard":"rounds","version":"1.0.0","event":"changed"}'];
  assert.equal(prepareBlock(b, config).events[0]?.payload, null);
});

test('source failures are sanitized and the fixture file preserves numeric height gaps', async () => {
  const heights: string[] = [];
  for await (const input of new FixtureSource('test/fixtures/blocks.jsonl').blocks()) heights.push(prepareBlock(input, config).block.header.height);
  assert.deepEqual(heights, ['100', '101', '103']);
  await assert.rejects(async () => { for await (const _ of new FixtureSource('/missing/private/path').blocks()) {} }, /source_read_failed/);
});

test('verifier receipts are kept only when they name one of our contracts', async () => {
  const block = await first();
  const receipt = (id: string, logs: string[]) => ({ receipt_id: id, receiver_id: 'verifier.fixture.near', status: { SuccessValue: '' }, logs });
  const other = receipt('4'.repeat(32), ['EVENT_JSON:{"standard":"nep245","event":"mt_transfer","data":[{"old_owner_id":"alice.near","new_owner_id":"bob.near"}]}']);
  const ours = receipt('5'.repeat(32), ['EVENT_JSON:{"standard":"nep245","event":"mt_transfer","data":[{"old_owner_id":"alice.near","new_owner_id":"rounds.fixture.near"}]}']);
  const before = prepareBlock(block, config).block.receipts.length;
  const prepared = prepareBlock({ ...block, receipts: [...block.receipts, other, ours] }, config);
  assert.equal(prepared.block.receipts.length, before + 1);
  assert.ok(prepared.block.receipts.some(r => r.receipt_id === ours.receipt_id));
  assert.ok(!prepared.block.receipts.some(r => r.receipt_id === other.receipt_id));
});
