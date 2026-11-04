"use client";

import { useState } from "react";
import { Button, Notice } from "./ui";
import { useWallet } from "./WalletProvider";
import { AgentAccess } from "./AgentAccess";
import { AgentDesk } from "./AgentDesk";
import { StepNotice, useStep } from "./AgentStep";
import { config } from "@/lib/config";
import { useNow } from "@/lib/hooks";
import {
  createAgent, freezeAgent, issueGrant, revokeGrants, signAndFollow, type AgentsSetup, type AgentView,
  type IntentStatus, type OwnerIntent,
} from "@/lib/agents";

const NATIVE_WARNING = "Native methods are for advanced users and are not protected by this account's policy: "
  + "destinations, budget, timelock, schedule and owner approval don't apply. A NEAR transfer can go to any account. "
  + "A signed EVM or Solana transaction, or EVM typed data such as a permit, can move everything at that address. "
  + "Only switch on what the agent needs, for services you trust; a service may treat a signed message as you "
  + "logging in.";
const NAME = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;

function outcome(s: IntentStatus) {
  if (s.status === "SUCCESS") return "Signed and applied.";
  if (s.status === "PENDING_SIGNATURE") return "Not signed yet.";
  if (s.status === "NEEDS_REVIEW") {
    return "The agent service is reviewing this request. It will show here once it is settled.";
  }
  if (s.status === "FAILED" || s.status === "REFUNDED") {
    throw new Error(`The request did not go through${s.failure_code ? ` (${s.failure_code})` : ""}.`);
  }
  return "Signed. Waiting for it to land; this page updates on its own.";
}

function SignIntent({ generated, onDone }: { generated: OwnerIntent; onDone: () => void }) {
  const { signer } = useWallet();
  const step = useStep();
  const expired = Date.parse(generated.expires_at) <= useNow(5000);
  const sign = () => step.run(async () => {
    const status = await signAndFollow(generated, await signer());
    onDone();
    return outcome(status);
  });
  return <div className="agent-step">
    <p className="agent-summary">{generated.preview.summary}</p>
    {expired
      ? <p className="text-muted">This request expired before it was signed. Start it again.</p>
      : <Button onClick={sign} disabled={step.busy}>
        {step.busy ? "Waiting for your wallet" : "Sign with your wallet"}
      </Button>}
    <StepNotice step={step} />
  </div>;
}

function Rules({ owner }: { owner: string }) {
  const symbol = config.tokenSymbol;
  return <>
    <p>Your wallet owns the account and signs the rules it follows. Within them, Dragons Market acts for it:</p>
    <ul className="agent-rules">
      <li>It calls only the market and rounds contracts, from the agent&apos;s NEAR account. It never holds {symbol}.</li>
      <li>
        Your wallet sends {symbol} straight into the agent&apos;s market and rounds balances. Those pay out only into
        its NEAR Intents balance, and that pays out to <span className="mono">{owner}</span> and nowhere else.
      </li>
      <li>What you fund into those balances is what its trades can lose, so fund only what it should trade.</li>
      <li>You can stop Dragons Market or freeze the agent at any time, from this page.</li>
    </ul>
    <Notice tone="warning">{NATIVE_WARNING}</Notice>
  </>;
}

export function CreateAgent({ owner, first, onCreated }: { owner: string; first: boolean; onCreated: () => void }) {
  const [name, setName] = useState("Dragons agent");
  const [generated, setGenerated] = useState<OwnerIntent | null>(null);
  const step = useStep();
  const prepare = () => step.run(async () => { setGenerated(await createAgent(name)); });
  const signed = () => {
    setGenerated(null);
    onCreated();
  };
  return <section className="agent-create" aria-labelledby="agent-create-title">
    <h2 id="agent-create-title" className="section-title">Open an agent account</h2>
    <Rules owner={owner} />
    {generated ? <SignIntent generated={generated} onDone={signed} /> : <div className="agent-step">
      <label htmlFor="agent-name" className="agent-label">Name</label>
      <div className="field">
        <input id="agent-name" value={name} maxLength={64} autoComplete="off" onChange={(e) => setName(e.target.value)}
          aria-invalid={!NAME.test(name) || undefined} />
      </div>
      <Button variant={first ? "primary" : "secondary"} onClick={prepare} disabled={!NAME.test(name) || step.busy}>
        {step.busy ? "Preparing" : "Review and sign"}
      </Button>
      <StepNotice step={step} />
    </div>}
  </section>;
}

