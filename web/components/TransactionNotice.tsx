"use client";

import { useState } from "react";
import type { useTx } from "@/lib/hooks";
import { Button, Notice } from "./ui";

export function TransactionNotice({ tx }: { tx: ReturnType<typeof useTx> }) {
  const [reference, setReference] = useState("");
  if (tx.state.phase === "idle") return null;
  if (tx.state.phase === "waiting") return <Notice>Waiting for your wallet and the chain.</Notice>;
  return <Notice tone={tx.state.phase === "done" ? undefined : "danger"}>
    <p>{"message" in tx.state ? tx.state.message : ""}</p>
    {tx.state.phase === "unknown" && <>
      {tx.pending?.hash ? <p className="mono break-all">Transaction: {tx.pending.hash}</p>
        : <label>Transaction hash from wallet history
          <input value={reference} onChange={event => setReference(event.target.value)} autoComplete="off" />
        </label>}
      <Button variant="secondary" onClick={() => tx.check(reference)}>Check saved transaction</Button>
      <Button variant="ghost" onClick={() => tx.clear()}>Clear after manual verification</Button>
    </>}
  </Notice>;
}
