// Run with: node --test keeper/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advanceCursor, dueActions, formatNear, juryProblems, marginReport, nearToYocto, oracleReconciliation, readCursor, readKeyFile,
  refuseKeyFlags, resolveKeys, secondJurySize, storageMargin, writeCursor, refuseRetiredController,
} from "./keeper.mjs";

const NOW = 1_000_000n;

test("retired controller flags are rejected before any RPC call", () => {
  assert.throws(() => refuseRetiredController({ governance: "old.example.near" }), /retired/);
  assert.doesNotThrow(() => refuseRetiredController({ treasury: "example.sputnik-dao.near" }));
});
const base = {
  now: NOW, height: 100n, markets: [{ id: "0", outcome: null, resolve_by: "9000000" }], locked: {}, feesDue: 0n, minSweep: 1_000n,
};
const proposed = { stage: "proposed", window_ends_at: "1000000", panel: [], challenger: null, applied: false };
const disputed = {
  stage: "disputed", window_ends_at: "0", panel: [], challenger: "dave", applied: false,
  draw_after_height: "100", draw_by: "1500000", commit_ends_at: "0", panel_deadline: "0",
};
const seated = { ...disputed, panel: ["a", "b", "c"], commit_ends_at: "1700000", panel_deadline: "2000000" };
const names = (s) => dueActions(s).map((a) => `${a.contract}.${a.method}`);
const world = (c, extra = {}) => ({ ...base, ...extra, cases: { 0: c } });

test("an unchallenged proposal is finalized the moment its window ends, and not a nanosecond before", () => {
  assert.deepEqual(names(world(proposed)), ["oracle.finalize"]);
  assert.deepEqual(names(world(proposed, { now: NOW - 1n })), []);
});

test("a jury is drawn once the delay has passed, up to and including draw_by", () => {
  assert.deepEqual(names(world(disputed)), ["oracle.resolve_draw"]);
  assert.deepEqual(names(world(disputed, { height: 99n })), [], "too early");
  assert.deepEqual(names(world(disputed, { now: 1_500_000n })), ["oracle.resolve_draw"], "the last moment");
  assert.deepEqual(names(world(disputed, { now: 1_500_001n })), ["oracle.finalize"], "too late to draw, the round is over");
  assert.deepEqual(names(world(seated)), [], "already drawn");
});

test("a round nobody decided is finalized after the panel deadline, and not at it", () => {
  assert.deepEqual(names(world(seated, { now: 2_000_000n })), []);
  assert.deepEqual(names(world(seated, { now: 2_000_001n })), ["oracle.finalize"]);
});

test("a jury that was never drawn is finalized only after draw_by", () => {
  assert.deepEqual(names(world(disputed, { height: 99n, now: 1_500_000n })), []);
  assert.deepEqual(names(world(disputed, { height: 99n, now: 1_500_001n })), ["oracle.finalize"]);
});

test("a final answer the market has not received is applied again", () => {
  assert.deepEqual(names(world({ ...proposed, stage: "final", applied: false })), ["oracle.retry_apply"]);
  assert.deepEqual(names(world({ ...proposed, stage: "final", applied: true })), []);
});

test("a settled dispute whose jury is still locked is unlocked again, an unchallenged one never is", () => {
  const settled = { ...disputed, stage: "final", applied: true, panel: ["a"] };
  assert.deepEqual(names(world(settled, { locked: { 0: true } })), ["oracle.retry_unlock"]);
  assert.deepEqual(names(world(settled, { locked: { 0: false } })), []);
  assert.deepEqual(names(world({ ...settled, challenger: null }, { locked: { 0: true } })), []);
});

test("a market nobody answered is sent to the oracle's deadline answer, but never while a case exists", () => {
  const unanswered = { ...base, cases: { 0: null }, now: 9_000_000n };
  assert.deepEqual(names(unanswered), ["oracle.resolve_by_deadline"]);
  assert.deepEqual(names({ ...unanswered, now: 8_999_999n }), []);
  assert.deepEqual(names({ ...unanswered, markets: [{ id: "0", outcome: "yes", resolve_by: "9000000" }] }), [], "already resolved");
  assert.deepEqual(names({ ...unanswered, cases: { 0: { ...proposed, stage: "final", applied: false } } }), ["oracle.retry_apply"], "apply the real answer, do not void over it");
});

