import Link from "next/link";
import type { MarketView } from "@/lib/market";
import type { Pt } from "./PriceChart";
export function RecentPrices({ markets, histories }: { markets: MarketView[]; histories: Record<string, Pt[]> }) {
  const updates = markets.flatMap(m => (histories[m.id] ?? []).slice(1).map((point, i) => ({ market:m, point, previous:histories[m.id][i].p })))
    .sort((a,b) => b.point.at - a.point.at).slice(0,4);
  return <section className="recent-prices" aria-label="Recent price updates"><div><h2>Featured price moves</h2><p>Changes recorded in the featured markets.</p></div>{updates.length ? <ul>{updates.map(({market,point,previous},i) => <li key={`${market.id}-${point.at}-${i}`}><Link href={`/market?id=${market.id}`}><span>{market.title}</span><span className="num">{Math.round(previous)}% → {Math.round(point.p)}% Yes</span><time dateTime={new Date(point.at).toISOString()}>{new Date(point.at).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</time></Link></li>)}</ul> : <p>Price changes will appear here when markets trade.</p>}</section>;
}
