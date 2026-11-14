import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { keeperRpc, signedFunctionCall } from '@dragons-market/keeper';
import type pg from 'pg';
import { finalTransaction, type FinalTransaction } from './agent-chain.js';
import { messageHash } from './auth.js';
import { base58Decode, base58Encode } from './base58.js';
import { readConfig, type Config } from './config.js';
import { createPool } from './database.js';
import { object } from './ingestion/block.js';
import { LOCK } from './locks.js';
import { RpcError, type ReadRpcClient } from './providers.js';
import { ed25519Key, executeIntentsKeyNonce, relayRpc } from './relay.js';
import { exchangeNearUsd } from './relay-fee.js';
import { isAccount, isHash, isUnits } from './validate.js';

type Rpc = Pick<ReadRpcClient, 'call'>;
export type TopupMode = 'dry-run' | 'execute';
export interface TopupSettings {
  mode: TopupMode;
  relayer: string;
  verifier: string;
  collateral: string;
  collateralDecimals: number;
  /** The verifier's wNEAR token id: what 1Click delivers and what native_withdraw burns. */
  wnear: string;
  belowYocto: bigint;
  minUnits: bigint;
  maxUnits: bigint;
  maxUnitsPerDay: bigint;
  maxSlippageBps: bigint;
  swapWaitMs: number;
  /** A FunctionCall key of the relayer limited to execute_intents, used by nothing else, so the API relay's key nonce never moves. */
  submitKey: string | null;
  treasuryKey: string | null;
  /** Accounts a quote's deposit address must never be: our own contracts and the relayer. */
  forbiddenDepositAddresses: string[];
}
export interface OneClick { quote(request: QuoteRequest): Promise<unknown>; status(depositAddress: string): Promise<unknown> }
export interface TopupDeps {
  settings: TopupSettings;
  primary: Rpc;
  second: Rpc | null;
  requireSecond: boolean;
  broadcast: (signedTx: string) => Promise<unknown>;
  oneClick: OneClick;
  /** NEAR in USD scaled by 1e18: the same exchange median the relay fee is priced from. */
  nearUsd: () => Promise<bigint>;
  journal: TopupJournal;
  log: (event: Record<string, unknown>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface QuoteRequest {
  dry: boolean; swapType: 'EXACT_INPUT'; slippageTolerance: number; originAsset: string; depositType: 'INTENTS'; destinationAsset: string;
  amount: string; refundTo: string; refundType: 'INTENTS'; recipient: string; recipientType: 'INTENTS'; deadline: string;
}
export type TopupState = 'healthy' | 'insufficient_collateral' | 'dry_run' | 'journal_pending' | 'waiting' | 'topped_up' | 'refunded' | 'withdrawn' | 'deposit_unspent' | 'daily_cap_reached';
export interface TopupResult { state: TopupState; [field: string]: unknown }

/**
 * `collateralBefore` is the Intents collateral balance just before the deposit, which a refund must restore. `nativeBefore` is the
 * relayer's spendable NEAR when the withdraw was signed, the baseline that proves a withdraw someone else landed reached us.
 */
export type TopupStep =
  | { step: 'deposit'; nonce: string; deadline: number; hash: string; depositAddress: string; amountIn: string; minAmountOut: string; collateralBefore: string }
  | { step: 'swap'; depositAddress: string; amountIn: string; minAmountOut: string; collateralBefore: string; depositHash: string }
  | { step: 'withdraw'; nonce: string; deadline: number; hash: string; amount: string; nativeBefore: string };
/** The relayer's journal row, shared by every host that takes the top-up lock. A missing row is not an empty journal. */
export interface TopupJournal {
  read(): Promise<{ verifier: string; pending: unknown } | null>;
  /** Writes the pending step, and with `deposit` also records that amount against the daily cap, in one transaction. */
  write(verifier: string, pending: TopupStep | null, deposit?: bigint): Promise<void>;
  depositedToday(): Promise<bigint>;
}

export const ONECLICK_URL = 'https://1click.chaindefuser.com';
const EXECUTE_GAS = 300n * 10n ** 12n;
const YOCTO_PER_NEAR = 10n ** 24n;
const PRICE_SCALE = 10n ** 18n;
const BPS = 10_000n;
const YOCTO_PER_STORAGE_BYTE = 10n ** 19n;
const DEFAULT_SLIPPAGE_BPS = '200';
const MAX_SLIPPAGE_BPS = 2000;
const DEFAULT_SWAP_WAIT_MS = 180_000;
const QUOTE_TTL_MS = 10 * 60_000;
// 1Click's own tolerance sets minAmountOut, the amount the median check prices. Kept well under the default 200 bps budget,
// which also has to absorb the 25 bps unauthenticated surcharge and the solver spread.
const ONECLICK_SLIPPAGE_BPS = 50;
// A deposit is signed only while the quote has this long left, and its payload expires a minute before the quote does.
const MIN_QUOTE_LIFE_MS = 2 * 60_000;
const QUOTE_MARGIN_MS = 60_000;
const PAYLOAD_TTL_MS = 3 * 60_000;
// Block time can trail the wall clock. Past deadline + grace an unused nonce can never be spent, so its step is dropped.
const DEADLINE_GRACE_MS = 2 * 60_000;
const NANOS_PER_MS = 1_000_000n;
// A FunctionCall allowance pays the gas of a leaked submit key; OPERATIONS.md sets 1 NEAR, and none or a large one is refused.
const MAX_SUBMIT_ALLOWANCE_YOCTO = 5n * YOCTO_PER_NEAR;
// Below this a native_withdraw costs a meaningful share of what it brings home, so dust sent by strangers stays put.
const MIN_WITHDRAW_YOCTO = YOCTO_PER_NEAR / 10n;
// A withdraw that someone else landed counts once spendable NEAR rose by its amount less this: room for the gas of our own failed
// transaction and of relay transactions in between, never more than half the amount.
const WITHDRAW_GAS_SLACK_YOCTO = YOCTO_PER_NEAR / 20n;
const STATUS_POLL_MS = 5000;
const ONECLICK_TIMEOUT_MS = 15_000;
const MAX_ONECLICK_BYTES = 65_536;
const VERSIONED_NONCE = Buffer.from('5628f6c6', 'hex');
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const WAITING = new Set(['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING']);
const NEEDS_OPERATOR = new Set(['FAILED', 'INCOMPLETE_DEPOSIT']);
const ECHOED: (keyof QuoteRequest)[] = ['dry', 'swapType', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType'];

export class TopupError extends Error {
  constructor(public readonly code: string, public readonly details: Record<string, unknown> = {}) { super(code); }
}

function nearToYocto(value: string | undefined, name: string): bigint {
  if (!value || !/^\d{1,9}(\.\d{1,24})?$/.test(value)) throw new Error(`Invalid ${name}: an amount of NEAR such as 2 or 0.5`);
  const [whole, fraction = ''] = value.split('.');
  const yocto = BigInt(whole!) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, '0'));
  if (yocto === 0n) throw new Error(`Invalid ${name}: it must be above zero`);
  return yocto;
}

function units(value: string | undefined, name: string): bigint {
  if (!isUnits(value) || value === '0') throw new Error(`Invalid ${name}: a whole number of collateral units above zero`);
  return BigInt(value);
}

function topupMode(env: NodeJS.ProcessEnv): TopupMode {
  const mode = env.RELAY_TOPUP_MODE || 'dry-run';
  if (mode !== 'dry-run' && mode !== 'execute') throw new Error('Invalid RELAY_TOPUP_MODE: dry-run or execute');
  return mode;
}

function topupLimits(env: NodeJS.ProcessEnv) {
  const minUnits = units(env.RELAY_TOPUP_MIN_USDC, 'RELAY_TOPUP_MIN_USDC'), maxUnits = units(env.RELAY_TOPUP_MAX_USDC, 'RELAY_TOPUP_MAX_USDC');
  if (maxUnits < minUnits) throw new Error('RELAY_TOPUP_MAX_USDC must be at least RELAY_TOPUP_MIN_USDC');
  const maxUnitsPerDay = units(env.RELAY_TOPUP_MAX_USDC_PER_DAY, 'RELAY_TOPUP_MAX_USDC_PER_DAY');
  if (maxUnitsPerDay < maxUnits) throw new Error('RELAY_TOPUP_MAX_USDC_PER_DAY must be at least RELAY_TOPUP_MAX_USDC');
  const slippage = env.RELAY_TOPUP_MAX_SLIPPAGE_BPS || DEFAULT_SLIPPAGE_BPS;
  if (!/^\d{1,4}$/.test(slippage) || Number(slippage) > MAX_SLIPPAGE_BPS) throw new Error(`Invalid RELAY_TOPUP_MAX_SLIPPAGE_BPS: 0 to ${MAX_SLIPPAGE_BPS}`);
  return { minUnits, maxUnits, maxUnitsPerDay, maxSlippageBps: BigInt(slippage) };
}

function requireDistinctKeys(relayPublicKey: string, treasuryKey: string | null, submitKey: string | null) {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(relayPublicKey) || base58Decode(relayPublicKey.slice(8)).length !== 32) {
    throw new Error('RELAYER_PUBLIC_KEY must be the API relay public key');
  }
  const publicKeys = [relayPublicKey];
  for (const [name, key] of [['RELAY_TREASURY_KEY', treasuryKey], ['RELAY_TOPUP_SUBMIT_KEY', submitKey]] as const) {
    if (!key) continue;
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(key) || base58Decode(key.slice(8)).length !== 64) throw new Error(`${name} must be an ed25519 secret key`);
    publicKeys.push(ed25519Key(key, name).publicKeyText);
  }
  if (new Set(publicKeys).size !== publicKeys.length) {
    throw new Error('RELAYER_KEY, RELAY_TREASURY_KEY and RELAY_TOPUP_SUBMIT_KEY must be three different keys: the treasury key moves the relayer\'s Intents balance, and the API relay key nonce must never move under a top-up');
  }
}

