import { config } from "./config";
import { view } from "./rpc";
import { GAS, type FunctionCall } from "./market";

export type QuarterState = "open" | "closing" | "final";
export type EntitlementStatus = "accruing" | "closing" | "claimable" | "pending" | "paid";

export interface Stake {
  owner: string;
  staked_at: string;
  unlock_requested_at: string | null;
  serving: string | null;
  booked_to: string;
}

export interface QuarterView {
  quarter: number;
  label: string;
  starts_at: string;
  ends_at: string;
  claimable_from: string;
  state: QuarterState;
  revenue_in: string;
  carry_in: string;
  pool: string;
  seat_ns: string;
  forfeit_ns: string;
  paid: string;
  pending: string;
  rolled_to: number | null;
}

export interface EntitlementView {
  quarter: number;
  token_id: string;
  owner: string;
  weight_ns: string;
  amount: string;
  // True until the quarter is final: later revenue and seat time still move the amount.
  estimated: boolean;
  status: EntitlementStatus;
  requested_at: string | null;
  paid_at: string | null;
}

export interface RewardTotals {
  total_received: string;
  total_paid: string;
  pending_claims: string;
  open_pool: string;
  final_unclaimed: string;
  rolled: string;
}

export interface CouncilConfig {
  verifier: string;
  collateral_token_id: string;
  markets: string[];
  nft_contract: string | null;
  cooldown_ns: string;
  max_seats_per_account: number;
  allowlist_enabled: boolean;
  close_grace_ns: string;
  reconcile_wait_ns: string;
}

const council = () => config.councilId;

export const getCouncilConfig = () => view<CouncilConfig>(council(), "config");
export const seatCount = () => view<number>(council(), "seat_count");
export const isSeat = (account: string) => view<boolean>(council(), "is_seat", { account_id: account });
export const isAllowed = (tokenId: string) => view<boolean>(council(), "is_allowed", { token_id: tokenId });
export const seatsOf = (account: string) => view<string[]>(council(), "seats_of", { account_id: account });
export const stakeOf = (tokenId: string) => view<Stake | null>(council(), "stake_of", { token_id: tokenId });
export const currentQuarter = () => view<QuarterView>(council(), "current_quarter");
export const getQuarter = (quarter: number) => view<QuarterView | null>(council(), "get_quarter", { quarter });
export const listQuarters = (from: number, limit: number) =>
  view<QuarterView[]>(council(), "list_quarters", { from_quarter: from, limit });
export const getEntitlement = (quarter: number, tokenId: string, account: string) =>
  view<EntitlementView | null>(council(), "get_entitlement", { quarter, token_id: tokenId, account_id: account });
export const entitlementsOf = (account: string, fromQuarter: number, limit: number) =>
  view<EntitlementView[]>(council(), "entitlements_of", { account_id: account, from_quarter: fromQuarter, limit });
export const rewardTotals = () => view<RewardTotals>(council(), "reward_totals");

// Stakes a seat by sending the NFT to the Council. Check isAllowed first; the Council refuses tokens off its allowlist.
export const stakeCall = (tokenId: string): FunctionCall => ({
  receiverId: config.nftId,
  methodName: "nft_transfer_call",
  args: { receiver_id: council(), token_id: tokenId, msg: "" },
  gas: GAS,
  deposit: "1",
});

export const requestUnstakeCall = (tokenId: string): FunctionCall => ({
  receiverId: council(),
  methodName: "request_unstake",
  args: { token_id: tokenId },
  gas: "30000000000000",
  deposit: "0",
});

export const unstakeCall = (tokenId: string): FunctionCall => ({
  receiverId: council(),
  methodName: "unstake",
  args: { token_id: tokenId },
  gas: GAS,
  deposit: "1",
});

// A quarter pays each seat once. The call is refused until the quarter is final.
export const claimQuarterCall = (quarter: number, tokenId: string): FunctionCall => ({
  receiverId: council(),
  methodName: "claim_quarter",
  args: { quarter, token_id: tokenId },
  gas: GAS,
  deposit: "1",
});
