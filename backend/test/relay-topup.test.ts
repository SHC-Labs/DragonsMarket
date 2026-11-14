import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { messageHash } from '../src/auth.js';
import { base58Decode, base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import { RpcError } from '../src/providers.js';
import { TopupError, runTopup, topupSettings, withTopupLock, type OneClick, type QuoteRequest, type TopupDeps, type TopupSettings } from '../src/relay-topup.js';
import { memoryJournal, type JournalDb } from './topup-harness.js';

const RELAYER = 'relayer.near', VERIFIER = 'intents.near', USDC = 'nep141:usdc.near', WNEAR = 'nep141:wrap.near';
const NEAR = 10n ** 24n, USD = 1_000_000n;
const START = Date.parse('2026-11-09T12:00:00Z');
const MEDIAN = 3n * 10n ** 18n;

function keyText() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return 'ed25519:' + base58Encode(Buffer.concat([seed, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]));
}
const publicOf = (secret: string) => 'ed25519:' + base58Encode(base58Decode(secret.slice(8)).subarray(32));
const RELAY_KEY = keyText(), TREASURY_KEY = keyText(), SUBMIT_KEY = keyText();
const DISTINCT = /RELAYER_KEY, RELAY_TREASURY_KEY and RELAY_TOPUP_SUBMIT_KEY must be three different keys/;

const baseEnv = () => ({ DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'sandbox', DEPLOYMENT_ID: 'topup', DEPLOYMENT_START_BLOCK: '1',
  COLLATERAL_TOKEN_ID: USDC, VERIFIER_CONTRACT_ID: VERIFIER, MARKET_CONTRACT_ID: 'market.near' });
const topupEnv = { RELAYER_ACCOUNT_ID: RELAYER, RELAYER_PUBLIC_KEY: publicOf(RELAY_KEY),
  RELAY_TOPUP_BELOW_NEAR: '2', RELAY_TOPUP_MIN_USDC: String(5n * USD), RELAY_TOPUP_MAX_USDC: String(20n * USD),
  RELAY_TOPUP_MAX_USDC_PER_DAY: String(100n * USD) };

function settings(over: Partial<TopupSettings> = {}): TopupSettings {
  return { ...topupSettings({ ...topupEnv, RELAY_TOPUP_MODE: 'execute', RELAY_TREASURY_KEY: TREASURY_KEY, RELAY_TOPUP_SUBMIT_KEY: SUBMIT_KEY }, readConfig(baseEnv())), wnear: WNEAR, ...over };
}

interface Signed { standard: string; payload: { message: string; nonce: string; recipient: string }; public_key: string; signature: string }

