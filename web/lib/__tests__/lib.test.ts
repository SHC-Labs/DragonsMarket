import { describe, expect, it } from "vitest";
import { cents, formatMoney, formatShares, maxSharesWithSlippage, minSharesWithSlippage, shortAccount, timeLeft, toMicro } from "../format";
import { friendlyError } from "../errors";

describe("toMicro", () => {
  it("parses plain amounts", () => {
    expect(toMicro("12.5")).toBe(12_500_000n);
    expect(toMicro("0.000001")).toBe(1n);
    expect(toMicro("7")).toBe(7_000_000n);
    expect(toMicro(" 3.20 ")).toBe(3_200_000n);
    expect(toMicro("12.")).toBe(12_000_000n);
  });
  it("rejects anything else", () => {
    for (const bad of ["", "abc", "-1", "1.0000001", "1,5", "1e3", ".5"]) expect(toMicro(bad)).toBeNull();
  });
});

describe("formatting", () => {
  it("shows money with two decimals", () => {
    expect(formatMoney(12_500_000n)).toBe("12.50");
    expect(formatMoney("1000000000")).toBe("1,000.00");
    expect(formatMoney(0n)).toBe("0.00");
    expect(formatMoney(999_999n)).toBe("1.00");
  });
  it("shows shares with one decimal", () => {
    expect(formatShares(36_800_000n)).toBe("36.8");
  });
  it("rounds prices to whole cents", () => {
    expect(cents("340000")).toBe("34¢");
    expect(cents("500000")).toBe("50¢");
    expect(cents("84999")).toBe("8¢");
    expect(cents("85000")).toBe("9¢");
  });
  it("shortens long account ids and leaves short ones", () => {
    expect(shortAccount("alice.near")).toBe("alice.near");
    expect(shortAccount("a".repeat(64))).toHaveLength(19);
  });
});

describe("timeLeft", () => {
  const now = 1_000_000;
  const at = (ms: number) => BigInt(now + ms) * 1_000_000n;
  it("counts down in the right unit", () => {
    expect(timeLeft(at(40_000), now)).toBe("40s left");
    expect(timeLeft(at(14 * 60_000 + 5_000), now)).toBe("14m 5s left");
    expect(timeLeft(at((2 * 3600 + 14 * 60) * 1000), now)).toBe("2h 14m left");
    expect(timeLeft(at(-1), now)).toBe("ended");
  });
});

describe("slippage", () => {
  it("lowers the minimum a buyer accepts and raises the maximum a seller pays", () => {
    expect(minSharesWithSlippage(10_000n)).toBe(9_900n);
    expect(maxSharesWithSlippage(10_000n)).toBe(10_100n);
    expect(maxSharesWithSlippage(1n)).toBeGreaterThanOrEqual(1n);
  });
});

describe("friendlyError", () => {
  it("explains known failures in plain words", () => {
    expect(friendlyError("market is closed", "abc123")).toBe("Trading has closed on this market.");
    expect(friendlyError("price moved, you would get fewer shares than your minimum", "abc123")).toMatch(/price moved/i);
    expect(friendlyError("do the storage deposit first", "abc123")).toBe("Do the one-time storage step first.");
  });
  it("never leaves a person without a reference", () => {
    expect(friendlyError(null, "abc123")).toBe("The transaction could not be confirmed. Check its final status before trying again. Reference abc123.");
    expect(friendlyError("some new panic", "abc123")).toContain("abc123");
  });
});

import { seedHex, sigilSpec, polygonPoints } from "../sigil";

describe("sigil", () => {
  it("is deterministic: the same fingerprint always gives the same emblem", () => {
    const h = "a41f09c2" + "7be310".repeat(9);
    expect(sigilSpec(h)).toEqual(sigilSpec(h));
  });
  it("tells similar account ids apart", () => {
    const a = seedHex("dev-20261009014034-27941227840915.test.near");
    const b = seedHex("dev-20261009014034-69476298784454.test.near");
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
    expect(JSON.stringify(sigilSpec(a))).not.toBe(JSON.stringify(sigilSpec(b)));
  });
  it("keeps every drawn value inside the 100 by 100 box", () => {
    for (let i = 0; i < 50; i++) {
      const s = sigilSpec(seedHex(`account-${i}`));
      expect(s.sides).toBeGreaterThanOrEqual(3);
      expect(s.sides).toBeLessThanOrEqual(8);
      s.dots.forEach((d) => {
        expect(d.x).toBeGreaterThan(0);
        expect(d.x).toBeLessThan(100);
        expect(d.y).toBeGreaterThan(0);
        expect(d.y).toBeLessThan(100);
      });
      polygonPoints(s.sides, s.polyR, s.rotation).split(" ").forEach((pt) => {
        const [x, y] = pt.split(",").map(Number);
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(100);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(100);
      });
    }
  });
});
