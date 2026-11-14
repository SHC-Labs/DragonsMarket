"use client";

import { useState } from "react";
import { AccountEmptyState, PageLandmark } from "@/components/PageHeader";
import { Button, Notice } from "@/components/ui";
import { Lock } from "@/components/icons";
import { UnstakeCutDialog } from "@/components/UnstakeCutDialog";
import { RevenueClaim } from "@/components/RevenueClaim";
import { TransactionNotice } from "@/components/TransactionNotice";
import { useWallet } from "@/components/WalletProvider";
import { config } from "@/lib/config";
import { formatDateTime, formatDateTimeUtc, formatMoney, timeLeft } from "@/lib/format";
import { useNow, usePoll, useTx } from "@/lib/hooks";
import { signsWithRelay } from "@/lib/wallet-account";
import {
  claimableOf, getCouncilConfig, inProgressOf, isAllowed, nftToken, nftTokensFor, quarterInfo, requestUnstakeCall, seatCount, seatEarnings, seatsOf,
  stakeCall, stakeOf, unstakeCall, type SeatEarnings, type Stake,
} from "@/lib/council";
import type { FunctionCall } from "@/lib/market";

interface Seat { token: string; stake: Stake; earnings: SeatEarnings | null }

const SECOND_NS = 1_000_000_000n;
const UNITS: [number, string][] = [[86_400, "day"], [3_600, "hour"], [60, "minute"], [1, "second"]];

// "1 minute", "7 days": the cooldown as a person reads it.
function span(ns: bigint) {
  const secs = Number(ns / SECOND_NS);
  const [size, name] = UNITS.find(([unit]) => secs >= unit) ?? UNITS[3];
  const n = Math.round(secs / size);
  return `${n} ${name}${n === 1 ? "" : "s"}`;
}

// Where a seat is in its life, read straight from the council's record.
function seatState(stake: Stake, earnings: SeatEarnings | null, cooldownNs: bigint, now: number) {
  if (stake.serving !== null) return { label: "On a jury. Locked until the case ends.", action: null } as const;
  if (stake.unlock_requested_at === null) {
    const label = earnings?.state === "waiting" ? `Staked. Starts earning ${formatDateTime(earnings.earning_from)}`
      : earnings ? `Earning. ${formatMoney(BigInt(earnings.earned_closed) + BigInt(earnings.earned_in_progress))} ${config.tokenSymbol} so far`
      : `Staked since ${formatDateTime(stake.staked_at)}`;
    return { label, action: "request" } as const;
  }
  const ready = BigInt(stake.unlock_requested_at) + cooldownNs;
  const wait = timeLeft(ready, now);
  return wait === "ended"
    ? { label: "Cooldown over. Ready to unstake.", action: "unstake" } as const
    : { label: `Leaving. Cooldown ends in ${wait.replace(" left", "")}.`, action: "waiting" } as const;
}

async function load(account: string) {
  const cfg = await getCouncilConfig();
  const tokens = await seatsOf(account);
  const [stakes, total] = await Promise.all([Promise.all(tokens.map(stakeOf)), seatCount()]);
  const earnings = await Promise.all(tokens.map(token => seatEarnings(token).catch(() => null)));
  const seats: Seat[] = tokens.flatMap((token, i) => (stakes[i] ? [{ token, stake: stakes[i], earnings: earnings[i] }] : []));
  const owned = await nftTokensFor(account).then(list => list.map(t => t.token_id), () => null);
  const eligible: Record<string, boolean> = Object.create(null);
  await Promise.all((owned ?? []).map(async token => { eligible[token] = await isAllowed(token); }));
  const claimable = await claimableOf(account).then(v => BigInt(v), () => null);
  const inProgress = await inProgressOf(account).then(v => BigInt(v), () => null);
  const quarterEnd = await quarterInfo().then(q => BigInt(q.ends_at), () => null);
  return { cfg, seats, owned, eligible, total, claimable, inProgress, quarterEnd };
}

