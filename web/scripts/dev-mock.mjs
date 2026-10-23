// Starts the mock chain (scripts/mock-chain.mjs) and the Next dev server against it, on :3400 (PORT overrides).
// For UI work without Rust or the NEAR sandbox; see scripts/dev-local.sh for the real local chain.
import { spawn } from "node:child_process";

const rpc = `http://127.0.0.1:${process.env.MOCK_CHAIN_PORT ?? 3030}`;
const env = {
  ...process.env,
  NEXT_PUBLIC_NETWORK: "sandbox",
  NEXT_PUBLIC_RPC_URL: rpc,
  NEXT_PUBLIC_MARKET_ID: "market.test.near",
  NEXT_PUBLIC_ORACLE_ID: "oracle.test.near",
  NEXT_PUBLIC_COUNCIL_ID: "council.test.near",
  NEXT_PUBLIC_VERIFIER_ID: "intents.test.near",
  NEXT_PUBLIC_COLLATERAL_TOKEN_ID: "nep141:ft.test.near",
  NEXT_PUBLIC_TOKEN_ID: "ft.test.near",
};

const children = [
  spawn(process.execPath, ["scripts/mock-chain.mjs"], { env, stdio: "inherit" }),
  spawn("npx", ["next", "dev", "-p", process.env.PORT ?? "3400"], { env, stdio: "inherit", shell: true }),
];
const stop = () => children.forEach((c) => c.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((c) => c.on("exit", (code) => { stop(); process.exitCode = code ?? 0; }));
