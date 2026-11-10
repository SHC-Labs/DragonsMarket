import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeeperApproval, verifyKeeperApproval, type KeeperApproval } from '../src/keeper-approval.js';
import type { ReadRpcClient } from '../src/providers.js';
import { keeperSettings } from '../src/keeper-runner.js';
import { keeperFixture } from './keeper-fixture.js';
import { assertDaoPolicy, daoPolicyHash } from '../src/dao-policy.js';

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
    a => { delete a.keeper.publicKeys.rounds; }, a => { a.governance.minApprovals = 1; },
    a => { a.governance.policySha256 = 'unreviewed'; }, a => { a.governance.codeHash = '1'.repeat(32); },
  ];
  for (const change of changes) { const a = structuredClone(approval); change(a); assert.throws(() => parse(a)); }
  assert.throws(() => parseKeeperApproval(JSON.stringify(approval) + ' ', encode().KEEPER_APPROVAL_SHA256, config), /digest/);
  const settings = keeperSettings({ KEEPER_MODE: 'sign', ...encode() }, config);
  assert.equal(settings.options.account, approval.keeper.accountId);
  assert.equal(settings.options.workers, 1);
  assert.throws(() => keeperSettings({ KEEPER_MODE: 'sign', ...encode() }, { ...config, rpc: { ...config.rpc, secondUrl: null } }), /two independent/);
});

test('both providers must prove approved code and controls at the same recent finalized block', async () => {
  const { config, approval, policy } = keeperFixture();
  const header = { hash: 'h'.repeat(32), height: 200, timestamp_nanosec: String(BigInt(Date.now()) * 1000000n) };
  let failure = '';
  const checkedKeys = new Set<string>();
  const checkedCustody = new Set<string>();
  const provider = (secondary: boolean): Pick<ReadRpcClient, 'call'> => ({ call: async (method, args) => {
    const p = args as Record<string, string>;
    if (method === 'status') return { chain_id: secondary && failure === 'network' ? 'testnet' : 'mainnet' };
    if (method === 'block') return { header: { ...header,
      ...(secondary && failure === 'head' && p.block_id ? { hash: 'other' } : {}),
      ...(failure === 'stale' ? { timestamp_nanosec: '1000' } : {}) } };
    const role = p.account_id === approval.controls.owner ? 'dao'
      : Object.entries(approval.contracts).find(([, c]) => c.accountId === p.account_id)?.[0];
    if (p.request_type === 'view_access_key_list') {
      checkedKeys.add(`${secondary}:${role}`);
      return { block_hash: secondary && failure === 'key-block' ? 'wrong' : header.hash,
        keys: secondary && failure === `key:${role}` ? [{ access_key: { permission: 'FullAccess' } }]
          : failure === 'malformed-keys' ? null : [] };
    }
    if (p.request_type === 'view_account') {
      if (role === 'dao') return { block_hash: header.hash,
        ...(failure === 'global-dao' ? { code_hash: '1'.repeat(32), global_contract_hash: approval.governance.codeHash }
          : { code_hash: secondary && failure === 'dao-code' ? 'wrong' : approval.governance.codeHash }),
        ...(failure === 'mutable-dao' ? { global_contract_account_id: 'mutable.near' } : {}) };
      if (p.account_id === approval.keeper.accountId) return { block_hash: header.hash,
        amount: failure === 'balance' ? '0' : '1000000000000000000000000', storage_usage: 10 };
      return { block_hash: header.hash, code_hash: secondary && failure === 'code' && role === 'nft' ? 'wrong'
        : approval.contracts[role as keyof KeeperApproval['contracts']]!.codeHash };
    }
    const decoded: Record<string, string> = JSON.parse(Buffer.from(p.args_base64!, 'base64').toString());
    if (p.method_name === 'get_policy') return { block_hash: header.hash,
      result: [...Buffer.from(JSON.stringify(secondary && failure === 'dao-policy' ? {} : policy))] };
    if (p.method_name !== 'config') {
      assert.equal(p.account_id, 'intents.near');
      const custodyRole = Object.entries(approval.contracts).find(([, c]) => c.accountId === decoded.account_id)?.[0];
      checkedCustody.add(`${secondary}:${custodyRole}:${p.method_name}`);
      const bad = secondary && failure === `${p.method_name}:${custodyRole}`;
      const values: Record<string, unknown> = {
        public_keys_of: bad ? ['ed25519:retained'] : [],
        is_auth_by_predecessor_id_enabled: !bad,
        is_account_locked: bad,
        pa_is_paused: secondary && failure === 'verifier-paused',
      };
      assert.ok(Object.hasOwn(values, p.method_name!));
      const value = secondary && failure === `malformed:${p.method_name}` ? 'false' : values[p.method_name!];
      return { block_hash: secondary && failure === 'custody-block' ? 'wrong' : header.hash,
        result: [...Buffer.from(JSON.stringify(value))] };
    }
    const settings = { owner: approval.controls.owner, operator: approval.controls.operator, treasury: approval.controls.treasury,
      upgrade_proven: failure === 'unproven' ? false : failure === 'missing-proof' ? undefined : true,
      pending_owner: failure === 'missing-control' ? undefined : null, upgrade_in_flight: false, paused: false, sells_paused: false,
      verifier: 'intents.near', collateral_token_id: 'nep141:usdc.near', oracle: 'oracle.near', council: 'council.near',
      revenue_pool: 'council.near', nft_contract: 'nft.near', markets: ['market.near'],
      no_decision_recipient: secondary && failure === 'oracle-recipient' ? 'attacker.near' : approval.controls.treasury,
      ...(secondary && failure === 'controls' && role === 'market' ? { treasury: 'attacker.near' } : {}),
      ...(failure === 'pause' ? { paused: true } : {}), ...(failure === 'pending' ? { pending_owner: 'next.near' } : {}),
      ...(failure === 'upgrade' ? { upgrade_in_flight: true } : {}), ...(failure === 'sells-paused' ? { sells_paused: true } : {}) };
    return { block_hash: header.hash, result: [...Buffer.from(JSON.stringify(settings))] };
  } });
  await verifyKeeperApproval(approval, config, provider(false), provider(true));
  const financial = ['market', 'oracle', 'council', 'rounds'].filter(role => role in approval.contracts);
  const custodyMethods = ['public_keys_of', 'is_auth_by_predecessor_id_enabled', 'is_account_locked'];
  for (const secondary of [false, true]) {
    for (const role of [...financial, 'nft']) assert.ok(checkedKeys.has(`${secondary}:${role}`));
    for (const role of financial) for (const method of custodyMethods)
      assert.ok(checkedCustody.has(`${secondary}:${role}:${method}`));
  }
  for (failure of ['network', 'head', 'stale', 'code', 'balance', 'controls', 'pause', 'pending', 'upgrade', 'sells-paused', 'missing-control',
    'unproven', 'missing-proof', 'malformed-keys', 'key-block', 'custody-block', 'verifier-paused',
    'dao-code', 'dao-policy', 'mutable-dao', 'key:dao', 'oracle-recipient',
    ...[...financial, 'nft'].map(role => `key:${role}`),
    ...financial.flatMap(role => custodyMethods.map(method => `${method}:${role}`)),
    ...[...custodyMethods, 'pa_is_paused'].map(method => `malformed:${method}`)]) {
    await assert.rejects(verifyKeeperApproval(approval, config, provider(false), provider(true)), { name: 'Error' }, failure);
  }
  failure = '';
  failure = 'global-dao';
  await verifyKeeperApproval(approval, config, provider(false), provider(true));
  failure = '';
  for (const role of ['market', 'oracle', 'council', 'rounds'] as const) {
    const original = config.deployment!.contracts[role];
    if (!original) continue;
    config.deployment!.contracts[role] = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
    approval.contracts[role]!.accountId = config.deployment!.contracts[role]!;
    await assert.rejects(verifyKeeperApproval(approval, config, provider(false), provider(true)),
      /approved_contract_custody_unverifiable/);
    config.deployment!.contracts[role] = original;
    approval.contracts[role]!.accountId = original;
  }
  delete approval.contracts.rounds;
  delete config.deployment!.contracts.rounds;
  delete approval.keeper.publicKeys.rounds;
  checkedKeys.clear();
  checkedCustody.clear();
  await verifyKeeperApproval(approval, config, provider(false), provider(true));
  assert.ok([...checkedKeys, ...checkedCustody].every(value => !value.includes(':rounds')),
    'a human-only deployment without Rounds still verifies its configured contracts');
});

