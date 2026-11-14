"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { config } from "./config";
import { exclusive, resubmit, type Relayed } from "./relay";
import { clearRelay, readRelay, relayChanged, relayJournalKey, writeRelay } from "./relay-journal";
import { relayOutcome } from "./relay-outcome";
import { recoverRelay } from "./relay-recovery";
import { finalTransaction } from "./rpc";

export type RelayTxState =
  | { phase: "idle" }
  | { phase: "waiting"; since?: number }
  | { phase: "done" | "failed"; message: string }
  | { phase: "unknown"; message: string; recheck: boolean };
const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener("relay-call-change", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("relay-call-change", notify);
  };
};
const empty = () => null;
const unknown: RelayTxState = { phase: "unknown", recheck: true,
  message: "A signed request needs confirmation. Check again to recover it before signing another action." };

export function useRelayTx(account: string | null) {
  const key = relayJournalKey(account ?? "disconnected");
  const raw = useSyncExternalStore(subscribe, () => {
    try { return account ? localStorage.getItem(key) : null; } catch { return "unavailable"; }
  }, empty);
  const [status, setStatus] = useState<{ key: string; state: RelayTxState }>({ key, state: { phase: "idle" } });
  const locked = useRef(false);
  const update = (state: RelayTxState) => setStatus({ key, state });
  const state: RelayTxState = status.key === key && status.state.phase === "waiting" ? status.state
    : raw !== null ? unknown : status.key === key ? status.state : { phase: "idle" };
  const guard = async (work: () => Promise<boolean>) => {
    if (!account || locked.current) return false;
    locked.current = true;
    update({ phase: "waiting" });
    try { return await work(); }
    catch { update(unknown); return false; }
    finally {
      locked.current = false;
      setStatus(current => current.key === key && current.state.phase === "waiting" ? { key, state: unknown } : current);
      relayChanged();
    }
  };
  const run = (opts: { submit: () => Promise<Relayed>; done: () => Promise<boolean>; doneMessage: string; timeoutMs?: number }) => guard(async () => {
    const outcome = await relayOutcome(opts.submit, { read: hash => finalTransaction(hash, config.relayerId),
      done: opts.done, doneMessage: opts.doneMessage, timeoutMs: opts.timeoutMs ?? 45000 });
    if (outcome.phase === "done") {
      const pending = readRelay(localStorage.getItem(key), account!);
      if (!pending?.attempt) throw new Error("The signed request was not retained.");
      clearRelay(localStorage, key, pending);
    }
    update(outcome.phase === "unknown" ? unknown : outcome);
    return outcome.phase === "done";
  });
  const recheck = () => guard(() => exclusive(async () => {
    const pending = readRelay(localStorage.getItem(key), account!);
    if (!pending) throw new Error("Saved request unavailable. Do not sign a replacement.");
    if (!pending.attempt) {
      // Acquiring the signing lock proves no other tab is still collecting these
      // signatures. No complete payload was exposed to the relay.
      clearRelay(localStorage, key, pending);
      update({ phase: "failed", message: "Signing stopped before this request was sent. You can try again." });
      return false;
    }
    if (pending.relayer === config.relayerId) {
      try { await resubmit(pending.attempt); }
      catch { /* Recovery below uses chain evidence, including hashes already retained. */ }
      finally { writeRelay(localStorage, key, pending); }
    }
    const recovered = await recoverRelay(pending, hash => finalTransaction(hash, pending.relayer), async () => {
      const response = await fetch(`${config.backendUrl}/intents/status`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ signed: pending.attempt!.signed }),
        signal: AbortSignal.timeout(15000) });
      return response.ok ? response.json() : null;
    });
    if (recovered === "done") {
      clearRelay(localStorage, key, pending);
      update({ phase: "done", message: "The saved action is confirmed. Your balances can now be refreshed." });
      return true;
    }
    if (recovered === "failed") {
      clearRelay(localStorage, key, pending);
      update({ phase: "failed", message: "This request is settled, but not every action completed. Fees or account setup may have been paid. Check your refreshed balances before trying again." });
      return false;
    }
    update(unknown);
    return false;
  }));
  const reset = () => { if (raw === null) update({ phase: "idle" }); };
  return { state, run, recheck, reset, busy: state.phase === "waiting" || raw !== null };
}
