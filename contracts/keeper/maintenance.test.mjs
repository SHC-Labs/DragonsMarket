import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dueActions, queuedRun } from './keeper.mjs';
import { newQueue, ingestBlock, readQueue, writeQueue } from './due-queue.mjs';
import { b58encode } from './chain.mjs';

const day = 86_400_000_000_000n;
const scope = { rpc: 'https://rpc.invalid', market: 'market.near', oracle: 'oracle.near', council: 'council.near', rounds: 'rounds.near' };
const credit = (account, receiver = scope.oracle, status = { SuccessValue: '' }) => ({
  finalized: true, header: { height: '1', hash: 'first', prev_hash: 'zero', timestamp_nanosec: '1' },
  receipts: [{ receipt_id: 'credit', receiver_id: receiver, status,
    logs: ['EVENT_JSON:' + JSON.stringify({ standard: 'oracle', version: '1.0.0', event: 'bond_claimable', data: { account, amount: '100' } })] }],
});

test('payout discovery binds successful Oracle events, survives restart and preserves the first deadline', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-payout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const block of [credit('alice.near', 'forged.near'), credit('alice.near', scope.oracle, { Failure: {} })]) {
    const state = newQueue(scope); ingestBlock(state, block); assert.deepEqual(state.jobs, {});
  }
  const state = newQueue(scope), block = credit('alice.near');
  ingestBlock(state, block);
  const due = String(7n * day + 1n);
  assert.equal(state.jobs['bond:alice.near'].nextAt, due);
  ingestBlock(state, { ...block, header: { ...block.header, height: '2', hash: 'second', prev_hash: 'first', timestamp_nanosec: String(day) } });
  assert.equal(state.jobs['bond:alice.near'].nextAt, due);
  const file = path.join(directory, 'queue.json'); writeQueue(file, state);
  assert.deepEqual(readQueue(file, scope), state);
  for (const invalid of ['../malformed', undefined, null, 123])
    assert.throws(() => ingestBlock(newQueue(scope), credit(invalid)), /entity id/);
});

test('Rounds sweeps include retriable treasury balances and do not share Market retry state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-rounds-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'queue.json'), state = newQueue(scope);
  let now = 8n * day, claim = '100', roundFees = '0', treasuryBalance = '20000000';
  ingestBlock(state, credit('alice.near'));
  state.globalRetry = { sweep_fees: { failures: 1, nextAt: String(now + day) } };
  writeQueue(file, state);
  const keys = { oracle: 'ed25519:' + b58encode(Buffer.alloc(64, 1)), rounds: 'ed25519:' + b58encode(Buffer.alloc(64, 2)) };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { method, params: p } = JSON.parse(init.body);
    if (method === 'block') return Response.json({ result: { header: { height: 2, hash: 'second', timestamp_nanosec: String(now) } } });
    if (p.request_type === 'view_access_key') {
      const rounds = p.public_key === 'ed25519:' + b58encode(Buffer.alloc(32, 2));
      return Response.json({ result: { permission: { FunctionCall: { receiver_id: rounds ? scope.rounds : scope.oracle,
        method_names: rounds ? ['sweep_fees'] : ['payout_bond'], allowance: '10000' } } } });
    }
    const views = {
      'market.near:config': { markets: '0', next_sweep_id: '0', min_sweep: '1', min_sweep_interval_minutes: 60, settle_wait_minutes: 10 },
      'council.near:config': { last_day: String(now / day) },
      'market.near:get_fees': { collected: '20000000', revenue_due: '0', treasury_due: '0' },
      'rounds.near:config': { treasury: 'treasury.near' },
      'rounds.near:owed_breakdown': { fees: roundFees },
      'rounds.near:get_balance': treasuryBalance,
      'oracle.near:claimable_of': claim,
    };
    const key = p.account_id + ':' + p.method_name;
    assert.ok(Object.hasOwn(views, key), key);
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(views[key]))] } });
  });
  const opts = { ...scope, account: 'keeper.near', 'state-file': file, workers: 1, 'require-scoped-keys': true };
  const sent = [], execution = { beforeBatch: async () => {}, send: async action => { sent.push(action); return 'ok'; } };
  await queuedRun(opts, keys, execution);
  assert.deepEqual(sent.map(a => a.contract + '.' + a.method), ['rounds.sweep_fees', 'oracle.payout_bond']);
  assert.deepEqual(sent[1].args, { account_id: 'alice.near' });
  claim = '0'; treasuryBalance = '0'; now += 2_000_000_000n;
  sent.length = 0;
  await queuedRun(opts, keys, execution);
  assert.deepEqual(sent, []);
  assert.equal(readQueue(file, scope).jobs['bond:alice.near'], undefined);
  roundFees = '20000000';
  await assert.rejects(queuedRun(opts, keys, { ...execution, send: async () => { throw new Error('unavailable'); } }), /scheduled retries/);
  assert.equal(readQueue(file, scope).globalRetry['rounds:sweep_fees'].failures, 1);
  sent.length = 0;
  await queuedRun(opts, keys, execution);
  assert.deepEqual(sent, [], 'failed Rounds payout respects its own backoff');
});

test('Rounds dust and unconfigured deployments produce no sweep action', () => {
  const snapshot = { market: scope.market, markets: [], cases: {}, locked: {}, now: 1n, height: 1n, feesDue: 0n, minSweep: 10n };
  assert.deepEqual(dueActions(snapshot), []);
  assert.deepEqual(dueActions({ ...snapshot, roundsFeesDue: 9n }), []);
  assert.equal(dueActions({ ...snapshot, roundsFeesDue: 10n })[0].contract, 'rounds');
});
