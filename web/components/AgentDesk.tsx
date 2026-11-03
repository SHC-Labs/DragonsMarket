"use client";

import { useState } from "react";
import { Button, Notice } from "./ui";
import { useWallet } from "./WalletProvider";
import { StepNotice, useStep } from "./AgentStep";
import { config } from "@/lib/config";
import { friendlyError, shortRef } from "@/lib/errors";
import { formatMoney, minSharesWithSlippage, toMicro } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { nearBalance, txPanics, view } from "@/lib/rpc";
import {
  actionKey, agentOperations, depositedFor, outcomeOf, runAction, stakeBlock, type ActionOutcome, type AgentAction,
  type AgentOperation, type AgentsSetup, type RoundRules,
} from "@/lib/agents";

interface RoundsAccount { registered: boolean; available: string; pending_withdrawals: string; open_stakes: number }
interface SeriesChoice { id: number; asset: string; round: string }
interface RoundsConfig { series: number; min_stake: string; max_open_stakes: number; paused: boolean }

const GAS_TOP_UP = 200_000_000_000_000_000_000_000n;
const MAX_REGISTRATION = 100_000_000_000_000_000_000_000n;
const TGAS_30 = "30000000000000";
const TGAS_300 = "300000000000000";
const nearText = (yocto: bigint) => `${(Number(yocto / 10n ** 20n) / 10_000).toFixed(2)} NEAR`;
const money = (micro: string | bigint) => `${formatMoney(micro)} ${config.tokenSymbol}`;
const SEE_HISTORY = "The details are in the history below.";
const SETTLING = "It was sent and is still settling. Check the history before trying again.";
const STOPPED = "Dragons Market could not prove whether it went through, so it stopped it for a check. Look at the "
  + "agent's balances before trying again.";
const UNREAD = "Your wallet sent it, but its result could not be read. Check the agent's balances before sending again.";

function report(state: string, done: string, refused = `That did not go through. ${SEE_HISTORY}`) {
  const outcome = outcomeOf(state);
  if (outcome === "refused") throw new Error(refused);
  if (outcome === "review") throw new Error(STOPPED);
  return outcome === "done" ? done : SETTLING;
}

const unconfirmed = () => {
  throw new Error("Your wallet did not confirm it sent this. Check the agent's balances before sending again.");
};

async function credited(hash: string, owner: string, rounds: string, agent: string) {
  const amount = await depositedFor(hash, owner, rounds, agent).catch(() => { throw new Error(UNREAD); });
  if (amount !== null) return `Sent ${money(amount)} into the agent's rounds balance.`;
  const panic = (await txPanics(hash, owner).catch(() => []))[0];
  throw new Error("Rounds did not credit it to the agent. A refused transfer goes back to your wallet, so check your "
    + `wallet and the agent's balances before sending again.${panic ? ` ${friendlyError(panic, shortRef(hash))}` : ""}`);
}

function desk(account: string, owner: string, setup: AgentsSetup) {
  const intents = { account_id: account, token_id: config.collateralTokenId };
  return Promise.all([
    nearBalance(account),
    view<string>(setup.token, "ft_balance_of", { account_id: owner }),
    view<string>(config.verifierId, "mt_balance_of", intents),
    setup.rounds ? view<RoundsAccount>(setup.rounds, "get_account", { account_id: account }) : null,
  ]).then(([near, inWallet, inIntents, rounds]) => ({ near, inWallet, inIntents, rounds }));
}

async function roundsChoices(rounds: string) {
  const config = await view<RoundsConfig>(rounds, "config");
  const ids = Array.from({ length: Math.min(config.series, 12) }, (_, i) => i);
  const choices: SeriesChoice[] = await Promise.all(ids.map(async (id) => {
    const [found, round] = await Promise.all([
      view<{ asset: string } | null>(rounds, "get_series", { series_id: id }),
      view<string>(rounds, "next_round", { series_id: id }),
    ]);
    return { id, asset: found?.asset ?? `Series ${id}`, round };
  }));
  const rules: RoundRules = { minStake: BigInt(config.min_stake), maxOpen: config.max_open_stakes,
    paused: config.paused };
  return { choices, rules };
}


