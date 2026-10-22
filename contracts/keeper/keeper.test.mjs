// Run with: node --test keeper/keeper.test.mjs keeper/treasury.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accessKeyReport, advanceCursor, daoReport, dueActions, formatNear, isOpen, juryProblems, marginReport, nearToYocto, options,
  readCursor, readKeyFile, reconcile, reconciliation, refuseKeyFlags, resolveKeys, secondJurySize, storageMargin, verifierProblems,
  writeCursor, refuseRetiredController,
} from "./keeper.mjs";
import { b58encode } from "./chain.mjs";

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

test("the books match the verifier, or the verifier holds more, or money is missing", () => {
  const oracle = (owed, held) => reconciliation({ name: "oracle", owed, held });
  assert.deepEqual(oracle("10000000", "10000000"), { line: "oracle owes 10000000 and holds 10000000 in the verifier", problem: null });
  const surplus = oracle("10000000", "14000000");
  assert.match(surplus.line, /^oracle owes 10000000 and holds 14000000 in the verifier, 4000000 more than it owes/);
  assert.equal(surplus.problem, null, "a surplus is not an incident");
  assert.equal(oracle("10000000", "9999999").problem, "the oracle owes 10000000 but the verifier holds only 9999999 for it: 1 is missing");
  assert.equal(oracle("0", "0").problem, null);
  const market = reconciliation({ name: "market", owed: 7n, held: 5n });
  assert.equal(market.problem, "the market owes 7 but the verifier holds only 5 for it: 2 is missing");
});

test("the Council's figure is a floor: holding more is normal and holding less is missing money", () => {
  const council = (owed, held) => reconciliation({ name: "council", owed, held, exact: false });
  assert.equal(council(100n, 100n).line, "council owes at least 100 and holds 100 in the verifier");
  assert.equal(council(100n, 100n).problem, null);
  assert.match(council(100n, 103n).line, /^council owes at least 100 and holds 103 in the verifier, 3 more than it needs/);
  assert.equal(council(100n, 103n).problem, null);
  assert.equal(council(100n, 99n).problem, "the council owes at least 100 but the verifier holds only 99 for it: 1 is missing");
});

test("a shortfall is read again a few blocks later and reported only if it is still there", async () => {
  const feed = (...reads) => {
    const waits = [];
    let n = 0;
    return { read: async () => reads[Math.min(n++, reads.length - 1)], wait: async (blocks) => waits.push(blocks), waits, reads: () => n };
  };
  const ok = feed({ owed: 5n, held: 5n });
  assert.deepEqual(await reconcile(ok.read, ok.wait), { owed: 5n, held: 5n });
  assert.deepEqual([ok.reads(), ok.waits], [1, []], "nothing to doubt, nothing waited for");
  const surplus = feed({ owed: 5n, held: 9n });
  await reconcile(surplus.read, surplus.wait);
  assert.deepEqual([surplus.reads(), surplus.waits], [1, []], "a surplus is not read again");
  const settled = feed({ owed: 5n, held: 4n }, { owed: 5n, held: 5n });
  assert.deepEqual(await reconcile(settled.read, settled.wait), { owed: 5n, held: 5n });
  assert.deepEqual([settled.reads(), settled.waits], [2, [3]], "read again after 3 blocks, and it was a payout in flight");
  const missing = feed({ owed: 5n, held: 4n });
  assert.deepEqual(await reconcile(missing.read, missing.wait), { owed: 5n, held: 4n });
  assert.deepEqual([missing.reads(), missing.waits], [3, [3, 3]], "three reads, 3 blocks apart");
  const worse = feed({ owed: 5n, held: 4n }, { owed: 5n, held: 4n }, { owed: 5n, held: 1n });
  assert.equal((await reconcile(worse.read, worse.wait)).held, 1n, "the last read is the one reported");
});

test("the verifier's view of a contract is a problem when it has a key, refuses its own calls, or has locked it", () => {
  const view = { name: "market", id: "m.near", keys: [], predecessorAuth: true, locked: false };
  assert.deepEqual(verifierProblems(view), []);
  assert.match(verifierProblems({ ...view, keys: ["ed25519:abc"] })[0], /^market m\.near has 1 public key registered in the verifier: a key can move its funds/);
  assert.match(verifierProblems({ ...view, keys: ["a", "b"] })[0], /has 2 public keys registered/);
  assert.match(verifierProblems({ ...view, predecessorAuth: false })[0], /^market m\.near does not authenticate by predecessor/);
  assert.match(verifierProblems({ ...view, locked: true })[0], /^market m\.near is locked in the verifier.*stop advertising deposits/);
  assert.equal(verifierProblems({ ...view, keys: ["a"], predecessorAuth: false, locked: true }).length, 3);
});

