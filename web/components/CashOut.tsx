"use client";

import { useWallet } from "./WalletProvider";
import { Button, Notice } from "./ui";
import { config } from "@/lib/config";
import { formatMoney } from "@/lib/format";
import { useCashOut } from "@/lib/use-cash-out";

export function CashOut({ account, balance, reload }: { account: string; balance: bigint; reload: () => Promise<void> }) {
  const { send } = useWallet();
  const { input, setInput, amount, reference, setReference, busy, message, stored, pending, run } =
    useCashOut({ account, balance, send, reload });
  return <section aria-label="Withdraw to your wallet" className="mt-8">
    <h2 className="section-title">Withdraw to your wallet</h2>
    <p>Send {config.tokenSymbol} from your Intents balance to <strong>{account}</strong> on NEAR. Your wallet confirms the amount and network fee.</p>
    <label htmlFor="cash-out-amount">Amount ({config.tokenSymbol})</label>
    <div className="trade-amount-field">
      <input id="cash-out-amount" inputMode="decimal" autoComplete="off" value={input}
        maxLength={40}
        disabled={busy || stored !== null} onChange={event => setInput(event.target.value)} placeholder="0.00" />
    </div>
    <p>Available: {formatMoney(balance)} {config.tokenSymbol}. A wallet without token storage first needs a separate storage setup, capped at 0.01 NEAR.</p>
    {stored ? <>
      <p>A previous request{pending ? ` for ${formatMoney(pending.amount)} ${config.tokenSymbol}` : ""} needs checking.
        No further withdrawal will be sent until it is resolved.</p>
      <label htmlFor="cash-out-reference">Transaction hash, if your wallet did not return it</label>
      <input id="cash-out-reference" value={pending?.hash ?? reference} maxLength={44}
        onChange={event => setReference(event.target.value)} disabled={busy || !!pending?.hash} />
      <Button disabled={busy || !pending} onClick={() => void run("check")}>Check withdrawal</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void run("clear")}>Clear checked request</Button>
    </> : <Button disabled={busy || !amount || amount > balance} onClick={() => void run("send")}>
      {busy ? "Checking withdrawal" : "Withdraw to my wallet"}
    </Button>}
    {message && <Notice>{message}</Notice>}
  </section>;
}
