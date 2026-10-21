"use client";

import { useState, ViewTransition } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Notice, SplitMeter, StateBadge } from "@/components/ui";
import type { Pt } from "@/components/PriceChart";
import { MarketOutcomeChart } from "@/components/MarketOutcomeChart";
import { CountUp } from "@/components/CountUp";
import { RulesBlock } from "@/components/RulesBlock";
import { Resolution } from "@/components/Resolution";
import { MarketSeal } from "@/components/MarketSeal";
import { TradeTicket } from "@/components/TradeTicket";
import { Clock, Coin } from "@/components/icons";
import { config } from "@/lib/config";
import { formatDateTime, formatMoney, nsToMs } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { getCase, getHistory, getMarket, isMarketListed, listedMarket, listedStage } from "@/lib/market";
import { pct, resultWord } from "@/lib/probability";
import { categoryOf, labelOf } from "@/lib/categories";

export function MarketView() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const initialSide = params.get("side") === "no" ? "no" : "yes";
  const [scrub, setScrub] = useState<Pt | null>(null);
  const { data, error, loading } = usePoll(
    async () => {
      const market = await getMarket(id);
      if (!market) return { market, stage: null, points: [] as Pt[] };
      const stage = market.status === "closed" ? (await getCase(id))?.stage ?? null : null;
      const points = (await getHistory(id)).map((h) => ({ at: nsToMs(h.at), p: h.price_yes / 10_000 }));
      return { market, stage, points };
    },
    [id],
    5000,
  );
  // Opened from the list: draw the header from the list's copy at once (so the question can morph across), then the fresh read replaces it.
  const cached = !data && !error ? listedMarket(id) : null;
  const view = data ?? (cached ? { market: cached, stage: listedStage(id), points: [] as Pt[] } : null);
  const pending = !data;

  if (!/^\d+$/.test(id)) return <PageHeader title="Market unavailable" description="This market does not exist." actions={<Link href="/">Browse markets</Link>} />;
  if (loading && !view) return <><h1 className="sr-only">Market</h1><p role="status" className="sr-only">Loading market</p><MarketSkeleton /></>;
  if (error && !data) return <><PageHeader title="Market unavailable" actions={<Link href="/">Browse markets</Link>} /><Notice tone="danger">Could not load this market. Check your connection.</Notice></>;
  if (!view?.market) return <PageHeader title="Market unavailable" description="This market does not exist." actions={<Link href="/">Browse markets</Link>} />;

  const m = view.market;
  if (!isMarketListed(m)) return <PageHeader title="Market unavailable" description="This market is not ready for trading." actions={<Link href="/">Browse available markets</Link>} />;
  const done = m.status === "resolved";
  const yes = pct(m.price_yes);
  const first = view.points[0]?.p;
  const delta = first === undefined ? 0 : Math.round(yes - first);
  const labels = labelOf(m.category, m.subcategory);

  return (
    <div className="market-detail-page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link href="/">Markets</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/?cat=${categoryOf(m)}`}>{labels.category}</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/?cat=${categoryOf(m)}&sub=${m.subcategory}`} aria-current="page">{labels.sub}</Link>
      </nav>
      <div className="market-detail-layout">
        <header className="market-detail-header">
          <MarketSeal hash={m.rule_hash} id={m.id} className="detail-seal" />
          <div className="min-w-0">
            <div className="market-detail-meta">
              <StateBadge status={m.status} caseStage={view.stage} />
              <span><Clock size={15} />Closes <span className="num">{formatDateTime(m.close_at)}</span></span>
              <span><Coin size={15} /><span className="num">{formatMoney(m.locked)}</span> {config.tokenSymbol} in play</span>
              {m.outcome && <span className="market-detail-result">Result: {resultWord(m)}</span>}
            </div>
            <ViewTransition name={`market-title-${m.id}`} share="morph" default="none"><h1 className="market-title">{m.title}</h1></ViewTransition>
          </div>
        </header>

        <section className="price-panel" aria-label="Price">
          <div className="price-panel-head">
            <div className="price-panel-figure">
              {done ? (
                <div className="display price-panel-number">{resultWord(m)}</div>
              ) : (
                <div className="display price-panel-number" data-scrubbing={scrub ? true : undefined}><CountUp value={scrub ? Math.round(scrub.p) : yes} duration={scrub ? 260 : 900} /><span>%</span></div>
              )}
              <div className="price-panel-label" aria-live="off">{done ? "final result" : scrub ? <>chance of Yes on <time className="num" dateTime={new Date(scrub.at).toISOString()}>{new Date(scrub.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time></> : "chance of Yes"}</div>
            </div>
            {!done && view.points.length > 1 && (
              <div className="price-panel-delta num" data-dir={delta > 0 ? "up" : delta < 0 ? "down" : "flat"}>
                {delta >= 0 ? "+" : ""}
                {delta} pts over the available history
              </div>
            )}
          </div>
          {done ? <div className="price-panel-settled" aria-hidden="true" /> : <SplitMeter yes={yes} labels size="lg" />}
          <div className="price-panel-chart">
            {pending ? <div className="skeleton chart-skeleton" aria-hidden="true" /> : <MarketOutcomeChart points={view.points} onActive={done ? undefined : setScrub} />}
          </div>
        </section>

        <div className="market-ticket-slot">
          <TradeTicket market={m} initialSide={initialSide} />
        </div>

        <div className="market-detail-body">
          <RulesBlock market={m} />
          <Resolution market={m} />
        </div>
      </div>
    </div>
  );
}

function MarketSkeleton() {
  return <div className="market-detail-page" aria-hidden="true">
    <div className="market-detail-layout">
      <div className="market-detail-header"><div className="skeleton market-skeleton-icon" /><div className="market-skeleton-title"><span className="skeleton-line" /><span className="skeleton-line" /></div></div>
      <div className="skeleton market-skeleton-price" />
      <div className="market-ticket-slot"><div className="skeleton market-skeleton-ticket" /></div>
    </div>
  </div>;
}
