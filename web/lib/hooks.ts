"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { txPanics } from "./rpc";
import { friendlyError, shortRef } from "./errors";
import type { FunctionCall } from "./market";

// Calls a read function now and every `ms`, keeping the last good value if a refresh fails.
// Results are tied to the dependency values, so changing them never shows the old answer.
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], ms = 5000) {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({ key, data: null, error: null });
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
        if (live) setState({ key, data, error: null });
      } catch (e) {
        const error = e instanceof Error ? e.message : "Could not load.";
        if (live) setState((s) => ({ key, data: s.key === key ? s.data : null, error }));
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

  const current = state.key === key ? state : { data: null, error: null };
  const reload = useCallback(() => runRef.current(), []);
  return { data: current.data, error: current.error, loading: current.data === null && current.error === null, reload };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export type TxState =
  | { phase: "idle" }
  | { phase: "waiting"; since: number }
  | { phase: "done"; message: string }
  | { phase: "failed"; message: string };

// Sends a call through the wallet, then waits for the chain to show the effect (`done()` returns true).
// If the effect never shows, the transaction is read back and its panic explained.
export function useTx(send: (call: FunctionCall) => Promise<string>, account: string | null) {
  const [state, setState] = useState<TxState>({ phase: "idle" });

  const run = useCallback(
    async (call: FunctionCall, opts: { done: () => Promise<boolean>; doneMessage: string; timeoutMs?: number }) => {
      setState({ phase: "waiting", since: Date.now() });
      let hash = "";
      try {
        hash = await send(call);
      } catch {
        setState({ phase: "failed", message: "The wallet did not send it. Nothing was taken." });
        return false;
      }
      const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          if (await opts.done()) {
            setState({ phase: "done", message: opts.doneMessage });
            return true;
          }
        } catch {
          // a read failed; try again until the deadline
        }
      }
      let panic: string | null = null;
      try {
        if (account) panic = (await txPanics(hash, account))[0] ?? null;
      } catch {
        // the lookup failed, fall back to the generic message
      }
      setState({ phase: "failed", message: friendlyError(panic, shortRef(hash)) });
      return false;
    },
    [send, account],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, run, reset };
}
