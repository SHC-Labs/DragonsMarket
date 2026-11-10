import { config } from "./config";
import { finalTransaction } from "./rpc";
import { completedReceipts, decoded, receiptSucceeded, record } from "./receipt-proof";

export interface PendingClaim { tokens: string[]; hash: string | null }
export type ClaimResult = { status: "pending" } | { status: "paid" | "refunded"; amount: string };
export const transactionHash = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const sameTokens = (value: unknown, expected: string[]) => Array.isArray(value)
  && value.length === expected.length && value.every((token, i) => token === expected[i]);

export function pendingClaim(raw: string | null): PendingClaim | null {
  if (!raw || raw.length > 16384) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || !Array.isArray(value.tokens) || value.tokens.length > 10
      || !value.tokens.every(token => typeof token === "string" && token.length > 0 && token.length <= 1024)
      || new Set(value.tokens).size !== value.tokens.length
      || (value.hash !== null && (typeof value.hash !== "string" || !transactionHash(value.hash)))) return null;
    return { tokens: value.tokens, hash: value.hash };
  } catch { return null; }
}

function events(outcomes: Record<string, unknown>[], executor: string, standard: string) {
  return outcomes.filter(outcome => outcome.executor_id === executor && receiptSucceeded(outcome))
    .flatMap(outcome => Array.isArray(outcome.logs) ? outcome.logs : []).flatMap(log => {
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) return [];
      try {
        const event: unknown = JSON.parse(log.slice(11));
        return record(event) && event.standard === standard && event.version === "1.0.0" ? [event] : [];
      } catch { return []; }
    });
}

export function claimResult(result: unknown, hash: string, account: string, tokens: string[]): ClaimResult {
  const pending: ClaimResult = { status: "pending" };
  if (!config.councilId || !config.verifierId || !config.collateralTokenId || !transactionHash(hash)
    || !record(result) || result.final_execution_status !== "FINAL" || !record(result.transaction)
    || !record(result.status) || Object.keys(result.status).length !== 1 || typeof result.status.SuccessValue !== "string"
    || !record(result.transaction_outcome) || result.transaction_outcome.id !== hash
    || !record(result.transaction_outcome.outcome) || result.transaction_outcome.outcome.executor_id !== account) return pending;
  const tx = result.transaction;
  if (tx.hash !== hash || tx.signer_id !== account || tx.receiver_id !== config.councilId
    || !Array.isArray(tx.actions) || tx.actions.length !== 1 || !record(tx.actions[0])
    || !record(tx.actions[0].FunctionCall)) return pending;
  const call = tx.actions[0].FunctionCall, args = decoded(call.args);
  if (call.method_name !== "claim" || call.deposit !== "1" || !record(args)
    || Object.keys(args).length !== 1 || !sameTokens(args.token_ids, tokens)) return pending;
  const outcomes = completedReceipts(result, "terminal");
  if (!outcomes) return pending;
  const council = events(outcomes, config.councilId, "council");
  const requests = council.filter(event => event.event === "claim_requested");
  const settlements = council.filter(event => event.event === "claim_paid" || event.event === "claim_failed");
  if (requests.length !== 1 || settlements.length !== 1) return pending;
  const requested = requests[0].data, settled = settlements[0].data;
  if (!record(requested) || !record(settled) || requested.account !== account
    || typeof requested.id !== "string" || !/^(0|[1-9]\d{0,19})$/.test(requested.id)
    || BigInt(requested.id) >= 2n ** 64n
    || typeof requested.requested_at !== "string" || !/^[1-9]\d{0,19}$/.test(requested.requested_at)
    || BigInt(requested.requested_at) >= 2n ** 64n
    || typeof requested.amount !== "string" || !/^[1-9]\d{0,38}$/.test(requested.amount)
    || BigInt(requested.amount) >= 2n ** 128n || !sameTokens(requested.tokens, tokens)
    || settled.id !== requested.id || settled.account !== account || settled.amount !== requested.amount
    || settled.requested_at !== requested.requested_at || !sameTokens(settled.tokens, tokens)) return pending;
  const amount = requested.amount;
  const transfers = events(outcomes, config.verifierId, "nep245").filter(event => event.event === "mt_transfer")
    .flatMap(event => Array.isArray(event.data) ? event.data : []).filter(item => record(item)
      && item.old_owner_id === config.councilId && item.new_owner_id === account
      && sameTokens(item.token_ids, [config.collateralTokenId]) && sameTokens(item.amounts, [amount]));
  if (settlements[0].event === "claim_failed") return transfers.length === 0
    ? { status: "refunded", amount: requested.amount } : pending;
  return outcomes.every(receiptSucceeded) && transfers.length === 1
    ? { status: "paid", amount: requested.amount } : pending;
}

export function checkClaim(hash: string, account: string, tokens: string[]) {
  return finalTransaction(hash, account).then(result => claimResult(result, hash, account, tokens));
}
