"use client";

import Link from "next/link";
import { MarketOutcomeChart } from "./MarketOutcomeChart";
import { type Pt } from "./PriceChart";
import { SplitMeter, StateBadge } from "./ui";
import { CountUp } from "./CountUp";
import { MarketIcon } from "./MarketIcon";
import { MarketSeal } from "./MarketSeal";
import { Embers } from "./Embers";
import { ArrowRight } from "./icons";
import { labelOf } from "@/lib/categories";
import { config } from "@/lib/config";
import { formatDateTime, formatMoney } from "@/lib/format";
import { pct, resultWord } from "@/lib/probability";
import type { MarketView } from "@/lib/market";

export const deltaOf = (points: Pt[], now: number): number => (points.length > 1 ? Math.round(now - points[0].p) : 0);

export function DeltaChip({ delta, unit = false }: { delta: number; unit?: boolean }) {
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return <span className="delta-chip num" data-dir={dir}>
    <span aria-hidden="true">{dir === "up" ? "▲" : dir === "down" ? "▼" : "•"}</span>
    <span className="sr-only">{dir === "up" ? "Up" : dir === "down" ? "Down" : "Unchanged"}</span>
    {Math.abs(delta)}{unit ? " pts" : ""}
  </span>;
}

export function FeaturedMarket({ market: m, stage, points }: { market: MarketView; stage: string | null; points: Pt[] }) {
  const done = m.status === "resolved";
  const yes = pct(m.price_yes);
  const category = labelOf(m.category, m.subcategory);
  return <section data-testid="featured-market" className="spotlight-card featured-panel" aria-label="Featured market">
    <Embers height={0.6} intensity={1.35} />
    <MarketSeal hash={m.rule_hash} id={m.id} className="spotlight-seal" />
    <div className="spotlight-copy">
      <div className="spotlight-meta"><MarketIcon category={m.category} sub={m.subcategory} small /><span>{category.category} · {category.sub}</span><StateBadge status={m.status} caseStage={stage} /></div>
      <h2 className="spotlight-title"><Link href={`/market?id=${m.id}`}>{m.title}</Link></h2>
      {done ? <p className="spotlight-result">Result: <strong>{resultWord(m)}</strong></p> : <>
        <div className="spotlight-figure">
          <span className="display spotlight-number"><CountUp value={yes} /><small>%</small></span>
          <span className="spotlight-figure-label">chance of Yes{points.length > 1 && <DeltaChip delta={deltaOf(points, yes)} unit />}</span>
        </div>
        <SplitMeter yes={yes} size="lg" />
        <div className="feature-outcomes">{(["yes", "no"] as const).map(side => <Link key={side} href={`/market?id=${m.id}&side=${side}`} className={`feature-outcome-row feature-outcome-${side}`}>
          <span className="feature-outcome-side">{side === "yes" ? "Yes" : "No"}</span><strong className="num">{side === "yes" ? yes : 100 - yes}%</strong><small>{m.status === "open" ? "Buy" : "View"}<ArrowRight size={13} /></small>
        </Link>)}</div>
      </>}
      <div className="feature-card-footer"><span><span className="num">{formatMoney(m.locked)}</span> {config.tokenSymbol} in play</span><span>Closes <span className="num">{formatDateTime(m.close_at)}</span></span></div>
    </div>
    <div className="spotlight-chart"><MarketOutcomeChart points={points} compact /></div>
  </section>;
}

function Row({ market: m, rank, points, right }: { market: MarketView; rank: number; points: Pt[]; right?: React.ReactNode }) {
  const yes = pct(m.price_yes);
  return (
    <li>
      <Link href={`/market?id=${m.id}`} className="pulse-row">
        <span className="pulse-rank num">{rank}</span>
        <span className="pulse-title">{m.title}</span>
        {right ?? (
          <span className="pulse-figures">
            <span className="num pulse-chance">{yes}%</span>
            <DeltaChip delta={deltaOf(points, yes)} />
          </span>
        )}
      </Link>
    </li>
  );
}

export function Trending({ markets, histories, title = "Trending" }: { markets: MarketView[]; histories: Record<string, Pt[]>; title?: string }) {
  const open = markets.filter((m) => m.status === "open");
  const byVolume = [...open].sort((a, b) => (BigInt(b.locked) > BigInt(a.locked) ? 1 : BigInt(b.locked) < BigInt(a.locked) ? -1 : 0)).slice(0, 3);
  const closing = [...open].sort((a, b) => (BigInt(a.close_at) > BigInt(b.close_at) ? 1 : -1)).slice(0, 2);
  return (
    <aside className="trending-panel" aria-label="Trending">
      <h2>{title}</h2>
      <ol className="pulse-list">
        {byVolume.map((m, i) => <Row key={m.id} market={m} rank={i + 1} points={histories[m.id] ?? []} />)}
        {byVolume.length === 0 && <li className="pulse-empty">No open markets.</li>}
      </ol>
      {closing.length > 0 && (
        <>
          <h3>Closing soon</h3>
          <ul className="pulse-list">
            {closing.map((m, i) => (
              <Row key={m.id} market={m} rank={i + 1} points={[]} right={<span className="num pulse-date">{formatDateTime(m.close_at)}</span>} />
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
