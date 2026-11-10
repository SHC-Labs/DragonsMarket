"use client";

import { useState } from "react";
import { Button, Notice } from "./ui";
import { useWallet } from "./WalletProvider";
import { StepNotice, useStep } from "./AgentStep";
import { config } from "@/lib/config";
import { formatMoney, toMicro } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { Bot } from "./icons";
import {
  accessTokens, requestAccess, revokeAccess, signAccess, type AccessRequest, type IssuedAccess,
} from "@/lib/agents";

const LABEL = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;
const money = (micro: string) => `${formatMoney(micro)} ${config.tokenSymbol}`;
const endpoint = (path: string) => `${config.mcpUrl.replace(/\/$/, "")}${path}`;

function Issued({ issued, onDone }: { issued: IssuedAccess; onDone: () => void }) {
  return <div className="agent-panel">
    <Notice tone="warning">
      Copy the token now. It is shown only once, and whoever holds it can trade for this agent within the limits
      you set.
    </Notice>
    <dl className="agent-connect">
      <div><dt>MCP server</dt><dd className="mono">{endpoint("/mcp")}</dd></div>
      <div><dt>Header</dt><dd className="mono">Authorization: Bearer {issued.token}</dd></div>
      <div><dt>Skill</dt><dd className="mono">{endpoint("/skill.md")}</dd></div>
    </dl>
    <p className="text-muted">
      {issued.label} may spend {money(issued.max_spend)} at a time and {money(issued.daily_limit)} in any 24 hours,
      until {new Date(issued.expires_at).toLocaleDateString()}. These limits cover buys and stakes. It can also sell
      what the agent holds. Dragons Market enforces these connection limits before calling the Agent API;
      they do not change the account&apos;s separate custody policy.
    </p>
    <div><Button variant="secondary" onClick={onDone}>I have copied it</Button></div>
  </div>;
}

interface SignProps { agentId: string; asked: AccessRequest; onIssued: (issued: IssuedAccess) => void }

function SignRequest({ agentId, asked, onIssued }: SignProps) {
  const { signer } = useWallet();
  const step = useStep();
  const sign = () => step.run(async () => { onIssued(await signAccess(agentId, asked, await signer())); });
  return <div className="agent-panel">
    <h4 className="agent-panel-title">Sign to give access</h4>
    <p className="agent-summary">{asked.message}</p>
    <div>
      <Button variant="secondary" onClick={sign} disabled={step.busy}>
        {step.busy ? "Waiting for your wallet" : "Sign with your wallet"}
      </Button>
    </div>
    <StepNotice step={step} />
  </div>;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB",
  { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

function Endpoints() {
  return <dl className="agent-connect">
    <div><dt>MCP server</dt><dd className="mono">{endpoint("/mcp")}</dd></div>
    <div><dt>Skill</dt><dd className="mono">{endpoint("/skill.md")}</dd></div>
  </dl>;
}

export function AgentAccess({ agentId }: { agentId: string }) {
  const { data: tokens, reload } = usePoll(() => accessTokens(agentId), [agentId], 30000);
  const [label, setLabel] = useState("My AI agent");
  const [perTrade, setPerTrade] = useState("");
  const [perDay, setPerDay] = useState("");
  const [asked, setAsked] = useState<AccessRequest | null>(null);
  const [issued, setIssued] = useState<IssuedAccess | null>(null);
  const step = useStep();
  const max = toMicro(perTrade), day = toMicro(perDay);
  const valid = LABEL.test(label) && max !== null && max > 0n && day !== null && day >= max;
  const give = () => step.run(async () => {
    setAsked(await requestAccess(agentId, label, max!.toString(), day!.toString()));
  });
  const revoke = (id: string) => step.run(async () => {
    await revokeAccess(agentId, id);
    reload();
    return "That connection no longer works.";
  });
  const signed = (token: IssuedAccess) => {
    setAsked(null);
    setIssued(token);
    reload();
  };
  if (!config.mcpUrl) return null;
  if (issued) return <Issued issued={issued} onDone={() => setIssued(null)} />;
  if (asked) return <SignRequest agentId={agentId} asked={asked} onIssued={signed} />;
  const symbol = config.tokenSymbol;
  return <div className="agent-access">
    <div className="agent-access-intro">
      <h4 className="agent-panel-title">Connect an AI agent</h4>
      <p className="text-muted">
        Give an AI agent this account through the Dragons Market MCP server. It trades only from the balances you fund
        and pays out only to you. Your limits cover buys and stakes, and it can sell what the agent holds at any time.
        Each connection has its own allowance, enforced by Dragons Market. The Agent API separately checks the
        account policy before execution; it cannot measure a trade from funds already inside a market.
      </p>
      <Endpoints />
    </div>
    <div className="agent-access-main">
      <div role="group" aria-labelledby={`give-${agentId}`} className="agent-form">
        <h5 id={`give-${agentId}`} className="agent-form-title">New connection</h5>
        <div className="agent-access-fields">
          <label className="agent-field">
            <span className="agent-label">Name</span>
            <span className="field">
              <input aria-label="Name for this connection" value={label} maxLength={64} autoComplete="off"
                onChange={(e) => setLabel(e.target.value)} />
            </span>
          </label>
          <label className="agent-field">
            <span className="agent-label">Per trade</span>
            <span className="field">
              <input aria-label={`Most ${symbol} for one stake or buy`} inputMode="decimal" placeholder="0.00"
                value={perTrade} onChange={(e) => setPerTrade(e.target.value)} className="num" />
              <span className="agent-unit" aria-hidden="true">{symbol}</span>
            </span>
          </label>
          <label className="agent-field">
            <span className="agent-label">Per 24 hours</span>
            <span className="field">
              <input aria-label={`Most ${symbol} in 24 hours`} inputMode="decimal" placeholder="0.00"
                value={perDay} onChange={(e) => setPerDay(e.target.value)} className="num" />
              <span className="agent-unit" aria-hidden="true">{symbol}</span>
            </span>
          </label>
          <Button variant="secondary" onClick={give} disabled={!valid || step.busy}>Give access</Button>
        </div>
        <StepNotice step={step} />
      </div>
      <div className="agent-form">
        <h5 className="agent-form-title">Connections</h5>
        {tokens && tokens.length > 0 ? <ul className="agent-tokens">
          {tokens.map((t) => <li key={t.id}>
            <span className="agent-token-mark" aria-hidden="true"><Bot size={20} variant="Bulk" /></span>
            <div className="agent-token-main">
              <p className="agent-token-label">{t.label}</p>
              <p className="agent-token-limits">
                <span className="num">{money(t.max_spend)}</span> a trade, <span className="num">
                  {money(t.daily_limit)}</span> in 24 hours
                {t.last_used_at && <>. Last used {when(t.last_used_at)}</>}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => revoke(t.id)} disabled={step.busy}
              aria-label={`Revoke ${t.label}`}>Revoke</Button>
          </li>)}
        </ul> : <p className="text-muted">{tokens ? "No AI agent is connected yet." : "Reading connections"}</p>}
      </div>
    </div>
  </div>;
}
