import { expect, it } from "vitest";
import { successfulCall } from "../receipt-proof";
import type { FunctionCall } from "../market";

const hash = "B".repeat(44), account = "alice.near";
const call: FunctionCall = { receiverId: "market.near", methodName: "withdraw", args: { amount: "1000000" }, gas: "100000000000000", deposit: "1" };
const encode = (args: unknown) => Buffer.from(JSON.stringify(args)).toString("base64");
function result() {
  return { final_execution_status: "FINAL", status: { SuccessValue: "" } as Record<string, unknown>,
    transaction: { hash, signer_id: account, receiver_id: call.receiverId, actions: [{ FunctionCall: {
      method_name: call.methodName, args: encode(call.args), deposit: "1",
    } }] },
    transaction_outcome: { id: hash, outcome: { executor_id: account, receipt_ids: ["call"], status: { SuccessReceiptId: "call" } as Record<string, unknown> } },
    receipts_outcome: [
      { id: "call", outcome: { executor_id: "market.near", receipt_ids: ["pay", "callback"], status: { SuccessReceiptId: "callback" } as Record<string, unknown> } },
      { id: "pay", outcome: { executor_id: "intents.near", receipt_ids: [], status: { SuccessValue: "" } as Record<string, unknown> } },
      { id: "callback", outcome: { executor_id: "market.near", receipt_ids: [], status: { SuccessValue: "" } as Record<string, unknown> } },
    ],
  };
}
it("accepts an exact finalized wallet call with every receipt successful", () => {
  expect(successfulCall(result(), hash, account, call)).toBe(true);
  const args = { token_id: "\u9f99", accepts_cut: true }, tx = result();
  tx.transaction.actions[0].FunctionCall.args = encode({ accepts_cut: true, token_id: "\u9f99" });
  expect(successfulCall(tx, hash, account, { ...call, args })).toBe(true);
});
const bad: [string, (tx: ReturnType<typeof result>) => void][] = [
  ["debit before finality", tx => { tx.final_execution_status = "EXECUTED"; }],
  ["failed payout despite successful refund callback", tx => { tx.receipts_outcome[1].outcome.status = { Failure: {} }; }],
  ["failed callback", tx => { tx.receipts_outcome[2].outcome.status = { Failure: {} }; }],
  ["missing payout receipt", tx => { tx.receipts_outcome.splice(1, 1); }],
  ["failed final outcome", tx => { tx.status = { Failure: {} }; }],
  ["different wallet", tx => { tx.transaction.signer_id = "bob.near"; }],
  ["different receiver", tx => { tx.transaction.receiver_id = "evil.near"; }],
  ["different amount", tx => { tx.transaction.actions[0].FunctionCall.args = encode({ amount: "1" }); }],
  ["additional argument", tx => { tx.transaction.actions[0].FunctionCall.args = encode({ ...call.args, recipient: "evil.near" }); }],
  ["different method", tx => { tx.transaction.actions[0].FunctionCall.method_name = "buy"; }],
  ["missing consent deposit", tx => { tx.transaction.actions[0].FunctionCall.deposit = "0"; }],
  ["different hash", tx => { tx.transaction.hash = "C".repeat(44); }],
  ["different root", tx => { tx.transaction_outcome.id = "C".repeat(44); }],
  ["another action", tx => { tx.transaction.actions.push(tx.transaction.actions[0]); }],
  ["unlinked receipt", tx => { tx.receipts_outcome.push({ ...tx.receipts_outcome[0], id: "unlinked" }); }],
  ["no call execution", tx => { tx.transaction_outcome.outcome.status = { SuccessValue: "" };
    tx.transaction_outcome.outcome.receipt_ids = []; tx.receipts_outcome = []; }],
];
it.each(bad)("refuses %s even when a balance predicate would pass", (_, mutate) => {
  const tx = result(); mutate(tx);
  expect(successfulCall(tx, hash, account, call)).toBe(false);
});