/** An intents.near stand-in that checks NEP-413 signatures and applies transfer and native_withdraw the way the contract does. */
function fakeChain(hostTime: () => number) {
  const chain = {
    native: 1n * NEAR, storageUsage: 1000, balances: new Map<string, bigint>([[USDC, 50n * USD], [WNEAR, 0n]]),
    used: new Set<string>(), keys: new Set([publicOf(TREASURY_KEY)]),
    accessNonces: new Map([[publicOf(RELAY_KEY), 7], [publicOf(SUBMIT_KEY), 40]]), keysQueried: [] as string[], signedWith: [] as string[],
    txs: new Map<string, { failed: boolean; executors: string[] }>(),
    events: [] as string[], lastSimulated: null as Signed | null, failSimulation: false, failNextStatus: 0, failWithdrawReceipt: false,
    applyBroadcast: true, broadcasts: [] as string[],
  };
  const bytes = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1 });
  const intentsOf = (item: Signed) => {
    const message = JSON.parse(item.payload.message) as { signer_id: string; deadline: string; intents: Record<string, unknown>[] };
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), base58Decode(item.public_key.slice(8))]), format: 'der', type: 'spki' });
    const valid = item.standard === 'nep413' && item.payload.recipient === VERIFIER && message.signer_id === RELAYER && chain.keys.has(item.public_key)
      && verify(null, messageHash(item.payload.message, item.payload.nonce, item.payload.recipient), key, base58Decode(item.signature.slice(8)));
    return { valid, message };
  };
  const spendable = (item: Signed) => {
    const { valid, message } = intentsOf(item);
    if (!valid || chain.used.has(item.payload.nonce)) return false;
    return message.intents.every(intent => intent.intent === 'transfer'
      ? (chain.balances.get(USDC) ?? 0n) >= BigInt((intent.tokens as Record<string, string>)[USDC]!)
      : intent.intent === 'native_withdraw' && intent.receiver_id === RELAYER && (chain.balances.get(WNEAR) ?? 0n) >= BigInt(intent.amount as string));
  };
  const call = async (method: string, params: object) => {
    const p = params as Record<string, string>;
    if (method === 'block') return { header: { hash: base58Encode(Buffer.alloc(32, 1)), timestamp_nanosec: String(BigInt(hostTime()) * 1_000_000n) } };
    if (method === 'EXPERIMENTAL_tx_status') {
      if (chain.failNextStatus > 0) { chain.failNextStatus--; throw new RpcError('transport_or_timeout'); }
      const tx = chain.txs.get(p.tx_hash!);
      if (!tx) throw new RpcError(-32000, 'UNKNOWN_TRANSACTION');
      const receipts = tx.executors.map((executor, index) => ({ id: `r${index}`, outcome: { executor_id: executor, logs: [],
        receipt_ids: index + 1 < tx.executors.length ? [`r${index + 1}`] : [],
        status: tx.failed && index === tx.executors.length - 1 ? { Failure: { ActionError: {} } } : index + 1 < tx.executors.length ? { SuccessReceiptId: `r${index + 1}` } : { SuccessValue: '' } } }));
      return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
        transaction: { hash: p.tx_hash, signer_id: RELAYER, receiver_id: VERIFIER, actions: [{ FunctionCall: { method_name: 'execute_intents', args: 'e30=', deposit: '0' } }] },
        transaction_outcome: { id: p.tx_hash, outcome: { executor_id: RELAYER, logs: [], receipt_ids: ['r0'], status: { SuccessReceiptId: 'r0' } } },
        receipts_outcome: receipts };
    }
    if (p.request_type === 'view_account') return { amount: String(chain.native), locked: '0', storage_usage: chain.storageUsage };
    if (p.request_type === 'view_access_key') {
      chain.keysQueried.push(p.public_key!);
      const nonce = chain.accessNonces.get(p.public_key!);
      if (nonce === undefined) throw new RpcError(-32000, 'UNKNOWN_ACCESS_KEY');
      return { nonce, permission: { FunctionCall: { receiver_id: VERIFIER, method_names: ['execute_intents'], allowance: String(NEAR) } } };
    }
    const args = JSON.parse(Buffer.from(p.args_base64!, 'base64').toString()) as Record<string, unknown>;
    switch (p.method_name) {
      case 'mt_balance_of': return bytes(String(chain.balances.get(args.token_id as string) ?? 0n));
      case 'is_nonce_used': return bytes(chain.used.has(args.nonce as string));
      case 'public_keys_of': return bytes(args.account_id === RELAYER ? [...chain.keys] : []);
      case 'ft_metadata': return bytes({ spec: 'ft-1.0.0', name: 'USD Coin', symbol: 'USDC', decimals: 6 });
      case 'simulate_intents': {
        const [item] = args.signed as Signed[];
        chain.events.push(`simulate ${JSON.parse(item!.payload.message).intents[0].intent}`);
        if (chain.failSimulation || !spendable(item!)) throw new RpcError(-32000, 'CONTRACT_EXECUTION_ERROR');
        chain.lastSimulated = item!;
        return bytes({ intents_executed: [], logs: [], min_deadline: 'x', state: { fee: 0, current_salt: '00' } });
      }
    }
    throw new Error(`unexpected ${method} ${p.method_name}`);
  };
  const broadcast = async (signed: string) => {
    chain.broadcasts.push(signed);
    const item = chain.lastSimulated!;
    const kind = JSON.parse(item.payload.message).intents[0].intent as string;
    chain.events.push(`broadcast ${kind}`);
    if (!chain.applyBroadcast) throw new Error('process died before the transaction left');
    const hash = base58Encode(createHash('sha256').update(Buffer.from(signed, 'base64').subarray(0, -65)).digest());
    const tx = Buffer.from(signed, 'base64');
    const signerLength = tx.readUInt32LE(0);
    const signerKey = 'ed25519:' + base58Encode(tx.subarray(4 + signerLength + 1, 4 + signerLength + 33));
    const txNonce = Number(tx.readBigUInt64LE(4 + signerLength + 33));
    assert.equal(txNonce, chain.accessNonces.get(signerKey)! + 1, 'the transaction nonce follows its own key');
    chain.accessNonces.set(signerKey, txNonce);
    chain.signedWith.push(signerKey);
    const { message } = intentsOf(item);
    chain.used.add(item.payload.nonce);
    for (const intent of message.intents) {
      if (intent.intent === 'transfer') chain.balances.set(USDC, chain.balances.get(USDC)! - BigInt((intent.tokens as Record<string, string>)[USDC]!));
      else {
        chain.balances.set(WNEAR, chain.balances.get(WNEAR)! - BigInt(intent.amount as string));
        if (!chain.failWithdrawReceipt) chain.native += BigInt(intent.amount as string);
      }
    }
    chain.txs.set(hash, { failed: kind === 'native_withdraw' && chain.failWithdrawReceipt, executors: kind === 'transfer' ? [VERIFIER] : [VERIFIER, 'wrap.near', VERIFIER, RELAYER] });
    return { final_execution_status: 'FINAL' };
  };
  return { chain, rpc: { call }, broadcast };
}

