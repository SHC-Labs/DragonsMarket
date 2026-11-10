import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonical, IngestionError, object, type Header } from './block.js';
import { isAccount as account, isHash as hash } from '../validate.js';

export interface ObservedReceipt {
  receiptId: string;
  receiverId: string;
  transactionHash: string;
  childReceiptIds: string[];
  status: Record<string, unknown>;
  logs: string[];
}
export interface ObservedBlock {
  header: Header;
  previousHeight: string;
  shardIds: string[];
  receipts: ObservedReceipt[];
}
function integer(v: unknown): string {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(s) || BigInt(s) > 18446744073709551615n) throw new IngestionError('invalid_neardata_integer');
  return s;
}
/** Preserve large integer lexemes before JS rounds them. No numeric coercion of token amounts. */
export function parseNeardata(text: string): unknown {
  try {
    return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error();
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
        if (!context?.source || !/^-?[0-9]+$/.test(context.source)) throw new Error();
        return context.source;
      }
      return value;
    });
  } catch { throw new IngestionError('invalid_neardata_json'); }
}
export function normalizeNeardata(input: unknown): ObservedBlock {
  if (!object(input) || !object(input.block) || !object(input.block.header) || !Array.isArray(input.block.chunks) || !Array.isArray(input.shards) || !input.shards.length || input.shards.length > 1024) throw new IngestionError('invalid_neardata_block');
  const h = input.block.header;
  if (!hash(h.hash) || !hash(h.prev_hash) || typeof h.timestamp_nanosec !== 'string') throw new IngestionError('invalid_neardata_header');
  const header = { height: integer(h.height), hash: h.hash, prev_hash: h.prev_hash, timestamp_nanosec: integer(h.timestamp_nanosec) };
  const previousHeight = integer(h.prev_height);
  if (BigInt(previousHeight) >= BigInt(header.height)) throw new IngestionError('invalid_neardata_parent');
  const expected = input.block.chunks.map(c => { if (!object(c)) throw new IngestionError('invalid_neardata_shard'); return integer(c.shard_id); });
  const seenShards = new Set<string>();
  const seenReceipts = new Set<string>();
  const receipts: ObservedReceipt[] = [];
  for (const shard of input.shards) {
    if (!object(shard) || !Array.isArray(shard.receipt_execution_outcomes)) throw new IngestionError('invalid_neardata_shard');
    const shardId = integer(shard.shard_id);
    if (seenShards.has(shardId)) throw new IngestionError('duplicate_neardata_shard');
    seenShards.add(shardId);
    for (const row of shard.receipt_execution_outcomes) {
      if (!object(row) || !object(row.execution_outcome)) throw new IngestionError('invalid_neardata_outcome');
      const ex = row.execution_outcome;
      const v = ex.outcome;
      if (!hash(ex.id) || ex.block_hash !== header.hash || !object(v) || !account(v.executor_id) || !hash(row.tx_hash) || !Array.isArray(v.receipt_ids) || v.receipt_ids.some(id => !hash(id)) || !Array.isArray(v.logs) || v.logs.length > 1024 || v.logs.some(log => typeof log !== 'string' || Buffer.byteLength(log) > 65536) || !object(v.status)) throw new IngestionError('invalid_neardata_outcome');
      if (seenReceipts.has(ex.id)) throw new IngestionError('duplicate_neardata_receipt');
      seenReceipts.add(ex.id);
      if (seenReceipts.size > 100000) throw new IngestionError('neardata_too_many_receipts');
      const status = v.status;
      if (Object.keys(status).length !== 1 || !(typeof status.SuccessValue === 'string' || hash(status.SuccessReceiptId) || object(status.Failure))) throw new IngestionError('incomplete_neardata_outcome');
      if (row.receipt !== null && row.receipt !== undefined && (!object(row.receipt) || row.receipt.receipt_id !== ex.id || row.receipt.receiver_id !== v.executor_id)) throw new IngestionError('neardata_receipt_mismatch');
      receipts.push({ receiptId: ex.id, receiverId: v.executor_id, transactionHash: row.tx_hash, childReceiptIds: v.receipt_ids as string[], status, logs: v.logs as string[] });
    }
  }
  if (new Set(expected).size !== expected.length || expected.length !== seenShards.size || expected.some(id => !seenShards.has(id))) throw new IngestionError('incomplete_neardata_shards');
  receipts.sort((a, b) => a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0);
  return { header, previousHeight, shardIds: [...seenShards].sort(), receipts };
}

const MAX_REQUESTS_PER_CYCLE = 32;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_BYTES_PER_CYCLE = 128 * 1024 * 1024;

