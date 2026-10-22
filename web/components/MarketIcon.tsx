import { Baseball, Basketball, Bitcoin, Bot, CloudSun, Cpu, Film, Flame, Football, Gamepad2, Globe2, Hockey, House, Landmark, RacingFlag, Rocket, SoccerBall, TennisBall, TrendingUp, Trophy, Vote, type AppIcon } from "@/components/icons";
import type { CSSProperties } from "react";

export const categoryTone = (category: string) => ["politics", "sports", "crypto", "economy", "tech", "culture", "world"].includes(category) ? category : "other";

// The category's colour pair from the palette, as the --icon-bg / --icon-ink the glyphs draw with.
export const categoryColours = (category: string) => {
  const tone = categoryTone(category);
  return { "--icon-bg": `var(--category-${tone}-bg)`, "--icon-ink": `var(--category-${tone}-ink)` } as CSSProperties;
};

// Sports topics with their own equipment; everything else falls back to its category's icon.
const SPORT: Record<string, AppIcon> = {
  nba: Basketball, nfl: Football, "college-football": Football, mlb: Baseball, soccer: SoccerBall, "world-cup": SoccerBall,
  nhl: Hockey, tennis: TennisBall, f1: RacingFlag,
};
const TOPIC: Record<string, AppIcon> = { weather: CloudSun, ai: Bot, space: Rocket, gaming: Gamepad2, housing: House, oil: Flame };
const CATEGORY: Record<string, AppIcon> = { politics: Landmark, sports: Trophy, crypto: Bitcoin, economy: TrendingUp, tech: Cpu, culture: Film };

// The glyph for a market's category and topic, in Phosphor's duotone weight.
export function CategoryGlyph({ category, sub, size }: { category: string; sub: string; size: number }) {
  const Icon = (category === "sports" && SPORT[sub]) || TOPIC[sub] || (category === "politics" && sub.includes("election") ? Vote : null) || CATEGORY[category] || Globe2;
  return <Icon size={size} variant="Bulk" />;
}

export function MarketIcon({ category, sub, small = false }: { category: string; sub: string; small?: boolean }) {
  return <span aria-hidden="true" className={`market-category-art market-icon ${small ? "market-category-art-small" : ""}`} style={categoryColours(category)}>
    <CategoryGlyph category={category} sub={sub} size={small ? 25 : 29} />
  </span>;
}
