import { UserFacingError } from "./errors";
import { base58Decode } from "./base58";
import { verifyQuoteSignature, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { ONECLICK_URL, readOneClickResponse as readResponse } from "./oneclick";

// Deposits come in through the 1Click API of NEAR Intents: it hands out an address on the person's own chain, and whatever
// USDC arrives there is credited to their Intents account. No transaction is built here and no key is involved.
// An unauthenticated request works and carries a 0.25% surcharge; a JWT would remove it (docs.near-intents.org, 1Click quickstart).
export { ONECLICK_URL } from "./oneclick";

export type DepositChainId = "base" | "arb" | "sol";
export interface DepositChain { id: DepositChainId; name: string; usdc: string; refundKind: "evm" | "solana" }

export const DEPOSIT_CHAINS: DepositChain[] = [
  { id: "base", name: "Base", usdc: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", refundKind: "evm" },
  { id: "arb", name: "Arbitrum", usdc: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", refundKind: "evm" },
  { id: "sol", name: "Solana", usdc: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", refundKind: "solana" },
];

export const QUOTE_LIFETIME_MS = 30 * 60_000;
const SLIPPAGE_BPS = 100;

export function validRefund(kind: "evm" | "solana", address: string): boolean {
  if (kind === "evm") return /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/i.test(address);
  try { return address.length >= 32 && address.length <= 44 && base58Decode(address).length === 32 && !/^1+$/.test(address); }
  catch { return false; }
}

export function quoteRequest(input: { chain: DepositChain; amount: bigint; recipient: string; refundTo: string; collateral: string; now?: number }) {
  return {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: input.chain.usdc,
    destinationAsset: input.collateral,
    amount: input.amount.toString(),
    depositType: "ORIGIN_CHAIN",
    recipient: input.recipient,
    recipientType: "INTENTS",
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date((input.now ?? Date.now()) + QUOTE_LIFETIME_MS).toISOString(),
  };
}

export interface DepositQuote { depositAddress: string; depositMemo: string | null; amountIn: string; amountOut: string; deadline: string }
export type QuoteRequest = ReturnType<typeof quoteRequest>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const units = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d{0,38})$/.test(value) && BigInt(value) < 2n ** 128n;
// The fields that decide where the money goes and how much is asked. The service echoes the request it quoted.
const ECHOED = ["dry", "originAsset", "destinationAsset", "amount", "recipient", "recipientType", "refundTo", "refundType", "depositType", "swapType", "slippageTolerance"] as const;
const MIN_LIFE_MS = 60_000;

// The address shown must come from a quote for exactly this request: right chain and token in, the configured collateral out,
// into this person's Intents account, for the amount they typed. Anything else is refused and nothing is shown.
export function parseQuote(body: unknown, expected: { request: QuoteRequest; chain: DepositChain; now: number }): DepositQuote {
  const unrecognised = () => new UserFacingError("The deposit service answered in a form this site does not recognise. Nothing was sent.");
  if (!record(body) || !record(body.quote) || !record(body.quoteRequest)) throw unrecognised();
  const { quote, quoteRequest: echo } = body;
  if (ECHOED.some(key => echo[key] !== expected.request[key]) || typeof echo.deadline !== "string"
    || Date.parse(echo.deadline) !== Date.parse(expected.request.deadline)) throw new UserFacingError("The deposit service quoted a different request than this site asked for. Nothing was sent.");
  const { depositAddress, amountIn, amountOut, deadline } = quote;
  if (typeof depositAddress !== "string" || !validRefund(expected.chain.refundKind, depositAddress)
    || !units(amountIn) || !units(amountOut) || typeof deadline !== "string") throw unrecognised();
  if (amountIn !== expected.request.amount || BigInt(amountOut) > BigInt(amountIn) || BigInt(amountOut) === 0n) {
    throw new UserFacingError("The deposit service quoted a different amount than you entered. Nothing was sent.");
  }
  // These chains take plain transfers. A memo would have to be added by hand, and a transfer without it could be lost.
  if (quote.depositMemo !== undefined && quote.depositMemo !== null && quote.depositMemo !== "") throw unrecognised();
  const expires = Date.parse(deadline);
  if (!Number.isFinite(expires) || expires < expected.now + MIN_LIFE_MS) throw new UserFacingError("The deposit address had already expired. Ask for a new one.");
  const sendUntil = Math.min(expires, Date.parse(expected.request.deadline));
  if (expires > Date.parse(expected.request.deadline) + 4 * 24 * 60 * 60_000) throw unrecognised();
  if (sendUntil < expected.now + MIN_LIFE_MS) throw unrecognised();
  if (typeof body.signature !== "string" || body.signature.length > 100) throw unrecognised();
  if (!verifyQuoteSignature(body as unknown as OneClickQuoteResponse)) throw unrecognised();
  return { depositAddress, depositMemo: null, amountIn, amountOut,
    deadline: new Date(sendUntil).toISOString() };
}

export const quoteExpired = (deadlineMs: number, now: number) => now >= deadlineMs;

// Every 5 seconds for the first minute, then slower up to every 30 seconds. A deposit sent just before the deadline can still be
// processing afterwards, so polling goes on for an hour past it, and never more than 500 times.
const POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
const POLL_AFTER_DEADLINE_MS = 60 * 60_000;
const MAX_POLLS = 500;
export function nextPollMs(attempt: number, now: number, deadlineMs: number): number | null {
  if (attempt >= MAX_POLLS || now > deadlineMs + POLL_AFTER_DEADLINE_MS) return null;
  return attempt < 12 ? POLL_MS : Math.min(MAX_POLL_MS, POLL_MS + (attempt - 12) * 1_000);
}

export async function requestDeposit(request: QuoteRequest, chain: DepositChain): Promise<DepositQuote> {
  let response: Response;
  try {
    response = await fetch(`${ONECLICK_URL}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000), redirect: "error", credentials: "omit" });
  } catch {
    throw new UserFacingError("Could not reach the deposit service. Try again in a moment.");
  }
  if (!response.ok) {
    const body: unknown = await readResponse(response).catch(() => null);
    const reason = record(body) && typeof body.message === "string" ? body.message.replace(/[\u0000-\u001f]/g, " ").slice(0, 160) : null;
    throw new UserFacingError(reason ? `The deposit service refused this amount: ${reason}` : `The deposit service answered ${response.status}.`);
  }
  const body: unknown = await readResponse(response).catch(() => null);
  return parseQuote(body, { request, chain, now: Date.now() });
}

export type DepositStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";
const STATUSES: DepositStatus[] = ["KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"];
export const depositFinished = (status: DepositStatus) => status === "SUCCESS" || status === "REFUNDED" || status === "FAILED";

export function statusUrl(address: string, memo: string | null) {
  const query = new URLSearchParams({ depositAddress: address });
  if (memo) query.set("depositMemo", memo);
  return `${ONECLICK_URL}/status?${query}`;
}

export async function readDepositStatus(address: string, memo: string | null): Promise<DepositStatus> {
  const response = await fetch(statusUrl(address, memo), { signal: AbortSignal.timeout(15_000), redirect: "error", credentials: "omit" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`status ${response.status}`); }
  const body: unknown = await readResponse(response);
  const status = record(body) ? body.status : null;
  const known = STATUSES.find(s => s === status);
  if (!known) throw new Error("unknown status");
  return known;
}
