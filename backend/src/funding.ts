import {account} from './ingestion/neardata.js';
import {object,parseJson} from './ingestion/block.js';
import type {ReadRpcClient} from './providers.js';
// Official NEAR Intents wrapping guide and Circle's native-USDC address list, checked 2026-10-27.
export const fundingTokens={NEAR:{contract:'wrap.near',decimals:24},USDC:{contract:'17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',decimals:6}} as const;
type FundingView=(contract:string,method:string,args:Record<string,unknown>)=>Promise<unknown>;
const units=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,38})$/.test(v)||BigInt(v)>2n**128n-1n)throw new Error('invalid_funding_amount');return BigInt(v);};
export async function fundingViews(rpc:Pick<ReadRpcClient,'call'>){
 const status=await rpc.call('status',{});if(!object(status)||status.chain_id!=='mainnet')throw new Error('mainnet_required');
 const block=await rpc.call('block',{finality:'final'});if(!object(block)||!object(block.header)||typeof block.header.hash!=='string')throw new Error('invalid_funding_head');
 const hash=block.header.hash;
 const view:FundingView=async(contract,method,args)=>{
  if(!Object.values(fundingTokens).some(t=>t.contract===contract)||!['ft_metadata','ft_balance_of','storage_balance_of','storage_balance_bounds'].includes(method))throw new Error('funding_view_not_allowed');
  const r=await rpc.call('query',{request_type:'call_function',block_id:hash,account_id:contract,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
  if(!object(r)||r.block_hash!==hash||!Array.isArray(r.result)||r.result.length>65536||r.result.some(b=>!Number.isInteger(b)||b<0||b>255))throw new Error('invalid_funding_view');
  return parseJson(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(r.result)));
 };
 return {blockHash:hash,view};
}
/** Internal unsigned planner only. No endpoint, relayer, private key or broadcast capability. */
export async function prepareIntentsDeposit(accountId:string,asset:'NEAR'|'USDC',amount:string,view:FundingView){
 if(!account(accountId)||accountId.endsWith('.testnet')||!Object.hasOwn(fundingTokens,asset)||units(amount)<=0n)throw new Error('invalid_funding_request');
 const token=fundingTokens[asset],metadata=await view(token.contract,'ft_metadata',{});
 if(!object(metadata)||metadata.decimals!==token.decimals||(asset==='USDC'?metadata.symbol!=='USDC':!['wNEAR','NEAR'].includes(String(metadata.symbol))))throw new Error('funding_token_metadata_mismatch');
 const receiverStorage=await view(token.contract,'storage_balance_of',{account_id:'intents.near'});
 if(!object(receiverStorage)||units(receiverStorage.total)<=0n)throw new Error('intents_token_storage_unregistered');
 const actions:{receiverId:string;methodName:string;args:Record<string,unknown>;gas:string;deposit:string}[]=[];
 if(asset==='NEAR'){
  const senderStorage=await view(token.contract,'storage_balance_of',{account_id:accountId});
  if(senderStorage===null){const bounds=await view(token.contract,'storage_balance_bounds',{});if(!object(bounds)||units(bounds.min)<=0n)throw new Error('invalid_storage_bounds');
   actions.push({receiverId:token.contract,methodName:'storage_deposit',args:{account_id:accountId,registration_only:true},gas:'30000000000000',deposit:bounds.min as string});
  }else if(!object(senderStorage)||units(senderStorage.total)<=0n)throw new Error('invalid_sender_storage');
  actions.push({receiverId:token.contract,methodName:'near_deposit',args:{},gas:'30000000000000',deposit:amount});
 }else{
  if(units(await view(token.contract,'ft_balance_of',{account_id:accountId}))<units(amount))throw new Error('insufficient_usdc_balance');
 }
 actions.push({receiverId:token.contract,methodName:'ft_transfer_call',args:{receiver_id:'intents.near',amount,msg:accountId},gas:'100000000000000',deposit:'1'});
 return {network:'mainnet',signerId:accountId,asset,tokenId:`nep141:${token.contract}`,decimals:token.decimals,amount,
  beneficiary:accountId,actions,executionEnabled:false,credit:'personal_intents_balance_only',completion:'confirm_receipts_and_verifier_credit_before_marking_complete'};
}
