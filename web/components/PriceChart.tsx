"use client";

import { useState } from "react";

export interface Pt {
  at: number; // ms
  p: number; // chance of Yes, 0 to 100
}

const W = 1000;
const H = 200;

function layout(points: Pt[]) {
  const t0 = points[0].at;
  const span = Math.max(points[points.length - 1].at - t0, 1);
  return points.map((pt) => ({ ...pt, x: ((pt.at - t0) / span) * W, y: ((100 - pt.p) / 100) * H }));
}

// Price changes happen at trades, so the line holds its value until the next one (step after).
export function stepPath(points: Pt[], width = W, height = H): { line: string; area: string } {
  const pts = points.length === 1 ? [points[0], { ...points[0], at: points[0].at + 1 }] : points;
  const t0 = pts[0].at;
  const span = Math.max(pts[pts.length - 1].at - t0, 1);
  const xy = pts.map((pt) => [((pt.at - t0) / span) * width, ((100 - pt.p) / 100) * height] as const);
  let line = `M ${xy[0][0].toFixed(1)} ${xy[0][1].toFixed(1)}`;
  for (let i = 1; i < xy.length; i++) line += ` H ${xy[i][0].toFixed(1)} V ${xy[i][1].toFixed(1)}`;
  const area = `${line} V ${height} H ${xy[0][0].toFixed(1)} Z`;
  return { line, area };
}

const fmt = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

// One chart language for the featured market and the full market page.
export function PriceChart({ points, height = 14, label, compact = false }: { points: Pt[]; height?: number; label: string; compact?: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  if (!points.length) return <div className="price-chart-empty" style={{minHeight:`${height}rem`}}>Price history will appear after the first trade.</div>;
  const laid = layout(points.length === 1 ? [points[0], {...points[0],at:points[0].at+1}] : points);
  const {line,area} = stepPath(points);
  const current = selected === null ? laid[laid.length-1] : laid[Math.min(selected,laid.length-1)];
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect=e.currentTarget.getBoundingClientRect();
    const x=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width))*W;
    let index=0;
    laid.forEach((pt,i)=>{ if(pt.x<=x) index=i; });
    setSelected(Math.min(index,points.length-1));
  };
  return <figure className={`price-chart ${compact ? "price-chart-compact" : ""}`} aria-label={label}>
    <div className="price-chart-readout"><span><strong>{Math.round(current.p)}%</strong> Yes</span><time dateTime={new Date(current.at).toISOString()}>{selected===null ? "Latest · " : ""}{fmt(current.at)}</time></div>
    <div className="price-chart-canvas" style={{height:`${height}rem`}}>
      <div className="price-chart-plot" onPointerMove={move} onPointerLeave={()=>setSelected(null)} onPointerCancel={()=>setSelected(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
          {[0,50,100].map(v=><line key={v} className="price-chart-grid" x1="0" x2={W} y1={(100-v)/100*H} y2={(100-v)/100*H} vectorEffect="non-scaling-stroke" />)}
          <path d={area} className="price-chart-area" />
          <path d={line} className="price-chart-line" vectorEffect="non-scaling-stroke" />
        </svg>
        {selected!==null && <div className="price-chart-crosshair" style={{left:`${current.x/W*100}%`}} />}
        <span className="price-chart-dot" style={{left:`${current.x/W*100}%`,top:`${current.y/H*100}%`}} />
      </div>
      <div className="price-chart-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
    </div>
    <div className="price-chart-dates"><span>{new Date(points[0].at).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</span><span>{points.length>1 ? new Date(points[points.length-1].at).toLocaleDateString("en-GB",{day:"numeric",month:"short"}) : "First price"}</span></div>
    <label className="sr-only">Explore price history<input type="range" min={0} max={Math.max(0,points.length-1)} value={selected ?? points.length-1} onChange={e=>setSelected(Number(e.target.value))} onBlur={()=>setSelected(null)} aria-valuetext={`${Math.round(current.p)} percent Yes, ${fmt(current.at)}`} /></label>
    {!compact && <details className="price-chart-data"><summary>View price history</summary><table><thead><tr><th scope="col">Time</th><th scope="col">Chance of Yes</th></tr></thead><tbody>{points.map((pt,i)=><tr key={i}><td>{fmt(pt.at)}</td><td>{Math.round(pt.p)}%</td></tr>)}</tbody></table></details>}
  </figure>;
}

export function Sparkline({ points, className = "" }: { points: Pt[]; className?: string }) {
  if (points.length < 2) {
    return (
      <svg viewBox="0 0 100 36" preserveAspectRatio="none" className={className} aria-hidden="true">
        <line x1="0" x2="100" y1="18" y2="18" stroke="var(--border-input)" strokeDasharray="3 4" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
  const { line } = stepPath(points, 100, 36);
  return <svg viewBox="0 0 100 36" preserveAspectRatio="none" className={`overflow-visible ${className}`} aria-hidden="true"><path d={line} className="price-chart-line" vectorEffect="non-scaling-stroke" /></svg>;
}
