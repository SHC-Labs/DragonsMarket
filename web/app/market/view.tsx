"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Notice, StateBadge } from "@/components/ui";
import type { Pt } from "@/components/PriceChart";
import { MarketOutcomeChart } from "@/components/MarketOutcomeChart";
import { ProbBar } from "@/components/MarketCard";
import { RulesBlock } from "@/components/RulesBlock";
import { Resolution } from "@/components/Resolution";
import { MarketIcon } from "@/components/MarketIcon";
import { TradeTicket } from "@/components/TradeTicket";
import { config } from "@/lib/config";
import { formatDateTime, formatMoney, nsToMs } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { getCase, getHistory, getMarket, isMarketListed } from "@/lib/market";
import { pct, resultWord } from "@/lib/probability";
import { categoryOf, labelOf } from "@/lib/categories";

export function MarketView() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const initialSide = params.get("side") === "no" ? "no" : "yes";
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

  if (!/^\d+$/.test(id)) return <PageHeader title="Market unavailable" description="This market does not exist." actions={<Link href="/">Browse markets</Link>} />;
  if (loading && !data) return <><PageHeader title="Market" /><p role="status" className="text-muted">Loading market</p></>;
  if (error && !data) return <><PageHeader title="Market unavailable" actions={<Link href="/">Browse markets</Link>} /><Notice tone="danger">Could not load this market. Check your connection.</Notice></>;
  if (!data?.market) return <PageHeader title="Market unavailable" description="This market does not exist." actions={<Link href="/">Browse markets</Link>} />;

  const m = data.market;
  if (!isMarketListed(m)) return <PageHeader title="Market unavailable" description="This market is not ready for trading." actions={<Link href="/">Browse available markets</Link>} />;
  const done = m.status === "resolved";
  const yes = pct(m.price_yes);
  const first = data.points[0]?.p;
  const delta = first === undefined ? 0 : Math.round(yes - first);

  return (
    <div className="market-detail-page">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Link href="/" className="no-underline hover:text-fg">Markets</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/?cat=${categoryOf(m)}`} className="no-underline hover:text-fg">{labelOf(m.category, m.subcategory).category}</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/?cat=${categoryOf(m)}&sub=${m.subcategory}`} className="text-fg no-underline hover:underline">{labelOf(m.category, m.subcategory).sub}</Link>
      </nav>
      <div className="market-detail-layout mt-5 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <header className="market-detail-header flex items-start gap-4">
            <div className="hidden shrink-0 sm:block"><MarketIcon category={m.category} sub={m.subcategory} /></div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
                <StateBadge status={m.status} caseStage={data.stage} />
                <span>Closes <span className="num">{formatDateTime(m.close_at)}</span></span>
                <span><span className="num">{formatMoney(m.locked)}</span> {config.tokenSymbol} in play</span>
                {m.outcome && <span className="text-fg">Result: {resultWord(m)}</span>}
              </div>
              <h1 className="page-title mb-0 mt-4">{m.title}</h1>
            </div>
          </header>

          <section className="rise mt-8 rounded-xl border border-border bg-surface/60 p-5 sm:p-7" style={{ "--i": 2 } as React.CSSProperties} aria-label="Price">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex items-end gap-3">
                {done ? (
                  <div className="display text-[6rem] leading-[5.25rem]">{resultWord(m)}</div>
                ) : (
                  <div className="display text-[6.5rem] leading-[5.5rem]">
                    {yes}
                    <span className="text-[3rem] text-muted">%</span>
                  </div>
                )}
                <div className="pb-2 text-sm text-muted">{done ? "final result" : "chance of Yes"}</div>
              </div>
              {!done && data.points.length > 1 && (
                <div className={`num pb-2 text-sm ${delta >= 0 ? "text-yes" : "text-no"}`}>
                  {delta >= 0 ? "+" : ""}
                  {delta} pts over the available history
                </div>
              )}
            </div>
            <div className="mt-5">{done ? <div className="h-1.5 rounded-full bg-border" /> : <ProbBar yes={yes} />}</div>
            <div className="mt-7">
              <MarketOutcomeChart points={data.points} />
            </div>
          </section>

          <RulesBlock market={m} />
          <Resolution market={m} />
        </div>
        <div className="rise lg:sticky lg:top-24" style={{ "--i": 3 } as React.CSSProperties}>
          <TradeTicket market={m} initialSide={initialSide} />
        </div>
      </div>
    </div>
  );
}
