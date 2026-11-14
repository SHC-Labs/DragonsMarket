"use client";

import { useId, useState } from "react";
import { Button, Notice } from "./ui";
import { DepositDialog } from "./DepositDialog";
import { useWallet } from "./WalletProvider";
import { config } from "@/lib/config";
import { formatExact, nsToMs } from "@/lib/format";
import { useNow, usePoll, useRelayFee, useRelayTx, type RelayTxState } from "@/lib/hooks";
import { challengeMessage, getCase, getOracleConfig, proposeMessage, tokenBalance, type Case, type MarketView, type Outcome } from "@/lib/market";
import { cleanEvidence, MAX_EVIDENCE_BYTES, type Action } from "@/lib/signed-intents";
import { signsWithRelay } from "@/lib/wallet-account";

const WORD: Record<Outcome, string> = { yes: "Yes", no: "No", void: "Void" };
const OUTCOMES: Outcome[] = ["yes", "no", "void"];
// The bond and fee are signed, so they are shown to the last unit.
const money = (v: bigint) => `${formatExact(v)} ${config.tokenSymbol}`;

// Propose an answer, or challenge the proposed one, with a message an EVM or Solana wallet signs. The bond and the network fee come
// from the person's Intents account. Voting and every later step need a NEAR wallet.
export function AnswerPanel({ market, record, onChange }: { market: MarketView; record: Case | null; onChange: () => void }) {
  const { account, identity, signRelayed } = useWallet();
  const relayTx = useRelayTx(account);
  const now = useNow(1000);
  const [outcome, setOutcome] = useState<Outcome>("yes");
  const [evidence, setEvidence] = useState("");
  const [depositOpen, setDepositOpen] = useState(false);
  const relay = signsWithRelay(identity);
  const { fee, reload: reloadFee } = useRelayFee(relay);
  const stage = record?.stage ?? null;
  const proposing = market.outcome === null && nsToMs(market.close_at) <= now && record === null;
  const challenging = record !== null && stage === "proposed" && nsToMs(record.window_ends_at) > now;
  const { data } = usePoll(async () => {
    if (!account || !relay) return null;
    const [bond, intents] = await Promise.all([getOracleConfig().then(c => BigInt(c.bond)), tokenBalance(account).then(BigInt)]);
    return { bond, intents };
  }, [account, relay], 8000);

  if (!relay || !account || (!proposing && !challenging)) return null;
  const bond = challenging ? BigInt(record.bond) : data?.bond ?? null;
  const answer = challenging && outcome === record.proposed ? OUTCOMES.find(o => o !== record.proposed)! : outcome;
  const options = challenging ? OUTCOMES.filter(o => o !== record.proposed) : OUTCOMES;
  const own = challenging && record.proposer === account;
  const { text: evidenceText, fits } = cleanEvidence(evidence);

  const submit = async () => {
    if (bond === null || fee === null || (!challenging && (evidenceText === "" || !fits))) return;
    const action: Action = { to: config.oracleId, amount: bond, msg: challenging ? challengeMessage(market.id, answer) : proposeMessage(market.id, answer, evidenceText) };
    const done = async () => {
      const c = await getCase(market.id);
      return challenging ? c?.stage === "disputed" && c.challenger === account : c?.stage === "proposed" && c.proposer === account;
    };
    await relayTx.run({ submit: () => signRelayed([action], fee), done, doneMessage: challenging ? "Challenge sent. A jury will review the case." : "Answer proposed. It can be challenged during the window." });
    await reloadFee();
    onChange();
  };

  return <>
    <AnswerForm challenging={challenging} bond={bond} fee={fee} options={options} answer={answer} evidence={evidence} state={relayTx.state} own={own}
      balance={data?.intents ?? null} canDeposit={config.network === "mainnet"} onDeposit={() => setDepositOpen(true)} onSubmit={submit} onCheckAgain={async () => { await relayTx.recheck(); onChange(); }} onDismiss={relayTx.reset}
      onAnswer={option => { setOutcome(option); relayTx.reset(); }} onEvidence={text => { setEvidence(text); relayTx.reset(); }} />
    {depositOpen && identity && <DepositDialog identity={identity} onClose={() => setDepositOpen(false)} />}
  </>;
}

