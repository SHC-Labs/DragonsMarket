"use client";

import Link from "next/link";
import type { MarketView } from "@/lib/market";
import { config } from "@/lib/config";
import { formatMoney, shortAccount } from "@/lib/format";
import { useNow, usePoll } from "@/lib/hooks";
import { recentTrades, type Trade } from "@/lib/trades";

function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

function Row({ trade, title, now }: { trade: Trade; title?: string; now: number }) {
  const word = trade.side === "yes" ? "Yes" : "No";
  const body = <>
    <span className="trade-who mono">{shortAccount(trade.account, 20)}</span>
    <span className="trade-what">
      {trade.kind === "buy" ? "bought" : "sold"} <b className="trade-side" data-side={trade.side}>{word}</b>
    </span>
    <span className="trade-amount num">{formatMoney(trade.collateral)} {config.tokenSymbol}</span>
    {title && <span className="trade-title">{title}</span>}
    <time className="trade-time num" dateTime={new Date(trade.at).toISOString()}>{ago(trade.at, now)}</time>
  </>;
  return <li className="trade-row enter" data-side={trade.side}>
    {title ? <Link href={`/market?id=${trade.marketId}`}>{body}</Link> : <div>{body}</div>}
  </li>;
}

/** The latest buys and sells, read from the backend's index of chain events. Shows nothing without a backend. */
export function TradeFeed({ markets, marketId, limit = 6 }: { markets?: MarketView[]; marketId?: string; limit?: number }) {
  const { data, error } = usePoll(() => recentTrades(limit, marketId), [limit, marketId], 3000);
  const now = useNow(1000);
  if (data === null || (error && !data)) return null;
  const titles = new Map(markets?.map((m) => [m.id, m.title]));
  return <section className="trade-feed" data-scope={marketId ? "market" : "all"} aria-label="Latest trades">
    <h2 className="section-title">Latest trades</h2>
    {!data ? <ul aria-hidden="true">{Array.from({ length: 3 }, (_, i) => <li key={i} className="skeleton trade-skeleton" />)}</ul>
      : data.length === 0 ? <p className="text-muted">Trades will appear here as they happen.</p>
        : <ul aria-live="off">{data.map((t) =>
          <Row key={t.key} trade={t} now={now} title={marketId ? undefined : titles.get(t.marketId)} />)}</ul>}
  </section>;
}
