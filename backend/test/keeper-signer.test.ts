import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keeperSettings } from '../src/keeper-runner.js';
import { createKeeperSigner, keeperSigningKeys } from '../src/keeper-signer.js';
import { base58Encode } from '../src/base58.js';
import type { ReadRpcClient } from '../src/providers.js';
import { keeperFixture } from './keeper-fixture.js';
import { KEEPER_METHODS } from '@dragons-market/keeper';

test('scoped secrets must derive the approved public keys', () => {
  const { env, approval } = keeperFixture();
  assert.equal(Object.keys(keeperSigningKeys(env, approval)).length, 4);
  assert.throws(() => keeperSigningKeys({ ...env, KEEPER_KEY: 'forbidden' }, approval), /unscoped/);
  assert.throws(() => keeperSigningKeys({ ...env, KEEPER_ORACLE_KEY: env.KEEPER_MARKET_KEY }, approval), /does_not_match/);
  assert.throws(() => keeperSigningKeys({ ...env, KEEPER_MARKET_KEY: undefined }, approval), /missing/);
});

test('signer journals before broadcasting, proves finality, and recovers ambiguous submissions without resending', async t => {
  const { env, approval, config, encode } = keeperFixture();
  const { options } = keeperSettings({ KEEPER_MODE: 'sign', ...encode() }, config);
  const keys = keeperSigningKeys(env, approval);
  const dir = mkdtempSync(join(tmpdir(), 'keeper-sign-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journalFile = join(dir, 'submission.json');
  const journal = () => JSON.parse(readFileSync(journalFile, 'utf8'));
  let action: { contract: 'market' | 'oracle' | 'council' | 'rounds'; method: string; args: Record<string, string>; gas: bigint } =
    { contract: 'oracle', method: 'finalize', args: { market: 'market.near', market_id: '0' }, gas: 100_000_000_000_000n };
  let sends = 0, verifies = 0, final = true, failed = false, corrupted = false, allowance = '5000';
  let pendingHash = '';
  const permission = (key: string) => {
    const role = (Object.keys(approval.keeper.publicKeys) as (keyof typeof keys)[]).find(role => approval.keeper.publicKeys[role] === key)!;
    return { FunctionCall: { receiver_id: options[role], method_names: KEEPER_METHODS[role], allowance } };
  };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => Response.json({ result: { permission: permission(JSON.parse(String(init?.body)).params.public_key) } }));
  const rpc: Pick<ReadRpcClient, 'call'> = { call: async (method, params) => {
    if (method === 'block') return { header: { hash: base58Encode(Buffer.alloc(32, 1)) } };
    if (method === 'query') return { nonce: 1, permission: permission((params as { public_key: string }).public_key) };
    if (!final) throw new Error('transaction_not_known_yet');
    return { final_execution_status: 'FINAL', status: failed ? { Failure: {} } : { SuccessValue: '' },
      transaction: { hash: pendingHash, signer_id: approval.keeper.accountId, receiver_id: options[action.contract],
        actions: [{ FunctionCall: { method_name: corrupted ? 'upgrade' : action.method, args: Buffer.from(JSON.stringify(action.args)).toString('base64'), deposit: '0' } }] },
      transaction_outcome: { id: pendingHash, outcome: { executor_id: approval.keeper.accountId, receipt_ids: ['receipt'], status: { SuccessReceiptId: 'receipt' } } },
      receipts_outcome: [{ id: 'receipt', outcome: { executor_id: options[action.contract], receipt_ids: [], logs: [],
        status: failed ? { Failure: { ActionError: {} } } : { SuccessValue: '' } } }] };
  } };
  const make = () => createKeeperSigner({ approval, options, keys, journalFile, primary: rpc, secondary: rpc,
    verify: async () => { verifies++; }, broadcast: async signed => {
      sends++;
      pendingHash = base58Encode(createHash('sha256').update(Buffer.from(signed, 'base64').subarray(0, -65)).digest());
      assert.equal(journal().pending.hash, pendingHash, 'durable transaction identity exists before dispatch');
      if (!final) throw new Error('network_timeout');
      return {};
    } });
  const signer = make();
  await signer.beforeBatch([action]);
  assert.equal(await signer.send(action), 'ok');
  assert.equal(journal().pending, null);
  assert.deepEqual(journal().last, { hash: pendingHash, failed: false });
  assert.equal(verifies, 2);
  final = false;
  await assert.rejects(signer.send(action), /transaction_not_known/);
  assert.ok(journal().pending);
  const restarted = make();
  await assert.rejects(restarted.beforeBatch([action]), /transaction_not_known/);
  await assert.rejects(restarted.send(action), /transaction_not_known/);
  assert.equal(sends, 2, 'uncertain transaction blocks all new submissions across restarts');
  final = true; corrupted = true;
  await assert.rejects(restarted.recover(), /proof_mismatch/);
  assert.ok(journal().pending);
  corrupted = false;
  await restarted.recover();
  assert.equal(journal().pending, null);
  assert.equal(sends, 2, 'recovery only reads');
  failed = true;
  await assert.rejects(restarted.send(action), /transaction_failed/);
  assert.equal(journal().pending, null, 'a proved failure can be retried from fresh state');
  assert.equal(journal().last.failed, true);
  allowance = '10001';
  await assert.rejects(restarted.beforeBatch([]), /allowance_invalid/, 'all keys are checked even when no action is due');
  await assert.rejects(restarted.send(action), /allowance_invalid/);
  assert.equal(sends, 3);
  await assert.rejects(restarted.beforeBatch(Array(11).fill(action)), /budget/);
  await assert.rejects(restarted.send({ ...action, method: 'upgrade' }), /unexpected/);
  await assert.rejects(restarted.send({ ...action, args: { ...action.args, beneficiary: 'attacker.near' } }), /arguments/);
  await assert.rejects(restarted.send({ ...action, args: { ...action.args, market_id: '7' } }), /market_not_approved/);
  allowance = '5000'; failed = false;
  action = { contract: 'rounds', method: 'sweep_fees', args: {}, gas: 100_000_000_000_000n };
  assert.equal(await restarted.send(action), 'ok');
  await assert.rejects(restarted.send({ ...action, args: { receiver_id: 'attacker.near' } }), /arguments/);
  action = { contract: 'oracle', method: 'payout_bond', args: { account_id: 'alice.near' }, gas: 100_000_000_000_000n };
  assert.equal(await restarted.send(action), 'ok');
  await assert.rejects(restarted.send({ ...action, args: { ...action.args, receiver_id: 'attacker.near' } }), /arguments/);
  await assert.rejects(restarted.send({ ...action, args: { account_id: '../invalid' } }), /arguments/);
  assert.equal(sends, 5, 'only the two exact new maintenance calls were broadcast');
});
