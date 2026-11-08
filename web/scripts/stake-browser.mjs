import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function checkStakeBrowser(page, base) {
  const sent = [];
  let claimed = false;
  const endpoint = "https://test.rpc.fastnear.com/**";
  const handler = async route => {
    const request = route.request().postDataJSON();
    const headers = { "access-control-allow-origin": "*" };
    if (route.request().url().endsWith("/cash-out-fixture")) {
      sent.push(request);
      claimed = true;
      return route.fulfill({ json: { transaction: { hash: "B".repeat(44) } }, headers });
    }
    const method = request.params?.method_name;
    const args = request.params?.args_base64 ? JSON.parse(Buffer.from(request.params.args_base64, "base64").toString()) : {};
    const views = {
      config: { max_seats_per_account: 5, cooldown_ns: "86400000000000" },
      seats_of: [], seat_count: 0, claimable_of: claimed ? "0" : "1000000", in_progress_of: "0",
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
    await expect(page.getByText("Revenue claimed.")).toBeVisible();
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
    await page.getByRole("button", { name: "Connected as csp-test.testnet. Disconnect" }).click();
    await page.getByRole("button", { name: /connect wallet/i }).first().click();
    await page.getByText("CSP Test Wallet", { exact: true }).click();
    await expect(page.getByText("0 of 5 seats staked")).toBeVisible();
    await expect(page.getByText("Dragon eligible", { exact: true })).toHaveCount(0);
    assert.equal(sent.length, 1, "finding a token and reconnecting never sends a stake transaction");
    console.log("Stake browser passed: claims after leaving, verified eligibility, reset on wallet disconnect");
  } finally { await page.context().unroute(endpoint, handler); }
}
