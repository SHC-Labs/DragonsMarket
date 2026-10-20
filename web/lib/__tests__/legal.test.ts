import { describe, expect, it } from "vitest";
import { createLegalAcceptance, legalAcceptanceKey, parseLegalAcceptance, readLegalAcceptance, saveLegalAcceptance } from "../legal";

const receipt = createLegalAcceptance("alice.testnet", "testnet", new Date("2026-10-19T22:00:00Z"));
const serialise = (changes = {}) => JSON.stringify({ ...receipt, ...changes });

describe("wallet policy acceptance preferences", () => {
  it("keeps wallet accounts and networks separate", () => {
    expect(parseLegalAcceptance(serialise(), "alice.testnet", "testnet")).toEqual(receipt);
    expect(parseLegalAcceptance(serialise(), "bob.testnet", "testnet")).toBeNull();
    expect(parseLegalAcceptance(serialise(), "alice.testnet", "mainnet")).toBeNull();
    expect(legalAcceptanceKey("alice.testnet", "testnet")).not.toBe(legalAcceptanceKey("alice.testnet", "mainnet"));
    expect(legalAcceptanceKey("alice.testnet", "testnet")).not.toBe(legalAcceptanceKey("bob.testnet", "testnet"));
  });
  it("requires new acceptance if either policy version changes", () => {
    expect(parseLegalAcceptance(serialise({ termsVersion: "old" }), "alice.testnet", "testnet")).toBeNull();
    expect(parseLegalAcceptance(serialise({ privacyVersion: "old" }), "alice.testnet", "testnet")).toBeNull();
  });
  it("requires explicit agreement and acknowledgement and never treats a click as a signature", () => {
    for (const changes of [{ termsAgreed: false }, { privacyAcknowledged: false }, { termsAgreed: "true" }, { method: "signed" }, { schema: 2 }, { acceptedAt: "invalid" }]) {
      expect(parseLegalAcceptance(serialise(changes), "alice.testnet", "testnet")).toBeNull();
    }
    expect(receipt.method).toBe("clickwrap");
    expect(receipt).not.toHaveProperty("signature");
  });
  it("does not accept corrupt or missing storage", () => {
    for (const raw of [null, "", "[]", "null", "{}", "bad JSON", '"text"']) expect(parseLegalAcceptance(raw, "alice.testnet", "testnet")).toBeNull();
    expect(readLegalAcceptance({ getItem: () => { throw new Error("blocked"); } }, "alice.testnet", "testnet")).toBeNull();
    expect(() => createLegalAcceptance("", "testnet")).toThrow();
  });
  it("does not claim success when storage is blocked or silently drops the write", () => {
    expect(() => saveLegalAcceptance({ setItem: () => { throw new Error("quota"); }, getItem: () => null }, receipt)).toThrow();
    expect(() => saveLegalAcceptance({ setItem: () => {}, getItem: () => null }, receipt)).toThrow("could not be saved");
    const data = new Map<string, string>();
    const storage = { setItem: (key: string, value: string) => { data.set(key, value); }, getItem: (key: string) => data.get(key) ?? null };
    saveLegalAcceptance(storage, receipt);
    expect(readLegalAcceptance(storage, "alice.testnet", "testnet")).toEqual(receipt);
    expect(readLegalAcceptance(storage, "bob.testnet", "testnet")).toBeNull();
  });
});
