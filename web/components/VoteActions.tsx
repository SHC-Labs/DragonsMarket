"use client";

import { useState } from "react";
import { useWallet } from "./WalletProvider";
import { Button, Notice } from "./ui";
import { TransactionNotice } from "./TransactionNotice";
import { useTx } from "@/lib/hooks";
import { config } from "@/lib/config";
import { commitVoteCall, getCase, revealVoteCall, type Case, type Outcome } from "@/lib/market";
import { byteLength, prepareVote, readVoteSecret, voteKey, votePhase, type VoteSecret } from "@/lib/resolution";

export function VoteActions({ id, record, now, reload }: { id: string; record: Case; now: bigint; reload: () => Promise<void> }) {
  const { account, send } = useWallet();
  const tx = useTx(send, account);
  const [choice, setChoice] = useState<Outcome>(record.proposed);
  const [secret, setSecret] = useState<VoteSecret | null>(null);
  const [backup, setBackup] = useState("");
  const [saved, setSaved] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  if (!account) return null;
  const scope = voteKey(config.network, config.oracleId, config.marketId, id, record, account);
  const phase = votePhase(record, account, now);
  const current = secret?.scope === scope ? secret : null;
  const onChain = record.commits.find(c => c.juror === account)?.commitment;
  const matches = current && (!onChain || onChain === current.commitment);
  const choices = [record.proposed, record.challenger_answer].filter((v): v is Outcome => v !== null);
  const load = async (imported: boolean) => {
    setWorking(true); setError(null);
    try {
      if (!navigator.locks) throw new Error("Use a browser that supports secure wallet coordination.");
      await navigator.locks.request(scope, async () => {
        let value: VoteSecret;
        if (imported) {
          value = await readVoteSecret(backup, scope, account);
          if (onChain && value.commitment !== onChain) throw new Error("Backup does not match your on-chain commitment.");
          const old = localStorage.getItem(scope);
          if (old !== null && (await readVoteSecret(old, scope, account)).commitment !== value.commitment) {
            throw new Error("A different secret is already saved. Keep both backups and verify the on-chain commitment.");
          }
          localStorage.setItem(scope, JSON.stringify(value));
          if (localStorage.getItem(scope) !== JSON.stringify(value)) throw new Error("Could not save the backup.");
        } else {
          const old = localStorage.getItem(scope);
          if (old === null && phase !== "commit") throw new Error("Import the backup you saved before committing.");
          value = await prepareVote(localStorage, scope, account, choice);
        }
        if (!choices.includes(value.outcome) || (onChain && value.commitment !== onChain)) throw new Error("The saved vote does not match this case.");
        setSecret(value); setBackup(JSON.stringify(value)); setSaved(false);
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load the vote backup."); }
    finally { setWorking(false); }
  };
  const commit = async () => {
    if (!current || !matches || !saved || phase !== "commit") return;
    await tx.run(commitVoteCall(id, current.commitment), {
      done: async () => (await getCase(id))?.commits.some(c => c.juror === account && c.commitment === current.commitment) === true,
      doneMessage: "Vote committed. Keep your backup and return during the reveal window.",
    });
    await reload();
  };
  const reveal = async () => {
    if (!current || !matches || phase !== "reveal" || !reason.trim() || byteLength(reason) > 1000) return;
    await tx.run(revealVoteCall(id, current.outcome, current.salt, reason), {
      done: async () => (await getCase(id))?.votes.some(v => v.juror === account && v.outcome === current.outcome && v.reason === reason) === true,
      doneMessage: "Vote revealed.",
    });
    await reload();
  };
  if (!record.panel.includes(account)) return null;
  return <div className="agent-panel">
    <h3>Your jury vote</h3>
    <p>Commit your choice privately, then return to reveal it. Missing the reveal can lose your jury reward.</p>
    {phase === "commit" && !current && <label>Your answer <select aria-label="Jury answer" value={choice}
      onChange={e => setChoice(e.target.value as Outcome)}>{choices.map(v => <option key={v} value={v}>{v}</option>)}</select></label>}
    {phase && <Button variant="secondary" disabled={working || tx.busy} onClick={() => load(false)}>
      {phase === "commit" ? "Prepare or recover vote" : "Load saved vote"}
    </Button>}
    {current && <><p>Saved choice: <strong>{current.outcome}</strong>. Keep this backup private until reveal.</p>
      <label>Vote backup<textarea aria-label="Vote backup" readOnly value={JSON.stringify(current)} /></label>
    </>}
    {phase === "commit" && current && <>
      <label><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} /> I saved this vote backup somewhere safe.</label>
      <Button disabled={!saved || !matches || tx.busy} onClick={commit}>Commit vote</Button>
    </>}
    {phase === "committed" && <p>Your commitment is recorded. Return when the reveal window opens.</p>}
    {phase === "reveal" && <>
      <label>Reason for your vote<textarea aria-label="Reason for your vote" value={reason} onChange={e => setReason(e.target.value)} /></label>
      <Button disabled={!matches || !reason.trim() || byteLength(reason) > 1000 || tx.busy} onClick={reveal}>Reveal vote</Button>
    </>}
    {phase && !current && <details><summary>Restore a vote backup</summary>
      <textarea aria-label="Import vote backup" value={backup} onChange={e => setBackup(e.target.value)} />
      <Button variant="secondary" disabled={working || tx.busy || !backup} onClick={() => load(true)}>Import backup</Button>
    </details>}
    {!phase && <p>No vote action is available for this account at this time.</p>}
    {error && <Notice tone="danger">{error}</Notice>}
    <TransactionNotice tx={tx} />
  </div>;
}
