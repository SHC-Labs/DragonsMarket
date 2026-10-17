"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";
import { useWatchlist } from "@/lib/watchlist";
import { RecentPrices } from "@/components/RecentPrices";
import { Threshold } from "@/components/Threshold";
import { Controls } from "@/components/Controls";
import { FeaturedCarousel } from "@/components/FeaturedCarousel";
import { Trending } from "@/components/Featured";
import { HowItWorks } from "@/components/HowItWorks";
import { MarketGrid } from "@/components/MarketGrid";
import type { Pt } from "@/components/PriceChart";
import { Button, Notice } from "@/components/ui";
import { countMarkets, findCategory } from "@/lib/categories";
import { config, isConfigured } from "@/lib/config";
import { filterMarkets, filtersFromQuery, sortMarkets, statusOf, type Status } from "@/lib/filters";
import { formatMoney, nsToMs } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { getCase, getHistory, listMarkets } from "@/lib/market";

async function load() {
  const markets = await listMarkets();
  const stages: Record<string, string | null> = {};
  const histories: Record<string, Pt[]> = {};
  await Promise.all(
    markets.map(async (m) => {
      if (m.status === "closed") stages[m.id] = (await getCase(m.id))?.stage ?? null;
      histories[m.id] = (await getHistory(m.id)).map((h) => ({ at: nsToMs(h.at), p: h.price_yes / 10_000 }));
    }),
  );
  return { markets, stages, histories };
}

export function HomeView({ watchlistOnly = false }: { watchlistOnly?: boolean }) {
  const { account, walletAvailable, openConnect } = useWallet();
  const { data, error, loading, reload } = usePoll(load, [], 8000);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { ids: watchedIds } = useWatchlist();
  const watching = watchlistOnly || params.get("watching") === "true";
  const f = filtersFromQuery((k) => params.get(k));

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

  const counts = useMemo(() => countMarkets(data?.markets ?? []), [data]);
  const statusCounts = useMemo(() => {
    const scoped = filterMarkets(data?.markets ?? [], { ...f, status: "all", q: typed });
    const c: Record<Status, number> = { all: scoped.length, open: 0, resolving: 0, final: 0 };
    scoped.forEach((m) => c[statusOf(m)]++);
    return c;
  }, [data, f.cat, f.sub, typed]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => sortMarkets(filterMarkets(data?.markets ?? [], { ...f, q: typed }).filter(m => !watching || watchedIds.includes(m.id)), f.sort), [data, f.cat, f.sub, f.status, f.sort, typed, watching, watchedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  if (watching && !account) return <section className="py-10"><p className="ritual-label">Watchlist</p><h1 className="text-3xl">Keep an eye on your markets.</h1><p className="my-4 max-w-xl text-muted">Connect your wallet to save markets and find them here. Each wallet has its own list on this browser.</p><Button onClick={openConnect} disabled={!walletAvailable}>Connect wallet</Button><Link href="/" className="ml-5 text-council">Browse markets</Link></section>;
  if (!isConfigured) return <Threshold />;
  if (loading && !data) return <><Threshold /><p role="status" className="text-muted">Loading markets</p><div className="market-loading" aria-hidden="true"><div /><div /><div /></div></>;
  if (error && !data) {
    return (
      <div className="mt-10">
        <Threshold />
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
    <>
      {watching ? <section className="workspace-intro"><div><p className="ritual-label">Watchlist</p><h1 className="text-3xl">Markets you’re following.</h1><p>Saved for <span className="break-all">{account}</span> on this browser. Switch wallets to see a different list.</p></div></section> : <><h1 className="sr-only">Prediction markets</h1><Threshold /></>}


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

      <div className="market-list-tabs" role="group" aria-label="Market list"><button type="button" aria-pressed={!watching} onClick={()=>watchlistOnly ? router.push("/") : update({watching:null})}>All markets</button><button type="button" aria-pressed={watching} onClick={()=>router.push("/watchlist")}>Watchlist <span className="num">{data.markets.filter(m=>watchedIds.includes(m.id)).length}</span></button>{watching && <span>Saved for your connected wallet on this browser.</span>}</div>
      <section id="markets" className="mt-10 scroll-mt-32" aria-label="Markets">
        <h2 className="display m-0 text-[2rem] leading-9">
          {filtered ? `${shown.length} ${shown.length === 1 ? "market" : "markets"}${where ? ` in ${where}` : ""}` : watching ? "Your watchlist" : "Find a market"}
        </h2>

        {shown.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-border p-10 text-center text-muted">
            {watching && watchedIds.length === 0 ? "Nothing saved yet. Tap Watch on a market to keep it here." : data.markets.length === 0 ? "No markets yet." : where && !typed.trim() ? `No markets in ${where} yet.` : "No markets match that."}{" "}
            {data.markets.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => { setTyped(""); lastSynced.current = ""; router.replace(pathname, { scroll: false }); }}>Clear filters</Button>
            )}
          </div>
        ) : (
          <MarketGrid key={`${f.cat}:${f.sub}:${f.status}:${f.sort}:${typed}:${watching}:${account}`} markets={shown} stages={data.stages} histories={data.histories} />
        )}
      </section>

      {!watching && <RecentPrices markets={data.markets} histories={data.histories} />}
      <div className="mt-10"><HowItWorks /></div>
    </>
  );
}
