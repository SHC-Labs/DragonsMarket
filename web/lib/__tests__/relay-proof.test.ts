import { expect, it } from "vitest";
import { relayedIntentSucceeded } from "../receipt-proof";

const hash = "R".repeat(44), relayer = "relayer.near", verifier = "intents.near", target = "market.near";
const signed = { standard: "erc191", payload: '{"signer_id":"0xabc","intents":[]}' };
const encode = (args: unknown) => Buffer.from(JSON.stringify(args)).toString("base64");
function result() {
  return { final_execution_status: "FINAL", status: { SuccessValue: "" } as Record<string, unknown>,
    transaction: { hash, signer_id: relayer, receiver_id: verifier, actions: [{ FunctionCall: {
      method_name: "execute_intents", args: encode({ signed: [{ ...signed, signature: "secp256k1:abc" }] }), deposit: "0",
    } }] },
    transaction_outcome: { id: hash, outcome: { executor_id: relayer, receipt_ids: ["exec"], status: { SuccessReceiptId: "exec" } as Record<string, unknown> } },
    receipts_outcome: [
      { id: "exec", outcome: { executor_id: verifier, receipt_ids: ["notify"], status: { SuccessReceiptId: "notify" } as Record<string, unknown> } },
      { id: "notify", outcome: { executor_id: target, receipt_ids: [], status: { SuccessValue: "" } as Record<string, unknown> } },
    ],
  };
}
const check = (tx: unknown, over: { relayer?: string; verifier?: string; target?: string; signed?: typeof signed } = {}) =>
  relayedIntentSucceeded(tx, hash, over.relayer ?? relayer, over.verifier ?? verifier, over.signed ?? signed, over.target ?? target);

it("accepts the relayer's final execute_intents carrying exactly the signed payload and reaching the market", () => {
  expect(check(result())).toBe(true);
});

const bad: [string, (tx: ReturnType<typeof result>) => void][] = [
  ["not final", tx => { tx.final_execution_status = "EXECUTED"; }],
  ["failed final status", tx => { tx.status = { Failure: {} }; }],
  ["a failed receipt", tx => { tx.receipts_outcome[1].outcome.status = { Failure: {} }; }],
  ["no receipt on the market", tx => { tx.receipts_outcome[1].outcome.executor_id = "other.near"; }],
  ["signed by someone else", tx => { tx.transaction.signer_id = "mallory.near"; }],
  ["sent to another contract", tx => { tx.transaction.receiver_id = "evil.near"; }],
  ["another method", tx => { tx.transaction.actions[0].FunctionCall.method_name = "ft_transfer"; }],
  ["attached deposit", tx => { tx.transaction.actions[0].FunctionCall.deposit = "1"; }],
  ["a different payload", tx => { tx.transaction.actions[0].FunctionCall.args = encode({ signed: [{ ...signed, payload: "{}" }] }); }],
  ["a different standard", tx => { tx.transaction.actions[0].FunctionCall.args = encode({ signed: [{ ...signed, standard: "raw_ed25519" }] }); }],
  ["two signed items", tx => { tx.transaction.actions[0].FunctionCall.args = encode({ signed: [signed, signed] }); }],
  ["a different hash", tx => { tx.transaction.hash = "S".repeat(44); }],
  ["another executor for the first receipt", tx => { tx.transaction_outcome.outcome.executor_id = "mallory.near"; }],
  ["a receipt missing from the list", tx => { tx.receipts_outcome.pop(); }],
];
for (const [name, mutate] of bad) {
  it(`rejects ${name}`, () => {
    const tx = result();
    mutate(tx);
    expect(check(tx)).toBe(false);
  });
}

it("rejects a payload paid to a contract other than the one expected", () => {
  expect(check(result(), { target: "oracle.near" })).toBe(false);
});
it("rejects anything that is not a transaction result", () => {
  expect(check(null)).toBe(false);
  expect(check("x")).toBe(false);
});
