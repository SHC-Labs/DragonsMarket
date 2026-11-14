import { config } from "./config";
import { UserFacingError } from "./errors";
import { formatExact } from "./format";
import { actionPayload, PAYLOAD_LIFETIME_MS, type Action, type IntentsContext, type MultiPayload } from "./signed-intents";
import { clearRelay, relayJournalKey, writeRelay, type PendingRelay, type RelayStorage } from "./relay-journal";

// One signed payload that was relayed: what was signed, and which contract it paid.
export interface RelayedItem { standard: string; payload: string; target: string }

// The durable signed request and any transaction hashes returned during recovery.
export interface Attempt { signed: MultiPayload[]; items: RelayedItem[]; hashes?: string[] }
export interface Relayed { hashes: string[]; items: RelayedItem[]; attempt?: Attempt }

export interface RelayDetail { code?: string | null; hash?: string | null; completed?: string[]; unknown?: boolean }

export class RelayError extends UserFacingError {
  // A transaction the relay says to check, and the hashes of items that already landed.
  readonly code: string | null;
  readonly hash: string | null;
  readonly completed: string[];
  // True when the action may have happened: only the chain can say, not this error.
  readonly unknown: boolean;
  attempt?: Attempt;
  constructor(message: string, readonly status: number, readonly index: number | null, detail: RelayDetail = {}) {
    super(message);
    this.code = detail.code ?? null;
    this.hash = detail.hash ?? null;
    this.completed = detail.completed ?? [];
    this.unknown = detail.unknown ?? false;
  }
}

const text = (value: unknown) => typeof value === "string" && value.trim() !== "" ? value.slice(0, 200) : null;

// The relay waits for each transaction to be final, two of them for a first trade, so it can take a while to answer.
const RELAY_TIMEOUT_MS = 120_000;
// The relay refuses a payload with less than a minute of life left (MIN_DEADLINE_MS in backend/src/relay.ts). The extra 30 s
// covers the trip to the relay and a clock that runs behind.
const RELAY_MIN_LIFE_MS = 60_000;
const SUBMIT_MARGIN_MS = RELAY_MIN_LIFE_MS + 30_000;
const FEE_TIMEOUT_MS = 10_000;
// The most the backend ever quotes unless the operator raises it (DEFAULT_RELAY_MAX_FEE in backend/src/config.ts). A quote above it is not signed.
export const MAX_RELAY_FEE = 100_000n;
// A fee at click time may be this much above the one the ticket showed (5/4) before the person is asked again.
const FEE_RISE_NUM = 5n;
const FEE_RISE_DEN = 4n;
const NO_FEE = "Could not get the network fee from the Dragons Market service. Nothing was sent. Try again in a minute.";

// The fee each signed action pays the relayer, priced by the backend from the gas price and the NEAR price. A quote is accepted
// until validUntil, longer than a payload lives.
export async function fetchRelayFee(): Promise<{ fee: bigint; validUntil: number }> {
  let body: unknown;
  try {
    const response = await fetch(`${config.backendUrl}/intents/fee`, { signal: AbortSignal.timeout(FEE_TIMEOUT_MS) });
    if (!response.ok) throw new Error();
    body = await response.json();
  } catch {
    throw new UserFacingError(NO_FEE);
  }
  const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const validUntil = typeof record.validUntil === "string" ? Date.parse(record.validUntil) : NaN;
  if (typeof record.fee !== "string" || !/^[1-9][0-9]{0,30}$/.test(record.fee)
    || !Number.isFinite(validUntil) || validUntil <= Date.now() || validUntil > Date.now() + 600000) throw new UserFacingError(NO_FEE);
  const fee = BigInt(record.fee);
  if (fee > MAX_RELAY_FEE) throw new UserFacingError(NO_FEE);
  return { fee, validUntil };
}

const UNKNOWN = "We did not get an answer from the Dragons Market service, so the action may have gone through. Use Check again to recover this request before signing another.";

// Sends signed payloads to the backend, which checks them, pays the gas and runs them in order. Returns one transaction hash each.
export async function relaySigned(signed: MultiPayload[], { timeoutMs = RELAY_TIMEOUT_MS } = {}): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${config.backendUrl}/intents/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A dropped connection or a timeout can come after the service received the request and ran it.
    throw new RelayError(UNKNOWN, 0, null, { unknown: true });
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* no body to read */ }
  const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  if (response.ok) {
    const hashes = record.hashes;
    if (!Array.isArray(hashes) || hashes.length !== signed.length || !hashes.every(h => typeof h === "string" && h !== "") || new Set(hashes).size !== hashes.length) {
      throw new RelayError(`The service answered in a form this site does not recognise. ${UNKNOWN}`, response.status, null, { unknown: true });
    }
    return hashes as string[];
  }
  const error = record.error !== null && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const code = text(error.code);
  const index = typeof error.index === "number" && Number.isInteger(error.index) ? error.index : null;
  const hash = text(error.hash);
  const completed = Array.isArray(error.completed) ? error.completed.filter((h): h is string => typeof h === "string" && h !== "") : [];
  const message = `${code && PLAIN[code] ? PLAIN[code] : "The service could not complete this request."} Its outcome still needs confirmation. Use Check again before signing anything else.`;
  throw new RelayError(message, response.status, index,
    { code, hash, completed, unknown: true });
}

