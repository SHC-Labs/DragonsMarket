"use client";

import Link from "next/link";
import { AccountEmptyState, PageLandmark } from "@/components/PageHeader";
import { Button, Notice } from "@/components/ui";
import { CountUp } from "@/components/CountUp";
import { CashOut } from "@/components/CashOut";
import { CrossChainCashOut } from "@/components/CrossChainCashOut";
import { TransactionNotice } from "@/components/TransactionNotice";
import { RelayNotice } from "@/components/RelayNotice";
import { MarketIcon } from "@/components/MarketIcon";
import { Embers } from "@/components/Embers";
import { Award, Wallet } from "@/components/icons";
import { useWallet } from "@/components/WalletProvider";
import { backendEnabled, pendingFor, pendingLabel } from "@/lib/backend";
import { config } from "@/lib/config";
import { formatExact, formatMoney, formatShares } from "@/lib/format";
import { usePoll, useRelayFee, useRelayTx, useTx } from "@/lib/hooks";
import { relayMarketExit } from "@/lib/relay-market";
import { signsWithRelay } from "@/lib/wallet-account";
import {
  getBalance, getPositions, getShares, listMarkets, redeemCall, tokenBalance, withdrawCall,
  type FunctionCall, type MarketView,
} from "@/lib/market";

// redeemable is the contract's own figure for what redeem would pay now: a winner's share of the pool, or on a Void what the
// position put in. It is 0 while the market is unresolved.
interface Position { market: MarketView; yes: bigint; no: bigint; redeemable: bigint }

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Title() {
  return <PageLandmark title="Portfolio" />;
}

function Balance({ label, value, children, tone }: { label: string; value: bigint; children?: React.ReactNode; tone: "wallet" | "market" }) {
  return <div className="balance-tile" data-tone={tone}>
    <Embers height={0.85} intensity={0.7} speed={0.16} spark={tone === "market" ? "--council" : "--yes"} smoke={tone === "market" ? "--council" : "--accent"} />
    <dt><Wallet size={18} variant="Bulk" />{label}</dt>
    <dd>
      <span className="balance-figure" aria-hidden="true"><CountUp value={Number(value) / 1e6} format={money} className="num" duration={1100} /> <span className="balance-unit">{config.tokenSymbol}</span></span>
      <span className="sr-only">{formatMoney(value)} {config.tokenSymbol}</span>
      {children}
    </dd>
  </div>;
}

export default function Portfolio() {
  const { account } = useWallet();
  return <AccountPortfolio key={account ?? "disconnected"} />;
}

