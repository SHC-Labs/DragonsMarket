// Reading the chain, and base58, for the keeper and the treasury helper. No dependencies: Node 22 built-ins only.

// Free public endpoints refuse bursts. `urls` may be one endpoint or several separated by commas: a refused call (HTTP 429 or 5xx,
// a timeout or a dropped connection) moves to the next endpoint after a short wait. Calls are also spaced at least `paceMs` apart
// (KEEPER_RPC_PACE_MS or --rpc-pace-ms), so a long run stays under the limits instead of hitting them and retrying.
let paceMs = Number(process.env.KEEPER_RPC_PACE_MS ?? 0);
let nextSlot = 0;
let credentials = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function setRpcPace(ms) {
  if (!Number.isInteger(ms) || ms < 0 || ms > 60000) throw new Error('Invalid RPC pacing');
  paceMs = ms;
  nextSlot = 0;
}

export function setRpcCredentials(entries) {
  const next = new Map();
  for (const [endpoint, token] of entries) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || typeof token !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(token)) throw new Error('Invalid RPC credential configuration');
    next.set(url.href, token);
  }
  credentials = next;
}

async function responseBody(response) {
  try {
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 16 * 1024 * 1024) throw new Error('oversized_response');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new Error('RPC response unavailable or invalid'); }
}

async function waitForSlot() {
  if (!paceMs) return;
  const at = Math.max(Date.now(), nextSlot);
  nextSlot = at + paceMs;
  if (at > Date.now()) await sleep(at - Date.now());
}

export async function rpc(urls, method, params) {
  const endpoints = String(urls).split(",").map((url) => url.trim()).filter(Boolean);
  let last = "";
  for (let attempt = 0; attempt < Math.max(3, endpoints.length * 2); attempt++) {
    if (attempt > 0) await sleep(400 * attempt);
    await waitForSlot();
    let res;
    try {
      const endpoint = endpoints[attempt % endpoints.length];
      const token = credentials.get(new URL(endpoint).href);
      res = await fetch(endpoint, {
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: "keeper", method, params }),
      });
    } catch {
      last = `${method}: transport unavailable`;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      last = `${method}: HTTP ${res.status}`;
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`${method}: HTTP ${res.status}`); }
    const body = await responseBody(res);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${method}: malformed RPC response`);
    if (body.error) {
      const reported = body.error.cause?.name ?? body.error.name;
      const name = ['UNKNOWN_BLOCK', 'UNKNOWN_ACCOUNT', 'UNKNOWN_ACCESS_KEY', 'TIMEOUT_ERROR', 'HANDLER_ERROR']
        .includes(reported) ? reported : 'RPC_ERROR';
      throw new Error(`${method}: ${name}`);
    }
    if (!Object.hasOwn(body, 'result')) throw new Error(`${method}: missing RPC result`);
    return body.result;
  }
  throw new Error(`every RPC endpoint refused: ${last}`);
}

// Reads at the last final block, or at `blockId` (a height) when two views must agree on one block.
export async function view(url, account, method, args = {}, blockId) {
  const result = await rpc(url, "query", {
    request_type: "call_function",
    ...(blockId === undefined ? { finality: "final" } : { block_id: blockId }),
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (result.error) throw new Error(`${account}.${method}: view rejected`);
  try { return JSON.parse(Buffer.from(result.result).toString()); }
  catch { throw new Error(`${account}.${method}: invalid view result`); }
}

// The same read as a function of (account, method, args), which is the shape the treasury helper asks for.
export function viewer(url, blockId) {
  return (account, method, args = {}) => view(url, account, method, args, blockId);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(text) {
  let n = 0n;
  for (const ch of text) {
    const digit = B58.indexOf(ch);
    if (digit < 0) throw new Error(`"${ch}" is not a base58 character`);
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes]);
}

export function b58encode(bytes) {
  let n = BigInt("0x0" + Buffer.from(bytes).toString("hex"));
  let out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
