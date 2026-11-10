import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readConfig } from '../../backend/dist/src/config.js';
import { parseKeeperApproval } from '../../backend/dist/src/keeper-approval.js';
import { isAccount } from '../../backend/dist/src/validate.js';
import { NeardataReader, readNeardataSettings } from '../../backend/dist/src/ingestion/neardata.js';
import { services } from './release.mjs';
import { postgresId } from './backups.mjs';

export const origins = { web: 'https://dragons.market', server: 'https://api.dragons.market', mcp: 'https://mcp.dragons.market' };
export const workerServices = [
  { name: 'indexer', id: 'f6887306-3294-4c10-8114-d9915b892983' },
  { name: 'reconcile', id: '0c3219b8-1222-417a-ad8a-13d91bd8d298' },
  { name: 'verify-chain', id: '10cad31b-9af4-4600-b5ab-097351380ec5', job: true },
];
export const agentService = { name: 'agent-worker', id: '52ef567e-f69e-4416-8ec8-b0290b8c0a19' };
export const pricesService = { name: 'prices', id: 'b97a6ec3-1eb6-4387-914b-b09a2883e869' };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const digest = raw => createHash('sha256').update(raw).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

function https(value, originOnly = false) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash &&
      (!originOnly || value === u.origin);
  } catch { return false; }
}

export function manifestVariables(deployment) {
  return {
    NETWORK: 'mainnet', DEPLOYMENT_ID: deployment.id, DEPLOYMENT_START_BLOCK: deployment.startBlock,
    ...Object.fromEntries(Object.entries(deployment.contracts).map(([role, account]) => [`${role.toUpperCase()}_CONTRACT_ID`, account])),
    COLLATERAL_TOKEN_ID: deployment.collateralTokenId, COLLATERAL_DECIMALS: String(deployment.collateralDecimals),
  };
}

export function parseActivation(raw, expectedDigest) {
  requireValue(typeof raw === 'string' && Buffer.byteLength(raw) <= 49152 && /^[a-f0-9]{64}$/.test(expectedDigest ?? '') &&
    digest(raw) === expectedDigest, 'Activation plan digest mismatch');
  const plan = JSON.parse(raw);
  requireValue(object(plan) && plan.version === 1 && /^[a-f0-9]{40}$/.test(plan.sourceCommit ?? '') && !/^0+$/.test(plan.sourceCommit) &&
    ['human', 'agents'].includes(plan.profile) && uuid.test(plan.keeperServiceId ?? '') &&
    https(plan.publicRpcUrl, true) && object(plan.keeperApproval) && object(plan.keeperApproval.deployment), 'Invalid activation plan');
  const config = readConfig({ DATABASE_URL: 'postgres://localhost/validation', ...manifestVariables(plan.keeperApproval.deployment) });
  const approvalJson = JSON.stringify(plan.keeperApproval);
  const approval = parseKeeperApproval(approvalJson, digest(approvalJson), config);
  requireValue(approval.deployment.collateralDecimals === 6, 'The browser currently supports six-decimal collateral');
  requireValue(![...services, ...workerServices, agentService, pricesService].some(s => s.id === plan.keeperServiceId) &&
    plan.keeperServiceId !== postgresId, 'Keeper must have its own service');
  if (plan.profile === 'agents') {
    requireValue(object(plan.agent) && https(plan.agent.apiUrl, true) && isAccount(plan.agent.walletContract) &&
      !plan.agent.walletContract.endsWith('.testnet') && !['intents.near', 'intents.far'].includes(plan.agent.walletContract),
      'Invalid agent destinations');
  } else requireValue(plan.agent === undefined, 'Human release must not contain agent activation');
  return { ...plan, approval, approvalJson, approvalDigest: digest(approvalJson) };
}

export function requireLaunchEvidence(plan) {
  requireValue(https(plan.launchEvidence), 'Link the reviewed funded human acceptance, market disposition and operational evidence before launch');
  if (plan.profile === 'agents') requireValue(https(plan.agent.acceptanceEvidence), 'Agent activation requires actual partner acceptance evidence');
}

