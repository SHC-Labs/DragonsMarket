import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { keeperRpc } from '@dragons-market/keeper';
import { ReadRpcClient } from '../src/providers.js';
import { TopupError, runTopup, type OneClick, type QuoteRequest, type TopupDeps } from '../src/relay-topup.js';
import { memoryJournal } from './topup-harness.js';

const INTENTS_SHA256 = 'a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547';
// releases/wnear.wasm of near/intents at 16d04f6 (git blob 8df321f9). Its base58 sha256 is the code_hash of mainnet wrap.near.
const WNEAR_SHA256 = 'b72c26d390b23f4517d091a8aab06b0369d465356ec5fb337d5fda076da38ac0';
const USD = 1_000_000n, NEAR = 10n ** 24n;
const DELIVERED = 2n * NEAR, PRICE = 10n * 10n ** 18n;
const DEPOSIT_ADDRESS = 'd'.repeat(64);
const wasm = (path: string) => readFile(resolve('../contracts/target', path));

interface TxView {
  transaction: { public_key: string; receiver_id: string; actions: { FunctionCall: { method_name: string; deposit: string } }[] };
  transaction_outcome: { outcome: { tokens_burnt: string } };
  receipts_outcome: { outcome: { tokens_burnt: string } }[];
  receipts: { predecessor_id: string; receiver_id: string; receipt: { Action?: { actions: ({ Transfer?: { deposit: string } } | string)[] } } }[];
}

