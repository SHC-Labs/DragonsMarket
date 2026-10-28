import test from 'node:test';
import assert from 'node:assert/strict';
import {binanceBoundary,coingeckoLatest,decimal,candidate} from '../src/prices.js';

test('exact USD/USDC observations never substitute latest/USDT data for a five-minute boundary',async()=>{
 const boundary='1700000100000000000',ms=BigInt(boundary)/1000000n;
 const binance=await binanceBoundary('BTC',boundary,async input=>{
  const url=new URL(String(input));assert.equal(url.searchParams.get('symbol'),'BTCUSDC');
  return new Response(JSON.stringify([[Number(ms-60000n),'1','1','1','80000.12345678','2',Number(ms-1n),'2',5,'1','1','0']]));
 });
 assert.equal(binance.price,'80000.12345678');assert.equal(binance.quote,'USDC');assert.equal(binance.exactBoundary,true);
 const latest=await coingeckoLatest('BTC',boundary,null,async()=>new Response(`{"bitcoin":{"usd":80000.123456789012345678,"last_updated_at":${Math.floor(Date.now()/1000)}}}`));
 assert.equal(latest.price,'80000.123456789012345678');assert.equal(latest.exactBoundary,false);assert.equal(latest.quote,'USD');
 const policy={asset:'BTC' as const,quote:'USDC' as const,boundaryNs:boundary,decimals:8,minimumSources:2,maxDeviationBps:100};
 assert.throws(()=>candidate([binance,latest],policy),/insufficient_exact_independent_sources/);
 assert.throws(()=>candidate([binance,binance],policy),/duplicate_price_source/);
 assert.equal(decimal('9007199254740993.01',2),900719925474099301n);
 assert.throws(()=>decimal('1.000000001',8),/price_precision_exceeds_policy/);
 await assert.rejects(binanceBoundary('NEAR',boundary,async()=>new Response('[]')),/boundary_candle_missing/);
 await assert.rejects(coingeckoLatest('NEAR',boundary,null,async()=>new Response('{"near":{"usd":2,"last_updated_at":1}}')),/stale_display_price/);
});

import {coinmarketcapLatest} from '../src/prices.js';
function cmcBody(){return {status:{error_code:0},data:[['1','BTC'],['1027','ETH'],['6535','NEAR']].map(([id,symbol])=>({id:Number(id),symbol,is_active:1,is_fiat:0,quote:[{id:2781,symbol:'USD',price:2,last_updated:new Date().toISOString()}]}))};}
const boundary='1700000100000000000';
test('CMC batches pinned assets, preserves precision and uses header-only authentication',async()=>{
 const observations=await coinmarketcapLatest(boundary,{mode:'keyed',apiKey:'fixture-key'},async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.pathname,'/v3/cryptocurrency/quotes/latest');assert.equal(url.searchParams.get('id'),'1,1027,6535');
  assert.equal(url.searchParams.get('convert'),'USD');assert.ok(!String(input).includes('fixture-key'));
  assert.equal((init?.headers as Record<string,string>)['X-CMC_PRO_API_KEY'],'fixture-key');
  return new Response(JSON.stringify(cmcBody()).replace('"price":2','"price":80000.123456789012345678'));
 });
 assert.deepEqual(observations.map(o=>o.asset),['BTC','ETH','NEAR']);assert.equal(observations[0]!.price,'80000.123456789012345678');
 assert.ok(observations.every(o=>!o.exactBoundary&&o.source==='coinmarketcap'&&o.quote==='USD'));
 assert.throws(()=>candidate(observations,{asset:'BTC',quote:'USD',boundaryNs:boundary,decimals:18,minimumSources:2,maxDeviationBps:100}),/insufficient_exact/);
});
test('CMC keyless never receives a key and shares the same provider identity',async()=>{
 const result=await coinmarketcapLatest(boundary,{mode:'keyless',apiKey:'must-not-send'},async(input,init)=>{
  assert.equal(new URL(String(input)).pathname,'/public-api/v3/cryptocurrency/quotes/latest');assert.deepEqual(init?.headers,{});
  return new Response(JSON.stringify(cmcBody()));
 });
 const exact={...result[0]!,exactBoundary:true};
 assert.throws(()=>candidate([exact,exact],{asset:'BTC',quote:'USD',boundaryNs:boundary,decimals:18,minimumSources:2,maxDeviationBps:100}),/duplicate_price_source/);
});
test('CMC refuses stale, missing, duplicate, wrong-asset, wrong-quote and vendor errors',async()=>{
 const cases:Array<[string,(body:ReturnType<typeof cmcBody>)=>void]>=[
 ['stale_display_price',d=>{d.data[0]!.quote[0]!.last_updated='2000-01-01T00:00:00.000Z';}],
 ['cmc_asset_missing',d=>{d.data.pop();}],
 ['cmc_asset_missing',d=>{d.data.push(d.data[0]!);}],
 ['invalid_cmc_asset',d=>{d.data[0]!.symbol='FAKE';}],
 ['invalid_cmc_quote',d=>{d.data[0]!.quote[0]!.symbol='USDT';}],
 ['invalid_cmc_response',d=>{d.status.error_code=1001;}],
 ];
 for(const [error,mutate] of cases){const d=cmcBody();mutate(d);await assert.rejects(coinmarketcapLatest(boundary,{mode:'keyless'},async()=>new Response(JSON.stringify(d))),new RegExp(error));}
 await assert.rejects(coinmarketcapLatest(boundary,{mode:'keyless'},async()=>new Response('limited',{status:429})),/price_rate_limited/);
 await assert.rejects(coinmarketcapLatest(boundary,{mode:'keyed',apiKey:'bad\r\nkey'}),/invalid_cmc_key/);
});

