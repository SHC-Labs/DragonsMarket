import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {readConfig,type Config} from './config.js';
import {ReadRpcClient} from './providers.js';
import {object,parseJson} from './ingestion/block.js';
import {createPool,verifyDatabase} from './database.js';
const amount=(v:unknown)=>{if(typeof v!=='string'||!/^\d{1,39}$/.test(v)||BigInt(v)>2n**128n-1n)throw new Error('invalid_liability_amount');return BigInt(v);};
export async function reconcile(config:Config,rpc:Pick<ReadRpcClient,'call'>){
 if(!config.deployment)throw new Error('deployment_not_configured');
 const status=await rpc.call('status',{});
 if(!object(status)||typeof status.chain_id!=='string'||(config.network==='sandbox'?['testnet','mainnet'].includes(status.chain_id):status.chain_id!==config.network))throw new Error('network_mismatch');
 const block=await rpc.call('block',{finality:'final'});
 if(!object(block)||!object(block.header)||typeof block.header.hash!=='string')throw new Error('invalid_finalized_head');
 const hash=block.header.hash;
 const view=async(contract:string,method:string,args:unknown)=>{
  const result=await rpc.call('query',{request_type:'call_function',block_id:hash,account_id:contract,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
  if(!object(result)||result.block_hash!==hash||!Array.isArray(result.result)||result.result.length>1024*1024||result.result.some(b=>!Number.isInteger(b)||b<0||b>255))throw new Error('invalid_finalized_view');
  return parseJson(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(result.result)));
 };
 const d=config.deployment,contracts=[];
 for(const role of ['market','rounds','oracle','council'] as const){
  const receiver=d.contracts[role];if(!receiver)continue;
  let owed:bigint;
  if(role==='council'){
   const totals=await view(receiver,'reward_totals',{});if(!object(totals))throw new Error('invalid_reward_totals');
   owed=amount(totals.total_received)-amount(totals.total_paid)-amount(totals.pending_claims);if(owed<0n)throw new Error('invalid_reward_accounting');
  }else owed=amount(await view(receiver,'total_owed',{}));
  const held=amount(await view(d.contracts.verifier!,'mt_balance_of',{account_id:receiver,token_id:d.collateralTokenId}));
  contracts.push({role,contract:receiver,owed:owed.toString(),held:held.toString(),shortfall:(held<owed?owed-held:0n).toString(),surplus:(held>owed?held-owed:0n).toString()});
 }
 return {blockHash:hash,height:String(block.header.height),collateralTokenId:d.collateralTokenId,solvent:contracts.every(c=>c.shortfall==='0'),contracts};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const stop=new AbortController();process.on('SIGTERM',()=>stop.abort());process.on('SIGINT',()=>stop.abort());let pool:ReturnType<typeof createPool>|undefined;
 try{const config=readConfig(process.env);pool=createPool(config.databaseUrl);await verifyDatabase(pool,config);const rpc=new ReadRpcClient(config.rpc.primaryUrl,config.rpc,config.rpc.primaryBearerToken);
 do{const report=await reconcile(config,rpc);await pool.query('INSERT INTO reconciliation_reports(deployment_id,block_hash,report,solvent) VALUES($1,$2,$3,$4) ON CONFLICT(deployment_id,block_hash) DO NOTHING',[config.deployment!.id,report.blockHash,JSON.stringify(report),report.solvent]);console.log(JSON.stringify(report));if(!report.solvent)process.exitCode=1;
 if(process.argv.includes('--follow'))await sleep(60000,undefined,{signal:stop.signal}).catch(()=>{});
 }while(process.argv.includes('--follow')&&!stop.signal.aborted);
 }catch{console.error('reconciliation_unavailable');process.exitCode=1;}finally{await pool?.end();}
}
