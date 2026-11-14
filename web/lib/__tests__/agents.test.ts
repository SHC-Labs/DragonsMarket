import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    backendUrl: "https://api.example.com", verifierId: "intents.near", collateralTokenId: "nep141:usdc.example.near",
    tokenId: "", marketId: "market.example.near", oracleId: "oracle.example.near", councilId: "", nftId: "",
    agentWalletContract: "wallets.example.near", agentApiHost: "agents.example.com",
    network: "mainnet",
  },
}));

import {
  agentClaimable, agentError, agentsSetup, createAgent, depositedFor, freezeAgent, heldPositions, openMarkets,
  outcomeOf, refusalMessage, requestAccess, revokeGrants, roundWait, runAction, safeToSign, signAccess, signAndFollow,
  signIntent, stakeBlock, type AccessRequest, type OwnerIntent, type OwnerSigner,
} from "../agents";
import { BackendError } from "../backend";
import { nearPolicyFixture } from "./near-policy-fixture";

const nonce = Buffer.alloc(32, 7).toString("base64");
const identity = { type: "near" as const, account_id: "alice.near", public_key: "ed25519:key" };
const intent = (standard: string, payload: Record<string, unknown>): OwnerIntent => ({
  ...(standard === "nep366" ? nearPolicyFixture().generated : {}),
  correlation_id: "intent_1", type: standard === "nep413" ? "grant_issue" : "agent_create",
  agent_id: "a".repeat(64), status: "PENDING_SIGNATURE",
  expires_at: new Date(Date.now() + 550000).toISOString(), signer: identity,
  intent: { standard, payload },
  preview: standard === "nep366" ? nearPolicyFixture().generated.preview : { summary: "Create the agent" },
});
const call = (methodName: string, deposit = "0") =>
  ({ type: "FunctionCall", params: { methodName, args: nearPolicyFixture().args, gas: "1", deposit } });
const OVER_ONE_NEAR = "1000000000000000000000001", ONE_NEAR = "1000000000000000000000000";
const delegate = (extra: Record<string, unknown> = {}) =>
  ({ receiverId: "wallets.example.near", actions: [call("store_wallet_policy")], ...extra });
const canonical = (value: Record<string, unknown>): string => `{${Object.keys(value).sort().map(key =>
  `${JSON.stringify(key)}:${typeof value[key] === "object" && value[key] !== null
    ? canonical(value[key] as Record<string, unknown>) : JSON.stringify(value[key])}`).join(",")}}`;
const grantMessage = () => ({ domain: "near-intents-agent-api.agent-grant.v6", owner: identity,
  tenant_id: "tenant-1", agent_id: "a".repeat(64), network: "mainnet", issued_at_ms: Date.now(),
  expires_at_ms: Date.now() + 86400000, owner_epoch: 1, nonce: "07".repeat(32), recipient: "agents.example.com",
  label: "Dragons Market", credential: "b".repeat(64), wallet_id: "wallet-1" });
const message = (extra: Record<string, unknown> = {}) =>
  ({ message: canonical(grantMessage()), recipient: "agents.example.com", nonce, ...extra });
