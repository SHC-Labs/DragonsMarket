// Run with: node --test keeper/
import test from "node:test";
import assert from "node:assert/strict";
import { dueActions, juryProblems } from "./keeper.mjs";

const NOW = 1_000_000n;
const base = { now: NOW, height: 100n, markets: [{ id: "0", outcome: null, resolve_by: "9000000" }], locked: {} };
const proposed = { stage: "proposed", window_ends_at: "1000000", panel: [], challenger: null, applied: false };
const disputed = {
  stage: "disputed", window_ends_at: "0", panel: [], challenger: "dave", applied: false,
  draw_after_height: "100", commit_ends_at: "1500000", panel_deadline: "2000000",
};
const names = (s) => dueActions(s).map((a) => `${a.contract}.${a.method}`);
const world = (c, extra = {}) => ({ ...base, ...extra, cases: { 0: c } });

test("an unchallenged proposal is finalized the moment its window ends, and not a nanosecond before", () => {
  assert.deepEqual(names(world(proposed)), ["oracle.finalize"]);
  assert.deepEqual(names(world(proposed, { now: NOW - 1n })), []);
});

test("a jury is drawn once the delay has passed and the commit phase is still open", () => {
  assert.deepEqual(names(world(disputed)), ["oracle.resolve_draw"]);
  assert.deepEqual(names(world(disputed, { height: 99n })), [], "too early");
  assert.deepEqual(names(world(disputed, { now: 1_500_000n })), [], "too late to draw");
  assert.deepEqual(names(world({ ...disputed, panel: ["a", "b", "c"] })), [], "already drawn");
});

test("a dispute nobody decided is finalized after the panel deadline, and not at it", () => {
  assert.deepEqual(names(world({ ...disputed, panel: ["a"] }, { now: 2_000_000n })), []);
  assert.deepEqual(names(world({ ...disputed, panel: ["a"] }, { now: 2_000_001n })), ["oracle.finalize"]);
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

test("a market nobody answered is voided after its deadline, but never while a case exists", () => {
  const unanswered = { ...base, cases: { 0: null }, now: 9_000_000n };
  assert.deepEqual(names(unanswered), ["market.void_if_unresolved"]);
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
  assert.equal(juryProblems({ jurySize: 3, holders: 5 }).length, 0);
  assert.equal(juryProblems({ jurySize: 3, holders: 4 }).length, 1);
  assert.match(juryProblems({ jurySize: 3, holders: 2 })[0], /every draw will fail/);
});
