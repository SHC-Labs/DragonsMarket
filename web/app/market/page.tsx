import { Suspense } from "react";
import { MarketView } from "./view";

// Static export has no dynamic routes for ids we do not know at build time, so the id is a query: /market?id=0
export default function MarketPage() {
  return (
    <Suspense fallback={<p className="mt-10 text-muted">Loading market</p>}>
      <MarketView />
    </Suspense>
  );
}
