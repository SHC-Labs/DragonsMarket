import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { prepareAdministrationProposal, prepareTreasuryVote, type TreasuryTarget, type TreasuryWalletRequest } from '@dragons-market/keeper/treasury';
import { KEEPER_METHODS, type KeeperOptions } from '@dragons-market/keeper';
import { verifyKeeperApproval, type KeeperApproval } from '../src/keeper-approval.js';
import { createKeeperSigner, keeperSigningKeys } from '../src/keeper-signer.js';
import { ReadRpcClient } from '../src/providers.js';
import { keeperFixture } from './keeper-fixture.js';
import { daoPolicyHash } from '../src/dao-policy.js';
import { daoFixture } from './dao-fixture.js';

test('DAO governance, sealing and the production keeper approval/signing path work together on a real chain',
  { timeout: 300000 }, async () => {
  const daoWasm = await daoFixture();
  await mkdir('.local/tmp', { recursive: true });
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  const directory = await mkdtemp(resolve('.local/tmp/dao-keeper-'));
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.start({ version: '2.13.4' });
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
    const account = async (name: string) => {
      const key = KeyPair.fromRandom('ed25519'), id = `${name}.${DEFAULT_ACCOUNT_ID}`;
      await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto('30') });
      return new Account(id, provider, key.toString());
    };
    const landed = (result: Awaited<ReturnType<Account['signAndSendTransaction']>>) => {
      assert.ok(typeof result.status === 'object' && 'SuccessValue' in result.status, JSON.stringify(result.status));
      for (const receipt of result.receipts_outcome) {
        const status = receipt.outcome.status;
        assert.ok(typeof status === 'object' && ('SuccessValue' in status || 'SuccessReceiptId' in status), JSON.stringify(status));
      }
      return result;
    };
    const call = async (signer: Account, receiverId: string, method: string, args: object, gas: `${number}` = '100', deposit = 0n) => landed(
      await signer.signAndSendTransaction({ receiverId, waitUntil: 'FINAL',
        actions: [actions.functionCall(method, args, teraToGas(gas), deposit)] }));
    const view = async (contractId: string, methodName: string, args: Record<string, unknown> = {}) => {
      const result = await provider.callFunction<Record<string, unknown>>({ contractId, method: methodName, args, blockQuery: { finality: 'final' } });
      assert.ok(result, `${contractId}.${methodName} must return its configuration or proposal`);
      return result;
    };
    const dao = await account('dao');
    const members = [await account('member1'), await account('member2'), await account('member3')];
    const outsider = await account('outsider');
    await dao.deployContract(daoWasm);
    await call(dao, dao.accountId, 'new', { config: { name: 'Sandbox governance', purpose: 'Integration proof', metadata: '' },
      policy: { roles: [{ name: 'Council', kind: { Group: members.map(member => member.accountId) }, permissions: ['*:*'], vote_policy: {} }],
        default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: '2' },
        proposal_bond: nearToYocto('0.1').toString(), proposal_period: '604800000000000',
        bounty_bond: nearToYocto('0.1').toString(), bounty_forgiveness_period: '604800000000000' } });
    const roles = ['market', 'oracle', 'council', 'rounds'] as const;
    const contracts = Object.fromEntries(roles.map(role => [role, `${role}.${DEFAULT_ACCOUNT_ID}`])) as Record<TreasuryTarget, string>;
    const verifier = await account('intents'), collateral = await account('usdc'), nft = await account('nft');
    const verifierCode = await readFile('../contracts/target/intents/defuse.wasm');
    assert.equal(createHash('sha256').update(verifierCode).digest('hex'), 'a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547');
    await verifier.deployContract(verifierCode);
    await call(verifier, verifier.accountId, 'new', { config: { wnear_id: 'wrap.near', fees: { fee: 0, fee_collector: root.accountId },
      roles: { super_admins: [root.accountId], grantees: {} } } });
    for (const [target, name] of [[collateral, 'mock_ft'], [nft, 'mock_nft']] as const) {
      await target.deployContract(await readFile(`../contracts/target/near/${name}/${name}.wasm`));
      await call(target, target.accountId, 'new', { owner_id: root.accountId });
    }
    const collateralTokenId = `nep141:${collateral.accountId}`;
    for (const role of roles) {
      const target = await account(role);
      await target.deployContract(await readFile(`../contracts/target/near/${role}/${role}.wasm`));
      const common = { owner_id: dao.accountId, verifier_id: verifier.accountId, collateral_token_id: collateralTokenId };
      const init = role === 'market' ? { ...common, operator_id: outsider.accountId, oracle_id: contracts.oracle }
        : role === 'council' ? { ...common, oracle_id: contracts.oracle, cooldown_ns: '1000000000', max_seats_per_account: 5 }
        : role === 'rounds' ? { ...common, operator_id: outsider.accountId, network: 'sandbox', price_threshold: 1 }
        : { ...common, operator_id: outsider.accountId, market_contract: contracts.market, council: contracts.council,
          bond: '5000000', window_ms: '3600000', panel_deadline_ms: '7200000', draw_window_ms: '3600000', jury_size: 5,
          draw_delay_blocks: '2', min_proposal_ms: '3600000', network: 'sandbox', price_threshold: 1, no_decision_recipient: dao.accountId };
      await call(target, target.accountId, 'new', init);
    }
    const settings = { treasuryId: dao.accountId, contracts, view };
    const submit = async (signer: Account, request: TreasuryWalletRequest) => landed(await signer.signAndSendTransaction({ receiverId: request.receiverId,
      waitUntil: 'FINAL', actions: request.actions.map(({ params }) => actions.functionCall(params.methodName, params.args,
        BigInt(params.gas), BigInt(params.deposit))) }));
    const propose = async (target: TreasuryTarget, methodName: string, args: Record<string, unknown>) => {
      const request = await prepareAdministrationProposal({ ...settings, target, methodName, args, description: `Test ${target}.${methodName}` });
      const result = await submit(members[0]!, request);
      assert.ok(typeof result.status === 'object' && 'SuccessValue' in result.status);
      const proposalId: unknown = JSON.parse(Buffer.from(result.status.SuccessValue, 'base64').toString());
      assert.ok(typeof proposalId === 'number' && Number.isSafeInteger(proposalId));
      const vote = await prepareTreasuryVote({ ...settings, proposalId, approve: true });
      await assert.rejects(submit(outsider, vote), /ERR_PERMISSION_DENIED/);
      await submit(members[0]!, vote);
      assert.equal((await view(dao.accountId, 'get_proposal', { id: proposalId })).status, 'InProgress');
      return { proposalId, vote };
    };
    const approve = async ({ proposalId, vote }: Awaited<ReturnType<typeof propose>>) => {
      await submit(members[1]!, vote);
      assert.equal((await view(dao.accountId, 'get_proposal', { id: proposalId })).status, 'Approved');
      await assert.rejects(prepareTreasuryVote({ ...settings, proposalId, approve: true }), /cannot be approved/);
    };
    const publishers = Array.from({ length: 3 }, () => KeyPair.fromRandom('ed25519').getPublicKey().toString());
    for (const target of ['oracle', 'rounds'] as const) {
      const args = { publishers, threshold: 2 };
      const before = await view(contracts[target], 'config');
      await assert.rejects(call(outsider, contracts[target], 'set_publishers', args), /owner only/);
      const pending = await propose(target, 'set_publishers', args);
      assert.deepEqual((await view(contracts[target], 'config')).publishers, before.publishers, 'one vote cannot change publishers');
      await approve(pending);
      const after = await view(contracts[target], 'config');
      assert.deepEqual(after.publishers, publishers);
      assert.equal(after.price_threshold, 2);
    }
    const jury = await propose('oracle', 'set_jury_size', { jury_size: 7 });
    assert.equal((await view(contracts.oracle, 'config')).jury_size, 5);
    await approve(jury);
    assert.equal((await view(contracts.oracle, 'config')).jury_size, 7);

    await approve(await propose('market', 'set_fee_recipients', { revenue_pool: contracts.council, treasury: dao.accountId }));
    await approve(await propose('rounds', 'set_treasury', { treasury: dao.accountId }));
    await approve(await propose('council', 'allow_market', { market: contracts.market }));
    await approve(await propose('council', 'set_nft_contract', { nft_contract: nft.accountId }));
    for (const role of roles) {
      const accountId = contracts[role];
      await call(outsider, accountId, 'stage_code', await readFile(`../contracts/target/near/${role}/${role}.wasm`), '150', nearToYocto('5'));
      const codeHash = (await provider.viewAccount({ accountId, blockQuery: { finality: 'final' } })).code_hash;
      await approve(await propose(role, 'upgrade', { code_hash: codeHash }));
      assert.equal((await view(accountId, 'config')).upgrade_proven, true);
      const keys = await provider.viewAccessKeyList({ accountId, finalityQuery: { finality: 'final' } });
      assert.equal(keys.keys.length, 1);
      await approve(await propose(role, 'seal', { public_key: keys.keys[0]!.public_key }));
      assert.equal((await provider.viewAccessKeyList({ accountId, finalityQuery: { finality: 'final' } })).keys.length, 0);
    }
    await approve(await propose('council', 'set_max_seats_per_account', { max_seats_per_account: 6 }));
    assert.equal((await view(contracts.council, 'config')).max_seats_per_account, 6, 'DAO administration survives removal of account keys');

    const nftKeys = await provider.viewAccessKeyList({ accountId: nft.accountId });
    landed(await nft.signAndSendTransaction({ receiverId: nft.accountId, waitUntil: 'FINAL',
      actions: nftKeys.keys.map(key => actions.deleteKey(PublicKey.fromString(key.public_key))) }));
    const daoKeys = await provider.viewAccessKeyList({ accountId: dao.accountId });
    landed(await dao.signAndSendTransaction({ receiverId: dao.accountId, waitUntil: 'FINAL',
      actions: daoKeys.keys.map(key => actions.deleteKey(PublicKey.fromString(key.public_key))) }));
    // Synthetic approval and keys apply only to this isolated sandbox. The production parser still
    // requires mainnet, independent HTTPS providers and externally approved release evidence.
    const { approval, config, env } = keeperFixture();
    const keeper = await account('keeper');
    config.network = 'sandbox';
    config.deployment = { id: 'dao-keeper-sandbox', startBlock: '1', collateralTokenId, collateralDecimals: 6,
      contracts: { ...contracts, verifier: verifier.accountId } };
    approval.deployment = config.deployment;
    approval.controls = { owner: dao.accountId, operator: outsider.accountId, treasury: dao.accountId };
    approval.governance.codeHash = (await provider.viewAccount({ accountId: dao.accountId })).code_hash;
    approval.governance.policySha256 = daoPolicyHash(await view(dao.accountId, 'get_policy'));
    for (const [role, accountId] of Object.entries({ ...config.deployment.contracts, nft: nft.accountId, collateral: collateral.accountId })) {
      const expected = approval.contracts[role as keyof KeeperApproval['contracts']];
      assert.ok(expected);
      expected.accountId = accountId;
      expected.codeHash = (await provider.viewAccount({ accountId })).code_hash;
    }
    approval.keeper.accountId = keeper.accountId;
    approval.keeper.maxKeyAllowanceYocto = nearToYocto('0.1').toString();
    approval.keeper.minBalanceYocto = nearToYocto('1').toString();
    landed(await keeper.signAndSendTransaction({ receiverId: keeper.accountId, waitUntil: 'FINAL', actions:
      roles.map(role => actions.addFunctionCallAccessKey(
        KeyPair.fromString(env[`KEEPER_${role.toUpperCase()}_KEY`]! as KeyPairString).getPublicKey(), contracts[role],
        [...KEEPER_METHODS[role]], nearToYocto('0.1'))) }));
    // Two independent client queues against one local node exercise the real pacing and block binding.
    // They do not stand in for production provider independence.
    const primary = new ReadRpcClient(sandbox.rpcUrl, config.rpc), secondary = new ReadRpcClient(sandbox.rpcUrl, config.rpc);
    let verifications = 0;
    const options: KeeperOptions = { rpc: sandbox.rpcUrl, ...contracts, account: keeper.accountId,
      'state-file': `${directory}/queue.json`, 'events-file': `${directory}/events.jsonl`,
      'require-live-feed': true, 'require-scoped-keys': true, workers: 1, 'job-batch': 1 };
    const journalFile = `${directory}/submission.json`;
    const create = () => createKeeperSigner({ approval, options, keys: keeperSigningKeys(env, approval), primary, secondary, journalFile,
      verify: async () => { await verifyKeeperApproval(approval, config, primary, secondary); verifications++; } });
    const signer = create(), action = { contract: 'council', method: 'advance_days', args: {}, gas: teraToGas('50') };
    await signer.beforeBatch([action]);
    assert.equal(await signer.send(action), 'ok');
    assert.equal(verifications, 2, 'real approval is checked both before the batch and immediately before signing');
    const journal = JSON.parse(await readFile(journalFile, 'utf8'));
    assert.equal(journal.pending, null);
    assert.equal(journal.last.failed, false);
    assert.equal(await create().recover(), undefined, 'restart does not resubmit a completed operation');
    await approve(await propose('market', 'set_paused', { paused: true }));
    await assert.rejects(create().send(action), /approved_contract_controls_changed/);
    assert.deepEqual(JSON.parse(await readFile(journalFile, 'utf8')), journal, 'changed DAO controls prevent signing and leave no new submission');
    await approve(await propose('market', 'set_paused', { paused: false }));
    const weakPolicy = await view(dao.accountId, 'get_policy');
    assert.ok(Array.isArray(weakPolicy.roles));
    weakPolicy.roles.push({ name: 'Requestor', kind: { Group: members.map(member => member.accountId) },
      permissions: ['*:AddProposal', 'call:VoteReject'],
      vote_policy: { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '0' } } });
    const change = landed(await members[0]!.signAndSendTransaction({ receiverId: dao.accountId, waitUntil: 'FINAL',
      actions: [actions.functionCall('add_proposal', { proposal: { description: 'Prove policy drift refusal',
        kind: { ChangePolicy: { policy: weakPolicy } } } }, teraToGas('100'), nearToYocto('0.1'))] }));
    assert.ok(typeof change.status === 'object' && 'SuccessValue' in change.status);
    const policyId: unknown = JSON.parse(Buffer.from(change.status.SuccessValue, 'base64').toString());
    assert.ok(typeof policyId === 'number');
    for (const member of members.slice(0, 2)) {
      await call(member, dao.accountId, 'act_proposal', { id: policyId, action: 'VoteApprove',
        proposal: { ChangePolicy: { policy: weakPolicy } } }, '300');
    }
    await assert.rejects(create().send(action), /approved_dao_policy_changed/);
    approval.governance.policySha256 = daoPolicyHash(await view(dao.accountId, 'get_policy'));
    await assert.rejects(create().send(action), /unsafe_dao_approval_threshold/,
      'copying a new hash cannot authorize zero-vote execution through a nonvoting role');
    assert.deepEqual(JSON.parse(await readFile(journalFile, 'utf8')), journal);
    const pending = await propose('market', 'set_paused', { paused: true });
    const stored = await view(dao.accountId, 'get_proposal', { id: pending.proposalId });
    await call(members[1]!, dao.accountId, 'act_proposal', { id: pending.proposalId, action: 'VoteReject', proposal: stored.kind }, '300');
    assert.equal((await view(contracts.market, 'config')).paused, true,
      'a rejection can execute through a zero-threshold role that has no VoteApprove permission');
  } finally {
    if (sandbox) {
      const child = (sandbox as unknown as { childProcess: ChildProcess }).childProcess;
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await sandbox.tearDown(); } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