function Authorize({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const [generated, setGenerated] = useState<OwnerIntent | null>(null);
  const step = useStep();
  const signed = () => {
    setGenerated(null);
    onDone();
  };
  if (generated) return <SignIntent generated={generated} onDone={signed} />;
  return <div className="agent-step">
    <p>Authorize Dragons Market to act for this agent within its rules. The authorization lasts 90 days.</p>
    <Button onClick={() => step.run(async () => { setGenerated(await issueGrant(agentId)); })} disabled={step.busy}>
      {step.busy ? "Preparing" : "Authorize Dragons Market"}
    </Button>
    <StepNotice step={step} />
  </div>;
}

function stage(agent: AgentView): [string, string] {
  if (agent.state === "pending") return ["Not open yet", "attention"];
  if (agent.frozen) return ["Frozen", "attention"];
  return agent.authorized_until ? ["Authorized", "open"] : ["Needs authorization", "attention"];
}

function Controls({ agent, reload }: { agent: AgentView; reload: () => void }) {
  const step = useStep();
  const revoke = () => step.run(async () => {
    const asked = await revokeGrants(agent.agent_id);
    reload();
    return asked.length ? "Dragons Market has stopped. Sign below to revoke it at the agent service too."
      : "Dragons Market has stopped acting for this agent.";
  });
  const freeze = () => step.run(async () => {
    await freezeAgent(agent.agent_id, !agent.frozen);
    reload();
    return "Sign below to apply it.";
  });
  return <div className="agent-step">
    <div className="agent-row">
      {agent.authorized_until && <Button variant="secondary" onClick={revoke} disabled={step.busy}>
        Stop Dragons Market
      </Button>}
      <Button variant="secondary" onClick={freeze} disabled={step.busy}>
        {agent.frozen ? "Unfreeze agent" : "Freeze agent"}
      </Button>
    </div>
    <StepNotice step={step} />
  </div>;
}

interface CardProps { agent: AgentView; owner: string; setup: AgentsSetup; reload: () => void }

function NextStep({ agent, owner, setup, reload }: CardProps) {
  const open = agent.open_intents.at(-1);
  if (open?.status === "PENDING_SIGNATURE") return <SignIntent generated={open.generated} onDone={reload} />;
  const waiting = (text: string) => <p className="text-muted" role="status">{text}</p>;
  if (open) return waiting("Signed. Waiting for the agent service to apply it.");
  if (agent.state === "pending") return waiting("Waiting for the agent account to open.");
  if (!agent.authorized_until) return <Authorize agentId={agent.agent_id} onDone={reload} />;
  return <>
    <AgentDesk agentId={agent.agent_id} account={agent.near_account_id!} owner={owner} setup={setup}
      frozen={agent.frozen} />
    <AgentAccess agentId={agent.agent_id} />
  </>;
}

export function AgentCard(props: CardProps) {
  const { agent, reload } = props;
  const [label, tone] = stage(agent);
  return <article className="agent-card">
    <header className="agent-card-head">
      <h3 className="agent-name">{agent.name}</h3>
      <span className="status-pill" data-tone={tone}>{label}</span>
    </header>
    {agent.near_account_id && <p className="agent-account">
      <span className="text-muted">Agent account</span> <span className="mono">{agent.near_account_id}</span>
    </p>}
    <NextStep {...props} />
    {agent.state === "active" && <Controls agent={agent} reload={reload} />}
  </article>;
}
