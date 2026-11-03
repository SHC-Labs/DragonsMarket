"use client";

import { useState } from "react";
import { Button, Notice } from "./ui";
import { StepNotice, useStep } from "./AgentStep";
import { config } from "@/lib/config";
import { formatMoney, toMicro } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { accessTokens, giveAccess, revokeAccess, type IssuedAccess } from "@/lib/agents";

const LABEL = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;
const money = (micro: string) => `${formatMoney(micro)} ${config.tokenSymbol}`;
const endpoint = (path: string) => `${config.mcpUrl.replace(/\/$/, "")}${path}`;

function Issued({ issued, onDone }: { issued: IssuedAccess; onDone: () => void }) {
  return <div className="agent-panel">
    <Notice tone="warning">
      Copy the token now. It is shown only once, and whoever holds it can stake for this agent within the limits
      you set.
    </Notice>
    <dl className="agent-connect">
      <div><dt>MCP server</dt><dd className="mono">{endpoint("/mcp")}</dd></div>
      <div><dt>Header</dt><dd className="mono">Authorization: Bearer {issued.token}</dd></div>
      <div><dt>Skill</dt><dd className="mono">{endpoint("/skill.md")}</dd></div>
    </dl>
    <p className="text-muted">
      {issued.label} may stake {money(issued.max_stake)} at a time and {money(issued.daily_limit)} in any 24 hours,
      until {new Date(issued.expires_at).toLocaleDateString()}.
    </p>
    <div><Button variant="secondary" onClick={onDone}>I have copied it</Button></div>
  </div>;
}

export function AgentAccess({ agentId }: { agentId: string }) {
  const { data: tokens, reload } = usePoll(() => accessTokens(agentId), [agentId], 30000);
  const [label, setLabel] = useState("My AI agent");
  const [perStake, setPerStake] = useState("");
  const [perDay, setPerDay] = useState("");
  const [issued, setIssued] = useState<IssuedAccess | null>(null);
  const step = useStep();
  const max = toMicro(perStake), day = toMicro(perDay);
  const valid = LABEL.test(label) && max !== null && max > 0n && day !== null && day >= max;
  const give = () => step.run(async () => {
    setIssued(await giveAccess(agentId, label, max!.toString(), day!.toString()));
    reload();
  });
  const revoke = (id: string) => step.run(async () => {
    await revokeAccess(agentId, id);
    reload();
    return "That connection no longer works.";
  });
  if (!config.mcpUrl) return null;
  if (issued) return <Issued issued={issued} onDone={() => setIssued(null)} />;
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Connect an AI agent</h4>
    <p className="text-muted">
      Give an AI agent this account through the Dragons Market MCP server. It stakes only from the rounds balance,
      only within your limits, and pays out only to you.
    </p>
    <div className="agent-row">
      <div className="field agent-amount">
        <input aria-label="Name for this connection" value={label} maxLength={64} autoComplete="off"
          onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="field agent-amount">
        <input aria-label={`Most ${config.tokenSymbol} for one stake`} inputMode="decimal" placeholder="Per stake"
          value={perStake} onChange={(e) => setPerStake(e.target.value)} className="num" />
      </div>
      <div className="field agent-amount">
        <input aria-label={`Most ${config.tokenSymbol} in 24 hours`} inputMode="decimal" placeholder="Per 24 hours"
          value={perDay} onChange={(e) => setPerDay(e.target.value)} className="num" />
      </div>
      <Button variant="secondary" onClick={give} disabled={!valid || step.busy}>Give access</Button>
    </div>
    <StepNotice step={step} />
    {tokens && tokens.length > 0 && <ul className="agent-history">
      {tokens.map((t) => <li key={t.id}>
        <span>{t.label}: {money(t.max_stake)} a stake, {money(t.daily_limit)} in 24 hours</span>
        <Button variant="secondary" size="sm" onClick={() => revoke(t.id)} disabled={step.busy}>Revoke</Button>
      </li>)}
    </ul>}
  </div>;
}
