import type { Metadata } from "next";
import { Membership } from "@/components/Membership";
export const metadata: Metadata = { title: "Membership | The Council" };
export default function MembershipPage() { return <Membership />; }
