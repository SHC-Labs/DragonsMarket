import { createHash } from 'node:crypto';
import type { Config, ContractRole } from '../config.js';

export const MAX_BLOCK_BYTES = 8 * 1024 * 1024;
export type Deployment = NonNullable<Config['deployment']>;
export class IngestionError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export interface Header { height: string; hash: string; prev_hash: string; timestamp_nanosec: string }
export interface Receipt { receipt_id: string; receiver_id: string; status: Record<string, unknown>; logs: string[]; transaction_hash?: string; child_receipt_ids?: string[] }
export interface FinalizedBlock { network: Config['network']; finalized: true; header: Header; receipts: Receipt[] }
export interface EventRow { receiptId: string; receiverId: string; logIndex: number; dataIndex: number; standard: string; version: string; event: string; rawLog: string; payload: unknown }
export interface PreparedBlock { block: FinalizedBlock; events: EventRow[]; digest: string }

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error('Unsafe number');
      return value;
    });
  } catch { throw new IngestionError('invalid_json_or_unsafe_number'); }
}
function uint(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 20 && BigInt(value) <= 18446744073709551615n;
}
function hash(value: unknown): value is string { return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value); }
function account(value: unknown): value is string { return typeof value === 'string' && value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value); }
function successful(status: Record<string, unknown>) { return Object.hasOwn(status, 'SuccessValue') || Object.hasOwn(status, 'SuccessReceiptId'); }

export function prepareBlock(input: unknown, config: Config): PreparedBlock {
  const d = config.deployment;
  if (!d) throw new IngestionError('deployment_required');
  if (!object(input) || input.network !== config.network) throw new IngestionError('network_mismatch');
  if (input.finalized !== true) throw new IngestionError('finalized_block_required');
  const h = input.header;
  if (!object(h) || !uint(h.height) || !uint(h.timestamp_nanosec) || !hash(h.hash) || !hash(h.prev_hash)) throw new IngestionError('invalid_header');
  if (!Array.isArray(input.receipts) || input.receipts.length > 10000) throw new IngestionError('invalid_receipts');
  const standards = new Map<string, string>();
  for (const role of ['market', 'rounds', 'oracle', 'council'] as const satisfies readonly ContractRole[]) {
    const receiver = d.contracts[role];
    if (receiver) {
      if (standards.has(receiver)) throw new IngestionError('ambiguous_contract_roles');
      standards.set(receiver, role);
    }
  }
  const seen = new Set<string>();
  const receipts: Receipt[] = [];
  const events: EventRow[] = [];
  for (const raw of input.receipts) {
    if (!object(raw) || !hash(raw.receipt_id) || !account(raw.receiver_id) || !object(raw.status) || !Array.isArray(raw.logs) || raw.logs.length > 1024 || raw.logs.some(log => typeof log !== 'string' || Buffer.byteLength(log) > 65536)) throw new IngestionError('invalid_receipt');
    if (seen.has(raw.receipt_id)) throw new IngestionError('duplicate_receipt');
    seen.add(raw.receipt_id);
    const status = raw.status;
    if (Object.keys(status).length !== 1 || !(typeof status.SuccessValue === 'string' || hash(status.SuccessReceiptId) || object(status.Failure))) throw new IngestionError('incomplete_receipt_outcome');
    const standard = standards.get(raw.receiver_id);
    if (!standard && raw.receiver_id !== d.contracts.verifier) continue;
    if (raw.transaction_hash !== undefined && !hash(raw.transaction_hash)) throw new IngestionError('invalid_transaction_hash');
    if (raw.child_receipt_ids !== undefined && (!Array.isArray(raw.child_receipt_ids) || raw.child_receipt_ids.length > 10000 || raw.child_receipt_ids.some(id => !hash(id)))) throw new IngestionError('invalid_receipt_links');
    const receipt: Receipt = { receipt_id: raw.receipt_id, receiver_id: raw.receiver_id, status, logs: raw.logs as string[] };
    if (typeof raw.transaction_hash === 'string') receipt.transaction_hash = raw.transaction_hash;
    if (Array.isArray(raw.child_receipt_ids)) receipt.child_receipt_ids = raw.child_receipt_ids as string[];
    receipts.push(receipt);
    // Verifier receipts are evidence only until its NEP-245 projection is reviewed.
    if (!standard || !successful(status)) continue;
    for (const [logIndex, log] of receipt.logs.entries()) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      const data = parseJson(log.slice('EVENT_JSON:'.length));
      if (!object(data) || typeof data.standard !== 'string' || typeof data.version !== 'string' || typeof data.event !== 'string' || !data.event.length || data.event.length > 128) throw new IngestionError('invalid_event');
      if (data.standard !== standard) continue;
      if (data.version !== '1.0.0') throw new IngestionError('unsupported_event_version');
      const items = Array.isArray(data.data) && data.data.length ? data.data : [data.data ?? null];
      if (items.length > 10000 || events.length + items.length > 50000) throw new IngestionError('too_many_events');
      items.forEach((payload, dataIndex) => events.push({ receiptId: receipt.receipt_id, receiverId: receipt.receiver_id, logIndex, dataIndex, standard, version: data.version as string, event: data.event as string, rawLog: log, payload }));
    }
  }
  // Receipt order is not execution ordering across shards. Normalize it for replay comparisons.
  receipts.sort((a, b) => a.receipt_id.localeCompare(b.receipt_id));
  const block: FinalizedBlock = { network: config.network, finalized: true, header: { height: h.height, hash: h.hash, prev_hash: h.prev_hash, timestamp_nanosec: h.timestamp_nanosec }, receipts };
  const serialized = canonical(block);
  if (Buffer.byteLength(serialized) > MAX_BLOCK_BYTES) throw new IngestionError('block_too_large');
  return { block, events, digest: createHash('sha256').update(serialized).digest('hex') };
}