export function activationServices(plan, stage) {
  requireValue(['prepare', 'launch'].includes(stage), 'Invalid activation stage');
  const keeper = { name: 'keeper', id: plan.keeperServiceId, job: true };
  const foundation = name => services.find(service => service.name === name);
  return [foundation('database-release'), ...workerServices, keeper,
    ...(stage === 'launch' && plan.profile === 'agents' ? [agentService] : []),
    foundation('server'), foundation('mcp'), ...(stage === 'launch' ? [foundation('web')] : [])];
}

function same(actual, expected, label) {
  requireValue(isDeepStrictEqual(actual, expected), `Activation configuration mismatch: ${label}`);
}

export function expectedBrowser(plan) {
  const d = plan.approval.deployment;
  return { version: 1, sourceCommit: plan.sourceCommit, network: 'mainnet', marketId: d.contracts.market, oracleId: d.contracts.oracle,
    councilId: d.contracts.council, verifierId: d.contracts.verifier, nftId: plan.approval.contracts.nft.accountId,
    collateralTokenId: d.collateralTokenId, tokenId: d.collateralTokenId.slice(7), tokenDecimals: d.collateralDecimals,
    rpcUrl: plan.publicRpcUrl, backendUrl: origins.server, mcpUrl: origins.mcp,
    agentWalletContract: plan.profile === 'agents' ? plan.agent.walletContract : '',
    agentApiHost: plan.profile === 'agents' ? new URL(plan.agent.apiUrl).hostname : '' };
}

const secretOwners = {
  OPERATOR_TOKEN: ['server'], AGENT_WORKER_TOKEN: ['server', 'agent-worker'],
  AGENT_API_KEY: ['agent-worker'], AGENT_GRANT_KEY: ['agent-worker'],
  KEEPER_MARKET_KEY: ['keeper'], KEEPER_ORACLE_KEY: ['keeper'], KEEPER_COUNCIL_KEY: ['keeper'],
  KEEPER_ROUNDS_KEY: ['keeper'],
  RPC_PRIMARY_BEARER_TOKEN: ['database-release', 'server', 'indexer', 'reconcile', 'verify-chain', 'keeper', 'agent-worker'],
  RPC_SECOND_BEARER_TOKEN: ['database-release', 'server', 'indexer', 'reconcile', 'verify-chain', 'keeper', 'agent-worker'],
  NEARDATA_BEARER_TOKEN: ['indexer'],
};

export function verifySealedExecutionKeys(plan, stage, entries) {
  requireValue(Array.isArray(entries), 'Missing variable metadata');
  const owners = { KEEPER_MARKET_KEY: plan.keeperServiceId, KEEPER_ORACLE_KEY: plan.keeperServiceId,
    KEEPER_COUNCIL_KEY: plan.keeperServiceId, KEEPER_ROUNDS_KEY: plan.keeperServiceId,
    AGENT_API_KEY: agentService.id, AGENT_GRANT_KEY: agentService.id };
  for (const [name, serviceId] of Object.entries(owners)) {
    const rows = entries.filter(entry => entry.name === name);
    const active = stage === 'launch' && (serviceId === plan.keeperServiceId || plan.profile === 'agents')
      && (name !== 'KEEPER_ROUNDS_KEY' || Boolean(plan.approval.deployment.contracts.rounds));
    requireValue(active ? rows.length === 1 && rows[0].serviceId === serviceId && rows[0].isSealed === true
      : rows.length === 0, `Execution credential must match its sealed service boundary: ${name}`);
  }
}

function checkDatabasePasswords(inventory) {
  const vars = inventory['database-release'];
  requireValue(object(vars), 'Missing database-release variables');
  const roles = ['API', 'INDEXER', 'WORKER', 'PUBLISHER', 'AGENT', 'KEEPER'];
  if (vars.BACKUP_DB_PASSWORD !== undefined) roles.push('BACKUP');
  const passwords = roles.map(role => vars[`${role}_DB_PASSWORD`]);
  requireValue(passwords.every(password => /^[a-f0-9]{64}$/.test(password ?? '')) &&
    new Set(passwords).size === passwords.length, 'Service database passwords must be distinct 32-byte hex values');
  return Object.fromEntries(roles.map(role => [`dm_${role.toLowerCase()}_login`, vars[`${role}_DB_PASSWORD`]]));
}

