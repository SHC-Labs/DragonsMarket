import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../config", () => ({ config: { network: "mainnet", verifierId: "intents.near",
  tokenId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  collateralTokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  tokenDecimals: 6 } }));
vi.mock("@defuse-protocol/one-click-sdk-typescript", () => ({ verifyQuoteSignature: () => true }));
vi.mock("../market", () => ({ tokenBalance: vi.fn(async () => "10000000") }));
vi.mock("../rpc", () => ({ view: vi.fn(async () => true) }));
import { crossChainCashOutKey, recoverCrossChainCashOut, sendCrossChainCashOut } from "../cross-chain-cash-out";
import { view } from "../rpc";
import { tokenBalance } from "../market";
import { identity, now, payload, quote, sign, status, intentHash, refundDeadline } from "./cross-chain-fixture";

let records: Map<string, string>;
let state: ReturnType<typeof status>;
let posts: string[];
const key = crossChainCashOutKey(identity.account);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  records = new Map(); state = status("PENDING_DEPOSIT"); posts = [];
  vi.mocked(view).mockResolvedValue(true);
  vi.mocked(tokenBalance).mockResolvedValue("10000000");
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("navigator", { locks: { request: (_key: string, _options: unknown, run: (lock: object) => unknown) => run({}) } });
  vi.stubGlobal("localStorage", { getItem: (k: string) => records.get(k) ?? null,
    setItem: (k: string, v: string) => { records.set(k, v); }, removeItem: (k: string) => { records.delete(k); } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store"); expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.endsWith("/generate-intent")) return Response.json({ intent: { standard: "erc191", payload: payload() } });
    if (url.endsWith("/submit-intent")) {
      const sent = JSON.parse(String(init.body));
      expect(JSON.parse(records.get(key)!).signed).toEqual(sent.signedData);
      posts.push(String(init.body));
      return Response.json({ intentHash });
    }
    return Response.json(state);
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("cash-out persistence and recovery", () => {
  it("retains signed bytes before submission and never signs a duplicate", async () => {
    const signer = vi.fn(sign);
    await sendCrossChainCashOut(quote(), signer, localStorage);
    expect(signer).toHaveBeenCalledTimes(1);
    expect(JSON.parse(records.get(key)!).intentHash).toBe(intentHash);
    await expect(sendCrossChainCashOut(quote(), signer, localStorage)).rejects.toThrow(/previous withdrawal/);
    await recoverCrossChainCashOut(identity, localStorage, "retry");
    expect(posts).toHaveLength(2); expect(posts[1]).toBe(posts[0]);
    expect(signer).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost submit reply using exactly the persisted signature", async () => {
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const result = await original(url, init);
      if (url.endsWith("/submit-intent")) throw new TypeError("reply lost");
      return result;
    }));
    await expect(sendCrossChainCashOut(quote(), sign, localStorage)).rejects.toThrow(/reply lost/);
    expect(JSON.parse(records.get(key)!).signed).not.toBeNull();
    vi.stubGlobal("fetch", original);
    await recoverCrossChainCashOut(identity, localStorage, "retry");
    expect(posts[1]).toBe(posts[0]);
  });
  it("clears an interrupted unsigned request only under the shared signing lock", async () => {
    const signer = vi.fn(async () => { throw new Error("declined"); });
    await expect(sendCrossChainCashOut(quote(), signer, localStorage)).rejects.toThrow(/declined/);
    expect(posts).toHaveLength(0);
    vi.stubGlobal("navigator", { locks: { request: (_: string, _options: unknown, run: (lock: null) => unknown) => run(null) } });
    await expect(recoverCrossChainCashOut(identity, localStorage)).rejects.toThrow(/Another tab/);
    expect(records.has(key)).toBe(true);
    vi.stubGlobal("navigator", { locks: { request: (_: string, _options: unknown, run: (lock: object) => unknown) => run({}) } });
    expect(await recoverCrossChainCashOut(identity, localStorage)).toBeNull();
    expect(records.has(key)).toBe(false);
  });
  it("refuses signing when storage is unavailable, the balance is short, or Web Locks are missing", async () => {
    const signer = vi.fn(sign);
    const broken = { ...localStorage, setItem: () => { throw new Error("quota"); } };
    await expect(sendCrossChainCashOut(quote(), signer, broken)).rejects.toThrow(/quota/);
    vi.mocked(tokenBalance).mockResolvedValue("9999999");
    await expect(sendCrossChainCashOut(quote(), signer, localStorage)).rejects.toThrow(/balance/);
    vi.stubGlobal("navigator", {});
    await expect(sendCrossChainCashOut(quote(), signer, localStorage)).rejects.toThrow(/Web Locks/);
    expect(signer).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
  it("keeps signed requests when the provider refuses access or the response is oversized", async () => {
    const original = globalThis.fetch;
    for (const answer of [() => new Response("unauthorized", { status: 401 }), () => new Response(" ".repeat(128 * 1024 + 1))]) {
      records.clear();
      vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => url.endsWith("/submit-intent")
        ? Promise.resolve(answer()) : original(url, init)));
      await expect(sendCrossChainCashOut(quote(), sign, localStorage)).rejects.toThrow();
      expect(JSON.parse(records.get(key)!).signed).not.toBeNull();
    }
  });
  it("never retries after the refund deadline even though the signature lives longer", async () => {
    await sendCrossChainCashOut(quote(), sign, localStorage);
    vi.setSystemTime(Date.parse(refundDeadline));
    await expect(recoverCrossChainCashOut(identity, localStorage, "retry")).rejects.toThrow(/window has closed/);
    expect(posts).toHaveLength(1); expect(records.has(key)).toBe(true);
  });
  it("does not finalize from an API status or a nonce alone", async () => {
    await sendCrossChainCashOut(quote(), sign, localStorage);
    for (const name of ["PENDING_DEPOSIT", "PROCESSING", "INCOMPLETE_DEPOSIT", "FAILED"]) {
      state = status(name);
      expect((await recoverCrossChainCashOut(identity, localStorage, "finish"))?.terminal).toBe(false);
      expect(records.has(key)).toBe(true);
    }
    state = status(); vi.mocked(view).mockResolvedValue(false);
    expect((await recoverCrossChainCashOut(identity, localStorage, "finish"))?.terminal).toBe(false);
    expect(records.has(key)).toBe(true);
    vi.mocked(view).mockResolvedValue(true); state.swapDetails.destinationChainTxHashes = [];
    expect((await recoverCrossChainCashOut(identity, localStorage, "finish"))?.terminal).toBe(false);
    state = status(); state.swapDetails.amountOut = "1";
    expect((await recoverCrossChainCashOut(identity, localStorage, "finish"))?.terminal).toBe(false);
  });
  it("retains evidence and only then releases a completed withdrawal", async () => {
    await sendCrossChainCashOut(quote(), sign, localStorage);
    state = status();
    const result = await recoverCrossChainCashOut(identity, localStorage, "finish");
    expect(result?.terminal).toBe(true);
    expect(result?.destinationHashes).toEqual([state.swapDetails.destinationChainTxHashes[0].hash]);
    expect(records.has(key)).toBe(false);
    expect(JSON.parse(records.get(`${key}:last`)!).result.terminal).toBe(true);
    expect(posts).toHaveLength(1);
  });
  it("requires refund accounting and retains failures with unknown refunds", async () => {
    await sendCrossChainCashOut(quote(), sign, localStorage);
    state = status("REFUNDED"); state.swapDetails.depositedAmount = "1";
    expect((await recoverCrossChainCashOut(identity, localStorage, "finish"))?.terminal).toBe(false);
    state = status("REFUNDED"); state.swapDetails.refundedAmount = "1";
    expect((await recoverCrossChainCashOut(identity, localStorage, "finish"))?.terminal).toBe(false);
    state = status("REFUNDED");
    expect((await recoverCrossChainCashOut(identity, localStorage, "finish"))?.terminal).toBe(true);
  });
  it("rejects altered recovery state, mismatched quotes and unavailable chain reads", async () => {
    await sendCrossChainCashOut(quote(), sign, localStorage);
    const raw = records.get(key)!;
    records.set(key, raw.replace('"amount":"10000000"', '"amount":"10000001"'));
    await expect(recoverCrossChainCashOut(identity, localStorage)).rejects.toThrow();
    records.set(key, raw); state.quoteResponse.signature = "different quote";
    await expect(recoverCrossChainCashOut(identity, localStorage)).rejects.toThrow();
    state = status(); vi.mocked(view).mockRejectedValue(new Error("RPC unavailable"));
    await expect(recoverCrossChainCashOut(identity, localStorage, "finish")).rejects.toThrow(/RPC/);
    expect(records.get(key)).toBe(raw);
  });
  it("cannot clear a replacement record written while confirmation is running", async () => {
    await sendCrossChainCashOut(quote(), sign, localStorage);
    state = status();
    vi.mocked(view).mockImplementation(async () => { records.set(key, "replacement"); return true; });
    await expect(recoverCrossChainCashOut(identity, localStorage, "finish")).rejects.toThrow();
    expect(records.get(key)).toBe("replacement");
    expect(records.has(`${key}:last`)).toBe(false);
  });
  it("keeps the pending request if its settlement archive cannot be retained", async () => {
    await sendCrossChainCashOut(quote(), sign, localStorage);
    state = status();
    const broken = { ...localStorage, setItem: () => {} };
    await expect(recoverCrossChainCashOut(identity, broken, "finish")).rejects.toThrow();
    expect(records.has(key)).toBe(true);
  });
});
