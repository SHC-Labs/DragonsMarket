import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request} from 'node:http';
import {createApp,limitKey} from '../src/app.js';
import {readConfig} from '../src/config.js';
const rawPost=(port:number,path:string)=>new Promise<number>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path,method:'POST',headers:{Origin:'http://localhost:3400','Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end('{}');});
test('request limits apply per real socket, with no trust in spoofed forwarded IP headers',async()=>{
 const app=createApp(readConfig({DATABASE_URL:'postgresql://localhost/test'}),async()=>{});app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert.ok(address&&typeof address!=='string');const root=`http://127.0.0.1:${address.port}`;
 try{for(let i=0;i<120;i++)assert.equal((await fetch(root+'/v1/config',{headers:{'X-Forwarded-For':`192.0.2.${i}`}})).status,200);
  const blocked=await fetch(root+'/v1/config');assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'60');
  assert.equal((await fetch(root+'/health/live')).status,200,'application exhaustion does not block liveness');
  assert.equal((await fetch(root+'/health/ready')).status,200,'application exhaustion does not block readiness');
 }finally{app.closeAllConnections();await new Promise<void>((resolve,reject)=>app.close(e=>e?reject(e):resolve()));}
});

test('behind a trusted proxy each client is limited by the address the proxy recorded',async()=>{
 const app=createApp(readConfig({DATABASE_URL:'postgresql://localhost/test',TRUSTED_PROXY_HOPS:'1',TRUSTED_PROXY_ADDRESSES:'127.0.0.1'}),async()=>{});app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert.ok(address&&typeof address!=='string');const root=`http://127.0.0.1:${address.port}`;
 try{for(let i=0;i<120;i++)assert.equal((await fetch(root+'/v1/config',{headers:{'X-Forwarded-For':`203.0.113.9, 192.0.2.1`}})).status,200);
  assert.equal((await fetch(root+'/v1/config',{headers:{'X-Forwarded-For':'203.0.113.9, 192.0.2.1'}})).status,429);
  assert.equal((await fetch(root+'/v1/config',{headers:{'X-Forwarded-For':'203.0.113.9, 192.0.2.2'}})).status,200,'a different client behind the proxy has its own budget');
  assert.equal((await fetch(root+'/v1/config',{headers:{'X-Forwarded-For':'198.51.100.7, 192.0.2.2'}})).status,200,'entries left of the proxy hop are client-controlled and ignored');
 }finally{app.closeAllConnections();await new Promise<void>((resolve,reject)=>app.close(e=>e?reject(e):resolve()));}
});

test('the challenge limit also holds for dot-segment paths',async()=>{
 const app=createApp(readConfig({DATABASE_URL:'postgresql://localhost/test'}),async()=>{},undefined,undefined,async()=>({}));app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert.ok(address&&typeof address!=='string');const root=`http://127.0.0.1:${address.port}`;
 try{const statuses:number[]=[];for(let i=0;i<7;i++)statuses.push(await rawPost(address.port,'/v1/auth/x/../challenge'));
  assert.deepEqual(statuses.slice(5),[429,429]);
 }finally{app.closeAllConnections();await new Promise<void>((resolve,reject)=>app.close(e=>e?reject(e):resolve()));}
});

test('NEAR and EVM challenges share a single allowance, including normalized paths', async () => {
 const app = createApp(readConfig({ DATABASE_URL: 'postgresql://localhost/test' }),
  async () => {}, undefined, undefined, async () => ({}));
 app.listen(0, '127.0.0.1');
 await once(app, 'listening');
 const address = app.address();
 assert.ok(address && typeof address !== 'string');
 try {
  for (const path of ['/v1/auth/challenge', '/v1/auth/evm/challenge', '/v1/auth/evm/x/../challenge',
   '/v1/auth/challenge', '/v1/auth/evm/challenge']) {
   assert.equal(await rawPost(address.port, path), 200);
  }
  assert.equal(await rawPost(address.port, '/v1/auth/evm/challenge'), 429);
  assert.equal(await rawPost(address.port, '/v1/auth/challenge'), 429);
 } finally {
  app.closeAllConnections();
  await new Promise<void>(resolve => app.close(() => resolve()));
 }
});

test('a peer that is not a configured proxy cannot choose its own limit key',async()=>{
 const app=createApp(readConfig({DATABASE_URL:'postgresql://localhost/test',TRUSTED_PROXY_HOPS:'1',TRUSTED_PROXY_ADDRESSES:'10.255.255.1'}),async()=>{});app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert.ok(address&&typeof address!=='string');const root=`http://127.0.0.1:${address.port}`;
 try{for(let i=0;i<120;i++)assert.equal((await fetch(root+'/v1/config',{headers:{'X-Forwarded-For':`198.51.100.${i}`}})).status,200);
  assert.equal((await fetch(root+'/v1/config',{headers:{'X-Forwarded-For':'198.51.100.200'}})).status,429);
 }finally{app.closeAllConnections();await new Promise<void>((resolve,reject)=>app.close(e=>e?reject(e):resolve()));}
});

