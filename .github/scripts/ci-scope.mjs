import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const quick = ['backend', 'mcp', 'web', 'keeper', 'deploy', 'database', 'contracts'];
const sharedApps = ['backend', 'mcp', 'web', 'keeper', 'deploy', 'database', 'backup', 'browser'];
const rules = [
  [/^(package\.json|pnpm-(lock|workspace)\.yaml|\.node-version)$/, sharedApps],
  [/^\.github\//, sharedApps],
  [/^\.github\/(scripts\/|workflows\/ci\.yml$)/, ['contracts']],
  [/^backend\//, ['backend', 'mcp', 'database']],
  [/^backend\/(ops\/|scripts\/backup\.sh$|test\/backup-restore\.test\.ts$)/, ['backup']],
  [/^contracts\/keeper\//, ['keeper', 'backend', 'database']],
  [/^contracts\/(?!keeper\/).*(?<!\.md)$/, ['contracts', 'keeper']],
  [/^mcp\//, ['mcp']],
  [/^web\//, ['web']],
  [/^web\/(package\.json|\.node-version|next\.config\.[^/]+|scripts\/.*)$/, ['browser']],
  [/^web\/(lib\/(config|wallet|auth|near|intents|cash-out)[^/]*|components\/.*[Ww]allet[^/]*)$/, ['browser']],
  [/^Caddyfile$/, ['web', 'browser', 'deploy']],
  [/^(deploy\/|\.dockerignore$)/, ['deploy']],
];

export function ciScope(files, full = false) {
  const scope = Object.fromEntries([...quick, 'backup', 'browser', 'chain'].map(key => [key, full]));
  for (const file of files) {
    const matches = rules.filter(([pattern]) => pattern.test(file));
    const selected = matches.flatMap(([, checks]) => checks);
    if (!matches.length && !/^(docs\/|\.gitignore$|\.gitattributes$|LICENSE$)|\.md$/.test(file)) selected.push(...quick);
    for (const key of selected) scope[key] = true;
  }
  if (scope.backup) scope.database = true;
  if (scope.deploy) scope.backend = true;
  scope.install = scope.backend || scope.mcp || scope.web || scope.database || scope.browser;
  return scope;
}

function changedFiles(base) {
  return execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD', '--'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
}

export function planCi(env, diff = changedFiles) {
  const full = env.CI_FULL === 'true';
  if (full && env.GITHUB_REPOSITORY === 'SHC-Labs/Dragons-Market' && env.CI_PAID_PRIVATE !== 'true') {
    throw new Error('Full private validation requires the explicit paid_private_checks opt-in');
  }
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    if (!/^[a-f0-9]{40}$/.test(env.CI_BASE_SHA ?? '')) throw new Error('Missing pull request base commit');
    return ciScope(diff(env.CI_BASE_SHA), full);
  }
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Unsupported CI event');
  const scope = ciScope([], true);
  if (!full) scope.backup = scope.browser = scope.chain = false;
  return scope;
}

export function requireContractChecks(jobs) {
  if (jobs.changes?.result !== 'success') throw new Error('CI scope detection did not succeed');
  const { contracts, chain, keeper } = jobs.changes.outputs ?? {};
  if (![contracts, chain, keeper].every(value => ['true', 'false'].includes(value))) {
    throw new Error('Invalid CI scope outputs');
  }
  const required = ['changes', ...(contracts === 'true' ? ['unit'] : []),
    ...(keeper === 'true' ? ['keeper'] : []), ...(chain === 'true' ? ['unit', 'keeper', 'clippy', 'sandbox'] : [])];
  for (const name of required) {
    if (jobs[name]?.result !== 'success') throw new Error(`${name}: not successful`);
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (!['success', 'skipped'].includes(job.result)) throw new Error(`${name}: ${job.result}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scope = planCi(process.env);
  const output = Object.entries(scope).map(([key, value]) => `${key}=${value}\n`).join('');
  appendFileSync(process.env.GITHUB_OUTPUT, output);
  console.log(output.trimEnd());
}
