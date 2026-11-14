import type { FunctionCall } from "./market";
import { record, successfulCall } from "./receipt-proof";

export interface PendingWalletCall {
  version: 1;
  account: string;
  call: FunctionCall;
  hash: string | null;
  createdAt: number;
}
export const transactionHash = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
export const walletJournalKey = (network: string, account: string) => `wallet-call:${network}:${account}`;

export function readWalletCall(raw: string | null, account: string): PendingWalletCall | null {
  if (!raw || raw.length > 65536) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || value.account !== account || !record(value.call)
      || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0
      || !(value.hash === null || (typeof value.hash === "string" && transactionHash(value.hash)))) return null;
    const call = value.call;
    if (typeof call.receiverId !== "string" || typeof call.methodName !== "string"
      || !record(call.args) || typeof call.gas !== "string" || typeof call.deposit !== "string") return null;
    return value as unknown as PendingWalletCall;
  } catch { return null; }
}

export async function recordWalletSend(store: Pick<Storage, "getItem" | "setItem">, key: string,
  account: string, call: FunctionCall, send: (call: FunctionCall) => Promise<string>) {
  if (store.getItem(key) !== null) throw new Error("A wallet request still needs confirmation.");
  const pending: PendingWalletCall = { version: 1, account, call: structuredClone(call),
    hash: null, createdAt: Date.now() };
  const encoded = JSON.stringify(pending);
  if (encoded.length > 65536) throw new Error("Wallet request is too large.");
  store.setItem(key, encoded);
  if (store.getItem(key) !== encoded) throw new Error("Could not retain the wallet request.");
  const hash = await send(structuredClone(call));
  if (!transactionHash(hash)) throw new Error("The wallet did not return a transaction hash.");
  pending.hash = hash;
  store.setItem(key, JSON.stringify(pending));
  return pending;
}

export function walletCallConfirmed(pending: PendingWalletCall, result: unknown) {
  return pending.hash !== null && successfulCall(result, pending.hash, pending.account, pending.call);
}