test("each call carries the market id and enough gas to settle", () => {
  const [a] = dueActions(world(disputed));
  assert.deepEqual(a.args, { market_id: "0" });
  assert.equal(a.gas, 300n * 10n ** 12n);
});

test("a jury needs as many different holders as its size, and two more to be safe", () => {
  assert.equal(juryProblems({ jurySize: 3, holders: 12 }).length, 0);
  assert.equal(juryProblems({ jurySize: 3, holders: 2 }).length, 1);
  assert.match(juryProblems({ jurySize: 3, holders: 2 })[0], /every draw will fail/);
  assert.match(juryProblems({ jurySize: 5, holders: 5 })[0], /7 are needed to be safe/);
});

test("a failed first round can only escalate with both juries and both parties as different holders", () => {
  assert.equal(secondJurySize(3), 7);
  assert.equal(secondJurySize(11), 21);
  assert.equal(secondJurySize(21), 21);
  const [problem] = juryProblems({ jurySize: 11, holders: 33 });
  assert.match(problem, /34 are needed \(11 \+ 21 \+ 2\)/);
  assert.equal(juryProblems({ jurySize: 11, holders: 34 }).length, 0);
  assert.equal(juryProblems({ jurySize: 3, holders: 11 }).length, 1, "3 + 7 + 2 = 12");
  assert.equal(juryProblems({ jurySize: 3, holders: 12 }).length, 0);
});

test("the storage margin is the balance minus 1e19 yocto a byte, and an account under the margin is a problem", () => {
  const near = (n) => nearToYocto(String(n));
  assert.equal(storageMargin({ amount: near(10).toString(), storage_usage: 100_000 }), near(9));
  assert.equal(formatNear(near(9) + nearToYocto("0.0129")), "9.012 NEAR");
  assert.equal(nearToYocto("0.5"), 5n * 10n ** 23n);
  assert.throws(() => nearToYocto("five"), /not an amount of NEAR/);
  const accounts = [
    { name: "market", id: "m.near", amount: near(10).toString(), storage_usage: 100_000 },
    { name: "oracle", id: "o.near", amount: near(5).toString(), storage_usage: 100_000 },
  ];
  const { lines, problems } = marginReport(accounts, near(5));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^market m\.near: balance 10\.000 NEAR, 100000 bytes of storage, 9\.000 NEAR left after storage$/);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^oracle o\.near has 4\.000 NEAR left/);
  assert.equal(marginReport(accounts, near(4)).problems.length, 0, "exactly at the margin is fine");
});

test("fees are swept once they reach the minimum, and never when there are none", () => {
  const sweeps = (extra) => dueActions(world(null, { now: 0n, ...extra })).filter((a) => a.method === "sweep_fees");
  assert.equal(sweeps({ feesDue: 999n }).length, 0);
  const [sweep] = sweeps({ feesDue: 1_000n });
  assert.deepEqual([sweep.contract, sweep.args, sweep.gas], ["market", {}, 100n * 10n ** 12n]);
  assert.equal(sweeps({ feesDue: 0n, minSweep: 0n }).length, 0);
  assert.ok(sweep.gas >= 87n * 10n ** 12n, "sweep_fees refuses less than 87 TGas");
});

