import { completedReceipts, record, relayedIntentSucceeded } from "./receipt-proof";
import type { RelayedItem } from "./relay";

// Recovery cannot use a balance delta captured by a page that no longer exists.
// Read the contract's event from this exact transaction instead.
export function relayedEffectConfirmed(result: unknown, hash: string, relayer: string, verifier: string, item: RelayedItem): boolean {
  if (!relayedIntentSucceeded(result, hash, relayer, verifier, item, item.target) || !record(result)) return false;
  try {
    const payload: unknown = JSON.parse(item.payload);
    if (!record(payload) || !Array.isArray(payload.intents)) return false;
    const action = payload.intents.find(intent => record(intent) && (intent.contract_id === item.target || intent.receiver_id === item.target));
    if (!record(action) || typeof action.msg !== "string") return false;
    const p = action.msg.split(":"), signer = payload.signer_id;
    for (const outcome of completedReceipts(result) ?? []) {
      if (outcome.executor_id !== item.target || !Array.isArray(outcome.logs)) continue;
      for (const log of outcome.logs) {
        if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
        const event: unknown = JSON.parse(log.slice(11));
        if (!record(event) || event.version !== "1.0.0" || !record(event.data)) continue;
        const d = event.data;
        if (event.standard === "market" && d.account === signer) {
          if (p[0] === "register" && event.event === "registered") return true;
          if (p[0] === "redeem" && event.event === "redeemed" && d.market_id === p[1]) return true;
          if (p[0] === "withdraw" && event.event === "withdraw_confirmed" && d.amount === p[1]) return true;
          if (p[0] === "sell" && event.event === "sell" && d.market_id === p[1] && d.side === p[2] && d.shares === p[3]) return true;
          if (p[0] === "buy" && event.event === "buy" && d.market_id === p[1] && d.side === p[2]) return true;
        }
        if (event.standard === "oracle" && d.market === p[1] && d.market_id === p[2]) {
          if (p[0] === "propose" && event.event === "proposed" && d.proposer === signer && d.outcome === p[3]) return true;
          if (p[0] === "challenge" && event.event === "challenged" && d.challenger === signer && d.answer === p[3]) return true;
        }
      }
    }
  } catch { return false; }
  return false;
}