function topupKeys(env: NodeJS.ProcessEnv, mode: TopupMode, relayPublicKey: string) {
  const treasuryKey = env.RELAY_TREASURY_KEY || null, submitKey = env.RELAY_TOPUP_SUBMIT_KEY || null;
  if (mode === 'execute' && !treasuryKey) throw new Error('RELAY_TOPUP_MODE=execute needs RELAY_TREASURY_KEY');
  if (mode === 'execute' && !submitKey) throw new Error('RELAY_TOPUP_MODE=execute needs RELAY_TOPUP_SUBMIT_KEY');
  requireDistinctKeys(relayPublicKey, treasuryKey, submitKey);
  for (const [name, secret, approved] of [
    ['RELAY_TREASURY_KEY', treasuryKey, env.RELAY_TREASURY_PUBLIC_KEY],
    ['RELAY_TOPUP_SUBMIT_KEY', submitKey, env.RELAY_TOPUP_SUBMIT_PUBLIC_KEY],
  ] as const) {
    if (secret && approved && ed25519Key(secret, name).publicKeyText !== approved) throw new Error(`${name} does not match its approved public key`);
  }
  return { treasuryKey, submitKey };
}

export function topupSettings(env: NodeJS.ProcessEnv, config: Config): TopupSettings {
  const { deployment } = config;
  if (env.RELAYER_KEY || config.relay) throw new Error('The API RELAYER_KEY must not be available to the top-up job');
  const relayer = env.RELAYER_ACCOUNT_ID;
  if (!deployment?.contracts.verifier || !isAccount(relayer) || Object.values(deployment.contracts).includes(relayer)
    || (config.network === 'mainnet' && relayer.endsWith('.testnet'))) throw new Error('The top-up job needs a distinct relayer account and deployment');
  const mode = topupMode(env), limits = topupLimits(env), keys = topupKeys(env, mode, env.RELAYER_PUBLIC_KEY ?? '');
  return {
    mode, relayer, verifier: deployment.contracts.verifier, collateral: deployment.collateralTokenId,
    collateralDecimals: deployment.collateralDecimals, wnear: config.network === 'mainnet' ? 'nep141:wrap.near' : 'nep141:wrap.testnet',
    belowYocto: nearToYocto(env.RELAY_TOPUP_BELOW_NEAR, 'RELAY_TOPUP_BELOW_NEAR'), ...limits, swapWaitMs: DEFAULT_SWAP_WAIT_MS, ...keys,
    forbiddenDepositAddresses: [relayer, ...Object.values(deployment.contracts)],
  };
}

