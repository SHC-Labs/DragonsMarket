import { object, parseJson } from './ingestion/block.js';
import { isUnits } from './validate.js';
import { RpcError, type ReadRpcClient } from './providers.js';

type Rpc = Pick<ReadRpcClient, 'call'>;
export interface ContractEvent { executor: string; standard: string; event: string; data: Record<string, unknown> }
export interface CallAction { method: string; args: unknown; deposit: string }
export interface FinalTransaction {
  signer: string; receiver: string; calls: (CallAction | null)[]; events: ContractEvent[];
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

function receiptEvents(receipts: unknown[]) {
  const events: ContractEvent[] = [];
  for (const receipt of receipts) {
    const o = object(receipt) && object(receipt.outcome) ? receipt.outcome : null;
    if (!o || typeof o.executor_id !== 'string' || !Array.isArray(o.logs) || !object(o.status)) {
      throw new Error('invalid_receipt_outcome');
    }
    if (!Object.hasOwn(o.status, 'SuccessValue') && !Object.hasOwn(o.status, 'SuccessReceiptId')) continue;
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
  return events;
}

export function finalTransaction(rpc: Rpc, transactionHash: string, sender: string): Promise<FinalTransaction> {
  return rpc.call('EXPERIMENTAL_tx_status', { tx_hash: transactionHash, sender_account_id: sender,
    wait_until: 'FINAL' }).then(outcome => {
    const tx = object(outcome) && object(outcome.transaction) ? outcome.transaction : null;
    if (!tx || tx.hash !== transactionHash || typeof tx.signer_id !== 'string' || typeof tx.receiver_id !== 'string'
      || !Array.isArray(tx.actions) || !object(outcome) || !Array.isArray(outcome.receipts_outcome)) {
      throw new Error('invalid_transaction_outcome');
    }
    return { signer: tx.signer_id, receiver: tx.receiver_id, calls: tx.actions.map(callAction),
      events: receiptEvents(outcome.receipts_outcome) };
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
