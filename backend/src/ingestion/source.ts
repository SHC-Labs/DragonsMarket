import { createReadStream } from 'node:fs';
import { IngestionError, MAX_BLOCK_BYTES, parseJson } from './block.js';
import type { Network } from '../config.js';

export interface BlockSource {
  readonly id: string;
  readonly mode: 'fixture' | 'local_capture' | 'live';
  readonly network: Network;
  blocks(): AsyncIterable<unknown>;
}

// This is deliberately a finite replay source, not a live follower or finality proof.
export class FixtureSource implements BlockSource {
  readonly id = 'fixture-jsonl-v1';
  readonly mode = 'fixture' as const;
  readonly network = 'sandbox' as const;
  constructor(private readonly path: string) {}
  async *blocks(): AsyncIterable<unknown> {
    const stream = createReadStream(this.path, { highWaterMark: 65536 });
    let pending = Buffer.alloc(0);
    const parse = (line: Buffer) => {
      if (line.length > MAX_BLOCK_BYTES) throw new IngestionError('fixture_line_too_large');
      try { return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
      catch (error) { if (error instanceof IngestionError) throw error; throw new IngestionError('invalid_fixture_encoding'); }
    };
    try {
      for await (const chunk of stream) {
        pending = Buffer.concat([pending, chunk as Buffer]);
        let end: number;
        while ((end = pending.indexOf(10)) !== -1) {
          const line = pending.subarray(0, end);
          pending = pending.subarray(end + 1);
          if (line.toString('utf8').trim()) yield parse(line);
        }
        if (pending.length > MAX_BLOCK_BYTES) throw new IngestionError('fixture_line_too_large');
      }
      if (pending.toString('utf8').trim()) yield parse(pending);
    } catch (error) {
      if (error instanceof IngestionError) throw error;
      throw new IngestionError('source_read_failed');
    } finally { stream.destroy(); }
  }
}
