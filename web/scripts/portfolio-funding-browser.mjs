import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function checkPortfolioFundingBrowser(page, base) {
  const account = "csp-test.testnet", marketId = "market.csp-fixture.testnet";
  const token = "usdc.csp-fixture.testnet", verifier = "verifier.csp-fixture.testnet";
  const endpoint = "https://test.rpc.fastnear.com/**";
  const ns = ms => String(BigInt(ms) * 1_000_000n);
  const market = { id: "0", title: "Separate deposit and purchase", status: "open", registered: true,
    rule_text: "Yes if the test completes", resolution_source: "https://example.com/result", void_policy: "Void otherwise",
    category: "world", subcategory: "science", rule_hash: "a".repeat(64), price_rule: null,
    close_at: ns(Date.now() + 3600000), resolve_by: ns(Date.now() + 86400000), outcome: null, refunds: false,
    price_yes: "1000000", price_no: "0", yes_shares: "0", no_shares: "0", locked: "0", holders: 0, pruned: false };
  let wallet = 3_000_000n, intents = 0n, shares = 0n;
  const sent = [], proofs = new Map();
  const handler = async route => {
    const body = route.request().postDataJSON(), headers = { "access-control-allow-origin": "*" };
    if (route.request().url().endsWith("/cash-out-fixture")) {
      const action = body.actions[0].params;
      assert.equal(action.args.amount, "1000000");
      if (action.methodName === "ft_transfer_call") {
        assert.equal(body.receiverId, token);
        assert.equal(action.args.receiver_id, verifier);
        assert.equal(action.args.msg, account);
        assert.equal(intents, 0n); wallet -= 1_000_000n; intents += 1_000_000n;
      } else {
        assert.equal(action.methodName, "mt_transfer_call");
        assert.equal(body.receiverId, verifier);
        assert.equal(action.args.receiver_id, marketId);
        assert.match(action.args.msg, /^buy:0:yes:/);
        assert.equal(intents, 1_000_000n); intents -= 1_000_000n; shares += 980_000n;
      }
      sent.push(body);
      const hash = (sent.length === 1 ? "L" : "M").repeat(44);
      proofs.set(hash, body);
      return route.fulfill({ headers, json: { transaction: { hash } } });
    }
    if (body.method === "EXPERIMENTAL_tx_status") {
      const hash = body.params.tx_hash, request = proofs.get(hash);
      assert.ok(request);
      const action = request.actions[0].params;
      return route.fulfill({ headers, json: { jsonrpc: "2.0", id: body.id, result: {
        final_execution_status: "FINAL", status: { SuccessValue: "" },
        transaction: { hash, signer_id: account, receiver_id: request.receiverId, actions: [{ FunctionCall: {
          method_name: action.methodName, deposit: action.deposit, args: Buffer.from(JSON.stringify(action.args)).toString("base64"),
        } }] },
        transaction_outcome: { id: hash, outcome: { executor_id: account, receipt_ids: ["call"], status: { SuccessReceiptId: "call" } } },
        receipts_outcome: [{ id: "call", outcome: { executor_id: request.receiverId, receipt_ids: [], status: { SuccessValue: "" } } }],
      } } });
    }
    const method = body.params?.method_name;
    const views = { list_markets: [market], get_market: market, get_history: [], get_case: null,
      get_positions: [], get_balance: "0", mt_balance_of: String(intents), ft_balance_of: String(wallet),
      is_registered: true, get_shares: [String(shares), "0"],
      quote_buy: { shares_out: "980000", fee: "20000" },
      config: body.params?.account_id === "oracle.csp-fixture.testnet"
        ? { markets: [marketId], verifier, collateral_token_id: "nep141:" + token, bond: "5000000" }
        : { paused: false, sells_paused: false, registration_fee: "250000" },
      get_market_info: { close_at: market.close_at, resolve_by: market.resolve_by, rule_hash: market.rule_hash,
        price_rule: null, window_ns: "1000000000", draw_window_ns: "1000000000", panel_deadline_ns: "1000000000", apply_buffer_ns: "1000000000" },
    };
    if (!(method in views)) return route.fallback();
    return route.fulfill({ headers, json: { jsonrpc: "2.0", id: body.id, result: { result: [...Buffer.from(JSON.stringify(views[method]))] } } });
  };
  await page.context().route(endpoint, handler);
  try {
    await page.goto(base + "/market?id=0", { waitUntil: "networkidle" });
    const ticket = page.getByRole("complementary", { name: "Trade ticket" });
    await ticket.getByLabel("Amount", { exact: true }).fill("1");
    await expect(ticket.getByRole("button", { name: "Buy Yes", exact: true })).toBeDisabled();
    await expect(ticket.getByText("0¢", { exact: true })).toHaveCount(0);
    await ticket.getByRole("link", { name: "Deposit funds in Portfolio" }).click();
    const deposit = page.getByRole("region", { name: "Deposit funds" });
    await expect(deposit.getByText("Depositing does not buy shares.", { exact: false })).toBeVisible();
    await deposit.getByLabel("Deposit amount (mUSD)").fill("4");
    await expect(deposit.getByRole("button", { name: "Deposit mUSD", exact: true })).toBeDisabled();
    await deposit.getByLabel("Deposit amount (mUSD)").fill("1");
    await deposit.getByRole("button", { name: "Deposit mUSD", exact: true }).click();
    await expect(deposit.getByText("Deposit complete. Your funds are ready to trade.")).toBeVisible();
    assert.equal(sent.length, 1, "deposit submits only the funding transfer");
    assert.equal(shares, 0n, "deposit does not open a position");
    await page.goto(base + "/market?id=0", { waitUntil: "networkidle" });
    await ticket.getByLabel("Amount", { exact: true }).fill("1");
    await expect(ticket.getByRole("button", { name: "Buy Yes", exact: true })).toBeEnabled();
    await ticket.getByRole("button", { name: "Buy Yes", exact: true }).click();
    await expect(ticket.getByText("Bought Yes shares.", { exact: true })).toBeVisible();
    assert.equal(sent.length, 2, "buy submits one purchase and never deposits again");
    assert.equal(shares, 980_000n); assert.equal(wallet, 2_000_000n); assert.equal(intents, 0n);
    console.log("Portfolio funding browser passed: explicit deposit, insufficient-balance guard, separate purchase, no duplicate funding, no free-share labels");
  } finally { await page.context().unroute(endpoint, handler); }
}
