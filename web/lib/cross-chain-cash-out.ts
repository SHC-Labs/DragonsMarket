import { config } from "./config";
import { base58Decode } from "./base58";
import { cashOutPayload, verifyCashOutSignature } from "./cross-chain-intent";
import {
  cashOutError, cashOutUnits, parseCashOutQuote, reviewCashOutQuote, type CrossChainQuote,
} from "./cross-chain-quote";
import { UserFacingError } from "./errors";
import { tokenBalance } from "./market";
import { oneClick } from "./oneclick";
import { record } from "./receipt-proof";
import { exclusive } from "./relay";
import { view } from "./rpc";
import type { MultiPayload } from "./signed-intents";
import type { WalletAccount } from "./wallet-account";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface PendingCashOut {
  version: 1;
  quote: CrossChainQuote;
  payload: string | null;
  signed: MultiPayload | null;
  intentHash: string | null;
}
export interface CashOutProgress {
  status: "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT"
    | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";
  terminal: boolean;
  destinationHashes: string[];
}
export const crossChainCashOutKey = (account: string) =>
  `cross-chain-cash-out:${config.network}:${config.verifierId}:${account}`;
export const crossChainChanged = () => window.dispatchEvent(new Event("cross-chain-cash-out-change"));
const hash32 = (value: unknown): value is string => {
  try { return typeof value === "string" && value.length <= 44 && base58Decode(value).length === 32; }
  catch { return false; }
};

function save(store: Store, pending: PendingCashOut) {
  const key = crossChainCashOutKey(pending.quote.identity.account), text = JSON.stringify(pending);
  if (text.length > 128 * 1024) throw cashOutError();
  store.setItem(key, text);
  if (store.getItem(key) !== text) throw new Error("Could not retain the withdrawal request.");
  crossChainChanged();
}

function storedPending(raw: string | null): Record<string, unknown> & { quote: Record<string, unknown> } {
  if (!raw || raw.length > 128 * 1024) throw cashOutError();
  const p: unknown = JSON.parse(raw);
  if (!record(p) || p.version !== 1 || !record(p.quote)) throw cashOutError();
  return { ...p, quote: p.quote };
}

function pendingQuote(q: Record<string, unknown>, identity: WalletAccount) {
  if (!record(q.identity) || q.identity.account !== identity.account || q.identity.chain !== identity.chain
    || typeof q.identity.label !== "string") throw cashOutError();
  if (typeof q.amount !== "string" || typeof q.refundDeadline !== "string"
    || !["base", "arb", "sol"].includes(String(q.chainId))) throw cashOutError();
  return parseCashOutQuote(q.response, {
    identity: { ...identity, label: q.identity.label }, chainId: q.chainId as CrossChainQuote["chainId"],
    amount: q.amount, refundDeadline: q.refundDeadline,
  });
}

async function read(store: Store, identity: WalletAccount): Promise<PendingCashOut> {
  const p = storedPending(store.getItem(crossChainCashOutKey(identity.account)));
  const quote = pendingQuote(p.quote, identity);
  if (p.intentHash !== null && !hash32(p.intentHash)) throw cashOutError();
  if (p.payload !== null) cashOutPayload({
    standard: identity.chain === "evm" ? "erc191" : "raw_ed25519", payload: p.payload,
  }, quote);
  if (p.signed !== null) {
    if (!record(p.signed) || typeof p.payload !== "string") throw cashOutError();
    await verifyCashOutSignature(p.signed as unknown as MultiPayload, p.payload, quote);
  }
  return { version: 1, quote, payload: p.payload as string | null,
    signed: p.signed as MultiPayload | null, intentHash: p.intentHash as string | null };
}

async function submit(pending: PendingCashOut, store: Store) {
  if (!pending.signed || Date.now() + 60_000 >= Date.parse(pending.quote.refundDeadline)) {
    throw new UserFacingError("The submission window has closed. Check this withdrawal; do not sign a replacement.");
  }
  const reply = await oneClick("/submit-intent", { type: "swap_transfer", signedData: pending.signed });
  if (!record(reply) || !hash32(reply.intentHash)) throw cashOutError();
  pending.intentHash = reply.intentHash;
  save(store, pending);
}

