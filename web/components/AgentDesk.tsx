"use client";

import { useState } from "react";
import { Button, Notice } from "./ui";
import { useWallet } from "./WalletProvider";
import { Act, Funding, Register, money, report, unconfirmed, type Place } from "./AgentActions";
import { AgentMarkets } from "./AgentMarkets";
import { StepNotice, useStep } from "./AgentStep";
import { config } from "@/lib/config";
import { minSharesWithSlippage, toMicro } from "@/lib/format";
import { useNow, usePoll } from "@/lib/hooks";
import { nearBalance, view } from "@/lib/rpc";
import {
  actionKey, agentClaimable, agentOperations, outcomeOf, roundWait, runAction, stakeBlock, type ActionOutcome,
  type AgentAction, type AgentOperation, type AgentsSetup, type AmountLimits, type ClaimableStake, type RoundRules,
} from "@/lib/agents";

interface RoundsAccount { registered: boolean; available: string; pending_withdrawals: string; open_stakes: number }
interface MarketAccount { registered: boolean; available: string; pending_withdrawals: string; positions: number | null }
interface OpenRound { series_id: number; asset: string; round: string; opens_at: string; closes_at: string }
interface RoundsConfig { min_stake: string; max_open_stakes: number; paused: boolean }

const GAS_TOP_UP = 200_000_000_000_000_000_000_000n;
const nearText = (yocto: bigint) => `${(Number(yocto / 10n ** 20n) / 10_000).toFixed(2)} NEAR`;

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
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Stake as the agent</h4>
    <div className="agent-row">
      <label className="sr-only" htmlFor={`series-${agentId}`}>Series</label>
      <select id={`series-${agentId}`} className="agent-select" value={choice}
        onChange={(e) => setChoice(Number(e.target.value))}>
        {market.choices.map((s) => <option key={s.series_id} value={s.series_id}>{s.asset}, round {s.round}</option>)}
      </select>
      <div role="group" aria-label="Side" className="segmented">
        {(["up", "down"] as const).map((s) => <button key={s} type="button" aria-pressed={side === s}
          onClick={() => setSide(s)}>{s === "up" ? "Up" : "Down"}</button>)}
      </div>
      <div className="field agent-amount">
        <input aria-label="Amount to stake" inputMode="decimal" placeholder="0.00" value={amount}
          onChange={(e) => setAmount(e.target.value)} className="num" />
      </div>
      <Button variant="secondary" onClick={stake} disabled={!ready}>{step.busy ? "Staking" : "Stake"}</Button>
    </div>
    {(blocked ?? waiting) && <p className="text-muted" role="status">{blocked ?? waiting}</p>}
    <StepNotice step={step} />
  </div>;
}

interface RoundsDeskProps {
  place: Place; agentId: string; account: string; owner: string; token: string; inWallet: string; held: RoundsAccount;
  onDone: () => void;
}

function RoundsDesk({ place, agentId, account, owner, token, inWallet, held, onDone }: RoundsDeskProps) {
  const { data: rules } = usePoll(() => view<RoundsConfig>(place.contract, "config"), [place.contract], 60000);
  if (!held.registered) return <Register account={account} owner={owner} place={place} reload={onDone} />;
  return <>
    <Funding account={account} owner={owner} place={place} token={token} inWallet={inWallet}
      least={rules ? BigInt(rules.min_stake) : null} reload={onDone} />
    <Stake rounds={place.contract} agentId={agentId} account={account} available={BigInt(held.available)}
      openStakes={held.open_stakes} onDone={onDone} />
  </>;
}

const LABELS: Record<string, string> = {
  stake: "Stake", claim: "Claim", buy: "Buy", sell: "Sell", redeem: "Redeem", cash_out: "Cash out",
};
const describe = (op: AgentOperation) => {
  const a = op.action;
  if (a?.kind === "stake") return `Stake ${money(a.amount)} on ${a.side === "up" ? "Up" : "Down"}, round ${a.round}`;
  if (a?.kind === "buy") return `Buy ${a.side === "yes" ? "Yes" : "No"} with ${money(a.amount)}, market ${a.market}`;
  if (a?.kind === "sell") return `Sell ${a.side === "yes" ? "Yes" : "No"} shares, market ${a.market}`;
  if (a?.kind === "redeem") return `Redeem market ${a.market}`;
  if (a?.kind === "withdraw") return `Withdrawal of ${money(a.amount)} from ${a.venue === "market" ? "markets" : "rounds"}`;
  if (a?.kind === "leave") return `Left ${a.venue === "market" ? "markets" : "rounds"}`;
  if (a && "amount" in a) return `${LABELS[a.kind] ?? a.kind} of ${money(a.amount)}`;
  return a ? LABELS[a.kind] ?? a.kind : op.kind;
};

const LABEL: Record<ActionOutcome, [string, string]> = {
  done: ["Done", "final"], refused: ["Did not go through", "attention"], review: ["Needs a check", "attention"],
  settling: ["In progress", "neutral"],
};

interface ClaimsProps { agentId: string; stakes: ClaimableStake[]; onDone: () => void }

function Claims({ agentId, stakes, onDone }: ClaimsProps) {
  if (!stakes.length) return null;
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Ready to claim</h4>
    <ul className="agent-history">
      {stakes.map((s) => <li key={`${s.series}:${s.round}`}>
        <span>{money(s.amount)} on {s.side === "up" ? "Up" : "Down"}, round {s.round}</span>
        <Act label="Claim" agentId={agentId} action={{ kind: "claim", series: s.series, round: s.round }}
          onDone={onDone} />
      </li>)}
    </ul>
  </div>;
}

