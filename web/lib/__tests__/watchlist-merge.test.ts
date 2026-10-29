import { describe, expect, it } from "vitest";
import { MAX_WATCHED, mergeWatchlists } from "../watchlist-merge";

describe("watchlist merge", () => {
  it("joins both lists and pushes only what the server lacks", () => {
    expect(mergeWatchlists({ local: ["1", "2"], remote: ["2", "3"], removed: [] })).toEqual({ ids: ["1", "2", "3"], push: ["1"], remove: [] });
  });

  it("keeps a removed market removed even when another device still has it", () => {
    expect(mergeWatchlists({ local: ["1"], remote: ["1", "7"], removed: ["7"] })).toEqual({ ids: ["1"], push: [], remove: ["7"] });
  });

  it("does not ask the server to remove what it never held", () => {
    expect(mergeWatchlists({ local: [], remote: ["1"], removed: ["9"] }).remove).toEqual([]);
  });

  it("leaves out ids the server would refuse and stops at the server's cap", () => {
    const many = Array.from({ length: MAX_WATCHED + 20 }, (_, i) => String(i));
    expect(mergeWatchlists({ local: ["abc", "1.5", ...many], remote: [], removed: [] }).ids).toHaveLength(MAX_WATCHED);
    expect(mergeWatchlists({ local: ["abc", "1.5", "4"], remote: [], removed: [] }).ids).toEqual(["4"]);
  });
});
