import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {migrate} from '../src/migrate.js';
import {readConfig} from '../src/config.js';
import {verifyDatabase} from '../src/database.js';
import {registerDeployment} from '../src/ingestion/store.js';
import {ingest} from '../src/ingestion/engine.js';
import {FixtureSource} from '../src/ingestion/source.js';
import {prepareOperation} from '../src/services.js';
import {mkdir,rm} from 'node:fs/promises';
const exec=promisify(execFile);
test('pg_dump/pg_restore recover exact database values in an isolated schema',async()=>{
 const url=process.env.TEST_DATABASE_URL;assert.ok(url);const parsed=new URL(url);assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname));
 const schema=`restore_${randomUUID().replaceAll('-','')}`,archive=`.local/backups/${schema}.dump`,pool=new pg.Pool({connectionString:url}),scoped=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const config=readConfig({DATABASE_URL:url,DEPLOYMENT_ID:'restore-test',DEPLOYMENT_START_BLOCK:'100',ROUNDS_CONTRACT_ID:'rounds.fixture.near',VERIFIER_CONTRACT_ID:'verifier.fixture.near',COLLATERAL_TOKEN_ID:'nep141:usdc.fixture.near'});
 const env={...process.env,PGHOST:parsed.hostname,PGPORT:parsed.port,PGDATABASE:parsed.pathname.slice(1),PGUSER:decodeURIComponent(parsed.username),PGPASSWORD:decodeURIComponent(parsed.password)};
 try{
  await mkdir('.local/backups',{recursive:true});await pool.query(`CREATE SCHEMA ${schema}`);
  await migrate(scoped);await registerDeployment(scoped,config);await ingest(scoped,config,new FixtureSource('test/fixtures/blocks.jsonl'));
  const operation=await prepareOperation(scoped,'restore-test','alice.near','withdraw','restore-op',{amount:'9007199254740993'});
  await scoped.query("UPDATE user_operations SET state='unknown' WHERE id=$1",[operation.id]);
  await pool.query(`CREATE TABLE ${schema}.evidence(id text PRIMARY KEY,amount numeric(38,0),payload jsonb)`);
  await pool.query(`INSERT INTO ${schema}.evidence VALUES ('receipt',900719925474099301,'{"state":"unknown"}')`);
  await exec('pg_dump',['--format=custom','--no-owner','--no-acl',`--schema=${schema}`,`--file=${archive}`],{env});
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await exec('pg_restore',['--no-owner','--no-acl','--exit-on-error','--dbname',env.PGDATABASE,archive],{env});
  await verifyDatabase(scoped,config);
  assert.equal((await scoped.query('SELECT count(*)::int AS n FROM raw_events')).rows[0].n,4);
  assert.equal((await scoped.query('SELECT block_height::text FROM indexer_checkpoints')).rows[0].block_height,'103');
  assert.equal((await scoped.query('SELECT state FROM user_operations WHERE id=$1',[operation.id])).rows[0].state,'unknown');
  assert.deepEqual((await pool.query(`SELECT id,amount::text,payload FROM ${schema}.evidence`)).rows,[{id:'receipt',amount:'900719925474099301',payload:{state:'unknown'}}]);
 }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await scoped.end();await pool.end();await rm(archive,{force:true});}
});
