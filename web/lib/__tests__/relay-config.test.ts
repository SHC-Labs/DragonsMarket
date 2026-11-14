import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const configured = () => {
  for (const [k, v] of Object.entries({ NEXT_PUBLIC_NETWORK: "mainnet", NEXT_PUBLIC_MARKET_ID: "m.near", NEXT_PUBLIC_ORACLE_ID: "o.near", NEXT_PUBLIC_VERIFIER_ID: "intents.near",
    NEXT_PUBLIC_COLLATERAL_TOKEN_ID: "nep141:usdc.near", NEXT_PUBLIC_BACKEND_URL: "https://api.example", NEXT_PUBLIC_RELAYER_ID: "relayer.near" })) vi.stubEnv(k, v);
};

it("enables the relay from a relayer and a backend alone: the fee comes from the backend, not the build", async () => {
  configured();
  vi.stubEnv("NEXT_PUBLIC_RELAY_FEE", "");
  const config = await import("../config");
  expect(config.relayEnabled).toBe(true);
  expect("relayFeeUnits" in config).toBe(false);
});

it("keeps the relay off without a relayer, without a backend, and in the sandbox", async () => {
  for (const [key, value] of [["NEXT_PUBLIC_RELAYER_ID", ""], ["NEXT_PUBLIC_BACKEND_URL", ""], ["NEXT_PUBLIC_NETWORK", "sandbox"]]) {
    vi.resetModules();
    configured();
    vi.stubEnv(key, value);
    expect((await import("../config")).relayEnabled, key).toBe(false);
  }
});
