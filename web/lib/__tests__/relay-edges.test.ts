import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../config", () => ({ config: { backendUrl: "https://api.example", relayerId: "relayer.near", verifierId: "intents.near" } }));

import { relayOutcome } from "../hooks";
import { resubmit, signAndRelay, type Attempt } from "../relay";
import { PAYLOAD_LIFETIME_MS, type MultiPayload } from "../signed-intents";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } });
  vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, work: (lock: object) => unknown) => work({}) } });
});

// backend/src/relay.ts refuses any payload with less than this much life left when it arrives (MIN_DEADLINE_MS).
const RELAY_MIN_LIFE_MS = 60_000;

it("does not send a first signature the relay will refuse as expired after a slow second signature", async () => {
  const posted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/intents/fee")) return new Response(JSON.stringify({ fee: "15000", validUntil: new Date(Date.now() + 590000).toISOString() }));
    posted.push(String(init?.body));
    return new Response(JSON.stringify({ error: { code: "invalid_deadline", index: 0 } }), { status: 400 });
  }));
  let t = Date.parse("2026-11-09T12:00:00Z");
  let signatures = 0;
  // The second wallet prompt is answered 4 m 15 s after the first payload was built: 45 s of its life is left.
  const sign = async (payload: string): Promise<MultiPayload> => {
    if (signatures++ === 1) t += PAYLOAD_LIFETIME_MS - 45_000;
    return { standard: "erc191", payload, signature: "secp256k1:x" };
  };
  const result = await signAndRelay({ sign, ctx: { verifier: "intents.near", collateral: "nep141:usdc.near", relayer: "relayer.near" },
    signerId: "0xabc0000000000000000000000000000000000001", shownFee: 15_000n, now: () => t,
    actions: [{ to: "market.near", amount: 1_000_000n, msg: "register" }, { to: "market.near", amount: 5n, msg: "buy:1:yes:1" }] }).catch(e => e);
  const firstLife = posted.length ? Date.parse(JSON.parse(JSON.parse(posted[0]).signed[0].payload).deadline) - t : null;
  expect(signatures).toBe(2);
  expect(String(result)).toMatch(/Signing took too long/);
  expect(posted, `posted two signatures with ${firstLife} ms left on the first, under the relay's ${RELAY_MIN_LIFE_MS} ms floor: ${String(result)}`).toHaveLength(0);
});

it("after \"Check again\", a payload the chain already ran is not reported as a failure that spent nothing", async () => {
  // The first send landed, then the relay lost its memory of it (restart, deploy, or 10000 newer payloads evicting it). The resend
  // is simulated afresh, the verifier refuses the used nonce, and the relay answers simulation_failed.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "simulation_failed", index: 0, requestId: "r" } }), { status: 422 })));
  const attempt: Attempt = { signed: [{ standard: "erc191", payload: "pa", signature: "s" }], items: [{ standard: "erc191", payload: "pa", target: "market.near" }] };
  let t = 0;
  const out = await relayOutcome(() => resubmit(attempt), { read: async () => null, done: async () => false, doneMessage: "Bought.", timeoutMs: 1000,
    now: () => t, sleep: async (ms: number) => { t += ms; } });
  expect(`${out.phase}: ${out.message}`).not.toMatch(/^failed: .*Nothing was spent/);
});
