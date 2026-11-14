import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({ config: { backendUrl: "https://api.example" } }));

import { exclusive, fetchRelayFee, relaySigned, RelayError, resubmit, signAndRelay } from "../relay";
import { PAYLOAD_LIFETIME_MS, type MultiPayload } from "../signed-intents";

const item = (payload: string): MultiPayload => ({ standard: "erc191", payload, signature: "secp256k1:x" });
const reply = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } });
  vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, work: (lock: object) => unknown) => work({}) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("relay client", () => {
  it("posts {signed} to /intents/relay and returns the hashes in order", async () => {
    const fetchMock = reply(200, { hashes: ["h1", "h2"] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(relaySigned([item("a"), item("b")])).resolves.toEqual(["h1", "h2"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example/intents/relay");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ signed: [item("a"), item("b")] });
  });
  it("keeps a 422 uncertain and preserves its failing index without claiming setup succeeded", async () => {
    vi.stubGlobal("fetch", reply(422, { error: { code: "simulation_failed", requestId: "r", index: 1, reason: "Your balance is too low." } }));
    const error = await relaySigned([item("a"), item("b")]).catch(e => e);
    expect(error).toBeInstanceOf(RelayError);
    expect(error.message).toMatch(/Use Check again/);
    expect(error.message).not.toMatch(/setup went through|nothing else was spent/);
    expect(error.index).toBe(1);
  });
  it("explains rate limits and outages in plain words", async () => {
    vi.stubGlobal("fetch", reply(429, { error: { code: "signer_rate_limited", requestId: "r" } }));
    await expect(relaySigned([item("a")])).rejects.toThrow("This wallet has sent too many requests");
    vi.stubGlobal("fetch", reply(503, { error: { code: "relay_key_invalid", requestId: "r" } }));
    await expect(relaySigned([item("a")])).rejects.toThrow("busy or unavailable");
  });
  it("does not claim a refund based only on an HTTP error", async () => {
    vi.stubGlobal("fetch", reply(422, { error: { code: "transfer_refunded", requestId: "r", index: 0, reason: "The price moved." } }));
    await expect(relaySigned([item("a")])).rejects.toThrow(/outcome still needs confirmation/);
  });
  it("refuses a reply with the wrong number of hashes", async () => {
    vi.stubGlobal("fetch", reply(200, { hashes: ["h1"] }));
    await expect(relaySigned([item("a"), item("b")])).rejects.toBeInstanceOf(RelayError);
  });
  it("does not promise nothing was sent when the connection drops, because the service may already have run it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const error = await relaySigned([item("a")]).catch(e => e);
    expect(error).toBeInstanceOf(RelayError);
    expect(error.message).not.toMatch(/Nothing was (sent|spent)/);
    expect(error.message).toMatch(/Use Check again/);
  });
});

describe("relay outcomes that are not all-or-nothing", () => {
  it("does not say nothing was spent when the buy fails after the account setup already ran", async () => {
    for (const code of ["simulation_failed", "rpc_unavailable", "relay_busy"]) {
      vi.stubGlobal("fetch", reply(422, { error: { code, index: 1, reason: "Price moved." } }));
      const message = (await relaySigned([item("a"), item("b")]).catch(e => e)).message as string;
      expect(message, code).not.toMatch(/Nothing was spent/);
      expect(message, code).not.toMatch(/account setup went through/);
      expect(message, code).toMatch(/Check again/);
    }
  });
  it("requires receipt confirmation before claiming a fee was paid", async () => {
    vi.stubGlobal("fetch", reply(422, { error: { code: "transfer_refunded", index: 0, reason: "The price moved." } }));
    await expect(relaySigned([item("a")])).rejects.toThrow(/outcome still needs confirmation/);
  });
  it("tells the person to check before retrying when the transaction was sent but not confirmed", async () => {
    vi.stubGlobal("fetch", reply(502, { error: { code: "transaction_not_final", index: 0 } }));
    const message = (await relaySigned([item("a")]).catch(e => e)).message as string;
    expect(message).toMatch(/outcome still needs confirmation/);
    expect(message).not.toMatch(/Nothing was spent/);
  });
  it("explains an expired signature and any other refusal in words, not a status code", async () => {
    vi.stubGlobal("fetch", reply(400, { error: { code: "invalid_deadline", index: 0 } }));
    await expect(relaySigned([item("a")])).rejects.toThrow(/expired/);
    vi.stubGlobal("fetch", reply(400, { error: { code: "action_not_allowed", index: 0 } }));
    const message = (await relaySigned([item("a")]).catch(e => e)).message as string;
    expect(message).not.toMatch(/\(400\)/);
    expect(message).not.toMatch(/Nothing was spent/);
  });
  it("gives up waiting after the timeout and says the action may still have gone through", async () => {
    vi.stubGlobal("fetch", vi.fn((_: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })));
    const error = await relaySigned([item("a")], { timeoutMs: 20 }).catch(e => e);
    expect(error).toBeInstanceOf(RelayError);
    expect(error.message).toMatch(/may have gone through/);
  });
  it("refuses a success reply that repeats a hash", async () => {
    vi.stubGlobal("fetch", reply(200, { hashes: ["h1", "h1"] }));
    await expect(relaySigned([item("a"), item("b")])).rejects.toBeInstanceOf(RelayError);
  });
});

describe("one signed action at a time", () => {
  it("refuses a second action in this tab while the first is still running", async () => {
    let release!: () => void;
    const first = exclusive(() => new Promise<string>(r => { release = () => r("one"); }));
    await expect(exclusive(async () => "two")).rejects.toThrow(/already sending/);
    release();
    await expect(first).resolves.toBe("one");
    await expect(exclusive(async () => "three")).resolves.toBe("three");
  });
  it("refuses an action while another tab holds the lock", async () => {
    vi.stubGlobal("navigator", { locks: { request: async (_: string, _o: unknown, fn: (lock: unknown) => unknown) => fn(null) } });
    await expect(exclusive(async () => "x")).rejects.toThrow(/Another tab/);
  });
});

const QUOTE = { fee: "15000", validUntil: new Date(Date.now() + 590000).toISOString() };
// The fee quote and the relay are two endpoints of one service; `relay` answers the POST.
const routed = (relay: () => Response | Promise<Response>, quote: () => Response = () => new Response(JSON.stringify(QUOTE))) =>
  vi.fn(async (url: string) => (url.endsWith("/intents/fee") ? quote() : relay()));
const posts = (mock: ReturnType<typeof routed>) => mock.mock.calls.filter(([url]) => url === "https://api.example/intents/relay") as unknown as [string, RequestInit][];
const ok = (hashes: string[]) => () => new Response(JSON.stringify({ hashes }));

describe("the relay fee", () => {
  it("reads the fee and its expiry from GET /intents/fee", async () => {
    const fetchMock = reply(200, QUOTE);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchRelayFee()).resolves.toEqual({ fee: 15_000n, validUntil: Date.parse(QUOTE.validUntil) });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example/intents/fee");
    expect(fetchMock.mock.calls[0][1]?.method ?? "GET").toBe("GET");
  });
  it("refuses a fee that is not a positive whole number of units, and a missing or broken service, in words", async () => {
    for (const body of [{ fee: "0", validUntil: QUOTE.validUntil }, { fee: "1.5", validUntil: QUOTE.validUntil }, { fee: 15000, validUntil: QUOTE.validUntil },
      { fee: "15000", validUntil: "soon" }, { fee: "15000" }, null]) {
      vi.stubGlobal("fetch", reply(200, body));
      await expect(fetchRelayFee(), JSON.stringify(body)).rejects.toThrow(/network fee/);
    }
    vi.stubGlobal("fetch", reply(503, { error: { code: "relay_unavailable" } }));
    await expect(fetchRelayFee()).rejects.toThrow(/network fee/);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(fetchRelayFee()).rejects.toThrow(/Nothing was sent/);
  });
  it("explains a fee that rose while signing and a balance that cannot cover the request", async () => {
    vi.stubGlobal("fetch", reply(422, { error: { code: "fee_too_low", index: 0, reason: "20000" } }));
    await expect(relaySigned([item("a")])).rejects.toThrow(/network fee went up/);
    vi.stubGlobal("fetch", reply(422, { error: { code: "insufficient_balance" } }));
    const message = (await relaySigned([item("a"), item("b")]).catch(e => e)).message as string;
    expect(message).toMatch(/does not hold enough/);
    expect(message).not.toMatch(/Nothing was spent/);
  });
});

describe("signing then relaying", () => {
  const ctx = { verifier: "intents.near", collateral: "nep141:usdc.near", relayer: "relayer.near" };
  const signer = "0xabc0000000000000000000000000000000000001";

  it("asks for the fee before building, and signs every payload of the action with that one quote", async () => {
    const order: string[] = [];
    const fetchMock = routed(ok(["h1", "h2"]));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { order.push(url.endsWith("/intents/fee") ? "fee" : "relay"); return fetchMock(url); }));
    const seen: string[] = [];
    await signAndRelay({ sign: async payload => { order.push("sign"); seen.push(payload); return item(payload); }, ctx, signerId: signer, shownFee: 15_000n,
      actions: [{ to: "market.near", amount: 1_000_000n, msg: "register" }, { to: "market.near", amount: 5n, msg: "buy:1:yes:1" }] });
    expect(order).toEqual(["fee", "sign", "sign", "relay"]);
    expect(seen.map(p => JSON.parse(p).intents[1])).toEqual(Array(2).fill({ intent: "transfer", receiver_id: "relayer.near", tokens: { "nep141:usdc.near": "15000" } }));
  });
  it("asks the wallet for nothing when the fee cannot be read", async () => {
    const fetchMock = routed(ok(["h1"]), () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    let prompts = 0;
    await expect(signAndRelay({ sign: async payload => { prompts++; return item(payload); }, ctx, signerId: signer, shownFee: 15_000n, actions: [{ to: "m", amount: 1n, msg: "buy:1:yes:1" }] }))
      .rejects.toThrow(/network fee/);
    expect(prompts).toBe(0);
    expect(posts(fetchMock)).toHaveLength(0);
  });
  it("submits exactly the strings the wallet signed, unicode included, in order", async () => {
    const seen: string[] = [];
    const fetchMock = routed(ok(["h1", "h2"]));
    vi.stubGlobal("fetch", fetchMock);
    const actions = [{ to: "market.near", amount: 1_000_000n, msg: "register" }, { to: "oracle.near", amount: 5n, msg: "propose:market.near:7:yes:café \u{1F409} \"q\" \\" }];
    const out = await signAndRelay({ sign: async payload => { seen.push(payload); return item(payload); }, ctx, signerId: signer, shownFee: 15_000n, actions });
    const sent = JSON.parse(String(posts(fetchMock)[0]![1].body)).signed.map((s: MultiPayload) => s.payload);
    expect(sent).toEqual(seen);
    expect(out.items.map(i => i.payload)).toEqual(seen);
    expect(out.items.map(i => i.target)).toEqual(["market.near", "oracle.near"]);
    expect(JSON.parse(seen[1]).intents[0].msg).toBe(actions[1].msg);
    expect(new TextDecoder().decode(new TextEncoder().encode(seen[1]))).toBe(seen[1]);
  });
  it("sends nothing when the second signature is declined", async () => {
    const fetchMock = routed(ok(["h1"]));
    vi.stubGlobal("fetch", fetchMock);
    let n = 0;
    const sign = async (payload: string) => { if (n++ === 1) throw new RelayError("declined", 0, null); return item(payload); };
    await expect(signAndRelay({ sign, ctx, signerId: signer, shownFee: 15_000n, actions: [{ to: "m", amount: 1n, msg: "register" }, { to: "m", amount: 1n, msg: "buy:1:yes:1" }] })).rejects.toThrow("declined");
    expect(posts(fetchMock)).toHaveLength(0);
  });
  it("sends nothing when the first signature is about to expire by the time the second is signed", async () => {
    const fetchMock = routed(ok(["h1", "h2"]));
    vi.stubGlobal("fetch", fetchMock);
    let t = 1_000_000;
    const sign = async (payload: string) => { t += PAYLOAD_LIFETIME_MS - 10_000; return item(payload); };
    await expect(signAndRelay({ sign, ctx, signerId: signer, shownFee: 15_000n, now: () => t, actions: [{ to: "m", amount: 1n, msg: "register" }, { to: "m", amount: 1n, msg: "buy:1:yes:1" }] }))
      .rejects.toThrow(/took too long/);
    expect(posts(fetchMock)).toHaveLength(0);
  });
  it("asks the wallet once when the same action is started twice at the same moment", async () => {
    vi.stubGlobal("fetch", routed(ok(["h1"])));
    let prompts = 0;
    const sign = async (payload: string) => { prompts++; await new Promise(r => setTimeout(r, 5)); return item(payload); };
    const input = { sign, ctx, signerId: signer, shownFee: 15_000n, actions: [{ to: "m", amount: 1n, msg: "buy:1:yes:1" }] };
    const results = await Promise.allSettled([signAndRelay(input), signAndRelay(input)]);
    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(prompts).toBe(1);
  });
});

