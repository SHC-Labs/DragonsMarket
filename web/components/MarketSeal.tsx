import { useId } from "react";
import { sigilSpec } from "@/lib/sigil";

// The market's seal: the Dragons' crest struck into a coin whose rings, markers and inscription are minted from the
// market's on-chain rule fingerprint, so no two markets share a seal and the same fingerprint always makes the same one.
// Decorative (aria-hidden): the fingerprint itself is printed in the rules block.
export function MarketSeal({ hash, id, tone = "venue", className = "" }: { hash: string; id: string; tone?: "venue" | "council"; className?: string }) {
  const s = sigilSpec(hash);
  const uid = useId().replace(/:/g, "");
  const ink = tone === "council" ? "var(--council)" : s.primary;
  const ink2 = tone === "council" ? "var(--council)" : s.secondary;
  const inscription = `DRAGONS MARKET · No. ${id.padStart(3, "0")} · RULE ${hash.slice(0, 6).toUpperCase()}…${hash.slice(-4).toUpperCase()} · SEALED ·`;
  return (
    <svg viewBox="0 0 200 200" className={`market-seal ${className}`} data-tone={tone} aria-hidden="true" focusable="false" style={{ "--seal-ink": ink } as React.CSSProperties}>
      <defs>
        <path id={`${uid}-ring`} d="M100,100 m-79,0 a79,79 0 1,1 158,0 a79,79 0 1,1 -158,0" />
        <mask id={`${uid}-crest`} style={{ maskType: "alpha" }}><image href="/brand/dragon-crest.png" x="62" y="56" width="76" height="88" preserveAspectRatio="xMidYMid meet" /></mask>
      </defs>
      <circle cx="100" cy="100" r="97" className="seal-face" />
      <g className="seal-reeding">{Array.from({ length: 90 }, (_, i) => <line key={i} x1="100" y1="4" x2="100" y2={i % 5 === 0 ? 13 : 9} transform={`rotate(${i * 4} 100 100)`} />)}</g>
      <circle cx="100" cy="100" r="92" className="seal-line" pathLength={1} />
      <circle cx="100" cy="100" r="68" className="seal-line" pathLength={1} />
      <text className="seal-inscription"><textPath href={`#${uid}-ring`} textLength={2 * Math.PI * 79 - 4} lengthAdjust="spacingAndGlyphs">{inscription}</textPath></text>
      {/* The fingerprint's own rings and markers, between the inscription and the crest. */}
      <g className="seal-sigil">
        {s.rings.map((ring, i) => <circle key={i} cx="100" cy="100" r={44 + i * (20 / s.rings.length)} fill="none" stroke={i % 2 === 0 ? ink : ink2} strokeOpacity={ring.opacity * 0.85} strokeWidth="1" strokeDasharray={ring.dash === "none" ? undefined : ring.dash} pathLength={ring.dash === "none" ? 1 : undefined} className={ring.dash === "none" ? "seal-draw" : undefined} />)}
        {s.dots.map((d, i) => {
          const a = Math.atan2(d.y - 50, d.x - 50);
          return <circle key={i} cx={100 + Math.cos(a) * 64} cy={100 + Math.sin(a) * 64} r="2.6" fill={ink2} />;
        })}
      </g>
      <rect x="62" y="56" width="76" height="88" fill={ink} mask={`url(#${uid}-crest)`} className="seal-crest" />
    </svg>
  );
}
