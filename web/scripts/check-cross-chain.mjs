import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = JSON.parse(await readFile(new URL("../lib/__tests__/fixtures/oneclick-cash-out.json", import.meta.url)));
const wallet = privateKeyToAccount(`0x${"00".repeat(31)}01`);
const port = process.env.CSP_TEST_PORT ?? "3398", base = `http://127.0.0.1:${port}`;
const storageKey = `cross-chain-cash-out:mainnet:intents.near:${wallet.address.toLowerCase()}`;
const state = await mkdtemp(resolve(tmpdir(), "dragons-cross-chain-"));
const server = spawn(process.env.CADDY_BIN ?? "caddy", ["run", "--config", resolve(root, "Caddyfile"), "--adapter", "caddyfile"], {
  cwd: root, env: { ...process.env, PORT: port, STATIC_ROOT: resolve(root, "web/out-caddy"),
    XDG_CONFIG_HOME: state, XDG_DATA_HOME: state }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "", browser;
server.stdout.on("data", chunk => { logs += chunk; });
server.stderr.on("data", chunk => { logs += chunk; });
const exited = once(server, "exit").catch(error => { logs += error.message; });

async function installFixture(context, config) {
  const signed = [], submissions = [];
  let completed = false;
  let releaseSignature;
  const signatureGate = new Promise(resolve => { releaseSignature = resolve; });
  await context.exposeBinding("fixtureSign", async (_source, message) => {
    signed.push(message);
    await signatureGate;
    return wallet.signMessage({ message });
  });
  await context.addInitScript(({ address }) => {
    window.ethereum = { request: async ({ method, params }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "personal_sign") {
        if (params[1] !== address) throw new Error("wrong signing account");
        const bytes = Uint8Array.from(params[0].slice(2).match(/../g), hex => parseInt(hex, 16));
        return window.fixtureSign(new TextDecoder().decode(bytes));
      }
      throw new Error(`Unexpected wallet call: ${method}`);
    } };
  }, { address: wallet.address });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    const headers = { "access-control-allow-origin": "*" };
    const respond = json => route.fulfill({ json, headers });
    if (url.href.endsWith("manifest.json")) return respond({ version: "1.0.0", wallets: [] });
    if (url.href.startsWith(config.rpcUrl)) {
      const body = route.request().postDataJSON();
      const values = { list_markets: [], get_balance: "0", mt_balance_of: completed ? "0" : "10000000",
        is_nonce_used: completed };
      assert.ok(Object.hasOwn(values, body.params.method_name), body.params.method_name);
      return respond({ jsonrpc: "2.0", id: body.id,
        result: { result: [...Buffer.from(JSON.stringify(values[body.params.method_name]))] } });
    }
    if (url.origin === "https://1click.chaindefuser.com") {
      if (url.pathname === "/v0/quote") {
        const request = route.request().postDataJSON();
        for (const [key, value] of Object.entries(request)) assert.equal(fixture.quoteRequest[key], value, key);
        return respond(fixture);
      }
      if (url.pathname === "/v0/generate-intent") return respond({ intent: { standard: "erc191",
        payload: JSON.stringify({ signer_id: wallet.address.toLowerCase(), verifying_contract: "intents.near",
          deadline: fixture.quote.deadline, nonce: Buffer.alloc(32, 19).toString("base64"),
          intents: [{ intent: "transfer", receiver_id: fixture.quote.depositAddress,
            tokens: { [config.collateralTokenId]: "10000000" } }] }) } });
      if (url.pathname === "/v0/submit-intent") {
        submissions.push(route.request().postData());
        return submissions.length === 1 ? route.abort("failed") : respond({ intentHash: "A".repeat(44) });
      }
      if (url.pathname === "/v0/status") return respond({ quoteResponse: fixture,
        status: completed ? "SUCCESS" : "PENDING_DEPOSIT", swapDetails: {
          amountIn: "10000000", amountOut: fixture.quote.amountOut,
          destinationChainTxHashes: completed ? [{ hash: "0x" + "cd".repeat(32) }] : [],
        } });
      throw new Error(`Unexpected 1Click request: ${url.pathname}`);
    }
    if (url.href.startsWith(config.backendUrl)) return respond({ accountId: null, fee: "1",
      validUntil: new Date(Date.parse(fixture.quoteRequest.deadline) - 25 * 60_000).toISOString() });
    return route.abort("blockedbyclient");
  });
  return { signed, submissions, releaseSignature, complete: () => { completed = true; } };
}