import {usdBoundary,type Exchange} from '../src/prices.js';
const at=1700000040;
const coinbaseBody=(time=at)=>`[[${time},80784.77,80809,80787.92,80809.12345678,0.49802106]]`;
const krakenBody=(count=35,last=at,key='XXBTZUSD')=>`{"error":[],"result":{"${key}":[[${at},"80800.1","80813.9","80800.0","80813.9","80808.0","0.18882354",${count}],[${at+60},"80813.9","80821.0","80803.0","80821.0","80811.5","0.17554749",43]],"last":${last}}}`;
const bitstampBody=(volume='0.01093903',time=at)=>`{"data":{"pair":"BTC/USD","ohlc":[{"timestamp":"${time}","open":"80795.33","high":"80809.44","low":"80795.33","close":"80809.44","volume":"${volume}"}]}}`;
test('Coinbase, Kraken and Bitstamp give the USD close of the minute ending at the boundary and form a quorum together',async()=>{
 const requested:string[]=[];
 const serve=(body:string):typeof fetch=>async input=>{requested.push(String(input));return new Response(body);};
 const coinbase=await usdBoundary('coinbase','BTC',boundary,serve(coinbaseBody()));
 const kraken=await usdBoundary('kraken','BTC',boundary,serve(krakenBody()));
 const bitstamp=await usdBoundary('bitstamp','BTC',boundary,serve(bitstampBody()));
 assert.deepEqual(requested,[
  'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2023-11-14T22%3A14%3A00.000Z&end=2023-11-14T22%3A14%3A00.000Z',
  'https://api.kraken.com/0/public/OHLC?pair=XXBTZUSD&interval=1&since=1700000040',
  'https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=1&start=1700000040',
 ]);
 assert.deepEqual([coinbase,kraken,bitstamp].map(o=>[o.source,o.price]),[['coinbase','80809.12345678'],['kraken','80813.9'],['bitstamp','80809.44']]);
 assert.ok([coinbase,kraken,bitstamp].every(o=>o.quote==='USD'&&o.exactBoundary&&o.sourceTimeNs==='1700000099999000000'));
 const policy={asset:'BTC' as const,quote:'USD' as const,boundaryNs:boundary,decimals:8,minimumSources:2,maxDeviationBps:100};
 assert.equal(candidate([coinbase,kraken,bitstamp],policy),'8080944000000');
 assert.equal(candidate([coinbase,kraken],policy),'8081390000000');
 assert.throws(()=>candidate([coinbase,kraken,bitstamp],{...policy,quote:'USDC'}),/insufficient_exact_independent_sources/);
 assert.throws(()=>candidate([coinbase,kraken,{...bitstamp,price:'82000'}],policy),/divergent_price_sources/);
});
test('USD candles are refused when the minute is empty, still open, another minute or not a final five-minute boundary',async()=>{
 const cases:Array<[Exchange,string,string]>=[
 ['coinbase','[]','boundary_candle_missing'],
 ['coinbase',coinbaseBody(at-60),'invalid_boundary_candle'],
 ['kraken',krakenBody(0),'invalid_boundary_candle'],
 ['kraken',krakenBody(35,at-60),'boundary_candle_missing'],
 ['kraken','{"error":["EGeneral:Too many requests"]}','invalid_price_response'],
 ['kraken',krakenBody(35,at,'XBTUSD'),'invalid_price_response'],
 ['bitstamp',bitstampBody('0.000'),'invalid_boundary_candle'],
 ['bitstamp',bitstampBody('0.01093903',at+60),'invalid_boundary_candle'],
 ];
 for(const [source,body,error] of cases)await assert.rejects(usdBoundary(source,'BTC',boundary,async()=>new Response(body)),new RegExp(error));
 const never:typeof fetch=async()=>{throw new Error('no request expected');};
 await assert.rejects(usdBoundary('kraken','BTC','1700000160000000000',never),/boundary_not_final/);
 await assert.rejects(usdBoundary('kraken','BTC',((BigInt(Date.now())/300000n+1n)*300000000000n).toString(),never),/boundary_not_final/);
 await assert.rejects(usdBoundary('gemini' as Exchange,'BTC',boundary,never),/invalid_boundary/);
});
