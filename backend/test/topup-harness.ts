import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageHash } from '../src/auth.js';
import { base58Decode, base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import { RpcError } from '../src/providers.js';
import { TopupError, runTopup, topupSettings, type OneClick, type QuoteRequest, type TopupDeps, type TopupJournal, type TopupSettings } from '../src/relay-topup.js';

// The relay-topup.test.ts stand-ins, extended with what an attacker controls: block time, the intents key set, the submit
// key allowance, a payload relayed by someone else, refunds and dust.
export const RELAYER = 'relayer.near', VERIFIER = 'intents.near', USDC = 'nep141:usdc.near', WNEAR = 'nep141:wrap.near';
export const NEAR = 10n ** 24n, USD = 1_000_000n;
export const START = Date.parse('2026-11-09T12:00:00Z');
export const MEDIAN = 3n * 10n ** 18n;
export const ATTACKER = 'f'.repeat(64);
export const SCRATCH = mkdtempSync(join(tmpdir(), 'topup-rt-'));
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const DAY_MS = 24 * 3600 * 1000;

export function keyText() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return 'ed25519:' + base58Encode(Buffer.concat([seed, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]));
}
export const publicOf = (secret: string) => 'ed25519:' + base58Encode(base58Decode(secret.slice(8)).subarray(32));
export const RELAY_KEY = keyText(), TREASURY_KEY = keyText(), SUBMIT_KEY = keyText();

export const baseEnv = () => ({ DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'sandbox', DEPLOYMENT_ID: 'topup', DEPLOYMENT_START_BLOCK: '1',
  COLLATERAL_TOKEN_ID: USDC, VERIFIER_CONTRACT_ID: VERIFIER, MARKET_CONTRACT_ID: 'market.near' });
export const topupEnv = { RELAYER_ACCOUNT_ID: RELAYER, RELAYER_PUBLIC_KEY: publicOf(RELAY_KEY),
  RELAY_TOPUP_BELOW_NEAR: '2', RELAY_TOPUP_MIN_USDC: String(5n * USD), RELAY_TOPUP_MAX_USDC: String(20n * USD),
  RELAY_TOPUP_MAX_USDC_PER_DAY: String(100n * USD) };

export interface JournalDb { row: { verifier: string; pending: unknown } | null; deposits: { at: number; amount: bigint }[] }
/** The relay_topup_journal and relay_topup_deposits rows in memory, round-tripped through JSON like jsonb. Each call is one host's connection to `db`. */
export function memoryJournal(now: () => number, db: JournalDb = { row: { verifier: VERIFIER, pending: null }, deposits: [] }): TopupJournal & { db: JournalDb } {
  return {
    db,
    async read() { return db.row && JSON.parse(JSON.stringify(db.row)); },
    async write(verifier, pending, deposit) {
      if (db.row && db.row.verifier !== verifier) throw new TopupError('topup_journal_scope_changed');
      db.row = { verifier, pending: JSON.parse(JSON.stringify(pending)) };
      if (deposit !== undefined) db.deposits.push({ at: now(), amount: deposit });
    },
    async depositedToday() { return db.deposits.filter(d => d.at > now() - DAY_MS).reduce((sum, d) => sum + d.amount, 0n); },
  };
}

export function settings(over: Partial<TopupSettings> = {}): TopupSettings {
  return { ...topupSettings({ ...topupEnv, RELAY_TOPUP_MODE: 'execute', RELAY_TREASURY_KEY: TREASURY_KEY, RELAY_TOPUP_SUBMIT_KEY: SUBMIT_KEY }, readConfig(baseEnv())), wnear: WNEAR, ...over };
}

export interface Signed { standard: string; payload: { message: string; nonce: string; recipient: string }; public_key: string; signature: string }
export interface Transfer { receiver: string; amount: bigint }

