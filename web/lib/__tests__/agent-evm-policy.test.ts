import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, recoverPublicKey, type Hex } from "viem";

vi.mock("../config", () => ({ config: { backendUrl: "https://api.example.com", network: "mainnet",
  agentApiHost: "agents.example.com", agentWalletContract: "wallets.example.near", verifierId: "intents.near",
  collateralTokenId: "nep141:usdc.example.near", tokenId: "", marketId: "", oracleId: "", councilId: "", nftId: "" } }));

import { safeToSign, signAndFollow, signIntent, type OwnerIntent } from "../agents";
import { evmAuthorityAccount, evmPolicyRequest } from "../agent-evm-policy";
import type { EvmConnection, EvmOwnerSigner } from "../agent-evm-consent";
import { policyArgs, policyFixture, policyOwner, policyWallet } from "./evm-policy-fixture";

const connection = { address: policyWallet.address, chainId: 8453 };
const signer = () => ({ type: "evm" as const,
  getIdentity: vi.fn<() => Promise<EvmConnection | null>>().mockResolvedValue(connection),
  signTypedData: vi.fn<EvmOwnerSigner["signTypedData"]>(payload => policyWallet.signTypedData(payload)),
});
const forbidden = async (g: OwnerIntent) => {
  const s = signer();
  expect(safeToSign(g)).toBe(false);
  await expect(signIntent(g, s)).rejects.toThrow(/stopped/);
  expect(s.signTypedData).not.toHaveBeenCalled();
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("EVM policy signing", () => {
  it.each(["agent_create", "agent_freeze", "agent_unfreeze"] as const)("signs the exact %s wallet request", async type => {
    const { generated, approval, payload } = policyFixture(type), s = signer();
    expect(evmAuthorityAccount(policyOwner.public_key)).toBe("0sd6fd8ebcac51e9b978ae03b01f89037bb30dd5d8");
    expect(safeToSign(generated)).toBe(true);
    const typed = evmPolicyRequest(generated, approval.walletContract, approval)!;
    expect(typed).toEqual(payload);
    const signed = await signIntent(generated, s);
    expect(signed.payload).toEqual(payload);
    const key = await recoverPublicKey({ hash: hashTypedData(typed), signature: signed.signature as Hex });
    expect(`0x${key.slice(4)}`).toBe(policyOwner.public_key);
    expect(s.getIdentity).toHaveBeenCalledTimes(3);
  });

  it("refuses missing or changed custody, revision, policy and storage-refund approval", async () => {
    const { generated } = policyFixture();
    const missing = structuredClone(generated);
    delete missing.policy_approval;
    await forbidden(missing);
    for (const patch of [{ walletAccount: "b".repeat(64) }, { tenantId: "another-tenant" }, { revision: 3 },
      { walletContract: "intents.near" }, { storageRefundTo: "mallory.near" }, { policy: { frozen: true } }]) {
      const bad = structuredClone(generated);
      Object.assign(bad.policy_approval!, patch);
      await forbidden(bad);
    }
    for (const patch of [{ revision: 2 }, { previous_revision: 1 }, { policy_hash: "a".repeat(64) },
      { policy: { frozen: false, actions: ["transfer"] } }]) {
      const bad = structuredClone(generated);
      Object.assign(bad.preview, patch);
      await forbidden(bad);
    }
  });

  it("rejects transfers, hidden calls, callbacks and extra receivers before a wallet prompt", async () => {
    const { generated, out, actions, message } = policyFixture("agent_freeze");
    const variants = [
      { ...out, after: [{}] }, { ...out, then: [...out.then, ...out.then] }, { ...out, hidden: true },
      { ...out, then: [{ receiver_id: "intents.near", actions }] },
      { ...out, then: [{ ...out.then[0], actions: [...actions, { action: "transfer", amount: "1" }] }] },
    ];
    for (const patch of [{ function_name: "execute" }, { min_gas: "100000000000001" },
      { deposit: "1000000000000000000000001" }, { deposit: "01" }, { args: "not base64" }, { gas: "1" }]) {
      variants.push({ ...out, then: [{ ...out.then[0]!, actions: [{ ...actions[0], ...patch }, actions[1]!] }] });
    }
    for (const altered of variants) {
      const bad = structuredClone(generated);
      bad.intent.payload.message = { ...message, out: JSON.stringify(altered) };
      await forbidden(bad);
    }
  });

  it("rejects changed policy arguments and extra powers on a freeze call", async () => {
    const { generated, out, message, args } = policyFixture("agent_freeze");
    for (const patch of [{ wallet_pubkey: `ed25519:${"b".repeat(64)}` }, { locked: true },
      { agent_policy_hash: "a".repeat(64) }, { storage_refund_to: "mallory.near" },
      { version: 0 }, { valid_until: 1 }, { encrypted_data: "" }, { wallet_signature: "invalid" }]) {
      const altered = structuredClone(out);
      altered.then[0]!.actions[0]!.args = policyArgs({ ...args, ...patch });
      const bad = structuredClone(generated);
      bad.intent.payload.message = { ...message, out: JSON.stringify(altered) };
      await forbidden(bad);
    }
    for (const patch of [{ deposit: "1" }, { function_name: "unfreeze_wallet" },
      { args: policyArgs({ wallet_pubkey: args.wallet_pubkey, recipient: "mallory.near" }) }]) {
      const altered = structuredClone(out);
      Object.assign(altered.then[0]!.actions[1]!, patch);
      const bad = structuredClone(generated);
      bad.intent.payload.message = { ...message, out: JSON.stringify(altered) };
      await forbidden(bad);
    }
  });

  it("rejects altered domains, signed networks, nonce encoding and signing windows", async () => {
    const { generated, message, payload } = policyFixture();
    for (const patch of [{ chainId: "testnet" }, { signerId: policyOwner.address }, { nonce: "123" },
      { nonce: -1 }, { nonce: 0x100000000 }, { timeoutSecs: 601 }, { timeoutSecs: 0 }, { ops: "[{}]" },
      { createdAt: new Date(Date.now() + 120000).toISOString() }, { createdAt: "invalid" },
      { out: ` ${message.out}` }, { out: message.out.replace("{", '{"after":["hidden"],') }]) {
      const bad = structuredClone(generated);
      bad.intent.payload.message = { ...message, ...patch };
      await forbidden(bad);
    }
    for (const patch of [{ domain: { ...payload.domain, chainId: 8453 } }, { primaryType: "Authorization" },
      { types: { ...payload.types, WalletMessage: [...payload.types.WalletMessage].reverse() } }]) {
      const bad = structuredClone(generated);
      Object.assign(bad.intent.payload, patch);
      await forbidden(bad);
    }
  });

  it.each(["disconnect", "account", "chain", "expiry"])("stops after %s changes during signing", async change => {
    const { generated } = policyFixture();
    const s = signer();
    s.signTypedData.mockImplementation(async payload => {
      const signature = await policyWallet.signTypedData(payload);
      if (change === "disconnect") s.getIdentity.mockResolvedValue(null);
      if (change === "account") s.getIdentity.mockResolvedValue({ ...connection, address: "0x" + "f".repeat(40) });
      if (change === "chain") s.getIdentity.mockResolvedValue({ ...connection, chainId: 1 });
      if (change === "expiry") { vi.useFakeTimers(); vi.setSystemTime(Date.parse(generated.expires_at)); }
      return signature;
    });
    await expect(signIntent(generated, s)).rejects.toThrow(/changed|expired/);
  });

  it("rejects a valid signature from another key", async () => {
    const { generated } = policyFixture(), s = signer();
    const other = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
    s.signTypedData.mockImplementation(payload => other.signTypedData(payload));
    await expect(signIntent(generated, s)).rejects.toThrow(/different account or key/);
  });

  it("submits the captured request and proof even if UI objects change while the wallet is open", async () => {
    const { generated } = policyFixture("agent_freeze"), original = structuredClone(generated), s = signer();
    s.signTypedData.mockImplementation(async payload => {
      const signature = await policyWallet.signTypedData(payload);
      generated.correlation_id = "intent_other";
      generated.policy_approval!.policy = { frozen: false };
      payload.message = { malicious: true };
      return signature;
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ correlation_id: original.correlation_id,
      status: "SUCCESS", failure_code: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await signAndFollow(generated, s)).status).toBe("SUCCESS");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/agent-intents/intent_policy");
    const signed = JSON.parse(String(init.body)).signed_data;
    expect(Object.keys(signed).sort()).toEqual(["payload", "signature", "standard"]);
    expect(signed.payload).toEqual(original.intent.payload);
  });
});
