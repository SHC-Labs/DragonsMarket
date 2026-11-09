"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Notice } from "./ui";
import { Lock } from "./icons";
import { useIndicator } from "./useIndicator";
import { useWallet } from "./WalletProvider";
import { config } from "@/lib/config";
import { formatMoney, formatShares, minSharesWithSlippage, nsToMs, toMicro } from "@/lib/format";
import { useNow, usePoll, useTx } from "@/lib/hooks";
import {
  buyCall, fundCall, getBalance, getShares, isRegistered, quoteBuy, quoteSell, redeemCall, sellCall, storageDepositCall,
  tokenBalance, walletTokenBalance, withdrawCall, type BuyQuote, type FunctionCall, type MarketView, type SellQuote, type Side,
} from "@/lib/market";

// A buy or sell accepts the price moving this far against it between the quote and the transaction.
const SLIPPAGE_BPS = 100n;
const BPS = 10_000n;
const money = (v: bigint) => `${formatMoney(v)} ${config.tokenSymbol}`;
const sideName = (side: Side) => (side === "yes" ? "Yes" : "No");

type Quote = { mode: "buy"; q: BuyQuote } | { mode: "sell"; q: SellQuote };
interface Action { label: string; onClick?: () => void; disabled?: boolean; locked?: boolean; note?: string }

export function TradeTicket({ market, initialSide = "yes" }: { market: MarketView; initialSide?: Side }) {
  const { account } = useWallet();
  return <AccountTradeTicket key={`${account ?? "disconnected"}:${market.id}`} market={market} initialSide={initialSide} />;
}

