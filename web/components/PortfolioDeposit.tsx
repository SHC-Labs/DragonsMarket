"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Notice } from "./ui";
import { TransactionNotice } from "./TransactionNotice";
import { useWallet } from "./WalletProvider";
import { config } from "@/lib/config";
import { formatMoney, toMicro } from "@/lib/format";
import { fundCall, tokenBalance } from "@/lib/market";
import { useTx } from "@/lib/hooks";

export function PortfolioDeposit({ account, walletBalance, reload }: {
  account: string; walletBalance: bigint; reload: () => Promise<void>;
}) {
  const { send } = useWallet();
  const tx = useTx(send, account);
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = toMicro(input);
  const valid = amount !== null && amount > 0n && amount <= walletBalance;
  const deposit = async () => {
    if (!valid || amount === null || tx.busy || checking) return;
    setError(null);
    setChecking(true);
    let before: bigint;
    try { before = BigInt(await tokenBalance(account)); }
    catch { setError("Could not check your trading balance. Try again."); setChecking(false); return; }
    if (await tx.run(fundCall(account, amount), {
      done: async () => BigInt(await tokenBalance(account)) >= before + amount,
      doneMessage: "Deposit complete. Your funds are ready to trade.",
    })) setInput("");
    setChecking(false);
    await reload();
  };
  return <section id="deposit" aria-label="Deposit funds" className="portfolio-deposit">
    <h2 className="section-title">Deposit funds</h2>
    <p>Move {config.tokenSymbol} from your NEAR wallet into your trading balance. Depositing does not buy shares.</p>
    <p>In your wallet: <strong>{formatMoney(walletBalance)} {config.tokenSymbol}</strong></p>
    <form onSubmit={event => { event.preventDefault(); void deposit(); }}>
      <label htmlFor="portfolio-deposit-amount">Deposit amount ({config.tokenSymbol})</label>
      <div className="trade-amount-field">
        <input id="portfolio-deposit-amount" inputMode="decimal" autoComplete="off" maxLength={40}
          value={input} placeholder="0.00" disabled={tx.busy || checking}
          onChange={event => { setInput(event.target.value); tx.reset(); }} />
      </div>
      <Button type="submit" disabled={!valid || tx.busy || checking}>{tx.busy || checking ? "Confirming deposit" : `Deposit ${config.tokenSymbol}`}</Button>
    </form>
    {error && <Notice tone="danger">{error}</Notice>}
    <TransactionNotice tx={tx} />
    <Link href="/" className="text-link">Browse markets to buy shares</Link>
  </section>;
}