const signedStep = (s: Record<string, unknown>) => typeof s.nonce === 'string' && Number.isSafeInteger(s.deadline) && isHash(s.hash);
const swapFields = (s: Record<string, unknown>) => isAccount(s.depositAddress) && isUnits(s.amountIn) && isUnits(s.minAmountOut) && isUnits(s.collateralBefore);
const STEP_CHECKS: Record<TopupStep['step'], (s: Record<string, unknown>) => boolean> = {
  deposit: s => signedStep(s) && swapFields(s),
  swap: s => swapFields(s) && isHash(s.depositHash),
  withdraw: s => signedStep(s) && isUnits(s.amount) && isUnits(s.nativeBefore),
};
const isStep = (p: unknown): p is TopupStep =>
  object(p) && typeof p.step === 'string' && Object.hasOwn(STEP_CHECKS, p.step) && STEP_CHECKS[p.step as TopupStep['step']](p);

/** The pending step, or undefined when the relayer has no journal row yet. */
async function readPending(journal: TopupJournal, settings: TopupSettings): Promise<TopupStep | null | undefined> {
  const row = await journal.read();
  if (row === null) return undefined;
  if (row.verifier !== settings.verifier) throw new TopupError('topup_journal_scope_changed');
  if (row.pending !== null && !isStep(row.pending)) throw new TopupError('invalid_topup_journal');
  return row.pending;
}

/** Signs intents for the relayer's own Intents account as a NEP-413 payload, the standard named accounts use. */
function treasurySigner(secret: string, signer: string, verifier: string) {
  const key = ed25519Key(secret, 'RELAY_TREASURY_KEY');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, key.seed]), format: 'der', type: 'pkcs8' });
  return {
    publicKey: key.publicKeyText,
    sign(intents: object[], deadline: number) {
      let bytes = randomBytes(32);
      while (bytes.subarray(0, 4).equals(VERSIONED_NONCE)) bytes = randomBytes(32);
      const nonce = bytes.toString('base64');
      const message = JSON.stringify({ signer_id: signer, deadline: new Date(deadline).toISOString(), intents });
      const signature = sign(null, messageHash(message, nonce, verifier), privateKey);
      return { nonce, item: { standard: 'nep413', payload: { message, nonce, recipient: verifier }, public_key: key.publicKeyText, signature: `ed25519:${base58Encode(signature)}` } };
    },
  };
}

interface Quote { amountIn: bigint; amountOut: bigint; minAmountOut: bigint; depositAddress: string | null; deadline: number | null }

function member(raw: unknown, key: string) {
  const value = object(raw) ? raw[key] : null;
  return object(value) ? value : null;
}

function quoteAmounts(quote: Record<string, unknown>, request: QuoteRequest) {
  const { amountIn, amountOut, minAmountOut } = quote;
  if (!isUnits(amountIn) || !isUnits(amountOut) || !isUnits(minAmountOut) || minAmountOut === '0' || BigInt(minAmountOut) > BigInt(amountOut))
    throw new TopupError('invalid_quote');
  if (amountIn !== request.amount) throw new TopupError('quote_amount_mismatch', { requested: request.amount, quoted: amountIn });
  return { amountIn: BigInt(amountIn), amountOut: BigInt(amountOut), minAmountOut: BigInt(minAmountOut) };
}

