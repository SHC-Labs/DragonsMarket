"use client";

import { useRef, useState } from "react";
import { Button } from "./ui";
import { Lock } from "./icons";
import { useIndicator } from "./useIndicator";
import { config } from "@/lib/config";
import { formatMoney, formatShares, toMicro } from "@/lib/format";
import type { MarketView, Side } from "@/lib/market";

// Integration point: connect quoteBuy/quoteSell and wallet confirmation from
// lib/market.ts once the contract interface and fee rules are finalized.
// Until then this ticket only manages local input. It requests no quotes or transactions.
export function TradeTicket({ market, initialSide = "yes" }: { market: MarketView; initialSide?: Side }) {
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");
  const modes = useRef<HTMLDivElement>(null);
  useIndicator(modes, mode);
  const value = toMicro(input);
  const invalid = input.trim() !== "" && value === null;
  const unit = mode === "buy" ? config.tokenSymbol : "shares";
  const amount = value === null ? "Unavailable" : `${mode === "buy" ? formatMoney(value) : formatShares(value)} ${unit}`;

  return <aside aria-label="Trade ticket" className="ticket" data-side={side}>
    <div className="ticket-head">
      <div ref={modes} role="group" aria-label="Buy or sell" className="segmented ticket-modes">
        {(["buy", "sell"] as const).map(option => <button type="button" key={option} aria-pressed={mode === option}
          onClick={() => { setMode(option); setInput(""); }}
          className="trade-mode-button">{option === "buy" ? "Buy" : "Sell"}</button>)}
      </div>
      {market.status === "resolved" && <span className="ticket-settled">Market settled</span>}
    </div>
    <fieldset className="ticket-outcomes">
      <legend>Outcome</legend>
      {(["yes", "no"] as const).map(option => <label key={option} className="ticket-outcome" data-option={option} data-selected={side === option || undefined}>
        <input type="radio" name="outcome" value={option} checked={side === option} onChange={() => setSide(option)} className="sr-only" />
        <span className="ticket-outcome-name">{option === "yes" ? "Yes" : "No"}</span><span className="num ticket-outcome-price">{Math.round(Number(option === "yes" ? market.price_yes : market.price_no) / 10_000)}¢</span>
      </label>)}
    </fieldset>
    <label htmlFor="amount" className="ticket-label">{mode === "buy" ? "Amount" : "Shares to sell"}</label>
    <div className="trade-amount-field" data-invalid={invalid || undefined}>
      <input id="amount" inputMode="decimal" autoComplete="off" value={input} placeholder="0.00" onChange={e => setInput(e.target.value)} aria-invalid={invalid || undefined} aria-describedby={invalid ? "amount-error trading-status" : "trading-status"} className="num" />
      <span>{unit}</span>
    </div>
    {invalid && <p id="amount-error" role="alert" className="ticket-error">Enter a positive number with up to six decimal places.</p>}
    <dl className="trade-estimates">
      <div><dt>{mode === "buy" ? "Amount entered" : "Shares entered"}</dt><dd className="num">{input.trim() ? amount : "Not entered"}</dd></div>
      <div><dt>{mode === "buy" ? "Estimated shares" : "Estimated return"}</dt><dd>Unavailable</dd></div>
      <div><dt>Fee</dt><dd>Not available yet</dd></div>
    </dl>
    <Button size="lg" disabled aria-describedby="trading-status"><Lock size={17} />Trading coming soon</Button>
    <p id="trading-status" className="ticket-note">Trading isn’t open yet. When it opens, you’ll see prices and fees here before confirming an order.</p>
  </aside>;
}
