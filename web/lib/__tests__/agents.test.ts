import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    backendUrl: "https://api.example.com", verifierId: "intents.near", collateralTokenId: "nep141:usdc.example.near",
    tokenId: "", marketId: "market.example.near", oracleId: "oracle.example.near", councilId: "", nftId: "",
  },
}));

import {
  agentClaimable, agentError, agentsSetup, createAgent, depositedFor, freezeAgent, heldPositions, openMarkets,
  outcomeOf, refusalMessage, requestAccess, revokeGrants, roundWait, runAction, safeToSign, signAccess, signAndFollow,
  signIntent, stakeBlock, type AccessRequest, type OwnerIntent, type OwnerSigner,
} from "../agents";
import { BackendError } from "../backend";

const nonce = Buffer.alloc(32, 7).toString("base64");
const intent = (standard: string, payload: Record<string, unknown>): OwnerIntent => ({
  correlation_id: "intent_1", type: "agent_create", agent_id: "a".repeat(64), status: "PENDING_SIGNATURE",
  expires_at: "2030-01-01T00:00:00.000Z", intent: { standard, payload }, preview: { summary: "Create the agent" },
});
const call = (methodName: string, deposit = "0") =>
  ({ type: "FunctionCall", params: { methodName, args: {}, gas: "1", deposit } });
const OVER_ONE_NEAR = "1000000000000000000000001", ONE_NEAR = "1000000000000000000000000";
const delegate = (extra: Record<string, unknown> = {}) =>
  ({ receiverId: "wallets.example.near", actions: [call("store_wallet_policy")], ...extra });
const message = (extra: Record<string, unknown> = {}) =>
  ({ message: "grant", recipient: "agents.example.com", nonce, ...extra });
const signer = (): OwnerSigner & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
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
      .toEqual(["grant", "agents.example.com", Array(32).fill(7)]);
  });
});

describe("a request that could move the owner's funds never reaches the wallet", () => {
  const unsafe: [string, string, Record<string, unknown>][] = [
    ["a token transfer", "nep366", delegate({ actions: [call("ft_transfer")] })],
    ["a NEAR Intents transfer", "nep366", delegate({ actions: [call("mt_transfer")] })],
    ["a call to NEAR Intents", "nep366", delegate({ receiverId: "intents.near" })],
    ["a call to the collateral token", "nep366", delegate({ receiverId: "usdc.example.near" })],
    ["a call to the market", "nep366", delegate({ receiverId: "market.example.near" })],
    ["a plain NEAR transfer", "nep366", delegate({ actions: [{ type: "Transfer", params: { deposit: "1" } }] })],
    ["more than 1 NEAR attached", "nep366", delegate({ actions: [call("store_wallet_policy", OVER_ONE_NEAR)] })],
    ["no actions", "nep366", delegate({ actions: [] })],
    ["a message NEAR Intents would execute", "nep413", message({ recipient: "intents.far" })],
    ["a message to the verifier", "nep413", message({ recipient: "intents.near" })],
    ["a malformed nonce", "nep413", message({ nonce: "AAAA" })],
    ["a standard this wallet does not sign", "eip712", delegate()],
  ];
  it.each(unsafe)("refuses %s", async (_why, standard, payload) => {
    expect(safeToSign(standard, payload)).toBe(false);
    const s = signer();
    await expect(signIntent(intent(standard, payload), s)).rejects.toThrow(/could move your funds/);
    expect(s.calls).toEqual([]);
  });

  it("lets the owner flow's own requests through", () => {
    expect(safeToSign("nep366", delegate({ actions: [call("store_wallet_policy", ONE_NEAR)] }))).toBe(true);
    expect(safeToSign("nep413", message())).toBe(true);
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
  const asked: AccessRequest = { id: "11111111-1111-4111-8111-111111111111", nonce, recipient: origin,
    message: "Give an AI agent access to a Dragons Market agent account\nMost for one stake: 5 nep141:usdc" };
  const agent = "a".repeat(64);

  it("asks for a request, signs its exact words and only then gets a token", async () => {
    const seen = replies([200, asked], [200, { id: asked.id, token: "dmk_token", label: "Bot" }]);
    const request = await requestAccess(agent, "Bot", "5000000", "20000000");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ label: "Bot", max_spend: "5000000", daily_limit: "20000000" });
    const s = signer();
    const issued = await signAccess(agent, request, s, origin);
    expect(issued.token).toBe("dmk_token");
    const signed = s.calls[0] as { message: string; recipient: string; nonce: Uint8Array };
    expect([signed.message, signed.recipient, Array.from(signed.nonce)])
      .toEqual([asked.message, origin, Array(32).fill(7)]);
    expect(seen[1]!.url).toBe(`https://api.example.com/v1/agents/${agent}/access/${asked.id}/sign`);
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ public_key: "ed25519:key", signature: "c2ln" });
  });

  it.each([
    ["another site", { ...asked, recipient: "https://evil.example.com" }],
    ["other words", { ...asked, message: "Sign in to Dragons Market" }],
  ])("stops a request for %s before the wallet", async (_why, bad) => {
    const s = signer();
    await expect(signAccess(agent, bad, s, origin)).rejects.toThrow(/did not match this site/);
    expect(s.calls).toEqual([]);
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
    expect(refusalMessage("wallet_frozen")).toMatch(/nothing moves until you unfreeze/);
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
