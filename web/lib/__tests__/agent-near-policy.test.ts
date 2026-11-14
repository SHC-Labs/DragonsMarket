import { test, vi } from "vitest";
vi.mock("../config", () => ({ config: { network: "mainnet", agentWalletContract: "wallets.example.near",
  agentApiHost: "agents.example.com", verifierId: "intents.near", collateralTokenId: "nep141:usdc.near",
  tokenId: "", marketId: "", oracleId: "", councilId: "", nftId: "" } }));
import assert from "node:assert/strict";
import type { OwnerIntent } from "../agents";
import { safeToSign, signIntent } from "../agents";
import { nearPolicyFixture } from "./near-policy-fixture";

const accepts = (g: OwnerIntent) => safeToSign(g);

test("changed NEAR policy arguments are rejected before opening a wallet prompt", async () => {
  const signDelegateActions = vi.fn(async () => ({ signedDelegateActions: ["signed"] }));
  const signer = { accountId: "alice.near", signDelegateActions,
    signMessage: vi.fn(async () => ({ publicKey: "ed25519:key", signature: "signature" })) };
  for (const type of ["agent_create", "agent_freeze", "agent_unfreeze"] as const) {
    const { generated, actions } = nearPolicyFixture(type);
    actions[0]!.params.args.wallet_pubkey = `ed25519:${"f".repeat(64)}`;
    await assert.rejects(signIntent(generated, signer), /stopped this request/);
  }
  assert.equal(signDelegateActions.mock.calls.length, 0);
  const { generated } = nearPolicyFixture();
  const signed = await signIntent(generated, signer);
  assert.deepEqual(signed.payload, generated.intent.payload);
  assert.equal(signDelegateActions.mock.calls.length, 1);
});

test("NEAR create, freeze and unfreeze bind the exact custody wallet and policy while preserving JSON values", () => {
  for (const type of ["agent_create", "agent_freeze", "agent_unfreeze"] as const) {
    const { generated, actions, args } = nearPolicyFixture(type);
    assert.ok(accepts(generated), type);
    actions[0]!.params.args = Object.fromEntries(Object.entries(args).reverse());
    assert.ok(accepts(JSON.parse(JSON.stringify(generated))), "key order is not authority");
    actions[0]!.params.args.version = 12;
    assert.ok(accepts(generated), "provider document version is distinct from the account policy revision");
  }
});

test("NEAR policy storage refuses substituted custody, commitment, refunds and hidden arguments", () => {
  for (const type of ["agent_create", "agent_freeze", "agent_unfreeze"] as const) {
    const changes = [{ wallet_pubkey: `ed25519:${"f".repeat(64)}` }, { locked: true },
      { version: 0 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { valid_until: 1 }, { valid_until: "9999999999" },
      { encrypted_data: "" }, { encrypted_data: "AAEC Aw==" }, { encrypted_data: "A".repeat(32769) },
      { wallet_signature: "bad" }, { storage_refund_to: "mallory.near" },
      { agent_policy_hash: "f".repeat(64) }, { new_owner: "mallory.near" }];
    for (const patch of changes) {
      const { generated, actions } = nearPolicyFixture(type);
      Object.assign(actions[0]!.params.args, patch);
      assert.equal(accepts(generated), false, `${type}: ${Object.keys(patch)}`);
    }
    const { args } = nearPolicyFixture(type);
    for (const key of Object.keys(args).filter(k => k !== "storage_refund_to")) {
      const { generated, actions } = nearPolicyFixture(type);
      delete actions[0]!.params.args[key];
      assert.equal(accepts(generated), false, `missing ${key}`);
    }
  }
});

test("NEAR delegates refuse altered approvals, previews, expired requests and different signing families", () => {
  for (const type of ["agent_create", "agent_freeze", "agent_unfreeze"] as const) {
    for (const patch of [{ tenantId: "other-tenant" }, { walletAccount: "f".repeat(64) },
      { walletContract: "other.near" }, { revision: 0 }, { revision: 9 }, { policy: { frozen: false } },
      { storageRefundTo: "mallory.near" }]) {
      const { generated } = nearPolicyFixture(type);
      Object.assign(generated.policy_approval!, patch);
      assert.equal(accepts(generated), false);
    }
    for (const patch of [{ revision: 9 }, { previous_revision: 8 }, { policy_hash: "e".repeat(64) },
      { policy: { frozen: false } }]) {
      const { generated } = nearPolicyFixture(type);
      Object.assign(generated.preview, patch);
      assert.equal(accepts(generated), false);
    }
    const { generated } = nearPolicyFixture(type);
    for (const expires_at of ["invalid", new Date(0).toISOString(), new Date(Date.now() + 601000).toISOString()]) {
      assert.equal(accepts({ ...generated, expires_at }), false);
    }
    for (const standard of ["nep413", "eip712"]) {
      assert.equal(accepts({ ...generated, intent: { ...generated.intent, standard } }), false);
    }
    assert.equal(accepts({ ...generated, agent_id: "b".repeat(64) }), false);
    delete generated.policy_approval;
    assert.equal(accepts(generated), false, "old unbound requests need regeneration");
  }
});

test("NEAR transition calls cannot target another wallet, attach funds or add arguments", () => {
  for (const type of ["agent_freeze", "agent_unfreeze"] as const) {
    for (const patch of [{ args: { wallet_pubkey: `ed25519:${"f".repeat(64)}` } },
      { args: { wallet_pubkey: `ed25519:${"d".repeat(64)}`, owner: "mallory.near" } },
      { args: "{}" }, { deposit: "1" }, { methodName: "delete_wallet" },
      { methodName: type === "agent_freeze" ? "unfreeze_wallet" : "freeze_wallet" }]) {
      const { generated, actions } = nearPolicyFixture(type);
      Object.assign(actions[1]!.params, patch);
      assert.equal(accepts(generated), false);
    }
    const { generated, actions } = nearPolicyFixture(type);
    actions.reverse();
    assert.equal(accepts(generated), false, "storage precedes transition");
  }
});

test("NEAR framing and budgets refuse alternate encodings without changing legitimate bounds", () => {
  for (const patch of [{ gas: "0" }, { gas: "300000000000001" }, { gas: "1e14" }, { gas: "01" },
    { deposit: "01" }, { deposit: "-1" }, { deposit: "1000000000000000000000001" },
    { args: "{}" }, { args: [] }, { args: null }, { callback: "hidden" }]) {
    const { generated, actions } = nearPolicyFixture();
    Object.assign(actions[0]!.params, patch);
    assert.equal(accepts(generated), false, JSON.stringify(patch));
  }
  const { generated, actions } = nearPolicyFixture();
  actions[0]!.params.gas = "300000000000000";
  actions[0]!.params.deposit = "1000000000000000000000000";
  assert.ok(accepts(generated));
  generated.intent.payload.senderId = "mallory.near";
  assert.equal(accepts(generated), false);
});
