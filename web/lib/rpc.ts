import { config } from "./config";

export class RpcError extends Error {}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "pm", method, params }),
  });
  if (!res.ok) throw new RpcError(`The network answered ${res.status}.`);
  const body = await res.json();
  if (body.error) throw new RpcError(String(body.error.data ?? body.error.message ?? "Network error."));
  return body.result as T;
}

// Read a contract view method. No wallet needed.
export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await rpc<{ result: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: toBase64(JSON.stringify(args)),
  });
  if (result.error) throw new RpcError(result.error);
  const text = new TextDecoder().decode(new Uint8Array(result.result));
  return (text === "" ? null : JSON.parse(text)) as T;
}

// Contract panic messages from a finished transaction, so a failure can be explained in words.
export async function txPanics(txHash: string, signerId: string): Promise<string[]> {
  const result = await rpc<unknown>("EXPERIMENTAL_tx_status", {
    tx_hash: txHash,
    sender_account_id: signerId,
    wait_until: "FINAL",
  });
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      const m = node.match(/Smart contract panicked: (.*)/);
      if (m) found.push(m[1]);
    } else if (node && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(walk);
    }
  };
  walk(result);
  return found;
}
