import { describe, expect, it } from "vitest";
import { formatExact, toMicro } from "../format";
import { actionPayload, utf8, type IntentsContext } from "../signed-intents";

// Small seeded generator so a failure reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
const ALPHABET = ["0", "1", "5", "9", ".", ",", "-", "+", "e", "E", " ", "\u00a0", "\u0661", "\uff11", "_", "x", "$", "\u2212"];
const PLAIN = /^\d+(\.\d{0,6})?$/;

describe("amount parsing never signs more than it shows", () => {
  it("rejects commas, signs, exponents, separators and non-ASCII digits outright", () => {
    for (const input of ["1,000", "1.000,5", "-1", "+1", "1e6", "1E-2", "1_000", "1 000", "\u0661", "\uff11", "0x10", "Infinity", "NaN", "1.0000001", ".5", "\u22121", ""]) {
      expect(toMicro(input), JSON.stringify(input)).toBeNull();
    }
  });
  it("on 20,000 random strings: anything accepted is a plain decimal whose exact display parses back to the same units", () => {
    const r = rng(42);
    for (let n = 0; n < 20_000; n++) {
      const input = Array.from({ length: 1 + Math.floor(r() * 14) }, () => pick(r, ALPHABET)).join("");
      const value = toMicro(input);
      if (value === null) continue;
      expect(PLAIN.test(input.trim()), JSON.stringify(input)).toBe(true);
      expect(value >= 0n).toBe(true);
      expect(toMicro(formatExact(value).replace(/,/g, ""))).toBe(value);
    }
  });
  it("on 5,000 random amounts up to 10^30 units: the exact display shows every unit, and the rounded display can hide some", () => {
    const r = rng(7);
    let hidden = 0;
    for (let n = 0; n < 5_000; n++) {
      const digits = Array.from({ length: 1 + Math.floor(r() * 30) }, () => pick(r, "0123456789".split(""))).join("");
      const value = BigInt(digits);
      expect(toMicro(formatExact(value).replace(/,/g, ""))).toBe(value);
      if (value % 10_000n !== 0n) hidden++;
    }
    expect(hidden).toBeGreaterThan(0);
  });
  it("shows sub-cent amounts exactly", () => {
    expect([formatExact(4_000n), formatExact(1_004_999n), formatExact(5_000_000n), formatExact(1_234_567_890_123n), formatExact(0n)])
      .toEqual(["0.004", "1.004999", "5.00", "1,234,567.890123", "0.00"]);
  });
});

describe("payload building on random input", () => {
  const ctx: IntentsContext = { verifier: "intents.near", collateral: "nep141:usdc.near", relayer: "relayer.near", relayFee: 20_000n };
  const MSG = ["a", "\"", "\\", "\u00e9", "\u{1F409}", ":", "\n", "\u2028", "\u0000", "}", "{", "\u202e", " "];
  it("on 3,000 payloads: fixed key order, the exact amount and message, and UTF-8 that round-trips byte for byte", () => {
    const r = rng(99);
    for (let n = 0; n < 3_000; n++) {
      const amount = BigInt(Math.floor(r() * 1e15)) * BigInt(1 + Math.floor(r() * 1000));
      const msg = `propose:m:${n}:yes:${Array.from({ length: Math.floor(r() * 40) }, () => pick(r, MSG)).join("")}`;
      const payload = actionPayload(ctx, "0xabc0000000000000000000000000000000000001", { to: "oracle.near", amount, msg });
      const parsed = JSON.parse(payload);
      expect(Object.keys(parsed)).toEqual(["signer_id", "verifying_contract", "deadline", "nonce", "intents"]);
      expect(Object.keys(parsed.intents[0])).toEqual(["intent", "receiver_id", "tokens", "msg"]);
      expect(parsed.intents[0].tokens).toEqual({ "nep141:usdc.near": amount.toString() });
      expect(parsed.intents[0].msg).toBe(msg);
      expect(parsed.intents[1]).toEqual({ intent: "transfer", receiver_id: "relayer.near", tokens: { "nep141:usdc.near": "20000" } });
      expect(new TextDecoder("utf-8", { fatal: true }).decode(utf8(payload))).toBe(payload);
    }
  });
  it("refuses a negative or zero amount instead of building a payload", () => {
    expect(() => actionPayload(ctx, "x", { to: "m", amount: -1n, msg: "m" })).toThrow();
    expect(() => actionPayload(ctx, "x", { to: "m", amount: 0n, msg: "m" })).toThrow();
  });
  it("encodes a lone surrogate as an escape, so the signed bytes still decode to the submitted string", () => {
    const payload = actionPayload(ctx, "x", { to: "m", amount: 1n, msg: "a\ud800b" });
    expect(payload).toContain("\\ud800");
    expect(new TextDecoder("utf-8", { fatal: true }).decode(utf8(payload))).toBe(payload);
  });
});
