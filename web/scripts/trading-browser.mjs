import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Exercises the exported app and real wallet bridge with deterministic local receipts.
// No keys, real funds, remote transactions or production test hooks.
export async function checkTradingBrowser(page, base) {
  const account = "csp-test.testnet", marketId = "market.csp-fixture.testnet";
  const oracle = "oracle.csp-fixture.testnet", verifier = "verifier.csp-fixture.testnet";
  const endpoint = "https://test.rpc.fastnear.com/**";
  const ns = ms => String(BigInt(ms) * 1_000_000n), encoded = v => Buffer.from(JSON.stringify(v)).toString("base64");
  const market = { id: "0", title: "Trading recovery fixture", status: "halted", registered: true,
    rule_text: "Yes if the test completes", resolution_source: "https://example.com/result", void_policy: "Void otherwise",
    category: "world", subcategory: "science", rule_hash: "a".repeat(64), price_rule: null,
    close_at: ns(Date.now() + 3600000), resolve_by: ns(Date.now() + 86400000), outcome: null, refunds: false,
    price_yes: "500000", price_no: "500000", yes_shares: "2000000", no_shares: "0", locked: "10000000", holders: 1, pruned: false };
  let record = null, final = false, oracleFunds = 0n, intentsFunds = 20_000_000n, sellsPaused = true;
  const sent = [];
  const proofs = new Map();
  const handler = async route => {
    const body = route.request().postDataJSON(), headers = { "access-control-allow-origin": "*" };
    if (route.request().url().endsWith("/cash-out-fixture")) {
      sent.push(body);
      const hash = (["E", "F", "G", "H", "J", "K"][sent.length - 1]).repeat(44);
      proofs.set(hash, body);
      const { methodName: method, args } = body.actions[0].params;
      if (method === "mt_transfer_call" && args.msg.startsWith("propose:")) {
        const [, , , proposed, ...evidence] = args.msg.split(":");
        record = { case_uid: "7", stage: "proposed", proposer: account, proposed, bond: "5000000",
          evidence: evidence.join(":"), window_ends_at: ns(Date.now() + 3600000), challenger: null,
          challenger_answer: null, round: 0, jury_size: 5, panel: [], first_panel: [], commits: [], votes: [],
          commit_ends_at: "0", panel_deadline: "0", final_outcome: null, applied: false };
      } else if (method === "mt_transfer_call" && args.msg.startsWith("challenge:")) {
        record = { ...record, stage: "disputed", challenger: account, challenger_answer: args.msg.split(":")[3],
          panel: [account], commit_ends_at: ns(Date.now() + 3600000), panel_deadline: ns(Date.now() + 7200000) };
      } else if (method === "commit_vote") record.commits.push({ juror: account, commitment: args.commitment });
      else if (method === "reveal_vote") record.votes.push({ juror: account, outcome: args.outcome, reason: args.reason });
      else if (method === "withdraw_bond") { intentsFunds += oracleFunds; oracleFunds = 0n; }
      else assert.equal(method, "sell");
      return route.fulfill({ json: { transaction: { hash } }, headers });
    }
    if (body.method === "EXPERIMENTAL_tx_status") {
      const hash = body.params.tx_hash, request = proofs.get(hash);
      assert.ok(request, "only saved transactions are checked");
      const action = request.actions[0].params;
      return route.fulfill({ headers, json: { jsonrpc: "2.0", id: body.id, result: {
        final_execution_status: final ? "FINAL" : "EXECUTED", status: { SuccessValue: "" },
        transaction: { hash, signer_id: account, receiver_id: request.receiverId, actions: [{ FunctionCall: {
          method_name: action.methodName, deposit: action.deposit, args: encoded(action.args),
        } }] },
        transaction_outcome: { id: hash, outcome: { executor_id: account, receipt_ids: ["call"], status: { SuccessReceiptId: "call" } } },
        receipts_outcome: [{ id: "call", outcome: { executor_id: request.receiverId, receipt_ids: [], status: { SuccessValue: "" } } }],
      } } });
    }
    const method = body.params?.method_name;
    const views = {
      get_market: market, list_markets: [market], get_history: [], get_case: record, get_positions: [],
      get_balance: "0", claimable_of: String(oracleFunds), mt_balance_of: String(intentsFunds), ft_balance_of: "0", is_registered: true,
      get_shares: ["2000000", "0"], quote_sell: { collateral_out: "500000", fee: "10000" },
      config: body.params?.account_id === oracle ? { markets: [marketId], verifier, collateral_token_id: "nep141:usdc.csp-fixture.testnet", bond: "5000000" }
        : { paused: false, sells_paused: sellsPaused, markets: "1", registration_fee: "50000" },
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
    await expect(ticket.getByRole("button", { name: "Buying paused" })).toBeDisabled();
    await ticket.getByRole("button", { name: "Sell", exact: true }).click();
    await expect(ticket.getByRole("button", { name: "Selling paused" })).toBeDisabled();
    sellsPaused = false;
    await page.reload({ waitUntil: "networkidle" });
    await ticket.getByRole("button", { name: "Sell", exact: true }).click();
    await ticket.getByLabel("Shares to sell").fill("1");
    await expect(ticket.getByRole("button", { name: "Sell Yes", exact: true })).toBeEnabled();
    await ticket.getByRole("button", { name: "Sell Yes", exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    assert.equal(sent[0].actions[0].params.methodName, "sell");
    await expect(ticket.getByText("This request is unconfirmed.", { exact: false })).toBeVisible({ timeout: 40000 });
    await page.reload({ waitUntil: "networkidle" });
    await expect(ticket.getByText("Transaction: " + "E".repeat(44))).toBeVisible();
    await ticket.getByRole("button", { name: "Sell", exact: true }).click();
    await expect(ticket.getByLabel("Shares to sell")).toBeDisabled();
    const other = await page.context().newPage();
    await other.goto(base + "/market?id=0", { waitUntil: "networkidle" });
    await expect(other.getByRole("complementary", { name: "Trade ticket" }).getByLabel("Amount", { exact: true })).toBeDisabled();
    await other.close();
    assert.equal(sent.length, 1, "timeout, form changes, reload and another tab cannot duplicate the request");
    final = true;
    await ticket.getByRole("button", { name: "Check saved transaction" }).click();
    await expect(ticket.getByText("The saved transaction finalized successfully.", { exact: false })).toBeVisible();

    market.status = "closed"; market.close_at = ns(Date.now() - 1000);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByLabel("Proposal evidence").fill("https://example.com/evidence");
    await page.getByRole("button", { name: "Submit proposal", exact: true }).click();
    await expect(page.getByText("Answer proposed. The challenge window is open.")).toBeVisible();
    assert.equal(sent[1].receiverId, verifier);
    assert.equal(sent[1].actions[0].params.args.amount, "5000000");
    record.proposer = "another.testnet";
    await page.reload({ waitUntil: "networkidle" });
    await page.getByLabel("Resolution answer").selectOption("no");
    await page.getByRole("button", { name: "Submit challenge", exact: true }).click();
    await expect(page.getByText("Challenge recorded. The jury draw comes next.")).toBeVisible();
    // The oracle excludes proposer/challenger from the jury. Exercise a separate
    // case in which this wallet was actually selected, after the challenge test.
    record.case_uid = "8"; record.challenger = "challenger.testnet";
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Prepare or recover vote" }).click();
    const backup = await page.getByLabel("Vote backup", { exact: true }).inputValue();
    assert.equal(JSON.parse(backup).juror, account);
    await expect(page.getByRole("button", { name: "Commit vote", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "I saved this vote backup somewhere safe." }).check();
    await page.getByRole("button", { name: "Commit vote", exact: true }).click();
    await expect(page.getByText("Vote committed.", { exact: false })).toBeVisible();
    assert.equal(sent[3].actions[0].params.args.commitment, JSON.parse(backup).commitment);
    record.commit_ends_at = ns(Date.now() - 1000);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Load saved vote" }).click();
    await expect(page.getByLabel("Vote backup", { exact: true })).toHaveValue(backup);
    await page.getByLabel("Reason for your vote").fill("The published evidence satisfies the market rule.");
    await page.getByRole("button", { name: "Reveal vote", exact: true }).click();
    await expect(page.getByText("Vote revealed.", { exact: true })).toBeVisible();
    assert.equal(sent[4].actions[0].params.args.salt, JSON.parse(backup).salt);
    oracleFunds = 1_000_000n;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Withdraw oracle funds", exact: true }).click();
    await expect(page.getByText("Oracle funds withdrawn to your Intents account.")).toBeVisible();
    assert.equal(sent[5].receiverId, oracle);
    assert.equal(sent[5].actions[0].params.deposit, "1");
    assert.equal(sent.length, 6);
    console.log("Trading browser passed: halted-market sell, durable timeout/reload/cross-tab recovery, proposal, challenge, vote backup, commit/reveal and bond withdrawal");
  } finally { await page.context().unroute(endpoint, handler); }
}