const signer = (): OwnerSigner & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    accountId: "alice.near",
    signMessage: async (p) => {
      calls.push(p);
      return { accountId: "alice.near", publicKey: "ed25519:key", signature: "c2ln" };
    },
    signDelegateActions: async (p) => {
      calls.push(p);
      return { signedDelegateActions: ["c2lnbmVk"] };
    },
  };
};
function replies(...bodies: [number, unknown][]) {
  const seen: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const [status, body] = bodies.shift()!;
    return new Response(JSON.stringify(body), { status });
  }));
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the owner signs what the Agent API prepared, unchanged", () => {
  it("signs a NEP-366 payload as a delegate action", async () => {
    const payload = delegate();
    const s = signer();
    expect(await signIntent(intent("nep366", payload), s))
      .toEqual({ standard: "nep366", payload, signed_delegate: "c2lnbmVk" });
    expect(s.calls).toEqual([{ delegateActions: [payload] }]);
  });

  it("signs a NEP-413 payload with its nonce as bytes", async () => {
    const payload = message();
    const s = signer();
    expect(await signIntent(intent("nep413", payload), s))
      .toEqual({ standard: "nep413", payload, public_key: "ed25519:key", signature: "c2ln" });
    const asked = s.calls[0] as { message: string; recipient: string; nonce: Uint8Array };
    expect([asked.message, asked.recipient, Array.from(asked.nonce)])
      .toEqual([payload.message, "agents.example.com", Array(32).fill(7)]);
  });

  it("refuses expired requests and another owner before opening the wallet", async () => {
    for (const patch of [{ expires_at: "invalid" }, { expires_at: new Date(0).toISOString() },
      { signer: { ...identity, account_id: "mallory.near" } }]) {
      const s = signer();
      await expect(signIntent({ ...intent("nep366", delegate()), ...patch }, s)).rejects.toThrow();
      expect(s.calls).toEqual([]);
    }
  });

  it("rejects a wallet that returns another account or owner key", async () => {
    for (const patch of [{ accountId: "mallory.near" }, { publicKey: "ed25519:other" }]) {
      const s = signer();
      s.signMessage = async () => ({ accountId: "alice.near", publicKey: identity.public_key,
        signature: "c2ln", ...patch });
      await expect(signIntent(intent("nep413", message()), s)).rejects.toThrow(/different account or key/);
    }
  });

  it("does not return signatures when the wallet prompt outlives its intent", async () => {
    vi.useFakeTimers();
    for (const standard of ["nep413", "nep366"]) {
      const generated = intent(standard, standard === "nep413" ? message() : delegate()), s = signer();
      s.signMessage = async () => {
        vi.setSystemTime(Date.now() + 600000);
        return { accountId: "alice.near", publicKey: identity.public_key, signature: "s" };
      };
      s.signDelegateActions = async () => {
        vi.setSystemTime(Date.now() + 600000);
        return { signedDelegateActions: ["signed"] };
      };
      await expect(signIntent(generated, s)).rejects.toThrow(/expired while signing/);
    }
  });
});

describe("canonical Agent API consent", () => {
  it("checks every authority field before a grant reaches the wallet", async () => {
    const patches = [{ owner: { ...identity, account_id: "mallory.near" } },
      { owner: { ...identity, public_key: "another-key" } }, { agent_id: "c".repeat(64) },
      { recipient: "intents.near" }, { network: "testnet" }, { nonce: "08".repeat(32) },
      { tenant_id: "" }, { owner_epoch: 0 }, { label: "Unrelated app" }, { credential: "bad" },
      { domain: "near-intents-agent-api.owner-change.v1" }, { wallet_id: "" },
      { issued_at_ms: Date.now() - 16 * 60000 }, { issued_at_ms: Date.now() + 120000 },
      { expires_at_ms: Date.now() + 91 * 86400000 }, { hidden_permission: "transfer" }];
    for (const patch of patches) {
      const s = signer(), payload = message({ message: canonical({ ...grantMessage(), ...patch }) });
      await expect(signIntent(intent("nep413", payload), s)).rejects.toThrow();
      expect(s.calls, JSON.stringify(patch)).toEqual([]);
    }
    for (const text of ["not json", "null", "[]", ` ${message().message}`,
      message().message.replace("{", '{"domain":"other",')]) {
      expect(safeToSign(intent("nep413", message({ message: text })))).toBe(false);
    }
  });

  it("accepts only grant revocation in the administration family", () => {
    const base = Object.fromEntries(Object.entries(grantMessage())
      .filter(([key]) => !["label", "credential", "wallet_id"].includes(key)));
    const value = { ...base, domain: "near-intents-agent-api.owner-admin.v2", action: "revoke_grant",
      target_id: "grant-1", expires_at_ms: Date.now() + 600000 };
    const generated = { ...intent("nep413", message({ message: canonical(value) })), type: "grant_revoke" as const };
    expect(safeToSign(generated)).toBe(true);
    for (const patch of [{ action: "delete_agent" }, { target_id: "" }, { hidden: true },
      { expires_at_ms: Date.now() + 86400000 }]) {
      expect(safeToSign({ ...generated, intent: { ...generated.intent,
        payload: message({ message: canonical({ ...value, ...patch }) }) } })).toBe(false);
    }
  });
});

