"use client";

import { useEffect, useRef } from "react";
import { ArrowUpDown, LayoutGrid, Search, X } from "@/components/icons";
import { CATEGORIES, OTHER, findCategory, type Counts } from "@/lib/categories";
import { SORTS, STATUSES, type Sort, type Status } from "@/lib/filters";
import { useIndicator } from "./useIndicator";

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

export function Controls(p: Props) {
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);

  // Marks the toolbar while it is stuck under the header, so it can turn solid only when content slides beneath it.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const top = parseFloat(getComputedStyle(el).top);
      const stuck = getComputedStyle(el).position === "sticky" && !Number.isNaN(top) && el.getBoundingClientRect().top <= top + 1 && window.scrollY > 0;
      el.toggleAttribute("data-stuck", stuck);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    check();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, []);
  const statusGroup = useRef<HTMLDivElement>(null);
  useIndicator(statusGroup, `${p.status}:${p.statusCounts[p.status]}`);

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
    <div ref={bar} className="market-controls">
      <div className="market-controls-row">
        <div className="field market-search">
          <label htmlFor="search" className="sr-only">Search markets</label>
          <Search size={18} />
          <input
            ref={input} id="search" type="search" value={p.query} onChange={(e) => p.onQuery(e.target.value)} autoComplete="off"
            placeholder="Search by question or topic"
          />
          {p.query ? (
            <button type="button" onClick={() => { p.onQuery(""); input.current?.focus(); }} aria-label="Clear search" className="icon-btn market-search-clear">
              <X size={16} />
            </button>
          ) : (
            <kbd className="kbd market-search-kbd" aria-hidden="true">/</kbd>
          )}
        </div>

        <div ref={statusGroup} role="group" aria-label="Status" className="segmented market-status">
          {STATUSES.map((s) => (
            <button key={s.id} type="button" aria-pressed={p.status === s.id} onClick={() => p.onStatus(s.id)}>
              {s.label} <span className="count num">{p.statusCounts[s.id]}</span>
            </button>
          ))}
        </div>

        <label className="market-sort">
          <span className="sr-only">Sort by</span>
          <ArrowUpDown size={16} />
          <select value={p.sort} onChange={(e) => p.onSort(e.target.value as Sort)}>
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>

        <dl className="market-stats">
          <div><dt>Markets</dt><dd className="num">{p.stats.markets}</dd></div>
          <div><dt>{p.stats.symbol} in play</dt><dd className="num">{p.stats.locked}</dd></div>
        </dl>
      </div>

      <div className="chip-scroller">
        <div role="group" aria-label="Category" className="chip-row">
          <button type="button" aria-pressed={p.cat === ""} onClick={() => p.onCategory("")} className="chip">
            <LayoutGrid variant={p.cat === "" ? "Bold" : "Linear"} size={16} />
            All markets <span className="count">{p.counts.all}</span>
          </button>
          {shown.map((c) => {
            const Icon = c.icon;
            const on = p.cat === c.id;
            const n = p.counts.byCategory[c.id] ?? 0;
            return (
              <button key={c.id} type="button" aria-pressed={on} onClick={() => p.onCategory(on ? "" : c.id)} className="chip" data-empty={n === 0 || undefined}>
                <Icon variant={on ? "Bold" : "Linear"} size={16} />
                {c.label} <span className="count">{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {subs.length > 0 && (
        <div className="chip-scroller enter-fade">
          <div role="group" aria-label={`${active?.label} topics`} className="chip-row">
            <span className="eyebrow chip-row-label">{active?.label}</span>
            <button type="button" aria-pressed={p.sub === ""} onClick={() => p.onSub("")} className="chip chip-sm">
              All <span className="count">{p.counts.byCategory[p.cat] ?? 0}</span>
            </button>
            {subs.map((s) => {
              const n = subCounts[s.id] ?? 0;
              const on = p.sub === s.id;
              return (
                <button key={s.id} type="button" aria-pressed={on} onClick={() => p.onSub(on ? "" : s.id)} className="chip chip-sm" data-empty={n === 0 || undefined}>
                  {s.label} <span className="count">{n}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
