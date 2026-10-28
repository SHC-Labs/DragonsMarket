import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rm} from 'node:fs/promises';
import pg from 'pg';
import {recordEvidence} from '../src/prices.js';
import {migrate} from '../src/migrate.js';
import {readConfig} from '../src/config.js';
import {registerDeployment} from '../src/ingestion/store.js';
import {FixtureSource} from '../src/ingestion/source.js';
import {ingest} from '../src/ingestion/engine.js';
import {exportFeed} from '../src/ingestion/feed.js';

test('price evidence is stored once, and the keeper feed recovers from lost acknowledgements and truncation',async()=>{
 const url=process.env.TEST_DATABASE_URL;assert.ok(url);const schema=`feed_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const config=readConfig({DATABASE_URL:url,DEPLOYMENT_ID:'feed',DEPLOYMENT_START_BLOCK:'100',ROUNDS_CONTRACT_ID:'rounds.fixture.near',VERIFIER_CONTRACT_ID:'verifier.fixture.near',COLLATERAL_TOKEN_ID:'nep141:usdc.fixture.near'});
 const file=`.local/feeds/${schema}.jsonl`;
 try{
 await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await registerDeployment(pool,config);
 const observation={asset:'BTC' as const,source:'binance' as const,quote:'USDC' as const,boundaryNs:'1700000100000000000',sourceTimeNs:'1700000099999000000',retrievedAt:new Date().toISOString(),price:'9007199254740993.01',exactBoundary:true,raw:'public-source-evidence'};
 await recordEvidence(pool,observation);await recordEvidence(pool,observation);
 const evidence=(await pool.query('SELECT price,source_time_ns::text FROM price_evidence')).rows;assert.equal(evidence.length,1);assert.equal(evidence[0].price,observation.price);assert.equal(evidence[0].source_time_ns,observation.sourceTimeNs);
 await ingest(pool,config,new FixtureSource('test/fixtures/blocks.jsonl'));
 assert.equal((await exportFeed(pool,'feed',file)).exported,3);
 const before=await readFile(file,'utf8');assert.equal(before.trim().split('\n').length,3);
 // Simulate loss of all DB acknowledgements after bytes were fsynced.
 await pool.query('UPDATE feed_exports SET height=NULL,byte_offset=0');
 assert.equal((await exportFeed(pool,'feed',file)).exported,3);
 assert.equal(await readFile(file,'utf8'),before);
 assert.equal((await exportFeed(pool,'feed',file)).exported,0);
 await pool.query('UPDATE feed_exports SET height=NULL,byte_offset=0');
 const lines=before.split('\n');await writeFile(file,lines[0]+'\n'+lines[1]!.slice(0,20));
 assert.equal((await exportFeed(pool,'feed',file)).exported,3);assert.equal(await readFile(file,'utf8'),before);
 await writeFile(file,before.slice(0,-1));await assert.rejects(exportFeed(pool,'feed',file),/feed_truncated/);
 }finally{await rm(file,{force:true});await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
