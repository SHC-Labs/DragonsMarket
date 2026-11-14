"use client";

import { useWallet } from "./WalletProvider";
import { Button, Notice } from "./ui";
import { DEPOSIT_CHAINS } from "@/lib/deposit";
import { formatDateTimeUtc, formatExact, formatMoney } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { useCrossChainCashOut } from "@/lib/use-cross-chain-cash-out";
import type { WalletAccount } from "@/lib/wallet-account";

const STATUS_TEXT = {
  PENDING_DEPOSIT: "Waiting for the signed transfer to reach Intents.",
  KNOWN_DEPOSIT_TX: "The transfer was seen. Waiting for confirmation.",
  INCOMPLETE_DEPOSIT: "The swap service reports an incomplete deposit. Keep this request for support.",
  PROCESSING: "Moving your USDC to the destination chain.",
  SUCCESS: "1Click reports this withdrawal completed. Check the destination transaction in your wallet.",
  REFUNDED: "1Click reports a refund to your Intents account. Review your balance and the withdrawal record.",
  FAILED: "The swap service reports a failure. This does not prove a refund. Keep this request for support.",
};
const deadlineText = (iso: string) => formatDateTimeUtc(BigInt(Date.parse(iso)) * 1_000_000n);

export function CrossChainCashOut({ identity, balance, reload }: {
  identity: WalletAccount; balance: bigint; reload: () => Promise<void>;
}) {
  const { cashOut } = useWallet();
  const { input, setInput, chain, setChain, amount, quote, setQuote,
    stored, saved, state, busy, message, run, download } = useCrossChainCashOut({ identity, balance, send: cashOut, reload });
  const now = useNow(1000);
  const expired = quote !== null && now + 60_000 >= quote.reviewDeadline;
  const chains = DEPOSIT_CHAINS.filter(c => c.refundKind === identity.chain);
  const destination = chains.find(c => c.id === (quote?.chainId ?? chain));
  return <section aria-label="Withdraw to your wallet" className="mt-8">
    <h2 className="section-title">Withdraw to your wallet</h2>
    <p>Send USDC from your Intents balance to <strong className="mono break-all">{identity.label}</strong>.</p>
    {stored !== null ? <>
      <Notice>A previous withdrawal is saved. Check it before starting another;
        reloading does not send it again.</Notice>
      {state && <>
        <p role="status">{STATUS_TEXT[state.status]}</p>
        {state.destinationHashes.map(hash => <p className="mono break-all" key={hash}>
          Destination transaction: {hash}
        </p>)}
        {!state.terminal && ["SUCCESS", "REFUNDED"].includes(state.status)
          && <p>Final confirmation is incomplete. This request remains saved.</p>}
      </>}
      <Button disabled={busy} onClick={() => void run("check")}>Check withdrawal</Button>
      {state?.status === "PENDING_DEPOSIT" && <Button variant="secondary" disabled={busy}
        onClick={() => void run("retry")}>Retry the same signed request</Button>}
      {state?.terminal && <Button variant="secondary" disabled={busy}
        onClick={() => void run("finish")}>Save completed withdrawal</Button>}
    </> : quote ? <>
      <p>You send <strong>{formatExact(quote.amount)} USDC</strong>.</p>
      <p>You receive approximately <strong>{formatExact(quote.amountOut)} USDC on {destination?.name}</strong>,
        with a minimum of {formatExact(quote.minAmountOut)} USDC. Fees are included; the slippage limit is 1%.</p>
      <p>If the swap cannot complete, the quoted refund is {formatExact(quote.refundAmount)} USDC
        to your Intents account.
        Refund processing begins after {deadlineText(quote.refundDeadline)}.</p>
      <p>Your signature authorizes this one transfer of {formatExact(quote.amount)} USDC.
        It expires on {deadlineText(quote.authorizationDeadline)}.</p>
      {expired && <Notice>This quote needs refreshing before you sign.</Notice>}
      <Button disabled={busy || expired || BigInt(quote.amount) > balance}
        onClick={() => void run("send")}>{busy ? "Waiting for your wallet" : "Sign and withdraw"}</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setQuote(null)}>Change amount or network</Button>
    </> : <>
      <div role="group" aria-label="Withdrawal network" className="segmented deposit-chains">
        {chains.map(c => <button type="button" key={c.id} aria-pressed={chain === c.id} disabled={busy}
          className="trade-mode-button" onClick={() => setChain(c.id)}>{c.name}</button>)}
      </div>
      <label htmlFor="cross-chain-amount">Amount (USDC)</label>
      <div className="trade-amount-field"><input id="cross-chain-amount" inputMode="decimal" autoComplete="off"
        value={input} maxLength={40} disabled={busy} onChange={e => setInput(e.target.value)}
        placeholder="0.00" /></div>
      <p>Available: {formatMoney(balance)} USDC. Review the network, fees and minimum received before signing.</p>
      <Button disabled={busy || !amount || amount > balance} onClick={() => void run("quote")}>
        {busy ? "Getting a quote" : "Review withdrawal"}
      </Button>
    </>}
    {(stored !== null || saved !== null) && <Button variant="ghost" onClick={download}>
      Download withdrawal record
    </Button>}
    {message && <Notice>{message}</Notice>}
  </section>;
}
