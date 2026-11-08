import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../config", () => ({ config: {
  verifierId: "intents.near", tokenId: "usdc.near", collateralTokenId: "nep141:usdc.near",
} }));
vi.mock("../rpc", () => ({ view: vi.fn(), finalTransaction: vi.fn() }));
vi.mock("../market", () => ({ tokenBalance: vi.fn() }));
import { view } from "../rpc";
import { tokenBalance } from "../market";
import { cashOutCall, cashOutStorage, cashOutConfirmed, pendingCashOut } from "../cash-out";

const hash = "A".repeat(44);
const encoded = (value: unknown) => btoa(JSON.stringify(value));
function transaction() {
  return {
    final_execution_status: "FINAL", status: { SuccessValue: encoded("1000000") },
    transaction: { hash, signer_id: "alice.near", receiver_id: "intents.near", actions: [{ FunctionCall: {
      method_name: "ft_withdraw", deposit: "1",
      args: encoded({ token: "usdc.near", receiver_id: "alice.near", amount: "1000000" }),
    } }] },
    transaction_outcome: { id: hash, outcome: { executor_id: "alice.near",
      receipt_ids: ["withdraw"], status: { SuccessReceiptId: "withdraw" } } },
    receipts_outcome: [
      { id: "withdraw", outcome: { executor_id: "intents.near", receipt_ids: ["transfer", "resolve"],
        status: { SuccessReceiptId: "resolve" }, logs: [] as string[] } },
      { id: "transfer", outcome: { executor_id: "usdc.near", receipt_ids: [] as string[], status: { SuccessValue: "" },
        logs: ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"old_owner_id":"intents.near","new_owner_id":"alice.near","amount":"1000000"}]}'] } },
      { id: "resolve", outcome: { executor_id: "intents.near", receipt_ids: [] as string[], status: { SuccessValue: encoded("1000000") }, logs: [] as string[] } },
    ],
  };
}

describe("human wallet cash-out", () => {
  beforeEach(() => vi.resetAllMocks());
  it("limits a withdrawal to a positive exact amount and the connected account", () => {
    expect(cashOutCall("alice.near", 1000000n)).toMatchObject({ receiverId: "intents.near", methodName: "ft_withdraw",
      deposit: "1", args: { token: "usdc.near", receiver_id: "alice.near", amount: "1000000" } });
    for (const amount of [0n, -1n, 2n ** 128n]) expect(() => cashOutCall("alice.near", amount)).toThrow();
    expect(() => cashOutCall("alice.near/evil", 1n)).toThrow();
  });
  it("checks available balance and prepares bounded token storage separately", async () => {
    vi.mocked(tokenBalance).mockResolvedValue("1000000");
    vi.mocked(view).mockResolvedValueOnce(null).mockResolvedValueOnce({ min: "1250000000000000000000" });
    expect(await cashOutStorage("alice.near", 1000000n)).toMatchObject({ receiverId: "usdc.near",
      methodName: "storage_deposit", deposit: "1250000000000000000000", args: { account_id: "alice.near", registration_only: true } });
    vi.mocked(view).mockResolvedValue({ total: "1250000000000000000000" });
    expect(await cashOutStorage("alice.near", 1000000n)).toBeNull();
    await expect(cashOutStorage("alice.near", 1000001n)).rejects.toThrow("balance");
    vi.mocked(view).mockResolvedValueOnce(null).mockResolvedValueOnce({ min: String(10n ** 24n) });
    await expect(cashOutStorage("alice.near", 1n)).rejects.toThrow("storage");
  });
  it("requires the exact signed action, complete successful receipt graph and actual token payout", () => {
    expect(cashOutConfirmed(transaction(), hash, "alice.near", 1000000n)).toBe(true);
    const changes: ((tx: ReturnType<typeof transaction>) => void)[] = [
      tx => { tx.final_execution_status = "EXECUTED"; },
      tx => { tx.status.SuccessValue = encoded("0"); },
      tx => { tx.transaction.hash = "different"; },
      tx => { tx.transaction_outcome.id = "different"; },
      tx => { tx.transaction_outcome.outcome.executor_id = "other.near"; },
      tx => { tx.transaction.signer_id = "other.near"; },
      tx => { tx.transaction.receiver_id = "attacker.near"; },
      tx => { tx.transaction.actions[0].FunctionCall.deposit = "0"; },
      tx => { tx.transaction.actions[0].FunctionCall.args = encoded({ token: "usdc.near", receiver_id: "other.near", amount: "1000000" }); },
      tx => { tx.transaction.actions.push(tx.transaction.actions[0]); },
      tx => { tx.receipts_outcome.pop(); },
      tx => { tx.receipts_outcome.push(tx.receipts_outcome[0]); },
      tx => { tx.receipts_outcome[1].outcome.executor_id = "attacker.near"; },
      tx => { tx.receipts_outcome[1].outcome.logs[0] = tx.receipts_outcome[1].outcome.logs[0].replace("alice.near", "other.near"); },
      tx => { tx.receipts_outcome[1].outcome.logs = []; },
      tx => { tx.receipts_outcome[0].outcome.receipt_ids.push("unreturned"); },
      tx => { tx.receipts_outcome[0].outcome.status.SuccessReceiptId = "unreturned"; },
    ];
    for (const change of changes) { const tx = transaction(); change(tx); expect(cashOutConfirmed(tx, hash, "alice.near", 1000000n)).toBe(false); }
  });
  it("does not trust corrupt or oversized browser recovery records", () => {
    expect(pendingCashOut(JSON.stringify({ amount: "1000000", hash }))).toEqual({ amount: "1000000", hash });
    expect(pendingCashOut(JSON.stringify({ amount: "1", hash: null }))).toEqual({ amount: "1", hash: null });
    for (const value of [null, "", "unavailable", "[]", "null", "x".repeat(257),
      JSON.stringify({ amount: "0", hash }), JSON.stringify({ amount: "-1", hash }),
      JSON.stringify({ amount: String(2n ** 128n), hash }), JSON.stringify({ amount: "1", hash: "javascript:x" })]) {
      expect(pendingCashOut(value)).toBeNull();
    }
  });
});
