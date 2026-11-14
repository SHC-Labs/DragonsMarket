import { config } from "./config";
import type { FunctionCall } from "./market";
import type { Action } from "./signed-intents";

export function relayMarketExit(call: FunctionCall): Action {
  if (call.receiverId !== config.marketId) throw new Error("Unknown market destination.");
  const a = call.args;
  let parts: unknown[];
  if (call.methodName === "sell") parts = ["sell", a.market_id, a.side, a.shares, a.min_collateral];
  else if (call.methodName === "redeem") parts = ["redeem", a.market_id];
  else if (call.methodName === "withdraw") parts = ["withdraw", a.amount];
  else throw new Error("This action is not a supported market exit.");
  if (!parts.every(part => typeof part === "string" && !part.includes(":"))) throw new Error("Invalid market exit arguments.");
  return { kind: "auth", to: call.receiverId, msg: parts.join(":") };
}
