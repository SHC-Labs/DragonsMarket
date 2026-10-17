import { Bitcoin, Clapperboard, Cpu, Globe, Landmark, Trophy, TrendingUp, type AppIcon } from "../components/icons";
import type { MarketView } from "./market";

export interface Sub {
  id: string;
  label: string;
}

export interface Category {
  id: string;
  label: string;
  icon: AppIcon;
  subs: Sub[];
}

// The list of categories the site knows about. The contract only stores the two slugs on each market,
// so adding a sport or a topic here is a front-end change. Markets with a slug not listed show under Other.
export const CATEGORIES: Category[] = [
  {
    id: "politics", label: "Politics", icon: Landmark,
    subs: [
      { id: "us-elections", label: "US elections" }, { id: "congress", label: "Congress" }, { id: "white-house", label: "White House" },
      { id: "world-elections", label: "World elections" }, { id: "policy", label: "Policy and courts" },
    ],
  },
  {
    id: "sports", label: "Sports", icon: Trophy,
    subs: [
      { id: "nfl", label: "NFL" }, { id: "nba", label: "NBA" }, { id: "mlb", label: "MLB" }, { id: "nhl", label: "NHL" },
      { id: "college-football", label: "College football" }, { id: "soccer", label: "Soccer" }, { id: "world-cup", label: "World Cup" },
      { id: "tennis", label: "Tennis" }, { id: "f1", label: "Formula 1" }, { id: "ufc", label: "UFC and boxing" },
    ],
  },
  {
    id: "crypto", label: "Crypto", icon: Bitcoin,
    subs: [
      { id: "bitcoin", label: "Bitcoin" }, { id: "ethereum", label: "Ethereum" }, { id: "near", label: "NEAR" },
      { id: "solana", label: "Solana" }, { id: "defi", label: "DeFi" }, { id: "stablecoins", label: "Stablecoins" },
    ],
  },
  {
    id: "economy", label: "Economy", icon: TrendingUp,
    subs: [
      { id: "fed", label: "Fed and rates" }, { id: "inflation", label: "Inflation" }, { id: "stocks", label: "Stocks" },
      { id: "oil", label: "Oil and energy" }, { id: "housing", label: "Housing" }, { id: "jobs", label: "Jobs" },
    ],
  },
  {
    id: "tech", label: "Tech", icon: Cpu,
    subs: [
      { id: "ai", label: "AI" }, { id: "big-tech", label: "Big tech" }, { id: "space", label: "Space" },
      { id: "gaming", label: "Gaming" }, { id: "gadgets", label: "Gadgets" },
    ],
  },
  {
    id: "culture", label: "Culture", icon: Clapperboard,
    subs: [
      { id: "movies", label: "Movies" }, { id: "music", label: "Music" }, { id: "awards", label: "Awards" },
      { id: "tv", label: "TV" }, { id: "celebrities", label: "Celebrities" },
    ],
  },
  {
    id: "world", label: "World", icon: Globe,
    subs: [
      { id: "geopolitics", label: "Geopolitics" }, { id: "weather", label: "Weather and storms" },
      { id: "science", label: "Science" }, { id: "health", label: "Health" },
    ],
  },
];

export const OTHER: Category = { id: "other", label: "Other", icon: Globe, subs: [] };

const known = new Set(CATEGORIES.map((c) => c.id));

// Which tab a market belongs under.
export const categoryOf = (m: Pick<MarketView, "category">): string => (known.has(m.category) ? m.category : "other");

export const findCategory = (id: string): Category | undefined => [...CATEGORIES, OTHER].find((c) => c.id === id);

export function labelOf(category: string, sub: string): { category: string; sub: string } {
  const c = findCategory(categoryOf({ category }));
  return { category: c?.label ?? "Other", sub: c?.subs.find((s) => s.id === sub)?.label ?? sub };
}

export interface Counts {
  all: number;
  byCategory: Record<string, number>;
  bySub: Record<string, Record<string, number>>;
}

export function countMarkets(markets: MarketView[]): Counts {
  const counts: Counts = { all: markets.length, byCategory: {}, bySub: {} };
  for (const m of markets) {
    const c = categoryOf(m);
    counts.byCategory[c] = (counts.byCategory[c] ?? 0) + 1;
    counts.bySub[c] ??= {};
    counts.bySub[c][m.subcategory] = (counts.bySub[c][m.subcategory] ?? 0) + 1;
  }
  return counts;
}
