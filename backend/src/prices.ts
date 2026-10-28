import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import type pg from 'pg';
import {object} from './ingestion/block.js';
import {setTimeout as sleep} from 'node:timers/promises';
import {createPool,verifyDatabase} from './database.js';
import {readConfig} from './config.js';
export type Asset='BTC'|'ETH'|'NEAR';
export type Exchange='coinbase'|'kraken'|'bitstamp';
export interface Observation{asset:Asset;source:'binance'|Exchange|'coingecko'|'coinmarketcap';quote:'USD'|'USDC';boundaryNs:string;sourceTimeNs:string;retrievedAt:string;price:string;exactBoundary:boolean;raw:string;}
const assets:Asset[]=['BTC','ETH','NEAR'];
const coinIds:Record<Asset,string>={BTC:'bitcoin',ETH:'ethereum',NEAR:'near'};
export function decimal(value:unknown,decimals=8){
 if(typeof value!=='string'||!/^\d{1,30}(\.\d{1,18})?$/.test(value)||!Number.isInteger(decimals)||decimals<0||decimals>18)throw new Error('invalid_decimal');
 const [whole,fraction='']=value.split('.');
 if(fraction.length>decimals&&/[1-9]/.test(fraction.slice(decimals)))throw new Error('price_precision_exceeds_policy');
 const scaled=BigInt(whole!)*10n**BigInt(decimals)+BigInt(fraction.slice(0,decimals).padEnd(decimals,'0')||'0');
 if(scaled<=0n)throw new Error('nonpositive_price');return scaled;
}
function parseExact(raw:string):unknown{return JSON.parse(raw,(_key,value:unknown,context?:{source?:string})=>typeof value==='number'?(context?.source??(()=>{throw new Error('exact_json_required');})()):value);}
async function get(url:URL,transport:typeof fetch,headers:Record<string,string>={}){
 const r=await transport(url,{redirect:'error',signal:AbortSignal.timeout(10000),headers});
 if(!r.ok||!r.body){await r.body?.cancel();throw new Error(r.status===429?'price_rate_limited':'price_source_unavailable');}
 const chunks:Uint8Array[]=[];let size=0;
 for await(const chunk of r.body){size+=chunk.length;if(size>1024*1024)throw new Error('price_response_too_large');chunks.push(chunk);}
 const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));return {raw,data:parseExact(raw)};
}
export async function binanceBoundary(asset:Asset,boundaryNs:string,transport:typeof fetch=fetch):Promise<Observation>{
 if(!assets.includes(asset)||!/^\d{1,20}$/.test(boundaryNs))throw new Error('invalid_boundary');
 const boundary=BigInt(boundaryNs);if(boundary%300000000000n!==0n||boundary>BigInt(Date.now()-3000)*1000000n)throw new Error('boundary_not_final');
 const ms=boundary/1000000n,start=ms-60000n;
 const url=new URL('https://data-api.binance.vision/api/v3/klines');
 url.search=new URLSearchParams({symbol:asset+'USDC',interval:'1m',startTime:start.toString(),endTime:(ms-1n).toString(),limit:'1'}).toString();
 const {raw,data}=await get(url,transport);
 if(!Array.isArray(data)||data.length!==1||!Array.isArray(data[0]))throw new Error('boundary_candle_missing');
 const row=data[0];
 if(row[0]!==start.toString()||row[6]!==(ms-1n).toString()||typeof row[8]!=='string'||BigInt(row[8])<=0n)throw new Error('invalid_boundary_candle');
 decimal(row[4],18);
 return {asset,source:'binance',quote:'USDC',boundaryNs,sourceTimeNs:((ms-1n)*1000000n).toString(),retrievedAt:new Date().toISOString(),price:row[4] as string,exactBoundary:true,raw};
}
const usdPairs:Record<Exchange,Record<Asset,string>>={
 coinbase:{BTC:'BTC-USD',ETH:'ETH-USD',NEAR:'NEAR-USD'},
 kraken:{BTC:'XXBTZUSD',ETH:'XETHZUSD',NEAR:'NEARUSD'},
 bitstamp:{BTC:'btcusd',ETH:'ethusd',NEAR:'nearusd'},
};
function usdCandleUrl(source:Exchange,pair:string,start:bigint){
 if(source==='coinbase'){
  const at=new Date(Number(start)*1000).toISOString(),url=new URL(`https://api.exchange.coinbase.com/products/${pair}/candles`);
  url.search=new URLSearchParams({granularity:'60',start:at,end:at}).toString();return url;
 }
 const url=new URL(source==='kraken'?'https://api.kraken.com/0/public/OHLC':`https://www.bitstamp.net/api/v2/ohlc/${pair}/`);
 url.search=new URLSearchParams(source==='kraken'?{pair,interval:'1',since:start.toString()}:{step:'60',limit:'1',start:start.toString()}).toString();return url;
}
function usdCandle(source:Exchange,pair:string,start:bigint,data:unknown):{start:unknown;close:unknown;traded:boolean}{
 if(source==='coinbase'){
  if(!Array.isArray(data)||data.length!==1||!Array.isArray(data[0]))throw new Error('boundary_candle_missing');
  const row=data[0];return {start:row[0],close:row[4],traded:typeof row[5]==='string'&&Number(row[5])>0};
 }
 if(source==='kraken'){
  if(!object(data)||!Array.isArray(data.error)||data.error.length>0||!object(data.result))throw new Error('invalid_price_response');
  const rows=data.result[pair],last=data.result.last;
  if(!Array.isArray(rows)||typeof last!=='string'||!/^\d{1,12}$/.test(last))throw new Error('invalid_price_response');
  const row=rows.find(r=>Array.isArray(r)&&r[0]===start.toString());
  if(!Array.isArray(row)||BigInt(last)<start)throw new Error('boundary_candle_missing');
  return {start:row[0],close:row[4],traded:typeof row[7]==='string'&&/^\d{1,12}$/.test(row[7])&&BigInt(row[7])>0n};
 }
 const rows=object(data)&&object(data.data)?data.data.ohlc:null;
 if(!Array.isArray(rows)||rows.length!==1||!object(rows[0]))throw new Error('boundary_candle_missing');
 const row=rows[0];return {start:row.timestamp,close:row.close,traded:typeof row.volume==='string'&&Number(row.volume)>0};
}
export async function usdBoundary(source:Exchange,asset:Asset,boundaryNs:string,transport:typeof fetch=fetch):Promise<Observation>{
 if(!assets.includes(asset)||!Object.hasOwn(usdPairs,source)||!/^\d{1,20}$/.test(boundaryNs))throw new Error('invalid_boundary');
 const boundary=BigInt(boundaryNs);if(boundary%300000000000n!==0n||boundary>BigInt(Date.now()-3000)*1000000n)throw new Error('boundary_not_final');
 const start=boundary/1000000000n-60n,pair=usdPairs[source][asset];
 const {raw,data}=await get(usdCandleUrl(source,pair,start),transport);
 const candle=usdCandle(source,pair,start,data);
 if(candle.start!==start.toString()||!candle.traded)throw new Error('invalid_boundary_candle');
 decimal(candle.close,18);
 return {asset,source,quote:'USD',boundaryNs,sourceTimeNs:(boundary-1000000n).toString(),retrievedAt:new Date().toISOString(),price:candle.close as string,exactBoundary:true,raw};
}
export async function coingeckoLatest(asset:Asset,boundaryNs:string,demoKey:string|null=null,transport:typeof fetch=fetch):Promise<Observation>{
 if(!assets.includes(asset)||!/^\d{1,20}$/.test(boundaryNs))throw new Error('invalid_asset');
 if(demoKey&&/[\r\n]/.test(demoKey))throw new Error('invalid_demo_key');
 const url=new URL('https://api.coingecko.com/api/v3/simple/price');
 url.search=new URLSearchParams({ids:coinIds[asset],vs_currencies:'usd',include_last_updated_at:'true',precision:'full'}).toString();
 const {raw,data}=await get(url,transport,demoKey?{'x-cg-demo-api-key':demoKey}:{});
 const row=object(data)?data[coinIds[asset]]:null;
 if(!object(row)||typeof row.last_updated_at!=='string'||!/^\d{1,12}$/.test(row.last_updated_at))throw new Error('invalid_price_response');
 decimal(row.usd,18);const time=BigInt(row.last_updated_at)*1000000000n;
 const age=BigInt(Date.now())*1000000n-time;if(age< -5000000000n||age>120000000000n)throw new Error('stale_display_price');
 return {asset,source:'coingecko',quote:'USD',boundaryNs,sourceTimeNs:time.toString(),retrievedAt:new Date().toISOString(),price:row.usd as string,exactBoundary:false,raw};
}
// Keyed and public routes are transports for the same independent provider.
export async function coinmarketcapLatest(boundaryNs:string,options:{mode:'keyed'|'keyless';apiKey?:string|undefined},transport:typeof fetch=fetch):Promise<Observation[]>{
 if(!/^\d{1,20}$/.test(boundaryNs))throw new Error('invalid_boundary');
 if(!['keyed','keyless'].includes(options.mode))throw new Error('invalid_cmc_mode');
 if(options.mode==='keyed'&&(!options.apiKey||/[\r\n]/.test(options.apiKey)))throw new Error('invalid_cmc_key');
 const prefix=options.mode==='keyless'?'/public-api':'';
 const url=new URL(`https://pro-api.coinmarketcap.com${prefix}/v3/cryptocurrency/quotes/latest`);
 const ids:Record<Asset,string>={BTC:'1',ETH:'1027',NEAR:'6535'};
 url.search=new URLSearchParams({id:assets.map(a=>ids[a]).join(','),convert:'USD'}).toString();
 const {raw,data}=await get(url,transport,options.mode==='keyed'?{'X-CMC_PRO_API_KEY':options.apiKey!}:{});
 if(!object(data)||!object(data.status)||data.status.error_code!=='0'||!Array.isArray(data.data))throw new Error('invalid_cmc_response');
 const rows=data.data;
 return assets.map(asset=>{
  const matches=rows.filter(r=>object(r)&&r.id===ids[asset]);
  if(matches.length!==1)throw new Error('cmc_asset_missing_or_duplicate');
  const row=matches[0];
  if(!object(row)||row.symbol!==asset||row.is_active!=='1'||row.is_fiat!=='0'||!Array.isArray(row.quote))throw new Error('invalid_cmc_asset');
  const quotes=row.quote.filter(q=>object(q)&&q.symbol==='USD'&&q.id==='2781');
  if(quotes.length!==1)throw new Error('invalid_cmc_quote');
  const q=quotes[0];if(!object(q)||typeof q.last_updated!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(q.last_updated))throw new Error('invalid_cmc_timestamp');
  const time=Date.parse(q.last_updated),age=Date.now()-time;
  if(!Number.isFinite(time)||age< -5000||age>120000)throw new Error('stale_display_price');
  decimal(q.price,18);
  return {asset,source:'coinmarketcap',quote:'USD',boundaryNs,sourceTimeNs:(BigInt(time)*1000000n).toString(),retrievedAt:new Date().toISOString(),price:q.price as string,exactBoundary:false,raw};
 });
}
export function candidate(observations:Observation[],policy:{asset:Asset;quote:'USD'|'USDC';boundaryNs:string;decimals:number;minimumSources:number;maxDeviationBps:number}){
 if(policy.minimumSources<2||policy.minimumSources>5||!Number.isInteger(policy.maxDeviationBps)||policy.maxDeviationBps<1||policy.maxDeviationBps>1000)throw new Error('invalid_price_policy');
 const selected=observations.filter(o=>o.asset===policy.asset&&o.quote===policy.quote&&o.boundaryNs===policy.boundaryNs&&o.exactBoundary);
 if(new Set(selected.map(o=>o.source)).size!==selected.length)throw new Error('duplicate_price_source');
 if(selected.length<policy.minimumSources)throw new Error('insufficient_exact_independent_sources');
 const prices=selected.map(o=>decimal(o.price,policy.decimals)).sort((a,b)=>a<b?-1:a>b?1:0);
 const median=prices[Math.floor(prices.length/2)]!;
 if(prices.some(p=>(p>median?p-median:median-p)*10000n>median*BigInt(policy.maxDeviationBps)))throw new Error('divergent_price_sources');
 return median.toString();
}
export async function recordEvidence(pool:pg.Pool,o:Observation){
 const hash=createHash('sha256').update(o.raw).digest('hex');
 await pool.query(`INSERT INTO price_evidence(id,asset,source,quote,boundary_ns,source_time_ns,retrieved_at,price,raw_response,response_hash,accepted,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(asset,source,boundary_ns,response_hash) DO NOTHING`,[randomUUID(),o.asset,o.source,o.quote,o.boundaryNs,o.sourceTimeNs,o.retrievedAt,o.price,o.raw,hash,o.exactBoundary,o.exactBoundary?'closed_one_minute_candle_not_yet_approved_for_signing':'display_only_not_a_boundary_price']);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 let pool:pg.Pool|undefined;const stop=new AbortController();process.on('SIGINT',()=>stop.abort());process.on('SIGTERM',()=>stop.abort());
 try{
 const cmcMode=process.env.COINMARKETCAP_MODE||'keyless';
 if(!['keyed','keyless','off'].includes(cmcMode))throw new Error('invalid_cmc_mode');
 const config=readConfig(process.env);pool=createPool(config.databaseUrl);await verifyDatabase(pool,{...config,deployment:null});
 do {
 const boundary=(BigInt(Date.now()-5000)/300000n*300000000000n).toString();
 for(const asset of assets){for(const source of ['binance','coinbase','kraken','bitstamp','coingecko'] as const){
  try{const o=source==='binance'?await binanceBoundary(asset,boundary):source==='coingecko'?await coingeckoLatest(asset,boundary,process.env.COINGECKO_DEMO_API_KEY||null):await usdBoundary(source,asset,boundary);await recordEvidence(pool,o);console.log(JSON.stringify({asset,source,quote:o.quote,price:o.price,exactBoundary:o.exactBoundary,signing:false}));}
  catch{console.error(JSON.stringify({asset,source,error:'observation_unavailable',signing:false}));process.exitCode=1;}
 }}
 if(cmcMode!=='off'){
  try{for(const o of await coinmarketcapLatest(boundary,{mode:cmcMode as 'keyed'|'keyless',apiKey:process.env.COINMARKETCAP_API_KEY})){
   await recordEvidence(pool,o);console.log(JSON.stringify({asset:o.asset,source:o.source,quote:o.quote,price:o.price,exactBoundary:false,signing:false}));
  }}catch{console.error(JSON.stringify({source:'coinmarketcap',mode:cmcMode,error:'observation_unavailable',signing:false}));process.exitCode=1;}
 }
 if(process.argv.includes('--follow')&&!stop.signal.aborted){const wait=300000-(Date.now()%300000)+5000;await sleep(wait,undefined,{signal:stop.signal}).catch(()=>{});}
 }while(process.argv.includes('--follow')&&!stop.signal.aborted);
 }catch{console.error('price_collection_failed');process.exitCode=1;}finally{await pool?.end();}
}
