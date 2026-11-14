import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, recoverPublicKey, type Hex } from "viem";

vi.mock("../config", () => ({ config: { backendUrl: "https://api.example.com", network: "mainnet",
  agentApiHost: "agents.example.com", agentWalletContract: "wallets.example.near", verifierId: "intents.near",
  collateralTokenId: "nep141:usdc.example.near", tokenId: "", marketId: "", oracleId: "", councilId: "", nftId: "" } }));

import { safeToSign, signAndFollow, signIntent, type OwnerIntent } from "../agents";
import { evmConsent, type EvmOwnerSigner, type EvmConnection } from "../agent-evm-consent";

const wallet = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const owner = { type: "evm" as const, address: wallet.address.toLowerCase(), chain_id: 8453,
  public_key: `0x${wallet.publicKey.slice(4)}` };
const connection = { address: wallet.address, chainId: 8453 };
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const r = v as Record<string, unknown>;
    return `{${Object.keys(r).sort().map(key => `${JSON.stringify(key)}:${canonical(r[key])}`).join(",")}}`;
  }
  return JSON.stringify(v);
};

function example(type: "grant_issue" | "grant_revoke" = "grant_issue", now = Date.now()): OwnerIntent {
  const common = { owner, tenant_id: "tenant-1", agent_id: "a".repeat(64), network: "mainnet",
    issued_at_ms: now, owner_epoch: 1, nonce: "09".repeat(32), recipient: "agents.example.com" };
  const message = type === "grant_issue" ? { ...common, domain: "near-intents-agent-api.agent-grant.v6",
    wallet_id: "wallet-1", label: "Dragons Market", credential: "b".repeat(64), expires_at_ms: now + 86400000 }
    : { ...common, domain: "near-intents-agent-api.owner-admin.v2", action: "revoke_grant",
      target_id: "c".repeat(64), expires_at_ms: now + 300000 };
  return { correlation_id: "intent_evm", type, agent_id: common.agent_id, signer: owner,
    status: "PENDING_SIGNATURE", expires_at: new Date(now + 290000).toISOString(),
    intent: { standard: "eip712", payload: { domain: { name: "NEAR Wallet Contract", version: "1" },
      primaryType: "Authorization", types: {
        EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }],
        Authorization: [{ name: "purpose", type: "string" }, { name: "recipient", type: "string" },
          { name: "payload", type: "string" }],
      }, message: { purpose: "PROVE_OWNERSHIP", recipient: common.recipient, payload: canonical(message) } } },
    preview: { summary: "Authorize Dragons Market" } };
}

const signer = () => ({ type: "evm" as const,
  getIdentity: vi.fn<() => Promise<EvmConnection | null>>().mockResolvedValue(connection),
  signTypedData: vi.fn<EvmOwnerSigner["signTypedData"]>(payload => wallet.signTypedData(payload)),
});

