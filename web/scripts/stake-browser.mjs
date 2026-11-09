import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function checkStakeBrowser(page, base) {
  const sent = [];
  let claimed = false;
  let claimStatus = "pending", claimHash = "B".repeat(44);
  let showSeat = false, leaving = false, unstakeSubmitted = false;
  const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64");
  const claimEvent = event => `EVENT_JSON:${JSON.stringify({ standard: "council", version: "1.0.0", event,
    data: { id: "7", account: "csp-test.testnet", amount: "1000000", tokens: [], requested_at: "1800000000000000000" } })}`;
  const claimResult = () => ({
    final_execution_status: claimStatus === "pending" ? "EXECUTED" : "FINAL", status: { SuccessValue: "" },
    transaction: { hash: claimHash, signer_id: "csp-test.testnet", receiver_id: "council.csp-fixture.testnet", actions: [{ FunctionCall: {
      method_name: "claim", deposit: "1", args: encoded({ token_ids: [] }),
    } }] },
    transaction_outcome: { id: claimHash, outcome: { executor_id: "csp-test.testnet", receipt_ids: ["claim"], status: { SuccessReceiptId: "claim" } } },
    receipts_outcome: [
      { id: "claim", outcome: { executor_id: "council.csp-fixture.testnet", receipt_ids: ["transfer", "settle"], status: { SuccessReceiptId: "settle" }, logs: [claimEvent("claim_requested")] } },
      { id: "transfer", outcome: { executor_id: "verifier.csp-fixture.testnet", receipt_ids: [],
        status: claimStatus === "paid" ? { SuccessValue: "" } : { Failure: { error_message: "transfer failed" } },
        logs: claimStatus === "paid" ? [`EVENT_JSON:${JSON.stringify({ standard: "nep245", version: "1.0.0", event: "mt_transfer",
          data: [{ old_owner_id: "council.csp-fixture.testnet", new_owner_id: "csp-test.testnet", token_ids: ["nep141:usdc.csp-fixture.testnet"], amounts: ["1000000"] }] })}`] : [] } },
      { id: "settle", outcome: { executor_id: "council.csp-fixture.testnet", receipt_ids: [],
        status: claimStatus === "pending" ? { Unknown: null } : { SuccessValue: "" },
        logs: claimStatus === "pending" ? [] : [claimEvent(claimStatus === "paid" ? "claim_paid" : "claim_failed")] } },
    ],
  });
  const endpoint = "https://test.rpc.fastnear.com/**";
  const handler = async route => {
    const request = route.request().postDataJSON();
    const headers = { "access-control-allow-origin": "*" };
    if (route.request().url().endsWith("/cash-out-fixture")) {
      sent.push(request);
      const action = request.actions[0].params;
      if (action.methodName === "claim") { claimed = true; claimHash = (sent.length === 1 ? "B" : "C").repeat(44); }
      else if (action.methodName === "request_unstake") {
        assert.equal(action.deposit, "1");
        assert.deepEqual(action.args, { token_id: "staked", accepts_cut: true });
        leaving = true; unstakeSubmitted = true;
      } else throw new Error(`Unexpected wallet call ${action.methodName}`);
      return route.fulfill({ json: { transaction: { hash: claimHash }, status: { Failure: { error_message: "not a payout proof" } } }, headers });
    }
    if (request.method === "EXPERIMENTAL_tx_status" && request.params.tx_hash === claimHash) {
      if (unstakeSubmitted) return route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: {
        final_execution_status: "FINAL", status: { SuccessValue: "" },
        transaction: { hash: claimHash, signer_id: "csp-test.testnet", receiver_id: "council.csp-fixture.testnet", actions: [{ FunctionCall: {
          method_name: "request_unstake", deposit: "1", args: encoded({ token_id: "staked", accepts_cut: true }),
        } }] },
        transaction_outcome: { id: claimHash, outcome: { executor_id: "csp-test.testnet", receipt_ids: ["unstake"], status: { SuccessReceiptId: "unstake" } } },
        receipts_outcome: [{ id: "unstake", outcome: { executor_id: "council.csp-fixture.testnet", receipt_ids: [], status: { SuccessValue: "" } } }],
      } }, headers });
      if (claimStatus === "refunded") claimed = false;
      return route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: claimResult() }, headers });
    }
    const method = request.params?.method_name;
    const args = request.params?.args_base64 ? JSON.parse(Buffer.from(request.params.args_base64, "base64").toString()) : {};
    const views = {
      config: { max_seats_per_account: 5, cooldown_ns: "86400000000000" },
      seats_of: showSeat ? ["staked"] : [], seat_count: showSeat ? 1 : 0,
      claimable_of: claimed ? "0" : "1000000", in_progress_of: "0",
      stake_of: { owner: "csp-test.testnet", staked_at: "1", serving: null,
        unlock_requested_at: leaving ? String(BigInt(Date.now()) * 1_000_000n) : null },
      seat_earnings: { owner: "csp-test.testnet", state: leaving ? "leaving" : "earning",
        earning_from: "1", earned_closed: "0", earned_in_progress: "1000000" },
      quarter_info: { ends_at: "1800000000000000000" },
      nft_token: { token_id: args.token_id, owner_id: "csp-test.testnet" },
      is_allowed: args.token_id === "eligible",
    };
    if (method === "nft_tokens_for_owner") {
      return route.fulfill({ json: { jsonrpc: "2.0", id: request.id, error: { message: "No enumeration" } }, headers });
    }
    if (!(method in views)) return route.fallback();
    return route.fulfill({ json: { jsonrpc: "2.0", id: request.id,
      result: { result: [...Buffer.from(JSON.stringify(views[method]))] } }, headers });
  };
  await page.context().route(endpoint, handler);
  try {
    await page.goto(`${base}/stake`, { waitUntil: "networkidle" });
    await expect(page.getByText("0 of 5 seats staked")).toBeVisible();
    await expect(page.getByRole("button", { name: "Claim", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Claim", exact: true }).click();
    await expect(page.getByText("Revenue payment is not confirmed.", { exact: false })).toBeVisible();
    await expect(page.getByText("Revenue claimed.", { exact: false })).toHaveCount(0);
    const other = await page.context().newPage();
    await other.goto(`${base}/stake`, { waitUntil: "networkidle" });
    await expect(other.getByRole("button", { name: "Check claim", exact: true })).toBeVisible();
    await expect(other.getByRole("button", { name: "Claim", exact: true })).toHaveCount(0);
    await other.close();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Check claim", exact: true })).toBeVisible();
    assert.equal(sent.length, 1, "reload and another tab never resubmit an unresolved claim");
    claimStatus = "refunded";
    await page.getByRole("button", { name: "Check claim", exact: true }).click();
    await expect(page.getByText("The payout failed and your claimable revenue was restored.", { exact: false })).toBeVisible();
    claimStatus = "paid";
    await page.getByRole("button", { name: "Claim", exact: true }).click();
    await expect(page.getByText("Revenue claimed.", { exact: false })).toBeVisible();
    assert.deepEqual(sent[0].actions[0].params.args, { token_ids: [] });
    assert.equal(sent[0].actions[0].params.methodName, "claim");
    for (const token of ["ineligible", "constructor", "__proto__", "eligible"]) {
      await page.getByLabel("Add a Dragon by token id").fill(token);
      await page.getByRole("button", { name: "Find", exact: true }).click();
      const row = page.locator("li").filter({ hasText: `Dragon ${token}` });
      await expect(row).toBeVisible();
      if (token === "eligible") await expect(row.getByRole("button", { name: "Stake", exact: true })).toBeEnabled();
      else await expect(row.getByRole("button", { name: "Stake", exact: true })).toBeDisabled();
    }
    showSeat = true;
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText("1 of 5 seats staked")).toBeVisible();
    await page.getByRole("button", { name: "Request unstake", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Leaving costs half of this quarter")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep my seat" }).click();
    assert.equal(sent.length, 2, "cancelling unstaking never signs a transaction");
    await page.getByRole("button", { name: "Request unstake", exact: true }).click();
    await dialog.getByRole("button", { name: "Request unstake", exact: true }).click();
    await expect(page.getByText("Unstake requested. The cooldown has started.")).toBeVisible();
    assert.equal(sent.length, 3);
    assert.equal(sent[2].receiverId, "council.csp-fixture.testnet");
    assert.equal(sent[2].actions[0].params.deposit, "1");
    showSeat = false;
    await page.getByRole("button", { name: "Connected as csp-test.testnet. Disconnect" }).click();
    await page.getByRole("button", { name: /connect wallet/i }).first().click();
    await page.getByText("CSP Test Wallet", { exact: true }).click();
    await expect(page.getByText("0 of 5 seats staked")).toBeVisible();
    await expect(page.getByText("Dragon eligible", { exact: true })).toHaveCount(0);
    assert.equal(sent.length, 3, "finding a token and reconnecting never sends a stake transaction");
    console.log("Stake browser passed: payout proof, failed/uncertain claims, reload and cross-tab recovery, eligibility, unstake consent, reset on disconnect");
  } finally { await page.context().unroute(endpoint, handler); }
}
