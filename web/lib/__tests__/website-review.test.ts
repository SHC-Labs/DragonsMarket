import { describe, expect, it } from "vitest";
import { voidPayout, netSellProceeds } from "../settlement";
import { minSharesWithSlippage } from "../format";
import { friendlyError } from "../errors";

describe("reviewed settlement display", () => {
  it("uses the published weighted Void price, including asymmetric positions", () => {
    expect(voidPayout(10_000_000n, 4_000_000n, "700000")).toBe(8_200_000n);
    expect(voidPayout(1n, 0n, "999999")).toBe(0n);
    expect(voidPayout(10n, 0n, "0")).toBe(0n);
    expect(voidPayout(10n, 0n, "1000000")).toBe(10n);
  });
  it("does not invent a half-price settlement for unknown or invalid values", () => {
    for (const value of [undefined, null, "", "-1", "1000001", "bad"]) expect(voidPayout(10n, 5n, value)).toBeNull();
  });
  it("subtracts the fee from gross sell proceeds", () => {
    expect(netSellProceeds({collateral_out:"10000000",fee:"300000"})).toBe(9_700_000n);
    expect(() => netSellProceeds({collateral_out:"1",fee:"2"})).toThrow();
  });
  it("keeps positive dust minimums above zero", () => {
    expect(minSharesWithSlippage(1n)).toBe(1n);
    expect(minSharesWithSlippage(0n)).toBe(0n);
  });
  it("distinguishes not-yet-closed, closed, resolved and position limits", () => {
    expect(friendlyError("market has not closed", "abc")).toContain("still open");
    expect(friendlyError("market is closed", "abc")).toContain("has closed");
    expect(friendlyError("market is resolved", "abc")).toContain("final result");
    expect(friendlyError("too many positions", "abc")).toContain("position limit");
  });
});