describe("a request that could move the owner's funds never reaches the wallet", () => {
  const unsafe: [string, string, Record<string, unknown>][] = [
    ["a token transfer", "nep366", delegate({ actions: [call("ft_transfer")] })],
    ["a NEAR Intents transfer", "nep366", delegate({ actions: [call("mt_transfer")] })],
    ["an unrecognized wallet method", "nep366", delegate({ actions: [call("execute")] })],
    ["an unasked freeze", "nep366", delegate({ actions: [call("freeze_wallet")] })],
    ["a duplicate policy write", "nep366", delegate({ actions: [call("store_wallet_policy"), call("store_wallet_policy")] })],
    ["unbounded gas", "nep366", delegate({ actions: [{ ...call("store_wallet_policy"),
      params: { ...call("store_wallet_policy").params, gas: "300000000000001" } }] })],
    ["a call to NEAR Intents", "nep366", delegate({ receiverId: "intents.near" })],
    ["a call to the collateral token", "nep366", delegate({ receiverId: "usdc.example.near" })],
    ["a call to the market", "nep366", delegate({ receiverId: "market.example.near" })],
    ["a call to the rounds contract", "nep366", delegate({ receiverId: "rounds.example.near" })],
    ["a call to any other contract", "nep366", delegate({ receiverId: "swap.example.near" })],
    ["a message for any other site", "nep413", message({ recipient: "phish.example.com" })],
    ["an unasked wallet callback", "nep413", message({ callbackUrl: "https://phish.example.com" })],
    ["an unasked delegate sender", "nep366", delegate({ senderId: "mallory.near" })],
    ["a plain NEAR transfer", "nep366", delegate({ actions: [{ type: "Transfer", params: { deposit: "1" } }] })],
    ["more than 1 NEAR attached", "nep366", delegate({ actions: [call("store_wallet_policy", OVER_ONE_NEAR)] })],
    ["no actions", "nep366", delegate({ actions: [] })],
    ["a message NEAR Intents would execute", "nep413", message({ recipient: "intents.far" })],
    ["a message to the verifier", "nep413", message({ recipient: "intents.near" })],
    ["a malformed nonce", "nep413", message({ nonce: "AAAA" })],
    ["a standard this wallet does not sign", "eip712", delegate()],
  ];
  it.each(unsafe)("refuses %s", async (_why, standard, payload) => {
    expect(safeToSign(intent(standard, payload))).toBe(false);
    const s = signer();
    await expect(signIntent(intent(standard, payload), s)).rejects.toThrow(/could move your funds/);
    expect(s.calls).toEqual([]);
  });

  it("lets the owner flow's own requests through", () => {
    expect(safeToSign(intent("nep366", delegate({ actions: [call("store_wallet_policy", ONE_NEAR)] })))).toBe(true);
    expect(safeToSign(intent("nep413", message()))).toBe(true);
    for (const type of ["agent_freeze", "agent_unfreeze"] as const) {
      const { generated } = nearPolicyFixture(type);
      expect(safeToSign(generated)).toBe(true);
      expect(safeToSign({ ...generated, type: "agent_create" })).toBe(false);
      expect(safeToSign({ ...generated, type: type === "agent_freeze" ? "agent_unfreeze" : "agent_freeze" })).toBe(false);
    }
    expect(safeToSign({ ...intent("nep413", message()), type: "agent_create" })).toBe(false);
    expect(safeToSign({ ...intent("nep366", delegate()), type: "grant_revoke" })).toBe(false);
  });
});

