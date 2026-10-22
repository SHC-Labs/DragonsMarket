"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";
import { useWatchlist } from "@/lib/watchlist";
import { RecentPrices } from "@/components/RecentPrices";
import { Ticker } from "@/components/Ticker";
import { CouncilCall } from "@/components/CouncilCall";
import { AccountEmptyState, PageLandmark } from "@/components/PageHeader";
import { Controls } from "@/components/Controls";
import { FeaturedCarousel } from "@/components/FeaturedCarousel";
import { Trending } from "@/components/Featured";
import { MarketGrid } from "@/components/MarketGrid";
import type { Pt } from "@/lib/history";
import { Button, Notice } from "@/components/ui";
import { Search } from "@/components/icons";
import { useIndicator } from "@/components/useIndicator";
import { countMarkets, findCategory } from "@/lib/categories";
import { config, isConfigured } from "@/lib/config";
import { filterMarkets, filtersFromQuery, sortMarkets, statusOf, type Status } from "@/lib/filters";
import { formatMoney, nsToMs } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { getCase, getHistory, listMarkets, isMarketListed, rememberStages } from "@/lib/market";

// Share in-flight reads (including React development remounts) and recent history.
const historyReads = new Map<string, { expires: number; promise: Promise<Pt[]> }>();
function featuredHistory(id: string): Promise<Pt[]> {
  const key = `${config.rpcUrl}:${config.marketId}:${id}`;
  const cached = historyReads.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = getHistory(id).then(rows => rows.map(h => ({ at: nsToMs(h.at), p: h.price_yes / 10_000 })));
  historyReads.set(key, { expires: Date.now() + 30000, promise });
  promise.catch(() => historyReads.delete(key));
  if (historyReads.size > 100) historyReads.delete(historyReads.keys().next().value!);
  return promise;
}

async function load(category: string, subcategory: string) {
  const markets = (await listMarkets()).filter(isMarketListed);
  const stages: Record<string, string | null> = {};
  const histories: Record<string, Pt[]> = {};
  const scope = markets.filter(m => m.status === "open" && (!category || m.category === category) && (!subcategory || m.subcategory === subcategory));
  const featured = sortMarkets(scope, "volume").slice(0, 5);
  await Promise.all([
    ...markets.filter(m => m.status === "closed").map(async m => { stages[m.id] = (await getCase(m.id))?.stage ?? null; }),
    ...featured.map(async m => {
      try { histories[m.id] = await featuredHistory(m.id); }
      catch { histories[m.id] = []; } // A chart failure must not hide the market list.
    }),
  ]);
  rememberStages(stages);
  return { markets, stages, histories };
}

