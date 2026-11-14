import { expect, it } from "vitest";
import type { Case, OracleMarketInfo } from "../market";
import { byteLength, canChallenge, canPropose, prepareVote, readVoteSecret, voteKey, votePhase } from "../resolution";

const info = { close_at: "100", resolve_by: "1000", window_ns: "100", draw_window_ns: "50",
  panel_deadline_ns: "200", apply_buffer_ns: "50", price_rule: null } as OracleMarketInfo;
const record = { case_uid: "7", stage: "proposed", proposer: "alice.near", proposed: "yes", challenger_answer: "no",
  window_ends_at: "200", round: 0, panel: ["juror.near"], commit_ends_at: "300", panel_deadline: "400", commits: [], votes: [] } as unknown as Case;
it("reserves the challenge window, both draws, both juries and the apply buffer", () => {
  expect(canPropose(info, 99n)).toBe(false);
  expect(canPropose(info, 100n)).toBe(true);
  expect(canPropose(info, 350n)).toBe(true);
  expect(canPropose(info, 351n)).toBe(false);
  expect(canPropose({ ...info, price_rule: {} as NonNullable<OracleMarketInfo["price_rule"]> }, 100n)).toBe(false);
});
it("enforces challenge and commit/reveal boundaries and identities", () => {
  expect(canChallenge(record, "alice.near", 199n)).toBe(false);
  expect(canChallenge(record, "bob.near", 199n)).toBe(true);
  expect(canChallenge(record, "bob.near", 200n)).toBe(false);
  const disputed: Case = { ...record, stage: "disputed" };
  expect(votePhase(disputed, "outsider.near", 299n)).toBeNull();
  expect(votePhase(disputed, "juror.near", 299n)).toBe("commit");
  expect(votePhase(disputed, "juror.near", 300n)).toBeNull();
  disputed.commits = [{ juror: "juror.near", commitment: "a".repeat(64) }];
  expect(votePhase(disputed, "juror.near", 299n)).toBe("committed");
  expect(votePhase(disputed, "juror.near", 300n)).toBe("reveal");
  expect(votePhase(disputed, "juror.near", 400n)).toBe("reveal");
  expect(votePhase(disputed, "juror.near", 401n)).toBeNull();
});
it("keeps the original secret across retries and rejects altered or cross-case backups", async () => {
  let raw: string | null = null;
  const store = { getItem: () => raw, setItem: (_: string, value: string) => { raw = value; } };
  const key = voteKey("mainnet", "oracle.near", "market.near", "1", record, "juror.near");
  const first = await prepareVote(store, key, "juror.near", "no");
  expect(await prepareVote(store, key, "juror.near", "yes")).toEqual(first);
  expect(await readVoteSecret(raw!, key, "juror.near")).toEqual(first);
  for (const altered of [{ ...first, salt: "0".repeat(32) }, { ...first, outcome: "yes" }, { ...first, version: 2 }]) {
    await expect(readVoteSecret(JSON.stringify(altered), key, "juror.near")).rejects.toThrow();
  }
  await expect(readVoteSecret(raw!, key + ":other", "juror.near")).rejects.toThrow();
  await expect(readVoteSecret(raw!, key, "another.near")).rejects.toThrow();
  expect(voteKey("mainnet", "oracle.near", "market.near", "1", { ...record, round: 1 }, "juror.near")).not.toBe(key);
  expect(byteLength("é")).toBe(2);
});
