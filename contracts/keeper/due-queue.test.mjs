import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newQueue, readQueue, writeQueue, withQueueLock, touch, finish, retry, selectJobs, bounded, serializeByKey, ingestBlock, ingestFile } from './due-queue.mjs';
import { nextMarketAt } from './keeper.mjs';
const scope={rpc:'http://localhost:3030',market:'market.near',oracle:'oracle.near',council:'council.near'};
const event=(standard,name,data)=>'EVENT_JSON:'+JSON.stringify({standard,version:'1.0.0',event:name,data});
const receipt=(receiver_id,logs,status={SuccessValue:''},receipt_id='receipt-1')=>({receiver_id,logs,status,receipt_id});
const block=(height,receipts=[],prev_hash='genesis')=>({finalized:true,header:{height:String(height),hash:'hash-'+height,prev_hash,timestamp_nanosec:String(BigInt(height)*1_000_000_000n)},receipts});
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'dragons-queue-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}

test('a future market never pins unrelated due work and batches stay bounded',()=>{
 const s=newQueue(scope);touch(s,'market','0',999999n);touch(s,'market','1',1n);touch(s,'market','2',1n);
 assert.deepEqual(selectJobs(s,2n,1).map(j=>j.id),['1']);
 assert.equal(selectJobs(s,2n,1).length,1);
 for(let i=3;i<1000;i++)touch(s,'market',i,999999n);
 assert.ok(selectJobs(s,2n,50).length<=12,'only due jobs and ten repair reads, never the catalog');
});
test('receipt success, receiver, standard and market scope govern event ingestion',()=>{
 const s=newQueue(scope);
 ingestBlock(s,block(1,[
  receipt(scope.market,[event('market','market_created',{market_id:'7'})]),
  receipt(scope.market,[event('market','market_created',{market_id:'8'})],{Failure:{}},'failed'),
  receipt('foreign.near',[event('market','market_created',{market_id:'9'})],undefined,'foreign'),
  receipt(scope.oracle,[event('oracle','proposed',{market:'other.near',market_id:'10'})],undefined,'other-market'),
  receipt(scope.oracle,[event('oracle','challenged',{market:scope.market,market_id:'11'})],{SuccessReceiptId:'child'},'parent-success'),
 ]));
 assert.deepEqual(Object.keys(s.jobs).sort(),['market:11','market:7']);
 assert.equal(s.cursor.height,'1');
});
test('replay, duplicate receipts and a block gap never duplicate or lose work',()=>{
 const s=newQueue(scope),r=receipt(scope.market,[event('market','fees_swept',{id:'1'})]);
 const b=block(5,[r,r]);assert.equal(ingestBlock(s,b),true);assert.equal(ingestBlock(s,b),false);
 assert.equal(Object.keys(s.jobs).length,1);
 assert.throws(()=>ingestBlock(s,block(7,[],'missing')),/gap/);
 assert.equal(s.cursor.height,'5');
 ingestBlock(s,block(7,[],'hash-5')); // NEAR can skip heights; hash continuity is what matters.
 assert.equal(s.cursor.height,'7');
 assert.throws(()=>ingestBlock(s,{...block(7),header:{...block(7).header,hash:'fork'}}),/hash changed/);
});
test('invalid late event leaves the entire block uncommitted',()=>{
 const s=newQueue(scope);
 assert.throws(()=>ingestBlock(s,block(1,[receipt(scope.market,[event('market','market_created',{market_id:'7'}),'EVENT_JSON:broken'])])));
 assert.deepEqual(s.jobs,{});assert.equal(s.cursor,null);
});
test('jury events wake the correct market and unresolved sweeps have no recent-history cutoff',()=>{
 const s=newQueue(scope);s.caseMarkets['42']='500';
 ingestBlock(s,block(10,[receipt(scope.council,[event('council','jury_released',{case_key:String((1n<<63n)|42n)})]),receipt(scope.market,[event('market','fee_transfer_unresolved',{sweep_id:'1'})],undefined,'old-sweep')]));
 assert.ok(s.jobs['market:500']);assert.ok(s.jobs['sweep:1']);
});
test('atomic queue storage binds scope and migrates the old cursor through bounded bootstrap',t=>{
 const file=path.join(temp(t),'state.json'),s=newQueue(scope);touch(s,'market','7',5n);writeQueue(file,s);
 assert.deepEqual(readQueue(file,scope),s);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.throws(()=>readQueue(file,{...scope,market:'other.near'}),/scope/);
 fs.writeFileSync(file,JSON.stringify({finished_through:'90'}));
 const migrated=readQueue(file,scope);assert.equal(migrated.marketCursor,'0');assert.equal(migrated.legacyCursor,'90');
});
test('partial event lines are retried and cursor is persisted with scheduled work',t=>{
 const dir=temp(t),file=path.join(dir,'events.jsonl'),stateFile=path.join(dir,'queue.json'),s=newQueue(scope);
 const a=JSON.stringify(block(1,[receipt(scope.market,[event('market','market_created',{market_id:'4'})])]))+'\n';
 const b=JSON.stringify(block(2,[receipt(scope.market,[event('market','fees_swept',{id:'1'})])],'hash-1'));
 fs.writeFileSync(file,a+b.slice(0,30));assert.equal(ingestFile(s,file,2),1);assert.equal(s.eventOffset,Buffer.byteLength(a));
 writeQueue(stateFile,s);const restored=readQueue(stateFile,scope);assert.ok(restored.jobs['market:4']);
 fs.appendFileSync(file,b.slice(30)+'\n');assert.equal(ingestFile(restored,file,2),1);assert.ok(restored.jobs['sweep:1']);
 assert.equal(restored.cursor.height,'2');
});
test('future blocks are not consumed and a truncated feed is refused',t=>{
 const file=path.join(temp(t),'events.jsonl'),s=newQueue(scope);fs.writeFileSync(file,JSON.stringify(block(8))+'\n');
 assert.equal(ingestFile(s,file,7),0);assert.equal(s.eventOffset,0);
 ingestFile(s,file,8);fs.writeFileSync(file,'');assert.throws(()=>ingestFile(s,file,8),/truncated/);
});
test('retries back off, survive restart and cap their delay',t=>{
 const s=newQueue(scope),j=touch(s,'market','1',0n);retry(j,0n,'timeout');assert.equal(j.nextAt,'1000000000');
 retry(j,0n,'timeout');assert.equal(j.nextAt,'2000000000');for(let i=0;i<30;i++)retry(j,0n,'unknown');
 assert.equal(j.nextAt,'900000000000');const file=path.join(temp(t),'queue.json');writeQueue(file,s);assert.equal(readQueue(file,scope).jobs['market:1'].failures,20);
 finish(s,j);assert.deepEqual(s.jobs,{});
});
test('workers are bounded and the same access key never races its nonce',async()=>{
 let active=0,max=0;const serial=serializeByKey(),seen=[];
 await bounded([1,2,3,4],4,n=>serial('same-key',async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));seen.push(n);active--;}));
 assert.equal(max,1);assert.deepEqual(seen,[1,2,3,4]);
 await assert.rejects(bounded([1],9,()=>{}),/Workers/);
});
test('one live process owns a queue and the lock is removed on failure',async t=>{
 const file=path.join(temp(t),'queue.json');
 await withQueueLock(file,async()=>{assert.throws(()=>withQueueLock(file,()=>{}),/Another keeper/);});
 assert.ok(!fs.existsSync(file+'.lock'));
 await assert.rejects(withQueueLock(file,async()=>{throw new Error('failed');}),/failed/);assert.ok(!fs.existsSync(file+'.lock'));
});
test('draw windows, panel deadlines and completed cases have independent due times',()=>{
 const m={id:'0',outcome:null,resolve_by:'1000'},c={stage:'disputed',panel:[],draw_by:'500',draw_after_height:'10'};
 assert.equal(nextMarketAt(m,c,false,5n,9n),1_000_000_005n);
 assert.equal(nextMarketAt(m,c,false,5n,10n),5n);
 assert.equal(nextMarketAt(m,{...c,panel:['juror.near'],panel_deadline:'700'},false,5n,10n),701n);
 assert.equal(nextMarketAt({...m,outcome:'yes'},{stage:'final',applied:true},false,5n,10n),null);
});
