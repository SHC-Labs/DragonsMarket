"use client";
import Link from "next/link";
import { CouncilSeal } from "@/components/Threshold";
import { isConfigured } from "@/lib/config";
import { usePoll } from "@/lib/hooks";
import { getCase, listMarkets } from "@/lib/market";
import { StateBadge } from "@/components/ui";
async function loadCouncil() {
  if (!isConfigured) return { panel: [], cases: [] };
  const markets = await listMarkets();
  const cases = await Promise.all(markets.filter(m => m.status === "closed" || m.status === "resolved").map(async market => ({ market, record: await getCase(market.id) })));
  return { panel: [], cases: cases.filter(c => c.record) };
}
export function CouncilView() {
  const { data, error, loading, reload } = usePoll(loadCouncil, [], 8000);
  const cases = data?.cases ?? [];
  return <div className="tribunal-page">
    <div className="tribunal-masthead"><div><p className="ritual-label">Council · Disputes and results</p><h1>How disputes <br /><span>work.</span></h1><p>If a result is challenged, a jury reads the rule and the evidence and votes Yes, No or Void. Every vote and reason is public.</p></div><div className="tribunal-stamp"><CouncilSeal /><span>PUBLIC CASE RECORDS</span></div></div>
    <div className="tribunal-layout taste-case-layout">
      <section className="case-docket" aria-label="Dispute docket"><div className="docket-heading"><h2>Cases and results</h2><span className="num">{data ? `${cases.length} recorded cases` : "Awaiting records"}</span></div>
        {loading && !data && <p role="status" className="text-muted">Loading case records…</p>}
        {error && <p role="alert" className="text-muted">Could not load cases. <button className="underline" onClick={reload}>Retry</button></p>}
        {data && cases.length === 0 && <p className="text-muted">No case records yet. Disputed outcomes will appear here.</p>}
        <ul className="case-list">{cases.map(({market, record}) => <li key={market.id}><Link href={`/market?id=${market.id}`}><span className="case-number num">CASE / {market.id.padStart(3,"0")}</span><h3>{market.title}</h3><div className="case-meta"><StateBadge status={market.status} caseStage={record?.stage} /><span>{record?.votes.length ?? 0} public votes</span><span>{record?.final_outcome ? `Verdict: ${record.final_outcome.toUpperCase()}` : record?.stage === "disputed" ? "Jury deciding" : "Challenge window"} ↗</span></div></Link></li>)}</ul>
      </section>
      <aside className="tribunal-sidebar"><p className="ritual-label">The panel</p><h2>Panel members</h2><ul className="juror-roster">{(data?.panel ?? []).map((account,i) => <li key={account}><span className="juror-index num">{String(i+1).padStart(2,"0")}</span><div><span className="num">Juror {String(i+1).padStart(2,"0")}</span><small>Panel member · Votes on record</small></div></li>)}</ul><p className="text-sm text-muted">The platform picks the panel for now. Who sits on the long-term Council is not decided.</p><Link href="/membership" className="ritual-link">NFT membership ↗</Link></aside>
    </div>
    <section className="council-journey" aria-label="How an outcome becomes final"><div><p className="ritual-label">Step by step</p><h2>From question<br /><em>to result.</em></h2><p>Each market page shows the current step. A bond is a deposit you put up when you propose or challenge an answer.</p></div><ol>{[
      ["The rules are fixed first","Before trading opens, the market states the question, the source that decides it, the deadline and what counts as void."],
      ["Someone proposes an answer","After trading closes, anyone can propose Yes, No or Void with a link to evidence and a bond."],
      ["Anyone can challenge it","A challenger puts up an equal bond. If nobody challenges within the window, the answer becomes final."],
      ["The jury votes","If the answer is challenged, the jury reads the rule and the evidence and votes. The majority decides. If they miss the deadline, the market is void and both bonds go back."],
      ["The result is final","Winning shares can be redeemed from your portfolio."]
    ].map(([title,text],i)=><li key={title}><span className="num">{String(i+1).padStart(2,"0")}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol></section>
    <section className="membership-faq" aria-label="Council questions"><h2>Questions</h2>{[["What does Void mean?","The market is cancelled. Each share pays back half a token, whichever side you held."],["Can one person decide a case?","No. A jury votes, the majority decides, and each juror has to give a reason."],["Where are the evidence and votes?","On the market page, under Resolution. Open any case above."]].map(([q,a])=><details key={q}><summary>{q}</summary><p>{a}</p></details>)}</section>
  </div>;
}
