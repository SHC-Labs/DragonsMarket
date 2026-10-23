import { config } from "./config";
import { view } from "./rpc";

export type Outcome = "yes" | "no" | "void";
export type Side = "yes" | "no";

export interface PriceRule {
  observation_time: string;
  strike: string;
  decimals: number;
  above: boolean;
}

export type MarketStatus = "resolved" | "halted" | "closed" | "unregistered" | "unseeded" | "open";

export interface MarketView {
  id: string;
  title: string;
  rule_text: string;
  resolution_source: string;
  void_policy: string;
  category: string;
  subcategory: string;
  rule_hash: string;
  price_rule: PriceRule | null;
  close_at: string;
  resolve_by: string;
  status: MarketStatus;
  registered: boolean;
  seeded: boolean;
  void_price_yes: string | null;
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
  // Unique across every market the oracle serves; never changes
  case_uid: string;
  stage: "proposed" | "disputed" | "final";
  proposer: string;
  proposed: Outcome;
  bond: string;
  evidence: string;
  window_ends_at: string;
  challenger: string | null;
  challenger_answer: Outcome | null;
  round: number;
  jury_size: number;
  draw_by: string;
  draw_after_height: string;
  commit_ends_at: string;
  // 0 until a jury is seated
  panel_deadline: string;
  panel: string[];
  first_panel: string[];
  commits: { juror: string; commitment: string }[];
  challenged_at: string;
  delinquent: string[];
  votes: Vote[];
  final_outcome: Outcome | null;
  applied: boolean;
  // The shares of the bonds that go to jurors, fixed when the answer was proposed.
  juror_share_bps: number;
  no_decision_share_bps: number;
}

// One row of list_cases: where a case stands, without the evidence, the panel or the vote text.
export interface CaseSummary {
  market: string;
  market_id: string;
  stage: Case["stage"];
  proposed: Outcome;
  challenger_answer: Outcome | null;
  round: number;
  final_outcome: Outcome | null;
  applied: boolean;
  // Revealed votes only
  votes: number;
  window_ends_at: string;
  draw_by: string;
  panel_deadline: string;
}

export interface BondTotals {
  bonds_held: string;
  claimable: string;
  pending_payouts: string;
  total: string;
}

export interface OracleMarketInfo {
  close_at: string;
  resolve_by: string;
  rule_hash: string;
  price_rule: PriceRule | null;
  window_ns: string;
  panel_deadline_ns: string;
  draw_window_ns: string;
  apply_buffer_ns: string;
}

export interface PricePoint {
  at: string;
  price_yes: number;
}

export interface OracleConfig {
  // Market contracts the oracle accepts cases from
  markets: string[];
  verifier: string;
  collateral_token_id: string;
  bond: string;
  window_ns: string;
  panel_deadline_ns: string;
  draw_window_ns: string;
  min_proposal_ns: string;
  min_resolve_gap_ns: string;
  council: string;
  jury_size: number;
  draw_delay_blocks: string;
  no_decision_recipient: string | null;
  apply_buffer_ns: string;
  juror_share_bps: number;
  no_decision_share_bps: number;
  max_publishers: number;
  reconcile_wait_ns: string;
}

export interface MarketConfig {
  state_version: number;
  upgrade_proven: boolean;
  upgrade_in_flight: boolean;
  owner: string;
  pending_owner: string | null;
  operator: string;
  oracle: string;
  markets: string;
  min_sweep: string;
  next_sweep_id: string;
  revenue_unresolved: string;
  verifier: string;
  collateral_token_id: string;
  paused: boolean;
  storage_deposit: string;
  max_positions: number;
  fee_rate_bps: number;
  create_fee: string;
  revenue_pool: string | null;
  treasury: string | null;
  revenue_share_bps: number;
  treasury_share_bps: number;
  sells_paused: boolean;
  void_price_window_ns: string;
  void_grace_ns: string;
  settle_wait_minutes: number;
  reconcile_wait_minutes: number;
  min_sweep_interval_minutes: number;
  min_open_price: string;
  max_open_price: string;
  max_fee_rate_bps: number;
  min_revenue_share_bps: number;
  max_revenue_share_bps: number;
  max_create_fee: string;
  max_min_sweep: string;
}

export interface Fees {
  collected: string;
  revenue_due: string;
  treasury_due: string;
  revenue_unresolved: string;
}

// One market where an account holds shares. redeemable is what redeem would credit now, "0" until the market resolves.
export interface PositionView {
  market_id: string;
  yes: string;
  no: string;
  status: MarketStatus;
  outcome: Outcome | null;
  redeemable: string;
}

export interface AccountView {
  registered: boolean;
  available: string;
  pending_withdrawals: string;
  // How many markets the account holds shares in
  positions: number;
}

// Money sent and not yet reported: withdrawals waiting on their callback, and fee legs that are pending or unresolved.
export interface InFlightView {
  withdrawals: string;
  withdrawal_count: number;
  legs: string;
  leg_count: number;
}

// The buckets total_owed adds, and their sum.
export interface OwedView {
  balances: string;
  locked: string;
  fees: string;
  revenue_due: string;
  treasury_due: string;
  unresolved: string;
  pending_withdrawals: string;
  total: string;
}

