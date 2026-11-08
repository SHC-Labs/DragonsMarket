// Production Caddy + Chromium check. Wallet responses are local fixtures: no
// wallet credentials, account signatures or chain transactions are involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { cashOutWalletMethod, installCashOutFixture, checkCashOutBrowser } from "./cash-out-browser.mjs";
import { checkStakeBrowser } from "./stake-browser.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = process.env.CSP_TEST_PORT ?? "3397", base = `http://127.0.0.1:${port}`;
const state = await mkdtemp(resolve(tmpdir(), "dragons-csp-"));
const server = spawn(process.env.CADDY_BIN ?? "caddy", ["run", "--config", resolve(root, "Caddyfile"), "--adapter", "caddyfile"], {
  cwd: root, env: { ...process.env, PORT: port, STATIC_ROOT: resolve(root, "web/out-caddy"),
    XDG_CONFIG_HOME: state, XDG_DATA_HOME: state }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "", browser;
server.stdout.on("data", chunk => { logs += chunk; });
server.stderr.on("data", chunk => { logs += chunk; });
const exited = once(server, "exit").catch(error => { logs += error.message; });
const nonceOf = response => response.headers.get("content-security-policy")?.match(/'nonce-([A-Za-z0-9]{32})'/)?.[1];
try {
  let started = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) break;
    if (await fetch(`${base}/health/live`).then(r => r.ok, () => false)) { started = true; break; }
    await delay(100);
  }
  assert.ok(started, logs);
  const nonces = new Set();
  const pages = (await readdir(resolve(root, "web/out-caddy"), { recursive: true })).filter(name => name.endsWith(".html"));
  for (const path of [...pages.map(name => `/${name}`), "/", "/agents", "/__missing-csp-page"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, path.startsWith("/__missing") ? 404 : 200, path);
    const nonce = nonceOf(response), html = await response.text();
    assert.ok(nonce, path);
    assert.ok(!nonces.has(nonce), "fresh nonce on every response");
    nonces.add(nonce);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.doesNotMatch(html, /\[\[DM_CSP|DM_CSP\]\]/);
    for (const tag of html.matchAll(/<script\b[^>]*>/g)) assert.ok(tag[0].includes(`nonce="${nonce}"`), path);
  }
  for (const headers of [{ Range: "bytes=0-100" }, { "If-Modified-Since": "Wed, 01 Jan 2099 00:00:00 GMT" }]) {
    const response = await fetch(base, { headers });
    assert.equal(response.status, 200);
    assert.ok(nonceOf(response));
    assert.match(await response.text(), /^<!DOCTYPE html>/i);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cashOut = await installCashOutFixture(page.context());
  const errors = [], violations = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (/Content Security Policy|violates.*directive/i.test(message.text())) violations.push(message.text()); });
  const executor = "https://raw.githubusercontent.com/csp-fixture/wallet.js";
  const manifest = { version: "1.0.0", wallets: [{ id: "csp-fixture", name: "CSP Test Wallet", type: "sandbox",
    platform: ["web"], icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", description: "Local test", website: "https://example.com",
    version: "1.0.0", executor, permissions: { storage: true },
    features: { testnet: true, mainnet: true, signMessage: true, signAndSendTransaction: true } }] };
  await page.context().route("https://**/*manifest.json", route => route.fulfill({ json: manifest, headers: { "access-control-allow-origin": "*" } }));
  await page.context().route(`${executor}*`, route => route.fulfill({ contentType: "application/javascript",
    headers: { "access-control-allow-origin": "*" }, body: `window.selector.ready({
      signIn: async () => [{accountId: 'csp-test.testnet', publicKey: 'ed25519:test-only'}],
      getAccounts: async () => [{accountId: 'csp-test.testnet', publicKey: 'ed25519:test-only'}],
      ${cashOutWalletMethod}
      signOut: async () => {}
    });` }));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /connect wallet/i }).first().click();
  await page.getByText("CSP Test Wallet", { exact: true }).click();
  await page.getByText("csp-test.testnet", { exact: true }).waitFor({ state: "visible", timeout: 15000 }).catch(error => {
    throw new Error(`${error.message}\nErrors: ${JSON.stringify(errors)}\nCSP: ${JSON.stringify(violations)}`);
  });
  assert.deepEqual(errors, [], "hydration and wallet iframe scripts execute");
  assert.deepEqual(violations, [], "legitimate wallet connection has no CSP violations");
  await page.getByRole("checkbox", { name: "I agree to the Terms of Use." }).check();
  await page.getByRole("checkbox", { name: "I acknowledge the Privacy Policy." }).check();
  await page.getByRole("button", { name: "Accept and continue" }).click();
  const navigation = page.getByRole("navigation", { name: "Main", exact: true }).filter({ visible: true });
  for (const [label, path] of [["Agents", "/agents"], ["Council", "/council"], ["Portfolio", "/portfolio"]]) {
    await navigation.getByRole("link", { name: label, exact: true }).click();
    await page.waitForURL(base + path);
    await page.getByRole("button", { name: "Connected as csp-test.testnet. Disconnect" }).waitFor();
  }
  await checkCashOutBrowser(page, cashOut, base);
  await checkStakeBrowser(page, base);
  for (const path of ["/agents", "/docs", "/api", "/council", "/privacy"]) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    assert.equal(await page.locator("h1").count() > 0, true, path);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
  // Inject parser-created scripts and event handlers into an otherwise genuine
  // response, retaining its real CSP. Neither is signed with the response nonce.
  await page.route(`${base}/?attack`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("</body>",
      '<script>window.cspInjected = true</script><img src="/missing-image" onerror="window.cspHandler = true"></body>') });
  });
  await page.goto(`${base}/?attack`, { waitUntil: "networkidle" });
  assert.deepEqual(await page.evaluate(() => [Boolean(window.cspInjected), Boolean(window.cspHandler)]), [false, false]);
  assert.ok(violations.length >= 2, "browser reports the blocked injection attempts");
  console.log(`CSP passed: ${pages.length} exported documents, nonce rotation, caching, 404s, browser hydration, sandboxed wallet connection, blocked script/event injection`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await exited;
  await rm(state, { recursive: true, force: true });
}
