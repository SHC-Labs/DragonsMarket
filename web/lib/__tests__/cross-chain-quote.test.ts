import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../config", () => ({ config: { network: "mainnet", verifierId: "intents.near",
  tokenId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  collateralTokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  tokenDecimals: 6 } }));
vi.mock("@defuse-protocol/one-click-sdk-typescript", () => ({ verifyQuoteSignature: vi.fn(() => true) }));
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { config } from "../config";
import { base58Encode } from "../base58";
import { cashOutDestination, cashOutRequest, parseCashOutQuote, quoteCashOut, reviewCashOutQuote } from "../cross-chain-quote";
import { cashOutPayload, verifyCashOutSignature } from "../cross-chain-intent";
import { encodeEd25519 } from "../signed-intents";
import { authorizationDeadline, identity, now, payload, quote, refundDeadline, response, sign } from "./cross-chain-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.mocked(verifyQuoteSignature).mockReturnValue(true); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("cross-chain cash-out quote boundaries", () => {
  const expected = { identity, chainId: "base" as const, amount: "10000000", refundDeadline };
  it("binds the destination to the connected wallet and refunds to its Intents account", () => {
    expect(cashOutRequest(identity, "base", "10000000", refundDeadline)).toMatchObject({
      recipient: identity.label, recipientType: "DESTINATION_CHAIN", refundTo: identity.account,
      refundType: "INTENTS", depositType: "INTENTS", slippageTolerance: 100,
    });
    expect(quote()).toMatchObject({ amount: "10000000", minAmountOut: "9895624", authorizationDeadline });
    expect(() => cashOutDestination({ ...identity, account: "0x" + "34".repeat(20) }, "base")).toThrow();
    expect(() => cashOutDestination(identity, "sol")).toThrow();
    expect(() => cashOutDestination({ ...identity, chain: "near" }, "base")).toThrow();
    for (const amount of ["0", "-1", "01", "1e7", String(2n ** 128n)]) {
      expect(() => cashOutRequest(identity, "base", amount, refundDeadline)).toThrow();
    }
  });
  it.each(["recipient", "recipientType", "refundTo", "refundType", "originAsset", "destinationAsset",
    "amount", "depositType", "swapType", "deadline", "slippageTolerance", "dry"])("refuses changed %s", key => {
    const r = response(); Object.assign(r.quoteRequest, { [key]: "different" });
    expect(() => parseCashOutQuote(r, expected)).toThrow();
  });
  it.each([
    ["another amount", { amountIn: "10000001" }], ["smaller input", { minAmountIn: "1" }],
    ["another deposit format", { depositAddress: "evil.near" }], ["memo", { depositMemo: "1" }],
    ["invalid amount", { amountOut: "1e7" }], ["overflow", { amountOut: String(2n ** 128n) }],
    ["missing minimum", { minAmountOut: undefined }], ["looser slippage", { minAmountOut: "9895623" }],
    ["more than quoted", { minAmountOut: "10000000" }], ["zero output", { amountOut: "0" }],
    ["unbounded address lifetime", { deadline: "2030-01-01T00:00:00Z" }],
    ["recipient callback", { customRecipientMsg: "evil" }],
    ["missing refund fee", { refundFee: undefined }], ["negative refund fee", { refundFee: "-1" }],
    ["refund fee consumes everything", { refundFee: "10000000" }],
  ])("refuses %s", (_name, change) => {
    const r = response(); Object.assign(r.quote, change);
    expect(() => parseCashOutQuote(r, expected)).toThrow();
  });
  it("rejects an invalid provider signature and stale or future quotes", () => {
    vi.mocked(verifyQuoteSignature).mockReturnValue(false);
    expect(() => quote()).toThrow();
    vi.mocked(verifyQuoteSignature).mockReturnValue(true);
    expect(() => reviewCashOutQuote(quote(), now + 241_000)).toThrow(/refresh/);
    expect(() => reviewCashOutQuote(quote(), now - 31_000)).toThrow(/refresh/);
    expect(() => reviewCashOutQuote(quote(), now)).not.toThrow();
    const r = response(); r.timestamp = "invalid";
    expect(() => parseCashOutQuote(r, expected)).toThrow();
  });
  it("refuses a non-mainnet build before reaching the provider", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const network = config.network;
    try {
      config.network = "testnet";
      await expect(quoteCashOut(identity, "base", 10000000n)).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    } finally { config.network = network; }
  });
  it("does not label another collateral token as native USDC", () => {
    const tokenId = config.tokenId, collateral = config.collateralTokenId;
    try {
      config.tokenId = "another.near"; config.collateralTokenId = "nep141:another.near";
      expect(() => cashOutRequest(identity, "base", "10000000", refundDeadline)).toThrow();
    } finally { config.tokenId = tokenId; config.collateralTokenId = collateral; }
  });
});

