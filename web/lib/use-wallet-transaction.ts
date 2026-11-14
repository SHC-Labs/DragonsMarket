"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { config } from "./config";
import type { FunctionCall } from "./market";
import { finalTransaction } from "./rpc";
import { readWalletCall, recordWalletSend, recoverWalletCall, transactionHash, walletCallConfirmed, walletJournalKey } from "./wallet-journal";

export type TxState =
  | { phase: "idle" | "waiting" }
  | { phase: "done" | "failed" | "unknown"; message: string };
const changed = () => window.dispatchEvent(new Event("wallet-call-change"));
const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener("wallet-call-change", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("wallet-call-change", notify);
  };
};
const empty = () => null;
const uncertain = "Confirmation pending. Check status before trying again.";

export function useTx(send: (call: FunctionCall) => Promise<string>, account: string | null) {
  const key = walletJournalKey(config.network, account ?? "disconnected");
  const raw = useSyncExternalStore(subscribe, () => {
    try { return account ? localStorage.getItem(key) : null; } catch { return "unavailable"; }
  }, empty);
  const [status, setStatus] = useState<{ key: string; state: TxState }>({ key, state: { phase: "idle" } });
  const locked = useRef(false);
  const pending = readWalletCall(raw, account ?? "");
  const update = (state: TxState) => setStatus({ key, state });
  const state: TxState = status.key === key && status.state.phase === "waiting" ? status.state
    : raw === "unavailable" ? { phase: "failed", message: "Site storage is unavailable. Enable storage for this site before submitting wallet transactions." }
    : raw !== null ? { phase: "unknown", message: uncertain }
      : status.key === key ? status.state : { phase: "idle" };

  const waiting = status.key === key && status.state.phase === "waiting";
  useEffect(() => {
    if (!account || !readWalletCall(raw, account)?.hash || waiting || !navigator.locks) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const recover = async () => {
      try {
        await navigator.locks.request(key, { ifAvailable: true }, async lock => {
          if (!lock || locked.current || controller.signal.aborted) return;
          if (await recoverWalletCall(localStorage, key, account, finalTransaction, controller.signal)) {
            setStatus({ key, state: { phase: "done", message: "Transaction confirmed. You can continue." } });
            changed();
          }
        });
      } catch { /* Keep the saved request when the network cannot confirm it. */ }
      if (!controller.signal.aborted && ++attempts < 3) timer = setTimeout(recover, 3000);
    };
    void recover();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [account, key, raw, waiting]);

  const exclusive = async (work: () => Promise<boolean>) => {
    if (!account || locked.current) return false;
    locked.current = true;
    update({ phase: "waiting" });
    try {
      if (!navigator.locks) throw new Error("This browser cannot coordinate wallet requests safely.");
      return await navigator.locks.request(key, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("Another tab is handling a wallet request.");
        return work();
      });
    } catch {
      update({ phase: "failed", message: uncertain });
      return false;
    } finally {
      locked.current = false;
      setStatus(current => current.key === key && current.state.phase === "waiting"
        ? { key, state: { phase: "idle" } } : current);
      changed();
    }
  };

  const run = (call: FunctionCall,
    opts: { done: (hash: string) => Promise<boolean>; doneMessage: string; timeoutMs?: number }) => exclusive(async () => {
    const sent = await recordWalletSend(localStorage, key, account!, call, send);
    changed();
    const deadline = Date.now() + (opts.timeoutMs ?? 30000);
    while (Date.now() < deadline) {
      try {
        if (walletCallConfirmed(sent, await finalTransaction(sent.hash!, sent.account)) && await opts.done(sent.hash!)) {
          localStorage.removeItem(key); update({ phase: "done", message: opts.doneMessage }); return true;
        }
      } catch { /* A failed read cannot prove a failed transaction. */ }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    update({ phase: "unknown", message: uncertain });
    return false;
  });

  const check = (reference: string) => exclusive(async () => {
    const current = readWalletCall(localStorage.getItem(key), account!);
    if (!current) throw new Error("Saved request is unavailable.");
    const hash = current.hash ?? reference.trim();
    if (!transactionHash(hash)) throw new Error("Enter the full hash from your wallet history.");
    current.hash = hash;
    localStorage.setItem(key, JSON.stringify(current));
    if (!walletCallConfirmed(current, await finalTransaction(hash, current.account))) {
      update({ phase: "unknown", message: uncertain }); return false;
    }
    localStorage.removeItem(key);
    update({ phase: "done", message: "Transaction confirmed. You can continue." });
    return true;
  });

  const clear = () => exclusive(async () => {
    localStorage.removeItem(key); update({ phase: "idle" }); return true;
  });
  const reset = () => { if (raw === null) update({ phase: "idle" }); };
  return { state, run, reset, pending, check, clear, busy: state.phase === "waiting" || raw !== null };
}
