import { verifyQuoteSignature, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { base58Decode } from "./base58";
import { config } from "./config";
import { DEPOSIT_CHAINS, validRefund, type DepositChainId } from "./deposit";
import { UserFacingError } from "./errors";
import { oneClick } from "./oneclick";
import { record } from "./receipt-proof";
import type { WalletAccount } from "./wallet-account";

const REFUND_AFTER_MS = 30 * 60_000;
const MAX_ADDRESS_LIFE_MS = 4 * 24 * 60 * 60_000;
const NATIVE_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const cashOutUnits = (v: unknown): v is string => typeof v === "string"
  && /^[1-9]\d{0,38}$/.test(v) && BigInt(v) < 2n ** 128n;
export const cashOutError = () => new UserFacingError(
  "The withdrawal details could not be verified. Keep any saved request and check its status.",
);

export interface CrossChainQuote {
  identity: WalletAccount;
  chainId: DepositChainId;
  amount: string;
  refundDeadline: string;
  response: OneClickQuoteResponse;
  depositAddress: string;
  amountOut: string;
  minAmountOut: string;
  refundAmount: string;
  authorizationDeadline: string;
  reviewDeadline: number;
}

export function cashOutDestination(identity: WalletAccount, chainId: DepositChainId) {
  const chain = DEPOSIT_CHAINS.find(c => c.id === chainId && c.refundKind === identity.chain);
  if (!chain || !validRefund(chain.refundKind, identity.label)) throw cashOutError();
  const account = identity.chain === "evm" ? identity.label.toLowerCase()
    : Array.from(base58Decode(identity.label), b => b.toString(16).padStart(2, "0")).join("");
  if (identity.account !== account) throw cashOutError();
  return chain;
}

function checkDeployment() {
  if (config.network !== "mainnet" || config.verifierId !== "intents.near" || config.tokenDecimals !== 6
    || config.collateralTokenId !== NATIVE_USDC
    || config.collateralTokenId !== `nep141:${config.tokenId}`) throw cashOutError();
}

export function cashOutRequest(identity: WalletAccount, chainId: DepositChainId, amount: string, deadline: string) {
  checkDeployment();
  const chain = cashOutDestination(identity, chainId);
  if (!cashOutUnits(amount) || !Number.isFinite(Date.parse(deadline))) throw cashOutError();
  return { dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
    originAsset: config.collateralTokenId, destinationAsset: chain.usdc, amount,
    depositType: "INTENTS", recipient: identity.label, recipientType: "DESTINATION_CHAIN",
    refundTo: identity.account, refundType: "INTENTS", deadline };
}

function checkQuoteRequest(echo: Record<string, unknown>, quote: Record<string, unknown>,
  request: ReturnType<typeof cashOutRequest>) {
  if (Object.entries(request).some(([key, value]) => echo[key] !== value)) throw cashOutError();
  if (["customRecipientMsg", "virtualChainRecipient", "virtualChainRefundRecipient"].some(k => echo[k] || quote[k])
    || (echo.confidentiality !== undefined && echo.confidentiality !== "public")
    || (echo.depositMode !== undefined && echo.depositMode !== "SIMPLE") || quote.depositMemo) throw cashOutError();
}

function quoteAmounts(quote: Record<string, unknown>, amount: string) {
  if (quote.amountIn !== amount || quote.minAmountIn !== amount
    || !cashOutUnits(quote.amountOut) || !cashOutUnits(quote.minAmountOut)) throw cashOutError();
  if (BigInt(quote.amountOut) > BigInt(amount) || BigInt(quote.minAmountOut) > BigInt(quote.amountOut)
    || BigInt(quote.minAmountOut) < BigInt(quote.amountOut) * 9900n / 10000n) throw cashOutError();
  return { amountOut: quote.amountOut, minAmountOut: quote.minAmountOut };
}

function quotedRefund(fee: unknown, amount: string) {
  if (fee !== "0" && !cashOutUnits(fee)) throw cashOutError();
  if (BigInt(fee) >= BigInt(amount)) throw cashOutError();
  return String(BigInt(amount) - BigInt(fee));
}

function quoteDeadlines(timestamp: unknown, deadline: unknown, refundDeadline: string) {
  const created = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  const refund = Date.parse(refundDeadline);
  if (typeof deadline !== "string") throw cashOutError();
  const expiry = Date.parse(deadline);
  if (![created, refund, expiry].every(Number.isFinite) || refund < created || refund > created + REFUND_AFTER_MS
    || expiry < refund || expiry > created + MAX_ADDRESS_LIFE_MS) throw cashOutError();
  return { authorizationDeadline: deadline, reviewDeadline: Math.min(refund, created + 5 * 60_000) };
}

function signedQuote(body: Record<string, unknown>) {
  if (typeof body.signature !== "string" || body.signature.length > 100) throw cashOutError();
  const response = body as unknown as OneClickQuoteResponse;
  if (!verifyQuoteSignature(response)) throw cashOutError();
  return response;
}

export function parseCashOutQuote(body: unknown, expected: {
  identity: WalletAccount; chainId: DepositChainId; amount: string; refundDeadline: string;
}): CrossChainQuote {
  const request = cashOutRequest(expected.identity, expected.chainId, expected.amount, expected.refundDeadline);
  if (!record(body) || !record(body.quote) || !record(body.quoteRequest)) throw cashOutError();
  const { quote, quoteRequest: echo } = body;
  checkQuoteRequest(echo, quote, request);
  if (typeof quote.depositAddress !== "string" || !/^[0-9a-f]{64}$/.test(quote.depositAddress)) throw cashOutError();
  const response = signedQuote(body);
  return { ...expected, response, depositAddress: quote.depositAddress,
    ...quoteAmounts(quote, expected.amount), refundAmount: quotedRefund(quote.refundFee, expected.amount),
    ...quoteDeadlines(body.timestamp, quote.deadline, expected.refundDeadline) };
}

export function reviewCashOutQuote(quote: CrossChainQuote, now = Date.now()) {
  const verified = parseCashOutQuote(quote.response, quote);
  if (verified.response.timestamp && Date.parse(verified.response.timestamp) > now + 30_000
    || now + 60_000 >= verified.reviewDeadline) {
    throw new UserFacingError("This quote needs refreshing before you sign. Request a new quote.");
  }
  return verified;
}

export async function quoteCashOut(identity: WalletAccount, chainId: DepositChainId, amount: bigint) {
  const refundDeadline = new Date(Date.now() + REFUND_AFTER_MS).toISOString();
  const request = cashOutRequest(identity, chainId, String(amount), refundDeadline);
  const response = await oneClick("/quote", request);
  return reviewCashOutQuote(parseCashOutQuote(response, { identity, chainId, amount: String(amount), refundDeadline }));
}