function quoteDeposit(quote: Record<string, unknown>, settings: TopupSettings, now: number) {
  const depositAddress = quote.depositAddress, deadline = typeof quote.deadline === 'string' ? Date.parse(quote.deadline) : NaN;
  if (!isAccount(depositAddress) || settings.forbiddenDepositAddresses.includes(depositAddress)) throw new TopupError('invalid_deposit_address');
  if (!Number.isFinite(deadline)) throw new TopupError('invalid_quote');
  if (deadline - now < MIN_QUOTE_LIFE_MS) throw new TopupError('quote_expiring', { deadline: new Date(deadline).toISOString() });
  return { depositAddress, deadline };
}

function parseQuote(raw: unknown, request: QuoteRequest, settings: TopupSettings, now: number): Quote {
  const quote = member(raw, 'quote'), echo = member(raw, 'quoteRequest');
  if (!quote || !echo) throw new TopupError('invalid_quote');
  const changed = ECHOED.filter(field => echo[field] !== request[field]);
  if (changed.length) throw new TopupError('quote_request_mismatch', { fields: changed });
  const amounts = quoteAmounts(quote, request);
  if (request.dry) return { ...amounts, depositAddress: null, deadline: null };
  return { ...amounts, ...quoteDeposit(quote, settings, now) };
}

/** USD paid per NEAR, scaled by 1e18, with the collateral counted at one dollar. Rounded up so a borderline quote is refused. */
function usdPerNear(collateral: bigint, yocto: bigint, decimals: number) {
  const numerator = collateral * YOCTO_PER_NEAR * PRICE_SCALE, denominator = yocto * 10n ** BigInt(decimals);
  return (numerator + denominator - 1n) / denominator;
}

const outcomeOf = (tx: FinalTransaction) => JSON.stringify([[...tx.failed].sort(), [...tx.succeeded].sort()]);

type SwapStep = Extract<TopupStep, { step: 'swap' }>;
type DepositStep = Extract<TopupStep, { step: 'deposit' }>;
type WithdrawStep = Extract<TopupStep, { step: 'withdraw' }>;
type Advance = 'next' | 'waiting';

/** One run's state, shared by every step: the journalled step and what this run has already settled. */
interface Run {
  deps: TopupDeps;
  s: TopupSettings;
  log: TopupDeps['log'];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  providers: Rpc[];
  wnearAccount: string;
  pending: TopupStep | null;
  swapOutcome: 'topped_up' | 'refunded' | null;
  withdrawn: bigint;
}

const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const save = (run: Run, deposit?: bigint) => run.deps.journal.write(run.s.verifier, run.pending, deposit);

async function startRun(deps: TopupDeps): Promise<Run> {
  const s = deps.settings;
  if (deps.requireSecond && !deps.second) throw new TopupError('second_rpc_required');
  let pending = await readPending(deps.journal, s);
  if (pending === undefined) {
    if (s.mode === 'execute') throw new TopupError('topup_journal_missing');
    await deps.journal.write(s.verifier, null);
    pending = null;
  }
  return { deps, s, log: deps.log, now: deps.now ?? Date.now, sleep: deps.sleep ?? wait, providers: [deps.primary, ...(deps.second ? [deps.second] : [])],
    wnearAccount: s.wnear.slice('nep141:'.length), pending, swapOutcome: null, withdrawn: 0n };
}

