import { describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({ config: { relayerId: "relayer.near", verifierId: "intents.near", backendUrl: "" } }));

import { confirmRelayed, oneAtATime, relayOutcome } from "../hooks";
import { RelayError, resubmit, type Attempt } from "../relay";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test fixture mutated freely by each case
type Tx = Record<string, any>;
const relayer = "relayer.near", verifier = "intents.near";
const encode = (args: unknown) => Buffer.from(JSON.stringify(args)).toString("base64");
function tx(hash: string, payload: string, target: string, over: (t: Tx) => void = () => {}) {
  const t: Tx = { final_execution_status: "FINAL", status: { SuccessValue: "" },
    transaction: { hash, signer_id: relayer, receiver_id: verifier, actions: [{ FunctionCall: { method_name: "execute_intents", args: encode({ signed: [{ standard: "erc191", payload, signature: "s" }] }), deposit: "0" } }] },
    transaction_outcome: { id: hash, outcome: { executor_id: relayer, receipt_ids: ["e"], status: { SuccessReceiptId: "e" } } },
    receipts_outcome: [
      { id: "e", outcome: { executor_id: verifier, receipt_ids: ["n"], status: { SuccessReceiptId: "n" } } },
      { id: "n", outcome: { executor_id: target, receipt_ids: [], status: { SuccessValue: "" } } },
    ] };
  over(t);
  return t;
}
const sent = { hashes: ["A", "B"], items: [{ standard: "erc191", payload: "pa", target: "market.near" }, { standard: "erc191", payload: "pb", target: "market.near" }] };
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

it("confirms only when every relayed transaction carries its own signed payload and the business effect shows", async () => {
  const chain: Record<string, unknown> = { A: tx("A", "pa", "market.near"), B: tx("B", "pb", "market.near") };
  const done = vi.fn(async () => true);
  await expect(confirmRelayed(sent, { read: async h => chain[h], done, timeoutMs: 10_000, ...clock() })).resolves.toBe(true);
  expect(done).toHaveBeenCalledTimes(1);
});

const forged: [string, Record<string, unknown>][] = [
  ["the second hash carries another payload", { A: tx("A", "pa", "market.near"), B: tx("B", "pa", "market.near") }],
  ["the hashes are swapped", { A: tx("A", "pb", "market.near"), B: tx("B", "pa", "market.near") }],
  ["the market refunded (failed receipt)", { A: tx("A", "pa", "market.near"), B: tx("B", "pb", "market.near", t => { t.receipts_outcome[1].outcome.status = { Failure: {} }; }) }],
  ["the market receipt is missing", { A: tx("A", "pa", "market.near"), B: tx("B", "pb", "elsewhere.near") }],
  ["another account signed it", { A: tx("A", "pa", "market.near"), B: tx("B", "pb", "market.near", t => { t.transaction.signer_id = "mallory.near"; }) }],
  ["it went to another contract", { A: tx("A", "pa", "market.near"), B: tx("B", "pb", "market.near", t => { t.transaction.receiver_id = "evil.near"; }) }],
  ["it is not final", { A: tx("A", "pa", "market.near"), B: tx("B", "pb", "market.near", t => { t.final_execution_status = "INCLUDED"; }) }],
  ["only the first transaction exists", { A: tx("A", "pa", "market.near") }],
];
for (const [name, chain] of forged) {
  it(`never reports success when ${name}`, async () => {
    const done = vi.fn(async () => true);
    await expect(confirmRelayed(sent, { read: async h => { if (!(h in chain)) throw new Error("unknown tx"); return chain[h]; }, done, timeoutMs: 10_000, ...clock() })).resolves.toBe(false);
    expect(done).not.toHaveBeenCalled();
  });
}

it("keeps waiting when the effect has not shown yet and gives up at the deadline", async () => {
  const chain: Record<string, unknown> = { A: tx("A", "pa", "market.near"), B: tx("B", "pb", "market.near") };
  await expect(confirmRelayed(sent, { read: async h => chain[h], done: async () => false, timeoutMs: 10_000, ...clock() })).resolves.toBe(false);
});

it("runs a second click as a no-op while the first is still in flight", async () => {
  const guard = oneAtATime();
  let release!: () => void;
  const first = guard(() => new Promise<boolean>(r => { release = () => r(true); }));
  const second = guard(async () => true);
  await expect(second).resolves.toBe(false);
  release();
  await expect(first).resolves.toBe(true);
  await expect(guard(async () => true)).resolves.toBe(true);
});

