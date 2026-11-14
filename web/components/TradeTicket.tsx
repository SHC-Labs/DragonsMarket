"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import { Lock } from "./icons";
import { useIndicator } from "./useIndicator";
import { useWallet } from "./WalletProvider";
import { RelayNotice } from "./RelayNotice";
import { relayMarketExit } from "@/lib/relay-market";
import { DepositDialog } from "./DepositDialog";
import { TransactionNotice } from "./TransactionNotice";
import { config } from "@/lib/config";
import type { Action } from "@/lib/signed-intents";
import { formatExact, formatMoney, formatShares, minSharesWithSlippage, nsToMs, toMicro } from "@/lib/format";
import { useNow, usePoll, useRelayFee, useRelayTx, useTx } from "@/lib/hooks";
import { signsWithRelay } from "@/lib/wallet-account";
import {
  buyCall, buyMessage, fundCall, getBalance, getMarketConfig, getShares, isRegistered, quoteBuy, quoteSell, redeemCall, sellCall, storageDepositCall,
  tokenBalance, walletTokenBalance, withdrawCall, type BuyQuote, type FunctionCall, type MarketView, type SellQuote, type Side,
} from "@/lib/market";

// A buy or sell accepts the price moving this far against it between the quote and the transaction.
const SLIPPAGE_BPS = 100n;
const BPS = 10_000n;
const money = (v: bigint) => `${formatMoney(v)} ${config.tokenSymbol}`;
// What an EVM or Solana wallet signs is shown to the last unit, so a rounded figure never hides part of it.
const exact = (v: bigint) => `${formatExact(v)} ${config.tokenSymbol}`;
const sideName = (side: Side) => (side === "yes" ? "Yes" : "No");

type Quote = { mode: "buy"; q: BuyQuote } | { mode: "sell"; q: SellQuote };
interface TicketAction { label: string; onClick?: () => void; disabled?: boolean; locked?: boolean; note?: string }

export function TradeTicket({ market, initialSide = "yes" }: { market: MarketView; initialSide?: Side }) {
  const { account } = useWallet();
  return <AccountTradeTicket key={`${account ?? "disconnected"}:${market.id}`} market={market} initialSide={initialSide} />;
}

