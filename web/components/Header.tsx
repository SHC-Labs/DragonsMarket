"use client";

import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";
import { usePathname } from "next/navigation";
import { useWallet } from "./WalletProvider";
import { Button } from "./ui";
import { shortAccount } from "@/lib/format";

function Mark() {
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-full border border-input text-sm text-council" aria-hidden="true">C</span>
  );
}

export function Header() {
  const { account, walletAvailable, openConnect, disconnect } = useWallet();
  const pathname = usePathname();
  const links = [{ href: "/", label: "Markets" }, { href: "/watchlist", label: "Watchlist" }, { href: "/council", label: "Council" }, { href: "/membership", label: "Membership" }, { href: "/partnerships", label: "Partnerships" }, { href: "/portfolio", label: "Portfolio" }];
  const navigation = links.map(({ href, label }) => (
    <Link key={href} href={href} aria-current={pathname === href || (href === "/" && pathname === "/market") ? "page" : undefined} className="site-nav-link">{label}</Link>
  ));
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-canvas/75 backdrop-blur-md">
        <div className="site-header-row mx-auto flex h-16 max-w-[var(--page-max)] items-center justify-between gap-4 px-[var(--gutter)]">
          <div className="flex shrink-0 items-center gap-8">
            <Link href="/" className="flex items-center gap-2 text-fg no-underline">
              <Mark />
              <span className="brand-wordmark text-[1.1rem] leading-none">The Council</span>
            </Link>
            <nav className="hidden gap-4 lg:flex" aria-label="Main">{navigation}</nav>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <ThemeToggle />
            {account ? (
              <Button variant="secondary" size="sm" onClick={disconnect} aria-label={`Connected as ${account}. Disconnect`}>
                <span aria-hidden="true" className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-yes" />
                <span className="num max-w-[8.5rem] truncate whitespace-nowrap text-sm sm:max-w-none">{shortAccount(account, 16)}</span><span className="ml-2 text-xs">Disconnect</span>
              </Button>
            ) : (
              <Button size="sm" onClick={openConnect} disabled={!walletAvailable} title={walletAvailable ? undefined : "Wallet connection unavailable"}>
                Connect wallet
              </Button>
            )}
          </div>
        </div>
        <nav className="mobile-site-nav lg:hidden" aria-label="Main">{navigation}</nav>
      </header>
    </>
  );
}
