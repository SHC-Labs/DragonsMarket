import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base58Decode, base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import { ReadRpcClient } from '../src/providers.js';
import { RelayError, createRelay, validateItem, type RelayContext, type RelayHandler, type RelayRpc } from '../src/relay.js';
import { createFeeQuoter, rpcGasPrice, type FeeQuoter } from '../src/relay-fee.js';

const INTENTS_SHA256 = 'a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547';
const USD = 1_000_000n;
const RELAY_FEE = 1000n;
const wasm = (path: string) => readFile(resolve('../contracts/target', path));

interface Signer { id: string; standard: 'raw_ed25519' | 'erc191'; sign: (payload: string) => Record<string, string> }

function ed25519Signer(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { id: raw.toString('hex'), standard: 'raw_ed25519', sign: payload => ({ standard: 'raw_ed25519', payload,
    public_key: `ed25519:${base58Encode(raw)}`, signature: `ed25519:${base58Encode(sign(null, Buffer.from(payload), privateKey))}` }) };
}

function erc191Signer(): Signer {
    const secret: Uint8Array = secp256k1.utils.randomSecretKey();
    const address = '0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12)).toString('hex');
    return { id: address, standard: 'erc191', sign: payload => {
      const message = Buffer.from(payload);
      const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`), message]));
      const recovered: Uint8Array = secp256k1.sign(digest, secret, { prehash: false, format: 'recovered' });
      return { standard: 'erc191', payload, signature: `secp256k1:${base58Encode(Buffer.concat([recovered.subarray(1), recovered.subarray(0, 1)]))}` };
    } };
}

test('a signed buy from a wallet with no NEAR account goes through the relay into the real Intents contract and market', { timeout: 300000 }, async t => {
  const verifierWasm = await wasm('intents/defuse.wasm');
  assert.equal(createHash('sha256').update(verifierWasm).digest('hex'), INTENTS_SHA256, 'the Intents wasm must be the one deployed as intents.near');
  await mkdir('.local/tmp', { recursive: true });
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.start({ version: '2.13.4' });
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
    const keys = new Map<string, KeyPair>();
    const account = async (name: string, balance: `${number}` = '30') => {
      const key = KeyPair.fromRandom('ed25519'), id = `${name}.${DEFAULT_ACCOUNT_ID}`;
      await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(balance) });
      keys.set(id, key);
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

    const owner = await account('owner');
    const verifier = await account('verifier', '60'), ft = await account('ft'), market = await account('market'), oracle = await account('oracle');
    const relayer = await account('relayer');
    await verifier.deployContract(verifierWasm);
    await ft.deployContract(await wasm('near/mock_ft/mock_ft.wasm'));
    await market.deployContract(await wasm('near/market/market.wasm'));
    await oracle.deployContract(await wasm('near/oracle/oracle.wasm'));
    const collateral = `nep141:${ft.accountId}`;
    await call(verifier, verifier.accountId, 'new', { config: { wnear_id: 'wrap.near', fees: { fee: 0, fee_collector: owner.accountId },
      roles: { super_admins: [owner.accountId], grantees: { DAO: [owner.accountId] } } } });
    await call(ft, ft.accountId, 'new', { owner_id: owner.accountId });
    await call(market, market.accountId, 'new', { owner_id: owner.accountId, operator_id: owner.accountId, oracle_id: oracle.accountId,
      verifier_id: verifier.accountId, collateral_token_id: collateral });
    await call(oracle, oracle.accountId, 'new', { owner_id: owner.accountId, market_contract: market.accountId, verifier_id: verifier.accountId,
      collateral_token_id: collateral, bond: String(5n * USD), window_ms: '3600000', panel_deadline_ms: '7200000', draw_window_ms: '3600000',
      council: `council.${DEFAULT_ACCOUNT_ID}`, jury_size: 5, draw_delay_blocks: '2', min_proposal_ms: '3600000', operator_id: owner.accountId,
      network: 'sandbox', price_threshold: 2, no_decision_recipient: owner.accountId });
    await call(owner, ft.accountId, 'storage_deposit', { account_id: verifier.accountId, registration_only: true }, nearToYocto('0.1'));
    await call(owner, ft.accountId, 'mint', { account_id: owner.accountId, amount: String(1000n * USD) });
    const closeAt = BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n;
    const created = await call(owner, market.accountId, 'create_market', { title: 'Will the relay test pass?', rule_text: 'Yes if it passes.',
      resolution_source: 'https://example.com/source', void_policy: 'Void if cancelled.', category: 'world', subcategory: 'science',
      close_at: String(closeAt), resolve_by: String(closeAt + 36_000_000_000_000n) }, nearToYocto('0.06'));
    assert.ok(typeof created.status === 'object' && 'SuccessValue' in created.status);
    const marketId = JSON.parse(Buffer.from(created.status.SuccessValue, 'base64').toString()) as string;
    assert.equal((await view<{ registered: boolean }>(market.accountId, 'get_market', { market_id: marketId })).registered, true);
    const registrationFee = BigInt((await view<{ registration_fee: string }>(market.accountId, 'config')).registration_fee);

    const relayerKey = KeyPair.fromRandom('ed25519');
    const addKey = (key: KeyPair, methods: string[]) => relayer.signAndSendTransaction({ receiverId: relayer.accountId, waitUntil: 'FINAL',
      actions: [actions.addFunctionCallAccessKey(key.getPublicKey(), verifier.accountId, methods, nearToYocto('5'))] });
    await addKey(relayerKey, ['execute_intents']);

    const client = () => new ReadRpcClient(sandbox!.rpcUrl, { timeoutMs: 30000, intervalMs: 20 });
    const rpc: RelayRpc = { primary: client(), second: client(), reads: client(), sendUrl: sandbox.rpcUrl, requireSecond: false };
    // $0.30 a NEAR prices an action at 900 units at the sandbox gas price, so the 1000 floor is the required fee.
    const sandboxFees = (reads: RelayRpc['reads'] = rpc.reads): FeeQuoter =>
      createFeeQuoter({ minFee: RELAY_FEE, maxFee: 100_000n, decimals: 6 }, { nearUsd: async () => 3n * 10n ** 17n, gasPrice: rpcGasPrice(reads) });
    const relayWith = (key: KeyPair, fee = String(RELAY_FEE), over: Partial<RelayRpc> = {}): RelayHandler => createRelay(readConfig({ DATABASE_URL: 'postgresql://localhost/test',
      NETWORK: 'sandbox', DEPLOYMENT_ID: 'relay-test', DEPLOYMENT_START_BLOCK: '1', COLLATERAL_TOKEN_ID: collateral,
      VERIFIER_CONTRACT_ID: verifier.accountId, MARKET_CONTRACT_ID: market.accountId, ORACLE_CONTRACT_ID: oracle.accountId,
      RELAYER_ACCOUNT_ID: relayer.accountId, RELAYER_KEY: key.toString(), RELAY_MIN_FEE: fee }), { ...rpc, ...over }, sandboxFees(over.reads))!.submit;
    const context: RelayContext = { verifier: verifier.accountId, collateral, market: market.accountId, oracle: oracle.accountId, relayer: relayer.accountId, minFee: RELAY_FEE, maxFee: 100_000n };
    type Tap = (method: string, params: Record<string, unknown>, result: unknown) => unknown;
    const tap = (inner: RelayRpc['primary'], after: Tap = (_m, _p, result) => result) => {
      const tapped = { calls: 0, call: async (method: Parameters<ReadRpcClient['call']>[0], params: object) => {
        tapped.calls++;
        return after(method, params as Record<string, unknown>, await inner.call(method, params));
      } };
      return tapped;
    };
    const nearOf = async (accountId: string) => BigInt(((await rpc.primary.call('query', { request_type: 'view_account', finality: 'final', account_id: accountId })) as { amount: string }).amount);
    const gasOf = async (hash: string) => {
      const outcome = await rpc.primary.call('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: relayer.accountId, wait_until: 'FINAL' }) as
        { transaction_outcome: { outcome: { gas_burnt: number; tokens_burnt: string } }; receipts_outcome: { outcome: { gas_burnt: number; tokens_burnt: string } }[] };
      const all = [outcome.transaction_outcome, ...outcome.receipts_outcome];
      return { tgas: all.reduce((sum, entry) => sum + entry.outcome.gas_burnt, 0) / 1e12, yocto: all.reduce((sum, entry) => sum + BigInt(entry.outcome.tokens_burnt), 0n) };
    };
    const relayFailure = (code: string, index: number, completed: number, hashed: boolean) => (error: unknown) =>
      error instanceof RelayError && error.code === code && error.index === index && (error.completed ?? []).length === completed && Boolean(error.hash) === hashed;
    const ownKey = async () => { const key = KeyPair.fromRandom('ed25519'); await addKey(key, ['execute_intents']); return key; };
    const registerItem = async (amount = 20n * USD) => {
      const signer = ed25519Signer();
      await fund(signer, amount);
      return { signer, item: payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]) };
    };
    const relay = relayWith(relayerKey);

    const balance = async (accountId: string) => BigInt(await view<string>(verifier.accountId, 'mt_balance_of', { account_id: accountId, token_id: collateral }));
    const fund = (signer: Signer, amount: bigint) => call(owner, ft.accountId, 'ft_transfer_call', { receiver_id: verifier.accountId, amount: String(amount), msg: signer.id }, 1n);
    const transfer = (to: string, amount: bigint, extra: object = {}) => ({ intent: 'transfer', receiver_id: to, tokens: { [collateral]: String(amount) }, ...extra });
    const auth = (msg: string) => ({ intent: 'auth_call', contract_id: market.accountId, msg, min_gas: '100000000000000' });
    const marketBalance = async (signer: Signer) => BigInt(await view<string>(market.accountId, 'get_balance', { account_id: signer.id }));
    const payload = (signer: Signer, intents: object[]) => signer.sign(JSON.stringify({ signer_id: signer.id, verifying_contract: verifier.accountId,
      deadline: new Date(Date.now() + 5 * 60_000).toISOString(), nonce: randomBytes(32).toString('base64'), intents }));
    const registered = (signer: Signer) => view<boolean>(market.accountId, 'is_registered', { account_id: signer.id });
    const shares = async (signer: Signer) => (await view<[string, string]>(market.accountId, 'get_shares', { market_id: marketId, account_id: signer.id })).map(BigInt);
    const allow = () => true;
    const executeDirect = (item: object) => owner.signAndSendTransaction({ receiverId: verifier.accountId, waitUntil: 'FINAL',
      actions: [actions.functionCall('execute_intents', { signed: [item] }, teraToGas(300), 0n)] });
    const rawPayload = (signer: Signer, intents: string) => `{"signer_id":"${signer.id}","verifying_contract":"${verifier.accountId}","deadline":"${new Date(Date.now() + 5 * 60_000).toISOString()}","nonce":"${randomBytes(32).toString('base64')}","intents":${intents}}`;


    await t.test('the relayer key is checked against the chain before anything is sent', async () => {
      const full = KeyPair.fromRandom('ed25519');
      await relayer.signAndSendTransaction({ receiverId: relayer.accountId, waitUntil: 'FINAL', actions: [actions.addFullAccessKey(full.getPublicKey())] });
      const wrongMethods = KeyPair.fromRandom('ed25519'), wrongReceiver = KeyPair.fromRandom('ed25519');
      await addKey(wrongMethods, ['execute_intents', 'mt_transfer']);
      await relayer.signAndSendTransaction({ receiverId: relayer.accountId, waitUntil: 'FINAL',
        actions: [actions.addFunctionCallAccessKey(wrongReceiver.getPublicKey(), market.accountId, ['execute_intents'], nearToYocto('1'))] });
      const signer = ed25519Signer();
      await fund(signer, 20n * USD);
      const body = { signed: [payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)])] };
      for (const key of [full, wrongMethods, wrongReceiver, KeyPair.fromRandom('ed25519')]) {
        await assert.rejects(relayWith(key)(body, allow), (error: unknown) => error instanceof RelayError && error.status === 503 && error.code === 'relay_key_invalid');
      }
    });

    const signers = [ed25519Signer(), erc191Signer()];
    for (const signer of signers) {
      await t.test(`${signer.standard}: register then buy, both fees paid, shares held`, async () => {
        await fund(signer, 100n * USD);
        assert.equal(await registered(signer), false);
        const relayerBefore = await balance(relayer.accountId), nearBefore = await nearOf(relayer.accountId);
        const a = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
        const b = payload(signer, [transfer(market.accountId, 10n * USD, { msg: `buy:${marketId}:yes:1` }), transfer(relayer.accountId, RELAY_FEE)]);
        const { hashes } = await relay({ signed: [a, b] }, allow);
        assert.equal(hashes.length, 2);
        const [registerGas, buyGas] = [await gasOf(hashes[0]!), await gasOf(hashes[1]!)];
        t.diagnostic(`${signer.standard} gas: register ${registerGas.tgas} TGas (${registerGas.yocto} yocto burnt), buy ${buyGas.tgas} TGas (${buyGas.yocto} yocto burnt), relayer NEAR spent ${nearBefore - await nearOf(relayer.accountId)} yocto`);
        assert.equal(await registered(signer), true);
        const [yes, no] = await shares(signer);
        assert.ok(yes! > 0n && no === 0n, `yes shares ${yes}, no shares ${no}`);
        assert.equal(await balance(relayer.accountId) - relayerBefore, 2n * RELAY_FEE);
        assert.equal(await balance(signer.id), 100n * USD - registrationFee - 10n * USD - 2n * RELAY_FEE);
      });
      await t.test(`${signer.standard}: signed sell and withdraw return collateral to the same Intents owner`, async () => {
        const before = (await shares(signer))[0]!;
        const sell = payload(signer, [auth(`sell:${marketId}:yes:${before / 2n}:1`), transfer(relayer.accountId, RELAY_FEE)]);
        const sold = await relay({ signed: [sell] }, allow);
        assert.equal((await shares(signer))[0], before - before / 2n);
        const available = await marketBalance(signer), intentsBefore = await balance(signer.id);
        assert.ok(available > 0n);
        const withdrawal = payload(signer, [auth(`withdraw:${available}`), transfer(relayer.accountId, RELAY_FEE)]);
        const withdrawn = await relay({ signed: [withdrawal] }, allow);
        assert.equal(await marketBalance(signer), 0n);
        assert.equal(await balance(signer.id), intentsBefore + available - RELAY_FEE);
        for (const [name, hash] of [['sell', sold.hashes[0]!], ['withdraw', withdrawn.hashes[0]!]]) {
          const gas = await gasOf(hash!);
          t.diagnostic(`${signer.standard} ${name}: ${gas.tgas} TGas`);
          assert.ok(gas.tgas < 20, 'the action stays inside the fee model gas budget');
        }
      });
    }

    await t.test('a resubmitted payload gets its first hash back from memory, never a second send, and a fresh relay is refused by simulate_intents', async () => {
      const { item } = await registerItem();
      const primary = tap(rpc.primary), second = tap(rpc.second!);
      const remembering = relayWith(await ownKey(), String(RELAY_FEE), { primary, second }), restarted = relayWith(await ownKey());
      const { hashes } = await remembering({ signed: [item] }, allow);
      const before = await balance(relayer.accountId), near = await nearOf(relayer.accountId), calls = primary.calls + second.calls;
      const again = await Promise.all([remembering({ signed: [item] }, () => false), remembering({ signed: [item] }, () => false)]);
      assert.deepEqual(again, [{ hashes }, { hashes }]);
      assert.equal(primary.calls + second.calls, calls, 'no RPC call and no rate-limit charge for a settled payload');
      await assert.rejects(restarted({ signed: [item] }, allow), (error: unknown) => error instanceof RelayError && error.status === 422 && error.code === 'simulation_failed' && error.index === 0);
      assert.equal(await balance(relayer.accountId), before);
      assert.equal(await nearOf(relayer.accountId), near, 'no transaction was sent for any replay');
    });

    await t.test('an ambiguous outcome returns the computed hash, and the retry reads that transaction instead of sending again', async () => {
      const { signer, item } = await registerItem();
      let blind = true;
      const primary = tap(rpc.primary, (method, _params, result) => {
        if (method === 'EXPERIMENTAL_tx_status' && blind) { blind = false; throw new Error('provider timed out'); }
        return result;
      });
      const flaky = relayWith(await ownKey(), String(RELAY_FEE), { primary });
      let hash = '';
      await assert.rejects(flaky({ signed: [item] }, allow), (error: unknown) => {
        hash = error instanceof RelayError ? error.hash ?? '' : '';
        return relayFailure('transaction_not_final', 0, 0, true)(error);
      });
      const near = await nearOf(relayer.accountId);
      assert.deepEqual(await flaky({ signed: [item] }, allow), { hashes: [hash] });
      assert.equal(await nearOf(relayer.accountId), near, 'the retry sent nothing');
      assert.equal(await registered(signer), true);
    });

    await t.test('when the second item fails, the error still carries the first item hash', async () => {
      const signer = ed25519Signer();
      const total = registrationFee + 10n * USD + 2n * RELAY_FEE;
      await fund(signer, total);
      const a = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
      const b = payload(signer, [transfer(market.accountId, 10n * USD, { msg: `buy:${marketId}:yes:1` }), transfer(relayer.accountId, RELAY_FEE)]);
      const drain = payload(signer, [transfer(owner.accountId, 10n * USD)]);
      let simulations = 0;
      const primary = tap(rpc.primary, async (method, params, result) => {
        if (method !== 'query' || params.method_name !== 'simulate_intents' || ++simulations !== 2) return result;
        await executeDirect(drain);
        return rpc.primary.call(method, params);
      });
      await assert.rejects(relayWith(await ownKey(), String(RELAY_FEE), { primary })({ signed: [a, b] }, allow), relayFailure('simulation_failed', 1, 1, false));
      assert.equal(await registered(signer), true, 'the first item did land, and the caller is told its hash');
    });

    await t.test('balance gate: an unfunded, validly signed request is charged its signer limit and refused from one read, with no simulation; funded, it goes through', async () => {
      const signer = ed25519Signer();
      const primary = tap(rpc.primary), second = tap(rpc.second!), reads = tap(rpc.reads);
      const gated = relayWith(await ownKey(), String(RELAY_FEE), { primary, second, reads });
      const a = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
      const b = payload(signer, [transfer(market.accountId, 10n * USD, { msg: `buy:${marketId}:yes:1` }), transfer(relayer.accountId, RELAY_FEE)]);
      const slots: string[] = [];
      const counted = (id: string) => { slots.push(id); return true; };
      const before = reads.calls;
      await assert.rejects(gated({ signed: [a, b] }, counted), (error: unknown) => error instanceof RelayError && error.status === 422 && error.code === 'insufficient_balance');
      assert.equal(primary.calls + second.calls, 0, 'nothing reached simulate_intents or any other call of the paced path');
      assert.deepEqual(slots, [signer.id], 'the per-signer limit is charged before the read, so an unfunded replay is not free');
      assert.ok(reads.calls - before <= 2, 'one balance read, plus at most the first gas price read');
      const total = registrationFee + 10n * USD + 2n * RELAY_FEE;
      await fund(signer, total - 1n);
      await assert.rejects(gated({ signed: [a, b] }, counted), (error: unknown) => error instanceof RelayError && error.code === 'insufficient_balance', 'one unit short of both items');
      assert.equal(primary.calls + second.calls, 0);
      await fund(signer, 1n);
      const { hashes } = await gated({ signed: [a, b] }, counted);
      assert.equal(hashes.length, 2);
      assert.deepEqual(slots, [signer.id, signer.id, signer.id]);
      assert.equal(await balance(signer.id), 0n, 'the gate asked for exactly what the two items spend');
    });

    await t.test('the fee quote reads the gas price from the RPC and prices it with the NEAR price', async () => {
      const gas = await rpcGasPrice(rpc.reads)();
      assert.equal(gas, 100_000_000n, 'the sandbox runs at the protocol minimum gas price');
      const at4 = createFeeQuoter({ minFee: RELAY_FEE, maxFee: 100_000n, decimals: 6 }, { nearUsd: async () => 4n * 10n ** 18n, gasPrice: rpcGasPrice(rpc.reads) });
      assert.equal((await at4.quote()).fee, 12_000n, '20 TGas x 1e8 yocto x $4 x 1.5');
      assert.equal((await sandboxFees().quote()).fee, RELAY_FEE);
    });

    await t.test('simulate-then-spend: a balance drained after simulation fails the execution, costs our gas once, and suspends the signer', async () => {
      const signer = ed25519Signer();
      await fund(signer, 20n * USD);
      const item = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
      const drain = payload(signer, [transfer(owner.accountId, 20n * USD)]);
      let armed = true;
      const primary = tap(rpc.primary, async (method, params, result) => {
        if (armed && method === 'query' && params.method_name === 'simulate_intents') { armed = false; await executeDirect(drain); }
        return result;
      });
      const raced = relayWith(await ownKey(), String(RELAY_FEE), { primary });
      const fees = await balance(relayer.accountId), near = await nearOf(relayer.accountId);
      let hash = '';
      await assert.rejects(raced({ signed: [item] }, allow), (error: unknown) => {
        hash = error instanceof RelayError ? error.hash ?? '' : '';
        return relayFailure('execution_failed', 0, 0, true)(error);
      });
      const lost = near - await nearOf(relayer.accountId), gas = await gasOf(hash);
      t.diagnostic(`failed execute_intents (balance drained after simulation): ${gas.tgas} TGas, ${gas.yocto} yocto burnt, relayer NEAR spent ${lost} yocto`);
      assert.equal(await balance(relayer.accountId), fees, 'no fee: the whole execute_intents reverted');
      assert.ok(lost > 0n);
      const calls = primary.calls;
      await assert.rejects(raced({ signed: [item] }, allow), relayFailure('execution_failed', 0, 0, true), 'the same payload again gets the same answer from memory');
      await fund(signer, 20n * USD);
      const retry = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
      await assert.rejects(raced({ signed: [retry] }, allow), (error: unknown) => error instanceof RelayError && error.status === 403 && error.code === 'signer_suspended');
      assert.equal(primary.calls, calls, 'a suspended signer costs no RPC call');
    });

    await t.test('a second user of an uncoordinated relay key is refused until the operator restarts it', async () => {
      const shared = await ownKey();
      const first = relayWith(shared), other = relayWith(shared);
      const register = async (handler: RelayHandler) => {
        const signer = ed25519Signer();
        await fund(signer, 20n * USD);
        return handler({ signed: [payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)])] }, allow);
      };
      await register(first);
      await register(other);
      await assert.rejects(register(first), (error: unknown) => error instanceof RelayError && error.status === 503 && error.code === 'relay_key_shared');
      await assert.rejects(register(first), (error: unknown) => error instanceof RelayError && error.code === 'relay_key_shared');
      assert.equal((await register(relayWith(shared))).hashes.length, 1);
    });

    await t.test('the outcome is reported only when both providers agree on it, and a missing market receipt is not a success', async () => {
      const markFailed: Tap = (method, _params, result) => {
        if (method !== 'EXPERIMENTAL_tx_status') return result;
        const copy = structuredClone(result) as { receipts_outcome: { outcome: { executor_id: string; status: object } }[] };
        for (const receipt of copy.receipts_outcome) if (receipt.outcome.executor_id === market.accountId) receipt.outcome.status = { Failure: { ActionError: {} } };
        return copy;
      };
      const renamed: Tap = (method, _params, result) => {
        if (method !== 'EXPERIMENTAL_tx_status') return result;
        const copy = structuredClone(result) as { receipts_outcome: { outcome: { executor_id: string } }[] };
        for (const receipt of copy.receipts_outcome) if (receipt.outcome.executor_id === market.accountId) receipt.outcome.executor_id = owner.accountId;
        return copy;
      };
      const cases: [string, Partial<RelayRpc>][] = [
        ['rpc_disagreement', { second: tap(rpc.second!, markFailed) }],
        ['action_not_delivered', { primary: tap(rpc.primary, renamed), second: tap(rpc.second!, renamed) }],
      ];
      for (const [code, over] of cases) {
        const signer = ed25519Signer();
        await fund(signer, 20n * USD);
        const item = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
        await assert.rejects(relayWith(await ownKey(), String(RELAY_FEE), over)({ signed: [item] }, allow), relayFailure(code, 0, 0, true), code);
      }
    });

    await t.test('the local signature check accepts and refuses exactly what simulate_intents accepts and refuses', async () => {
      const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const bytesOf = (text: string) => Buffer.from(base58Decode(text.slice(text.indexOf(':') + 1)));
      const encode = (prefix: string, bytes: Buffer) => `${prefix}:${base58Encode(bytes)}`;
      const flip = (bytes: Buffer, at: number, mask = 1) => { const copy = Buffer.from(bytes); copy[at]! ^= mask; return copy; };
      const verdicts: string[] = [];
      for (const signer of [ed25519Signer(), ed25519Signer(), ...(await Promise.all([erc191Signer(), erc191Signer()])).filter((s): s is Signer => s !== null)]) {
        await fund(signer, 20n * USD);
        const item = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
        const sig = bytesOf(item.signature!), prefix = item.signature!.slice(0, item.signature!.indexOf(':'));
        const otherPayload = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
        const variants: [string, Record<string, string>][] = [
          ['valid', item],
          ['first byte flipped', { ...item, signature: encode(prefix, flip(sig, 0)) }],
          ['last signature byte flipped', { ...item, signature: encode(prefix, flip(sig, 63, 0x80)) }],
          ['signature of another payload', { ...item, signature: otherPayload.signature! }],
        ];
        if (signer.standard === 'erc191') {
          const s = BigInt('0x' + sig.subarray(32, 64).toString('hex'));
          variants.push(['other recovery id', { ...item, signature: encode(prefix, flip(sig, 64)) }]);
          variants.push(['high-s twin', { ...item, signature: encode(prefix, Buffer.concat([sig.subarray(0, 32), Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex'), Buffer.from([sig[64]! ^ 1])])) }]);
        }
        for (const [name, variant] of variants) {
          const local = (() => { try { validateItem(variant, context, Date.now(), 0); return true; } catch { return false; } })();
          const chain = await provider.callFunction({ contractId: verifier.accountId, method: 'simulate_intents', args: { signed: [variant] }, blockQuery: { finality: 'optimistic' } })
            .then(() => true, () => false);
          verdicts.push(`${signer.standard} ${name}: local ${local} chain ${chain}`);
          assert.equal(local, chain, `${signer.standard} ${name}: local ${local}, simulate_intents ${chain}`);
          assert.equal(local, name === 'valid', `${signer.standard} ${name}`);
        }
      }
      t.diagnostic(verdicts.join('; '));
    });

    await t.test('a market refusal that the Intents contract refunds is reported as a failure', async () => {
      const signer = ed25519Signer();
      await fund(signer, 30n * USD);
      await relay({ signed: [payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)])] }, allow);
      const before = await balance(signer.id);
      const refused = payload(signer, [transfer(market.accountId, 10n * USD, { msg: `buy:${marketId}:yes:${100n * USD * USD}` }), transfer(relayer.accountId, RELAY_FEE)]);
      await assert.rejects(relay({ signed: [refused] }, allow), (error: unknown) => error instanceof RelayError && error.code === 'transfer_refunded' && error.index === 0);
      assert.equal(await balance(signer.id), before - RELAY_FEE, 'the buy amount came back, only the relay fee was spent');
      assert.deepEqual(await shares(signer), [0n, 0n]);
    });

    await t.test('a signature that does not match the signer is refused', async () => {
      const signer = ed25519Signer(), impostor = ed25519Signer();
      await fund(signer, 20n * USD);
      const good = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
      const forged = { ...good, signature: impostor.sign(good.payload!).signature! };
      await assert.rejects(relay({ signed: [forged] }, allow), (error: unknown) => error instanceof RelayError && error.status === 400 && error.code === 'invalid_signature');
    });

    await t.test('duplicate keys: intents.near reads a duplicated msg differently from JSON.parse, so the validator refuses every duplicate', async () => {
      const fee = (tokens: string, receiver = `"receiver_id":"${relayer.accountId}"`) => `{"intent":"transfer",${receiver},"tokens":${tokens}}`;
      const plainFee = fee(`{"${collateral}":"${RELAY_FEE}"}`);
      const reg = (extra = '"msg":"register"', head = '"intent":"transfer"') => `{${head},"receiver_id":"${market.accountId}","tokens":{"${collateral}":"${registrationFee}"},${extra}}`;
      const cases: { name: string; intents: string; contract: 'last_wins' | 'refused' | 'notification_dropped' }[] = [
        { name: 'fee amount 1 then the fee', intents: `[${reg()},${fee(`{"${collateral}":"1","${collateral}":"${RELAY_FEE}"}`)}]`, contract: 'last_wins' },
        { name: 'fee receiver owner then relayer', intents: `[${reg()},${fee(`{"${collateral}":"${RELAY_FEE}"}`, `"receiver_id":"${owner.accountId}","receiver_id":"${relayer.accountId}"`)}]`, contract: 'refused' },
        { name: 'intent tag ft_withdraw then transfer', intents: `[${reg('"msg":"register"', '"intent":"ft_withdraw","intent":"transfer"')},${plainFee}]`, contract: 'refused' },
        { name: 'msg deposit then register', intents: `[${reg('"msg":"deposit","msg":"register"')},${plainFee}]`, contract: 'notification_dropped' },
      ];
      for (const { name, intents, contract } of cases) {
        const signer = ed25519Signer();
        await fund(signer, 20n * USD);
        const item = signer.sign(rawPayload(signer, intents));
        assert.equal((JSON.parse(item.payload!) as { intents: { msg?: string }[] }).intents[0]!.msg, 'register', `${name}: JSON.parse reads the last value`);
        assert.throws(() => validateItem(item, context, Date.now(), 0), (error: unknown) => error instanceof RelayError && error.code === 'invalid_payload', name);
        await assert.rejects(relay({ signed: [item] }, allow), (error: unknown) => error instanceof RelayError && error.status === 400, name);
        const before = { relayer: await balance(relayer.accountId), signer: await balance(signer.id) };
        const result = await executeDirect(item).then(() => 'executed', (error: unknown) => String(error));
        const moved = { relayer: await balance(relayer.accountId) - before.relayer, signer: before.signer - await balance(signer.id) };
        if (contract === 'refused') {
          assert.match(result, /duplicate field/, name);
          assert.deepEqual(moved, { relayer: 0n, signer: 0n }, name);
        } else {
          assert.equal(result, 'executed', name);
          assert.deepEqual(moved, { relayer: RELAY_FEE, signer: registrationFee + RELAY_FEE }, `${name}: serde keeps the last amount`);
          assert.equal(await registered(signer), contract === 'last_wins', contract === 'last_wins' ? name
            : `${name}: serde fails the flattened notification and runs a plain transfer, so the money sits in the market with no registration and every receipt succeeds`);
        }
      }
    });

    await t.test('min_gas is a decimal string the Intents contract honours, and a malformed one silently drops the notification', async () => {
      const signer = ed25519Signer();
      await fund(signer, 40n * USD);
      const register = (min_gas: unknown) => payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register', min_gas }), transfer(relayer.accountId, RELAY_FEE)]);
      const execute = executeDirect;
      await assert.rejects(execute(register('900000000000000')), /Exceeded the prepaid gas/, 'a string min_gas above the prepaid gas is enforced');
      await assert.rejects(execute(register(900000000000000)), /Exceeded the prepaid gas/, 'a number min_gas is enforced too');
      await execute(register('abc'));
      assert.equal(await registered(signer), false, 'an unparsable min_gas turns the transfer into a plain balance move: no mt_on_transfer, no refund');
      await assert.rejects(relay({ signed: [register('50000000000000')] }, allow), (error: unknown) => error instanceof RelayError && error.code === 'invalid_intent');
    });

    await t.test('both wallet standards redeem a resolved market through auth_call', async () => {
      const close = BigInt((await provider.viewBlock({ finality: 'final' })).header.timestamp_nanosec) + 60_000_000_000n;
      const result = await call(owner, market.accountId, 'create_market', { title: 'Relayed redemption', rule_text: 'Void for the local acceptance test.',
        resolution_source: 'https://example.com/source', void_policy: 'Void returns the remaining backing.', category: 'world', subcategory: 'science',
        close_at: String(close), resolve_by: String(close + 36_000_000_000_000n) }, nearToYocto('0.06'));
      assert.ok(typeof result.status === 'object' && 'SuccessValue' in result.status);
      const id = JSON.parse(Buffer.from(result.status.SuccessValue, 'base64').toString()) as string;
      for (const signer of signers) await relay({ signed: [payload(signer,
        [transfer(market.accountId, USD, { msg: `buy:${id}:yes:1` }), transfer(relayer.accountId, RELAY_FEE)])] }, allow);
      const advance = await fetch(sandbox!.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'advance', method: 'sandbox_fast_forward', params: { delta_height: 250 } }) });
      const advanced = await advance.json() as { error?: unknown };
      assert.equal(advanced.error, undefined);
      await call(oracle, market.accountId, 'set_outcome', { market_id: id, outcome: 'void' });
      for (const signer of signers) {
        const before = await marketBalance(signer);
        const item = payload(signer, [auth(`redeem:${id}`), transfer(relayer.accountId, RELAY_FEE)]);
        const { hashes } = await relay({ signed: [item] }, allow);
        assert.ok(await marketBalance(signer) > before);
        assert.deepEqual(await view(market.accountId, 'get_shares', { market_id: id, account_id: signer.id }), ['0', '0']);
        const gas = await gasOf(hashes[0]!);
        t.diagnostic(`${signer.standard} redeem: ${gas.tgas} TGas`);
        const proof = await rpc.primary.call('EXPERIMENTAL_tx_status', { tx_hash: hashes[0]!, sender_account_id: relayer.accountId, wait_until: 'FINAL' }) as
          { receipts_outcome: { outcome: { executor_id: string; logs: string[] } }[] };
        const events = proof.receipts_outcome.flatMap(receipt => receipt.outcome.logs.filter(log => log.startsWith('EVENT_JSON:'))
          .map(log => ({ executor: receipt.outcome.executor_id, event: JSON.parse(log.slice(11)) })));
        assert.ok(events.some(({ executor, event }) => executor === verifier.accountId && event.standard === 'dip4' && event.event === 'intents_executed'
          && event.data.some((data: { account_id: string; nonce: string }) => data.account_id === signer.id && data.nonce === JSON.parse(item.payload!).nonce)));
        assert.ok(events.some(({ executor, event }) => executor === market.accountId && event.standard === 'market' && event.event === 'redeemed'
          && event.data.account === signer.id && event.data.market_id === id));
      }
    });
  } finally {
    if (sandbox) {
      const child = (sandbox as unknown as { childProcess: ChildProcess }).childProcess;
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await sandbox.tearDown(); } finally { clearTimeout(timer); }
    }
  }
});
