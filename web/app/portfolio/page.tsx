"use client";

import Link from "next/link";
import { AccountEmptyState, PageLandmark } from "@/components/PageHeader";
import { Button, Notice } from "@/components/ui";
import { MarketIcon } from "@/components/MarketIcon";
import { useWallet } from "@/components/WalletProvider";
import { config } from "@/lib/config";
import { voidPayout } from "@/lib/settlement";
import { formatMoney, formatShares } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import {
  getBalance, getShares, listMarkets, tokenBalance,
  type MarketView,
} from "@/lib/market";

interface Position { market: MarketView; yes: bigint; no: bigint }

// Read-only estimate from published settlement values; no fixed Void refund.
function payout(p: Position): bigint | null {
  if (p.market.outcome === "yes") return p.yes;
  if (p.market.outcome === "no") return p.no;
  if (p.market.outcome === "void") return voidPayout(p.yes, p.no, p.market.void_price_yes);
  return 0n;
}

function Title() {
  return <PageLandmark title="Portfolio" />;
}

export default function Portfolio() {
  const { account, openConnect, walletAvailable } = useWallet();
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

  if (!account) {
    return (
      <div className="page-content">
        <Title />
        <AccountEmptyState title="View your portfolio" description="Connect your wallet to see your positions and balances. Withdrawals and redemptions will be available here when they open." actions={<Button onClick={openConnect} disabled={!walletAvailable}>Connect wallet</Button>} />
      </div>
    );
  }

  return (
    <div className="page-content">
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
          <div className="portfolio-summary"><span className="num">{data.positions.length} positions</span><span className="num">{data.positions.filter(p => p.market.status === "resolved").length} resolved</span></div>
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
                <Button variant="secondary" size="sm" className="mt-2" disabled aria-describedby="portfolio-integration">Withdrawals coming soon</Button>
              </dd>
            </div>
          </dl>
          <p id="portfolio-integration" className="mt-3 text-sm text-muted">Withdrawals and redemptions aren’t available yet. You can still view your positions here.</p>

          <h2 className="section-title mb-4 mt-12">Positions</h2>
          {data.positions.length === 0 ? (
            <p className="text-muted">No positions yet. <Link href="/">Browse markets</Link></p>
          ) : (
            <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0">
              {data.positions.map((p, i) => {
                const pay = payout(p);
                const resolved = p.market.status === "resolved";
                return (
                  <li key={p.market.id} className="rise flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface/60 p-4" style={{ "--i": i } as React.CSSProperties}>
                    <MarketIcon category={p.market.category} sub={p.market.subcategory} small />
                    <div className="min-w-0 flex-1 basis-60">
                      <Link href={`/market?id=${p.market.id}`} className="font-medium no-underline hover:underline">{p.market.title}</Link>
                      <div className="num mt-1 flex flex-wrap gap-x-4 text-sm">
                        {p.yes > 0n && <span className="text-yes">{formatShares(p.yes)} Yes</span>}
                        {p.no > 0n && <span className="text-no">{formatShares(p.no)} No</span>}
                      </div>
                      <div className="mt-1 text-sm text-muted">
                        {!resolved
                          ? p.market.status === "closed" ? "Waiting for the answer" : "Open"
                          : p.market.outcome === "void" ? pay === null ? "Void: settlement price has not been published." : `Void: estimated payout ${formatMoney(pay)} ${config.tokenSymbol}`
                          : pay !== null && pay > 0n ? `You won ${formatMoney(pay)} ${config.tokenSymbol}`
                          : `Resolved ${p.market.outcome === "yes" ? "Yes" : "No"}. Nothing to redeem.`}
                      </div>
                    </div>
                    <div>
                      {resolved ? (
                        <Button size="sm" disabled aria-describedby="portfolio-integration">Redemption coming soon</Button>
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
    </div>
  );
}
