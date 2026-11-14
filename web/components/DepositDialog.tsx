"use client";

import { useEffect, useState } from "react";
import { Button, Notice } from "./ui";
import { ModalDialog } from "./ModalDialog";
import { config } from "@/lib/config";
import { DEPOSIT_CHAINS, depositFinished, nextPollMs, quoteExpired, quoteRequest, readDepositStatus, requestDeposit, validRefund, type DepositChain, type DepositQuote, type DepositStatus } from "@/lib/deposit";
import { UserFacingError } from "@/lib/errors";
import { formatExact, formatDateTime, toMicro } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { WalletAccount } from "@/lib/wallet-account";

const STATUS_TEXT: Record<DepositStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit to arrive.",
  KNOWN_DEPOSIT_TX: "Deposit seen. Confirming it.",
  PROCESSING: "Deposit confirmed. Moving it into your Intents account.",
  INCOMPLETE_DEPOSIT: "Less than the amount above arrived. Send the rest to the same address.",
  SUCCESS: "Done. The funds are in your Intents account.",
  REFUNDED: "The deposit could not complete and was sent back to your refund address.",
  FAILED: "The deposit failed. This does not confirm a refund; check the transfer with 1Click support.",
};

// `requestQuote` is replaceable only so the /brand page can show the form without asking 1Click for a real address.
export function DepositDialog({ identity, onClose, requestQuote = requestDeposit }: { identity: WalletAccount; onClose: () => void; requestQuote?: typeof requestDeposit }) {
  const [chain, setChain] = useState<DepositChain>(DEPOSIT_CHAINS[0]);
  const [input, setInput] = useState("");
  const [refund, setRefund] = useState("");
  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [status, setStatus] = useState<DepositStatus>("PENDING_DEPOSIT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [stalled, setStalled] = useState(false);
  const now = useNow(1000);

  const amount = toMicro(input);
  const sameKind = identity.chain === chain.refundKind;
  const refundTo = sameKind ? identity.label : refund.trim();
  const ready = amount !== null && amount > 0n && validRefund(chain.refundKind, refundTo);

  const deadlineMs = quote ? Date.parse(quote.deadline) : 0;
  const expired = quote !== null && quoteExpired(deadlineMs, now) && status === "PENDING_DEPOSIT";

  // Polls from the moment the address is shown, slows down over time and stops for good once the status is final or the
  // bound in nextPollMs is reached. A status read that fails is retried on the next tick.
  useEffect(() => {
    if (!quote) return;
    let live = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await readDepositStatus(quote.depositAddress, quote.depositMemo).catch(() => null);
      if (!live) return;
      if (next) setStatus(next);
      if (next && depositFinished(next)) return;
      const wait = nextPollMs(++attempt, Date.now(), Date.parse(quote.deadline));
      if (wait === null) setStalled(true);
      else timer = setTimeout(tick, wait);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
  }, [quote]);

  const submit = async () => {
    if (!ready || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await requestQuote(quoteRequest({ chain, amount, recipient: identity.account, refundTo, collateral: config.collateralTokenId }), chain);
      setStatus("PENDING_DEPOSIT");
      setStalled(false);
      setQuote(next);
    } catch (e) {
      setError(e instanceof UserFacingError ? e.message : "Could not get a deposit address. Try again.");
    } finally { setBusy(false); }
  };
  const copy = () => navigator.clipboard.writeText(quote!.depositAddress).then(() => setCopied(true), () => setCopied(false));

  return <ModalDialog titleId="deposit-title" onClose={onClose}>
    <h2 id="deposit-title">Deposit {config.tokenSymbol}</h2>
    {!quote ? <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <p>Send {config.tokenSymbol} from another chain. It arrives in your Intents account, which is where every buy draws from.</p>
      <div role="group" aria-label="Chain you are sending from" className="segmented deposit-chains">
        {DEPOSIT_CHAINS.map(option => <button type="button" key={option.id} aria-pressed={chain.id === option.id} onClick={() => setChain(option)} className="trade-mode-button">{option.name}</button>)}
      </div>
      <label htmlFor="deposit-amount" className="ticket-label">Amount to send</label>
      <div className="trade-amount-field" data-invalid={input.trim() !== "" && amount === null ? true : undefined}>
        <input id="deposit-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={input} onChange={e => setInput(e.target.value)} className="num" />
        <span>{config.tokenSymbol}</span>
      </div>
      {!sameKind && <>
        <label htmlFor="deposit-refund" className="ticket-label">Refund address on {chain.name}</label>
        <div className="trade-amount-field"><input id="deposit-refund" autoComplete="off" spellCheck={false} placeholder={chain.refundKind === "evm" ? "0x…" : "Solana address"} value={refund} onChange={e => setRefund(e.target.value)} className="mono" aria-invalid={refund !== "" && !validRefund(chain.refundKind, refundTo) ? true : undefined} /></div>
        <p className="deposit-note">If the deposit cannot complete, the funds go back here.</p>
      </>}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="wallet-dialog-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!ready || busy}>{busy ? "Getting an address" : "Get deposit address"}</Button>
      </div>
    </form> : <>
      {expired
        ? <Notice tone="danger">The deposit window has closed. Do not send more funds. If you already sent a transfer, keep its transaction hash and check its status.</Notice>
        : <Notice tone="warning">Send only {config.tokenSymbol} on {chain.name} to this address. Other tokens or networks can be lost.</Notice>}
      <dl className="deposit-details">
        <div><dt>Send exactly</dt><dd className="num">{formatExact(quote.amountIn)} {config.tokenSymbol} on {chain.name}</dd></div>
        {!expired && <div><dt>To this address</dt><dd className="mono deposit-address">{quote.depositAddress}</dd></div>}
        <div><dt>You receive about</dt><dd className="num">{formatExact(quote.amountOut)} {config.tokenSymbol} in Intents</dd></div>
        <div><dt>Send before</dt><dd>{formatDateTime(BigInt(deadlineMs) * 1_000_000n)}</dd></div>
      </dl>
      <p role="status" className="deposit-status" data-status={status}>{stalled && !depositFinished(status) ? "Still waiting. This page stopped checking; your deposit is still processed if it was sent in time." : STATUS_TEXT[status]}</p>
      <div className="wallet-dialog-actions">
        {!expired && <Button variant="secondary" onClick={copy}>{copied ? "Address copied" : "Copy address"}</Button>}
        <Button variant={depositFinished(status) ? "primary" : "ghost"} onClick={onClose}>{depositFinished(status) ? "Done" : "Close"}</Button>
      </div>
    </>}
  </ModalDialog>;
}
