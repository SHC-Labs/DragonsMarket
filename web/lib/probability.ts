import type { MarketView } from "./market";

// Price of Yes in millionths -> whole percent. A price of 0.52 reads as 52%.
export const pct = (priceMicro: string | number | bigint): number => Math.round(Number(priceMicro) / 10_000);

// Open markets with the most collateral locked come first when picking a featured one.
export function pickFeatured(markets: MarketView[]): MarketView | null {
  const open = markets.filter((m) => m.status === "open");
  const pool = open.length ? open : markets;
  return pool.reduce<MarketView | null>((best, m) => (!best || BigInt(m.locked) > BigInt(best.locked) ? m : best), null);
}

export function resultWord(m: MarketView): string {
  return m.outcome === "yes" ? "Yes" : m.outcome === "no" ? "No" : "Void";
}
