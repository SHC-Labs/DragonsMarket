import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { readPrivateJson, writePrivateJson } from '../src/durable-file.js';
import { topupSettings, withTopupLock, type QuoteRequest } from '../src/relay-topup.js';
import { ATTACKER, NEAR, RELAYER, SCRATCH, SUBMIT_KEY, TREASURY_KEY, USD, attempt, baseEnv, harness, journalOf, publicOf, topupEnv } from './topup-harness.js';

// Attacks that failed against aa8b6df. Each passes today and guards the defense it names.

const quoteWith = (patch: (request: QuoteRequest) => Record<string, unknown>, echo: (request: QuoteRequest) => QuoteRequest = r => r) =>
  async (h: ReturnType<typeof harness>) => {
    h.deps.oneClick = { quote: async request => ({ quoteRequest: echo(request), quote: patch(request) }), status: async () => ({ status: 'SUCCESS' }) };
    return attempt(h.run());
  };
const fair = (request: QuoteRequest) => ({ amountIn: request.amount, amountOut: String(7n * NEAR), minAmountOut: String(6n * NEAR), depositAddress: ATTACKER,
  deadline: new Date(Date.parse('2026-11-09T12:10:00Z')).toISOString() });

test('held: a quote that lies about amountOut but guarantees little in minAmountOut is priced on minAmountOut and refused', async () => {
  const h = harness();
  assert.equal(await quoteWith(r => ({ ...fair(r), amountOut: String(1000n * NEAR), minAmountOut: String(NEAR) }))(h), 'quote_price_refused');
  assert.equal(h.chain.broadcasts.length, 0);
});

test('held: echoed request fields that differ (asset, recipient, refund, deposit type, dry) are refused before signing', async () => {
  const swaps: [keyof QuoteRequest, unknown][] = [['destinationAsset', 'nep141:usdt.near'], ['recipient', 'thief.near'], ['refundTo', 'thief.near'],
    ['recipientType', 'DESTINATION_CHAIN'], ['depositType', 'ORIGIN_CHAIN'], ['dry', true], ['originAsset', 'nep141:other.near']];
  for (const [field, value] of swaps) {
    const h = harness();
    assert.equal(await quoteWith(fair, r => ({ ...r, [field]: value }))(h), 'quote_request_mismatch', field);
    assert.equal(h.chain.broadcasts.length, 0, field);
  }
});

test('held: quote deadlines that are missing, unparseable or already past are refused', async () => {
  for (const deadline of [undefined, 'soon', '2026-11-09T11:00:00Z', 1e15]) {
    const h = harness();
    const state = await quoteWith(r => ({ ...fair(r), deadline }))(h);
    assert.ok(state === 'invalid_quote' || state === 'quote_expiring', `${deadline}: ${state}`);
    assert.equal(h.chain.broadcasts.length, 0);
  }
});

test('held: the deposit is the requested amount, to the quoted address, and the payload expires before the quote', async () => {
  const h = harness();
  assert.equal(await attempt(h.run()), 'topped_up');
  assert.equal(h.chain.transfers.length, 1);
  assert.equal(h.chain.transfers[0]!.amount, 20n * USD, 'never more than RELAY_TOPUP_MAX_USDC in one deposit');
  assert.deepEqual(h.chain.withdraws.map(w => w.receiver), [RELAYER], 'native_withdraw only ever pays the relayer');
});

test('held: a wNEAR shortfall after SUCCESS and FAILED / INCOMPLETE_DEPOSIT / unknown statuses stay sticky with no new deposit', async () => {
  for (const [statuses, deliver, code] of [[['SUCCESS'], false, 'swap_output_missing'], [['FAILED'], true, 'swap_needs_operator'],
    [['INCOMPLETE_DEPOSIT'], true, 'swap_needs_operator'], [['STOLEN'], true, 'invalid_swap_status']] as const) {
    const h = harness({ oneClick: { statuses: [...statuses], deliver } });
    for (let run = 0; run < 3; run++) assert.equal(await attempt(h.run()), code);
    assert.equal(h.chain.transfers.length, 1, code);
  }
});

test('held: the journal refuses symlinks, hard links, group/world modes and torn JSON (fails closed)', () => {
  const dir = join(SCRATCH, 'held');
  mkdirSync(dir, { mode: 0o700 });
  const real = join(dir, 'real.json');
  writePrivateJson(real, { version: 1 });
  const sym = join(dir, 'sym.json');
  symlinkSync(real, sym);
  assert.throws(() => readPrivateJson(sym, 16_384, 'unsafe'), /ELOOP|unsafe/);
  const hard = join(dir, 'hard.json');
  linkSync(real, hard);
  assert.throws(() => readPrivateJson(hard, 16_384, 'unsafe'), /unsafe/);
  const open = join(dir, 'open.json');
  writeFileSync(open, '{}');
  chmodSync(open, 0o644);
  assert.throws(() => readPrivateJson(open, 16_384, 'unsafe'), /unsafe/);
  const torn = join(dir, 'torn.json');
  writeFileSync(torn, '{"version":1,"pend', { mode: 0o600 });
  assert.throws(() => readPrivateJson(torn, 16_384, 'unsafe'), SyntaxError);
});

