import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { base58Encode } from '../src/base58.js';
import { RpcError } from '../src/providers.js';
import type { TopupDeps } from '../src/relay-topup.js';
import { VERIFIER, attempt, harness, journalOf, type Signed } from './topup-harness.js';

test('host clock ahead of the chain: a pending deposit is not written off while chain time is still before its deadline', async () => {
  const h = harness({ settings: { swapWaitMs: 0 } });
  h.chain.applyBroadcast = false;
  assert.equal(await attempt(h.run()), 'waiting');
  const held = h.chain.lastSimulated!;
  const { deadline } = journalOf(h.journal).pending as { deadline: number };
  h.chain.blockTimeMs = deadline - 30_000;
  h.clock.now = deadline + 2 * 60_000 + 1;
  h.chain.applyBroadcast = true;
  const second = await attempt(h.run());
  h.apply(held, 'whoever-kept-the-first-payload');
  assert.equal(h.chain.transfers.length, 1, `the first payload was still live on chain when run two ended ${second}`);
});

test('the signed payload does not reach an RPC (simulate_intents) before it is journalled', async () => {
  const h = harness();
  let captured: Signed | null = null;
  const thief: TopupDeps['primary'] = { call: async (method, params) => {
    const p = params as Record<string, string>;
    if (p.method_name === 'simulate_intents') {
      captured ??= (JSON.parse(Buffer.from(p.args_base64!, 'base64').toString()) as { signed: Signed[] }).signed[0]!;
      throw new RpcError(-32000, 'CONTRACT_EXECUTION_ERROR');
    }
    return h.deps.primary.call(method, params);
  } };
  assert.equal(await attempt(h.run({ second: thief })), 'simulation_failed');
  assert.ok(captured, 'the second RPC holds a live signed transfer');
  h.apply(captured, 'submitted-by-the-rpc');
  await attempt(h.run());
  assert.equal(h.click.requests.length, 1, 'a payload that left the process is in the journal, so no fresh deposit is quoted on top of it');
  assert.equal(h.chain.transfers.length, 1);
});

test('a front-runner that lands our payload in its own transaction does not brick the job with a sticky deposit_failed', async () => {
  const h = harness();
  const frontrun = async (signed: string) => {
    const ours = base58Encode(createHash('sha256').update(Buffer.from(signed, 'base64').subarray(0, -65)).digest());
    const item = h.chain.lastSimulated!;
    if (JSON.parse(item.payload.message).intents[0].intent !== 'transfer') return h.deps.broadcast(signed);
    h.apply(item, 'front-runner-tx');
    h.chain.txs.set(ours, { failed: true, executors: [VERIFIER] });
    return { final_execution_status: 'FINAL' };
  };
  const first = await attempt(h.run({ broadcast: frontrun }));
  const states = [first];
  for (let run = 0; run < 2; run++) states.push(await attempt(h.run()));
  assert.equal(h.chain.transfers.length, 1);
  assert.deepEqual(states, ['topped_up', 'healthy', 'healthy'], 'the deposit really reached 1Click, so the swap is followed and its NEAR withdrawn');
  assert.equal(h.chain.withdraws.length, 1);
});

/** A broadcast that lets a front-runner land our signed native_withdraw first, so our own transaction fails on the spent nonce. */
const frontrunWithdraw = (h: ReturnType<typeof harness>, nearArrives: boolean) => async (signed: string) => {
  const item = h.chain.lastSimulated!;
  if (JSON.parse(item.payload.message).intents[0].intent !== 'native_withdraw') return h.deps.broadcast(signed);
  h.chain.failWithdrawReceipt = !nearArrives;
  h.apply(item, 'front-runner-tx');
  h.chain.txs.set(base58Encode(createHash('sha256').update(Buffer.from(signed, 'base64').subarray(0, -65)).digest()), { failed: true, executors: [VERIFIER] });
  return { final_execution_status: 'FINAL' };
};

test('a front-runner that lands our withdraw payload in its own transaction does not stop the job with withdraw_failed once the NEAR arrived', async () => {
  const h = harness();
  const native = h.chain.native;
  const states = [await attempt(h.run({ broadcast: frontrunWithdraw(h, true) }))];
  for (let run = 0; run < 2; run++) states.push(await attempt(h.run()));
  assert.deepEqual(states, ['topped_up', 'healthy', 'healthy']);
  assert.deepEqual(h.chain.withdraws, [{ receiver: 'relayer.near', amount: h.chain.native - native }], 'one withdraw, all of it paid to the relayer');
  assert.ok(h.chain.native > native);
  assert.equal(journalOf(h.journal).pending, null);
  assert.equal(h.chain.transfers.length, 1, 'no second deposit');
});

test('a front-run withdraw whose NEAR never arrived still stops the job with withdraw_failed on every run', async () => {
  const h = harness();
  const native = h.chain.native;
  const states = [await attempt(h.run({ broadcast: frontrunWithdraw(h, false) }))];
  for (let run = 0; run < 2; run++) states.push(await attempt(h.run()));
  assert.deepEqual(states, ['withdraw_failed', 'withdraw_failed', 'withdraw_failed']);
  assert.equal(h.chain.native, native);
  assert.equal(journalOf(h.journal).pending!.step, 'withdraw');
  assert.equal(h.click.requests.length, 1, 'no new swap starts meanwhile');
});
