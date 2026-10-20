import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routes = ["/", "/watchlist", "/council", "/partnerships", "/portfolio"];

test("main pages start with content and keep Dragons Market as the shared brand", async ({ page }) => {
  for (const theme of ["dark", "light"]) {
    await page.addInitScript(t => localStorage.setItem("council-theme", t), theme);
    let contentPadding: string | undefined;
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator(".page-content")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.locator("main h1")).toHaveClass("sr-only");
      await expect(page.locator("main .page-header")).toHaveCount(0);
      await expect(page.locator("main .page-description")).toHaveCount(0);
      const padding = await page.locator(".page-content").evaluate(e => getComputedStyle(e).paddingTop);
      contentPadding ??= padding;
      expect(padding).toBe(contentPadding);
      expect(await page.locator("header .brand-wordmark").first().evaluate(e => getComputedStyle(e).fontFamily)).toContain("Sora");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    }
    await page.goto("/council");
    await expect(page.getByRole("navigation", { name: "Council sections" })).toHaveCount(0);
    await expect(page.locator(".collection-tilt-card img")).toHaveCount(4);
    await page.locator(".membership-faq summary").first().click();
    await expect(page.locator(".membership-faq details").first()).toHaveAttribute("open", "");
    await page.goto("/partnerships");
    await expect(page.locator(".partner-hero-art figcaption")).toHaveCount(0);
    await expect(page.locator(".partner-logos a")).toHaveCount(2);
    const partner = page.getByRole("link", { name: "Explore Degen Arena", exact: false });
    await expect(partner).toHaveAttribute("href", "https://degenarena.gg");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  }
});

test("the header guide works as a modal on every page", async ({ page }) => {
  for (const theme of ["dark", "light"]) {
    await page.addInitScript(t => localStorage.setItem("council-theme", t), theme);
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator(".page-content")).toBeVisible();
      await expect(page.locator(".page-header .page-description")).toHaveCount(0);
      await expect(page.locator("main .market-help, main .guide-steps")).toHaveCount(0);
      const trigger = page.getByRole("button", { name: "How it works", exact: true });
      const themeButton = page.getByRole("button", { name: /Switch to .* theme/ });
      const guideBox = await trigger.boundingBox();
      const themeBox = await themeButton.boundingBox();
      expect(themeBox!.x - (guideBox!.x + guideBox!.width)).toBeGreaterThanOrEqual(16);
      await trigger.hover();
      await expect.poll(() => trigger.evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "How it works", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".guide-stage")).toHaveCount(1);
      await expect(dialog.getByText("Step 1 of 3", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "Choose a market" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "Close guide" })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(dialog.getByRole("button", { name: "Next", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Close guide" })).toBeFocused();
      expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
      expect(await dialog.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
      await dialog.getByRole("button", { name: "Next", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: "Buy Yes or No" })).toBeFocused();
      await expect(dialog.getByText("Step 2 of 3", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Back", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: "Choose a market" })).toBeVisible();
      await dialog.getByRole("button", { name: "Next", exact: true }).click();
      await dialog.getByRole("button", { name: "Next", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: "Follow the result" })).toBeFocused();
      await expect(dialog.getByText("Step 3 of 3", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Finish", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(dialog.getByText("Step 1 of 3", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    }
    const trigger = page.getByRole("button", { name: "How it works", exact: true });
    await trigger.click();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    await page.getByRole("dialog").getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.mouse.click(2, 2);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await trigger.click();
    await page.getByRole("dialog").getByRole("link", { name: "How results are decided" }).click();
    await expect(page).toHaveURL(/\/council$/);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  }
});
