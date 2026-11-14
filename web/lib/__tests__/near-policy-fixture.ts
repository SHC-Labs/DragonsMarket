import { policyFixture } from "./evm-policy-fixture";

export function nearPolicyFixture(type: "agent_create" | "agent_freeze" | "agent_unfreeze" = "agent_create") {
  const { generated, approval, args } = policyFixture(type);
  generated.signer = { type: "near", account_id: "alice.near", public_key: "ed25519:key" };
  const call = (methodName: string, value: Record<string, unknown>, deposit = "0") => ({
    type: "FunctionCall", params: { methodName, args: value, gas: "50000000000000", deposit },
  });
  const actions = [call("store_wallet_policy", args, "10000000000000000000000")];
  if (type !== "agent_create") actions.push(call(type === "agent_freeze" ? "freeze_wallet" : "unfreeze_wallet",
    { wallet_pubkey: args.wallet_pubkey }));
  generated.intent = { standard: "nep366", payload: { receiverId: approval.walletContract, actions } };
  return { generated, approval, actions, args };
}
