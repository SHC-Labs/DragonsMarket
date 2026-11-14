"use client";

import { useNow, usePoll } from "@/lib/hooks";
import { getCase, type Case, type MarketView, type Outcome } from "@/lib/market";
import { formatDateTime, nsToMs } from "@/lib/format";
import { seedHex } from "@/lib/sigil";
import { Sigil } from "./Sigil";
import { AnswerPanel } from "./AnswerPanel";
import { useWallet } from "./WalletProvider";
import { signsWithRelay } from "@/lib/wallet-account";
import { MarketSeal } from "./MarketSeal";
import { ArrowUpRight } from "./icons";
import { ResolutionActions } from "./ResolutionActions";

const evidenceUrl = (value: string) => {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url : null; } catch { return null; }
};
const WORD: Record<Outcome, string> = { yes: "Yes", no: "No", void: "Void" };

type StepState = "done" | "current" | "upcoming" | "skipped";

// Where the market is in its resolution, from its status and the case stage alone.
function steps(closed: boolean, c: Case | null): { label: string; state: StepState }[] {
  const stage = c?.stage;
  const final = stage === "final";
  return [
    { label: closed ? "Trading closed" : "Trading open", state: closed ? "done" : "current" },
    { label: "Answer proposed", state: !closed ? "upcoming" : !c ? "current" : stage === "proposed" ? "current" : "done" },
    { label: "Challenged", state: stage === "disputed" ? "current" : final ? (c?.challenger ? "done" : "skipped") : "upcoming" },
    { label: "Final result", state: final ? "done" : "upcoming" },
  ];
}

function Tracker({ closed, record }: { closed: boolean; record: Case | null }) {
  return <ol className="resolution-tracker" aria-label="Resolution progress">
    {steps(closed, record).map((step, i) => <li key={step.label} data-state={step.state} style={{ "--i": i } as React.CSSProperties}>
      <span className="tracker-node" aria-hidden="true">{step.state === "done" ? "" : i + 1}</span>
      <span className="tracker-label">{step.label}<span className="sr-only">{step.state === "done" ? ", complete" : step.state === "current" ? ", current step" : step.state === "skipped" ? ", not needed" : ", upcoming"}</span></span>
    </li>)}
  </ol>;
}

export function Resolution({ market }: { market: MarketView }) {
  const now = useNow();
  const closed = market.outcome !== null || nsToMs(market.close_at) <= now;
  const record = usePoll(() => getCase(market.id), [market.id], 8000);
  const c = record.data;
  const relay = signsWithRelay(useWallet().identity);
  const evidence = evidenceUrl(c?.evidence ?? "");
  return <section aria-labelledby="res-h" className="detail-section">
    <h2 id="res-h" className="section-title">Resolution</h2>
    {(!closed || !record.loading || c) && <Tracker closed={closed} record={c ?? null} />}
    {!closed ? <p className="resolution-note">Trading closes on {formatDateTime(market.close_at)}. Follow the proposed answer and final result here.</p> : <>
      {record.loading && !c && <p role="status" className="resolution-note">Loading the result record…</p>}
      {record.error && <p role="alert" className="resolution-note">The result record is unavailable. <button type="button" className="btn btn-ghost btn-sm" onClick={record.reload}>Retry</button></p>}
      {c && <div className="resolution-record" data-stage={c.stage}>
        <div className="resolution-summary">
          <dl>
            <div><dt>Status</dt><dd>{c.stage === "final" ? "Final result" : c.stage === "disputed" ? "Challenged" : "Answer proposed"}</dd></div>
            <div><dt>Proposed answer</dt><dd><strong>{WORD[c.proposed] ?? "Unavailable"}</strong></dd></div>
          </dl>
          {evidence && <a href={evidence.href} target="_blank" rel="noopener noreferrer" className="text-link resolution-evidence">Read the evidence · {evidence?.hostname}<ArrowUpRight size={15} /></a>}
        </div>
        {c.final_outcome && <div className="resolution-ruling">
          <div className="verdict-seal" aria-hidden="true"><MarketSeal hash={market.rule_hash} id={market.id} tone="council" className="verdict-seal-art" /><span>{WORD[c.final_outcome]}</span></div>
          <p className="resolution-verdict">Final answer: <strong>{WORD[c.final_outcome]}</strong></p>
        </div>}
        {Array.isArray(c.votes) && c.votes.length > 0 && <><h3 className="resolution-votes-title">Public votes</h3><ul className="resolution-votes">{c.votes.map((vote, i) => <li key={`${vote.juror}-${i}`} className="vote-card enter" style={{ "--i": i } as React.CSSProperties}>
          <Sigil hash={seedHex(vote.juror)} className="vote-sigil" />
          <div className="min-w-0"><span className="mono vote-juror">{vote.juror}</span><p><span className="vote-outcome" data-outcome={vote.outcome}>{WORD[vote.outcome]}</span>{vote.reason ? <span className="vote-reason">: {vote.reason}</span> : null}</p></div>
        </li>)}</ul></>}
      </div>}
      {!record.loading && !record.error && !c && <p className="resolution-note">No result has been published yet.</p>}
      {relay && !record.loading && !record.error && <AnswerPanel market={market} record={c} onChange={record.reload} />}
    </>}
    {!relay && !record.loading && !record.error && <ResolutionActions key={market.id} id={market.id} record={c ?? null} reload={record.reload} />}
  </section>;
}
