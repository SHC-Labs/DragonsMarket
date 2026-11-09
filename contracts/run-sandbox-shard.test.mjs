import test from 'node:test';
import assert from 'node:assert/strict';
import { partition } from './run-sandbox-shard.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const names = Array.from({ length: 45 }, (_, i) => `suite_${i}`);
const metadata = { packages: [{ name: 'tests', targets: [
  { name: 'tests', kind: ['lib'] }, ...names.map(name => ({ name, kind: ['test'] })),
] }] };

test('the required check refuses failed, cancelled or missing chain integration even on backend-only PRs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const script = workflow.match(/node -e '\n([\s\S]+?)\n          '/)?.[1];
  assert.ok(script, 'required check script is present');
  const run = jobs => spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, RESULTS: JSON.stringify(jobs) }, encoding: 'utf8',
  }).status;
  const jobs = { changes: { result: 'success', outputs: { contracts: 'false', chain: 'true' } },
    fmt: { result: 'skipped' }, clippy: { result: 'skipped' }, unit: { result: 'skipped' },
    keeper: { result: 'skipped' }, sandbox: { result: 'success' } };
  assert.equal(run(jobs), 0);
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.equal(run({ ...jobs, sandbox: { result } }), 1, String(result));
  }
  const missing = structuredClone(jobs);
  delete missing.sandbox;
  assert.equal(run(missing), 1);
  assert.equal(run({ ...jobs, changes: { result: 'failure' } }), 1);
  assert.equal(run({ ...jobs, changes: { result: 'success', outputs: { contracts: 'false' } } }), 1);
  jobs.changes.outputs.chain = 'false'; jobs.sandbox.result = 'skipped';
  assert.equal(run(jobs), 0, 'documentation-only changes may skip integration');
  jobs.changes.outputs.contracts = 'true'; jobs.changes.outputs.chain = 'true'; jobs.sandbox.result = 'success';
  assert.equal(run(jobs), 1, 'contract changes require the Rust checks too');
  for (const job of Object.values(jobs)) job.result = 'success';
  assert.equal(run(jobs), 0);
});

test('all integration targets occur exactly once, including targets added later', () => {
  for (const extra of [[], [{ name: 'new_regression', kind: ['test'] }]]) {
    const source = structuredClone(metadata);
    source.packages[0].targets.push(...extra);
    const selected = Array.from({ length: 8 }, (_, i) => partition(source, i, 8)).flat();
    assert.equal(new Set(selected).size, selected.length);
    assert.deepEqual(selected.sort(), [...names, ...extra.map(t => t.name)].sort());
  }
});

test('missing inventory and invalid or empty shards fail instead of silently passing', () => {
  for (const [index, count] of [[-1, 8], [8, 8], [0, 0], [0, 46], [NaN, 8], [0.5, 8]]) {
    assert.throws(() => partition(metadata, index, count));
  }
  assert.throws(() => partition({ packages: [] }, 0, 8));
});

test('the runner executes every selected suite, includes library/doc tests once, and propagates failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dragons-shards-'));
  try {
    writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata));
    writeFileSync(join(directory, 'cargo'), '#!/bin/sh\nif [ "$1" = metadata ]; then cat "$SHARD_FIXTURE/metadata.json"; else printf "%s\\n" "$*" >> "$SHARD_FIXTURE/calls"; exit "${SHARD_EXIT:-0}"; fi\n', { mode: 0o755 });
    const run = (index, status = '0') => spawnSync(process.execPath, [fileURLToPath(new URL('./run-sandbox-shard.mjs', import.meta.url)), String(index), '8'], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SHARD_FIXTURE: directory, SHARD_EXIT: status }, encoding: 'utf8',
    });
    for (let index = 0; index < 8; index++) assert.equal(run(index).status, 0);
    const calls = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 9);
    assert.equal(calls.filter(call => call.includes('--lib')).length, 1);
    assert.equal(calls.filter(call => call.includes('--doc')).length, 1);
    const actual = calls.flatMap(call => Array.from(call.matchAll(/--test (\S+)/g), match => match[1]));
    assert.deepEqual(actual.sort(), [...names].sort());
    assert.ok(calls.every(call => call.startsWith('test --locked -p tests ') && call.endsWith('-- --test-threads=2')));
    assert.equal(run(0, '17').status, 17);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
