"use client";

import { useState } from "react";
import { Button, Notice } from "./ui";
import { useWallet } from "./WalletProvider";
import { config } from "@/lib/config";
import { formatDateTime, formatMoney, nsToMs, shortAccount, timeLeft } from "@/lib/format";
import { useNow, usePoll, useTx } from "@/lib/hooks";
import {
  challengeCall, claimableBond, finalizeCall, getCase, getOracleConfig, proposeCall, retryApplyCall, voteCall,
  withdrawBondCall, type Case, type MarketView, type Outcome, type OracleConfig,
} from "@/lib/market";

const WORD: Record<Outcome, string> = { yes: "Yes", no: "No", void: "Void" };
const isUrl = (s: string) => /^https?:\/\//i.test(s);

function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol aria-label="Resolution progress" className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-4">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === current ? "step" : undefined}
          className={`border-t-2 pt-2 text-sm ${i < current ? "border-muted text-fg" : i === current ? "border-warning font-semibold text-fg" : "border-border text-muted"}`}
        >
          {s}
        </li>
      ))}
    </ol>
  );
}

function Seal() {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-council">
      <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="10" cy="10" r="8" />
        <path d="M10 4v12M4 10h12" />
      </svg>
      Sealed by the Council
    </span>
  );
}

function Juror({ n, account, vote, deadlinePassed }: { n: number; account: string; vote?: Case["votes"][number]; deadlinePassed: boolean }) {
  return (
    <div className="grid grid-cols-[4rem_1fr] gap-3 rounded-md border border-border bg-surface p-3">
      <div
        role="img"
        aria-label={`Council seat ${n}`}
        className="num flex h-16 w-16 items-center justify-center rounded-sm border border-council bg-council-soft text-sm text-council"
      >
        #{String(n).padStart(3, "0")}
      </div>
      <div className="min-w-0 text-sm">
        <div className="num truncate" title={account}>{shortAccount(account)}</div>
        <div className="font-semibold">{vote ? WORD[vote.outcome] : deadlinePassed ? "Did not vote" : "Not voted"}</div>
        {vote && <div className="text-muted">{vote.reason}</div>}
      </div>
    </div>
  );
}

