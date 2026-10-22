"use client";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useCallback, useState } from "react";
import { ArrowLeft, ArrowRight, Pause, Play } from "@/components/icons";
import { FeaturedMarket } from "./Featured";
import type { MarketView } from "@/lib/market";
import type { Pt } from "@/lib/history";

const ROTATE_MS = 8000;

// The incoming card slides in while the outgoing one drifts a shorter distance and fades: a parallax push, not a crossfade.
function SlidingCard({ children, outgoing = false, animate, direction, onFinish, label, live }: { children: ReactNode; outgoing?: boolean; animate: boolean; direction: number; onFinish?: () => void; label?: string; live?: "off" | "polite" }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!animate || !ref.current) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animation = ref.current.animate(outgoing
      ? [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${-direction * 18}%)`, opacity: 0 }]
      : [{ transform: `translateX(${direction * 100}%)`, opacity: 0.6 }, { transform: "translateX(0)", opacity: 1 }],
    { duration: reduced ? 0 : 520, easing: "cubic-bezier(.22,.8,.24,1)", fill: "both" });
    animation.finished.then(() => onFinish?.()).catch(() => {});
    return () => animation.cancel();
  }, [animate, direction, outgoing, onFinish]);
  return <div ref={ref} className={outgoing ? "featured-slide-outgoing" : "featured-slide-current"} aria-hidden={outgoing || undefined} inert={outgoing} role={outgoing ? undefined : "group"} aria-roledescription={outgoing ? undefined : "slide"} aria-label={label} aria-live={live}>{children}</div>;
}

export function FeaturedCarousel({ markets, stages, histories }: { markets: MarketView[]; stages: Record<string, string | null>; histories: Record<string, Pt[]> }) {
  const [selected, setSelected] = useState(0), [paused, setPaused] = useState(false);
  const [previous, setPrevious] = useState<number | null>(null), [direction, setDirection] = useState(1);

  const finish = useCallback(() => setPrevious(null), []);
  const rotating = !paused && markets.length > 1;
  useEffect(() => { if (!rotating) return; const timer = setInterval(() => { setPrevious(selected % markets.length); setDirection(1); setSelected(i => (i + 1) % markets.length); }, ROTATE_MS); return () => clearInterval(timer); }, [rotating, markets.length, selected]);
  if (!markets.length) return null;
  const active = selected % markets.length, market = markets[active];
  const choose = (i: number) => { const next = (i + markets.length) % markets.length; if (next === active) return; setPrevious(active); setDirection(i < active ? -1 : 1); setSelected(next); };
  return <section className="featured-carousel" data-rotating={rotating || undefined} aria-label="Featured markets, ranked by funds in play" aria-roledescription="carousel" style={{ "--rotate": `${ROTATE_MS}ms` } as CSSProperties} onFocusCapture={e => { if (e.target.matches(":focus-visible") && !e.currentTarget.contains(e.relatedTarget as Node)) setPaused(true); }}>
    <div className="featured-carousel-heading"><span className="eyebrow">Most in play</span><span className="num">{String(active + 1).padStart(2, "0")} <span aria-hidden="true">/</span> {String(markets.length).padStart(2, "0")}</span></div>
    <div className="featured-slide-stage">
      {previous !== null && previous !== active && markets[previous] && <SlidingCard outgoing animate direction={direction} key={`out-${markets[previous].id}-${market.id}`}><FeaturedMarket market={markets[previous]} stage={stages[markets[previous].id] ?? null} points={histories[markets[previous].id] ?? []} /></SlidingCard>}
      <SlidingCard key={market.id} animate={previous !== null} direction={direction} onFinish={finish} live={rotating ? "off" : "polite"} label={`${active + 1} of ${markets.length}: ${market.title}`}><FeaturedMarket market={market} stage={stages[market.id] ?? null} points={histories[market.id] ?? []} /></SlidingCard>
    </div>
    <div className="featured-carousel-controls">
      <div role="group" aria-label="Choose featured market" className="featured-segments">{markets.map((m, i) => <button key={m.id} type="button" aria-label={`Show featured market: ${m.title}`} aria-pressed={active === i} onClick={() => choose(i)}><span><i key={active === i ? `${selected}-${rotating}` : undefined} /></span></button>)}</div>
      <div className="featured-steppers"><button type="button" aria-label="Previous featured market" onClick={() => choose(active - 1)}><ArrowLeft size={17} /></button><button type="button" aria-label="Next featured market" onClick={() => choose(active + 1)}><ArrowRight size={17} /></button><button type="button" aria-label={rotating ? "Pause featured rotation" : "Play featured rotation"} onClick={() => setPaused(p => !p)}>{rotating ? <Pause size={16} /> : <Play size={16} />}</button></div>
    </div>
  </section>;
}