/** 1Click stand-in. A SUCCESS status credits the quoted wNEAR to the relayer's Intents account, as the solver would. */
function fakeOneClick(chain: ReturnType<typeof fakeChain>['chain'], over: { usdPerNear?: number; statuses?: string[]; deliver?: boolean; quote?: (request: QuoteRequest, now: number) => unknown } = {}) {
  const requests: QuoteRequest[] = [], statuses = [...(over.statuses ?? ['SUCCESS'])];
  let delivered = 0n, refunded = false;
  let clock = () => START;
  const oneClick: OneClick = {
    async quote(request) {
      requests.push(request);
      if (over.quote) return over.quote(request, clock());
      const out = BigInt(request.amount) * NEAR * 1000n / BigInt(Math.round((over.usdPerNear ?? 3) * 1000)) / USD;
      return { quoteRequest: request, quote: { amountIn: request.amount, amountOut: String(out), minAmountOut: String(out * 9950n / 10000n),
        ...(request.dry ? {} : { depositAddress: 'a'.repeat(64), deadline: new Date(clock() + 10 * 60_000).toISOString() }) } };
    },
    async status() {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      if (status === 'CRASH') throw new Error('process died while polling');
      if (status === 'SUCCESS' && !delivered && over.deliver !== false) {
        const quote = requests.at(-1)!;
        delivered = BigInt(quote.amount) * NEAR * 1000n / BigInt(Math.round((over.usdPerNear ?? 3) * 1000)) / USD;
        chain.balances.set(WNEAR, chain.balances.get(WNEAR)! + delivered);
      }
      if (status === 'REFUNDED' && !refunded) {
        refunded = true;
        chain.balances.set(USDC, chain.balances.get(USDC)! + BigInt(requests.at(-1)!.amount));
      }
      return { status };
    },
  };
  return { oneClick, requests, setClock: (now: () => number) => { clock = now; } };
}

function harness(over: { settings?: Partial<TopupSettings>; oneClick?: Parameters<typeof fakeOneClick>[1] } = {}) {
  const clock = { now: START };
  const { chain, rpc, broadcast } = fakeChain(() => clock.now);
  const click = fakeOneClick(chain, over.oneClick);
  click.setClock(() => clock.now);
  const logs: Record<string, unknown>[] = [];
  const journal = memoryJournal(() => clock.now);
  const deps: TopupDeps = { settings: settings(over.settings), primary: rpc, second: rpc, requireSecond: true, broadcast, oneClick: click.oneClick,
    nearUsd: async () => MEDIAN, journal, log: event => logs.push(event), now: () => clock.now, sleep: async ms => { clock.now += ms; } };
  return { chain, click, clock, logs, deps, journal, run: (extra: Partial<TopupDeps> = {}) => runTopup({ ...deps, ...extra }) };
}
const rejectsWith = (code: string) => (error: unknown) => error instanceof TopupError && error.code === code;
const journalOf = (journal: { db: JournalDb }) => journal.db.row as { pending: { step: string } | null };

