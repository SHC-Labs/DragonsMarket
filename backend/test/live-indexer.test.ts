import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/migrate.js';
import { readConfig } from '../src/config.js';
import { registerDeployment,ingestionStatus } from '../src/ingestion/store.js';
import { followCycle } from '../src/ingestion/follow.js';
import { NeardataReader } from '../src/ingestion/neardata.js';
import { createReadApi } from '../src/read-api.js';

// Uses synthetic live-format blocks for configured synthetic accounts. Actual mainnet source has a separate test.
test('app live source commits provenance, resumes across skipped heights and exposes honest transaction coverage',async()=>{
 const url=process.env.TEST_DATABASE_URL;assert.ok(url);
 const schema=`live_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:url});
 const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const config=readConfig({DATABASE_URL:url,NETWORK:'mainnet',DEPLOYMENT_ID:'synthetic-mainnet',DEPLOYMENT_START_BLOCK:'100',ROUNDS_CONTRACT_ID:'rounds.synthetic.near',VERIFIER_CONTRACT_ID:'verifier.synthetic.near',COLLATERAL_TOKEN_ID:'nep141:usdc.synthetic.near'});
 let head=100;
 const document=(h:number)=>({block:{header:{height:h,hash:(h===100?'2':'3').repeat(32),prev_hash:(h===100?'1':'2').repeat(32),prev_height:h===100?99:100,timestamp_nanosec:String(1700000000000000000n+BigInt(h))},chunks:[{shard_id:0}]},shards:[{shard_id:0,receipt_execution_outcomes:[{tx_hash:'T'.repeat(32),receipt:null,execution_outcome:{id:(h===100?'A':'B').repeat(32),block_hash:(h===100?'2':'3').repeat(32),outcome:{executor_id:'rounds.synthetic.near',receipt_ids:['D'.repeat(32)],status:{SuccessValue:''},logs:['EVENT_JSON:{"standard":"rounds","version":"1.0.0","event":"fee_set","data":{"fee_bps":50}}']}}}]}]});
 const reader=new NeardataReader(async input=>{const path=new URL(String(input)).pathname;return new Response(JSON.stringify(path.endsWith('/final')?document(head):path.endsWith('/101')?null:document(100)));},async()=>{});
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await registerDeployment(pool,config);
  assert.equal((await followCycle(pool,config,reader)).committed,1);
  head=102;assert.equal((await followCycle(pool,config,reader)).committed,1);
  assert.equal((await followCycle(pool,config,reader)).committed,0);
  const status=await ingestionStatus(pool,config) as any;assert.equal(status.live,true);assert.equal(status.lagBlocks,'0');
  const read=createReadApi(pool,config);
  const data=await read(new URL(`http://localhost/v1/transactions/${'T'.repeat(32)}/receipts?limit=1`)) as any;
  assert.equal(data.data.length,1);assert.ok(data.nextCursor);assert.equal(data.transactionCompletion,'not_inferred');
  assert.equal(data.data[0].transaction_hash,'T'.repeat(32));assert.deepEqual(data.data[0].child_receipt_ids,['D'.repeat(32)]);
  const second=await read(new URL(`http://localhost/v1/transactions/${'T'.repeat(32)}/receipts?limit=1&cursor=${data.nextCursor}`)) as any;
  assert.equal(second.data[0].block_height,'102');assert.equal(second.nextCursor,null);
  await pool.query("UPDATE source_heads SET heartbeat_at=now()-interval '2 minutes'");
  assert.equal((await ingestionStatus(pool,config) as any).live,false);
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
