import { isPrivateRoute, type PrivateHandler } from './private-api.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { publicConfig } from './config.js';
import { isReadRoute, ReadError, type ReadHandler } from './read-api.js';

export function createApp(config: Config, ready: () => Promise<void>, indexerStatus: () => Promise<unknown> = async () => ({ state: 'not_configured', live: false }), read?: ReadHandler, privateRead?: PrivateHandler) {
  const limits=new Map<string,{start:number;count:number}>();
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Vary', 'Origin');
    if (req.headers.origin === config.webOrigin) { res.setHeader('Access-Control-Allow-Origin', config.webOrigin); res.setHeader('Access-Control-Allow-Credentials','true'); }
    const reply = (status: number, body: unknown) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    const client=req.socket.remoteAddress??'unknown';
    const now=Date.now();const bucket=limits.get(client);
    if(!bucket||now-bucket.start>=60000){if(limits.size>=10000)limits.delete(limits.keys().next().value!);limits.set(client,{start:now,count:1});}
    else if(++bucket.count>120){res.setHeader('Retry-After','60');reply(429,{error:{code:'rate_limited',requestId}});return;}
    if((req.url?.length??0)>8192){reply(400,{error:{code:'invalid_url',requestId}});return;}
    const privatePath=(req.url??'').split('?')[0]!;
    if(privatePath==='/v1/auth/challenge'){
      const key='challenge:'+client, b=limits.get(key);
      if(!b||now-b.start>=60000)limits.set(key,{start:now,count:1});
      else if(++b.count>5){reply(429,{error:{code:'challenge_rate_limited',requestId}});return;}
    }
    if(req.method==='OPTIONS'&&isPrivateRoute(privatePath)){
      if(req.headers.origin!==config.webOrigin){reply(403,{error:{code:'origin_required',requestId}});return;}
      res.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, PUT, DELETE');res.setHeader('Access-Control-Allow-Headers','Content-Type');reply(204,null);return;
    }
    if(isPrivateRoute(privatePath)&&privateRead){
      try{const url=new URL(req.url!,'http://localhost');reply(200,await privateRead(req,res,url));}
      catch(e){reply(e instanceof ReadError?e.status:503,{error:{code:e instanceof ReadError?e.code:'private_service_unavailable',requestId}});}return;
    }
    if (!['GET', 'HEAD'].includes(req.method ?? '')) {
      res.setHeader('Allow', 'GET, HEAD');
      reply(405, { error: { code: 'method_not_allowed', requestId } }); return;
    }
    let path: string;
    let url: URL;
    try { if ((req.url?.length ?? 0) > 8192) throw new Error(); url = new URL(req.url ?? '/', 'http://localhost'); path = url.pathname; }
    catch { reply(400, { error: { code: 'invalid_url', requestId } }); return; }
    if (path === '/health/live') { reply(200, { status: 'ok' }); return; }
    if (path === '/v1/config') { reply(200, publicConfig(config)); return; }
    if (path === '/v1/indexer/status') {
      try { reply(200, await indexerStatus()); }
      catch { reply(503, { error: { code: 'indexer_status_unavailable', requestId } }); }
      return;
    }
    if (path === '/health/ready') {
      try {
        await ready();
        reply(200, { status: 'ready', checks: { database: 'ok', schema: 'current' }, deploymentConfigured: config.deployment !== null, scope: 'foundation', indexing: config.deployment ? 'see_indexer_status' : 'deployment_not_configured' });
      } catch { reply(503, { status: 'not_ready', error: { code: 'database_or_configuration_unavailable', requestId } }); }
      return;
    }
    if (isReadRoute(path)) {
      try {
        if (!read) throw new ReadError(503, 'read_api_unavailable');
        reply(200, await read(url));
      } catch (error) {
        reply(error instanceof ReadError ? error.status : 503, { error: { code: error instanceof ReadError ? error.code : 'read_api_unavailable', requestId } });
      }
      return;
    }
    reply(404, { error: { code: 'not_found', requestId } });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
