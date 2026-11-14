import { describe, expect, it, vi } from "vitest";
import { readWalletCall, recordWalletSend, walletCallConfirmed, walletJournalKey } from "../wallet-journal";
import type { FunctionCall } from "../market";

const call: FunctionCall = { receiverId: "market.near", methodName: "sell", args: { market_id: "7", shares: "1000000" }, gas: "100000000000000", deposit: "1" };
const hash = "B".repeat(44);
function storage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
}
describe("durable wallet request journal", () => {
  it("records before sending and retains the full hash and immutable request", async () => {
    const store = storage(), original = structuredClone(call);
    const sent = await recordWalletSend(store, "key", "alice.near", original, async input => {
      expect(readWalletCall(store.getItem("key"), "alice.near")?.call).toEqual(call);
      input.args.shares = "9"; return hash;
    });
    original.args.shares = "2";
    expect(sent.call).toEqual(call);
    expect(readWalletCall(store.getItem("key"), "alice.near")?.hash).toBe(hash);
    const retry = vi.fn();
    await expect(recordWalletSend(store, "key", "alice.near", call, retry)).rejects.toThrow("still needs confirmation");
    expect(retry).not.toHaveBeenCalled();
  });
  it("does not submit if storage is unavailable or silently drops the write", async () => {
    const send = vi.fn();
    for (const setItem of [() => { throw new Error("quota"); }, () => {}]) {
      await expect(recordWalletSend({ getItem: () => null, setItem }, "key", "alice.near", call, send)).rejects.toThrow();
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("retains an uncertain request when the wallet throws or returns an invalid hash", async () => {
    for (const send of [async () => { throw new Error("wallet disconnected after sending"); }, async () => "short"]) {
      const store = storage();
      await expect(recordWalletSend(store, "key", "alice.near", call, send)).rejects.toThrow();
      expect(readWalletCall(store.getItem("key"), "alice.near")).toMatchObject({ hash: null, call });
    }
  });
  it("keeps the original request if saving the returned hash fails", async () => {
    const store = storage(), send = vi.fn(async () => hash);
    let writes = 0;
    await expect(recordWalletSend({ getItem: store.getItem, setItem: (key, value) => {
      if (++writes === 2) throw new Error("storage full");
      store.setItem(key, value);
    } }, "key", "alice.near", call, send)).rejects.toThrow("storage full");
    expect(send).toHaveBeenCalledTimes(1);
    expect(readWalletCall(store.getItem("key"), "alice.near")).toMatchObject({ call, hash: null });
    expect(readWalletCall(store.getItem("key"), "bob.near")).toBeNull();
  });
  it("rejects malformed records and scopes pending requests to the network and account", () => {
    for (const raw of ["{", "null", "[]", JSON.stringify({ version: 2 }), "x".repeat(65537)]) {
      expect(readWalletCall(raw, "alice.near")).toBeNull();
    }
    expect(walletJournalKey("mainnet", "alice.near")).not.toBe(walletJournalKey("testnet", "alice.near"));
    expect(walletJournalKey("mainnet", "alice.near")).not.toBe(walletJournalKey("mainnet", "bob.near"));
  });
  it("refuses balance-only or unrelated success as proof", async () => {
    const sent = await recordWalletSend(storage(), "key", "alice.near", call, async () => hash);
    expect(walletCallConfirmed(sent, { status: { SuccessValue: "" } })).toBe(false);
    expect(walletCallConfirmed({ ...sent, hash: null }, {})).toBe(false);
  });
});
