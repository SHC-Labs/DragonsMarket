import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './config.js';
import { base58Decode } from './base58.js';
import { finalizedHead, viewAt } from './chain-view.js';
import { object } from './ingestion/block.js';
import type { ReadRpcClient } from './providers.js';
import { isAccount, isUint, isUnits } from './validate.js';
import { assertDaoPolicy, daoPolicyHash } from './dao-policy.js';

type Rpc = Pick<ReadRpcClient, 'call'>;
const ROLES = ['market', 'oracle', 'council', 'rounds', 'verifier', 'nft', 'collateral'] as const;
type Role = typeof ROLES[number];
const FINANCIAL = ['market', 'oracle', 'council', 'rounds'] as const;
const HEX = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MAX_APPROVAL_AGE = 30 * 24 * 3600_000;

export interface KeeperApproval {
  version: 1;
  network: 'mainnet';
  deployment: NonNullable<Config['deployment']>;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  reviewEvidence: string;
  marketIds: string[];
  contracts: Partial<Record<Role, { accountId: string; codeHash: string; sourceCommit: string; buildEvidence: string }>>;
  controls: { owner: string; operator: string; treasury: string };
  governance: { codeHash: string; policySha256: string; minApprovals: number;
    sourceCommit: string; buildEvidence: string };
  keeper: {
    accountId: string;
    publicKeys: Record<'market' | 'oracle' | 'council', string> & { rounds?: string };
    minBalanceYocto: string;
    maxKeyAllowanceYocto: string;
    maxActionsPerRun: number;
    maxGasPerRunTgas: number;
  };
}

function https(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; }
  catch { return false; }
}

function publicKey(value: unknown) {
  if (typeof value !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  return base58Decode(value.slice(8)).length === 32;
}

export function assertApprovalCurrent(approval: KeeperApproval, now = Date.now()) {
  const approved = Date.parse(approval.approvedAt), expires = Date.parse(approval.expiresAt);
  if (!Number.isFinite(approved) || !Number.isFinite(expires) || approved > now || expires <= now
    || expires <= approved || expires - approved > MAX_APPROVAL_AGE) throw new Error('keeper_approval_expired_or_invalid');
}

export function parseKeeperApproval(raw: string | undefined, digest: string | undefined, config: Config): KeeperApproval {
  if (!raw || Buffer.byteLength(raw) > 32_768 || !digest || !HEX.test(digest)
    || createHash('sha256').update(raw).digest('hex') !== digest) throw new Error('keeper_approval_digest_mismatch');
  const a: unknown = JSON.parse(raw);
  if (!object(a) || a.version !== 1 || a.network !== 'mainnet' || config.network !== 'mainnet'
    || !config.deployment || !isDeepStrictEqual(a.deployment, config.deployment)
    || typeof a.approvedBy !== 'string' || !a.approvedBy.trim() || a.approvedBy.length > 200
    || typeof a.approvedAt !== 'string' || typeof a.expiresAt !== 'string' || !https(a.reviewEvidence)
    || !Array.isArray(a.marketIds) || a.marketIds.length > 1000 || !a.marketIds.every(isUint)
    || new Set(a.marketIds).size !== a.marketIds.length
    || !object(a.contracts) || !object(a.controls) || !object(a.keeper)) throw new Error('invalid_keeper_approval');
  const expected: Partial<Record<Role, string>> = { ...config.deployment.contracts,
    collateral: config.deployment.collateralTokenId.slice(7) };
  if (!expected.market || !expected.oracle || !expected.council || !expected.verifier
    || !object(a.contracts.nft) || !isAccount(a.contracts.nft.accountId)) throw new Error('incomplete_keeper_approval');
  expected.nft = a.contracts.nft.accountId;
  if (Object.keys(a.contracts).length !== Object.keys(expected).length) throw new Error('unexpected_approved_contract');
  for (const [role, account] of Object.entries(expected)) {
    const c = a.contracts[role];
    if (!object(c) || c.accountId !== account || !isAccount(account) || account.endsWith('.testnet')
      || typeof c.codeHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.codeHash)
      || base58Decode(c.codeHash).length !== 32 || /^1+$/.test(c.codeHash)
      || typeof c.sourceCommit !== 'string' || !COMMIT.test(c.sourceCommit) || /^0+$/.test(c.sourceCommit)
      || !https(c.buildEvidence)) throw new Error('invalid_approved_contract');
  }
  const controls = a.controls;
  if (!['owner', 'operator', 'treasury'].every(k => isAccount(controls[k]) && !(controls[k] as string).endsWith('.testnet')))
    throw new Error('invalid_approved_controls');
  const g = a.governance;
  if (!object(g) || typeof g.codeHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(g.codeHash)
    || base58Decode(g.codeHash).length !== 32 || /^1+$/.test(g.codeHash)
    || typeof g.policySha256 !== 'string' || !HEX.test(g.policySha256)
    || !Number.isSafeInteger(g.minApprovals) || Number(g.minApprovals) < 2 || Number(g.minApprovals) > 100
    || typeof g.sourceCommit !== 'string' || !COMMIT.test(g.sourceCommit) || /^0+$/.test(g.sourceCommit)
    || !https(g.buildEvidence)) throw new Error('invalid_approved_governance');
  const k = a.keeper;
  const publicKeys = k.publicKeys;
  const keyRoles = expected.rounds ? FINANCIAL : FINANCIAL.filter(role => role !== 'rounds');
  if (!isAccount(k.accountId) || k.accountId.endsWith('.testnet') || !object(k.publicKeys)
    || [controls.owner, controls.treasury, ...Object.values(expected)].includes(k.accountId)
    || !object(publicKeys) || !keyRoles.every(role => publicKey(publicKeys[role]))
    || new Set(Object.values(k.publicKeys)).size !== keyRoles.length || Object.keys(k.publicKeys).length !== keyRoles.length
    || !isUnits(k.minBalanceYocto) || k.minBalanceYocto === '0'
    || !isUnits(k.maxKeyAllowanceYocto) || k.maxKeyAllowanceYocto === '0'
    || !Number.isInteger(k.maxActionsPerRun) || Number(k.maxActionsPerRun) < 1 || Number(k.maxActionsPerRun) > 10
    || !Number.isInteger(k.maxGasPerRunTgas) || Number(k.maxGasPerRunTgas) < 1 || Number(k.maxGasPerRunTgas) > 3000)
    throw new Error('invalid_keeper_budget_or_identity');
  const approval = a as unknown as KeeperApproval;
  assertApprovalCurrent(approval);
  return approval;
}

