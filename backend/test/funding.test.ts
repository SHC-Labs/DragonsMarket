import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareIntentsDeposit,fundingTokens} from '../src/funding.js';
test('unsigned NEAR/USDC deposits bind the beneficiary, pin native tokens and check storage/balance',async()=>{
 let balance='10000000';
 const view=async(contract:string,method:string,args:Record<string,unknown>)=>{
  if(method==='ft_metadata')return contract===fundingTokens.NEAR.contract?{symbol:'wNEAR',decimals:24}:{symbol:'USDC',decimals:6};
  if(method==='storage_balance_of')return args.account_id==='intents.near'?{total:'1250000000000000000000'}:null;
  if(method==='storage_balance_bounds')return {min:'1250000000000000000000'};
  if(method==='ft_balance_of')return balance;
  throw new Error('unexpected_view');
 };
 const near=await prepareIntentsDeposit('alice.near','NEAR','1000000000000000000000000',view);
 assert.deepEqual(near.actions.map(a=>a.methodName),['storage_deposit','near_deposit','ft_transfer_call']);
 assert.equal(near.actions[2]!.args.msg,'alice.near');assert.equal(near.actions[2]!.args.receiver_id,'intents.near');assert.equal(near.executionEnabled,false);
 const usdc=await prepareIntentsDeposit('alice.near','USDC','5000000',view);assert.equal(usdc.actions.length,1);assert.equal(usdc.decimals,6);assert.equal(usdc.beneficiary,'alice.near');
 balance='1';await assert.rejects(prepareIntentsDeposit('alice.near','USDC','5000000',view),/insufficient_usdc_balance/);
 await assert.rejects(prepareIntentsDeposit('alice.testnet','NEAR','1',view),/invalid_funding_request/);
 await assert.rejects(prepareIntentsDeposit('alice.near','NEAR','1',async()=>({symbol:'USDT',decimals:6})),/funding_token_metadata_mismatch/);
});
