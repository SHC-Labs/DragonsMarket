import { readConfig } from './config.js';
import { createPool, verifyDatabase } from './database.js';
import { createApp } from './app.js';
import { createReadApi, ReadError } from './read-api.js';
import { cleanupExpiredAuth } from './auth.js';
import { backendStatus } from './monitoring.js';
import { createPrivateApi } from './private-api.js';
import { object } from './ingestion/block.js';
import { ingestionStatus } from './ingestion/store.js';

try {
  const config = readConfig(process.env);
  const pool = createPool(config.databaseUrl);
  const evidence=createReadApi(pool,config);
  const server = createApp(config, () => verifyDatabase(pool, config), async () => {
    await verifyDatabase(pool, config);
    return ingestionStatus(pool, config);
  }, async url=>{if(url.pathname==='/v1/health/services'){if(url.search)throw new ReadError(400,'invalid_query');await verifyDatabase(pool,config);return backendStatus(pool,config);}return evidence(url);}, createPrivateApi(pool, config, async (accountId,publicKey)=>{
    const network=await fetch(config.rpc.primaryUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',...(config.rpc.primaryBearerToken?{Authorization:`Bearer ${config.rpc.primaryBearerToken}`}:{})},body:JSON.stringify({jsonrpc:'2.0',id:'network',method:'status',params:{}})});
    const chain:unknown=await network.json();if(!network.ok||!object(chain)||!object(chain.result)||typeof chain.result.chain_id!=='string'||(config.network==='sandbox'?['mainnet','testnet'].includes(chain.result.chain_id):chain.result.chain_id!==config.network))return false;
    const response=await fetch(config.rpc.primaryUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',...(config.rpc.primaryBearerToken?{Authorization:`Bearer ${config.rpc.primaryBearerToken}`}:{})},body:JSON.stringify({jsonrpc:'2.0',id:'auth',method:'query',params:{request_type:'view_access_key',finality:'final',account_id:accountId,public_key:publicKey}})});
    const body:unknown=await response.json();return response.ok&&object(body)&&object(body.result)&&body.result.permission==='FullAccess';
  }, process.env.POLICY_TERMS_HASH&&process.env.POLICY_PRIVACY_HASH?{terms:process.env.POLICY_TERMS_HASH,privacy:process.env.POLICY_PRIVACY_HASH}:null));
  server.on('error', () => { console.error('API failed to listen'); void pool.end(); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Dragons Market backend listening on port ${config.port}`));
  const housekeeping=setInterval(()=>{void cleanupExpiredAuth(pool).catch(()=>console.error('Expired credential cleanup unavailable'));},3600000);housekeeping.unref();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;clearInterval(housekeeping);
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(() => { void pool.end().then(() => clearTimeout(timeout)); });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid backend configuration');
  process.exitCode = 1;
}