test('relay top-up against the real Intents contract and the mainnet wNEAR code: nep413 deposit and native_withdraw sent with a dedicated execute_intents key', { timeout: 300000 }, async t => {
  const verifierWasm = await wasm('intents/defuse.wasm'), wnearWasm = await wasm('intents/wnear.wasm'), mockFtWasm = await wasm('near/mock_ft/mock_ft.wasm');
  assert.equal(createHash('sha256').update(verifierWasm).digest('hex'), INTENTS_SHA256, 'the Intents wasm must be the one deployed as intents.near');
  assert.equal(createHash('sha256').update(wnearWasm).digest('hex'), WNEAR_SHA256, 'the wNEAR wasm must be the pinned near/intents release, the code of wrap.near');
  await mkdir('.local/tmp', { recursive: true });
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.start({ version: '2.13.4' });
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const reader = new ReadRpcClient(sandbox.rpcUrl, { timeoutMs: 30000, intervalMs: 20 });
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
    const account = async (name: string, balance: `${number}` = '30') => {
      const key = KeyPair.fromRandom('ed25519'), id = `${name}.${DEFAULT_ACCOUNT_ID}`;
      await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(balance) });
      return new Account(id, provider, key.toString());
    };
    const call = async (signer: Account, receiverId: string, method: string, args: object, deposit = 0n) => {
      const result = await signer.signAndSendTransaction({ receiverId, waitUntil: 'FINAL', actions: [actions.functionCall(method, args, teraToGas(250), deposit)] });
      for (const receipt of result.receipts_outcome) {
        const status = receipt.outcome.status;
        assert.ok(typeof status === 'object' && ('SuccessValue' in status || 'SuccessReceiptId' in status), JSON.stringify(status));
      }
      return result;
    };
    const view = async <T extends object | string | boolean>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
      (await provider.callFunction<T>({ contractId, method, args, blockQuery: { finality: 'final' } }))!;
    const nearOf = async (accountId: string) => BigInt((await reader.call('query', { request_type: 'view_account', finality: 'final', account_id: accountId }) as { amount: string }).amount);
    const keyNonce = async (accountId: string, key: KeyPair) =>
      (await reader.call('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: key.getPublicKey().toString() }) as { nonce: number }).nonce;
    const owner = await account('owner', '60');
    await owner.deployContract(mockFtWasm);
    await call(owner, owner.accountId, 'new', { owner_id: owner.accountId });

    /** One verifier with its own wNEAR, relayer and keys. `wnearCode` is the real wrap.near code or a mock FT with no near_withdraw. */
    async function scenario(prefix: string, wnearCode: Buffer) {
      const real = wnearCode === wnearWasm;
      const verifier = await account(`${prefix}-intents`, '60'), wrap = await account(`${prefix}-wrap`, '60'), relayer = await account(`${prefix}-relayer`);
      await verifier.deployContract(verifierWasm);
      await wrap.deployContract(wnearCode);
      await call(verifier, verifier.accountId, 'new', { config: { wnear_id: wrap.accountId, fees: { fee: 0, fee_collector: owner.accountId },
        roles: { super_admins: [owner.accountId], grantees: { DAO: [owner.accountId] } } } });
      await call(wrap, wrap.accountId, 'new', real ? {} : { owner_id: owner.accountId });
      for (const holder of [verifier.accountId, owner.accountId]) await call(owner, wrap.accountId, 'storage_deposit', { account_id: holder, registration_only: true }, nearToYocto('0.1'));
      await call(owner, owner.accountId, 'storage_deposit', { account_id: verifier.accountId, registration_only: true }, nearToYocto('0.1'));
      await call(owner, owner.accountId, 'mint', { account_id: owner.accountId, amount: String(50n * USD) });
      await call(owner, owner.accountId, 'ft_transfer_call', { receiver_id: verifier.accountId, amount: String(50n * USD), msg: relayer.accountId }, 1n);
      const relayKey = KeyPair.fromRandom('ed25519'), submitKey = KeyPair.fromRandom('ed25519'), treasuryKey = KeyPair.fromRandom('ed25519');
      for (const key of [relayKey, submitKey]) {
        await relayer.signAndSendTransaction({ receiverId: relayer.accountId, waitUntil: 'FINAL',
          actions: [actions.addFunctionCallAccessKey(key.getPublicKey(), verifier.accountId, ['execute_intents'], nearToYocto('5'))] });
      }
      const collateral = `nep141:${owner.accountId}`, wnearToken = `nep141:${wrap.accountId}`;
      const intentsBalance = async (accountId: string, token: string) => BigInt(await view<string>(verifier.accountId, 'mt_balance_of', { account_id: accountId, token_id: token }));
      let atSwap: bigint | null = null;
      const oneClick: OneClick = {
        async quote(request: QuoteRequest) {
          return { quoteRequest: request, quote: { amountIn: request.amount, amountOut: String(DELIVERED), minAmountOut: String(DELIVERED * 995n / 1000n),
            depositAddress: DEPOSIT_ADDRESS, deadline: new Date(Date.now() + 10 * 60_000).toISOString() } };
        },
        // The swap leg cannot run in the sandbox. This plays the solver: it credits the quoted wNEAR to the relayer's Intents account.
        async status() {
          if (atSwap === null) {
            assert.equal(await intentsBalance(DEPOSIT_ADDRESS, collateral), 20n * USD, 'the deposit reached the quote address before the swap was reported');
            if (real) await call(owner, wrap.accountId, 'near_deposit', {}, DELIVERED);
            else await call(owner, wrap.accountId, 'mint', { account_id: owner.accountId, amount: String(DELIVERED) });
            await call(owner, wrap.accountId, 'ft_transfer_call', { receiver_id: verifier.accountId, amount: String(DELIVERED), msg: relayer.accountId }, 1n);
            atSwap = await nearOf(relayer.accountId);
          }
          return { status: 'SUCCESS' };
        },
      };
      const client = () => new ReadRpcClient(sandbox!.rpcUrl, { timeoutMs: 30000, intervalMs: 20 });
      const logs: Record<string, unknown>[] = [];
      const deps: TopupDeps = {
        settings: { mode: 'execute', relayer: relayer.accountId, verifier: verifier.accountId, collateral, collateralDecimals: 6, wnear: wnearToken,
          belowYocto: 1000n * NEAR, minUnits: 5n * USD, maxUnits: 20n * USD, maxUnitsPerDay: 100n * USD, maxSlippageBps: 200n, swapWaitMs: 60_000,
          submitKey: submitKey.toString(), treasuryKey: treasuryKey.toString(), forbiddenDepositAddresses: [relayer.accountId, verifier.accountId] },
        primary: client(), second: client(), requireSecond: true, oneClick, nearUsd: async () => PRICE,
        broadcast: signed => keeperRpc(sandbox!.rpcUrl, 'send_tx', { signed_tx_base64: signed, wait_until: 'FINAL' }),
        journal: memoryJournal(Date.now, { row: { verifier: verifier.accountId, pending: null }, deposits: [] }), log: event => logs.push(event),
      };
      const register = () => call(relayer, verifier.accountId, 'add_public_key', { public_key: treasuryKey.getPublicKey().toString() }, 1n);
      const sentTransactions = async () => Promise.all(logs.filter(e => e.event === 'deposit_sent' || e.event === 'withdraw_sent')
        .map(async e => await reader.call('EXPERIMENTAL_tx_status', { tx_hash: e.hash, sender_account_id: relayer.accountId, wait_until: 'FINAL' }) as TxView));
      const assertSentWithSubmitKey = async (txs: TxView[]) => {
        assert.equal(txs.length, 2);
        for (const tx of txs) {
          assert.equal(tx.transaction.public_key, submitKey.getPublicKey().toString(), 'sent with the top-up submit key');
          assert.equal(tx.transaction.receiver_id, verifier.accountId);
          assert.deepEqual(tx.transaction.actions.map(a => [a.FunctionCall.method_name, a.FunctionCall.deposit]), [['execute_intents', '0']]);
        }
      };
      return { verifier, wrap, relayer, relayKey, submitKey, treasuryKey, collateral, wnearToken, deps, logs, register, intentsBalance,
        sentTransactions, assertSentWithSubmitKey, atSwap: () => atSwap };
    }

    const live = await scenario('live', wnearWasm);

    await t.test('before add_public_key the treasury key cannot act for the relayer, and the job refuses before quoting', async () => {
      await assert.rejects(runTopup(live.deps), (error: unknown) => error instanceof TopupError && error.code === 'treasury_key_not_registered');
      assert.equal(live.atSwap(), null);
    });

    await t.test('the one-time operator step registers the treasury key in intents.near for the relayer account', async () => {
      await live.register();
      assert.equal(await view<boolean>(live.verifier.accountId, 'has_public_key', { account_id: live.relayer.accountId, public_key: live.treasuryKey.getPublicKey().toString() }), true);
      const keys = await reader.call('query', { request_type: 'view_access_key_list', finality: 'final', account_id: live.relayer.accountId }) as { keys: { public_key: string }[] };
      assert.ok(!keys.keys.some(key => key.public_key === live.treasuryKey.getPublicKey().toString()), 'the treasury key is an Intents key only, never a NEAR access key');
    });

    await t.test('deposit, mocked swap and native_withdraw through the real wrap.near code deliver exactly the wNEAR as native NEAR', async () => {
      const relayNonce = await keyNonce(live.relayer.accountId, live.relayKey);
      const wrapBefore = await nearOf(live.wrap.accountId);
      const result = await runTopup(live.deps);
      assert.equal(result.state, 'topped_up');
      assert.equal(result.withdrawnYocto, String(DELIVERED));
      assert.equal(await live.intentsBalance(live.relayer.accountId, live.collateral), 30n * USD, 'RELAY_TOPUP_MAX_USDC capped the deposit at 20 of 50');
      assert.equal(await live.intentsBalance(DEPOSIT_ADDRESS, live.collateral), 20n * USD);
      assert.equal(await live.intentsBalance(live.relayer.accountId, live.wnearToken), 0n);
      assert.equal(BigInt(await view<string>(live.wrap.accountId, 'ft_balance_of', { account_id: live.verifier.accountId })), 0n, 'the verifier unwrapped all of it');
      const txs = await live.sentTransactions();
      await live.assertSentWithSubmitKey(txs);
      assert.equal(await keyNonce(live.relayer.accountId, live.relayKey), relayNonce, 'the API relay key nonce did not move');
      const withdrawTx = txs[1]!;
      const transfers = withdrawTx.receipts.flatMap(r => (r.receipt.Action?.actions ?? []).flatMap(action =>
        typeof action === 'object' && action.Transfer && r.receiver_id === live.relayer.accountId && r.predecessor_id === live.verifier.accountId ? [BigInt(action.Transfer.deposit)] : []));
      assert.deepEqual(transfers, [DELIVERED], 'one native transfer of exactly the withdrawn wNEAR, from intents to the relayer');
      const burnt = [withdrawTx.transaction_outcome, ...withdrawTx.receipts_outcome].reduce((sum, r) => sum + BigInt(r.outcome.tokens_burnt), 0n);
      const gained = await nearOf(live.relayer.accountId) - live.atSwap()!;
      t.diagnostic(`native_withdraw: relayer +${gained} yocto = ${DELIVERED} delivered - ${DELIVERED - gained} cost; ${burnt} yocto burnt across the transaction; wrap.near NEAR change ${await nearOf(live.wrap.accountId) - wrapBefore}`);
      assert.equal(gained, DELIVERED - burnt, 'the relayer gained the wNEAR as NEAR, less exactly the gas the withdraw transaction burnt');
    });

    await t.test('with a wNEAR that cannot unwrap, native_withdraw burns the wNEAR and the job reports withdraw_failed on every run', async () => {
      const broken = await scenario('mock', mockFtWasm);
      await broken.register();
      const nearBefore = await nearOf(broken.relayer.accountId);
      await assert.rejects(runTopup(broken.deps), (error: unknown) => error instanceof TopupError && error.code === 'withdraw_failed');
      assert.equal(await broken.intentsBalance(DEPOSIT_ADDRESS, broken.collateral), 20n * USD, 'the deposit leg still landed');
      assert.equal(await broken.intentsBalance(broken.relayer.accountId, broken.wnearToken), 0n, 'native_withdraw took the wNEAR and does not refund it');
      await broken.assertSentWithSubmitKey(await broken.sentTransactions());
      assert.ok(await nearOf(broken.relayer.accountId) < nearBefore, 'no NEAR arrived, only gas was spent');
      await assert.rejects(runTopup(broken.deps), (error: unknown) => error instanceof TopupError && error.code === 'withdraw_failed', 'sticky until a person clears the journal');
      assert.equal((await broken.sentTransactions()).length, 2, 'the second run sent nothing');
    });
  } finally {
    if (sandbox) {
      const child = (sandbox as unknown as { childProcess: ChildProcess }).childProcess;
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await sandbox.tearDown(); } finally { clearTimeout(timer); }
    }
  }
});
