import type { Metadata } from "next";
import { CouncilView } from "./view";
export const metadata: Metadata = {
  title: "Council | Dragons Market",
  description: "Dragon NFT membership, staked Council seats, platform fee sharing, and public dispute records.",
};
export default function CouncilPage() {
  return <CouncilView />;
}
