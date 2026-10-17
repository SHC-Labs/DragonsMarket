"use client";

import { useEffect, useRef } from "react";
import { ArrowUpDown, LayoutGrid, Search, X } from "@/components/icons";
import { CATEGORIES, OTHER, findCategory, type Counts } from "@/lib/categories";
import { SORTS, STATUSES, type Sort, type Status } from "@/lib/filters";

interface Props {
  query: string;
  onQuery: (q: string) => void;
  status: Status;
  onStatus: (s: Status) => void;
  statusCounts: Record<Status, number>;
  sort: Sort;
  onSort: (s: Sort) => void;
  cat: string;
  sub: string;
  onCategory: (id: string) => void;
  onSub: (id: string) => void;
  counts: Counts;
  stats: { markets: number; locked: string; symbol: string };
}

const chipBase = "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm transition-colors duration-[120ms]";

export function Controls(p: Props) {
  const input = useRef<HTMLInputElement>(null);

  // Press / anywhere on the page to jump to the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "")) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const shown = [...CATEGORIES, ...(p.counts.byCategory.other ? [OTHER] : [])];
  const active = findCategory(p.cat);
  const subs = active?.subs ?? [];
  const subCounts = p.counts.bySub[p.cat] ?? {};

  return (
    <div className="market-controls z-20 -mx-[var(--gutter)] mt-4 border-b border-border bg-canvas/80 px-[var(--gutter)] pb-3 pt-3 backdrop-blur-xl lg:sticky lg:top-16">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-[36rem]">
          <label htmlFor="search" className="sr-only">Search markets</label>
          <Search className="pointer-events-none absolute left-4 top-1/2 h-[1.1rem] w-[1.1rem] -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            ref={input} id="search" type="search" value={p.query} onChange={(e) => p.onQuery(e.target.value)} autoComplete="off"
            placeholder="Search by question or topic"
            className="h-11 w-full rounded-full border border-input bg-surface/80 pl-11 pr-20 text-sm text-fg outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-muted focus:border-yes/70 focus:shadow-[0_0_0_0.25rem_color-mix(in_oklab,var(--yes)_16%,transparent)] [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
            {p.query ? (
              <button type="button" onClick={() => { p.onQuery(""); input.current?.focus(); }} aria-label="Clear search" className="flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg">
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : (
              <kbd className="num pointer-events-none hidden rounded-md border border-border bg-canvas px-1.5 py-0.5 text-[0.7rem] text-muted [@media(pointer:fine)]:inline-block" aria-hidden="true">/</kbd>
            )}
          </div>
        </div>

        <div role="group" aria-label="Status" className="flex max-w-full overflow-x-auto rounded-full border border-border bg-surface/70 p-1">
          {STATUSES.map((s) => (
            <button
              key={s.id} type="button" aria-pressed={p.status === s.id} onClick={() => p.onStatus(s.id)}
              className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors duration-[120ms] ${p.status === s.id ? "bg-fg text-canvas" : "text-muted hover:text-fg"}`}
            >
              {s.label} <span className={`num text-xs ${p.status === s.id ? "opacity-70" : ""}`}>{p.statusCounts[s.id]}</span>
            </button>
          ))}
        </div>

        <label className="relative flex items-center">
          <span className="sr-only">Sort by</span>
          <ArrowUpDown className="pointer-events-none absolute left-3 h-4 w-4 text-muted" aria-hidden="true" />
          <select
            value={p.sort} onChange={(e) => p.onSort(e.target.value as Sort)}
            className="h-10 cursor-pointer appearance-none rounded-full border border-input bg-surface/80 pl-9 pr-4 text-sm text-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>

        <div className="ml-auto hidden items-center gap-4 text-xs text-muted xl:flex">
          <span><span className="num text-fg">{p.stats.markets}</span> markets</span>
          <span><span className="num text-fg">{p.stats.locked}</span> {p.stats.symbol} in play</span>
        </div>
      </div>

      <div className="mt-3 [mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-1rem),transparent)]">
        <div role="group" aria-label="Category" className="flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button" aria-pressed={p.cat === ""} onClick={() => p.onCategory("")}
            className={`${chipBase} ${p.cat === "" ? "border-fg bg-fg text-canvas" : "border-border bg-surface/50 text-muted hover:border-input hover:text-fg"}`}
          >
            <LayoutGrid variant={p.cat === "" ? "Bold" : "Linear"} className="h-4 w-4" aria-hidden="true" />
            All markets <span className={`num text-xs ${p.cat === "" ? "opacity-70" : ""}`}>{p.counts.all}</span>
          </button>
          {shown.map((c) => {
            const Icon = c.icon;
            const on = p.cat === c.id;
            const n = p.counts.byCategory[c.id] ?? 0;
            return (
              <button
                key={c.id} type="button" aria-pressed={on} onClick={() => p.onCategory(on ? "" : c.id)}
                className={`${chipBase} ${on ? "border-fg bg-fg text-canvas" : "border-border bg-surface/50 text-muted hover:border-input hover:text-fg"} ${n === 0 && !on ? "opacity-60" : ""}`}
              >
                <Icon variant={on ? "Bold" : "Linear"} className="h-4 w-4" aria-hidden="true" />
                {c.label} <span className={`num text-xs ${on ? "opacity-70" : ""}`}>{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {subs.length > 0 && (
        <div className="rise mt-2 [mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-1rem),transparent)]">
          <div role="group" aria-label={`${active?.label} topics`} className="flex items-center gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span className="shrink-0 text-xs uppercase tracking-[0.12em] text-muted">{active?.label}</span>
            <button
              type="button" aria-pressed={p.sub === ""} onClick={() => p.onSub("")}
              className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-1 text-xs transition-colors duration-[120ms] ${p.sub === "" ? "border-yes bg-yes-soft text-yes" : "border-border text-muted hover:border-input hover:text-fg"}`}
            >
              All <span className="num">{p.counts.byCategory[p.cat] ?? 0}</span>
            </button>
            {subs.map((s) => {
              const n = subCounts[s.id] ?? 0;
              const on = p.sub === s.id;
              return (
                <button
                  key={s.id} type="button" aria-pressed={on} onClick={() => p.onSub(on ? "" : s.id)}
                  className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-1 text-xs transition-colors duration-[120ms] ${on ? "border-yes bg-yes-soft text-yes" : "border-border text-muted hover:border-input hover:text-fg"} ${n === 0 && !on ? "opacity-50" : ""}`}
                >
                  {s.label} <span className="num">{n}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
