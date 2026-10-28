import {sign,createPublicKey,type KeyObject} from 'node:crypto';
import type pg from 'pg';
import {account} from './ingestion/neardata.js';
import {reserveSigningDecision} from './services.js';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function publicKey(key:KeyObject){
 const raw=createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32);let n=BigInt('0x'+raw.toString('hex')),encoded='';
 while(n){encoded=alphabet[Number(n%58n)]!+encoded;n/=58n;}for(const b of raw){if(b!==0)break;encoded='1'+encoded;}return 'ed25519:'+encoded;
}
export function priceMessage(contract:string,network:string,asset:string,momentNs:string,price:string,decimals:number){
 if(!account(contract)||!['mainnet','testnet','sandbox'].includes(network)||!['BTC','ETH','NEAR'].includes(asset)||!/^(0|[1-9][0-9]{0,19})$/.test(momentNs)||BigInt(momentNs)>2n**64n-1n||!/^[1-9][0-9]{0,38}$/.test(price)||BigInt(price)<=0n||BigInt(price)>2n**128n-1n||!Number.isInteger(decimals)||decimals<0||decimals>18)throw new Error('invalid_price_message');
 return `round-price:v1:${contract}:${network}:${asset}:${momentNs}:${price}:${decimals}`;
}
/** No key-loading or submission CLI is enabled. Caller must first approve source policy and final contract ABI. */
export async function signBoundary(pool:pg.Pool,deployment:string,input:{contract:string;network:string;asset:string;momentNs:string;price:string;decimals:number},key:KeyObject,approved:boolean){
 if(!approved||key.asymmetricKeyType!=='ed25519'||key.type!=='private')throw new Error('publisher_not_approved');
 const row=(await pool.query('SELECT network,contracts FROM deployments WHERE id=$1',[deployment])).rows[0];
 if(!row||row.network!==input.network||row.contracts.rounds!==input.contract)throw new Error('publisher_deployment_mismatch');
 const payload=priceMessage(input.contract,input.network,input.asset,input.momentNs,input.price,input.decimals);
 const publisher=publicKey(key),boundary=`${input.contract}/${input.network}/${input.asset}/${input.momentNs}`;
 const reserved=await reserveSigningDecision(pool,deployment,publisher,boundary,payload);
 const signature=reserved.signature??sign(null,Buffer.from(payload),key).toString('hex');
 await pool.query('UPDATE signing_decisions SET signature=$4 WHERE deployment_id=$1 AND publisher_key=$2 AND boundary_key=$3 AND (signature IS NULL OR signature=$4)',[deployment,publisher,boundary,signature]);
 return {payload,entry:`${publisher}.${signature}`};
}
