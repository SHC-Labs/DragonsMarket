"use client";

import type { PointerEvent, ReactNode } from "react";
import { Embers } from "./Embers";

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
    <span className="hint-card"><b>A</b><i>♠</i></span><span className="hint-card"><b>K</b><i>♥</i></span>
  </div>;
  return <svg className="game-hint hint-plinko" viewBox="0 0 120 120" aria-hidden="true">
    {Array.from({ length: 5 }, (_, row) => Array.from({ length: row + 3 }, (_, col) => <circle key={`${row}-${col}`} className="hint-peg" cx={60 - (row + 2) * 9 + col * 18} cy={22 + row * 18} r="2.6" />))}
    <circle className="hint-ball" cx="60" cy="6" r="5" />
  </svg>;
}
