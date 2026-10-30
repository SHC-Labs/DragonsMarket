// Run with: node --test keeper/keeper.test.mjs keeper/treasury.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  accessKeyReport, advanceCursor, councilFloor, daoReport, describeOutcome, drawableHolders, dueActions, formatNear, isOpen, juryProblems, marginReport, nearToYocto, options, wiringProblems,
  quarterEnd, quarterOf, readCursor, readKeyFile, reconcile, reconciliation, refuseKeyFlags, resolveKeys, secondJurySize, storageMargin, tokenProblems, verifierProblems,
  writeCursor, refuseRetiredController, releaseReport, validateActionKeys,
} from "./keeper.mjs";
import { b58encode } from "./chain.mjs";
import { hexToBase58, parseReleaseHashes } from "./release-check.mjs";

const NOW = 1_000_000n;

test("retired controller flags are rejected before any RPC call", () => {
  assert.throws(() => refuseRetiredController({ governance: "old.example.near" }), /retired/);
  assert.doesNotThrow(() => refuseRetiredController({ treasury: "example.sputnik-dao.near" }));
});
const base = {
  market: "market.near", now: NOW, height: 100n, markets: [{ id: "0", outcome: null, resolve_by: "9000000" }], locked: {}, feesDue: 0n, minSweep: 1_000n,
  sweepIntervalNs: 3_600n * 10n ** 9n, settleWaitNs: 600n * 10n ** 9n,
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

test("each oracle call carries the market account, the market id and enough gas to settle", () => {
  const [a] = dueActions(world(disputed));
  assert.deepEqual(a.args, { market: "market.near", market_id: "0" });
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

test("a payout in flight lowers what the verifier must hold, and only that much", () => {
  const books = (held, inFlight) => reconciliation({ name: "market", owed: 100n, held, inFlight });
  const exact = books(60n, 40n);
  assert.deepEqual(exact, { line: "market owes 100, 40 of it in flight and holds 60 in the verifier", problem: null });
  assert.equal(books(100n, 40n).problem, null, "the transfer had not left yet");
  assert.match(books(130n, 40n).line, /, 30 more than it owes/);
  assert.equal(books(59n, 40n).problem, "the market owes 100, 40 of it in flight but the verifier holds only 59 for it: 1 is missing");
  assert.equal(books(60n, 0n).problem, "the market owes 100 but the verifier holds only 60 for it: 40 is missing", "nothing in flight behaves as before");
  assert.equal(reconciliation({ name: "oracle", owed: 100n, held: 100n }).line, "oracle owes 100 and holds 100 in the verifier");
});

test("the Council's figure is a floor: holding more is normal and holding less is missing money", () => {
  const council = (owed, held) => reconciliation({ name: "council", owed, held, exact: false });
  assert.equal(council(100n, 100n).line, "council owes at least 100 and holds 100 in the verifier");
  assert.equal(council(100n, 100n).problem, null);
  assert.match(council(100n, 103n).line, /^council owes at least 100 and holds 103 in the verifier, 3 more than it needs/);
  assert.equal(council(100n, 103n).problem, null);
  assert.equal(council(100n, 99n).problem, "the council owes at least 100 but the verifier holds only 99 for it: 1 is missing");
});

test("the Council's floor is what it took in less what it paid and less the claims on their way", () => {
  const totals = (total_received, total_paid, pending_claims) => ({ total_received, total_paid, pending_claims });
  assert.equal(councilFloor(totals("1600000", "0", "0")), 1600000n);
  assert.equal(councilFloor(totals("1600000", "871005", "0")), 728995n);
  assert.equal(councilFloor(totals("1600000", "871005", "444970")), 284025n, "a claim in flight has already left the verifier");
  assert.equal(councilFloor(totals("0", "0", "0")), 0n);
  assert.equal(councilFloor(totals("340282366920938463463374607431768211455", "1", "0")), 340282366920938463463374607431768211454n);
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
  const flying = feed({ owed: 5n, held: 3n, inFlight: 2n });
  assert.deepEqual(await reconcile(flying.read, flying.wait), { owed: 5n, held: 3n, inFlight: 2n });
  assert.deepEqual([flying.reads(), flying.waits], [1, []], "holding owed less what is in flight is not doubted");
  const short = feed({ owed: 5n, held: 2n, inFlight: 2n });
  await reconcile(short.read, short.wait);
  assert.deepEqual([short.reads(), short.waits], [3, [3, 3]], "below owed less what is in flight is read again");
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

test("the token must know the market and the verifier, or a deposit or buy by token cannot arrive", () => {
  const view = { token: "usdc.near", market: "m.near", marketRegistered: true, verifier: "v.near", verifierRegistered: true };
  assert.deepEqual(tokenProblems(view), []);
  assert.match(tokenProblems({ ...view, marketRegistered: false })[0], /^market m\.near is not registered with the token usdc\.near: the token refuses every deposit and buy/);
  assert.match(tokenProblems({ ...view, verifierRegistered: false })[0], /^the verifier v\.near is not registered with the token usdc\.near: .*goes back to its sender$/);
  assert.equal(tokenProblems({ ...view, marketRegistered: false, verifierRegistered: false }).length, 2);
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
    pending(5, call(CONTRACTS.market, "settle_leg", { sweep_id: "1" })),
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
  assert.equal(report.problems[0], "DAO proposal 5 names market.near and is not on the allow-list: market.settle_leg is not on the allow-list");
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
  assert.deepEqual(resolveKeys({}, { KEEPER_KEY: "env-key" }), { default: "env-key", oracle: undefined, market: undefined, council: undefined });
  const keys = resolveKeys(
    { "key-file": file("d", 0o600, "file-key"), "oracle-key-file": file("o", 0o400, "oracle-key") },
    { KEEPER_KEY: "env-key", KEEPER_MARKET_KEY: "market-env" },
  );
  assert.deepEqual(keys, { default: "file-key", oracle: "oracle-key", market: "market-env", council: undefined });
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

test("only holders with a seat that is neither serving nor leaving can be drawn", () => {
  const holders = drawableHolders([
    { owner: "a.near", unlock_requested_at: null, serving: null },
    { owner: "a.near", unlock_requested_at: null, serving: null },
    { owner: "b.near", unlock_requested_at: "1790812800000000000", serving: null },
    { owner: "c.near", unlock_requested_at: null, serving: "7" },
    { owner: "d.near", unlock_requested_at: "1", serving: "7" },
    { owner: "e.near", unlock_requested_at: null, serving: null },
  ]);
  assert.deepEqual([...holders].sort(), ["a.near", "e.near"]);
});

test("a council of leaving holders is short of the drawable holders a jury needs", () => {
  const stakes = Array.from({ length: 12 }, (_, i) => ({ owner: `h${i}.near`, unlock_requested_at: i < 3 ? "1" : null, serving: null }));
  assert.equal(juryProblems({ jurySize: 3, holders: drawableHolders(stakes).size }).length, 1, "9 drawable of the 12 needed");
  assert.equal(juryProblems({ jurySize: 3, holders: drawableHolders(stakes.map((s) => ({ ...s, unlock_requested_at: null }))).size }).length, 0);
});

const ns = (iso) => BigInt(Date.parse(iso)) * 1_000_000n;
const DAY = 86_400n * 10n ** 9n;
const HOUR = 3_600n * 10n ** 9n;
const MINUTE = 60n * 10n ** 9n;
const Q4_2026 = 2026 * 4 + 3;
const idle = { ...base, now: 0n, cases: { 0: null }, markets: [] };
const council = (extra = {}) => ({ lastTick: ns("2026-11-01T00:00:00Z"), nextToFinalize: Q4_2026, closeGraceNs: 7n * DAY, ...extra });
const withCouncil = (now, extra) => ({ ...idle, now: ns(now), council: council(extra) });
const councilCalls = (s) => dueActions(s).filter((a) => a.contract === "council").map((a) => a.method);

test("quarters are numbered year * 4 + quarter and end where the next one starts", () => {
  assert.equal(quarterOf(ns("2026-12-31T23:59:59Z")), Q4_2026);
  assert.equal(quarterOf(ns("2027-01-01T00:00:00Z")), Q4_2026 + 1);
  assert.equal(quarterEnd(Q4_2026), ns("2027-01-01T00:00:00Z"));
  assert.equal(quarterEnd(Q4_2026 + 1), ns("2027-04-01T00:00:00Z"));
});

test("advance_quarters is sent once the quarter of now is not the quarter of the last tick, and not before", () => {
  assert.deepEqual(councilCalls(withCouncil("2026-12-31T23:59:59Z")), []);
  assert.deepEqual(councilCalls(withCouncil("2027-01-01T00:00:00Z")), ["advance_quarters"]);
  const [advance] = dueActions(withCouncil("2027-01-01T00:00:00Z"));
  assert.deepEqual([advance.contract, advance.args, advance.gas], ["council", {}, 50n * 10n ** 12n]);
});

test("finalize_quarter is sent for the next quarter only after its end plus the grace, and only that quarter", () => {
  const end = quarterEnd(Q4_2026);
  const caught = { lastTick: end };
  assert.deepEqual(councilCalls({ ...withCouncil("2027-01-01T00:00:00Z", caught), now: end + 7n * DAY - 1n }), []);
  const only = dueActions({ ...withCouncil("2027-01-01T00:00:00Z", caught), now: end + 7n * DAY });
  const finalize = only.find((a) => a.method === "finalize_quarter");
  assert.deepEqual([finalize.contract, finalize.args, finalize.gas], ["council", { quarter: Q4_2026 }, 50n * 10n ** 12n]);
  const behind = dueActions({ ...withCouncil("2027-01-01T00:00:00Z", { lastTick: end - DAY }), now: end + 7n * DAY });
  assert.deepEqual(behind.map((a) => a.method), ["advance_quarters", "finalize_quarter"], "the ledger moves first");
  const later = dueActions({ ...withCouncil("2027-05-01T00:00:00Z", { nextToFinalize: Q4_2026 + 1, lastTick: quarterEnd(Q4_2026 + 1) }) });
  assert.deepEqual(later.map((a) => a.args.quarter), [Q4_2026 + 1], "in order: the next one, not the newest");
});

test("finalize_quarter waits while one advance cannot bring the ledger up to the quarter's end", () => {
  const stale = council({ lastTick: ns("2024-02-01T00:00:00Z") });
  assert.deepEqual(councilCalls({ ...idle, now: ns("2027-03-01T00:00:00Z"), council: stale }), ["advance_quarters"]);
  assert.deepEqual(councilCalls({ ...idle, now: ns("2027-03-01T00:00:00Z"), council: council({ lastTick: ns("2025-04-01T00:00:00Z") }) }), ["advance_quarters", "finalize_quarter"]);
});

test("a finalize refused for an open jury is reported as waiting, any other failure is shown as it is", () => {
  const finalize = { method: "finalize_quarter" };
  assert.match(describeOutcome(finalize, 'FAILED {"ActionError":"Smart contract panicked: a jury drawn in this quarter is still open"}'), /^waiting/);
  assert.equal(describeOutcome(finalize, "FAILED other"), "FAILED other");
  assert.equal(describeOutcome({ method: "sweep_fees" }, "ok"), "ok");
});

const sweepAt = (id, at, status) => ({ id: String(id), at: String(at), council: { status }, treasury: { status: "settled" } });
const settling = (sweeps, now) => dueActions({ ...idle, now, sweeps }).filter((a) => a.method === "settle_leg");

test("settle_leg is sent for an unresolved leg ten minutes after its sweep, never for a younger, settled or refused one", () => {
  const at = ns("2027-01-01T00:00:00Z");
  const sweeps = [sweepAt(4, at, "unresolved"), sweepAt(5, at, "settled"), sweepAt(6, at, "refused"), sweepAt(7, at, "pending")];
  assert.deepEqual(settling(sweeps, at + 10n * MINUTE - 1n), []);
  const [settle, ...rest] = settling(sweeps, at + 10n * MINUTE);
  assert.equal(rest.length, 0);
  assert.deepEqual([settle.contract, settle.args, settle.gas], ["market", { sweep_id: "4" }, 50n * 10n ** 12n]);
  assert.ok(settle.gas >= 30n * 10n ** 12n, "settle_leg refuses less than 30 TGas");
});

test("every recent sweep with an unresolved leg gets its own settle_leg", () => {
  const at = ns("2027-01-01T00:00:00Z");
  const sweeps = [sweepAt(1, at, "unresolved"), sweepAt(2, at, "settled"), sweepAt(3, at, "unresolved")];
  assert.deepEqual(settling(sweeps, at + HOUR).map((a) => a.args.sweep_id), ["1", "3"]);
});

test("no sweep is sent within an hour of the last one, and one is sent from the hour on", () => {
  const last = ns("2027-01-01T00:00:00Z");
  const sweeps = (now, lastSweepAt) => dueActions({ ...idle, now, feesDue: 1_000n, lastSweepAt }).filter((a) => a.method === "sweep_fees");
  assert.equal(sweeps(last + HOUR - 1n, last).length, 0);
  assert.equal(sweeps(last + HOUR, last).length, 1);
  assert.equal(sweeps(last + 1n, null).length, 1, "no sweep yet");
});

test("the sweep gap and the settle wait follow the market's settings once the owner has changed them", () => {
  const at = ns("2027-01-01T00:00:00Z");
  const timing = { sweepIntervalNs: 2n * HOUR, settleWaitNs: 30n * MINUTE };
  const due = (now) => dueActions({ ...idle, ...timing, now, feesDue: 1_000n, lastSweepAt: at, sweeps: [sweepAt(1, at, "unresolved")] });
  assert.deepEqual(due(at + 30n * MINUTE - 1n).map((a) => a.method), []);
  assert.deepEqual(due(at + 30n * MINUTE).map((a) => a.method), ["settle_leg"]);
  assert.deepEqual(due(at + HOUR).map((a) => a.method), ["settle_leg"], "an hour is not enough once the gap is two");
  assert.deepEqual(due(at + 2n * HOUR).map((a) => a.method), ["settle_leg", "sweep_fees"]);
});

// ---- --release ---------------------------------------------------------------------------------------------------

const HASHES = { market: "11".repeat(32), oracle: "22".repeat(32), council: "33".repeat(32) };
const RELEASE_LIST = ["Release hashes", "", ...Object.entries(HASHES).map(([n, h]) => `${n} sha256:${h}`), `commit ${"a".repeat(40)}`, "toolchain 1.86.0"].join("\n");

async function fakeRpc(codeHashes, run) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const account = JSON.parse(body).params.account_id;
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "dontcare", result: { code_hash: codeHashes[account] } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const liveFor = (hexes) => ({ "market.near": hexToBase58(hexes.market), "oracle.near": hexToBase58(hexes.oracle), "council.near": hexToBase58(hexes.council) });
const release = (url) => releaseReport({ rpc: url, market: "market.near", oracle: "oracle.near", council: "council.near" }, parseReleaseHashes(RELEASE_LIST));

test("--release passes with one line when the live code matches the list", async () => {
  const report = await fakeRpc(liveFor(HASHES), release);
  assert.deepEqual(report, { lines: ["release: live code matches the release hash list"], differs: false });
});

test("--release fails and names the contract whose live code differs", async () => {
  const report = await fakeRpc(liveFor({ ...HASHES, oracle: "44".repeat(32) }), release);
  assert.equal(report.differs, true);
  assert.equal(report.lines[0], "release: 1 contract(s) differ from the release hash list");
  assert.match(report.lines[1], /^release: oracle: live code hash /);
  assert.equal(report.lines.length, 2);
});

test("--release with a bad list prints the reason and exits 1 before any RPC call", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-release-"));
  const file = path.join(dir, "list.txt");
  fs.writeFileSync(file, "not a hash list\n");
  const out = spawnSync(process.execPath, [path.join(import.meta.dirname, "keeper.mjs"), "check", "--rpc", "http://127.0.0.1:1", "--market", "market.near", "--oracle", "oracle.near", "--council", "council.near", "--release", file], { encoding: "utf8" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /release list must start with the line "Release hashes"/);
});


test("a batch validates every key scope before dispatch and caches shared key reads", async t => {
  const key = "ed25519:" + b58encode(Buffer.alloc(64, 7));
  const opts = { rpc: "http://rpc.invalid", account: "keeper.near", market: "market.near", oracle: "oracle.near" };
  const actions = [{contract:"oracle",method:"finalize"},{contract:"market",method:"sweep_fees"}];
  let calls = 0;
  let permission = "FullAccess";
  t.mock.method(globalThis,"fetch",async()=>{ calls++;return {ok:true,json:async()=>({result:{permission}})}; });
  await assert.rejects(validateActionKeys(opts,{},actions),/no key for oracle/);
  assert.equal(calls,0);
  await validateActionKeys(opts,{default:key},actions);
  assert.equal(calls,1);
  permission = {FunctionCall:{receiver_id:"market.near",method_names:["sweep_fees"],allowance:"1000"}};
  await assert.rejects(validateActionKeys(opts,{default:key},actions),/Receiver/);
  permission = {FunctionCall:{receiver_id:"oracle.near",method_names:["retry_apply"],allowance:"1000"}};
  await assert.rejects(validateActionKeys(opts,{default:key},actions.slice(0,1)),/does not allow finalize/);
  permission = {FunctionCall:{receiver_id:"oracle.near",method_names:[],allowance:"0"}};
  await assert.rejects(validateActionKeys(opts,{default:key},actions.slice(0,1)),/exhausted/);
  permission.FunctionCall.allowance = null;
  await validateActionKeys(opts,{default:key},actions.slice(0,1));
});

test("wiring check passes when every contract names the same oracle, Council, verifier and token", () => {
  const shared = { verifier: "v.near", collateral_token_id: "nep141:usdc.near" };
  const configs = {
    market: { ...shared, oracle: "o.near", revenue_pool: "c.near" },
    oracle: { ...shared, council: "c.near" },
    council: { ...shared, oracle: "o.near" },
    rounds: { ...shared, treasury: "t.near" },
  };
  configs.market.treasury = "t.near";
  const ids = { oracle: "o.near", council: "c.near" };
  assert.deepEqual(wiringProblems(configs, ids), []);
  assert.deepEqual(wiringProblems({ ...configs, council: { ...shared, oracle: "x.near" } }, ids), ["the Council's oracle is x.near, expected o.near"]);
  assert.deepEqual(wiringProblems({ ...configs, market: { ...configs.market, revenue_pool: null } }, ids), ["the market's revenue_pool is unset, expected c.near"]);
  assert.deepEqual(wiringProblems({ ...configs, rounds: { ...configs.rounds, treasury: null } }, ids), ["the rounds contract's treasury is unset, expected t.near"]);
  assert.deepEqual(wiringProblems({ ...configs, rounds: { ...configs.rounds, collateral_token_id: "nep141:other.near" } }, ids), ["the rounds's collateral token is nep141:other.near, expected nep141:usdc.near"]);
});