/** Fixed provider hosts, no chain writes, finite requests and bounded memory. */
export class NeardataReader {
  readonly origin = 'https://mainnet.neardata.xyz';
  readonly concurrency: number;
  private requests = 0;
  private bytes = 0;
  private nextAt = 0;
  constructor(private readonly transport: typeof fetch = fetch,
    private readonly pause: (ms: number) => Promise<unknown> = sleep, private readonly intervalMs = 1000,
    private readonly options: { bearerToken?: string | undefined; concurrency?: number } = {}) {
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000)
      throw new IngestionError('invalid_source_interval');
    if (options.bearerToken !== undefined && !/^[\x21-\x7e]{8,4096}$/.test(options.bearerToken))
      throw new IngestionError('invalid_source_token');
    if (intervalMs < 400 && !options.bearerToken) throw new IngestionError('authenticated_source_required');
    this.concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4)
      throw new IngestionError('invalid_source_concurrency');
  }
  resetBudget() { this.requests = 0; this.bytes = 0; }
  /** True while a following block still fits in this cycle's request and byte budget. A batch stops here and the next cycle carries on. */
  hasBudget(count = 1) {
    return this.requests <= MAX_REQUESTS_PER_CYCLE - 4 * count
      && this.bytes <= MAX_BYTES_PER_CYCLE - MAX_DOCUMENT_BYTES * count;
  }
  async document(path: string): Promise<unknown> {
    if (!/^\/v0\/(last_block\/final|block\/[0-9]+)$/.test(path)) throw new IngestionError('invalid_neardata_path');
    let url = new URL(path, this.origin);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (++this.requests > MAX_REQUESTS_PER_CYCLE) throw new IngestionError('neardata_request_budget');
      const reservedAt = Math.max(Date.now(), this.nextAt);
      this.nextAt = reservedAt + this.intervalMs;
      await this.pause(Math.max(0, reservedAt - Date.now()));
      try {
        const response = await this.transport(url, { method: 'GET', redirect: 'manual',
          headers: this.options.bearerToken ? { Authorization: `Bearer ${this.options.bearerToken}` } : {},
          signal: AbortSignal.timeout(20000) });
        if ([301, 302, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirects === 3) throw new IngestionError('invalid_neardata_redirect');
          const target = new URL(location, url);
          const trusted = [this.origin, 'https://a3.mainnet.neardata.xyz'].includes(target.origin);
          if (!trusted || target.search || target.hash || target.username || target.password
            || !/^\/v0\/block\/[0-9]+$/.test(target.pathname)
            || (url.pathname !== '/v0/last_block/final' && target.pathname !== url.pathname))
            throw new IngestionError('invalid_neardata_redirect');
          url = target; continue;
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new IngestionError(response.status === 429 ? 'neardata_rate_limited' : 'neardata_unavailable');
        }
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length; this.bytes += chunk.length;
          if (length > MAX_DOCUMENT_BYTES || this.bytes > MAX_BYTES_PER_CYCLE) throw new IngestionError('neardata_size_limit');
          chunks.push(chunk);
        }
        return parseNeardata(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch (error) {
        if (error instanceof IngestionError) throw error;
        throw new IngestionError('neardata_unavailable');
      }
    }
    throw new IngestionError('invalid_neardata_redirect');
  }
  async capture(count = 5) {
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new IngestionError('invalid_neardata_count');
    let block = normalizeNeardata(await this.document('/v0/last_block/final'));
    const reverse = [block];
    while (reverse.length < count) {
      const previous = normalizeNeardata(await this.document(`/v0/block/${block.previousHeight}`));
      if (previous.header.height !== block.previousHeight || previous.header.hash !== block.header.prev_hash || BigInt(previous.header.timestamp_nanosec) >= BigInt(block.header.timestamp_nanosec)) throw new IngestionError('neardata_ancestry_mismatch');
      reverse.push(previous); block = previous;
    }
    return reverse.reverse();
  }
}
export function readNeardataSettings(env: NodeJS.ProcessEnv) {
  const number = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!/^[1-9]\d{0,4}$/.test(value)) throw new IngestionError('invalid_source_settings');
    return Number(value);
  };
  return {
    intervalMs: number(env.NEARDATA_INTERVAL_MS, 400),
    concurrency: number(env.NEARDATA_CONCURRENCY, 1),
    bearerToken: env.NEARDATA_BEARER_TOKEN,
  };
}
export interface CapturedEvent { receiptId: string; logIndex: number; rawLog: string; envelope: unknown; malformed: boolean }
export interface ScopedCaptureBlock extends ObservedBlock { events: CapturedEvent[]; digest: string }
export function scopeCapture(block: ObservedBlock, receiver: string): ScopedCaptureBlock {
  if (!account(receiver)) throw new IngestionError('invalid_capture_receiver');
  const receipts = block.receipts.filter(r => r.receiverId === receiver);
  const events: CapturedEvent[] = [];
  for (const receipt of receipts) {
    if ('Failure' in receipt.status) continue;
    for (const [logIndex, rawLog] of receipt.logs.entries()) {
      if (!rawLog.startsWith('EVENT_JSON:')) continue;
      let envelope: unknown = null, malformed = false;
      try {
        envelope = parseNeardata(rawLog.slice(11));
        const record = envelope;
        malformed = !object(record) || !['standard', 'version', 'event'].every(key => typeof record[key] === 'string');
      } catch { malformed = true; }
      events.push({ receiptId: receipt.receiptId, logIndex, rawLog, envelope, malformed });
    }
  }
  const scoped = { ...block, receipts, events };
  return { ...scoped, digest: createHash('sha256').update(canonical(scoped)).digest('hex') };
}
