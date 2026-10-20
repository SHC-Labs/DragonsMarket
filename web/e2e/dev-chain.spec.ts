import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Integration read checks only. Contract mutation flows remain deliberately unwired.
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
  await expect(page.getByText("No markets match that.", {exact:false})).toBeVisible();
  await page.getByRole("button", {name:"Clear search"}).click();
  await expect(page.getByTestId("market-card").first()).toBeVisible();
});

test("rules and trade placeholders remain accurate before wiring", async ({ page }) => {
  await page.goto(`/market?id=${chain.markets.open}`);
  await expect(page.getByRole("region", {name:"How this market resolves"}).getByText("Cancelled if")).toBeVisible();
  await page.getByLabel("Amount", {exact:true}).fill("5");
  await expect(page.getByText("Not available yet", {exact:true})).toBeVisible();
  await expect(page.getByRole("button", {name:"Trading coming soon"})).toBeDisabled();
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
  test(`resolution ${state} stays read-only and does not crash`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", e=>errors.push(e.message));
    await page.goto(`/market?id=${chain.markets[state]}`);
    await expect(page.locator(".resolution-record")).toBeVisible();
    await expect(page.getByRole("button", {name:/Vote |Challenge this answer|Make it final/})).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("portfolio transactions remain unavailable", async ({ page }) => {
  await page.goto(`/portfolio?as=${chain.accounts.alice}`);
  await expect(page.getByRole("button", {name:"Withdrawals coming soon"})).toBeDisabled();
  for(const button of await page.getByRole("button", {name:"Redemption coming soon"}).all()) await expect(button).toBeDisabled();
});
