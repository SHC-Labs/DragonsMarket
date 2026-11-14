import { config } from "./config";
import type { Attempt } from "./relay";
import { record } from "./receipt-proof";

export type RelayStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface PendingRelay {
  version: 1;
  account: string;
  relayer: string;
  verifier: string;
  attempt: Attempt | null;
}
export const relayJournalKey = (account: string) => `relay-call:${config.network}:${config.verifierId}:${account}`;
export const relayChanged = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event("relay-call-change")); };
export function writeRelay(store: RelayStorage, key: string, value: PendingRelay) {
  const encoded = JSON.stringify(value);
  if (encoded.length > 16384) throw new Error("Signed request exceeds the recovery record limit.");
  store.setItem(key, encoded);
  if (store.getItem(key) !== encoded) throw new Error("Could not retain the signed request.");
  relayChanged();
}
export function readRelay(raw: string | null, account: string): PendingRelay | null {
  if (!raw || raw.length > 16384) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || value.account !== account
      || value.verifier !== config.verifierId || typeof value.relayer !== "string") return null;
    if (value.attempt === null) return value as unknown as PendingRelay;
    const attempt = value.attempt;
    if (!record(attempt) || !Array.isArray(attempt.signed) || !Array.isArray(attempt.items)
      || attempt.signed.length < 1 || attempt.signed.length > 2 || attempt.items.length !== attempt.signed.length
      || (attempt.hashes !== undefined && (!Array.isArray(attempt.hashes) || attempt.hashes.length > attempt.items.length
        || !attempt.hashes.every(hash => typeof hash === "string" && hash.length <= 44)))) return null;
    for (let i = 0; i < attempt.signed.length; i++) {
      const signed = attempt.signed[i], item = attempt.items[i];
      if (!record(signed) || !record(item) || !["erc191", "raw_ed25519"].includes(String(signed.standard))
        || typeof signed.signature !== "string" || typeof signed.payload !== "string" || signed.payload.length > 2048
        || (signed.standard === "raw_ed25519" && typeof signed.public_key !== "string")
        || item.payload !== signed.payload || item.standard !== signed.standard || typeof item.target !== "string") return null;
      const payload: unknown = JSON.parse(signed.payload);
      if (!record(payload) || payload.signer_id !== account || payload.verifying_contract !== value.verifier
        || typeof payload.nonce !== "string" || typeof payload.deadline !== "string" || !Number.isFinite(Date.parse(payload.deadline))) return null;
    }
    return value as unknown as PendingRelay;
  } catch { return null; }
}

export function clearRelay(store: RelayStorage, key: string, expected: PendingRelay) {
  if (store.getItem(key) !== JSON.stringify(expected)) throw new Error("The saved relay request changed.");
  store.removeItem(key);
  if (store.getItem(key) !== null) throw new Error("Could not clear the confirmed request.");
  relayChanged();
}
