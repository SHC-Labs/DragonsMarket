import { categoryOf, labelOf } from "./categories";
import type { MarketView } from "./market";

export type Status = "all" | "open" | "resolving" | "final";
export type Sort = "volume" | "closing" | "newest";

export const STATUSES: { id: Status; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "resolving", label: "In resolution" },
  { id: "final", label: "Final" },
];

export const SORTS: { id: Sort; label: string }[] = [
  { id: "volume", label: "Most in play" },
  { id: "closing", label: "Closing soon" },
  { id: "newest", label: "Newest" },
];

export const statusOf = (m: Pick<MarketView, "status">): Exclude<Status, "all"> =>
  m.status === "open" ? "open" : m.status === "resolved" ? "final" : "resolving";

export interface Filters {
  cat: string;
  sub: string;
  q: string;
  status: Status;
}

// Search looks at the question, who decides it, and the category and sub-category names.
export function matchesQuery(m: MarketView, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const l = labelOf(m.category, m.subcategory);
  return [m.title, m.resolution_source, l.category, l.sub].some((t) => t.toLowerCase().includes(needle));
}

export function filterMarkets(markets: MarketView[], f: Filters): MarketView[] {
  return markets.filter(
    (m) =>
      (!f.cat || categoryOf(m) === f.cat) &&
      (!f.sub || m.subcategory === f.sub) &&
      (f.status === "all" || statusOf(m) === f.status) &&
      matchesQuery(m, f.q),
  );
}

const big = (a: string, b: string) => (BigInt(a) > BigInt(b) ? 1 : BigInt(a) < BigInt(b) ? -1 : 0);

export function sortMarkets(markets: MarketView[], sort: Sort): MarketView[] {
  const by: Record<Sort, (a: MarketView, b: MarketView) => number> = {
    volume: (a, b) => big(b.locked, a.locked),
    closing: (a, b) => big(a.close_at, b.close_at),
    newest: (a, b) => big(b.id, a.id),
  };
  return [...markets].sort(by[sort]);
}

// Reads filters from a URL query. Anything unknown falls back to "no filter".
export function filtersFromQuery(get: (key: string) => string | null): Filters & { sort: Sort } {
  const status = get("status") as Status | null;
  const sort = get("sort") as Sort | null;
  return {
    cat: get("cat") ?? "",
    sub: get("sub") ?? "",
    q: get("q") ?? "",
    status: STATUSES.some((s) => s.id === status) ? (status as Status) : "all",
    sort: SORTS.some((s) => s.id === sort) ? (sort as Sort) : "volume",
  };
}