describe("a stake the round would refuse is stopped before its money moves", () => {
  const rules = { minStake: 100_000n, maxOpen: 20, paused: false };
  it.each([
    ["paused rounds", { ...rules, paused: true }, 0, null, "up", 5_000_000n, /paused/],
    ["below the minimum", rules, 0, null, "up", 99_999n, /smallest stake is 0.10/],
    ["the other side of a held stake", rules, 1, { side: "down" }, "up", 5_000_000n, /other side/],
    ["the open stake limit", rules, 20, null, "up", 5_000_000n, /Claim a settled round/],
  ] as const)("refuses %s", (_why, r, open, held, side, amount, message) => {
    expect(stakeBlock(r, open, held, side, amount)).toMatch(message);
  });
  it("lets a stake the round takes through, including more on a side already held at the limit", () => {
    expect(stakeBlock(rules, 3, null, "up", 100_000n)).toBeNull();
    expect(stakeBlock(rules, 20, { side: "up" }, "up", 5_000_000n)).toBeNull();
  });
});

describe("a round says when it can take a stake", () => {
  const ms = (at: number) => String(BigInt(at) * 1_000_000n);
  it("says nothing while the round is open", () => {
    expect(roundWait(ms(1000), ms(9000), 5000)).toBeNull();
    expect(roundWait(ms(1000), ms(9000), 1000)).toBeNull();
  });
  it("counts down to a round that has not started, in seconds and then minutes", () => {
    expect(roundWait(ms(10_000), ms(90_000), 1000)).toBe("This round opens in 9 sec.");
    expect(roundWait(ms(200_000), ms(290_000), 1000)).toBe("This round opens in 4 min.");
  });
  it("does not offer a round that has closed", () => {
    expect(roundWait(ms(1000), ms(9000), 9000)).toMatch(/has closed/);
  });
});

