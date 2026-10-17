"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Notice, StateBadge } from "@/components/ui";
import type { Pt } from "@/components/PriceChart";
import { MarketOutcomeChart } from "@/components/MarketOutcomeChart";
import { ProbBar } from "@/components/MarketCard";
import { RulesBlock } from "@/components/RulesBlock";
import { Resolution } from "@/components/Resolution";
import { Sigil } from "@/components/Sigil";
import { TradeTicket } from "@/components/TradeTicket";
import { config } from "@/lib/config";
import { formatDateTime, formatMoney, nsToMs } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { getCase, getHistory, getMarket } from "@/lib/market";
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

  if (!/^\d+$/.test(id)) return <p className="mt-10">This market does not exist. <Link href="/">All markets</Link></p>;
  if (loading && !data) return <p className="mt-10 text-muted">Loading market</p>;
  if (error && !data) return <Notice tone="danger">Could not load this market. Check your connection.</Notice>;
  if (!data?.market) return <p className="mt-10">This market does not exist. <Link href="/">All markets</Link></p>;

  const m = data.market;
  const done = m.status === "resolved";
  const yes = pct(m.price_yes);
  const first = data.points[0]?.p;
  const delta = first === undefined ? 0 : Math.round(yes - first);

  return (
    <div className="pt-8">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Link href="/" className="no-underline hover:text-fg">Markets</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/?cat=${categoryOf(m)}`} className="no-underline hover:text-fg">{labelOf(m.category, m.subcategory).category}</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/?cat=${categoryOf(m)}&sub=${m.subcategory}`} className="text-fg no-underline hover:underline">{labelOf(m.category, m.subcategory).sub}</Link>
      </nav>
      <div className="market-detail-layout mt-5 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <header className="rise flex items-start gap-5">
            <Sigil hash={m.rule_hash} className="hidden h-24 w-24 shrink-0 rounded-lg border border-border bg-canvas sm:block" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
                <StateBadge status={m.status} caseStage={data.stage} />
                <span>Closes <span className="num">{formatDateTime(m.close_at)}</span></span>
                <span><span className="num">{formatMoney(m.locked)}</span> {config.tokenSymbol} in play</span>
                {m.outcome && <span className="text-fg">Result: {resultWord(m)}</span>}
              </div>
              <h1 className="display mb-0 mt-4 text-[2.5rem] leading-[2.625rem] sm:text-[3.5rem] sm:leading-[3.5rem]">{m.title}</h1>
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
                  {delta} pts since the market opened
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
