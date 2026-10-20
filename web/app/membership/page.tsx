import type { Metadata } from "next";
import { MembershipRedirect } from "./redirect";
export const metadata: Metadata = {
  title: "Council membership | Dragons Market",
  alternates: { canonical: "/council" },
  robots: { index: false, follow: true },
};
export default function MembershipPage() { return <MembershipRedirect />; }