test('settings: dry-run and 200 bps by default; amounts, modes and key separation are checked', () => {
  const config = readConfig(baseEnv());
  const defaults = topupSettings(topupEnv, config);
  assert.equal(defaults.mode, 'dry-run');
  assert.equal(defaults.maxSlippageBps, 200n);
  assert.equal(defaults.belowYocto, 2n * NEAR);
  assert.equal(defaults.treasuryKey, null);
  assert.equal(topupSettings({ ...topupEnv, RELAY_TOPUP_BELOW_NEAR: '0.25' }, config).belowYocto, NEAR / 4n);
  assert.throws(() => topupSettings({ ...topupEnv, RELAY_TOPUP_MODE: 'execute', RELAY_TOPUP_SUBMIT_KEY: SUBMIT_KEY }, config), /needs RELAY_TREASURY_KEY/);
  assert.throws(() => topupSettings({ ...topupEnv, RELAY_TOPUP_MODE: 'execute', RELAY_TREASURY_KEY: TREASURY_KEY }, config), /needs RELAY_TOPUP_SUBMIT_KEY/);
  assert.throws(() => topupSettings({ ...topupEnv, RELAY_TOPUP_MODE: 'live' }, config), /Invalid RELAY_TOPUP_MODE/);
  assert.throws(() => topupSettings({ ...topupEnv, RELAY_TOPUP_MAX_USDC: '1' }, config), /at least RELAY_TOPUP_MIN_USDC/);
  assert.throws(() => topupSettings({ ...topupEnv, RELAY_TOPUP_MAX_SLIPPAGE_BPS: '2001' }, config), /SLIPPAGE/);
  assert.throws(() => topupSettings({ ...topupEnv, RELAY_TOPUP_BELOW_NEAR: '0' }, config), /BELOW_NEAR/);
  const execute = { ...topupEnv, RELAY_TOPUP_MODE: 'execute' };
  for (const [treasury, submit, name] of [[RELAY_KEY, SUBMIT_KEY, 'treasury = relay'], [TREASURY_KEY, RELAY_KEY, 'submit = relay'], [TREASURY_KEY, TREASURY_KEY, 'submit = treasury']]) {
    assert.throws(() => topupSettings({ ...execute, RELAY_TREASURY_KEY: treasury, RELAY_TOPUP_SUBMIT_KEY: submit }, config), DISTINCT, name);
  }
  assert.throws(() => topupSettings({ ...topupEnv, RELAY_TREASURY_KEY: RELAY_KEY }, config), DISTINCT, 'refused in dry-run too');
  assert.throws(() => topupSettings({ ...topupEnv, RELAY_TOPUP_SUBMIT_KEY: RELAY_KEY }, config), DISTINCT, 'refused in dry-run too');
  assert.equal(topupSettings({ ...execute, RELAY_TREASURY_KEY: TREASURY_KEY, RELAY_TOPUP_SUBMIT_KEY: SUBMIT_KEY }, config).submitKey, SUBMIT_KEY);
});

test('the API configuration refuses to start with either top-up key in its environment', () => {
  assert.throws(() => readConfig({ ...baseEnv(), RELAY_TREASURY_KEY: TREASURY_KEY }), /belong to the relay top-up job/);
  assert.throws(() => readConfig({ ...baseEnv(), RELAY_TOPUP_SUBMIT_KEY: SUBMIT_KEY }), /belong to the relay top-up job/);
});

