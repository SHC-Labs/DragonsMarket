import { defineConfig } from "@playwright/test";

// Runs against the exported site (npm run build:dev first) and the local dev chain (see contracts/pm-tests/tests/dev_chain.rs).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3390" },
  webServer: {
    command: "node scripts/serve.mjs",
    url: "http://127.0.0.1:3390",
    reuseExistingServer: true,
    timeout: 30_000,
  },
  // One run per screen class. The layout reads the screen on its own, so every test runs at each size.
  projects: [
    { name: "phone", use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
    { name: "tablet", use: { viewport: { width: 820, height: 1180 }, hasTouch: true } },
    { name: "laptop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "fullhd", use: { viewport: { width: 1920, height: 1080 } } },
    { name: "tv", use: { viewport: { width: 3840, height: 2160 } } },
  ],
});
