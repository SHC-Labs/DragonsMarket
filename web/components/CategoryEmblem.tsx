"use client";

import type { PointerEvent } from "react";
import { CategoryGlyph, categoryColours } from "./MarketIcon";

// The market's category, drawn large in its own colours in the corner of the price panel: it floats, and it turns
// toward the pointer as you move across the panel. Decorative: the category is named in the chip and breadcrumb.
export function CategoryEmblem({ category, sub }: { category: string; sub: string }) {
  return <span className="category-emblem" aria-hidden="true" style={categoryColours(category)}>
    <span className="category-emblem-halo" />
    <span className="category-emblem-glyph"><CategoryGlyph category={category} sub={sub} size={160} /></span>
  </span>;
}

// Lets the emblem lean toward the cursor: the panel sets --px/--py from -0.5 to 0.5.
export function trackPanel(e: PointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse") return;
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--px", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
  e.currentTarget.style.setProperty("--py", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
}
