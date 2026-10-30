"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./Brand";
import { HowItWorksDialog } from "./HowItWorksDialog";
import { ThemeToggle } from "./ThemeToggle";
import { usePathname } from "next/navigation";
import { useWallet } from "./WalletProvider";
import { useIndicator } from "./useIndicator";
import { Button } from "./ui";
import { shortAccount } from "@/lib/format";

export function Header() {
  const { account, walletAvailable, openConnect, disconnect, backendAccount, signOutOnAllDevices } = useWallet();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const pathname = usePathname();
  const desktopNav = useRef<HTMLElement>(null);
  const mobileNav = useRef<HTMLElement>(null);
  const bar = useRef<HTMLElement>(null);
  // Solid once content scrolls beneath the header; glass only over the page's own top.
  useEffect(() => {
    const onScroll = () => bar.current?.toggleAttribute("data-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useIndicator(desktopNav, pathname);
  useIndicator(mobileNav, pathname);
  useEffect(() => {
    const nav = mobileNav.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && active) nav.scrollLeft = active.offsetLeft - Math.max(0, (nav.clientWidth - active.offsetWidth) / 2);
  }, [pathname]);
  const links = [{ href: "/", label: "Markets" }, { href: "/watchlist", label: "Watchlist" }, { href: "/council", label: "Council" }, { href: "/partnerships", label: "Partnerships" }, { href: "/portfolio", label: "Portfolio" }];
  const navigation = links.map(({ href, label }) => (
    <Link key={href} href={href} aria-current={pathname === href || (href === "/" && pathname === "/market") ? "page" : undefined} className="site-nav-link">{label}</Link>
  ));
  return (
    <header ref={bar} className="site-header" style={{ viewTransitionName: "site-header" }}>
      <div className="site-header-row">
        <div className="site-header-start">
          <Brand />
          <nav ref={desktopNav} className="site-nav" aria-label="Main">{navigation}</nav>
        </div>
        <div className="site-header-actions">
          <HowItWorksDialog />
          <ThemeToggle />
          {backendAccount && (
            <button type="button" className="how-it-works-trigger" onClick={() => { setSignOutFailed(false); signOutOnAllDevices().catch(() => setSignOutFailed(true)); }}>
              {signOutFailed ? "Could not sign out, try again" : "Sign out on all devices"}
            </button>
          )}
          {account ? (
            <button type="button" className="wallet-pill" onClick={disconnect} aria-label={`Connected as ${account}. Disconnect`}>
              <span aria-hidden="true" className="wallet-dot" />
              <span className="wallet-account">{shortAccount(account, 16)}</span><span className="wallet-action">Disconnect</span>
            </button>
          ) : (
            <Button size="sm" onClick={openConnect} disabled={!walletAvailable} title={walletAvailable ? undefined : "Wallet connection unavailable"}>
              Connect wallet
            </Button>
          )}
        </div>
      </div>
      <div className="mobile-nav-frame"><nav ref={mobileNav} className="site-nav mobile-site-nav" aria-label="Main">{navigation}</nav></div>
    </header>
  );
}