describe("access for an AI agent takes the owner's wallet", () => {
  const origin = "https://dragons.example.com";
  const agent = "a".repeat(64);
  const asked = (): AccessRequest => {
    const id = "11111111-1111-4111-8111-111111111111", now = Date.now();
    const expires_at = new Date(now + 30 * 86400000).toISOString();
    const sign_before = new Date(now + 300000).toISOString();
    return { id, nonce, recipient: origin, expires_at, sign_before,
      terms: { agentId: agent, label: "Bot", maxSpend: "5000000", dailyLimit: "20000000" },
      message: ["Authorize a Dragons Market MCP connection (v1)", `Request: ${id}`, `Site: ${origin}`,
        "Network: mainnet", "Owner: alice.near", `Agent: ${agent}`, "Name: Bot",
        "Collateral: nep141:usdc.example.near", "Maximum per buy or stake (atomic units): 5000000",
        "Maximum per rolling 24 hours (atomic units): 20000000",
        "Allowed actions: stake, claim, buy, sell, redeem, withdraw, cash_out.",
        "Withdrawals return to the agent balance. Cash-out pays only the owner.",
        "This connection cannot change account policy, grant access or mint NFTs.",
        `Access expires: ${expires_at}`, `Sign before: ${sign_before}`].join("\n") };
  };

  it("asks for a request, signs its exact words and only then gets a token", async () => {
    const challenge = asked();
    const seen = replies([200, challenge], [200, { id: challenge.id, token: "dmk_token", label: "Bot" }]);
    const request = await requestAccess(agent, "Bot", "5000000", "20000000");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ label: "Bot", max_spend: "5000000", daily_limit: "20000000" });
    const s = signer();
    const issued = await signAccess(agent, request, s, origin);
    expect(issued.token).toBe("dmk_token");
    const signed = s.calls[0] as { message: string; recipient: string; nonce: Uint8Array };
    expect([signed.message, signed.recipient, Array.from(signed.nonce)])
      .toEqual([challenge.message, origin, Array(32).fill(7)]);
    expect(seen[1]!.url).toBe(`https://api.example.com/v1/agents/${agent}/access/${challenge.id}/sign`);
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ public_key: "ed25519:key", signature: "c2ln" });
  });

  it.each([
    ["another site", { recipient: "https://evil.example.com" }],
    ["other words", { message: "Sign in to Dragons Market" }],
  ])("stops a request for %s before the wallet", async (_why, bad) => {
    const s = signer();
    await expect(signAccess(agent, { ...asked(), ...bad }, s, origin)).rejects.toThrow(/did not match this site/);
    expect(s.calls).toEqual([]);
  });

  it("binds owner, agent, limits, tools, collateral, network and exact deadlines", async () => {
    const request = asked();
    const mutations: AccessRequest[] = [
      { ...request, id: "22222222-2222-4222-8222-222222222222" }, { ...request, nonce: "bad" },
      { ...request, terms: { ...request.terms, agentId: "b".repeat(64) } },
      { ...request, terms: { ...request.terms, label: "Another bot" } },
      { ...request, terms: { ...request.terms, maxSpend: "9000000" } },
      { ...request, terms: { ...request.terms, dailyLimit: "30000000" } },
      { ...request, sign_before: new Date(0).toISOString() },
      { ...request, sign_before: new Date(Date.now() + 600000).toISOString() },
      { ...request, expires_at: new Date(Date.now() + 31 * 86400000).toISOString() },
      ...[["Owner: alice.near", "Owner: mallory.near"], ["Network: mainnet", "Network: testnet"],
        ["nep141:usdc.example.near", "nep141:another.near"], ["cash_out.", "cash_out, leave."],
        ["5000000", "9000000"], ["20000000", "30000000"]].map(([before, after]) =>
        ({ ...request, message: request.message.replace(before!, after!) })),
      { ...request, message: `${request.message}\nAlso grant unlimited transfers.` },
    ];
    for (const bad of mutations) {
      const s = signer();
      await expect(signAccess(agent, bad, s, origin)).rejects.toThrow(/did not match this site/);
      expect(s.calls).toEqual([]);
    }
  });

  it("keeps the local form values even when a response claims wider limits", async () => {
    const request = asked();
    replies([200, { ...request, message: request.message.replace("5000000", "9000000"),
      terms: { ...request.terms, maxSpend: "9000000" } }]);
    const response = await requestAccess(agent, "Bot", "5000000", "20000000"), s = signer();
    await expect(signAccess(agent, response, s, origin)).rejects.toThrow();
    expect(s.calls).toEqual([]);
  });

  it("submits nothing if the wallet account changes or the prompt outlives the request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const request = asked(), s = signer();
    s.signMessage = async () => ({ accountId: "mallory.near", publicKey: identity.public_key, signature: "s" });
    await expect(signAccess(agent, request, s, origin)).rejects.toThrow(/different account/);
    s.signMessage = async () => {
      vi.setSystemTime(Date.now() + 300001);
      return { accountId: "alice.near", publicKey: identity.public_key, signature: "s" };
    };
    await expect(signAccess(agent, request, s, origin)).rejects.toThrow(/expired/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("the backend and its refusals", () => {
  it("reads the backend's error code and puts it in words", async () => {
    const seen = replies([409, { error: { code: "agent_limit_reached", requestId: "r" } }]);
    const refused = await createAgent("Trader").catch((e: unknown) => e);
    expect(seen.map((r) => [r.url, r.init.credentials])).toEqual([["https://api.example.com/v1/agents", "include"]]);
    expect(refused).toBeInstanceOf(BackendError);
    expect((refused as BackendError).code).toBe("agent_limit_reached");
    expect(agentError(refused)).toBe("You already have three agents.");
    expect(agentError(new BackendError("refused", 409, "policy_asset_denied")))
      .toBe("The request was refused (policy_asset_denied).");
  });

  it("asks for a signed request's status by POST, so the ask carries this site's origin", async () => {
    vi.useFakeTimers();
    const seen = replies([200, { correlation_id: "intent_1", status: "PROCESSING" }],
      [200, { correlation_id: "intent_1", status: "SUCCESS" }]);
    const done = signAndFollow(intent("nep413", message()), signer());
    await vi.advanceTimersByTimeAsync(3000);
    expect((await done).status).toBe("SUCCESS");
    expect(seen.map((r) => [r.url, r.init.method])).toEqual([
      ["https://api.example.com/v1/agent-intents/intent_1", "POST"],
      ["https://api.example.com/v1/agent-intents/intent_1/status", "POST"],
    ]);
  });

  it("stops Dragons Market and freezes or thaws the agent by POST", async () => {
    const agent = "a".repeat(64);
    const seen = replies([200, { data: [] }], [200, intent("nep366", delegate())], [200, intent("nep366", delegate())]);
    expect(await revokeGrants(agent)).toEqual([]);
    await freezeAgent(agent, true);
    await freezeAgent(agent, false);
    expect(seen.map((r) => [r.url.slice(r.url.lastIndexOf("/") + 1), r.init.method]))
      .toEqual([["revoke", "POST"], ["freeze", "POST"], ["unfreeze", "POST"]]);
  });

  it("offers agents only when the backend has them on", async () => {
    replies([200, { capabilities: { agents: false } }]);
    expect(await agentsSetup()).toBeNull();
    const deployment = { collateralTokenId: "nep141:usdc.example.near",
      contracts: { rounds: "rounds.example.near", market: "market.example.near" } };
    replies([200, { capabilities: { agents: true }, deployment }]);
    expect(await agentsSetup()).toEqual({ rounds: "rounds.example.near", market: "market.example.near",
      token: "usdc.example.near", cashOut: null, spend: null });
  });

  it("reads what a session may spend only when both limits are whole amounts", async () => {
    const deployment = { collateralTokenId: "nep141:usdc.example.near", contracts: {} };
    replies([200, { capabilities: { agents: true }, deployment,
      agentSpend: { perTransaction: "100000000", daily: "500000000" } }]);
    expect((await agentsSetup())?.spend).toEqual({ perTransaction: 100000000n, daily: 500000000n });
    replies([200, { capabilities: { agents: true }, deployment, agentSpend: { perTransaction: "1e9", daily: "5" } }]);
    expect((await agentsSetup())?.spend).toBeNull();
  });

  it("reads the cash out limits only when both are whole amounts", async () => {
    const deployment = { collateralTokenId: "nep141:usdc.example.near", contracts: {} };
    replies([200, { capabilities: { agents: true }, deployment,
      agentCashOut: { perTransaction: "100000000", daily: "500000000" } }]);
    expect((await agentsSetup())?.cashOut).toEqual({ perTransaction: 100000000n, daily: 500000000n });
    replies([200, { capabilities: { agents: true }, deployment, agentCashOut: { perTransaction: "1e9", daily: "5" } }]);
    expect((await agentsSetup())?.cashOut).toBeNull();
  });

  it("names a limit the agent's rules refused, and keeps the generic line for anything else", () => {
    expect(refusalMessage("policy_transaction_limit_exceeded")).toMatch(/at once/);
    expect(refusalMessage("policy_limit_exceeded")).toMatch(/24 hours/);
    expect(refusalMessage("wallet_frozen")).toMatch(/already sent may still settle/);
    expect(refusalMessage("policy_not_ready")).toMatch(/not applied and synchronized/);
    expect(refusalMessage("provider_policy_mismatch")).toMatch(/differs from the approved/);
    expect(refusalMessage("agent_authorization_stale")).toMatch(/no longer valid/);
    expect(refusalMessage("access_token_invalid")).toMatch(/expired or been revoked/);
    expect(refusalMessage("daily_limit_reached")).toMatch(/Unsettled trades stay reserved/);
    expect(refusalMessage("custody_native_balance_required")).toMatch(/more NEAR for gas/);
    expect(refusalMessage("toString")).toBeNull();
    expect(refusalMessage(undefined)).toBeNull();
  });

  it("reads what the agent can claim from the backend", async () => {
    const stake = { series: 0, round: "6", side: "up", amount: "5000000", outcome: "up" };
    const seen = replies([200, { data: [stake] }]);
    expect(await agentClaimable("a".repeat(64))).toEqual([stake]);
    expect(seen[0]!.url).toBe(`https://api.example.com/v1/agents/${"a".repeat(64)}/claimable`);
  });
});

describe("an agent action", () => {
  it("is asked again under the same key until it settles, so it is never sent twice", async () => {
    vi.useFakeTimers();
    const unsettled: [number, unknown] = [200, { operation: "o1", state: "unknown", evidence: null }];
    const seen = replies(unsettled, unsettled, [200, { operation: "o1", state: "confirmed", evidence: {} }]);
    const action = { kind: "cash_out", amount: "5" } as const;
    const done = runAction("a".repeat(64), "ui-key-0001", action);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await done).state).toBe("confirmed");
    expect(seen.map((r) => JSON.parse(String(r.init.body)))).toEqual(Array(3).fill({ key: "ui-key-0001", action }));
  });

  it("is asked again under the same key after an answer that may follow a send, never shown failed", async () => {
    vi.useFakeTimers();
    const action = { kind: "cash_out", amount: "5" } as const;
    const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(answer({ error: { code: "agent_api_unavailable" } }, 502))
      .mockResolvedValueOnce(answer({ error: { code: "operation_in_progress" } }, 409))
      .mockResolvedValueOnce(answer({ operation: "o1", state: "confirmed", evidence: {} }));
    vi.stubGlobal("fetch", fetch);
    const done = runAction("a".repeat(64), "ui-key-0002", action);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await done).state).toBe("confirmed");
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)).key)).toEqual(Array(4).fill("ui-key-0002"));
  });

  it("comes back unsettled, not failed, when the backend never answers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const done = runAction("a".repeat(64), "ui-key-0003", { kind: "cash_out", amount: "5" });
    await vi.advanceTimersByTimeAsync(120000);
    expect(outcomeOf((await done).state)).toBe("settling");
  });

  it("shows a refusal made before anything was sent at once", async () => {
    const seen = replies([400, { error: { code: "invalid_amount" } }]);
    await expect(runAction("a".repeat(64), "ui-key-0004", { kind: "cash_out", amount: "0" }))
      .rejects.toMatchObject({ code: "invalid_amount" });
    expect(seen).toHaveLength(1);
  });

  it("is reported failed only once it is settled as failed, and one stopped for a check says so", () => {
    expect(["confirmed", "failed", "reconcile", "unknown", "submitted", "prepared", "constructor"].map(outcomeOf))
      .toEqual(["done", "refused", "review", "settling", "settling", "settling", "settling"]);
    expect(agentError(new BackendError("refused", 409, "constructor"))).toBe("The request was refused (constructor).");
  });
});