async function view(run: Run, provider: Rpc, method: string, args: object, account = run.s.verifier) {
  const result = await provider.call('query', { request_type: 'call_function', finality: 'final', account_id: account, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  if (!object(result) || !Array.isArray(result.result)) throw new TopupError('rpc_invalid_view', { method });
  return JSON.parse(Buffer.from(result.result as number[]).toString()) as unknown;
}

async function intentsBalance(run: Run, token: string) {
  const balance = await view(run, run.deps.primary, 'mt_balance_of', { account_id: run.s.relayer, token_id: token });
  if (!isUnits(balance)) throw new TopupError('rpc_invalid_view', { method: 'mt_balance_of' });
  return BigInt(balance);
}

async function nonceUsed(run: Run, nonce: string) {
  const answers = await Promise.all(run.providers.map(provider => view(run, provider, 'is_nonce_used', { account_id: run.s.relayer, nonce })));
  if (answers.some(answer => typeof answer !== 'boolean' || answer !== answers[0])) throw new TopupError('rpc_disagreement', { method: 'is_nonce_used' });
  return answers[0] as boolean;
}

async function spendableNear(run: Run) {
  const account = await run.deps.primary.call('query', { request_type: 'view_account', finality: 'final', account_id: run.s.relayer });
  if (!object(account) || !isUnits(account.amount) || !isUnits(account.locked) || !Number.isSafeInteger(account.storage_usage)) throw new TopupError('rpc_invalid_view', { method: 'view_account' });
  const storage = BigInt(account.storage_usage as number) * YOCTO_PER_STORAGE_BYTE - BigInt(account.locked);
  const spendable = BigInt(account.amount) - (storage > 0n ? storage : 0n);
  return spendable > 0n ? spendable : 0n;
}

async function finalBlockMs(provider: Rpc) {
  const block = await provider.call('block', { finality: 'final' });
  const nanos = object(block) && object(block.header) ? block.header.timestamp_nanosec : null;
  if (!isUnits(nanos)) throw new TopupError('rpc_invalid_view', { method: 'block' });
  return Number(BigInt(nanos) / NANOS_PER_MS);
}

/** The slowest provider's final block time: a payload is written off only once every provider's chain is past its deadline. */
const chainTime = async (run: Run) => Math.min(...await Promise.all(run.providers.map(finalBlockMs)));

async function submitAccessKey(run: Run, publicKey: string): Promise<unknown> {
  try {
    return await run.deps.primary.call('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: run.s.relayer, public_key: publicKey });
  } catch (error) {
    if (error instanceof RpcError && error.causeName === 'UNKNOWN_ACCESS_KEY') throw new TopupError('submit_key_invalid', { publicKey });
    throw error;
  }
}

async function submitKeyNonce(run: Run) {
  const publicKey = ed25519Key(run.s.submitKey!, 'RELAY_TOPUP_SUBMIT_KEY').publicKeyText;
  const access = await submitAccessKey(run, publicKey);
  const nonce = executeIntentsKeyNonce(access, run.s.verifier);
  const allowance = object(access) && object(access.permission) && object(access.permission.FunctionCall) ? access.permission.FunctionCall.allowance : null;
  if (nonce === null || !isUnits(allowance) || BigInt(allowance) > MAX_SUBMIT_ALLOWANCE_YOCTO) throw new TopupError('submit_key_invalid', { publicKey, allowance });
  return nonce;
}

async function simulateOn(provider: Rpc, verifier: string, args_base64: string): Promise<unknown> {
  try {
    return await provider.call('query', { request_type: 'call_function', finality: 'optimistic', account_id: verifier, method_name: 'simulate_intents', args_base64 });
  } catch (error) {
    if (error instanceof RpcError && error.causeName === 'CONTRACT_EXECUTION_ERROR') throw new TopupError('simulation_failed');
    throw error;
  }
}

function checkSimulation(result: unknown) {
  if (object(result) && typeof result.error === 'string') throw new TopupError('simulation_failed', { reason: result.error.slice(0, 200) });
  if (!object(result) || !Array.isArray(result.result)) throw new TopupError('rpc_invalid_view', { method: 'simulate_intents' });
  const output = JSON.parse(Buffer.from(result.result as number[]).toString()) as unknown;
  if (!object(output) || output.invariant_violated !== undefined) throw new TopupError('simulation_failed', { output });
}

async function simulate(run: Run, item: object) {
  const args_base64 = Buffer.from(JSON.stringify({ signed: [item] })).toString('base64');
  await Promise.all(run.providers.map(async provider => checkSimulation(await simulateOn(provider, run.s.verifier, args_base64))));
}

/** Signs the intents and the transaction, journals the step with its hash, then simulates and broadcasts. No RPC sees the payload before the journal holds it. */
async function executeIntents(run: Run, intents: object[], deadline: number, pending: (nonce: string, hash: string) => TopupStep, deposit?: bigint) {
  const { s, deps } = run;
  const signer = treasurySigner(s.treasuryKey!, s.relayer, s.verifier);
  const { nonce, item } = signer.sign(intents, deadline);
  const key = ed25519Key(s.submitKey!, 'RELAY_TOPUP_SUBMIT_KEY');
  const [current, block] = await Promise.all([submitKeyNonce(run), deps.primary.call('block', { finality: 'optimistic' })]);
  const blockHash = object(block) && object(block.header) ? block.header.hash : null;
  if (!isHash(blockHash)) throw new TopupError('rpc_invalid_view', { method: 'block' });
  const signed = signedFunctionCall({ signer: s.relayer, seed: key.seed, publicKey: key.publicKey, nonce: current + 1n, receiver: s.verifier,
    blockHash: base58Decode(blockHash), method: 'execute_intents', args: Buffer.from(JSON.stringify({ signed: [item] })), gas: EXECUTE_GAS });
  const hash = base58Encode(createHash('sha256').update(Buffer.from(signed, 'base64').subarray(0, -65)).digest());
  const step = pending(nonce, hash);
  run.pending = step;
  await save(run, deposit);
  await simulate(run, item);
  run.log({ event: `${step.step}_sent`, hash, nonce, deadline: new Date(deadline).toISOString() });
  try { await deps.broadcast(signed); } catch { /* the nonce and the final receipts below say whether it landed */ }
}

async function settle(run: Run, hash: string, label: string, mustSucceed: string[]) {
  const outcomes = await Promise.all(run.providers.map(provider => finalTransaction(provider, hash, run.s.relayer).catch(() => null)));
  if (outcomes.some(tx => tx === null)) throw new TopupError('transaction_not_final', { hash });
  const [tx] = outcomes as FinalTransaction[];
  if (outcomes.some(other => outcomeOf(other!) !== outcomeOf(tx!))) throw new TopupError('rpc_disagreement', { hash });
  if (tx!.failed.length) throw new TopupError(`${label}_failed`, { hash, failed: tx!.failed });
  const missing = mustSucceed.filter(executor => !tx!.succeeded.includes(executor));
  if (missing.length) throw new TopupError(`${label}_not_delivered`, { hash, missing });
}

async function withdraw(run: Run, amount: bigint) {
  run.log({ event: 'withdraw_planned', amountYocto: String(amount) });
  const nativeBefore = String(await spendableNear(run));
  const deadline = run.now() + PAYLOAD_TTL_MS;
  await executeIntents(run, [{ intent: 'native_withdraw', receiver_id: run.s.relayer, amount: String(amount) }], deadline,
    (nonce, hash) => ({ step: 'withdraw', nonce, deadline, hash, amount: String(amount), nativeBefore }));
}

async function swapStatus(run: Run, p: SwapStep) {
  const raw = await run.deps.oneClick.status(p.depositAddress);
  const status = object(raw) && typeof raw.status === 'string' ? raw.status : null;
  run.log({ event: 'swap_status', depositAddress: p.depositAddress, status, amountIn: p.amountIn, minAmountOut: p.minAmountOut });
  return status;
}

async function swapSucceeded(run: Run, p: SwapStep) {
  // 1Click's word alone is not delivery: the wNEAR must be in the relayer's Intents account before the step moves on.
  const wnear = await intentsBalance(run, run.s.wnear);
  if (wnear < BigInt(p.minAmountOut)) throw new TopupError('swap_output_missing', { depositAddress: p.depositAddress, wnearYocto: String(wnear), minAmountOut: p.minAmountOut });
  run.swapOutcome = 'topped_up';
  await withdraw(run, wnear);
}

async function swapRefunded(run: Run, p: SwapStep, status: string) {
  const collateral = await intentsBalance(run, run.s.collateral);
  if (collateral < BigInt(p.collateralBefore)) throw new TopupError('swap_needs_operator', { status, reason: 'refund_missing',
    depositAddress: p.depositAddress, collateralUnits: String(collateral), collateralBefore: p.collateralBefore });
  run.swapOutcome = 'refunded';
  run.pending = null;
  await save(run);
}

async function advanceSwap(run: Run, p: SwapStep): Promise<Advance> {
  const status = await swapStatus(run, p);
  if (status === 'SUCCESS') { await swapSucceeded(run, p); return 'next'; }
  if (status === 'REFUNDED') { await swapRefunded(run, p, status); return 'next'; }
  if (status && WAITING.has(status)) return 'waiting';
  if (status && NEEDS_OPERATOR.has(status)) throw new TopupError('swap_needs_operator', { status, depositAddress: p.depositAddress });
  throw new TopupError('invalid_swap_status', { status });
}

async function expireUnspent(run: Run, p: DepositStep | WithdrawStep): Promise<Advance> {
  if (await chainTime(run) <= p.deadline + DEADLINE_GRACE_MS) return 'waiting';
  run.log({ event: `${p.step}_expired_unspent`, hash: p.hash, nonce: p.nonce });
  run.pending = null;
  await save(run);
  return 'next';
}

async function depositLanded(run: Run, p: DepositStep) {
  // intents.near spends the nonce in the same receipt that moves the tokens, so a spent nonce is the deposit, whoever's transaction carried it.
  run.log({ event: 'deposit_final', hash: p.hash, nonce: p.nonce, depositAddress: p.depositAddress, amountIn: p.amountIn });
  run.pending = { step: 'swap', depositAddress: p.depositAddress, amountIn: p.amountIn, minAmountOut: p.minAmountOut,
    collateralBefore: p.collateralBefore, depositHash: p.hash };
  await save(run);
}

/**
 * Our withdraw transaction failed, yet the nonce is spent: someone may have landed our signed payload first.
 * The spent nonce proves intents.near took the wNEAR, and native_withdraw pays only the receiver we signed, but the NEAR arrives in
 * later receipts that can still fail. So the proof is the relayer's balance, which must have risen by the amount less gas.
 */
async function withdrawnElsewhere(run: Run, p: WithdrawStep, error: unknown) {
  if (!(error instanceof TopupError) || error.code !== 'withdraw_failed') throw error;
  const amount = BigInt(p.amount), native = await spendableNear(run);
  const slack = WITHDRAW_GAS_SLACK_YOCTO < amount / 2n ? WITHDRAW_GAS_SLACK_YOCTO : amount / 2n;
  if (native - BigInt(p.nativeBefore) < amount - slack) throw error;
  run.log({ event: 'withdraw_landed_elsewhere', hash: p.hash, nonce: p.nonce, nativeBeforeYocto: p.nativeBefore, nativeYocto: String(native) });
}

async function withdrawLanded(run: Run, p: WithdrawStep) {
  // native_withdraw burns the wNEAR before unwrapping and never refunds it, so a failed receipt here needs a person.
  await settle(run, p.hash, 'withdraw', [run.s.verifier, run.wnearAccount]).catch((error: unknown) => withdrawnElsewhere(run, p, error));
  run.withdrawn += BigInt(p.amount);
  run.log({ event: 'withdraw_final', hash: p.hash, amountYocto: p.amount, nativeYocto: String(await spendableNear(run)) });
  run.pending = null;
  await save(run);
}

async function advanceSigned(run: Run, p: DepositStep | WithdrawStep): Promise<Advance> {
  if (!await nonceUsed(run, p.nonce)) return expireUnspent(run, p);
  if (p.step === 'deposit') await depositLanded(run, p);
  else await withdrawLanded(run, p);
  return 'next';
}

/** Moves the journalled step forward from what the chain and 1Click report. Never re-sends a signed payload. */
async function advance(run: Run): Promise<'clear' | 'waiting'> {
  while (run.pending) {
    const p = run.pending;
    const next = p.step === 'swap' ? await advanceSwap(run, p) : await advanceSigned(run, p);
    if (next === 'waiting') return 'waiting';
  }
  return 'clear';
}

/** Settles whatever is in flight and brings any wNEAR in the Intents account home as native NEAR. False while still waiting. */
async function drain(run: Run): Promise<boolean> {
  const until = run.now() + run.s.swapWaitMs;
  for (;;) {
    if (await advance(run) === 'clear') {
      const wnear = await intentsBalance(run, run.s.wnear);
      if (wnear < MIN_WITHDRAW_YOCTO) return true;
      if (run.s.mode === 'dry-run') { run.log({ event: 'would_withdraw', amountYocto: String(wnear) }); return true; }
      await withdraw(run, wnear);
      continue;
    }
    if (run.now() >= until) return false;
    await run.sleep(STATUS_POLL_MS);
  }
}

/** In execute mode the relayer's Intents key set must be exactly the treasury key, and the submit key must pass its checks. */
async function checkKeys(run: Run) {
  const { s } = run;
  if (s.mode !== 'execute') return;
  const publicKey = treasurySigner(s.treasuryKey!, s.relayer, s.verifier).publicKey;
  const keys = await view(run, run.deps.primary, 'public_keys_of', { account_id: s.relayer });
  if (!Array.isArray(keys) || !keys.includes(publicKey)) throw new TopupError('treasury_key_not_registered', { publicKey });
  if (keys.length !== 1) throw new TopupError('intents_key_set_unexpected', { keys });
  await submitKeyNonce(run);
}

async function checkCollateralDecimals(run: Run) {
  const metadata = await view(run, run.deps.primary, 'ft_metadata', {}, run.s.collateral.slice('nep141:'.length));
  if (!object(metadata) || metadata.decimals !== run.s.collateralDecimals)
    throw new TopupError('collateral_decimals_mismatch', { configured: run.s.collateralDecimals, onChain: object(metadata) ? metadata.decimals : null });
}

interface Funding { collateral: bigint; left: bigint }

/** The collateral and daily budget a deposit may use, or the result that ends the run because none is needed or allowed. */
async function fundingNeed(run: Run): Promise<TopupResult | Funding> {
  const { s } = run;
  const native = await spendableNear(run), collateral = await intentsBalance(run, s.collateral);
  run.log({ event: 'balances', nativeYocto: String(native), belowYocto: String(s.belowYocto), collateralUnits: String(collateral), minUnits: String(s.minUnits) });
  if (native >= s.belowYocto) return { state: run.swapOutcome ?? (run.withdrawn ? 'withdrawn' : 'healthy'), nativeYocto: String(native) };
  if (collateral < s.minUnits) return { state: 'insufficient_collateral', nativeYocto: String(native), collateralUnits: String(collateral) };
  const today = await run.deps.journal.depositedToday(), left = s.maxUnitsPerDay - today;
  if (left < s.minUnits) return { state: 'daily_cap_reached', depositedTodayUnits: String(today), maxUnitsPerDay: String(s.maxUnitsPerDay) };
  await checkCollateralDecimals(run);
  return { collateral, left };
}

async function freshQuote(run: Run, { collateral, left }: Funding) {
  const { s } = run;
  const amount = [collateral, s.maxUnits, left].reduce((low, value) => value < low ? value : low);
  const request: QuoteRequest = { dry: s.mode === 'dry-run', swapType: 'EXACT_INPUT', slippageTolerance: ONECLICK_SLIPPAGE_BPS, originAsset: s.collateral,
    depositType: 'INTENTS', destinationAsset: s.wnear, amount: String(amount), refundTo: s.relayer, refundType: 'INTENTS', recipient: s.relayer,
    recipientType: 'INTENTS', deadline: new Date(run.now() + QUOTE_TTL_MS).toISOString() };
  const quote = parseQuote(await run.deps.oneClick.quote(request), request, s, run.now());
  const median = await run.deps.nearUsd();
  const worst = usdPerNear(quote.amountIn, quote.minAmountOut, s.collateralDecimals), limit = median * (BPS + s.maxSlippageBps) / BPS;
  const priced = { amountIn: String(quote.amountIn), amountOutYocto: String(quote.amountOut), minAmountOutYocto: String(quote.minAmountOut),
    quotedUsdPerNear: String(worst), medianUsdPerNear: String(median), limitUsdPerNear: String(limit) };
  run.log({ event: 'quote', depositAddress: quote.depositAddress, ...priced });
  if (worst > limit) throw new TopupError('quote_price_refused', priced);
  return { quote, priced };
}

async function sendDeposit(run: Run, quote: Quote, collateral: bigint) {
  const deadline = Math.min(run.now() + PAYLOAD_TTL_MS, quote.deadline! - QUOTE_MARGIN_MS);
  const depositAddress = quote.depositAddress!, token = run.s.collateral;
  await executeIntents(run, [{ intent: 'transfer', receiver_id: depositAddress, tokens: { [token]: String(quote.amountIn) } }], deadline,
    (nonce, hash) => ({ step: 'deposit', nonce, deadline, hash, depositAddress, amountIn: String(quote.amountIn), minAmountOut: String(quote.minAmountOut),
      collateralBefore: String(collateral) }), quote.amountIn);
}

/** Quotes and sends a deposit when native NEAR is low and collateral and the daily cap allow, then follows it to the end. */
async function topUp(run: Run): Promise<TopupResult> {
  const need = await fundingNeed(run);
  if ('state' in need) return need;
  const { quote, priced } = await freshQuote(run, need);
  if (run.s.mode === 'dry-run') return { state: 'dry_run', ...priced };
  await sendDeposit(run, quote, need.collateral);
  if (!await drain(run)) return { state: 'waiting', step: run.pending!.step };
  return { state: run.swapOutcome ?? 'deposit_unspent', withdrawnYocto: String(run.withdrawn), nativeYocto: String(await spendableNear(run)) };
}

export async function runTopup(deps: TopupDeps): Promise<TopupResult> {
  const run = await startRun(deps);
  if (run.pending && run.s.mode === 'dry-run') return { state: 'journal_pending', step: run.pending.step };
  await checkKeys(run);
  if (!await drain(run)) return { state: 'waiting', step: run.pending!.step };
  return topUp(run);
}

async function readCapped(response: Response) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_ONECLICK_BYTES) throw new TopupError('oneclick_response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function oneClickClient(base = ONECLICK_URL, transport: typeof fetch = fetch): OneClick {
  const call = async (path: string, init: RequestInit) => {
    let response: Response;
    try {
      response = await transport(base + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(ONECLICK_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    } catch { throw new TopupError('oneclick_unavailable'); }
    const text = await readCapped(response);
    if (!response.ok) throw new TopupError('oneclick_refused', { status: response.status, message: text.slice(0, 200) });
    try { return JSON.parse(text) as unknown; } catch { throw new TopupError('oneclick_invalid_json'); }
  };
  return {
    quote: request => call('/v0/quote', { method: 'POST', body: JSON.stringify(request) }),
    status: depositAddress => call(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { method: 'GET' }),
  };
}

/** One top-up per relayer at a time, across hosts, held on one connection for the whole run like the keeper's lock. */
export async function withTopupLock<T>(pool: Pick<pg.Pool, 'connect'>, relayer: string, work: (client: pg.PoolClient) => Promise<T>,
  lost: () => void = () => process.exit(1)): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  const onError = () => { console.error('Relay top-up database lock connection lost'); lost(); };
  client.on('error', onError);
  try {
    locked = (await client.query(`SELECT pg_try_advisory_lock(${LOCK.relayTopup},hashtext($1)) AS locked`, [relayer])).rows[0]?.locked === true;
    if (!locked) throw new TopupError('topup_lock_held');
    return await work(client);
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock(${LOCK.relayTopup},hashtext($1))`, [relayer]).catch(() => {});
    client.off('error', onError);
    client.release();
  }
}

/** The journal row and the deposit record, written on the connection that holds the top-up lock. */
export function postgresJournal(client: Pick<pg.PoolClient, 'query'>, relayer: string): TopupJournal {
  return {
    async read() {
      const { rows } = await client.query('SELECT verifier, pending FROM relay_topup_journal WHERE relayer = $1', [relayer]);
      return rows[0] ? { verifier: rows[0].verifier as string, pending: rows[0].pending as unknown } : null;
    },
    async write(verifier, pending, deposit) {
      await client.query('BEGIN');
      try {
        const { rowCount } = await client.query(`INSERT INTO relay_topup_journal(relayer, verifier, pending) VALUES($1, $2, $3)
          ON CONFLICT (relayer) DO UPDATE SET pending = excluded.pending, updated_at = now() WHERE relay_topup_journal.verifier = excluded.verifier`,
        [relayer, verifier, JSON.stringify(pending)]);
        if (rowCount !== 1) throw new TopupError('topup_journal_scope_changed');
        if (deposit !== undefined) await client.query('INSERT INTO relay_topup_deposits(relayer, amount) VALUES($1, $2)', [relayer, String(deposit)]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    },
    async depositedToday() {
      const { rows } = await client.query(`SELECT coalesce(sum(amount), 0)::text AS total FROM relay_topup_deposits
        WHERE relayer = $1 AND sent_at > now() - interval '1 day'`, [relayer]);
      return BigInt(rows[0].total as string);
    },
  };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('The relay top-up accepts configuration through environment variables only');
  if (process.getuid?.() === 0) throw new Error('The relay top-up must run as a non-root user');
  const { RELAY_TREASURY_KEY: _treasury, RELAY_TOPUP_SUBMIT_KEY: _submit, RELAYER_ACCOUNT_ID: _relayer, ...shared } = process.env;
  const config = readConfig(shared);
  const settings = topupSettings(process.env, config);
  if (config.network !== 'mainnet') throw new Error('The relay top-up swaps through 1Click, which serves mainnet only');
  const rpc = relayRpc(config);
  const pool = createPool(config.databaseUrl, 1);
  const timeout = setTimeout(() => { console.error('Relay top-up exceeded its runtime limit'); process.exit(1); }, 600_000);
  timeout.unref();
  const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ service: 'relay-topup', mode: settings.mode, ...event }));
  try {
    const result = await withTopupLock(pool, settings.relayer, client => runTopup({
      settings, primary: rpc.primary, second: rpc.second, requireSecond: rpc.requireSecond, oneClick: oneClickClient(), nearUsd: exchangeNearUsd(),
      broadcast: signed => keeperRpc(rpc.sendUrl, 'send_tx', { signed_tx_base64: signed, wait_until: 'FINAL' }),
      journal: postgresJournal(client, settings.relayer), log,
    }));
    log({ event: 'result', ...result });
  } finally { clearTimeout(timeout); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof TopupError ? { code: error.code, ...error.details } : { code: 'failed', message: error instanceof Error ? error.message : 'unknown' };
    console.error(JSON.stringify({ service: 'relay-topup', event: 'failed', ...code }));
    process.exitCode = 1;
  });
}