interface HistoryProps { agentId: string; frozen: boolean; onDone: () => void }

function History({ agentId, frozen, onDone }: HistoryProps) {
  const load = () => Promise.all([agentOperations(agentId), agentClaimable(agentId)])
    .then(([operations, stakes]) => ({ operations, stakes }));
  const { data, reload } = usePoll(load, [agentId], 8000);
  if (!data) return null;
  const claimed = () => {
    reload();
    onDone();
  };
  return <>
    {!frozen && <Claims agentId={agentId} stakes={data.stakes} onDone={claimed} />}
    {data.operations.length > 0 && <div className="agent-panel">
      <h4 className="agent-panel-title">History</h4>
      <ul className="agent-history">
        {data.operations.map((op) => {
          const [label, tone] = LABEL[outcomeOf(op.state)];
          return <li key={op.id}>
            <span>{describe(op)}</span>
            <span className="status-pill" data-tone={tone}>{label}</span>
          </li>;
        })}
      </ul>
    </div>}
  </>;
}

interface PayOutProps {
  agentId: string;
  inRounds: bigint;
  inMarket: bigint;
  inIntents: bigint;
  limits: AmountLimits | null;
  onDone: () => void;
}

function PayOut({ agentId, inRounds, inMarket, inIntents, limits, onDone }: PayOutProps) {
  if (inRounds === 0n && inMarket === 0n && inIntents === 0n) return null;
  const out = limits && inIntents > limits.perTransaction ? limits.perTransaction : inIntents;
  const fromRounds: AgentAction = { kind: "withdraw", venue: "rounds", amount: inRounds.toString() };
  const fromMarket: AgentAction = { kind: "withdraw", venue: "market", amount: inMarket.toString() };
  const cashOut: AgentAction = { kind: "cash_out", amount: out.toString() };
  return <>
    <div className="agent-panel agent-row">
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
  </>;
}

const empty = (held: { available: string; pending_withdrawals: string }) =>
  BigInt(held.available) === 0n && BigInt(held.pending_withdrawals) === 0n;
const roundsLeavable = (rounds: RoundsAccount | null) =>
  rounds?.registered === true && rounds.open_stakes === 0 && empty(rounds);
const marketLeavable = (market: MarketAccount | null) =>
  market?.registered === true && market.positions === 0 && empty(market);

interface LeaveProps { agentId: string; place: Place; onDone: () => void }

function Leave({ agentId, place, onDone }: LeaveProps) {
  return <div className="agent-panel">
    <p className="text-muted">
      The agent holds nothing in {place.name}. Leaving returns the 0.05 NEAR to the wallet that paid it.
    </p>
    <Act label={`Leave ${place.name}`} agentId={agentId} action={{ kind: "leave", venue: place.venue }} onDone={onDone} />
  </div>;
}

interface DeskProps { agentId: string; account: string; owner: string; setup: AgentsSetup; frozen: boolean }

export function AgentDesk({ agentId, account, owner, setup, frozen }: DeskProps) {
  const deps = [account, owner, setup.token, setup.rounds, setup.market];
  const { data, error, reload } = usePoll(() => desk(account, owner, setup), deps, 6000);
  if (!data) {
    return error ? <Notice tone="danger">Could not read the agent&apos;s balances. Check your connection.</Notice>
      : <p className="text-muted" role="status">Reading the agent&apos;s balances</p>;
  }
  const inRounds = BigInt(data.rounds?.available ?? "0"), inMarket = BigInt(data.market?.available ?? "0");
  const inIntents = BigInt(data.inIntents);
  const rounds = setup.rounds ? roundsPlace(setup.rounds) : null;
  const market = setup.market ? marketPlace(setup.market) : null;
  const common = { agentId, account, owner, token: setup.token, inWallet: data.inWallet, onDone: reload };
  return <div className="agent-desk">
    <dl className="agent-balances">
      <div><dt>NEAR for gas</dt><dd className="num">{nearText(data.near)}</dd></div>
      <div><dt>In markets</dt><dd className="num">{money(inMarket)}</dd></div>
      <div><dt>In rounds</dt><dd className="num">{money(inRounds)}</dd></div>
      <div><dt>In its NEAR Intents balance</dt><dd className="num">{money(inIntents)}</dd></div>
    </dl>
    {frozen && <Notice tone="warning">This agent is frozen, so nothing moves until you unfreeze it.</Notice>}
    {!frozen && <GasTopUp account={account} reload={reload} />}
    {!frozen && setup.spend && <p className="text-muted">
      From this site your agents spend at most {money(setup.spend.perTransaction)} at a time
      and {money(setup.spend.daily)} in 24 hours.
    </p>}
    {!frozen && market && <AgentMarkets place={market} held={data.market} {...common} />}
    {!frozen && rounds && data.rounds && <RoundsDesk place={rounds} held={data.rounds} {...common} />}
    {!frozen && <PayOut agentId={agentId} inRounds={inRounds} inMarket={inMarket} inIntents={inIntents}
      limits={setup.cashOut} onDone={reload} />}
    {!frozen && market && marketLeavable(data.market) && <Leave agentId={agentId} place={market} onDone={reload} />}
    {!frozen && rounds && roundsLeavable(data.rounds) && <Leave agentId={agentId} place={rounds} onDone={reload} />}
    <History agentId={agentId} frozen={frozen} onDone={reload} />
  </div>;
}