export function sendCrossChainCashOut(
  quote: CrossChainQuote, sign: (payload: string) => Promise<MultiPayload>, store: Store,
) {
  return exclusive(async () => {
    const verified = reviewCashOutQuote(quote);
    if (store.getItem(crossChainCashOutKey(verified.identity.account)) !== null) {
      throw new UserFacingError("Check your previous withdrawal before signing another.");
    }
    const balance = await tokenBalance(verified.identity.account);
    if (!cashOutUnits(balance) || BigInt(balance) < BigInt(verified.amount)) {
      throw new UserFacingError("Your Intents balance is below the amount in this quote.");
    }
    const pending: PendingCashOut = { version: 1, quote: verified, payload: null, signed: null, intentHash: null };
    save(store, pending);
    const generated = await oneClick("/generate-intent", { type: "swap_transfer",
      standard: verified.identity.chain === "evm" ? "erc191" : "raw_ed25519",
      signerId: verified.identity.account, depositAddress: verified.depositAddress });
    const payload = cashOutPayload(record(generated) ? generated.intent : null, verified);
    reviewCashOutQuote(verified);
    pending.payload = payload;
    save(store, pending);
    const signed = await sign(payload);
    await verifyCashOutSignature(signed, payload, verified);
    pending.signed = signed;
    save(store, pending);
    await submit(pending, store);
  });
}

function destinationHashes(value: unknown, quote: CrossChainQuote): string[] {
  if (!Array.isArray(value) || value.length > 16) throw cashOutError();
  return value.map(tx => {
    if (!record(tx) || typeof tx.hash !== "string") throw cashOutError();
    if (quote.identity.chain === "evm") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(tx.hash)) throw cashOutError();
    } else if (tx.hash.length > 88 || base58Decode(tx.hash).length !== 64) throw cashOutError();
    return tx.hash;
  });
}

async function progress(pending: PendingCashOut): Promise<CashOutProgress> {
  const body = await oneClick(`/status?${new URLSearchParams({ depositAddress: pending.quote.depositAddress })}`);
  if (!record(body) || !record(body.quoteResponse) || !record(body.swapDetails)) throw cashOutError();
  const quote = originalQuote(body.quoteResponse, pending.quote);
  const statuses: CashOutProgress["status"][] = [
    "PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED",
  ];
  const status = statuses.find(s => s === body.status);
  if (!status) throw cashOutError();
  const details = body.swapDetails;
  const hashes = destinationHashes(details.destinationChainTxHashes, quote);
  const settled = status === "SUCCESS" ? paid(details, quote, hashes.length)
    : refunded(status, details, quote);
  const nonceUsed = await consumed(pending);
  return { status, terminal: nonceUsed === true && settled, destinationHashes: hashes };
}

function originalQuote(response: unknown, original: CrossChainQuote) {
  const quote = parseCashOutQuote(response, original);
  if (quote.response.signature !== original.response.signature
    || quote.depositAddress !== original.depositAddress) throw cashOutError();
  return quote;
}

function paid(details: Record<string, unknown>, quote: CrossChainQuote, hashCount: number) {
  return hashCount > 0 && details.amountIn === quote.amount && cashOutUnits(details.amountOut)
    && BigInt(details.amountOut) >= BigInt(quote.minAmountOut);
}

function refunded(status: CashOutProgress["status"], details: Record<string, unknown>, quote: CrossChainQuote) {
  return status === "REFUNDED" && details.depositedAmount === quote.amount
    && details.refundedAmount === quote.refundAmount;
}

function consumed(pending: PendingCashOut): Promise<unknown> {
  if (!pending.payload || !pending.signed) return Promise.resolve(false);
  return view<unknown>(config.verifierId, "is_nonce_used", {
    account_id: pending.quote.identity.account, nonce: JSON.parse(pending.payload).nonce,
  });
}

export function recoverCrossChainCashOut(
  identity: WalletAccount, store: Store, mode: "check" | "retry" | "finish" = "check",
) {
  return exclusive(async () => {
    const key = crossChainCashOutKey(identity.account), initial = store.getItem(key);
    const pending = await read(store, identity);
    const unchanged = () => { if (store.getItem(key) !== initial) throw cashOutError(); };
    unchanged();
    if (!pending.signed) {
      store.removeItem(key);
      crossChainChanged();
      return null;
    }
    const state = await progress(pending);
    unchanged();
    if (mode === "finish" && state.terminal) {
      const archived = JSON.stringify({ ...pending, result: state });
      store.setItem(`${key}:last`, archived);
      if (store.getItem(`${key}:last`) !== archived) throw cashOutError();
      store.removeItem(key);
      crossChainChanged();
    } else if (mode === "retry" && state.status === "PENDING_DEPOSIT") await submit(pending, store);
    return state;
  });
}
