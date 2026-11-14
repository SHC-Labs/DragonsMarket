import { privateKeyToAccount } from "viem/accounts";
import { sha256, stringToHex } from "viem";
import type { OwnerIntent } from "../agents";
import type { EvmPolicyApproval } from "../agent-evm-policy";
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).sort().map(key => `${JSON.stringify(key)}:${canonical(r[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const policyWallet = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
export const policyOwner = { type: "evm" as const, address: policyWallet.address.toLowerCase(), chain_id: 8453,
  public_key: `0x${policyWallet.publicKey.slice(4)}` };
export const policyHash = (value: unknown) => sha256(stringToHex(canonical(value))).slice(2);
export const policyArgs = (value: unknown) => btoa(JSON.stringify(value));

export function policyFixture(type: "agent_create" | "agent_freeze" | "agent_unfreeze" = "agent_create",
  now = Date.now()) {
  now = Math.floor(now / 1000) * 1000;
  const approval: EvmPolicyApproval = { tenantId: "tenant-test", walletContract: "wallets.example.near",
    walletAccount: "d".repeat(64), revision: type === "agent_create" ? 1 : 2,
    policy: { frozen: type === "agent_freeze", actions: ["withdraw"], confidential: false },
    storageRefundTo: type === "agent_create" ? "sponsor.example.near" : null };
  const agentId = "a".repeat(64);
  const args = { wallet_pubkey: `ed25519:${approval.walletAccount}`, encrypted_data: "AAECAw==",
    wallet_signature: "e".repeat(128), version: approval.revision, locked: false,
    valid_until: Math.floor(now / 1000) + 600,
    agent_policy_hash: policyHash({ domain: "near-intents-agent-api.policy.v1",
      tenantId: approval.tenantId, agentId, revision: approval.revision, policy: approval.policy }),
    ...(approval.storageRefundTo ? { storage_refund_to: approval.storageRefundTo } : {}) };
  const gas = type === "agent_create" ? "100000000000000" : "50000000000000";
  const actions: Record<string, unknown>[] = [{ action: "function_call", function_name: "store_wallet_policy",
    args: policyArgs(args), deposit: "10000000000000000000000", min_gas: gas }];
  if (type !== "agent_create") actions.push({ action: "function_call",
    function_name: type === "agent_freeze" ? "freeze_wallet" : "unfreeze_wallet",
    args: policyArgs({ wallet_pubkey: args.wallet_pubkey }), deposit: "0", min_gas: gas });
  const out = { after: [], then: [{ receiver_id: approval.walletContract, actions }] };
  const message = { chainId: "mainnet", signerId: "0sd6fd8ebcac51e9b978ae03b01f89037bb30dd5d8",
    nonce: 123, createdAt: new Date(now - 30000).toISOString().replace(".000Z", "Z"), timeoutSecs: 600,
    ops: "[]", out: JSON.stringify(out) };
  const payload = { domain: { name: "NEAR Wallet Contract", version: "1" }, primaryType: "WalletMessage",
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }],
      WalletMessage: [
        { name: "chainId", type: "string" }, { name: "signerId", type: "string" },
        { name: "nonce", type: "uint32" }, { name: "createdAt", type: "string" },
        { name: "timeoutSecs", type: "uint32" }, { name: "ops", type: "string" }, { name: "out", type: "string" },
      ],
    }, message };
  const generated: OwnerIntent = { correlation_id: "intent_policy", type, agent_id: agentId, signer: policyOwner,
    status: "PENDING_SIGNATURE", expires_at: new Date(now + 560000).toISOString(),
    intent: { standard: "eip712", payload },
    preview: { summary: "Agent policy", revision: approval.revision, previous_revision: approval.revision - 1,
      policy_hash: policyHash(approval.policy), policy: structuredClone(approval.policy) },
    policy_approval: structuredClone(approval) };
  return { generated, approval, payload, message, out, actions, args };
}
