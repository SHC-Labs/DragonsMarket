"use client";
import { useMemo, useSyncExternalStore } from "react";
import { useWallet } from "@/components/WalletProvider";
import { config } from "./config";
const prefix = `council-watchlist:${config.network}:${config.marketId}`;
const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener("watchlist-change", notify);
  return () => { window.removeEventListener("storage", notify); window.removeEventListener("watchlist-change", notify); };
};

export function useWatchlist() {
  const { account } = useWallet();
  const key = account ? `${prefix}:${account}` : null;
  const raw = useSyncExternalStore(subscribe, () => { try { return key ? localStorage.getItem(key) || "[]" : "[]"; } catch { return "[]"; } }, () => "[]");
  const ids = useMemo<string[]>(() => { try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; } catch { return []; } }, [raw]);
  const toggle = (id: string) => {
    if (!key) return false;
    try {
      const next = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
      localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new Event("watchlist-change"));
      return true;
    } catch { return false; }
  };
  return { ids, toggle };
}