const call = (methodName: string, args: Record<string, unknown>, deposit: string, gas = TGAS_30) =>
  ({ type: "FunctionCall" as const, params: { methodName, args, gas, deposit } });

interface FundingProps {
  account: string; owner: string; rounds: string; token: string; held: { inWallet: string }; registered: boolean;
  reload: () => void;
}

function Funding({ account, owner, rounds, token, held, registered, reload }: FundingProps) {
  const { sendTransaction } = useWallet();
  const { data: rules } = usePoll(() => view<RoundsConfig>(rounds, "config"), [rounds], 60000);
  const [amount, setAmount] = useState("");
  const step = useStep();
  const micro = toMicro(amount), least = rules ? BigInt(rules.min_stake) : null;
  const topUp = () => step.run(async () => {
    await sendTransaction(account, [{ type: "Transfer", params: { deposit: GAS_TOP_UP.toString() } }])
      .catch(unconfirmed);
    reload();
    return "Sent 0.20 NEAR for the agent's gas.";
  });
  const send = () => step.run(async () => {
    const hash = await sendTransaction(token, [call("ft_transfer_call",
      { receiver_id: rounds, amount: micro!.toString(), msg: `deposit_for:${account}` }, "1", TGAS_300)])
      .catch(unconfirmed);
    setAmount("");
    reload();
    return credited(hash, owner, rounds, account);
  });
  const enough = micro !== null && least !== null && micro >= least && micro <= BigInt(held.inWallet);
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Fund the agent</h4>
    <p className="text-muted">
      It needs NEAR for gas, and {config.tokenSymbol} in its rounds balance to stake.
      You have {money(held.inWallet)} in your wallet{least !== null && <>, and send at least {money(least)}</>}.
    </p>
    <div className="agent-row">
      <Button variant="secondary" onClick={topUp} disabled={step.busy}>Send 0.20 NEAR</Button>
      {registered && <>
        <div className="field agent-amount">
          <input aria-label={`${config.tokenSymbol} to send`} inputMode="decimal" placeholder="0.00" value={amount}
            onChange={(e) => setAmount(e.target.value)} className="num" />
        </div>
        <Button variant="secondary" onClick={send} disabled={!enough || step.busy}>Send {config.tokenSymbol}</Button>
      </>}
    </div>
    {!registered && <p className="text-muted">Register the agent with rounds, then send it {config.tokenSymbol}.</p>}
    <StepNotice step={step} />
  </div>;
}

interface RegisterProps { account: string; owner: string; rounds: string; reload: () => void }

function Register({ account, owner, rounds, reload }: RegisterProps) {
  const { sendTransaction } = useWallet();
  const step = useStep();
  const register = () => step.run(async () => {
    const { storage_deposit: asked } = await view<{ storage_deposit: string }>(rounds, "config");
    if (BigInt(asked) > MAX_REGISTRATION) {
      throw new Error("Rounds asked for more than 0.1 NEAR to register, so nothing was sent.");
    }
    const hash = await sendTransaction(rounds, [call("storage_deposit", { account_id: account }, asked)])
      .catch(unconfirmed);
    reload();
    const panics = await txPanics(hash, owner).catch(() => { throw new Error(UNREAD); });
    if (panics[0]) throw new Error(`Rounds did not register the agent. ${friendlyError(panics[0], shortRef(hash))}`);
    return "Registered the agent with rounds.";
  });
  return <div className="agent-panel">
    <p className="text-muted">
      Rounds keep 0.05 NEAR from your wallet while the agent takes part, and return it to you when it leaves.
    </p>
    <Button onClick={register} disabled={step.busy}>{step.busy ? "Waiting for your wallet" : "Register with rounds"}</Button>
    <StepNotice step={step} />
  </div>;
}

interface StakeProps {
  rounds: string; agentId: string; account: string; available: bigint; openStakes: number; onDone: () => void;
}
const LEFT_IN_ROUNDS = "The round did not take the stake. The money is still in the agent's rounds balance.";

