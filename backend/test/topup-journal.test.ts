import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../src/durable-file.js';
import { ATTACKER, NEAR, SCRATCH, USD, attempt, harness, memoryJournal } from './topup-harness.js';

test('a journal that is gone (another host under the shared lock, a fresh container disk, another cwd) does not let a second deposit out while the first sits FAILED', async () => {
  const h = harness({ oneClick: { statuses: ['FAILED'], depositAddress: ATTACKER } });
  assert.equal(await attempt(h.run()), 'swap_needs_operator');
  const states = [];
  for (let run = 0; run < 3; run++) states.push(await attempt(h.run({ journal: memoryJournal(() => h.clock.now, h.journal.db) })));
  assert.equal(h.chain.transfers.length, 1, `the sticky operator state must survive the local file; later runs ended ${JSON.stringify(states)}`);
  assert.equal(h.click.requests.length, 1, 'no new quote while a deposit is unresolved');
});

test('a journal directory others can write is refused, since they can delete or swap the journal and erase the pending step', () => {
  const dir = join(SCRATCH, 'shared-dir');
  mkdirSync(dir);
  chmodSync(dir, 0o777);
  const file = join(dir, 'relayer.near.journal.json');
  writePrivateJson(file, { version: 1, pending: { step: 'swap' } });
  assert.throws(() => readPrivateJson(file, 16_384, 'unsafe_topup_journal'), /unsafe_topup_journal/);
});

test('a journal replaced by a dangling symlink is refused, not read as "nothing pending"', () => {
  const dir = join(SCRATCH, 'private-dir');
  mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, 'relayer.near.journal.json');
  symlinkSync(join(dir, 'nowhere'), file);
  assert.throws(() => readPrivateJson(file, 16_384, 'unsafe_topup_journal'), /unsafe_topup_journal|ELOOP/);
});

test('a relayer with no journal row is refused in execute mode; only a dry-run, which can have nothing in flight, creates the row', async () => {
  const h = harness();
  h.journal.db.row = null;
  assert.equal(await attempt(h.run()), 'topup_journal_missing');
  assert.equal(h.click.requests.length, 0);
  assert.equal(await attempt(h.run({ settings: { ...h.deps.settings, mode: 'dry-run' } })), 'dry_run');
  assert.deepEqual(h.journal.db.row, { verifier: 'intents.near', pending: null });
  assert.equal(await attempt(h.run()), 'topped_up');
});

test('RELAY_TOPUP_MAX_USDC_PER_DAY bounds the deposits of every run in a rolling day, across hosts sharing the journal', async () => {
  const h = harness({ settings: { belowYocto: 1000n * NEAR, maxUnitsPerDay: 30n * USD } });
  const states = [];
  for (let run = 0; run < 3; run++) states.push(await attempt(h.run({ journal: memoryJournal(() => h.clock.now, h.journal.db) })));
  assert.deepEqual(states, ['topped_up', 'topped_up', 'daily_cap_reached']);
  assert.deepEqual(h.chain.transfers.map(t => t.amount), [20n * USD, 10n * USD], 'the second deposit is cut to what the day has left');
  h.clock.now += 24 * 3600 * 1000;
  assert.equal(await attempt(h.run()), 'topped_up');
  assert.equal(h.chain.transfers.length, 3);
});
