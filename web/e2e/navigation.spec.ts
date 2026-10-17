import { test, expect } from "@playwright/test";

test("top navigation opens separate pages and marks the current page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#council")).toHaveCount(0);
  await expect(page.locator("#membership")).toHaveCount(0);
  const main = page.getByRole("navigation", { name: "Main", exact: true }).filter({ visible: true });
  for (const [label, path, heading] of [
    ["Council", "/council", "How disputes"],
    ["Membership", "/membership", "NFT membership."],
    ["Portfolio", "/portfolio", "Portfolio"],
    ["Markets", "/", "Prediction markets"],
  ]) {
    await main.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path === "/" ? "/" : path}/?$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
    await expect(main.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }
  await page.goto("/membership");
  await expect(page.getByRole("heading", { name: "Quarterly revenue share" })).toBeVisible();
  await expect(page.locator("#council")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("NFT membership.");
});
