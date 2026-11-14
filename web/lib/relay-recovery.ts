import { record, relayedIntentConsumed } from "./receipt-proof";
import { relayedEffectConfirmed } from "./relay-effects";
import type { PendingRelay } from "./relay-journal";

export async function recoverRelay(pending: PendingRelay, read: (hash: string) => Promise<unknown>, expired: () => Promise<unknown>): Promise<"done" | "failed" | "unknown"> {
  const attempt = pending.attempt;
  if (!attempt) return "unknown";
  const states = await Promise.all(attempt.items.map(async (item, index) => {
    const hash = attempt.hashes?.[index];
    if (!hash) return "unknown";
    try {
      const tx = await read(hash);
      if (relayedEffectConfirmed(tx, hash, pending.relayer, pending.verifier, item)) return "done";
      if (relayedIntentConsumed(tx, hash, pending.relayer, pending.verifier, item)) return "failed";
    } catch { /* An unavailable receipt leaves this item unresolved. */ }
    return "unknown";
  }));
  if (states.every(state => state === "done")) return "done";
  if (states.includes("unknown")) {
    const evidence = await expired();
    if (record(evidence) && Array.isArray(evidence.unused) && evidence.unused.length === states.length) {
      for (let i = 0; i < states.length; i++) if (states[i] === "unknown" && evidence.unused[i] === true) states[i] = "failed";
    }
  }
  return states.includes("unknown") ? "unknown" : "failed";
}
