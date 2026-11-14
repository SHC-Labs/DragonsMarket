import { describe, expect, it, vi } from "vitest";
vi.mock("../config", () => ({ config: { network: "mainnet", verifierId: "intents.near", tokenDecimals: 6,
  tokenId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  collateralTokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" } }));
import { parseCashOutQuote, reviewCashOutQuote } from "../cross-chain-quote";
import fixture from "./fixtures/oneclick-cash-out.json";

describe("recorded 1Click quote signature", () => {
  const expected = { identity: { chain: "evm" as const,
    account: fixture.quoteRequest.refundTo, label: fixture.quoteRequest.recipient },
    chainId: "base" as const, amount: fixture.quoteRequest.amount, refundDeadline: fixture.quoteRequest.deadline };
  it("verifies a real unfunded quote with the official SDK key", () => {
    const quote = parseCashOutQuote(fixture, expected);
    expect(reviewCashOutQuote(quote, Date.parse(fixture.timestamp)).depositAddress).toBe(fixture.quote.depositAddress);
    expect(quote.authorizationDeadline).not.toBe(quote.refundDeadline);
  });
  it("detects tampering even when the request and manipulated response agree", () => {
    const altered = structuredClone(fixture);
    altered.quote.depositAddress = "ab".repeat(32);
    expect(() => parseCashOutQuote(altered, expected)).toThrow();
    const recipient = "0x" + "34".repeat(20);
    altered.quoteRequest.recipient = recipient; altered.quoteRequest.refundTo = recipient;
    expect(() => parseCashOutQuote(altered, { ...expected, identity: { chain: "evm", account: recipient, label: recipient } })).toThrow();
    const badSignature = { ...fixture, signature: fixture.signature.replace("V2R2", "W2R2") };
    expect(() => parseCashOutQuote(badSignature, expected)).toThrow();
  });
});