interface AnswerFormProps {
  challenging: boolean;
  bond: bigint | null;
  fee: bigint | null;
  options: Outcome[];
  answer: Outcome;
  evidence: string;
  state: RelayTxState;
  own: boolean;
  balance: bigint | null;
  canDeposit: boolean;
  onAnswer: (option: Outcome) => void;
  onEvidence: (text: string) => void;
  onDeposit: () => void;
  onSubmit: () => void;
  onCheckAgain?: () => void;
  onDismiss?: () => void;
}

// The form itself, with no wallet or network behind it, so the /brand page can show it in its states.
export function AnswerForm({ challenging, bond, fee, options, answer, evidence, state, own, balance, canDeposit, onAnswer, onEvidence, onDeposit, onSubmit, onCheckAgain }: AnswerFormProps) {
  const { text: evidenceText, fits } = cleanEvidence(evidence);
  const short = bond !== null && balance !== null && fee !== null && bond + fee > balance;
  const busy = state.phase === "waiting" || state.phase === "unknown";
  const title = challenging ? "Challenge this answer" : "Propose an answer";
  const id = useId();
  return <section aria-labelledby={`${id}-h`} className="answer-panel">
    <h3 id={`${id}-h`} className="resolution-votes-title">{title}</h3>
    <p className="resolution-note">{challenging
      ? `Name the answer you say is right. You post a bond of ${bond === null ? "the bond" : money(bond)}, the same as the proposer, and it is returned if you are right.`
      : `Anyone can propose the answer. You post a bond of ${bond === null ? "the bond" : money(bond)}, returned if nobody successfully challenges it.`}</p>
    <div role="group" aria-label={challenging ? "Your answer" : "Proposed answer"} className="segmented answer-options">
      {options.map(option => <button type="button" key={option} disabled={busy} aria-pressed={answer === option} onClick={() => onAnswer(option)} className="trade-mode-button">{WORD[option]}</button>)}
    </div>
    {!challenging && <>
      <label htmlFor={`${id}-evidence`} className="ticket-label">Evidence</label>
      <div className="trade-amount-field"><input id={`${id}-evidence`} autoComplete="off" maxLength={MAX_EVIDENCE_BYTES} aria-invalid={fits ? undefined : true} aria-describedby={fits ? undefined : `${id}-evidence-error`} placeholder="A link to the source" value={evidence} onChange={e => onEvidence(e.target.value)} disabled={busy} /></div>
      {!fits && <p id={`${id}-evidence-error`} role="alert" className="ticket-error">Shorten the evidence. A link to the source is enough.</p>}
    </>}
    {state.phase === "waiting" && <Notice>Waiting for your wallet, then the network. This takes about 10 seconds.</Notice>}
    {state.phase === "done" && <Notice>{state.message}</Notice>}
    {state.phase === "failed" && <Notice tone="danger">{state.message}</Notice>}
    {state.phase === "unknown" && <Notice tone="danger"><span>{state.message} </span>
      <Button variant="ghost" size="sm" onClick={onCheckAgain}>Check again</Button></Notice>}
    {own && <Notice>You proposed this answer, so another account has to challenge it.</Notice>}
    {fee === null && <p className="resolution-note">Getting the network fee.</p>}
    {short && <p className="resolution-note">Your Intents account holds {money(balance)}. You need {money(bond + fee)}, which includes {money(fee)} in network fees.</p>}
    <div className="answer-actions">
      {short && canDeposit && <Button variant="secondary" onClick={onDeposit}>Deposit {config.tokenSymbol}</Button>}
      <Button variant="secondary" disabled={busy || own || short || bond === null || fee === null || (!challenging && (evidenceText === "" || !fits))} onClick={onSubmit}>{challenging ? `Challenge with ${WORD[answer]}` : `Propose ${WORD[answer]}`}</Button>
    </div>
    <p className="resolution-footnote">Voting is available with a NEAR wallet for now.</p>
  </section>;
}