export function StakeView() {
  const { account } = useWallet();
  return <AccountStakeView key={account ?? "disconnected"} />;
}

function AccountStakeView() {
  const { account, identity, openConnect, walletAvailable, send } = useWallet();
  const now = useNow(1000);
  const tx = useTx(send, account);
  const { run, busy } = tx;
  const [typed, setTyped] = useState("");
  const [found, setFound] = useState<Record<string, boolean>>({});
  const [leaving, setLeaving] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const { data, error, loading, reload } = usePoll(async () => (account ? load(account) : null), [account], 6000);

  if (!config.councilId || !config.nftId) {
    return <div className="page-content"><PageLandmark title="Stake" /><Notice tone="warning">Staking is not set up for this network yet.</Notice></div>;
  }
  if (signsWithRelay(identity)) {
    return <div className="page-content"><PageLandmark title="Stake" /><Notice>Staking is available with a NEAR wallet for now.</Notice></div>;
  }
  if (!account) {
    return (
      <div className="page-content">
        <PageLandmark title="Stake" />
        <AccountEmptyState title="Stake your Dragons" description="Connect your wallet to stake a Dragon, see your seats and follow your cooldowns." actions={<Button onClick={openConnect} disabled={!walletAvailable}>Connect wallet</Button>} />
      </div>
    );
  }

  const act = async (call: FunctionCall, done: () => Promise<boolean>, doneMessage: string) => {
    await run(call, { done, doneMessage, timeoutMs: 45_000 });
    await reload();
  };
  const cap = data?.cfg.max_seats_per_account ?? 0;
  const seatsFull = data ? data.seats.length >= cap : true;
  const cooldown = data ? BigInt(data.cfg.cooldown_ns) : 0n;
  const listed = data?.owned ?? Object.keys(found);
  const tokens = data ? [...new Set([...listed])] : [];

  const lookup = async () => {
    const token = typed.trim();
    if (!token) return;
    setLookupError(null);
    try {
      const record = await nftToken(token);
      if (!record || record.owner_id !== account) { setLookupError("That Dragon is not in your wallet."); return; }
      const eligible = await isAllowed(token);
      setFound(list => ({ ...list, [token]: eligible }));
      setTyped("");
      await reload();
    } catch {
      setLookupError("Could not read that Dragon. Check the token id and try again.");
    }
  };
  const stake = (token: string) => act(stakeCall(token), async () => (await stakeOf(token))?.owner === account, `Dragon ${token} is staked.`);

  return (
    <div className="page-content portfolio-page">
      <PageLandmark title="Stake" />
      {loading && !data ? (
        <><p role="status" className="sr-only">Loading your seats</p><div className="portfolio-skeleton" aria-hidden="true"><div className="skeleton" /><div className="skeleton" /></div></>
      ) : error && !data ? (
        <div className="mt-8"><Notice tone="danger"><span>Could not load your seats. Check your connection. </span><Button variant="ghost" size="sm" onClick={reload}>Retry</Button></Notice></div>
      ) : data ? (
        <>
          <div className="portfolio-summary">
            <span className="num portfolio-count">{data.seats.length} of {cap} seats staked</span>
            <span className="portfolio-breakdown">
              <span><i aria-hidden="true" />{data.total} seats in the Council</span>
              <span><i aria-hidden="true" />Unstake cooldown {span(cooldown)}</span>
            </span>
          </div>
          <TransactionNotice tx={tx} />

          {data.claimable !== null && (
            <ul className="position-list">
              <RevenueClaim account={account} amount={data.claimable} tokens={data.seats.map(s => s.token).slice(0, 10)} disabled={busy} reload={reload} />
              {data.inProgress !== null && data.inProgress > 0n && (
                <li className="position-row">
                  <div className="position-main"><span className="position-title">Earned this quarter</span><div className="position-shares num"><span>{formatMoney(data.inProgress)} {config.tokenSymbol}</span></div></div>
                  <div className="position-status"><span className="position-outcome">{data.quarterEnd !== null ? `Claimable after ${formatDateTimeUtc(data.quarterEnd)}.` : "Claimable once the quarter ends."}</span></div>
                </li>
              )}
            </ul>
          )}

          <h2 className="section-title portfolio-positions-title">Your Dragons</h2>
          {tokens.length === 0 && data.owned !== null && <p className="portfolio-empty">No Dragons in this wallet. Staked Dragons are listed below.</p>}
          {data.owned === null && (
            <form className="position-row" onSubmit={e => { e.preventDefault(); void lookup(); }}>
              <div className="position-main">
                <label htmlFor="token" className="position-title">Add a Dragon by token id</label>
                <div className="trade-amount-field" data-invalid={lookupError ? true : undefined}><input id="token" className="num" inputMode="text" autoComplete="off" value={typed} placeholder="Token id" onChange={e => setTyped(e.target.value)} /></div>
                {lookupError && <p role="alert" className="ticket-error">{lookupError}</p>}
              </div>
              <div className="position-action"><Button type="submit" variant="secondary" size="sm" disabled={busy || !typed.trim()}>Find</Button></div>
            </form>
          )}
          {tokens.length > 0 && (
            <ul className="position-list">
              {tokens.map((token, i) => {
                const ok = (data.eligible[token] ?? found[token]) === true;
                return (
                  <li key={token} className="position-row enter" style={{ "--i": i } as React.CSSProperties}>
                    <div className="position-main"><span className="position-title">Dragon {token}</span></div>
                    <div className="position-status"><span className="position-outcome">{!ok ? "Not eligible for a seat" : seatsFull ? "Seat limit reached" : "Eligible for a seat"}</span></div>
                    <div className="position-action"><Button variant="secondary" size="sm" disabled={busy || !ok || seatsFull} onClick={() => stake(token)}>Stake</Button></div>
                  </li>
                );
              })}
            </ul>
          )}

          <h2 className="section-title portfolio-positions-title">Your seats</h2>
          {data.seats.length === 0 ? (
            <p className="portfolio-empty">No staked Dragons yet. Stake one above to take a Council seat.</p>
          ) : (
            <ul className="position-list">
              {data.seats.map(({ token, stake: s, earnings }, i) => {
                const st = seatState(s, earnings, cooldown, now);
                return (
                  <li key={token} className="position-row enter" data-won={st.action === "unstake" || undefined} style={{ "--i": i } as React.CSSProperties}>
                    <div className="position-main"><span className="position-title">Dragon {token}</span></div>
                    <div className="position-status"><span className="position-outcome">{st.action === null && <Lock size={15} />}{st.label}</span></div>
                    <div className="position-action">
                      {st.action === "request" && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setLeaving(token)}>Request unstake</Button>}
                      {st.action === "unstake" && <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(unstakeCall(token), async () => (await stakeOf(token)) === null, `Dragon ${token} is back in your wallet.`)}>Unstake</Button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="portfolio-note">A staked Dragon can be drawn for a dispute jury and earns a revenue share from the day after it is staked. Revenue is paid per quarter. Asking to unstake starts a cooldown and cuts half of the running quarter&apos;s earnings, and a seat on a jury stays locked until its case ends.</p>
          {leaving !== null && (
            <UnstakeCutDialog
              token={leaving}
              atRisk={`${formatMoney(BigInt(data.seats.find(s => s.token === leaving)?.earnings?.earned_in_progress ?? "0") / 2n)} ${config.tokenSymbol}`}
              quarterEnds={data.quarterEnd !== null ? formatDateTimeUtc(data.quarterEnd) : "the end of the quarter"}
              onCancel={() => setLeaving(null)}
              onConfirm={() => { const token = leaving; setLeaving(null); void act(requestUnstakeCall(token), async () => (await stakeOf(token))?.unlock_requested_at != null, "Unstake requested. The cooldown has started."); }}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
