"use client";

import { useLayoutEffect, useRef } from "react";

// Counts from the value it last showed to the new one, editing the same text node so nothing re-mounts.
// Server render and reduced motion show the final value directly.
export function CountUp({ value, decimals = 0, duration = 900, format, className }: { value: number; decimals?: number; duration?: number; format?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const text = (n: number) => (format ? format(n) : n.toFixed(decimals));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current ?? 0;
    shown.current = value;
    if (from === value || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = text(value);
      return;
    }
    const start = performance.now();
    let done = false;
    el.textContent = text(from);
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      el.textContent = text(from + (value - from) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else done = true;
    });
    return () => {
      cancelAnimationFrame(frame);
      // Interrupted before the end (a re-run or StrictMode): let the next run start from the same place.
      if (!done) shown.current = from;
      el.textContent = text(value);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals, duration]);

  return <span ref={ref} className={className} suppressHydrationWarning>{text(value)}</span>;
}