test("the oracle's books match the verifier, or the verifier holds more, or money is missing", () => {
  assert.deepEqual(oracleReconciliation({ owed: "10000000", held: "10000000" }), {
    line: "oracle owes 10000000 and holds 10000000 in the verifier", problem: null,
  });
  const surplus = oracleReconciliation({ owed: "10000000", held: "14000000" });
  assert.match(surplus.line, /^oracle owes 10000000 and holds 14000000 in the verifier, 4000000 more than it owes/);
  assert.equal(surplus.problem, null, "a surplus is not an incident");
  const missing = oracleReconciliation({ owed: "10000000", held: "9999999" });
  assert.equal(missing.problem, "the oracle owes 10000000 but the verifier holds only 9999999 for it: 1 is missing");
  assert.equal(oracleReconciliation({ owed: "0", held: "0" }).problem, null);
});

test("the cursor advances over a finished prefix and stops at the first market that is not finished", () => {
  const market = (id, outcome = "yes") => ({ id: String(id), outcome, resolve_by: "9000000" });
  const final = { ...proposed, stage: "final", applied: true };
  const snap = (markets, cases, locked = {}) => ({ markets, cases, locked });
  const markets = [market(0), market(1), market(2, null), market(3)];
  const done = snap(markets, { 0: null, 1: final, 2: null, 3: null });
  assert.equal(advanceCursor(done, -1n), 1n, "market 2 has no answer, so 3 is not reached");
  assert.equal(advanceCursor(snap([market(0, null)], { 0: null }), -1n), -1n, "nothing finished");
  assert.equal(advanceCursor(snap([market(5), market(6)], { 5: null, 6: null }), 4n), 6n, "starts after the saved cursor");
  assert.equal(advanceCursor(snap([market(6)], { 6: null }), 4n), 4n, "a gap in the ids is never skipped");
});

test("a market with an answer is not finished while its case is unapplied, not final, or still holds a jury", () => {
  const reach = (c, locked = false) =>
    advanceCursor({ markets: [{ id: "0", outcome: "yes", resolve_by: "9" }], cases: { 0: c }, locked: { 0: locked } }, -1n);
  const final = { ...proposed, stage: "final", applied: true };
  assert.equal(reach(final), 0n);
  assert.equal(reach({ ...final, applied: false }), -1n);
  assert.equal(reach({ ...final, stage: "disputed" }), -1n);
  assert.equal(reach({ ...final, challenger: "dave" }, true), -1n);
});

test("the cursor file round trips, a missing file means no cursor, and a damaged one is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-"));
  const file = path.join(dir, "state.json");
  assert.equal(readCursor(file), -1n);
  assert.equal(readCursor(undefined), -1n);
  writeCursor(file, 41n);
  assert.equal(readCursor(file), 41n);
  fs.writeFileSync(file, JSON.stringify({ finished_through: 7 }));
  assert.throws(() => readCursor(file), /not a keeper state file/);
  fs.rmSync(dir, { recursive: true });
});

test("a key comes from the environment or from a private file, a scoped key replaces the default for its contract only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-"));
  const file = (name, mode, text) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text + "\n");
    fs.chmodSync(p, mode);
    return p;
  };
  assert.deepEqual(resolveKeys({}, { KEEPER_KEY: "env-key" }), { default: "env-key", oracle: undefined, market: undefined });
  const keys = resolveKeys(
    { "key-file": file("d", 0o600, "file-key"), "oracle-key-file": file("o", 0o400, "oracle-key") },
    { KEEPER_KEY: "env-key", KEEPER_MARKET_KEY: "market-env" },
  );
  assert.deepEqual(keys, { default: "file-key", oracle: "oracle-key", market: "market-env" });
  assert.throws(() => readKeyFile(file("group", 0o640, "x")), /can be read by group or others \(mode 640\)/);
  assert.throws(() => readKeyFile(file("world", 0o644, "x")), /chmod 600/);
  assert.throws(() => resolveKeys({ "market-key-file": file("loose", 0o604, "x") }, {}), /group or others/);
  fs.rmSync(dir, { recursive: true });
});

test("a key on the command line is refused", () => {
  for (const flag of ["key", "oracle-key", "market-key"]) {
    assert.throws(() => refuseKeyFlags({ [flag]: "ed25519:abc" }), new RegExp(`--${flag} is refused`));
  }
  refuseKeyFlags({ "key-file": "k" });
});
