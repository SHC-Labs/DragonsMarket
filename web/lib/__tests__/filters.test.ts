import { describe, expect, it } from "vitest";
import { filterMarkets, filtersFromQuery, matchesQuery, sortMarkets } from "../filters";
import type { MarketView } from "../market";

const mk = (id: string, title: string, category: string, subcategory: string, status: MarketView["status"] = "open", locked = "0", close_at = "1"): MarketView =>
  ({ id, title, category, subcategory, status, locked, close_at, resolution_source: "AP" }) as MarketView;

const markets = [
  mk("0", "Will the Chiefs win the Super Bowl?", "sports", "nfl", "open", "500"),
  mk("1", "Will the Lakers win the title?", "sports", "nba", "open", "900"),
  mk("2", "Will bitcoin reach 100k?", "crypto", "bitcoin", "closed", "700"),
  mk("3", "Will Netanyahu stay on?", "politics", "world-elections", "resolved", "100"),
];
const none = { cat: "", sub: "", q: "", status: "all" as const };

describe("filterMarkets", () => {
  it("filters by category, then sub-category", () => {
    expect(filterMarkets(markets, { ...none, cat: "sports" }).map((m) => m.id)).toEqual(["0", "1"]);
    expect(filterMarkets(markets, { ...none, cat: "sports", sub: "nfl" }).map((m) => m.id)).toEqual(["0"]);
  });
  it("filters by status group", () => {
    expect(filterMarkets(markets, { ...none, status: "resolving" }).map((m) => m.id)).toEqual(["2"]);
    expect(filterMarkets(markets, { ...none, status: "final" }).map((m) => m.id)).toEqual(["3"]);
  });
  it("searches titles and also category and sub-category names", () => {
    expect(filterMarkets(markets, { ...none, q: "lakers" }).map((m) => m.id)).toEqual(["1"]);
    expect(filterMarkets(markets, { ...none, q: "nfl" }).map((m) => m.id)).toEqual(["0"]);
    expect(matchesQuery(markets[0], "sports")).toBe(true);
    expect(filterMarkets(markets, { ...none, q: "zzz" })).toEqual([]);
  });
  it("combines filters", () => {
    expect(filterMarkets(markets, { cat: "sports", sub: "", q: "win", status: "open" }).map((m) => m.id)).toEqual(["0", "1"]);
  });
});

describe("sortMarkets", () => {
  it("sorts by money in play without changing the input", () => {
    expect(sortMarkets(markets, "volume").map((m) => m.id)).toEqual(["1", "2", "0", "3"]);
    expect(markets.map((m) => m.id)).toEqual(["0", "1", "2", "3"]);
  });
  it("sorts newest first", () => {
    expect(sortMarkets(markets, "newest").map((m) => m.id)).toEqual(["3", "2", "1", "0"]);
  });
});

describe("filtersFromQuery", () => {
  it("reads the URL and ignores nonsense", () => {
    const q = new URLSearchParams("cat=sports&sub=nfl&q=chiefs&status=bogus&sort=closing");
    expect(filtersFromQuery((k) => q.get(k))).toEqual({ cat: "sports", sub: "nfl", q: "chiefs", status: "all", sort: "closing" });
    expect(filtersFromQuery(() => null)).toEqual({ cat: "", sub: "", q: "", status: "all", sort: "volume" });
  });
});