describe("the fee the wallet signs", () => {
  const ctx = { verifier: "intents.near", collateral: "nep141:usdc.near", relayer: "relayer.near" };
  const sign = async (payload: string) => item(payload);
  const input = { ctx, signerId: "0xabc0000000000000000000000000000000000001", actions: [{ to: "m", amount: 1n, msg: "buy:1:yes:1" }] };
  const quoting = (fee: string) => routed(ok(["h1"]), () => new Response(JSON.stringify({ fee, validUntil: QUOTE.validUntil })));
  it("refuses to ask the wallet when the fee rose more than a quarter above the one shown, and says the new fee", async () => {
    vi.stubGlobal("fetch", quoting("60000"));
    const asked: string[] = [];
    const error = await signAndRelay({ ...input, shownFee: 15_000n, sign: async p => { asked.push(p); return item(p); } }).catch(e => e);
    expect(asked).toHaveLength(0);
    expect(String(error.message)).toMatch(/fee is now/);
  });
  it("signs when the fee rose by no more than a quarter", async () => {
    const mock = quoting("18750");
    vi.stubGlobal("fetch", mock);
    await signAndRelay({ ...input, shownFee: 15_000n, sign });
    expect(posts(mock)).toHaveLength(1);
  });
  it("refuses a quote above the ceiling before anything is shown or signed", async () => {
    vi.stubGlobal("fetch", quoting("1" + "0".repeat(30)));
    await expect(fetchRelayFee()).rejects.toThrow(/network fee/);
    await expect(signAndRelay({ ...input, shownFee: 15_000n, sign })).rejects.toThrow(/network fee/);
  });
});

