import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

async function load(url = "https://api.example") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", url);
  vi.stubEnv("NEXT_PUBLIC_MARKET_ID", "market.near");
  return import("../backend");
}

describe("backend client", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("does nothing without a backend URL", async () => {
    const backend = await load("");
    expect(backend.backendEnabled()).toBe(false);
    expect(await backend.currentSession()).toBeNull();
    await expect(backend.serverWatchlist()).rejects.toMatchObject({ code: "backend_disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signs the backend's challenge with the wallet and sends back the signature", async () => {
    const backend = await load();
    const nonce = Buffer.alloc(32, 7).toString("base64");
    vi.mocked(fetch)
      .mockResolvedValueOnce(reply(200, { id: "c1", accountId: "alice.near", message: "Sign in", nonce, recipient: "https://app.example", callbackUrl: "https://app.example", expiresAt: "x" }))
      .mockResolvedValueOnce(reply(200, { authenticated: true }))
      .mockResolvedValueOnce(reply(200, { session: { account_id: "alice.near" } }));
    const sign = vi.fn(async () => ({ accountId: "alice.near", publicKey: "ed25519:abc", signature: "sig" }));
    await backend.signIn("alice.near", sign);
    expect(sign).toHaveBeenCalledWith({ message: "Sign in", recipient: "https://app.example", callbackUrl: "https://app.example", nonce: new Uint8Array(32).fill(7) });
    const [path, init] = vi.mocked(fetch).mock.calls[1]!;
    expect(path).toBe("https://api.example/v1/auth/verify");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(init!.body))).toEqual({ id: "c1", publicKey: "ed25519:abc", signature: "sig" });
  });

  it("says so when the browser did not keep the sign-in cookie", async () => {
    const backend = await load();
    vi.mocked(fetch)
      .mockResolvedValueOnce(reply(200, { id: "c1", accountId: "alice.near", message: "m", nonce: "AA==", recipient: "r", callbackUrl: "r", expiresAt: "x" }))
      .mockResolvedValueOnce(reply(200, { authenticated: true }))
      .mockResolvedValueOnce(reply(200, { session: null }));
    await expect(backend.signIn("alice.near", async () => ({ accountId: "alice.near", publicKey: "k", signature: "s" }))).rejects.toMatchObject({ code: "session_not_kept" });
  });

  it("refuses a challenge or a signature for a different account", async () => {
    const backend = await load();
    vi.mocked(fetch).mockResolvedValueOnce(reply(200, { id: "c1", accountId: "mallory.near", message: "m", nonce: "AA==", recipient: "r", callbackUrl: "r", expiresAt: "x" }));
    await expect(backend.signIn("alice.near", vi.fn())).rejects.toMatchObject({ code: "account_mismatch" });
    vi.mocked(fetch).mockResolvedValueOnce(reply(200, { id: "c2", accountId: "alice.near", message: "m", nonce: "AA==", recipient: "r", callbackUrl: "r", expiresAt: "x" }));
    await expect(backend.signIn("alice.near", async () => ({ accountId: "bob.near", publicKey: "k", signature: "s" }))).rejects.toMatchObject({ code: "account_mismatch" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("asks the service to end every session and reports a failure", async () => {
    const backend = await load();
    vi.mocked(fetch).mockResolvedValueOnce(reply(200, { authenticated: false }));
    await backend.signOutEverywhere();
    const [path, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(path).toBe("https://api.example/v1/auth/logout-all");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    vi.mocked(fetch).mockResolvedValueOnce(reply(401, { error: { code: "session_required" } }));
    await expect(backend.signOutEverywhere()).rejects.toMatchObject({ status: 401, code: "session_required" });
  });

  it("keeps only this market's watched ids and stores them under the market contract", async () => {
    const backend = await load();
    vi.mocked(fetch).mockResolvedValueOnce(reply(200, { data: [{ item: "market.near/3" }, { item: "other.near/9" }, { item: "market.near/12" }] }));
    expect(await backend.serverWatchlist()).toEqual(["3", "12"]);
    vi.mocked(fetch).mockResolvedValueOnce(reply(200, { saved: true }));
    await backend.setServerWatch("5", true);
    const [, put] = vi.mocked(fetch).mock.calls[1]!;
    expect(put).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(put!.body))).toEqual({ item: "market.near/5" });
    vi.mocked(fetch).mockResolvedValueOnce(reply(200, { saved: true }));
    await backend.setServerWatch("5", false);
    expect(vi.mocked(fetch).mock.calls[2]![1]).toMatchObject({ method: "DELETE" });
  });

  it("reads a missing session as signed out and surfaces the error code of a refusal", async () => {
    const backend = await load();
    vi.mocked(fetch).mockResolvedValueOnce(reply(200, { session: null }));
    expect(await backend.currentSession()).toBeNull();
    vi.mocked(fetch).mockResolvedValueOnce(reply(401, { error: { code: "session_required" } }));
    await expect(backend.serverWatchlist()).rejects.toMatchObject({ status: 401, code: "session_required" });
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network"));
    await expect(backend.serverWatchlist()).rejects.toMatchObject({ code: "unreachable" });
  });

  it("lists only the signed-in account's pending settlements, with amounts read exactly", async () => {
    const backend = await load();
    vi.mocked(fetch).mockResolvedValueOnce(reply(200, { data: [
      { kind: "withdrawal", event: "withdraw", receipt_id: "r1", block_height: "10", payload: { account: "alice.near", amount: "9007199254740993" } },
      { kind: "withdrawal", event: "withdraw", receipt_id: "r2", block_height: "11", payload: { account: "bob.near", amount: "5" } },
      { kind: "claim", event: "claim_requested", receipt_id: "r3", block_height: "12", payload: { owner: "alice.near", amount: "bad" } },
    ] }));
    const found = await backend.pendingFor("alice.near");
    expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toBe("https://api.example/v1/settlements/pending?limit=100&account=alice.near");
    expect(found).toEqual([
      { kind: "withdrawal", event: "withdraw", receiptId: "r1", blockHeight: "10", amount: 9007199254740993n },
      { kind: "claim", event: "claim_requested", receiptId: "r3", blockHeight: "12", amount: null },
    ]);
  });
});
