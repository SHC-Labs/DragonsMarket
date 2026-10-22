import { test, expect } from "@playwright/test";

test("top navigation has one Council entry for membership and disputes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#council")).toHaveCount(0);
  await expect(page.locator("#membership")).toHaveCount(0);
  const main = page.getByRole("navigation", { name: "Main", exact: true }).filter({ visible: true });
  for (const [label, path, heading] of [
    ["Council", "/council", "Dragon Council"],
    ["Portfolio", "/portfolio", "Portfolio"],
    ["Markets", "/", "Prediction markets"],
  ]) {
    await main.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path === "/" ? "/" : path}/?$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
    await expect(page.getByRole("heading", { level: 1 })).toHaveClass("sr-only");
    await expect(main.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }
  await expect(main.getByRole("link", { name: "Membership", exact: true })).toHaveCount(0);
  await page.goto("/council");
  await expect(page.getByRole("heading", { name: "Join the Council" })).toBeVisible();
  await expect(page.getByRole("region", { name: "NFT collection" }).getByRole("img")).toHaveCount(10);
  await expect(page.getByRole("heading", { name: "Cases and results" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Council sections" })).toHaveCount(0);
  await page.getByRole("link", { name: /See how disputes work/ }).click();
  await expect(page).toHaveURL(/\/council#process$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});

test("legacy membership links lead to the Council membership section", async ({ page }) => {
  await page.goto("/membership");
  await expect(page).toHaveURL(/\/council#membership$/);
  await expect(page.locator("#membership")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dragon Council");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dragon Council");
});
