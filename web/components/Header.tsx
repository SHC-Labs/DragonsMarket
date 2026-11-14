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
import { shortAddress } from "@/lib/wallet-account";

export function Header() {
  const { account, identity, walletAvailable, openConnect, disconnect, backendAccount, signOutOnAllDevices } = useWallet();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const pathname = usePathname();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuKey = `${account}:${pathname}`;
  const menuOpen = account !== null && menuFor === menuKey;
  const walletMenu = useRef<HTMLDivElement>(null);
  const walletButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !walletMenu.current?.contains(event.target)) setMenuFor(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuFor(null); walletButton.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);
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
  const links = [{ href: "/", label: "Markets" }, { href: "/watchlist", label: "Watchlist" }, { href: "/council", label: "Council" }, { href: "/stake", label: "Stake" }, { href: "/agents", label: "Agents" }];
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
          {account ? (
            <div className="wallet-menu" ref={walletMenu} onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) setMenuFor(null);
            }}>
              <button ref={walletButton} type="button" className="wallet-pill" onClick={() => setMenuFor(menuOpen ? null : menuKey)}
                aria-label={`Account menu for ${account}`} aria-expanded={menuOpen} aria-controls="wallet-account-menu">
                <span aria-hidden="true" className="wallet-dot" />
                <span className="wallet-account">{identity && identity.chain !== "near" ? shortAddress(identity.label) : shortAccount(account, 16)}</span>
                <span aria-hidden="true">⌄</span>
              </button>
              {menuOpen && <nav id="wallet-account-menu" className="wallet-dropdown" aria-label="Wallet account">
                <Link href="/portfolio" onClick={() => setMenuFor(null)}>Portfolio</Link>
                <Link href="/portfolio#deposit" onClick={() => setMenuFor(null)}>Deposit funds</Link>
                <button type="button" onClick={() => { setMenuFor(null); disconnect(); }}>Disconnect</button>
                {backendAccount && <button type="button" onClick={() => { setSignOutFailed(false); signOutOnAllDevices().catch(() => setSignOutFailed(true)); }}>
                  {signOutFailed ? "Could not sign out, try again" : "Sign out on all devices"}
                </button>}
              </nav>}
            </div>
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
