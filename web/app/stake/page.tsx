import type { Metadata } from "next";
import { StakeView } from "./view";

export const metadata: Metadata = {
  title: "Stake | Dragons Market",
  description: "Stake a Dragon NFT to take a Council seat, serve on dispute juries and share in platform fees.",
};

export default function StakePage() {
  return <StakeView />;
}
