"use client";

import { useId, useState } from "react";
import type { useTx } from "@/lib/hooks";
import { Button, Notice } from "./ui";
import { ModalDialog } from "./ModalDialog";

export function TransactionNotice({ tx }: { tx: ReturnType<typeof useTx> }) {
  const [reference, setReference] = useState("");
  const [resetRequest, setResetRequest] = useState<string | null>(null);
  const requestId = tx.pending ? `${tx.pending.account}:${tx.pending.createdAt}` : "unreadable";
  const titleId = useId();
  if (tx.state.phase === "idle") return null;
  if (tx.state.phase === "waiting") return <Notice>Waiting for your wallet and the chain.</Notice>;
  return <Notice tone={tx.state.phase === "unknown" ? "warning" : tx.state.phase === "done" ? undefined : "danger"}>
    <p>{"message" in tx.state ? tx.state.message : ""}</p>
    {tx.state.phase === "unknown" && <>
      {tx.pending?.hash ? <p className="mono break-all">Transaction: {tx.pending.hash}</p>
        : <label>Transaction hash from wallet history
          <input value={reference} onChange={event => setReference(event.target.value)} autoComplete="off" />
        </label>}
      <Button variant="secondary" onClick={() => tx.check(reference)}>Check status</Button>
      <Button variant="ghost" onClick={() => setResetRequest(requestId)}>Reset request</Button>
      {resetRequest === requestId && <ModalDialog titleId={titleId} onClose={() => setResetRequest(null)}>
        <h2 id={titleId}>Reset this request?</h2>
        <p>Check your wallet history first. Resetting does not cancel a transaction. Sending again could charge you twice.</p>
        <div className="wallet-dialog-actions">
          <Button variant="secondary" autoFocus onClick={() => setResetRequest(null)}>Keep request</Button>
          <Button onClick={() => { setResetRequest(null); void tx.clear(); }}>I checked, reset</Button>
        </div>
      </ModalDialog>}
    </>}
  </Notice>;
}