function AccountTradeTicket({ market, initialSide }: { market: MarketView; initialSide: Side }) {
  const { account, identity, walletAvailable, openConnect, send, signRelayed } = useWallet();
  const relay = signsWithRelay(identity);
  const nearTx = useTx(send, account);
  const relayTx = useRelayTx(account);
  const { fee: relayFee, reload: reloadFee } = useRelayFee(relay);
  const { state, reset } = relay ? relayTx : nearTx;
  const { run } = nearTx;
  const [depositOpen, setDepositOpen] = useState(false);
  const busy = relay ? relayTx.busy : nearTx.busy;
  const now = useNow(1000);
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");
  const modes = useRef<HTMLDivElement>(null);
  useIndicator(modes, mode);
  const value = toMicro(input);
  const invalid = input.trim() !== "" && value === null;
  const unit = mode === "buy" ? config.tokenSymbol : "shares";
  const amount = value === null ? "Unavailable" : `${mode === "buy" ? (relay ? formatExact(value) : formatMoney(value)) : formatShares(value)} ${unit}`;
  // The list is polled, so a market that has just passed its close is still marked open until the next read.
  const open = market.status === "open" && nsToMs(market.close_at) > now;

  const { data: held, reload } = usePoll(async () => {
    if (!account) return null;
    const [registered, intents, inMarket, wallet, shares, rules] = await Promise.all([
      isRegistered(account), tokenBalance(account), getBalance(account), relay ? "0" : walletTokenBalance(account), getShares(market.id, account), getMarketConfig(),
    ]);
    return { registered, rules, registrationFee: BigInt(rules.registration_fee), intents: BigInt(intents), inMarket: BigInt(inMarket), wallet: BigInt(wallet), yes: BigInt(shares[0]), no: BigInt(shares[1]) };
  }, [account, market.id, relay], 5000);
  const sellOpen = market.registered && market.outcome === null && nsToMs(market.close_at) > now;
  const available = Boolean(held && (mode === "buy" ? open && held.rules.paused === false
    : sellOpen && held.rules.sells_paused === false));

  // The quote follows the amount a moment after typing stops.
  const [settled, setSettled] = useState<bigint | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), 300);
    return () => clearTimeout(t);
  }, [value]);
  const { data: quoted } = usePoll<Quote | null>(async () => {
    if (!available || settled === null || settled <= 0n) return null;
    return mode === "buy" ? { mode, q: await quoteBuy(market.id, side, settled) } : { mode, q: await quoteSell(market.id, side, settled) };
  }, [market.id, side, mode, available, String(settled)], 5000);
  const quote = settled === value && quoted?.mode === mode ? quoted : null;
  const buyQuote = quote?.mode === "buy" ? quote.q : null;
  const sellQuote = quote?.mode === "sell" ? quote.q : null;
  const sellNet = sellQuote ? BigInt(sellQuote.collateral_out) - BigInt(sellQuote.fee) : 0n;
  const priced = buyQuote ? BigInt(buyQuote.shares_out) > 0n : sellQuote ? BigInt(sellQuote.collateral_out) > 0n : false;

  const mine = held ? (side === "yes" ? held.yes : held.no) : 0n;
  const act = async (call: FunctionCall, done: () => Promise<boolean>, doneMessage: string) => {
    if (relay) {
      if (relayFee === null || !held || held.intents < relayFee) return;
      await actRelayed([relayMarketExit(call)], relayFee, done, doneMessage);
      return;
    }
    if (await run(call, { done, doneMessage })) setInput("");
    await reload();
  };
  const sharesOf = async () => {
    const [yes, no] = await getShares(market.id, account!);
    return side === "yes" ? BigInt(yes) : BigInt(no);
  };
  const actRelayed = async (actions: Action[], shownFee: bigint, done: () => Promise<boolean>, doneMessage: string) => {
    if (await relayTx.run({ submit: () => signRelayed(actions, shownFee), done, doneMessage })) setInput("");
    await Promise.all([reload(), reloadFee()]);
  };
  const withdraw = (balance: bigint) => act(withdrawCall(balance), async () => BigInt(await getBalance(account!)) < balance, "Withdrawn to your Intents account.");

  const relayAction = (h: NonNullable<typeof held>): TicketAction => {
    if (relayFee === null) return { label: "Getting the network fee", disabled: true };
    if (h.intents < relayFee) return { label: "Add funds for network fee", onClick: () => setDepositOpen(true),
      note: `Each action requires ${exact(relayFee)} in your Intents balance for gas.` };
    if (market.status === "resolved") {
      if (h.yes + h.no > 0n) return { label: "Redeem winnings", onClick: () => act(redeemCall(market.id),
        async () => { const shares = await getShares(market.id, account!); return shares.every(n => BigInt(n) === 0n); }, "Redeemed to your market balance.") };
      if (h.inMarket > 0n) return { label: `Withdraw ${money(h.inMarket)}`, onClick: () => withdraw(h.inMarket) };
      return { label: "Market settled", disabled: true };
    }
    if (!available) return { label: nsToMs(market.close_at) <= now ? "Trading closed" : "Trading paused", disabled: true, locked: true };
    if (!value || value <= 0n) return { label: "Enter an amount", disabled: true };
    if (mode === "sell") {
      if (value > mine) return { label: `You hold fewer ${sideName(side)} shares`, disabled: true };
      if (!sellQuote || !priced) return { label: "Getting a sell price", disabled: true };
      const minOut = sellNet * (BPS - SLIPPAGE_BPS) / BPS;
      return { label: `Sell ${sideName(side)}`, onClick: async () => { const before = await sharesOf();
        await act(sellCall(market.id, side, value, minOut), async () => (await sharesOf()) < before, `Sold ${sideName(side)} shares.`); } };
    }
    const payloads = h.registered ? 1n : 2n;
    const needed = value + h.registrationFee * (h.registered ? 0n : 1n) + relayFee * payloads;
    if (needed > h.intents) {
      return config.network === "mainnet"
        ? { label: "Add funds", onClick: () => setDepositOpen(true), note: `This buy needs ${exact(needed)} in your Intents account, including ${exact(relayFee * payloads)} in network fees${h.registered ? "" : ` and ${exact(h.registrationFee)} to open your market account`}.` }
        : { label: `Not enough ${config.tokenSymbol}`, disabled: true };
    }
    if (!buyQuote || !priced) return { label: priced ? "Getting a price" : "Amount not available", disabled: true };
    const minShares = minSharesWithSlippage(BigInt(buyQuote.shares_out), SLIPPAGE_BPS);
    const buy: Action = { to: config.marketId, amount: value, msg: buyMessage(market.id, side, minShares) };
    const register: Action = { to: config.marketId, amount: h.registrationFee, msg: "register" };
    return { label: `Buy ${sideName(side)}`, onClick: async () => {
      const before = await sharesOf();
      await actRelayed(h.registered ? [buy] : [register, buy], relayFee, async () => (await sharesOf()) > before, `Bought ${sideName(side)} shares.`);
    } };
  };

  let action: TicketAction;
  if (!account) action = { label: "Connect wallet", onClick: openConnect, disabled: !walletAvailable };
  else if (!held) action = { label: "Loading your account", disabled: true };
  else if (relay) action = relayAction(held);
  else if (market.status === "resolved") {
    if (held.yes + held.no > 0n) action = { label: "Redeem winnings", onClick: () => act(redeemCall(market.id), async () => (await sharesOf()) === 0n, "Redeemed. Withdraw the balance to move it to your Intents account.") };
    else if (held.inMarket > 0n) action = { label: `Withdraw ${money(held.inMarket)}`, onClick: () => withdraw(held.inMarket) };
    else action = { label: "Market settled", disabled: true, locked: true };
  } else if (!available) action = { label: nsToMs(market.close_at) <= now ? "Trading closed"
    : mode === "sell" ? "Selling paused" : "Buying paused", disabled: true, locked: true };
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
        {!relay && <div><dt>In your wallet</dt><dd className="num">{money(held.wallet)}</dd></div>}
        {relay && <div><dt>Network fee</dt><dd className="num">{relayFee === null ? "Not available yet" : exact(relayFee * (held.registered ? 1n : 2n))}</dd></div>}
        {relay && !held.registered && <div><dt>Opens your market account</dt><dd className="num">{exact(held.registrationFee)}</dd></div>}
        {relay && mode === "buy" && relayFee !== null && value !== null && value > 0n && <div><dt>Total you sign for</dt><dd className="num">{exact(value + relayFee * (held.registered ? 1n : 2n) + (held.registered ? 0n : held.registrationFee))}</dd></div>}
        <div><dt>Your shares</dt><dd className="num">{formatShares(held.yes)} Yes, {formatShares(held.no)} No</dd></div>
        {held.inMarket > 0n && <div><dt>Ready to withdraw</dt><dd className="num">{money(held.inMarket)}</dd></div>}
      </>}
    </dl>
    {!relay && <TransactionNotice tx={nearTx} />}
    {relay && <RelayNotice state={relayTx.state} recheck={async () => { if (await relayTx.recheck()) setInput(""); await reload(); }} />}
    <Button size="lg" onClick={action.onClick} disabled={action.disabled || busy} aria-describedby="trading-status">{action.locked && <Lock size={17} />}{action.label}</Button>
    {relay && config.network === "mainnet" && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDepositOpen(true)}>Deposit {config.tokenSymbol}</Button>}
    {held && held.inMarket > 0n && market.status !== "resolved" && <Button variant="secondary" size="sm" disabled={busy || (relay && (relayFee === null || held.intents < relayFee))} onClick={() => withdraw(held.inMarket)}>Withdraw {money(held.inMarket)}</Button>}
    <p id="trading-status" className="ticket-note">{action.note ?? (relay
      ? `Your wallet asks you to sign a message, not a transaction, and we pay the gas for the fee shown. A buy accepts up to ${Number(SLIPPAGE_BPS) / 100}% price movement.`
      : `Your wallet asks you to confirm each step. A buy or sell accepts up to ${Number(SLIPPAGE_BPS) / 100}% price movement.`)}</p>
    {depositOpen && identity && <DepositDialog identity={identity} onClose={() => { setDepositOpen(false); void reload(); }} />}
  </aside>;
}