describe("hardened relay error codes", () => {
  const fail = async (status: number, error: Record<string, unknown>) => {
    vi.stubGlobal("fetch", reply(status, { error: { requestId: "r", ...error } }));
    return await relaySigned([item("a")]).catch(e => e) as RelayError;
  };

  it("explains a repeated item", async () => {
    expect((await fail(400, { code: "duplicate_item" })).message).toMatch(/same signed action twice/);
  });
  it("says a paused wallet is paused for an hour", async () => {
    const error = await fail(403, { code: "signer_suspended" });
    expect(error.message).toMatch(/paused for an hour/);
    expect(error.unknown).toBe(true);
  });
  it("retains a reported failure's hash and waits for chain evidence", async () => {
    const error = await fail(422, { code: "execution_failed", hash: "H1", index: 0 });
    expect(error.message).toMatch(/needs confirmation/);
    expect(error.message).not.toMatch(/Nothing was spent/);
    expect(error.message).not.toMatch(/fee was still paid/);
    expect(error.hash).toBe("H1");
    expect(error.unknown).toBe(true);
  });
  it("treats an undelivered action, an rpc disagreement and an unconfirmed transaction as unknown outcomes that carry a hash", async () => {
    for (const code of ["action_not_delivered", "rpc_disagreement", "transaction_not_final"]) {
      const error = await fail(502, { code, hash: "H2", index: 1, completed: ["H1"] });
      expect(error.unknown, code).toBe(true);
      expect(error.hash, code).toBe("H2");
      expect(error.completed, code).toEqual(["H1"]);
      expect(error.index, code).toBe(1);
      expect(error.message, code).toMatch(/needs confirmation/);
    }
  });
  it("explains a shared relay key as the service being unavailable", async () => {
    const error = await fail(503, { code: "relay_key_shared" });
    expect(error.message).toMatch(/busy or unavailable/);
    expect(error.unknown).toBe(true);
  });
  it("requires recovery after a bad signature, payload, nonce or deadline response", async () => {
    for (const code of ["invalid_signature", "invalid_payload", "invalid_nonce", "invalid_deadline"]) {
      const error = await fail(400, { code, index: 0 });
      expect(error.message, code).toMatch(/Check again/);
      expect(error.message, code).not.toMatch(/\(400\)/);
      expect(error.unknown, code).toBe(true);
    }
    expect((await fail(400, { code: "invalid_deadline", index: 0 })).message).toMatch(/expired/);
  });
  it("treats a code it does not know as an unknown outcome, never as nothing spent", async () => {
    const error = await fail(400, { code: "invalid_min_gas", index: 0 });
    expect(error.unknown).toBe(true);
    expect(error.message).not.toMatch(/Nothing was spent/);
  });
  it("treats a server error with an unlisted code or no JSON body as an unknown outcome", async () => {
    for (const make of [() => reply(503, { error: { code: "relay_unavailable" } }), () => reply(502, null), () => vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 504 }))]) {
      vi.stubGlobal("fetch", make());
      const error = await relaySigned([item("a")]).catch(e => e) as RelayError;
      expect(error.unknown).toBe(true);
      expect(error.message).not.toMatch(/Nothing was spent/);
    }
  });
  it("keeps the plain copy for a known refusal that carries a server status", async () => {
    const error = await fail(503, { code: "relay_busy" });
    expect(error.unknown).toBe(true);
    expect(error.message).not.toMatch(/Nothing was spent/);
  });
  it("marks a dropped connection and a timeout as unknown with no hash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const error = await relaySigned([item("a")]).catch(e => e) as RelayError;
    expect(error.unknown).toBe(true);
    expect(error.hash).toBeNull();
    expect(error.completed).toEqual([]);
  });
});

