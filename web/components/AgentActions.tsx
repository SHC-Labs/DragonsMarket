"use client";

import { useState } from "react";
import { Button } from "./ui";
import { useWallet } from "./WalletProvider";
import { StepNotice, useStep } from "./AgentStep";
import { config } from "@/lib/config";
import { friendlyError, shortRef } from "@/lib/errors";
import { formatMoney, toMicro } from "@/lib/format";
import { txPanics, view } from "@/lib/rpc";
import {
  actionKey, depositedFor, outcomeOf, refusalMessage, runAction, type ActionResult, type AgentAction, type Venue,
} from "@/lib/agents";

export interface Place { venue: Venue; contract: string; name: string; balance: string; purpose: string }

const MAX_REGISTRATION = 100_000_000_000_000_000_000_000n;
const TGAS_30 = "30000000000000";
const TGAS_300 = "300000000000000";
const SEE_HISTORY = "The details are in the history below.";
const SETTLING = "It was sent and is still settling. Check the history before trying again.";
const STOPPED = "Dragons Market could not prove whether it went through, so it stopped it for a check. Look at the "
  + "agent's balances before trying again.";
const UNREAD = "Your wallet sent it, but its result could not be read. Check the agent's balances before sending again.";

export const money = (micro: string | bigint) => `${formatMoney(micro)} ${config.tokenSymbol}`;

export function report(result: ActionResult, done: string, refused = `That did not go through. ${SEE_HISTORY}`) {
  const outcome = outcomeOf(result.state);
  if (outcome === "refused") throw new Error(refusalMessage(result.evidence?.code) ?? refused);
  if (outcome === "review") throw new Error(STOPPED);
  return outcome === "done" ? done : SETTLING;
}

export const unconfirmed = () => {
  throw new Error("Your wallet did not confirm it sent this. Check the agent's balances before sending again.");
};

async function credited(hash: string, owner: string, place: Place, agent: string) {
  const amount = await depositedFor(hash, owner, place.contract, agent, place.venue)
    .catch(() => { throw new Error(UNREAD); });
  if (amount !== null) return `Sent ${money(amount)} into the agent's ${place.balance}.`;
  const panic = (await txPanics(hash, owner).catch(() => []))[0];
  throw new Error(`The ${place.balance} did not credit it. A refused transfer goes back to your wallet, so check your `
    + `wallet and the agent's balances before sending again.${panic ? ` ${friendlyError(panic, shortRef(hash))}` : ""}`);
}

const call = (methodName: string, args: Record<string, unknown>, deposit: string, gas = TGAS_30) =>
  ({ type: "FunctionCall" as const, params: { methodName, args, gas, deposit } });

interface FundingProps {
  account: string; owner: string; place: Place; token: string; inWallet: string; least: bigint | null;
  reload: () => void;
}

export function Funding({ account, owner, place, token, inWallet, least, reload }: FundingProps) {
  const { sendTransaction } = useWallet();
  const [amount, setAmount] = useState("");
  const step = useStep();
  const micro = toMicro(amount);
  const send = () => step.run(async () => {
    const hash = await sendTransaction(token, [call("ft_transfer_call",
      { receiver_id: place.contract, amount: micro!.toString(), msg: `deposit_for:${account}` }, "1", TGAS_300)])
      .catch(unconfirmed);
    setAmount("");
    reload();
    return credited(hash, owner, place, account);
  });
  const enough = micro !== null && least !== null && micro >= least && micro <= BigInt(inWallet);
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Fund the {place.balance}</h4>
    <p className="text-muted">
      It needs {config.tokenSymbol} in its {place.balance} to {place.purpose}. You have {money(inWallet)} in your
      wallet{least !== null && <>, and send at least {money(least)}</>}.
    </p>
    <div className="agent-row">
      <div className="field agent-amount">
        <input aria-label={`${config.tokenSymbol} to send to ${place.name}`} inputMode="decimal" placeholder="0.00"
          value={amount} onChange={(e) => setAmount(e.target.value)} className="num" />
      </div>
      <Button variant="secondary" onClick={send} disabled={!enough || step.busy}>
        Send {config.tokenSymbol} to {place.name}
      </Button>
    </div>
    <StepNotice step={step} />
  </div>;
}

interface RegisterProps { account: string; owner: string; place: Place; reload: () => void }

export function Register({ account, owner, place, reload }: RegisterProps) {
  const { sendTransaction } = useWallet();
  const step = useStep();
  const register = () => step.run(async () => {
    const { storage_deposit: asked } = await view<{ storage_deposit: string }>(place.contract, "config");
    if (BigInt(asked) > MAX_REGISTRATION) {
      throw new Error(`${place.name} asked for more than 0.1 NEAR to register, so nothing was sent.`);
    }
    const hash = await sendTransaction(place.contract, [call("storage_deposit", { account_id: account }, asked)])
      .catch(unconfirmed);
    reload();
    const panics = await txPanics(hash, owner).catch(() => { throw new Error(UNREAD); });
    if (panics[0]) throw new Error(`The agent was not registered. ${friendlyError(panics[0], shortRef(hash))}`);
    return `Registered the agent with ${place.name}.`;
  });
  return <div className="agent-panel">
    <p className="text-muted">
      Registering with {place.name} keeps 0.05 NEAR from your wallet while the agent takes part, and returns it to you
      when it leaves.
    </p>
    <div>
      <Button variant="secondary" onClick={register} disabled={step.busy}>
        {step.busy ? "Waiting for your wallet" : `Register with ${place.name}`}
      </Button>
    </div>
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

export function Act({ label, agentId, action, onDone, variant = "secondary" }: ActProps) {
  const step = useStep();
  const act = () => step.run(async () => {
    const result = await runAction(agentId, actionKey(), action);
    onDone();
    return report(result, "Done.");
  });
  return <div>
    <Button variant={variant} onClick={act} disabled={step.busy}>{step.busy ? "Working" : label}</Button>
    <StepNotice step={step} />
  </div>;
}
