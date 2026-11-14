import test from 'node:test';
import assert from 'node:assert/strict';
import { ciScope, planCi, requireContractChecks } from './ci-scope.mjs';

test('documentation needs no package install, database, compiler or sandbox', () => {
  const scope = ciScope(['docs/RAILWAY.md', 'README.md']);
  assert.ok(Object.values(scope).every(value => value === false));
});

test('routine web and MCP edits select their own checks', () => {
  const web = ciScope(['web/app/page.tsx']);
  assert.equal(web.web, true);
  assert.equal(web.install, true);
  for (const key of ['backend', 'mcp', 'database', 'backup', 'browser', 'contracts', 'chain']) assert.equal(web[key], false, key);
  const mcp = ciScope(['mcp/src/server.ts', 'mcp/skill/SKILL.md']);
  assert.equal(mcp.mcp, true);
  assert.equal(mcp.web, false);
  assert.equal(mcp.database, false);
});

test('backend changes exercise API contracts and real database tests without Rust sandbox', () => {
  const scope = ciScope(['backend/src/agents.ts', 'backend/migrations/022.sql']);
  for (const key of ['backend', 'mcp', 'database']) assert.equal(scope[key], true, key);
  for (const key of ['web', 'backup', 'browser', 'contracts', 'chain']) assert.equal(scope[key], false, key);
});

test('deployment checks build the backend modules and fixtures they import', () => {
  for (const file of ['deploy/railway/release.mjs', 'deploy/railway/activate.test.mjs', '.dockerignore']) {
    const scope = ciScope([file]);
    for (const key of ['deploy', 'backend', 'install']) assert.equal(scope[key], true, `${file}: ${key}`);
    for (const key of ['web', 'database', 'contracts', 'chain']) assert.equal(scope[key], false, `${file}: ${key}`);
  }
});

test('backup and browser boundary changes retain their targeted integration checks', () => {
  assert.equal(ciScope(['backend/scripts/backup.sh']).backup, true);
  assert.equal(ciScope(['backend/ops/restore.sh']).database, true);
  for (const file of ['Caddyfile', 'web/scripts/prepare-caddy.mjs', 'web/components/WalletProvider.tsx', 'web/lib/cash-out.ts', 'web/next.config.ts']) {
    assert.equal(ciScope([file]).browser, true, file);
  }
});

test('keeper edits do not compile Rust and Rust edits do not start eight sandbox shards', () => {
  const keeper = ciScope(['contracts/keeper/keeper.mjs']);
  for (const key of ['keeper', 'backend', 'database']) assert.equal(keeper[key], true, key);
  assert.equal(keeper.contracts, false);
  assert.equal(keeper.chain, false);
  const rust = ciScope(['contracts/market/src/lib.rs']);
  assert.equal(rust.contracts, true);
  assert.equal(rust.keeper, true);
  assert.equal(rust.chain, false);
});

test('shared inputs and unknown code receive broad checks without implicit full runs', () => {
  for (const file of ['pnpm-lock.yaml', '.github/workflows/ci.yml', 'new-service/server.ts']) {
    const scope = ciScope([file]);
    for (const key of ['backend', 'mcp', 'web']) assert.equal(scope[key], true, `${file}: ${key}`);
    assert.equal(scope.chain, false, file);
  }
  assert.ok(Object.values(ciScope([], true)).every(value => value === true));
  assert.equal(ciScope(['pnpm-lock.yaml']).contracts, false, 'JavaScript dependencies do not rebuild Rust');
});

test('PR diff errors fail closed and renamed/deleted old paths still select checks', () => {
  const env = { GITHUB_EVENT_NAME: 'pull_request', CI_BASE_SHA: 'a'.repeat(40) };
  assert.throws(() => planCi({ ...env, CI_BASE_SHA: '--help' }), /base commit/);
  assert.throws(() => planCi(env, () => { throw new Error('missing commit'); }), /missing commit/);
  const scope = planCi(env, base => {
    assert.equal(base, env.CI_BASE_SHA);
    return ['backend/src/removed.ts', 'docs/moved-example.md'];
  });
  assert.equal(scope.database, true);
});

test('full private checks require separate consent and release checks cover everything', () => {
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'SHC-Labs/Dragons-Market', CI_FULL: 'true' };
  assert.throws(() => planCi(env), /paid_private_checks/);
  assert.ok(Object.values(planCi({ ...env, CI_PAID_PRIVATE: 'true' })).every(Boolean));
  assert.ok(Object.values(planCi({ ...env, GITHUB_REPOSITORY: 'SHC-Labs/DragonsMarket' })).every(Boolean));
  assert.equal(planCi({ ...env, CI_FULL: 'false' }).chain, false);
  assert.equal(planCi({ ...env, CI_FULL: 'false' }).contracts, true);
  assert.equal(planCi({ ...env, CI_FULL: 'false' }).browser, false);
  assert.throws(() => planCi({ GITHUB_EVENT_NAME: 'push' }), /Unsupported CI event/);
});

test('required gate accepts deliberate omissions but refuses lost, failed or cancelled checks', () => {
  const jobs = { changes: { result: 'success', outputs: { contracts: 'false', chain: 'false', keeper: 'false' } },
    unit: { result: 'skipped' }, clippy: { result: 'skipped' }, sandbox: { result: 'skipped' },
    keeper: { result: 'skipped' } };
  assert.doesNotThrow(() => requireContractChecks(jobs));
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.throws(() => requireContractChecks({ ...jobs, changes: { ...jobs.changes, result } }), /scope detection/);
  }
  for (const value of [undefined, '', 'TRUE']) {
    assert.throws(() => requireContractChecks({ ...jobs,
      changes: { result: 'success', outputs: { ...jobs.changes.outputs, contracts: value } } }), /scope outputs/);
  }
  jobs.changes.outputs.contracts = 'true';
  assert.throws(() => requireContractChecks(jobs), /unit: not successful/);
  jobs.unit.result = 'success';
  assert.doesNotThrow(() => requireContractChecks(jobs));
  jobs.changes.outputs.chain = jobs.changes.outputs.keeper = 'true';
  for (const job of ['unit', 'keeper', 'clippy', 'sandbox']) jobs[job].result = 'success';
  assert.doesNotThrow(() => requireContractChecks(jobs));
  for (const job of ['unit', 'keeper', 'clippy', 'sandbox']) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      assert.throws(() => requireContractChecks({ ...jobs, [job]: { result } }), /not successful/);
    }
  }
});
