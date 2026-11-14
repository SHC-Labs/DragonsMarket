import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import { ReadRpcClient } from '../src/providers.js';
import { RelayError, createRelay, validateItem, type RelayContext, type RelayHandler, type RelayRpc } from '../src/relay.js';
import { GAS_PER_ACTION, createFeeQuoter, rpcGasPrice } from '../src/relay-fee.js';

// Red-team measurements against the real intents.near wasm. Ports are fixed so this never collides with another sandbox.
const RPC_PORT = Number(process.env.REDTEAM_RPC_PORT ?? 47391);
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

// The identity point: OpenSSL verifies R = identity, S = 0 under it for every message. intents.near refuses it as a weak key.
const WEAK_KEY = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
const weakSigner: Signer = { id: WEAK_KEY.toString('hex'), sign: payload => ({ standard: 'raw_ed25519', payload,
  public_key: `ed25519:${base58Encode(WEAK_KEY)}`, signature: `ed25519:${base58Encode(Buffer.concat([WEAK_KEY, Buffer.alloc(32)]))}` }) };

test('what a signed payload can make the relayer pay for', { timeout: 600000 }, async t => {
  await mkdir('.local/tmp', { recursive: true });
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.start({ version: '2.13.4', config: { rpcPort: RPC_PORT, netPort: RPC_PORT + 1 } });
    const pid = (sandbox as unknown as { childProcess: ChildProcess }).childProcess.pid;
    if (process.env.REDTEAM_PID_FILE) await writeFile(process.env.REDTEAM_PID_FILE, String(pid));
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
    const account = async (name: string, balance: `${number}` = '30') => {
      const key = KeyPair.fromRandom('ed25519'), id = `${name}.${DEFAULT_ACCOUNT_ID}`;
      await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(balance) });
      return new Account(id, provider, key.toString());
    };
    const call = (signer: Account, receiverId: string, method: string, args: object, deposit = 0n) =>
      signer.signAndSendTransaction({ receiverId, waitUntil: 'FINAL', actions: [actions.functionCall(method, args, teraToGas(250), deposit)] });
    const view = async <T extends object | string | boolean>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
      (await provider.callFunction<T>({ contractId, method, args, blockQuery: { finality: 'final' } }))!;

    const owner = await account('owner');
    const verifier = await account('verifier', '60'), ft = await account('ft'), market = await account('market'), oracle = await account('oracle');
    const relayer = await account('relayer'), attacker = await account('attacker');
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
    const closeAt = BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n;
    const created = await call(owner, market.accountId, 'create_market', { title: 'Will the red team pass?', rule_text: 'Yes if it passes.',
      resolution_source: 'https://example.com/source', void_policy: 'Void if cancelled.', category: 'world', subcategory: 'science',
      close_at: String(closeAt), resolve_by: String(closeAt + 36_000_000_000_000n) }, nearToYocto('0.06'));
    assert.ok(typeof created.status === 'object' && 'SuccessValue' in created.status);
    const marketId = JSON.parse(Buffer.from(created.status.SuccessValue, 'base64').toString()) as string;
    const registrationFee = BigInt((await view<{ registration_fee: string }>(market.accountId, 'config')).registration_fee);

    const addKey = async () => {
      const key = KeyPair.fromRandom('ed25519');
      await relayer.signAndSendTransaction({ receiverId: relayer.accountId, waitUntil: 'FINAL',
        actions: [actions.addFunctionCallAccessKey(key.getPublicKey(), verifier.accountId, ['execute_intents'], nearToYocto('5'))] });
      return key;
    };
    // Production pacing: RPC_INTERVAL_MS cannot go below 1000, so every primary call waits at least a second behind the last one.
    const client = (intervalMs = 20) => new ReadRpcClient(sandbox!.rpcUrl, { timeoutMs: 30000, intervalMs });
    const rpc: RelayRpc = { primary: client(), second: client(), reads: client(), sendUrl: sandbox.rpcUrl, requireSecond: false };
    const relayWith = async (over: Partial<RelayRpc> = {}): Promise<RelayHandler> => createRelay(readConfig({ DATABASE_URL: 'postgresql://localhost/test',
      NETWORK: 'sandbox', DEPLOYMENT_ID: 'redteam', DEPLOYMENT_START_BLOCK: '1', COLLATERAL_TOKEN_ID: collateral,
      VERIFIER_CONTRACT_ID: verifier.accountId, MARKET_CONTRACT_ID: market.accountId, ORACLE_CONTRACT_ID: oracle.accountId,
      RELAYER_ACCOUNT_ID: relayer.accountId, RELAYER_KEY: (await addKey()).toString(), RELAY_MIN_FEE: String(RELAY_FEE) }), { ...rpc, ...over },
      createFeeQuoter({ minFee: RELAY_FEE, maxFee: 100_000n, decimals: 6 }, { nearUsd: async () => 3n * 10n ** 17n, gasPrice: rpcGasPrice(rpc.reads) }))!.submit;
    const context: RelayContext = { verifier: verifier.accountId, collateral, market: market.accountId, oracle: oracle.accountId, relayer: relayer.accountId, minFee: RELAY_FEE, maxFee: 100_000n };
    const tap = (inner: RelayRpc['primary'], before: (method: string, params: Record<string, unknown>) => Promise<void>) => ({
      call: async (method: Parameters<ReadRpcClient['call']>[0], params: object) => { await before(method, params as Record<string, unknown>); return inner.call(method, params); },
    });
    const nearOf = async (id: string) => BigInt(((await rpc.primary.call('query', { request_type: 'view_account', finality: 'final', account_id: id })) as { amount: string }).amount);
    const balance = async (id: string) => BigInt(await view<string>(verifier.accountId, 'mt_balance_of', { account_id: id, token_id: collateral }));
    const fund = (signer: Signer, amount: bigint) => call(owner, ft.accountId, 'ft_transfer_call', { receiver_id: verifier.accountId, amount: String(amount), msg: signer.id }, 1n);
    const transfer = (to: string, amount: bigint, extra: object = {}) => ({ intent: 'transfer', receiver_id: to, tokens: { [collateral]: String(amount) }, ...extra });
    const payload = (signer: Signer, intents: object[], lifeMs = 5 * 60_000, nonce = randomBytes(32).toString('base64')) => signer.sign(JSON.stringify({ signer_id: signer.id,
      verifying_contract: verifier.accountId, deadline: new Date(Date.now() + lifeMs).toISOString(), nonce, intents }));
    const simulate = (item: object) => provider.callFunction({ contractId: verifier.accountId, method: 'simulate_intents', args: { signed: [item] }, blockQuery: { finality: 'optimistic' } })
      .then(() => 'accepted', (error: unknown) => `refused: ${String(error).slice(0, 160)}`);
    const allow = () => true;
    const gasPrice = await rpcGasPrice(rpc.reads)();
    // What one fee pays for in NEAR: GAS_PER_ACTION at the gas price, times the 1.5 margin that is meant for price moves only.
    const feeCoversYocto = GAS_PER_ACTION * gasPrice * 3n / 2n;
    t.diagnostic(`gas price ${gasPrice} yocto/gas; one fee is priced to cover ${GAS_PER_ACTION / 10n ** 12n} TGas = ${GAS_PER_ACTION * gasPrice} yocto, ${feeCoversYocto} with the margin`);

    await t.test('measured: relayer NEAR per relayed action against what the fee is priced to cover', async () => {
      const relay = await relayWith();
      const rows: string[] = [];
      const measure = async (name: string, item: Record<string, string>, expect: string | null) => {
        const before = await nearOf(relayer.accountId);
        const outcome = await relay({ signed: [item] }, allow).then(() => 'ok', (error: unknown) => error instanceof RelayError ? error.code : String(error));
        const spent = before - await nearOf(relayer.accountId);
        rows.push(`${name}: ${outcome}, relayer spent ${spent} yocto = ${Number(spent * 1000n / feeCoversYocto) / 10}% of the margined fee budget`);
        if (expect) assert.equal(outcome, expect, name);
        return spent;
      };
      const signer = ed25519Signer();
      await fund(signer, 100n * USD);
      const register = await measure('register', payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]), 'ok');
      const buy = await measure('buy', payload(signer, [transfer(market.accountId, 10n * USD, { msg: `buy:${marketId}:yes:1` }), transfer(relayer.accountId, RELAY_FEE)]), 'ok');
      const refused = await measure('buy the market refuses (min shares out of reach)', payload(signer, [transfer(market.accountId, 10n * USD, { msg: `buy:${marketId}:yes:${10n ** 38n}` }), transfer(relayer.accountId, RELAY_FEE)]), 'transfer_refunded');
      const propose = await measure('oracle propose with 512 bytes of evidence (refused: market open)', payload(signer, [transfer(oracle.accountId, 5n * USD, { msg: `propose:${market.accountId}:${marketId}:yes:${'e'.repeat(512)}` }), transfer(relayer.accountId, RELAY_FEE)]), 'transfer_refunded');
      t.diagnostic(rows.join('\n'));
      const worst = [register, buy, refused, propose].reduce((a, b) => (a > b ? a : b));
      assert.ok(worst <= feeCoversYocto, `the costliest relayed action spent ${worst} yocto, more than the ${feeCoversYocto} one fee covers`);
    });

    // Not fixed: the attacker's own drain costs about 1.38 times what the relayer loses, so this is griefing, not profit.
    await t.test('measured: a balance drain raced after simulation, repeated with a fresh signer each round, costs the relayer every round; suspension does not stop it', async () => {
      const relayerLoss: bigint[] = [], attackerCost: bigint[] = [];
      let current = ed25519Signer();
      await fund(current, 20n * USD);
      for (let round = 0; round < 3; round++) {
        const next = ed25519Signer();
        const item = payload(current, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]);
        const drain = payload(current, [transfer(next.id, 20n * USD)]);
        let attackerBefore = 0n, attackerAfter = 0n, armed = true;
        // The relay's simulation sees the funded balance; the signer's own drain lands before the relay's send.
        const relay = await relayWith({ primary: { call: async (method, params) => {
          const result = await rpc.primary.call(method, params);
          if (armed && method === 'query' && (params as Record<string, unknown>).method_name === 'simulate_intents') {
            armed = false;
            attackerBefore = await nearOf(attacker.accountId);
            await attacker.signAndSendTransaction({ receiverId: verifier.accountId, waitUntil: 'FINAL',
              actions: [actions.functionCall('execute_intents', { signed: [drain] }, teraToGas(30), 0n)] });
            attackerAfter = await nearOf(attacker.accountId);
          }
          return result;
        } } });
        const before = await nearOf(relayer.accountId), fees = await balance(relayer.accountId);
        await assert.rejects(relay({ signed: [item] }, allow), (error: unknown) => error instanceof RelayError && error.code === 'execution_failed', `round ${round}`);
        relayerLoss.push(before - await nearOf(relayer.accountId));
        attackerCost.push(attackerBefore - attackerAfter);
        assert.equal(await balance(relayer.accountId), fees, 'no fee was paid');
        assert.equal(await balance(next.id), 20n * USD, 'the drain funded the next signer');
        current = next;
      }
      t.diagnostic(`relayer lost ${relayerLoss.join(', ')} yocto; attacker paid ${attackerCost.join(', ')} yocto for the drains`);
      for (const loss of relayerLoss) assert.ok(loss > 0n);
    });

    await t.test('measured: how long one item holds the queue under production pacing', async () => {
      const signer = ed25519Signer();
      await fund(signer, 40n * USD);
      const relay = await relayWith({ primary: client(1000), second: client(1000) });
      const started = Date.now();
      await relay({ signed: [payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]),
        payload(signer, [transfer(market.accountId, 10n * USD, { msg: `buy:${marketId}:yes:1` }), transfer(relayer.accountId, RELAY_FEE)])] }, allow);
      const perItem = (Date.now() - started) / 2;
      t.diagnostic(`one item took ${perItem} ms with 1000 ms pacing on a ~1 s sandbox block time; MAX_QUEUED = 8 two-item requests is ${(16 * perItem / 1000).toFixed(1)} s of queue`);
    });

    await t.test('a payload whose simulation runs in the last two seconds of its life is not sent, so it cannot fail on chain on the relayer\'s gas', async () => {
      const signer = ed25519Signer();
      await fund(signer, 20n * USD);
      const lifeMs = 61_000;
      const item = payload(signer, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)], lifeMs);
      const deadline = Date.parse(JSON.parse(item.payload!).deadline as string);
      // Stands in for a queue that took 59.5 seconds to reach this item. The relay's own primary pacing is the production 1000 ms.
      const paced = client(1000);
      let held = false;
      const primary = tap(paced, async (method, params) => {
        if (held || method !== 'query' || params.method_name !== 'simulate_intents') return;
        held = true;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() - 1500)));
      });
      const relay = await relayWith({ primary, second: null });
      const before = await nearOf(relayer.accountId);
      const outcome = await relay({ signed: [item] }, allow).then(() => 'ok', (error: unknown) => error instanceof RelayError ? `${error.code}${error.hash ? ' (sent)' : ''}` : String(error));
      const spent = before - await nearOf(relayer.accountId);
      t.diagnostic(`deadline race: ${outcome}, relayer spent ${spent} yocto`);
      assert.ok(!outcome.endsWith('(sent)'), `the relay sent a transaction that could not land before its deadline: ${outcome}`);
      assert.equal(spent, 0n, 'and spent gas on it');
    });

    const agree = async (name: string, item: Record<string, string>) => {
      const local = (() => { try { validateItem(item, context, Date.now(), 0); return 'accepted'; } catch (error) { return `refused ${(error as RelayError).code}`; } })();
      const chain = await simulate(item);
      t.diagnostic(`${name}: local ${local}, simulate_intents ${chain}`);
      assert.equal(local.startsWith('accepted'), chain === 'accepted', `${name}: local ${local}, chain ${chain}`);
    };

    await t.test('the local signature check refuses a forged signature under a weak ed25519 key, as intents.near does', async () => {
      await fund(weakSigner, 2n * USD);
      await agree('weak key', payload(weakSigner, [transfer(market.accountId, registrationFee, { msg: 'register' }), transfer(relayer.accountId, RELAY_FEE)]));
    });

    await t.test('held: canonical payloads with reordered keys, a non-BMP character and U+2028 in evidence are read the same way locally and on chain', async () => {
      const honest = ed25519Signer();
      await fund(honest, 20n * USD);
      const reordered = honest.sign(JSON.stringify({ intents: [{ tokens: { [collateral]: String(RELAY_FEE) }, receiver_id: relayer.accountId, intent: 'transfer' },
        { msg: 'register', tokens: { [collateral]: String(registrationFee) }, intent: 'transfer', receiver_id: market.accountId }],
        nonce: randomBytes(32).toString('base64'), deadline: new Date(Date.now() + 5 * 60_000).toISOString(), verifying_contract: verifier.accountId, signer_id: honest.id }));
      await agree('reordered keys', reordered);
      await agree('non-BMP and U+2028 evidence', payload(honest, [transfer(oracle.accountId, 5n * USD, { msg: `propose:${market.accountId}:${marketId}:yes:https://e.com/\u{1F409} x` }), transfer(relayer.accountId, RELAY_FEE)]));
    });

    await t.test('a lone surrogate escape in the evidence is read the same way locally and on chain', async () => {
      const honest = ed25519Signer();
      await fund(honest, 20n * USD);
      await agree('lone surrogate', payload(honest, [transfer(oracle.accountId, 5n * USD, { msg: `propose:${market.accountId}:${marketId}:yes:https://e.com/\ud800` }), transfer(relayer.accountId, RELAY_FEE)]));
    });
  } finally {
    if (sandbox) {
      const child = (sandbox as unknown as { childProcess: ChildProcess }).childProcess;
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await sandbox.tearDown(); } finally { clearTimeout(timer); }
    }
  }
});
