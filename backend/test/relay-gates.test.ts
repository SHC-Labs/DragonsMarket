import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createApp } from '../src/app.js';
import { base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import { ReadRpcClient, RpcError } from '../src/providers.js';
import { decimal } from '../src/prices.js';
import { RelayError, createRelay, type Relay, type RelayRpc } from '../src/relay.js';
import { FEE_WINDOW_MS, FeeAboveCeiling, createFeeQuoter, nearUsdFrom, requiredFee, rpcGasPrice, type FeeQuoter, type FeeSettings } from '../src/relay-fee.js';

const VERIFIER = 'intents.near', COLLATERAL = 'nep141:usdc.near', MARKET = 'market.near', ORACLE = 'oracle.near', RELAYER = 'relayer.near';
// Buy cost measured in the sandbox. Withdrawals cost more; the shared fee budget is 20 TGas per action.
const BUY_GAS = 13_373_310_573_060n;
const MIN_GAS_PRICE = 100_000_000n;
const YOCTO = 10n ** 24n;
const USD18 = (dollars: string) => decimal(dollars, 18);
const DEFAULTS: FeeSettings = { minFee: 1000n, maxFee: 100_000n, decimals: 6, swapCostBps: 150n };
// What an action really costs the relayer in collateral units: its gas at the gas price, in USD, plus converting the fee back to NEAR.
const costUnits = (gas: bigint, gasPrice: bigint, nearUsd: bigint, swapCostBps = 150n) =>
  (gas * gasPrice * nearUsd * (10_000n + swapCostBps) * 10n ** 6n + YOCTO * 10n ** 18n * 10_000n - 1n) / (YOCTO * 10n ** 18n * 10_000n);

function evmKey() {
  const secret = secp256k1.utils.randomSecretKey();
  const address = '0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12)).toString('hex');
  return (intents: object[], deadlineMs = 5 * 60_000) => {
    const payload = JSON.stringify({ signer_id: address, verifying_contract: VERIFIER, deadline: new Date(Date.now() + deadlineMs).toISOString(),
      nonce: randomBytes(32).toString('base64'), intents });
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(payload)}`), Buffer.from(payload)]));
    const recovered = secp256k1.sign(digest, secret, { prehash: false, format: 'recovered' });
    return { address, item: { standard: 'erc191', payload, signature: 'secp256k1:' + base58Encode(Buffer.concat([recovered.subarray(1), recovered.subarray(0, 1)])) } };
  };
}
const move = (to: string, amount: string, extra: object = {}) => ({ intent: 'transfer', receiver_id: to, tokens: { [COLLATERAL]: amount }, ...extra });
const buyWithFee = (fee = '1000') => [move(MARKET, '5000000', { msg: 'buy:3:yes:1' }), move(RELAYER, fee)];

function relayKeyText() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return 'ed25519:' + base58Encode(Buffer.concat([privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32), publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]));
}
const fixedFee = (fee = 1000n): FeeQuoter => ({ quote: async () => ({ fee, validUntil: Date.now() }), accepted: async () => fee });
function relayWith(rpc: Partial<RelayRpc>, key = relayKeyText(), fees: FeeQuoter = fixedFee()) {
  const refuse: RelayRpc['primary'] = { call: async () => { throw new RpcError('transport_or_timeout'); } };
  return createRelay(readConfig({ DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'sandbox', DEPLOYMENT_ID: 'redteam', DEPLOYMENT_START_BLOCK: '1',
    COLLATERAL_TOKEN_ID: COLLATERAL, VERIFIER_CONTRACT_ID: VERIFIER, MARKET_CONTRACT_ID: MARKET, ORACLE_CONTRACT_ID: ORACLE,
    RELAYER_ACCOUNT_ID: RELAYER, RELAYER_KEY: key, RELAY_MIN_FEE: '1000' }),
  { primary: refuse, second: null, reads: refuse, sendUrl: 'http://127.0.0.1:1', requireSecond: false, ...rpc }, fees)!;
}
const viewResult = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: 'x' });
const codeOf = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof RelayError ? error.code : String(error)));

/** A JSON-RPC endpoint behind a real paced ReadRpcClient, the way relayRpc builds `reads`: one call per second at the lowest RPC_INTERVAL_MS. */
function pacedBalances(balanceOf: (account: string) => string) {
  const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init!.body)) as { id: string; params: { args_base64: string } };
    const { account_id } = JSON.parse(Buffer.from(request.params.args_base64, 'base64').toString()) as { account_id: string };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: viewResult(balanceOf(account_id)) }));
  }) as typeof fetch;
  return new ReadRpcClient('https://rpc.invalid', { timeoutMs: 10_000, intervalMs: 1000 }, null, transport);
}

async function stubRpc(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const sent: string[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const { method, params, id } = JSON.parse(text) as { method: string; params: Record<string, unknown>; id: string };
    if (method === 'send_tx') sent.push(String(params.signed_tx_base64));
    const result = await answer(method, params);
    if (result === undefined) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, sent, close: () => { server.closeAllConnections(); server.close(); } };
}

const blockHash = base58Encode(randomBytes(32));
/** A chain whose primary provider simulates fine and reports the relayer key at `nonce()`. */
function chain(nonce: () => number, onSimulate: () => Promise<void> = async () => {}): RelayRpc['primary'] {
  return { call: async (method, params) => {
    const p = params as Record<string, unknown>;
    if (method === 'query' && p.method_name === 'simulate_intents') { await onSimulate(); return viewResult({}); }
    if (method === 'query' && p.request_type === 'view_access_key') {
      await new Promise(done => setTimeout(done, 20));
      return { nonce: nonce(), permission: { FunctionCall: { allowance: null, receiver_id: VERIFIER, method_names: ['execute_intents'] } }, block_height: 1, block_hash: blockHash };
    }
    if (method === 'block') return { header: { hash: blockHash } };
    throw new RpcError('transport_or_timeout');
  } };
}
const txNonce = (signed: string) => {
  const bytes = Buffer.from(signed, 'base64');
  return bytes.readBigUInt64LE(4 + bytes.readUInt32LE(0) + 33);
};

test('one unfunded signer replaying one signed body holds at most one balance-read slot and is charged its signer limit, so a funded honest user still gets through', async () => {
  const attacker = evmKey()(buyWithFee());
  const honest = evmKey()(buyWithFee());
  const relay = relayWith({ reads: pacedBalances(account => (account === honest.address ? '100000000' : '0')) });
  const charged: string[] = [];
  const allow = (signer: string) => { charged.push(signer); return true; };
  const flood: Promise<string>[] = [];
  // A sustained flood: whenever a read completes and frees a slot, the next replay takes it.
  for (let wave = 0; wave < 3; wave++) {
    flood.push(...Array.from({ length: 4 }, () => codeOf(relay.submit({ signed: [attacker.item] }, allow))));
    await new Promise(done => setTimeout(done, 20));
  }
  const honestCode = await codeOf(relay.submit({ signed: [honest.item] }, allow));
  const floodCodes = await Promise.all(flood);
  assert.ok(floodCodes.every(code => code === 'insufficient_balance' || code === 'relay_busy'), `the attacker is refused without spending anything: ${floodCodes}`);
  assert.ok(charged.includes(attacker.address), 'the per-signer limit is charged before the balance read, so one signed body cannot be replayed for free');
  assert.notEqual(honestCode, 'relay_busy', 'a funded user must not be locked out by unfunded requests that cost the attacker nothing');
});

test('a funded attacker whose buys the market refunds holds one queue slot, not all eight, and the next honest user is queued', async t => {
  let release: () => void = () => {};
  const gate = new Promise<void>(done => { release = done; });
  const rpc = await stubRpc(() => ({}));
  t.after(rpc.close);
  const relay = relayWith({ reads: { call: async () => viewResult('100000000000') }, sendUrl: rpc.url, primary: chain(() => 1, () => gate) });
  const attacker = evmKey();
  const queued: Promise<string>[] = [];
  for (let i = 0; i < 8; i++) {
    queued.push(codeOf(relay.submit({ signed: [attacker([move(MARKET, '1', { msg: `buy:3:yes:${2n ** 128n - 1n}` }), move(RELAYER, '1000')]).item] }, () => true)));
    await new Promise(done => setTimeout(done, 10));
  }
  const honest = codeOf(relay.submit({ signed: [evmKey()(buyWithFee()).item] }, () => true));
  await new Promise(done => setTimeout(done, 50));
  release();
  const honestCode = await honest;
  assert.deepEqual(await Promise.all(queued), ['transaction_not_final', ...Array(7).fill('relay_busy')], 'only the first attacker request was queued and sent');
  assert.notEqual(honestCode, 'relay_busy', 'one signer must not be able to hold every queue slot');
});

// No fee an honest user would pay makes a lockout expensive: 900 actions an hour at any fee under the 0.10 ceiling is under
// $90. So a lockout is stopped by the per-signer and per-client shares above, and the bar here is that holding the relay is never
// subsidised: at every gas price the relay still prices, the fees a refunded-buy flood pays cover the gas the relayer burns on it.
test('holding the relay is never subsidised: at every gas price the relay still prices, a refunded-buy flood pays at least the gas it burns', () => {
  // Per item the paced primary client makes simulate_intents, view_access_key, block and EXPERIMENTAL_tx_status calls, at least
  // RPC_INTERVAL_MS (minimum 1000) apart, before send_tx's own wait for finality.
  const primaryCallsPerItem = 4n, minIntervalMs = 1000n;
  const itemsPerHour = 3_600_000n / (primaryCallsPerItem * minIntervalMs);
  assert.equal(itemsPerHour, 900n);
  assert.equal(requiredFee(MIN_GAS_PRICE, USD18('3'), DEFAULTS), 9135n);
  for (let multiple = 1n; requiredFee(multiple * MIN_GAS_PRICE, USD18('3'), DEFAULTS) <= DEFAULTS.maxFee; multiple++) {
    const gasPrice = multiple * MIN_GAS_PRICE;
    const attackerUnitsPerHour = itemsPerHour * requiredFee(gasPrice, USD18('3'), DEFAULTS);
    const relayerGasUnitsPerHour = itemsPerHour * costUnits(12_529_764_068_076n, gasPrice, USD18('3'));
    assert.ok(attackerUnitsPerHour >= relayerGasUnitsPerHour,
      `at ${multiple}x the floor gas price the flood pays ${Number(attackerUnitsPerHour) / 1e6} USDC an hour for ${Number(relayerGasUnitsPerHour) / 1e6} USDC of gas`);
  }
});

test('a payload a few seconds from its deadline is not signed or sent, so it cannot fail on chain on our gas or suspend an honest signer', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const rpc = await stubRpc(() => ({}));
  try {
    const relay = relayWith({ reads: { call: async () => viewResult('100000000000') }, sendUrl: rpc.url,
      primary: chain(() => 1, async () => { clock += 59_000; }) });
    const { item } = evmKey()(buyWithFee(), 61_000);
    await codeOf(relay.submit({ signed: [item] }, () => true));
    assert.equal(rpc.sent.length, 0, `sent with ${(Date.parse(JSON.parse(item.payload).deadline) - clock) / 1000}s left before the deadline; the queue and the paced RPC calls ahead of it take longer than that`);
  } finally {
    Date.now = realNow;
    rpc.close();
  }
});

test('an isolated sandbox instance never replaces signed bytes after a nonce collision; production requires shared coordination', async () => {
  let chainNonce = 41n;
  const landed = new Set<string>();
  const hashOf = (signed: string) => base58Encode(createHash('sha256').update(Buffer.from(signed, 'base64').subarray(0, -65)).digest());
  const rpc = await stubRpc((method, params) => {
    const signed = String(params.signed_tx_base64);
    if (method === 'send_tx' && txNonce(signed) > chainNonce) {
      chainNonce = txNonce(signed);
      landed.add(hashOf(signed));
    }
    return {};
  });
  const primary: RelayRpc['primary'] = { call: async (method, params) => {
    const p = params as Record<string, unknown>;
    if (method === 'EXPERIMENTAL_tx_status') throw landed.has(String(p.tx_hash)) ? new RpcError('transport_or_timeout') : new RpcError(-32000, 'UNKNOWN_TRANSACTION');
    return chain(() => Number(chainNonce)).call(method, params);
  } };
  try {
    const key = relayKeyText();
    const shared = { reads: { call: async () => viewResult('100000000000') }, sendUrl: rpc.url, primary };
    const users = [relayWith(shared, key), relayWith(shared, key)].map(relay => ({ relay, body: { signed: [evmKey()(buyWithFee()).item] } }));
    const codes = await Promise.all(users.map(({ relay, body }) => codeOf(relay.submit(body, () => true))));
    assert.deepEqual(rpc.sent.map(txNonce), [42n, 42n], 'both instances read nonce 41 and signed 42');
    assert.deepEqual([...codes].sort(), ['transaction_dropped', 'transaction_not_final'], 'the dropped one is not told transaction_not_final until its payload expires');
    const loser = users[codes.indexOf('transaction_dropped')]!;
    assert.equal(await codeOf(loser.relay.submit(loser.body, () => true)), 'transaction_dropped');
    assert.deepEqual(rpc.sent.map(txNonce), [42n, 42n, 42n]);
    assert.equal(rpc.sent[2], rpc.sent[1]);
    assert.equal(landed.size, 1);
  } finally {
    rpc.close();
  }
});

test('an RPC that takes send_tx and never answers does not hold the single relay queue', { timeout: 30_000 }, async () => {
  const rpc = await stubRpc(method => (method === 'send_tx' ? undefined : {}));
  try {
    const relay = relayWith({ reads: { call: async () => viewResult('100000000000') }, sendUrl: rpc.url, primary: chain(() => 1) });
    const started = Date.now();
    const outcome = await Promise.race([codeOf(relay.submit({ signed: [evmKey()(buyWithFee()).item] }, () => true)), new Promise(done => setTimeout(() => done('still waiting'), 15_000))]);
    assert.notEqual(outcome, 'still waiting', `after ${(Date.now() - started) / 1000}s the item still holds the queue: keeperRpc waits 30s per attempt over 3 attempts, about 91s per item, 2 items a request, 8 requests queued`);
  } finally {
    rpc.close();
  }
});

test('once gas runs at 25x the floor a buy costs more than the ceiling, and the relay stops instead of accepting the ceiling', async () => {
  const gasPrice = 25n * MIN_GAS_PRICE;
  const quoter = createFeeQuoter(DEFAULTS, { nearUsd: async () => USD18('3'), gasPrice: async () => gasPrice });
  const cost = costUnits(BUY_GAS, gasPrice, USD18('3'));
  assert.ok(cost > DEFAULTS.maxFee, `a buy costs ${cost} units, above the ${DEFAULTS.maxFee} ceiling`);
  await assert.rejects(quoter.accepted(), FeeAboveCeiling, 'no fee is accepted below what a buy costs');
  await assert.rejects(quoter.quote(), FeeAboveCeiling, 'and none is quoted');
  const relay = relayWith({ reads: { call: async () => viewResult('100000000000') } }, undefined, quoter);
  assert.equal(await codeOf(relay.submit({ signed: [evmKey()(buyWithFee('100000')).item] }, () => true)), 'fee_unavailable');
});

test('under congestion a quote from before about 82 full blocks no longer covers a buy, and it is no longer accepted', async () => {
  // NEAR raises the gas price by 1% per block while blocks are more than half full. 1.2s blocks, the slower of the two block times seen on mainnet.
  const blocksAfter = (ms: number) => BigInt(Math.floor(ms / 1200));
  const priceAt = (blocks: bigint) => { let price = MIN_GAS_PRICE; for (let i = 0n; i < blocks; i++) price = price * 101n / 100n; return price; };
  let now = Date.parse('2026-11-10T12:00:00Z');
  const start = now;
  const quoter = createFeeQuoter(DEFAULTS, { nearUsd: async () => USD18('3'), gasPrice: async () => priceAt(blocksAfter(now - start)) }, () => now);
  const signedAtStart = await quoter.quote();
  now += 2 * 60_000;
  const accepted = await quoter.accepted();
  const cost = costUnits(BUY_GAS, priceAt(blocksAfter(now - start)), USD18('3'));
  assert.ok(signedAtStart.fee < cost, 'the quote signed before congestion no longer covers a buy');
  assert.ok(now - start < FEE_WINDOW_MS);
  assert.ok(accepted >= cost, `two minutes into congestion (gas ${priceAt(blocksAfter(now - start))} yocto) a buy costs ${cost} units and the relay still accepts ${accepted}`);
});

test('a gas price below the protocol minimum from one RPC is not believed, and the fee still covers a buy', async () => {
  const lying = rpcGasPrice({ call: async () => ({ gas_price: '1' }) });
  const quoter = createFeeQuoter(DEFAULTS, { nearUsd: async () => USD18('3'), gasPrice: lying });
  const accepted = await quoter.accepted().catch(() => DEFAULTS.maxFee);
  const cost = costUnits(BUY_GAS, MIN_GAS_PRICE, USD18('3'));
  assert.ok(accepted >= cost, `one RPC answering gas_price 1 makes the relay accept ${accepted} units for a buy that costs at least ${cost}`);
});

test('one of five price sources off by 6% is dropped as an outlier, and an hour later the fee is still the one the four others justify', async () => {
  let now = Date.parse('2026-11-10T12:00:00Z');
  const sources = ['3.00', '3.01', '3.02', '3.00', '3.20'].map(price => async () => ({ price }));
  const quoter = createFeeQuoter(DEFAULTS, { nearUsd: nearUsdFrom(sources), gasPrice: async () => MIN_GAS_PRICE }, () => now);
  now += 61 * 60_000;
  const { fee } = await quoter.quote();
  const fair = requiredFee(MIN_GAS_PRICE, USD18('3.01'), DEFAULTS);
  assert.ok(fee < DEFAULTS.maxFee, `four sources agree on $3.00-3.02 but the fee is ${fee}, ${Number(fee) / Number(fair)}x the ${fair} they justify`);
});

test('the relay limit is per IPv6 /48, so one /48 holder does not get 65,536 separate budgets', async () => {
  const config = { ...readConfig({ DATABASE_URL: 'postgresql://localhost/test', TRUSTED_PROXY_HOPS: '1', TRUSTED_PROXY_ADDRESSES: '127.0.0.1', TRUSTED_PROXY_HEADER: 'x-real-ip' }) };
  const relay: Relay = { submit: async () => ({ hashes: [] }), quote: async () => ({ fee: 1000n, validUntil: Date.now() }), status: () => ({ keyAllowance: null, keyAllowanceLow: false }) };
  const app = createApp(config, async () => {}, undefined, undefined, undefined, undefined, relay);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const statuses: number[] = [];
    for (let subnet = 0; subnet < 30; subnet++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/intents/relay`, { method: 'POST', body: '{}',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': `2001:db8:0:${subnet.toString(16)}::1` } });
      statuses.push(response.status);
    }
    assert.ok(statuses.filter(status => status === 200).length <= 10, `${statuses.filter(status => status === 200).length} of 30 relay requests from one /48 in one minute were served`);
  } finally {
    app.closeAllConnections();
    await new Promise<void>(done => app.close(() => done()));
  }
});
