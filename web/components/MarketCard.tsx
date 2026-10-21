"use client";
import Link from "next/link";
import type { CSSProperties, PointerEvent } from "react";
import { useState } from "react";
import { Star, Share2 } from "@/components/icons";
import { useWallet } from "./WalletProvider";
import { useWatchlist } from "@/lib/watchlist";
import { type Pt } from "./PriceChart";
import { SplitMeter, StateBadge } from "./ui";
import { MarketIcon } from "./MarketIcon";
import { MarketSeal } from "./MarketSeal";
import { labelOf } from "@/lib/categories";
import { config } from "@/lib/config";
import { formatDateTime, formatMoney } from "@/lib/format";
import { pct, resultWord } from "@/lib/probability";
import type { MarketView } from "@/lib/market";

export function ProbBar({ yes }: { yes: number }) {
  return <SplitMeter yes={yes} size="lg" />;
}

// Each outcome opens the market with that side selected.
function OutcomeRows({ market: m }: { market: MarketView }) {
  return <div className="market-outcome-rows">{(["yes", "no"] as const).map(side => {
    const chance = pct(side === "yes" ? m.price_yes : m.price_no);
    const label = side === "yes" ? "Yes" : "No";
    return <Link key={side} href={`/market?id=${m.id}&side=${side}`} className={`market-outcome-option market-outcome-${side}`} aria-label={`${m.status === "open" ? "Buy" : "View"} ${label}, ${chance}% chance, ${m.title}`}>
      <span className="market-outcome-label">{label}</span>
      <span className="market-outcome-chance num">{chance}¢</span>
    </Link>;
  })}</div>;
}

// A soft light follows the pointer across the card.
function track(event: PointerEvent<HTMLElement>) {
  if (event.pointerType !== "mouse") return;
  const r = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--mx", `${event.clientX - r.left}px`);
  event.currentTarget.style.setProperty("--my", `${event.clientY - r.top}px`);
}

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
  const yes = pct(m.price_yes);
  const labels = labelOf(m.category, m.subcategory);
  return (
    <article data-testid="market-card" data-state={done ? "resolved" : open ? "open" : "closed"} onPointerMove={track} className="market-card enter" style={{ "--i": index } as CSSProperties}>
      <Link href={`/market?id=${m.id}`} className="market-card-heading">
        <div className="min-w-0">
          <div className="market-card-cat"><MarketIcon category={m.category} sub={m.subcategory} small />{labels.category} <span aria-hidden="true">·</span> {labels.sub}</div>
          <h3>{m.title}</h3>
        </div>
        <MarketSeal hash={m.rule_hash} id={m.id} className="card-seal" />
      </Link>

      <div className="market-card-outcomes">
        {done ? (
          <div className="market-card-result" data-outcome={m.outcome ?? undefined}>
            <span className="eyebrow">Result</span>
            <strong>{resultWord(m)}</strong>
          </div>
        ) : open ? (
          <>
            <div className="market-card-odds"><span className="num"><b>{yes}</b>%</span><span>chance of Yes</span></div>
            <SplitMeter yes={yes} size="sm" />
            <OutcomeRows market={m} />
          </>
        ) : (
          <div className="market-card-waiting">
            <span className="market-card-waiting-icon" aria-hidden="true" />
            <p>Trading stopped. {stage === "disputed" ? "The Council is deciding." : stage === "proposed" ? "An answer is waiting for a challenge." : "Waiting for an answer."}</p>
          </div>
        )}
      </div>

      <div className="market-card-meta">
        <StateBadge status={m.status} caseStage={stage} />
        <div className="market-card-figures">
          <span><span className="num">{formatMoney(m.locked)}</span> {config.tokenSymbol} in play</span>
          <span>{done ? "Closed" : "Closes"} <span className="num">{formatDateTime(m.close_at)}</span></span>
        </div>
        <div className="card-tools">
          <button type="button" className="icon-btn" data-active={watched || undefined} title={watched ? "Saved to watchlist" : "Watch"} aria-label={`${watched ? "Unwatch" : "Watch"} ${m.title}`} aria-pressed={watched} onClick={() => { if (!account) { openConnect(); setMessage("Connect your wallet to save this market."); return; } setMessage(toggle(m.id) ? watched ? "Removed from your watchlist." : "Saved to your watchlist." : "Couldn’t save this market. Browser storage may be disabled."); }}><Star size={18} variant={watched ? "Bold" : "Linear"} /></button>
          <button type="button" className="icon-btn" title="Share" aria-label={`Share ${m.title}`} onClick={share}><Share2 size={17} /></button>
        </div>
      </div>
      <p role="status" className="card-feedback">{message}</p>{shareUrl && <input aria-label="Market link" readOnly value={shareUrl} onFocus={e => e.currentTarget.select()} className="card-share-input" />}
    </article>
  );
}
