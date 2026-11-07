export class BackendRefusal extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export interface Session {
  agentId: string;
  expiresAt: number;
  decimals: number;
}

type Json = Record<string, unknown>;

const MAX_BYTES = 1 << 20;
const CODE = /^[a-z0-9_]{1,64}$/;
const AGENT_ID = /^[0-9a-f]{64}$/;
const record = (value: unknown): Json =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {});

async function bounded(response: Response): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new BackendRefusal(502, 'backend_answer_too_large');
      chunks.push(chunk);
    }
  } catch (error) {
    throw error instanceof BackendRefusal ? error : new BackendRefusal(503, 'backend_unavailable');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BackendRefusal(502, 'backend_answer_unreadable');
  }
}

export class Backend {
  constructor(private readonly origin: string, private readonly fetcher: typeof fetch = fetch) {}

  /** Readiness checks the private API and its database, without any agent credential. */
  async ready(): Promise<void> {
    try {
      const response = await this.fetcher(`${this.origin}/health/ready`, {
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      const answer = record(await bounded(response));
      const checks = record(answer.checks);
      if (!response.ok || answer.status !== 'ready' || checks.database !== 'ok' || checks.schema !== 'current') {
        throw new Error('not_ready');
      }
    } catch {
      throw new BackendRefusal(503, 'backend_unavailable');
    }
  }

  async call(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Json> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}/v1/agent-access/${path}`, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(60000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new BackendRefusal(503, 'backend_unavailable');
    }
    const answer = record(await bounded(response));
    if (response.ok) return answer;
    const code = record(answer.error).code;
    throw new BackendRefusal(response.status, typeof code === 'string' && CODE.test(code) ? code : 'backend_refused');
  }

  async session(token: string): Promise<Session> {
    const answer = await this.call(token, 'GET', 'session');
    const decimals = record(answer.collateral).decimals, expiresAt = Date.parse(String(answer.expires_at));
    if (typeof answer.agent_id !== 'string' || !AGENT_ID.test(answer.agent_id) || !Number.isSafeInteger(decimals)
      || (decimals as number) < 0 || (decimals as number) > 38 || Number.isNaN(expiresAt)) {
      throw new BackendRefusal(502, 'backend_answer_unreadable');
    }
    return { agentId: answer.agent_id, expiresAt: Math.floor(expiresAt / 1000), decimals: decimals as number };
  }
}