describe("a funding transaction", () => {
  const agent = "b".repeat(64), rounds = "rounds.example.near";
  const deposit = (data: Record<string, unknown>) =>
    `EVENT_JSON:${JSON.stringify({ standard: "rounds", version: "1.0.0", event: "deposit", data })}`;
  const receipt = (executor: string, logs: string[], status: Record<string, unknown> = { SuccessValue: "" }) =>
    ({ outcome: { executor_id: executor, logs, status } });
  const chain = (receipts: unknown[]) => vi.fn(async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: "pm", result: { receipts_outcome: receipts } })));

  it("counts only a deposit rounds credited to the agent in a receipt that succeeded", async () => {
    vi.stubGlobal("fetch", chain([receipt(rounds, [deposit({ account: agent, amount: "5000000", from: "alice.near" })])]));
    expect(await depositedFor("tx1", "alice.near", rounds, agent)).toBe(5000000n);
    const market = "market.example.near";
    const inMarket = deposit({ account: agent, amount: "7" }).replace('"standard":"rounds"', '"standard":"market"');
    vi.stubGlobal("fetch", chain([receipt(market, [inMarket])]));
    expect(await depositedFor("tx1", "alice.near", market, agent, "market")).toBe(7n);
    expect(await depositedFor("tx1", "alice.near", rounds, agent, "market"), "the market's own receipt").toBeNull();
    vi.stubGlobal("fetch", chain([receipt(market, [deposit({ account: agent, amount: "7" })])]));
    expect(await depositedFor("tx1", "alice.near", market, agent, "market"), "the wrong standard").toBeNull();
    vi.stubGlobal("fetch", chain([receipt(rounds, [deposit({ account: agent, amount: "5000000", from: "alice.near" })])]));
    for (const receipts of [
      [receipt(rounds, [deposit({ account: agent, amount: "5000000" })], { Failure: {} })],
      [receipt("market.example.near", [deposit({ account: agent, amount: "5000000" })])],
      [receipt(rounds, [deposit({ account: "mallory.near", amount: "5000000" })])],
      [receipt(rounds, [deposit({ account: agent, amount: "-5" })])],
      [receipt(rounds, ["EVENT_JSON:{broken"])],
      [],
    ]) {
      vi.stubGlobal("fetch", chain(receipts));
      expect(await depositedFor("tx1", "alice.near", rounds, agent), JSON.stringify(receipts)).toBeNull();
    }
  });
});