function AccountTradeTicket({ market, initialSide }: { market: MarketView; initialSide: Side }) {
  const { account, walletAvailable, openConnect, send } = useWallet();
  const { state, run, reset } = useTx(send, account);
  const now = useNow(1000);
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");
  const modes = useRef<HTMLDivElement>(null);
  useIndicator(modes, mode);
  const value = toMicro(input);
  const invalid = input.trim() !== "" && value === null;
  const unit = mode === "buy" ? config.tokenSymbol : "shares";
  const amount = value === null ? "Unavailable" : `${mode === "buy" ? formatMoney(value) : formatShares(value)} ${unit}`;
  // The list is polled, so a market that has just passed its close is still marked open until the next read.
  const open = market.status === "open" && nsToMs(market.close_at) > now;
  const busy = state.phase === "waiting";

  const { data: held, reload } = usePoll(async () => {
    if (!account) return null;
    const [registered, intents, inMarket, wallet, shares] = await Promise.all([
      isRegistered(account), tokenBalance(account), getBalance(account), walletTokenBalance(account), getShares(market.id, account),
    ]);
    return { registered, intents: BigInt(intents), inMarket: BigInt(inMarket), wallet: BigInt(wallet), yes: BigInt(shares[0]), no: BigInt(shares[1]) };
  }, [account, market.id], 5000);

  // The quote follows the amount a moment after typing stops.
  const [settled, setSettled] = useState<bigint | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), 300);
    return () => clearTimeout(t);
  }, [value]);
  const { data: quoted } = usePoll<Quote | null>(async () => {
    if (!open || settled === null || settled <= 0n) return null;
    return mode === "buy" ? { mode, q: await quoteBuy(market.id, side, settled) } : { mode, q: await quoteSell(market.id, side, settled) };
  }, [market.id, side, mode, open, String(settled)], 5000);
  const quote = settled === value && quoted?.mode === mode ? quoted : null;
  const buyQuote = quote?.mode === "buy" ? quote.q : null;
  const sellQuote = quote?.mode === "sell" ? quote.q : null;
  const sellNet = sellQuote ? BigInt(sellQuote.collateral_out) - BigInt(sellQuote.fee) : 0n;
  const priced = buyQuote ? BigInt(buyQuote.shares_out) > 0n : sellQuote ? BigInt(sellQuote.collateral_out) > 0n : false;

  const mine = held ? (side === "yes" ? held.yes : held.no) : 0n;
  const act = async (call: FunctionCall, done: () => Promise<boolean>, doneMessage: string) => {
    if (await run(call, { done, doneMessage })) setInput("");
    await reload();
  };
  const sharesOf = async () => {
    const [yes, no] = await getShares(market.id, account!);
    return side === "yes" ? BigInt(yes) : BigInt(no);
  };
  const withdraw = (balance: bigint) => act(withdrawCall(balance), async () => BigInt(await getBalance(account!)) < balance, "Withdrawn to your Intents account.");

  let action: Action;
  if (!account) action = { label: "Connect wallet", onClick: openConnect, disabled: !walletAvailable };
  else if (!held) action = { label: "Loading your account", disabled: true };
  else if (market.status === "resolved") {
    if (held.yes + held.no > 0n) action = { label: "Redeem winnings", onClick: () => act(redeemCall(market.id), async () => (await sharesOf()) === 0n, "Redeemed. Withdraw the balance to move it to your Intents account.") };
    else if (held.inMarket > 0n) action = { label: `Withdraw ${money(held.inMarket)}`, onClick: () => withdraw(held.inMarket) };
    else action = { label: "Market settled", disabled: true, locked: true };
  } else if (!open) action = { label: market.status === "halted" ? "Trading paused" : "Trading closed", disabled: true, locked: true };
  else if (!held.registered) {
    action = { label: "Set up account", onClick: () => act(storageDepositCall(), () => isRegistered(account), "Account set up. You can trade now."), note: "A one-time storage deposit of 0.05 NEAR lets the market keep your positions." };
  } else if (mode === "buy") {
    if (!value || value <= 0n) action = { label: "Enter an amount", disabled: true };
    else if (value > held.intents) {
      const shortfall = value - held.intents;
      action = held.wallet >= shortfall
        ? { label: `Add ${money(shortfall)}`, onClick: () => act(fundCall(account, shortfall), async () => BigInt(await tokenBalance(account)) >= value, "Funds added. You can buy now."), note: "This moves the token from your wallet into your Intents account. The buy is a second step." }
        : { label: `Not enough ${config.tokenSymbol}`, disabled: true };
    } else if (!buyQuote || !priced) action = { label: priced ? "Getting a price" : "Amount not available", disabled: true };
    else {
      const minShares = minSharesWithSlippage(BigInt(buyQuote.shares_out), SLIPPAGE_BPS);
      action = { label: `Buy ${sideName(side)}`, onClick: async () => { const before = await sharesOf(); await act(buyCall(market.id, side, value, minShares), async () => (await sharesOf()) > before, `Bought ${sideName(side)} shares.`); } };
    }
  } else if (!value || value <= 0n) action = { label: "Enter shares", disabled: true };
  else if (value > mine) action = { label: `You hold fewer ${sideName(side)} shares`, disabled: true };
  else if (!sellQuote || !priced) action = { label: priced ? "Getting a price" : "Amount not available", disabled: true };
  else {
    const minOut = (sellNet * (BPS - SLIPPAGE_BPS)) / BPS;
    action = { label: `Sell ${sideName(side)}`, onClick: async () => { const before = await sharesOf(); await act(sellCall(market.id, side, value, minOut), async () => (await sharesOf()) < before, `Sold ${sideName(side)} shares.`); } };
  }

  const edit = () => { if (state.phase === "done" || state.phase === "failed") reset(); };
  return <aside aria-label="Trade ticket" className="ticket" data-side={side}>
    <div className="ticket-head">
      <div ref={modes} role="group" aria-label="Buy or sell" className="segmented ticket-modes">
        {(["buy", "sell"] as const).map(option => <button type="button" key={option} aria-pressed={mode === option}
          onClick={() => { setMode(option); setInput(""); edit(); }}
          className="trade-mode-button">{option === "buy" ? "Buy" : "Sell"}</button>)}
      </div>
      {market.status === "resolved" && <span className="ticket-settled">Market settled</span>}
    </div>
    <fieldset className="ticket-outcomes">
      <legend>Outcome</legend>
      {(["yes", "no"] as const).map(option => <label key={option} className="ticket-outcome" data-option={option} data-selected={side === option || undefined}>
        <input type="radio" name="outcome" value={option} checked={side === option} onChange={() => { setSide(option); edit(); }} className="sr-only" />
        <span className="ticket-outcome-name">{sideName(option)}</span><span className="num ticket-outcome-price">{Math.round(Number(option === "yes" ? market.price_yes : market.price_no) / 10_000)}¢</span>
      </label>)}
    </fieldset>
    <label htmlFor="amount" className="ticket-label">{mode === "buy" ? "Amount" : "Shares to sell"}</label>
    <div className="trade-amount-field" data-invalid={invalid || undefined}>
      <input id="amount" inputMode="decimal" autoComplete="off" value={input} placeholder="0.00" disabled={busy} onChange={e => { setInput(e.target.value); edit(); }} aria-invalid={invalid || undefined} aria-describedby={invalid ? "amount-error trading-status" : "trading-status"} className="num" />
      <span>{unit}</span>
    </div>
    {invalid && <p id="amount-error" role="alert" className="ticket-error">Enter a positive number with up to six decimal places.</p>}
    <dl className="trade-estimates">
      <div><dt>{mode === "buy" ? "Amount entered" : "Shares entered"}</dt><dd className="num">{input.trim() ? amount : "Not entered"}</dd></div>
      <div><dt>{mode === "buy" ? "Estimated shares" : "Estimated return"}</dt><dd className="num">{buyQuote && priced ? `${formatShares(buyQuote.shares_out)} shares` : sellQuote && priced ? money(sellNet) : "Unavailable"}</dd></div>
      <div><dt>Fee</dt><dd className="num">{quote && priced ? money(BigInt(buyQuote?.fee ?? sellQuote?.fee ?? "0")) : "Not available yet"}</dd></div>
      {held && <>
        <div><dt>In your Intents account</dt><dd className="num">{money(held.intents)}</dd></div>
        <div><dt>In your wallet</dt><dd className="num">{money(held.wallet)}</dd></div>
        <div><dt>Your shares</dt><dd className="num">{formatShares(held.yes)} Yes, {formatShares(held.no)} No</dd></div>
        {held.inMarket > 0n && <div><dt>Ready to withdraw</dt><dd className="num">{money(held.inMarket)}</dd></div>}
      </>}
    </dl>
    {state.phase === "waiting" && <Notice>Waiting for your wallet and the chain.</Notice>}
    {state.phase === "done" && <Notice>{state.message}</Notice>}
    {state.phase === "failed" && <Notice tone="danger">{state.message}</Notice>}
    <Button size="lg" onClick={action.onClick} disabled={action.disabled || busy} aria-describedby="trading-status">{action.locked && <Lock size={17} />}{action.label}</Button>
    {held && held.inMarket > 0n && market.status !== "resolved" && <Button variant="secondary" size="sm" disabled={busy} onClick={() => withdraw(held.inMarket)}>Withdraw {money(held.inMarket)}</Button>}
    <p id="trading-status" className="ticket-note">{action.note ?? `Your wallet asks you to confirm each step. A buy or sell accepts up to ${Number(SLIPPAGE_BPS) / 100}% price movement.`}</p>
  </aside>;
}
