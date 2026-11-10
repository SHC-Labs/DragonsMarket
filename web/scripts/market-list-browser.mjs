import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function checkMarketListBrowser(page, base) {
  const deployment = await (await page.request.get(`${base}/deployment.json`)).json();
  if (!deployment.marketId) {
    const calls = [];
    page.on("request", request => {
      if (request.method() === "POST" && request.url().includes("rpc")) calls.push(request.url());
    });
    await page.goto(base, { waitUntil: "networkidle" });
    await expect(page.getByText("Markets are not active yet.", { exact: false })).toBeVisible();
    await expect(page.getByTestId("market-card")).toHaveCount(0);
    assert.deepEqual(calls, [], "an inactive site does not query a missing contract");
    console.log("Market browser passed: explicit inactive state without contract reads");
    return;
  }
  const market = { id: "0", title: "Market listing fixture", status: "open", registered: true,
    rule_text: "A test rule", resolution_source: "A test source", void_policy: "A test void policy",
    category: "world", subcategory: "science", rule_hash: "a".repeat(64), price_rule: null,
    close_at: "4102444800000000000", resolve_by: "4102531200000000000", outcome: null, refunds: false,
    price_yes: "500000", price_no: "500000", yes_shares: "1000000", no_shares: "1000000",
    locked: "1000000", holders: 2, pruned: false };
  let listFails = false;
  const route = async request => {
    const rpc = request.request().postDataJSON(), method = rpc.params?.method_name;
    if (!['list_markets', 'get_case', 'get_history'].includes(method)) return request.fallback();
    const unavailable = method === "get_case" || (method === "list_markets" && listFails);
    const value = method === "list_markets" ? [market,
      { ...market, id: "1", title: "Closed listing fixture", status: "closed" }] : [];
    return request.fulfill({ json: { jsonrpc: "2.0", id: rpc.id, ...(unavailable
      ? { error: { message: "Read temporarily unavailable" } }
      : { result: { result: [...Buffer.from(JSON.stringify(value))] } }) },
    headers: { "access-control-allow-origin": "*" } });
  };
  await page.route(`${deployment.rpcUrl}/**`, route);
  try {
    await page.goto(base, { waitUntil: "networkidle" });
    await expect(page.getByTestId("market-card")).toHaveCount(2);
    await expect(page.getByText("Resolution updates are temporarily unavailable.", { exact: false })).toBeVisible();
    listFails = true;
    await expect(page.getByText("Market updates are temporarily unavailable.", { exact: false }))
      .toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("market-card")).toHaveCount(2);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText("Could not load markets.", { exact: false })).toBeVisible();
    listFails = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByTestId("market-card")).toHaveCount(2);
    console.log("Market browser passed: resolution outage isolation, stale warning and retry recovery");
  } finally {
    await page.unroute(`${deployment.rpcUrl}/**`, route);
  }
}
