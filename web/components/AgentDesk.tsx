"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Button, Notice } from "./ui";
import { useWallet } from "./WalletProvider";
import { CountUp } from "./CountUp";
import { useIndicator } from "./useIndicator";
import { Act, Funding, Register, money, report, unconfirmed, type Place } from "./AgentActions";
import { AgentAccess } from "./AgentAccess";
import { Buy, LEAST_DEPOSIT, Positions } from "./AgentMarkets";
import { StepNotice, useStep } from "./AgentStep";
import { Award, Chart, Coin, Flame, Timer, Wallet, type AppIcon } from "./icons";
import { config } from "@/lib/config";
import { minSharesWithSlippage, toMicro } from "@/lib/format";
import { useNow, usePoll } from "@/lib/hooks";
import { nearBalance, view } from "@/lib/rpc";
import {
  actionKey, agentClaimable, agentOperations, heldPositions, openMarkets, outcomeOf, roundWait, runAction, stakeBlock,
  type ActionOutcome, type AgentAction, type AgentOperation, type AgentsSetup, type AmountLimits, type ClaimableStake,
  type RoundRules,
} from "@/lib/agents";

interface RoundsAccount { registered: boolean; available: string; pending_withdrawals: string; open_stakes: number }
interface MarketAccount { registered: boolean; available: string; pending_withdrawals: string; positions: number | null }
interface OpenRound { series_id: number; asset: string; round: string; opens_at: string; closes_at: string }
interface RoundsConfig { min_stake: string; max_open_stakes: number; paused: boolean }

