// Reading the chain, and base58, for the keeper and the treasury helper. No dependencies: Node 22 built-ins only.

export async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "keeper", method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
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
  if (result.error) throw new Error(`${account}.${method}: ${result.error}`);
  return JSON.parse(Buffer.from(result.result).toString());
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