const BUSY = "The service is busy or unavailable.";
const PLAIN: Record<string, string> = {
  rate_limited: "Too many requests from this connection. Wait a minute and try again.",
  signer_rate_limited: "This wallet has sent too many requests. Wait a minute and try again.",
  relay_busy: BUSY,
  relay_key_invalid: BUSY,
  rpc_unavailable: BUSY,
  second_rpc_required: BUSY,
  relay_key_shared: BUSY,
  duplicate_item: "This request holds the same signed action twice, so the service refused it.",
  signer_suspended: "This wallet is paused for an hour after a failed action or repeated refused ones. Try again later.",
  fee_unavailable: "Network gas costs more right now than this service pays for. Try again later.",
  invalid_deadline: "The signed request has expired or has too little time left.",
  invalid_signature: "The service could not verify the signature. Check its status before trying again.",
  invalid_payload: "The signed message was not in the form the service accepts. Check its status before trying again.",
  invalid_nonce: "The signed message carried a one-time number the service does not accept. Check its status before trying again.",
  fee_too_low: "The network fee went up while you were signing.",
  insufficient_balance: "Your Intents account does not hold enough for this action and its network fee.",
};

let running = false;
const LOCK = "dragons-market:relay";

// One signed action at a time, in this tab and across tabs using Web Locks. A second click or a second tab
// would otherwise ask the wallet to sign a second payload with its own nonce, and both would run and both would pay.
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (running) throw new UserFacingError("This tab is already sending a signed action. Wait for it to finish.");
  running = true;
  try {
    const locks = typeof navigator !== "undefined" ? (navigator as { locks?: LockManager }).locks : undefined;
    if (!locks) throw new UserFacingError("This browser cannot coordinate signed requests safely. Use a browser with Web Locks support.");
    return await locks.request(LOCK, { ifAvailable: true }, async lock => {
      if (!lock) throw new UserFacingError("Another tab is sending a signed action. Wait for it to finish, then try again.");
      return fn();
    });
  } finally {
    running = false;
  }
}

// Recovery only sends the original signed payloads.
export async function resubmit(attempt: Attempt): Promise<Relayed> {
  try {
    const hashes = await relaySigned(attempt.signed);
    attempt.hashes = hashes;
    return { hashes, items: attempt.items, attempt };
  } catch (error) {
    if (error instanceof RelayError) {
      error.attempt = attempt;
      const hashes = [...error.completed, ...(error.hash ? [error.hash] : [])];
      if (hashes.length > (attempt.hashes?.length ?? 0) && hashes.length <= attempt.items.length) attempt.hashes = hashes;
    }
    throw error;
  }
}

export function signAndRelay(input: {
  sign: (payload: string) => Promise<MultiPayload>;
  ctx: Omit<IntentsContext, "relayFee">;
  signerId: string;
  actions: Action[];
  // The network fee the ticket showed for one signed action.
  shownFee: bigint;
  now?: () => number;
  store?: RelayStorage;
}): Promise<Relayed> {
  const now = input.now ?? Date.now;
  return exclusive(async () => {
    if (input.actions.length < 1 || input.actions.length > 2) throw new UserFacingError("This request must contain one or two actions.");
    const store = input.store ?? localStorage;
    const key = relayJournalKey(input.signerId);
    if (store.getItem(key) !== null) throw new UserFacingError("A signed request still needs confirmation. Use Check again before signing another.");
    const { fee } = await fetchRelayFee();
    if (fee * FEE_RISE_DEN > input.shownFee * FEE_RISE_NUM) {
      throw new UserFacingError(`The network fee is now ${formatExact(fee)} ${config.tokenSymbol} for each signed message, up from ${formatExact(input.shownFee)}. Nothing was sent. Check the new total, then try again.`);
    }
    const ctx: IntentsContext = { ...input.ctx, relayFee: fee };
    const items: RelayedItem[] = [];
    const signed: MultiPayload[] = [];
    let pending: PendingRelay = { version: 1, account: input.signerId, verifier: input.ctx.verifier, relayer: input.ctx.relayer, attempt: null };
    writeRelay(store, key, pending);
    let persisted = pending;
    let exposed = false;
    try {
      let firstBuilt: number | null = null;
      for (const action of input.actions) {
        const builtAt = now();
        firstBuilt ??= builtAt;
        const payload = actionPayload(ctx, input.signerId, action, builtAt);
        const item = await input.sign(payload);
        if (item.payload !== payload) throw new UserFacingError("The wallet returned a different message than the one shown. Nothing was sent.");
        signed.push(item);
        items.push({ standard: item.standard, payload, target: action.to });
      }
      if (firstBuilt !== null && now() > firstBuilt + PAYLOAD_LIFETIME_MS - SUBMIT_MARGIN_MS) {
        throw new UserFacingError("Signing took too long, so the first signature is about to expire. Nothing was sent. Try again.");
      }
      const attempt = { signed, items };
      pending = { ...pending, attempt };
      writeRelay(store, key, pending);
      persisted = pending;
      exposed = true;
      try { return await resubmit(attempt); }
      finally { writeRelay(store, key, pending); }
    } catch (error) {
      if (!exposed) clearRelay(store, key, persisted);
      throw error;
    }
  });
}