test('the top-up job refuses the API secret and keys that differ from the approved public keys', () => {
  const config = readConfig(baseEnv());
  assert.throws(() => topupSettings({ ...topupEnv, RELAYER_KEY: RELAY_KEY }, config), /must not be available/);
  const apiConfig = readConfig({ ...baseEnv(), RELAYER_ACCOUNT_ID: RELAYER, RELAYER_KEY: RELAY_KEY, RELAY_MIN_FEE: '1000' });
  assert.throws(() => topupSettings(topupEnv, apiConfig), /must not be available/);
  const execute = { ...topupEnv, RELAY_TOPUP_MODE: 'execute', RELAY_TREASURY_KEY: TREASURY_KEY, RELAY_TOPUP_SUBMIT_KEY: SUBMIT_KEY };
  assert.throws(() => topupSettings({ ...execute, RELAY_TREASURY_PUBLIC_KEY: publicOf(SUBMIT_KEY) }, config), /does not match its approved public key/);
  assert.throws(() => topupSettings({ ...execute, RELAY_TOPUP_SUBMIT_PUBLIC_KEY: publicOf(TREASURY_KEY) }, config), /does not match its approved public key/);
  assert.equal(topupSettings({ ...execute, RELAY_TREASURY_PUBLIC_KEY: publicOf(TREASURY_KEY),
    RELAY_TOPUP_SUBMIT_PUBLIC_KEY: publicOf(SUBMIT_KEY) }, config).mode, 'execute');
});

