import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@defuse-protocol/one-click-sdk-typescript", () => ({ verifyQuoteSignature: vi.fn(() => true) }));
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { DEPOSIT_CHAINS, depositFinished, nextPollMs, parseQuote, quoteExpired, quoteRequest, requestDeposit, readDepositStatus, statusUrl, validRefund } from "../deposit";

afterEach(() => vi.unstubAllGlobals());

describe("1Click deposit", () => {
  it("asks for an origin-chain deposit into the person's Intents account", () => {
    const base = DEPOSIT_CHAINS.find(c => c.id === "base")!;
    expect(quoteRequest({ chain: base, amount: 10_000_000n, recipient: "0xabc0000000000000000000000000000000000001", refundTo: "0xAbC0000000000000000000000000000000000001", collateral: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", now: Date.UTC(2026, 10, 10, 12) })).toEqual({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      amount: "10000000",
      depositType: "ORIGIN_CHAIN",
      recipient: "0xabc0000000000000000000000000000000000001",
      recipientType: "INTENTS",
      refundTo: "0xAbC0000000000000000000000000000000000001",
      refundType: "ORIGIN_CHAIN",
      deadline: "2026-11-10T12:30:00.000Z",
    });
  });
  it("covers USDC on Base, Arbitrum and Solana", () => {
    expect(DEPOSIT_CHAINS.map(c => [c.id, c.refundKind])).toEqual([["base", "evm"], ["arb", "evm"], ["sol", "solana"]]);
  });
  it("refuses a malformed quote", () => {
    const base = DEPOSIT_CHAINS[0];
    const request = quoteRequest({ chain: base, amount: 1n, recipient: "r", refundTo: "0xAbC0000000000000000000000000000000000001", collateral: "c" });
    expect(() => parseQuote({ quote: { amountIn: "1" }, quoteRequest: request }, { request, chain: base, now: 0 })).toThrow();
    expect(() => parseQuote(null, { request, chain: base, now: 0 })).toThrow();
  });
  it("polls status by deposit address and memo", () => {
    expect(statusUrl("0xdep", null)).toBe("https://1click.chaindefuser.com/v0/status?depositAddress=0xdep");
    expect(statusUrl("addr", "42")).toBe("https://1click.chaindefuser.com/v0/status?depositAddress=addr&depositMemo=42");
  });
  it("stops polling on a final status only", () => {
    expect(["SUCCESS", "REFUNDED", "FAILED"].every(s => depositFinished(s as never))).toBe(true);
    expect(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT"].some(s => depositFinished(s as never))).toBe(false);
  });
  it("checks refund addresses by chain family", () => {
    expect(validRefund("evm", "0xAbC0000000000000000000000000000000000001")).toBe(true);
    expect(validRefund("evm", "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK")).toBe(false);
    expect(validRefund("solana", "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK")).toBe(true);
    expect(validRefund("solana", "0xAbC0000000000000000000000000000000000001")).toBe(false);
    expect(validRefund("solana", "z".repeat(44))).toBe(false); // decodes to 33 bytes
    expect(validRefund("solana", "1".repeat(33))).toBe(false);
    expect(validRefund("solana", "1".repeat(32))).toBe(false);
    expect(validRefund("evm", "0x" + "0".repeat(40))).toBe(false);
  });
});

describe("1Click quotes are checked against what was asked", () => {
  const NOW = Date.UTC(2026, 10, 10, 12);
  const base = DEPOSIT_CHAINS.find(c => c.id === "base")!;
  const sol = DEPOSIT_CHAINS.find(c => c.id === "sol")!;
  const collateral = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const recipient = "0xabc0000000000000000000000000000000000001";
  const request = (chain = base) => quoteRequest({ chain, amount: 10_000_000n, recipient, refundTo: chain === base ? "0xAbC0000000000000000000000000000000000001" : "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK", collateral, now: NOW });
  const reply = (req: ReturnType<typeof request>, quote: Record<string, unknown> = {}, echo: Record<string, unknown> = {}) => ({
    correlationId: "c", timestamp: "t", signature: "s",
    quoteRequest: { ...req, ...echo },
    quote: { depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8", amountIn: "10000000", amountOut: "9990000", deadline: "2026-11-10T12:30:00Z", ...quote },
  });
  const check = (body: unknown, chain = base, now = NOW) => parseQuote(body, { request: request(chain), chain, now });

  it("accepts a quote that matches the request", () => {
    expect(check(reply(request())).depositAddress).toBe("0x76b4c56085ED136a8744D52bE956396624a730E8");
    expect(check(reply(request(sol), { depositAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }), sol).depositAddress).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  });
  it("keeps the sending window short when the provider address lives longer", () => {
    expect(check(reply(request(), { deadline: "2026-11-13T12:30:00Z" })).deadline).toBe(request().deadline);
  });
  it("refuses a quote with an invalid service signature", () => {
    vi.mocked(verifyQuoteSignature).mockReturnValueOnce(false);
    expect(() => check(reply(request()))).toThrow();
  });
  const wrong: [string, () => unknown][] = [
    ["another recipient", () => reply(request(), {}, { recipient: "0xdef0000000000000000000000000000000000002" })],
    ["a recipient outside Intents", () => reply(request(), {}, { recipientType: "DESTINATION_CHAIN" })],
    ["another destination asset", () => reply(request(), {}, { destinationAsset: "nep141:wrap.near" })],
    ["another origin asset", () => reply(request(), {}, { originAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" })],
    ["another refund address", () => reply(request(), {}, { refundTo: "0xdef0000000000000000000000000000000000002" })],
    ["a different refund chain type", () => reply(request(), {}, { refundType: "INTENTS" })],
    ["a dry-run quote", () => reply(request(), {}, { dry: true })],
    ["a weaker slippage limit", () => reply(request(), {}, { slippageTolerance: 200 })],
    ["a changed request deadline", () => reply(request(), {}, { deadline: "2026-11-10T13:30:00Z" })],
    ["another requested amount", () => reply(request(), {}, { amount: "1" })],
    ["a quoted input other than the amount asked", () => reply(request(), { amountIn: "10000001" })],
    ["a non-numeric output", () => reply(request(), { amountOut: "1e7" })],
    ["more out than in", () => reply(request(), { amountOut: "10000001" })],
    ["a Solana address for an EVM chain", () => reply(request(), { depositAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" })],
    ["an address with markup", () => reply(request(), { depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8<script>" })],
    ["a memo nobody asked for", () => reply(request(), { depositMemo: "42" })],
    ["an expired deadline", () => reply(request(), { deadline: "2026-11-10T11:59:00Z" })],
    ["an unreadable deadline", () => reply(request(), { deadline: "soon" })],
    ["an unbounded address lifetime", () => reply(request(), { deadline: "2026-11-20T13:30:00Z" })],
    ["no echo of the request", () => ({ quote: reply(request()).quote })],
  ];
  for (const [name, body] of wrong) it(`refuses ${name}`, () => { expect(() => check(body())).toThrow(); });
  it("refuses an EVM address on Solana", () => {
    expect(() => check(reply(request(sol)), sol)).toThrow();
  });
  it("bounds service responses and sends no browser credentials or redirects", async () => {
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(" ".repeat(128 * 1024 + 1));
    });
    vi.stubGlobal("fetch", transport);
    await expect(requestDeposit(request(), base)).rejects.toThrow(/does not recognise/);
    await expect(readDepositStatus("0x76b4c56085ED136a8744D52bE956396624a730E8", null)).rejects.toThrow(/too large/);
  });
});

describe("status polling is bounded", () => {
  const deadline = Date.UTC(2026, 10, 10, 12, 30);
  it("polls every few seconds, slows down, and stops an hour after the address expires", () => {
    expect(nextPollMs(0, deadline - 60_000, deadline)).toBe(5_000);
    expect(nextPollMs(30, deadline - 60_000, deadline)).toBeGreaterThan(5_000);
    expect(nextPollMs(30, deadline - 60_000, deadline)!).toBeLessThanOrEqual(30_000);
    expect(nextPollMs(5, deadline + 61 * 60_000, deadline)).toBeNull();
    expect(nextPollMs(10_000, deadline - 60_000, deadline)).toBeNull();
  });
  it("tells an expired address apart from a live one", () => {
    expect(quoteExpired(deadline, deadline - 1)).toBe(false);
    expect(quoteExpired(deadline, deadline)).toBe(true);
  });
});
