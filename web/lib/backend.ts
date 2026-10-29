import { config } from "./config";

// The backend is optional. Everything here is a no-op or refuses plainly when NEXT_PUBLIC_BACKEND_URL is empty, and nothing on
// the site depends on an answer: balances, positions and trades still come from the chain.
export class BackendError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export const backendEnabled = () => config.backendUrl !== "";

interface Reply<T> { ok: boolean; status: number; body: T }

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<Reply<T>> {
  if (!backendEnabled()) throw new BackendError("The backend is not configured.", 0, "backend_disabled");
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(`${config.backendUrl}${path}`, {
      method,
      credentials: "include",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new BackendError("Could not reach the Dragons Market service.", 0, "unreachable");
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* an empty or non-JSON reply has no body to read */ }
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (!response.ok) throw new BackendError(`The service answered ${response.status}.`, response.status, typeof code === "string" ? code : "unknown");
  return { ok: true, status: response.status, body: body as T };
}

export interface Challenge { id: string; accountId: string; message: string; nonce: string; recipient: string; callbackUrl: string; expiresAt: string }
export interface SignedMessage { accountId: string; publicKey: string; signature: string }
export type SignMessage = (request: { message: string; recipient: string; nonce: Uint8Array; callbackUrl: string }) => Promise<SignedMessage>;

function nonceBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The account the backend session belongs to, or null when there is none (or no backend). */
export async function currentSession(): Promise<string | null> {
  if (!backendEnabled()) return null;
  const { body } = await call<{ session: { account_id: string } | null }>("/v1/auth/session");
  return body.session?.account_id ?? null;
}

/** Proves ownership of `account` by signing the backend's challenge with the wallet (NEP-413), which creates a 24 hour session. */
export async function signIn(account: string, sign: SignMessage): Promise<void> {
  const { body: challenge } = await call<Challenge>("/v1/auth/challenge", { method: "POST", body: { accountId: account } });
  if (challenge.accountId !== account) throw new BackendError("The service asked for a different account.", 0, "account_mismatch");
  const signed = await sign({ message: challenge.message, recipient: challenge.recipient, nonce: nonceBytes(challenge.nonce), callbackUrl: challenge.callbackUrl });
  if (signed.accountId !== account) throw new BackendError("The wallet signed for a different account.", 0, "account_mismatch");
  await call("/v1/auth/verify", { method: "POST", body: { id: challenge.id, publicKey: signed.publicKey, signature: signed.signature } });
  // The cookie is only sent back when the site and the service are on the same site. If it was not kept, say so now instead of
  // letting every later call fail quietly.
  if ((await currentSession()) !== account) throw new BackendError("The browser did not keep the sign-in. The service must be on the same site as this page.", 0, "session_not_kept");
}

export async function signOut(): Promise<void> {
  if (backendEnabled()) await call("/v1/auth/logout", { method: "POST", body: {} }).catch(() => {});
}

// A watched market is stored as "<market contract>/<id>", so one account can watch markets on more than one deployment.
export const watchItem = (marketId: string) => `${config.marketId}/${marketId}`;
const itemPrefix = () => `${config.marketId}/`;

export async function serverWatchlist(): Promise<string[]> {
  const { body } = await call<{ data: { item: string }[] }>("/v1/watchlist");
  return body.data.map(row => row.item).filter(item => item.startsWith(itemPrefix())).map(item => item.slice(itemPrefix().length));
}

export async function setServerWatch(marketId: string, watched: boolean): Promise<void> {
  await call("/v1/watchlist", { method: watched ? "PUT" : "DELETE", body: { item: watchItem(marketId) } });
}

export interface PendingSettlement { kind: "withdrawal" | "bond_payout" | "claim"; event: string; receiptId: string; amount: bigint | null; blockHeight: string }

interface PendingRow { kind: string; event: string; receipt_id: string; block_height: string; payload: { account?: string; owner?: string; amount?: string } }

/** Money the contracts have started to send to `account` that no terminal event has confirmed yet. Public chain data, filtered here. */
export async function pendingFor(account: string): Promise<PendingSettlement[]> {
  const { body } = await call<{ data: PendingRow[] }>(`/v1/settlements/pending?limit=100&account=${encodeURIComponent(account)}`);
  return body.data
    .filter(row => (row.payload.account ?? row.payload.owner) === account && ["withdrawal", "bond_payout", "claim"].includes(row.kind))
    .map(row => ({
      kind: row.kind as PendingSettlement["kind"], event: row.event, receiptId: row.receipt_id, blockHeight: row.block_height,
      amount: typeof row.payload.amount === "string" && /^\d{1,39}$/.test(row.payload.amount) ? BigInt(row.payload.amount) : null,
    }));
}

export const pendingLabel = (kind: PendingSettlement["kind"]) =>
  kind === "withdrawal" ? "Withdrawal" : kind === "bond_payout" ? "Bond payout" : "Reward claim";
