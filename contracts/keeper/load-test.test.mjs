import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { validatePlan, confirmedEvent, run } from "./load-test.mjs";
import { signedFunctionCall } from "./keeper.mjs";
const contracts={market:"market.testnet",oracle:"oracle.testnet",council:"council.testnet",verifier:"verifier.testnet"};
const call={actor:"alice.testnet",target:"market",method:"buy",args:{market_id:"0",side:"yes",amount:"10",min_shares:"1"},deposit:"1",gasTgas:100,expect:{receiver:"market",event:"buy",data:{market_id:"0"}}};
const plan={rpc:"http://rpc.invalid",contracts,workers:2,actors:[{id:"alice.testnet",keyFile:"/never/read"}],calls:[call]};
test("planning does not read keys or contact RPC",async t=>{
  t.mock.method(globalThis,"fetch",()=>{throw new Error("No RPC during planning");});
  assert.equal((await run(plan)).mode,"plan");
  for(const bad of [{contracts:{...contracts,market:"market.near"}},{workers:9},{calls:[{...call,method:"set_owner"}]},{calls:[{...call,deposit:"1000000000000000000000001"}]},{calls:[{...call,expect:{receiver:"market",event:"buy",data:{}}}]},{calls:[{...call,target:"verifier",method:"mt_transfer_call",args:{receiver_id:"foreign.testnet"}}]}])assert.throws(()=>validatePlan({...plan,...bad}));
});
test("a mainnet RPC is refused before keys or transactions",async t=>{
  t.mock.method(globalThis,"fetch",async()=>Response.json({result:{chain_id:"mainnet"}}));
  await assert.rejects(run(plan,true),/not testnet/);
});
test("trade evidence needs finality, receipt success, receiver, event and entity",()=>{
  const event={standard:"market",event:"buy",data:{market_id:"0"}};
  const outcome={executor_id:contracts.market,status:{SuccessValue:""},logs:["EVENT_JSON:"+JSON.stringify(event)]};
  const result={final_execution_status:"FINAL",status:{SuccessValue:""},receipts_outcome:[{outcome}]};
  assert.equal(confirmedEvent(result,call.expect,contracts),true);
  assert.equal(confirmedEvent({...result,final_execution_status:"EXECUTED_OPTIMISTIC"},call.expect,contracts),false);
  for(const bad of [{executor_id:contracts.oracle},{status:{Failure:{}}},{logs:["EVENT_JSON:"+JSON.stringify({...event,data:{market_id:"1"}})]},{logs:["EVENT_JSON:"+JSON.stringify({...event,standard:"fake"})]}])assert.equal(confirmedEvent({...result,receipts_outcome:[{outcome:{...outcome,...bad}}]},call.expect,contracts),false);
});
test("the shared signer preserves the native deposit and signs the exact transaction bytes",()=>{
  const seed=Buffer.alloc(32,7),key=crypto.createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed]),format:"der",type:"pkcs8"});
  const publicKey=crypto.createPublicKey(key).export({format:"der",type:"spki"}).subarray(-32);
  const signed=Buffer.from(signedFunctionCall({signer:"alice.testnet",seed,publicKey,nonce:1n,receiver:contracts.market,blockHash:Buffer.alloc(32),method:"buy",args:Buffer.from("{}"),gas:100n*10n**12n,deposit:123n}),"base64");
  const tx=signed.subarray(0,-65),signature=signed.subarray(-64);
  assert.equal(tx.readBigUInt64LE(tx.length-16),123n);
  assert.equal(tx.readBigUInt64LE(tx.length-8),0n);
  assert(crypto.verify(null,crypto.createHash("sha256").update(tx).digest(),crypto.createPublicKey(key),signature));
});

test("every workload method is part of the current application ABI",()=>{
  const source=fs.readFileSync(new URL("./load-test.mjs",import.meta.url),"utf8");
  for(const target of ["market","oracle","council"]){
    const block=source.match(new RegExp(target+": new Set\\(\\[([^\\]]+)"))[1];
    const contract=fs.readFileSync(new URL("../"+target+"/src/lib.rs",import.meta.url),"utf8");
    for(const method of block.matchAll(/"([a-z_]+)"/g))assert.match(contract,new RegExp("pub (?:async )?fn "+method[1]+"\\("));
  }
});
