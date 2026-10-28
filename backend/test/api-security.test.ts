import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
test('request limits apply per real socket, with no trust in spoofed forwarded IP headers',async()=>{
 const app=createApp(readConfig({DATABASE_URL:'postgresql://localhost/test'}),async()=>{});app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert.ok(address&&typeof address!=='string');const root=`http://127.0.0.1:${address.port}`;
 try{for(let i=0;i<120;i++)assert.equal((await fetch(root+'/v1/config',{headers:{'X-Forwarded-For':`192.0.2.${i}`}})).status,200);
  const blocked=await fetch(root+'/v1/config');assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'60');
 }finally{app.closeAllConnections();await new Promise<void>((resolve,reject)=>app.close(e=>e?reject(e):resolve()));}
});