test('native NEAR at or above the threshold: nothing is quoted or signed', async () => {
  const h = harness();
  h.chain.native = 3n * NEAR;
  assert.deepEqual(await h.run(), { state: 'healthy', nativeYocto: String(3n * NEAR - 1000n * 10n ** 19n) });
  assert.equal(h.click.requests.length, 0);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('storage is not spendable: a balance above the threshold only by its storage stake still tops up', async () => {
  const h = harness({ settings: { mode: 'dry-run' } });
  h.chain.native = 2n * NEAR;
  assert.equal((await h.run()).state, 'dry_run');
});

test('collateral below RELAY_TOPUP_MIN_USDC: nothing is quoted', async () => {
  const h = harness();
  h.chain.balances.set(USDC, 5n * USD - 1n);
  assert.deepEqual(await h.run(), { state: 'insufficient_collateral', nativeYocto: String(NEAR - 10n ** 22n), collateralUnits: String(5n * USD - 1n) });
  assert.equal(h.click.requests.length, 0);
});

test('dry-run quotes the capped amount with dry=true and signs nothing', async () => {
  const h = harness({ settings: { mode: 'dry-run', treasuryKey: null } });
  const result = await h.run();
  assert.equal(result.state, 'dry_run');
  assert.equal(result.amountIn, String(20n * USD), 'RELAY_TOPUP_MAX_USDC caps a 50 USDC balance at 20');
  assert.deepEqual(h.click.requests.map(r => [r.dry, r.amount, r.depositType, r.recipient, r.recipientType, r.refundTo, r.refundType, r.originAsset, r.destinationAsset]),
    [[true, String(20n * USD), 'INTENTS', RELAYER, 'INTENTS', RELAYER, 'INTENTS', USDC, WNEAR]]);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(journalOf(h.journal).pending, null);
});

test('a quote worse than the median by more than the slippage budget is refused before anything is signed', async () => {
  const bad = harness({ oneClick: { usdPerNear: 3.07 } });
  await assert.rejects(bad.run(), (error: unknown) => rejectsWith('quote_price_refused')(error)
    && BigInt((error as TopupError).details.quotedUsdPerNear as string) > BigInt((error as TopupError).details.limitUsdPerNear as string));
  assert.equal(bad.chain.broadcasts.length, 0);
  assert.ok(bad.logs.some(e => e.event === 'quote' && e.medianUsdPerNear === String(MEDIAN)), 'the refused quote is logged with its amounts');
  const tight = harness({ settings: { maxSlippageBps: 50n }, oneClick: { usdPerNear: 3.0 } });
  await assert.rejects(tight.run(), rejectsWith('quote_price_refused'), 'minAmountOut is what is priced, so 1Click tolerance alone exceeds a 50 bps budget');
  const fair = harness({ oneClick: { usdPerNear: 3.03 } });
  assert.equal((await fair.run()).state, 'topped_up');
});

test('quotes that do not match the request, or pay into our own accounts, are refused', async () => {
  const cases: [string, (request: QuoteRequest, now: number) => unknown][] = [
    ['quote_request_mismatch', request => ({ quoteRequest: { ...request, recipient: 'thief.near' }, quote: { amountIn: request.amount, amountOut: '1', minAmountOut: '1', depositAddress: 'x.near', deadline: '2030-01-01T00:00:00Z' } })],
    ['quote_amount_mismatch', request => ({ quoteRequest: request, quote: { amountIn: '1', amountOut: '1', minAmountOut: '1', depositAddress: 'x.near', deadline: '2030-01-01T00:00:00Z' } })],
    ['invalid_deposit_address', request => ({ quoteRequest: request, quote: { amountIn: request.amount, amountOut: String(10n * NEAR), minAmountOut: String(10n * NEAR), depositAddress: VERIFIER, deadline: '2030-01-01T00:00:00Z' } })],
    ['invalid_quote', request => ({ quoteRequest: request, quote: { amountIn: request.amount, amountOut: '1', minAmountOut: '2', depositAddress: 'x.near', deadline: '2030-01-01T00:00:00Z' } })],
  ];
  for (const [code, quote] of cases) {
    const h = harness({ oneClick: { quote } });
    await assert.rejects(h.run(), rejectsWith(code), code);
    assert.equal(h.chain.broadcasts.length, 0, code);
  }
});

test('a quote with under two minutes left is refused as expiring', async () => {
  const h = harness({ oneClick: { quote: (request, now) => ({ quoteRequest: request, quote: { amountIn: request.amount, amountOut: String(10n * NEAR),
    minAmountOut: String(10n * NEAR), depositAddress: 'a'.repeat(64), deadline: new Date(now + 90_000).toISOString() } }) } });
  await assert.rejects(h.run(), rejectsWith('quote_expiring'));
  assert.equal(h.chain.broadcasts.length, 0);
});

test('execute: deposit, swap, native_withdraw; each send simulated first, NEAR delivered, journal cleared', async () => {
  const h = harness({ oneClick: { statuses: ['KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS'] } });
  const result = await h.run();
  const delivered = 20n * USD * NEAR * 1000n / 3000n / USD;
  assert.equal(result.state, 'topped_up');
  assert.equal(result.withdrawnYocto, String(delivered));
  assert.equal(h.chain.native, NEAR + delivered);
  assert.equal(h.chain.balances.get(USDC), 30n * USD);
  assert.equal(h.chain.balances.get(WNEAR), 0n);
  assert.deepEqual(h.chain.events, ['simulate transfer', 'simulate transfer', 'broadcast transfer', 'simulate native_withdraw', 'simulate native_withdraw', 'broadcast native_withdraw'],
    'both providers simulate before every send');
  assert.equal(journalOf(h.journal).pending, null);
  assert.deepEqual(h.chain.signedWith, [publicOf(SUBMIT_KEY), publicOf(SUBMIT_KEY)], 'both transactions are signed with the top-up submit key');
  assert.equal(h.chain.accessNonces.get(publicOf(RELAY_KEY)), 7, 'the API relay key nonce never moved');
  assert.ok(!h.chain.keysQueried.includes(publicOf(RELAY_KEY)), 'the job never even reads the API relay key');
  const events = h.logs.map(e => e.event);
  for (const event of ['balances', 'quote', 'deposit_sent', 'deposit_final', 'swap_status', 'withdraw_planned', 'withdraw_sent', 'withdraw_final'])
    assert.ok(events.includes(event), event);
  assert.equal(h.logs.find(e => e.event === 'deposit_final')!.amountIn, String(20n * USD));
});

test('simulation refused: nothing is broadcast, and the signed deposit an RPC has seen stays journalled until its deadline', async () => {
  const h = harness();
  h.chain.failSimulation = true;
  await assert.rejects(h.run(), rejectsWith('simulation_failed'));
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(journalOf(h.journal).pending!.step, 'deposit');
});

test('a treasury key not registered in intents.near is refused before any quote', async () => {
  const h = harness();
  h.chain.keys.clear();
  await assert.rejects(h.run(), rejectsWith('treasury_key_not_registered'));
  assert.equal(h.click.requests.length, 0);
});

test('a submit key that is missing on chain is refused before any quote', async () => {
  const h = harness();
  h.chain.accessNonces.delete(publicOf(SUBMIT_KEY));
  await assert.rejects(h.run(), rejectsWith('submit_key_invalid'));
  assert.equal(h.click.requests.length, 0);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('crash before the deposit left: the journal waits out the payload deadline, then a fresh quote is used; the old payload is never re-sent', async () => {
  const h = harness({ settings: { swapWaitMs: 10_000 } });
  h.chain.applyBroadcast = false;
  assert.deepEqual(await h.run(), { state: 'waiting', step: 'deposit' });
  const first = journalOf(h.journal).pending as unknown as { nonce: string; deadline: number };
  assert.equal(h.chain.broadcasts.length, 1);
  assert.deepEqual(await h.run(), { state: 'waiting', step: 'deposit' }, 'still inside deadline + grace: wait, do not resend');
  assert.equal(h.chain.broadcasts.length, 1);
  h.chain.applyBroadcast = true;
  h.clock.now = first.deadline + 2 * 60_000 + 1;
  assert.equal((await h.run()).state, 'topped_up');
  assert.ok(h.logs.some(e => e.event === 'deposit_expired_unspent' && e.nonce === first.nonce));
  assert.equal(h.chain.used.has(first.nonce), false, 'the first payload was never spent');
  assert.equal(h.click.requests.length, 2, 'a new quote, not the stale one');
  assert.equal(h.chain.balances.get(USDC), 30n * USD, 'exactly one deposit of 20 USDC moved');
});

test('crash after the deposit landed: the next run reads the swap status instead of depositing again', async () => {
  const h = harness({ oneClick: { statuses: ['CRASH', 'SUCCESS'] } });
  await assert.rejects(h.run(), /process died while polling/);
  assert.equal(journalOf(h.journal).pending!.step, 'swap');
  assert.equal(h.chain.balances.get(USDC), 30n * USD);
  assert.equal((await h.run()).state, 'topped_up');
  assert.equal(h.chain.balances.get(USDC), 30n * USD, 'no second deposit');
  assert.equal(h.click.requests.length, 1);
  assert.deepEqual(h.chain.events.filter(e => e.startsWith('broadcast')), ['broadcast transfer', 'broadcast native_withdraw']);
});

test('withdraw landed but its outcome was unreadable: the next run proves it from the nonce and receipts, no second withdraw', async () => {
  const h = harness();
  const original = h.chain.txs.set.bind(h.chain.txs);
  h.chain.txs.set = (hash, tx) => { if (tx.executors.length > 1) h.chain.failNextStatus = 2; return original(hash, tx); };
  await assert.rejects(h.run(), rejectsWith('transaction_not_final'));
  assert.equal(journalOf(h.journal).pending!.step, 'withdraw');
  h.chain.txs.set = original;
  const native = h.chain.native;
  assert.equal((await h.run()).state, 'withdrawn');
  assert.equal(h.chain.native, native, 'the NEAR arrived in the first run and nothing was sent again');
  assert.deepEqual(h.chain.events.filter(e => e.startsWith('broadcast')), ['broadcast transfer', 'broadcast native_withdraw']);
  assert.equal(journalOf(h.journal).pending, null);
});

test('a withdraw whose receipts failed after the wNEAR was taken stops the job until a person looks', async () => {
  const h = harness();
  h.chain.failWithdrawReceipt = true;
  await assert.rejects(h.run(), rejectsWith('withdraw_failed'));
  await assert.rejects(h.run(), rejectsWith('withdraw_failed'), 'sticky: every run reports it again');
  assert.deepEqual(h.chain.events.filter(e => e.startsWith('broadcast')), ['broadcast transfer', 'broadcast native_withdraw']);
});

test('1Click FAILED or INCOMPLETE_DEPOSIT keeps the journal and refuses to start another swap; REFUNDED clears it', async () => {
  for (const status of ['FAILED', 'INCOMPLETE_DEPOSIT']) {
    const h = harness({ oneClick: { statuses: [status] } });
    await assert.rejects(h.run(), rejectsWith('swap_needs_operator'), status);
    await assert.rejects(h.run(), rejectsWith('swap_needs_operator'), status);
    assert.equal(h.click.requests.length, 1, status);
  }
  const refunded = harness({ oneClick: { statuses: ['REFUNDED'] } });
  assert.equal((await refunded.run()).state, 'refunded');
  assert.equal(journalOf(refunded.journal).pending, null);
});

test('1Click reporting SUCCESS without the wNEAR in the Intents account stops the job; nothing is withdrawn or re-swapped', async () => {
  const h = harness({ oneClick: { deliver: false } });
  await assert.rejects(h.run(), rejectsWith('swap_output_missing'));
  await assert.rejects(h.run(), rejectsWith('swap_output_missing'));
  assert.equal(journalOf(h.journal).pending!.step, 'swap');
  assert.deepEqual(h.chain.events.filter(e => e.startsWith('broadcast')), ['broadcast transfer']);
  assert.equal(h.click.requests.length, 1);
});

test('a swap still processing when the wait runs out leaves the journal for the next run', async () => {
  const h = harness({ oneClick: { statuses: ['PROCESSING'] } });
  assert.deepEqual(await h.run(), { state: 'waiting', step: 'swap' });
  assert.equal(journalOf(h.journal).pending!.step, 'swap');
});

test('dry-run never acts on a pending journal', async () => {
  const h = harness({ oneClick: { statuses: ['PROCESSING'] } });
  await h.run();
  const calls = h.chain.broadcasts.length;
  assert.deepEqual(await h.run({ settings: { ...h.deps.settings, mode: 'dry-run' } }), { state: 'journal_pending', step: 'swap' });
  assert.equal(h.chain.broadcasts.length, calls);
});

test('leftover wNEAR in the Intents account is withdrawn even when NEAR is healthy', async () => {
  const h = harness();
  h.chain.native = 5n * NEAR;
  h.chain.balances.set(WNEAR, NEAR);
  assert.equal((await h.run()).state, 'withdrawn');
  assert.equal(h.chain.native, 6n * NEAR);
  assert.equal(h.click.requests.length, 0);
});

test('the two RPC providers must agree on whether a nonce was spent', async () => {
  const h = harness();
  h.chain.applyBroadcast = false;
  await h.run();
  const liar: TopupDeps['primary'] = { call: async (method, params) => {
    if ((params as Record<string, string>).method_name === 'is_nonce_used') return { result: [...Buffer.from('true')], logs: [], block_height: 1 };
    return h.deps.primary.call(method, params);
  } };
  await assert.rejects(h.run({ second: liar }), rejectsWith('rpc_disagreement'));
  await assert.rejects(h.run({ second: null }), rejectsWith('second_rpc_required'));
});

function fakePool(locked: boolean) {
  const queries: string[] = [];
  let released = 0;
  const client = { on() {}, off() {}, release() { released++; },
    async query(sql: string) { queries.push(sql); return { rows: [{ locked }] }; } };
  return { pool: { connect: async () => client } as never, queries, released: () => released };
}

test('lock held by another run: the work never starts and the connection is released', async () => {
  const held = fakePool(false);
  let ran = false;
  await assert.rejects(withTopupLock(held.pool, RELAYER, async () => { ran = true; }), rejectsWith('topup_lock_held'));
  assert.equal(ran, false);
  assert.equal(held.released(), 1);
  assert.equal(held.queries.filter(q => q.includes('unlock')).length, 0);
  const free = fakePool(true);
  assert.equal(await withTopupLock(free.pool, RELAYER, async () => 'ran'), 'ran');
  assert.match(free.queries[0]!, /pg_try_advisory_lock\(704346949,hashtext\(\$1\)\)/);
  assert.match(free.queries[1]!, /pg_advisory_unlock/);
  assert.equal(free.released(), 1);
});
