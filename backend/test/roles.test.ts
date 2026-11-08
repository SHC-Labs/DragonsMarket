import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {migrate} from '../src/migrate.js';
test('role template limits API/indexer authority; provisioning test roles roll back',async()=>{
 const url=process.env.TEST_DATABASE_URL;assert.ok(url);const suffix=randomUUID().replaceAll('-',''),schema=`roles_${suffix}`;
 const admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});const names=['api','indexer','worker','publisher','backup','agent','keeper'].map(k=>`t_${suffix}_${k}`);
 let client:pg.PoolClient|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
  await pool.query(`INSERT INTO deployments(id,network,start_block,contracts,collateral_token_id,collateral_decimals) VALUES('roles','sandbox',0,'{"rounds":"rounds.test.near"}','nep141:usdc.test.near',6)`);
  client=await pool.connect();await client.query('BEGIN');
  let sql=await readFile('ops/roles.sql','utf8');sql=sql.replace(/\bpublic\b/g,schema);
  for(const [i,name] of ['api','indexer','worker','publisher','backup','agent','keeper'].entries())sql=sql.replaceAll('dm_'+name,names[i]!);
  await client.query(sql);
  await client.query(`SET LOCAL ROLE ${names[1]}`);
  await client.query('SELECT * FROM deployments');
  await client.query("INSERT INTO source_heads(deployment_id,height,hash,timestamp_ns) VALUES('roles',0,'hash',0)");
  await client.query('SAVEPOINT denied');
  await assert.rejects(client.query("UPDATE deployments SET start_block=1 WHERE id='roles'"),(e:unknown)=>(e as {code:string}).code==='42501');
  await client.query('ROLLBACK TO SAVEPOINT denied');await client.query('RESET ROLE');
  await client.query(`SET LOCAL ROLE ${names[0]}`);
  await client.query('SELECT * FROM raw_events');
  await client.query('SELECT * FROM keeper_status');
  await client.query('SELECT state FROM user_operations WHERE false');
  const denied=async(c:pg.PoolClient,sql:string)=>{
   await c.query('SAVEPOINT denied');
   await assert.rejects(c.query(sql),(e:unknown)=>(e as {code:string}).code==='42501',sql);
   await c.query('ROLLBACK TO SAVEPOINT denied');
  };
  for(const statement of ['SELECT sealed_token FROM agent_grants','SELECT * FROM agent_accounts','SELECT * FROM agent_intents','SELECT token_hash FROM agent_access_tokens','UPDATE user_operations SET state=state WHERE false',"INSERT INTO user_operations(id) VALUES(gen_random_uuid())"])await denied(client,statement);
  await denied(client,"UPDATE keeper_status SET state='ready'");
  await client.query('SAVEPOINT denied_api');
  await assert.rejects(client.query("INSERT INTO reconciliation_reports(deployment_id,block_hash,report,solvent) VALUES('roles','hash','{}',true)"),(e:unknown)=>(e as {code:string}).code==='42501');
  await client.query('ROLLBACK TO SAVEPOINT denied_api');await client.query('RESET ROLE');
  await client.query(`SET LOCAL ROLE ${names[2]}`);
  await client.query('SELECT state FROM user_operations WHERE false');
  for(const statement of ['UPDATE user_operations SET state=state WHERE false','SELECT sealed_token FROM agent_grants'])await denied(client,statement);
  await client.query('RESET ROLE');
  await client.query(`SET LOCAL ROLE ${names[5]}`);
  await client.query('SELECT version FROM schema_migrations');
  await client.query('SELECT id FROM deployments');
  await client.query('SELECT sealed_token FROM agent_grants WHERE false');
  await client.query('UPDATE agent_grants SET state=state WHERE false');
  await client.query('UPDATE agent_accounts SET state=state WHERE false');
  await client.query('UPDATE agent_intents SET status=status WHERE false');
  await client.query('UPDATE agent_access_tokens SET label=label WHERE false');
  await client.query('UPDATE user_operations SET state=state WHERE false');
  for(const statement of ['DELETE FROM agent_access_tokens','SELECT * FROM wallet_sessions','SELECT * FROM signing_decisions'])await denied(client,statement);
  await client.query('RESET ROLE');
  await client.query(`SET LOCAL ROLE ${names[6]}`);
  await client.query('SELECT * FROM indexed_blocks');
  await client.query('SELECT * FROM reconciliation_reports');
  await client.query('SELECT * FROM chain_integrity_reports');
  await client.query("INSERT INTO keeper_status(deployment_id,mode,state) VALUES('roles','prepare','running')");
  await client.query("UPDATE keeper_status SET state='ready'");
  await client.query("INSERT INTO feed_exports(deployment_id,destination_hash) VALUES('roles',repeat('a',64))");
  await client.query('UPDATE feed_exports SET byte_offset=byte_offset');
  for(const statement of ['SELECT * FROM wallet_sessions','SELECT * FROM agent_grants','SELECT * FROM user_operations',
   'UPDATE indexed_blocks SET block_hash=block_hash','UPDATE reconciliation_reports SET solvent=true',
   'UPDATE chain_integrity_reports SET ok=true','DELETE FROM feed_exports'])await denied(client,statement);
  await client.query('RESET ROLE');
  await client.query('ROLLBACK');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1)',[names])).rows[0].n,0);
 }finally{
  if(client){await client.query('ROLLBACK');client.release();}await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
 }
});
