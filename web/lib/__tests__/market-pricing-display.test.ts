import { describe, expect, it } from "vitest";
import { averageShareCost } from "../format";
import { participationLabel } from "../probability";

describe("market pricing display", () => {
  it("distinguishes empty and one-sided holdings from two-sided odds", () => {
    expect(participationLabel({ yes_shares: "0", no_shares: "0" })).toBe("No trades yet");
    expect(participationLabel({ yes_shares: "980000", no_shares: "0" })).toBe("Only Yes held");
    expect(participationLabel({ yes_shares: "0", no_shares: "980000" })).toBe("Only No held");
    expect(participationLabel({ yes_shares: "980000", no_shares: "1697409" })).toBeNull();
  });

  it("shows the fee-inclusive average of the actual live No quote", () => {
    expect(averageShareCost(1_000_000n, 1_697_409n)).toBe("0.5891");
    expect(averageShareCost(1_000_000n, 980_000n)).toBe("1.0204");
  });

  it("never describes a positive cost as free or divides by zero", () => {
    expect(averageShareCost(1n, 1_000_000n)).toBe("<0.0001");
    expect(averageShareCost(1_000_000n, 0n)).toBeNull();
    expect(averageShareCost(0n, 980_000n)).toBeNull();
  });
});
