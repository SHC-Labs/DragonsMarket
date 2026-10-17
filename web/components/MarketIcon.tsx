import { Bitcoin, Bot, CloudSun, Cpu, Film, Flame, Globe2, House, Landmark, Rocket, TrendingUp, Trophy, Vote, Gamepad2 } from "@/components/icons";
import type { CSSProperties } from "react";
const themes:Record<string,[string,string]>={politics:["#2868c9","#eef6ff"],sports:["#df6340","#fff2df"],crypto:["#e58b13","#fff7dd"],economy:["#16866a","#dcfff2"],tech:["#7354d8","#f4eaff"],culture:["#bb447f","#ffe7f3"],world:["#16859d","#e1fbff"],other:["#667085","#f1f5fb"]};
export function MarketIcon({category,sub,small=false}:{category:string;sub:string;small?:boolean}) {
 const tone=themes[category]??themes.other;
 let Icon=category==="politics"?Landmark:category==="sports"?Trophy:category==="crypto"?Bitcoin:category==="economy"?TrendingUp:category==="tech"?Cpu:category==="culture"?Film:Globe2;
 if(category==="politics"&&sub.includes("election"))Icon=Vote;
 if(sub==="weather")Icon=CloudSun;if(sub==="ai")Icon=Bot;if(sub==="space")Icon=Rocket;if(sub==="gaming")Icon=Gamepad2;if(sub==="housing")Icon=House;if(sub==="oil")Icon=Flame;
 const ball=category==="sports"&&["nba","mlb","nfl","soccer","world-cup"].includes(sub);
 return <span aria-hidden="true" className={`market-category-art market-icon ${small?"market-category-art-small":""}`} style={{"--icon-bg":tone[0],"--icon-ink":tone[1]} as CSSProperties}>
 {ball?<svg viewBox="0 0 32 32" width="32" height="32" fill="none">
 {sub==="nba"?<><circle cx="16" cy="16" r="12" fill="#ffc45d" stroke="#723519" strokeWidth="1.7"/><path d="M4 16h24M16 4v24M7 7c11 4 14 10 18 18M25 7C14 11 11 14 7 25" stroke="#723519" strokeWidth="1.7"/></>:sub==="mlb"?<><circle cx="16" cy="16" r="12" fill="#fff7ec"/><path d="M9 6c8 5 8 15 0 20M23 6c-8 5-8 15 0 20" stroke="#df4848" strokeWidth="2" strokeDasharray="2 2"/></>:sub==="nfl"?<><ellipse cx="16" cy="16" rx="14" ry="8" transform="rotate(-40 16 16)" fill="#924b29" stroke="#ffd7b0" strokeWidth="1.5"/><path d="m11 20 10-9M12 15l5 5M15 12l5 5" stroke="#fff3e3" strokeWidth="2"/></>:<><circle cx="16" cy="16" r="12" fill="#fff7ec"/><path d="m16 10 6 4-2 7h-8l-2-7 6-4ZM7 6l4 4-5 6H4M25 6l-4 4 5 6h2M10 27l3-6M22 27l-3-6" fill="#27344c" stroke="#27344c" strokeWidth="1.5"/></>}
 </svg>:<Icon size={small?25:29} variant="Bulk"/>}
 </span>;
}
