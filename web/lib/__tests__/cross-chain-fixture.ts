import { privateKeyToAccount } from "viem/accounts";
import { cashOutRequest, parseCashOutQuote } from "../cross-chain-quote";
import { encodeErc191 } from "../signed-intents";
import type { WalletAccount } from "../wallet-account";
import { config } from "../config";

export const now = Date.UTC(2026, 10, 1, 12);
export const wallet = privateKeyToAccount(`0x${"00".repeat(31)}01`);
export const identity: WalletAccount = { chain: "evm", account: wallet.address.toLowerCase(), label: wallet.address };
export const refundDeadline = new Date(now + 30 * 60_000).toISOString();
export const authorizationDeadline = new Date(now + 3 * 24 * 60 * 60_000).toISOString();
export const depositAddress = "ab".repeat(32);
export const intentHash = "A".repeat(44);
export const destinationHash = "0x" + "cd".repeat(32);

export function response() {
  return {
    quoteRequest: cashOutRequest(identity, "base", "10000000", refundDeadline),
    quote: { depositAddress, amountIn: "10000000", minAmountIn: "10000000", amountOut: "9995580",
      minAmountOut: "9895624", refundFee: "0", deadline: authorizationDeadline },
    signature: "test-quote", timestamp: new Date(now).toISOString(), correlationId: "test",
  };
}
export function quote() {
  return parseCashOutQuote(response(), { identity, chainId: "base", amount: "10000000", refundDeadline });
}
export function payload() {
  return JSON.stringify({ verifying_contract: "intents.near", signer_id: identity.account,
    deadline: authorizationDeadline, nonce: btoa("n".repeat(32)), intents: [{ intent: "transfer",
      receiver_id: depositAddress, tokens: { [config.collateralTokenId]: "10000000" } }] });
}
export const sign = (text: string) => wallet.signMessage({ message: text }).then(signature => encodeErc191(text, signature));
export function status(state = "SUCCESS") {
  return { quoteResponse: response(), status: state, swapDetails: {
    amountIn: "10000000", amountOut: "9995580", depositedAmount: "10000000", refundedAmount: "10000000",
    destinationChainTxHashes: state === "SUCCESS" ? [{ hash: destinationHash, explorerUrl: "javascript:evil()" }] : [],
  } };
}
