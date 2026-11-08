import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { createKeeperSigner, keeperSigningKeys } from '../src/keeper-signer.js';
import { ReadRpcClient } from '../src/providers.js';
import { keeperFixture } from './keeper-fixture.js';
import { KEEPER_METHODS } from '@dragons-market/keeper';

test('production signer executes a scoped Council call with real final receipts and refuses a revoked key', { timeout: 120000 }, async () => {
  const wasm = await readFile(resolve('../contracts/target/near/council/council.wasm'));
  await mkdir('.local/tmp', { recursive: true });
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  const directory = await mkdtemp(resolve('.local/tmp/keeper-signing-'));
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.start({ version: '2.13.4' });
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const owner = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
    const councilKey = KeyPair.fromRandom('ed25519');
    const council = `council.${DEFAULT_ACCOUNT_ID}`;
    await owner.createAccount({ newAccountId: council, publicKey: councilKey.getPublicKey(), nearToTransfer: nearToYocto('30') });
    const contract = new Account(council, provider, councilKey.toString());
    await contract.deployContract(wasm);
    await contract.signAndSendTransaction({ receiverId: council, waitUntil: 'FINAL', actions: [actions.functionCall('new', {
      owner_id: owner.accountId, oracle_id: owner.accountId, verifier_id: owner.accountId,
      collateral_token_id: 'nep141:usdc.near', cooldown_ns: '1000000000', max_seats_per_account: 5,
    }, teraToGas('100'))] });
    const { approval, env } = keeperFixture();
    const keeperKey = KeyPair.fromString(env.KEEPER_COUNCIL_KEY! as KeyPairString);
    const keeper = `keeper.${DEFAULT_ACCOUNT_ID}`;
    const adminKey = KeyPair.fromRandom('ed25519');
    await owner.createAccount({ newAccountId: keeper, publicKey: adminKey.getPublicKey(), nearToTransfer: nearToYocto('5') });
    const admin = new Account(keeper, provider, adminKey.toString());
    await admin.signAndSendTransaction({ receiverId: keeper, waitUntil: 'FINAL', actions:
      (['market', 'oracle', 'council'] as const).map(role => actions.addFunctionCallAccessKey(
        KeyPair.fromString(env[`KEEPER_${role.toUpperCase()}_KEY`]! as KeyPairString).getPublicKey(),
        role === 'council' ? council : `${role}.near`, [...KEEPER_METHODS[role]], nearToYocto('0.1'))),
    });
    approval.keeper.accountId = keeper;
    approval.keeper.maxKeyAllowanceYocto = nearToYocto('0.1').toString();
    const options = { rpc: sandbox.rpcUrl, market: 'market.near', oracle: 'oracle.near', council, account: keeper,
      'state-file': `${directory}/queue.json`, 'events-file': `${directory}/events.jsonl`,
      'require-live-feed': true as const, 'require-scoped-keys': true as const, workers: 1, 'job-batch': 1 };
    const primary = new ReadRpcClient(sandbox.rpcUrl, { timeoutMs: 30000, intervalMs: 50 });
    const secondary = new ReadRpcClient(sandbox.rpcUrl, { timeoutMs: 30000, intervalMs: 50 });
    const journalFile = `${directory}/submission.json`;
    const create = () => createKeeperSigner({ approval, options, keys: keeperSigningKeys(env, approval), primary, secondary,
      journalFile, verify: async () => {} });
    const signer = create();
    const action = { contract: 'council', method: 'advance_days', args: {}, gas: teraToGas('50') };
    await signer.beforeBatch([action]);
    assert.equal(await signer.send(action), 'ok');
    const journal = JSON.parse(await readFile(journalFile, 'utf8'));
    assert.equal(journal.pending, null);
    assert.equal(journal.last.failed, false);
    assert.ok(journal.last.hash);
    assert.equal(await create().recover(), undefined, 'completed transaction stays completed across process restart');
    await admin.signAndSendTransaction({ receiverId: keeper, waitUntil: 'FINAL', actions: [actions.deleteKey(keeperKey.getPublicKey())] });
    await assert.rejects(create().send(action));
    assert.deepEqual(JSON.parse(await readFile(journalFile, 'utf8')), journal, 'revocation causes no new submission');
  } finally {
    if (sandbox) {
      const child = (sandbox as unknown as { childProcess: ChildProcess }).childProcess;
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await sandbox.tearDown(); } finally { clearTimeout(timeout); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
