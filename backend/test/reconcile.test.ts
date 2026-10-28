import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfig} from '../src/config.js';
import {reconcile} from '../src/reconcile.js';
import {priceMessage} from '../src/publisher.js';
test('reconciliation pins liabilities and holdings to one block and never credits surplus',async()=>{
 const config=readConfig({DATABASE_URL:'postgresql://localhost/test',NETWORK:'mainnet',DEPLOYMENT_ID:'test',DEPLOYMENT_START_BLOCK:'0',ROUNDS_CONTRACT_ID:'rounds.synthetic.near',VERIFIER_CONTRACT_ID:'verifier.synthetic.near',COLLATERAL_TOKEN_ID:'nep141:usdc.synthetic.near'});
 let held='101';
 const rpc={async call(method:string,params:object){if(method==='status')return {chain_id:'mainnet'};if(method==='block')return {header:{hash:'2'.repeat(32),height:100}};
 const p=params as any;assert.equal(p.block_id,'2'.repeat(32));const value=p.method_name==='total_owed'?'100':held;
 return {block_hash:p.block_id,result:[...Buffer.from(JSON.stringify(value))]};}};
 let report=await reconcile(config,rpc);assert.equal(report.solvent,true);assert.equal(report.contracts[0]!.surplus,'1');
 held='99';report=await reconcile(config,rpc);assert.equal(report.solvent,false);assert.equal(report.contracts[0]!.shortfall,'1');
 assert.equal(priceMessage('rounds.near','mainnet','BTC','600000000000','8000000000000',8),'round-price:v1:rounds.near:mainnet:BTC:600000000000:8000000000000:8');
});
