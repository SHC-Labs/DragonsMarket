"use client";

import Link from "next/link";
import { CouncilSeal } from "@/components/Threshold";
import { Button, Notice } from "@/components/ui";
import { Sigil } from "@/components/Sigil";
import { useWallet } from "@/components/WalletProvider";
import { config } from "@/lib/config";
import { formatMoney, formatShares } from "@/lib/format";
import { usePoll, useTx } from "@/lib/hooks";
import {
  getBalance, getShares, listMarkets, redeemCall, tokenBalance, withdrawCall,
  type MarketView,
} from "@/lib/market";

interface Position { market: MarketView; yes: bigint; no: bigint }

// What redeeming pays once a market is resolved. Void pays half a unit per share, rounded down.
function payout(p: Position): bigint {
  if (p.market.outcome === "yes") return p.yes;
  if (p.market.outcome === "no") return p.no;
  if (p.market.outcome === "void") return (p.yes + p.no) / 2n;
  return 0n;
}

function Title() {
  return (
    <div className="portfolio-masthead">
      <div><p className="ritual-label">Your account</p><h1>Portfolio</h1><p>See your shares, collect winnings, and withdraw your balance.</p></div><Link href="/" className="ritual-link">Browse markets ↗</Link>
    </div>
  );
}

export default function Portfolio() {
  const { account, openConnect, walletAvailable, send } = useWallet();
  const tx = useTx(send, account);
  const { data, error, loading, reload } = usePoll(
    async () => {
      if (!account) return null;
      const [markets, inMarket, inWallet] = await Promise.all([listMarkets(), getBalance(account), tokenBalance(account)]);
      const positions: Position[] = [];
      await Promise.all(
        markets.map(async (market) => {
          const [y, n] = await getShares(market.id, account);
          if (BigInt(y) + BigInt(n) > 0n) positions.push({ market, yes: BigInt(y), no: BigInt(n) });
        }),
      );
      positions.sort((a, b) => Number(BigInt(a.market.id) - BigInt(b.market.id)));
      return { positions, inMarket: BigInt(inMarket), inWallet: BigInt(inWallet) };
    },
    [account],
    6000,
  );
  const waiting = tx.state.phase === "waiting";

  if (!account) {
    return (
      <>
        <Title />
        <section className="portfolio-locked"><div className="vault-symbol"><CouncilSeal /></div><div><p className="ritual-label">Wallet required</p><h2>Connect to see <br />your portfolio.</h2><p>Connect a wallet to see your positions. You can redeem winnings and withdraw your balance from here.</p><Button onClick={openConnect} disabled={!walletAvailable}>Connect wallet</Button></div></section>
      </>
    );
  }

  return (
    <>
      <Title />
      {loading && !data ? (
        <p className="mt-8 text-muted">Loading your positions</p>
      ) : error && !data ? (
        <div className="mt-8">
          <Notice tone="danger">
            <span>Could not load your portfolio. Check your connection. </span>
            <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
          </Notice>
        </div>
      ) : data ? (
        <>
          <div className="portfolio-summary"><span className="ritual-label">Your shares</span><span className="num">{data.positions.length} positions</span><span className="num">{data.positions.filter(p => p.market.status === "resolved").length} resolved</span></div>
          <dl className="portfolio-balances m-0 mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0 rounded-xl border border-border bg-surface/60 p-6 [overflow-wrap:anywhere]">
              <dt className="text-xs uppercase tracking-[0.1em] text-muted">In your wallet</dt>
              <dd className="m-0 mt-2">
                <span className="display block text-[3rem] leading-[3rem]">
                  <span className="num text-[2.5rem]">{formatMoney(data.inWallet)}</span> <span className="text-xl text-muted">{config.tokenSymbol}</span>
                </span>

              </dd>
            </div>
            <div className="min-w-0 rounded-xl border border-border bg-surface/60 p-6 [overflow-wrap:anywhere]">
              <dt className="text-xs uppercase tracking-[0.1em] text-muted">Available to withdraw</dt>
              <dd className="m-0 mt-2">
                <span className="display block text-[3rem] leading-[3rem]">
                  <span className="num text-[2.5rem]">{formatMoney(data.inMarket)}</span> <span className="text-xl text-muted">{config.tokenSymbol}</span>
                </span>
                <Button variant="secondary" size="sm" className="mt-2" disabled={waiting || data.inMarket === 0n} onClick={() =>
                  tx.run(withdrawCall(data.inMarket), { done: async () => BigInt(await getBalance(account)) === 0n, doneMessage: "Done. The money is in your wallet." }).then(reload)}>
                  {waiting ? "Waiting for confirmation" : "Withdraw all"}
                </Button>
              </dd>
            </div>
          </dl>
          <div role="status" className="mt-3 text-sm">
            {tx.state.phase === "done" && <p className="m-0">{tx.state.message}</p>}
            {tx.state.phase === "failed" && <p className="m-0 text-no">{tx.state.message}</p>}
          </div>

          <h2 className="display mb-4 mt-14 text-[2.5rem] leading-[2.5rem]">Positions</h2>
          {data.positions.length === 0 ? (
            <p className="text-muted">No positions yet. <Link href="/">Browse markets</Link></p>
          ) : (
            <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0">
              {data.positions.map((p, i) => {
                const pay = payout(p);
                const resolved = p.market.status === "resolved";
                return (
                  <li key={p.market.id} className="rise flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface/60 p-4" style={{ "--i": i } as React.CSSProperties}>
                    <Sigil hash={p.market.rule_hash} className="h-14 w-14 shrink-0 rounded-md border border-border bg-canvas" />
                    <div className="min-w-0 flex-1 basis-60">
                      <Link href={`/market?id=${p.market.id}`} className="font-medium no-underline hover:underline">{p.market.title}</Link>
                      <div className="num mt-1 flex flex-wrap gap-x-4 text-sm">
                        {p.yes > 0n && <span className="text-yes">{formatShares(p.yes)} Yes</span>}
                        {p.no > 0n && <span className="text-no">{formatShares(p.no)} No</span>}
                      </div>
                      <div className="mt-1 text-sm text-muted">
                        {!resolved
                          ? p.market.status === "closed" ? "Waiting for the answer" : "Open"
                          : p.market.outcome === "void" ? `Void: you get back ${formatMoney(pay)} ${config.tokenSymbol}`
                          : pay > 0n ? `You won ${formatMoney(pay)} ${config.tokenSymbol}`
                          : `Resolved ${p.market.outcome === "yes" ? "Yes" : "No"}. Nothing to redeem.`}
                      </div>
                    </div>
                    <div>
                      {resolved ? (
                        <Button size="sm" disabled={waiting} onClick={() =>
                          tx.run(redeemCall(p.market.id), { done: async () => { const [y, n] = await getShares(p.market.id, account); return BigInt(y) + BigInt(n) === 0n; }, doneMessage: "Done. Added to your balance here. Withdraw it above." }).then(reload)}>
                          {pay > 0n ? `Redeem ${formatMoney(pay)} ${config.tokenSymbol}` : "Clear"}
                        </Button>
                      ) : p.market.status === "open" ? (
                        <Link href={`/market?id=${p.market.id}`} className="text-sm">Sell</Link>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </>
  );
}
