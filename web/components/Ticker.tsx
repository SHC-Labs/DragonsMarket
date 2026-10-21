"use client";

import Link from "next/link";
import { useState } from "react";
import { Pause, Play } from "./icons";
import { DeltaChip, deltaOf } from "./Featured";
import type { Pt } from "./PriceChart";
import { pct } from "@/lib/probability";
import type { MarketView } from "@/lib/market";

// The tape: every open market's Yes price running under the header, like a trading floor's board.
// The second copy only makes the loop seamless, so it is hidden from assistive tech and keyboard focus.
export function Ticker({ markets, histories }: { markets: MarketView[]; histories: Record<string, Pt[]> }) {
  const [paused, setPaused] = useState(false);
  const open = markets.filter(m => m.status === "open");
  if (open.length < 3) return null;
  const items = (copy: boolean) => open.map(m => {
    const yes = pct(m.price_yes);
    const points = histories[m.id] ?? [];
    return <li key={`${copy ? "b" : "a"}-${m.id}`}>
      <Link href={`/market?id=${m.id}`} tabIndex={copy ? -1 : undefined}>
        <span className="tape-title">{m.title.replace(/^Will (the )?/, "").replace(/\?$/, "")}</span>
        <span className="tape-price num">{yes}¢</span>
        {points.length > 1 && <DeltaChip delta={deltaOf(points, yes)} />}
      </Link>
    </li>;
  });
  return <section className="tape" aria-label="Yes prices of open markets" data-paused={paused || undefined} style={{ "--tape-items": open.length } as React.CSSProperties}>
    <div className="tape-viewport">
      <ul className="tape-track">{items(false)}</ul>
      <ul className="tape-track" aria-hidden="true" inert>{items(true)}</ul>
    </div>
    <button type="button" className="tape-toggle" aria-label={paused ? "Play the price tape" : "Pause the price tape"} onClick={() => setPaused(p => !p)}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
  </section>;
}