test('DAO policy checks every approving role, including overrides and wildcard permissions', () => {
  const { policy } = keeperFixture();
  assertDaoPolicy(policy, 2);
  const weak = structuredClone(policy);
  weak.roles.push({ ...structuredClone(policy.roles[0]!), name: 'Approver', permissions: ['call:VoteApprove'],
    vote_policy: { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' } } });
  assert.throws(() => assertDaoPolicy(weak, 2), /unsafe_dao_approval_threshold/);
  weak.roles[1]!.permissions = ['*:AddProposal'];
  weak.roles[1]!.vote_policy = { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '0' } };
  assert.throws(() => assertDaoPolicy(weak, 2), /unsafe_dao_approval_threshold/,
    'Finalize evaluates nonvoting roles too; zero-vote requestors cannot bypass approval');
  assert.throws(() => assertDaoPolicy({ ...policy, default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' } }, 2), /threshold/);
  assert.throws(() => assertDaoPolicy({ ...policy, roles: [{ ...policy.roles[0], kind: 'Everyone' }] }, 2), /approver_role/);
  assert.throws(() => assertDaoPolicy({ ...policy, roles: [{ ...policy.roles[0], kind: { Group: ['one.near', 'one.near'] } }] }, 2), /approver_role/);
  assert.throws(() => assertDaoPolicy({ ...policy, default_vote_policy: { weight_kind: 'TokenWeight', quorum: '0', threshold: '2' } }, 2), /vote_policy/);
  const ratio = { ...policy, default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] } };
  assertDaoPolicy(ratio, 2);
  assert.throws(() => assertDaoPolicy(ratio, 3), /threshold/);
  assert.throws(() => assertDaoPolicy({ ...ratio, default_vote_policy: { ...ratio.default_vote_policy, threshold: [1, 0] } }, 2), /ratio/);
  assert.throws(() => assertDaoPolicy({ ...ratio, default_vote_policy: { ...ratio.default_vote_policy, quorum: '4' } }, 2), /threshold/);
  assert.throws(() => assertDaoPolicy({ ...policy, roles: [{ ...policy.roles[0], permissions: ['transfer:VoteApprove'] }] }, 2), /execution_unavailable/);
  assert.equal(daoPolicyHash(policy), daoPolicyHash({ default_vote_policy: policy.default_vote_policy, roles: policy.roles }));
  const ordered = structuredClone(policy);
  ordered.roles[0]!.permissions = ['*:VoteApprove', '*:AddProposal'];
  const reordered = structuredClone(ordered);
  reordered.roles[0]!.permissions.reverse();
  reordered.roles[0]!.kind.Group.reverse();
  assert.equal(daoPolicyHash(ordered), daoPolicyHash(reordered), 'set iteration order is not policy drift');
  reordered.roles[0]!.kind.Group[0] = 'replacement.near';
  assert.notEqual(daoPolicyHash(ordered), daoPolicyHash(reordered), 'membership changes still require review');
});