describe("the desk reads markets from the contract the deployment names", () => {
  const market = "market.example.near";
  const answering = (table: Record<string, (args: Record<string, unknown>) => unknown>) => {
    const asked: { contract: string; method: string; args: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const { params } = JSON.parse(String(init.body));
      const args = JSON.parse(atob(params.args_base64)) as Record<string, unknown>;
      asked.push({ contract: params.account_id, method: params.method_name, args });
      const result = [...Buffer.from(JSON.stringify(table[params.method_name]!(args)))];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "pm", result: { result } }));
    }));
    return asked;
  };

  it("offers only the open markets among the newest fifty", async () => {
    const asked = answering({
      config: () => ({ markets: "120" }),
      list_markets: () => [{ id: "118", status: "open" }, { id: "119", status: "closed" }, { id: "70", status: "open" }],
    });
    expect((await openMarkets(market)).map((m) => m.id)).toEqual(["118", "70"]);
    expect(asked.map((a) => a.contract)).toEqual([market, market]);
    expect(asked[1]!.args).toEqual({ from_index: "70", limit: "50" });
    answering({ config: () => ({ markets: "3" }), list_markets: (args) => {
      expect(args.from_index).toBe("0");
      return [];
    } });
    expect(await openMarkets(market)).toEqual([]);
  });

  it("names each position, and says which market it is when the market is gone", async () => {
    const held = { yes: "5", no: "0", status: "open", redeemable: "0" };
    const asked = answering({
      get_positions: () => [{ ...held, market_id: "7" }, { ...held, market_id: "8" }],
      get_market: (args) => (args.market_id === "7" ? { title: "Will it rain?" } : null),
    });
    expect(await heldPositions(market, "agent.near")).toEqual([{ ...held, market_id: "7", title: "Will it rain?" },
      { ...held, market_id: "8", title: "Market 8" }]);
    expect(asked[0]!.args).toEqual({ account_id: "agent.near", limit: "100" });
  });
});