function checkCredentials(name, vars) {
  requireValue(object(vars), `Missing variable inventory: ${name}`);
  requireValue(!vars.RAILWAY_RUN_UID || vars.RAILWAY_RUN_UID === (name === 'web' ? '1000' : '65532'),
    `Service must use its image user: ${name}`);
  for (const [key, value] of Object.entries(vars)) {
    if (value === '' || value === undefined || key.startsWith('RAILWAY_') || !/(?:_KEY|_TOKEN|_PASSWORD)$/.test(key)) continue;
    const allowed = /^(API|INDEXER|WORKER|PUBLISHER|AGENT|KEEPER|BACKUP)_DB_PASSWORD$/.test(key)
      ? ['database-release'] : secretOwners[key] ?? [];
    requireValue(allowed.includes(name), `Credential in the wrong service: ${name}.${key}`);
  }
  requireValue(!vars.PUBLISH_ROUND_PRICES || vars.PUBLISH_ROUND_PRICES === 'false',
    'Price publishing requires a separate reviewed release');
  if (['web', 'mcp'].includes(name)) requireValue(!vars.DATABASE_URL, `Database credentials are forbidden on ${name}`);
}

function chainConfiguration(name, vars, plan, passwords) {
  const workerSecrets = new Set(['AGENT_API_KEY', 'AGENT_GRANT_KEY', 'AGENT_WORKER_TOKEN', 'AGENT_WORKER_URL']);
  const config = readConfig(name === 'agent-worker'
    ? Object.fromEntries(Object.entries(vars).filter(([key]) => !workerSecrets.has(key))) : vars);
  same(config.deployment, plan.approval.deployment, `${name} deployment`);
  same(config.network, 'mainnet', `${name} network`);
  const connection = new URL(config.databaseUrl);
  const login = { server: 'api', indexer: 'indexer', reconcile: 'worker', 'verify-chain': 'worker',
    keeper: 'keeper', 'agent-worker': 'agent' }[name];
  same(connection.hostname, 'postgres.railway.internal', `${name} database host`);
  same(connection.port, '5432', `${name} database port`);
  same(connection.username, login ? `dm_${login}_login` : 'postgres', `${name} database role`);
  const password = decodeURIComponent(connection.password);
  requireValue(Boolean(password), `Missing database credential: ${name}`);
  if (login) same(password, passwords[connection.username], `${name} database credential reference`);
  else requireValue(!Object.values(passwords).includes(password), 'Owner password must be separate');
  requireValue(config.rpc.primaryUrl.startsWith('https:') && config.rpc.secondUrl?.startsWith('https:'),
    `Two HTTPS providers required: ${name}`);
  return config;
}

function checkHttpServices(server, mcp) {
  same(server.webOrigin, origins.web, 'browser origin');
  same(server.host, '::', 'server private/public listener');
  same(server.port, 3500, 'server port');
  same(server.trustedProxyHops, 1, 'server proxy hops');
  same(server.trustedProxyAddresses, ['0.0.0.0/0', '::/0'], 'server ingress');
  same(server.trustedProxyHeader, 'x-real-ip', 'server forwarding header');
  requireValue(server.operatorToken !== null, 'The launch gate requires the private operator health token');
  same(mcp.DRAGONS_API_URL, 'http://server.railway.internal:3500', 'MCP backend');
  same(mcp.MCP_PUBLIC_URL, origins.mcp, 'MCP public origin');
  same(mcp.MCP_TRUSTED_PROXY_ADDRESSES, '0.0.0.0/0,::/0', 'MCP ingress');
  same(mcp.HOST, '::', 'MCP listener');
  same(mcp.PORT, '3700', 'MCP port');
}

function checkKeeperStage(plan, stage, inventory) {
  same(inventory['database-release'].REGISTER_DEPLOYMENT, 'true', 'deployment registration');
  for (const name of ['database-release', 'keeper']) {
    same(inventory[name].KEEPER_APPROVAL_JSON, plan.approvalJson, `${name} approval`);
    same(inventory[name].KEEPER_APPROVAL_SHA256, plan.approvalDigest, `${name} approval digest`);
  }
  same(inventory.keeper.KEEPER_MODE, stage === 'prepare' ? 'prepare' : 'sign', 'keeper mode');
  for (const role of ['MARKET', 'ORACLE', 'COUNCIL', 'ROUNDS']) {
    const value = inventory.keeper[`KEEPER_${role}_KEY`];
    const active = stage === 'launch' && (role !== 'ROUNDS' || Boolean(plan.approval.deployment.contracts.rounds));
    requireValue(active ? value === null : value === undefined || value === '',
      'Keeper signing keys must be absent during preparation and sealed for launch');
  }
}

