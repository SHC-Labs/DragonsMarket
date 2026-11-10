import test from 'node:test';
import assert from 'node:assert/strict';
import { finalTransaction } from '../src/agent-chain.js';

function proof() {
  return {
    final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: 'transaction', signer_id: 'agent.near', receiver_id: 'market.near', actions: [] },
    transaction_outcome: { id: 'transaction', outcome: { executor_id: 'agent.near',
      status: { SuccessReceiptId: 'receipt' }, receipt_ids: ['receipt'] } },
    receipts_outcome: [{ id: 'receipt', outcome: { executor_id: 'market.near', receipt_ids: [] as string[],
      status: { SuccessValue: '' } as Record<string, unknown>, logs: [] } }],
  };
}

test('agent settlement requires FINAL and the complete transaction receipt graph', async () => {
  const verify = (value: unknown) => finalTransaction({ call: async () => value }, 'transaction', 'agent.near');
  await verify(proof());
  const changes: ((value: ReturnType<typeof proof>) => void)[] = [
    value => { value.final_execution_status = 'EXECUTED'; },
    value => { value.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    value => { value.transaction.signer_id = 'someone-else.near'; },
    value => { value.transaction_outcome.id = 'another-transaction'; },
    value => { value.transaction_outcome.outcome.executor_id = 'someone-else.near'; },
    value => { value.receipts_outcome = []; },
    value => { value.receipts_outcome.push(value.receipts_outcome[0]!); },
    value => { value.receipts_outcome.push({ ...value.receipts_outcome[0]!, id: 'unrelated' }); },
    value => { value.receipts_outcome[0]!.outcome.receipt_ids = ['missing']; },
    value => { value.receipts_outcome[0]!.outcome.receipt_ids = ['receipt']; },
    value => { value.receipts_outcome[0]!.outcome.status = { Unknown: null }; },
    value => { value.receipts_outcome[0]!.outcome.status = { SuccessValue: '', Failure: {} }; },
    value => { value.receipts_outcome[0]!.outcome.status = { SuccessReceiptId: 'missing' }; },
  ];
  for (const change of changes) {
    const value = proof(); change(value);
    await assert.rejects(verify(value));
  }
  const failed = proof();
  failed.receipts_outcome[0]!.outcome.status = { Failure: { ActionError: {} } };
  assert.deepEqual((await verify(failed)).failed, ['market.near']);
  const rejected = { ...proof(), status: { Failure: {} },
    transaction_outcome: { id: 'transaction', outcome: { executor_id: 'agent.near', receipt_ids: [], status: { Failure: {} } } },
    receipts_outcome: [] };
  assert.deepEqual((await verify(rejected)).failed, ['agent.near'], 'a root transaction failure cannot be reported as success');
});
