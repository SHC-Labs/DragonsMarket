import type { FunctionCall } from "./market";

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function decoded(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value), c => c.charCodeAt(0))));
  } catch { return null; }
}

export function receiptSucceeded(outcome: Record<string, unknown>): boolean {
  return record(outcome.status) && Object.keys(outcome.status).length === 1
    && (typeof outcome.status.SuccessValue === "string" || typeof outcome.status.SuccessReceiptId === "string");
}

export function completedReceipts(result: Record<string, unknown>, mode: "successful" | "terminal" = "successful") {
  if (!record(result.transaction_outcome) || !record(result.transaction_outcome.outcome)
    || !Array.isArray(result.receipts_outcome) || result.receipts_outcome.length > 256) return null;
  const receipts = new Map<string, Record<string, unknown>>();
  for (const item of result.receipts_outcome) {
    if (!record(item) || typeof item.id !== "string" || receipts.has(item.id) || !record(item.outcome)) return null;
    receipts.set(item.id, item.outcome);
  }
  const queue: unknown[] = [result.transaction_outcome.outcome];
  const seen = new Set<string>();
  const outcomes: Record<string, unknown>[] = [];
  while (queue.length) {
    const outcome = queue.shift();
    if (!record(outcome) || !record(outcome.status) || !Array.isArray(outcome.receipt_ids)
      || Object.keys(outcome.status).length !== 1
      || !(receiptSucceeded(outcome) || (mode === "terminal" && record(outcome.status.Failure)))) return null;
    if (typeof outcome.status.SuccessReceiptId === "string"
      && !outcome.receipt_ids.includes(outcome.status.SuccessReceiptId)) return null;
    outcomes.push(outcome);
    for (const id of outcome.receipt_ids) {
      if (typeof id !== "string" || seen.has(id) || !receipts.has(id)) return null;
      seen.add(id); queue.push(receipts.get(id));
    }
  }
  return seen.size === receipts.size ? outcomes : null;
}

function sameJson(left: unknown, right: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length
    && left.every((value, i) => sameJson(value, right[i], depth + 1));
  return record(left) && record(right) && Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key], depth + 1));
}

// State can change before asynchronous receipts settle. Bind success to this wallet's
// exact request before consulting a caller's business-specific state predicate.
export function successfulCall(result: unknown, hash: string, account: string, call: FunctionCall): boolean {
  if (!record(result) || result.final_execution_status !== "FINAL" || !record(result.status)
    || Object.keys(result.status).length !== 1 || typeof result.status.SuccessValue !== "string"
    || !record(result.transaction) || !record(result.transaction_outcome)
    || result.transaction_outcome.id !== hash || !record(result.transaction_outcome.outcome)
    || result.transaction_outcome.outcome.executor_id !== account) return false;
  const tx = result.transaction;
  if (tx.hash !== hash || tx.signer_id !== account || tx.receiver_id !== call.receiverId
    || !Array.isArray(tx.actions) || tx.actions.length !== 1 || !record(tx.actions[0])
    || Object.keys(tx.actions[0]).length !== 1 || !record(tx.actions[0].FunctionCall)) return false;
  const action = tx.actions[0].FunctionCall;
  const outcomes = completedReceipts(result);
  return action.method_name === call.methodName && action.deposit === call.deposit
    && sameJson(decoded(action.args), call.args) && outcomes !== null && outcomes.length > 1
    && outcomes.some(outcome => outcome.executor_id === call.receiverId);
}

// A signed action the relayer ran for someone else. The transaction belongs to the relayer, so bind it to what this person
// signed: the verifier's execute_intents carrying exactly that payload, final, every receipt successful, and a receipt
// on the market or oracle that the payload paid.
export function relayedIntentReceipts(result: unknown, hash: string, relayer: string, verifier: string, signed: { standard: string; payload: string }, mode: "successful" | "terminal" = "successful") {
  if (!record(result) || result.final_execution_status !== "FINAL" || !record(result.status)
    || Object.keys(result.status).length !== 1 || !(typeof result.status.SuccessValue === "string" || (mode === "terminal" && record(result.status.Failure)))
    || !record(result.transaction) || !record(result.transaction_outcome)
    || result.transaction_outcome.id !== hash || !record(result.transaction_outcome.outcome)
    || result.transaction_outcome.outcome.executor_id !== relayer) return null;
  const tx = result.transaction;
  if (tx.hash !== hash || tx.signer_id !== relayer || tx.receiver_id !== verifier
    || !Array.isArray(tx.actions) || tx.actions.length !== 1 || !record(tx.actions[0])
    || Object.keys(tx.actions[0]).length !== 1 || !record(tx.actions[0].FunctionCall)) return null;
  const action = tx.actions[0].FunctionCall;
  const args = decoded(action.args);
  if (action.method_name !== "execute_intents" || action.deposit !== "0" || !record(args)
    || !Array.isArray(args.signed) || args.signed.length !== 1) return null;
  const item = args.signed[0];
  if (!record(item) || item.standard !== signed.standard || item.payload !== signed.payload) return null;
  return completedReceipts(result, mode);
}

export function relayedIntentSucceeded(result: unknown, hash: string, relayer: string, verifier: string, signed: { standard: string; payload: string }, target: string): boolean {
  const outcomes = relayedIntentReceipts(result, hash, relayer, verifier, signed);
  return outcomes !== null && outcomes.some(outcome => outcome.executor_id === target);
}

// An unsuccessful contract callback can still consume the signed intent and its
// fee. Require the verifier's nonce event and every descendant receipt to settle.
export function relayedIntentConsumed(result: unknown, hash: string, relayer: string, verifier: string, signed: { standard: string; payload: string }): boolean {
  const outcomes = relayedIntentReceipts(result, hash, relayer, verifier, signed, "terminal");
  if (!outcomes) return false;
  try {
    const payload: unknown = JSON.parse(signed.payload);
    if (!record(payload) || typeof payload.signer_id !== "string" || typeof payload.nonce !== "string") return false;
    return outcomes.some(outcome => outcome.executor_id === verifier && receiptSucceeded(outcome)
      && Array.isArray(outcome.logs) && outcome.logs.some(log => {
        if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) return false;
        let event: unknown;
        try { event = JSON.parse(log.slice(11)); } catch { return false; }
        return record(event) && event.standard === "dip4" && event.event === "intents_executed"
          && Array.isArray(event.data) && event.data.some(entry => record(entry)
            && entry.account_id === payload.signer_id && entry.nonce === payload.nonce);
      }));
  } catch { return false; }
}