const GAS_TOP_UP = 200_000_000_000_000_000_000_000n;
const nearAmount = (yocto: bigint) => Number(yocto / 10n ** 20n) / 10_000;
const twoPlaces = (n: number) => n.toFixed(2);
// Money counts in whole cents so the figure at rest matches formatMoney exactly.
const centsOf = (micro: bigint) => Number((micro + 5_000n) / 10_000n);
const fromCents = (n: number) =>
  (Math.round(n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const roundsPlace = (contract: string): Place =>
  ({ venue: "rounds", contract, name: "rounds", balance: "rounds balance", purpose: "stake" });
const marketPlace = (contract: string): Place =>
  ({ venue: "market", contract, name: "markets", balance: "market balance", purpose: "buy shares" });

function desk(account: string, owner: string, setup: AgentsSetup) {
  const where = { account_id: account };
  return Promise.all([
    nearBalance(account),
    view<string>(setup.token, "ft_balance_of", { account_id: owner }),
    view<string>(config.verifierId, "mt_balance_of", { ...where, token_id: config.collateralTokenId }),
    setup.rounds ? view<RoundsAccount>(setup.rounds, "get_account", where) : null,
    setup.market ? view<MarketAccount>(setup.market, "get_account", where) : null,
  ]).then(([near, inWallet, inIntents, rounds, market]) => ({ near, inWallet, inIntents, rounds, market }));
}

const marketBook = (contract: string | null, account: string) => (contract
  ? Promise.all([openMarkets(contract), heldPositions(contract, account)])
    .then(([choices, positions]) => ({ choices, positions }))
  : Promise.resolve(null));

// Market titles the open list and held positions do not cover, read once each.
const TITLES = new Map<string, Promise<string | null>>();
function marketTitle(contract: string, id: string) {
  const key = `${contract}:${id}`;
  if (!TITLES.has(key)) {
    TITLES.set(key, view<{ title: string } | null>(contract, "get_market", { market_id: id })
      .then((m) => m?.title ?? null).catch(() => null));
  }
  return TITLES.get(key)!;
}

async function roundsChoices(rounds: string) {
  const [settings, choices] = await Promise.all([view<RoundsConfig>(rounds, "config"),
    view<OpenRound[]>(rounds, "open_rounds", { from_index: 0, limit: 12 })]);
  const rules: RoundRules = { minStake: BigInt(settings.min_stake), maxOpen: settings.max_open_stakes,
    paused: settings.paused };
  return { choices, rules };
}

function GasTopUp({ account, reload }: { account: string; reload: () => void }) {
  const { sendTransaction } = useWallet();
  const step = useStep();
  const topUp = () => step.run(async () => {
    await sendTransaction(account, [{ type: "Transfer", params: { deposit: GAS_TOP_UP.toString() } }])
      .catch(unconfirmed);
    reload();
    return "Sent 0.20 NEAR for the agent's gas.";
  });
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Gas</h4>
    <p className="text-muted">Every action the agent takes needs NEAR for gas.</p>
    <div><Button variant="secondary" onClick={topUp} disabled={step.busy}>Send 0.20 NEAR</Button></div>
    <StepNotice step={step} />
  </div>;
}

interface StakeProps {
  rounds: string; agentId: string; account: string; available: bigint; openStakes: number; onDone: () => void;
}
const LEFT_IN_ROUNDS = "The round did not take the stake. The money is still in the agent's rounds balance.";

function Stake({ rounds, agentId, account, available, openStakes, onDone }: StakeProps) {
  const { data: market } = usePoll(() => roundsChoices(rounds), [rounds], 15000);
  const [choice, setChoice] = useState(0);
  const [side, setSide] = useState<"up" | "down">("up");
  const [amount, setAmount] = useState("");
  const sides = useRef<HTMLDivElement>(null);
  useIndicator(sides, `${side}:${market?.choices.length ?? 0}`);
  const step = useStep();
  const now = useNow(1000);
  const micro = toMicro(amount), picked = market?.choices.find((s) => s.series_id === choice);
  const where = picked ? { series_id: choice, round: picked.round, account_id: account } : null;
  const heldStake = () => (where ? view<{ side: string } | null>(rounds, "get_stake", where) : Promise.resolve(null));
  const deps = [rounds, choice, picked?.round ?? "", account];
  const { data: held, loading: heldLoading } = usePoll(heldStake, deps, 15000);
  const stake = () => step.run(async () => {
    const asked = { series_id: choice, round: picked!.round, side, amount: micro!.toString() };
    const quoted = BigInt(await view<string>(rounds, "quote_stake", asked));
    if (quoted === 0n) throw new Error("This round cannot take that stake. Try a smaller amount.");
    const action: AgentAction = { kind: "stake", series: choice, round: picked!.round, side, amount: asked.amount,
      minShares: minSharesWithSlippage(quoted).toString() };
    const result = await runAction(agentId, actionKey(), action);
    setAmount("");
    onDone();
    return report(result, `Staked ${money(micro!)} on ${side === "up" ? "Up" : "Down"} in round `
      + `${picked!.round}.`, LEFT_IN_ROUNDS);
  });
  if (!market?.choices.length) return <p className="text-muted">No rounds are open yet.</p>;
  const blocked = stakeBlock(market.rules, openStakes, held ?? null, side, micro ?? 0n);
  const waiting = picked ? roundWait(picked.opens_at, picked.closes_at, now) : null;
  const ready = picked && micro !== null && micro > 0n && micro <= available && !blocked && !waiting && !heldLoading
    && !step.busy;
  return <div role="group" className="agent-form" aria-labelledby={`stake-${agentId}`}>
    <div className="agent-form-head">
      <h4 id={`stake-${agentId}`} className="agent-panel-title">Stake as the agent</h4>
      <span className="agent-form-meta">{money(available)} in its rounds balance</span>
    </div>
    <label className="agent-label" htmlFor={`series-${agentId}`}>Series</label>
    <select id={`series-${agentId}`} className="agent-select" value={choice}
      onChange={(e) => setChoice(Number(e.target.value))}>
      {market.choices.map((s) => <option key={s.series_id} value={s.series_id}>{s.asset}, round {s.round}</option>)}
    </select>
    <div className="agent-ticket">
      <div ref={sides} role="group" aria-label="Side" className="segmented">
        {(["up", "down"] as const).map((s) => <button key={s} type="button" aria-pressed={side === s}
          onClick={() => setSide(s)}>{s === "up" ? "Up" : "Down"}</button>)}
      </div>
      <div className="field agent-amount">
        <input aria-label="Amount to stake" inputMode="decimal" placeholder="0.00" value={amount}
          onChange={(e) => setAmount(e.target.value)} className="num" />
        <span className="agent-unit" aria-hidden="true">{config.tokenSymbol}</span>
      </div>
      <Button variant="secondary" onClick={stake} disabled={!ready}>{step.busy ? "Staking" : "Stake"}</Button>
    </div>
    {(blocked ?? waiting) && <p className="text-muted" role="status">{blocked ?? waiting}</p>}
    <StepNotice step={step} />
  </div>;
}

const empty = (held: { available: string; pending_withdrawals: string }) =>
  BigInt(held.available) === 0n && BigInt(held.pending_withdrawals) === 0n;
const roundsLeavable = (rounds: RoundsAccount | null) =>
  rounds?.registered === true && rounds.open_stakes === 0 && empty(rounds);
const marketLeavable = (market: MarketAccount | null) =>
  market?.registered === true && market.positions === 0 && empty(market);

/* ---------- Activity ---------- */

const LABELS: Record<string, string> = {
  stake: "Stake", claim: "Claim", buy: "Buy", sell: "Sell", redeem: "Redeem", cash_out: "Cash out",
};
const side = (yes: boolean) => <b className="agent-op-side" data-side={yes ? "yes" : "no"}>{yes ? "Yes" : "No"}</b>;
const venueName = (venue: string) => (venue === "market" ? "markets" : "rounds");

// One line for what the agent did, and where: the market's title or the round.
function describe(op: AgentOperation, title: (id: string) => string): { what: ReactNode; where: string | null } {
  const a = op.action;
  if (a?.kind === "stake") {
    return { what: <>Stake {money(a.amount)} on {a.side === "up" ? "Up" : "Down"}</>, where: `Round ${a.round}` };
  }
  if (a?.kind === "buy") return { what: <>Buy {side(a.side === "yes")} with {money(a.amount)}</>, where: title(a.market) };
  if (a?.kind === "sell") return { what: <>Sell {side(a.side === "yes")} shares</>, where: title(a.market) };
  if (a?.kind === "redeem") return { what: "Redeem", where: title(a.market) };
  if (a?.kind === "claim") return { what: "Claim", where: `Round ${a.round}` };
  if (a?.kind === "withdraw") return { what: <>Withdrawal of {money(a.amount)} from {venueName(a.venue)}</>, where: null };
  if (a?.kind === "leave") return { what: `Left ${venueName(a.venue)}`, where: null };
  if (a?.kind === "cash_out") return { what: `${LABELS[a.kind]} of ${money(a.amount)}`, where: null };
  return { what: op.kind, where: null };
}

const ICON: Record<string, AppIcon> = {
  buy: Chart, sell: Chart, redeem: Award, stake: Timer, claim: Award, withdraw: Wallet, cash_out: Wallet, leave: Wallet,
};

const LABEL: Record<ActionOutcome, [string, string]> = {
  done: ["Done", "final"], refused: ["Did not go through", "attention"], review: ["Needs a check", "attention"],
  settling: ["In progress", "neutral"],
};

const when = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleString("en-GB",
    { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
};

function Activity({ operations, title }: { operations: AgentOperation[]; title: (id: string) => string }) {
  if (!operations.length) {
    return <p className="agent-feed-empty">
      Nothing yet. Every trade, stake and payout the agent makes lands here, newest first.
    </p>;
  }
  return <ul className="agent-feed-list">
    {operations.map((op, i) => {
      const [label, tone] = LABEL[outcomeOf(op.state)];
      const { what, where } = describe(op, title);
      const Icon = op.action ? ICON[op.action.kind] ?? Coin : Coin;
      const sided = op.action && "side" in op.action && (op.action.side === "yes" || op.action.side === "no")
        ? op.action.side : undefined;
      const at = when(op.updated_at);
      return <li key={op.id} className="agent-op" data-side={sided} style={{ "--i": Math.min(i, 8) } as CSSProperties}>
        <span className="agent-op-mark" aria-hidden="true"><Icon size={20} variant="Bulk" /></span>
        <div className="agent-op-main">
          <p className="agent-op-what">{what}</p>
          {where && <p className="agent-op-where">{where}</p>}
        </div>
        {at && <time className="agent-op-time num" dateTime={op.updated_at}>{at}</time>}
        <span className="status-pill" data-tone={tone}>{label}</span>
      </li>;
    })}
  </ul>;
}

interface ClaimsProps { agentId: string; stakes: ClaimableStake[]; onDone: () => void }

function Claims({ agentId, stakes, onDone }: ClaimsProps) {
  if (!stakes.length) return null;
  return <div className="agent-claims">
    <h4 className="agent-panel-title">Ready to claim</h4>
    <ul className="agent-history">
      {stakes.map((s) => <li key={`${s.series}:${s.round}`}>
        <span><span className="num">{money(s.amount)}</span> on {s.side === "up" ? "Up" : "Down"}, round {s.round}</span>
        <Act label="Claim" agentId={agentId} action={{ kind: "claim", series: s.series, round: s.round }}
          onDone={onDone} />
      </li>)}
    </ul>
  </div>;
}

/* ---------- Pay out and leave ---------- */

interface PayOutProps {
  agentId: string; inRounds: bigint; inMarket: bigint; inIntents: bigint; limits: AmountLimits | null;
  onDone: () => void;
}

function PayOut({ agentId, inRounds, inMarket, inIntents, limits, onDone }: PayOutProps) {
  if (inRounds === 0n && inMarket === 0n && inIntents === 0n) {
    return <p className="text-muted">Nothing to pay out yet. Its balances in markets, rounds and NEAR Intents are empty.</p>;
  }
  const out = limits && inIntents > limits.perTransaction ? limits.perTransaction : inIntents;
  const fromRounds: AgentAction = { kind: "withdraw", venue: "rounds", amount: inRounds.toString() };
  const fromMarket: AgentAction = { kind: "withdraw", venue: "market", amount: inMarket.toString() };
  const cashOut: AgentAction = { kind: "cash_out", amount: out.toString() };
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Pay out to your wallet</h4>
    <p className="text-muted">
      Withdrawals move money into its NEAR Intents balance. Cashing out sends it from there to your wallet and nowhere
      else.
    </p>
    <div className="agent-row">
      {inMarket > 0n &&
        <Act label={`Withdraw ${money(inMarket)} from markets`} agentId={agentId} action={fromMarket} onDone={onDone} />}
      {inRounds > 0n &&
        <Act label={`Withdraw ${money(inRounds)} from rounds`} agentId={agentId} action={fromRounds} onDone={onDone} />}
      {out > 0n &&
        <Act label={`Cash out ${money(out)} to your wallet`} agentId={agentId} action={cashOut} onDone={onDone} />}
    </div>
    {limits && out < inIntents && <p className="text-muted">
      The agent pays out at most {money(limits.perTransaction)} at a time and {money(limits.daily)} in 24 hours.
    </p>}
  </div>;
}

interface LeaveProps { agentId: string; place: Place; onDone: () => void }

function Leave({ agentId, place, onDone }: LeaveProps) {
  return <div className="agent-panel">
    <p className="text-muted">
      The agent holds nothing in {place.name}. Leaving returns the 0.05 NEAR to the wallet that paid it.
    </p>
    <Act label={`Leave ${place.name}`} agentId={agentId} action={{ kind: "leave", venue: place.venue }} onDone={onDone} />
  </div>;
}

/* ---------- The actions panel ---------- */

interface Tab { id: string; label: string; panel: ReactNode }

function ActionTabs({ agentId, tabs, note }: { agentId: string; tabs: Tab[]; note: ReactNode }) {
  const [chosen, setChosen] = useState(tabs[0]?.id);
  const active = tabs.some((t) => t.id === chosen) ? chosen : tabs[0]?.id;
  const list = useRef<HTMLDivElement>(null);
  useIndicator(list, `${active}:${tabs.length}`);
  if (!tabs.length) return null;
  const move = (e: KeyboardEvent) => {
    const at = tabs.findIndex((t) => t.id === active);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length]!;
    setChosen(tab.id);
    list.current?.querySelector<HTMLElement>(`#tab-${agentId}-${tab.id}`)?.focus();
  };
  return <section className="agent-actions" aria-label="Actions">
    <div className="agent-actions-head">
      <div ref={list} role="tablist" aria-label="Actions" className="agent-tabs" onKeyDown={move}>
        {tabs.map((t) => <button key={t.id} id={`tab-${agentId}-${t.id}`} type="button" role="tab"
          aria-selected={t.id === active} aria-controls={`panel-${agentId}-${t.id}`} tabIndex={t.id === active ? 0 : -1}
          onClick={() => setChosen(t.id)}>{t.label}</button>)}
      </div>
      {note && <p className="agent-actions-note">{note}</p>}
    </div>
    {tabs.map((t) => <div key={t.id} id={`panel-${agentId}-${t.id}`} role="tabpanel"
      aria-labelledby={`tab-${agentId}-${t.id}`} hidden={t.id !== active} className="agent-tabpanel">
      {t.panel}
    </div>)}
  </section>;
}

/* ---------- The desk ---------- */

interface StatProps { label: string; icon: AppIcon; value: number; format: (n: number) => string; unit: string }

function Stat({ label, icon: Icon, value, format, unit }: StatProps) {
  return <div className="agent-stat">
    <dt><Icon size={16} />{label}</dt>
    <dd><CountUp value={value} format={format} className="agent-stat-figure" />
      <span className="agent-stat-unit">{unit}</span></dd>
  </div>;
}

interface DeskProps { agentId: string; account: string; owner: string; setup: AgentsSetup; frozen: boolean }

export function AgentDesk({ agentId, account, owner, setup, frozen }: DeskProps) {
  const deps = [account, owner, setup.token, setup.rounds, setup.market];
  const { data, error, reload } = usePoll(() => desk(account, owner, setup), deps, 6000);
  const { data: book, reload: reloadBook } = usePoll(() => marketBook(setup.market, account),
    [setup.market, account], 10000);
  const [fetched, setFetched] = useState<Record<string, string>>({});
  const loadHistory = async () => {
    const [operations, stakes] = await Promise.all([agentOperations(agentId), agentClaimable(agentId)]);
    const known = (id: string) => fetched[id] ?? book?.choices.find((m) => m.id === id)
      ?? book?.positions.find((p) => p.market_id === id);
    const missing = [...new Set(operations.flatMap((op) =>
      (op.action && "market" in op.action && !known(op.action.market) ? [op.action.market] : [])))];
    if (setup.market && missing.length) {
      const titles = await Promise.all(missing.map((id) => marketTitle(setup.market!, id)));
      const found = Object.fromEntries(missing.flatMap((id, i) => (titles[i] ? [[id, titles[i]!]] : [])));
      if (Object.keys(found).length) setFetched((f) => ({ ...f, ...found }));
    }
    return { operations, stakes };
  };
  const { data: history, reload: reloadHistory } = usePoll(loadHistory, [agentId], 8000);
  if (!data) {
    return error ? <Notice tone="danger">Could not read the agent&apos;s balances. Check your connection.</Notice>
      : <p className="text-muted" role="status">Reading the agent&apos;s balances</p>;
  }
  const title = (id: string) => fetched[id] ?? book?.choices.find((m) => m.id === id)?.title
    ?? book?.positions.find((p) => p.market_id === id)?.title ?? `Market ${id}`;
  const inRounds = BigInt(data.rounds?.available ?? "0"), inMarket = BigInt(data.market?.available ?? "0");
  const inIntents = BigInt(data.inIntents);
  const rounds = setup.rounds ? roundsPlace(setup.rounds) : null;
  const market = setup.market ? marketPlace(setup.market) : null;
  const common = { account, owner, token: setup.token, inWallet: data.inWallet, reload };
  const traded = () => {
    reloadBook();
    reloadHistory();
    reload();
  };
  const positions = data.market?.registered ? book?.positions ?? [] : [];
  const claims = !frozen ? history?.stakes ?? [] : [];

  const tabs: Tab[] = [];
  if (!frozen && market && data.market) {
    tabs.push({ id: "markets", label: "Trade markets", panel: data.market.registered
      ? <div className="agent-split">
        {book ? <Buy contract={market.contract} agentId={agentId} available={inMarket} choices={book.choices}
          onDone={traded} /> : <p className="text-muted" role="status">Reading open markets</p>}
        <Funding place={market} least={LEAST_DEPOSIT} {...common} />
      </div>
      : <Register account={account} owner={owner} place={market} reload={reload} /> });
  }
  if (!frozen && rounds && data.rounds) {
    tabs.push({ id: "rounds", label: "Stake rounds", panel: <RoundsTab place={rounds} agentId={agentId}
      held={data.rounds} common={common} onDone={traded} /> });
  }
  if (!frozen) {
    tabs.push({ id: "payout", label: "Pay out", panel: <div className="agent-stack">
      <PayOut agentId={agentId} inRounds={inRounds} inMarket={inMarket} inIntents={inIntents} limits={setup.cashOut}
        onDone={traded} />
      {market && marketLeavable(data.market) && <Leave agentId={agentId} place={market} onDone={reload} />}
      {rounds && roundsLeavable(data.rounds) && <Leave agentId={agentId} place={rounds} onDone={reload} />}
    </div> });
    tabs.push({ id: "gas", label: "Gas", panel: <GasTopUp account={account} reload={reload} /> });
  }
  if (config.mcpUrl) tabs.push({ id: "access", label: "Connect an AI agent", panel: <AgentAccess agentId={agentId} /> });
  const note = !frozen && setup.spend ? <>From this site your agents spend at most {money(setup.spend.perTransaction)} at
    a time and {money(setup.spend.daily)} in 24 hours.</> : null;

  return <div className="agent-desk">
    <dl className="agent-stats">
      <Stat label="NEAR for gas" icon={Flame} value={nearAmount(data.near)} format={twoPlaces} unit="NEAR" />
      <Stat label="In markets" icon={Chart} value={centsOf(inMarket)} format={fromCents} unit={config.tokenSymbol} />
      <Stat label="In rounds" icon={Timer} value={centsOf(inRounds)} format={fromCents} unit={config.tokenSymbol} />
      <Stat label="In its NEAR Intents balance" icon={Wallet} value={centsOf(inIntents)} format={fromCents}
        unit={config.tokenSymbol} />
    </dl>
    {frozen && <Notice tone="warning">This agent is frozen, so nothing moves until you unfreeze it.</Notice>}
    <div className="agent-floor">
      <section className="agent-feed" aria-labelledby={`feed-${agentId}`}>
        <header className="agent-feed-head">
          <h4 id={`feed-${agentId}`} className="agent-feed-title">Activity</h4>
          <span className="agent-live">Live</span>
          <span className="agent-feed-meta">Newest first</span>
        </header>
        {history ? <div className="agent-scroll" tabIndex={0} aria-label="Agent activity">
          <Activity operations={history.operations} title={title} />
        </div> : <p className="text-muted" role="status">Reading the agent&apos;s activity</p>}
      </section>
      <aside className="agent-holdings" aria-labelledby={`held-${agentId}`}>
        <header className="agent-feed-head">
          <h4 id={`held-${agentId}`} className="agent-feed-title">Positions</h4>
          {positions.length > 0 && <span className="agent-feed-meta num">
            {positions.length} {positions.length === 1 ? "market" : "markets"}
          </span>}
        </header>
        <div className="agent-scroll" tabIndex={0} aria-label="Agent positions">
          <Claims agentId={agentId} stakes={claims} onDone={traded} />
          {positions.length > 0 && market
            ? <Positions contract={market.contract} agentId={agentId} positions={positions} frozen={frozen}
              onDone={traded} />
            : <p className="agent-feed-empty">No shares held. What the agent buys shows here, ready to sell.</p>}
        </div>
      </aside>
    </div>
    <ActionTabs agentId={agentId} tabs={tabs} note={note} />
  </div>;
}

interface RoundsTabProps {
  place: Place; agentId: string; held: RoundsAccount; onDone: () => void;
  common: { account: string; owner: string; token: string; inWallet: string; reload: () => void };
}

function RoundsTab({ place, agentId, held, common, onDone }: RoundsTabProps) {
  const { data: rules } = usePoll(() => view<RoundsConfig>(place.contract, "config"), [place.contract], 60000);
  if (!held.registered) {
    return <Register account={common.account} owner={common.owner} place={place} reload={common.reload} />;
  }
  return <div className="agent-split">
    <Stake rounds={place.contract} agentId={agentId} account={common.account} available={BigInt(held.available)}
      openStakes={held.open_stakes} onDone={onDone} />
    <Funding place={place} least={rules ? BigInt(rules.min_stake) : null} {...common} />
  </div>;
}
