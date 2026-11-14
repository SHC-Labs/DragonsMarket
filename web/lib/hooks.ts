"use client";

import { useCallback, useEffect, useRef, useState } from "react";
export { useTx, type TxState } from "./use-wallet-transaction";
import { fetchRelayFee } from "./relay";

// Calls a read function now and every `ms`, keeping the last good value if a refresh fails.
// Results are tied to the dependency values, so changing them never shows the old answer.
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], ms = 5000) {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null; answered: boolean }>({ key, data: null, error: null, answered: false });
  const fnRef = useRef(fn);
  const runRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    let live = true;
    const run = async () => {
      try {
        const data = await fnRef.current();
        if (live) setState({ key, data, error: null, answered: true });
      } catch (e) {
        const error = e instanceof Error ? e.message : "Could not load.";
        if (live) setState((s) => ({ key, data: s.key === key ? s.data : null, error, answered: true }));
      }
    };
    runRef.current = run;
    run();
    const t = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key, ms]);

  const current = state.key === key ? state : { data: null, error: null, answered: false };
  const reload = useCallback(() => runRef.current(), []);
  return { data: current.data, error: current.error, loading: !current.answered, reload };
}

// The relay fee to show before signing, refreshed as often as the backend reprices it. Signing asks for the fee again.
export function useRelayFee(enabled: boolean): { fee: bigint | null; reload: () => Promise<void> } {
  const { data, reload } = usePoll(async () => (enabled ? (await fetchRelayFee()).fee : null), [enabled], 60_000);
  return { fee: data, reload };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export { useRelayTx, type RelayTxState } from "./use-relay-transaction";
export { confirmRelayed, relayOutcome, oneAtATime } from "./relay-outcome";
export type { RelayedItem } from "./relay";
