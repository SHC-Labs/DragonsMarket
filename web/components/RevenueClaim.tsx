"use client";

import { useWallet } from "./WalletProvider";
import { Button, Notice } from "./ui";
import { config } from "@/lib/config";
import { formatMoney } from "@/lib/format";
import { useRevenueClaim } from "@/lib/use-revenue-claim";

export function RevenueClaim({ account, amount, tokens, disabled, reload }: {
  account: string; amount: bigint; tokens: string[]; disabled: boolean; reload: () => Promise<void>;
}) {
  const { send } = useWallet();
  const { reference, setReference, busy, message, stored, pending, run } = useRevenueClaim({ account, tokens, send, reload });
  return <li className="position-row">
    <div className="position-main">
      <span className="position-title">Revenue ready to claim</span>
      <div className="position-shares num"><span>{formatMoney(amount)} {config.tokenSymbol}</span></div>
      {stored !== null && <>
        <p>A previous revenue claim needs checking. No further claim will be sent until it is resolved.</p>
        <label htmlFor="claim-reference">Claim transaction hash, if your wallet did not return it</label>
        <input id="claim-reference" value={pending?.hash ?? reference} maxLength={44}
          onChange={event => setReference(event.target.value)} disabled={busy || !!pending?.hash} />
      </>}
      {message && <Notice>{message}</Notice>}
    </div>
    <div className="position-status"><span className="position-outcome">Revenue share from quarters that have ended. It never expires.</span></div>
    <div className="position-action">
      {stored !== null ? <>
        <Button size="sm" disabled={busy || !pending} onClick={() => void run("check")}>Check claim</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run("clear")}>Clear checked claim</Button>
      </> : <Button size="sm" disabled={disabled || busy || amount === 0n} onClick={() => void run("send")}>
        {busy ? "Checking claim" : "Claim"}
      </Button>}
    </div>
  </li>;
}
