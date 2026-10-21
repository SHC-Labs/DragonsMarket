"use client";
import { useEffect, useId, useRef, useState } from "react";
import { LinePath, AreaClosed } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { curveMonotoneX } from "@visx/curve";
import type { Pt } from "./PriceChart";

const DAY = 86_400_000;

// Labels follow the span of the series: clock times within a day, dates beyond it.
function timeFormat(span: number) {
  return span >= 2 * DAY
    ? (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    : (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
const fullTime = (at: number) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function niceTicks(min: number, max: number): number[] {
  const step = max - min > 50 ? 25 : max - min > 24 ? 10 : 5;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) out.push(t);
  return out;
}

export function MarketOutcomeChart({ points, compact = false, onActive }: { points: Pt[]; compact?: boolean; onActive?: (point: Pt | null) => void }) {
  const [index, setIndex] = useState<number | null>(null);
  // Lets the page follow the cursor through history (the market page's big numeral rewinds with it).
  useEffect(() => { onActive?.(index === null ? null : points[Math.min(index, points.length - 1)] ?? null); }, [index]); // eslint-disable-line react-hooks/exhaustive-deps
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 620, height: 280 });
  const gradient = useId().replace(/:/g, "");
  useEffect(() => {
    if (!svgRef.current) return;
    const observer = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (rect && rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height }); });
    observer.observe(svgRef.current);
    return () => observer.disconnect();
  }, [points.length]);
  if (!points.length) return <div className="price-chart-empty"><span className="price-chart-empty-line" aria-hidden="true" />Price history will appear after the first trade.</div>;

  const values = points.flatMap(p => [p.p, 100 - p.p]);
  const min = Math.max(0, Math.floor(Math.min(...values)) - 4), max = Math.min(100, Math.ceil(Math.max(...values)) + 4);
  const W = size.width, H = size.height, L = 34, R = Math.max(60, W - (compact ? 58 : 76)), T = 12, B = Math.max(40, H - 28);
  const first = points[0].at, last = points[points.length - 1];
  const x = scaleLinear({ domain: [first, Math.max(first + 1, last.at)], range: [L, R] });
  const y = scaleLinear({ domain: [min, max], range: [B, T] });
  const active = points[Math.min(index ?? points.length - 1, points.length - 1)];
  const fmt = timeFormat(last.at - first);
  const timeTicks = last.at > first ? [0, 1, 2, 3].map(i => first + ((last.at - first) * i) / 3) : [first];
  let yesY = y(last.p), noY = y(100 - last.p);
  if (Math.abs(yesY - noY) < 34) { const center = (yesY + noY) / 2; const up = last.p >= 50 ? -1 : 1; yesY = center + up * 17; noY = center - up * 17; }

  return <figure className="outcome-chart" data-compact={compact || undefined} aria-label="Yes and No price history">
    <figcaption className="outcome-chart-readout" aria-hidden="true">
      <span className="readout-yes"><i className="outcome-dot outcome-yes" />Yes <b className="num">{active.p.toFixed(1)}%</b></span>
      <span className="readout-no"><i className="outcome-dot outcome-no outcome-dot-dashed" />No <b className="num">{(100 - active.p).toFixed(1)}%</b></span>
      <time className="num" dateTime={new Date(active.at).toISOString()}>{index === null ? "Latest · " : ""}{fullTime(active.at)}</time>
    </figcaption>
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Yes ${last.p.toFixed(1)} percent, No ${(100 - last.p).toFixed(1)} percent. Price history from ${fullTime(first)} to ${fullTime(last.at)}.`}
      onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(); const at = x.invert(((e.clientX - r.left) / r.width) * W); let i = 0; points.forEach((p, n) => { if (p.at <= at) i = n; }); setIndex(i); }}
      onPointerLeave={() => setIndex(null)}>
      <defs>
        <linearGradient id={`${gradient}-yes`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-yes)" stopOpacity="0.28" /><stop offset="100%" stopColor="var(--chart-yes)" stopOpacity="0" /></linearGradient>
      </defs>
      {niceTicks(min, max).map(t => <g key={t}><line x1={L} x2={R} y1={y(t)} y2={y(t)} className="outcome-grid" /><text x={L - 8} y={y(t) + 4} textAnchor="end" className="outcome-axis">{t}%</text></g>)}
      <AreaClosed<Pt> data={points} x={p => x(p.at)} y={p => y(p.p)} yScale={y} curve={curveMonotoneX} fill={`url(#${gradient}-yes)`} className="outcome-area" />
      <LinePath<Pt> data={points} x={p => x(p.at)} y={p => y(100 - p.p)} curve={curveMonotoneX} className="outcome-line outcome-no-line" />
      <LinePath<Pt> data={points} x={p => x(p.at)} y={p => y(p.p)} curve={curveMonotoneX} className="outcome-line outcome-yes-line" pathLength={1} />
      {index !== null && <g className="outcome-scrub"><line x1={x(active.at)} x2={x(active.at)} y1={T} y2={B} className="outcome-crosshair" /><circle cx={x(active.at)} cy={y(active.p)} r={4.5} fill="var(--chart-yes)" /><circle cx={x(active.at)} cy={y(100 - active.p)} r={4.5} fill="var(--chart-no)" /></g>}
      <circle cx={R} cy={y(last.p)} r={11} className="outcome-halo" fill="var(--chart-yes)" />
      <circle cx={R} cy={y(last.p)} r={4} fill="var(--chart-yes)" className="outcome-end" /><circle cx={R} cy={y(100 - last.p)} r={3.5} fill="var(--chart-no)" className="outcome-end" />
      <path d={`M ${R + 6} ${y(last.p)} L ${R + 12} ${yesY}`} className="outcome-connector outcome-yes-connector" /><path d={`M ${R + 6} ${y(100 - last.p)} L ${R + 12} ${noY}`} className="outcome-connector outcome-no-connector" />
      <text x={R + 16} y={yesY + 5} className="outcome-end-label" fill="var(--chart-yes)">{Math.round(last.p)}%</text><text x={R + 16} y={noY + 5} className="outcome-end-label" fill="var(--chart-no)">{Math.round(100 - last.p)}%</text>
      {timeTicks.map((t, i) => <text key={i} x={x(t)} y={H - 6} textAnchor={i === 0 ? "start" : i === timeTicks.length - 1 ? "end" : "middle"} className="outcome-axis">{fmt(t)}</text>)}
    </svg>
    {!compact && <LinkToData points={points} />}
    <label className="sr-only">Explore outcome history<input type="range" min={0} max={points.length - 1} value={index ?? points.length - 1} onChange={e => setIndex(Number(e.target.value))} onBlur={() => setIndex(null)} aria-valuetext={`Yes ${active.p.toFixed(1)} percent, No ${(100 - active.p).toFixed(1)} percent, ${fullTime(active.at)}`} /></label>
  </figure>;
}

function LinkToData({ points }: { points: Pt[] }) {
  return <details className="outcome-data"><summary>Data</summary><div className="outcome-data-scroll"><table><thead><tr><th>Time</th><th>Yes</th><th>No</th></tr></thead><tbody>{points.map((p, i) => <tr key={i}><td>{new Date(p.at).toLocaleString("en-GB")}</td><td>{p.p.toFixed(1)}%</td><td>{(100 - p.p).toFixed(1)}%</td></tr>)}</tbody></table></div></details>;
}
