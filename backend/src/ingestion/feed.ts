import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { open, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { readConfig } from '../config.js';
import { createPool, verifyDatabase } from '../database.js';

/** Recover an append after fsync but before DB acknowledgement by comparing the unacknowledged bytes. */
export async function exportFeed(pool:pg.Pool,deployment:string,path:string,limit=50){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('invalid_feed_limit');
  const root=resolve('.local/feeds'),target=resolve(path);
  if(!target.startsWith(root+'/'))throw new Error('feed_must_be_under_local_feeds');
  const key=createHash('sha256').update(relative(root,target)).digest('hex');
  const c=await pool.connect();let file: Awaited<ReturnType<typeof open>>|undefined;
  let locked=false;
  try{
    locked=(await c.query('SELECT pg_try_advisory_lock(704346944,hashtext($1)) AS ok',[key])).rows[0].ok;
    if(!locked)throw new Error('feed_exporter_running');
    await mkdir(dirname(target),{recursive:true});
    const actualRoot=await realpath(root),parent=await realpath(dirname(target));
    if(actualRoot!==root||(parent!==actualRoot&&!parent.startsWith(actualRoot+'/')))throw new Error('feed_symlink_refused');
    file=await open(target,constants.O_RDWR|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    if(!(await file.stat()).isFile())throw new Error('feed_regular_file_required');
    await c.query('INSERT INTO feed_exports(deployment_id,destination_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[deployment,key]);
    const cursor=(await c.query('SELECT height::text,byte_offset::text FROM feed_exports WHERE deployment_id=$1 AND destination_hash=$2',[deployment,key])).rows[0];
    let offset=Number(cursor.byte_offset);
    if(!Number.isSafeInteger(offset))throw new Error('feed_offset_too_large');
    const size=(await file.stat()).size;
    if(size<offset)throw new Error('feed_truncated');
    if(cursor.height){
      const last=(await c.query('SELECT keeper_payload FROM indexed_blocks WHERE deployment_id=$1 AND block_height=$2',[deployment,cursor.height])).rows[0];
      if(!last)throw new Error('feed_checkpoint_missing');
      const expected=Buffer.from(JSON.stringify(last.keeper_payload)+'\n');
      if(offset<expected.length)throw new Error('feed_offset_invalid');
      const tail=Buffer.alloc(expected.length);await file.read(tail,0,tail.length,offset-tail.length);
      if(!tail.equals(expected))throw new Error('feed_acknowledged_tail_changed');
    }
    const {rows}=await c.query('SELECT block_height::text,keeper_payload FROM indexed_blocks WHERE deployment_id=$1 AND ($2::numeric IS NULL OR block_height>$2) ORDER BY block_height LIMIT $3',[deployment,cursor.height,limit]);
    let exported=0;
    for(const row of rows){
      const bytes=Buffer.from(JSON.stringify(row.keeper_payload)+'\n');
      if(bytes.length>8*1024*1024)throw new Error('feed_line_too_large');
      const remaining=size-offset;
      if(remaining>0){
        const existing=Buffer.alloc(Math.min(bytes.length,remaining));await file.read(existing,0,existing.length,offset);
        if(!bytes.subarray(0,existing.length).equals(existing))throw new Error('feed_unacknowledged_content_changed');
        if(existing.length<bytes.length){await file.truncate(offset);await file.writeFile(bytes);}
      }else await file.writeFile(bytes);
      await file.sync();offset+=bytes.length;
      await c.query('UPDATE feed_exports SET height=$3,byte_offset=$4,updated_at=now() WHERE deployment_id=$1 AND destination_hash=$2',[deployment,key,row.block_height,offset]);
      exported++;
    }
    if(rows.length===0&&size>offset)throw new Error('feed_contains_unindexed_data');
    return {exported,byteOffset:String(offset)};
  }finally{
    await file?.close();if(locked)await c.query('SELECT pg_advisory_unlock(704346944,hashtext($1))',[key]).catch(()=>{});c.release();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 let pool:pg.Pool|undefined;const stop=new AbortController();process.on('SIGINT',()=>stop.abort());process.on('SIGTERM',()=>stop.abort());
 try{
  const config=readConfig(process.env);if(!config.deployment)throw new Error('deployment_required');pool=createPool(config.databaseUrl);await verifyDatabase(pool,config);
  do{console.log(JSON.stringify(await exportFeed(pool,config.deployment.id,process.env.KEEPER_FEED_PATH||'.local/feeds/keeper.jsonl')));
   if(process.argv.includes('--follow'))await sleep(1000,undefined,{signal:stop.signal}).catch(()=>{});
  }while(process.argv.includes('--follow')&&!stop.signal.aborted);
 }catch{console.error('feed_export_failed');process.exitCode=1;}finally{await pool?.end();}
}
