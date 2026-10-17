import { describe, expect, it } from "vitest";
import { CATEGORIES, categoryOf, countMarkets, labelOf } from "../categories";
import type { MarketView } from "../market";

const m = (category: string, subcategory: string): MarketView => ({ category, subcategory }) as MarketView;

describe("categories", () => {
  it("every category and sub-category id is a lowercase slug the contract accepts", () => {
    for (const c of CATEGORIES) {
      expect(c.id).toMatch(/^[a-z0-9-]{1,32}$/);
      c.subs.forEach((s) => expect(s.id).toMatch(/^[a-z0-9-]{1,32}$/));
      expect(new Set(c.subs.map((s) => s.id)).size).toBe(c.subs.length);
    }
    expect(new Set(CATEGORIES.map((c) => c.id)).size).toBe(CATEGORIES.length);
  });
  it("covers the sports people ask for", () => {
    const sports = CATEGORIES.find((c) => c.id === "sports")!;
    for (const id of ["nfl", "nba", "mlb", "world-cup", "soccer", "f1"]) expect(sports.subs.map((s) => s.id)).toContain(id);
  });
  it("puts unknown categories under Other and keeps their sub-category text", () => {
    expect(categoryOf(m("sports", "nfl"))).toBe("sports");
    expect(categoryOf(m("gardening", "roses"))).toBe("other");
    expect(labelOf("sports", "world-cup")).toEqual({ category: "Sports", sub: "World Cup" });
    expect(labelOf("gardening", "roses")).toEqual({ category: "Other", sub: "roses" });
  });
  it("counts markets per category and sub-category", () => {
    const c = countMarkets([m("sports", "nfl"), m("sports", "nfl"), m("sports", "nba"), m("crypto", "bitcoin"), m("odd", "x")]);
    expect(c.all).toBe(5);
    expect(c.byCategory).toEqual({ sports: 3, crypto: 1, other: 1 });
    expect(c.bySub.sports).toEqual({ nfl: 2, nba: 1 });
  });
});