export function fakeChain(hostTime: () => number = () => START) {
  const chain = {
    native: 1n * NEAR, storageUsage: 1000, balances: new Map<string, bigint>([[USDC, 50n * USD], [WNEAR, 0n]]),
    used: new Set<string>(), keys: new Set([publicOf(TREASURY_KEY)]),
    accessNonces: new Map([[publicOf(RELAY_KEY), 7], [publicOf(SUBMIT_KEY), 40]]),
    submitAllowance: '1000000000000000000000000' as string | null,
    txs: new Map<string, { failed: boolean; executors: string[] }>(),
    events: [] as string[], lastSimulated: null as Signed | null, failWithdrawReceipt: false,
    applyBroadcast: true, broadcasts: [] as string[], transfers: [] as Transfer[], withdraws: [] as { receiver: string; amount: bigint }[],
    /** Chain block time in ms; null means it follows the host clock. */
    blockTimeMs: null as number | null,
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
      : intent.intent === 'native_withdraw' && (chain.balances.get(WNEAR) ?? 0n) >= BigInt(intent.amount as string));
  };
  /** Applies a signed payload the way execute_intents does, whoever submits it, under a transaction hash of the submitter's own. */
  const apply = (item: Signed, hash: string) => {
    const { valid, message } = intentsOf(item);
    assert.ok(valid, 'payload signature');
    assert.ok(Date.parse(message.deadline) >= (chain.blockTimeMs ?? 0), 'payload deadline is enforced on chain time');
    assert.ok(!chain.used.has(item.payload.nonce), 'nonce reuse');
    chain.used.add(item.payload.nonce);
    const kind = message.intents[0]!.intent as string;
    for (const intent of message.intents) {
      if (intent.intent === 'transfer') {
        const amount = BigInt((intent.tokens as Record<string, string>)[USDC]!);
        chain.balances.set(USDC, chain.balances.get(USDC)! - amount);
        chain.transfers.push({ receiver: intent.receiver_id as string, amount });
      } else {
        chain.balances.set(WNEAR, chain.balances.get(WNEAR)! - BigInt(intent.amount as string));
        chain.withdraws.push({ receiver: intent.receiver_id as string, amount: BigInt(intent.amount as string) });
        if (!chain.failWithdrawReceipt && intent.receiver_id === RELAYER) chain.native += BigInt(intent.amount as string);
      }
    }
    chain.txs.set(hash, { failed: kind === 'native_withdraw' && chain.failWithdrawReceipt, executors: kind === 'transfer' ? [VERIFIER] : [VERIFIER, 'wrap.near', VERIFIER, RELAYER] });
  };
  const call = async (method: string, params: object) => {
    const p = params as Record<string, string>;
    if (method === 'block') {
      return { header: { hash: base58Encode(Buffer.alloc(32, 1)), timestamp_nanosec: String(BigInt(chain.blockTimeMs ?? hostTime()) * 1_000_000n) } };
    }
    if (method === 'EXPERIMENTAL_tx_status') {
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
      const nonce = chain.accessNonces.get(p.public_key!);
      if (nonce === undefined) throw new RpcError(-32000, 'UNKNOWN_ACCESS_KEY');
      return { nonce, permission: { FunctionCall: { receiver_id: VERIFIER, method_names: ['execute_intents'], allowance: chain.submitAllowance } } };
    }
    const args = JSON.parse(Buffer.from(p.args_base64!, 'base64').toString()) as Record<string, unknown>;
    switch (p.method_name) {
      case 'mt_balance_of': return bytes(String(chain.balances.get(args.token_id as string) ?? 0n));
      case 'is_nonce_used': return bytes(chain.used.has(args.nonce as string));
      case 'has_public_key': return bytes(args.account_id === RELAYER && chain.keys.has(args.public_key as string));
      case 'public_keys_of': return bytes(args.account_id === RELAYER ? [...chain.keys] : []);
      case 'ft_metadata': return bytes({ spec: 'ft-1.0.0', name: 'USD Coin', symbol: 'USDC', decimals: 6 });
      case 'simulate_intents': {
        const [item] = args.signed as Signed[];
        chain.events.push(`simulate ${JSON.parse(item!.payload.message).intents[0].intent}`);
        if (!spendable(item!)) throw new RpcError(-32000, 'CONTRACT_EXECUTION_ERROR');
        chain.lastSimulated = item!;
        return bytes({ intents_executed: [], logs: [], min_deadline: 'x', state: { fee: 0, current_salt: '00' } });
      }
    }
    throw new Error(`unexpected ${method} ${p.method_name}`);
  };
  const broadcast = async (signed: string) => {
    chain.broadcasts.push(signed);
    const item = chain.lastSimulated!;
    chain.events.push(`broadcast ${JSON.parse(item.payload.message).intents[0].intent}`);
    if (!chain.applyBroadcast) throw new Error('process died before the transaction left');
    const hash = base58Encode(createHash('sha256').update(Buffer.from(signed, 'base64').subarray(0, -65)).digest());
    const tx = Buffer.from(signed, 'base64');
    const signerLength = tx.readUInt32LE(0);
    const signerKey = 'ed25519:' + base58Encode(tx.subarray(4 + signerLength + 1, 4 + signerLength + 33));
    chain.accessNonces.set(signerKey, Number(tx.readBigUInt64LE(4 + signerLength + 33)));
    apply(item, hash);
    return { final_execution_status: 'FINAL' };
  };
  return { chain, rpc: { call }, broadcast, apply };
}

