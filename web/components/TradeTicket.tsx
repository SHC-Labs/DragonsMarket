"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "./ui";
import { useWallet } from "./WalletProvider";
import { config } from "@/lib/config";
import { formatMoney, formatShares, maxSharesWithSlippage, minSharesWithSlippage, toMicro } from "@/lib/format";
import { useNow, usePoll, useTx } from "@/lib/hooks";
import {
  buyCall, getShares, isRegistered, quoteBuy, quoteSell, sellCall, storageDepositCall, tokenBalance,
  type MarketView, type Side,
} from "@/lib/market";

type Quote = { shares: bigint; money: bigint; sharesIn: bigint };

const avgCents = (money: bigint, shares: bigint) => (shares === 0n ? "-" : `${((money * 100n + shares / 2n) / shares).toString()}¢`);

function Line({ label, value, muted }: { label: string; value: string; muted: boolean }) {
  return (
    <div className={`flex items-baseline gap-2 py-[0.1875rem] ${muted ? "opacity-60" : ""}`}>
      <span className="text-muted">{label}</span>
      <span className="mb-1 flex-1 border-b border-dotted border-input" aria-hidden="true" />
      <span className="num">{value}</span>
    </div>
  );
}

export function TradeTicket({ market, initialSide = "yes" }: { market: MarketView; initialSide?: Side }) {
  const { account, walletAvailable, openConnect, send } = useWallet();
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");
  const [quoted, setQuoted] = useState<{ key: string; quote: Quote | null } | null>(null);
  const now = useNow(1000);
  const tx = useTx(send, account);
  const idx = side === "yes" ? 0 : 1;

  const me = usePoll(
    async () => {
      if (!account) return null;
      const [token, registered, held] = await Promise.all([tokenBalance(account), isRegistered(account), getShares(market.id, account)]);
      return { token: BigInt(token), registered, held: [BigInt(held[0]), BigInt(held[1])] as [bigint, bigint] };
    },
    [account, market.id],
    5000,
  );

  const value = toMicro(input);

  // The quote belongs to the exact amount, side and tab it was asked for. Anything else counts as "still getting the price".
  const quoteKey = `${tab}:${side}:${market.id}:${value ?? ""}`;
  useEffect(() => {
    if (!value || value === 0n) return;
    const t = setTimeout(async () => {
      let result: Quote | null = null;
      try {
        if (tab === "buy") {
          const shares = BigInt(await quoteBuy(market.id, side, value));
          result = shares > 0n ? { shares, money: value, sharesIn: 0n } : null;
        } else {
          const q = await quoteSell(market.id, side, value);
          const money = BigInt(q.collateral_out);
          result = money > 0n ? { shares: value, money, sharesIn: BigInt(q.shares_in) } : null;
        }
      } catch {
        result = null;
      }
      setQuoted({ key: quoteKey, quote: result });
    }, 300);
    return () => clearTimeout(t);
  }, [value, side, tab, market.id, quoteKey]);
  const quote = quoted?.key === quoteKey ? quoted.quote : null;
  const quoting = Boolean(value && value > 0n) && quoted?.key !== quoteKey;

  const open = market.status === "open";
  const held = me.data?.held[idx] ?? 0n;
  const have = me.data?.token ?? 0n;
  const waiting = tx.state.phase === "waiting";

  let reason: string | null = null;
  if (!open) reason = market.status === "halted" ? "Trading is paused. Your balance is safe." : "Trading has stopped on this market.";
  else if (!value || value === 0n) reason = tab === "buy" ? "Enter an amount." : "Enter how many shares to sell.";
  else if (tab === "buy" && value > have) reason = `You have ${formatMoney(have)} ${config.tokenSymbol}. This costs ${formatMoney(value)}.`;
  else if (tab === "sell" && value > held) reason = `You hold ${formatShares(held)} ${side === "yes" ? "Yes" : "No"} shares.`;
  else if (!quote) reason = quoting ? "Getting the price." : "This trade is not possible right now.";
  else if (me.data && !me.data.registered) reason = "Do the one-time storage step first.";

  const confirm = async () => {
    if (!account || !value || !quote) return;
    const before = held;
    if (tab === "buy") {
      const ok = await tx.run(buyCall(market.id, side, value, minSharesWithSlippage(quote.shares)), {
        done: async () => BigInt((await getShares(market.id, account))[idx]) > before,
        doneMessage: `Done. You hold more ${side === "yes" ? "Yes" : "No"} shares.`,
      });
      if (ok) setInput("");
    } else {
      const maxIn = (() => {
        const padded = maxSharesWithSlippage(quote.sharesIn);
        return padded < held ? padded : held;
      })();
      const ok = await tx.run(sellCall(market.id, side, quote.money, maxIn), {
        done: async () => BigInt((await getShares(market.id, account))[idx]) < before,
        doneMessage: `Done. ${formatMoney(quote.money)} ${config.tokenSymbol} is in your balance here. Withdraw it from the portfolio.`,
      });
      if (ok) setInput("");
    }
    me.reload();
  };

  const register = () =>
    tx.run(storageDepositCall(), {
      done: async () => (account ? isRegistered(account) : false),
      doneMessage: "Done. You can trade now.",
    }).then(() => me.reload());



  const unit = tab === "buy" ? config.tokenSymbol : "shares";

  return (
    <aside aria-label="Trade ticket" className="rounded-md border border-border border-t-2 border-t-input border-dashed bg-raised p-4" style={{ borderTopStyle: "dashed" }}>
      <div role="tablist" aria-label="Buy or sell" className="mb-4 flex gap-4">
        {(["buy", "sell"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => { setTab(t); setInput(""); tx.reset(); }}
            className={`num text-sm uppercase tracking-[0.12em] ${tab === t ? "text-fg underline underline-offset-8" : "text-muted"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <fieldset className="m-0 mb-4 grid grid-cols-2 gap-2 border-0 p-0">
        <legend className="mb-2 text-sm text-muted">Outcome</legend>
        {(["yes", "no"] as const).map((s) => {
          const on = side === s;
          const tone = s === "yes" ? "border-yes bg-yes-soft" : "border-no bg-no-soft";
          return (
            <label key={s} className={`flex cursor-pointer items-center justify-between rounded-md border px-3 py-3 ${on ? `border-2 ${tone}` : "border-input"} has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus`}>
              <input type="radio" name="outcome" value={s} checked={on} onChange={() => setSide(s)} className="sr-only" />
              <span>{s === "yes" ? "Yes" : "No"}</span>
              <span className={`num font-medium ${s === "yes" ? "text-yes" : "text-no"}`}>
                {Math.round(Number(BigInt(s === "yes" ? market.price_yes : market.price_no)) / 10_000)}¢
              </span>
            </label>
          );
        })}
      </fieldset>

      <div>
        <label htmlFor="amount" className="mb-1 block text-sm text-muted">{tab === "buy" ? "Amount" : "Shares to sell"}</label>
        <div className="flex h-11 items-center gap-2 rounded-md border border-input bg-canvas px-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
          <input
            id="amount" inputMode="decimal" autoComplete="off" value={input} placeholder="0.00"
            onChange={(e) => { setInput(e.target.value); tx.reset(); }}
            aria-describedby="balance-note"
            className="num min-w-0 flex-1 bg-transparent text-xl text-fg outline-none placeholder:text-muted"
          />
          <span className="text-sm text-muted">{unit}</span>
        </div>
        <div id="balance-note" className="num mt-1 text-sm text-muted">
          {account ? (tab === "buy" ? `Balance ${formatMoney(have)} ${config.tokenSymbol}` : `You hold ${formatShares(held)} ${side === "yes" ? "Yes" : "No"}`) : "Connect a wallet to trade."}
        </div>
      </div>

      <div className="my-4 text-sm" aria-live="polite">
        {tab === "buy" ? (
          <>
            <Line label="You pay" value={value ? `${formatMoney(value)} ${config.tokenSymbol}` : "-"} muted={quoting} />
            <Line label="You get about" value={quote ? `${formatShares(quote.shares)} ${side === "yes" ? "Yes" : "No"}` : "-"} muted={quoting} />
            <Line label="Least you will get" value={quote ? `${formatShares(minSharesWithSlippage(quote.shares))} ${side === "yes" ? "Yes" : "No"}` : "-"} muted={quoting} />
            <Line label="Average price" value={quote && value ? avgCents(value, quote.shares) : "-"} muted={quoting} />
          </>
        ) : (
          <>
            <Line label="You sell" value={value ? `${formatShares(value)} ${side === "yes" ? "Yes" : "No"}` : "-"} muted={quoting} />
            <Line label="You get about" value={quote ? `${formatMoney(quote.money)} ${config.tokenSymbol}` : "-"} muted={quoting} />
            <Line label="Average price" value={quote ? avgCents(quote.money, quote.sharesIn) : "-"} muted={quoting} />
          </>
        )}
        <Line label="Fee" value={`0.00 ${config.tokenSymbol}`} muted={quoting} />
      </div>

      {!account ? (
        <Button size="lg" onClick={openConnect} disabled={!walletAvailable}>Connect wallet</Button>
      ) : me.data && !me.data.registered ? (
        <>
          <p className="mb-2 text-sm">One-time storage deposit of 0.05 NEAR so this contract can remember your balance.</p>
          <Button size="lg" onClick={register} disabled={waiting}>{waiting ? "Waiting for confirmation" : "Do the storage step"}</Button>
        </>
      ) : (
        <>
          <Button size="lg" onClick={confirm} disabled={reason !== null || waiting}>
            {waiting ? "Waiting for confirmation" : tab === "buy" ? `Buy ${quote ? formatShares(quote.shares) : ""} ${side === "yes" ? "Yes" : "No"}`.replace("  ", " ") : `Sell ${side === "yes" ? "Yes" : "No"}`}
          </Button>
          {reason && !waiting && <p className="mt-2 text-sm">{reason}</p>}
        </>
      )}



      <div role="status" className="mt-3 text-sm">
        {tx.state.phase === "waiting" && (
          <p className="m-0"><span className="num">{Math.floor((now - tx.state.since) / 1000)}s</span>. You can leave this page. Your balance is not touched until this finishes.</p>
        )}
        {tx.state.phase === "done" && (
          <p className="m-0">{tx.state.message} <Link href="/portfolio">Portfolio</Link></p>
        )}
        {tx.state.phase === "failed" && <p className="m-0 text-no">{tx.state.message}</p>}
      </div>

      <p className="mb-0 mt-3 text-sm text-muted">If this resolves your way, each share pays 1.00 {config.tokenSymbol}.</p>
    </aside>
  );
}