test('held: a tampered pending withdraw is never re-signed from the journal; amounts come from the chain', async () => {
  const h = harness();
  h.chain.native = 5n * NEAR;
  h.journal.db.row = { verifier: 'intents.near',
    pending: { step: 'withdraw', nonce: 'AAAA', deadline: 0, hash: '11111111111111111111111111111111', amount: String(1000n * NEAR), nativeBefore: String(5n * NEAR) } };
  assert.equal(await attempt(h.run()), 'healthy');
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(journalOf(h.journal).pending, null);
});

test('held: env values that would widen limits are rejected rather than coerced', () => {
  const config = readConfig(baseEnv());
  for (const [name, value] of [['RELAY_TOPUP_MAX_SLIPPAGE_BPS', '2001'], ['RELAY_TOPUP_MAX_SLIPPAGE_BPS', '-1'], ['RELAY_TOPUP_MAX_SLIPPAGE_BPS', '2e3'],
    ['RELAY_TOPUP_MAX_SLIPPAGE_BPS', ' 200'], ['RELAY_TOPUP_MAX_SLIPPAGE_BPS', '200.5'], ['RELAY_TOPUP_MAX_USDC', '1e9'], ['RELAY_TOPUP_MAX_USDC', '20 000000'],
    ['RELAY_TOPUP_MAX_USDC', '-1'], ['RELAY_TOPUP_MIN_USDC', '0'], ['RELAY_TOPUP_BELOW_NEAR', '1e3'], ['RELAY_TOPUP_BELOW_NEAR', 'Infinity'], ['RELAY_TOPUP_MODE', 'EXECUTE']]) {
    assert.throws(() => topupSettings({ ...topupEnv, [name!]: value }, config), Error, `${name}=${value}`);
  }
});

test('held: the API configuration refuses either top-up key, and the job refuses a shared key', () => {
  assert.throws(() => readConfig({ ...baseEnv(), RELAY_TREASURY_KEY: TREASURY_KEY }));
  assert.throws(() => readConfig({ ...baseEnv(), RELAY_TOPUP_SUBMIT_KEY: SUBMIT_KEY }));
  assert.throws(() => topupSettings({ ...topupEnv, RELAY_TOPUP_MODE: 'execute', RELAY_TREASURY_KEY: SUBMIT_KEY, RELAY_TOPUP_SUBMIT_KEY: SUBMIT_KEY }, readConfig(baseEnv())));
});

test('held: a full-access or multi-method submit key is refused before any quote', async () => {
  for (const permission of ['FullAccess', { FunctionCall: { receiver_id: 'intents.near', method_names: ['execute_intents', 'add_public_key'], allowance: '1' } },
    { FunctionCall: { receiver_id: 'intents.near', method_names: [], allowance: '1' } }, { FunctionCall: { receiver_id: 'evil.near', method_names: ['execute_intents'], allowance: '1' } }]) {
    const h = harness();
    const primary = h.deps.primary;
    const call: typeof primary.call = async (method, params) => {
      const p = params as Record<string, string>;
      if (p.request_type === 'view_access_key' && p.public_key === publicOf(SUBMIT_KEY)) return { nonce: 40, permission };
      return primary.call(method, params);
    };
    assert.equal(await attempt(h.run({ primary: { call } })), 'submit_key_invalid', JSON.stringify(permission));
    assert.equal(h.click.requests.length, 0);
  }
});

test('held: two runs never hold the advisory lock together', async () => {
  const held = new Set<string>();
  const pool = { connect: async () => ({ on() {}, off() {}, release() {},
    async query(sql: string, params: string[]) {
      const key = params[0]!;
      if (sql.includes('pg_try_advisory_lock')) { if (held.has(key)) return { rows: [{ locked: false }] }; held.add(key); return { rows: [{ locked: true }] }; }
      held.delete(key);
      return { rows: [{}] };
    } }) } as never;
  let inside = 0, overlap = false;
  const work = async () => { inside++; overlap ||= inside > 1; await new Promise(r => setTimeout(r, 10)); inside--; };
  const results = await Promise.allSettled([withTopupLock(pool, RELAYER, work), withTopupLock(pool, RELAYER, work)]);
  assert.equal(overlap, false);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
});
