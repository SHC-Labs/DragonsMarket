"use client";

import Link from "next/link";
import { AccountEmptyState, PageLandmark } from "@/components/PageHeader";
import { Button, Notice } from "@/components/ui";
import { CountUp } from "@/components/CountUp";
import { MarketIcon } from "@/components/MarketIcon";
import { Embers } from "@/components/Embers";
import { Award, Lock, Wallet } from "@/components/icons";
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

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Title() {
  return <PageLandmark title="Portfolio" />;
}

function Balance({ label, value, children, tone }: { label: string; value: bigint; children?: React.ReactNode; tone: "wallet" | "market" }) {
  return <div className="balance-tile" data-tone={tone}>
    <Embers height={0.85} intensity={0.8} spark={tone === "market" ? "--council" : "--yes"} smoke={tone === "market" ? "--council" : "--accent"} />
    <dt><Wallet size={18} variant="Bulk" />{label}</dt>
    <dd>
      <span className="balance-figure" aria-hidden="true"><CountUp value={Number(value) / 1e6} format={money} className="num" duration={1100} /> <span className="balance-unit">{config.tokenSymbol}</span></span>
      <span className="sr-only">{formatMoney(value)} {config.tokenSymbol}</span>
      {children}
    </dd>
  </div>;
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

  const counts = data ? {
    open: data.positions.filter(p => p.market.status === "open").length,
    waiting: data.positions.filter(p => p.market.status === "closed" || p.market.status === "halted").length,
    resolved: data.positions.filter(p => p.market.status === "resolved").length,
  } : null;

  return (
    <div className="page-content portfolio-page">
      <Title />
      {loading && !data ? (
        <><p role="status" className="sr-only">Loading your positions</p><div className="portfolio-skeleton" aria-hidden="true"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div></>
      ) : error && !data ? (
        <div className="mt-8">
          <Notice tone="danger">
            <span>Could not load your portfolio. Check your connection. </span>
            <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
          </Notice>
        </div>
      ) : data && counts ? (
        <>
          <div className="portfolio-summary">
            <span className="num portfolio-count">{data.positions.length} positions</span>
            <span className="portfolio-breakdown">
              <span data-k="open"><i aria-hidden="true" />{counts.open} open</span>
              <span data-k="waiting"><i aria-hidden="true" />{counts.waiting} awaiting answer</span>
              <span data-k="resolved"><i aria-hidden="true" />{counts.resolved} resolved</span>
            </span>
          </div>
          <dl className="portfolio-balances">
            <Balance label="In your wallet" value={data.inWallet} tone="wallet" />
            <Balance label="Available to withdraw" value={data.inMarket} tone="market">
              <Button variant="secondary" size="sm" disabled aria-describedby="portfolio-integration"><Lock size={15} />Withdrawals coming soon</Button>
            </Balance>
          </dl>
          <p id="portfolio-integration" className="portfolio-note">Withdrawals and redemptions aren’t available yet. You can still view your positions here.</p>

          <h2 className="section-title portfolio-positions-title">Positions</h2>
          {data.positions.length === 0 ? (
            <p className="portfolio-empty">No positions yet. <Link href="/" className="text-link">Browse markets</Link></p>
          ) : (
            <ul className="position-list">
              {data.positions.map((p, i) => {
                const pay = payout(p);
                const resolved = p.market.status === "resolved";
                const won = resolved && p.market.outcome !== "void" && pay !== null && pay > 0n;
                return (
                  <li key={p.market.id} className="position-row enter" data-won={won || undefined} style={{ "--i": i } as React.CSSProperties}>
                    <MarketIcon category={p.market.category} sub={p.market.subcategory} small />
                    <div className="position-main">
                      <Link href={`/market?id=${p.market.id}`} className="position-title">{p.market.title}</Link>
                      <div className="position-shares num">
                        {p.yes > 0n && <span data-side="yes">{formatShares(p.yes)} Yes</span>}
                        {p.no > 0n && <span data-side="no">{formatShares(p.no)} No</span>}
                      </div>
                    </div>
                    <div className="position-status">
                      <span className="position-outcome" data-status={p.market.status}>
                        {won && <Award size={16} variant="Bold" />}
                        {!resolved
                          ? p.market.status === "closed" ? "Waiting for the answer" : "Open"
                          : p.market.outcome === "void" ? pay === null ? "Void: settlement price has not been published." : `Void: estimated payout ${formatMoney(pay)} ${config.tokenSymbol}`
                          : pay !== null && pay > 0n ? `You won ${formatMoney(pay)} ${config.tokenSymbol}`
                          : `Resolved ${p.market.outcome === "yes" ? "Yes" : "No"}. Nothing to redeem.`}
                      </span>
                    </div>
                    <div className="position-action">
                      {resolved ? (
                        <Button size="sm" disabled aria-describedby="portfolio-integration">Redemption coming soon</Button>
                      ) : p.market.status === "open" ? (
                        <Link href={`/market?id=${p.market.id}`} className="btn btn-secondary btn-sm">Sell</Link>
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
