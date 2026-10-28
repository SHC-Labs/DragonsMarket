import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import type pg from 'pg';
import {readConfig,type Config} from './config.js';
import {createPool,verifyDatabase} from './database.js';

// The full scan runs rarely, so it gets its own long limit instead of the API's 3 seconds.
const SCAN_TIMEOUT='10min';
const FOLLOW_INTERVAL_MS=6*60*60*1000;

/**
 * Checks the stored history against itself: every block names the previous stored block as its parent, the checkpoint is the last
 * block, and the events kept equal the events the blocks say they hold. A restore from a damaged backup, a manual edit or a
 * lost write shows up here. A gap in block heights is fine (null slots); a broken parent link is not.
 */
export async function checkChain(pool:pg.Pool,config:Config){
 if(!config.deployment)throw new Error('deployment_not_configured');
 const id=config.deployment.id;
 const client=await pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query(`SET LOCAL statement_timeout='${SCAN_TIMEOUT}'`);
  const blocks=(await client.query(`SELECT count(*)::text AS blocks,min(block_height)::text AS first,max(block_height)::text AS last,
    count(*) FILTER (WHERE parent IS NOT NULL AND prev_hash<>parent)::text AS broken_links,coalesce(sum(event_count),0)::text AS declared_events
    FROM (SELECT block_height,prev_hash,event_count,lag(block_hash) OVER (ORDER BY block_height) AS parent FROM indexed_blocks WHERE deployment_id=$1) b`,[id])).rows[0];
  const events=(await client.query('SELECT count(*)::text AS n FROM raw_events WHERE deployment_id=$1',[id])).rows[0].n;
  const checkpoint=(await client.query('SELECT c.block_height::text AS height,c.block_hash AS hash,b.block_hash AS stored FROM indexer_checkpoints c LEFT JOIN indexed_blocks b ON b.deployment_id=c.deployment_id AND b.block_height=c.block_height WHERE c.deployment_id=$1',[id])).rows[0];
  await client.query('COMMIT');
  const problems:string[]=[];
  if(blocks.broken_links!=='0')problems.push('broken_parent_links');
  if(events!==blocks.declared_events)problems.push('event_count_mismatch');
  if(checkpoint&&(checkpoint.stored!==checkpoint.hash||checkpoint.height!==blocks.last))problems.push('checkpoint_not_last_block');
  if(!checkpoint&&blocks.blocks!=='0')problems.push('blocks_without_checkpoint');
  return {ok:problems.length===0,problems,blocks:blocks.blocks,firstHeight:blocks.first,lastHeight:blocks.last,brokenLinks:blocks.broken_links,events,declaredEvents:blocks.declared_events};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const stop=new AbortController();process.on('SIGTERM',()=>stop.abort());process.on('SIGINT',()=>stop.abort());
 const follow=process.argv.includes('--follow');let pool:pg.Pool|undefined;
 try{
  const config=readConfig(process.env);pool=createPool(config.databaseUrl);await verifyDatabase(pool,config);
  do{
   try{const report=await checkChain(pool,config);await pool.query('INSERT INTO chain_integrity_reports(deployment_id,ok,report) VALUES($1,$2,$3)',[config.deployment!.id,report.ok,JSON.stringify(report)]);console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;}
   catch(error){console.error(JSON.stringify({service:'verify-chain',error:error instanceof Error?error.message.slice(0,200):'unknown'}));process.exitCode=1;if(!follow)break;}
   if(follow)await sleep(FOLLOW_INTERVAL_MS,undefined,{signal:stop.signal}).catch(()=>{});
  }while(follow&&!stop.signal.aborted);
 }catch(error){console.error(JSON.stringify({service:'verify-chain',error:error instanceof Error?error.message.slice(0,200):'unknown'}));process.exitCode=1;}finally{await pool?.end();}
}
