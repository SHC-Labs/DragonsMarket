import type { CSSProperties } from "react";

// A half-circle gauge for the chance of Yes. The arc sweeps in once when the card appears.
export function Gauge({ value, index = 0 }: { value: number; index?: number }) {
  const len = Math.PI * 40;
  const off = len * (1 - Math.min(Math.max(value, 0), 100) / 100);
  return (
    <div className="w-[4.75rem] shrink-0 text-center" role="img" aria-label={`${value} percent chance of Yes`}>
      <div className="relative">
        <svg viewBox="0 0 100 54" className="block w-full overflow-visible" aria-hidden="true">
          <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="var(--border)" strokeWidth="7" strokeLinecap="round" />
          <path
            d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="var(--yes)" strokeWidth="7" strokeLinecap="round"
            strokeDasharray={len} strokeDashoffset={off} className="sweep" style={{ "--len": len, "--i": index } as CSSProperties}
          />
        </svg>
        <div className="absolute inset-x-0 bottom-0 leading-none">
          <span className="display text-[1.6rem]">{value}</span>
          <span className="text-[0.7rem] text-muted">%</span>
        </div>
      </div>
      <div className="mt-1.5 text-[0.625rem] uppercase tracking-[0.12em] text-muted">chance</div>
    </div>
  );
}
