import { config } from "./config";
import { view } from "./rpc";

export type Outcome = "yes" | "no" | "void";
export type Side = "yes" | "no";

export interface MarketView {
  id: string;
  title: string;
  rule_text: string;
  resolution_source: string;
  void_policy: string;
  category: string;
  subcategory: string;
  rule_hash: string;
  close_at: string;
  resolve_by: string;
  status: "open" | "closed" | "halted" | "resolved";
  registered: boolean;
  seeded?: boolean;
  void_price_yes?: string | null;
  outcome: Outcome | null;
  price_yes: string;
  price_no: string;
  locked: string;
}

export interface Vote {
  juror: string;
  outcome: Outcome;
  reason: string;
}

export interface Case {
  stage: "proposed" | "disputed" | "final";
  proposer: string;
  proposed: Outcome;
  evidence: string;
  window_ends_at: string;
  challenger: string | null;
  panel_deadline: string;
  panel?: string[];
  commits?: { juror: string; commitment: string }[];
  commit_ends_at?: string;
  challenged_at?: string;
  draw_after_height?: string;
  delinquent?: string[];
  votes: Vote[];
  final_outcome: Outcome | null;
  applied: boolean;
}

export interface PricePoint {
  at: string;
  price_yes: number;
}

export interface OracleConfig {
  bond: string;
  window_ns: string;
  panel_deadline_ns: string;
  council?: string;
  jury_size?: number;
  draw_delay_blocks?: string;
}

const market = () => config.marketId;
const oracle = () => config.oracleId;

// ---- reads --------------------------------------------------------------------------------

// The last list read, so a market page opened from it can draw its header in the same frame as the navigation
// (the shared-element morph needs both ends in one commit). The page still reads the market itself straight after.
const lastListed = new Map<string, MarketView>();
const lastStage = new Map<string, string | null>();
export const listedMarket = (id: string) => lastListed.get(id) ?? null;
export const listedStage = (id: string) => lastStage.get(id) ?? null;
export function rememberStages(stages: Record<string, string | null>) {
  for (const [id, stage] of Object.entries(stages)) lastStage.set(id, stage);
}

// Fetch every page: positions can belong to markets beyond the first 50.
export async function listMarkets(): Promise<MarketView[]> {
  const all: MarketView[] = [];
  const seen = new Set<string>();
  for (let from = 0; ; from += 50) {
    const page = await view<MarketView[]>(market(), "list_markets", { from_index: String(from), limit: "50" });
    for (const item of page) {
      if (seen.has(item.id)) throw new Error("Market pagination repeated a record. Please retry.");
      seen.add(item.id);
      all.push(item);
    }
    if (page.length < 50) {
      for (const m of all) lastListed.set(m.id, m);
      return all;
    }
  }
}

// Unknown seeding state remains a pending contract field; explicit false is never tradable.
export const isMarketListed = (m: MarketView) => m.registered && m.seeded !== false;
export interface BuyQuote { shares_out: string; fee: string }
export interface SellQuote { collateral_out: string; shares_in: string; fee: string }

export const getMarket = (id: string) => view<MarketView | null>(market(), "get_market", { market_id: id });
export const getHistory = (id: string) => view<PricePoint[]>(market(), "get_history", { market_id: id });
export const getCase = (id: string) => view<Case | null>(oracle(), "get_case", { market_id: id });
export const getOracleConfig = () => view<OracleConfig>(oracle(), "config");
export const getBalance = (account: string) => view<string>(market(), "get_balance", { account_id: account });
export const getShares = (id: string, account: string) =>
  view<[string, string]>(market(), "get_shares", { market_id: id, account_id: account });
export const isRegistered = (account: string) => view<boolean>(market(), "is_registered", { account_id: account });
export const tokenBalance = (account: string) => view<string>(config.tokenId, "ft_balance_of", { account_id: account });
export const claimableBond = (account: string) => view<string>(oracle(), "claimable_of", { account_id: account });
export const quoteBuy = (id: string, side: Side, amount: bigint) =>
  view<BuyQuote>(market(), "quote_buy", { market_id: id, side, amount: amount.toString() });
export const quoteSell = (id: string, side: Side, shares: bigint) =>
  view<SellQuote>(market(), "quote_sell", {
    market_id: id,
    side,
    shares: shares.toString(),
  });

// ---- transactions -------------------------------------------------------------------------
// Each returns a function call for the wallet to sign. Nothing here touches the network.

export interface FunctionCall {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}

const GAS = "100000000000000"; // 100 TGas
const ONE_YOCTO = "1";
const STORAGE_DEPOSIT = "50000000000000000000000"; // 0.05 NEAR, what market asks for

const tokenTransfer = (to: string, amount: bigint, msg: string): FunctionCall => ({
  receiverId: config.tokenId,
  methodName: "ft_transfer_call",
  args: { receiver_id: to, amount: amount.toString(), msg },
  gas: GAS,
  deposit: ONE_YOCTO,
});

export const storageDepositCall = (): FunctionCall => ({
  receiverId: market(),
  methodName: "storage_deposit",
  args: {},
  gas: "30000000000000",
  deposit: STORAGE_DEPOSIT,
});

export const buyCall = (id: string, side: Side, amount: bigint, minShares: bigint) =>
  tokenTransfer(market(), amount, `buy:${id}:${side}:${minShares}`);

export const sellCall = (id: string, side: Side, collateralOut: bigint, maxSharesIn: bigint): FunctionCall => ({
  receiverId: market(),
  methodName: "sell",
  args: { market_id: id, side, collateral_out: collateralOut.toString(), max_shares_in: maxSharesIn.toString() },
  gas: GAS,
  deposit: "0",
});

export const redeemCall = (id: string): FunctionCall => ({
  receiverId: market(),
  methodName: "redeem",
  args: { market_id: id },
  gas: GAS,
  deposit: "0",
});

export const withdrawCall = (amount: bigint): FunctionCall => ({
  receiverId: market(),
  methodName: "withdraw",
  args: { amount: amount.toString() },
  gas: GAS,
  deposit: ONE_YOCTO,
});

export const proposeCall = (id: string, outcome: Outcome, evidence: string, bond: bigint) =>
  tokenTransfer(oracle(), bond, `propose:${id}:${outcome}:${evidence}`);

export const challengeCall = (id: string, bond: bigint) => tokenTransfer(oracle(), bond, `challenge:${id}`);

// Voting integration intentionally pending: commit/reveal and durable salt recovery
// must be designed against the final ABI. There is no panel_vote adapter.

export const finalizeCall = (id: string): FunctionCall => ({
  receiverId: oracle(),
  methodName: "finalize",
  args: { market_id: id },
  gas: GAS,
  deposit: "0",
});

export const retryApplyCall = (id: string): FunctionCall => ({
  receiverId: oracle(),
  methodName: "retry_apply",
  args: { market_id: id },
  gas: GAS,
  deposit: "0",
});

export const withdrawBondCall = (): FunctionCall => ({
  receiverId: oracle(),
  methodName: "withdraw_bond",
  args: {},
  gas: GAS,
  deposit: ONE_YOCTO,
});

// Test money, testnet only. The mock token has a public faucet method (added with the testnet deploy).
export const faucetCall = (): FunctionCall => ({
  receiverId: config.tokenId,
  methodName: "faucet",
  args: {},
  gas: "30000000000000",
  deposit: "0",
});
