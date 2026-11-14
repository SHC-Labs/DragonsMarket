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
    let scheduled = 0, next = height;
    type Result = { ok: true; value: unknown } | { ok: false; error: unknown };
    const pending = new Map<bigint, Promise<Result>>();
    const fill = () => {
      this.signal?.throwIfAborted();
      while (pending.size < this.reader.concurrency && scheduled < 20
        && next <= BigInt(this.head.header.height) && this.reader.hasBudget()) {
        const request = next.toString() === this.head.header.height ? Promise.resolve(this.head)
          : this.reader.document(`/v0/block/${next}`);
        pending.set(next, request.then(value => ({ ok: true, value }), error => ({ ok: false, error })));
        next++; scheduled++;
      }
    };
    try {
      fill();
      while (pending.size) {
        this.signal?.throwIfAborted();
        const item = await pending.get(height)!;
        pending.delete(height);
        if (!item.ok) throw item.error;
        const raw = item.value;
        // Null slots are not committed. A later block must prove it directly follows the last committed hash.
        if (raw === null) { height++; fill(); continue; }
        const block = raw === this.head ? this.head : normalizeNeardata(raw);
        if (block.header.height !== height.toString()) throw new IngestionError('source_height_mismatch');
        if (previous && (block.header.prev_hash !== previous.hash || block.previousHeight !== previous.height || BigInt(block.header.timestamp_nanosec) <= BigInt(previous.timestamp_nanosec))) throw new IngestionError('source_ancestry_mismatch');
        if (!previous && block.header.height !== this.start) throw new IngestionError('start_block_mismatch');
        // Keep downloads moving during the ordered database commit without increasing the window.
        fill();
        yield { network: 'mainnet', finalized: true, header: block.header, receipts: block.receipts.map(r => ({ receipt_id: r.receiptId, receiver_id: r.receiverId, status: r.status, logs: r.logs, transaction_hash: r.transactionHash, child_receipt_ids: r.childReceiptIds })) };
        previous = block.header; height++;
      }
    } finally {
      // A failed or cancelled consumer must finish its outstanding reads before the
      // supervisor resets the shared request/byte budget for another cycle.
      await Promise.all(pending.values());
    }
    if (!previous || (height <= BigInt(this.head.header.height) && previous.height === this.checkpoint?.height)) throw new IngestionError('source_no_progress');
  }
}
