"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useWallet } from "@/components/WalletProvider";
import { backendEnabled, serverWatchlist, setServerWatch } from "@/lib/backend";
import { config } from "@/lib/config";
import { isWatchableId, mergeWatchlists } from "@/lib/watchlist-merge";

// One watchlist for the whole page. It lives in this browser and, when the backend knows the account, on the server too, so it
// follows the person to another device. A failed sync never loses the local list. Keeping it in one place means the sync and
// the wallet prompt happen once, not once per market card.
const prefix = `council-watchlist:${config.network}:${config.marketId}`;
const CHANGE = "watchlist-change";

const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener(CHANGE, notify);
  return () => { window.removeEventListener("storage", notify); window.removeEventListener(CHANGE, notify); };
};
const readKey = (key: string | null) => { try { return key ? localStorage.getItem(key) || "[]" : "[]"; } catch { return "[]"; } };
const parse = (raw: string): string[] => {
  try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
};
const write = (key: string, ids: string[]) => {
  try { localStorage.setItem(key, JSON.stringify(ids)); window.dispatchEvent(new Event(CHANGE)); return true; } catch { return false; }
};

interface WatchlistState { ids: string[]; toggle: (id: string) => boolean }
const Ctx = createContext<WatchlistState>({ ids: [], toggle: () => false });
export const useWatchlistContext = () => useContext(Ctx);

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const { account, backendAccount, signInToBackend } = useWallet();
  const listKey = account ? `${prefix}:${account}` : null;
  const removedKey = account ? `${prefix}:${account}:removed` : null;
  const listRaw = useSyncExternalStore(subscribe, () => readKey(listKey), () => "[]");
  const removedRaw = useSyncExternalStore(subscribe, () => readKey(removedKey), () => "[]");
  const ids = useMemo(() => parse(listRaw), [listRaw]);
  const removed = useMemo(() => parse(removedRaw), [removedRaw]);
  const [syncedFor, setSyncedFor] = useState<string | null>(null);
  const asked = useRef(false);
  const latest = useRef({ ids, removed });
  useEffect(() => { latest.current = { ids, removed }; });

  // Once per signed-in account: merge the server's list with this browser's, push what the server lacks and clear what the
  // person removed. Reads the current lists from a ref so a change made while the request is out is not lost.
  useEffect(() => {
    if (!account || !listKey || !removedKey || backendAccount !== account || syncedFor === account) return;
    let live = true;
    serverWatchlist()
      .then(async remote => {
        if (!live) return;
        const { ids: local, removed: gone } = latest.current;
        const merged = mergeWatchlists({ local, remote, removed: gone });
        write(listKey, merged.ids);
        await Promise.all(merged.push.map(id => setServerWatch(id, true)));
        await Promise.all(merged.remove.map(id => setServerWatch(id, false)));
        const stillRemoved = latest.current.removed.filter(id => !merged.remove.includes(id) && remote.includes(id));
        write(removedKey, stillRemoved);
        if (live) setSyncedFor(account);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [account, backendAccount, syncedFor, listKey, removedKey]);

  const toggle = useCallback((id: string) => {
    if (!listKey || !removedKey || !isWatchableId(id)) return false;
    const watching = latest.current.ids.includes(id);
    const next = watching ? latest.current.ids.filter(value => value !== id) : [...latest.current.ids, id];
    const gone = watching ? [...new Set([...latest.current.removed, id])] : latest.current.removed.filter(value => value !== id);
    if (!write(listKey, next)) return false;
    write(removedKey, gone);
    latest.current = { ids: next, removed: gone };
    if (backendAccount && backendAccount === account) {
      setServerWatch(id, !watching)
        .then(() => { if (watching) write(removedKey, latest.current.removed.filter(value => value !== id)); })
        .catch(() => {});
    } else if (backendEnabled() && account && !asked.current) {
      // One wallet prompt per visit: a person who declined is not asked again on every star.
      asked.current = true;
      void signInToBackend().catch(() => {});
    }
    return true;
  }, [listKey, removedKey, backendAccount, account, signInToBackend]);

  const value = useMemo(() => ({ ids, toggle }), [ids, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