function checkAgentStage(plan, agents, inventory, server) {
  if (agents) {
    const worker = inventory['agent-worker'];
    same(worker.AGENT_API_KEY, null, 'sealed Agent API key');
    same(worker.AGENT_GRANT_KEY, null, 'sealed grant encryption key');
    same(worker.AGENT_API_URL, plan.agent.apiUrl, 'Agent API destination');
    same(worker.AGENT_API_WALLET_CONTRACT, plan.agent.walletContract, 'Agent wallet contract');
    same(worker.AGENT_WORKER_HOST, '::', 'Agent worker private listener');
    same(worker.AGENT_WORKER_PORT ?? '3510', '3510', 'Agent worker port');
    same(server.agentWorker, { url: 'http://agent-worker.railway.internal:3510', token: worker.AGENT_WORKER_TOKEN }, 'Agent worker link');
  } else {
    requireValue(server.agentWorker === null, 'Agent execution must remain disabled');
    for (const key of ['AGENT_API_KEY', 'AGENT_GRANT_KEY', 'AGENT_WORKER_TOKEN']) {
      requireValue(inventory['agent-worker'][key] === undefined || inventory['agent-worker'][key] === '',
        'Inactive agent worker must not receive credentials');
    }
  }
}

function checkBrowserStage(plan, stage, web) {
  const browser = expectedBrowser(plan);
  const mapping = { sourceCommit: 'RELEASE_COMMIT', network: 'NETWORK', marketId: 'MARKET_ID', oracleId: 'ORACLE_ID', councilId: 'COUNCIL_ID', verifierId: 'VERIFIER_ID',
    nftId: 'NFT_ID', collateralTokenId: 'COLLATERAL_TOKEN_ID', tokenId: 'TOKEN_ID', rpcUrl: 'RPC_URL',
    backendUrl: 'BACKEND_URL', mcpUrl: 'MCP_URL', agentWalletContract: 'AGENT_WALLET_CONTRACT', agentApiHost: 'AGENT_API_HOST' };
  if (stage === 'launch') {
    for (const [field, key] of Object.entries(mapping)) same(web[`NEXT_PUBLIC_${key}`] ?? '', browser[field], `web.${key}`);
  } else {
    for (const key of ['MARKET_ID', 'ORACLE_ID', 'COUNCIL_ID', 'VERIFIER_ID', 'NFT_ID', 'COLLATERAL_TOKEN_ID', 'TOKEN_ID', 'AGENT_WALLET_CONTRACT', 'AGENT_API_HOST'])
      requireValue(!web[`NEXT_PUBLIC_${key}`], 'Preparation must leave the browser inactive');
  }
}

export function verifyActivationVariables(plan, stage, inventory) {
  const passwords = checkDatabasePasswords(inventory);
  const chainServices = ['database-release', 'server', 'indexer', 'reconcile', 'verify-chain', 'keeper'];
  const agents = stage === 'launch' && plan.profile === 'agents';
  if (agents) chainServices.push('agent-worker');
  for (const name of [...chainServices, 'web', 'mcp', ...(!agents ? ['agent-worker'] : []), 'prices']) {
    checkCredentials(name, inventory[name]);
  }
  const configurations = Object.fromEntries(chainServices.map(name =>
    [name, chainConfiguration(name, inventory[name], plan, passwords)]));
  const server = configurations.server;
  for (const [name, config] of Object.entries(configurations)) {
    same(config.rpc, server.rpc, `${name} RPC settings`);
    same(new URL(config.databaseUrl).pathname, new URL(server.databaseUrl).pathname, `${name} database`);
    if (name !== 'server') requireValue(config.agentWorker === null, `Worker link belongs only to server: ${name}`);
  }
  checkHttpServices(server, inventory.mcp);
  checkKeeperStage(plan, stage, inventory);
  const source = readNeardataSettings(inventory.indexer);
  new NeardataReader(undefined, undefined, source.intervalMs, source);
  checkAgentStage(plan, agents, inventory, server);
  checkBrowserStage(plan, stage, inventory.web);
  return server;
}
