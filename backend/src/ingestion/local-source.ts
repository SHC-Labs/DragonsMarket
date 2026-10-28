import { randomUUID } from 'node:crypto';
import { IngestionError, object, canonical, type FinalizedBlock, type Header, type Receipt } from './block.js';
import type { BlockSource } from './source.js';

export interface TransactionReference { hash: string; sender: string }
const isHash = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const isUint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) && v.length <= 20 && BigInt(v) <= 18446744073709551615n;

// Restricted to loopback and read methods. Never reads a wallet key or sends a transaction.
export class LocalSandboxReader {
  private readonly url: string;
  private bytes = 0;
  constructor(url: string, private readonly transport: typeof fetch = fetch) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new IngestionError('invalid_local_rpc'); }
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new IngestionError('loopback_rpc_required');
    this.url = parsed.href;
  }
  async call(method: 'status' | 'block' | 'EXPERIMENTAL_tx_status', params: object): Promise<Record<string, unknown>> {
    const id = randomUUID();
    try {
      const r = await this.transport(this.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      if (!r.ok || !r.body) throw new Error();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of r.body) {
        length += chunk.length; this.bytes += chunk.length;
        if (length > 8 * 1024 * 1024 || this.bytes > 32 * 1024 * 1024) throw new IngestionError('local_capture_too_large');
        chunks.push(chunk);
      }
      // Ignore the RPC's unsafe numeric timestamp field; normalize only timestamp_nanosec below.
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(result) || result.id !== id || result.jsonrpc !== '2.0' || !object(result.result)) throw new Error();
      return result.result;
    } catch (error) { if (error instanceof IngestionError) throw error; throw new IngestionError('local_rpc_failed'); }
  }
  async verifySandbox() {
    const status = await this.call('status', {});
    if (typeof status.chain_id !== 'string' || !status.chain_id || ['mainnet', 'testnet'].includes(status.chain_id)) throw new IngestionError('local_sandbox_required');
  }
  async header(params: { finality: 'final' } | { block_id: string }): Promise<Header> {
    const result = await this.call('block', params);
    const h = result.header;
    if (!object(h) || !isHash(h.hash) || !isHash(h.prev_hash) || !isUint(h.timestamp_nanosec) || !(Number.isSafeInteger(h.height) && Number(h.height) >= 0)) throw new IngestionError('invalid_local_block');
    if ('block_id' in params && h.hash !== params.block_id) throw new IngestionError('local_block_hash_mismatch');
    return { height: String(h.height), hash: h.hash, prev_hash: h.prev_hash, timestamp_nanosec: h.timestamp_nanosec };
  }
}

class LocalCaptureSource implements BlockSource {
  readonly id = 'local-tx-receipts-v1';
  readonly mode = 'local_capture' as const;
  readonly network = 'sandbox' as const;
  constructor(private readonly frames: FinalizedBlock[]) {}
  async *blocks() { for (const frame of this.frames) yield structuredClone(frame); }
}

/** Captures only explicitly known test transactions, not all activity on a network. */
export async function captureLocalTransactions(reader: LocalSandboxReader, anchorHash: string, transactions: TransactionReference[], maxBlocks = 200) {
  if (!isHash(anchorHash) || transactions.length < 1 || transactions.length > 20 || !Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 200) throw new IngestionError('invalid_local_capture_request');
  if (transactions.some(t => !isHash(t.hash) || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(t.sender)) || new Set(transactions.map(t => t.hash)).size !== transactions.length) throw new IngestionError('invalid_local_transaction_reference');
  await reader.verifySandbox();
  const receipts = new Map<string, { blockHash: string; receipt: Receipt }>();
  for (const reference of transactions) {
    const tx = await reader.call('EXPERIMENTAL_tx_status', { tx_hash: reference.hash, sender_account_id: reference.sender, wait_until: 'FINAL' });
    if (tx.final_execution_status !== 'FINAL' || !object(tx.transaction) || tx.transaction.hash !== reference.hash || tx.transaction.signer_id !== reference.sender || !Array.isArray(tx.receipts_outcome) || !tx.receipts_outcome.length || tx.receipts_outcome.length > 1000) throw new IngestionError('incomplete_local_transaction');
    for (const row of tx.receipts_outcome) {
      if (!object(row) || !isHash(row.id) || !isHash(row.block_hash) || !object(row.outcome) || typeof row.outcome.executor_id !== 'string' || !object(row.outcome.status) || !Array.isArray(row.outcome.logs) || row.outcome.logs.some(log => typeof log !== 'string')) throw new IngestionError('invalid_local_outcome');
      const record = { blockHash: row.block_hash, receipt: { receipt_id: row.id, receiver_id: row.outcome.executor_id, status: row.outcome.status, logs: row.outcome.logs as string[] } };
      const previous = receipts.get(row.id);
      if (previous && canonical(previous) !== canonical(record)) throw new IngestionError('conflicting_local_outcome');
      receipts.set(row.id, record);
    }
  }
  const frames: FinalizedBlock[] = [];
  let header = await reader.header({ finality: 'final' });
  while (header.hash !== anchorHash) {
    if (frames.length >= maxBlocks) throw new IngestionError('local_anchor_not_reached');
    const selected = [...receipts.values()].filter(record => record.blockHash === header.hash).map(record => record.receipt);
    frames.push({ network: 'sandbox', finalized: true, header, receipts: selected });
    header = await reader.header({ block_id: header.prev_hash });
  }
  if (!frames.length) throw new IngestionError('empty_local_capture');
  const hashes = new Set(frames.map(frame => frame.header.hash));
  if ([...receipts.values()].some(record => !hashes.has(record.blockHash))) throw new IngestionError('receipt_outside_capture');
  frames.reverse();
  return { source: new LocalCaptureSource(frames), startBlock: frames[0]!.header.height, endBlock: frames.at(-1)!.header.height, receipts: [...receipts.values()].map(record => record.receipt), blocks: frames.length };
}
