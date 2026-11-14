import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import { ReadRpcClient } from '../src/providers.js';
import { RelayError, createRelay, type RelayRpc } from '../src/relay.js';
import { GAS_PER_ACTION, createFeeQuoter, rpcGasPrice } from '../src/relay-fee.js';

const USD = 1_000_000n;
const RELAY_FEE = 1000n;
const wasm = (path: string) => readFile(resolve('../contracts/target', path));

interface Signer { id: string; sign: (payload: string) => Record<string, string> }
function ed25519Signer(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { id: raw.toString('hex'), sign: payload => ({ standard: 'raw_ed25519', payload,
    public_key: `ed25519:${base58Encode(raw)}`, signature: `ed25519:${base58Encode(sign(null, Buffer.from(payload), privateKey))}` }) };
}

test('every relayed action, including the refund paths and the oracle actions, burns at most the 20 TGas the fee charges for', { timeout: 300000 }, async t => {
  await mkdir('.local/tmp', { recursive: true });
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.start({ version: '2.13.4' });
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
    const account = async (name: string, balance: `${number}` = '30') => {
      const key = KeyPair.fromRandom('ed25519'), id = `${name}.${DEFAULT_ACCOUNT_ID}`;
      await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(balance) });
      return new Account(id, provider, key.toString());
    };
    const call = async (signer: Account, receiverId: string, method: string, args: object, deposit = 0n) =>
      signer.signAndSendTransaction({ receiverId, waitUntil: 'FINAL', actions: [actions.functionCall(method, args, teraToGas(250), deposit)] });
    const view = async <T extends object | string | boolean>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
      (await provider.callFunction<T>({ contractId, method, args, blockQuery: { finality: 'final' } }))!;

    const owner = await account('owner');
    const verifier = await account('verifier', '60'), ft = await account('ft'), market = await account('market'), oracle = await account('oracle');
    const relayer = await account('relayer'), attackerAccount = await account('attacker');
    await verifier.deployContract(await wasm('intents/defuse.wasm'));
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
    const createMarket = async (closeInMs: bigint) => {
      const closeAt = BigInt(Date.now()) * 1_000_000n + closeInMs * 1_000_000n;
      const created = await call(owner, market.accountId, 'create_market', { title: `Red team ${closeInMs}`, rule_text: 'Yes if it passes.',
        resolution_source: 'https://example.com/source', void_policy: 'Void if cancelled.', category: 'world', subcategory: 'science',
        close_at: String(closeAt), resolve_by: String(closeAt + 360_000_000_000_000n) }, nearToYocto('0.06'));
      assert.ok(typeof created.status === 'object' && 'SuccessValue' in created.status, JSON.stringify(created.status));
      return JSON.parse(Buffer.from(created.status.SuccessValue, 'base64').toString()) as string;
    };
    const openMarket = await createMarket(3_600_000n);
    const closingMarket = await createMarket(15_000n);
    const registrationFee = BigInt((await view<{ registration_fee: string }>(market.accountId, 'config')).registration_fee);

    const relayerKey = KeyPair.fromRandom('ed25519');
    const allowance = nearToYocto('5');
    await relayer.signAndSendTransaction({ receiverId: relayer.accountId, waitUntil: 'FINAL',
      actions: [actions.addFunctionCallAccessKey(relayerKey.getPublicKey(), verifier.accountId, ['execute_intents'], allowance)] });

    const client = () => new ReadRpcClient(sandbox!.rpcUrl, { timeoutMs: 30000, intervalMs: 20 });
    const rpc: RelayRpc = { primary: client(), second: client(), reads: client(), sendUrl: sandbox.rpcUrl, requireSecond: false };
    const relay = createRelay(readConfig({ DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'sandbox', DEPLOYMENT_ID: 'redteam', DEPLOYMENT_START_BLOCK: '1',
      COLLATERAL_TOKEN_ID: collateral, VERIFIER_CONTRACT_ID: verifier.accountId, MARKET_CONTRACT_ID: market.accountId, ORACLE_CONTRACT_ID: oracle.accountId,
      RELAYER_ACCOUNT_ID: relayer.accountId, RELAYER_KEY: relayerKey.toString(), RELAY_MIN_FEE: String(RELAY_FEE) }), rpc,
      createFeeQuoter({ minFee: RELAY_FEE, maxFee: 100_000n, decimals: 6 }, { nearUsd: async () => 3n * 10n ** 17n, gasPrice: rpcGasPrice(rpc.reads) }))!;

    const nearOf = async (id: string) => BigInt(((await rpc.primary.call('query', { request_type: 'view_account', finality: 'final', account_id: id })) as { amount: string }).amount);
    const allowanceOf = async () => BigInt(((await rpc.primary.call('query', { request_type: 'view_access_key', finality: 'final', account_id: relayer.accountId,
      public_key: relayerKey.getPublicKey().toString() })) as { permission: { FunctionCall: { allowance: string } } }).permission.FunctionCall.allowance);
    const gasOf = async (hash: string, sender = relayer.accountId) => {
      const outcome = await rpc.primary.call('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' }) as
        { transaction_outcome: { outcome: { gas_burnt: number } }; receipts_outcome: { outcome: { gas_burnt: number } }[] };
      return [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((sum, entry) => sum + entry.outcome.gas_burnt, 0);
    };
    const balance = async (id: string) => BigInt(await view<string>(verifier.accountId, 'mt_balance_of', { account_id: id, token_id: collateral }));
    const fund = (signer: Signer, amount: bigint) => call(owner, ft.accountId, 'ft_transfer_call', { receiver_id: verifier.accountId, amount: String(amount), msg: signer.id }, 1n);
    const transfer = (to: string, amount: bigint, extra: object = {}) => ({ intent: 'transfer', receiver_id: to, tokens: { [collateral]: String(amount) }, ...extra });
    const payload = (signer: Signer, intents: object[]) => signer.sign(JSON.stringify({ signer_id: signer.id, verifying_contract: verifier.accountId,
      deadline: new Date(Date.now() + 5 * 60_000).toISOString(), nonce: randomBytes(32).toString('base64'), intents }));
    const allow = () => true;

    const rows: { name: string; tgas: number; nearSpent: bigint; allowanceSpent: bigint; fee: bigint; code: string }[] = [];
    const measure = async (name: string, signer: Signer, action: object) => {
      const near = await nearOf(relayer.accountId), allowed = await allowanceOf(), fees = await balance(relayer.accountId);
      let hash = '', code = 'ok';
      try {
        hash = (await relay.submit({ signed: [payload(signer, [action, transfer(relayer.accountId, RELAY_FEE)])] }, allow)).hashes[0]!;
      } catch (error) {
        assert.ok(error instanceof RelayError && error.hash, `${name}: ${String(error)}`);
        hash = error.hash; code = error.code;
      }
      const row = { name, tgas: (await gasOf(hash)) / 1e12, nearSpent: near - await nearOf(relayer.accountId), allowanceSpent: allowed - await allowanceOf(),
        fee: await balance(relayer.accountId) - fees, code };
      rows.push(row);
      t.diagnostic(`${name}: ${row.code}, ${row.tgas} TGas, relayer NEAR spent ${row.nearSpent}, key allowance spent ${row.allowanceSpent}, fee collected ${row.fee}`);
      return row;
    };

    const proposer = ed25519Signer(), challenger = ed25519Signer(), buyer = ed25519Signer();
    for (const signer of [proposer, challenger, buyer]) await fund(signer, 100n * USD);
    const evidence = 'https://example.com/' + 'e'.repeat(512 - 'https://example.com/'.length);
    await measure('register', buyer, transfer(market.accountId, registrationFee, { msg: 'register' }));
    await measure('register again (market refunds)', buyer, transfer(market.accountId, registrationFee, { msg: 'register' }));
    await measure('buy', buyer, transfer(market.accountId, 10n * USD, { msg: `buy:${openMarket}:yes:1` }));
    await measure('buy with an impossible min_out (market refunds)', buyer, transfer(market.accountId, 10n * USD, { msg: `buy:${openMarket}:yes:${'9'.repeat(39)}` }));
    await measure('a third refunded action in an hour (market refunds, signer paused)', buyer, transfer(market.accountId, 10n * USD, { msg: `buy:${openMarket}:yes:${'9'.repeat(39)}` }));
    await assert.rejects(relay.submit({ signed: [payload(buyer, [transfer(market.accountId, 10n * USD, { msg: `buy:${openMarket}:yes:1` }), transfer(relayer.accountId, RELAY_FEE)])] }, allow),
      (error: unknown) => error instanceof RelayError && error.code === 'signer_suspended', 'three refunded actions in an hour pause the signer');
    await measure('propose on an open market with 512-byte evidence (oracle refunds)', proposer,
      transfer(oracle.accountId, 5n * USD, { msg: `propose:${market.accountId}:${openMarket}:yes:${evidence}` }));
    await measure('challenge with no case (oracle refunds)', challenger, transfer(oracle.accountId, 5n * USD, { msg: `challenge:${market.accountId}:${openMarket}:no` }));
    while (BigInt(Date.now()) < BigInt((await view<{ close_at: string }>(market.accountId, 'get_market', { market_id: closingMarket })).close_at) / 1_000_000n + 2000n) {
      await new Promise(done => setTimeout(done, 1000));
    }
    await measure('propose with 512-byte evidence', proposer, transfer(oracle.accountId, 5n * USD, { msg: `propose:${market.accountId}:${closingMarket}:yes:${evidence}` }));
    await measure('challenge', challenger, transfer(oracle.accountId, 5n * USD, { msg: `challenge:${market.accountId}:${closingMarket}:no` }));

    const sybil = ed25519Signer();
    await fund(sybil, 20n * USD);
    let drainHash = '';
    const racing: RelayRpc['primary'] = { call: async (method, params) => {
      const p = params as Record<string, unknown>;
      if (method === 'query' && p.method_name === 'simulate_intents' && !drainHash) {
        const result = await rpc.primary.call(method, params);
        const drain = payload(sybil, [transfer(attackerAccount.accountId, 20n * USD)]);
        drainHash = (await attackerAccount.signAndSendTransaction({ receiverId: verifier.accountId, waitUntil: 'FINAL',
          actions: [actions.functionCall('execute_intents', { signed: [drain] }, teraToGas(300), 0n)] })).transaction.hash;
        return result;
      }
      return rpc.primary.call(method, params);
    } };
    const raced = createRelay(readConfig({ DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'sandbox', DEPLOYMENT_ID: 'redteam', DEPLOYMENT_START_BLOCK: '1',
      COLLATERAL_TOKEN_ID: collateral, VERIFIER_CONTRACT_ID: verifier.accountId, MARKET_CONTRACT_ID: market.accountId, ORACLE_CONTRACT_ID: oracle.accountId,
      RELAYER_ACCOUNT_ID: relayer.accountId, RELAYER_KEY: relayerKey.toString(), RELAY_MIN_FEE: String(RELAY_FEE) }), { ...rpc, primary: racing },
      createFeeQuoter({ minFee: RELAY_FEE, maxFee: 100_000n, decimals: 6 }, { nearUsd: async () => 3n * 10n ** 17n, gasPrice: rpcGasPrice(rpc.reads) }))!;
    const nearBeforeRace = await nearOf(relayer.accountId), attackerBefore = await nearOf(attackerAccount.accountId);
    let failedHash = '';
    await assert.rejects(raced.submit({ signed: [payload(sybil, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)])] }, allow),
      (error: unknown) => { failedHash = error instanceof RelayError ? error.hash ?? '' : ''; return error instanceof RelayError && error.code === 'execution_failed'; });
    const ourLoss = nearBeforeRace - await nearOf(relayer.accountId), attackerCost = attackerBefore - await nearOf(attackerAccount.accountId);
    t.diagnostic(`sybil drain race: our failed execute ${(await gasOf(failedHash)) / 1e12} TGas, ${ourLoss} yocto; attacker's drain ${(await gasOf(drainHash, attackerAccount.accountId)) / 1e12} TGas, ${attackerCost} yocto`);
    assert.ok(attackerCost >= ourLoss, `the attacker spends ${attackerCost} yocto to burn ${ourLoss} of ours`);

    const charged = Number(GAS_PER_ACTION) / 1e12;
    const over = rows.filter(row => row.tgas > charged);
    assert.deepEqual(over.map(row => `${row.name} ${row.tgas} TGas`), [], `actions burning more than the ${charged} TGas the fee charges for`);
    for (const row of rows) assert.equal(row.fee, RELAY_FEE, `${row.name}: the fee is collected even when the action is refunded`);
    const worst = rows.reduce((top, row) => (row.allowanceSpent > top.allowanceSpent ? row : top));
    t.diagnostic(`worst allowance draw ${worst.allowanceSpent} yocto for ${worst.name}; a ${allowance} yocto allowance lasts ${allowance / worst.allowanceSpent} such actions`);
    for (const row of rows) {
      assert.ok(row.allowanceSpent <= row.nearSpent * 2n,
        `${row.name}: the relayer key's allowance drops by ${row.allowanceSpent} yocto while the action costs ${row.nearSpent}, so the key runs dry ${row.allowanceSpent / (row.nearSpent || 1n)}x faster than the gas it pays`);
    }
  } finally {
    await sandbox?.tearDown();
  }
});