export type LegStatus = "pending" | "settled" | "refused" | "unresolved";
export interface Leg {
  to: string;
  amount: string;
  status: LegStatus;
}
export interface Sweep {
  id: string;
  at: string;
  total: string;
  carried_council: string;
  carried_treasury: string;
  council: Leg;
  treasury: Leg;
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
export const getCase = (id: string) => view<Case | null>(oracle(), "get_case", { market: market(), market_id: id });
export const getMarketInfo = (id: string) => view<OracleMarketInfo | null>(oracle(), "get_market_info", { market: market(), market_id: id });
// Looks at `limit` consecutive market ids and returns a row for each one that has a case, so advance by `limit`.
export const listCases = (fromMarketId: number, limit: number) =>
  view<CaseSummary[]>(oracle(), "list_cases", { market: market(), from_market_id: String(fromMarketId), limit });
export const getBondTotals = () => view<BondTotals>(oracle(), "bond_totals");
export const getOracleConfig = () => view<OracleConfig>(oracle(), "config");
export const getMarketConfig = () => view<MarketConfig>(market(), "config");
export const getFees = () => view<Fees>(market(), "get_fees");
export const getSweep = (id: string) => view<Sweep | null>(market(), "get_sweep", { sweep_id: id });
export const listSweeps = (from: number, limit: number) =>
  view<Sweep[]>(market(), "list_sweeps", { from_index: String(from), limit: String(limit) });
export const getPositions = (account: string) => view<PositionView[]>(market(), "get_positions", { account_id: account });
export const getAccount = (account: string) => view<AccountView>(market(), "get_account", { account_id: account });
export const getInFlight = () => view<InFlightView>(market(), "in_flight");
export const getOwedBreakdown = () => view<OwedView>(market(), "owed_breakdown");
export const marketTotalOwed = () => view<string>(market(), "total_owed");
export const getBalance = (account: string) => view<string>(market(), "get_balance", { account_id: account });
export const getShares = (id: string, account: string) =>
  view<[string, string]>(market(), "get_shares", { market_id: id, account_id: account });
export const isRegistered = (account: string) => view<boolean>(market(), "is_registered", { account_id: account });
// Free funds live in the user's Intents account, not in a token contract.
export const tokenBalance = (account: string) =>
  view<string>(config.verifierId, "mt_balance_of", { account_id: account, token_id: config.collateralTokenId });
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

export const GAS = "100000000000000"; // 100 TGas, clears every contract floor but resolve_draw's
const GAS_DRAW = "300000000000000"; // resolve_draw refuses below 275 TGas
const ONE_YOCTO = "1";
const STORAGE_DEPOSIT = "50000000000000000000000"; // 0.05 NEAR, what market asks for

// Money moves by the verifier. It refunds the sender when the receiver refuses the message, and the transaction still
// succeeds, so callers must read the effect on the chain rather than the transaction status.
const verifierTransfer = (to: string, amount: bigint, msg: string): FunctionCall => ({
  receiverId: config.verifierId,
  methodName: "mt_transfer_call",
  args: { receiver_id: to, token_id: config.collateralTokenId, amount: amount.toString(), msg },
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

export const depositCall = (amount: bigint) => verifierTransfer(market(), amount, "deposit");

// Buy with funds still in the Intents account.
export const buyCall = (id: string, side: Side, amount: bigint, minShares: bigint) =>
  verifierTransfer(market(), amount, `buy:${id}:${side}:${minShares}`);

// Buy with funds already deposited in the market.
export const buyFromBalanceCall = (id: string, side: Side, amount: bigint, minShares: bigint): FunctionCall => ({
  receiverId: market(),
  methodName: "buy",
  args: { market_id: id, side, amount: amount.toString(), min_shares: minShares.toString() },
  gas: GAS,
  deposit: ONE_YOCTO,
});

export const sellCall = (id: string, side: Side, collateralOut: bigint, maxSharesIn: bigint): FunctionCall => ({
  receiverId: market(),
  methodName: "sell",
  args: { market_id: id, side, collateral_out: collateralOut.toString(), max_shares_in: maxSharesIn.toString() },
  gas: GAS,
  deposit: ONE_YOCTO,
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
  verifierTransfer(oracle(), bond, `propose:${market()}:${id}:${outcome}:${evidence}`);

// The challenger names the answer they say is right; jurors vote for it or for the proposal.
export const challengeCall = (id: string, answer: Outcome, bond: bigint) =>
  verifierTransfer(oracle(), bond, `challenge:${market()}:${id}:${answer}`);

export const commitVoteCall = (id: string, commitment: string): FunctionCall => ({
  receiverId: oracle(),
  methodName: "commit_vote",
  args: { market: market(), market_id: id, commitment },
  gas: GAS,
  deposit: ONE_YOCTO,
});

export const revealVoteCall = (id: string, outcome: Outcome, salt: string, reason: string): FunctionCall => ({
  receiverId: oracle(),
  methodName: "reveal_vote",
  args: { market: market(), market_id: id, outcome, salt, reason },
  gas: GAS,
  deposit: ONE_YOCTO,
});

export const resolveDrawCall = (id: string): FunctionCall => ({
  receiverId: oracle(),
  methodName: "resolve_draw",
  args: { market: market(), market_id: id },
  gas: GAS_DRAW,
  deposit: "0",
});

// hex(sha256("<juror>:<outcome>:<salt>")), the form the oracle checks a reveal against. The salt must be random and
// stored before the commit is sent: a lost salt makes the reveal impossible.
export async function commitmentFor(juror: string, outcome: Outcome, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${juror}:${outcome}:${salt}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const newSalt = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export const finalizeCall = (id: string): FunctionCall => ({
  receiverId: oracle(),
  methodName: "finalize",
  args: { market: market(), market_id: id },
  gas: GAS,
  deposit: "0",
});

export const retryApplyCall = (id: string): FunctionCall => ({
  receiverId: oracle(),
  methodName: "retry_apply",
  args: { market: market(), market_id: id },
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
