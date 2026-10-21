"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Client replacement also works with the static export; old bookmarks keep a usable link.
export function MembershipRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/council#membership"); }, [router]);
  return <section className="membership-redirect"><p role="status">Membership is now part of the Council.</p><Link href="/council#membership" className="ritual-link">Go to Council membership ↗</Link></section>;
}
