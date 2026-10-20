import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../rpc", () => ({ view: vi.fn() }));
import { view } from "../rpc";
import { listMarkets, isMarketListed, type MarketView } from "../market";
const read = vi.mocked(view);
const batch = (start: number, count: number) => Array.from({length: count}, (_, i) => ({id:String(start+i)} as MarketView));
beforeEach(() => read.mockReset());
describe("market pagination", () => {
  it("includes markets beyond 50 without skipping or truncating", async () => {
    read.mockResolvedValueOnce(batch(0,50)).mockResolvedValueOnce(batch(50,50)).mockResolvedValueOnce(batch(100,3));
    const result = await listMarkets();
    expect(result).toHaveLength(103);
    expect(result.at(-1)?.id).toBe("102");
    expect(read.mock.calls.map(c=>c[2])).toEqual([{from_index:"0",limit:"50"},{from_index:"50",limit:"50"},{from_index:"100",limit:"50"}]);
  });
  it("handles exact full pages and detects a non-advancing endpoint", async () => {
    read.mockResolvedValueOnce(batch(0,50)).mockResolvedValueOnce([]);
    expect(await listMarkets()).toHaveLength(50);
    read.mockResolvedValueOnce(batch(0,50)).mockResolvedValueOnce(batch(0,50));
    await expect(listMarkets()).rejects.toThrow("repeated");
  });
  it("does not display explicitly unregistered or unseeded markets as tradable", () => {
    expect(isMarketListed({registered:true,seeded:false} as MarketView)).toBe(false);
    expect(isMarketListed({registered:false,seeded:true} as MarketView)).toBe(false);
    expect(isMarketListed({registered:true,seeded:true} as MarketView)).toBe(true);
  });
});
