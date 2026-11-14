"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { AnswerForm } from "@/components/AnswerPanel";
import { ConnectDialog } from "@/components/ConnectDialog";
import { DepositDialog } from "@/components/DepositDialog";
import { UserFacingError } from "@/lib/errors";
import type { Outcome } from "@/lib/market";
import type { EvmWallet, SolanaWallet } from "@/lib/wallets";
import { evmAccount } from "@/lib/wallet-account";

// Samples for the wallet dialogs and the answer form. Nothing here reaches a wallet, the relay or 1Click.
const SAMPLE = "This is a sample on the brand page. Nothing was sent.";
const refuse = () => Promise.reject(new UserFacingError(SAMPLE));
const inert = { request: refuse };
const EVM: EvmWallet[] = [
  { id: "rdns:sample.metamask", remember: "rdns:sample.metamask", name: "MetaMask", icon: null, provider: inert },
  { id: "rdns:sample.rabby", remember: "rdns:sample.rabby", name: "Rabby", icon: null, provider: inert },
];
const SOLANA: SolanaWallet[] = [{ id: "solana:0", remember: "name:Phantom", name: "Phantom", icon: null, wallet: { name: "Phantom", icon: "", chains: [], accounts: [], features: {} } }];
const IDENTITY = evmAccount("0x5a3c0000000000000000000000000000000000d1");

export function WalletDialogSamples() {
  const [open, setOpen] = useState<"connect" | "deposit" | null>(null);
  return <div className="brand-row">
    <Button variant="secondary" onClick={() => setOpen("connect")}>Open the connect dialog</Button>
    <Button variant="secondary" onClick={() => setOpen("deposit")}>Open the deposit dialog</Button>
    {open === "connect" && <ConnectDialog wallets={{ evm: EVM, solana: SOLANA }} onClose={() => setOpen(null)} onNear={() => setOpen(null)} onBrowserWallet={refuse} />}
    {open === "deposit" && <DepositDialog identity={IDENTITY} onClose={() => setOpen(null)} requestQuote={refuse} />}
  </div>;
}

export function AnswerFormSample() {
  const [answer, setAnswer] = useState<Outcome>("yes");
  const [evidence, setEvidence] = useState("https://www.example.org/result");
  return <div className="brand-stack">
    <AnswerForm challenging={false} bond={10_000_000n} fee={20_000n} options={["yes", "no", "void"]} answer={answer} evidence={evidence}
      state={{ phase: "idle" }} own={false} balance={25_000_000n} canDeposit={false} onAnswer={setAnswer} onEvidence={setEvidence} onDeposit={() => {}} onSubmit={() => {}} />
    <AnswerForm challenging bond={10_000_000n} fee={20_000n} options={["no", "void"]} answer="no" evidence=""
      state={{ phase: "failed", message: "Your Intents account is short of the bond. Nothing was spent." }} own={false} balance={4_500_000n} canDeposit={false}
      onAnswer={() => {}} onEvidence={() => {}} onDeposit={() => {}} onSubmit={() => {}} />
  </div>;
}