describe("cash-out signatures authorize only the reviewed transfer", () => {
  it("verifies the real ERC191 signer and preserves the exact payload", async () => {
    const text = payload(), signed = await sign(text);
    expect(cashOutPayload(signed, quote())).toBe(text);
    await expect(verifyCashOutSignature(signed, text, quote())).resolves.toBeUndefined();
    await expect(verifyCashOutSignature({ ...signed, signature: "secp256k1:" + "1".repeat(65) }, text, quote())).rejects.toThrow();
    await expect(verifyCashOutSignature(signed, text + " ", quote())).rejects.toThrow();
    const extraField = { ...signed, extra: "not allowed" };
    await expect(verifyCashOutSignature(extraField, text, quote())).rejects.toThrow();
  });
  it.each(["signer_id", "verifying_contract", "deadline", "nonce"])("refuses a changed %s in the generated message", key => {
    const p = JSON.parse(payload()); p[key] = "changed";
    expect(() => cashOutPayload({ standard: "erc191", payload: JSON.stringify(p) }, quote())).toThrow();
  });
  it("refuses extra actions, tokens, callbacks and duplicate JSON keys", () => {
    type Payload = { intents: { receiver_id: string; tokens: Record<string, string>; msg?: string }[] };
    const changes = [
      (p: Payload) => { p.intents.push(p.intents[0]); },
      (p: Payload) => { p.intents[0].msg = "call"; },
      (p: Payload) => { p.intents[0].tokens["nep141:other.near"] = "1"; },
      (p: Payload) => { p.intents[0].receiver_id = "attacker.near"; },
      (p: Payload) => { p.intents[0].tokens[config.collateralTokenId] = "10000001"; },
    ];
    for (const change of changes) {
      const p = JSON.parse(payload()); change(p);
      expect(() => cashOutPayload({ standard: "erc191", payload: JSON.stringify(p) }, quote())).toThrow();
    }
    expect(() => cashOutPayload({ standard: "erc191", payload: payload().replace("{", '{"signer_id":"evil",') }, quote())).toThrow();
  });
  it("checks Solana signatures and the address-to-Intents-account mapping", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    const sol = { chain: "solana" as const, account: Buffer.from(publicKey).toString("hex"), label: base58Encode(publicKey) };
    expect(cashOutDestination(sol, "sol").id).toBe("sol");
    expect(() => cashOutDestination({ ...sol, label: base58Encode(new Uint8Array(32).fill(3)) }, "sol")).toThrow();
    const q = { ...quote(), identity: sol, chainId: "sol" as const };
    const text = JSON.stringify({ ...JSON.parse(payload()), signer_id: sol.account });
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(text)));
    const signed = encodeEd25519(text, publicKey, signature);
    await expect(verifyCashOutSignature(signed, text, q)).resolves.toBeUndefined();
    signature[0] ^= 1;
    await expect(verifyCashOutSignature(encodeEd25519(text, publicKey, signature), text, q)).rejects.toThrow();
  });
});
