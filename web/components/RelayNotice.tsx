"use client";

import type { RelayTxState } from "@/lib/use-relay-transaction";
import { Button, Notice } from "./ui";

export function RelayNotice({ state, recheck }: { state: RelayTxState; recheck: () => Promise<unknown> }) {
  if (state.phase === "idle") return null;
  if (state.phase === "waiting") return <Notice>Waiting for your wallet and network confirmation.</Notice>;
  return <Notice tone={state.phase === "done" ? undefined : "danger"}>
    <span>{state.message} </span>
    {state.phase === "unknown" && <Button variant="ghost" size="sm" onClick={() => void recheck()}>Check again</Button>}
  </Notice>;
}
