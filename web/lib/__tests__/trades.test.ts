import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({ config: { backendUrl: "https://api.example.com", marketId: "market.example.near" } }));
vi.mock("../rpc", () => ({ chainHeight: async () => 5000n }));

import { recentTrades } from "../trades";

const row = (n: number, event = "buy") => ({
  block_height: String(4200 + n), block_timestamp_ns: String((1_700_000_000_000 + n * 1000) * 1_000_000), receipt_id: `r${n}`,
  log_index: 0, data_index: 0, event, payload: { account: `t${n}.near`, market_id: "0", side: "yes", collateral: "1000000", price_yes: "500000" },
});

afterEach(() => vi.unstubAllGlobals());

describe("recentTrades", () => {
  it("walks every page of the window so the newest trades are the ones shown", async () => {
    // 250 buys, served oldest first, 100 to a page
    const buys = Array.from({ length: 250 }, (_, n) => row(n));
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      seen.push(url.search);
      const page = Number(url.searchParams.get("cursor") ?? 0);
      const all = url.searchParams.get("event") === "buy" ? buys : [];
      const data = all.slice(page * 100, page * 100 + 100);
      const nextCursor = (page + 1) * 100 < all.length ? String(page + 1) : null;
      return new Response(JSON.stringify({ data, nextCursor }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const trades = await recentTrades(3);
    expect(trades?.map((t) => t.account)).toEqual(["t249.near", "t248.near", "t247.near"]);
    expect(seen.filter((s) => s.includes("event=buy"))).toHaveLength(3);
  });
});
