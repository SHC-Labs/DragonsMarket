"use client";

import { useState } from "react";
import { Button, Notice } from "./ui";
import { ModalDialog } from "./ModalDialog";
import { Wallet } from "./icons";
import { DEEP_LINKS, deviceOf, insideWalletBrowser, walletPage } from "@/lib/deep-links";
import { UserFacingError } from "@/lib/errors";
import type { Discovered } from "./WalletProvider";

interface Props {
  wallets: Discovered;
  onClose: () => void;
  onNear: () => void;
  onBrowserWallet: (kind: "evm" | "solana", id: string) => Promise<void>;
}

const coarsePointer = () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

function WalletRow({ name, icon, busy, onClick }: { name: string; icon: string | null; busy: boolean; onClick: () => void }) {
  return <button type="button" className="connect-option" disabled={busy} onClick={onClick}>
    {/* wallet-supplied data: image, never a remote URL */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {icon ? <img src={icon} alt="" width={28} height={28} /> : <Wallet size={24} aria-hidden="true" />}
    <span>{name}</span>
  </button>;
}

export function ConnectDialog({ wallets, onClose, onNear, onBrowserWallet }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const device = deviceOf(navigator.userAgent, coarsePointer());
  const page = walletPage(window.location);
  // Inside a wallet's own browser the wallet is already here; discovery may just not have reported it yet.
  const none = wallets.evm.length === 0 && wallets.solana.length === 0 && !insideWalletBrowser(window as unknown as Record<string, unknown>);
  const phone = device.mobile && page !== null;

  const choose = async (kind: "evm" | "solana", id: string) => {
    setPending(`${kind}:${id}`);
    setError(null);
    try { await onBrowserWallet(kind, id); }
    catch (e) { setError(e instanceof UserFacingError ? e.message : "The wallet could not connect. Open it, then try again."); setPending(null); }
  };
  const copy = () => navigator.clipboard.writeText(page ?? "").then(() => setCopied(true), () => setCopied(false));

  return <ModalDialog titleId="connect-title" onClose={onClose}>
    <h2 id="connect-title">Connect a wallet</h2>
    <p className="wallet-dialog-lede">Your keys stay in your wallet. This site asks it to sign one message at a time and shows you what it says.</p>

    <section aria-labelledby="connect-near" className="connect-group">
      <h3 id="connect-near">NEAR</h3>
      <button type="button" className="connect-option" onClick={onNear}><Wallet size={24} aria-hidden="true" /><span>NEAR wallet</span></button>
    </section>

    <section aria-labelledby="connect-evm" className="connect-group">
      <h3 id="connect-evm">Ethereum-compatible wallets</h3>
      {wallets.evm.length === 0 ? <p className="connect-empty">No browser wallet found.</p>
        : wallets.evm.map(w => <WalletRow key={w.id} name={pending === `evm:${w.id}` ? `${w.name}, waiting` : w.name} icon={w.icon} busy={pending !== null} onClick={() => choose("evm", w.id)} />)}
    </section>

    <section aria-labelledby="connect-solana" className="connect-group">
      <h3 id="connect-solana">Solana wallets</h3>
      {wallets.solana.length === 0 ? <p className="connect-empty">No browser wallet found.</p>
        : wallets.solana.map(w => <WalletRow key={w.id} name={pending === `solana:${w.id}` ? `${w.name}, waiting` : w.name} icon={w.icon} busy={pending !== null} onClick={() => choose("solana", w.id)} />)}
    </section>

    {none && phone && page !== null && <section aria-labelledby="connect-phone" className="connect-group">
      <h3 id="connect-phone">On your phone</h3>
      <p className="connect-empty">Open this page inside your wallet app, where the wallet is built in.</p>
      <div className="connect-links">
        {DEEP_LINKS.map(link => <a key={link.id} className="btn btn-secondary btn-sm" href={link.href(page, device)}>Open in {link.name}</a>)}
      </div>
      <p className="connect-empty">Using Rabby: open Rabby, go to its Dapps tab and paste this page&apos;s link.{" "}
        <button type="button" className="connect-copy" onClick={copy}>{copied ? "Link copied" : "Copy link"}</button></p>
    </section>}
    {none && !phone && <p className="connect-empty">To use an Ethereum or Solana wallet here, install its browser extension, or open this page in your phone&apos;s wallet app.</p>}

    {error && <Notice tone="danger">{error}</Notice>}
    <div className="wallet-dialog-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
  </ModalDialog>;
}
