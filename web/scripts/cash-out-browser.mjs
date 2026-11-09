import assert from "node:assert/strict";
import { expect } from "@playwright/test";

const account = "csp-test.testnet", verifier = "verifier.csp-fixture.testnet", token = "usdc.csp-fixture.testnet";
const endpoint = "https://test.rpc.fastnear.com";
const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64");

export const cashOutWalletMethod = `signAndSendTransaction: async params => {
  const response = await fetch('${endpoint}/cash-out-fixture', {
    method: 'POST', body: JSON.stringify(params)
  });
  return response.json();
},`;

export async function installCashOutFixture(context) {
  const sent = [];
  let registered = false, paid = false, held;
  const result = () => ({
    final_execution_status: "FINAL", status: { SuccessValue: encoded(paid ? "1000000" : "0") },
    transaction: { hash: "A".repeat(44), signer_id: account, receiver_id: verifier, actions: [{ FunctionCall: {
      method_name: "ft_withdraw", deposit: "1", args: encoded({ token, receiver_id: account, amount: "1000000" }),
    } }] },
    transaction_outcome: { id: "A".repeat(44), outcome: { executor_id: account,
      receipt_ids: ["withdraw"], status: { SuccessReceiptId: "withdraw" } } },
    receipts_outcome: [
      { id: "withdraw", outcome: { executor_id: verifier, receipt_ids: ["transfer", "resolve"],
        status: { SuccessReceiptId: "resolve" }, logs: [] } },
      { id: "transfer", outcome: { executor_id: token, receipt_ids: [], status: { SuccessValue: "" },
        logs: [`EVENT_JSON:${JSON.stringify({ standard: "nep141", event: "ft_transfer", data: [
          { old_owner_id: verifier, new_owner_id: account, amount: "1000000" },
        ] })}`] } },
      { id: "resolve", outcome: { executor_id: verifier, receipt_ids: [],
        status: { SuccessValue: encoded(paid ? "1000000" : "0") }, logs: [] } },
    ],
  });
  await context.route(`${endpoint}/**`, async route => {
    const body = route.request().postDataJSON();
    const headers = { "access-control-allow-origin": "*" };
    if (route.request().url().endsWith("/cash-out-fixture")) {
      sent.push(body);
      if (body.actions[0].params.methodName === "storage_deposit") registered = true;
      else if (held) await held;
      return route.fulfill({ json: { transaction: { hash: "A".repeat(44) } }, headers });
    }
    if (body.method === "EXPERIMENTAL_tx_status") {
      return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: result() }, headers });
    }
    const views = { list_markets: [], get_balance: "0", mt_balance_of: paid ? "9000000" : "10000000",
      storage_balance_of: registered ? { total: "1250000000000000000000" } : null,
      storage_balance_bounds: { min: "1250000000000000000000" } };
    const value = views[body.params?.method_name];
    const response = value === undefined ? { error: { message: "Fixture view unavailable" } }
      : { result: { result: [...Buffer.from(JSON.stringify(value))] } };
    return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, ...response }, headers });
  });
  return {
    sent,
    paid: () => { paid = true; },
    hold: () => { let release; held = new Promise(resolve => { release = resolve; }); return release; },
  };
}

