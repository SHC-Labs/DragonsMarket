#!/usr/bin/env node
// Testnet workload runner. Review a plan first; --execute signs and spends only on verified testnet.
import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { b58decode, b58encode, rpc } from "./chain.mjs";
import { bounded, serializeByKey } from "./due-queue.mjs";
import { signedFunctionCall, readKeyFile } from "./keeper.mjs";
const METHODS = {
  market: new Set(["buy", "sell", "redeem", "withdraw", "sweep_fees", "settle_leg"]),
  oracle: new Set(["commit_vote", "reveal_vote", "finalize", "resolve_draw", "retry_apply", "retry_unlock", "resolve_by_deadline"]),
  council: new Set(["advance_quarters", "finalize_quarter"]),
  verifier: new Set(["mt_transfer_call"]),
};
const dec = /^(0|[1-9][0-9]*)$/;
const testAccount = value => typeof value === "string" && /^[a-z0-9._-]+\.testnet$/.test(value) && value.length <= 64;
export function validatePlan(plan) {
  if (!plan || typeof plan.rpc !== "string" || !/^https?:\/\//.test(plan.rpc)) throw new Error("An explicit testnet RPC is required");
  if (!Number.isInteger(plan.workers) || plan.workers < 1 || plan.workers > 8) throw new Error("Use 1 to 8 workers");
  for (const target of Object.keys(METHODS)) if (!testAccount(plan.contracts?.[target])) throw new Error("Every workload target must be an explicit .testnet account");
  if (new Set(Object.values(plan.contracts)).size !== 4) throw new Error("Four distinct workload targets are required");
  if (!Array.isArray(plan.actors) || !plan.actors.length || plan.actors.some(a => !testAccount(a.id) || typeof a.keyFile !== "string")) throw new Error("Actors need testnet account IDs and owner-only key files");
  if (new Set(plan.actors.map(a=>a.id)).size !== plan.actors.length) throw new Error("Duplicate actors");
  if (!Array.isArray(plan.calls) || !plan.calls.length || plan.calls.length > 100_000) throw new Error("Provide 1 to 100000 explicit calls");
  for (const call of plan.calls) {
    if (!plan.actors.some(a=>a.id===call.actor) || !METHODS[call.target]?.has(call.method)) throw new Error("Unknown workload actor or method");
    if (!call.args || typeof call.args !== "object" || Array.isArray(call.args) || !dec.test(call.deposit) || BigInt(call.deposit)>10n**24n) throw new Error("Explicit arguments and deposit of at most 1 NEAR per call are required");
    if (!Number.isInteger(call.gasTgas) || call.gasTgas < 1 || call.gasTgas > 300) throw new Error("Gas must be 1 to 300 TGas");
    if (!call.expect || !["market","oracle","council"].includes(call.expect.receiver) || typeof call.expect.event !== "string" || !call.expect.data || !Object.keys(call.expect.data).length) throw new Error("Each call needs a scoped expected application event and matching data");
    if (call.target === "verifier" && ![plan.contracts.market,plan.contracts.oracle,plan.contracts.council].includes(call.args.receiver_id)) throw new Error("Verifier transfer must target a configured application contract");
  }
  if (plan.caseIds !== undefined && (!Array.isArray(plan.caseIds) || plan.caseIds.some(id=>typeof id!=="string"||!dec.test(id)))) throw new Error("caseIds must be decimal market IDs");
  return plan;
}
export function confirmedEvent(result, expected, contracts) {
  if (result.final_execution_status !== "FINAL" || !Object.hasOwn(result.status ?? {},"SuccessValue")) return false;
  return (result.receipts_outcome ?? []).some(({outcome}) => {
    if (outcome?.executor_id !== contracts[expected.receiver] || !Object.hasOwn(outcome.status ?? {},"SuccessValue") && !Object.hasOwn(outcome.status ?? {},"SuccessReceiptId")) return false;
    return (outcome.logs ?? []).some(log=>{
      if (!log.startsWith("EVENT_JSON:")) return false;
      const event=JSON.parse(log.slice(11));
      return event.standard===expected.receiver && event.event===expected.event && (Array.isArray(event.data)?event.data:[event.data]).some(data=>
        data && Object.entries(expected.data).every(([key,value])=>JSON.stringify(data[key])===JSON.stringify(value)));
    });
  });
}
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
export async function run(plan, execute=false) {
  validatePlan(plan);
  if (!execute) return { mode:"plan", calls:plan.calls.length, actors:plan.actors.length, workers:plan.workers, contracts:plan.contracts, note:"No RPC calls, keys read or transactions sent. Pass --execute only after funding a dedicated testnet deployment." };
  let rpcCalls=0;const byMethod={};
  const request=async(method,params)=>{rpcCalls++;byMethod[method]=(byMethod[method]??0)+1;return rpc(plan.rpc,method,params);};
  const read=async(account,method,args={})=>{
    const r=await request("query",{request_type:"call_function",finality:"final",account_id:account,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString("base64")});
    if(r.error)throw new Error(r.error);
    return JSON.parse(Buffer.from(r.result).toString());
  };
  const status=await request("status",{});
  if (status.chain_id!=="testnet") throw new Error("The RPC is not testnet");
  // A shared verifier is a bottleneck under test, never a mainnet account fallback.
  const market=await read(plan.contracts.market,"config");
  if(market.verifier!==plan.contracts.verifier)throw new Error("Market verifier differs from the workload plan");
  const keys=new Map();
  for(const actor of plan.actors){
    const encoded=readKeyFile(actor.keyFile);const raw=b58decode(encoded.replace(/^ed25519:/,""));
    if(raw.length!==64)throw new Error("Expected a raw ed25519 secret key in the actor key file");
    keys.set(actor.id,raw);
  }
  const serial=serializeByKey(), results=[];const started=performance.now();
  await bounded(plan.calls,plan.workers,call=>serial(call.actor,async()=>{
    const start=performance.now();let hash;
    try{
      const raw=keys.get(call.actor),publicKey=raw.subarray(32);
      const [block,key]=await Promise.all([
        request("block",{finality:"optimistic"}),
        request("query",{request_type:"view_access_key",finality:"optimistic",account_id:call.actor,public_key:"ed25519:"+b58encode(publicKey)})
      ]);
      const signed=signedFunctionCall({signer:call.actor,seed:raw.subarray(0,32),publicKey,nonce:BigInt(key.nonce)+1n,
        receiver:plan.contracts[call.target],blockHash:b58decode(block.header.hash),method:call.method,args:Buffer.from(JSON.stringify(call.args)),gas:BigInt(call.gasTgas)*10n**12n,deposit:BigInt(call.deposit)});
      // The tx hash is known before dispatch; an RPC timeout never authorizes an automatic resend.
      const decoded=Buffer.from(signed,"base64");hash=b58encode(crypto.createHash("sha256").update(decoded.subarray(0,-65)).digest());
      let result;
      try{result=await request("send_tx",{signed_tx_base64:signed,wait_until:"FINAL"});}
      catch(error){
        try{result=await request("tx",{tx_hash:hash,sender_account_id:call.actor,wait_until:"FINAL"});}
        catch{throw new Error("Unconfirmed transaction; inspect "+hash+" before rerunning: "+error.message);}
      }
      const confirmed=confirmedEvent(result,call.expect,plan.contracts);
      results.push({actor:call.actor,method:call.method,hash,confirmed,isTrade:["buy","sell"].includes(call.expect.event),ms:performance.now()-start,
        receiptFailures:(result.receipts_outcome??[]).filter(r=>r.outcome?.status?.Failure).length});
    }catch(error){results.push({actor:call.actor,method:call.method,hash,confirmed:false,ms:performance.now()-start,error:error.message});}
  }));
  const elapsedSeconds=(performance.now()-started)/1000;
  const completed=results.filter(r=>r.confirmed),latencies=completed.map(r=>r.ms);
  const cases=[];
  for(const market_id of plan.caseIds??[]){
    const c=await read(plan.contracts.oracle,"get_case",{market:plan.contracts.market,market_id});
    const record={market_id,stage:c?.stage??null,applied:c?.applied??false};
    if(c?.case_uid){
      const juries=await Promise.all([c.case_uid,String(BigInt(c.case_uid)|(1n<<63n))].map(case_key=>read(plan.contracts.council,"jury_of",{case_key})));
      record.unlocked=juries.every(j=>j.length===0);record.complete=c.stage==="final"&&c.applied&&record.unlocked;
    }else record.complete=false;
    cases.push(record);
  }
  let keeper=null;
  if(plan.keeperStateFile){
    const state=JSON.parse(fs.readFileSync(plan.keeperStateFile,"utf8"));const block=await request("block",{finality:"final"});
    if(state.scope?.market!==plan.contracts.market || state.scope?.oracle!==plan.contracts.oracle || state.scope?.council!==plan.contracts.council)throw new Error("Keeper state belongs to another deployment");
    keeper={finalHeight:String(block.header.height),cursor:state.cursor,lagBlocks:state.cursor?String(BigInt(block.header.height)-BigInt(state.cursor.height)):null,jobs:Object.keys(state.jobs).length};
  }
  return {mode:"executed",elapsedSeconds,confirmed:completed.length,attempted:results.length,confirmedCallsPerSecond:completed.length/elapsedSeconds,
    confirmedTradesPerSecond:completed.filter(r=>r.isTrade).length/elapsedSeconds,
    latencyMs:{p50:percentile(latencies,0.5),p95:percentile(latencies,0.95)},rpcCalls,byMethod,cases,keeper,results};
}
if(import.meta.url===pathToFileURL(process.argv[1]??"").href){
  const [file,...flags]=process.argv.slice(2);
  if(!file||flags.some(f=>f!=="--execute"))throw new Error("Usage: node load-test.mjs workload.json [--execute]");
  run(JSON.parse(fs.readFileSync(file,"utf8")),flags.includes("--execute")).then(report=>console.log(JSON.stringify(report,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
