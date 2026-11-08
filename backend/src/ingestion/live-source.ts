import type { BlockSource } from './source.js';
import { IngestionError, type Header } from './block.js';
import { NeardataReader, normalizeNeardata, type ObservedBlock } from './neardata.js';

/** One bounded finalized batch. The supervisor owns retries, checkpoints and the next poll. */
export class LiveNeardataSource implements BlockSource {
  readonly id = 'mainnet-neardata-v1';
  readonly mode = 'live' as const;
  readonly network = 'mainnet' as const;
  constructor(private readonly reader: NeardataReader, private readonly head: ObservedBlock,
    private readonly start: string, private readonly checkpoint: Header | null, private readonly signal?: AbortSignal) {}
  async *blocks() {
    let height = this.checkpoint ? BigInt(this.checkpoint.height)+1n : BigInt(this.start);
    let previous = this.checkpoint;
    let requests = 0;
    while (height <= BigInt(this.head.header.height) && requests < 20) {
      this.signal?.throwIfAborted();
      let count = Math.min(this.reader.concurrency, 20 - requests,
        Number(BigInt(this.head.header.height) - height + 1n));
      while (count > 0 && !this.reader.hasBudget(count)) count--;
      if (count === 0) break;
      const batch = await Promise.allSettled(Array.from({ length: count }, (_, index) => {
        const next = height + BigInt(index);
        return next.toString() === this.head.header.height ? Promise.resolve(this.head)
          : this.reader.document(`/v0/block/${next}`);
      }));
      for (const item of batch) {
        this.signal?.throwIfAborted();
        if (item.status === 'rejected') throw item.reason;
        const raw = item.value;
        requests++;
        // Null slots are not committed. A later block must prove it directly follows the last committed hash.
        if (raw === null) { height++; continue; }
        const block = raw === this.head ? this.head : normalizeNeardata(raw);
        if (block.header.height !== height.toString()) throw new IngestionError('source_height_mismatch');
        if (previous && (block.header.prev_hash !== previous.hash || block.previousHeight !== previous.height || BigInt(block.header.timestamp_nanosec) <= BigInt(previous.timestamp_nanosec))) throw new IngestionError('source_ancestry_mismatch');
        if (!previous && block.header.height !== this.start) throw new IngestionError('start_block_mismatch');
        yield { network: 'mainnet', finalized: true, header: block.header, receipts: block.receipts.map(r => ({ receipt_id: r.receiptId, receiver_id: r.receiverId, status: r.status, logs: r.logs, transaction_hash: r.transactionHash, child_receipt_ids: r.childReceiptIds })) };
        previous = block.header; height++;
      }
    }
    if (!previous || (height <= BigInt(this.head.header.height) && previous.height === this.checkpoint?.height)) throw new IngestionError('source_no_progress');
  }
}
