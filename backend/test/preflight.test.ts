import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { preflightSummary } from '../src/preflight.js';

test('strict activation rejects warnings and empty evidence; diagnostics never call warnings ready', () => {
  const pass = { name: 'contract:market', status: 'pass' as const, detail: 'checked' };
  for (const strict of [false, true]) {
    assert.equal(preflightSummary([], strict).summary, 'not_ready');
    assert.equal(preflightSummary([pass], strict).summary, 'ready');
    assert.equal(preflightSummary([{ ...pass, status: 'fail' }], strict).summary, 'not_ready');
  }
  const warnings = [pass, { name: 'rounds:threshold', status: 'warn' as const, detail: 'unsafe quorum' }];
  assert.deepEqual(preflightSummary(warnings, true), { summary: 'not_ready', failed: 0, warnings: 1 });
  assert.deepEqual(preflightSummary(warnings, false), { summary: 'warnings', failed: 0, warnings: 1 });
});

test('misspelled or duplicated strict arguments fail before opening the database', () => {
  for (const args of [['--strcit'], ['--strict', '--strict'], ['--strict=false']]) {
    const result = spawnSync(process.execPath, ['dist/src/preflight.js', ...args], {
      encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'not-a-database' }, timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: preflight\.js/);
    assert.equal(result.stdout, '');
  }
});
