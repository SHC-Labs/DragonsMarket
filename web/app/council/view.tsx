"use client";

import Link from "next/link";
import { PageLandmark } from "@/components/PageHeader";
import { Membership } from "@/components/Membership";
import { isConfigured } from "@/lib/config";
import { usePoll } from "@/lib/hooks";
import { getCase, listMarkets } from "@/lib/market";
import { StateBadge } from "@/components/ui";

async function loadCouncil() {
  if (!isConfigured) return { cases: [] };
  const markets = await listMarkets();
  const cases = await Promise.all(
    markets.filter(m => m.status === "closed" || m.status === "resolved")
      .map(async market => ({ market, record: await getCase(market.id) })),
  );
  return { cases: cases.filter(c => c.record) };
}

const process = [
  ["The rules are fixed first", "Each market publishes its question, result source, deadline and cancellation rules before trading opens. Jurors must use those rules to decide the case."],
  ["An answer is proposed", "After the market closes, a proposer submits an answer, evidence and a bond. If nobody challenges it within the window, it can be finalized."],
  ["A challenger disputes the answer", "A challenger submits a different answer and an equal bond. A jury is drawn from eligible staked Council seats for that case."],
  ["Jurors commit, then reveal", "Jurors commit their votes without showing them. In a separate window, they reveal their vote and reason. They choose between the proposed and challenged answers; the majority decides."],
  ["The outcome is settled", "If the jury cannot decide, the case can move to a second round and then the contract's fallback. The market page shows the deadlines, final ruling and payout rules."],
];

const questions = [
  ["Do I need an NFT to trade?", "You can browse without an NFT. When trading opens, you will also be able to trade without joining the Council. Dragon NFTs are for Council membership."],
  ["Can I mint or stake here now?", "Minting and staking are not open yet. We will publish the supply, price, launch date and final participation terms before launch."],
  ["Does every NFT holder earn?", "Only eligible staked seats earn a share of Council fees. Quarterly payouts are planned, and we will publish final claim terms before launch. Earnings vary and are not guaranteed."],
  ["Is this the whole collection?", "These are a few Dragons from the larger collection."],
  ["What does Void mean?", "Void means the market is cancelled. Yes pays the published time-weighted closing price; No pays one token minus that price. The payout is not fixed at half a token."],
  ["Where can I read a jury's decision?", "Select a case under Cases and results. Its market page shows the evidence, revealed votes, reasons and final result in the Resolution section."],
];

export function CouncilView() {
  const { data, error, loading, reload } = usePoll(loadCouncil, [], 30000);
  const cases = data?.cases ?? [];
  return (
    <div className="tribunal-page council-hub page-content">
      <PageLandmark title="Dragon Council" />

      <Membership />

      <div id="cases" className="tribunal-layout taste-case-layout council-cases">
        <section className="case-docket" aria-labelledby="cases-title">
          <div className="docket-heading"><h2 id="cases-title">Cases and results</h2><span className="num">{data ? `${cases.length} recorded cases` : "Awaiting records"}</span></div>
          <p className="council-case-intro">Open a case to read the evidence and follow its result.</p>
          {loading && !data && <p role="status" className="text-muted">Loading case records…</p>}
          {error && <p role="alert" className="text-muted">Could not load cases. <button className="underline" onClick={reload}>Retry</button></p>}
          {data && cases.length === 0 && <p className="text-muted">No case records yet. Proposed answers, disputed outcomes and final results will appear here.</p>}
          <ul className="case-list">{cases.map(({ market, record }) => (
            <li key={market.id}><Link href={`/market?id=${market.id}`}>
              <span className="case-number num">CASE / {market.id.padStart(3, "0")}</span><h3>{market.title}</h3>
              <div className="case-meta"><StateBadge status={market.status} caseStage={record?.stage} /><span>{record?.votes.length ?? 0} revealed votes</span><span>{record?.final_outcome ? `Result: ${record.final_outcome.toUpperCase()}` : record?.stage === "disputed" ? "In dispute" : "Answer proposed"} ↗</span></div>
            </Link></li>
          ))}</ul>
        </section>
        <aside className="tribunal-sidebar" aria-labelledby="jury-title">
          <h2 id="jury-title">How juries are selected</h2>
          <p>Each case draws its own jury from eligible staked Council seats.</p>
          <p>Each case has its own deadlines. Once votes are revealed, the market page shows the jurors and their reasons.</p>
          <a href="#process" className="ritual-link">Follow the dispute process ↘</a>
        </aside>
      </div>

      <section id="process" className="council-journey" aria-labelledby="process-title">
        <div><h2 id="process-title">How disputes work</h2><p>A bond is the deposit required to propose or challenge an answer. The case record shows which step comes next.</p></div>
        <ol>{process.map(([title, text], i) => <li key={title}><span className="num">{String(i + 1).padStart(2, "0")}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol>
      </section>

      <section id="questions" className="membership-faq council-questions" aria-labelledby="questions-title">
        <h2 id="questions-title">Common questions</h2>
        {questions.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}
      </section>
    </div>
  );
}
