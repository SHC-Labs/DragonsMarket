"use client";

import { AccountEmptyState, PageLandmark } from "@/components/PageHeader";
import { AgentCard, CreateAgent } from "@/components/AgentCard";
import { StepNotice, useStep } from "@/components/AgentStep";
import { Button, Notice } from "@/components/ui";
import { useWallet } from "@/components/WalletProvider";
import { usePoll } from "@/lib/hooks";
import { currentSession } from "@/lib/backend";
import { agentsSetup, refreshAgents, type AgentsSetup } from "@/lib/agents";

function Failed({ what, retry }: { what: string; retry: () => void }) {
  return <Notice tone="danger">
    <span>{what} </span><Button variant="ghost" size="sm" onClick={retry}>Retry</Button>
  </Notice>;
}

function AgentList({ owner, setup }: { owner: string; setup: AgentsSetup }) {
  const { data, error, reload } = usePoll(refreshAgents, [owner], 5000);
  if (!data) {
    return error ? <Failed what="Could not load your agents." retry={reload} />
      : <p className="text-muted" role="status">Loading your agents</p>;
  }
  return <>
    {data.length > 0 && <section className="agent-list" aria-label="Your agents">
      {data.map((agent) =>
        <AgentCard key={agent.agent_id} agent={agent} owner={owner} setup={setup} reload={reload} />)}
    </section>}
    {data.length < 3 && <CreateAgent owner={owner} first={data.length === 0} onCreated={reload} />}
  </>;
}

function SignInPrompt({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const { signInToBackend } = useWallet();
  const step = useStep();
  const sign = () => step.run(async () => {
    await signInToBackend();
    await onSignedIn();
  });
  return <section className="agent-intro">
    <h2 className="section-title">Trade through an agent</h2>
    <p>
      An agent account is a NEAR Intents wallet that your wallet owns. You sign the rules it follows; Dragons Market
      then stakes, claims and cashes out for it within them.
    </p>
    <p className="text-muted">
      First, sign a message to start a Dragons Market session. It does not authorize any transaction.
    </p>
    <Button onClick={sign} disabled={step.busy}>
      {step.busy ? "Waiting for your wallet" : "Sign in to Dragons Market"}
    </Button>
    <StepNotice step={step} />
  </section>;
}

const ownerState = () => Promise.all([agentsSetup(), currentSession().catch(() => null)])
  .then(([setup, session]) => ({ setup, session }));

function OwnerAgents({ account }: { account: string }) {
  const { data, error, reload } = usePoll(ownerState, [account], 60000);
  if (!data) {
    return error ? <Failed what="Could not reach Dragons Market." retry={reload} />
      : <p className="text-muted" role="status">Checking your session</p>;
  }
  if (!data.setup) return <Notice>Agent accounts are coming soon.</Notice>;
  if (data.session !== account) return <SignInPrompt onSignedIn={reload} />;
  return <AgentList owner={account} setup={data.setup} />;
}

export function AgentsView() {
  const { account, openConnect, walletAvailable } = useWallet();
  const connect = <Button onClick={openConnect} disabled={!walletAvailable}>Connect wallet</Button>;
  const description = "Connect your wallet to open an agent account. You sign the rules it follows, and Dragons "
    + "Market acts for it only within them.";
  return <div className="page-content agents-page">
    <PageLandmark title="Agents" />
    {account ? <OwnerAgents account={account} />
      : <AccountEmptyState title="Trade through an agent" description={description} actions={connect} />}
  </div>;
}
