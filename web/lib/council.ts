import { config } from "./config";
import { view } from "./rpc";
import { GAS, type FunctionCall } from "./market";

export interface Stake {
  owner: string;
  staked_at: string;
  unlock_requested_at: string | null;
  serving: string | null;
  // The UTC day this seat starts earning, as a day number since 1970-01-01. Only a council that pays by arrival reports it.
  earn_from_day?: string;
}

export type SeatState = "waiting" | "earning" | "leaving" | "serving";

export interface SeatEarnings {
  owner: string;
  state: SeatState;
  earning_from: string;
  // What a claim pays for this seat now: its earnings up to the last finished quarter.
  earned_closed: string;
  // Earned in the quarter still running. A claim cannot reach it until the quarter ends, and leaving first cuts it by half.
  earned_in_progress: string;
}

export interface QuarterInfo {
  quarter: number;
  starts_at: string;
  ends_at: string;
  last_closed_quarter: number;
}

export interface RewardTotals {
  total_received: string;
  total_paid: string;
  pending_claims: string;
  carry: string;
  cut_pool: string;
  accrued_total: string;
}

export interface CouncilConfig {
  verifier: string;
  collateral_token_id: string;
  markets: string[];
  nft_contract: string | null;
  cooldown_ns: string;
  max_seats_per_account: number;
  allowlist_enabled: boolean;
  reconcile_wait_ns: string;
  last_day?: string;
  active_seats?: number;
}

const council = () => config.councilId;

export const getCouncilConfig = () => view<CouncilConfig>(council(), "config");
export const seatCount = () => view<number>(council(), "seat_count");
export const isSeat = (account: string) => view<boolean>(council(), "is_seat", { account_id: account });
export const isAllowed = (tokenId: string) => view<boolean>(council(), "is_allowed", { token_id: tokenId });
export const seatsOf = (account: string) => view<string[]>(council(), "seats_of", { account_id: account });
export const stakeOf = (tokenId: string) => view<Stake | null>(council(), "stake_of", { token_id: tokenId });
export const rewardTotals = () => view<RewardTotals>(council(), "reward_totals");
// What one seat has earned and when it starts. Only a council that pays by arrival has this view.
export const seatEarnings = (tokenId: string) => view<SeatEarnings | null>(council(), "seat_earnings", { token_id: tokenId });
// Revenue a holder can claim now, from quarters that have ended. Claims never expire.
export const claimableOf = (account: string) => view<string>(council(), "claimable_of", { account_id: account });
// What a holder has earned in the running quarter, claimable once it ends.
export const inProgressOf = (account: string) => view<string>(council(), "in_progress_of", { account_id: account });
export const quarterInfo = () => view<QuarterInfo>(council(), "quarter_info");

export interface OwnedToken {
  token_id: string;
  owner_id: string;
}

// NEP-181 enumeration. A collection without it answers with an error, which callers treat as "cannot list".
export const nftTokensFor = (account: string) =>
  view<OwnedToken[]>(config.nftId, "nft_tokens_for_owner", { account_id: account, from_index: "0", limit: 50 });
export const nftToken = (tokenId: string) => view<OwnedToken | null>(config.nftId, "nft_token", { token_id: tokenId });

// Stakes a seat by sending the NFT to the Council. Check isAllowed first; the Council refuses tokens off its allowlist.
export const stakeCall = (tokenId: string): FunctionCall => ({
  receiverId: config.nftId,
  methodName: "nft_transfer_call",
  args: { receiver_id: council(), token_id: tokenId, msg: "" },
  gas: GAS,
  deposit: "1",
});

// Leaving before the quarter ends cuts half of that quarter's earnings. The contract refuses the call without accepts_cut, so
// only send this after the holder has read the warning.
export const requestUnstakeCall = (tokenId: string): FunctionCall => ({
  receiverId: council(),
  methodName: "request_unstake",
  args: { token_id: tokenId, accepts_cut: true },
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

// Pays everything the caller's seats have earned in one transfer, up to ten seats a call. Pass no tokens to collect what an
// account already settled from seats that have left.
export const claimCall = (tokenIds: string[]): FunctionCall => ({
  receiverId: council(),
  methodName: "claim",
  args: { token_ids: tokenIds },
  gas: GAS,
  deposit: "1",
});
