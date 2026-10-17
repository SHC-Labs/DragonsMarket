"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { MarketOutcomeChart } from "./MarketOutcomeChart";
import { type Pt } from "./PriceChart";
import { StateBadge } from "./ui";
import { MarketIcon } from "./MarketIcon";
import { labelOf } from "@/lib/categories";
import { config } from "@/lib/config";
import { formatDateTime, formatMoney } from "@/lib/format";
import { pct, resultWord } from "@/lib/probability";
import type { MarketView } from "@/lib/market";

export const deltaOf = (points: Pt[], now: number): number => (points.length > 1 ? Math.round(now - points[0].p) : 0);

export function DeltaChip({ delta }: { delta: number }) {
  if (delta === 0) return <span className="num text-xs text-muted">0</span>;
  return <span className={`num text-xs ${delta > 0 ? "text-yes" : "text-no"}`}>{delta > 0 ? "▲" : "▼"} {Math.abs(delta)}</span>;
}

export function FeaturedMarket({ market: m, stage, points }: { market: MarketView; stage: string | null; points: Pt[] }) {
  const done = m.status === "resolved";
  const yes = pct(m.price_yes);
  const category=labelOf(m.category,m.subcategory);
  return <section data-testid="featured-market" className="featured-panel" aria-label="Featured market">
    <div className="feature-market-title"><MarketIcon category={m.category} sub={m.subcategory}/><div><p>{category.category} · {category.sub}</p><h2><Link href={`/market?id=${m.id}`}>{m.title}</Link></h2></div><StateBadge status={m.status} caseStage={stage}/></div>
    <div className="feature-outcome-layout"><div className="feature-outcomes">{done ? <p className="featured-price">Result: {resultWord(m)}</p> : <>{(["yes","no"] as const).map(side=><Link key={side} href={`/market?id=${m.id}&side=${side}`} className={`feature-outcome-row feature-outcome-${side}`}><span><i className={`outcome-dot outcome-${side}`}/>{side==="yes"?"Yes":"No"}</span><strong>{side==="yes"?yes:100-yes}%</strong><small>{m.status==="open"?"Buy ↗":"View ↗"}</small></Link>)}</>}</div><MarketOutcomeChart points={points} compact/></div>
    <div className="feature-card-footer"><span>{formatMoney(m.locked)} {config.tokenSymbol} in play</span><span>Closes {formatDateTime(m.close_at)}</span></div>
  </section>;
}

function Row({ market: m, rank, points, right }: { market: MarketView; rank: number; points: Pt[]; right?: React.ReactNode }) {
  const yes = pct(m.price_yes);
  return (
    <li>
      <Link href={`/market?id=${m.id}`} className="flex items-center gap-3 rounded-md px-2 py-2.5 no-underline transition-colors duration-[120ms] hover:bg-raised">
        <span className="num w-5 shrink-0 text-center text-xs text-muted">{rank}</span>
        <span className="min-w-0 flex-1 truncate text-sm">{m.title}</span>
        {right ?? (
          <span className="flex shrink-0 items-center gap-2">
            <DeltaChip delta={deltaOf(points, yes)} />
            <span className="num w-10 text-right text-sm">{yes}%</span>
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
    <aside className="trending-panel" style={{ "--i": 2 } as CSSProperties} aria-label="Trending">
      <h2 className="display mb-1 mt-0 text-[1.75rem] leading-8">{title}</h2>
      <ol className="m-0 list-none p-0">
        {byVolume.map((m, i) => <Row key={m.id} market={m} rank={i + 1} points={histories[m.id] ?? []} />)}
        {byVolume.length === 0 && <li className="px-2 py-2 text-sm text-muted">No open markets.</li>}
      </ol>
      {closing.length > 0 && (
        <>
          <h3 className="mb-1 mt-6 text-xs font-medium uppercase tracking-[0.12em] text-muted">Closing soon</h3>
          <ul className="m-0 list-none p-0">
            {closing.map((m, i) => (
              <Row key={m.id} market={m} rank={i + 1} points={[]} right={<span className="num shrink-0 text-xs text-muted">{formatDateTime(m.close_at)}</span>} />
            ))}
          </ul>
        </>
      )}

    </aside>
  );
}
