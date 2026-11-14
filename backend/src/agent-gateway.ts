import type { AgentWorkerLink } from './config.js';
import { ReadError } from './read-api.js';
import type { AgentRoutes, Body, AgentOwner } from './agent-paths.js';

const WORKER_TIMEOUT_MS = 60000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CODE = /^[a-z0-9_]{1,64}$/;

export interface Forwarded {
  method: string;
  path: string;
  owner?: AgentOwner;
  authorization?: string;
  body: Record<string, unknown> | null;
}

const unavailable = () => new ReadError(502, 'agent_api_unavailable');

function readBody(method: string, body: Body) {
  if (method !== 'POST') return Promise.resolve(null);
  return body().catch((error: unknown) => {
    if (error instanceof ReadError && error.code === 'invalid_json') return null;
    throw error;
  });
}

function answerOf(status: number, text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw unavailable(); }
  if (status === 200) return value;
  const code = (value as { error?: { code?: unknown } } | null)?.error?.code;
  throw status >= 400 && status < 600 && typeof code === 'string' && CODE.test(code)
    ? new ReadError(status, code) : unavailable();
}

async function responseText(response: Response) {
  let size = 0;
  const parts: Uint8Array[] = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw unavailable();
    parts.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
}

export function agentGateway(link: AgentWorkerLink, fetcher: typeof fetch = fetch): AgentRoutes {
  const forward = (request: Forwarded) => fetcher(`${link.url}/internal/agents`, { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${link.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(WORKER_TIMEOUT_MS) })
    .then(async response => ({ status: response.status, text: await responseText(response) }))
    .catch(() => { throw unavailable(); })
    .then(({ status, text }) => answerOf(status, text));
  return {
    owner: (method, path, owner, body) => readBody(method, body).then(sent =>
      forward({ method, path, owner, body: sent })),
    access: (method, path, authorization, body) => readBody(method, body).then(sent =>
      forward({ method, path, ...(authorization === undefined ? {} : { authorization }), body: sent })),
  };
}
