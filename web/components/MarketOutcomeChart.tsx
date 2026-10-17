"use client";
import { useEffect, useRef, useState } from "react";
import { LinePath } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { curveLinear } from "@visx/curve";
import type { Pt } from "./PriceChart";
export function MarketOutcomeChart({points,compact=false}:{points:Pt[];compact?:boolean}) {
 const [index,setIndex]=useState<number|null>(null);
 const svgRef=useRef<SVGSVGElement>(null);
 const [size,setSize]=useState({width:620,height:280});
 useEffect(()=>{
  if(!svgRef.current)return;
  const observer=new ResizeObserver(entries=>{const rect=entries[0]?.contentRect;if(rect&&rect.width>0&&rect.height>0)setSize({width:rect.width,height:rect.height});});
  observer.observe(svgRef.current);
  return()=>observer.disconnect();
 },[points.length]);
 if(!points.length)return <div className="price-chart-empty">Price history will appear after the first trade.</div>;
 const values=points.flatMap(p=>[p.p,100-p.p]);const min=Math.max(0,Math.floor(Math.min(...values))-3),max=Math.min(100,Math.ceil(Math.max(...values))+3);
 const W=size.width,H=size.height,L=8,R=Math.max(50,W-70),T=14,B=Math.max(40,H-30);
 const x=scaleLinear({domain:[points[0].at,Math.max(points[0].at+1,points[points.length-1].at)],range:[L,R]});const y=scaleLinear({domain:[min,max],range:[B,T]});
 const active=points[Math.min(index??points.length-1,points.length-1)],last=points[points.length-1];
 let yesY=y(last.p),noY=y(100-last.p);if(Math.abs(yesY-noY)<38){const center=(yesY+noY)/2;yesY=center-21;noY=center+21;}
 const fmt=(at:number)=>new Date(at).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
 return <figure className="outcome-chart" aria-label="Yes and No price history">
 <svg ref={svgRef} preserveAspectRatio="none" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Yes ${last.p.toFixed(1)} percent, No ${(100-last.p).toFixed(1)} percent. Price history from ${fmt(points[0].at)} to ${fmt(last.at)}.`} onPointerMove={e=>{const r=e.currentTarget.getBoundingClientRect();const at=x.invert((e.clientX-r.left)/r.width*W);let i=0;points.forEach((p,n)=>{if(p.at<=at)i=n});setIndex(i);}} onPointerLeave={()=>setIndex(null)}>
 {[min,(min+max)/2,max].map(t=><g key={t}><line x1={L} x2={R} y1={y(t)} y2={y(t)} className="outcome-grid"/></g>)}
 <LinePath<Pt> data={points} x={p=>x(p.at)} y={p=>y(p.p)} curve={curveLinear} className="outcome-line outcome-yes-line"/>
 <LinePath<Pt> data={points} x={p=>x(p.at)} y={p=>y(100-p.p)} curve={curveLinear} className="outcome-line outcome-no-line"/>
 {index!==null&&<><line x1={x(active.at)} x2={x(active.at)} y1={T} y2={B} className="outcome-crosshair"/><circle cx={x(active.at)} cy={y(active.p)} r={4} fill="var(--chart-yes)"/><circle cx={x(active.at)} cy={y(100-active.p)} r={4} fill="var(--chart-no)"/></>}
 <circle cx={R} cy={y(last.p)} r={4} fill="var(--chart-yes)"/><circle cx={R} cy={y(100-last.p)} r={4} fill="var(--chart-no)"/>
 <path d={`M ${R+6} ${y(last.p)} L ${R+13} ${yesY}`} className="outcome-yes-line outcome-connector"/><path d={`M ${R+6} ${y(100-last.p)} L ${R+13} ${noY}`} className="outcome-no-line outcome-connector"/>
 <text x={R+17} y={yesY+4} className="outcome-end-label" fill="var(--chart-yes)">{Math.round(last.p)}%</text><text x={R+17} y={noY+4} className="outcome-end-label" fill="var(--chart-no)">{Math.round(100-last.p)}%</text>
 <text x={L} y={H-7} className="outcome-axis">{fmt(points[0].at)}</text><text x={R} y={H-7} textAnchor="end" className="outcome-axis">{fmt(last.at)}</text></svg>
 {!compact && <LinkToData points={points}/>}
 <label className="sr-only">Explore outcome history<input type="range" min={0} max={points.length-1} value={index??points.length-1} onChange={e=>setIndex(Number(e.target.value))} onBlur={()=>setIndex(null)} aria-valuetext={`Yes ${active.p.toFixed(1)} percent, No ${(100-active.p).toFixed(1)} percent, ${fmt(active.at)}`}/></label>
 </figure>;
}
function LinkToData({points}:{points:Pt[]}){return <details className="outcome-data"><summary>Data</summary><table><thead><tr><th>Time</th><th>Yes</th><th>No</th></tr></thead><tbody>{points.map((p,i)=><tr key={i}><td>{new Date(p.at).toLocaleString("en-GB")}</td><td>{p.p.toFixed(1)}%</td><td>{(100-p.p).toFixed(1)}%</td></tr>)}</tbody></table></details>;}
