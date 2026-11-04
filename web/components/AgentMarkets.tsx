"use client";

import { useState } from "react";
import { Button } from "./ui";
import { StepNotice, useStep } from "./AgentStep";
import { Act, Funding, Register, money, report, type Place } from "./AgentActions";
import { formatShares, minSharesWithSlippage, toMicro } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { view } from "@/lib/rpc";
import {
  actionKey, heldPositions, openMarkets, runAction, type HeldPosition, type OpenMarket,
} from "@/lib/agents";

type Answer = "yes" | "no";
interface MarketAccount { registered: boolean; available: string; pending_withdrawals: string; positions: number | null }

const LEAST_DEPOSIT = 100_000n;
const LEFT_IN_MARKET = "The market did not take that. The money is still in the agent's market balance.";
const SELLABLE = new Set(["open", "halted"]);
const answerName = (side: Answer) => (side === "yes" ? "Yes" : "No");
const cents = (price: string) => `${Math.round(Number(price) / 10_000)}¢`;

interface BuyProps {
  contract: string; agentId: string; available: bigint; choices: OpenMarket[]; onDone: () => void;
}

function Buy({ contract, agentId, available, choices, onDone }: BuyProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [side, setSide] = useState<Answer>("yes");
  const [amount, setAmount] = useState("");
  const step = useStep();
  const market = choices.find((m) => m.id === picked) ?? choices[0];
  const micro = toMicro(amount);
  const buy = () => step.run(async () => {
    const asked = { market_id: market!.id, side, amount: micro!.toString() };
    const { shares_out: shares } = await view<{ shares_out: string }>(contract, "quote_buy", asked);
    if (BigInt(shares) === 0n) throw new Error("This market cannot take that amount. Try a smaller one.");
    const result = await runAction(agentId, actionKey(), { kind: "buy", market: market!.id, side, amount: asked.amount,
      minShares: minSharesWithSlippage(BigInt(shares)).toString() });
    setAmount("");
    onDone();
    return report(result, `Bought ${answerName(side)} with ${money(micro!)}.`, LEFT_IN_MARKET);
  });
  if (!market) return <p className="text-muted">No markets are open to trade right now.</p>;
  const ready = micro !== null && micro > 0n && micro <= available && !step.busy;
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Buy as the agent</h4>
    <div className="agent-row">
      <label className="sr-only" htmlFor={`market-${agentId}`}>Market</label>
      <select id={`market-${agentId}`} className="agent-select" value={market.id}
        onChange={(e) => setPicked(e.target.value)}>
        {choices.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
      </select>
      <div role="group" aria-label="Answer" className="segmented">
        {(["yes", "no"] as const).map((option) => <button key={option} type="button" aria-pressed={side === option}
          onClick={() => setSide(option)}>
          {answerName(option)} {cents(option === "yes" ? market.price_yes : market.price_no)}
        </button>)}
      </div>
      <div className="field agent-amount">
        <input aria-label="Amount to buy" inputMode="decimal" placeholder="0.00" value={amount}
          onChange={(e) => setAmount(e.target.value)} className="num" />
      </div>
      <Button onClick={buy} disabled={!ready}>{step.busy ? "Buying" : "Buy"}</Button>
    </div>
    <StepNotice step={step} />
  </div>;
}

interface SellProps { contract: string; agentId: string; market: string; side: Answer; held: bigint; onDone: () => void }

function Sell({ contract, agentId, market, side, held, onDone }: SellProps) {
  const [input, setInput] = useState("");
  const step = useStep();
  const shares = toMicro(input);
  const sell = () => step.run(async () => {
    const quote = await view<{ collateral_out: string; fee: string }>(contract, "quote_sell",
      { market_id: market, side, shares: shares!.toString() });
    const net = BigInt(quote.collateral_out) - BigInt(quote.fee);
    if (net <= 0n) throw new Error("The market cannot take that sell. Try a different amount.");
    const result = await runAction(agentId, actionKey(), { kind: "sell", market, side, shares: shares!.toString(),
      minCollateral: minSharesWithSlippage(net).toString() });
    setInput("");
    onDone();
    return report(result, `Sold ${formatShares(shares!)} ${answerName(side)} shares.`);
  });
  const ready = shares !== null && shares > 0n && shares <= held && !step.busy;
  return <div className="agent-row">
    <span>{formatShares(held)} {answerName(side)} shares</span>
    <div className="field agent-amount">
      <input aria-label={`${answerName(side)} shares to sell`} inputMode="decimal" placeholder="Shares" value={input}
        onChange={(e) => setInput(e.target.value)} className="num" />
    </div>
    <Button variant="secondary" size="sm" onClick={sell} disabled={!ready}>{step.busy ? "Selling" : "Sell"}</Button>
    <StepNotice step={step} />
  </div>;
}

interface PositionsProps { contract: string; agentId: string; positions: HeldPosition[]; onDone: () => void }

function Positions({ contract, agentId, positions, onDone }: PositionsProps) {
  if (!positions.length) return null;
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Positions</h4>
    {positions.map((p) => <div key={p.market_id} className="agent-position">
      <p>{p.title}</p>
      {SELLABLE.has(p.status) && (["yes", "no"] as const).filter((side) => BigInt(p[side]) > 0n).map((side) =>
        <Sell key={side} contract={contract} agentId={agentId} market={p.market_id} side={side} held={BigInt(p[side])}
          onDone={onDone} />)}
      {p.status === "resolved" && <Act label={`Redeem ${money(p.redeemable)}`} agentId={agentId}
        action={{ kind: "redeem", market: p.market_id }} onDone={onDone} />}
      {!SELLABLE.has(p.status) && p.status !== "resolved" &&
        <p className="text-muted">Trading has closed. It can be redeemed once the market resolves.</p>}
    </div>)}
  </div>;
}

interface AgentMarketsProps {
  place: Place; agentId: string; account: string; owner: string; token: string; inWallet: string;
  held: MarketAccount | null; onDone: () => void;
}

export function AgentMarkets({ place, agentId, account, owner, token, inWallet, held, onDone }: AgentMarketsProps) {
  const load = () => Promise.all([openMarkets(place.contract), heldPositions(place.contract, account)])
    .then(([choices, positions]) => ({ choices, positions }));
  const { data, reload } = usePoll(load, [place.contract, account], 10000);
  if (!held) return null;
  if (!held.registered) return <Register account={account} owner={owner} place={place} reload={onDone} />;
  const traded = () => {
    reload();
    onDone();
  };
  return <>
    <Funding account={account} owner={owner} place={place} token={token} inWallet={inWallet} least={LEAST_DEPOSIT}
      reload={onDone} />
    {data && <Buy contract={place.contract} agentId={agentId} available={BigInt(held.available)}
      choices={data.choices} onDone={traded} />}
    {data && <Positions contract={place.contract} agentId={agentId} positions={data.positions} onDone={traded} />}
  </>;
}
