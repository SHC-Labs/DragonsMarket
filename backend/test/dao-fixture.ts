import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The upstream repository tracks this deployed Sputnik fixture. It is test evidence for the
// proposal ABI, not approval of a production DAO deployment or its policy.
const REVISION = '5434a59dec23ee0c49df8c8c4350c208a7e75b0b';
const SHA256 = '6e3f1814d40769d8f57b9a7af689d22aaab96d3232cec4d861311829c1d2318f';

export async function daoFixture() {
  const file = resolve('../contracts/target/sputnik/dao.wasm');
  const matches = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex') === SHA256;
  const cached = await readFile(file).catch(() => null);
  if (cached && matches(cached)) return cached;
  const response = await fetch(`https://raw.githubusercontent.com/near-daos/sputnik-dao-contract/${REVISION}/sputnikdao2_original.wasm`,
    { signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.equal(response.status, 200);
  const chunks: Uint8Array[] = [];
  let length = 0;
  assert.ok(response.body);
  for await (const chunk of response.body) {
    length += chunk.length;
    assert.ok(length <= 2 * 1024 * 1024, 'DAO fixture exceeds the size bound');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  assert.ok(matches(bytes), 'DAO fixture checksum mismatch');
  await mkdir(resolve('../contracts/target/sputnik'), { recursive: true });
  await writeFile(file, bytes);
  return bytes;
}
