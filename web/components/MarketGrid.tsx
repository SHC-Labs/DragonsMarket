"use client";
import { useEffect, useRef, useState } from "react";
import { MarketCard } from "./MarketCard";
import type { MarketView } from "@/lib/market";
import type { Pt } from "@/lib/history";
export function MarketGrid({markets,stages,histories}:{markets:MarketView[];stages:Record<string,string|null>;histories:Record<string,Pt[]>}) {
 const ref=useRef<HTMLDivElement>(null);const[columns,setColumns]=useState(4);const[batches,setBatches]=useState(1);
 useEffect(()=>{if(!ref.current)return;const observer=new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width??0;const rem=parseFloat(getComputedStyle(document.documentElement).fontSize);if(width)setColumns(Math.min(4,Math.max(1,Math.floor((width+rem)/(20*rem)))));});observer.observe(ref.current);return()=>observer.disconnect();},[]);
 const batch=columns*(columns===1?6:3),count=Math.min(markets.length,batch*batches),visible=markets.slice(0,count);
 // Use a single column count for the entire grid, including the final batch.
 // Prefer a divisor when all results are visible, so 21 markets form seven rows of three.
 const divisors=Array.from({length:columns},(_,i)=>columns-i).filter(n=>count%n===0);
 const displayColumns=count<columns?Math.max(1,count):count===markets.length&&(divisors[0]??1)>1?divisors[0]:columns;
 const rows=Array.from({length:Math.ceil(count/displayColumns)},(_,i)=>visible.slice(i*displayColumns,(i+1)*displayColumns));
 return <><div ref={ref} className="market-card-grid paginated-market-grid">{rows.map(row=><div className="market-grid-row" key={row[0].id} style={{gridTemplateColumns:`repeat(${displayColumns},minmax(0,1fr))`}}>{row.map(m=><MarketCard key={m.id} market={m} stage={stages[m.id]??null} index={0} points={histories[m.id]??[]}/>)}</div>)}</div><div className="market-grid-pagination"><p role="status">Showing {count} of {markets.length} markets</p>{count<markets.length&&<button type="button" onClick={()=>setBatches(v=>v+1)}>Show more <span aria-hidden="true">↓</span></button>}</div></>;
}