test('every address in an IPv6 /64 shares one limit key, and mapped IPv4 uses the IPv4 key',()=>{
 assert.equal(limitKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'),limitKey('2001:db8:1:2::1'));
 assert.notEqual(limitKey('2001:db8:1:2::1'),limitKey('2001:db8:1:3::1'));
 assert.equal(limitKey('::ffff:192.0.2.5'),'192.0.2.5');
 assert.equal(limitKey('192.0.2.5'),'192.0.2.5');
});

test('a proxy hop count without proxy addresses is refused at startup',()=>{
 assert.throws(()=>readConfig({DATABASE_URL:'postgresql://localhost/test',TRUSTED_PROXY_HOPS:'1'}),/TRUSTED_PROXY_ADDRESSES/);
 assert.throws(()=>readConfig({DATABASE_URL:'postgresql://localhost/test',TRUSTED_PROXY_HOPS:'1',TRUSTED_PROXY_ADDRESSES:'not-an-ip'}),/Invalid TRUSTED_PROXY_ADDRESSES/);
 assert.throws(()=>readConfig({DATABASE_URL:'postgresql://localhost/test',TRUSTED_PROXY_HEADER:'x-real-ip'}),/exactly one/);
 assert.throws(()=>readConfig({DATABASE_URL:'postgresql://localhost/test',TRUSTED_PROXY_HEADER:'arbitrary'}),/Invalid TRUSTED_PROXY_HEADER/);
});

test('rejected challenge methods and origins do not consume login allowance',async()=>{
 const config=readConfig({DATABASE_URL:'postgresql://localhost/test'});
 const app=createApp(config,async()=>{},undefined,undefined,async()=>({}));
 app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert.ok(address&&typeof address!=='string');
 const root=`http://127.0.0.1:${address.port}/v1/auth/challenge`;
 try{
  for(let i=0;i<6;i++)for(const method of ['GET','HEAD','OPTIONS','POST']){
   const response=await fetch(root,{method,headers:{Origin:'https://untrusted.example'}});
   assert.notEqual(response.status,429);await response.arrayBuffer();
  }
  for(let i=0;i<5;i++)assert.equal(await rawPost(address.port,'/v1/auth/challenge'),200);
  assert.equal(await rawPost(address.port,'/v1/auth/challenge'),429);
 }finally{app.closeAllConnections();await new Promise<void>(resolve=>app.close(()=>resolve()));}
});

test('X-Real-IP is accepted only from a configured peer and cannot be overridden by X-Forwarded-For',async()=>{
 const token='operator-test-token-0123456789abcdef';
 for(const peer of ['127.0.0.1','192.0.2.10']){
  const config=readConfig({DATABASE_URL:'postgresql://localhost/test',OPERATOR_TOKEN:token,TRUSTED_PROXY_HEADER:'x-real-ip',TRUSTED_PROXY_HOPS:'1',TRUSTED_PROXY_ADDRESSES:peer});
  const app=createApp(config,async()=>{});app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert.ok(address&&typeof address!=='string');
  const root=`http://127.0.0.1:${address.port}`;
  try{
   const headers={Authorization:`Bearer ${token}`,'X-Real-IP':'198.51.100.1','X-Forwarded-For':'203.0.113.5'};
   const ingress=await (await fetch(root+'/v1/operator/ingress',{headers})).json();
   assert.equal(ingress.client,peer==='127.0.0.1'?'198.51.100.1':'127.0.0.1');
   assert.equal((await fetch(root+'/v1/operator/ingress')).status,404);
   const invalid=await (await fetch(root+'/v1/operator/ingress',{headers:{...headers,'X-Real-IP':'198.51.100.1, 203.0.113.5'}})).json();
   assert.equal(invalid.client,'127.0.0.1','ambiguous identity falls back to peer');
  }finally{app.closeAllConnections();await new Promise<void>(resolve=>app.close(()=>resolve()));}
 }
});

test('concurrent health checks share one bounded database check and refresh after expiry',async t=>{
 t.mock.timers.enable({apis:['Date']});
 let calls=0;let finish:()=>void=()=>{};
 const check=new Promise<void>(resolve=>{finish=resolve;});
 const app=createApp(readConfig({DATABASE_URL:'postgresql://localhost/test'}),()=>{calls++;return check;});
 app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert.ok(address&&typeof address!=='string');
 const root=`http://127.0.0.1:${address.port}/health/ready`;
 try{
  const requests=Array.from({length:20},()=>fetch(root));
  finish();
  for(const response of await Promise.all(requests))assert.equal(response.status,200);
  assert.equal(calls,1);
  t.mock.timers.tick(2001);
  assert.equal((await fetch(root)).status,200);assert.equal(calls,2);
 }finally{app.closeAllConnections();await new Promise<void>(resolve=>app.close(()=>resolve()));}
});
