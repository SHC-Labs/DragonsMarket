import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Explicit project identity prevents a stale CLI link from changing another app.
const [projectId, environmentId] = process.argv.slice(2);
if (!projectId || !environmentId) throw new Error('Usage: node deploy/railway/configure.mjs <expected-project-id> <environment-id>');
if (!process.stdin.isTTY) throw new Error('Run from a terminal so the Railway CLI can apply its configuration prompt');
const status = JSON.parse(execFileSync('railway', ['status', '--json'], { encoding: 'utf8' }));
if (status.id !== projectId) throw new Error('Linked Railway project does not match the requested project');
if (!status.environments.edges.some(({ node }) => node.id === environmentId)) throw new Error('Environment does not belong to the requested project');
const services = new Map(status.services.edges.map(({ node }) => [node.name, node.id]));
const settings = JSON.parse(readFileSync(new URL('./services.json', import.meta.url), 'utf8'));
const args = ['environment', 'edit', '--environment', environmentId, '--message', 'Apply Dragons Market service settings'];
for (const [name, fields] of Object.entries(settings)) {
  if (!services.has(name)) throw new Error(`Create the ${name} service before configuring the project`);
  for (const [path, value] of Object.entries(fields)) {
    args.push('--service-config', name, path, typeof value === 'string' ? value : JSON.stringify(value));
  }
}
execFileSync('railway', args, { stdio: 'inherit' });
const actual = JSON.parse(execFileSync('railway', ['environment', 'config', '--environment', environmentId, '--json'], { encoding: 'utf8' }));
// Railway omits these default values from the environment config response.
const defaults = { 'deploy.restartPolicyType': 'ON_FAILURE', 'deploy.sleepApplication': false };
for (const [name, fields] of Object.entries(settings)) {
  for (const [path, expected] of Object.entries(fields)) {
    const value = path.split('.').reduce((object, key) => object?.[key], actual.services[services.get(name)]) ?? defaults[path] ?? (expected === null ? null : undefined);
    if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`Railway did not apply ${name}.${path}`);
  }
}
console.log('All requested service settings verified');
