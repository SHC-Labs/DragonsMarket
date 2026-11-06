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

export async function chainHeight(): Promise<bigint> {
  const block = await rpc<{ header: { height: number } }>("block", { finality: "final" });
  return BigInt(block.header.height);
}

// The mock chain (scripts/mock-chain.mjs) applies a dev account's transaction itself. A real sandbox has no such
// method and refuses it, which reads the same as a wallet that did not send.
export async function sandboxSend(signerId: string, receiverId: string, actions: unknown[]): Promise<string> {
  const sent = await rpc<{ transaction: { hash: string } }>("sandbox_send",
    { signer_id: signerId, receiver_id: receiverId, actions });
  return sent.transaction.hash;
}

export async function nearBalance(accountId: string): Promise<bigint> {
  try {
    const params = { request_type: "view_account", finality: "final", account_id: accountId };
    const account = await rpc<{ amount: string }>("query", params);
    return BigInt(account.amount);
  } catch (e) {
    if (e instanceof RpcError && /does not exist|UNKNOWN_ACCOUNT/.test(e.message)) return 0n;
    throw e;
  }
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

export interface ChainEvent { executor: string; standard: unknown; event: unknown; data: Record<string, unknown> }
interface ReceiptOutcome { outcome?: { executor_id?: string; logs?: string[]; status?: Record<string, unknown> } }

function eventsOf({ outcome }: ReceiptOutcome): ChainEvent[] {
  const status = outcome?.status ?? {};
  if (!("SuccessValue" in status) && !("SuccessReceiptId" in status)) return [];
  return (outcome?.logs ?? []).filter((log) => log.startsWith("EVENT_JSON:")).flatMap((log) => {
    try {
      const e = JSON.parse(log.slice("EVENT_JSON:".length));
      const data = e?.data && typeof e.data === "object" && !Array.isArray(e.data) ? e.data : {};
      return [{ executor: outcome?.executor_id ?? "", standard: e?.standard, event: e?.event, data }];
    } catch {
      return [];
    }
  });
}

export async function txEvents(txHash: string, signerId: string): Promise<ChainEvent[]> {
  const result = await rpc<{ receipts_outcome?: ReceiptOutcome[] }>("EXPERIMENTAL_tx_status", {
    tx_hash: txHash,
    sender_account_id: signerId,
    wait_until: "FINAL",
  });
  return (result.receipts_outcome ?? []).flatMap(eventsOf);
}
