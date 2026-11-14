import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyKeeperApproval } from '../../backend/dist/src/keeper-approval.js';
import { ReadRpcClient } from '../../backend/dist/src/providers.js';
import { checkTarget, environmentId, projectId, railwayQuery, services, uploadSource, verifySource, waitForDeployment } from './release.mjs';
import { checkBackups, postgresId } from './backups.mjs';
import { smoke, verifyActivated } from './smoke.mjs';
import { activationServices, agentService, expectedBrowser, origins, parseActivation, pricesService, publishersService,
  requireLaunchEvidence, verifyActivationVariables, verifySealedExecutionKeys, workerServices } from './activation-plan.mjs';

const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const recent = (date, age, now) => typeof date === 'string' && Number.isFinite(Date.parse(date)) &&
  Date.parse(date) <= now && now - Date.parse(date) <= age;
const uint = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value);

export async function json(url, token, request = fetch) {
  const response = await request(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: token ? { Authorization: `Bearer ${token}` } : {} });
  ensure(response.ok, 'Deployment probe failed');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    ensure(bytes <= 65536, 'Deployment probe exceeded its response limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function verifyOperational(status, plan, signed = false, now = Date.now()) {
  const indexing = status?.indexing;
  ensure(status?.deploymentConfigured === true && indexing?.deploymentId === plan.approval.deployment.id &&
    indexing.live === true && indexing.source?.mode === 'live' && uint(indexing.lagBlocks) && BigInt(indexing.lagBlocks) <= 100n &&
    uint(indexing.checkpoint?.timestampNs) && BigInt(indexing.checkpoint.timestampNs) <= BigInt(now) * 1000000n &&
    BigInt(now) * 1000000n - BigInt(indexing.checkpoint.timestampNs) <= 60000000000n, 'Indexer is not current');
  ensure(status.reconciliation?.solvent === true && recent(status.reconciliation.checked_at, 900000, now), 'Reconciliation is not current and solvent');
  ensure(status.chainIntegrity?.ok === true && recent(status.chainIntegrity.checked_at, 46800000, now), 'Chain integrity has not passed recently');
  ensure(status.keeper?.state === 'ready' && recent(status.keeper.last_success_at, 900000, now) &&
    (signed ? status.keeper.mode === 'sign' : ['prepare', 'check', 'sign'].includes(status.keeper.mode)), 'Keeper has not completed a current pass');
  ensure(Array.isArray(status.alerts) && status.alerts.every(alert => !signed && alert === 'keeper_signing_disabled'), 'Operational alerts block activation');
}

export const smokeExpectation = plan => ({ deployment: plan.approval.deployment, agents: plan.profile === 'agents', browser: expectedBrowser(plan) });

export async function checkOperational(plan, token, signed, request = fetch) {
  const [ready, config, status] = await Promise.all([
    json(`${origins.server}/health/ready`, null, request), json(`${origins.server}/v1/config`, null, request),
    json(`${origins.server}/v1/operator/services`, token, request),
  ]);
  verifyActivated(ready, config, { deployment: plan.approval.deployment,
    agents: signed ? plan.profile === 'agents' : config.capabilities?.agents });
  ensure(signed || config.capabilities.agents === false || plan.profile === 'agents', 'Unexpected active agent execution');
  verifyOperational(status, plan, signed);
}

function completed(service, plan, stage, message) {
  let value;
  try { value = JSON.parse(message); } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (service.name === 'database-release') return value.service === 'database-release' && value.registered === plan.approval.deployment.id;
  if (service.name === 'verify-chain') return value.ok === true && Array.isArray(value.problems) && value.problems.length === 0;
  if (service.name === 'keeper') return value.service === 'keeper' && value.mode === (stage === 'prepare' ? 'prepare' : 'sign') &&
    (stage === 'prepare' ? value.signing === false : value.signing === true && value.current === true);
  return false;
}

