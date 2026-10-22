import { Bitcoin, Bot, CloudSun, Cpu, Film, Flame, Globe2, House, Landmark, Rocket, TrendingUp, Trophy, Vote, Gamepad2 } from "@/components/icons";
import type { CSSProperties } from "react";

export const categoryTone = (category: string) => ["politics", "sports", "crypto", "economy", "tech", "culture", "world"].includes(category) ? category : "other";

// The category's colour pair from the palette, as the --icon-bg / --icon-ink the glyphs draw with.
export const categoryColours = (category: string) => {
  const tone = categoryTone(category);
  return { "--icon-bg": `var(--category-${tone}-bg)`, "--icon-ink": `var(--category-${tone}-ink)` } as CSSProperties;
};

// The glyph for a market's category and topic: a drawn ball for the main ball sports, otherwise an icon.
export function CategoryGlyph({ category, sub, size }: { category: string; sub: string; size: number }) {
  let Icon = category === "politics" ? Landmark : category === "sports" ? Trophy : category === "crypto" ? Bitcoin : category === "economy" ? TrendingUp : category === "tech" ? Cpu : category === "culture" ? Film : Globe2;
  if (category === "politics" && sub.includes("election")) Icon = Vote;
  if (sub === "weather") Icon = CloudSun; if (sub === "ai") Icon = Bot; if (sub === "space") Icon = Rocket; if (sub === "gaming") Icon = Gamepad2; if (sub === "housing") Icon = House; if (sub === "oil") Icon = Flame;
  const ball = category === "sports" && ["nba", "mlb", "nfl", "soccer", "world-cup"].includes(sub);
  if (!ball) return <Icon size={size} variant="Bulk" />;
  return <svg viewBox="0 0 32 32" width={size} height={size} fill="none">
    {sub === "nba" ? <><circle cx="16" cy="16" r="12" fill="var(--icon-ink)" stroke="var(--icon-bg)" strokeWidth="1.7" /><path d="M4 16h24M16 4v24M7 7c11 4 14 10 18 18M25 7C14 11 11 14 7 25" stroke="var(--icon-bg)" strokeWidth="1.7" /></>
      : sub === "mlb" ? <><circle cx="16" cy="16" r="12" fill="var(--icon-bg)" stroke="var(--icon-ink)" strokeWidth="1.5" /><path d="M9 6c8 5 8 15 0 20M23 6c-8 5-8 15 0 20" stroke="var(--icon-ink)" strokeWidth="2" strokeDasharray="2 2" /></>
      : sub === "nfl" ? <><ellipse cx="16" cy="16" rx="14" ry="8" transform="rotate(-40 16 16)" fill="var(--icon-ink)" stroke="var(--icon-bg)" strokeWidth="1.5" /><path d="m11 20 10-9M12 15l5 5M15 12l5 5" stroke="var(--icon-bg)" strokeWidth="2" /></>
      : <><circle cx="16" cy="16" r="12" fill="var(--icon-bg)" stroke="var(--icon-ink)" strokeWidth="1.5" /><path d="m16 10 6 4-2 7h-8l-2-7 6-4ZM7 6l4 4-5 6H4M25 6l-4 4 5 6h2M10 27l3-6M22 27l-3-6" fill="var(--icon-ink)" stroke="var(--icon-ink)" strokeWidth="1.5" /></>}
  </svg>;
}

export function MarketIcon({ category, sub, small = false }: { category: string; sub: string; small?: boolean }) {
  return <span aria-hidden="true" className={`market-category-art market-icon ${small ? "market-category-art-small" : ""}`} style={categoryColours(category)}>
    <CategoryGlyph category={category} sub={sub} size={small ? 25 : 29} />
  </span>;
}
