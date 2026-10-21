import Link from "next/link";
import type { MarketView } from "@/lib/market";
import type { Pt } from "./PriceChart";
export function RecentPrices({ markets, histories }: { markets: MarketView[]; histories: Record<string, Pt[]> }) {
  const updates = markets.flatMap(m => (histories[m.id] ?? []).slice(1).map((point, i) => ({ market:m, point, previous:histories[m.id][i].p })))
    .sort((a,b) => b.point.at - a.point.at).slice(0,4);
  return <section className="recent-prices" aria-label="Recent price updates">
    <div className="recent-prices-head"><h2 className="section-title">Featured price moves</h2><p>Changes recorded in the featured markets.</p></div>
    {updates.length ? <ul>{updates.map(({market,point,previous},i) => {
      const from = Math.round(previous), to = Math.round(point.p);
      const dir = to > from ? "up" : to < from ? "down" : "flat";
      return <li key={`${market.id}-${point.at}-${i}`} className="enter" style={{ "--i": i } as React.CSSProperties}><Link href={`/market?id=${market.id}`}>
        <span className="recent-title">{market.title}</span>
        <span className="recent-move num" data-dir={dir}><span>{from}%</span><span aria-hidden="true" className="recent-arrow">→</span><span className="sr-only">to</span><b>{to}%</b> Yes</span>
        <time dateTime={new Date(point.at).toISOString()}>{new Date(point.at).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</time>
      </Link></li>;
    })}</ul> : <p className="recent-empty">Price changes will appear here when markets trade.</p>}
  </section>;
}
