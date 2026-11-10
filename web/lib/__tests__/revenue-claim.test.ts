import { describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({ config: {
  councilId: "council.near", verifierId: "intents.near", collateralTokenId: "nep141:usdc.near",
} }));
import { claimResult, pendingClaim } from "../revenue-claim";

const hash = "B".repeat(44), account = "alice.near";
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const event = (name: string, tokens: string[], amount = "1000000") => `EVENT_JSON:${JSON.stringify({
  standard: "council", version: "1.0.0", event: name,
  data: { id: "7", account, amount, tokens, requested_at: "1800000000000000000" },
})}`;
function transaction(tokens: string[] = []) {
  const outcome = (executor: string, children: string[], status: Record<string, unknown>, logs: string[] = []) =>
    ({ executor_id: executor, receipt_ids: children, status, logs });
  return {
    final_execution_status: "FINAL", status: { SuccessValue: "" } as Record<string, unknown>,
    transaction: { hash, signer_id: account, receiver_id: "council.near", actions: [{ FunctionCall: {
      method_name: "claim", deposit: "1", args: encoded({ token_ids: tokens }),
    } }] },
    transaction_outcome: { id: hash, outcome: outcome(account, ["claim"], { SuccessReceiptId: "claim" }) },
    receipts_outcome: [
      { id: "claim", outcome: outcome("council.near", ["transfer", "settle"], { SuccessReceiptId: "settle" }, [event("claim_requested", tokens)]) },
      { id: "transfer", outcome: outcome("intents.near", [], { SuccessValue: "" }, [`EVENT_JSON:${JSON.stringify({
        standard: "nep245", version: "1.0.0", event: "mt_transfer", data: [{ old_owner_id: "council.near",
          new_owner_id: account, token_ids: ["nep141:usdc.near"], amounts: ["1000000"] }],
      })}`]) },
      { id: "settle", outcome: outcome("council.near", [], { SuccessValue: "" }, [event("claim_paid", tokens)]) },
    ],
  };
}

