import { Suspense } from "react";
import { MarketFallback, MarketPageView } from "./view";

// Static export has no dynamic routes for ids we do not know at build time, so the id is a query: /market?id=0
export default function MarketPage() {
  return (
    <Suspense fallback={<MarketFallback />}>
      <MarketPageView />
    </Suspense>
  );
}
