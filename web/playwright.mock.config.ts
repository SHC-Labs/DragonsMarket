import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The same suite against the dev server and mock chain (npm run dev:mock), for machines without the NEAR sandbox.
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: "http://localhost:3400" },
  webServer: { command: "npm run dev:mock", url: "http://localhost:3400", reuseExistingServer: true, timeout: 120_000 },
});