export async function checkCashOutBrowser(page, fixture, base) {
  await page.goto(`${base}/portfolio`, { waitUntil: "networkidle" });
  const section = page.getByRole("region", { name: "Withdraw to your wallet" });
  await section.getByLabel("Amount (mUSD)").fill("1");
  await section.getByRole("button", { name: "Withdraw to my wallet" }).click();
  await expect(section).toContainText("Token storage was submitted");
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].receiverId, token);
  assert.equal(fixture.sent[0].actions[0].params.methodName, "storage_deposit");
  const release = fixture.hold();
  await section.getByRole("button", { name: "Withdraw to my wallet" }).click();
  await expect.poll(() => fixture.sent.length).toBe(2);
  assert.equal(fixture.sent[1].receiverId, verifier);
  assert.deepEqual(fixture.sent[1].actions[0].params.args, { token, receiver_id: account, amount: "1000000" });
  const second = await page.context().newPage();
  try {
    await second.goto(`${base}/portfolio`, { waitUntil: "networkidle" });
    const other = second.getByRole("region", { name: "Withdraw to your wallet" });
    await expect(other).toContainText("A previous request for 1.00 mUSD");
    await other.getByRole("button", { name: "Clear checked request" }).click();
    await expect(other).toContainText("Another tab is handling a withdrawal");
    assert.equal(fixture.sent.length, 2);
  } finally { release(); await second.close(); }
  await expect(section).toContainText("Payment is not confirmed");
  await page.reload({ waitUntil: "networkidle" });
  await expect(section).toContainText("A previous request for 1.00 mUSD");
  await expect(section.getByLabel("Amount (mUSD)")).toBeDisabled();
  fixture.paid();
  await section.getByRole("button", { name: "Check withdrawal" }).click();
  await expect(section).toContainText("reached csp-test.testnet");
  await expect(section.getByRole("button", { name: "Withdraw to my wallet" })).toBeVisible();
  assert.equal(fixture.sent.length, 2, "recovery checks do not resend a transaction");
  console.log("Cash-out browser passed: storage, exact destination, cross-tab exclusion, reload recovery, final payout");
}

export async function checkMarketWithdrawalBrowser(page, base) {
  const hash = "D".repeat(44), market = "market.csp-fixture.testnet";
  let sent = 0, checks = 0, settled = false;
  const handler = async route => {
    const body = route.request().postDataJSON(), headers = { "access-control-allow-origin": "*" };
    if (route.request().url().endsWith("/cash-out-fixture")) {
      assert.equal(body.receiverId, market);
      assert.equal(body.actions[0].params.methodName, "withdraw");
      assert.deepEqual(body.actions[0].params.args, { amount: "1000000" });
      sent++;
      return route.fulfill({ json: { transaction: { hash } }, headers });
    }
    if (body.params?.method_name === "get_balance") return route.fulfill({ headers,
      json: { jsonrpc: "2.0", id: body.id, result: { result: [...Buffer.from(JSON.stringify(sent ? "0" : "1000000"))] } } });
    if (body.method !== "EXPERIMENTAL_tx_status" || body.params.tx_hash !== hash) return route.fallback();
    checks++;
    return route.fulfill({ headers, json: { jsonrpc: "2.0", id: body.id, result: {
      final_execution_status: settled ? "FINAL" : "EXECUTED", status: { SuccessValue: "" },
      transaction: { hash, signer_id: account, receiver_id: market, actions: [{ FunctionCall: {
        method_name: "withdraw", deposit: "1", args: encoded({ amount: "1000000" }),
      } }] },
      transaction_outcome: { id: hash, outcome: { executor_id: account, receipt_ids: ["call"], status: { SuccessReceiptId: "call" } } },
      receipts_outcome: [
        { id: "call", outcome: { executor_id: market, receipt_ids: ["payout", "settle"], status: { SuccessReceiptId: "settle" } } },
        { id: "payout", outcome: { executor_id: verifier, receipt_ids: [], status: settled ? { SuccessValue: "" } : { Unknown: null } } },
        { id: "settle", outcome: { executor_id: market, receipt_ids: [], status: { SuccessValue: "" } } },
      ],
    } } });
  };
  await page.context().route(`${endpoint}/**`, handler);
  try {
    await page.goto(`${base}/portfolio`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    await expect.poll(() => checks).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("Withdrawn to your Intents account.", { exact: true })).toHaveCount(0);
    settled = true;
    await expect(page.getByText("Withdrawn to your Intents account.", { exact: true })).toBeVisible();
    assert.equal(sent, 1);
    await page.getByRole("button", { name: `Connected as ${account}. Disconnect` }).click();
    await page.getByRole("button", { name: /connect wallet/i }).first().click();
    await page.getByText("CSP Test Wallet", { exact: true }).click();
    await expect(page.getByText("Withdrawn to your Intents account.", { exact: true })).toHaveCount(0);
    assert.equal(sent, 1, "reconnecting does not replay a withdrawal");
    console.log("Market withdrawal browser passed: final payout checks and account-scoped transaction notices");
  } finally { await page.context().unroute(`${endpoint}/**`, handler); }
}