function Stake({ rounds, agentId, account, available, openStakes, onDone }: StakeProps) {
  const { data: market } = usePoll(() => roundsChoices(rounds), [rounds], 30000);
  const [choice, setChoice] = useState(0);
  const [side, setSide] = useState<"up" | "down">("up");
  const [amount, setAmount] = useState("");
  const step = useStep();
  const micro = toMicro(amount), picked = market?.choices.find((s) => s.id === choice);
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
    return report(result.state, `Staked ${money(micro!)} on ${side === "up" ? "Up" : "Down"} in round `
      + `${picked!.round}.`, LEFT_IN_ROUNDS);
  });
  if (!market?.choices.length) return <p className="text-muted">No rounds are open yet.</p>;
  const blocked = stakeBlock(market.rules, openStakes, held ?? null, side, micro ?? 0n);
  const ready = picked && micro !== null && micro > 0n && micro <= available && !blocked && !heldLoading
    && !step.busy;
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Stake as the agent</h4>
    <div className="agent-row">
      <label className="sr-only" htmlFor={`series-${agentId}`}>Series</label>
      <select id={`series-${agentId}`} className="agent-select" value={choice}
        onChange={(e) => setChoice(Number(e.target.value))}>
        {market.choices.map((s) => <option key={s.id} value={s.id}>{s.asset}, round {s.round}</option>)}
      </select>
      <div role="group" aria-label="Side" className="segmented">
        {(["up", "down"] as const).map((s) => <button key={s} type="button" aria-pressed={side === s}
          onClick={() => setSide(s)}>{s === "up" ? "Up" : "Down"}</button>)}
      </div>
      <div className="field agent-amount">
        <input aria-label="Amount to stake" inputMode="decimal" placeholder="0.00" value={amount}
          onChange={(e) => setAmount(e.target.value)} className="num" />
      </div>
      <Button onClick={stake} disabled={!ready}>{step.busy ? "Staking" : "Stake"}</Button>
    </div>
    {blocked && <p className="text-muted" role="status">{blocked}</p>}
    <StepNotice step={step} />
  </div>;
}

interface ActProps {
  label: string;
  agentId: string;
  action: AgentAction;
  onDone: () => void;
  variant?: "primary" | "secondary";
}

function Act({ label, agentId, action, onDone, variant = "secondary" }: ActProps) {
  const step = useStep();
  const act = () => step.run(async () => {
    const result = await runAction(agentId, actionKey(), action);
    onDone();
    return report(result.state, "Done.");
  });
  return <div>
    <Button variant={variant} onClick={act} disabled={step.busy}>{step.busy ? "Working" : label}</Button>
    <StepNotice step={step} />
  </div>;
}

const LABELS: Record<string, string> = {
  stake: "Stake", claim: "Claim", withdraw: "Withdrawal from rounds", cash_out: "Cash out",
};
const describe = (op: AgentOperation) => {
  const a = op.action;
  if (a?.kind === "stake") return `Stake ${money(a.amount)} on ${a.side === "up" ? "Up" : "Down"}, round ${a.round}`;
  if (a && "amount" in a) return `${LABELS[a.kind] ?? a.kind} of ${money(a.amount)}`;
  return a ? LABELS[a.kind] ?? a.kind : op.kind;
};

type Placed = { series: number; round: string };
const placed = (op: AgentOperation, kind: "stake" | "claim"): Placed | null =>
  op.state === "confirmed" && op.action?.kind === kind ? { series: op.action.series, round: op.action.round } : null;
const roundKey = (p: Placed) => `${p.series}:${p.round}`;

async function history(agentId: string, rounds: string | null) {
  const operations = await agentOperations(agentId);
  const claimed = new Set(operations.map((o) => placed(o, "claim")).filter((p) => p !== null).map(roundKey));
  const open = operations.map((o) => placed(o, "stake"))
    .filter((p): p is Placed => p !== null && !claimed.has(roundKey(p)));
  const claimable = new Set<string>();
  if (rounds) await Promise.all(open.map(async (p) => {
    const round = await view<{ outcome: unknown } | null>(rounds, "get_round", { series_id: p.series, round: p.round });
    if (round?.outcome) claimable.add(roundKey(p));
  }));
  return { operations, claimable };
}

