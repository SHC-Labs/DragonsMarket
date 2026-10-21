"use client";
import Link from "next/link";
import { PowerUpLink, PowerUpVisual } from "./PowerUp";
import type { CSSProperties, PointerEvent } from "react";
import { useState } from "react";
import { Star, Share2 } from "@/components/icons";
import { useWallet } from "./WalletProvider";
import { useWatchlist } from "@/lib/watchlist";
import { type Pt } from "@/lib/history";
import { StateBadge } from "./ui";
import { MarketIcon } from "./MarketIcon";
import { labelOf } from "@/lib/categories";
import { config } from "@/lib/config";
import { formatDateTime, formatMoney } from "@/lib/format";
import { pct, resultWord } from "@/lib/probability";
import type { MarketView } from "@/lib/market";

export function ProbBar({ yes }: { yes: number }) {
  const y = Math.min(Math.max(yes, 0), 100);
  return (
    <div role="img" aria-label={`Yes ${y} percent, No ${100 - y} percent`} className="flex h-1.5 gap-[2px]">
      <div className="grow rounded-full bg-yes" style={{ width: `${y}%`, "--i": 2 } as CSSProperties} />
      <div className="grow flex-1 rounded-full bg-no" style={{ "--i": 3 } as CSSProperties} />
    </div>
  );
}

// Each outcome opens the market with that side selected.
function OutcomeRows({ market: m }: { market: MarketView }) {
  return <div className="market-outcome-rows">{(["yes", "no"] as const).map(side => {
    const chance = pct(side === "yes" ? m.price_yes : m.price_no);
    const label = side === "yes" ? "Yes" : "No";
    return <PowerUpLink key={side} href={`/market?id=${m.id}&side=${side}`} className={`market-outcome-option market-outcome-${side}`} aria-label={`${m.status === "open" ? "Buy" : "View"} ${label}, ${chance}% chance, ${m.title}`}>
      <span className="market-outcome-label">{label}<span className="market-outcome-track" aria-hidden="true"><span style={{ width: `${chance}%` }} /></span></span>
      <span className="market-outcome-chance power-up-target num"><PowerUpVisual />{chance}%</span>
    </PowerUpLink>;
  })}</div>;
}

function tiltMarket(event: PointerEvent<HTMLElement>) {
 if(event.pointerType!=="mouse"||matchMedia("(prefers-reduced-motion: reduce)").matches)return;
 const r=event.currentTarget.getBoundingClientRect();
 event.currentTarget.style.setProperty("--card-x",`${-(event.clientY-r.top-r.height/2)/r.height*9}deg`);
 event.currentTarget.style.setProperty("--card-y",`${(event.clientX-r.left-r.width/2)/r.width*9}deg`);
 event.currentTarget.dataset.raised="true";
}
function resetMarket(event: PointerEvent<HTMLElement>) {delete event.currentTarget.dataset.raised;event.currentTarget.style.removeProperty("--card-x");event.currentTarget.style.removeProperty("--card-y");}
export function MarketCard({ market: m, stage, index }: { market: MarketView; stage: string | null; index: number; points?: Pt[] }) {
  const { ids, toggle } = useWatchlist();
  const { account, openConnect } = useWallet();
  const [message, setMessage] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const watched = ids.includes(m.id);
  const share = async () => {
    const url = new URL(`/market?id=${m.id}`, location.origin).href;
    try { await navigator.clipboard.writeText(url); setMessage("Link copied."); setShareUrl(""); } catch { setShareUrl(url); setMessage("Copy the link below."); }
  };
  const done = m.status === "resolved";
  const open = m.status === "open";
  return (
    <article
      data-testid="market-card"
      onPointerMove={tiltMarket} onPointerLeave={resetMarket} onPointerCancel={resetMarket}
      className="compact-market-card rise flex flex-col rounded-lg border border-border bg-surface/70 p-4 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-input"
      style={{ "--i": index } as CSSProperties}
    >
      <Link href={`/market?id=${m.id}`} className="market-card-heading flex items-start gap-3 no-underline">
        <MarketIcon category={m.category} sub={m.subcategory} small/>
        <div className="min-w-0 flex-1">
          <div className="mb-1 truncate text-[0.65rem] uppercase tracking-[0.14em] text-muted">
            {labelOf(m.category, m.subcategory).category} <span aria-hidden="true">·</span> {labelOf(m.category, m.subcategory).sub}
          </div>
          <h3 className="m-0 line-clamp-3 text-[0.95rem] font-medium leading-[1.35rem]">{m.title}</h3>
        </div>
        
      </Link>

      <div className="market-card-outcomes">
        {done ? (
          <div className="rounded-md border border-border bg-canvas px-3 py-2.5 text-sm">
            Result: <span className="font-semibold">{resultWord(m)}</span>
          </div>
        ) : open ? (
          <OutcomeRows market={m} />
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-muted">
            Trading stopped. {stage === "disputed" ? "The Council is deciding." : stage === "proposed" ? "An answer has been proposed." : "Waiting for an answer."}
          </div>
        )}
      </div>

      <div className="card-tools"><button type="button" aria-label={`${watched ? "Unwatch" : "Watch"} ${m.title}`} aria-pressed={watched} onClick={() => { if (!account) { openConnect(); setMessage("Connect your wallet to save this market."); return; } setMessage(toggle(m.id) ? watched ? "Removed from your watchlist." : "Saved to your watchlist." : "Couldn’t save this market. Browser storage may be disabled."); }}><Star size={17} variant={watched ? "Bold" : "Linear"} /><span>{watched ? "Saved" : "Watch"}</span></button><button type="button" aria-label={`Share ${m.title}`} onClick={share}><Share2 size={16} /><span>Share</span></button></div>
      <p role="status" className="card-feedback">{message}</p>{shareUrl && <input aria-label="Market link" readOnly value={shareUrl} onFocus={e=>e.currentTarget.select()} className="w-full bg-canvas text-fg" />}
      <div className="market-card-meta mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-4 text-xs text-muted">
        <StateBadge status={m.status} caseStage={stage} />
        <span>
          <span className="num">{formatMoney(m.locked)}</span> {config.tokenSymbol} in play
        </span>
        <span className="w-full sm:w-auto">
          {done ? "Closed" : "Closes"} <span className="num">{formatDateTime(m.close_at)}</span>
        </span>
      </div>
    </article>
  );
}
