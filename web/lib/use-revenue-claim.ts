"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { config } from "./config";
import { claimCall } from "./council";
import { formatMoney } from "./format";
import type { FunctionCall } from "./market";
import { checkClaim, pendingClaim, transactionHash, type PendingClaim } from "./revenue-claim";

const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener("revenue-claim-change", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("revenue-claim-change", notify);
  };
};
const empty = () => null;

export function useRevenueClaim({ account, tokens, send, reload }: {
  account: string; tokens: string[]; send: (call: FunctionCall) => Promise<string>; reload: () => Promise<void>;
}) {
  const key = `revenue-claim:${config.network}:${config.councilId}:${config.verifierId}:${config.collateralTokenId}:${account}`;
  const stored = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(key); } catch { return "unavailable"; }
  }, empty);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const locked = useRef(false);
  const pending = pendingClaim(stored);
  const save = (value: PendingClaim | null) => {
    if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key);
    window.dispatchEvent(new Event("revenue-claim-change"));
  };
  const confirm = async (hash: string, selected: string[]) => {
    const result = await checkClaim(hash, account, selected);
    if (result.status === "pending") {
      setMessage("Revenue payment is not confirmed. Check this claim before sending another.");
      return;
    }
    save(null); setReference("");
    setMessage(result.status === "paid"
      ? `Revenue claimed. ${formatMoney(result.amount)} ${config.tokenSymbol} reached your Intents balance.`
      : "The payout failed and your claimable revenue was restored. You can try again.");
    await reload();
  };
  const action = async (mode: "send" | "check" | "clear") => {
    if (localStorage.getItem(key) !== stored) return;
    if (mode === "clear") {
      if (window.confirm("Have you checked your wallet history and confirmed this claim finished or was never submitted? Clearing this notice does not cancel a pending payout.")) save(null);
      return;
    }
    if (mode === "check") {
      if (!pending) throw new Error("Invalid saved claim");
      const hash = pending.hash ?? reference.trim();
      if (!transactionHash(hash)) { setMessage("Enter the transaction hash from your wallet history."); return; }
      await confirm(hash, pending.tokens);
      return;
    }
    if (stored !== null) return;
    const request = pendingClaim(JSON.stringify({ tokens, hash: null }));
    if (!request) throw new Error("Invalid claim tokens");
    save(request);
    const hash = await send(claimCall(request.tokens));
    if (!transactionHash(hash)) throw new Error("Wallet did not return a transaction hash");
    save({ ...request, hash });
    await confirm(hash, request.tokens);
  };
  const run = async (mode: "send" | "check" | "clear") => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage("");
    try {
      if (!navigator.locks) {
        setMessage("This browser cannot safely coordinate claims. Use an up-to-date browser.");
        return;
      }
      await navigator.locks.request(key, { ifAvailable: true }, lock => {
        if (lock) return action(mode);
        setMessage("Another tab is handling this claim. Finish that request first.");
      });
    } catch {
      setMessage("Could not confirm the claim. Check your wallet history before trying again.");
    } finally { locked.current = false; setBusy(false); }
  };
  return { reference, setReference, busy, message, stored, pending, run };
}