describe("settling a relay answer that is not a plain success", () => {
  const signed = [{ standard: "erc191" as const, payload: "pa", signature: "s" }, { standard: "erc191" as const, payload: "pb", signature: "s" }];
  const attempt: Attempt = { signed, items: sent.items };
  const failure = (message: string, status: number, index: number | null, extra: { hash?: string; completed?: string[]; unknown?: boolean; code?: string } = {}) => {
    const error = new RelayError(message, status, index, { hash: extra.hash, completed: extra.completed, unknown: extra.unknown, code: extra.code });
    error.attempt = attempt;
    return error;
  };
  const base = (read: (h: string) => Promise<unknown>, over: Partial<Parameters<typeof relayOutcome>[1]> = {}) =>
    ({ read, done: async () => true, doneMessage: "Bought.", timeoutMs: 10_000, ...clock(), ...over });

  it("keeps the attempt and offers Check again after a 503 or an HTML 502, never saying nothing was spent", async () => {
    const bodies = [new Response(JSON.stringify({ error: { code: "relay_unavailable" } }), { status: 503 }), new Response("<html>Bad gateway</html>", { status: 502 })];
    for (const body of bodies) {
      vi.stubGlobal("fetch", vi.fn(async () => body.clone()));
      const out = await relayOutcome(() => resubmit(attempt), base(async () => null));
      expect(out).toMatchObject({ phase: "unknown", attempt });
      expect(out.message).toMatch(/Check again/);
      expect(out.message).not.toMatch(/Nothing was spent/);
    }
    vi.unstubAllGlobals();
  });
  it("returns done for a plain success once every hash is proved", async () => {
    const chain: Record<string, unknown> = { A: tx("A", "pa", "market.near"), B: tx("B", "pb", "market.near") };
    await expect(relayOutcome(async () => sent, base(async h => chain[h]))).resolves.toEqual({ phase: "done", message: "Bought." });
  });
  it("checks the returned hash and reports success when an unconfirmed transaction did land", async () => {
    const chain: Record<string, unknown> = { B: tx("B", "pb", "market.near"), A: tx("A", "pa", "market.near") };
    const read = vi.fn(async (h: string) => chain[h]);
    const out = await relayOutcome(async () => { throw failure("maybe", 502, 1, { hash: "B", completed: ["A"], unknown: true }); }, base(read));
    expect(out).toEqual({ phase: "done", message: "Bought." });
    expect(read).toHaveBeenCalledWith("B");
  });
  it("keeps a final response with a mismatched receipt unresolved", async () => {
    const chain: Record<string, unknown> = { A: tx("A", "pa", "elsewhere.near") };
    const out = await relayOutcome(async () => { throw failure("maybe", 502, 0, { hash: "A", unknown: true }); }, base(async h => chain[h], {}));
    expect(out.phase).toBe("unknown");
    expect(out.message).toMatch(/Check again/);
  });
  it("stays unknown, with the same attempt to resend, when the hash cannot be read as final in time", async () => {
    const out = await relayOutcome(async () => { throw failure("maybe", 502, 0, { hash: "A", unknown: true }); }, base(async () => { throw new Error("unknown tx"); }));
    expect(out).toMatchObject({ phase: "unknown", attempt });
    expect(out.message).toMatch(/Check again|check again/);
  });
  it("stays unknown after a dropped connection without reading anything, because there is no hash", async () => {
    const read = vi.fn();
    const out = await relayOutcome(async () => { throw failure("may have gone through", 0, null, { unknown: true }); }, base(read));
    expect(out).toMatchObject({ phase: "unknown", attempt });
    expect(read).not.toHaveBeenCalled();
  });
  it("retains partial completion until every signed payload has settled or expired", async () => {
    const chain: Record<string, unknown> = { A: tx("A", "pa", "market.near") };
    const out = await relayOutcome(async () => { throw failure("The market refused.", 422, 1, { completed: ["A"] }); }, base(async h => chain[h]));
    expect(out.phase).toBe("unknown");
    expect(out.message).toMatch(/Check again/);
  });
  it("does not claim the setup is confirmed when its hash does not prove", async () => {
    const out = await relayOutcome(async () => { throw failure("The market refused.", 422, 1, { completed: ["A"] }); }, base(async () => { throw new Error("nope"); }));
    expect(out.message).not.toMatch(/account setup is confirmed/);
  });
  it("ignores unproven claims of nothing spent and retains the signed attempt", async () => {
    const out = await relayOutcome(async () => { throw failure("Nothing was spent.", 400, 0); }, base(async () => null));
    expect(out).toMatchObject({ phase: "unknown", attempt });
    expect(out.message).not.toMatch(/Nothing was spent/);
  });
  it("turns an error that is not a relay error into a failure", async () => {
    const out = await relayOutcome(async () => { throw new Error("boom"); }, base(async () => null));
    expect(out.phase).toBe("failed");
    expect(out.message).not.toMatch(/Nothing was spent/);
  });
  it("after a resend, an expired-deadline refusal is not a known failure: the first send may have landed", async () => {
    const out = await relayOutcome(async () => { throw failure("expired", 400, 0, { code: "invalid_deadline" }); }, base(async () => null));
    expect(out.phase).toBe("unknown");
    expect((out as { attempt: Attempt | null }).attempt).toBe(attempt);
    expect(out.message).toMatch(/Check again/);
  });
});
