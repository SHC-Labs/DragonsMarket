import { Suspense } from "react";
import { HomeView } from "./home-view";

// The filters live in the URL (?cat=sports&sub=nfl), which a static page can only read in the browser.
export default function Home() {
  return (
    <Suspense fallback={<p className="mt-16 text-muted">Loading markets</p>}>
      <HomeView />
    </Suspense>
  );
}
