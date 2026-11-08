"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { config } from "./config";
import { toMicro, formatMoney } from "./format";
import type { FunctionCall } from "./market";
import { cashOutCall, cashOutStorage, checkCashOut, pendingCashOut } from "./cash-out";

const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener("cash-out-change", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("cash-out-change", notify);
  };
};
const empty = () => null;

export function useCashOut({ account, balance, send, reload }: {
  account: string; balance: bigint; send: (call: FunctionCall) => Promise<string>; reload: () => Promise<void>;
}) {
  const key = `cash-out:${config.network}:${config.verifierId}:${account}`;
  const stored = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(key); } catch { return "unavailable"; }
  }, empty);
  const [input, setInput] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const locked = useRef(false);
  const amount = toMicro(input);
  const pending = pendingCashOut(stored);
  const save = (value: { amount: string; hash: string | null } | null) => {
    if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key);
    window.dispatchEvent(new Event("cash-out-change"));
  };
  const confirm = async (hash: string, units: bigint) => {
    if (!await checkCashOut(hash, account, units)) {
      setMessage("Payment is not confirmed. Check its status before sending another withdrawal.");
      return;
    }
    save(null); setInput(""); setReference("");
    setMessage(`${formatMoney(units)} ${config.tokenSymbol} reached ${account}.`);
    await reload();
  };
  const submit = async () => {
    if (localStorage.getItem(key) !== null || !amount || amount > balance) return;
    const storage = await cashOutStorage(account, amount);
    if (storage) {
      await send(storage);
      setMessage("Token storage was submitted. Check your wallet, then continue the withdrawal.");
      return;
    }
    save({ amount: String(amount), hash: null });
    const hash = await send(cashOutCall(account, amount));
    save({ amount: String(amount), hash });
    await confirm(hash, amount);
  };
  const action = async (mode: "send" | "check" | "clear") => {
    if (localStorage.getItem(key) !== stored) return;
    if (mode === "send") return submit();
    if (mode === "clear") {
      if (window.confirm("Have you checked your wallet history and confirmed that this request finished or was never submitted? Clearing this notice does not cancel a transaction.")) save(null);
      return;
    }
    if (!pending) throw new Error("Invalid saved request");
    const hash = pending.hash ?? reference.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) {
      setMessage("Enter the transaction hash from your wallet history.");
      return;
    }
    await confirm(hash, BigInt(pending.amount));
  };
  const run = async (mode: "send" | "check" | "clear") => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage("");
    try {
      if (!navigator.locks) {
        setMessage("This browser cannot safely coordinate withdrawals. Use an up-to-date browser.");
        return;
      }
      await navigator.locks.request(key, { ifAvailable: true }, lock => {
        if (lock) return action(mode);
        setMessage("Another tab is handling a withdrawal. Finish that request first.");
      });
    } catch {
      setMessage("Could not confirm the request. Check your wallet history before trying again.");
    } finally { locked.current = false; setBusy(false); }
  };
  return { input, setInput, amount, reference, setReference, busy, message, stored, pending, run };
}