function AccountPortfolio() {
  const { account, identity, openConnect, walletAvailable, send, signRelayed } = useWallet();
  const tx = useTx(send, account);
  const relay = signsWithRelay(identity);
  const relayTx = useRelayTx(account);
  const { fee } = useRelayFee(relay);
  const busy = relay ? relayTx.busy : tx.busy;
  const { data, error, loading, reload } = usePoll(
    async () => {
      if (!account) return null;
      const [markets, inMarket, inWallet] = await Promise.all([listMarkets(), getBalance(account), tokenBalance(account)]);
      const positions: Position[] = [];
      await Promise.all(
        markets.map(async (market) => {
          const [y, n] = await getShares(market.id, account);
          if (BigInt(y) + BigInt(n) === 0n) return;
          const [held] = market.outcome ? await getPositions(account, market.id, 1) : [];
          positions.push({ market, yes: BigInt(y), no: BigInt(n), redeemable: BigInt(held?.redeemable ?? "0") });
        }),
      );
      positions.sort((a, b) => Number(BigInt(a.market.id) - BigInt(b.market.id)));
      return { positions, inMarket: BigInt(inMarket), inWallet: BigInt(inWallet) };
    },
    [account],
    6000,
  );

  const act = async (call: FunctionCall, done: () => Promise<boolean>, doneMessage: string) => {
    if (relay) {
      if (fee === null || !data || data.inWallet < fee) return;
      await relayTx.run({ submit: () => signRelayed([relayMarketExit(call)], fee), done, doneMessage });
    } else await tx.run(call, { done, doneMessage });
    await reload();
  };

  // Money a contract has started to send you and has not yet confirmed. It comes from the backend, which is optional, so a
  // failed or disabled lookup shows nothing rather than an error.
  const pending = usePoll(async () => (account && backendEnabled() ? pendingFor(account) : []), [account], 15000);

  if (!account) {
    return (
      <div className="page-content">
        <Title />
        <AccountEmptyState title="View your portfolio" description="Connect your wallet to see your positions and balances, redeem resolved positions and withdraw." actions={<Button onClick={openConnect} disabled={!walletAvailable}>Connect wallet</Button>} />
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
            <Balance label="In your Intents account" value={data.inWallet} tone="wallet" />
            <Balance label="Market balance" value={data.inMarket} tone="market">
              <Button variant="secondary" size="sm" disabled={busy || data.inMarket === 0n || (relay && (fee === null || data.inWallet < fee))} aria-describedby="portfolio-integration" onClick={() => act(withdrawCall(data.inMarket), async () => BigInt(await getBalance(account)) < data.inMarket, "Withdrawn to your Intents account.")}>Withdraw</Button>
            </Balance>
          </dl>
          <p id="portfolio-integration" className="portfolio-note">Redeem a resolved position to move its payout into your market balance, then withdraw the balance to your Intents account.</p>
          {!relay && <CashOut key={account} account={account} balance={data.inWallet} reload={reload} />}
          {relay && config.network === "mainnet" && <CrossChainCashOut key={account}
            identity={identity} balance={data.inWallet} reload={reload} />}
          {relay ? <>
            <p>{fee === null ? "Getting the network fee." : `Each market action requires ${formatExact(fee)} ${config.tokenSymbol} in your Intents balance for gas.`}</p>
            <RelayNotice state={relayTx.state} recheck={async () => { await relayTx.recheck(); await reload(); }} />
          </> : <TransactionNotice tx={tx} />}
          {pending.data && pending.data.length > 0 && (
            <Notice>
              <ul aria-label="Payments waiting for confirmation">
                {pending.data.map(item => (
                  <li key={`${item.receiptId}:${item.event}`}>
                    {pendingLabel(item.kind)}{item.amount === null ? "" : ` of ${formatMoney(item.amount)} ${config.tokenSymbol}`} is waiting for the contract to confirm it.
                  </li>
                ))}
              </ul>
            </Notice>
          )}

          <h2 className="section-title portfolio-positions-title">Positions</h2>
          {data.positions.length === 0 ? (
            <p className="portfolio-empty">No positions yet. <Link href="/" className="text-link">Browse markets</Link></p>
          ) : (
            <ul className="position-list">
              {data.positions.map((p, i) => {
                const pay = p.redeemable;
                const resolved = p.market.status === "resolved";
                const won = resolved && p.market.outcome !== "void" && pay > 0n;
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
                          : p.market.outcome === "void" ? `Void: estimated payout ${formatMoney(pay)} ${config.tokenSymbol}`
                          : pay > 0n ? `Estimated payout: ${formatMoney(pay)} ${config.tokenSymbol}`
                          : `Resolved ${p.market.outcome === "yes" ? "Yes" : "No"}. Nothing to redeem.`}
                      </span>
                    </div>
                    <div className="position-action">
                      {resolved ? (
                        <Button size="sm" disabled={busy || (relay && (fee === null || data.inWallet < fee))} onClick={() => act(redeemCall(p.market.id), async () => { const [y, n] = await getShares(p.market.id, account); return BigInt(y) + BigInt(n) === 0n; }, "Redeemed. Withdraw the balance to your Intents account.")}>Redeem</Button>
                      ) : ["open", "halted"].includes(p.market.status) ? (
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
