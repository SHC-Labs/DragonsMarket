import type { Metadata } from "next";
import { CouncilView } from "./view";
export const metadata: Metadata = { title: "Council | The Council" };
export default function CouncilPage() {
  return <CouncilView />;
}
