import { config } from "./config";
import { finalTransaction, view } from "./rpc";
import { tokenBalance, type FunctionCall } from "./market";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validate(account: string, amount: bigint) {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(account) || account.length < 2 || account.length > 64)
    throw new Error("Connect a valid NEAR account.");
  if (amount <= 0n || amount >= 2n ** 128n) throw new Error("Enter a positive amount with up to six decimals.");
  if (!config.verifierId || !config.tokenId || config.collateralTokenId !== `nep141:${config.tokenId}`)
    throw new Error("The withdrawal token is not configured consistently.");
}

export function cashOutCall(account: string, amount: bigint): FunctionCall {
  validate(account, amount);
  return { receiverId: config.verifierId, methodName: "ft_withdraw",
    args: { token: config.tokenId, receiver_id: account, amount: String(amount) },
    gas: "100000000000000", deposit: "1" };
}

export async function cashOutStorage(account: string, amount: bigint): Promise<FunctionCall | null> {
  validate(account, amount);
  const [balance, storage] = await Promise.all([
    tokenBalance(account), view<unknown>(config.tokenId, "storage_balance_of", { account_id: account }),
  ]);
  if (!/^(0|[1-9]\d{0,38})$/.test(balance) || BigInt(balance) >= 2n ** 128n || BigInt(balance) < amount)
    throw new Error("Your Intents balance is below the requested amount.");
  if (record(storage) && typeof storage.total === "string" && /^[1-9]\d{0,38}$/.test(storage.total)
    && BigInt(storage.total) < 2n ** 128n) return null;
  if (storage !== null) throw new Error("Could not verify your token storage registration.");
  const bounds = await view<unknown>(config.tokenId, "storage_balance_bounds");
  if (!record(bounds) || typeof bounds.min !== "string" || !/^[1-9]\d{0,38}$/.test(bounds.min)
    || BigInt(bounds.min) > 10n ** 22n) throw new Error("Token storage needs review before withdrawing.");
  return { receiverId: config.tokenId, methodName: "storage_deposit",
    args: { account_id: account, registration_only: true }, gas: "30000000000000", deposit: bounds.min };
}

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(atob(value)); } catch { return null; }
}

function completedReceipts(result: Record<string, unknown>): Record<string, unknown>[] | null {
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
      || !(typeof outcome.status.SuccessValue === "string" || typeof outcome.status.SuccessReceiptId === "string")) return null;
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

export function cashOutConfirmed(result: unknown, hash: string, account: string, amount: bigint): boolean {
  validate(account, amount);
  if (!record(result) || result.final_execution_status !== "FINAL" || !record(result.transaction)
    || !record(result.status) || Object.keys(result.status).length !== 1
    || decoded(result.status.SuccessValue) !== String(amount)) return false;
  if (!record(result.transaction_outcome) || result.transaction_outcome.id !== hash
    || !record(result.transaction_outcome.outcome) || result.transaction_outcome.outcome.executor_id !== account)
    return false;
  const tx = result.transaction;
  if (tx.hash !== hash || tx.signer_id !== account || tx.receiver_id !== config.verifierId
    || !Array.isArray(tx.actions) || tx.actions.length !== 1 || !record(tx.actions[0])
    || !record(tx.actions[0].FunctionCall)) return false;
  const call = tx.actions[0].FunctionCall;
  const args = decoded(call.args);
  if (call.method_name !== "ft_withdraw" || call.deposit !== "1" || !record(args)
    || Object.keys(args).length !== 3 || args.token !== config.tokenId
    || args.receiver_id !== account || args.amount !== String(amount)) return false;
  const outcomes = completedReceipts(result);
  return outcomes !== null && outcomes.some(outcome => outcome.executor_id === config.tokenId
    && Array.isArray(outcome.logs) && outcome.logs.some(log => {
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) return false;
      try {
        const event = JSON.parse(log.slice(11));
        return event.standard === "nep141" && event.event === "ft_transfer" && Array.isArray(event.data)
          && event.data.some((item: unknown) => record(item) && item.old_owner_id === config.verifierId
            && item.new_owner_id === account && item.amount === String(amount));
      } catch { return false; }
    }));
}

export function checkCashOut(hash: string, account: string, amount: bigint) {
  return finalTransaction(hash, account).then(result => cashOutConfirmed(result, hash, account, amount));
}

export function pendingCashOut(raw: string | null): { amount: string; hash: string | null } | null {
  if (!raw || raw.length > 256) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || typeof value.amount !== "string" || !/^[1-9]\d{0,38}$/.test(value.amount)
      || BigInt(value.amount) >= 2n ** 128n) return null;
    if (value.hash !== null && (typeof value.hash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.hash)))
      return null;
    return { amount: value.amount, hash: value.hash };
  } catch { return null; }
}
