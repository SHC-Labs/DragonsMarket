import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { keeperRpc, setRpcCredentials, signedFunctionCall } from '@dragons-market/keeper';
import { finalTransaction, type FinalTransaction } from './agent-chain.js';
import { base58Decode, base58Encode } from './base58.js';
import type { Config } from './config.js';
import { createFeeQuoter, exchangeNearUsd, FeeAboveCeiling, rpcGasPrice, type FeeQuote, type FeeQuoter } from './relay-fee.js';
import { object } from './ingestion/block.js';
import { RpcError, ReadRpcClient } from './providers.js';
import { ReadError } from './read-api.js';
import { isUnits, isUint } from './validate.js';
import type { RelayJournal, RelayLease, RelayRecord } from './relay-journal.js';

const MAX_SIGNED = 2;
const MAX_PAYLOAD_CHARS = 2048;
const MIN_DEADLINE_MS = 60 * 1000;
// Life a payload must still have when its transaction is signed: inclusion, then the verifier receipt that checks the deadline.
const SEND_MARGIN_MS = 20 * 1000;
// send_tx waits for finality. Past this the outcome is read from the chain instead, so a stalled RPC cannot hold the queue.
const SEND_TIMEOUT_MS = 10 * 1000;
const MAX_DEADLINE_MS = 10 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 512;
const EXECUTE_GAS = 300n * 10n ** 12n;
const MAX_QUEUED = 8;
// Balance reads waiting on their own paced client, one a second. Past this the request is refused at once instead of waiting longer.
// Sized so the burst that clients inside their per-network budget can send is queued, not refused.
const MAX_BALANCE_READS = 16;
const SUSPEND_MS = 60 * 60 * 1000;
// Refunded actions still pay the fee, but they can hold the queue for others. This many in SUSPEND_MS pauses the signer.
const MAX_REFUNDS = 3;
const MAX_REMEMBERED = 10000;
const ALLOWANCE_LOG_MS = 10 * 60 * 1000;
const MAX_KEY_ALLOWANCE = 5n * 10n ** 24n;
const SIGNER_ADDRESS = { erc191: /^0x[0-9a-f]{40}$/, raw_ed25519: /^[0-9a-f]{64}$/ };
const NONCE_BYTES = 32;
const VERSIONED_NONCE = Buffer.from('5628f6c6', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const LONE_SURROGATE = /\p{Cs}/u;
const OUTCOMES = new Set(['yes', 'no', 'void']);
const SIDES = new Set(['yes', 'no']);

type Rpc = Pick<ReadRpcClient, 'call'>;
export interface RelayContext { verifier: string; collateral: string; market: string; oracle: string | null; relayer: string; minFee: bigint; maxFee: bigint }
/** `reads` serves the balance gate and the gas price on its own pacing, so neither waits behind simulation nor delays it. */
export interface RelayRpc { primary: Rpc; second: Rpc | null; reads: Rpc; sendUrl: string; requireSecond: boolean }
export type RelayHandler = (body: Record<string, unknown>, signerAllowed: (signer: string) => boolean) => Promise<{ hashes: string[] }>;
/** `keyAllowance` is the relay key's remaining allowance in yoctoNEAR as of the last read, null before one. */
export interface RelayStatus { keyAllowance: string | null; keyAllowanceLow: boolean }
export interface Relay { submit: RelayHandler; quote: () => Promise<FeeQuote>; status: () => RelayStatus;
  recover?: (body: Record<string, unknown>) => Promise<{ unused: boolean[] }> }
export interface SignedItem { standard: 'erc191' | 'raw_ed25519'; payload: string; signature: string; public_key?: string }
/** `fee` is what the relayer is paid, `spend` everything the payload moves out of the signer's verifier balance. */
export interface ValidItem { signer: string; nonce: string; deadline: number; to: string; fee: bigint; spend: bigint; item: SignedItem }

export class RelayError extends ReadError {
  public completed?: string[];
  constructor(status: number, code: string, public readonly index?: number, public readonly reason?: string, public readonly hash?: string) {
    super(status, code);
  }
}

const refuse = (code: string, index?: number): never => { throw new RelayError(400, code, index); };
const isAmount = (value: unknown): value is string => isUnits(value) && value !== '0';
const isMarketId = isUint;
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

function base58Bytes(prefix: string, value: unknown, length: number): Buffer | null {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
  try {
    const bytes = base58Decode(value.slice(prefix.length));
    return bytes.length === length ? bytes : null;
  } catch { return null; }
}

function evidenceOk(evidence: string) {
  return Buffer.byteLength(evidence) <= MAX_EVIDENCE_BYTES && !/[\x00-\x1f\x7f]/.test(evidence);
}

function marketActionAllowed(msg: string, parts: string[]): boolean {
  return msg === 'register'
    || (parts.length === 4 && parts[0] === 'buy' && isMarketId(parts[1]) && SIDES.has(parts[2]!) && isAmount(parts[3]));
}

export const RELAY_AUTH_GAS = '100000000000000';
function authenticatedAction(intent: Record<string, unknown>, context: RelayContext, index: number) {
  if (!onlyKeys(intent, ['intent', 'contract_id', 'msg', 'min_gas']) || intent.contract_id !== context.market
    || intent.min_gas !== RELAY_AUTH_GAS || typeof intent.msg !== 'string') return refuse('action_not_allowed', index);
  const parts = intent.msg.split(':');
  const allowed = (parts[0] === 'sell' && parts.length === 5 && isMarketId(parts[1]) && SIDES.has(parts[2]!)
      && isAmount(parts[3]) && isUnits(parts[4]))
    || (parts[0] === 'redeem' && parts.length === 2 && isMarketId(parts[1]))
    || (parts[0] === 'withdraw' && parts.length === 2 && isAmount(parts[1]));
  if (!allowed) return refuse('action_not_allowed', index);
  return { to: context.market, amount: 0n, msg: intent.msg };
}

function oracleActionAllowed(parts: string[], context: RelayContext): boolean {
  if (parts[1] !== context.market || !isMarketId(parts[2]) || !OUTCOMES.has(parts[3] ?? '')) return false;
  if (parts[0] === 'challenge') return parts.length === 4;
  return parts[0] === 'propose' && parts.length >= 5 && evidenceOk(parts.slice(4).join(':'));
}

function actionAllowed(to: string, msg: string, context: RelayContext): boolean {
  const parts = msg.split(':');
  if (to === context.market) return marketActionAllowed(msg, parts);
  return to === context.oracle && oracleActionAllowed(parts, context);
}

function collateralAmount(tokens: unknown, collateral: string): bigint | null {
  if (!object(tokens) || Object.keys(tokens).length !== 1) return null;
  const amount = tokens[collateral];
  return isAmount(amount) ? BigInt(amount) : null;
}

// No min_gas: serde drops the whole notification when it does not parse, and one the 300 TGas budget cannot cover fails after simulation.
function transfer(intent: unknown, context: RelayContext, index: number) {
  if (!object(intent) || intent.intent !== 'transfer' || !onlyKeys(intent, ['intent', 'receiver_id', 'tokens', 'msg'])) return refuse('invalid_intent', index);
  const amount = collateralAmount(intent.tokens, context.collateral);
  const { receiver_id: to, msg } = intent;
  if (typeof to !== 'string' || amount === null || (msg !== undefined && typeof msg !== 'string')) return refuse('invalid_transfer', index);
  return { to, amount, msg };
}

/** intents.near refuses a small-order key, under which a forged signature verifies for every message. */
function weakKey(publicKey: Buffer): boolean {
  try { return ed25519.Point.fromBytes(publicKey, true).isSmallOrder(); } catch { return false; }
}

/** What intents.near checks: ed25519 over the payload bytes, or an EIP-191 secp256k1 signature with low s that recovers to signer_id. */
function signedBy(payload: string, signature: Buffer, publicKey: Buffer | null, signer: string): boolean {
  const message = Buffer.from(payload);
  try {
    if (publicKey) return verify(null, message, { key: Buffer.concat([ED25519_SPKI, publicKey]), format: 'der', type: 'spki' }, signature);
    const parsed = secp256k1.Signature.fromBytes(signature.subarray(0, 64), 'compact');
    if (parsed.hasHighS()) return false;
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`), message]));
    const key = parsed.addRecoveryBit(signature[64]!).recoverPublicKey(digest).toBytes(false);
    return '0x' + Buffer.from(keccak_256(key.subarray(1)).subarray(12)).toString('hex') === signer;
  } catch { return false; }
}

type Standard = SignedItem['standard'];
const ITEM_KEYS: Record<Standard, string[]> = { erc191: ['standard', 'payload', 'signature'], raw_ed25519: ['standard', 'payload', 'signature', 'public_key'] };

function readItem(input: unknown, index: number): { raw: Record<string, unknown>; standard: Standard; payload: string } {
  if (!object(input)) return refuse('invalid_item', index);
  const standard = input.standard;
  if (standard !== 'erc191' && standard !== 'raw_ed25519') return refuse('unsupported_standard', index);
  if (!onlyKeys(input, ITEM_KEYS[standard])) return refuse('invalid_item', index);
  const { payload } = input;
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_CHARS) return refuse('invalid_payload', index);
  return { raw: input, standard, payload };
}

function readSignature(standard: Standard, value: unknown, index: number): Buffer {
  const signature = standard === 'erc191' ? base58Bytes('secp256k1:', value, 65) : base58Bytes('ed25519:', value, 64);
  if (!signature || (standard === 'erc191' && signature[64]! > 1)) return refuse('invalid_signature', index);
  return signature;
}

function readPublicKey(standard: Standard, value: unknown, index: number): Buffer | null {
  if (standard !== 'raw_ed25519') return null;
  const publicKey = base58Bytes('ed25519:', value, 32);
  if (!publicKey || weakKey(publicKey)) return refuse('invalid_public_key', index);
  return publicKey;
}

function parsePayload(payload: string, index: number): Record<string, unknown> {
  let parsed: unknown;
  // serde_json refuses a lone surrogate escape, which JSON.parse reads and JSON.stringify writes back unchanged.
  const reviver = (_key: string, value: unknown) => (typeof value === 'string' && LONE_SURROGATE.test(value) ? refuse('invalid_payload', index) : value);
  try { parsed = JSON.parse(payload, reviver); } catch { return refuse('invalid_payload', index); }
  // One byte form per meaning: no duplicate keys, escapes or stray whitespace on which serde and JSON.parse could disagree.
  if (JSON.stringify(parsed) !== payload) return refuse('invalid_payload', index);
  if (!object(parsed) || !onlyKeys(parsed, ['signer_id', 'verifying_contract', 'deadline', 'nonce', 'intents'])) return refuse('invalid_payload', index);
  return parsed;
}

function readDeadline(parsed: Record<string, unknown>, now: number, index: number, recovery = false): number {
  const deadline = typeof parsed.deadline === 'string' ? Date.parse(parsed.deadline) : NaN;
  if (!(deadline >= (recovery ? 0 : now + MIN_DEADLINE_MS) && deadline <= now + MAX_DEADLINE_MS) || new Date(deadline).toISOString() !== parsed.deadline) {
    return refuse('invalid_deadline', index);
  }
  return deadline;
}

function readNonce(parsed: Record<string, unknown>, index: number): string {
  const nonce = typeof parsed.nonce === 'string' ? Buffer.from(parsed.nonce, 'base64') : null;
  if (!nonce || nonce.length !== NONCE_BYTES || nonce.toString('base64') !== parsed.nonce || nonce.subarray(0, 4).equals(VERSIONED_NONCE)) {
    return refuse('invalid_nonce', index);
  }
  return parsed.nonce as string;
}

function readSigner(parsed: Record<string, unknown>, standard: Standard, publicKey: Buffer | null, index: number): string {
  const signer = parsed.signer_id;
  if (typeof signer !== 'string' || !SIGNER_ADDRESS[standard].test(signer)) return refuse('invalid_signer', index);
  if (publicKey && publicKey.toString('hex') !== signer) return refuse('signer_key_mismatch', index);
  return signer;
}

/** The one fee transfer to the relayer and the one action transfer, from the two intents of a payload. */
function readTransfers(intents: unknown, context: RelayContext, index: number) {
  if (!Array.isArray(intents) || intents.length !== 2) return refuse('invalid_intents', index);
  const fees = intents.filter(intent => object(intent) && intent.intent === 'transfer' && intent.receiver_id === context.relayer);
  if (fees.length !== 1) return refuse('invalid_fee', index);
  const fee = transfer(fees[0], context, index);
  if (fee.msg !== undefined || fee.amount < context.minFee || fee.amount > context.maxFee) return refuse('invalid_fee', index);
  const raw = intents.find(intent => intent !== fees[0]);
  const auth = object(raw) && raw.intent === 'auth_call';
  const action = auth ? authenticatedAction(raw, context, index) : transfer(raw, context, index);
  if (!auth && (action.msg === undefined || !actionAllowed(action.to, action.msg, context))) return refuse('action_not_allowed', index);
  return { fee, action };
}

/** Checks one signed item against everything the relayer is willing to pay for, signature included. */
export function validateItem(input: unknown, context: RelayContext, now: number, index: number, recovery = false): ValidItem {
  const { raw, standard, payload } = readItem(input, index);
  const signature = readSignature(standard, raw.signature, index);
  const publicKey = readPublicKey(standard, raw.public_key, index);
  const parsed = parsePayload(payload, index);
  if (parsed.verifying_contract !== context.verifier) return refuse('wrong_verifier', index);
  const deadline = readDeadline(parsed, now, index, recovery);
  const nonce = readNonce(parsed, index);
  const signer = readSigner(parsed, standard, publicKey, index);
  const { fee, action } = readTransfers(parsed.intents, context, index);
  if (!signedBy(payload, signature, publicKey, signer)) return refuse('invalid_signature', index);
  return { signer, nonce, deadline, to: action.to, fee: fee.amount, spend: fee.amount + action.amount, item: raw as unknown as SignedItem };
}

/** The whole request, or nothing. All items must come from one signer. */
export function validateRelay(body: Record<string, unknown>, context: RelayContext, now: number, recovery = false): ValidItem[] {
  if (!onlyKeys(body, ['signed']) || !Array.isArray(body.signed) || body.signed.length < 1 || body.signed.length > MAX_SIGNED) return refuse('invalid_request');
  const items = body.signed.map((raw: unknown, index) => validateItem(raw, context, now, index, recovery));
  if (items.some(entry => entry.signer !== items[0]!.signer)) return refuse('mixed_signers');
  if (new Set(items.map(entry => entry.nonce)).size !== items.length) return refuse('duplicate_item');
  return items;
}

/** An `ed25519:` secret key with its public half checked against the seed. `name` is the setting it came from. */
export function ed25519Key(key: string, name: string) {
  const raw = base58Decode(key.slice(8));
  const seed = raw.subarray(0, 32), publicKey = raw.subarray(32);
  const derived = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }))
    .export({ type: 'spki', format: 'der' }).subarray(-32);
  if (!derived.equals(publicKey)) throw new Error(`${name} public half does not match its secret`);
  return { seed, publicKey, publicKeyText: `ed25519:${base58Encode(publicKey)}` };
}

/** The access key's nonce, or null unless it is a FunctionCall key that can call only the verifier's execute_intents. */
export function executeIntentsKeyNonce(access: unknown, verifier: string): bigint | null {
  const permission = functionCallPermission(access);
  if (!object(access) || typeof access.nonce !== 'number' || !Number.isSafeInteger(access.nonce) || access.nonce < 0
    || !permission || permission.receiver_id !== verifier || !onlyExecuteIntents(permission.method_names)) return null;
  return BigInt(access.nonce);
}

/** The key's remaining allowance, or null when it has none set (unlimited) or is not a FunctionCall key. */
export function keyAllowance(access: unknown): bigint | null {
  const allowance = functionCallPermission(access)?.allowance;
  return isUnits(allowance) ? BigInt(allowance) : null;
}

const functionCallPermission = (access: unknown) => (object(access) && object(access.permission) && object(access.permission.FunctionCall) ? access.permission.FunctionCall : null);

const onlyExecuteIntents = (methods: unknown) => Array.isArray(methods) && methods.length === 1 && methods[0] === 'execute_intents';

export function relayRpc(config: Config): RelayRpc {
  const { primaryUrl, primaryBearerToken, secondUrl, secondBearerToken } = config.rpc;
  if (primaryBearerToken) setRpcCredentials([[primaryUrl, primaryBearerToken]]);
  return {
    primary: new ReadRpcClient(primaryUrl, config.rpc, primaryBearerToken),
    second: secondUrl ? new ReadRpcClient(secondUrl, config.rpc, secondBearerToken) : null,
    reads: new ReadRpcClient(primaryUrl, config.rpc, primaryBearerToken),
    sendUrl: primaryUrl, requireSecond: config.network === 'mainnet',
  };
}

export function relayContext(config: Config): RelayContext | null {
  const { relay, deployment } = config;
  if (!relay || !deployment) return null;
  return { verifier: deployment.contracts.verifier!, collateral: deployment.collateralTokenId, market: deployment.contracts.market!,
    oracle: deployment.contracts.oracle ?? null, relayer: relay.accountId, minFee: relay.minFee, maxFee: relay.maxFee };
}

function remember<T>(map: Map<string, T>, key: string, value: T) {
  if (map.size >= MAX_REMEMBERED && !map.has(key)) map.delete(map.keys().next().value!);
  map.set(key, value);
}

const outcomeOf = (tx: FinalTransaction) => JSON.stringify(tx);
const priced = <T>(quote: Promise<T>) => quote.catch((error: unknown) => {
  throw error instanceof FeeAboveCeiling ? new RelayError(503, 'fee_unavailable') : error;
});
const payloadKey = (entry: ValidItem) => createHash('sha256').update(entry.item.payload).digest('base64');
const AMBIGUOUS = new Set(['transaction_not_final', 'rpc_disagreement']);

/** Recovery retains the original outer transaction bytes, including its nonce. */
type Sent = RelayRecord;


type Fail = (status: number, code: string) => never;
type Fresh = { entry: ValidItem; index: number }[];

/** Local admission limits; signing coordination and transaction identity live in PostgreSQL. */
interface RelayState {
  sent: Map<string, Sent>;
  suspended: Map<string, number>;
  refunds: Map<string, number[]>;
  // Signers with a request between its balance read and its answer. One each, so no signer holds more than one read or queue slot.
  busy: Set<string>;
  lastNonce: bigint | null;
  allowance: bigint | null;
  allowanceLoggedAt: number;
  queued: number;
  balanceReads: number;
  tail: Promise<unknown>;
}

interface RelayEnv { context: RelayContext; rpc: RelayRpc; key: ReturnType<typeof ed25519Key>; quoter: FeeQuoter; state: RelayState; allowanceAlert: bigint; lease?: RelayLease; journal?: RelayJournal; scope: string }

const newState = (): RelayState => ({
  sent: new Map(), suspended: new Map(), refunds: new Map(), busy: new Set(), lastNonce: null, allowance: null, allowanceLoggedAt: 0, queued: 0, balanceReads: 0, tail: Promise.resolve(),
});

async function verifierBalance({ context, rpc, state }: RelayEnv, signer: string): Promise<bigint> {
  if (state.balanceReads >= MAX_BALANCE_READS) throw new RelayError(503, 'relay_busy');
  state.balanceReads++;
  let result: unknown;
  try {
    result = await rpc.reads.call('query', { request_type: 'call_function', finality: 'optimistic', account_id: context.verifier, method_name: 'mt_balance_of',
      args_base64: Buffer.from(JSON.stringify({ account_id: signer, token_id: context.collateral })).toString('base64') });
  } catch {
    throw new RelayError(503, 'rpc_unavailable');
  } finally { state.balanceReads--; }
  let balance: unknown = null;
  try { balance = object(result) && Array.isArray(result.result) ? JSON.parse(Buffer.from(result.result as number[]).toString()) : null; } catch { /* checked below */ }
  if (!isUnits(balance)) throw new RelayError(503, 'rpc_unavailable');
  return BigInt(balance);
}

async function simulateOn(verifier: string, provider: Rpc, args_base64: string, index: number) {
  let result: unknown;
  try {
    result = await provider.call('query', { request_type: 'call_function', finality: 'optimistic', account_id: verifier, method_name: 'simulate_intents', args_base64 });
  } catch (error) {
    if (error instanceof RpcError && error.causeName === 'CONTRACT_EXECUTION_ERROR') throw new RelayError(422, 'simulation_failed', index);
    throw new RelayError(503, 'rpc_unavailable', index);
  }
  if (object(result) && typeof result.error === 'string') throw new RelayError(422, 'simulation_failed', index, result.error.slice(0, 200));
  const output = viewJson(result);
  if (!object(output)) throw new RelayError(503, 'rpc_unavailable', index);
  if (Object.hasOwn(output, 'invariant_violated')) throw new RelayError(422, 'simulation_failed', index);
}

function viewJson(result: unknown): unknown {
  if (!object(result) || !Array.isArray(result.result) || result.result.length > 65536
    || !result.result.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return undefined;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(result.result))); }
  catch { return undefined; }
}

async function simulate({ context, rpc }: RelayEnv, item: SignedItem, index: number) {
  const providers = [rpc.primary, ...(rpc.second ? [rpc.second] : [])];
  if (rpc.requireSecond && !rpc.second) throw new RelayError(503, 'second_rpc_required');
  const args_base64 = Buffer.from(JSON.stringify({ signed: [item] })).toString('base64');
  await Promise.all(providers.map(provider => simulateOn(context.verifier, provider, args_base64, index)));
}

function noteAllowance({ context, state, allowanceAlert }: RelayEnv, access: unknown) {
  const allowance = keyAllowance(access);
  state.allowance = allowance;
  const now = Date.now();
  if (allowance === null || allowance >= allowanceAlert || now - state.allowanceLoggedAt < ALLOWANCE_LOG_MS) return;
  state.allowanceLoggedAt = now;
  console.error(JSON.stringify({ service: 'relay', error: 'relay_key_allowance_low', relayer: context.relayer, allowance: allowance.toString(), alertBelow: allowanceAlert.toString() }));
}

async function chainNonce(env: RelayEnv, index: number): Promise<bigint> {
  const { context, rpc, key } = env;
  if (rpc.requireSecond && !rpc.second) throw new RelayError(503, 'second_rpc_required', index);
  let access: unknown;
  try {
    access = await rpc.primary.call('query', { request_type: 'view_access_key', finality: 'final', account_id: context.relayer, public_key: key.publicKeyText });
  } catch (error) {
    throw new RelayError(503, error instanceof RpcError && error.causeName === 'UNKNOWN_ACCESS_KEY' ? 'relay_key_invalid' : 'rpc_unavailable', index);
  }
  const nonce = executeIntentsKeyNonce(access, context.verifier);
  if (nonce === null) throw new RelayError(503, 'relay_key_invalid', index);
  const allowance = keyAllowance(access);
  if (rpc.requireSecond && (allowance === null || allowance > MAX_KEY_ALLOWANCE)) throw new RelayError(503, 'relay_key_invalid', index);
  if (rpc.second) {
    if (!object(access) || typeof access.block_hash !== 'string') throw new RelayError(503, 'rpc_unavailable', index);
    const second = await rpc.second.call('query', { request_type: 'view_access_key', block_id: access.block_hash,
      account_id: context.relayer, public_key: key.publicKeyText }).catch(() => { throw new RelayError(503, 'rpc_unavailable', index); });
    if (!object(second) || second.block_hash !== access.block_hash || executeIntentsKeyNonce(second, context.verifier) !== nonce
      || keyAllowance(second) !== allowance) throw new RelayError(503, 'rpc_disagreement', index);
  }
  noteAllowance(env, access);
  return nonce;
}

function refunded({ state }: RelayEnv, signer: string) {
  const now = Date.now();
  const recent = [...(state.refunds.get(signer) ?? []).filter(at => at > now - SUSPEND_MS), now];
  remember(state.refunds, signer, recent);
  if (recent.length >= MAX_REFUNDS) remember(state.suspended, signer, now + SUSPEND_MS);
}

async function outraced(env: RelayEnv, record: Sent, index: number): Promise<never> {
  const notFinal = new RelayError(502, 'transaction_not_final', index, undefined, record.hash);
  const unknown = await env.rpc.primary.call('EXPERIMENTAL_tx_status', { tx_hash: record.hash, sender_account_id: env.context.relayer, wait_until: 'NONE' })
    .then(() => false, (error: unknown) => error instanceof RpcError && error.causeName === 'UNKNOWN_TRANSACTION');
  if (!unknown) throw notFinal;
  // Absence from one RPC is not evidence that a transaction cannot still land.
  // Keep both its bytes and nonce reserved for recovery.
  throw new RelayError(503, 'transaction_dropped', index, undefined, record.hash);
}

function checkOutcome(env: RelayEnv, tx: FinalTransaction, entry: ValidItem, fail: Fail) {
  const { context, state } = env;
  const call = tx.calls[0];
  if (tx.receiver !== context.verifier || tx.calls.length !== 1 || call?.method !== 'execute_intents' || call.deposit !== '0'
    || !object(call.args) || !Array.isArray(call.args.signed) || call.args.signed.length !== 1
    || !object(call.args.signed[0]) || call.args.signed[0].payload !== entry.item.payload
    || call.args.signed[0].standard !== entry.item.standard) fail(502, 'rpc_disagreement');
  if (tx.failed.some(executor => executor !== context.market && executor !== context.oracle)) {
    // Past the deadline the failure may be our own lateness, which is no reason to pause the signer.
    if (Date.now() >= entry.deadline) fail(422, 'invalid_deadline');
    remember(state.suspended, entry.signer, Date.now() + SUSPEND_MS);
    fail(422, 'execution_failed');
  }
  if (tx.failed.length) {
    refunded(env, entry.signer);
    fail(422, 'transfer_refunded');
  }
  if (!tx.succeeded.includes(entry.to)) fail(502, 'action_not_delivered');
}

async function settle(env: RelayEnv, entry: ValidItem, record: Sent, index: number): Promise<string> {
  const { context, rpc } = env;
  const fail: Fail = (status, code) => {
    const error = new RelayError(status, code, index, undefined, record.hash);
    if (!AMBIGUOUS.has(code)) Object.assign(record, { settled: true, error });
    throw error;
  };
  const final = (provider: Rpc) => finalTransaction(provider, record.hash, context.relayer).catch(() => fail(502, 'transaction_not_final'));
  const tx = await finalTransaction(rpc.primary, record.hash, context.relayer).catch(() => outraced(env, record, index));
  if (rpc.second && outcomeOf(await final(rpc.second)) !== outcomeOf(tx)) fail(502, 'rpc_disagreement');
  checkOutcome(env, tx, entry, fail);
  record.settled = true;
  return record.hash;
}

/** The chain's access-key nonce and the latest block, read together. */
async function readChain(env: RelayEnv, index: number) {
  return Promise.all([chainNonce(env, index), env.rpc.primary.call('block', { finality: 'optimistic' })]).catch(error => {
    throw error instanceof RelayError ? error : new RelayError(503, 'rpc_unavailable', index);
  });
}

function blockHashOf(block: unknown, index: number): string {
  const hash = object(block) && object(block.header) ? block.header.hash : null;
  if (typeof hash !== 'string') throw new RelayError(503, 'rpc_unavailable', index);
  return hash;
}

async function execute(env: RelayEnv, entry: ValidItem, index: number): Promise<string> {
  const { context, rpc, key, state } = env;
  const [current, block] = await readChain(env, index);
  if (state.lastNonce !== null && current > state.lastNonce) {
    throw new RelayError(503, 'relay_key_shared', index);
  }
  const blockHash = blockHashOf(block, index);
  if (entry.deadline - Date.now() < SEND_MARGIN_MS) throw new RelayError(422, 'invalid_deadline', index);
  const nonce = (state.lastNonce !== null && state.lastNonce > current ? state.lastNonce : current) + 1n;
  const signed = signedFunctionCall({ signer: context.relayer, seed: key.seed, publicKey: key.publicKey, nonce, receiver: context.verifier,
    blockHash: base58Decode(blockHash), method: 'execute_intents', args: Buffer.from(JSON.stringify({ signed: [entry.item] })), gas: EXECUTE_GAS });
  const record: Sent = { until: entry.deadline, hash: base58Encode(createHash('sha256').update(Buffer.from(signed, 'base64').subarray(0, -65)).digest()), nonce, signed, error: null, settled: false };
  await env.lease?.save(payloadKey(entry), record);
  state.lastNonce = nonce;
  remember(state.sent, payloadKey(entry), record);
  env.lease?.assertOwned();
  await simulate(env, entry.item, index);
  env.lease?.assertOwned();
  if (entry.deadline - Date.now() < SEND_MARGIN_MS) throw new RelayError(422, 'invalid_deadline', index, undefined, record.hash);
  // Whether it landed is read from the final status below, whatever send_tx answers or however long it takes.
  await Promise.race([keeperRpc(rpc.sendUrl, 'send_tx', { signed_tx_base64: signed, wait_until: 'FINAL' }).catch(() => {}), sleep(SEND_TIMEOUT_MS, undefined, { ref: false })]);
  return settleRecorded(env, entry, record, index);
}

async function settleRecorded(env: RelayEnv, entry: ValidItem, record: Sent, index: number) {
  try { return await settle(env, entry, record, index); }
  finally { await env.lease?.save(payloadKey(entry), record); }
}

async function replay(env: RelayEnv, entry: ValidItem, record: Sent, index: number): Promise<string> {
  if (!record.settled) {
    try { return await settleRecorded(env, entry, record, index); }
    catch (error) { if (record.settled) throw error; }
    if (entry.deadline - Date.now() >= SEND_MARGIN_MS) {
      env.lease?.assertOwned();
      await Promise.race([keeperRpc(env.rpc.sendUrl, 'send_tx', { signed_tx_base64: record.signed, wait_until: 'FINAL' }).catch(() => {}), sleep(SEND_TIMEOUT_MS, undefined, { ref: false })]);
    }
    return settleRecorded(env, entry, record, index);
  }
  if (record.error) throw new RelayError(record.error.status, record.error.code, index, record.error.reason, record.hash);
  return record.hash;
}

function recorded({ state }: RelayEnv, entry: ValidItem) {
  const record = state.sent.get(payloadKey(entry));
  return record ?? null;
}

async function expiredUnused(env: RelayEnv, entry: ValidItem): Promise<boolean> {
  if (Date.now() < entry.deadline + 120000 || (env.rpc.requireSecond && !env.rpc.second)) return false;
  const providers = [env.rpc.primary, ...(env.rpc.second ? [env.rpc.second] : [])];
  const answers = await Promise.all(providers.map(async provider => {
    const block = await provider.call('block', { finality: 'final' });
    if (!object(block) || !object(block.header) || typeof block.header.timestamp_nanosec !== 'string'
      || !/^(0|[1-9]\d{0,19})$/.test(block.header.timestamp_nanosec) || typeof block.header.hash !== 'string'
      || block.header.hash.length > 44 || !base58Bytes('', block.header.hash, 32)
      || BigInt(block.header.timestamp_nanosec) < BigInt(entry.deadline + 120000) * 1000000n) return false;
    const response = await provider.call('query', { request_type: 'call_function', block_id: block.header.hash,
      account_id: env.context.verifier, method_name: 'is_nonce_used',
      args_base64: Buffer.from(JSON.stringify({ account_id: entry.signer, nonce: entry.nonce })).toString('base64') });
    return object(response) && response.block_hash === block.header.hash && viewJson(response) === false;
  }));
  return answers.every(Boolean);
}

async function run(env: RelayEnv, items: ValidItem[]) {
  const hashes: string[] = [];
  try {
    for (const [index, entry] of items.entries()) {
      const record = recorded(env, entry);
      if (record) { hashes.push(await replay(env, entry, record, index)); continue; }
      hashes.push(await execute(env, entry, index));
    }
  } catch (error) {
    if (error instanceof RelayError && hashes.length) error.completed = hashes;
    throw error;
  }
  return { hashes };
}

async function checkFee(env: RelayEnv, fresh: Fresh) {
  if (!fresh.length) return;
  const accepted = await priced(env.quoter.accepted());
  const short = fresh.find(({ entry }) => entry.fee < accepted);
  if (short) throw new RelayError(422, 'fee_too_low', short.index, accepted.toString());
}

/** The request's turn in the queue, once the signer is known to be able to pay for the payloads that are new. */
async function enqueue(env: RelayEnv, items: ValidItem[], fresh: Fresh) {
  const { state } = env;
  const spend = fresh.reduce((sum, { entry }) => sum + entry.spend, 0n);
  if (fresh.length && await verifierBalance(env, items[0]!.signer) < spend) throw new RelayError(422, 'insufficient_balance');
  if (state.queued >= MAX_QUEUED) throw new RelayError(503, 'relay_busy');
  state.queued++;
  const result = state.tail.then(() => env.journal ? env.journal.withKey(env.scope, items.map(payloadKey), async lease => {
    env.lease = lease;
    for (const [key, record] of lease.records) remember(state.sent, key, record);
    state.lastNonce = lease.lastNonce;
    try { return await run(env, items); }
    finally { delete env.lease; }
  }) : run(env, items));
  state.tail = result.catch(() => {});
  try { return await result; } finally { state.queued--; }
}

async function submitRelay(env: RelayEnv, body: Record<string, unknown>, signerAllowed: (signer: string) => boolean) {
  const { context, state } = env;
  const items = validateRelay(body, context, Date.now(), true);
  const signer = items[0]!.signer;
  if (!env.journal && items.every(entry => recorded(env, entry)?.settled)) return run(env, items);
  if ((state.suspended.get(signer) ?? 0) > Date.now()) throw new RelayError(403, 'signer_suspended');
  // A payload already sent was priced and funded when it went out; a retry of it is not charged again.
  const fresh = items.map((entry, index) => ({ entry, index })).filter(({ entry }) => !recorded(env, entry));
  const expired = fresh.find(({ entry }) => entry.deadline < Date.now() + MIN_DEADLINE_MS);
  if (expired) throw new RelayError(422, 'invalid_deadline', expired.index);
  await checkFee(env, fresh);
  if (!signerAllowed(signer)) throw new RelayError(429, 'signer_rate_limited');
  if (state.busy.has(signer)) throw new RelayError(503, 'relay_busy');
  state.busy.add(signer);
  try {
    return await enqueue(env, items, fresh);
  } finally {
    state.busy.delete(signer);
  }
}

/** Production signing uses a PostgreSQL lease and a durable nonce cursor. */
export function createRelay(config: Config, rpc: RelayRpc = relayRpc(config), fees?: FeeQuoter, journal?: RelayJournal): Relay | null {
  const context = relayContext(config);
  if (!context || !config.relay || !config.deployment) return null;
  if (config.network !== 'sandbox' && !journal) throw new Error('A durable relay journal is required');
  const key = ed25519Key(config.relay.key, 'RELAYER_KEY');
  const quoter = fees ?? createFeeQuoter({ minFee: config.relay.minFee, maxFee: config.relay.maxFee, swapCostBps: config.relay.swapCostBps, decimals: config.deployment.collateralDecimals },
    { nearUsd: exchangeNearUsd(), gasPrice: rpcGasPrice(rpc.reads, ...(rpc.second ? [rpc.second] : [])) });
  const scope = `${config.network}:${context.verifier}:${context.relayer}:${key.publicKeyText}`;
  const env: RelayEnv = { context, rpc, key, quoter, state: newState(), allowanceAlert: config.relay.keyAllowanceAlert,
    scope, ...(journal ? { journal } : {}) };
  const status = () => ({ keyAllowance: env.state.allowance?.toString() ?? null, keyAllowanceLow: env.state.allowance !== null && env.state.allowance < env.allowanceAlert });
  const submit: RelayHandler = async (body, signerAllowed) => {
    if (!journal) return submitRelay(env, body, signerAllowed);
    const items = validateRelay(body, context, Date.now(), true);
    for (const [key, record] of await journal.read(scope, items.map(payloadKey))) remember(env.state.sent, key, record);
    return submitRelay(env, body, signerAllowed);
  };
  const recover = async (body: Record<string, unknown>) => {
    const items = validateRelay(body, context, Date.now(), true);
    return { unused: await Promise.all(items.map(entry => expiredUnused(env, entry))) };
  };
  return { submit, quote: () => priced(quoter.quote()), status, recover };
}
