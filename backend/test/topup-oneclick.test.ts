import test from 'node:test';
import assert from 'node:assert/strict';
import { oneClickClient } from '../src/relay-topup.js';
import { rejectsWith } from './topup-harness.js';

test('an oversized 1Click response is cut off near the size limit, not buffered whole first', async () => {
  const chunk = new Uint8Array(65_536).fill(0x20);
  let pulled = 0;
  const transport = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= 64 * 1024 * 1024) { controller.close(); return; }
      pulled += chunk.length;
      controller.enqueue(chunk);
    },
  }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(oneClickClient('https://oneclick.invalid', transport).status('a'.repeat(64)), rejectsWith('oneclick_response_too_large'));
  assert.ok(pulled <= 1024 * 1024, `read ${pulled} bytes from a hostile endpoint before refusing`);
});
