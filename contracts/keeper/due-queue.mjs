// Durable scheduling state. The event feed is produced by a trusted finalized-receipt indexer.
// Contract views are re-read before actions; events never authorize a transfer or a verdict.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MARKET_EVENTS = new Set(['market_created','market_registered','market_registration_failed','outcome_set','redeemed','market_pruned']);
const ORACLE_EVENTS = new Set(['proposed','challenged','escalated','jury_drawn','draw_failed','final','outcome_applied','apply_failed','deadline_void']);
const SWEEP_EVENTS = new Set(['fees_swept','fee_transfer_unresolved','fee_transfer_failed','fee_leg_settled','fee_leg_reconciled']);
const NS_PER_MS = 1_000_000n;
export function newQueue(scope) {
  return { version: 1, scope, cursor: null, eventOffset: 0, marketCursor: '0', sweepCursor: '0', reconcileKey: '', jobs: {}, caseMarkets: {} };
}
export function readQueue(file, scope) {
  if (!file || !fs.existsSync(file)) return newQueue(scope);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof state.finished_through === 'string' && DECIMAL.test(state.finished_through)) return { ...newQueue(scope), legacyCursor: state.finished_through };
  if (state.version !== 1 || JSON.stringify(state.scope) !== JSON.stringify(scope) || !state.jobs || !state.caseMarkets) throw new Error('Keeper queue version or contract scope differs; reconcile before reusing it');
  for (const [key,j] of Object.entries(state.jobs)) {
    if (!['market','sweep'].includes(j.kind) || !DECIMAL.test(j.id) || key !== j.kind + ':' + j.id || !DECIMAL.test(j.nextAt)) throw new Error('Invalid keeper queue job');
  }
  return state;
}
export function writeQueue(file, state) {
  const parent = path.dirname(file); fs.mkdirSync(parent, {recursive:true});
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp,file);
  const dir = fs.openSync(parent,'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function withQueueLock(file, work) {
  if (!file) return work();
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const lock = file + '.lock';
  try { fs.writeFileSync(lock, String(process.pid), {flag:'wx',mode:0o600}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock,'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid keeper lock; inspect it before removing');
    try { process.kill(pid,0); throw new Error('Another keeper process owns this queue'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    fs.unlinkSync(lock); fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
  }
  return Promise.resolve().then(work).finally(()=>fs.unlinkSync(lock));
}
export function touch(state, kind, id, now) {
  id = String(id); if (!DECIMAL.test(id)) throw new Error('Invalid event entity id');
  const key = kind + ':' + id;
  state.jobs[key] = { ...(state.jobs[key]??{}), kind, id, nextAt:String(now), failures:0 };
  return state.jobs[key];
}
export function finish(state, job) {
  delete state.jobs[job.kind + ':' + job.id];
  if (job.caseUid) delete state.caseMarkets[job.caseUid];
}
export function retry(job, now, error) {
  job.failures = Math.min((job.failures??0)+1,20);
  const delay = Math.min(900_000,1_000 * 2 ** Math.min(job.failures-1,10));
  job.nextAt = String(now + BigInt(delay)*NS_PER_MS);
  job.error = String(error).slice(0,300);
}
export function selectJobs(state, now, limit=50) {
  if (!Number.isInteger(limit)||limit<1||limit>500) throw new Error('Job batch must be 1 to 500');
  const jobs=Object.values(state.jobs);
  const due=jobs.filter(j=>BigInt(j.nextAt)<=now).sort((a,b)=>BigInt(a.nextAt)<BigInt(b.nextAt)?-1:BigInt(a.nextAt)>BigInt(b.nextAt)?1:(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id)).slice(0,limit);
  // A small rotating reconciliation sample repairs missed changes without a catalog scan.
  const keys=Object.keys(state.jobs).sort();
  const candidates=[...keys.filter(k=>k>state.reconcileKey),...keys.filter(k=>k<=state.reconcileKey)];
  const chosen=new Set(due.map(j=>j.kind+':'+j.id));
  for (const key of candidates.slice(0,Math.min(10,limit-due.length))) { chosen.add(key); state.reconcileKey=key; }
  return [...chosen].map(k=>state.jobs[k]);
}
export async function bounded(items, workers, work) {
  if(!Number.isInteger(workers)||workers<1||workers>8)throw new Error('Workers must be 1 to 8');
  let at=0;const results=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(workers,items.length)},async()=>{
    while(at<items.length){const i=at++;results[i]=await work(items[i],i);}
  }));return results;
}
export function serializeByKey() {
  const tails=new Map();
  return async (key,work)=>{
    const previous=tails.get(key)??Promise.resolve();
    const result=previous.then(work);const tail=result.then(()=>{},()=>{});tails.set(key,tail);
    try{return await result;}finally{if(tails.get(key)===tail)tails.delete(key);}
  };
}
export function ingestBlock(state, block) {
  const h=block.header;
  if(block.finalized!==true||!h||!DECIMAL.test(String(h.height))||typeof h.hash!=='string'||typeof h.prev_hash!=='string'||!DECIMAL.test(String(h.timestamp_nanosec))||!Array.isArray(block.receipts))throw new Error('Expected a finalized block and receipt outcomes');
  if(state.cursor){
    if(BigInt(h.height)<=BigInt(state.cursor.height)){
      if(String(h.height)===state.cursor.height&&h.hash!==state.cursor.hash)throw new Error('Finalized block hash changed');
      return false;
    }
    if(h.prev_hash!==state.cursor.hash)throw new Error('Event feed has a block gap; reconcile it before advancing');
  }
  const seen=new Set(), updates=new Map();
  const enqueue=(kind,id)=>{id=String(id);if(!DECIMAL.test(id))throw new Error("Invalid event entity id");updates.set(kind+":"+id,{kind,id});};
  for(const receipt of block.receipts){
    const receiver=receipt.receiver_id;
    const role=['market','oracle','council'].find(k=>state.scope[k]===receiver);
    if(!role||!receipt.status||(!Object.hasOwn(receipt.status,'SuccessValue')&&!Object.hasOwn(receipt.status,'SuccessReceiptId')))continue;
    if(typeof receipt.receipt_id!=='string'||!Array.isArray(receipt.logs))throw new Error('Invalid successful receipt');
    if(seen.has(receipt.receipt_id))continue;seen.add(receipt.receipt_id);
    for(const log of receipt.logs){
      if(typeof log!=='string'||!log.startsWith('EVENT_JSON:'))continue;
      const event=JSON.parse(log.slice(11));if(event.standard!==role)continue;
      for(const data of Array.isArray(event.data)?event.data:[event.data]){
        if(!data||typeof data!=='object')throw new Error('Invalid contract event data');
        if(data.market!==undefined&&data.market!==state.scope.market)continue;
        if((role==='market'&&MARKET_EVENTS.has(event.event))||(role==='oracle'&&ORACLE_EVENTS.has(event.event)))enqueue('market',data.market_id);
        if(role==='market'&&SWEEP_EVENTS.has(event.event))enqueue('sweep',data.sweep_id??data.id);
        if(role==='council'&&['jury_drawn','jury_released'].includes(event.event)){
          const uid=String(BigInt(data.case_key)&((1n<<63n)-1n));
          if(state.caseMarkets[uid]!==undefined)enqueue('market',state.caseMarkets[uid]);
        }
        if(role==='council'&&event.event==='revenue')enqueue('sweep',data.sweep_id);
      }
    }
  }
  for(const {kind,id} of updates.values())touch(state,kind,id,h.timestamp_nanosec);
  state.cursor={height:String(h.height),hash:h.hash,timestampNs:String(h.timestamp_nanosec)};return true;
}

