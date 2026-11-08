import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeeperApproval, verifyKeeperApproval, type KeeperApproval } from '../src/keeper-approval.js';
import type { ReadRpcClient } from '../src/providers.js';
import { keeperSettings } from '../src/keeper-runner.js';
import { keeperFixture } from './keeper-fixture.js';

test('signing approval binds the exact deployment, artifacts, keys, budget and expiring review', () => {
  const { config, approval, encode } = keeperFixture();
  const parse = (a: unknown) => { const e = encode(a); return parseKeeperApproval(e.KEEPER_APPROVAL_JSON, e.KEEPER_APPROVAL_SHA256, config); };
  assert.deepEqual(parse(approval), approval);
  const changes: ((a: KeeperApproval) => void)[] = [
    a => { a.deployment.startBlock = '101'; }, a => { a.contracts.market!.accountId = 'other.near'; },
    a => { delete a.contracts.nft; }, a => { a.contracts.market!.sourceCommit = '0'.repeat(40); },
    a => { a.contracts.market!.codeHash = '1'.repeat(32); }, a => { a.contracts.market!.buildEvidence = 'file:///tmp/build'; },
    a => { a.approvedBy = ''; }, a => { a.expiresAt = new Date(Date.now() - 1).toISOString(); },
    a => { a.approvedAt = new Date(Date.now() + 1000).toISOString(); },
    a => { a.expiresAt = new Date(Date.now() + 31 * 86400000).toISOString(); },
    a => { a.controls.owner = 'owner.testnet'; }, a => { a.keeper.maxActionsPerRun = 100; },
    a => { a.keeper.accountId = a.controls.owner; }, a => { a.keeper.accountId = 'market.near'; },
    a => { a.keeper.maxKeyAllowanceYocto = '0'; }, a => { a.keeper.minBalanceYocto = '-1'; },
    a => { a.keeper.publicKeys.oracle = a.keeper.publicKeys.market; },
  ];
  for (const change of changes) { const a = structuredClone(approval); change(a); assert.throws(() => parse(a)); }
  assert.throws(() => parseKeeperApproval(JSON.stringify(approval) + ' ', encode().KEEPER_APPROVAL_SHA256, config), /digest/);
  const settings = keeperSettings({ KEEPER_MODE: 'sign', ...encode() }, config);
  assert.equal(settings.options.account, approval.keeper.accountId);
  assert.equal(settings.options.workers, 1);
  assert.throws(() => keeperSettings({ KEEPER_MODE: 'sign', ...encode() }, { ...config, rpc: { ...config.rpc, secondUrl: null } }), /two independent/);
});

test('both providers must prove approved code and controls at the same recent finalized block', async () => {
  const { config, approval } = keeperFixture();
  const header = { hash: 'h'.repeat(32), height: 200, timestamp_nanosec: String(BigInt(Date.now()) * 1000000n) };
  let failure = '';
  const provider = (secondary: boolean): Pick<ReadRpcClient, 'call'> => ({ call: async (method, args) => {
    const p = args as Record<string, string>;
    if (method === 'status') return { chain_id: secondary && failure === 'network' ? 'testnet' : 'mainnet' };
    if (method === 'block') return { header: { ...header,
      ...(secondary && failure === 'head' && p.block_id ? { hash: 'other' } : {}),
      ...(failure === 'stale' ? { timestamp_nanosec: '1000' } : {}) } };
    const role = Object.entries(approval.contracts).find(([, c]) => c.accountId === p.account_id)?.[0];
    if (p.request_type === 'view_account') {
      if (p.account_id === approval.keeper.accountId) return { block_hash: header.hash,
        amount: failure === 'balance' ? '0' : '1000000000000000000000000', storage_usage: 10 };
      return { block_hash: header.hash, code_hash: secondary && failure === 'code' && role === 'nft' ? 'wrong'
        : approval.contracts[role as keyof KeeperApproval['contracts']]!.codeHash };
    }
    const settings = { owner: approval.controls.owner, operator: approval.controls.operator, treasury: approval.controls.treasury,
      pending_owner: failure === 'missing-control' ? undefined : null, upgrade_in_flight: false, paused: false, sells_paused: false,
      verifier: 'intents.near', collateral_token_id: 'nep141:usdc.near', oracle: 'oracle.near', council: 'council.near',
      revenue_pool: 'council.near', nft_contract: 'nft.near', markets: ['market.near'],
      ...(secondary && failure === 'controls' && role === 'market' ? { treasury: 'attacker.near' } : {}),
      ...(failure === 'pause' ? { paused: true } : {}), ...(failure === 'pending' ? { pending_owner: 'next.near' } : {}),
      ...(failure === 'upgrade' ? { upgrade_in_flight: true } : {}), ...(failure === 'sells-paused' ? { sells_paused: true } : {}) };
    return { block_hash: header.hash, result: [...Buffer.from(JSON.stringify(settings))] };
  } });
  await verifyKeeperApproval(approval, config, provider(false), provider(true));
  for (failure of ['network', 'head', 'stale', 'code', 'balance', 'controls', 'pause', 'pending', 'upgrade', 'sells-paused', 'missing-control']) {
    await assert.rejects(verifyKeeperApproval(approval, config, provider(false), provider(true)), { name: 'Error' }, failure);
  }
});