describe("retrying without signing again", () => {
  const ctx = { verifier: "intents.near", collateral: "nep141:usdc.near", relayer: "relayer.near" };
  const signer = "0xabc0000000000000000000000000000000000001";
  const actions = [{ to: "market.near", amount: 1n, msg: "register" }, { to: "market.near", amount: 2n, msg: "buy:1:yes:1" }];

  it("attaches the signed payloads to an unknown outcome so the same bytes can be sent again", async () => {
    let attempt = 0;
    const fetchMock = routed(() => { if (attempt++ === 0) throw new TypeError("fetch failed"); return new Response(JSON.stringify({ hashes: ["h1", "h2"] })); });
    vi.stubGlobal("fetch", fetchMock);
    let prompts = 0;
    const error = await signAndRelay({ sign: async payload => { prompts++; return item(payload); }, ctx, signerId: signer, shownFee: 15_000n, actions }).catch(e => e) as RelayError;
    expect(error.attempt?.signed).toHaveLength(2);
    expect(error.attempt?.items.map(i => i.target)).toEqual(["market.near", "market.near"]);
    const again = await resubmit(error.attempt!);
    expect(again.hashes).toEqual(["h1", "h2"]);
    expect(again.items).toBe(error.attempt!.items);
    const [first, second] = posts(fetchMock);
    expect(second![1].body).toBe(first![1].body);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/intents/fee"))).toHaveLength(1);
    expect(prompts).toBe(2);
  });
  it("attaches the attempt to a known failure too, and to a resubmit that fails", async () => {
    vi.stubGlobal("fetch", routed(() => new Response(JSON.stringify({ error: { code: "simulation_failed", index: 0 } }), { status: 422 })));
    const error = await signAndRelay({ sign: async payload => item(payload), ctx, signerId: signer, shownFee: 15_000n, actions: [actions[0]] }).catch(e => e) as RelayError;
    expect(error.attempt).toBeDefined();
    const second = await resubmit(error.attempt!).catch(e => e) as RelayError;
    expect(second.attempt).toBe(error.attempt);
  });
});
