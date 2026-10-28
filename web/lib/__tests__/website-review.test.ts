import { describe, expect, it } from "vitest";
import { netSellProceeds } from "../settlement";
import { minSharesWithSlippage } from "../format";
import { friendlyError } from "../errors";

describe("reviewed settlement display", () => {
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
