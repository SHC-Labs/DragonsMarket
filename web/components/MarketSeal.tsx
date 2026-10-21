import { useId } from "react";
import { polygonPoints, sigilSpec } from "@/lib/sigil";

// The market's seal: an engraved coin minted from its on-chain rule fingerprint. The same fingerprint always mints
// the same seal. Decorative (aria-hidden): the fingerprint itself is printed in the rules block.
export function MarketSeal({ hash, id, tone = "venue", className = "" }: { hash: string; id: string; tone?: "venue" | "council"; className?: string }) {
  const s = sigilSpec(hash);
  const ink = tone === "council" ? "var(--council)" : s.primary;
  const ink2 = tone === "council" ? "var(--council)" : s.secondary;
  const path = `seal-ring-${useId().replace(/:/g, "")}`;
  const inscription = `DRAGONS MARKET · No. ${id.padStart(3, "0")} · RULE ${hash.slice(0, 6).toUpperCase()}…${hash.slice(-4).toUpperCase()} · SEALED ·`;
  return (
    <svg viewBox="0 0 200 200" className={`market-seal ${className}`} data-tone={tone} aria-hidden="true" focusable="false" style={{ "--seal-ink": ink } as React.CSSProperties}>
      <defs><path id={path} d="M100,100 m-79,0 a79,79 0 1,1 158,0 a79,79 0 1,1 -158,0" /></defs>
      <circle cx="100" cy="100" r="97" className="seal-face" />
      <g className="seal-reeding">{Array.from({ length: 90 }, (_, i) => <line key={i} x1="100" y1="4" x2="100" y2={i % 5 === 0 ? 13 : 9} transform={`rotate(${i * 4} 100 100)`} />)}</g>
      <circle cx="100" cy="100" r="92" className="seal-line" pathLength={1} />
      <circle cx="100" cy="100" r="68" className="seal-line" pathLength={1} />
      <text className="seal-inscription"><textPath href={`#${path}`} textLength={2 * Math.PI * 79 - 4} lengthAdjust="spacingAndGlyphs">{inscription}</textPath></text>
      <g transform="translate(36 36) scale(1.28)" className="seal-sigil">
        {s.rings.map((ring, i) => <circle key={i} cx="50" cy="50" r={ring.r} fill="none" stroke={i % 2 === 0 ? ink : ink2} strokeOpacity={ring.opacity} strokeWidth="0.9" strokeDasharray={ring.dash === "none" ? undefined : ring.dash} />)}
        <polygon points={polygonPoints(s.sides, s.polyR, s.rotation)} fill={ink} fillOpacity="0.1" stroke={ink} strokeWidth="1.2" strokeLinejoin="round" pathLength={1} className="seal-draw" />
        {Array.from({ length: s.spokes }, (_, i) => {
          const a = ((s.rotation + (360 / s.spokes) * i) * Math.PI) / 180;
          return <line key={i} x1="50" y1="50" x2={50 + Math.cos(a) * s.polyR} y2={50 + Math.sin(a) * s.polyR} stroke={ink2} strokeOpacity="0.6" strokeWidth="0.8" pathLength={1} className="seal-draw" />;
        })}
        {s.dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r="1.9" fill={ink2} />)}
        <circle cx="50" cy="50" r="2.4" fill={ink} />
      </g>
    </svg>
  );
}
