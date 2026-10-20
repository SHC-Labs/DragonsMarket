import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";

export default function NotFound() {
  return <PageHeader title="Page not found" description="This link doesn’t lead to a page on Dragons Market." actions={<Link href="/" className="ritual-link">Browse markets ↗</Link>} />;
}