function changed(generated: OwnerIntent, patch: Record<string, unknown>): OwnerIntent {
  const copy = structuredClone(generated);
  const message = copy.intent.payload.message as { payload: string };
  message.payload = canonical({ ...JSON.parse(message.payload), ...patch });
  return copy;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("EVM owner consent", () => {
  it.each(["grant_issue", "grant_revoke"] as const)("signs and verifies the exact %s proof", async type => {
    const generated = example(type), s = signer();
    expect(safeToSign(generated)).toBe(true);
    const signed = await signIntent(generated, s);
    expect(signed.standard).toBe("eip712");
    expect(signed.payload).toEqual(generated.intent.payload);
    expect(s.signTypedData).toHaveBeenCalledOnce();
    const payload = evmConsent(generated.intent.payload, "agents.example.com")!;
    const key = await recoverPublicKey({ hash: hashTypedData(payload), signature: signed.signature as Hex });
    expect(`0x${key.slice(4)}`).toBe(owner.public_key);
    expect(s.getIdentity).toHaveBeenCalledTimes(3);
  });

  it("refuses changed authority, permission, scope and lifetime before asking the wallet", async () => {
    for (const type of ["grant_issue", "grant_revoke"] as const) {
      const generated = example(type);
      for (const patch of [{ owner: { ...owner, chain_id: 1 } }, { owner: { ...owner, address: other.address } },
        { owner: { ...owner, public_key: `0x${other.publicKey.slice(4)}` } }, { owner_epoch: 0 },
        { tenant_id: "" }, { agent_id: "d".repeat(64) }, { network: "testnet" }, { recipient: "intents.near" },
        { nonce: "bad" }, { label: "Unlimited trader" }, { action: "delete_agent" },
        { issued_at_ms: Date.now() + 120000 }, { issued_at_ms: Date.now() - 960000 },
        { expires_at_ms: Date.now() - 1 }, { expires_at_ms: Date.now() + 366 * 86400000 },
        { domain: "near-intents-agent-api.owner-change.v1" }, { extra_power: "withdraw" }]) {
        const s = signer();
        await expect(signIntent(changed(generated, patch), s), JSON.stringify(patch)).rejects.toThrow(/stopped/);
        expect(s.signTypedData).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects ambiguous JSON, extra typed data and policy-changing signing families", async () => {
    const generated = example(), payload = generated.intent.payload;
    const message = payload.message as { purpose: string; recipient: string; payload: string };
    const badPayloads = [
      { ...payload, primaryType: "WalletMessage" },
      { ...payload, domain: { name: "NEAR Wallet Contract", version: "1", chainId: 8453 } },
      { ...payload, domain: { name: "NEAR Wallet Contract", version: "2" } },
      { ...payload, types: { ...payload.types as object, Extra: [{ name: "amount", type: "uint256" }] } },
      { ...payload, message: { ...message, purpose: "EXECUTE" } },
      { ...payload, message: { ...message, recipient: "intents.near" } },
      { ...payload, message: { ...message, spend: "unlimited" } },
      { ...payload, message: { ...message, payload: ` ${message.payload}` } },
      { ...payload, message: { ...message, payload: message.payload.replace("{", '{"owner_epoch":999,') } },
      { ...payload, message: { ...message, payload: "x".repeat(16385) } },
      { ...payload, callbackUrl: "https://phish.example.com" },
    ];
    for (const p of badPayloads) {
      const s = signer();
      await expect(signIntent({ ...generated, intent: { standard: "eip712", payload: p } }, s))
        .rejects.toThrow(/stopped/);
      expect(s.signTypedData).not.toHaveBeenCalled();
    }
    for (const type of ["agent_create", "agent_freeze", "agent_unfreeze"] as const) {
      expect(safeToSign({ ...generated, type })).toBe(false);
    }
    for (const standard of ["nep413", "nep366", "webauthn"]) {
      expect(safeToSign({ ...generated, intent: { standard, payload } })).toBe(false);
    }
  });

  it.each([
    { correlation_id: "intent_../other" }, { correlation_id: "intent_1/status?replace=true" },
    { agent_id: "not-an-agent" }, { status: "SUCCESS" }, { status: "PROCESSING" },
  ])("refuses a malformed or already submitted request before signing: %j", async patch => {
    const s = signer();
    await expect(signAndFollow({ ...example(), ...patch }, s)).rejects.toThrow(/stopped/);
    expect(s.signTypedData).not.toHaveBeenCalled();
  });

  it.each([null, { ...connection, address: other.address }, { ...connection, chainId: 1 }])(
    "stops a different connected identity before signing: %j", async identity => {
      const s = signer();
      s.getIdentity.mockResolvedValue(identity);
      await expect(signIntent(example(), s)).rejects.toThrow(/wallet or chain changed/);
      expect(s.signTypedData).not.toHaveBeenCalled();
    });

  it.each([null, { ...connection, address: other.address }, { ...connection, chainId: 1 }])(
    "submits nothing after the connected identity changes: %j", async identity => {
      const s = signer(), fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      s.getIdentity.mockResolvedValueOnce(connection).mockResolvedValue(identity);
      await expect(signAndFollow(example(), s)).rejects.toThrow(/wallet or chain changed/);
      expect(s.signTypedData).toHaveBeenCalledOnce();
      expect(fetcher).not.toHaveBeenCalled();
    });

  it("rejects signatures from another key, over altered bytes, or with malleable s", async () => {
    const generated = example(), typed = evmConsent(generated.intent.payload, "agents.example.com")!;
    const signature = await wallet.signTypedData(typed);
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = (order - BigInt(`0x${signature.slice(66, 130)}`)).toString(16).padStart(64, "0");
    const high = `${signature.slice(0, 66)}${highS}${signature.endsWith("1b") ? "1c" : "1b"}` as Hex;
    const bad = [await other.signTypedData(typed), high, "0x", `${signature.slice(0, -2)}02`,
      await wallet.signTypedData({ ...typed, message: { ...typed.message, recipient: "intents.near" } })];
    for (const signature of bad) {
      const s = signer(), fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      s.signTypedData.mockResolvedValue(signature as Hex);
      await expect(signAndFollow(generated, s)).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("rejects an expired wallet prompt without submission", async () => {
    vi.useFakeTimers();
    const generated = example(), s = signer(), fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    s.signTypedData.mockImplementation(async payload => {
      const result = await wallet.signTypedData(payload);
      vi.setSystemTime(Date.now() + 300000);
      return result;
    });
    await expect(signAndFollow(generated, s)).rejects.toThrow(/expired/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("snapshots the intent before the wallet opens and submits the unchanged SDK wire format", async () => {
    const generated = example(), original = structuredClone(generated), s = signer();
    s.signTypedData.mockImplementation(async payload => {
      const signature = await wallet.signTypedData(payload);
      generated.correlation_id = "intent_other";
      generated.signer = { ...owner, chain_id: 1 };
      payload.message.payload = "changed after signing";
      return signature;
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      correlation_id: original.correlation_id, status: "SUCCESS", failure_code: null,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await signAndFollow(generated, s)).status).toBe("SUCCESS");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/agent-intents/intent_evm");
    expect(init.credentials).toBe("include");
    const signed = JSON.parse(String(init.body)).signed_data;
    expect(Object.keys(signed).sort()).toEqual(["payload", "signature", "standard"]);
    expect(signed.payload).toEqual(original.intent.payload);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
