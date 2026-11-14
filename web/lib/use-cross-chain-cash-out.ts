"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { crossChainCashOutKey, recoverCrossChainCashOut, type CashOutProgress } from "./cross-chain-cash-out";
import { quoteCashOut, type CrossChainQuote } from "./cross-chain-quote";
import type { DepositChainId } from "./deposit";
import { UserFacingError } from "./errors";
import { toMicro } from "./format";
import type { WalletAccount } from "./wallet-account";

const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener("cross-chain-cash-out-change", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("cross-chain-cash-out-change", notify);
  };
};
const empty = () => null;

export function useCrossChainCashOut({ identity, balance, send, reload }: {
  identity: WalletAccount; balance: bigint;
  send: (quote: CrossChainQuote) => Promise<void>; reload: () => Promise<void>;
}) {
  const key = crossChainCashOutKey(identity.account);
  const stored = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(key); } catch { return "unavailable"; }
  }, empty);
  const saved = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(`${key}:last`); } catch { return null; }
  }, empty);
  const [input, setInput] = useState("");
  const [chain, setChain] = useState<DepositChainId>(identity.chain === "evm" ? "base" : "sol");
  const [quote, setQuote] = useState<CrossChainQuote | null>(null);
  const [state, setState] = useState<CashOutProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const locked = useRef(false);
  const amount = toMicro(input);
  const run = async (action: "quote" | "send" | "check" | "retry" | "finish") => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage("");
    try {
      if (action === "quote") {
        if (localStorage.getItem(key) !== null || !amount || amount > balance) return;
        setQuote(await quoteCashOut(identity, chain, amount));
        setState(null);
      } else if (action === "send") {
        if (!quote || localStorage.getItem(key) !== null) return;
        await send(quote);
        setQuote(null);
        setState(await recoverCrossChainCashOut(identity, localStorage));
        await reload();
      } else {
        const result = await recoverCrossChainCashOut(identity, localStorage, action);
        setState(result);
        if (result === null) setMessage("No signed withdrawal was submitted. You can request a new quote.");
        if (action === "finish" && result?.terminal) {
          setQuote(null); setInput(""); setState(null);
          setMessage("Withdrawal record saved in this browser. You can request a new quote.");
        }
        await reload();
      }
    } catch (error) {
      setMessage(error instanceof UserFacingError ? error.message
        : "Could not confirm this withdrawal. Keep the saved request and check its status before trying again.");
    } finally { locked.current = false; setBusy(false); }
  };
  const download = () => {
    const raw = stored ?? saved;
    if (!raw || raw === "unavailable") return;
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "dragons-market-withdrawal.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return { input, setInput, chain, setChain, amount, quote, setQuote,
    stored, saved, state, busy, message, run, download };
}