function recent(head: Awaited<ReturnType<typeof finalizedHead>>) {
  if (!/^[1-9]\d{0,19}$/.test(head.height) || !/^[1-9]\d{0,19}$/.test(head.timestampNs)) throw new Error('invalid_approval_head');
  const age = BigInt(Date.now()) * 1_000_000n - BigInt(head.timestampNs);
  if (age > 60_000_000_000n || age < -5_000_000_000n) throw new Error('stale_approval_head');
}

export async function verifyKeeperApproval(approval: KeeperApproval, config: Config, primary: Rpc, secondary: Rpc) {
  assertApprovalCurrent(approval);
  const d = config.deployment!.contracts;
  // Intents cannot enumerate the implicit signing key of an Ethereum-style account.
  if (FINANCIAL.some(role => /^0x[0-9a-f]{40}$/.test(d[role] ?? '')))
    throw new Error('approved_contract_custody_unverifiable');
  const heads = await Promise.all([finalizedHead(config, primary), finalizedHead(config, secondary)]);
  heads.forEach(recent);
  const head = BigInt(heads[0]!.height) <= BigInt(heads[1]!.height) ? heads[0]! : heads[1]!;
  await Promise.all([primary, secondary].map(async rpc => {
    const block = await rpc.call('block', { block_id: head.hash });
    if (!object(block) || !object(block.header) || block.header.hash !== head.hash
      || String(block.header.height) !== head.height || String(block.header.timestamp_nanosec) !== head.timestampNs)
      throw new Error('approval_provider_disagreement');
    for (const role of ROLES) {
      const expected = approval.contracts[role];
      if (!expected) continue;
      const account = await rpc.call('query', { request_type: 'view_account', block_id: head.hash, account_id: expected.accountId });
      if (!object(account) || account.block_hash !== head.hash || account.code_hash !== expected.codeHash)
        throw new Error('approved_code_mismatch');
      if (role === 'nft' || FINANCIAL.some(financial => financial === role)) {
        const access = await rpc.call('query', { request_type: 'view_access_key_list', block_id: head.hash, account_id: expected.accountId });
        if (!object(access) || access.block_hash !== head.hash || !Array.isArray(access.keys) || access.keys.length !== 0)
          throw new Error('approved_contract_not_keyless');
      }
    }
    const view = viewAt(rpc, head.hash);
    const dao = approval.controls.owner;
    const identity = await rpc.call('query', { request_type: 'view_account', block_id: head.hash, account_id: dao });
    if (!object(identity) || identity.block_hash !== head.hash || identity.global_contract_account_id
      || (identity.global_contract_hash ?? identity.code_hash) !== approval.governance.codeHash)
      throw new Error('approved_dao_code_changed');
    const daoKeys = await rpc.call('query', { request_type: 'view_access_key_list', block_id: head.hash, account_id: dao });
    if (!object(daoKeys) || daoKeys.block_hash !== head.hash || !Array.isArray(daoKeys.keys) || daoKeys.keys.length)
      throw new Error('approved_dao_not_keyless');
    const policy = await view(dao, 'get_policy', {});
    if (daoPolicyHash(policy) !== approval.governance.policySha256) throw new Error('approved_dao_policy_changed');
    assertDaoPolicy(policy, approval.governance.minApprovals);
    if (await view(d.verifier!, 'pa_is_paused', { key: 'mt_transfer' }) !== false)
      throw new Error('approved_verifier_transfers_unavailable');
    for (const role of FINANCIAL) {
      if (!d[role]) continue;
      const args = { account_id: d[role]! };
      const [keys, predecessorAuth, locked] = await Promise.all([
        view(d.verifier!, 'public_keys_of', args),
        view(d.verifier!, 'is_auth_by_predecessor_id_enabled', args),
        view(d.verifier!, 'is_account_locked', args),
      ]);
      if (!Array.isArray(keys) || keys.length !== 0 || predecessorAuth !== true || locked !== false)
        throw new Error('approved_verifier_custody_changed');
      const settings = await view(d[role]!, 'config', {});
      if (!object(settings) || settings.owner !== approval.controls.owner || settings.pending_owner !== null
        || settings.upgrade_in_flight !== false || settings.upgrade_proven !== true
        || (['market', 'rounds'].includes(role) && settings.paused !== false)
        || (role === 'market' && settings.sells_paused !== false)
        || settings.verifier !== d.verifier || settings.collateral_token_id !== config.deployment!.collateralTokenId
        || (role !== 'council' && settings.operator !== approval.controls.operator)
        || (['market', 'rounds'].includes(role) && settings.treasury !== approval.controls.treasury)
        || (role === 'market' && (settings.oracle !== d.oracle || settings.revenue_pool !== d.council))
        || (role === 'oracle' && (settings.council !== d.council
          || settings.no_decision_recipient !== approval.controls.treasury))
        || (role === 'council' && (settings.oracle !== d.oracle || settings.nft_contract !== approval.contracts.nft!.accountId))
        || (['oracle', 'council'].includes(role) && (!Array.isArray(settings.markets) || !settings.markets.includes(d.market))))
        throw new Error('approved_contract_controls_changed');
    }
    const balance = await rpc.call('query', { request_type: 'view_account', block_id: head.hash, account_id: approval.keeper.accountId });
    if (!object(balance) || balance.block_hash !== head.hash || !isUnits(balance.amount)
      || !Number.isSafeInteger(balance.storage_usage) || Number(balance.storage_usage) < 0
      || BigInt(balance.amount) - BigInt(Number(balance.storage_usage)) * 10n ** 19n < BigInt(approval.keeper.minBalanceYocto))
      throw new Error('keeper_gas_reserve_low');
  }));
  recent(head);
  assertApprovalCurrent(approval);
  return head;
}