// A signing pass needs recent finalized evidence, not merely an existing feed file.
export function feedIsCurrent(state, header, wallMs = Date.now()) {
  const cursor = state.cursor;
  if (!cursor || !DECIMAL.test(String(cursor.height)) || !DECIMAL.test(String(cursor.timestampNs))
    || !DECIMAL.test(String(header.height)) || !DECIMAL.test(String(header.timestamp_nanosec))) return false;
  const head = BigInt(header.height), indexed = BigInt(cursor.height);
  const wall = BigInt(wallMs) * NS_PER_MS, at = BigInt(header.timestamp_nanosec), observed = BigInt(cursor.timestampNs);
  if (indexed > head || head - indexed > 100n || observed > at || at - observed > 60_000n * NS_PER_MS) return false;
  if (at > wall + 5_000n * NS_PER_MS || wall - at > 60_000n * NS_PER_MS) return false;
  return indexed !== head || cursor.hash === header.hash;
}
// Read bounded complete JSONL records. A partial trailing line is retried next run.
export function ingestFile(state, file, finalHeight, maxBytes=8_388_608, maxBlocks=32) {
  if(!file)return 0;
  const fd=fs.openSync(file,'r');let count=0;
  try{
    const size=fs.fstatSync(fd).size;
    if(!Number.isSafeInteger(state.eventOffset)||state.eventOffset<0||state.eventOffset>size)throw new Error('Event feed was truncated or replaced; reconcile the cursor');
    const b=Buffer.alloc(Math.min(maxBytes,size-state.eventOffset));fs.readSync(fd,b,0,b.length,state.eventOffset);
    let start=0;
    while(count<maxBlocks){
      const end=b.indexOf(10,start);if(end<0)break;
      const line=b.subarray(start,end).toString('utf8');
      if(line.trim()){
        const block=JSON.parse(line);
        if(BigInt(block.header.height)>BigInt(finalHeight))break;
        ingestBlock(state,block);count++;
      }
      state.eventOffset+=end+1-start;start=end+1;
    }
    if(count===0&&b.length===maxBytes&&!b.includes(10))throw new Error('Event block exceeds the per-run byte bound');
  }finally{fs.closeSync(fd);}return count;
}