test("access keys are counted, and are a problem only when the contracts are expected to be sealed", () => {
  const accounts = [{ name: "market", id: "m.near", count: 1 }, { name: "oracle", id: "o.near", count: 0 }, { name: "council", id: "c.near", count: 2 }];
  assert.deepEqual(accessKeyReport(accounts, false), { line: "access keys: market 1, oracle 0, council 2", problems: [] });
  assert.deepEqual(accessKeyReport(accounts, true).problems, [
    "market m.near still has 1 access key: the owner has not sealed it",
    "council c.near still has 2 access keys: the owner has not sealed it",
  ]);
  assert.deepEqual(accessKeyReport(accounts.map((a) => ({ ...a, count: 0 })), true).problems, []);
});

test("flags that carry no value do not swallow the next option", () => {
  assert.deepEqual(options(["--expect-sealed", "--rpc", "http://x", "--watch-dao", "--dry-run", "--market", "m.near"]), {
    "expect-sealed": true, rpc: "http://x", "watch-dao": true, "dry-run": true, market: "m.near",
  });
  assert.deepEqual(options(["--min-margin", "7", "stray"]), { "min-margin": "7" });
});

test("a proposal is open while it is in progress or failed and inside its voting period, to the nanosecond", () => {
  const period = "1000";
  const at = (status, submitted) => isOpen({ status, submission_time: String(submitted) }, 5000n, period);
  assert.equal(at("InProgress", 4000), true, "the last nanosecond");
  assert.equal(at("InProgress", 3999), false, "one nanosecond past the period");
  assert.equal(at("Failed", 4500), true, "a failed call can be retried until the period ends");
  for (const status of ["Approved", "Rejected", "Removed", "Expired", "Moved"]) assert.equal(at(status, 4500), false, status);
});

const DAO = "dao.sputnik-dao.near";
const CONTRACTS = { market: "market.near", oracle: "oracle.near", council: "council.near" };
const call = (receiver, method, args, extra = {}) => ({
  FunctionCall: { receiver_id: receiver, actions: [{ method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: "0", gas: "30000000000000", ...extra }] },
});
const pending = (id, kind, status = "InProgress") => ({ id, proposer: "alice.near", status, kind });

test("the DAO report lists the open proposals that name the contracts and flags the ones the allow-list refuses", async () => {
  const staged = b58encode(Buffer.alloc(32, 1));
  const unstaged = b58encode(Buffer.alloc(32, 2));
  const asked = [];
  const view = async (account, method, args) => {
    asked.push([account, method]);
    if (method === "is_staged") return args.code_hash === staged;
    throw new Error(`unexpected ${method}`);
  };
  const upgrade = (code_hash) => call(CONTRACTS.oracle, "upgrade", { code_hash }, { gas: "150000000000000" });
  const proposals = [
    pending(3, call(CONTRACTS.market, "set_fee_rate_bps", { fee_rate_bps: 150 })),
    pending(4, call(CONTRACTS.oracle, "set_bond", { bond: "1" }), "Failed"),
    pending(5, call(CONTRACTS.market, "set_min_sweep", { min_sweep: "1" })),
    pending(6, call(CONTRACTS.council, "set_cooldown_ns", { cooldown_ns: "0" })),
    pending(7, upgrade(unstaged)),
    pending(8, upgrade(staged)),
    pending(9, call("intents.near", "mt_transfer", {})),
    pending(10, { Transfer: { token_id: "", receiver_id: "eve.near", amount: "1" } }),
    pending(11, "Vote"),
    pending(12, { ChangePolicy: { policy: {} } }),
  ];
  const report = await daoReport({ proposals, treasuryId: DAO, contracts: CONTRACTS, view });
  assert.deepEqual(report.lines, [
    'DAO proposal 3 (InProgress, by alice.near): market.set_fee_rate_bps {"fee_rate_bps":150}',
    'DAO proposal 4 (Failed, by alice.near): oracle.set_bond {"bond":"1"}',
    "DAO proposal 5 (InProgress, by alice.near) names market.near",
    "DAO proposal 6 (InProgress, by alice.near) names council.near",
    "DAO proposal 7 (InProgress, by alice.near) names oracle.near",
    `DAO proposal 8 (InProgress, by alice.near): oracle.upgrade {"code_hash":"${staged}"}`,
    "4 other open DAO proposals (FunctionCall, Transfer, Vote, ChangePolicy)",
  ]);
  assert.equal(report.problems.length, 3);
  assert.equal(report.problems[0], "DAO proposal 5 names market.near and is not on the allow-list: market.set_min_sweep is not on the allow-list");
  assert.match(report.problems[1], /^DAO proposal 6 names council\.near and is not on the allow-list: cooldown_ns must be/);
  assert.match(report.problems[2], /^DAO proposal 7 names oracle\.near and is not on the allow-list: no code with the hash .* is staged on oracle\.near/);
  assert.ok(asked.every(([account, method]) => account === CONTRACTS.oracle && method === "is_staged"), "it only reads");
  assert.deepEqual((await daoReport({ proposals: [], treasuryId: DAO, contracts: CONTRACTS, view })).lines, ["no open DAO proposals"]);
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
