import { polygonPoints, sigilSpec } from "@/lib/sigil";

// Decorative: the fingerprint it comes from is printed in the rules block, so screen readers skip this.
export function Sigil({ hash, className = "" }: { hash: string; className?: string }) {
  const s = sigilSpec(hash);
  const id = `g-${hash.slice(0, 10)}`;
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={id} cx={`${s.glow.x}%`} cy={`${s.glow.y}%`} r="50%">
          <stop offset="0" stopColor={s.primary} stopOpacity="0.28" />
          <stop offset="1" stopColor={s.primary} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#${id})`} />
      {s.rings.map((ring, i) => (
        <circle
          key={i}
          cx="50"
          cy="50"
          r={ring.r}
          fill="none"
          stroke={i % 2 === 0 ? s.primary : s.secondary}
          strokeOpacity={ring.opacity}
          strokeWidth="0.9"
          strokeDasharray={ring.dash}
        />
      ))}
      <polygon points={polygonPoints(s.sides, s.polyR, s.rotation)} fill={s.primary} fillOpacity="0.08" stroke={s.primary} strokeWidth="1.1" strokeLinejoin="round" />
      {Array.from({ length: s.spokes }, (_, i) => {
        const a = ((s.rotation + (360 / s.spokes) * i) * Math.PI) / 180;
        return <line key={i} x1="50" y1="50" x2={50 + Math.cos(a) * s.polyR} y2={50 + Math.sin(a) * s.polyR} stroke={s.secondary} strokeOpacity="0.55" strokeWidth="0.7" />;
      })}
      {s.dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r="1.9" fill={s.secondary} />
      ))}
      <circle cx="50" cy="50" r="1.6" fill={s.primary} />
    </svg>
  );
}
