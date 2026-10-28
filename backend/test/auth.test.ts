import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
import {KeyPair,KeyPairSigner} from 'near-api-js';
import {readConfig} from '../src/config.js';
import {migrate} from '../src/migrate.js';
import {registerDeployment} from '../src/ingestion/store.js';
import {createApp} from '../src/app.js';
import {createPrivateApi} from '../src/private-api.js';
import {challenge,cleanupExpiredAuth,login,session} from '../src/auth.js';

test('SDK-signed NEP-413 login rejects replay, wrong browser, wrong key permissions and cross-user access',async()=>{
 const url=process.env.TEST_DATABASE_URL;assert.ok(url);const schema=`auth_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const config=readConfig({DATABASE_URL:url,DEPLOYMENT_ID:'auth-test',DEPLOYMENT_START_BLOCK:'0',ROUNDS_CONTRACT_ID:'rounds.test.near',VERIFIER_CONTRACT_ID:'verifier.test.near',COLLATERAL_TOKEN_ID:'nep141:usdc.test.near'});
 const key=KeyPair.fromRandom('ed25519'),signer=new KeyPairSigner(key);
 const signed=async(c:Awaited<ReturnType<typeof challenge>>)=>{
  const s=await signer.signNep413Message(c.request.accountId,{message:c.request.message,nonce:Buffer.from(c.request.nonce,'base64'),recipient:c.request.recipient,callbackUrl:c.request.callbackUrl});
  return {key:s.publicKey.toString(),signature:Buffer.from(s.signature).toString('base64')};
 };
 const app=createApp(config,async()=>{},undefined,undefined,createPrivateApi(pool,config,async()=>true));
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await registerDeployment(pool,config);
  const c=await challenge(pool,config,'alice.near'),s=await signed(c);
  await assert.rejects(login(pool,config,c.request.id,s.key,s.signature,'wrong-browser',async()=>true),/invalid_login/);
  await assert.rejects(login(pool,config,c.request.id,s.key,s.signature,c.browser,async()=>false),/invalid_login/);
  await assert.rejects(login(pool,config,c.request.id,s.key,s.signature,c.browser,async()=>true),/invalid_login/,'a rejected attempt spends the challenge');
  const outage=await challenge(pool,config,'alice.near'),os=await signed(outage);
  await assert.rejects(login(pool,config,outage.request.id,os.key,os.signature,outage.browser,async()=>{throw new Error('rpc_unavailable');}),/rpc_unavailable/);
  const c2=await challenge(pool,config,'alice.near'),s2=await signed(c2);
  const token=await login(pool,config,outage.request.id,os.key,os.signature,outage.browser,async()=>true);
  assert.equal((await session(pool,config,token)).account_id,'alice.near','an RPC outage leaves the challenge usable');
  await assert.rejects(login(pool,config,outage.request.id,os.key,os.signature,outage.browser,async()=>true),/invalid_login/);
  assert.ok(c2&&s2);
  const expired=await challenge(pool,config,'alice.near'),es=await signed(expired);
  await pool.query("UPDATE wallet_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.request.id]);
  await assert.rejects(login(pool,config,expired.request.id,es.key,es.signature,expired.browser,async()=>true),/invalid_login/);
  await pool.query("INSERT INTO wallet_challenges(id,account_id,network,origin,nonce,browser_hash,message,expires_at) SELECT gen_random_uuid(),'old.near',$1,$2,'n'||g,'b','m',now()-interval '3 hours' FROM generate_series(1,2500) g",[config.network,config.webOrigin]);
  assert.equal((await cleanupExpiredAuth(pool)).challenges,2500,'cleanup drains more than one batch per run');
  const bob=await challenge(pool,config,'bob.near'),bs=await signed(bob),bobToken=await login(pool,config,bob.request.id,bs.key,bs.signature,bob.browser,async()=>true);
  app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert.ok(address&&typeof address!=='string');const root=`http://127.0.0.1:${address.port}`;
  const headers={Origin:config.webOrigin,'Content-Type':'application/json',Cookie:`dm_session=${token}`};
  assert.equal((await fetch(root+'/v1/watchlist',{method:'PUT',headers,body:JSON.stringify({item:'rounds.test.near/1'})})).status,200);
  const bobList=await fetch(root+'/v1/watchlist',{headers:{Cookie:`dm_session=${bobToken}`}});assert.deepEqual((await bobList.json()).data,[]);
  const csrf=await fetch(root+'/v1/watchlist',{method:'DELETE',headers:{...headers,Origin:'https://attacker.example'},body:'{"item":"rounds.test.near/1"}'});assert.equal(csrf.status,403);
  assert.equal((await fetch(root+'/v1/policies/acknowledge',{method:'POST',headers,body:'{}'})).status,503);
  assert.equal((await fetch(root+'/v1/auth/logout',{method:'POST',headers,body:'{}'})).status,200);
  assert.equal(await session(pool,config,token),null);
  await pool.query("UPDATE wallet_challenges SET expires_at=now()-interval '3 days'");
  assert.ok((await cleanupExpiredAuth(pool)).challenges!>0);
  assert.equal((await session(pool,config,bobToken)).account_id,'bob.near');
 }finally{app.closeAllConnections();if(app.listening)await new Promise<void>((resolve,reject)=>app.close(e=>e?reject(e):resolve()));await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
