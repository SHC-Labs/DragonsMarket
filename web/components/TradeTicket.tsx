"use client";

import { useState } from "react";
import { Button } from "./ui";
import { PowerUpVisual, usePowerUp } from "./PowerUp";
import { config } from "@/lib/config";
import { formatMoney, formatShares, toMicro } from "@/lib/format";
import type { MarketView, Side } from "@/lib/market";

function OutcomeOption({ option, selected, price, onSelect }: { option: Side; selected: boolean; price: number; onSelect: () => void }) {
  const effect = usePowerUp();
  return <label {...effect} data-selected={selected} className={`trade-outcome trade-outcome-${option} power-up-control power-up-target flex cursor-pointer items-center justify-between rounded-md border px-3 py-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus`}>
    <PowerUpVisual />
    <input type="radio" name="outcome" value={option} checked={selected} onChange={onSelect} className="sr-only" />
    <span className="trade-outcome-label"><span className="trade-outcome-check" aria-hidden="true">{selected ? "✓" : ""}</span>{option === "yes" ? "Yes" : "No"}</span><span className="trade-outcome-price num">{price}¢</span>
  </label>;
}

// Integration point: connect quoteBuy/quoteSell and wallet confirmation from
// lib/market.ts once the contract interface and fee rules are finalized.
// Until then this ticket only manages local input. It requests no quotes or transactions.
export function TradeTicket({ market, initialSide = "yes" }: { market: MarketView; initialSide?: Side }) {
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");
  const value = toMicro(input);
  const invalid = input.trim() !== "" && value === null;
  const unit = mode === "buy" ? config.tokenSymbol : "shares";
  const amount = value === null ? "Unavailable" : `${mode === "buy" ? formatMoney(value) : formatShares(value)} ${unit}`;

  return <aside aria-label="Trade ticket" className="rounded-md border border-border bg-raised p-4">
    <div role="group" aria-label="Buy or sell" className="mb-4 flex gap-4">
      {(["buy", "sell"] as const).map(option => <button type="button" key={option} aria-pressed={mode === option}
        onClick={() => { setMode(option); setInput(""); }}
        className={`trade-mode-button num text-sm uppercase tracking-[0.12em] ${mode === option ? "text-fg underline underline-offset-8" : "text-muted"}`}>{option}</button>)}
    </div>
    <fieldset className="m-0 mb-4 grid grid-cols-2 gap-2 border-0 p-0">
      <legend className="mb-2 text-sm text-muted">Outcome</legend>
      {(["yes", "no"] as const).map(option => <OutcomeOption key={option} option={option} selected={side === option}
        onSelect={() => setSide(option)} price={Math.round(Number(option === "yes" ? market.price_yes : market.price_no) / 10_000)} />)}
    </fieldset>
    <label htmlFor="amount" className="mb-1 block text-sm text-muted">{mode === "buy" ? "Amount" : "Shares to sell"}</label>
    <div className="trade-amount-field flex min-h-11 items-center gap-2 rounded-md border border-input bg-canvas px-3">
      <input id="amount" inputMode="decimal" autoComplete="off" value={input} placeholder="0.00" onChange={e => setInput(e.target.value)} aria-invalid={invalid || undefined} aria-describedby={invalid ? "amount-error trading-status" : "trading-status"} className="num min-w-0 flex-1 bg-transparent py-2 text-xl text-fg outline-none placeholder:text-muted" />
      <span className="text-sm text-muted">{unit}</span>
    </div>
    {invalid && <p id="amount-error" role="alert" className="mt-2 text-sm text-danger">Enter a positive number with up to six decimal places.</p>}
    <dl className="trade-estimates my-4 text-sm">
      <div><dt>{mode === "buy" ? "Amount entered" : "Shares entered"}</dt><dd className="num">{input.trim() ? amount : "Not entered"}</dd></div>
      <div><dt>{mode === "buy" ? "Estimated shares" : "Estimated return"}</dt><dd>Unavailable</dd></div>
      <div><dt>Fee</dt><dd>Not available yet</dd></div>
    </dl>
    <Button size="lg" disabled aria-describedby="trading-status">Trading coming soon</Button>
    <p id="trading-status" className="mb-0 mt-3 text-sm text-muted">Trading isn’t open yet. When it opens, you’ll see prices and fees here before confirming an order.</p>
  </aside>;
}