export function Resolution({ market }: { market: MarketView }) {
  const { account, send } = useWallet();
  const now = useNow(1000);
  const tx = useTx(send, account);
  const caseQ = usePoll(() => getCase(market.id), [market.id], 5000);
  const cfgQ = usePoll<OracleConfig>(getOracleConfig, [], 60_000);
  const bondQ = usePoll(async () => (account ? BigInt(await claimableBond(account)) : 0n), [account], 8000);
  const [pick, setPick] = useState<Outcome>("yes");
  const [evidence, setEvidence] = useState("");
  const [vote, setVote] = useState<Outcome>("yes");
  const [reason, setReason] = useState("");

  const c = caseQ.data;
  const cfg = cfgQ.data;
  const waiting = tx.state.phase === "waiting";
  const bond = cfg ? BigInt(cfg.bond) : null;
  const closed = market.status === "closed" || market.status === "resolved" || (market.status === "halted" && nsToMs(market.close_at) < now);

  if (market.status === "open") {
    return <p className="text-muted">Resolution starts after trading closes on {formatDateTime(market.close_at)}.</p>;
  }

  // Which step is happening now.
  const disputed = c?.stage === "disputed" || (c?.stage === "final" && c.challenger !== null);
  const steps = ["Trading closed", "Answer proposed", disputed ? "Council decides" : "Challenge window", "Final"];
  const current = !c ? 1 : c.stage === "proposed" ? 2 : c.stage === "disputed" ? 2 : 3;

  const refresh = async () => { await caseQ.reload(); await bondQ.reload(); };
  const run = (call: ReturnType<typeof finalizeCall>, done: (x: Case | null) => boolean, doneMessage: string) =>
    tx.run(call, { done: async () => done(await getCase(market.id)), doneMessage }).then(refresh);

  const windowOver = c ? now >= nsToMs(c.window_ends_at) : false;
  const panelOver = c && c.stage === "disputed" ? now > nsToMs(c.panel_deadline) : false;
  const isJuror = Boolean(account && cfg?.panel.includes(account));
  const myVote = c?.votes.find((v) => v.juror === account);

  return (
    <section aria-labelledby="res-h">
      <h2 id="res-h" className="mb-3 mt-8 border-b border-border pb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted">Resolution</h2>
      <Steps steps={steps} current={current} />

      <div className="mt-4 text-sm">
        {!c && closed && (
          <>
            <p className="m-0 mb-3">Nobody has proposed an answer yet. Anyone can{bond !== null ? `, with a bond of ${formatMoney(bond)} ${config.tokenSymbol}` : ""}.</p>
            {account && bond !== null ? (
              <div className="max-w-[28.75rem] rounded-md border border-border p-3">
                <fieldset className="m-0 mb-3 flex gap-4 border-0 p-0">
                  <legend className="mb-1 text-muted">Your answer</legend>
                  {(["yes", "no", "void"] as const).map((o) => (
                    <label key={o} className="flex items-center gap-1">
                      <input type="radio" name="answer" checked={pick === o} onChange={() => setPick(o)} /> {WORD[o]}
                    </label>
                  ))}
                </fieldset>
                <label htmlFor="evidence" className="mb-1 block text-muted">Evidence link</label>
                <input id="evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="https://"
                  className="mb-3 h-10 w-full rounded-md border border-input bg-canvas px-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" />
                <Button disabled={waiting || !isUrl(evidence)} onClick={() => run(proposeCall(market.id, pick, evidence, bond), (x) => x !== null, "Done. Your answer is proposed.")}>
                  {waiting ? "Waiting for confirmation" : `Propose ${WORD[pick]} with ${formatMoney(bond)} ${config.tokenSymbol}`}
                </Button>
                {!isUrl(evidence) && <p className="mb-0 mt-2 text-muted">Add a link that shows the result.</p>}
              </div>
            ) : (
              <p className="m-0 text-muted">Connect a wallet to propose.</p>
            )}
          </>
        )}

        {c && (
          <p className="m-0 mb-3">
            {c.challenger ? "First proposed answer (challenged)" : "Proposed answer"}: <strong>{WORD[c.proposed]}</strong> by <span className="num">{shortAccount(c.proposer)}</span>
            {bond !== null && <>, bond <span className="num">{formatMoney(bond)} {config.tokenSymbol}</span></>}.{" "}
            {isUrl(c.evidence) && <a href={c.evidence} target="_blank" rel="noopener noreferrer">Evidence</a>}
          </p>
        )}

        {c?.stage === "proposed" && (
          <>
            <p className="m-0 mb-3 text-muted">
              {windowOver ? "The challenge window has ended." : <>Challenge window: <span className="num">{timeLeft(c.window_ends_at, now)}</span>. Anyone can challenge with an equal bond.</>}
            </p>
            {!windowOver && account && account !== c.proposer && bond !== null && (
              <Button variant="secondary" disabled={waiting} onClick={() => run(challengeCall(market.id, bond), (x) => x?.stage === "disputed", "Done. The Council will decide.")}>
                {waiting ? "Waiting for confirmation" : `Challenge this answer (${formatMoney(bond)} ${config.tokenSymbol})`}
              </Button>
            )}
            {windowOver && (
              <Button disabled={waiting} onClick={() => run(finalizeCall(market.id), (x) => x?.stage === "final", "Done. The answer is final.")}>
                {waiting ? "Waiting for confirmation" : "Make it final"}
              </Button>
            )}
          </>
        )}

        {disputed && cfg && c && (
          <div className="mt-2 rounded-md border border-council bg-council-soft p-4">
            <h3 className="m-0 font-[family-name:var(--font-display-stack)] text-[1.75rem] font-semibold leading-[2.125rem] text-council">The Council</h3>
            <p className="m-0 mt-1 text-muted">
              Jury of {cfg.panel.length}. {c.stage === "disputed" ? <>Decision due <span className="num">{formatDateTime(c.panel_deadline)}</span> (<span className="num">{timeLeft(c.panel_deadline, now)}</span>).</> : "The case is closed."}
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {cfg.panel.map((j, i) => (
                <Juror key={j} n={i + 1} account={j} vote={c.votes.find((v) => v.juror === j)} deadlinePassed={panelOver || c.stage === "final"} />
              ))}
            </div>

            {c.stage === "disputed" && isJuror && !myVote && !panelOver && (
              <div className="mt-4 max-w-[28.75rem] border-t border-border pt-4">
                <fieldset className="m-0 mb-3 flex gap-4 border-0 p-0">
                  <legend className="mb-1 text-muted">Your vote</legend>
                  {(["yes", "no", "void"] as const).map((o) => (
                    <label key={o} className="flex items-center gap-1">
                      <input type="radio" name="vote" checked={vote === o} onChange={() => setVote(o)} /> {WORD[o]}
                    </label>
                  ))}
                </fieldset>
                <label htmlFor="reason" className="mb-1 block text-muted">Reason (required, shown to everyone)</label>
                <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
                  className="mb-3 w-full rounded-md border border-input bg-canvas p-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" />
                <Button disabled={waiting || reason.trim() === ""} onClick={() => run(voteCall(market.id, vote, reason.trim()), (x) => Boolean(x?.votes.some((v) => v.juror === account)) || x?.stage === "final", "Done. Your vote is recorded.")}>
                  {waiting ? "Waiting for confirmation" : `Vote ${WORD[vote]}`}
                </Button>
              </div>
            )}

            {c.stage === "disputed" && panelOver && (
              <div className="mt-4">
                <p className="m-0 mb-3">The Council did not reach a majority in time. The market resolves Void and both bonds go back.</p>
                <Button disabled={waiting} onClick={() => run(finalizeCall(market.id), (x) => x?.stage === "final", "Done. The market is Void.")}>
                  {waiting ? "Waiting for confirmation" : "Make it final"}
                </Button>
              </div>
            )}

            {c.stage === "final" && c.final_outcome && (
              <div className="mt-4 border-t border-border pt-4">
                <p className="m-0 font-[family-name:var(--font-display-stack)] text-[1.75rem] font-semibold leading-[2.125rem]">Verdict: {WORD[c.final_outcome]}</p>
                <p className="m-0 mb-3 mt-1 text-sm text-muted">
                  {c.votes.length ? `${c.votes.filter((v) => v.outcome === c.final_outcome).length} of ${c.votes.length} votes for ${WORD[c.final_outcome]}.` : "No majority, so Void."}
                </p>
                <Seal />
              </div>
            )}
          </div>
        )}

        {c?.stage === "final" && !disputed && c.final_outcome && (
          <p className="m-0 mt-2 text-base font-semibold">Final answer: {WORD[c.final_outcome]}</p>
        )}

        {c?.stage === "final" && !c.applied && (
          <Notice tone="warning">
            <span>The answer is final but the market has not updated yet. Anyone can retry. </span>
            <Button variant="secondary" size="sm" disabled={waiting} onClick={() => run(retryApplyCall(market.id), (x) => Boolean(x?.applied), "Done. The market is updated.")}>Retry</Button>
          </Notice>
        )}

        {(bondQ.data ?? 0n) > 0n && (
          <Notice>
            <span>You can withdraw <span className="num">{formatMoney(bondQ.data ?? 0n)} {config.tokenSymbol}</span> from resolved bonds. </span>
            <Button variant="secondary" size="sm" disabled={waiting} onClick={() => tx.run(withdrawBondCall(), { done: async () => (account ? BigInt(await claimableBond(account)) === 0n : false), doneMessage: "Done. The bond is in your wallet." }).then(refresh)}>Withdraw</Button>
          </Notice>
        )}

        <div role="status" className="mt-3">
          {tx.state.phase === "waiting" && <p className="m-0"><span className="num">{Math.floor((now - tx.state.since) / 1000)}s</span>. You can leave this page. Nothing is taken until this finishes.</p>}
          {tx.state.phase === "done" && <p className="m-0">{tx.state.message}</p>}
          {tx.state.phase === "failed" && <p className="m-0 text-no">{tx.state.message}</p>}
        </div>
      </div>
    </section>
  );
}
