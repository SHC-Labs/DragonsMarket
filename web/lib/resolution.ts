import { commitmentFor, newSalt, type Case, type OracleMarketInfo, type Outcome } from "./market";

export const byteLength = (value: string) => new TextEncoder().encode(value).length;
export function canPropose(info: OracleMarketInfo, now: bigint) {
  const span = BigInt(info.window_ns) + 2n * (BigInt(info.draw_window_ns) + BigInt(info.panel_deadline_ns));
  return info.price_rule === null && now >= BigInt(info.close_at)
    && now + span + BigInt(info.apply_buffer_ns) <= BigInt(info.resolve_by);
}
export function canChallenge(c: Case, account: string, now: bigint) {
  return c.stage === "proposed" && c.proposer !== account && now < BigInt(c.window_ends_at);
}
export function votePhase(c: Case, account: string, now: bigint) {
  if (c.stage !== "disputed" || !c.panel.includes(account) || c.votes.some(v => v.juror === account)) return null;
  if (now < BigInt(c.commit_ends_at)) return c.commits.some(v => v.juror === account) ? "committed" : "commit";
  return now <= BigInt(c.panel_deadline) && c.commits.some(v => v.juror === account) ? "reveal" : null;
}
export interface VoteSecret {
  version: 1; scope: string; juror: string; outcome: Outcome; salt: string; commitment: string;
}
export const voteKey = (network: string, oracle: string, market: string, id: string, c: Case, account: string) =>
  ["dragon-vote", network, oracle, market, id, c.case_uid, c.round, account].join(":");
export async function readVoteSecret(raw: string, scope: string, juror: string): Promise<VoteSecret> {
  if (raw.length > 4096) throw new Error("Vote backup is too large.");
  const v = JSON.parse(raw) as Partial<VoteSecret> | null;
  if (!v || v.version !== 1 || v.scope !== scope || v.juror !== juror
    || !["yes", "no", "void"].includes(v.outcome ?? "") || !/^[0-9a-f]{32}$/.test(v.salt ?? "")
    || v.commitment !== await commitmentFor(juror, v.outcome as Outcome, v.salt!)) {
    throw new Error("This backup does not match this account, case and voting round.");
  }
  return v as VoteSecret;
}
// Never replace a prepared secret: an earlier wallet submission may still be in flight.
export async function prepareVote(store: Pick<Storage, "getItem" | "setItem">, scope: string, juror: string, outcome: Outcome) {
  const existing = store.getItem(scope);
  if (existing !== null) return readVoteSecret(existing, scope, juror);
  const salt = newSalt();
  const secret: VoteSecret = { version: 1, scope, juror, outcome, salt, commitment: await commitmentFor(juror, outcome, salt) };
  // The caller holds a Web Lock across the read/hash/write sequence.
  const raw = JSON.stringify(secret);
  store.setItem(scope, raw);
  if (store.getItem(scope) !== raw) throw new Error("Could not retain the vote secret.");
  return secret;
}