const LABEL: Record<ActionOutcome, [string, string]> = {
  done: ["Done", "final"], refused: ["Did not go through", "attention"], review: ["Needs a check", "attention"],
  settling: ["In progress", "neutral"],
};

function History({ agentId, rounds, onDone }: { agentId: string; rounds: string | null; onDone: () => void }) {
  const { data, reload } = usePoll(() => history(agentId, rounds), [agentId, rounds], 8000);
  if (!data?.operations.length) return null;
  const claimed = () => {
    reload();
    onDone();
  };
  return <div className="agent-panel">
    <h4 className="agent-panel-title">History</h4>
    <ul className="agent-history">
      {data.operations.map((op) => {
        const stake = placed(op, "stake"), [label, tone] = LABEL[outcomeOf(op.state)];
        return <li key={op.id}>
          <span>{describe(op)}</span>
          <span className="status-pill" data-tone={tone}>{label}</span>
          {stake && data.claimable.has(roundKey(stake)) &&
            <Act label="Claim" agentId={agentId} action={{ kind: "claim", ...stake }} onDone={claimed} />}
        </li>;
      })}
    </ul>
  </div>;
}

interface LeaveProps { agentId: string; inRounds: bigint; inIntents: bigint; onDone: () => void }

function Leave({ agentId, inRounds, inIntents, onDone }: LeaveProps) {
  if (inRounds === 0n && inIntents === 0n) return null;
  const withdraw: AgentAction = { kind: "withdraw", contract: "rounds", amount: inRounds.toString() };
  const cashOut: AgentAction = { kind: "cash_out", amount: inIntents.toString() };
  return <div className="agent-panel agent-row">
    {inRounds > 0n &&
      <Act label={`Withdraw ${money(inRounds)} from rounds`} agentId={agentId} action={withdraw} onDone={onDone} />}
    {inIntents > 0n &&
      <Act label={`Cash out ${money(inIntents)} to your wallet`} agentId={agentId} action={cashOut} onDone={onDone} />}
  </div>;
}

interface DeskProps { agentId: string; account: string; owner: string; setup: AgentsSetup; frozen: boolean }

export function AgentDesk({ agentId, account, owner, setup, frozen }: DeskProps) {
  const deps = [account, owner, setup.token, setup.rounds];
  const { data, error, reload } = usePoll(() => desk(account, owner, setup), deps, 6000);
  if (!data) {
    return error ? <Notice tone="danger">Could not read the agent&apos;s balances. Check your connection.</Notice>
      : <p className="text-muted" role="status">Reading the agent&apos;s balances</p>;
  }
  const inRounds = BigInt(data.rounds?.available ?? "0"), inIntents = BigInt(data.inIntents);
  const registered = data.rounds?.registered === true;
  return <div className="agent-desk">
    <dl className="agent-balances">
      <div><dt>NEAR for gas</dt><dd className="num">{nearText(data.near)}</dd></div>
      <div><dt>In rounds</dt><dd className="num">{money(inRounds)}</dd></div>
      <div><dt>In its NEAR Intents balance</dt><dd className="num">{money(inIntents)}</dd></div>
    </dl>
    {frozen && <Notice tone="warning">
      This agent is frozen, so it stakes nothing. It can still claim, withdraw and cash out to you.
    </Notice>}
    {!frozen && setup.rounds && <>
      <Funding account={account} owner={owner} rounds={setup.rounds} token={setup.token} held={data}
        registered={registered} reload={reload} />
      {data.rounds && !registered &&
        <Register account={account} owner={owner} rounds={setup.rounds} reload={reload} />}
      {registered && <Stake rounds={setup.rounds} agentId={agentId} account={account} available={inRounds}
        openStakes={data.rounds!.open_stakes} onDone={reload} />}
    </>}
    <Leave agentId={agentId} inRounds={inRounds} inIntents={inIntents} onDone={reload} />
    <History agentId={agentId} rounds={setup.rounds} onDone={reload} />
  </div>;
}
