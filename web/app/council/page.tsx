import type { Metadata } from "next";
import { CouncilView } from "./view";
export const metadata: Metadata = {
  title: "Council | Dragons Market",
  description: "Meet the Dragons and the planned Council: eligible staked seats, dispute juries and quarterly fee-sharing claims.",
};
export default function CouncilPage() {
  return <CouncilView />;
}
