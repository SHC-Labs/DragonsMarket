import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSandboxReader, captureLocalTransactions } from '../src/ingestion/local-source.js';

const hash = (char: string) => char.repeat(32);
function reader(patch: { chain?: string; finality?: string; outcomeBlock?: string } = {}) {
  const transport: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    let result: unknown;
    if (request.method === 'status') result = { chain_id: patch.chain ?? 'localnet' };
    else if (request.method === 'EXPERIMENTAL_tx_status') result = {
      final_execution_status: patch.finality ?? 'FINAL', transaction: { hash: hash('T'), signer_id: 'owner.sandbox' },
      receipts_outcome: [{ id: hash('R'), block_hash: patch.outcomeBlock ?? hash('B'), outcome: { executor_id: 'rounds.sandbox', logs: [], status: { Failure: { ActionError: {} } } } }],
    };
    else {
      const current = request.params.finality ? hash('C') : request.params.block_id;
      result = { header: { hash: current, prev_hash: current === hash('C') ? hash('B') : hash('A'), height: current === hash('C') ? 12 : 11, timestamp: 1700000000000000000, timestamp_nanosec: '1700000000000000001' } };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  };
  return new LocalSandboxReader('http://127.0.0.1:3030', transport);
}
const reference = [{ hash: hash('T'), sender: 'owner.sandbox' }];

test('capture is loopback-only and refuses a public chain behind loopback', async () => {
  for (const url of ['https://free.rpc.fastnear.com', 'http://192.168.1.3:3030', 'http://user:password@localhost:3030', 'http://localhost:3030?key=secret']) assert.throws(() => new LocalSandboxReader(url), /loopback_rpc_required/);
  await assert.rejects(captureLocalTransactions(reader({ chain: 'mainnet' }), hash('A'), reference), /local_sandbox_required/);
});

test('capture follows finalized ancestry, keeps failed outcomes and exact nanoseconds', async () => {
  const captured = await captureLocalTransactions(reader(), hash('A'), reference);
  const frames: any[] = [];
  for await (const frame of captured.source.blocks()) frames.push(frame);
  assert.equal(captured.source.mode, 'local_capture');
  assert.equal(captured.startBlock, '11');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].header.timestamp_nanosec, '1700000000000000001');
  assert.deepEqual(frames[0].receipts[0].status, { Failure: { ActionError: {} } });
  assert.equal(frames[1].receipts.length, 0);
});

test('unfinished transactions, missing anchors and receipts outside the interval are refused', async () => {
  await assert.rejects(captureLocalTransactions(reader({ finality: 'EXECUTED' }), hash('A'), reference), /incomplete_local_transaction/);
  await assert.rejects(captureLocalTransactions(reader(), hash('A'), reference, 1), /local_anchor_not_reached/);
  await assert.rejects(captureLocalTransactions(reader({ outcomeBlock: hash('Z') }), hash('A'), reference), /receipt_outside_capture/);
});
