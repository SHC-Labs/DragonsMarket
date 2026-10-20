"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Brand } from "./Brand";
import { HowItWorksDialog } from "./HowItWorksDialog";
import { ThemeToggle } from "./ThemeToggle";
import { usePathname } from "next/navigation";
import { useWallet } from "./WalletProvider";
import { Button } from "./ui";
import { shortAccount } from "@/lib/format";

export function Header() {
  const { account, walletAvailable, openConnect, disconnect } = useWallet();
  const pathname = usePathname();
  const mobileNav = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = mobileNav.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && active) nav.scrollLeft = active.offsetLeft - nav.offsetLeft - Math.max(0, (nav.clientWidth - active.offsetWidth) / 2);
  }, [pathname]);
  const links = [{ href: "/", label: "Markets" }, { href: "/watchlist", label: "Watchlist" }, { href: "/council", label: "Council" }, { href: "/partnerships", label: "Partnerships" }, { href: "/portfolio", label: "Portfolio" }];
  const navigation = links.map(({ href, label }) => (
    <Link key={href} href={href} aria-current={pathname === href || (href === "/" && pathname === "/market") ? "page" : undefined} className="site-nav-link">{label}</Link>
  ));
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-canvas/75 backdrop-blur-md">
        <div className="site-header-row mx-auto flex h-16 max-w-[var(--page-max)] items-center justify-between gap-4 px-[var(--gutter)]">
          <div className="flex shrink-0 items-center gap-8">
            <Brand />
            <nav className="hidden gap-4 lg:flex" aria-label="Main">{navigation}</nav>
          </div>
          <div className="site-header-actions flex min-w-0 items-center gap-3">
            <HowItWorksDialog />
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
        <div className="mobile-nav-frame lg:hidden"><nav ref={mobileNav} className="mobile-site-nav lg:hidden" aria-label="Main">{navigation}</nav><span className="mobile-nav-hint">Swipe for more navigation ↔</span></div>
      </header>
    </>
  );
}