describe("Council revenue payout evidence", () => {
  it("confirms payment to Intents for a former staker and for exact selected seats", () => {
    for (const tokens of [[], ["seat-1"], ["\u9f99"]]) {
      expect(claimResult(transaction(tokens), hash, account, tokens)).toEqual({ status: "paid", amount: "1000000" });
    }
  });
  it("recognizes a failed transfer only after Council restored the claim", () => {
    const tx = transaction();
    tx.receipts_outcome[1].outcome.status = { Failure: { error_message: "locked" } };
    tx.receipts_outcome[1].outcome.logs = [];
    tx.receipts_outcome[2].outcome.logs = [event("claim_failed", [])];
    expect(claimResult(tx, hash, account, [])).toEqual({ status: "refunded", amount: "1000000" });
    tx.receipts_outcome[2].outcome.status = { Failure: { error_message: "callback failed" } };
    expect(claimResult(tx, hash, account, [])).toEqual({ status: "pending" });
  });
  const mutations: [string, (tx: ReturnType<typeof transaction>) => void][] = [
    ["nonfinal result", tx => { tx.final_execution_status = "EXECUTED"; }],
    ["failed final result", tx => { tx.status = { Failure: { error_message: "failed" } }; }],
    ["different hash", tx => { tx.transaction.hash = "C".repeat(44); }],
    ["different transaction outcome", tx => { tx.transaction_outcome.id = "C".repeat(44); }],
    ["different root executor", tx => { tx.transaction_outcome.outcome.executor_id = "bob.near"; }],
    ["different signer", tx => { tx.transaction.signer_id = "bob.near"; }],
    ["different receiver", tx => { tx.transaction.receiver_id = "evil.near"; }],
    ["different method", tx => { tx.transaction.actions[0].FunctionCall.method_name = "withdraw"; }],
    ["wrong consent deposit", tx => { tx.transaction.actions[0].FunctionCall.deposit = "0"; }],
    ["different tokens", tx => { tx.transaction.actions[0].FunctionCall.args = encoded({ token_ids: ["other"] }); }],
    ["extra arguments", tx => { tx.transaction.actions[0].FunctionCall.args = encoded({ token_ids: [], extra: true }); }],
    ["multiple actions", tx => { tx.transaction.actions.push(tx.transaction.actions[0]); }],
    ["missing receipt", tx => { tx.receipts_outcome.pop(); }],
    ["duplicate receipt", tx => { tx.receipts_outcome.push(tx.receipts_outcome[0]); }],
    ["unlinked receipt", tx => { tx.receipts_outcome.push({ ...tx.receipts_outcome[2], id: "unlinked" }); }],
    ["cycle", tx => { tx.receipts_outcome[2].outcome.receipt_ids.push("claim"); }],
    ["unresolved child", tx => { tx.receipts_outcome[0].outcome.receipt_ids.push("missing"); }],
    ["missing request", tx => { tx.receipts_outcome[0].outcome.logs = []; }],
    ["overflowing claim id", tx => { for (const receipt of tx.receipts_outcome) receipt.outcome.logs = receipt.outcome.logs.map(log => log.replace('"id":"7"', '"id":"18446744073709551616"')); }],
    ["absent claim timestamp", tx => { for (const receipt of tx.receipts_outcome) receipt.outcome.logs = receipt.outcome.logs.map(log => log.replace('"requested_at"', '"unrecognized"')); }],
    ["invalid UTF-8 arguments", tx => { tx.transaction.actions[0].FunctionCall.args = Buffer.from([0xc3, 0x28]).toString('base64'); }],
    ["failed callback", tx => { tx.receipts_outcome[2].outcome.status = { Failure: { error_message: "failed" } }; }],
    ["missing settlement", tx => { tx.receipts_outcome[2].outcome.logs = []; }],
    ["different settlement amount", tx => { tx.receipts_outcome[2].outcome.logs = [event("claim_paid", [], "1")]; }],
    ["different settlement account", tx => { tx.receipts_outcome[2].outcome.logs[0] = event("claim_paid", []).replace(account, "bob.near"); }],
    ["different settlement id", tx => { tx.receipts_outcome[2].outcome.logs[0] = event("claim_paid", []).replace('"7"', '"8"'); }],
    ["different settlement tokens", tx => { tx.receipts_outcome[2].outcome.logs = [event("claim_paid", ["other"])]; }],
    ["fake Council emitter", tx => { tx.receipts_outcome[2].outcome.executor_id = "evil.near"; }],
    ["missing token payout", tx => { tx.receipts_outcome[1].outcome.logs = []; }],
    ["fake token emitter", tx => { tx.receipts_outcome[1].outcome.executor_id = "evil.near"; }],
    ["different payout account", tx => { tx.receipts_outcome[1].outcome.logs[0] = tx.receipts_outcome[1].outcome.logs[0].replace(account, "bob.near"); }],
    ["different collateral", tx => { tx.receipts_outcome[1].outcome.logs[0] = tx.receipts_outcome[1].outcome.logs[0].replace("usdc.near", "fake.near"); }],
    ["different payout amount", tx => { tx.receipts_outcome[1].outcome.logs[0] = tx.receipts_outcome[1].outcome.logs[0].replace("1000000", "1"); }],
    ["contradictory refund", tx => { tx.receipts_outcome[2].outcome.logs = [event("claim_failed", [])]; }],
    ["multiple settlements", tx => { tx.receipts_outcome[2].outcome.logs.push(event("claim_failed", [])); }],
  ];
  it.each(mutations)("leaves %s unresolved", (_, mutate) => {
    const tx = transaction(); mutate(tx);
    expect(claimResult(tx, hash, account, [])).toEqual({ status: "pending" });
  });
  it("bounds browser recovery records and accepts claims with no active seats", () => {
    expect(pendingClaim(JSON.stringify({ tokens: [], hash: null }))).toEqual({ tokens: [], hash: null });
    expect(pendingClaim(JSON.stringify({ tokens: ["seat"], hash }))).toEqual({ tokens: ["seat"], hash });
    for (const raw of [null, "", "unavailable", "[]", "null", "x".repeat(16385),
      JSON.stringify({ tokens: ["duplicate", "duplicate"], hash }), JSON.stringify({ tokens: [12], hash }),
      JSON.stringify({ tokens: Array.from({ length: 11 }, (_, i) => String(i)), hash }),
      JSON.stringify({ tokens: [], hash: "javascript:x" })]) expect(pendingClaim(raw)).toBeNull();
  });
});
