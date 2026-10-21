"use client";

import { usePoll } from "@/lib/hooks";
import { getCase, type MarketView, type Outcome } from "@/lib/market";
import { formatDateTime } from "@/lib/format";

const evidenceUrl = (value: string) => {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url : null; } catch { return null; }
};
const WORD: Record<Outcome, string> = { yes: "Yes", no: "No", void: "Void" };

// Read-only integration point. Proposal, jury, vote and settlement actions stay
// in lib/market.ts for later integration once contract interfaces are finalized.
export function Resolution({ market }: { market: MarketView }) {
  const record = usePoll(() => market.status === "open" ? Promise.resolve(null) : getCase(market.id), [market.id, market.status], 8000);
  const c = record.data;
  const evidence = evidenceUrl(c?.evidence ?? "");
  return <section aria-labelledby="res-h">
    <h2 id="res-h" className="mb-3 mt-8 border-b border-border pb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted">Resolution</h2>
    {market.status === "open" ? <p className="text-muted">Trading closes on {formatDateTime(market.close_at)}. Follow the proposed answer and final result here.</p> : <>
      {record.loading && !c && <p role="status" className="text-muted">Loading the result record…</p>}
      {record.error && <p role="alert" className="text-muted">The result record is unavailable. <button type="button" className="underline" onClick={record.reload}>Retry</button></p>}
      {c && <div className="resolution-record rounded-md border border-border bg-surface p-4">
        <p><span className="text-muted">Status: </span>{c.stage === "final" ? "Final result" : c.stage === "disputed" ? "Challenged" : "Answer proposed"}</p>
        <p><span className="text-muted">Proposed answer: </span><strong>{WORD[c.proposed] ?? "Unavailable"}</strong></p>
        {evidence && <a href={evidence.href} target="_blank" rel="noopener noreferrer" className="text-council underline">Read the evidence · {evidence?.hostname} ↗</a>}
        {c.final_outcome && <p className="resolution-verdict">Final answer: <strong>{WORD[c.final_outcome]}</strong></p>}
        {Array.isArray(c.votes) && c.votes.length > 0 && <><h3 className="mt-4 text-base">Public votes</h3><ul>{c.votes.map((vote, i) => <li key={`${vote.juror}-${i}`} className="mb-3"><span className="break-all num">{vote.juror}</span><p>{WORD[vote.outcome]}{vote.reason ? `: ${vote.reason}` : ""}</p></li>)}</ul></>}
        {c.stage === "disputed" && <p className="text-muted">Jury details and dispute actions are not available here yet.</p>}
      </div>}
      {!record.loading && !record.error && !c && <p className="text-muted">No result has been published yet.</p>}
    </>}
    <p className="mt-4 text-sm text-muted">You cannot submit proposals, challenge results or vote on this site yet.</p>
  </section>;
}
