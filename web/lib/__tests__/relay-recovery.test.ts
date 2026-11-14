import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../config", () => ({ config: { network: "mainnet", backendUrl: "https://api.example", relayerId: "relay.near", verifierId: "intents.near" } }));
import { signAndRelay } from "../relay";
import { clearRelay, readRelay, relayJournalKey, type PendingRelay } from "../relay-journal";
import { recoverRelay } from "../relay-recovery";
import { relayedIntentConsumed } from "../receipt-proof";

const account = "0x" + "ab".repeat(20);
const ctx = { verifier: "intents.near", collateral: "nep141:usdc.near", relayer: "relay.near" };
const action = { to: "market.near", amount: 1000000n, msg: "register" };
let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } });
  vi.stubGlobal("navigator", { locks: { request: (_: string, _options: unknown, work: (lock: object) => unknown) => work({}) } });
});
afterEach(() => vi.unstubAllGlobals());

it("retains exact signed bytes before exposure and prevents a second signature after reload", async () => {
  let signs = 0;
  const input = { ctx, signerId: account, shownFee: 1000n, actions: [action], sign: async (payload: string) => {
    signs++;
    return { standard: "erc191" as const, payload, signature: "s" };
  } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/fee")) return Response.json({ fee: "1000", validUntil: new Date(Date.now() + 590000).toISOString() });
    const saved = readRelay(stored.get(relayJournalKey(account))!, account)!;
    expect(saved.attempt!.signed).toEqual(JSON.parse(String(init?.body)).signed);
    throw new TypeError("connection lost after submission");
  }));
  await expect(signAndRelay(input)).rejects.toThrow(/may have gone through/);
  const reloaded = JSON.parse(JSON.stringify(readRelay(stored.get(relayJournalKey(account))!, account)));
  expect(reloaded.attempt.signed).toHaveLength(1);
  await expect(signAndRelay(input)).rejects.toThrow(/still needs confirmation/);
  expect(signs).toBe(1);
  expect(readRelay(stored.get(relayJournalKey(account))!, "0x" + "cd".repeat(20))).toBeNull();
});

it("storage failure before the first signature and missing Web Locks both prevent signing", async () => {
  const sign = vi.fn();
  const input = { ctx, signerId: account, shownFee: 1000n, actions: [action], sign };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ fee: "1000", validUntil: new Date(Date.now() + 590000).toISOString() })));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: vi.fn() });
  await expect(signAndRelay(input)).rejects.toThrow(/quota/);
  expect(sign).not.toHaveBeenCalled();
  vi.stubGlobal("navigator", {});
  await expect(signAndRelay(input)).rejects.toThrow(/Web Locks/);
  expect(sign).not.toHaveBeenCalled();
});

it("a rejected second signature clears only the unexposed placeholder", async () => {
  let signs = 0, posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!url.endsWith("/fee")) posts++;
    return Response.json({ fee: "1000", validUntil: new Date(Date.now() + 590000).toISOString() });
  }));
  await expect(signAndRelay({ ctx, signerId: account, shownFee: 1000n, actions: [action, action], sign: async payload => {
    if (++signs === 2) throw new Error("declined");
    return { standard: "erc191", payload, signature: "s" };
  } })).rejects.toThrow(/declined/);
  expect(stored.size).toBe(0);
  expect(posts).toBe(0);
});

function fixture() {
  const items = ["register", "buy:3:yes:1"].map((msg, i) => ({ standard: "erc191", target: "market.near",
    payload: JSON.stringify({ signer_id: account, verifying_contract: ctx.verifier, nonce: String(i),
      deadline: "2026-11-10T12:00:00.000Z", intents: [{ intent: "transfer", receiver_id: "market.near", msg }] }) }));
  const pending: PendingRelay = { version: 1, account, relayer: ctx.relayer, verifier: ctx.verifier,
    attempt: { signed: items.map(item => ({ standard: "erc191", payload: item.payload, signature: "s" })), items, hashes: ["A", "B"] } };
  const tx = (index: number, fail = false) => ({ final_execution_status: "FINAL", status: { SuccessValue: "" },
    transaction: { hash: index ? "B" : "A", signer_id: ctx.relayer, receiver_id: ctx.verifier,
      actions: [{ FunctionCall: { method_name: "execute_intents", deposit: "0", args: btoa(JSON.stringify({ signed: [pending.attempt!.signed[index]] })) } }] },
    transaction_outcome: { id: index ? "B" : "A", outcome: { executor_id: ctx.relayer, receipt_ids: ["v"], status: { SuccessReceiptId: "v" } } },
    receipts_outcome: [
      { id: "v", outcome: { executor_id: ctx.verifier, status: { SuccessValue: "" }, receipt_ids: ["m"], logs: ["EVENT_JSON:" + JSON.stringify({
        standard: "dip4", version: "0.4.3", event: "intents_executed", data: [{ account_id: account, nonce: String(index) }],
      })] } },
      { id: "m", outcome: { executor_id: "market.near", status: fail ? { Failure: { error: "slippage" } } : { SuccessValue: "" }, receipt_ids: [],
        logs: fail ? [] : ["EVENT_JSON:" + JSON.stringify({ standard: "market", version: "1.0.0", event: index ? "buy" : "registered",
          data: { account, market_id: "3", side: "yes" } })] } },
    ] });
  return { pending, tx };
}

it("recovers confirmed registration and an expired unused buy as partial completion", async () => {
  const { pending, tx } = fixture();
  pending.attempt!.hashes = ["A"];
  expect(await recoverRelay(pending, async () => tx(0), async () => ({ unused: [false, true] }))).toBe("failed");
  expect(await recoverRelay(pending, async () => tx(0), async () => ({ unused: [false, false] }))).toBe("unknown");
});

it("a failed callback is settled only with the matching nonce event and complete receipts", async () => {
  const { pending, tx } = fixture();
  const failed = tx(1, true);
  expect(await recoverRelay(pending, async hash => hash === "A" ? tx(0) : failed, async () => null)).toBe("failed");
  failed.receipts_outcome[0].outcome.logs = [];
  expect(await recoverRelay(pending, async hash => hash === "A" ? tx(0) : failed, async () => null)).toBe("unknown");
  const missing = tx(1, true);
  missing.receipts_outcome.pop();
  expect(relayedIntentConsumed(missing, "B", ctx.relayer, ctx.verifier, pending.attempt!.items[1])).toBe(false);
  expect(relayedIntentConsumed(tx(1, true), "B", "someone.near", ctx.verifier, pending.attempt!.items[1])).toBe(false);
});

it("clearing confirmation cannot remove a different saved request", () => {
  const { pending } = fixture();
  stored.set(relayJournalKey(account), JSON.stringify(pending));
  expect(() => clearRelay(localStorage, relayJournalKey(account), { ...pending, relayer: "other.near" })).toThrow(/changed/);
  expect(stored.size).toBe(1);
});
