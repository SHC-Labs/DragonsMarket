import { Suspense } from "react";
import { HomeView } from "../home-view";
export const metadata = { title: "Watchlist | The Council" };
export default function Watchlist() {
  return <Suspense fallback={<p className="mt-10 text-muted">Loading your watchlist</p>}><HomeView watchlistOnly /></Suspense>;
}
