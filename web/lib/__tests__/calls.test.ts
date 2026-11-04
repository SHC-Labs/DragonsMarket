import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    marketId: "market.near",
    oracleId: "oracle.near",
    councilId: "council.near",
    verifierId: "intents.near",
    collateralTokenId: "nep141:usdc.near",
    nftId: "seats.near",
    tokenId: "usdc.near",
  },
}));

import { friendlyError, requiredGasTgas } from "../errors";
import {
  buyCall, buyFromBalanceCall, challengeCall, commitVoteCall, commitmentFor, depositCall, finalizeCall, newSalt, proposeCall, retryApplyCall,
  redeemCall, resolveDrawCall, revealVoteCall, sellCall, storageDepositCall, withdrawCall,
} from "../market";
import { claimCall, requestUnstakeCall, stakeCall, unstakeCall } from "../council";

const VERIFIER_FIELDS = { receiverId: "intents.near", methodName: "mt_transfer_call", deposit: "1", gas: "100000000000000" };

describe("money moves through the verifier", () => {
  it("deposits to the market", () => {
    expect(depositCall(5_000_000n)).toEqual({
      ...VERIFIER_FIELDS,
      args: { receiver_id: "market.near", token_id: "nep141:usdc.near", amount: "5000000", msg: "deposit" },
    });
  });
  it("buys with the message the market parses", () => {
    expect(buyCall("7", "yes", 2_000_000n, 1_900_000n).args).toEqual({
      receiver_id: "market.near", token_id: "nep141:usdc.near", amount: "2000000", msg: "buy:7:yes:1900000",
    });
  });
  it("proposes and challenges through the oracle, and a challenge names its answer", () => {
    expect(proposeCall("7", "no", "see the source", 5_000_000n).args).toMatchObject({
      receiver_id: "oracle.near", amount: "5000000", msg: "propose:market.near:7:no:see the source",
    });
    expect(challengeCall("7", "yes", 5_000_000n)).toMatchObject({
      ...VERIFIER_FIELDS,
      args: { receiver_id: "oracle.near", amount: "5000000", msg: "challenge:market.near:7:yes" },
    });
  });
});

describe("market calls that move value carry one yocto", () => {
  it("buy from the market balance, sell and withdraw", () => {
    expect(buyFromBalanceCall("7", "no", 1_000_000n, 900_000n)).toMatchObject({
      receiverId: "market.near", methodName: "buy", deposit: "1",
      args: { market_id: "7", side: "no", amount: "1000000", min_shares: "900000" },
    });
    expect(sellCall("7", "yes", 600_000n, 500_000n)).toMatchObject({
      methodName: "sell", deposit: "1", args: { market_id: "7", side: "yes", shares: "600000", min_collateral: "500000" },
    });
    expect(withdrawCall(3n)).toMatchObject({ methodName: "withdraw", deposit: "1", args: { amount: "3" } });
  });
  it("redeem and the storage deposit keep their own deposits", () => {
    expect(redeemCall("7").deposit).toBe("0");
    expect(storageDepositCall()).toMatchObject({ receiverId: "market.near", args: {}, deposit: "50000000000000000000000" });
  });
});

describe("jury calls", () => {
  it("commit and reveal carry one yocto, a draw gets 300 TGas", () => {
    expect(commitVoteCall("7", "ab")).toMatchObject({ receiverId: "oracle.near", methodName: "commit_vote", deposit: "1" });
    expect(revealVoteCall("7", "no", "salt", "because")).toMatchObject({
      methodName: "reveal_vote", deposit: "1", args: { market: "market.near", market_id: "7", outcome: "no", salt: "salt", reason: "because" },
    });
    expect(resolveDrawCall("7")).toMatchObject({ methodName: "resolve_draw", deposit: "0", gas: "300000000000000" });
  });
  it("every oracle call names the market account before the market id", () => {
    expect(commitVoteCall("7", "ab").args).toEqual({ market: "market.near", market_id: "7", commitment: "ab" });
    expect(resolveDrawCall("7").args).toEqual({ market: "market.near", market_id: "7" });
    expect(finalizeCall("7")).toMatchObject({ receiverId: "oracle.near", methodName: "finalize", args: { market: "market.near", market_id: "7" } });
    expect(retryApplyCall("7")).toMatchObject({ receiverId: "oracle.near", methodName: "retry_apply", args: { market: "market.near", market_id: "7" } });
  });
  it("verifier messages carry the market account first", () => {
    expect(proposeCall("7", "yes", "e", 1n).args.msg).toMatch(/^propose:market\.near:7:yes:/);
    expect(challengeCall("7", "void", 1n).args.msg).toMatch(/^challenge:market\.near:7:void$/);
  });
  it("hashes a commitment the way the oracle does", async () => {
    const expected = createHash("sha256").update("juror.near:no:a-long-random-salt").digest("hex");
    expect(await commitmentFor("juror.near", "no", "a-long-random-salt")).toBe(expected);
  });
  it("makes a 128-bit hex salt that differs each time", () => {
    const a = newSalt();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newSalt()).not.toBe(a);
  });
});

describe("council calls", () => {
  it("stakes through the NFT collection with an empty message", () => {
    expect(stakeCall("42")).toMatchObject({
      receiverId: "seats.near", methodName: "nft_transfer_call", deposit: "1",
      args: { receiver_id: "council.near", token_id: "42", msg: "" },
    });
  });
  it("requests, unstakes and claims", () => {
    expect(requestUnstakeCall("42")).toMatchObject({ receiverId: "council.near", methodName: "request_unstake", deposit: "0", args: { token_id: "42", accepts_cut: true } });
    expect(unstakeCall("42")).toMatchObject({ methodName: "unstake", deposit: "1" });
    expect(claimCall(["42", "43"])).toMatchObject({
      receiverId: "council.near", methodName: "claim", deposit: "1", args: { token_ids: ["42", "43"] },
    });
    expect(claimCall([])).toMatchObject({ methodName: "claim", args: { token_ids: [] } });
  });
});

describe("contract refusals", () => {
  it("explains the new strings", () => {
    expect(friendlyError("that market contract is not allowed", "r")).toBe("This market is not served by the oracle.");
    expect(friendlyError("bad market account", "r")).toContain("could not read this request");
    expect(friendlyError("send exactly the bond", "r")).toBe("Send exactly the bond amount.");
    expect(friendlyError("the panel deadline passed", "r")).toBe("The jury deadline has passed.");
    expect(friendlyError("that quarter is not final", "r")).toContain("still open");
  });
  it("reads the gas a refusal asks for", () => {
    const panic = "attach at least 275 TGas: a jury draw needs room for its callback";
    expect(requiredGasTgas(panic)).toBe(275);
    expect(requiredGasTgas("market is closed")).toBeNull();
    expect(requiredGasTgas(null)).toBeNull();
    expect(friendlyError(panic, "r")).toContain("more gas");
  });
});
