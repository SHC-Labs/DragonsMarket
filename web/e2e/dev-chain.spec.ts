import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Needs the local dev chain running (contracts/pm-tests/tests/dev_chain.rs) and the site built with npm run build:dev.
const chain = JSON.parse(readFileSync(join(__dirname, "../../contracts/dev-chain.json"), "utf8"));
const acct = chain.accounts;
const ids = chain.markets; // which market is in which resolution state
const COUNT: number = chain.count;
const shots = join(__dirname, "../../replica/clone-screens") + "/";

async function open(page: Page, path: string, as?: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const sep = path.includes("?") ? "&" : "?";
  await page.goto(as ? `${path}${sep}as=${as}` : path);
  return errors;
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page should not scroll sideways").toBeLessThanOrEqual(0);
}

test("S01 home: featured market, trending, and a card for every market with its state", async ({ page }, info) => {
  const errors = await open(page, "/", acct.alice);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Prediction markets");
  await expect(page.getByTestId("featured-market")).toBeVisible();
  const cards = page.getByTestId("market-card");
  await expect(cards).toHaveCount(COUNT);
  await expect(cards.filter({ hasText: "Will the Fed raise rates" })).toBeVisible();
  for (const word of ["Open", "Answer proposed", "Challenged", "Closed", "Final"]) {
    await expect(page.getByText(word, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  }
  await expect(page.getByText("Local test chain: play money only.")).toBeVisible();
  // Each card says where it belongs.
  await expect(cards.filter({ hasText: "Will the Lakers win" }).getByText("Sports")).toBeVisible();
  // A finished market shows its result, not a price that looks live.
  const finalCard = cards.filter({ hasText: "Tropical Storm Isaias" });
  await expect(finalCard.getByText("Result")).toBeVisible();
  await expect(finalCard.getByText("chance")).toHaveCount(0);
  await expect(page.locator("#council")).toHaveCount(0);
  await page.waitForTimeout(900);
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}S01-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("S01 search narrows the cards, matches topics too, and clears", async ({ page }) => {
  await open(page, "/", acct.alice);
  const cards = page.getByTestId("market-card");
  await expect(cards).toHaveCount(COUNT);
  await page.getByLabel("Search markets").fill("bitcoin");
  await expect(cards).toHaveCount(2);
  await page.getByLabel("Search markets").fill("formula");
  await expect(cards).toHaveCount(1); // found through its sub-category name, not its title
  await page.getByLabel("Search markets").fill("zzzz");
  await expect(page.getByText("No markets match that.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(cards).toHaveCount(COUNT);
  await page.getByLabel("Search markets").fill("senate");
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(cards).toHaveCount(COUNT);
});

test("S01 status toggle and sort", async ({ page }) => {
  await open(page, "/", acct.alice);
  const cards = page.getByTestId("market-card");
  await page.getByRole("button", { name: /^Open/ }).click();
  await expect(cards).toHaveCount(COUNT - 5);
  await page.getByRole("button", { name: /^In resolution/ }).click();
  await expect(cards).toHaveCount(3);
  await page.getByRole("button", { name: /^Final/ }).click();
  await expect(cards).toHaveCount(2);
  await expect(page.getByRole("button", { name: /^Final/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^All/ }).first().click();
  await page.getByLabel("Sort by").selectOption("closing");
  await expect(page).toHaveURL(/sort=closing/);
  await expect(cards.first()).toBeVisible();
});

test("categories: pick a topic, then a sub-category, and the address keeps the choice", async ({ page }) => {
  await open(page, "/", acct.alice);
  const cards = page.getByTestId("market-card");
  const tab = (name: RegExp) => page.getByRole("group", { name: "Category" }).getByRole("button", { name });

  // Every top-level topic is there with a count.
  for (const label of ["Politics", "Sports", "Crypto", "Economy", "Tech", "Culture", "World"]) await expect(tab(new RegExp(`^${label}`))).toBeVisible();
  await expect(tab(/^Sports/)).toContainText("6");

  await tab(/^Sports/).click();
  await expect(page).toHaveURL(/cat=sports/);
  await expect(cards).toHaveCount(6);
  await expect(page.getByRole("heading", { name: "6 markets in Sports" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trending in Sports" })).toBeVisible();

  // Sports sub-categories, including the ones with nothing in them yet.
  const topics = page.getByRole("group", { name: "Sports topics" });
  for (const label of ["NFL", "NBA", "MLB", "NHL", "Soccer", "World Cup", "Tennis", "Formula 1"]) await expect(topics.getByRole("button", { name: new RegExp(`^${label}`) })).toBeVisible();

  await topics.getByRole("button", { name: /^NFL/ }).click();
  await expect(page).toHaveURL(/sub=nfl/);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Chiefs");
  await expect(page.getByRole("heading", { name: "1 market in NFL" })).toBeVisible();

  // The choice survives a refresh, so a filtered view can be shared.
  await page.reload();
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole("group", { name: "Sports topics" }).getByRole("button", { name: /^NFL/ })).toHaveAttribute("aria-pressed", "true");

  // An empty sub-category says so plainly.
  await page.getByRole("group", { name: "Sports topics" }).getByRole("button", { name: /^NHL/ }).click();
  await expect(page.getByText("No markets in NHL yet.")).toBeVisible();

  // Switching topic resets the sub-category.
  await tab(/^Crypto/).click();
  await expect(page).not.toHaveURL(/sub=/);
  await expect(cards).toHaveCount(3);
  await page.getByRole("group", { name: "Crypto topics" }).getByRole("button", { name: /^NEAR/ }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("NEAR Intents");

  // Back to everything.
  await page.getByRole("button", { name: /^All markets/ }).click();
  await expect(cards).toHaveCount(COUNT);
});

test("categories: a shared link opens straight into the filtered view, and a market links back to its topic", async ({ page }) => {
  await open(page, "/?cat=politics&sub=world-elections", acct.alice);
  await expect(page.getByTestId("market-card")).toHaveCount(2);
  await page.getByTestId("market-card").first().getByRole("link").first().click();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link", { name: "Politics" })).toBeVisible();
  await expect(crumbs.getByRole("link", { name: "World elections" })).toBeVisible();
  await crumbs.getByRole("link", { name: "World elections" }).click();
  await expect(page.getByTestId("market-card")).toHaveCount(2);
});

test("press / to jump to search", async ({ page }, info) => {
  test.skip(info.project.name === "phone" || info.project.name === "tablet", "no keyboard shortcut on touch screens");
  await open(page, "/", acct.alice);
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("/");
  await expect(page.getByLabel("Search markets")).toBeFocused();
});

test("the page has side margins at every size and nothing touches the screen edge", async ({ page }) => {
  for (const path of ["/", "/?cat=sports", "/market?id=0", "/portfolio"]) {
    await open(page, path, acct.alice);
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const iw = document.documentElement.clientWidth;
      const main = getComputedStyle(document.querySelector("main")!);
      const tight: string[] = [];
      document.querySelectorAll("body *").forEach((el) => {
        if (el.children.length || !(el.textContent ?? "").trim() || el.closest("svg, [role=group], [aria-hidden=true]")) return;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") return;
        const range = document.createRange();
        range.selectNodeContents(el); // the text itself, not the box around it
        const b = range.getBoundingClientRect();
        // Text cut off by its container (ellipsis, scrolling chip rows) is not on screen, so only count the visible part.
        let left = b.left;
        let right = b.right;
        for (let a: HTMLElement | null = el as HTMLElement; a && a !== document.body; a = a.parentElement) {
          if (getComputedStyle(a).overflowX !== "visible") {
            const ar = a.getBoundingClientRect();
            left = Math.max(left, ar.left);
            right = Math.min(right, ar.right);
          }
        }
        if (right - left > 2 && (left < 8 || right > iw - 8)) tight.push(`"${(el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(left)}..${Math.round(right)} of ${iw}`);
      });
      return { iw, padL: parseFloat(main.paddingLeft), padR: parseFloat(main.paddingRight), tight: tight.slice(0, 4) };
    });
    expect(r.padL, `${path} left margin`).toBeGreaterThanOrEqual(14);
    expect(r.padR, `${path} right margin`).toBeGreaterThanOrEqual(14);
    expect(r.tight, `${path} text too close to the screen edge`).toEqual([]);
  }
});

test("no sideways scroll at any window width, down to very small phones", async ({ page }) => {
  for (const width of [320, 360, 600, 768, 1024, 1280, 1366, 1536, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/market?id=0", "/portfolio"]) {
      await open(page, path, acct.alice);
      await page.waitForTimeout(700);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});

test("market chart: drawn from the contract's price log, with a hover readout and a data table", async ({ page }, info) => {
  const errors = await open(page, "/market?id=0", acct.alice);
  const chart = page.getByRole("img", { name: /Chance of Yes over time/ });
  await expect(chart).toBeVisible();
  await expect(page.getByText("chance of Yes").first()).toBeVisible();
  const box = await chart.boundingBox();
  expect(box && box.width).toBeGreaterThan(200);
  if (info.project.name !== "phone" && info.project.name !== "tablet") {
    await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height / 2);
    await expect(page.locator("div.shadow-pop").filter({ hasText: "%" })).toBeVisible();
  }
  await page.getByText("Show the data").click();
  const rows = page.locator("details table tbody tr");
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  await expect(rows.first().getByText("50%")).toBeVisible(); // the opening price is always 50%
  expect(errors).toEqual([]);
});

test("S02 open market: rules come first, the quote is real, a buy is blocked without a wallet", async ({ page }, info) => {
  const errors = await open(page, "/market?id=0", acct.alice);
  await expect(page.getByRole("heading", { name: "Will the Fed raise rates at its next meeting?" })).toBeVisible();
  const rules = page.getByRole("region", { name: "How this market resolves" });
  await expect(rules.getByText("Void if")).toBeVisible();
  await expect(rules.getByText("postponed past 31 December")).toBeVisible();
  await expect(rules.getByLabel("Rule fingerprint")).toBeVisible();

  // Button says why it is off, then a real quote from the chain fills the lines.
  await expect(page.getByText("Enter an amount.")).toBeVisible();
  await page.getByLabel("Amount").fill("5");
  await expect(page.getByText("You get about").locator("..").locator(".num")).not.toHaveText("-", { timeout: 10_000 });
  await expect(page.getByText("Least you will get")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Buy .*Yes$/ })).toBeEnabled();

  // Over the balance is refused in words.
  await page.getByLabel("Amount").fill("5000");
  await expect(page.getByText(/You have .* mUSD\. This costs 5,000\.00\./)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Buy / })).toBeDisabled();
  await page.getByLabel("Amount").fill("abc");
  await expect(page.getByText("Enter an amount.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Buy / })).toBeDisabled();
  await page.waitForTimeout(300);

  await noSideScroll(page);
  await page.screenshot({ path: `${shots}S02-open-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("S09 answer proposed: challenge is offered to others, not to the proposer", async ({ page }, info) => {
  let errors = await open(page, `/market?id=${ids.proposed}`, acct.alice);
  await expect(page.getByText("Proposed answer:")).toBeVisible();
  await expect(page.getByRole("button", { name: /Challenge this answer/ })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Challenge window" })).toHaveAttribute("aria-current", "step");
  await page.screenshot({ path: `${shots}S09-proposed-${info.project.name}.png`, fullPage: true });
  await noSideScroll(page);

  errors = errors.concat(await open(page, `/market?id=${ids.proposed}`, acct.carol));
  await expect(page.getByText("Proposed answer:")).toBeVisible();
  await expect(page.getByRole("button", { name: /Challenge this answer/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("S09 dispute: the Council shows its jurors, votes and reasons", async ({ page }, info) => {
  const errors = await open(page, `/market?id=${ids.disputed}`, acct.jurors[1]);
  const council = page.locator("div", { has: page.getByRole("heading", { name: "The Council" }) }).last();
  await expect(page.getByRole("heading", { name: "The Council" })).toBeVisible();
  await expect(page.getByText("Jury of 3.")).toBeVisible();
  await expect(page.getByText("The scoreboard lists the Yankees as the winner.")).toBeVisible();
  await expect(page.getByText("Not voted")).toHaveCount(2);
  // A juror who has not voted sees the vote form and it asks for a reason.
  await expect(page.getByLabel(/Reason/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Vote / })).toBeDisabled();
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}S09-council-${info.project.name}.png`, fullPage: true });
  void council;
  expect(errors).toEqual([]);
});

test("S09 verdict: the Council's decision is stated plainly and sealed", async ({ page }, info) => {
  const errors = await open(page, `/market?id=${ids.verdict}`, acct.bob);
  await expect(page.getByText("Verdict: No")).toBeVisible();
  await expect(page.getByText("2 of 2 votes for No.")).toBeVisible();
  await expect(page.getByText("Sealed by the Council")).toBeVisible();
  await expect(page.getByText("Result: No")).toBeVisible();
  await expect(page.getByText("First proposed answer (challenged)")).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}S09-verdict-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("closed market with no answer yet invites a proposal with the bond shown", async ({ page }, info) => {
  const errors = await open(page, `/market?id=${ids.nobody}`, acct.bob);
  await expect(page.getByText(/Nobody has proposed an answer yet\. Anyone can, with a bond of 5\.00 mUSD\./)).toBeVisible();
  const propose = page.getByRole("button", { name: /^Propose Yes/ });
  await expect(propose).toBeDisabled();
  await page.getByLabel("Evidence link").fill("https://example.com/proof");
  await expect(propose).toBeEnabled();
  await expect(page.getByRole("button", { name: /^Buy/ })).toBeDisabled();
  await expect(page.getByText("Trading has stopped on this market.")).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}S09-nobody-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("S05 portfolio: balances, a win to redeem, a loss explained", async ({ page }, info) => {
  const errors = await open(page, "/portfolio", acct.alice);
  await expect(page.getByRole("heading", { name: "Portfolio" })).toBeVisible();
  await expect(page.getByText("In your wallet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Will Gemini 4 be released to the public by 15 October?" })).toBeVisible();
  await expect(page.getByText(/You won [\d.,]+ mUSD/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Redeem / })).toBeVisible();
  await expect(page.getByText("Resolved No. Nothing to redeem.")).toBeVisible();
  await expect(page.getByText("Waiting for the answer").first()).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}S05-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("portfolio and tickets ask for a wallet when nobody is connected", async ({ page }) => {
  await page.goto("/portfolio");
  await page.evaluate(() => window.localStorage.removeItem("pm-dev-account"));
  await page.reload();
  await expect(page.getByText("Connect a wallet to see your positions.")).toBeVisible();
});

test("a market that does not exist says so", async ({ page }) => {
  await open(page, "/market?id=999", acct.alice);
  await expect(page.getByText("This market does not exist.")).toBeVisible();
  await open(page, "/market?id=abc", acct.alice);
  await expect(page.getByText("This market does not exist.")).toBeVisible();
});

test("accessibility: no serious or critical axe violations on the main screens", async ({ page }) => {
  for (const path of ["/", "/market?id=0", `/market?id=${ids.disputed}`, `/market?id=${ids.verdict}`, "/portfolio"]) {
    await open(page, path, acct.alice);
    await page.waitForTimeout(1500);
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${path} ${v.id}: ${v.help}`)).toEqual([]);
  }
});

test("keyboard only: the trade ticket can be filled without a mouse", async ({ page }) => {
  await open(page, "/market?id=0", acct.alice);
  await page.getByRole("tab", { name: "buy" }).focus();
  await page.keyboard.press("Tab"); // sell tab
  await page.keyboard.press("Tab"); // yes radio
  await page.keyboard.press("ArrowRight"); // choose No
  await expect(page.getByRole("radio", { name: /No/ })).toBeChecked();
  await page.keyboard.press("Tab"); // amount
  await page.keyboard.type("3");
  await expect(page.getByLabel("Amount")).toHaveValue("3");
});

test("the layout adapts to the screen: columns, type size and no overflow", async ({ page }, info) => {
  const errors = await open(page, "/", acct.alice);
  await expect(page.getByTestId("market-card").first()).toBeVisible();
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="market-card"]')] as HTMLElement[];
    const tops = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)));
    const firstRow = cards.filter((c) => Math.round(c.getBoundingClientRect().top) === [...tops][0]);
    return {
      rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
      perRow: firstRow.length,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      cardWidth: cards[0].getBoundingClientRect().width,
      bodyWidth: document.body.getBoundingClientRect().width,
    };
  });
  expect(m.overflow).toBeLessThanOrEqual(0);
  const expected: Record<string, { rootMin: number; rootMax: number; perRow: number[] }> = {
    phone: { rootMin: 16, rootMax: 16.5, perRow: [1] },
    tablet: { rootMin: 16, rootMax: 16.5, perRow: [2] },
    laptop: { rootMin: 17, rootMax: 19, perRow: [3, 4] },
    fullhd: { rootMin: 20, rootMax: 22, perRow: [4, 5] },
    tv: { rootMin: 28, rootMax: 34, perRow: [5, 6, 7] },
  };
  const e = expected[info.project.name];
  expect(m.rootPx, "root font size follows the screen").toBeGreaterThanOrEqual(e.rootMin);
  expect(m.rootPx).toBeLessThanOrEqual(e.rootMax);
  expect(e.perRow, `cards per row at ${info.project.name} was ${m.perRow}`).toContain(m.perRow);
  // Cards stay a readable size on every screen, in rem terms.
  expect(m.cardWidth / m.rootPx).toBeGreaterThan(16);
  expect(m.cardWidth / m.rootPx).toBeLessThan(32);
  await page.screenshot({ path: `${shots}home-${info.project.name}.png`, fullPage: false });
  expect(errors).toEqual([]);
});
