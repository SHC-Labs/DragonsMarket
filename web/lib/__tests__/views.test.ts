import { beforeEach, describe, expect, it, vi } from "vitest";

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

const view = vi.hoisted(() => vi.fn());
vi.mock("../rpc", () => ({ view }));

import { friendlyError } from "../errors";
import {
  getAccount, getBondTotals, getCase, getFees, getInFlight, getMarketConfig, getMarketInfo, getOracleConfig, getOwedBreakdown,
  getPositions, listCases,
} from "../market";
import { getCouncilConfig } from "../council";

beforeEach(() => view.mockReset().mockResolvedValue(null));

describe("market views", () => {
  it("reads positions and the account for one account id", async () => {
    await getPositions("alice.near");
    expect(view).toHaveBeenLastCalledWith("market.near", "get_positions", { account_id: "alice.near" });
    await getAccount("alice.near");
    expect(view).toHaveBeenLastCalledWith("market.near", "get_account", { account_id: "alice.near" });
  });
  it("reads in-flight money and the owed breakdown with no args", async () => {
    await getInFlight();
    expect(view).toHaveBeenLastCalledWith("market.near", "in_flight");
    await getOwedBreakdown();
    expect(view).toHaveBeenLastCalledWith("market.near", "owed_breakdown");
  });
  it("reads the market config and the fees", async () => {
    await getMarketConfig();
    expect(view).toHaveBeenLastCalledWith("market.near", "config");
    await getFees();
    expect(view).toHaveBeenLastCalledWith("market.near", "get_fees");
  });
});

describe("oracle views", () => {
  it("lists cases with the start id as a decimal string and the limit as a number", async () => {
    await listCases(40, 25);
    expect(view).toHaveBeenLastCalledWith("oracle.near", "list_cases", { market: "market.near", from_market_id: "40", limit: 25 });
  });
  it("reads one case with the market account first", async () => {
    await getCase("7");
    expect(view).toHaveBeenLastCalledWith("oracle.near", "get_case", { market: "market.near", market_id: "7" });
  });
  it("reads bond totals, market info and config", async () => {
    await getBondTotals();
    expect(view).toHaveBeenLastCalledWith("oracle.near", "bond_totals");
    await getMarketInfo("7");
    expect(view).toHaveBeenLastCalledWith("oracle.near", "get_market_info", { market: "market.near", market_id: "7" });
    await getOracleConfig();
    expect(view).toHaveBeenLastCalledWith("oracle.near", "config");
  });
});

describe("council views", () => {
  it("reads the council config", async () => {
    await getCouncilConfig();
    expect(view).toHaveBeenLastCalledWith("council.near", "config");
  });
});

describe("new refusal copy", () => {
  it("says selling is paused, and that rule beats the generic paused rule", () => {
    const sells = friendlyError("sells are paused", "r");
    expect(sells).toBe("Selling is paused right now. Buying may still work.");
    expect(friendlyError("trading is paused", "r")).toBe("Trading is paused. Check the market status before trying again.");
    expect(sells).not.toBe(friendlyError("paused", "r"));
  });
  it("explains a pending withdrawal", () => {
    expect(friendlyError("a withdrawal is still pending", "r")).toContain("withdrawal is pending");
  });
  it("explains a fee sweep inside the waiting time, for both wordings of the refusal", () => {
    const copy = "Fees were swept a moment ago. Try again after the waiting time has passed.";
    expect(friendlyError("wait an hour since the last sweep", "r")).toBe(copy);
    expect(friendlyError("wait 5 minutes since the last sweep", "r")).toBe(copy);
  });
  it("explains an open jury blocking a quarter", () => {
    expect(friendlyError("a jury drawn in this quarter is still open", "r")).toContain("jury drawn in this quarter is still open");
  });
});

describe("first release wallet rule", () => {
  it("states NEAR wallets only", async () => {
    const { WALLET_RULE_V1 } = await vi.importActual<typeof import("../config")>("../config");
    expect(WALLET_RULE_V1).toBe("This version connects NEAR wallets. Support for wallets on other chains is planned.");
  });
});
