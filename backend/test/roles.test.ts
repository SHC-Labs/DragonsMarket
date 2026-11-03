import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {migrate} from '../src/migrate.js';
test('role template limits API/indexer authority; provisioning test roles roll back',async()=>{
 const url=process.env.TEST_DATABASE_URL;assert.ok(url);const suffix=randomUUID().replaceAll('-',''),schema=`roles_${suffix}`;
 const admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});const names=['api','indexer','worker','publisher','backup'].map(k=>`t_${suffix}_${k}`);
 let client:pg.PoolClient|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
  await pool.query(`INSERT INTO deployments(id,network,start_block,contracts,collateral_token_id,collateral_decimals) VALUES('roles','sandbox',0,'{"rounds":"rounds.test.near"}','nep141:usdc.test.near',6)`);
  client=await pool.connect();await client.query('BEGIN');
  let sql=await readFile('ops/roles.sql','utf8');sql=sql.replace(/\bpublic\b/g,schema);
  for(const [i,name] of ['api','indexer','worker','publisher','backup'].entries())sql=sql.replaceAll('dm_'+name,names[i]!);
  await client.query(sql);
  await client.query(`SET LOCAL ROLE ${names[1]}`);
  await client.query('SELECT * FROM deployments');
  await client.query("INSERT INTO source_heads(deployment_id,height,hash,timestamp_ns) VALUES('roles',0,'hash',0)");
  await client.query('SAVEPOINT denied');
  await assert.rejects(client.query("UPDATE deployments SET start_block=1 WHERE id='roles'"),(e:unknown)=>(e as {code:string}).code==='42501');
  await client.query('ROLLBACK TO SAVEPOINT denied');await client.query('RESET ROLE');
  await client.query(`SET LOCAL ROLE ${names[0]}`);
  await client.query('SELECT * FROM raw_events');
  await client.query('UPDATE user_operations SET state=state WHERE false');
  await client.query('UPDATE agent_grants SET state=state WHERE false');
  await client.query('SAVEPOINT denied_agent');
  await assert.rejects(client.query('DELETE FROM agent_access_stakes'),(e:unknown)=>(e as {code:string}).code==='42501');
  await client.query('ROLLBACK TO SAVEPOINT denied_agent');
  await client.query('SAVEPOINT denied_api');
  await assert.rejects(client.query("INSERT INTO reconciliation_reports(deployment_id,block_hash,report,solvent) VALUES('roles','hash','{}',true)"),(e:unknown)=>(e as {code:string}).code==='42501');
  await client.query('ROLLBACK TO SAVEPOINT denied_api');await client.query('RESET ROLE');
  await client.query('ROLLBACK');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1)',[names])).rows[0].n,0);
 }finally{
  if(client){await client.query('ROLLBACK');client.release();}await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
 }
});