export function HomeView({ watchlistOnly = false }: { watchlistOnly?: boolean }) {
  const { account, walletAvailable, openConnect } = useWallet();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { ids: watchedIds } = useWatchlist();
  const tabs = useRef<HTMLDivElement>(null);
  const watching = watchlistOnly || params.get("watching") === "true";
  const f = filtersFromQuery((k) => params.get(k));
  const { data, error, loading, reload } = usePoll(() => load(f.cat, f.sub), [f.cat, f.sub], 30000);

  // The URL holds the filters, so a filtered view can be shared, bookmarked and refreshed.
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Typing goes to local state first and reaches the URL a moment later, so the box never fights the router.
  const [typed, setTyped] = useState(f.q);
  const lastSynced = useRef(f.q);
  useEffect(() => {
    if (typed === lastSynced.current) return;
    const t = setTimeout(() => {
      lastSynced.current = typed;
      update({ q: typed || null });
    }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);
  useEffect(() => {
    // Back and forward buttons change the URL; follow them.
    if (f.q !== lastSynced.current) {
      lastSynced.current = f.q;
      setTyped(f.q);
    }
  }, [f.q]);

  useIndicator(tabs, `${watching}:${Boolean(data)}`);
  const counts = useMemo(() => countMarkets(data?.markets ?? []), [data]);
  const statusCounts = useMemo(() => {
    const scoped = filterMarkets(data?.markets ?? [], { ...f, status: "all", q: typed });
    const c: Record<Status, number> = { all: scoped.length, open: 0, resolving: 0, final: 0 };
    scoped.forEach((m) => c[statusOf(m)]++);
    return c;
  }, [data, f.cat, f.sub, typed]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => sortMarkets(filterMarkets(data?.markets ?? [], { ...f, q: typed }).filter(m => !watching || watchedIds.includes(m.id)), f.sort), [data, f.cat, f.sub, f.status, f.sort, typed, watching, watchedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  if (watching && !account) return <div className="page-content"><PageLandmark title="Watchlist" /><AccountEmptyState title="Keep an eye on your markets" description="Connect your wallet and select Watch on any market. This browser keeps a separate list for each wallet." actions={<><Button onClick={openConnect} disabled={!walletAvailable}>Connect wallet</Button><Link href="/">Browse markets</Link></>} /></div>;
  const intro = <PageLandmark title={watching ? "Watchlist" : "Prediction markets"} />;
  if (!isConfigured) return <div className="page-content">{intro}</div>;
  if (loading && !data) return <div className="page-content">{intro}<p role="status" className="sr-only">Loading markets</p><MarketsSkeleton /></div>;
  if (error && !data) {
    return (
      <div className="page-content">
        {intro}
        <Notice tone="danger">
          <span>Could not load markets. Check your connection. </span>
          <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
        </Notice>
      </div>
    );
  }
  if (!data) return null;

  const scope = filterMarkets(data.markets, { cat: f.cat, sub: f.sub, q: "", status: "all" });
  const featuredMarkets = [...scope].filter(m=>m.status==="open").sort((a,b)=>BigInt(a.locked)===BigInt(b.locked)?Number(a.id)-Number(b.id):BigInt(a.locked)>BigInt(b.locked)?-1:1).slice(0,5);
  const locked = data.markets.reduce((sum, m) => sum + BigInt(m.locked), 0n);
  const browsing = !watching && f.status === "all" && typed.trim() === "";
  const where = findCategory(f.cat)?.subs.find((s) => s.id === f.sub)?.label ?? findCategory(f.cat)?.label ?? "";
  const filtered = Boolean(f.cat || f.sub || typed.trim() || f.status !== "all");

  return (
    <div className="page-content">
      {intro}
      {!watching && <Ticker markets={data.markets} histories={data.histories} />}

      {browsing && featuredMarkets.length>0 && (
        <div className="market-spotlight">
          <FeaturedCarousel key={f.cat+f.sub} markets={featuredMarkets} stages={data.stages} histories={data.histories} />
          <Trending markets={scope} histories={data.histories} title={where ? `Trending in ${where}` : "Trending"} />
        </div>
      )}

      <Controls
        query={typed} onQuery={setTyped}
        status={f.status} onStatus={(s) => update({ status: s === "all" ? null : s })} statusCounts={statusCounts}
        sort={f.sort} onSort={(s) => update({ sort: s === "volume" ? null : s })}
        cat={f.cat} sub={f.sub}
        onCategory={(id) => update({ cat: id || null, sub: null })}
        onSub={(id) => update({ sub: id || null })}
        counts={counts}
        stats={{ markets: data.markets.length, locked: formatMoney(locked), symbol: config.tokenSymbol }}
      />

      <div className="market-list-head">
        <div ref={tabs} className="market-list-tabs" role="group" aria-label="Market list"><button type="button" aria-pressed={!watching} onClick={()=>watchlistOnly ? router.push("/") : update({watching:null})}>All markets</button><button type="button" aria-pressed={watching} onClick={()=>router.push("/watchlist")}>Watchlist <span className="count num">{data.markets.filter(m=>watchedIds.includes(m.id)).length}</span></button></div>
        {watching && <span className="market-list-note">Saved for this wallet in this browser.</span>}
      </div>
      <section id="markets" aria-label="Markets">
        <h2 className="section-title markets-heading">
          {filtered ? `${shown.length} ${shown.length === 1 ? "market" : "markets"}${where ? ` in ${where}` : ""}` : watching ? "Your watchlist" : "Find a market"}
        </h2>

        {shown.length === 0 ? (
          <div className="empty-results">
            <span className="empty-results-icon" aria-hidden="true"><Search size={26} variant="Bulk" /></span>
            <p>{watching && watchedIds.length === 0 ? "Your watchlist is empty. Select Watch on a market to save it." : data.markets.length === 0 ? "No markets yet." : where && !typed.trim() ? `No markets in ${where} yet.` : "No markets match your search."}</p>
            {data.markets.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => { setTyped(""); lastSynced.current = ""; router.replace(pathname, { scroll: false }); }}>Clear filters</Button>
            )}
          </div>
        ) : (
          <MarketGrid key={`${f.cat}:${f.sub}:${f.status}:${f.sort}:${typed}:${watching}:${account}`} markets={shown} stages={data.stages} histories={data.histories} />
        )}
      </section>

      {!watching && <RecentPrices markets={data.markets} histories={data.histories} />}
      {!watching && <CouncilCall />}
    </div>
  );
}

function MarketsSkeleton() {
  return <div className="markets-skeleton" aria-hidden="true">
    <div className="market-spotlight"><div className="skeleton markets-skeleton-hero" /><div className="skeleton markets-skeleton-rail" /></div>
    <div className="skeleton markets-skeleton-bar" />
    <div className="markets-skeleton-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton markets-skeleton-card" style={{ "--i": i } as React.CSSProperties}><span className="skeleton-line" /><span className="skeleton-line" /><span className="skeleton-line" /></div>)}</div>
  </div>;
}
