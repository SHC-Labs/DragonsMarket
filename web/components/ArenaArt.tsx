"use client";

import { useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pause, Play } from "./icons";
import { Embers } from "./Embers";
import { Smoke } from "./Smoke";

// The partner's hero art in a frame that turns toward the pointer, with rocket-exhaust sparks rising through it.
export function ArenaHero({ children }: { children: ReactNode }) {
  const move = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--rx", `${((e.clientY - r.top) / r.height - 0.5) * -8}deg`);
    e.currentTarget.style.setProperty("--ry", `${((e.clientX - r.left) / r.width - 0.5) * 10}deg`);
  };
  const leave = (e: PointerEvent<HTMLElement>) => { e.currentTarget.style.removeProperty("--rx"); e.currentTarget.style.removeProperty("--ry"); };
  return <figure className="partner-hero-art" onPointerMove={move} onPointerLeave={leave}>
    {children}
    <span className="arena-exhaust" aria-hidden="true" />
    <Embers height={0.95} intensity={2.2} spark="--rocket-spark" smoke="--rocket-smoke" />
  </figure>;
}

// A small drawing of how each game plays, shown over its art on hover. Mechanics only: no odds or results.
export function GameHint({ game }: { game: string }) {
  if (game === "moonshot") return <svg className="game-hint hint-moonshot" viewBox="0 0 200 120" aria-hidden="true">
    <path className="hint-climb" d="M10 110 C 60 108, 95 98, 125 72 S 168 22, 178 12" pathLength={1} />
    <circle className="hint-rocket" cx="178" cy="12" r="5" />
    <path className="hint-crash" d="M178 12 L 186 4 M178 12 L 188 16 M178 12 L 172 2" />
  </svg>;
  if (game === "blackjack") return <div className="game-hint hint-blackjack" aria-hidden="true">
    <PlayingCard rank="A" suit="spade" /><PlayingCard rank="K" suit="heart" />
  </div>;
  return <svg className="game-hint hint-plinko" viewBox="0 0 120 120" aria-hidden="true">
    {Array.from({ length: 5 }, (_, row) => Array.from({ length: row + 3 }, (_, col) => <circle key={`${row}-${col}`} className="hint-peg" cx={60 - (row + 2) * 9 + col * 18} cy={22 + row * 18} r="2.6" />))}
    <circle className="hint-ball" cx="60" cy="6" r="5" />
  </svg>;
}

// Two rows of the game names running in opposite directions; every word also drifts on its own path.
// Four identical copies per row, so moving by half the row loops seamlessly. Decorative, with a pause control.
export function ArenaMarquee({ names }: { names: string[] }) {
  const [paused, setPaused] = useState(false);
  return <div className="arena-marquee" data-paused={paused || undefined}>
    <div className="arena-marquee-rows" aria-hidden="true">{[0, 1].map(row => <div key={row} className="arena-marquee-row">{Array.from({ length: 4 }, (_, i) => <span key={i}>{names.map((name, j) => {
      const n = row * 12 + i * 3 + j;
      return <b key={name} style={{ "--dx": `${((n * 37) % 11) - 5}px`, "--dy": `${((n * 53) % 9) - 4}px`, "--dur": `${5 + ((n * 29) % 7)}s`, "--delay": `${-((n * 17) % 9)}s` } as React.CSSProperties}>{name}</b>;
    })}</span>)}</div>)}</div>
    <button type="button" className="tape-toggle arena-marquee-toggle" aria-label={paused ? "Play the game names" : "Pause the game names"} onClick={() => setPaused(p => !p)}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
  </div>;
}

// Smoke drifting behind the whole page, fixed to the screen; it parts around the cursor.
// Portalled to <body>: the app frame is a size container, which would otherwise make "fixed" scroll with the page.
export function ArenaAtmosphere() {
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!mounted) return null;
  return createPortal(<div className="partnership-page arena-atmosphere" aria-hidden="true"><Smoke /></div>, document.body);
}

const noSubscribe = () => () => {};

// Suit and crown shapes on a 10 by 10 grid.
const SUIT = {
  spade: "M5 0C5 0 0 4.5 0 6.6 0 8.4 1.6 9.4 3.1 8.9 3.6 8.7 4.1 8.3 4.4 7.9L3.8 10H6.2L5.6 7.9C5.9 8.3 6.4 8.7 6.9 8.9 8.4 9.4 10 8.4 10 6.6 10 4.5 5 0 5 0Z",
  heart: "M5 9.5C5 9.5 0 6.2 0 3.2 0 1.4 1.4 0 3 0 4 0 4.7.5 5 1.2 5.3.5 6 0 7 0 8.6 0 10 1.4 10 3.2 10 6.2 5 9.5 5 9.5Z",
};
const CROWN = "M0 8L1 2 3.5 5 5 0 6.5 5 9 2 10 8Z";

// A face-up playing card drawn like a printed deck: corner indices top-left and, turned, bottom-right.
function PlayingCard({ rank, suit }: { rank: "A" | "K"; suit: keyof typeof SUIT }) {
  const ink = suit === "heart" ? "#c8102e" : "#121014";
  const index = <g fill={ink}><text x="4.2" y="10.4" className="card-rank">{rank}</text><path d={SUIT[suit]} transform="translate(4 12.6) scale(0.42)" /></g>;
  return <svg className="hint-card" viewBox="0 0 50 70">
    <defs><linearGradient id={`paper-${rank}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#efeae1" /></linearGradient></defs>
    <rect x="0.5" y="0.5" width="49" height="69" rx="4" fill={`url(#paper-${rank})`} stroke="#d9d2c6" />
    {index}
    <g transform="rotate(180 25 35)">{index}</g>
    {rank === "A"
      ? <path d={SUIT[suit]} fill={ink} transform="translate(14 21) scale(2.2)" />
      : <g>
          <rect x="11" y="11" width="28" height="48" rx="1.5" fill="none" stroke={ink} strokeWidth="0.7" />
          <rect x="12.5" y="12.5" width="25" height="45" rx="1" fill="#fbe9d0" stroke="#d8a24a" strokeWidth="0.5" />
          <path d={CROWN} fill="#d8a24a" stroke="#9a6a1c" strokeWidth="0.25" transform="translate(18 17) scale(1.4)" />
          <text x="25" y="44" textAnchor="middle" fill={ink} className="card-court">K</text>
          <path d={SUIT[suit]} fill={ink} transform="translate(22 47) scale(0.6)" />
        </g>}
  </svg>;
}

// Behind the two free-floating marks: a mint aura for the dragon, a fire aura for the arena, sparks rising between.
export function ArenaPlateSparks() {
  return <span className="lockup-light" aria-hidden="true">
    <span className="lockup-aura aura-dragon" /><span className="lockup-aura aura-arena" /><span className="lockup-aura aura-core" />
    <Embers height={1} intensity={1.4} speed={0.4} spark="--rocket-spark" smoke="--rocket-smoke" />
  </span>;
}
