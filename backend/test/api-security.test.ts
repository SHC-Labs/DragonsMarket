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
});
