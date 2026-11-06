export interface McpConfig {
  host: string;
  port: number;
  backendUrl: string;
  publicUrl: URL;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const local = (url: URL) => LOCAL.has(url.hostname);
const privateNetwork = (url: URL) => local(url) || url.hostname.endsWith('.internal');

function origin(value: string | undefined, name: string, allowHttp: (url: URL) => boolean) {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new Error(`Invalid ${name}`); }
  const plain = !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  if (!plain || !(url.protocol === 'https:' || (url.protocol === 'http:' && allowHttp(url)))) {
    throw new Error(`${name} must be a plain https origin`);
  }
  return url;
}

export function readMcpConfig(env: NodeJS.ProcessEnv): McpConfig {
  const port = Number(env.PORT ?? '3700');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return {
    host: env.HOST ?? '127.0.0.1', port,
    backendUrl: origin(env.DRAGONS_API_URL, 'DRAGONS_API_URL', privateNetwork).origin,
    publicUrl: origin(env.MCP_PUBLIC_URL, 'MCP_PUBLIC_URL', local),
  };
}