try {
  let started = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) break;
    if (await fetch(`${base}/health/live`).then(r => r.ok, () => false)) { started = true; break; }
    await delay(100);
  }
  assert.ok(started, logs);
  const config = await fetch(`${base}/deployment.json`).then(r => r.json());
  assert.equal(config.network, "mainnet");
  assert.equal(config.verifierId, "intents.near");
  assert.equal(config.collateralTokenId, fixture.quoteRequest.originAsset);
  assert.ok(config.backendUrl && config.relayerId, "Build with the relay fixture enabled");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const installed = await installFixture(context, config);
  const page = await context.newPage(), errors = [], violations = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", msg => { if (/Content Security Policy|violates.*directive/i.test(msg.text())) violations.push(msg.text()); });
  await page.clock.setFixedTime(Date.parse(fixture.quoteRequest.deadline) - 30 * 60_000);
  await page.goto(`${base}/portfolio`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /connect wallet/i }).first().click();
  await page.getByRole("button", { name: "Browser wallet", exact: true }).click();
  await page.getByRole("checkbox", { name: "I agree to the Terms of Use." }).check();
  await page.getByRole("checkbox", { name: "I acknowledge the Privacy Policy." }).check();
  await page.getByRole("button", { name: "Accept and continue" }).click();
  const section = page.getByRole("region", { name: "Withdraw to your wallet" });
  await section.getByLabel("Amount (USDC)").fill("10");
  await section.getByRole("button", { name: "Review withdrawal" }).click();
  await expect(section).toContainText("9.895624 USDC");
  await expect(page.locator('[data-tone="wallet"] .balance-figure')).toContainText("10.00");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile quote fits");
  if (process.env.CASHOUT_SCREENSHOT) await page.screenshot({ path: process.env.CASHOUT_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await section.getByRole("button", { name: "Sign and withdraw" }).click();
  await expect.poll(() => installed.signed.length).toBe(1);
  const other = await context.newPage();
  try {
    await other.goto(`${base}/portfolio`, { waitUntil: "networkidle" });
    const otherSection = other.getByRole("region", { name: "Withdraw to your wallet" });
    await otherSection.getByRole("button", { name: "Check withdrawal", exact: true }).click();
    await expect(otherSection).toContainText("Another tab is sending a signed action");
    assert.equal(installed.submissions.length, 0);
  } finally { installed.releaseSignature(); await other.close(); }
  await expect.poll(() => installed.submissions.length).toBe(1);
  await expect(section).toContainText("Could not confirm this withdrawal");
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.deepEqual(stored.signed, JSON.parse(installed.submissions[0]).signedData);
  await page.reload({ waitUntil: "networkidle" });
  await expect(section).toContainText("A previous withdrawal is saved");
  assert.equal(installed.signed.length, 1);
  assert.equal(installed.submissions.length, 1);
  await section.getByRole("button", { name: "Check withdrawal", exact: true }).click();
  await section.getByRole("button", { name: "Retry the same signed request" }).click();
  await expect.poll(() => installed.submissions.length).toBe(2);
  assert.equal(installed.submissions[0], installed.submissions[1]);
  assert.equal(installed.signed.length, 1);
  installed.complete();
  await section.getByRole("button", { name: "Check withdrawal", exact: true }).click();
  await expect(section).toContainText("1Click reports this withdrawal completed");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "transaction hashes wrap");
  await section.getByRole("button", { name: "Save completed withdrawal" }).click();
  await expect(section.getByLabel("Amount (USDC)")).toBeVisible();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null);
  assert.ok(await page.evaluate(key => localStorage.getItem(`${key}:last`), storageKey));
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
  console.log("Cross-chain browser passed: verified quote, ERC191 signature, cross-tab exclusion, lost reply, reload, identical retry, settlement archive, CSP");
} finally {
  await browser?.close(); server.kill("SIGTERM"); await exited;
  await rm(state, { recursive: true, force: true });
}
