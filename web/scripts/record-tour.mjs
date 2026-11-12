// Records a walkthrough video of the built site. Needs `npm run build:dev` first.
// Starts the local static server itself, so run this with the server NOT already up
// (or pass REUSE_SERVER=1 if scripts/serve.mjs is already running on :3390).
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL = "http://127.0.0.1:3390";
const OUT_DIR = "tour-video";
const VIEWPORT = { width: 1440, height: 900 };

const PAGES = [
  { path: "/", label: "Markets" },
  { path: "/council", label: "Council" },
  { path: "/membership", label: "Membership" },
  { path: "/watchlist", label: "Watchlist" },
  { path: "/portfolio", label: "Portfolio" },
];

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("server never came up on " + BASE_URL);
}

async function smoothScrollTo(page, y, duration) {
  await page.evaluate(({ target, duration }) => {
    return new Promise((resolve) => {
      const start = window.scrollY;
      const distance = target - start;
      const startTime = performance.now();
      function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        window.scrollTo(0, start + distance * eased);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }, { target: y, duration });
}

// Scrolls down in readable increments (about one screen height at a time), pausing on each
// so there's time to actually read before the next move, instead of one long smooth blur.
async function scrollThroughPage(page, viewportHeight) {
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  if (scrollHeight <= viewportHeight + 100) {
    await sleep(2500);
    return;
  }
  const step = Math.round(viewportHeight * 0.8);
  let y = 0;
  while (y < scrollHeight - viewportHeight) {
    y = Math.min(y + step, scrollHeight - viewportHeight);
    await smoothScrollTo(page, y, 1400);
    await sleep(2200);
  }
  await sleep(800);
  await smoothScrollTo(page, 0, 1600);
  await sleep(600);
}

let server;
if (!process.env.REUSE_SERVER) {
  server = spawn("node", ["scripts/serve.mjs"], { stdio: "inherit" });
}

try {
  await waitForServer();

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();

  let marketHref = null;
  for (const { path, label } of PAGES) {
    console.log("visiting", label);
    await page.goto(BASE_URL + path, { waitUntil: "networkidle" });
    await sleep(2500);
    if (path === "/" && !marketHref) {
      marketHref = await page.evaluate(() => {
        const link = document.querySelector('a[href^="/market?id="]');
        return link ? link.getAttribute("href") : null;
      });
    }
    await scrollThroughPage(page, VIEWPORT.height);
  }

  if (marketHref) {
    console.log("visiting Market detail", marketHref);
    await page.goto(BASE_URL + marketHref, { waitUntil: "networkidle" });
    await sleep(3500);
  } else {
    console.log("no market link found on the home page, skipping market detail");
  }

  await context.close();
  await browser.close();

  console.log("video saved under", OUT_DIR);
} finally {
  if (server) server.kill();
}
