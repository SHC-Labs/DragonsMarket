import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const projectId = '489b02ad-fd74-4413-ab91-835da8b86542';
export const environmentId = 'dfda2a3a-a864-4e86-ab25-2299069f7729';
export const services = [
  { name: 'database-release', id: 'e4fa4cc1-5cab-4fc0-9225-2306e02fb262', job: true },
  { name: 'server', id: '42ebc124-27d3-4c97-9339-af3fcf22e428' },
  { name: 'mcp', id: 'e84924f2-c6ac-49dd-a3c3-ff1cdc47b9d3' },
  { name: 'web', id: '1e270bb5-5a08-4ea2-894f-995acbc1d995' },
];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const waiting = new Set(['INITIALIZING', 'QUEUED', 'WAITING', 'BUILDING', 'DEPLOYING']);
const settings = JSON.parse(readFileSync(new URL('./services.json', import.meta.url), 'utf8'));

export function verifySource(env, head, changes) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'SHC-Labs/DragonsMarket' ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Production releases require a manual run from SHC-Labs/DragonsMarket main');
  }
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') || head.trim() !== env.GITHUB_SHA || changes.trim()) {
    throw new Error('Release source must be the clean commit checked by this workflow');
  }
}

export function verifyTarget(data) {
  if (data.projectToken?.projectId !== projectId || data.projectToken?.environmentId !== environmentId ||
      data.environment?.projectId !== projectId || data.environment?.id !== environmentId) {
    throw new Error('Railway project token does not match Dragons Market production');
  }
  if (data.environment.unmergedChangesCount) throw new Error('Apply or discard staged Railway changes before releasing');
  const defaults = { 'deploy.restartPolicyType': 'ON_FAILURE', 'deploy.sleepApplication': false };
  for (const service of services) {
    const actual = data.environment.config.services[service.id];
    if (actual?.source?.repo || actual?.source?.image || actual?.deploy?.cronSchedule) {
      throw new Error(`Unexpected source or schedule on ${service.name}`);
    }
    for (const [path, expected] of Object.entries(settings[service.name])) {
      const value = path.split('.').reduce((object, key) => object?.[key], actual) ?? defaults[path];
      if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`Railway configuration drift: ${service.name}.${path}`);
    }
  }
}

export function railwayQuery(token, request = fetch) {
  if (!token) throw new Error('Set the production environment RAILWAY_TOKEN secret');
  return async (query, variables = {}) => {
    const response = await request('https://backboard.railway.com/graphql/v2', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Railway API request failed (HTTP ${response.status})`);
    const result = await response.json();
    if (result.errors?.length || !result.data) throw new Error('Railway API rejected the release query');
    return result.data;
  };
}

export async function checkTarget(query) {
  const data = await query(`query($environmentId: String!) {
    projectToken { projectId environmentId }
    environment(id: $environmentId) { id projectId unmergedChangesCount config(decryptVariables: false) }
  }`, { environmentId });
  verifyTarget(data);
}

export async function waitForDeployment(query, service, id, { sleep = delay, now = Date.now, timeout = 900000, log = console.log } = {}) {
  const deadline = now() + timeout;
  let previous;
  while (now() < deadline) {
    const { deployment } = await query(`query($id: String!) {
      deployment(id: $id) { id projectId environmentId serviceId status deploymentStopped }
    }`, { id });
    if (!deployment || deployment.id !== id || deployment.projectId !== projectId ||
        deployment.environmentId !== environmentId || deployment.serviceId !== service.id) {
      throw new Error(`Deployment identity mismatch for ${service.name}`);
    }
    if (deployment.status !== previous) log(`${service.name}: ${deployment.status}`);
    previous = deployment.status;
    if (deployment.status === 'SUCCESS') {
      if (!service.job) {
        if (deployment.deploymentStopped) throw new Error(`${service.name} stopped after deployment`);
        return;
      }
      if (deployment.deploymentStopped) {
        const { deploymentLogs } = await query(`query($id: String!) {
          deploymentLogs(deploymentId: $id, limit: 100) { message }
        }`, { id });
        if (deploymentLogs.some(({ message }) => /^Applied \d+ migration\(s\); service database roles are ready$/.test(message))) return;
      }
    } else if (!waiting.has(deployment.status)) {
      throw new Error(`${service.name} deployment ended with ${deployment.status}; inspect ${id}`);
    }
    await sleep(10000);
  }
  throw new Error(`Timed out waiting for ${service.name}; inspect ${id} before retrying`);
}

export async function release({ query, upload, wait = waitForDeployment, report = console.log }) {
  await checkTarget(query);
  for (const service of services) {
    const { deploymentId } = await upload(service);
    if (!uuid.test(deploymentId ?? '')) throw new Error(`Railway did not return a deployment ID for ${service.name}`);
    report(`${service.name}: https://railway.com/project/${projectId}/service/${service.id}?id=${deploymentId}`);
    await wait(query, service, deploymentId);
  }
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) throw new Error('Usage: node deploy/railway/release.mjs [--check]');
  const query = railwayQuery(process.env.RAILWAY_TOKEN);
  if (process.argv[2] === '--check') {
    await checkTarget(query);
    console.log('Railway project token and release service settings verified; no deployments started');
    return;
  }
  verifySource(process.env, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }));
  const sha = process.env.GITHUB_SHA;
  await release({
    query,
    upload(service) {
      let output;
      try {
        output = execFileSync('railway', ['up', '--detach', '--json', '--project', projectId,
          '--environment', environmentId, '--service', service.id, '--message', `GitHub ${sha}`],
        { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        throw new Error(`Railway upload failed for ${service.name}; inspect Railway before retrying`);
      }
      return JSON.parse(output);
    },
    report(message) {
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
