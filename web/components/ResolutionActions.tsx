"use client";

import { useState } from "react";
import { useWallet } from "./WalletProvider";
import { Button, Notice } from "./ui";
import { TransactionNotice } from "./TransactionNotice";
import { VoteActions } from "./VoteActions";
import { config } from "@/lib/config";
import { useNow, usePoll, useTx } from "@/lib/hooks";
import { formatDateTime, formatMoney } from "@/lib/format";
import { challengeCall, claimableBond, fundCall, getCase, getMarketInfo, getOracleConfig, proposeCall, tokenBalance, walletTokenBalance, withdrawBondCall, type Case, type Outcome } from "@/lib/market";
import { byteLength, canChallenge, canPropose } from "@/lib/resolution";

export function ResolutionActions({ id, record, reload }: { id: string; record: Case | null; reload: () => Promise<void> }) {
  const { account, send, openConnect, walletAvailable } = useWallet();
  const tx = useTx(send, account);
  const now = BigInt(useNow(1000)) * 1_000_000n;
  const [answer, setAnswer] = useState<Outcome>("yes");
  const [evidence, setEvidence] = useState("");
  const data = usePoll(async () => {
    const [info, rules, intents, wallet, claimable] = await Promise.all([
      getMarketInfo(id), getOracleConfig(), account ? tokenBalance(account) : "0", account ? walletTokenBalance(account) : "0",
      account ? claimableBond(account) : "0",
    ]);
    return { info, rules, intents: BigInt(intents), wallet: BigInt(wallet), claimable: BigInt(claimable) };
  }, [id, account], 6000);
  if (!config.oracleId) return null;
  if (!data.data) return <Notice tone={data.error ? "danger" : undefined}>{data.error ? "Resolution settings could not be read." : "Loading resolution settings."}</Notice>;
  const { info, rules, intents, wallet, claimable } = data.data;
  if (!info) return <Notice tone="warning">This market is not registered with the oracle.</Notice>;
  const propose = record === null && rules.markets.includes(config.marketId) && canPropose(info, now);
  const challenge = record !== null && account !== null && canChallenge(record, account, now);
  const bond = BigInt(record?.bond ?? rules.bond);
  const validConfig = rules.verifier === config.verifierId && rules.collateral_token_id === config.collateralTokenId;
  const eligible = propose || challenge;
  const valid = eligible && validConfig && byteLength(evidence) <= 512 && (!challenge || answer !== record!.proposed);
  const shortfall = bond > intents ? bond - intents : 0n;
  const submit = async () => {
    if (!account || !valid) return;
    if (shortfall > 0n) {
      if (shortfall > wallet) return;
      await tx.run(fundCall(account, shortfall), {
        done: async () => BigInt(await tokenBalance(account)) >= bond,
        doneMessage: "Your bond funds are in Intents. Confirm the proposal or challenge next.",
      });
    } else {
      await tx.run(propose ? proposeCall(id, answer, evidence, bond) : challengeCall(id, answer, bond), {
        done: async () => {
          const c = await getCase(id);
          return propose ? c?.proposer === account && c.proposed === answer && c.evidence === evidence
            : c?.challenger === account && c.challenger_answer === answer;
        },
        doneMessage: propose ? "Answer proposed. The challenge window is open." : "Challenge recorded. The jury draw comes next.",
      });
    }
    await Promise.all([reload(), data.reload()]);
  };
  return <div className="agent-panel">
    {!account && <Button onClick={openConnect} disabled={!walletAvailable}>Connect to participate in resolution</Button>}
    {!validConfig && <Notice tone="danger">Oracle collateral settings do not match this site. Bond transfers are disabled.</Notice>}
    {!record && info.price_rule && <p>This price market requires a publisher-signed price proposal.</p>}
    {!record && !info.price_rule && !propose && <p>The proposal window is closed or has not started. Trading closes {formatDateTime(info.close_at)}.</p>}
    {record?.stage === "proposed" && <p>Challenges close {formatDateTime(record.window_ends_at)}.</p>}
    {account && eligible && <>
      <h3>{propose ? "Propose an answer" : "Challenge this answer"}</h3>
      <p>The bond is {formatMoney(bond)} {config.tokenSymbol}. It is at risk if your answer loses. Read the market rule and evidence before signing.</p>
      <label>Answer <select aria-label="Resolution answer" value={answer} onChange={e => setAnswer(e.target.value as Outcome)}>
        {(["yes", "no", "void"] as const).map(v => <option key={v} value={v} disabled={challenge && v === record?.proposed}>{v}</option>)}
      </select></label>
      {propose && <label>Evidence link or explanation<textarea aria-label="Proposal evidence" value={evidence} onChange={e => setEvidence(e.target.value)} /></label>}
      {shortfall > wallet && <p>Add {formatMoney(shortfall - wallet)} {config.tokenSymbol} to your wallet to cover this bond.</p>}
      <Button disabled={!valid || tx.busy || shortfall > wallet} onClick={submit}>
        {shortfall > 0n ? "Fund bond in your Intents balance" : propose ? "Submit proposal" : "Submit challenge"}
      </Button>
    </>}
    {record?.stage === "disputed" && <>
      <p>{record.panel.length ? `Commit before ${formatDateTime(record.commit_ends_at)}; reveal by ${formatDateTime(record.panel_deadline)}.` : "Waiting for the jury draw."}</p>
      <VoteActions key={`${record.case_uid}:${record.round}:${account}`} id={id} record={record} now={now} reload={reload} />
    </>}
    {account && claimable > 0n && <>
      <p>Available oracle bonds and jury rewards: {formatMoney(claimable)} {config.tokenSymbol}.</p>
      <Button variant="secondary" disabled={tx.busy} onClick={async () => {
        await tx.run(withdrawBondCall(), {
          done: async () => BigInt(await claimableBond(account)) < claimable && BigInt(await tokenBalance(account)) >= intents + claimable,
          doneMessage: "Oracle funds withdrawn to your Intents account.",
        });
        await data.reload();
      }}>Withdraw oracle funds</Button>
    </>}
    <TransactionNotice tx={tx} />
  </div>;
}
