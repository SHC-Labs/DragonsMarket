import { object, parseJson } from './ingestion/block.js';
import { isUnits } from './validate.js';
import { RpcError, type ReadRpcClient } from './providers.js';

type Rpc = Pick<ReadRpcClient, 'call'>;
export interface ContractEvent { executor: string; standard: string; event: string; data: Record<string, unknown> }
export interface CallAction { method: string; args: unknown; deposit: string }
export interface FinalTransaction {
  signer: string; receiver: string; calls: (CallAction | null)[]; events: ContractEvent[]; failed: string[]; succeeded: string[];
}

function callAction(action: unknown): CallAction | null {
  const call = object(action) && object(action.FunctionCall) ? action.FunctionCall : null;
  if (!call || typeof call.method_name !== 'string' || typeof call.args !== 'string'
    || typeof call.deposit !== 'string') return null;
  try {
    return { method: call.method_name, deposit: call.deposit,
      args: parseJson(Buffer.from(call.args, 'base64').toString('utf8')) };
  } catch { return null; }
}

function receiptResults(receipts: unknown[]) {
  const events: ContractEvent[] = [], failed: string[] = [], succeeded: string[] = [];
  for (const receipt of receipts) {
    const o = object(receipt) && object(receipt.outcome) ? receipt.outcome : null;
    if (!o || typeof o.executor_id !== 'string' || !Array.isArray(o.logs) || !object(o.status)) {
      throw new Error('invalid_receipt_outcome');
    }
    if (Object.hasOwn(o.status, 'Failure')) failed.push(o.executor_id);
    if (!Object.hasOwn(o.status, 'SuccessValue') && !Object.hasOwn(o.status, 'SuccessReceiptId')) continue;
    succeeded.push(o.executor_id);
    for (const log of o.logs) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
      let parsed: unknown;
      try { parsed = parseJson(log.slice('EVENT_JSON:'.length)); } catch { continue; }
      if (object(parsed) && typeof parsed.standard === 'string' && typeof parsed.event === 'string'
        && object(parsed.data)) {
        events.push({ executor: o.executor_id, standard: parsed.standard, event: parsed.event, data: parsed.data });
      }
    }
  }
  return { events, failed, succeeded };
}

function completeReceipts(outcome: Record<string, unknown>, hash: string, sender: string): unknown[] {
  const root = outcome.transaction_outcome;
  if (outcome.final_execution_status !== 'FINAL' || !object(outcome.status)
    || Object.keys(outcome.status).length !== 1
    || !(typeof outcome.status.SuccessValue === 'string' || object(outcome.status.Failure))
    || !object(root) || root.id !== hash || !object(root.outcome) || root.outcome.executor_id !== sender
    || !Array.isArray(outcome.receipts_outcome) || outcome.receipts_outcome.length > 1024) {
    throw new Error('incomplete_final_transaction');
  }
  const receipts = new Map<string, Record<string, unknown>>();
  for (const receipt of outcome.receipts_outcome) {
    if (!object(receipt) || typeof receipt.id !== 'string' || !receipt.id || receipts.has(receipt.id)
      || !object(receipt.outcome)) throw new Error('invalid_receipt_graph');
    receipts.set(receipt.id, receipt.outcome);
  }
  const pending = [root.outcome];
  const seen = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const receipt = pending[index]!;
    const status = receipt.status;
    if (!object(status) || Object.keys(status).length !== 1 || !Array.isArray(receipt.receipt_ids)
      || receipt.receipt_ids.length > 1024
      || !(typeof status.SuccessValue === 'string' || typeof status.SuccessReceiptId === 'string' || object(status.Failure))
      || (typeof status.SuccessReceiptId === 'string' && !receipt.receipt_ids.includes(status.SuccessReceiptId))) {
      throw new Error('incomplete_receipt_outcome');
    }
    for (const id of receipt.receipt_ids) {
      if (typeof id !== 'string' || seen.has(id) || !receipts.has(id)) throw new Error('invalid_receipt_graph');
      seen.add(id);
      pending.push(receipts.get(id)!);
    }
  }
  if (seen.size !== receipts.size) throw new Error('unrelated_receipt_outcome');
  return outcome.receipts_outcome;
}

export function finalTransaction(rpc: Rpc, transactionHash: string, sender: string): Promise<FinalTransaction> {
  return rpc.call('EXPERIMENTAL_tx_status', { tx_hash: transactionHash, sender_account_id: sender,
    wait_until: 'FINAL' }).then(outcome => {
    const tx = object(outcome) && object(outcome.transaction) ? outcome.transaction : null;
    if (!tx || tx.hash !== transactionHash || tx.signer_id !== sender || typeof tx.receiver_id !== 'string'
      || !Array.isArray(tx.actions) || !object(outcome) || !Array.isArray(outcome.receipts_outcome)) {
      throw new Error('invalid_transaction_outcome');
    }
    const receipts = receiptResults(completeReceipts(outcome, transactionHash, sender));
    if (object(outcome.status) && Object.hasOwn(outcome.status, 'Failure') && !receipts.failed.length) receipts.failed.push(sender);
    return { signer: tx.signer_id, receiver: tx.receiver_id, calls: tx.actions.map(callAction), ...receipts };
  });
}

export function nearBalance(rpc: Rpc) {
  return (accountId: string) => rpc.call('query', { request_type: 'view_account', finality: 'final',
    account_id: accountId }).then(result => {
    if (!object(result) || !isUnits(result.amount)) throw new Error('invalid_account_view');
    return result.amount;
  }, (error: unknown) => {
    if (error instanceof RpcError && error.causeName === 'UNKNOWN_ACCOUNT') return '0';
    throw error;
  });
}
