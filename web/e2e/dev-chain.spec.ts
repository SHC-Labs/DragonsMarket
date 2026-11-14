import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Sandbox reads; signed mutations and recovery are covered by check-csp.mjs.
const chain = JSON.parse(readFileSync(join(__dirname, "../../contracts/dev-chain.json"), "utf8"));

test("markets paginate and outcomes open their market", async ({ page }) => {
  await page.goto("/");
  const cards = page.getByTestId("market-card");
  await expect(cards.first()).toBeVisible();
  while (await page.getByRole("button", {name:/Show More/}).count()) await page.getByRole("button", {name:/Show More/}).click();
  await expect(cards).toHaveCount(chain.count);
  await cards.first().getByRole("link", {name:/Buy No/}).click();
  await expect(page).toHaveURL(/side=no/);
});

test("search has a recoverable empty result", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("market-card").first()).toBeVisible();
  await page.getByRole("searchbox", {name:"Search markets"}).fill("no-matching-market-xyz");
  await expect(page.getByText("No markets match your search.", {exact:false})).toBeVisible();
  await page.getByRole("button", {name:"Clear search"}).click();
  await expect(page.getByTestId("market-card").first()).toBeVisible();
});

test("rules and disconnected trading controls remain accurate", async ({ page }) => {
  await page.goto(`/market?id=${chain.markets.open}`);
  await expect(page.getByRole("region", {name:"How this market resolves"}).getByText("Cancelled if")).toBeVisible();
  await page.getByLabel("Amount", {exact:true}).fill("5");
  await expect(page.getByRole("complementary", {name:"Trade ticket"}).getByRole("button", {name:"Connect wallet"})).toBeVisible();
  await page.getByLabel("Amount", {exact:true}).fill("abc");
  await expect(page.getByLabel("Amount", {exact:true})).toHaveAttribute("aria-invalid","true");
});

test("Visx history has a readable data alternative", async ({ page }) => {
  await page.goto(`/market?id=${chain.markets.open}`);
  await expect(page.locator(".outcome-chart svg")).toBeVisible();
  await page.getByText("Data", {exact:true}).click();
  expect(await page.locator(".outcome-data tbody tr").count()).toBeGreaterThan(0);
});

for (const state of ["proposed", "disputed", "verdict", "final_yes"]) {
  test(`resolution ${state} requires a wallet before mutations`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", e=>errors.push(e.message));
    await page.goto(`/market?id=${chain.markets[state]}`);
    await expect(page.locator(".resolution-record")).toBeVisible();
    await expect(page.getByRole("button", {name:/Submit proposal|Submit challenge|Commit vote|Reveal vote/})).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("portfolio displays the connected sandbox account", async ({ page }) => {
  await page.goto(`/portfolio?as=${chain.accounts.alice}`);
  await expect(page.getByRole("heading", {name:"Portfolio",exact:true})).toBeVisible();
  await expect(page.getByText("Market balance",{exact:true})).toBeVisible();
  await expect(page.getByRole("button", {name:"Withdraw",exact:true})).toBeVisible();
});