export async function activationSnapshot(query, plan, stage) {
  const all = [...services, ...workerServices, { name: 'keeper', id: plan.keeperServiceId }, ...publishersService(plan),
    agentService, pricesService];
  const target = await checkTarget(query, all);
  const metadata = target.environment.variables?.edges?.map(({ node }) => node);
  verifySealedExecutionKeys(plan, stage, metadata);
  const instances = target.environment.serviceInstances?.edges?.map(({ node }) => node);
  ensure(Array.isArray(instances), 'Missing deployment inventory');
  for (const service of [...all, { name: 'Postgres', id: postgresId }]) {
    const instance = instances.find(instance => instance.serviceId === service.id);
    ensure(instance?.numReplicas === 1, `Expected one replica: ${service.name}`);
    if (['server', 'mcp', 'web'].includes(service.name)) continue;
    const domains = instance.domains;
    ensure(Array.isArray(domains?.customDomains) && Array.isArray(domains?.serviceDomains) &&
      !domains.customDomains.length && !domains.serviceDomains.length, `Worker must have no public domain: ${service.name}`);
  }
  const dormant = [pricesService, ...(stage === 'prepare' || plan.profile === 'human' ? [agentService] : [])];
  for (const service of dormant) {
    const instance = instances.find(instance => instance.serviceId === service.id);
    ensure(instance && (!instance.latestDeployment || instance.latestDeployment.deploymentStopped === true), `Unapproved worker is active: ${service.name}`);
  }
  const mounts = target.environment.volumeInstances?.edges?.map(({ node }) => node).filter(v => v.serviceId === plan.keeperServiceId);
  ensure(mounts?.length === 1 && mounts[0].mountPath === '/app/.local/feeds', 'Keeper requires its isolated persistent volume');
  const database = await query(`query($environmentId: String!, $serviceId: String!) {
    tcpProxies(environmentId: $environmentId, serviceId: $serviceId) { id }
  }`, { environmentId, serviceId: postgresId });
  ensure(Array.isArray(database.tcpProxies) && !database.tcpProxies.length, 'Postgres must remain private');
  const inventory = {};
  for (const service of all) {
    const { variables, tcpProxies } = await query(`query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables: variablesForServiceDeployment(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      tcpProxies(environmentId: $environmentId, serviceId: $serviceId) { id }
    }`, { projectId, environmentId, serviceId: service.id });
    ensure(Array.isArray(tcpProxies) && !tcpProxies.length, `Unexpected public TCP exposure: ${service.name}`);
    ensure(variables && typeof variables === 'object' && !Array.isArray(variables), `Missing variable inventory: ${service.name}`);
    inventory[service.name] = Object.fromEntries(Object.entries(variables)
      .filter(([key]) => !key.startsWith('RAILWAY_') || key === 'RAILWAY_RUN_UID'));
  }
  const server = verifyActivationVariables(plan, stage, inventory);
  return { inventory, server, metadata: metadata.toSorted((a, b) => a.id.localeCompare(b.id)) };
}

function checkContracts(plan, config) {
  return verifyKeeperApproval(plan.approval, config,
    new ReadRpcClient(config.rpc.primaryUrl, config.rpc, config.rpc.primaryBearerToken),
    new ReadRpcClient(config.rpc.secondUrl, config.rpc, config.rpc.secondBearerToken));
}

export async function activatedRelease({ plan, stage, checkOnly = true, query, upload,
  wait = waitForDeployment, backups = checkBackups, contracts = checkContracts,
  operational = checkOperational, probe = json, smokeCheck = smoke, report = console.log }) {
  const selected = activationServices(plan, stage);
  if (stage === 'launch') requireLaunchEvidence(plan);
  const snapshot = await activationSnapshot(query, plan, stage);
  await backups(query, projectId, environmentId);
  await contracts(plan, snapshot.server);
  if (stage === 'launch') await operational(plan, snapshot.server.operatorToken, false);
  else {
    const built = await probe(`${origins.web}/deployment.json`);
    ensure(built?.version === 1 && ['marketId', 'oracleId', 'councilId', 'verifierId', 'nftId',
      'collateralTokenId', 'tokenId', 'agentWalletContract', 'agentApiHost'].every(key => built[key] === ''),
      'Preparation requires the inactive browser release');
  }
  report(`Verified ${stage} configuration and approved contract identity; no deployments started`);
  if (checkOnly) return;
  for (const service of selected) {
    const current = await activationSnapshot(query, plan, stage);
    ensure(isDeepStrictEqual(current.inventory, snapshot.inventory), 'Railway variables changed during the release');
    ensure(isDeepStrictEqual(current.metadata, snapshot.metadata), 'Railway variable metadata changed during the release');
    await contracts(plan, snapshot.server);
    if (service.name === 'keeper' && stage === 'launch') await operational(plan, snapshot.server.operatorToken, false);
    if (service.name === 'web') await operational(plan, snapshot.server.operatorToken, true);
    const { deploymentId } = await upload(service);
    ensure(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(deploymentId ?? ''), 'Missing deployment ID');
    report(`${service.name}: https://railway.com/project/${projectId}/service/${service.id}?id=${deploymentId}`);
    await wait(query, { ...service, ...(service.job ? { completed: message => completed(service, plan, stage, message) } : {}) }, deploymentId);
  }
  if (stage === 'launch') {
    await operational(plan, snapshot.server.operatorToken, true);
    await smokeCheck(origins.web, origins.server, origins.mcp, origins.web, smokeExpectation(plan));
    report('Deployment and configuration checks passed. Keep the funded acceptance and incident evidence with this release.');
    report(`Set the repository variable SMOKE_DEPLOYMENT_JSON to this public configuration before resuming scheduled monitoring:\n\n\`\`\`json\n${JSON.stringify(smokeExpectation(plan))}\n\`\`\``);
  } else report('Preparation deployed. Historical indexing and keeper catch-up must finish before launch; the website was not rebuilt.');
}

async function main() {
  const [stage, action, ...extra] = process.argv.slice(2);
  ensure(!extra.length && ['check', 'deploy'].includes(action), 'Usage: activate.mjs <prepare|launch> <check|deploy>');
  const plan = parseActivation(process.env.ACTIVATION_JSON, process.env.ACTIVATION_SHA256);
  verifySource(process.env, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }));
  ensure(plan.sourceCommit === process.env.GITHUB_SHA, 'The activation approval names a different application commit');
  await activatedRelease({ plan, stage, checkOnly: action === 'check', query: railwayQuery(process.env.RAILWAY_TOKEN),
    upload: service => uploadSource(service, plan.sourceCommit), report(message) {
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
    } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Activation stopped. Check the approved plan, Railway configuration, contract identity and operational gates; no automatic rollback was attempted.'); process.exitCode = 1; });
}
