import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 3056;
let child: ChildProcess;

async function oracleView(method: string, args: object) {
  const res = await fetch(`http://127.0.0.1:${PORT}`, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", account_id: "oracle.test.near", method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
  });
  const body = await res.json();
  return JSON.parse(Buffer.from(body.result.result).toString());
}

beforeAll(async () => {
  child = spawn("node", ["scripts/mock-chain.mjs"], { env: { ...process.env, MOCK_CHAIN_PORT: String(PORT) }, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
});
afterAll(() => { child.kill(); });

describe("mock chain oracle", () => {
  it("gives each market id its own case_uid", async () => {
    const one = await oracleView("get_case", { market: "market.test.near", market_id: "1" });
    const two = await oracleView("get_case", { market: "market.test.near", market_id: "2" });
    expect(one.case_uid).not.toBe(two.case_uid);
    expect(one.case_uid).toMatch(/^\d+$/);
  });
  it("answers nothing for a market account it does not serve", async () => {
    expect(await oracleView("get_case", { market: "other.test.near", market_id: "1" })).toBeNull();
    expect(await oracleView("list_cases", { market: "other.test.near", from_market_id: "0", limit: 10 })).toEqual([]);
  });
});
