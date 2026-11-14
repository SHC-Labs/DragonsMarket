"use client";

import { useState } from "react";
import { Button } from "./ui";
import { useWallet } from "./WalletProvider";
import { StepNotice, useStep } from "./AgentStep";
import { config } from "@/lib/config";
import { depositForCall, fundCall, tokenBalance } from "@/lib/market";
import { usePoll, useTx } from "@/lib/hooks";
import { TransactionNotice } from "./TransactionNotice";
import { formatMoney, toMicro } from "@/lib/format";
import { view } from "@/lib/rpc";
import {
  actionKey, depositedFor, outcomeOf, refusalMessage, runAction, type ActionResult, type AgentAction, type Venue,
} from "@/lib/agents";

export interface Place { venue: Venue; contract: string; name: string; balance: string; purpose: string }

const MAX_REGISTRATION = 100_000_000_000_000_000_000_000n;
const SEE_HISTORY = "The details are in the history below.";
const SETTLING = "It was sent and is still settling. Check the history before trying again.";
const STOPPED = "Dragons Market could not prove whether it went through, so it stopped it for a check. Look at the "
  + "agent's balances before trying again.";

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

interface FundingProps {
  account: string; owner: string; place: Place; token: string; inWallet: string; least: bigint | null;
  reload: () => void;
}

export function Funding({ account, owner, place, token, inWallet, least, reload }: FundingProps) {
  const { send: walletSend, account: connected } = useWallet();
  const [amount, setAmount] = useState("");
  const tx = useTx(walletSend, owner);
  const intents = usePoll(() => tokenBalance(owner), [owner], 6000);
  const micro = toMicro(amount);
  const available = intents.data === null ? null : BigInt(intents.data);
  const shortfall = micro !== null && available !== null && micro > available ? micro - available : 0n;
  const enough = connected === owner && micro !== null && least !== null && available !== null && micro >= least
    && shortfall <= BigInt(inWallet) && token === config.tokenId;
  const send = async () => {
    if (!enough || micro === null) return;
    if (shortfall > 0n) {
      await tx.run(fundCall(owner, shortfall), {
        done: async () => BigInt(await tokenBalance(owner)) >= micro,
        doneMessage: "Funds are in your own Intents balance. Now confirm the transfer to the agent.",
      });
    } else {
      const confirmed = await tx.run(depositForCall(place.contract, account, micro), {
        done: async hash => await depositedFor(hash, owner, place.contract, account, place.venue) === micro,
        doneMessage: `Credited ${money(micro)} to the agent's ${place.balance}.`,
      });
      if (confirmed) setAmount("");
    }
    await intents.reload();
    reload();
  };
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Fund the {place.balance}</h4>
    <p className="text-muted">
      First add {config.tokenSymbol} to your own Intents balance, then transfer it to the agent’s {place.balance}.
      You have {money(inWallet)} in your wallet and {available === null ? "an unavailable balance" : money(available)} in Intents.
      {least !== null && <> Send at least {money(least)}.</>}
    </p>
    <div className="agent-row">
      <div className="field agent-amount">
        <input aria-label={`${config.tokenSymbol} to send to ${place.name}`} inputMode="decimal" placeholder="0.00"
          value={amount} onChange={(e) => setAmount(e.target.value)} className="num" />
      </div>
      <Button variant="secondary" onClick={send} disabled={!enough || tx.busy}>
        {shortfall > 0n ? `Add ${config.tokenSymbol} to your Intents balance` : `Send ${config.tokenSymbol} to ${place.name}`}
      </Button>
    </div>
    <TransactionNotice tx={tx} />
  </div>;
}

interface RegisterProps { account: string; owner: string; place: Place; reload: () => void }

export function Register({ account, owner, place, reload }: RegisterProps) {
  const { send, account: connected } = useWallet();
  const tx = useTx(send, owner);
  const [error, setError] = useState<string | null>(null);
  const register = async () => {
    if (connected !== owner) return;
    setError(null);
    try {
      const { storage_deposit: asked } = await view<{ storage_deposit: string }>(place.contract, "config");
      if (!/^[0-9]{1,24}$/.test(asked) || BigInt(asked) > MAX_REGISTRATION) {
        throw new Error(`${place.name} asked for an invalid registration deposit; nothing was sent.`);
      }
      await tx.run({ receiverId: place.contract, methodName: "storage_deposit", args: { account_id: account },
        gas: "30000000000000", deposit: asked }, {
        done: () => view<boolean>(place.contract, "is_registered", { account_id: account }),
        doneMessage: `Registered the agent with ${place.name}.`,
      });
      reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read registration settings."); }
  };
  return <div className="agent-panel">
    <p className="text-muted">Register with {place.name} so it can store the agent’s balances and positions.
      Your wallet will show the required NEAR storage deposit before you sign.</p>
    <Button variant="secondary" onClick={register} disabled={tx.busy || connected !== owner}>Register with {place.name}</Button>
    {error && <p role="alert">{error}</p>}
    <TransactionNotice tx={tx} />
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