export interface ClickOptions {
  usdPerNear?: number; statuses?: string[]; deliver?: boolean; depositAddress?: string;
  /** Credit the deposit back as collateral when 1Click says REFUNDED, as an honest solver would. */
  refund?: boolean;
}

export function fakeOneClick(chain: ReturnType<typeof fakeChain>['chain'], over: ClickOptions = {}) {
  const requests: QuoteRequest[] = [], statuses = [...(over.statuses ?? ['SUCCESS'])];
  const delivered = new Set<string>();
  let clock = () => START, quotes = 0;
  const outFor = (amount: string) => BigInt(amount) * NEAR * 1000n / BigInt(Math.round((over.usdPerNear ?? 3) * 1000)) / USD;
  const addresses = new Map<string, QuoteRequest>();
  const oneClick: OneClick = {
    async quote(request) {
      requests.push(request);
      const out = outFor(request.amount);
      const depositAddress = over.depositAddress ?? (quotes++).toString(16).padStart(64, 'a');
      if (!request.dry) addresses.set(depositAddress, request);
      return { quoteRequest: request, quote: { amountIn: request.amount, amountOut: String(out), minAmountOut: String(out * 9950n / 10000n),
        ...(request.dry ? {} : { depositAddress, deadline: new Date(clock() + 10 * 60_000).toISOString() }) } };
    },
    async status(depositAddress) {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      const request = addresses.get(depositAddress) ?? requests.at(-1)!;
      if (status === 'SUCCESS' && !delivered.has(depositAddress) && over.deliver !== false) {
        delivered.add(depositAddress);
        chain.balances.set(WNEAR, chain.balances.get(WNEAR)! + outFor(request.amount));
      }
      if (status === 'REFUNDED' && over.refund && !delivered.has(depositAddress)) {
        delivered.add(depositAddress);
        chain.balances.set(USDC, chain.balances.get(USDC)! + BigInt(request.amount));
      }
      return { status };
    },
  };
  return { oneClick, requests, setClock: (now: () => number) => { clock = now; } };
}

export function harness(over: { settings?: Partial<TopupSettings>; oneClick?: ClickOptions } = {}) {
  const clock = { now: START };
  const { chain, rpc, broadcast, apply } = fakeChain(() => clock.now);
  const click = fakeOneClick(chain, over.oneClick);
  click.setClock(() => clock.now);
  const logs: Record<string, unknown>[] = [];
  const journal = memoryJournal(() => clock.now);
  const deps: TopupDeps = { settings: settings(over.settings), primary: rpc, second: rpc, requireSecond: true, broadcast, oneClick: click.oneClick,
    nearUsd: async () => MEDIAN, journal, log: event => logs.push(event), now: () => clock.now, sleep: async ms => { clock.now += ms; } };
  return { chain, click, clock, logs, deps, journal, apply, run: (extra: Partial<TopupDeps> = {}) => runTopup({ ...deps, ...extra }) };
}

export const rejectsWith = (code: string) => (error: unknown) => error instanceof TopupError && error.code === code;
export const journalOf = (journal: { db: JournalDb }) => journal.db.row as { pending: Record<string, unknown> | null };
/** Runs the job and returns its state or its error code, so a test can drive several runs the way a scheduler would. */
export const attempt = async (run: Promise<{ state: string }>) => run.then(r => r.state, (e: unknown) => (e instanceof TopupError ? e.code : String(e)));
