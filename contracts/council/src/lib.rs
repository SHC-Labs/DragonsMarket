// Council registry for the pitch test. A seat is an NFT from one collection staked here with
// nft_transfer_call. The registry draws juries for the oracle from the staked seats and keeps a drawn seat
// from leaving until the oracle says its case is final. Revenue sent here belongs to the UTC calendar quarter it arrives in.
// A seat's share of a quarter is the time it was staked inside that quarter over all the seat time of the quarter, and each
// seat claims each quarter once, from a set time after the quarter ends. A seat staked after a quarter began earns nothing
// from that quarter and starts with the next one.
// The JSON interface takes one argument per field, so a few methods are long on purpose.
#![allow(clippy::too_many_arguments)]

use near_contract_standards::non_fungible_token::core::{ext_nft_core, NonFungibleTokenReceiver};
use near_contract_standards::non_fungible_token::{Token, TokenId};
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue, PublicKey,
};
use std::collections::BTreeMap;

const MAX_SEATS: u32 = 1_000;
// Token ids one allow_tokens call may add. Each is a storage write and an entry in the event, so a call stays far below
// the gas it is given (measured in the sandbox).
const MAX_ALLOW_BATCH: usize = 100;
const NS_PER_SEC: u64 = 1_000_000_000;
const NS_PER_DAY: u64 = 86_400 * NS_PER_SEC;
// How long a claim can sit pending before the owner may decide it by hand, which leaves its payout callback time to arrive.
// The owner can move it between the bounds: under 10 minutes the callback may still be on its way, and over 7 days a
// seat locked out by a stuck claim waits too long for its money.
const DEFAULT_RECONCILE_WAIT_NS: u64 = 3_600 * NS_PER_SEC;
const MIN_RECONCILE_WAIT_NS: u64 = 600 * NS_PER_SEC;
const MAX_RECONCILE_WAIT_NS: u64 = 7 * NS_PER_DAY;
// A finished quarter waits this long before it can be finalized, so a case that crossed its end can settle first and a silent
// juror's forfeit still counts. Claims open when the quarter is finalized. The owner can move it between the bounds.
const DEFAULT_CLOSE_GRACE_NS: u64 = 7 * NS_PER_DAY;
const MIN_CLOSE_GRACE_NS: u64 = NS_PER_DAY;
const MAX_CLOSE_GRACE_NS: u64 = 30 * NS_PER_DAY;
// A longer cooldown overflows nothing, but it locks every seat for as long as it runs.
const MAX_COOLDOWN_NS: u64 = 365 * NS_PER_DAY;
// Quarters one call moves seat time or a seat's weight across. A longer idle stretch needs advance_quarters or book_seat_time
// first, in as many calls as it takes.
const MAX_QUARTER_STEPS: u32 = 8;
// Quarters one list_quarters call returns.
const MAX_VIEW_QUARTERS: u32 = 50;
// Quarters one entitlements_of call walks. Each quarter costs a lookup for every token the account has ever staked, so this
// bounds the gas of the view for an account with many seats.
const MAX_ENTITLEMENT_QUARTERS: u32 = 25;
const MAX_ENTITLEMENT_LOOKUPS: usize = 250;
const GAS_NFT_TRANSFER: Gas = Gas::from_tgas(15);
// The verifier burned 3.8 TGas for a payout from a contract in the sandbox (INTENTS-PROOF.md), so this is a wide margin.
const GAS_MT_TRANSFER: Gas = Gas::from_tgas(15);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_REMOVE_VERIFIER_KEY: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
// The ownership check on a staked token is a view on the collection and a callback that writes the seat.
const GAS_NFT_TOKEN_VIEW: Gas = Gas::from_tgas(10);
const GAS_STAKE_CALLBACK: Gas = Gas::from_tgas(20);
// The gas floors. An unstake sends the NFT and a claim sends the payout, each with a callback, and each burns about 3 TGas
// itself and neither depends on how many seats are staked.
const GAS_OWN_WORK: Gas = Gas::from_tgas(8);
const GAS_UNSTAKE_FLOOR: Gas = Gas::from_gas(GAS_NFT_TRANSFER.as_gas() + GAS_CALLBACK.as_gas() + GAS_OWN_WORK.as_gas());
const GAS_STAKE_FLOOR: Gas =
    Gas::from_gas(GAS_NFT_TOKEN_VIEW.as_gas() + GAS_STAKE_CALLBACK.as_gas() + GAS_OWN_WORK.as_gas());
const GAS_CLAIM_FLOOR: Gas = Gas::from_gas(GAS_MT_TRANSFER.as_gas() + GAS_CALLBACK.as_gas() + GAS_OWN_WORK.as_gas());
// The layout of the state below. migrate reads exactly this one and refuses any other. Version 2 is the quarterly books.
// Version 3 keys received sweeps by market account and stores every map record behind a version tag. Version 4 counts
// unstakes in flight. Version 5 counts only seats staked before a quarter began.
const STATE_VERSION: u16 = 5;
// Token ids in the verifier are exactly "nep141:<contract>". Anything else would never match a transfer.
const NEP141_PREFIX: &str = "nep141:";
const REVENUE_PREFIX: &str = "revenue:";

// The NEAR Intents verifier. Revenue arrives in this contract's account there, and claims are paid out of it.
#[ext_contract(ext_verifier)]
pub trait Verifier {
    fn remove_public_key(&mut self, public_key: PublicKey);
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

// Every record in a map is stored behind a one-byte version tag, so a later layout can be read next to this one. The
// wrapper is what the maps hold: it reads any stored version up to the current layout (the stored enum's into_current is
// where an upgrade from an older version goes) and always writes the current one.
macro_rules! versioned {
    ($name:ident, $stored:ident, $ty:ty) => {
        enum $stored {
            V1($ty),
        }

        impl $stored {
            fn into_current(self) -> $ty {
                match self {
                    Self::V1(value) => value,
                }
            }
        }

        #[derive(Clone)]
        struct $name($ty);

        impl $name {
            fn current(value: $ty) -> Self {
                Self(value)
            }

            fn into_inner(self) -> $ty {
                self.0
            }
        }

        impl std::ops::Deref for $name {
            type Target = $ty;

            fn deref(&self) -> &$ty {
                &self.0
            }
        }

        impl std::ops::DerefMut for $name {
            fn deref_mut(&mut self) -> &mut $ty {
                &mut self.0
            }
        }

        impl BorshSerialize for $name {
            fn serialize<W: borsh::io::Write>(&self, writer: &mut W) -> borsh::io::Result<()> {
                0u8.serialize(writer)?;
                self.0.serialize(writer)
            }
        }

        impl BorshDeserialize for $name {
            fn deserialize_reader<R: borsh::io::Read>(reader: &mut R) -> borsh::io::Result<Self> {
                let stored = match u8::deserialize_reader(reader)? {
                    0 => $stored::V1(<$ty>::deserialize_reader(reader)?),
                    _ => env::panic_str("a stored record has a newer version than this code can read"),
                };
                Ok(Self(stored.into_current()))
            }
        }
    };
}

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Staked,
    Stakes,
    SeatsOf,
    Juries,
    Allowed,
    Quarters,
    SeatWeight,
    Forfeits,
    Claims,
    Received,
    TokensOf,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Stake {
    owner: AccountId,
    staked_at: U64,
    unlock_requested_at: Option<U64>,
    // The case this seat was drawn for. It cannot leave or be drawn again until the oracle releases that case.
    serving: Option<U64>,
    // The time up to which this seat's staked time is already counted in the quarters it covered. Counting is lazy: unstake,
    // a claim, a forfeit and book_seat_time move it forward.
    booked_to: U64,
    // When the seat was drawn. A juror who never votes loses the seat time from here until the case is released.
    #[serde(skip)]
    serving_from: u64,
    // Where the token sits in `staked`, so unstaking does not scan the list.
    #[serde(skip)]
    index: u32,
}

versioned!(VersionedStake, StoredStake, Stake);

// What one quarter holds. `seat_ns` is the sum over the quarter of the number of seats still earning (staked and not asking to leave), in seat nanoseconds. It only
// moves when the seat count changes or when advance_quarters is called, so every method that changes the count moves it to
// the present first.
#[near(serializers=[borsh])]
#[derive(Clone, Default)]
struct QuarterBook {
    revenue_in: u128,
    // A quarter with no seat time rolls its whole pool into the next quarter, which holds it here until it is finalized.
    carry_in: u128,
    seat_ns: u128,
    forfeit_ns: u128,
    finalized: bool,
    // Fixed at finalization: what the seats share, and the seat time they share it by.
    pool: u128,
    weight_total: u128,
    rolled_to: Option<u32>,
    paid: u128,
    pending: u128,
}

versioned!(VersionedQuarterBook, StoredQuarterBook, QuarterBook);

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum ClaimStatus {
    Pending,
    Paid,
}

// The single-use record of one seat's claim on one quarter. It is written before the payout is sent and kept for good once
// paid, which is what stops a second claim.
#[near(serializers=[borsh])]
#[derive(Clone)]
struct Claim {
    amount: u128,
    status: ClaimStatus,
    requested_at: u64,
    paid_at: Option<u64>,
}

versioned!(VersionedClaim, StoredClaim, Claim);

#[near(serializers=[borsh])]
#[derive(Clone)]
struct Received {
    amount: u128,
    quarter: u32,
    at: u64,
}

versioned!(VersionedReceived, StoredReceived, Received);

#[near(serializers=[json])]
pub struct ReceivedView {
    amount: U128,
    quarter: u32,
    at: U64,
}

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum QuarterState {
    Open,
    Closing,
    Final,
}

#[near(serializers=[json])]
pub struct QuarterView {
    quarter: u32,
    label: String,
    starts_at: U64,
    ends_at: U64,
    claimable_from: U64,
    state: QuarterState,
    revenue_in: U128,
    carry_in: U128,
    pool: U128,
    seat_ns: U128,
    forfeit_ns: U128,
    paid: U128,
    pending: U128,
    rolled_to: Option<u32>,
}

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum EntitlementStatus {
    Accruing,
    Closing,
    Claimable,
    Pending,
    Paid,
}

#[near(serializers=[json])]
pub struct EntitlementView {
    quarter: u32,
    token_id: TokenId,
    owner: AccountId,
    weight_ns: U128,
    amount: U128,
    // True while the quarter is not final: later revenue and later seat time still move the amount.
    estimated: bool,
    status: EntitlementStatus,
    requested_at: Option<U64>,
    paid_at: Option<U64>,
}

#[near(serializers=[json])]
pub struct QuarterLabel {
    quarter: u32,
    label: String,
    starts_at: U64,
    ends_at: U64,
}

#[near(serializers=[json])]
pub struct RewardTotals {
    total_received: U128,
    total_paid: U128,
    pending_claims: U128,
    open_pool: U128,
    final_unclaimed: U128,
    rolled: U128,
}

// Days since 1970-01-01 to a civil date, and back (Howard Hinnant's algorithms). The year is signed in the arithmetic only.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = ((shifted_month + 2) % 12 + 1) as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted_month = i64::from(if month > 2 { month - 3 } else { month + 9 });
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

// The id of the UTC calendar quarter a time falls in: year * 4 + (quarter - 1), so 2026 Q4 is 8107. A time exactly on a
// boundary belongs to the quarter that starts there.
fn quarter_containing(at_ns: u64) -> u32 {
    let (year, month, _) = civil_from_days((at_ns / NS_PER_DAY) as i64);
    year as u32 * 4 + (month - 1) / 3
}

// Nanoseconds since the epoch at 00:00 UTC on the first day of the quarter. Saturates for a year past what a u64 holds.
fn quarter_start(quarter: u32) -> u64 {
    let days = days_from_civil(i64::from(quarter / 4), quarter % 4 * 3 + 1, 1);
    (days.max(0) as u64).saturating_mul(NS_PER_DAY)
}

// Where the quarter ends, exclusive: the start of the next one.
fn quarter_end(quarter: u32) -> u64 {
    quarter_start(quarter.saturating_add(1))
}

fn quarter_label(quarter: u32) -> String {
    format!("{}Q{}", quarter / 4, quarter % 4 + 1)
}

// Where a seat's time stops: at `to`, or at its request to unstake if that came first.
fn counted_until(stake: &Stake, to: u64) -> u64 {
    stake.unlock_requested_at.map_or(to, |requested| requested.0.min(to))
}

// How much of [from, to) lies inside the quarter, in nanoseconds.
fn overlap(quarter: u32, from: u64, to: u64) -> u64 {
    to.min(quarter_end(quarter))
        .saturating_sub(from.max(quarter_start(quarter)))
}

// floor(pool * weight / total) without overflowing: pool / total * weight cannot exceed pool, and the remainder part is
// below total * weight, which is far under u128::MAX at 1,000 seats over a quarter.
fn entitlement(pool: u128, weight: u128, total: u128) -> u128 {
    if total == 0 {
        return 0;
    }
    pool / total * weight + pool % total * weight / total
}

fn entitlement_page(limit: u32, tokens: usize) -> usize {
    (limit.min(MAX_ENTITLEMENT_QUARTERS) as usize).min((MAX_ENTITLEMENT_LOOKUPS / tokens.max(1)).max(1))
}

// ponytail: every draw walks every staked token and reads its record. Measured directly at 1,000 seats with
// 64-character account and token ids (contracts/tests/tests/_gas_probe.rs, since deleted): about 190 TGas
// when every seat has its own holder, and up to 210 TGas when 21 holders share them, because the pick then
// sets most tokens aside. The oracle reserves 250 TGas for the draw, so resolve_draw needs about 270 TGas
// attached. Raising MAX_SEATS needs GAS_DRAW raised to match, measured again at the new cap.
#[near(contract_state, contract_metadata(standard(standard = "nep297", version = "1.0.0")))]
#[derive(PanicOnDefault)]
pub struct CouncilContract {
    // First, so migrate can read it before it trusts the rest of the layout.
    state_version: u16,
    // Set by migrate, so it is true only once an upgrade has gone through. seal refuses until then.
    upgrade_proven: bool,
    // Set by upgrade just before it sends the deploy and migrate batch, cleared by migrate. migrate refuses to run when it
    // is not set, so the proof cannot come from calling migrate by hand. A batch that fails leaves it set in the old code,
    // and the next upgrade sets it again.
    upgrade_in_flight: bool,
    owner: AccountId,
    // Set by propose_owner. Ownership moves only when this account calls accept_owner.
    pending_owner: Option<AccountId>,
    oracle: AccountId,
    // The collection whose tokens stake here, which is None until the owner sets it, and the market accounts whose sweeps
    // count as revenue, which is empty until the owner allows one. Staking, claims and revenue refuse until then. A market
    // taken off the list can no longer send revenue; what it already sent stays.
    nft_contract: Option<AccountId>,
    allowed_markets: Vec<AccountId>,
    // The Intents verifier that holds the revenue, and the exact id of the collateral in it, "nep141:<token>".
    verifier: AccountId,
    collateral_token_id: String,
    // How long a seat waits between asking to unstake and leaving. The council cannot see the oracle's settings, so
    // whoever sets this must keep it at least as long as the oracle's challenge window plus panel deadline.
    cooldown_ns: u64,
    // The most seats one account can hold. It limits how much of the jury draw and the revenue share one buyer can
    // gather in a single wallet, and nothing more: one person can still use many wallets. Lowering it does not
    // remove seats an account already holds.
    max_seats_per_account: u32,
    // While on, only a token on the allowlist can be staked. A token is on it when the owner named it with allow_tokens,
    // or when its id is the decimal form of a number inside allowed_range. The collection must have a fixed supply
    // with minting closed before staking opens, or anyone could mint their way onto the list. Every entry belongs to the
    // collection that was current when it was made, so changing the collection leaves the old entries matching nothing.
    allowlist_enabled: bool,
    allowed_tokens: LookupSet<(AccountId, TokenId)>,
    allowed_range: Option<(AccountId, u64, u64)>,
    // Every staked token, in a stable order for the draw.
    staked: Vector<TokenId>,
    stakes: LookupMap<TokenId, VersionedStake>,
    seats_of: LookupMap<AccountId, u32>,
    // Every token an account has ever staked, so its entitlements can be listed after the seat is gone.
    tokens_of: LookupMap<AccountId, Vec<TokenId>>,
    // The tokens drawn for each case still open.
    juries: LookupMap<u64, Vec<TokenId>>,
    // How many open juries were drawn at each time, so finalize_quarter can see whether one drawn before a quarter's end is
    // still open. One entry per open case at most.
    open_juries: BTreeMap<u64, u32>,
    // Staked seats that have not asked to unstake. Only these add seat time: a seat's time stops at its request.
    earning: u32,
    // How long after a quarter ends it can be finalized, and so when its claims open.
    close_grace_ns: u64,
    // How long a claim must be pending before reconcile_claim can decide it.
    reconcile_wait_ns: u64,
    // Seat time is counted up to here. The quarters from `next_to_finalize` on are the ones not final yet.
    last_tick: u64,
    next_to_finalize: u32,
    // A quarter nobody touched has no entry, which reads as an empty book.
    quarters: LookupMap<u32, VersionedQuarterBook>,
    // Staked nanoseconds inside one quarter by one token for one owner, and the part of it a silent juror lost.
    seat_weight: LookupMap<(u32, TokenId, AccountId), u64>,
    forfeits: LookupMap<(u32, TokenId, AccountId), u64>,
    claims: LookupMap<(u32, TokenId, AccountId), VersionedClaim>,
    // Revenue by the market account and its sweep id, so a repeated send is refused, two markets can use the same sweep id,
    // and a market can ask what arrived.
    received: LookupMap<(AccountId, u64), VersionedReceived>,
    // Every token received as revenue, and every one paid out. Their difference less the claims in flight is what the
    // Intents account must hold. The rest of the books below split the difference: money in quarters still open, money in
    // finalized quarters, and money moved on from a quarter that had no seat time.
    total_received: u128,
    total_paid: u128,
    pending_total: u128,
    open_pool: u128,
    final_pool: u128,
    rolled_total: u128,
    // Seats taken out of `staked` whose NFT transfer has not been answered yet. The collection cannot change while one is out,
    // or a failed transfer would restore the seat under another collection.
    unstakes_in_flight: u32,
    // Earning seats staked after the start of the quarter that `last_tick` is in. They add no seat time to it.
    fresh: u32,
    // The first quarter the rule above applies to. Quarters before it keep the old rule, where every staked second counts, because
    // their seat time and weights were already counted that way when the state was migrated.
    rule_from_quarter: u32,
}

// Exact layout of state version 4, which counted every staked second of a quarter.
#[near(serializers=[borsh])]
struct StateV4 {
    state_version: u16,
    upgrade_proven: bool,
    upgrade_in_flight: bool,
    owner: AccountId,
    pending_owner: Option<AccountId>,
    oracle: AccountId,
    nft_contract: Option<AccountId>,
    allowed_markets: Vec<AccountId>,
    verifier: AccountId,
    collateral_token_id: String,
    cooldown_ns: u64,
    max_seats_per_account: u32,
    allowlist_enabled: bool,
    allowed_tokens: LookupSet<(AccountId, TokenId)>,
    allowed_range: Option<(AccountId, u64, u64)>,
    staked: Vector<TokenId>,
    stakes: LookupMap<TokenId, VersionedStake>,
    seats_of: LookupMap<AccountId, u32>,
    tokens_of: LookupMap<AccountId, Vec<TokenId>>,
    juries: LookupMap<u64, Vec<TokenId>>,
    open_juries: BTreeMap<u64, u32>,
    earning: u32,
    close_grace_ns: u64,
    reconcile_wait_ns: u64,
    last_tick: u64,
    next_to_finalize: u32,
    quarters: LookupMap<u32, VersionedQuarterBook>,
    seat_weight: LookupMap<(u32, TokenId, AccountId), u64>,
    forfeits: LookupMap<(u32, TokenId, AccountId), u64>,
    claims: LookupMap<(u32, TokenId, AccountId), VersionedClaim>,
    received: LookupMap<(AccountId, u64), VersionedReceived>,
    total_received: u128,
    total_paid: u128,
    pending_total: u128,
    open_pool: u128,
    final_pool: u128,
    rolled_total: u128,
    unstakes_in_flight: u32,
}

// Exact layout of state version 3, which did not count unstakes in flight.
#[near(serializers=[borsh])]
struct StateV3 {
    state_version: u16,
    upgrade_proven: bool,
    upgrade_in_flight: bool,
    owner: AccountId,
    pending_owner: Option<AccountId>,
    oracle: AccountId,
    nft_contract: Option<AccountId>,
    allowed_markets: Vec<AccountId>,
    verifier: AccountId,
    collateral_token_id: String,
    cooldown_ns: u64,
    max_seats_per_account: u32,
    allowlist_enabled: bool,
    allowed_tokens: LookupSet<(AccountId, TokenId)>,
    allowed_range: Option<(AccountId, u64, u64)>,
    staked: Vector<TokenId>,
    stakes: LookupMap<TokenId, VersionedStake>,
    seats_of: LookupMap<AccountId, u32>,
    tokens_of: LookupMap<AccountId, Vec<TokenId>>,
    juries: LookupMap<u64, Vec<TokenId>>,
    open_juries: BTreeMap<u64, u32>,
    earning: u32,
    close_grace_ns: u64,
    reconcile_wait_ns: u64,
    last_tick: u64,
    next_to_finalize: u32,
    quarters: LookupMap<u32, VersionedQuarterBook>,
    seat_weight: LookupMap<(u32, TokenId, AccountId), u64>,
    forfeits: LookupMap<(u32, TokenId, AccountId), u64>,
    claims: LookupMap<(u32, TokenId, AccountId), VersionedClaim>,
    received: LookupMap<(AccountId, u64), VersionedReceived>,
    total_received: u128,
    total_paid: u128,
    pending_total: u128,
    open_pool: u128,
    final_pool: u128,
    rolled_total: u128,
}

impl From<StateV3> for CouncilContract {
    fn from(old: StateV3) -> Self {
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: old.upgrade_proven,
            upgrade_in_flight: old.upgrade_in_flight,
            owner: old.owner,
            pending_owner: old.pending_owner,
            oracle: old.oracle,
            nft_contract: old.nft_contract,
            allowed_markets: old.allowed_markets,
            verifier: old.verifier,
            collateral_token_id: old.collateral_token_id,
            cooldown_ns: old.cooldown_ns,
            max_seats_per_account: old.max_seats_per_account,
            allowlist_enabled: old.allowlist_enabled,
            allowed_tokens: old.allowed_tokens,
            allowed_range: old.allowed_range,
            staked: old.staked,
            stakes: old.stakes,
            seats_of: old.seats_of,
            tokens_of: old.tokens_of,
            juries: old.juries,
            open_juries: old.open_juries,
            earning: old.earning,
            close_grace_ns: old.close_grace_ns,
            reconcile_wait_ns: old.reconcile_wait_ns,
            last_tick: old.last_tick,
            next_to_finalize: old.next_to_finalize,
            quarters: old.quarters,
            seat_weight: old.seat_weight,
            forfeits: old.forfeits,
            claims: old.claims,
            received: old.received,
            total_received: old.total_received,
            total_paid: old.total_paid,
            pending_total: old.pending_total,
            open_pool: old.open_pool,
            final_pool: old.final_pool,
            rolled_total: old.rolled_total,
            unstakes_in_flight: 0,
            fresh: 0,
            rule_from_quarter: quarter_containing(env::block_timestamp()) + 1,
        }
    }
}

// The quarter in progress keeps the old rule, so no seat counted so far changes, and the next quarter starts the new one. Every
// seat staked before the migration is old enough for it, and a seat staked after it and before it ends still counts in this
// quarter. The cost is one quarter where a late seat earns as before.
impl From<StateV4> for CouncilContract {
    fn from(old: StateV4) -> Self {
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: old.upgrade_proven,
            upgrade_in_flight: old.upgrade_in_flight,
            owner: old.owner,
            pending_owner: old.pending_owner,
            oracle: old.oracle,
            nft_contract: old.nft_contract,
            allowed_markets: old.allowed_markets,
            verifier: old.verifier,
            collateral_token_id: old.collateral_token_id,
            cooldown_ns: old.cooldown_ns,
            max_seats_per_account: old.max_seats_per_account,
            allowlist_enabled: old.allowlist_enabled,
            allowed_tokens: old.allowed_tokens,
            allowed_range: old.allowed_range,
            staked: old.staked,
            stakes: old.stakes,
            seats_of: old.seats_of,
            tokens_of: old.tokens_of,
            juries: old.juries,
            open_juries: old.open_juries,
            earning: old.earning,
            close_grace_ns: old.close_grace_ns,
            reconcile_wait_ns: old.reconcile_wait_ns,
            last_tick: old.last_tick,
            next_to_finalize: old.next_to_finalize,
            quarters: old.quarters,
            seat_weight: old.seat_weight,
            forfeits: old.forfeits,
            claims: old.claims,
            received: old.received,
            total_received: old.total_received,
            total_paid: old.total_paid,
            pending_total: old.pending_total,
            open_pool: old.open_pool,
            final_pool: old.final_pool,
            rolled_total: old.rolled_total,
            unstakes_in_flight: old.unstakes_in_flight,
            fresh: 0,
            rule_from_quarter: quarter_containing(env::block_timestamp()) + 1,
        }
    }
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "council", "version": "1.0.0", "event": event, "data": data })
    ));
}

// Round i hashes seed, case key and i, and the first 8 bytes pick from the tokens left. A token whose owner
// is already on the jury is set aside, so the jury is distinct accounts. The same inputs always draw the
// same jury.
fn pick(mut candidates: Vec<(TokenId, AccountId)>, seed: &[u8], case_key: u64, n: u32) -> Vec<(TokenId, AccountId)> {
    let mut jury: Vec<(TokenId, AccountId)> = vec![];
    let mut round: u32 = 0;
    while jury.len() < n as usize && !candidates.is_empty() {
        let h = env::sha256_array([seed, &case_key.to_le_bytes(), &round.to_le_bytes()].concat());
        let mut first = [0u8; 8];
        first.copy_from_slice(&h[..8]);
        let index = u64::from_le_bytes(first) % candidates.len() as u64;
        let seat = candidates.swap_remove(index as usize);
        if !jury.iter().any(|(_, a)| *a == seat.1) {
            jury.push(seat);
        }
        round += 1;
    }
    // Running out of tokens means every eligible account is already on the jury.
    require!(
        jury.len() == n as usize,
        format!(
            "not enough seat holders to draw a jury: {} eligible, {} needed",
            jury.len(),
            n
        )
    );
    jury
}

#[near]
impl CouncilContract {
    // Only this account can run it, so a deploy and init batch signed by it is the one way in. The collection and the markets
    // are not arguments: the owner sets them with set_nft_contract and allow_market once they are known and verified.
    #[private]
    #[init]
    pub fn new(
        owner_id: AccountId,
        oracle_id: AccountId,
        verifier_id: AccountId,
        collateral_token_id: String,
        cooldown_ns: U64,
        max_seats_per_account: u32,
        allowlist_enabled: Option<bool>,
    ) -> Self {
        require!(cooldown_ns.0 > 0, "the cooldown must be positive");
        require!(
            max_seats_per_account > 0,
            "an account must be allowed at least one seat"
        );
        require!(
            collateral_token_id.starts_with(NEP141_PREFIX),
            "the collateral token id must look like nep141:<token>"
        );
        let now = env::block_timestamp();
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: false,
            upgrade_in_flight: false,
            owner: owner_id,
            pending_owner: None,
            oracle: oracle_id,
            nft_contract: None,
            allowed_markets: vec![],
            verifier: verifier_id,
            collateral_token_id,
            cooldown_ns: cooldown_ns.0,
            max_seats_per_account,
            allowlist_enabled: allowlist_enabled.unwrap_or(true),
            allowed_tokens: LookupSet::new(Key::Allowed),
            allowed_range: None,
            staked: Vector::new(Key::Staked),
            stakes: LookupMap::new(Key::Stakes),
            seats_of: LookupMap::new(Key::SeatsOf),
            tokens_of: LookupMap::new(Key::TokensOf),
            juries: LookupMap::new(Key::Juries),
            open_juries: BTreeMap::new(),
            earning: 0,
            close_grace_ns: DEFAULT_CLOSE_GRACE_NS,
            reconcile_wait_ns: DEFAULT_RECONCILE_WAIT_NS,
            last_tick: now,
            next_to_finalize: quarter_containing(now),
            quarters: LookupMap::new(Key::Quarters),
            seat_weight: LookupMap::new(Key::SeatWeight),
            forfeits: LookupMap::new(Key::Forfeits),
            claims: LookupMap::new(Key::Claims),
            received: LookupMap::new(Key::Received),
            total_received: 0,
            total_paid: 0,
            pending_total: 0,
            open_pool: 0,
            final_pool: 0,
            rolled_total: 0,
            unstakes_in_flight: 0,
            fresh: 0,
            rule_from_quarter: 0,
        }
    }

    // Anyone can stage a wasm: the call input is the code, the deposit pays for its storage and the answer is its hash.
    #[payable]
    pub fn stage_code(&mut self) -> Base58CryptoHash {
        let staged = upgrade::stage_code();
        emit(
            "code_staged",
            json!({ "code_hash": staged.code_hash, "bytes": staged.bytes.to_string(), "by": staged.by }),
        );
        staged.code_hash
    }

    // Owner only, which is the DAO. SputnikDAO executes a proposal in the call of the approval that reaches its threshold,
    // so the DAO's voting period is the only delay a code change waits out (decided 2026-10-21). Staking, unstaking and
    // claiming never pause. The deploy and migrate are one batch: a migrate that panics puts the old code back. Attach at
    // least 100 TGas.
    pub fn upgrade(&mut self, code_hash: Base58CryptoHash) -> Promise {
        upgrade::require_upgrade_gas();
        self.only_owner();
        let code = upgrade::take_staged(code_hash);
        self.upgrade_in_flight = true;
        emit("upgrade_sent", json!({ "code_hash": code_hash }));
        upgrade::deploy_and_migrate(code).then(
            Self::ext(env::current_account_id())
                .with_static_gas(upgrade::GAS_UPGRADE_DONE)
                .on_upgrade_done(),
        )
    }

    // A batch that fails leaves the old code and the flag `upgrade` set. Cleared here, so nobody can call migrate by hand to
    // fake the proof that lets the owner seal a contract whose upgrade path never worked.
    #[private]
    pub fn on_upgrade_done(&mut self, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.upgrade_in_flight = false;
            emit("upgrade_failed", json!({}));
        }
    }

    // Runs in the new code, in the same batch as the deploy. It reads the one layout it was written for. A later version
    // keeps a copy of this struct as StateV1, reads that, builds its own state from it and bumps state_version.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let bytes = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("there is no state to migrate"));
        require!(bytes.len() >= 2, "invalid state");
        let mut state: Self = match u16::from_le_bytes([bytes[0], bytes[1]]) {
            STATE_VERSION => env::state_read().unwrap_or_else(|| env::panic_str("invalid current state")),
            4 => Self::from(env::state_read::<StateV4>().unwrap_or_else(|| env::panic_str("invalid previous state"))),
            3 => Self::from(env::state_read::<StateV3>().unwrap_or_else(|| env::panic_str("invalid previous state"))),
            _ => env::panic_str("unsupported state version"),
        };
        require!(state.upgrade_in_flight, "migrate runs only inside an upgrade");
        state.upgrade_in_flight = false;
        state.upgrade_proven = true;
        emit("migrated", json!({ "state_version": state.state_version }));
        state
    }

    // Deletes one access key of this account, for good if it is the last. Refused until an upgrade has gone through.
    pub fn seal(&mut self, public_key: PublicKey) -> Promise {
        self.only_owner();
        require!(self.upgrade_proven, "prove the upgrade path before deleting keys");
        emit("seal_sent", json!({ "public_key": public_key }));
        upgrade::delete_key(public_key)
    }

    // Seal deletes NEAR access keys only. A key registered for this account in the Intents verifier can still move everything it
    // holds, so the owner removes one here, as this account, the way the verifier requires.
    pub fn remove_verifier_key(&mut self, public_key: PublicKey) -> Promise {
        self.only_owner();
        emit("verifier_key_removal_sent", json!({ "public_key": public_key }));
        ext_verifier::ext(self.verifier.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_REMOVE_VERIFIER_KEY)
            .remove_public_key(public_key)
    }

    // Two steps, so a mistyped account cannot lock the owner out: nothing changes until the new owner accepts.
    pub fn propose_owner(&mut self, new_owner: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        emit("owner_proposed", json!({ "owner": self.owner, "proposed": new_owner }));
        self.pending_owner = Some(new_owner);
    }

    pub fn accept_owner(&mut self) {
        let who = env::predecessor_account_id();
        require!(self.pending_owner.as_ref() == Some(&who), "not the proposed owner");
        emit("owner_changed", json!({ "from": self.owner, "to": who }));
        self.owner = who;
        self.pending_owner = None;
    }

    // Applies to every unstake from now on, including ones already requested, which wait out the new length.
    pub fn set_cooldown_ns(&mut self, cooldown_ns: U64) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(
            (1..=MAX_COOLDOWN_NS).contains(&cooldown_ns.0),
            "the cooldown must be positive and at most a year"
        );
        emit("cooldown_set", json!({ "cooldown_ns": cooldown_ns.0.to_string() }));
        self.cooldown_ns = cooldown_ns.0;
    }

    pub fn set_max_seats_per_account(&mut self, max_seats_per_account: u32) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(
            max_seats_per_account > 0,
            "an account must be allowed at least one seat"
        );
        emit(
            "max_seats_per_account_set",
            json!({ "max_seats_per_account": max_seats_per_account }),
        );
        self.max_seats_per_account = max_seats_per_account;
    }

    // How long a finished quarter waits before it can be finalized and claimed. It applies to every quarter not final yet.
    pub fn set_close_grace_ns(&mut self, close_grace_ns: U64) {
        self.only_owner();
        require!(
            (MIN_CLOSE_GRACE_NS..=MAX_CLOSE_GRACE_NS).contains(&close_grace_ns.0),
            format!(
                "the grace period must be between {} and {} days",
                MIN_CLOSE_GRACE_NS / NS_PER_DAY,
                MAX_CLOSE_GRACE_NS / NS_PER_DAY
            )
        );
        emit(
            "close_grace_set",
            json!({ "close_grace_ns": close_grace_ns.0.to_string() }),
        );
        self.close_grace_ns = close_grace_ns.0;
    }

    // How long a claim must be pending before the owner can decide it by hand. It applies to every claim from now on.
    pub fn set_reconcile_wait_ns(&mut self, reconcile_wait_ns: U64) {
        self.only_owner();
        require!(
            (MIN_RECONCILE_WAIT_NS..=MAX_RECONCILE_WAIT_NS).contains(&reconcile_wait_ns.0),
            "the reconcile wait must be between 10 minutes and 7 days"
        );
        emit(
            "reconcile_wait_set",
            json!({ "reconcile_wait_ns": reconcile_wait_ns.0.to_string() }),
        );
        self.reconcile_wait_ns = reconcile_wait_ns.0;
    }

    // A market account whose sweeps count as revenue. Revenue and claims refuse until one is allowed.
    pub fn allow_market(&mut self, market: AccountId) {
        self.only_owner();
        require!(!self.allowed_markets.contains(&market), "already an allowed market");
        emit("market_allowed", json!({ "market": market }));
        self.allowed_markets.push(market);
    }

    // Stops revenue from that market account. Sweeps it already sent stay in the books. The last one cannot be removed,
    // because claims need a configured Council and a stranded quarter could then never be paid out.
    pub fn disallow_market(&mut self, market: AccountId) {
        self.only_owner();
        let at = self
            .allowed_markets
            .iter()
            .position(|m| *m == market)
            .unwrap_or_else(|| env::panic_str("not an allowed market"));
        require!(self.allowed_markets.len() > 1, "keep at least one allowed market");
        emit("market_disallowed", json!({ "market": market }));
        self.allowed_markets.remove(at);
    }

    // Stakes are keyed by token id alone, so the collection can only change while nothing is staked. The allowlist stays
    // as it is and applies only to the collection it was made for: the owner names the new collection's tokens again.
    pub fn set_nft_contract(&mut self, nft_contract: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(
            self.staked.is_empty(),
            "unstake every seat before changing the NFT contract"
        );
        require!(
            self.unstakes_in_flight == 0,
            "an unstake is still waiting for its NFT transfer"
        );
        emit("nft_contract_set", json!({ "nft_contract": nft_contract }));
        self.nft_contract = Some(nft_contract);
    }

    // Adds token ids to the allowlist, at most MAX_ALLOW_BATCH a call. Naming one twice changes nothing. A token already
    // staked stays staked if the allowlist is later switched on or the collection changes.
    pub fn allow_tokens(&mut self, token_ids: Vec<TokenId>) {
        self.only_owner();
        require!(!token_ids.is_empty(), "name at least one token");
        require!(token_ids.len() <= MAX_ALLOW_BATCH, "at most 100 tokens in one call");
        let collection = self.collection().clone();
        for token_id in &token_ids {
            self.allowed_tokens.insert((collection.clone(), token_id.clone()));
        }
        emit(
            "tokens_allowed",
            json!({ "nft_contract": collection, "token_ids": token_ids }),
        );
    }

    // For a collection whose ids are decimal numbers: every id from `first` to `last`, both included, is allowed. It
    // is for the current collection and replaces any earlier range.
    pub fn set_token_range(&mut self, first: U64, last: U64) {
        self.only_owner();
        require!(first.0 <= last.0, "the first id must not be above the last");
        let collection = self.collection().clone();
        self.allowed_range = Some((collection.clone(), first.0, last.0));
        emit(
            "token_range_set",
            json!({ "nft_contract": collection, "first": first.0.to_string(), "last": last.0.to_string() }),
        );
    }

    pub fn clear_token_range(&mut self) {
        self.only_owner();
        self.allowed_range = None;
        emit("token_range_cleared", json!({}));
    }

    // Off lets any token of the collection stake. It does not unstake anything when switched on.
    pub fn set_allowlist_enabled(&mut self, enabled: bool) {
        self.only_owner();
        self.allowlist_enabled = enabled;
        emit("allowlist_set", json!({ "enabled": enabled }));
    }

    // A draw marks the jury as serving. The seed is the block seed of the receipt that runs this call, so nobody can
    // know it when the call is sent, and it depends on nothing the caller passes. A repeat draw for the same case
    // returns the same jury, so retrying after a failed callback cannot reroll it.
    pub fn draw(&mut self, case_key: U64, n: u32, exclude: Vec<AccountId>) -> Vec<AccountId> {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        if let Some(tokens) = self.juries.get(&case_key.0) {
            return tokens.iter().map(|t| self.stakes[t].owner.clone()).collect();
        }
        let now = env::block_timestamp();
        let eligible: Vec<(TokenId, AccountId, bool)> = self
            .staked
            .iter()
            .filter_map(|t| {
                let s = &self.stakes[t];
                // A seat on its way out is not available to serve, so it cannot be drawn and then be stuck waiting.
                (s.serving.is_none() && s.unlock_requested_at.is_none() && !exclude.contains(&s.owner)).then(|| {
                    (
                        t.clone(),
                        s.owner.clone(),
                        now >= s.staked_at.0.saturating_add(self.cooldown_ns),
                    )
                })
            })
            .collect();
        // Seats staked within the last cooldown are set aside, so nobody can load the pool after seeing a challenge. When the
        // older seats cannot make a jury on their own, all of them are drawn from and a thin Council still works.
        let aged: Vec<(TokenId, AccountId)> = eligible
            .iter()
            .filter(|c| c.2)
            .map(|c| (c.0.clone(), c.1.clone()))
            .collect();
        let aged_owners = aged
            .iter()
            .map(|c| &c.1)
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        let candidates = if aged_owners >= n as usize {
            aged
        } else {
            eligible.into_iter().map(|c| (c.0, c.1)).collect()
        };
        let jury = pick(candidates, &env::random_seed_array(), case_key.0, n);
        for (t, _) in &jury {
            let stake = self.stakes.get_mut(t).unwrap();
            stake.serving = Some(case_key);
            stake.serving_from = now;
        }
        if !jury.is_empty() {
            *self.open_juries.entry(now).or_insert(0) += 1;
        }
        let (tokens, owners): (Vec<TokenId>, Vec<AccountId>) = jury.into_iter().unzip();
        emit(
            "jury_drawn",
            json!({ "case_key": case_key.0.to_string(), "tokens": tokens, "owners": owners }),
        );
        self.juries.insert(case_key.0, tokens);
        owners
    }

    // Called by the oracle once a case is final, with the jurors who never voted. A juror on that list loses the seat time
    // from the draw to now, in every quarter that is not final yet: it leaves the seat's weight and the quarter's total, so
    // the other seats' shares rise. A quarter already final is left alone. Nothing here can fail for want of work to do, so
    // a case is always released. A second call for the same case does nothing, so nobody is penalised twice.
    pub fn unlock_case(&mut self, case_key: U64, delinquent: Vec<AccountId>) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        let now = env::block_timestamp();
        let released = self.juries.remove(&case_key.0);
        if released.is_some() {
            emit(
                "jury_released",
                json!({ "case_key": case_key.0.to_string(), "delinquent": delinquent }),
            );
        }
        let jury = released.unwrap_or_default();
        if let Some(drawn_at) = jury.first().and_then(|t| self.stakes.get(t)).map(|s| s.serving_from) {
            self.close_open_jury(drawn_at);
        }
        for t in jury {
            let Some(s) = self.stakes.get_mut(&t) else { continue };
            let (owner, from, staked_at) = (s.owner.clone(), s.serving_from.max(s.staked_at.0), s.staked_at.0);
            s.serving = None;
            s.serving_from = 0;
            if delinquent.contains(&owner) {
                self.forfeit_serving_time(&t, &owner, case_key.0, (from, staked_at), now);
            }
        }
    }

    pub fn request_unstake(&mut self, token_id: TokenId) {
        let stake = self.callers_stake(&token_id);
        require!(stake.unlock_requested_at.is_none(), "unstake already requested");
        require!(stake.serving.is_none(), "this seat is serving on an open case");
        let owner = stake.owner.clone();
        let now = env::block_timestamp();
        // The seat's time stops here, so everything up to now is counted before the request is written.
        self.tick(now);
        self.book_stake(&token_id, now, MAX_QUARTER_STEPS);
        require!(self.stakes[&token_id].booked_to.0 >= now, "book this seat first");
        self.earning -= 1;
        if self.is_fresh(self.stakes[&token_id].staked_at.0, quarter_containing(now)) {
            self.fresh -= 1;
        }
        self.stakes.get_mut(&token_id).unwrap().unlock_requested_at = Some(U64(now));
        emit(
            "unstake_requested",
            json!({ "token_id": token_id, "owner": owner, "unlock_at": (now + self.cooldown_ns).to_string() }),
        );
    }

    // Returns the NFT and nothing else. What the seat earned stays claimable by quarter, so leaving never touches reward money.
    // The seat's time stopped at its request and was counted then, so nothing is left to count here.
    #[payable]
    pub fn unstake(&mut self, token_id: TokenId) -> Promise {
        upgrade::require_gas(GAS_UNSTAKE_FLOOR, "an unstake returns the NFT and then settles it");
        assert_one_yocto();
        let stake = self.callers_stake(&token_id).clone();
        let requested = stake
            .unlock_requested_at
            .unwrap_or_else(|| env::panic_str("request an unstake first"));
        let now = env::block_timestamp();
        require!(now >= requested.0 + self.cooldown_ns, "the cooldown has not passed");
        require!(stake.serving.is_none(), "this seat is serving on an open case");
        // Remove it before the transfer; restore it in a callback if the transfer fails.
        let stake = self.remove_stake(&token_id);
        self.unstakes_in_flight += 1;
        self.return_nft(token_id, stake)
    }

    #[private]
    pub fn on_unstaked(
        &mut self,
        token_id: TokenId,
        stake: Stake,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let data = json!({ "token_id": token_id, "owner": stake.owner });
        self.unstakes_in_flight = self.unstakes_in_flight.saturating_sub(1);
        if result.is_ok() {
            emit("unstaked", data);
        } else {
            self.restore_stake(token_id, stake);
            emit("unstake_failed", data);
        }
    }

    // Moves seat time forward towards now, across at most `max_steps` quarters (and never more than eight), so a stake or an
    // unstake after a long idle stretch does not have to. Returns the quarters it moved across.
    pub fn advance_quarters(&mut self, max_steps: Option<u32>) -> u32 {
        let steps = max_steps.unwrap_or(MAX_QUARTER_STEPS).min(MAX_QUARTER_STEPS);
        let moved = self.advance_seat_time(env::block_timestamp(), steps);
        emit("quarters_advanced", json!({ "steps": moved }));
        moved
    }

    // Counts the staked time of a seat from where it was last counted up to now, across at most `max_quarters` quarters. It is
    // needed only for a seat held more than eight quarters without an unstake or a claim. Returns the quarters it counted.
    pub fn book_seat_time(&mut self, token_id: TokenId, max_quarters: Option<u32>) -> u32 {
        require!(self.stakes.contains_key(&token_id), "not staked");
        let steps = max_quarters.unwrap_or(MAX_QUARTER_STEPS).min(MAX_QUARTER_STEPS);
        let quarters = self.book_stake(&token_id, env::block_timestamp(), steps);
        emit(
            "seat_time_booked",
            json!({ "token_id": token_id, "quarters": quarters }),
        );
        quarters
    }

    // Fixes a quarter's pool and total seat time once the grace period after its end has passed, so claims can open. Quarters
    // finalize in order. A quarter with no seat time moves its pool into the next quarter, and nobody can claim from it.
    pub fn finalize_quarter(&mut self, quarter: u32) {
        require!(quarter >= self.next_to_finalize, "that quarter is already final");
        require!(quarter == self.next_to_finalize, "finalize the earlier quarter first");
        let end = quarter_end(quarter);
        require!(
            env::block_timestamp() >= end.saturating_add(self.close_grace_ns),
            "the quarter cannot be finalized yet"
        );
        require!(
            self.open_juries.keys().next().is_none_or(|drawn| *drawn >= end)
                || env::block_timestamp() >= end.saturating_add(MAX_CLOSE_GRACE_NS),
            "a jury drawn in this quarter is still open"
        );
        self.tick(end);
        let mut book = self.book(quarter);
        let pool = book.revenue_in + book.carry_in;
        let weight_total = book.seat_ns - book.forfeit_ns;
        book.finalized = true;
        book.pool = pool;
        book.weight_total = weight_total;
        self.open_pool -= pool;
        if weight_total == 0 {
            let mut next = self.book(quarter + 1);
            next.carry_in += pool;
            self.put_book(quarter + 1, next);
            book.rolled_to = Some(quarter + 1);
            self.open_pool += pool;
            self.rolled_total += pool;
        } else {
            self.final_pool += pool;
        }
        self.put_book(quarter, book);
        self.next_to_finalize += 1;
        emit(
            "quarter_finalized",
            json!({ "quarter": quarter, "pool": pool.to_string(), "weight_ns": weight_total.to_string(),
                    "rolled_to": (weight_total == 0).then_some(quarter + 1) }),
        );
    }

    // Pays the caller's share of a finalized quarter for one token, once. The share is the pool times the seat's staked time
    // in the quarter over all seat time of the quarter, rounded down. The record is written before the payout is sent and a
    // failed payout deletes it, so a failure can be retried and a success cannot be claimed twice.
    #[payable]
    pub fn claim_quarter(&mut self, quarter: u32, token_id: TokenId) -> Promise {
        upgrade::require_gas(GAS_CLAIM_FLOOR, "a claim sends the payout and then settles it");
        assert_one_yocto();
        self.require_configured();
        let who = env::predecessor_account_id();
        let mut book = self
            .quarters
            .get(&quarter)
            .filter(|b| b.finalized)
            .map(|b| b.clone().into_inner())
            .unwrap_or_else(|| env::panic_str("that quarter is not final"));
        let key = (quarter, token_id.clone(), who.clone());
        if let Some(claim) = self.claims.get(&key) {
            match claim.status {
                ClaimStatus::Pending => env::panic_str("claim is already pending"),
                ClaimStatus::Paid => env::panic_str("already claimed"),
            }
        }
        let end = quarter_end(quarter);
        if let Some(until) = self
            .stakes
            .get(&token_id)
            .filter(|s| s.owner == who)
            .map(|s| counted_until(s, end))
            .filter(|until| self.stakes[&token_id].booked_to.0 < *until)
        {
            self.book_stake(&token_id, end, MAX_QUARTER_STEPS);
            require!(self.stakes[&token_id].booked_to.0 >= until, "book this seat first");
        }
        let amount = entitlement(book.pool, self.booked_weight(&key), book.weight_total);
        require!(amount > 0, "nothing to claim");
        let now = env::block_timestamp();
        self.claims.insert(
            key,
            VersionedClaim::current(Claim {
                amount,
                status: ClaimStatus::Pending,
                requested_at: now,
                paid_at: None,
            }),
        );
        book.pending += amount;
        self.pending_total += amount;
        self.put_book(quarter, book);
        emit(
            "claim_requested",
            json!({ "quarter": quarter, "token_id": token_id, "owner": who, "amount": amount.to_string(),
                    "requested_at": now.to_string() }),
        );
        self.pay(&who, amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_claim_paid(quarter, token_id, who, U64(now)),
        )
    }

    // mt_transfer returns nothing and is one verifier receipt, so an error means the payout did not happen (paused, locked,
    // out of gas) and the seat can claim again. A claim that is already paid or no longer pending is left alone.
    #[private]
    pub fn on_claim_paid(
        &mut self,
        quarter: u32,
        token_id: TokenId,
        owner: AccountId,
        requested_at: U64,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let key = (quarter, token_id.clone(), owner.clone());
        let Some(claim) = self.claims.get(&key).map(|c| c.clone().into_inner()) else {
            return;
        };
        if claim.status != ClaimStatus::Pending || claim.requested_at != requested_at.0 {
            return;
        }
        let paid = result.is_ok();
        let data = self.close_claim(quarter, token_id, owner, claim, paid);
        emit(if paid { "claim_paid" } else { "claim_failed" }, data);
    }

    // The owner's decision about a claim whose payout callback never arrived, so it stays pending and refuses every retry. It
    // needs an hour after the claim, which leaves the callback time to land, and the owner checks the verifier's events first:
    // `paid` true books the payout as made, false deletes the record so the seat can claim again. A callback that comes later
    // finds no pending claim and changes nothing.
    pub fn reconcile_claim(&mut self, quarter: u32, token_id: TokenId, owner: AccountId, paid: bool) {
        self.only_owner();
        let key = (quarter, token_id.clone(), owner.clone());
        let claim = self
            .claims
            .get(&key)
            .filter(|c| c.status == ClaimStatus::Pending)
            .map(|c| c.clone().into_inner())
            .unwrap_or_else(|| env::panic_str("no claim is pending for that seat"));
        require!(
            env::block_timestamp() >= claim.requested_at.saturating_add(self.reconcile_wait_ns),
            &format!(
                "wait {} minutes after the claim before reconciling",
                self.reconcile_wait_ns / (60 * NS_PER_SEC)
            )
        );
        let mut data = self.close_claim(quarter, token_id, owner, claim, paid);
        data["paid"] = json!(paid);
        emit("claim_reconciled", data);
    }

    // Takes a pending claim out of the in-flight totals and either books it as paid or deletes the record. Both the payout
    // callback and reconcile_claim end a claim here, so the two cannot disagree about the books. Returns the event data.
    fn close_claim(
        &mut self,
        quarter: u32,
        token_id: TokenId,
        owner: AccountId,
        claim: Claim,
        paid: bool,
    ) -> near_sdk::serde_json::Value {
        let key = (quarter, token_id.clone(), owner.clone());
        let mut book = self.book(quarter);
        book.pending -= claim.amount;
        self.pending_total -= claim.amount;
        let data = json!({ "quarter": quarter, "token_id": token_id, "owner": owner, "amount": claim.amount.to_string(),
                           "requested_at": claim.requested_at.to_string() });
        if paid {
            book.paid += claim.amount;
            self.total_paid += claim.amount;
            self.claims.insert(
                key,
                VersionedClaim::current(Claim {
                    status: ClaimStatus::Paid,
                    paid_at: Some(env::block_timestamp()),
                    ..claim
                }),
            );
        } else {
            self.claims.remove(&key);
        }
        self.put_book(quarter, book);
        data
    }

    // Called by the verifier after an mt_transfer_call, once the money is already in this contract's Intents account. The
    // message is "revenue:<sweep id>" and only an allowed market may send it. The money belongs to the quarter it arrives in,
    // and a sweep id is taken once per market, so a repeated send is refused and the verifier gives it back. The answer is the amounts to hand
    // back, so 0 keeps everything. Panicking makes the verifier refund the sender in full. A plain deposit never reaches
    // here: it sits in the account as surplus and is never counted.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128> {
        require!(
            env::predecessor_account_id() == self.verifier,
            "only the verifier can deliver money"
        );
        require!(
            previous_owner_ids.as_slice() == [sender_id.clone()],
            "the money must come from the sender's own balance"
        );
        require!(
            token_ids.len() == 1 && amounts.len() == 1,
            "exactly one token and amount"
        );
        require!(token_ids[0] == self.collateral_token_id, "wrong token");
        self.require_configured();
        let sweep_id: u64 = msg
            .strip_prefix(REVENUE_PREFIX)
            .and_then(|id| id.parse().ok())
            .unwrap_or_else(|| env::panic_str("unknown action"));
        require!(
            self.allowed_markets.contains(&sender_id),
            "revenue comes from an allowed market only"
        );
        let received_key = (sender_id.clone(), sweep_id);
        require!(
            !self.received.contains_key(&received_key),
            "that sweep was already received"
        );
        let amount = amounts[0].0;
        let at = env::block_timestamp();
        let quarter = quarter_containing(at);
        let mut book = self.book(quarter);
        book.revenue_in += amount;
        self.put_book(quarter, book);
        self.received.insert(
            received_key,
            VersionedReceived::current(Received { amount, quarter, at }),
        );
        self.total_received += amount;
        self.open_pool += amount;
        emit(
            "revenue",
            json!({ "from": sender_id, "market": sender_id, "amount": amount.to_string(), "sweep_id": sweep_id.to_string(),
                    "quarter": quarter, "seats": self.staked.len() }),
        );
        vec![U128(0)]
    }

    // ---- views ----------------------------------------------------------------------------

    // All revenue tokens this registry has taken in over its life, whether claimed yet or not.
    pub fn total_received(&self) -> U128 {
        U128(self.total_received)
    }

    // What a market sent under a sweep id, or null if this registry never took that sweep in. The market reads it with its own
    // account id to settle a transfer whose result it lost.
    pub fn received_of(&self, market: AccountId, sweep_id: U64) -> Option<ReceivedView> {
        self.received
            .get(&(market, sweep_id.0))
            .map(|r| r.clone().into_inner())
            .map(|r| ReceivedView {
                amount: U128(r.amount),
                quarter: r.quarter,
                at: U64(r.at),
            })
    }

    // total_received less total_paid less the claims in flight is the least this contract's Intents account must hold. The
    // account holds more by the rounding left in finalized quarters and by any plain deposit.
    pub fn reward_totals(&self) -> RewardTotals {
        RewardTotals {
            total_received: U128(self.total_received),
            total_paid: U128(self.total_paid),
            pending_claims: U128(self.pending_total),
            open_pool: U128(self.open_pool),
            final_unclaimed: U128(self.final_pool - self.total_paid - self.pending_total),
            rolled: U128(self.rolled_total),
        }
    }

    pub fn seat_count(&self) -> u32 {
        self.staked.len()
    }

    // The seats still held for a case. Empty once the oracle has released it, so a settled dispute that still lists
    // seats here is one whose unlock failed and needs retry_unlock.
    pub fn jury_of(&self, case_key: U64) -> Vec<TokenId> {
        self.juries.get(&case_key.0).cloned().unwrap_or_default()
    }

    // Whether this token could be staked now.
    pub fn is_allowed(&self, token_id: TokenId) -> bool {
        !self.allowlist_enabled || self.on_allowlist(&token_id)
    }

    pub fn is_seat(&self, account_id: AccountId) -> bool {
        self.seats_of.contains_key(&account_id)
    }

    // The tokens this account has staked now.
    pub fn seats_of(&self, account_id: AccountId) -> Vec<TokenId> {
        self.tokens_of
            .get(&account_id)
            .into_iter()
            .flatten()
            .filter(|t| self.stakes.get(*t).is_some_and(|s| s.owner == account_id))
            .cloned()
            .collect()
    }

    pub fn staked_tokens(&self, from_index: u32, limit: u32) -> Vec<TokenId> {
        self.staked
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    pub fn stake_of(&self, token_id: TokenId) -> Option<Stake> {
        self.stakes.get(&token_id).map(|s| s.clone().into_inner())
    }

    pub fn current_quarter(&self) -> QuarterView {
        self.quarter_view(quarter_containing(env::block_timestamp()))
    }

    // Null for a quarter that has not started.
    pub fn get_quarter(&self, quarter: u32) -> Option<QuarterView> {
        (quarter <= quarter_containing(env::block_timestamp())).then(|| self.quarter_view(quarter))
    }

    // From `from_quarter` up to the current one, at most 50. A quarter with no activity shows empty.
    pub fn list_quarters(&self, from_quarter: u32, limit: u32) -> Vec<QuarterView> {
        let last = quarter_containing(env::block_timestamp());
        (from_quarter..=last)
            .take(limit.min(MAX_VIEW_QUARTERS) as usize)
            .map(|q| self.quarter_view(q))
            .collect()
    }

    pub fn quarter_of(&self, at: U64) -> QuarterLabel {
        let quarter = quarter_containing(at.0);
        QuarterLabel {
            quarter,
            label: quarter_label(quarter),
            starts_at: U64(quarter_start(quarter)),
            ends_at: U64(quarter_end(quarter)),
        }
    }

    // What one token earned for one owner in one quarter, or null if it earned nothing there. While the quarter is not final
    // the amount is a guess that later revenue and later seat time still move, and `estimated` says so.
    pub fn get_entitlement(&self, quarter: u32, token_id: TokenId, account_id: AccountId) -> Option<EntitlementView> {
        self.entitlement_view(quarter, &token_id, &account_id)
    }

    // The entitlements of every token the account has staked, for `limit` quarters from `from_quarter` (at most 25, fewer for an
    // account with many tokens), oldest first. A token and quarter with nothing earned is left out.
    pub fn entitlements_of(&self, account_id: AccountId, from_quarter: u32, limit: u32) -> Vec<EntitlementView> {
        let last = quarter_containing(env::block_timestamp());
        let tokens = self.tokens_of.get(&account_id).cloned().unwrap_or_default();
        (from_quarter..=last)
            .take(entitlement_page(limit, tokens.len()))
            .flat_map(|q| tokens.iter().map(move |t| (q, t)))
            .filter_map(|(q, t)| self.entitlement_view(q, t, &account_id))
            .collect()
    }

    pub fn entitlements_page_quarters(&self, account_id: AccountId) -> u32 {
        let tokens = self.tokens_of.get(&account_id).map_or(0, Vec::len);
        entitlement_page(MAX_ENTITLEMENT_QUARTERS, tokens) as u32
    }

    // Whether a wasm with this sha256 is staged here, for the members to check before they vote to deploy it.
    pub fn is_staged(&self, code_hash: Base58CryptoHash) -> bool {
        upgrade::is_staged(code_hash)
    }

    // nft_contract is null until the owner sets it, and markets is empty until the owner allows one.
    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "state_version": self.state_version, "upgrade_proven": self.upgrade_proven, "upgrade_in_flight": self.upgrade_in_flight,
                "owner": self.owner, "pending_owner": self.pending_owner, "oracle": self.oracle, "nft_contract": self.nft_contract,
                "markets": self.allowed_markets, "verifier": self.verifier, "collateral_token_id": self.collateral_token_id,
                "cooldown_ns": self.cooldown_ns.to_string(), "close_grace_ns": self.close_grace_ns.to_string(),
                "reconcile_wait_ns": self.reconcile_wait_ns.to_string(),
                "max_seats_per_account": self.max_seats_per_account, "allowlist_enabled": self.allowlist_enabled,
                "allowed_range": self.current_range().map(|(first, last)| json!({ "first": first.to_string(), "last": last.to_string() })),
                "total_received": self.total_received.to_string(), "next_to_finalize": self.next_to_finalize,
                "last_tick": self.last_tick.to_string() })
    }
}

#[near]
impl NonFungibleTokenReceiver for CouncilContract {
    // Staking. msg is ignored. The seat goes to previous_owner_id, who owned the token, not to sender_id,
    // which can be an approved marketplace. The seat is written in on_stake_checked once the collection confirms the owner.
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: TokenId,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (sender_id, msg);
        require!(
            env::predecessor_account_id() == *self.collection(),
            "wrong NFT contract"
        );
        require!(self.is_allowed(token_id.clone()), "that token is not on the allowlist");
        require!(!self.stakes.contains_key(&token_id), "already staked");
        require!(self.staked.len() < MAX_SEATS, "the council is full");
        let held = self.seats_of.get(&previous_owner_id).copied().unwrap_or(0);
        require!(
            held < self.max_seats_per_account,
            "that account already holds the most seats allowed"
        );
        upgrade::require_gas(
            GAS_STAKE_FLOOR,
            "a stake checks the token's owner and then records the seat",
        );
        PromiseOrValue::Promise(
            ext_nft_core::ext(env::predecessor_account_id())
                .with_static_gas(GAS_NFT_TOKEN_VIEW)
                .nft_token(token_id.clone())
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_STAKE_CALLBACK)
                        .on_stake_checked(token_id, previous_owner_id, env::predecessor_account_id()),
                ),
        )
    }
}

#[near]
impl CouncilContract {
    // Counts the seat only when the collection says this contract owns the token. The answer is true, which makes the collection
    // return the token to the previous owner, for anything else: a failed view, no such token, another owner, or a council that
    // changed while the view ran. A panic here has the same effect, so nothing but a confirmed owner ever counts.
    #[private]
    pub fn on_stake_checked(
        &mut self,
        token_id: TokenId,
        previous_owner_id: AccountId,
        collection: AccountId,
        #[callback_result] result: Result<Option<Token>, PromiseError>,
    ) -> bool {
        let owned = matches!(&result, Ok(Some(token)) if token.token_id == token_id && token.owner_id == env::current_account_id());
        let open = self.nft_contract.as_ref() == Some(&collection)
            && self.is_allowed(token_id.clone())
            && !self.stakes.contains_key(&token_id)
            && self.staked.len() < MAX_SEATS
            && self.seats_of.get(&previous_owner_id).copied().unwrap_or(0) < self.max_seats_per_account;
        if !owned || !open {
            emit(
                "stake_refused",
                json!({ "token_id": token_id, "owner": previous_owner_id, "owned": owned }),
            );
            return true;
        }
        let now = env::block_timestamp();
        self.tick(now);
        emit("staked", json!({ "token_id": token_id, "owner": previous_owner_id }));
        let stake = Stake {
            owner: previous_owner_id,
            staked_at: U64(now),
            unlock_requested_at: None,
            serving: None,
            booked_to: U64(now),
            serving_from: 0,
            index: 0,
        };
        self.insert_stake(token_id, stake);
        self.earning += 1;
        if self.is_fresh(now, quarter_containing(now)) {
            self.fresh += 1;
        }
        false
    }
}

impl CouncilContract {
    fn close_open_jury(&mut self, drawn_at: u64) {
        if let Some(open) = self.open_juries.get_mut(&drawn_at) {
            *open -= 1;
            if *open == 0 {
                self.open_juries.remove(&drawn_at);
            }
        }
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn collection(&self) -> &AccountId {
        self.nft_contract
            .as_ref()
            .unwrap_or_else(|| env::panic_str("the NFT collection is not set, the owner must call set_nft_contract"))
    }

    // Claims and revenue refuse until the owner has said which accounts send the revenue.
    fn require_configured(&self) {
        require!(
            !self.allowed_markets.is_empty(),
            "the Council is not configured, the owner must call allow_market"
        );
    }

    // An id counts as a number only in its plain decimal form, so "007" and "+7" are not the token "7".
    fn on_allowlist(&self, token_id: &TokenId) -> bool {
        let Some(collection) = &self.nft_contract else {
            return false;
        };
        let in_range = || {
            let (first, last) = self.current_range()?;
            let n: u64 = token_id.parse().ok()?;
            (n.to_string() == *token_id && (first..=last).contains(&n)).then_some(())
        };
        self.allowed_tokens.contains(&(collection.clone(), token_id.clone())) || in_range().is_some()
    }

    // The range, if it was set for the collection that is current now.
    fn current_range(&self) -> Option<(u64, u64)> {
        self.allowed_range
            .as_ref()
            .filter(|(collection, ..)| Some(collection) == self.nft_contract.as_ref())
            .map(|(_, first, last)| (*first, *last))
    }

    fn callers_stake(&mut self, token_id: &TokenId) -> &mut Stake {
        let stake = self
            .stakes
            .get_mut(token_id)
            .unwrap_or_else(|| env::panic_str("not staked"));
        require!(stake.owner == env::predecessor_account_id(), "not your seat");
        stake
    }

    fn insert_stake(&mut self, token_id: TokenId, mut stake: Stake) {
        stake.index = self.staked.len();
        *self.seats_of.entry(stake.owner.clone()).or_insert(0) += 1;
        let history = self.tokens_of.entry(stake.owner.clone()).or_default();
        if !history.contains(&token_id) {
            history.push(token_id.clone());
        }
        self.staked.push(token_id.clone());
        self.stakes.insert(token_id, VersionedStake::current(stake));
    }

    // The seat was not counted while it was out, so the time it was out is not booked. It keeps its request, so it does not
    // earn again and `earning` stays as it is. This runs in a callback that must not fail, so seat time moves as far as it can.
    fn restore_stake(&mut self, token_id: TokenId, mut stake: Stake) {
        self.advance_seat_time(env::block_timestamp(), MAX_QUARTER_STEPS);
        stake.booked_to = U64(self.last_tick);
        self.insert_stake(token_id, stake);
    }

    // Pays `amount` of the collateral to `to` inside the verifier. mt_transfer returns nothing, so an error in a callback means
    // the verifier's receipt failed (paused, locked, out of gas) and nothing moved. `to` is always the caller of a claim.
    // This is the only payout of reward money.
    fn pay(&self, to: &AccountId, amount: u128) -> Promise {
        ext_verifier::ext(self.verifier.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_MT_TRANSFER)
            .mt_transfer(to.clone(), self.collateral_token_id.clone(), U128(amount), None, None)
    }

    fn return_nft(&self, token_id: TokenId, stake: Stake) -> Promise {
        ext_nft_core::ext(self.collection().clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_NFT_TRANSFER)
            .nft_transfer(stake.owner.clone(), token_id.clone(), None, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_unstaked(token_id, stake),
            )
    }

    fn remove_stake(&mut self, token_id: &TokenId) -> Stake {
        let stake = self.stakes.remove(token_id).unwrap().into_inner();
        self.staked.swap_remove(stake.index);
        if let Some(moved) = self.staked.get(stake.index).cloned() {
            self.stakes.get_mut(&moved).unwrap().index = stake.index;
        }
        let left = self.seats_of[&stake.owner] - 1;
        if left == 0 {
            self.seats_of.remove(&stake.owner);
        } else {
            self.seats_of.insert(stake.owner.clone(), left);
        }
        stake
    }

    fn book(&self, quarter: u32) -> QuarterBook {
        self.quarters
            .get(&quarter)
            .map_or_else(QuarterBook::default, |b| b.clone().into_inner())
    }

    fn put_book(&mut self, quarter: u32, book: QuarterBook) {
        self.quarters.insert(quarter, VersionedQuarterBook::current(book));
    }

    // Adds the seat time of the staked seats from `last_tick` towards `to`, one quarter at a time, at most `max_steps`
    // quarters. It stops at a quarter's end, so `last_tick` is always a place the next call can carry on from.
    fn advance_seat_time(&mut self, to: u64, max_steps: u32) -> u32 {
        let mut steps = 0;
        while self.last_tick < to && steps < max_steps {
            let seats = u128::from(self.earning - self.fresh);
            let quarter = quarter_containing(self.last_tick);
            let until = quarter_end(quarter).min(to);
            if seats > 0 {
                let mut book = self.book(quarter);
                book.seat_ns += seats * u128::from(until - self.last_tick);
                self.put_book(quarter, book);
            }
            self.last_tick = until;
            if until == quarter_end(quarter) {
                self.fresh = 0;
            }
            steps += 1;
        }
        steps
    }

    // Whether a seat staked at `staked_at` adds nothing to `quarter` because the quarter began before it was staked.
    fn is_fresh(&self, staked_at: u64, quarter: u32) -> bool {
        quarter >= self.rule_from_quarter && staked_at > quarter_start(quarter)
    }

    // Must run before the seat count changes: the time since the last change belongs to the seats that were staked during it.
    fn tick(&mut self, to: u64) {
        self.advance_seat_time(to, MAX_QUARTER_STEPS);
        require!(self.last_tick >= to, "call advance_quarters first");
    }

    // Adds a seat's staked time from `booked_to` towards `to` to the quarters it covers, at most `max_steps` of them.
    fn book_stake(&mut self, token_id: &TokenId, to: u64, max_steps: u32) -> u32 {
        let Some(stake) = self.stakes.get(token_id) else {
            return 0;
        };
        let to = counted_until(stake, to);
        let (owner, mut at, staked_at) = (stake.owner.clone(), stake.booked_to.0, stake.staked_at.0);
        let mut steps = 0;
        while at < to && steps < max_steps {
            let quarter = quarter_containing(at);
            let until = quarter_end(quarter).min(to);
            if !self.is_fresh(staked_at, quarter) {
                let key = (quarter, token_id.clone(), owner.clone());
                let have = self.seat_weight.get(&key).copied().unwrap_or(0);
                self.seat_weight.insert(key, have + (until - at));
            }
            at = until;
            steps += 1;
        }
        self.stakes.get_mut(token_id).unwrap().booked_to = U64(at);
        steps
    }

    // A silent juror's serving time in each quarter it touched that is not final. Quarters past the eighth are not looked
    // at, so releasing a case never runs out of gas.
    fn forfeit_serving_time(&mut self, token_id: &TokenId, owner: &AccountId, case: u64, span: (u64, u64), to: u64) {
        let (from, staked_at) = span;
        let first = quarter_containing(from);
        for quarter in (first..first.saturating_add(MAX_QUARTER_STEPS)).take_while(|q| quarter_start(*q) < to) {
            let span = if self.is_fresh(staked_at, quarter) {
                0
            } else {
                overlap(quarter, from, to)
            };
            let mut book = self.book(quarter);
            if book.finalized {
                emit(
                    "forfeit_skipped",
                    json!({ "token_id": token_id, "owner": owner, "case": case.to_string(), "quarter": quarter }),
                );
            } else if span > 0 {
                let key = (quarter, token_id.clone(), owner.clone());
                let lost = self.forfeits.get(&key).copied().unwrap_or(0);
                self.forfeits.insert(key, lost + span);
                book.forfeit_ns += u128::from(span);
                self.put_book(quarter, book);
                emit(
                    "seat_time_forfeited",
                    json!({ "token_id": token_id, "owner": owner, "case": case.to_string(), "quarter": quarter,
                            "forfeited_ns": span.to_string() }),
                );
            }
        }
    }

    // The staked time already counted for one token and owner in a quarter, less what a silent juror lost.
    fn booked_weight(&self, key: &(u32, TokenId, AccountId)) -> u128 {
        let counted = self.seat_weight.get(key).copied().unwrap_or(0);
        let lost = self.forfeits.get(key).copied().unwrap_or(0);
        u128::from(counted.saturating_sub(lost))
    }

    // The same including the staked time not counted yet, for a view.
    fn weight_now(&self, quarter: u32, token_id: &TokenId, owner: &AccountId) -> u128 {
        let uncounted = self
            .stakes
            .get(token_id)
            .filter(|s| s.owner == *owner && !self.is_fresh(s.staked_at.0, quarter))
            .map_or(0, |s| {
                overlap(quarter, s.booked_to.0, counted_until(s, env::block_timestamp()))
            });
        let key = (quarter, token_id.clone(), owner.clone());
        let counted = self.seat_weight.get(&key).copied().unwrap_or(0);
        let lost = self.forfeits.get(&key).copied().unwrap_or(0);
        u128::from((counted + uncounted).saturating_sub(lost))
    }

    // Seat time of a quarter as of now: what is counted plus what the staked seats have added since `last_tick`.
    fn seat_ns_now(&self, quarter: u32, book: &QuarterBook) -> u128 {
        let seats = if quarter == quarter_containing(self.last_tick) {
            self.earning - self.fresh
        } else {
            self.earning
        };
        book.seat_ns + u128::from(seats) * u128::from(overlap(quarter, self.last_tick, env::block_timestamp()))
    }

    fn quarter_view(&self, quarter: u32) -> QuarterView {
        let book = self.book(quarter);
        let (starts_at, ends_at) = (quarter_start(quarter), quarter_end(quarter));
        let state = if book.finalized {
            QuarterState::Final
        } else if env::block_timestamp() < ends_at {
            QuarterState::Open
        } else {
            QuarterState::Closing
        };
        let (pool, seat_ns) = if book.finalized {
            (book.pool, book.seat_ns)
        } else {
            (book.revenue_in + book.carry_in, self.seat_ns_now(quarter, &book))
        };
        QuarterView {
            quarter,
            label: quarter_label(quarter),
            starts_at: U64(starts_at),
            ends_at: U64(ends_at),
            claimable_from: U64(ends_at.saturating_add(self.close_grace_ns)),
            state,
            revenue_in: U128(book.revenue_in),
            carry_in: U128(book.carry_in),
            pool: U128(pool),
            seat_ns: U128(seat_ns),
            forfeit_ns: U128(book.forfeit_ns),
            paid: U128(book.paid),
            pending: U128(book.pending),
            rolled_to: book.rolled_to,
        }
    }

    fn entitlement_view(&self, quarter: u32, token_id: &TokenId, owner: &AccountId) -> Option<EntitlementView> {
        let weight = self.weight_now(quarter, token_id, owner);
        let claim = self.claims.get(&(quarter, token_id.clone(), owner.clone()));
        if weight == 0 && claim.is_none() {
            return None;
        }
        let book = self.book(quarter);
        let (amount, estimated, status) = match claim {
            Some(c) if c.status == ClaimStatus::Paid => (c.amount, false, EntitlementStatus::Paid),
            Some(c) => (c.amount, false, EntitlementStatus::Pending),
            None if book.finalized => (
                entitlement(book.pool, weight, book.weight_total),
                false,
                EntitlementStatus::Claimable,
            ),
            None => {
                let status = if env::block_timestamp() < quarter_end(quarter) {
                    EntitlementStatus::Accruing
                } else {
                    EntitlementStatus::Closing
                };
                (
                    entitlement(
                        book.revenue_in + book.carry_in,
                        weight,
                        self.seat_ns_now(quarter, &book) - book.forfeit_ns,
                    ),
                    true,
                    status,
                )
            }
        };
        Some(EntitlementView {
            quarter,
            token_id: token_id.clone(),
            owner: owner.clone(),
            weight_ns: U128(weight),
            amount: U128(amount),
            estimated,
            status,
            requested_at: claim.map(|c| U64(c.requested_at)),
            paid_at: claim.and_then(|c| c.paid_at).map(U64),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use proptest::prelude::*;
    use std::cell::Cell;
    use std::collections::{BTreeMap, BTreeSet};

    const OWNER: &str = "owner.near";
    const ORACLE: &str = "oracle.near";
    const NFT: &str = "nft.near";
    const VERIFIER: &str = "intents.near";
    const MARKET: &str = "market.near";
    const COLLATERAL_ID: &str = "nep141:usd.near";
    const RECONCILE_WAIT_NS: u64 = DEFAULT_RECONCILE_WAIT_NS;
    const COOLDOWN_NS: u64 = 60_000_000_000;
    const SECOND: u64 = NS_PER_SEC;
    const DAY: u64 = NS_PER_DAY;
    // 2026-10-01T00:00:00Z, the start of 2026 Q4 (quarter 8107). Every test begins here unless it says otherwise.
    const START: u64 = 1_790_812_800 * SECOND;
    const Q4_2026: u32 = 8_107;
    const Q1_2027: u32 = 8_108;
    const Q2_2027: u32 = 8_109;

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    // The chain's clock for the test. Every context built here reads it, so a test moves time with set_time.
    thread_local! {
        static CLOCK: Cell<u64> = const { Cell::new(0) };
    }

    fn now() -> u64 {
        CLOCK.with(Cell::get)
    }

    fn context(who: &str) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(acct(who)).block_timestamp(now());
        builder
    }

    fn act_as(who: &str) {
        testing_env!(context(who).build());
    }

    fn act_with_seed(who: &str, seed: u8) {
        testing_env!(context(who).random_seed([seed; 32]).build());
    }

    fn act_paid(who: &str) {
        testing_env!(context(who).attached_deposit(NearToken::from_yoctonear(1)).build());
    }

    fn act_at(who: &str, t: u64) {
        CLOCK.with(|c| c.set(t));
        act_paid(who);
    }

    fn set_time(t: u64) {
        CLOCK.with(|c| c.set(t));
        act_as(OWNER);
    }

    // The allowlist is off unless a test asks for it, so tests of other things stake any token they like.
    fn council() -> CouncilContract {
        council_with(Some(false))
    }

    fn council_with(allowlist_enabled: Option<bool>) -> CouncilContract {
        let mut c = unconfigured_council(allowlist_enabled);
        act_as(OWNER);
        c.set_nft_contract(acct(NFT));
        c.allow_market(acct(MARKET));
        c
    }

    // As deployed: no collection and no market until the owner says which.
    fn unconfigured_council(allowlist_enabled: Option<bool>) -> CouncilContract {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        CLOCK.with(|c| c.set(START));
        act_as(OWNER);
        CouncilContract::new(
            acct(OWNER),
            acct(ORACLE),
            acct(VERIFIER),
            COLLATERAL_ID.to_string(),
            U64(COOLDOWN_NS),
            MAX_SEATS,
            allowlist_enabled,
        )
    }

    // What the verifier calls after the market's mt_transfer_call.
    fn deliver(
        c: &mut CouncilContract,
        sender: &str,
        token_ids: Vec<&str>,
        amounts: Vec<u128>,
        msg: &str,
    ) -> Vec<U128> {
        c.mt_on_transfer(
            acct(sender),
            vec![acct(sender)],
            token_ids.into_iter().map(String::from).collect(),
            amounts.into_iter().map(U128).collect(),
            msg.to_string(),
        )
    }

    // The market's sweep `sweep_id` lands in the quarter the clock is in.
    fn revenue(c: &mut CouncilContract, sweep_id: u64, amount: u128) {
        act_as(VERIFIER);
        let _ = deliver(
            c,
            MARKET,
            vec![COLLATERAL_ID],
            vec![amount],
            &format!("{REVENUE_PREFIX}{sweep_id}"),
        );
    }

    // Requests the unstake, waits out the cooldown and unstakes. Time ends a cooldown after the request.
    fn leave(c: &mut CouncilContract, token: &str, owner: &str) {
        act_paid(owner);
        c.request_unstake(token.into());
        act_at(owner, now() + COOLDOWN_NS);
        let _ = c.unstake(token.into());
    }

    // Asks to leave at exactly `at`, which is where the seat's time stops, and unstakes a cooldown later.
    fn leave_at(c: &mut CouncilContract, token: &str, owner: &str, at: u64) {
        set_time(at);
        leave(c, token, owner);
        assert_eq!(now(), at + COOLDOWN_NS);
    }

    // Finalizes the next quarter at the earliest moment it can be.
    fn finalize(c: &mut CouncilContract) -> u32 {
        let q = c.next_to_finalize;
        set_time(quarter_end(q) + c.close_grace_ns);
        c.finalize_quarter(q);
        q
    }

    fn entitlement_of(c: &CouncilContract, quarter: u32, token: &str, owner: &str) -> u128 {
        c.get_entitlement(quarter, token.into(), acct(owner))
            .map_or(0, |e| e.amount.0)
    }

    // Claims and reports the transfer as done, and returns what was paid.
    fn claim(c: &mut CouncilContract, quarter: u32, token: &str, owner: &str) -> u128 {
        let amount = claim_without_reply(c, quarter, token, owner);
        act_as("council.near");
        c.on_claim_paid(
            quarter,
            token.into(),
            acct(owner),
            requested_at(c, quarter, token, owner),
            Ok(()),
        );
        amount
    }

    fn requested_at(c: &CouncilContract, quarter: u32, token: &str, owner: &str) -> U64 {
        U64(c
            .claims
            .get(&(quarter, token.into(), acct(owner)))
            .map_or(0, |claim| claim.requested_at))
    }

    // Claims and leaves the transfer's result unreported. Returns the amount the claim reserved.
    fn claim_without_reply(c: &mut CouncilContract, quarter: u32, token: &str, owner: &str) -> u128 {
        act_paid(owner);
        let _ = c.claim_quarter(quarter, token.into());
        let logs = near_sdk::test_utils::get_logs();
        let requested: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(logs.last().unwrap().strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(requested["event"], "claim_requested");
        requested["data"]["amount"].as_str().unwrap().parse().unwrap()
    }

    fn stake(c: &mut CouncilContract, token: &str, owner: &str) {
        act_as(NFT);
        let _ = c.nft_on_transfer(acct("market.near"), acct(owner), token.to_string(), String::new());
        confirm_stake(c, token, owner);
    }

    fn held_by(owner: &str, token: &str) -> Token {
        Token {
            token_id: token.to_string(),
            owner_id: acct(owner),
            metadata: None,
            approved_account_ids: None,
        }
    }

    fn confirm_stake(c: &mut CouncilContract, token: &str, owner: &str) -> bool {
        confirm_stake_from(c, NFT, token, owner)
    }

    fn confirm_stake_from(c: &mut CouncilContract, collection: &str, token: &str, owner: &str) -> bool {
        act_as("council.near");
        let held = held_by(env::current_account_id().as_str(), token);
        c.on_stake_checked(token.to_string(), acct(owner), acct(collection), Ok(Some(held)))
    }

    fn tokens(c: &CouncilContract) -> BTreeSet<TokenId> {
        c.staked_tokens(0, MAX_SEATS).into_iter().collect()
    }

    #[test]
    fn a_stake_belongs_to_the_previous_owner_not_the_sender() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        stake(&mut c, "t2", "a.near");
        assert_eq!(c.stake_of("t1".into()).unwrap().owner, acct("a.near"));
        assert!(c.is_seat(acct("a.near")));
        assert!(!c.is_seat(acct("market.near")));
        assert_eq!(c.seat_count(), 2);
    }

    #[test]
    #[should_panic(expected = "wrong NFT contract")]
    fn only_the_configured_collection_stakes() {
        let mut c = council();
        act_as("other-nft.near");
        let _ = c.nft_on_transfer(acct("a.near"), acct("a.near"), "t1".into(), String::new());
    }

    #[test]
    #[should_panic(expected = "already staked")]
    fn a_staked_token_cannot_be_staked_again() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        stake(&mut c, "t1", "b.near");
    }

    #[test]
    #[should_panic(expected = "the council is full")]
    fn the_council_holds_at_most_max_seats() {
        let mut c = council();
        for i in 0..=MAX_SEATS {
            stake(&mut c, &i.to_string(), "a.near");
        }
    }

    #[test]
    fn the_owner_changes_the_collection_while_nothing_is_staked() {
        let mut c = council();
        c.set_nft_contract(acct("other-nft.near"));
        act_as("other-nft.near");
        let _ = c.nft_on_transfer(acct("a.near"), acct("a.near"), "t1".into(), String::new());
        act_as("council.near");
        let token = held_by(env::current_account_id().as_str(), "t1");
        assert!(!c.on_stake_checked("t1".into(), acct("a.near"), acct("other-nft.near"), Ok(Some(token))));
        assert!(c.is_seat(acct("a.near")));
    }

    #[test]
    fn the_collection_cannot_change_while_an_unstake_waits_for_its_nft_transfer() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        let before = c.stake_of("1".into()).unwrap();
        leave(&mut c, "1", "a.near");
        assert_eq!((c.seat_count(), c.unstakes_in_flight), (0, 1));
        act_as(OWNER);
        let message = refusal(|| c.set_nft_contract(acct("other-nft.near")));
        assert!(message.contains("still waiting for its NFT transfer"), "{message}");
        act_as("council.near");
        c.on_unstaked("1".into(), before, Ok(()));
        assert_eq!(c.unstakes_in_flight, 0);
        act_as(OWNER);
        c.set_nft_contract(acct("other-nft.near"));
    }

    #[test]
    fn migrate_moves_version_three_state_to_four_with_nothing_in_flight() {
        let mut c = council();
        stake(&mut c, "7", "o0.near");
        let old = StateV3 {
            state_version: 3,
            upgrade_proven: c.upgrade_proven,
            upgrade_in_flight: true,
            owner: c.owner,
            pending_owner: c.pending_owner,
            oracle: c.oracle,
            nft_contract: c.nft_contract,
            allowed_markets: c.allowed_markets,
            verifier: c.verifier,
            collateral_token_id: c.collateral_token_id,
            cooldown_ns: c.cooldown_ns,
            max_seats_per_account: c.max_seats_per_account,
            allowlist_enabled: c.allowlist_enabled,
            allowed_tokens: c.allowed_tokens,
            allowed_range: c.allowed_range,
            staked: c.staked,
            stakes: c.stakes,
            seats_of: c.seats_of,
            tokens_of: c.tokens_of,
            juries: c.juries,
            open_juries: c.open_juries,
            earning: c.earning,
            close_grace_ns: c.close_grace_ns,
            reconcile_wait_ns: c.reconcile_wait_ns,
            last_tick: c.last_tick,
            next_to_finalize: c.next_to_finalize,
            quarters: c.quarters,
            seat_weight: c.seat_weight,
            forfeits: c.forfeits,
            claims: c.claims,
            received: c.received,
            total_received: c.total_received,
            total_paid: c.total_paid,
            pending_total: c.pending_total,
            open_pool: c.open_pool,
            final_pool: c.final_pool,
            rolled_total: c.rolled_total,
        };
        env::state_write(&old);
        testing_env!(context("alice.near").build());
        let migrated = CouncilContract::migrate();
        assert_eq!(migrated.state_version, STATE_VERSION);
        assert_eq!((migrated.unstakes_in_flight, migrated.seat_count()), (0, 1));
        assert!(migrated.upgrade_proven && !migrated.upgrade_in_flight);
    }

    #[test]
    fn migrate_moves_version_four_state_to_five_and_keeps_the_running_quarter_on_the_old_rule() {
        let mut c = council();
        stake(&mut c, "7", "o0.near");
        let old = StateV4 {
            state_version: 4,
            upgrade_proven: c.upgrade_proven,
            upgrade_in_flight: true,
            owner: c.owner,
            pending_owner: c.pending_owner,
            oracle: c.oracle,
            nft_contract: c.nft_contract,
            allowed_markets: c.allowed_markets,
            verifier: c.verifier,
            collateral_token_id: c.collateral_token_id,
            cooldown_ns: c.cooldown_ns,
            max_seats_per_account: c.max_seats_per_account,
            allowlist_enabled: c.allowlist_enabled,
            allowed_tokens: c.allowed_tokens,
            allowed_range: c.allowed_range,
            staked: c.staked,
            stakes: c.stakes,
            seats_of: c.seats_of,
            tokens_of: c.tokens_of,
            juries: c.juries,
            open_juries: c.open_juries,
            earning: c.earning,
            close_grace_ns: c.close_grace_ns,
            reconcile_wait_ns: c.reconcile_wait_ns,
            last_tick: c.last_tick,
            next_to_finalize: c.next_to_finalize,
            quarters: c.quarters,
            seat_weight: c.seat_weight,
            forfeits: c.forfeits,
            claims: c.claims,
            received: c.received,
            total_received: c.total_received,
            total_paid: c.total_paid,
            pending_total: c.pending_total,
            open_pool: c.open_pool,
            final_pool: c.final_pool,
            rolled_total: c.rolled_total,
            unstakes_in_flight: 2,
        };
        env::state_write(&old);
        testing_env!(context("alice.near").build());
        let migrated = CouncilContract::migrate();
        assert_eq!(migrated.state_version, STATE_VERSION);
        assert_eq!((migrated.unstakes_in_flight, migrated.seat_count()), (2, 1));
        assert_eq!((migrated.fresh, migrated.rule_from_quarter), (0, Q1_2027));
        let mut migrated = migrated;
        set_time(day(10));
        stake(&mut migrated, "8", "o1.near");
        assert_eq!(
            migrated.fresh, 0,
            "the quarter in progress still counts every staked second"
        );
        set_time(quarter_start(Q1_2027) + DAY);
        stake(&mut migrated, "9", "o2.near");
        assert_eq!(
            migrated.fresh, 1,
            "from the next quarter a seat staked after its start is fresh"
        );
        assert!(migrated.upgrade_proven && !migrated.upgrade_in_flight);
    }

    #[test]
    fn a_seat_staked_after_the_quarter_began_earns_nothing_until_the_next_quarter() {
        let mut c = council();
        stake(&mut c, "early", "early.near");
        set_time(day(45));
        stake(&mut c, "late", "late.near");
        set_time(day(60));
        revenue(&mut c, 1, 1_000_000);
        assert_eq!(finalize(&mut c), Q4_2026);
        let book = c.book(Q4_2026);
        assert_eq!((book.pool, book.weight_total), (1_000_000, 92 * u128::from(DAY)));
        assert_eq!(entitlement_of(&c, Q4_2026, "early", "early.near"), 1_000_000);
        assert_eq!(entitlement_of(&c, Q4_2026, "late", "late.near"), 0);
        assert_eq!(claim(&mut c, Q4_2026, "early", "early.near"), 1_000_000);
        assert_eq!(c.reward_totals().final_unclaimed.0, 0, "nothing is stranded");
        act_paid("late.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "late".into()))),
            "nothing to claim"
        );

        set_time(now() + DAY);
        revenue(&mut c, 2, 600_000);
        assert_eq!(finalize(&mut c), Q1_2027);
        assert_eq!(entitlement_of(&c, Q1_2027, "early", "early.near"), 300_000);
        assert_eq!(entitlement_of(&c, Q1_2027, "late", "late.near"), 300_000);
        let paid = claim(&mut c, Q1_2027, "early", "early.near") + claim(&mut c, Q1_2027, "late", "late.near");
        assert_eq!(paid, 600_000);
    }

    #[test]
    fn a_quarter_with_only_a_late_seat_rolls_its_revenue_to_the_next_one() {
        let mut c = council();
        set_time(day(10));
        stake(&mut c, "late", "late.near");
        set_time(day(20));
        revenue(&mut c, 1, 500_000);
        finalize(&mut c);
        assert_eq!(c.book(Q4_2026).rolled_to, Some(Q1_2027));
        assert_eq!(c.book(Q1_2027).carry_in, 500_000);
        finalize(&mut c);
        assert_eq!(entitlement_of(&c, Q1_2027, "late", "late.near"), 500_000);
        assert_eq!(claim(&mut c, Q1_2027, "late", "late.near"), 500_000);
    }

    #[test]
    fn a_late_seat_that_asks_to_leave_in_its_first_quarter_leaves_the_totals_alone() {
        let mut c = council();
        stake(&mut c, "early", "early.near");
        set_time(day(10));
        stake(&mut c, "late", "late.near");
        assert_eq!(c.fresh, 1);
        leave_at(&mut c, "late", "late.near", day(20));
        assert_eq!(c.fresh, 0);
        set_time(day(60));
        revenue(&mut c, 1, 920_000);
        finalize(&mut c);
        assert_eq!(c.book(Q4_2026).seat_ns, 92 * u128::from(DAY));
        assert_eq!(entitlement_of(&c, Q4_2026, "early", "early.near"), 920_000);
        assert_eq!(entitlement_of(&c, Q4_2026, "late", "late.near"), 0);
    }

    fn owned_by_council(token: &str) -> Result<Option<Token>, PromiseError> {
        Ok(Some(held_by(env::current_account_id().as_str(), token)))
    }

    fn check_stake(c: &mut CouncilContract, result: Result<Option<Token>, PromiseError>) -> bool {
        act_as(NFT);
        let _ = c.nft_on_transfer(acct("market.near"), acct("a.near"), "t1".into(), String::new());
        act_as("council.near");
        c.on_stake_checked("t1".into(), acct("a.near"), acct(NFT), result)
    }

    #[test]
    fn a_seat_counts_once_the_collection_says_the_council_owns_the_token() {
        let mut c = council();
        assert!(!check_stake(&mut c, owned_by_council("t1")), "false keeps the token");
        assert_eq!((c.seat_count(), c.earning), (1, 1));
        assert_eq!(last_event()["event"], "staked");
    }

    #[test]
    fn a_token_the_council_does_not_own_is_returned_and_never_counted() {
        for answer in [
            Ok(Some(held_by("someone.near", "t1"))),
            Ok(Some(held_by(env::current_account_id().as_str(), "other"))),
            Ok(None),
        ] {
            let mut c = council();
            assert!(check_stake(&mut c, answer), "true sends the token back to its owner");
            assert_eq!((c.seat_count(), c.earning, c.unstakes_in_flight), (0, 0, 0));
            assert_eq!(last_event()["event"], "stake_refused");
        }
    }

    #[test]
    fn a_failed_ownership_check_never_counts_the_seat() {
        let mut c = council();
        assert!(check_stake(&mut c, Err(PromiseError::Failed)));
        assert_eq!((c.seat_count(), c.earning, c.unstakes_in_flight), (0, 0, 0));
        assert!(!c.is_seat(acct("a.near")));
    }

    #[test]
    fn a_stake_confirmed_after_the_collection_changed_or_the_token_was_taken_is_returned() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_as("council.near");
        assert!(
            c.on_stake_checked("t1".into(), acct("b.near"), acct(NFT), owned_by_council("t1")),
            "already staked"
        );
        assert!(c.on_stake_checked(
            "t2".into(),
            acct("b.near"),
            acct("other-nft.near"),
            owned_by_council("t2")
        ));
        assert_eq!(c.seat_count(), 1);
    }

    #[test]
    fn staking_needs_the_gas_for_the_check_and_the_callback() {
        let mut c = council();
        testing_env!(context(NFT)
            .prepaid_gas(Gas::from_gas(GAS_STAKE_FLOOR.as_gas() - 1))
            .build());
        let message = refusal(|| {
            let _ = c.nft_on_transfer(acct("market.near"), acct("a.near"), "t1".into(), String::new());
        });
        assert!(message.contains("a stake checks the token's owner"), "{message}");
    }

    #[test]
    #[should_panic(expected = "unstake every seat before changing the NFT contract")]
    fn the_collection_cannot_change_under_staked_seats() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_as(OWNER);
        c.set_nft_contract(acct("other-nft.near"));
    }

    #[test]
    #[should_panic(expected = "oracle only")]
    fn only_the_oracle_draws() {
        let mut c = council();
        for i in 0..5 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        act_as(OWNER);
        c.draw(U64(0), 3, vec![]);
    }

    #[test]
    #[should_panic(expected = "not enough seat holders to draw a jury: 2 eligible, 3 needed")]
    fn a_draw_needs_enough_distinct_holders_after_the_exclusions() {
        let mut c = council();
        for i in 0..6 {
            stake(&mut c, &i.to_string(), ["a.near", "b.near", "c.near"][i % 3]);
        }
        act_as(ORACLE);
        c.draw(U64(0), 3, vec![acct("c.near")]);
    }

    #[test]
    fn a_seat_staked_within_the_last_cooldown_is_not_drawn_while_older_seats_can_make_a_jury() {
        for case in 0..10 {
            let mut c = council();
            for i in 0..3 {
                stake(&mut c, &format!("old{i}"), &format!("old{i}.near"));
            }
            set_time(now() + COOLDOWN_NS + 1);
            for i in 0..5 {
                stake(&mut c, &format!("new{i}"), &format!("new{i}.near"));
            }
            act_as(ORACLE);
            let jury = c.draw(U64(case), 3, vec![]);
            assert!(
                jury.iter().all(|o| o.as_str().starts_with("old")),
                "case {case}: {jury:?}"
            );
        }
    }

    #[test]
    fn when_the_older_seats_cannot_make_a_jury_the_newer_ones_fill_it() {
        let mut c = council();
        for i in 0..2 {
            stake(&mut c, &format!("old{i}"), &format!("old{i}.near"));
        }
        set_time(now() + COOLDOWN_NS + 1);
        for i in 0..3 {
            stake(&mut c, &format!("new{i}"), &format!("new{i}.near"));
        }
        act_as(ORACLE);
        let jury = c.draw(U64(0), 3, vec![]);
        assert_eq!(jury.len(), 3);
        assert!(jury.iter().any(|o| o.as_str().starts_with("new")));
    }

    #[test]
    fn a_drawn_jury_serves_until_released_and_a_repeat_draw_returns_it() {
        let mut c = council();
        for i in 0..6 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        act_with_seed(ORACLE, 1);
        let first = c.draw(U64(7), 3, vec![]);
        act_with_seed(ORACLE, 2);
        assert_eq!(
            c.draw(U64(7), 3, vec![]),
            first,
            "a block with another seed does not reroll the jury"
        );
        let second = c.draw(U64(8), 3, vec![]);
        assert!(
            second.iter().all(|a| !first.contains(a)),
            "a serving seat is not drawn again"
        );
        let serving = |c: &CouncilContract| {
            (0..6)
                .filter(|i| c.stake_of(i.to_string()).unwrap().serving.is_some())
                .count()
        };
        assert_eq!(serving(&c), 6);
        c.unlock_case(U64(7), vec![]);
        assert_eq!(serving(&c), 3);
        c.unlock_case(U64(7), vec![]);
        assert_eq!(serving(&c), 3);
    }

    // The jury depends on the block seed, the seat set and the case key, and on nothing the caller passes.
    #[test]
    fn the_draw_reads_the_block_seed_and_nothing_the_caller_passes() {
        let draw_with = |seed: u8, case_key: u64| {
            let mut c = council();
            for i in 0..12 {
                stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
            }
            act_with_seed(ORACLE, seed);
            c.draw(U64(case_key), 3, vec![])
        };
        assert_eq!(
            draw_with(1, 7),
            draw_with(1, 7),
            "the same seed, seats and case give the same jury"
        );
        let by_seed: BTreeSet<Vec<AccountId>> = (0..16).map(|seed| draw_with(seed, 7)).collect();
        assert!(
            by_seed.len() > 8,
            "another block seed draws another jury: {} different juries from 16 seeds",
            by_seed.len()
        );
        let by_case: BTreeSet<Vec<AccountId>> = (0..16).map(|case_key| draw_with(1, case_key)).collect();
        assert!(
            by_case.len() > 8,
            "another case draws another jury: {} different juries from 16 cases",
            by_case.len()
        );
    }

    // ---- the calendar: pure functions ---------------------------------------------------------------------

    #[test]
    fn the_quarter_table_of_the_spec_holds() {
        for (id, start_s, days) in [
            (8_107u32, 1_790_812_800u64, 92u64),
            (8_108, 1_798_761_600, 90),
            (8_109, 1_806_537_600, 91),
            (8_110, 1_814_400_000, 92),
            (8_111, 1_822_348_800, 92),
            (8_112, 1_830_297_600, 91),
        ] {
            assert_eq!(quarter_start(id), start_s * SECOND, "start of {id}");
            assert_eq!(quarter_end(id) - quarter_start(id), days * DAY, "length of {id}");
            assert_eq!(quarter_containing(start_s * SECOND), id);
            assert_eq!(quarter_containing(start_s * SECOND - 1), id - 1);
        }
        assert_eq!(quarter_containing(1_798_761_599_999_999_999), Q4_2026);
        assert_eq!(quarter_containing(1_798_761_600_000_000_000), Q1_2027);
        assert_eq!(
            quarter_containing(1_835_438_400_000_000_000),
            8_112,
            "29 February 2028 is in 2028 Q1"
        );
        assert_eq!(quarter_label(Q4_2026), "2026Q4");
        assert_eq!(quarter_label(8_112), "2028Q1");
    }

    // An independent count of the days from 1970-01-01 to the first of every month, by month lengths and the leap rule.
    #[test]
    fn every_month_boundary_from_1970_to_2100_falls_in_the_right_quarter() {
        let leap = |y: u64| y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400));
        let mut days = 0u64;
        let mut last_quarter = None;
        for year in 1970u64..=2100 {
            for month in 1u64..=12 {
                let start = days * DAY;
                let quarter = year as u32 * 4 + (month as u32 - 1) / 3;
                assert_eq!(quarter_containing(start), quarter, "{year}-{month:02}-01");
                if month % 3 == 1 {
                    assert_eq!(quarter_start(quarter), start, "start of {year} Q{}", month / 3 + 1);
                    if let Some(previous) = last_quarter {
                        assert_eq!(quarter_containing(start - 1), previous);
                        assert_eq!(quarter_end(previous), start);
                    }
                    last_quarter = Some(quarter);
                } else {
                    assert_eq!(
                        quarter_containing(start - 1),
                        quarter,
                        "the day before {year}-{month:02}-01"
                    );
                }
                days += match month {
                    2 if leap(year) => 29,
                    2 => 28,
                    4 | 6 | 9 | 11 => 30,
                    _ => 31,
                };
            }
        }
    }

    #[test]
    fn a_time_inside_a_quarter_belongs_to_it_and_one_nanosecond_before_its_end_still_does() {
        for q in [Q4_2026, Q1_2027, 8_112] {
            for at in [quarter_start(q), quarter_start(q) + 1, quarter_end(q) - 1] {
                assert_eq!(quarter_containing(at), q);
            }
            assert_eq!(quarter_containing(quarter_end(q)), q + 1);
        }
    }

    #[test]
    fn the_overlap_of_a_span_with_a_quarter_is_clipped_to_it() {
        let (start, end) = (quarter_start(Q1_2027), quarter_end(Q1_2027));
        assert_eq!(overlap(Q1_2027, start - 5 * DAY, start + 3 * DAY), 3 * DAY);
        assert_eq!(overlap(Q1_2027, end - 2 * DAY, end + 9 * DAY), 2 * DAY);
        assert_eq!(overlap(Q1_2027, start - DAY, end + DAY), end - start);
        assert_eq!(overlap(Q1_2027, end, end + DAY), 0);
        assert_eq!(overlap(Q1_2027, start - DAY, start), 0);
        assert_eq!(overlap(Q1_2027, end + DAY, start), 0, "a backwards span is empty");
    }

    #[test]
    fn a_share_is_the_pool_times_the_weight_over_the_total_rounded_down() {
        assert_eq!(entitlement(1_600_000, 92, 169), 871_005);
        assert_eq!(entitlement(1_600_000, 47, 169), 444_970);
        assert_eq!(entitlement(1_600_000, 30, 169), 284_023);
        assert_eq!(entitlement(10, 1, 3), 3);
        assert_eq!(entitlement(0, 5, 5), 0);
        assert_eq!(entitlement(7, 0, 5), 0);
        assert_eq!(entitlement(7, 5, 0), 0, "no seat time, no share");
        // The largest a quarter can hold: 1,000 seats for 92 days, and a pool of a trillion USDC.
        let total = 1_000 * 92 * u128::from(DAY);
        assert_eq!(
            entitlement(1_000_000_000_000_000_000, total, total),
            1_000_000_000_000_000_000
        );
        assert_eq!(
            entitlement(1_000_000_000_000_000_001, total / 2, total),
            500_000_000_000_000_000
        );
    }

    proptest! {
        // Whatever the pool and the weights, the shares add up to at most the pool and the leftover is under one unit a seat.
        #[test]
        fn shares_never_exceed_the_pool_and_leave_under_a_unit_a_seat(
            pool in 0u128..1_000_000_000_000_000_000_000,
            weights in proptest::collection::vec(1u128..8_000_000_000_000_000, 1..40)
        ) {
            let total: u128 = weights.iter().sum();
            let shares: u128 = weights.iter().map(|w| entitlement(pool, *w, total)).sum();
            prop_assert!(shares <= pool);
            prop_assert!(pool - shares < weights.len() as u128);
        }

        #[test]
        fn later_times_never_fall_in_earlier_quarters(a in any::<u32>(), b in any::<u32>()) {
            let (x, y) = (u64::from(a.min(b)) * 4_000_000_000, u64::from(a.max(b)) * 4_000_000_000);
            prop_assert!(quarter_containing(x) <= quarter_containing(y));
        }
    }

    // ---- the worked examples of the spec (council.md, 6.11), with the real calendar -------------------------

    fn day(n: u64) -> u64 {
        START + n * DAY
    }

    // 2026 Q4 has 92 days. Seat 1 is staked all quarter, seat 2 from 15 November (so it earns nothing until the next quarter),
    // seat 3 from 1 to 31 October. 600,000 comes in on 20 October and 1,000,000 on 30 December.
    fn example_one() -> CouncilContract {
        let mut c = council();
        stake(&mut c, "1", "seat1.near");
        stake(&mut c, "3", "seat3.near");
        set_time(day(19));
        revenue(&mut c, 1, 600_000);
        leave_at(&mut c, "3", "seat3.near", day(30));
        set_time(day(45));
        stake(&mut c, "2", "seat2.near");
        set_time(day(90));
        revenue(&mut c, 2, 1_000_000);
        c
    }

    #[test]
    fn example_one_the_baseline_quarter() {
        let mut c = example_one();
        assert_eq!(finalize(&mut c), Q4_2026);
        let book = c.book(Q4_2026);
        assert_eq!(
            (book.pool, book.weight_total, book.seat_ns),
            (1_600_000, 122 * u128::from(DAY), 122 * u128::from(DAY))
        );
        assert_eq!(entitlement_of(&c, Q4_2026, "1", "seat1.near"), 1_206_557);
        assert_eq!(
            entitlement_of(&c, Q4_2026, "2", "seat2.near"),
            0,
            "staked after the quarter began"
        );
        assert_eq!(entitlement_of(&c, Q4_2026, "3", "seat3.near"), 393_442);
        assert_eq!(claim(&mut c, Q4_2026, "1", "seat1.near"), 1_206_557);
        assert_eq!(
            claim(&mut c, Q4_2026, "3", "seat3.near"),
            393_442,
            "a seat that left still claims"
        );
        let totals = c.reward_totals();
        assert_eq!(
            (totals.total_paid.0, totals.final_unclaimed.0, totals.pending_claims.0),
            (1_599_999, 1, 0),
            "one unit stays as unallocated backing"
        );
    }

    #[test]
    fn example_two_a_sweep_after_the_boundary_belongs_to_the_next_quarter() {
        let mut c = example_one();
        set_time(quarter_start(Q1_2027) + 2 * DAY);
        revenue(&mut c, 3, 400_000);
        assert_eq!(
            c.received_of(acct(MARKET), U64(3)).map(|r| (r.amount.0, r.quarter)),
            Some((400_000, Q1_2027))
        );
        assert_eq!(c.book(Q4_2026).revenue_in, 1_600_000);
        assert_eq!(c.book(Q1_2027).revenue_in, 400_000);
        finalize(&mut c);
        assert_eq!(
            entitlement_of(&c, Q4_2026, "1", "seat1.near"),
            1_206_557,
            "the late sweep did not touch it"
        );
    }

    #[test]
    fn example_three_a_seat_staked_at_noon_on_the_last_day_earns_nothing() {
        let mut c = example_one();
        set_time(day(91) + DAY / 2);
        stake(&mut c, "4", "seat4.near");
        finalize(&mut c);
        assert_eq!(entitlement_of(&c, Q4_2026, "1", "seat1.near"), 1_206_557);
        assert_eq!(entitlement_of(&c, Q4_2026, "3", "seat3.near"), 393_442);
        assert_eq!(
            entitlement_of(&c, Q4_2026, "4", "seat4.near"),
            0,
            "no sliver: it starts with the next quarter"
        );
        let paid: u128 = [("1", "seat1.near"), ("3", "seat3.near")]
            .iter()
            .map(|(t, o)| claim(&mut c, Q4_2026, t, o))
            .sum();
        assert_eq!(1_600_000 - paid, 1, "the dust");
    }

    // Example one, except that seat 1 is drawn on 10 December with seat 2 and the case is released on 14 December. The
    // accounts in `delinquent` never voted.
    fn silent_juror(delinquent: Vec<AccountId>) -> CouncilContract {
        let mut c = council();
        stake(&mut c, "1", "seat1.near");
        stake(&mut c, "3", "seat3.near");
        set_time(day(19));
        revenue(&mut c, 1, 600_000);
        leave_at(&mut c, "3", "seat3.near", day(30));
        set_time(day(45));
        stake(&mut c, "2", "seat2.near");
        set_time(day(70));
        act_with_seed(ORACLE, 1);
        assert_eq!(c.draw(U64(1), 2, vec![]).len(), 2);
        set_time(day(74));
        act_as(ORACLE);
        c.unlock_case(U64(1), delinquent);
        set_time(day(90));
        revenue(&mut c, 2, 1_000_000);
        c
    }

    #[test]
    fn example_four_a_silent_juror_loses_the_seat_time_of_the_case() {
        let mut c = silent_juror(vec![acct("seat1.near")]);
        finalize(&mut c);
        let book = c.book(Q4_2026);
        assert_eq!(
            (book.weight_total, book.forfeit_ns),
            (118 * u128::from(DAY), 4 * u128::from(DAY))
        );
        assert_eq!(entitlement_of(&c, Q4_2026, "1", "seat1.near"), 1_193_220);
        assert_eq!(entitlement_of(&c, Q4_2026, "2", "seat2.near"), 0);
        assert_eq!(entitlement_of(&c, Q4_2026, "3", "seat3.near"), 406_779);
        assert_eq!(
            [("1", "seat1.near"), ("3", "seat3.near")]
                .iter()
                .map(|(t, o)| claim(&mut c, Q4_2026, t, o))
                .sum::<u128>(),
            1_599_999
        );
    }

    #[test]
    fn jurors_who_voted_lose_nothing() {
        let mut c = silent_juror(vec![]);
        finalize(&mut c);
        assert_eq!(c.book(Q4_2026).forfeit_ns, 0);
        assert_eq!(entitlement_of(&c, Q4_2026, "1", "seat1.near"), 1_206_557);
    }

    #[test]
    fn a_juror_is_penalised_once_and_naming_an_outsider_changes_nothing() {
        let mut c = silent_juror(vec![acct("seat1.near"), acct("seat1.near"), acct("nobody.near")]);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("seat1.near")]);
        assert_eq!(c.book(Q4_2026).forfeit_ns, 4 * u128::from(DAY));
    }

    #[test]
    fn a_forfeit_after_the_quarter_is_final_is_skipped_and_says_so() {
        let mut c = council();
        stake(&mut c, "1", "seat1.near");
        stake(&mut c, "2", "seat2.near");
        set_time(day(91));
        act_with_seed(ORACLE, 1);
        c.draw(U64(1), 2, vec![]);
        revenue(&mut c, 1, 1_000);
        // The case is still open when the longest grace period ends, and the quarter is finalized with both seats counted.
        set_time(quarter_end(Q4_2026) + MAX_CLOSE_GRACE_NS);
        c.finalize_quarter(Q4_2026);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("seat1.near")]);
        let events: Vec<String> = near_sdk::test_utils::get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| {
                near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap()["event"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(events, vec!["jury_released", "forfeit_skipped", "seat_time_forfeited"]);
        assert_eq!(c.book(Q4_2026).forfeit_ns, 0);
        assert_eq!(
            c.book(Q1_2027).forfeit_ns,
            u128::from(MAX_CLOSE_GRACE_NS),
            "the seat time since the boundary is in a quarter that is still open, so it is lost there"
        );
    }

    #[test]
    fn a_forfeit_that_crosses_a_boundary_is_split_between_the_quarters_it_touched() {
        let mut c = council();
        stake(&mut c, "1", "seat1.near");
        stake(&mut c, "2", "seat2.near");
        set_time(quarter_end(Q4_2026) - DAY);
        act_with_seed(ORACLE, 1);
        c.draw(U64(1), 2, vec![]);
        set_time(quarter_end(Q4_2026) + 2 * DAY);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("seat1.near")]);
        assert_eq!(c.book(Q4_2026).forfeit_ns, u128::from(DAY));
        assert_eq!(c.book(Q1_2027).forfeit_ns, 2 * u128::from(DAY));
        assert_eq!(
            c.forfeits.get(&(Q4_2026, "1".to_string(), acct("seat1.near"))).copied(),
            Some(DAY)
        );
    }

    #[test]
    fn example_five_a_quarter_with_no_seats_rolls_its_pool_into_the_next() {
        let mut c = council();
        // Nobody is staked in 2026 Q4 or 2027 Q1.
        set_time(quarter_start(Q1_2027) + 40 * DAY);
        revenue(&mut c, 1, 500_000);
        assert_eq!(finalize(&mut c), Q4_2026);
        assert_eq!(finalize(&mut c), Q1_2027);
        let q1 = c.book(Q1_2027);
        assert_eq!((q1.pool, q1.rolled_to), (500_000, Some(Q2_2027)));
        assert_eq!(c.book(Q2_2027).carry_in, 500_000);
        assert_eq!((c.open_pool, c.final_pool, c.rolled_total), (500_000, 0, 500_000));
        set_time(quarter_start(Q2_2027));
        stake(&mut c, "1", "seat1.near");
        set_time(quarter_start(Q2_2027) + 30 * DAY);
        revenue(&mut c, 2, 300_000);
        assert_eq!(finalize(&mut c), Q2_2027);
        assert_eq!(entitlement_of(&c, Q2_2027, "1", "seat1.near"), 800_000);
        assert_eq!(claim(&mut c, Q2_2027, "1", "seat1.near"), 800_000);
        act_paid("seat1.near");
        assert_eq!(c.reward_totals().final_unclaimed.0, 0);
        assert_eq!(c.total_received().0, c.total_paid, "every unit came back out");
    }

    #[test]
    fn a_rolled_quarter_has_nothing_to_claim() {
        let mut c = council();
        stake(&mut c, "1", "seat1.near");
        set_time(day(10));
        leave_at(&mut c, "1", "seat1.near", day(10) + COOLDOWN_NS);
        set_time(quarter_start(Q1_2027) + DAY);
        revenue(&mut c, 1, 90);
        finalize(&mut c);
        finalize(&mut c);
        assert_eq!(c.book(Q1_2027).rolled_to, Some(Q2_2027));
        act_paid("seat1.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q1_2027, "1".into()))),
            "nothing to claim"
        );
    }

    #[test]
    fn example_six_a_failed_claim_can_be_made_again_and_a_paid_one_cannot() {
        let mut c = example_one();
        finalize(&mut c);
        let reserved = claim_without_reply(&mut c, Q4_2026, "1", "seat1.near");
        assert_eq!(reserved, 1_206_557);
        assert_eq!(c.reward_totals().pending_claims.0, 1_206_557);
        assert_eq!(
            c.get_entitlement(Q4_2026, "1".into(), acct("seat1.near"))
                .unwrap()
                .status,
            EntitlementStatus::Pending
        );
        act_paid("seat1.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
            "claim is already pending"
        );
        // The verifier's feature is paused: the transfer fails and the record goes.
        let first = requested_at(&c, Q4_2026, "1", "seat1.near");
        act_as("council.near");
        c.on_claim_paid(
            Q4_2026,
            "1".into(),
            acct("seat1.near"),
            first,
            Err(PromiseError::Failed),
        );
        assert_eq!(last_event()["event"], "claim_failed");
        assert_eq!(
            last_event()["data"]["requested_at"],
            first.0.to_string(),
            "the terminal event names its request"
        );
        assert_eq!((c.reward_totals().pending_claims.0, c.total_paid), (0, 0));
        assert_eq!(
            c.get_entitlement(Q4_2026, "1".into(), acct("seat1.near"))
                .unwrap()
                .status,
            EntitlementStatus::Claimable
        );
        assert_eq!(claim(&mut c, Q4_2026, "1", "seat1.near"), 1_206_557);
        assert_eq!(last_event()["event"], "claim_paid");
        let second = requested_at(&c, Q4_2026, "1", "seat1.near");
        assert_eq!(last_event()["data"]["requested_at"], second.0.to_string());
        act_paid("seat1.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
            "already claimed"
        );
        assert_eq!(c.total_paid, 1_206_557);
    }

    #[test]
    fn a_callback_that_runs_again_or_late_changes_nothing() {
        let mut c = example_one();
        finalize(&mut c);
        claim(&mut c, Q4_2026, "1", "seat1.near");
        let paid = requested_at(&c, Q4_2026, "1", "seat1.near");
        act_as("council.near");
        c.on_claim_paid(Q4_2026, "1".into(), acct("seat1.near"), paid, Err(PromiseError::Failed));
        c.on_claim_paid(Q4_2026, "1".into(), acct("seat1.near"), paid, Ok(()));
        let none = requested_at(&c, Q4_2026, "2", "seat2.near");
        c.on_claim_paid(Q4_2026, "2".into(), acct("seat2.near"), none, Ok(()));
        assert_eq!(
            (c.total_paid, c.pending_total, c.book(Q4_2026).paid),
            (1_206_557, 0, 1_206_557)
        );
        assert_eq!(
            c.get_entitlement(Q4_2026, "1".into(), acct("seat1.near"))
                .unwrap()
                .status,
            EntitlementStatus::Paid
        );
    }

    // ---- a claim whose payout callback never arrived ----------------------------------------------------------

    fn clock() -> u64 {
        CLOCK.with(|c| c.get())
    }

    fn stuck_claim() -> CouncilContract {
        let mut c = example_one();
        finalize(&mut c);
        claim_without_reply(&mut c, Q4_2026, "1", "seat1.near");
        c
    }

    #[test]
    fn only_the_owner_decides_a_stuck_claim_and_not_before_an_hour() {
        let mut c = stuck_claim();
        set_time(clock() + RECONCILE_WAIT_NS - 1);
        assert_eq!(
            refusal(|| c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), false)),
            "wait 60 minutes after the claim before reconciling"
        );
        act_as("seat1.near");
        assert_eq!(
            refusal(|| c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), false)),
            "owner only"
        );
        set_time(clock() + 1);
        assert_eq!(
            refusal(|| c.reconcile_claim(Q4_2026, "2".into(), acct("seat2.near"), false)),
            "no claim is pending for that seat"
        );
        assert_eq!(c.reward_totals().pending_claims.0, 1_206_557, "nothing moved");
    }

    #[test]
    fn a_stuck_claim_the_owner_finds_unpaid_can_be_claimed_again() {
        let mut c = stuck_claim();
        set_time(clock() + RECONCILE_WAIT_NS);
        c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), false);
        let event = last_event();
        assert_eq!(
            (event["event"].as_str(), event["data"]["paid"].as_bool()),
            (Some("claim_reconciled"), Some(false))
        );
        assert_eq!((c.reward_totals().pending_claims.0, c.total_paid), (0, 0));
        assert_eq!(claim(&mut c, Q4_2026, "1", "seat1.near"), 1_206_557);
        assert_eq!(c.total_paid, 1_206_557);
    }

    #[test]
    fn a_stuck_claim_the_owner_finds_paid_is_booked_once_and_a_late_callback_changes_nothing() {
        let mut c = stuck_claim();
        set_time(clock() + RECONCILE_WAIT_NS);
        c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), true);
        assert_eq!(last_event()["data"]["paid"].as_bool(), Some(true));
        assert_eq!(
            (c.reward_totals().pending_claims.0, c.total_paid, c.book(Q4_2026).paid),
            (0, 1_206_557, 1_206_557)
        );
        assert_eq!(
            c.get_entitlement(Q4_2026, "1".into(), acct("seat1.near"))
                .unwrap()
                .status,
            EntitlementStatus::Paid
        );
        let stuck = requested_at(&c, Q4_2026, "1", "seat1.near");
        act_as("council.near");
        c.on_claim_paid(Q4_2026, "1".into(), acct("seat1.near"), stuck, Ok(()));
        c.on_claim_paid(
            Q4_2026,
            "1".into(),
            acct("seat1.near"),
            stuck,
            Err(PromiseError::Failed),
        );
        assert_eq!((c.total_paid, c.book(Q4_2026).paid), (1_206_557, 1_206_557));
        act_paid("seat1.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
            "already claimed"
        );
        set_time(clock() + 1);
        assert_eq!(
            refusal(|| c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), false)),
            "no claim is pending for that seat"
        );
    }

    #[test]
    fn a_late_callback_of_a_reconciled_claim_does_not_settle_the_claim_that_replaced_it() {
        let mut c = stuck_claim();
        let first = requested_at(&c, Q4_2026, "1", "seat1.near");
        set_time(clock() + RECONCILE_WAIT_NS);
        c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), false);
        let amount = claim_without_reply(&mut c, Q4_2026, "1", "seat1.near");
        let second = requested_at(&c, Q4_2026, "1", "seat1.near");
        assert_ne!(first, second);
        act_as("council.near");
        c.on_claim_paid(
            Q4_2026,
            "1".into(),
            acct("seat1.near"),
            first,
            Err(PromiseError::Failed),
        );
        assert_eq!(
            c.get_entitlement(Q4_2026, "1".into(), acct("seat1.near"))
                .unwrap()
                .status,
            EntitlementStatus::Pending,
            "the first payout's callback must not touch the second claim"
        );
        assert_eq!(c.reward_totals().pending_claims.0, amount);
        c.on_claim_paid(Q4_2026, "1".into(), acct("seat1.near"), second, Ok(()));
        assert_eq!(
            (c.total_paid, c.book(Q4_2026).paid, c.pending_total),
            (amount, amount, 0)
        );
        act_paid("seat1.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
            "already claimed"
        );
    }

    // ---- when a quarter can be finalized and claimed ----------------------------------------------------------

    #[test]
    fn a_quarter_is_final_only_after_the_grace_period_and_in_order() {
        let mut c = example_one();
        let end = quarter_end(Q4_2026);
        for (at, why) in [
            (end - 1, "the quarter cannot be finalized yet"),
            (end + DEFAULT_CLOSE_GRACE_NS - 1, "the quarter cannot be finalized yet"),
        ] {
            set_time(at);
            assert_eq!(refusal(|| c.finalize_quarter(Q4_2026)), why);
        }
        assert_eq!(
            refusal(|| c.finalize_quarter(Q1_2027)),
            "finalize the earlier quarter first"
        );
        set_time(end + DEFAULT_CLOSE_GRACE_NS);
        c.finalize_quarter(Q4_2026);
        assert_eq!(refusal(|| c.finalize_quarter(Q4_2026)), "that quarter is already final");
        assert_eq!(c.config()["next_to_finalize"], Q1_2027);
    }

    #[test]
    fn a_claim_before_the_quarter_is_final_is_refused() {
        let mut c = example_one();
        set_time(quarter_end(Q4_2026) + DEFAULT_CLOSE_GRACE_NS - 1);
        act_paid("seat1.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
            "that quarter is not final"
        );
        act_paid("seat1.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q1_2027, "1".into()))),
            "that quarter is not final"
        );
    }

    #[test]
    fn nobody_claims_for_a_seat_they_did_not_hold() {
        let mut c = example_one();
        finalize(&mut c);
        for who in ["seat2.near", "stranger.near"] {
            act_paid(who);
            assert_eq!(
                refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
                "nothing to claim",
                "{who}"
            );
        }
        // The real owner is not blocked by the attempts.
        assert_eq!(claim(&mut c, Q4_2026, "1", "seat1.near"), 1_206_557);
    }

    #[test]
    fn a_claim_needs_one_yocto_and_the_gas_for_its_payout() {
        let mut c = example_one();
        finalize(&mut c);
        act_as("seat1.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        act_with_gas("seat1.near", 32);
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
            "attach at least 33 TGas: a claim sends the payout and then settles it"
        );
        // The mocked chain meters gas by its own fee table, so the claim that pays is measured in the sandbox. With exactly the
        // floor the call gets past the check and stops at the next refusal.
        act_with_gas("seat1.near", 33);
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q1_2027, "1".into()))),
            "that quarter is not final"
        );
        assert_eq!(GAS_CLAIM_FLOOR, Gas::from_tgas(33));
    }

    #[test]
    fn unclaimed_amounts_stay_claimable_for_good() {
        let mut c = example_one();
        finalize(&mut c);
        set_time(quarter_start(Q4_2026 + 40));
        assert_eq!(claim(&mut c, Q4_2026, "3", "seat3.near"), 393_442);
    }

    #[test]
    fn a_claim_is_one_mt_transfer_of_one_yocto_to_the_caller_and_nothing_else_pays() {
        let mut c = example_one();
        finalize(&mut c);
        claim_without_reply(&mut c, Q4_2026, "1", "seat1.near");
        let sent = near_sdk::test_utils::get_created_receipts();
        let (args, deposit, gas) = mt_transfer_of(&sent[0]);
        assert_eq!((deposit, gas), (1, GAS_MT_TRANSFER.as_gas()));
        assert_eq!(args["receiver_id"], "seat1.near");
        assert_eq!(args["token_id"], COLLATERAL_ID);
        assert_eq!(args["amount"], "1206557");
        assert_eq!(sent.iter().filter(|r| r.receiver_id == acct(VERIFIER)).count(), 1);
    }

    #[test]
    fn claims_and_revenue_refuse_until_the_owner_has_named_the_market() {
        let mut c = unconfigured_council(Some(false));
        act_as(OWNER);
        c.set_nft_contract(acct(NFT));
        act_paid("a.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
            "the Council is not configured, the owner must call allow_market"
        );
        act_as(VERIFIER);
        assert_eq!(
            refusal(|| drop(deliver(&mut c, MARKET, vec![COLLATERAL_ID], vec![5], "revenue:1"))),
            "the Council is not configured, the owner must call allow_market"
        );
        act_as(OWNER);
        c.allow_market(acct(MARKET));
        revenue(&mut c, 1, 5);
        assert_eq!(c.total_received().0, 5);
    }

    #[test]
    fn staking_refuses_until_the_owner_has_named_the_collection() {
        let mut c = unconfigured_council(Some(false));
        act_as(NFT);
        assert_eq!(
            refusal(|| drop(c.nft_on_transfer(acct("a.near"), acct("a.near"), "1".into(), String::new()))),
            "the NFT collection is not set, the owner must call set_nft_contract"
        );
        act_as(OWNER);
        assert_eq!(
            refusal(|| c.allow_tokens(vec!["1".into()])),
            "the NFT collection is not set, the owner must call set_nft_contract"
        );
        assert_eq!(c.config()["nft_contract"], near_sdk::serde_json::Value::Null);
        assert_eq!(c.config()["markets"], near_sdk::serde_json::json!([]));
    }

    // ---- revenue: who may send it, once ------------------------------------------------------------------------

    fn delivery(msg: &str) -> String {
        let mut c = council();
        act_as(VERIFIER);
        refusal(|| drop(deliver(&mut c, MARKET, vec![COLLATERAL_ID], vec![900], msg)))
    }

    #[test]
    fn revenue_from_the_market_is_counted_kept_in_full_and_answered_with_a_zero_refund() {
        let mut c = council();
        act_as(VERIFIER);
        let out = deliver(&mut c, MARKET, vec![COLLATERAL_ID], vec![900], "revenue:7");
        assert_eq!(out, vec![U128(0)]);
        assert_eq!(c.total_received().0, 900);
        assert_eq!(c.config()["total_received"], "900");
        let e = last_event();
        assert_eq!(e["event"], "revenue");
        assert_eq!(
            (
                e["data"]["sweep_id"].as_str(),
                e["data"]["quarter"].as_u64(),
                e["data"]["amount"].as_str()
            ),
            (Some("7"), Some(u64::from(Q4_2026)), Some("900"))
        );
    }

    #[test]
    fn a_sweep_id_is_taken_once_and_the_repeat_is_refused() {
        let mut c = council();
        revenue(&mut c, 7, 900);
        act_as(VERIFIER);
        assert_eq!(
            refusal(|| drop(deliver(&mut c, MARKET, vec![COLLATERAL_ID], vec![900], "revenue:7"))),
            "that sweep was already received"
        );
        assert_eq!(c.total_received().0, 900);
        revenue(&mut c, 8, 100);
        assert_eq!(c.total_received().0, 1_000);
    }

    #[test]
    fn only_the_market_sends_revenue() {
        let mut c = council();
        act_as(VERIFIER);
        assert_eq!(
            refusal(|| drop(deliver(&mut c, "a.near", vec![COLLATERAL_ID], vec![900], "revenue:1"))),
            "revenue comes from an allowed market only"
        );
        assert_eq!(c.total_received().0, 0);
    }

    #[test]
    fn a_message_that_is_not_a_sweep_is_unknown() {
        for msg in [
            "revenue",
            "revenue:",
            "revenue:x",
            "revenue:-1",
            "deposit",
            "",
            "REVENUE:1",
            " revenue:1",
        ] {
            assert_eq!(delivery(msg), "unknown action", "{msg:?}");
        }
    }

    #[test]
    fn revenue_from_anyone_but_the_verifier_is_refused() {
        let mut c = council();
        act_as(MARKET);
        assert_eq!(
            refusal(|| drop(deliver(&mut c, MARKET, vec![COLLATERAL_ID], vec![900], "revenue:1"))),
            "only the verifier can deliver money"
        );
    }

    #[test]
    fn revenue_in_another_token_or_in_two_is_refused() {
        let mut c = council();
        act_as(VERIFIER);
        assert_eq!(
            refusal(|| drop(deliver(
                &mut c,
                MARKET,
                vec!["nep141:other.near"],
                vec![900],
                "revenue:1"
            ))),
            "wrong token"
        );
        assert_eq!(
            refusal(|| drop(deliver(
                &mut c,
                MARKET,
                vec![COLLATERAL_ID, COLLATERAL_ID],
                vec![1, 1],
                "revenue:1"
            ))),
            "exactly one token and amount"
        );
    }

    #[test]
    fn received_of_tells_the_market_what_it_sent_under_an_id() {
        let mut c = council();
        set_time(quarter_start(Q1_2027) + 5);
        revenue(&mut c, 12, 321);
        let r = c.received_of(acct(MARKET), U64(12)).unwrap();
        assert_eq!(
            (r.amount.0, r.quarter, r.at.0),
            (321, Q1_2027, quarter_start(Q1_2027) + 5)
        );
        assert!(c.received_of(acct(MARKET), U64(13)).is_none());
    }

    // ---- seats: staking mid-quarter, leaving, restaking ----------------------------------------------------------

    #[test]
    fn a_seat_earns_for_exactly_the_time_it_was_staked_and_keeps_the_right_after_it_leaves() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        leave_at(&mut c, "2", "b.near", day(46));
        set_time(day(80));
        revenue(&mut c, 1, 920_000);
        finalize(&mut c);
        // a: 92 days, b: 46 days, so two thirds and one third.
        assert_eq!(entitlement_of(&c, Q4_2026, "1", "a.near"), 613_333);
        assert_eq!(entitlement_of(&c, Q4_2026, "2", "b.near"), 306_666);
        assert_eq!(claim(&mut c, Q4_2026, "2", "b.near"), 306_666);
        assert!(!is_staked(&c, "2"), "the seat is gone from the council");
    }

    fn is_staked(c: &CouncilContract, token: &str) -> bool {
        c.stake_of(token.into()).is_some()
    }

    #[test]
    fn unstaking_returns_the_nft_and_pays_nothing() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        set_time(day(10));
        revenue(&mut c, 1, 5_000);
        leave(&mut c, "1", "a.near");
        let sent = near_sdk::test_utils::get_created_receipts();
        assert_eq!(sent[0].receiver_id, acct(NFT));
        assert!(
            sent.iter().all(|r| r.receiver_id != acct(VERIFIER)),
            "no payout leaves with the NFT"
        );
        assert_eq!(c.reward_totals().total_paid.0, 0);
    }

    #[test]
    fn the_token_restaked_by_someone_else_starts_a_span_of_its_own() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        leave_at(&mut c, "1", "a.near", day(30));
        stake(&mut c, "1", "b.near");
        set_time(day(60));
        revenue(&mut c, 1, 920_000);
        finalize(&mut c);
        // a held it 30 days until its request. b staked it later in the quarter, so b's span earns from the next quarter.
        assert_eq!(entitlement_of(&c, Q4_2026, "1", "a.near"), 920_000);
        assert_eq!(entitlement_of(&c, Q4_2026, "1", "b.near"), 0);
        assert_eq!(claim(&mut c, Q4_2026, "1", "a.near"), 920_000);
    }

    #[test]
    fn two_spans_of_one_token_by_one_owner_in_a_quarter_add_up_to_one_claim() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        leave_at(&mut c, "1", "a.near", day(10));
        set_time(day(20));
        stake(&mut c, "1", "a.near");
        set_time(day(50));
        revenue(&mut c, 1, 820_000);
        finalize(&mut c);
        // The first span is 10 days. The second starts inside the quarter, so it adds nothing to this one.
        assert_eq!(entitlement_of(&c, Q4_2026, "1", "a.near"), 820_000);
        assert_eq!(claim(&mut c, Q4_2026, "1", "a.near"), 820_000);
        act_paid("a.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q4_2026, "1".into()))),
            "already claimed"
        );
    }

    #[test]
    fn a_failed_unstake_restores_the_seat_and_it_does_not_earn_again() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(10));
        act_paid("a.near");
        c.request_unstake("1".into());
        let before = c.stake_of("1".into()).unwrap();
        act_at("a.near", day(10) + COOLDOWN_NS);
        let _ = c.unstake("1".into());
        assert_eq!(c.seat_count(), 1);
        // The NFT transfer fails an hour later.
        set_time(day(10) + COOLDOWN_NS + 3_600 * SECOND);
        act_as("council.near");
        c.on_unstaked("1".into(), before, Err(PromiseError::Failed));
        assert_eq!(last_event()["event"], "unstake_failed");
        assert_eq!(c.seat_count(), 2);
        assert_eq!(c.stake_of("1".into()).unwrap().booked_to.0, now());
        set_time(day(20));
        revenue(&mut c, 1, 1_000_000);
        finalize(&mut c);
        // Seat 1 counted until its request on day 10 and still has that request, seat 2 never left.
        let book = c.book(Q4_2026);
        assert_eq!(book.seat_ns, (92 + 10) * u128::from(DAY));
        assert_eq!(c.earning, 1);
        assert_eq!(c.stake_of("1".into()).unwrap().unlock_requested_at, Some(U64(day(10))));
        act_paid("a.near");
        c.book_seat_time("1".into(), None);
        c.book_seat_time("2".into(), None);
        let weight = |t: &str, o: &str| c.booked_weight(&(Q4_2026, t.to_string(), acct(o)));
        assert_eq!(
            weight("1", "a.near") + weight("2", "b.near"),
            book.seat_ns,
            "booked weights add up to the quarter's seat time"
        );
    }

    #[test]
    fn asking_to_leave_after_a_long_idle_stretch_needs_the_time_moved_first() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        set_time(START + 20 * 92 * DAY);
        act_paid("a.near");
        assert_eq!(refusal(|| c.request_unstake("1".into())), "call advance_quarters first");
    }

    #[test]
    fn idle_time_is_moved_forward_in_steps_by_anyone() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        let far = START + 20 * 92 * DAY;
        set_time(far);
        let target = quarter_containing(far);
        let mut calls = 0;
        while c.last_tick < far {
            act_as("anyone.near");
            let steps = c.advance_quarters(None);
            assert!((1..=MAX_QUARTER_STEPS).contains(&steps));
            calls += 1;
            assert!(calls < 10);
        }
        assert!(calls >= 2, "twenty quarters take more than one call of eight");
        act_paid("a.near");
        assert_eq!(refusal(|| c.request_unstake("1".into())), "book this seat first");
        let mut booked = 0;
        while c.stake_of("1".into()).unwrap().booked_to.0 < far {
            act_as("anyone.near");
            booked += c.book_seat_time("1".into(), Some(3));
            assert!(booked <= 3 * 10);
        }
        act_paid("a.near");
        c.request_unstake("1".into());
        act_at("a.near", far + COOLDOWN_NS);
        let _ = c.unstake("1".into());
        assert_eq!(c.seat_count(), 0);
        let total_weight: u128 = (Q4_2026..=target)
            .map(|q| c.booked_weight(&(q, "1".to_string(), acct("a.near"))))
            .sum();
        assert_eq!(
            total_weight,
            u128::from(far - START),
            "every nanosecond was counted once"
        );
    }

    #[test]
    fn advance_quarters_never_goes_past_eight_steps_whatever_is_asked() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        set_time(START + 30 * 92 * DAY);
        act_as("anyone.near");
        assert_eq!(c.advance_quarters(Some(1_000)), MAX_QUARTER_STEPS);
        assert_eq!(c.advance_quarters(Some(0)), 0);
    }

    // ---- views --------------------------------------------------------------------------------------------------

    #[test]
    fn the_quarter_views_show_state_pool_dates_and_what_was_paid() {
        let mut c = example_one();
        let open = c.current_quarter();
        assert_eq!(
            (open.quarter, open.label.as_str(), open.state),
            (Q4_2026, "2026Q4", QuarterState::Open)
        );
        assert_eq!(
            (open.starts_at.0, open.ends_at.0, open.claimable_from.0),
            (
                quarter_start(Q4_2026),
                quarter_end(Q4_2026),
                quarter_end(Q4_2026) + DEFAULT_CLOSE_GRACE_NS
            )
        );
        assert_eq!((open.revenue_in.0, open.pool.0), (1_600_000, 1_600_000));
        set_time(quarter_end(Q4_2026) + DAY);
        assert_eq!(c.get_quarter(Q4_2026).unwrap().state, QuarterState::Closing);
        assert!(c.get_quarter(Q1_2027).is_some());
        assert!(c.get_quarter(Q2_2027).is_none(), "a quarter that has not started");
        finalize(&mut c);
        claim(&mut c, Q4_2026, "1", "seat1.near");
        let fin = c.get_quarter(Q4_2026).unwrap();
        assert_eq!(
            (fin.state, fin.pool.0, fin.paid.0, fin.pending.0, fin.rolled_to),
            (QuarterState::Final, 1_600_000, 1_206_557, 0, None)
        );
        assert_eq!(fin.seat_ns.0, 122 * u128::from(DAY));
        let listed = c.list_quarters(Q4_2026, 50);
        assert_eq!(
            listed.iter().map(|q| q.quarter).collect::<Vec<_>>(),
            vec![Q4_2026, Q1_2027]
        );
        assert_eq!(c.list_quarters(Q4_2026, 1).len(), 1);
        assert!(c.list_quarters(Q2_2027, 5).is_empty());
    }

    #[test]
    fn quarter_of_names_the_quarter_of_any_time() {
        let c = council();
        let l = c.quarter_of(U64(1_798_761_599_999_999_999));
        assert_eq!(
            (l.quarter, l.label.as_str(), l.starts_at.0, l.ends_at.0),
            (Q4_2026, "2026Q4", 1_790_812_800_000_000_000, 1_798_761_600_000_000_000)
        );
    }

    #[test]
    fn an_entitlement_goes_from_accruing_to_closing_to_claimable_to_pending_to_paid() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(10));
        revenue(&mut c, 1, 1_000);
        let e = c.get_entitlement(Q4_2026, "1".into(), acct("a.near")).unwrap();
        assert_eq!(
            (e.status, e.estimated, e.amount.0, e.weight_ns.0),
            (EntitlementStatus::Accruing, true, 500, u128::from(10 * DAY))
        );
        set_time(quarter_end(Q4_2026) + DAY);
        let e = c.get_entitlement(Q4_2026, "1".into(), acct("a.near")).unwrap();
        assert_eq!(
            (e.status, e.estimated, e.amount.0),
            (EntitlementStatus::Closing, true, 500)
        );
        finalize(&mut c);
        let e = c.get_entitlement(Q4_2026, "1".into(), acct("a.near")).unwrap();
        assert_eq!(
            (e.status, e.estimated, e.amount.0),
            (EntitlementStatus::Claimable, false, 500)
        );
        claim_without_reply(&mut c, Q4_2026, "1", "a.near");
        let e = c.get_entitlement(Q4_2026, "1".into(), acct("a.near")).unwrap();
        assert_eq!(
            (e.status, e.requested_at.is_some(), e.paid_at),
            (EntitlementStatus::Pending, true, None)
        );
        act_as("council.near");
        c.on_claim_paid(
            Q4_2026,
            "1".into(),
            acct("a.near"),
            requested_at(&c, Q4_2026, "1", "a.near"),
            Ok(()),
        );
        let e = c.get_entitlement(Q4_2026, "1".into(), acct("a.near")).unwrap();
        assert_eq!(
            (e.status, e.paid_at.map(|t| t.0)),
            (EntitlementStatus::Paid, Some(now()))
        );
        assert!(c.get_entitlement(Q4_2026, "9".into(), acct("a.near")).is_none());
        assert!(c.get_entitlement(Q4_2026, "1".into(), acct("b.near")).is_none());
    }

    #[test]
    fn entitlements_of_walks_at_most_25_quarters_however_many_are_asked_for() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        for i in 0..30 {
            set_time(quarter_start(Q4_2026 + i) + DAY);
            revenue(&mut c, u64::from(i) + 1, 700);
        }
        let listed = c.entitlements_of(acct("a.near"), Q4_2026, 1_000);
        assert_eq!(listed.len(), MAX_ENTITLEMENT_QUARTERS as usize);
        assert_eq!(
            listed.last().map(|e| e.quarter),
            Some(Q4_2026 + MAX_ENTITLEMENT_QUARTERS - 1)
        );
        assert_eq!(c.entitlements_of(acct("a.near"), Q4_2026, 5).len(), 5);
    }

    #[test]
    fn a_page_covers_fewer_quarters_the_more_tokens_an_account_has_staked_but_at_least_one() {
        assert_eq!(entitlement_page(25, 0), 25);
        assert_eq!(entitlement_page(25, 10), 25);
        assert_eq!(entitlement_page(25, 20), 12);
        assert_eq!(entitlement_page(25, 250), 1);
        assert_eq!(entitlement_page(25, 1_000), 1);
        assert_eq!(entitlement_page(3, 20), 3);
        assert_eq!(entitlement_page(0, 20), 0);
    }

    #[test]
    fn an_account_with_twenty_tokens_reads_twelve_quarters_a_page_and_the_next_page_carries_on() {
        let mut c = council();
        for t in 0..20 {
            stake(&mut c, &t.to_string(), "big.near");
        }
        set_time(quarter_start(Q4_2026 + 20) + DAY);
        assert_eq!(c.entitlements_page_quarters(acct("big.near")), 12);
        assert_eq!(c.entitlements_page_quarters(acct("nobody.near")), 25);
        let page = |from: u32| -> BTreeSet<u32> {
            c.entitlements_of(acct("big.near"), from, 25)
                .iter()
                .map(|e| e.quarter)
                .collect()
        };
        assert_eq!(page(Q4_2026), (Q4_2026..Q4_2026 + 12).collect());
        assert_eq!(page(Q4_2026 + 12), (Q4_2026 + 12..=Q4_2026 + 20).collect());
    }

    #[test]
    fn an_account_lists_its_entitlements_over_current_and_past_seats() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "a.near");
        leave_at(&mut c, "2", "a.near", day(40));
        set_time(quarter_start(Q1_2027) + DAY);
        revenue(&mut c, 1, 700);
        let listed = c.entitlements_of(acct("a.near"), Q4_2026, 50);
        let ids: Vec<(u32, &str)> = listed.iter().map(|e| (e.quarter, e.token_id.as_str())).collect();
        assert_eq!(ids, vec![(Q4_2026, "1"), (Q4_2026, "2"), (Q1_2027, "1")]);
        assert_eq!(c.seats_of(acct("a.near")), vec!["1".to_string()]);
        assert!(c.entitlements_of(acct("nobody.near"), Q4_2026, 50).is_empty());
        assert_eq!(c.entitlements_of(acct("a.near"), Q4_2026, 1).len(), 2);
    }

    #[test]
    fn reward_totals_track_received_open_final_paid_and_rolled() {
        let mut c = example_one();
        let t = c.reward_totals();
        assert_eq!(
            (t.total_received.0, t.open_pool.0, t.final_unclaimed.0, t.rolled.0),
            (1_600_000, 1_600_000, 0, 0)
        );
        finalize(&mut c);
        let t = c.reward_totals();
        assert_eq!((t.open_pool.0, t.final_unclaimed.0), (0, 1_600_000));
        claim(&mut c, Q4_2026, "3", "seat3.near");
        let t = c.reward_totals();
        assert_eq!((t.total_paid.0, t.final_unclaimed.0), (393_442, 1_206_558));
    }

    #[test]
    fn config_names_the_new_settings_and_none_of_the_stream() {
        let c = council();
        let config = c.config();
        for field in ["stream_ns", "stream_remaining", "stream_ends_at"] {
            assert!(config.get(field).is_none(), "{field}");
        }
        assert_eq!(config["markets"], near_sdk::serde_json::json!([MARKET]));
        assert_eq!(config["nft_contract"], NFT);
        assert_eq!(config["close_grace_ns"], DEFAULT_CLOSE_GRACE_NS.to_string());
        assert_eq!(config["state_version"], 5);
        assert_eq!(config["next_to_finalize"], Q4_2026);
        assert_eq!(config["last_tick"], START.to_string());
    }

    // ---- what the owner can set -------------------------------------------------------------------------------

    #[test]
    fn the_owner_sets_the_grace_period_within_its_bounds() {
        let mut c = council();
        act_as(OWNER);
        c.set_close_grace_ns(U64(MIN_CLOSE_GRACE_NS));
        assert_eq!(last_event()["event"], "close_grace_set");
        c.set_close_grace_ns(U64(MAX_CLOSE_GRACE_NS));
        assert_eq!(c.config()["close_grace_ns"], MAX_CLOSE_GRACE_NS.to_string());
        for bad in [0, MIN_CLOSE_GRACE_NS - 1, MAX_CLOSE_GRACE_NS + 1] {
            assert_eq!(
                refusal(|| c.set_close_grace_ns(U64(bad))),
                "the grace period must be between 1 and 30 days",
                "{bad}"
            );
        }
    }

    #[test]
    fn the_owner_sets_the_reconcile_wait_within_its_bounds() {
        let mut c = council();
        assert_eq!(c.config()["reconcile_wait_ns"], DEFAULT_RECONCILE_WAIT_NS.to_string());
        act_as(OWNER);
        c.set_reconcile_wait_ns(U64(MIN_RECONCILE_WAIT_NS));
        let event = last_event();
        assert_eq!(event["event"], "reconcile_wait_set");
        assert_eq!(event["data"]["reconcile_wait_ns"], MIN_RECONCILE_WAIT_NS.to_string());
        c.set_reconcile_wait_ns(U64(MAX_RECONCILE_WAIT_NS));
        assert_eq!(c.config()["reconcile_wait_ns"], MAX_RECONCILE_WAIT_NS.to_string());
        for bad in [0, MIN_RECONCILE_WAIT_NS - 1, MAX_RECONCILE_WAIT_NS + 1] {
            assert_eq!(
                refusal(|| c.set_reconcile_wait_ns(U64(bad))),
                "the reconcile wait must be between 10 minutes and 7 days",
                "{bad}"
            );
        }
    }

    #[test]
    fn only_the_owner_sets_the_reconcile_wait() {
        let mut c = council();
        for who in ["a.near", ORACLE, MARKET] {
            act_as(who);
            assert_eq!(
                refusal(|| c.set_reconcile_wait_ns(U64(DEFAULT_RECONCILE_WAIT_NS))),
                "owner only",
                "{who}"
            );
        }
    }

    #[test]
    fn a_longer_reconcile_wait_refuses_a_reconcile_the_old_wait_would_allow() {
        let mut c = stuck_claim();
        act_as(OWNER);
        c.set_reconcile_wait_ns(U64(2 * DEFAULT_RECONCILE_WAIT_NS));
        set_time(clock() + RECONCILE_WAIT_NS);
        assert_eq!(
            refusal(|| c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), false)),
            "wait 120 minutes after the claim before reconciling"
        );
        set_time(clock() + RECONCILE_WAIT_NS);
        c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), false);
        assert_eq!(last_event()["event"], "claim_reconciled");
    }

    #[test]
    fn a_shorter_reconcile_wait_lets_the_owner_decide_sooner() {
        let mut c = stuck_claim();
        act_as(OWNER);
        c.set_reconcile_wait_ns(U64(MIN_RECONCILE_WAIT_NS));
        set_time(clock() + MIN_RECONCILE_WAIT_NS - 1);
        assert!(
            refusal(|| c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), false))
                .starts_with("wait 10 minutes")
        );
        set_time(clock() + 1);
        c.reconcile_claim(Q4_2026, "1".into(), acct("seat1.near"), false);
    }

    #[test]
    fn a_new_grace_period_applies_to_quarters_not_final_yet() {
        let mut c = example_one();
        act_as(OWNER);
        c.set_close_grace_ns(U64(MAX_CLOSE_GRACE_NS));
        set_time(quarter_end(Q4_2026) + DEFAULT_CLOSE_GRACE_NS);
        assert_eq!(
            refusal(|| c.finalize_quarter(Q4_2026)),
            "the quarter cannot be finalized yet"
        );
        set_time(quarter_end(Q4_2026) + MAX_CLOSE_GRACE_NS);
        c.finalize_quarter(Q4_2026);
    }

    #[test]
    fn only_the_owner_changes_the_markets_and_the_grace_period() {
        let mut c = council();
        for who in ["a.near", ORACLE, MARKET] {
            act_as(who);
            assert_eq!(refusal(|| c.allow_market(acct("other.near"))), "owner only", "{who}");
            assert_eq!(refusal(|| c.disallow_market(acct(MARKET))), "owner only", "{who}");
            assert_eq!(
                refusal(|| c.set_close_grace_ns(U64(MIN_CLOSE_GRACE_NS))),
                "owner only",
                "{who}"
            );
        }
        act_as(OWNER);
        c.allow_market(acct("new-market.near"));
        assert_eq!(last_event()["event"], "market_allowed");
        c.disallow_market(acct(MARKET));
        assert_eq!(last_event()["event"], "market_disallowed");
        assert_eq!(c.config()["markets"], near_sdk::serde_json::json!(["new-market.near"]));
        act_as(VERIFIER);
        assert_eq!(
            refusal(|| drop(deliver(&mut c, MARKET, vec![COLLATERAL_ID], vec![900], "revenue:1"))),
            "revenue comes from an allowed market only",
            "the old market no longer counts"
        );
    }

    // ---- the money identities ------------------------------------------------------------------------------------

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(80))]

        // Seats stake and leave at random inside one quarter, one sweep lands in it, and the quarter is finalized. Each seat's
        // share is exactly the pool times its staked time over everyone's, rounded down, and the shares plus the dust are the pool.
        #[test]
        fn a_share_is_the_staked_time_over_all_staked_time(
            first_len in 1u64..12,
            later in proptest::collection::vec((0u64..80, 1u64..12), 0..7),
            pool in 1u128..10_000_000_000
        ) {
            let spans: Vec<(u64, u64)> = std::iter::once((0, first_len)).chain(later).collect();
            let mut c = council();
            let mut events: Vec<(u64, bool, usize)> = vec![];
            for (i, (from, len)) in spans.iter().enumerate() {
                events.push((*from * DAY, true, i));
                events.push(((*from + *len) * DAY, false, i));
            }
            events.sort();
            let mut revenue_sent = false;
            for (at, join, i) in events {
                if !revenue_sent && at >= 85 * DAY {
                    set_time(START + 85 * DAY);
                    revenue(&mut c, 1, pool);
                    revenue_sent = true;
                }
                let (token, owner) = (i.to_string(), format!("seat{i}.near"));
                if join {
                    set_time(START + at);
                    stake(&mut c, &token, &owner);
                } else {
                    leave_at(&mut c, &token, &owner, START + at);
                }
            }
            if !revenue_sent {
                set_time(START + 85 * DAY);
                revenue(&mut c, 1, pool);
            }
            finalize(&mut c);
            let total: u128 = spans.iter().filter(|(from, _)| *from == 0).map(|(_, len)| u128::from(*len * DAY)).sum();
            let mut paid = 0u128;
            for (i, (_, len)) in spans.iter().enumerate() {
                let want = if spans[i].0 == 0 { pool * u128::from(*len * DAY) / total } else { 0 };
                let got = entitlement_of(&c, Q4_2026, &i.to_string(), &format!("seat{i}.near"));
                prop_assert_eq!(got, want, "seat {}", i);
                paid += got;
            }
            prop_assert!(paid <= pool && pool - paid < spans.len() as u128);
        }

        // Stakes, leaves, sweeps, draws with forfeits, finalizations and claims in any order and over several quarters.
        // Every unit received is in an open pool or a final pool, nothing is paid twice, the paid total is what the claims
        // paid, and once every seat is counted the weights of a finished quarter add up to its seat time less its forfeits.
        #[test]
        fn quarters_conserve_every_unit_and_never_pay_a_claim_twice(
            ops in proptest::collection::vec((0u8..10, 0u32..5, 0u32..3, 1u64..40), 1..90)
        ) {
            let mut c = council();
            let mut staked: BTreeMap<u32, u32> = BTreeMap::new();
            let mut keys: BTreeSet<(u32, u32)> = BTreeSet::new();
            let mut paid_keys: BTreeSet<(u32, u32, u32)> = BTreeSet::new();
            let (mut sent, mut paid, mut sweep, mut case) = (0u128, 0u128, 0u64, 0u64);
            let mut open_cases: Vec<(u64, Vec<AccountId>)> = vec![];
            // Seats that asked to unstake and stayed, with the time of the request.
            let mut stayed: BTreeMap<u32, u64> = BTreeMap::new();
            for (op, token, owner, amount) in ops {
                let (name, who) = (token.to_string(), format!("o{owner}.near"));
                match op {
                    0 if !staked.contains_key(&token) => {
                        stake(&mut c, &name, &who);
                        staked.insert(token, owner);
                        keys.insert((token, owner));
                    }
                    1 => {
                        sweep += 1;
                        revenue(&mut c, sweep, u128::from(amount) * 1_000_003);
                        sent += u128::from(amount) * 1_000_003;
                    }
                    2 => {
                        set_time(now() + amount * DAY);
                        act_as("keeper.near");
                        c.advance_quarters(None);
                    }
                    3 if staked.len() >= 2 => {
                        let n = 1 + (amount % 2) as u32;
                        act_with_seed(ORACLE, amount as u8);
                        if let Ok(jury) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.draw(U64(case), n, vec![]))) {
                            open_cases.push((case, jury));
                            case += 1;
                        }
                    }
                    4 if !open_cases.is_empty() => {
                        let (id, jury) = open_cases.remove(amount as usize % open_cases.len());
                        let silent: Vec<AccountId> = jury.iter().enumerate().filter(|(i, _)| (amount >> i) & 1 == 1).map(|(_, a)| a.clone()).collect();
                        act_as(ORACLE);
                        c.unlock_case(U64(id), silent);
                    }
                    5 if staked.contains_key(&token) && c.stake_of(name.clone()).is_some_and(|s| s.serving.is_none() && s.unlock_requested_at.is_none()) => {
                        let owner_of = staked[&token];
                        leave(&mut c, &name, &format!("o{owner_of}.near"));
                        staked.remove(&token);
                    }
                    9 if staked.contains_key(&token) && !stayed.contains_key(&token) && c.stake_of(name.clone()).is_some_and(|s| s.serving.is_none()) => {
                        let owner_of = staked[&token];
                        act_paid(&format!("o{owner_of}.near"));
                        c.request_unstake(name.clone());
                        stayed.insert(token, now());
                    }
                    6 => {
                        let q = c.next_to_finalize;
                        let end = quarter_end(q);
                        let no_early_jury = c.open_juries.keys().next().is_none_or(|drawn| *drawn >= end);
                        if now() >= end + c.close_grace_ns && (no_early_jury || now() >= end + MAX_CLOSE_GRACE_NS) {
                            act_as("keeper.near");
                            c.advance_quarters(None);
                            if c.last_tick >= quarter_end(q) {
                                c.finalize_quarter(q);
                            }
                        }
                    }
                    7 | 8 => {
                        let candidates: Vec<(u32, u32, u32)> = (c.next_to_finalize.saturating_sub(4)..c.next_to_finalize)
                            .flat_map(|q| keys.iter().map(move |(t, o)| (q, *t, *o)))
                            .collect();
                        if !candidates.is_empty() {
                            let (q, t, o) = candidates[amount as usize % candidates.len()];
                            let view = c.get_entitlement(q, t.to_string(), acct(&format!("o{o}.near")));
                            if view.as_ref().is_some_and(|e| e.status == EntitlementStatus::Claimable && e.amount.0 > 0) {
                                let got = claim_without_reply(&mut c, q, &t.to_string(), &format!("o{o}.near"));
                                let at = requested_at(&c, q, &t.to_string(), &format!("o{o}.near"));
                                act_as("council.near");
                                if op == 7 {
                                    c.on_claim_paid(q, t.to_string(), acct(&format!("o{o}.near")), at, Ok(()));
                                    prop_assert!(paid_keys.insert((q, t, o)), "claim paid twice");
                                    paid += got;
                                } else {
                                    c.on_claim_paid(q, t.to_string(), acct(&format!("o{o}.near")), at, Err(PromiseError::Failed));
                                }
                            }
                        }
                    }
                    _ => {}
                }
                prop_assert_eq!(c.total_received, sent);
                prop_assert_eq!(c.open_pool + c.final_pool, sent, "a unit is in no pool or in two");
                prop_assert_eq!(c.total_paid, paid);
                prop_assert!(c.final_pool >= c.total_paid + c.pending_total);
            }
            // Count every seat and every quarter, then compare the weights with the seat time.
            act_as("keeper.near");
            while c.last_tick < now() {
                c.advance_quarters(None);
            }
            let tokens: Vec<TokenId> = staked.keys().map(|t| t.to_string()).collect();
            for t in tokens {
                let until = counted_until(&c.stake_of(t.clone()).unwrap(), now());
                while c.stake_of(t.clone()).unwrap().booked_to.0 < until {
                    c.book_seat_time(t.clone(), None);
                }
            }
            for (token, requested) in &stayed {
                prop_assert_eq!(c.earning as usize, staked.len() - stayed.len());
                for q in quarter_containing(*requested) + 1..=quarter_containing(now()) {
                    let owner = format!("o{}.near", staked[token]);
                    let counted = c.seat_weight.get(&(q, token.to_string(), acct(&owner))).copied().unwrap_or(0);
                    prop_assert_eq!(counted, 0, "a seat that asked to leave kept earning in quarter {}", q);
                }
            }
            for q in Q4_2026..quarter_containing(now()) {
                let book = c.book(q);
                let weights: u128 = keys
                    .iter()
                    .flat_map(|(t, _)| (0..3).map(move |o| (*t, o)))
                    .collect::<BTreeSet<_>>()
                    .iter()
                    .map(|(t, o)| c.booked_weight(&(q, t.to_string(), acct(&format!("o{o}.near")))))
                    .sum();
                prop_assert_eq!(weights, book.seat_ns - book.forfeit_ns, "weights of quarter {} differ from its seat time", q);
                if book.finalized && book.weight_total > 0 {
                    let shares: u128 = (0..5u32)
                        .flat_map(|t| (0..3u32).map(move |o| (t, o)))
                        .map(|(t, o)| entitlement(book.pool, c.booked_weight(&(q, t.to_string(), acct(&format!("o{o}.near")))), book.weight_total))
                        .sum();
                    prop_assert!(shares <= book.pool);
                    prop_assert!(book.pool - shares < 15, "more than a unit a seat was left over");
                }
            }
        }
    }

    // ---- a seat that asked to leave, and a jury still open when a quarter closes ----------------------------------

    #[test]
    fn a_seat_that_asked_to_leave_earns_only_up_to_its_request() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(10));
        act_paid("a.near");
        c.request_unstake("1".into());
        assert_eq!(c.earning, 1);
        set_time(day(40));
        revenue(&mut c, 1, 1_020_000);
        finalize(&mut c);
        // Seat 1 never unstakes. It has 10 days of 102, seat 2 has all 92.
        assert_eq!(c.book(Q4_2026).seat_ns, 102 * u128::from(DAY));
        assert_eq!(entitlement_of(&c, Q4_2026, "1", "a.near"), 100_000);
        assert_eq!(entitlement_of(&c, Q4_2026, "2", "b.near"), 920_000);
        assert_eq!(claim(&mut c, Q4_2026, "1", "a.near"), 100_000);
        assert_eq!(claim(&mut c, Q4_2026, "2", "b.near"), 920_000);
    }

    #[test]
    fn a_leaving_seat_is_paid_nothing_in_the_quarters_after_its_request() {
        let mut c = council();
        for (token, owner) in [("1", "a.near"), ("2", "b.near"), ("3", "c.near")] {
            stake(&mut c, token, owner);
        }
        act_paid("a.near");
        c.request_unstake("1".into());
        // Three seats are staked and one is leaving, so a jury of three cannot be drawn.
        act_as(ORACLE);
        assert_eq!(
            refusal(|| drop(c.draw(U64(1), 3, vec![]))),
            "not enough seat holders to draw a jury: 2 eligible, 3 needed"
        );
        set_time(quarter_start(Q1_2027) + DAY);
        revenue(&mut c, 1, 920_000);
        set_time(quarter_start(Q2_2027) + DAY);
        finalize(&mut c);
        finalize(&mut c);
        assert_eq!(entitlement_of(&c, Q1_2027, "1", "a.near"), 0);
        assert_eq!(entitlement_of(&c, Q1_2027, "2", "b.near"), 460_000);
        assert_eq!(entitlement_of(&c, Q1_2027, "3", "c.near"), 460_000);
        act_paid("a.near");
        assert_eq!(
            refusal(|| drop(c.claim_quarter(Q1_2027, "1".into()))),
            "nothing to claim"
        );
    }

    const CASE_DRAWN_BEFORE_END: u64 = 3 * DAY;

    // A one day grace period: a juror drawn three days before the quarter ends whose case is
    // still open after the grace.
    fn a_juror_drawn_before_the_quarter_ends() -> (CouncilContract, AccountId) {
        let mut c = council();
        for (token, owner) in [("1", "a.near"), ("2", "b.near"), ("3", "c.near")] {
            stake(&mut c, token, owner);
        }
        act_as(OWNER);
        c.set_close_grace_ns(U64(MIN_CLOSE_GRACE_NS));
        set_time(quarter_end(Q4_2026) - CASE_DRAWN_BEFORE_END);
        act_with_seed(ORACLE, 1);
        let juror = c.draw(U64(1), 1, vec![]).remove(0);
        revenue(&mut c, 1, 900_000);
        (c, juror)
    }

    #[test]
    fn a_quarter_waits_for_a_jury_drawn_before_its_end() {
        let (mut c, juror) = a_juror_drawn_before_the_quarter_ends();
        set_time(quarter_end(Q4_2026) + MIN_CLOSE_GRACE_NS);
        assert_eq!(
            refusal(|| c.finalize_quarter(Q4_2026)),
            "a jury drawn in this quarter is still open"
        );
        // The case ends with the juror silent: the forfeit still lands in the quarter and then it can be finalized.
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![juror]);
        assert_eq!(c.book(Q4_2026).forfeit_ns, u128::from(CASE_DRAWN_BEFORE_END));
        c.finalize_quarter(Q4_2026);
        assert_eq!(c.next_to_finalize, Q1_2027);
        assert!(c.open_juries.is_empty());
    }

    #[test]
    fn a_lost_release_cannot_hold_a_quarter_past_the_longest_grace() {
        let (mut c, _) = a_juror_drawn_before_the_quarter_ends();
        set_time(quarter_end(Q4_2026) + MAX_CLOSE_GRACE_NS - 1);
        assert_eq!(
            refusal(|| c.finalize_quarter(Q4_2026)),
            "a jury drawn in this quarter is still open"
        );
        set_time(quarter_end(Q4_2026) + MAX_CLOSE_GRACE_NS);
        c.finalize_quarter(Q4_2026);
        assert_eq!(c.next_to_finalize, Q1_2027);
    }

    #[test]
    fn a_jury_drawn_after_the_quarter_ends_does_not_hold_it() {
        let (mut c, _) = a_juror_drawn_before_the_quarter_ends();
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![]);
        set_time(quarter_end(Q4_2026) + 1);
        act_with_seed(ORACLE, 2);
        c.draw(U64(2), 1, vec![]);
        set_time(quarter_end(Q4_2026) + MIN_CLOSE_GRACE_NS);
        c.finalize_quarter(Q4_2026);
        assert_eq!(c.next_to_finalize, Q1_2027);
    }

    #[test]
    fn releasing_a_case_twice_closes_it_once() {
        let (mut c, _) = a_juror_drawn_before_the_quarter_ends();
        act_with_seed(ORACLE, 3);
        c.draw(U64(2), 1, vec![]);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![]);
        c.unlock_case(U64(1), vec![]);
        assert_eq!(c.open_juries.values().sum::<u32>(), 1);
    }

    // ---- attacks: economics -------------------------------------------------------------------------

    // The jury is drawn per seat, so the chance that an attacker controls a majority of it depends on the share of seats
    // they hold and on how many jurors there are. Measured by drawing 150 juries from a council of 1,000 honest seats plus
    // the attacker's, held 10 to a wallet (the most one account may hold). Smaller than the real odds are precise, but
    // the shape is what matters: a bigger jury makes capture far harder than a bigger council does.
    #[test]
    fn the_chance_an_attacker_controls_a_jury_by_how_many_seats_they_hold() {
        const TRIALS: u32 = 150;
        let honest_seats = 1_000u32;
        let mut report = String::from("\nchance an attacker holds a majority of the jury, 150 draws, 10 seats per attacker wallet\n  attacker seats | jury of 3 | jury of 11 | jury of 21\n");
        let mut previous = [0.0f64; 3];
        for attacker_seats in [0u32, 100, 300, 500] {
            let total = honest_seats + attacker_seats;
            let candidates: Vec<(TokenId, AccountId)> = (0..total)
                .map(|i| {
                    if i < honest_seats {
                        (format!("h{i}"), acct(&format!("honest{i}.near")))
                    } else {
                        (
                            format!("a{i}"),
                            acct(&format!("attacker{}.near", (i - honest_seats) / 10)),
                        )
                    }
                })
                .collect();
            let mut rows = [0.0f64; 3];
            for (column, jury_size) in [3u32, 11, 21].into_iter().enumerate() {
                let mut captured = 0u32;
                for trial in 0..TRIALS {
                    // The mock chain meters gas over a whole test, so start each draw with a fresh allowance.
                    act_as(OWNER);
                    let seed = env::sha256(trial.to_le_bytes());
                    let jury = pick(candidates.clone(), &seed, trial as u64, jury_size);
                    let attackers = jury.iter().filter(|(_, a)| a.as_str().starts_with("attacker")).count() as u32;
                    if attackers > jury_size / 2 {
                        captured += 1;
                    }
                }
                rows[column] = captured as f64 / TRIALS as f64;
            }
            report.push_str(&format!(
                "  {attacker_seats:>6} ({:>4.1}%) | {:>8.2}% | {:>9.2}% | {:>9.2}%\n",
                attacker_seats as f64 * 100.0 / total as f64,
                rows[0] * 100.0,
                rows[1] * 100.0,
                rows[2] * 100.0
            ));
            for column in 0..3 {
                assert!(
                    rows[column] + 0.06 >= previous[column],
                    "more seats should not make capture less likely"
                );
            }
            previous = rows;
            if attacker_seats == 0 {
                assert!(
                    rows.iter().all(|r| *r == 0.0),
                    "an attacker with no seats never sits on a jury"
                );
            }
            if attacker_seats == 100 {
                assert!(
                    rows[2] < 0.01,
                    "9% of the seats captured {:.2}% of juries of 21",
                    rows[2] * 100.0
                );
            }
            if attacker_seats == 500 {
                assert!(
                    rows[2] < rows[0],
                    "a jury of 21 is harder to capture than a jury of 3: {rows:?}"
                );
            }
        }
        println!("{report}");
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(60))]

    }

    #[test]
    #[should_panic(expected = "that account already holds the most seats allowed")]
    fn an_account_cannot_stake_past_its_cap() {
        let mut c = council();
        act_as(OWNER);
        c.set_max_seats_per_account(2);
        stake(&mut c, "t1", "a.near");
        stake(&mut c, "t2", "a.near");
        stake(&mut c, "t3", "a.near");
    }

    #[test]
    fn the_cap_is_per_account_and_frees_up_when_a_seat_leaves() {
        let mut c = council();
        act_as(OWNER);
        c.set_max_seats_per_account(1);
        stake(&mut c, "t1", "a.near");
        stake(&mut c, "t2", "b.near");
        assert_eq!(c.seat_count(), 2, "a second account is not held back by the first");

        leave(&mut c, "t1", "a.near");
        stake(&mut c, "t3", "a.near");
        assert!(c.is_seat(acct("a.near")));
    }

    #[test]
    fn lowering_the_cap_does_not_remove_seats_already_held() {
        let mut c = council();
        for i in 0..3 {
            stake(&mut c, &i.to_string(), "a.near");
        }
        act_as(OWNER);
        c.set_max_seats_per_account(1);
        assert_eq!(c.seat_count(), 3);
        assert_eq!(c.config()["max_seats_per_account"], 1);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_stranger_cannot_change_the_cap() {
        let mut c = council();
        act_as("a.near");
        c.set_max_seats_per_account(1);
    }

    #[test]
    #[should_panic(expected = "an account must be allowed at least one seat")]
    fn a_cap_of_zero_is_refused() {
        let mut c = council();
        act_as(OWNER);
        c.set_max_seats_per_account(0);
    }

    #[test]
    fn a_seat_that_asked_to_unstake_is_never_drawn() {
        let mut c = council();
        for i in 0..4 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        act_at("seat0.near", START + 1);
        c.request_unstake("0".into());
        // Three of the four seats are drawn each time, so one draw could miss the seat by luck. Twenty cannot.
        act_as(ORACLE);
        for case in 0..20u64 {
            act_with_seed(ORACLE, case as u8);
            let jury = c.draw(U64(case), 3, vec![]);
            assert!(
                !jury.contains(&acct("seat0.near")),
                "the seat on its way out is left out of case {case}"
            );
            assert_eq!(jury.len(), 3);
            c.unlock_case(U64(case), vec![]);
        }
    }

    #[test]
    #[should_panic(expected = "not enough seat holders to draw a jury: 3 eligible, 4 needed")]
    fn a_seat_on_its_way_out_does_not_count_towards_a_full_jury() {
        let mut c = council();
        for i in 0..4 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        act_at("seat0.near", START + 1);
        c.request_unstake("0".into());
        act_as(ORACLE);
        c.draw(U64(1), 4, vec![]);
    }

    #[test]
    #[should_panic(expected = "the cooldown has not passed")]
    fn an_unstake_waits_the_full_cooldown() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_at("a.near", START + 1);
        c.request_unstake("t1".into());
        act_at("a.near", START + 1 + COOLDOWN_NS - 1);
        let _ = c.unstake("t1".into());
    }

    #[test]
    fn the_owner_changes_the_cooldown_and_it_applies_to_a_request_already_made() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_at("a.near", START + 1);
        c.request_unstake("t1".into());
        act_as(OWNER);
        c.set_cooldown_ns(U64(3 * COOLDOWN_NS));
        assert_eq!(c.config()["cooldown_ns"], (3 * COOLDOWN_NS).to_string());
        // The old length no longer frees the seat, the new one does.
        act_at("a.near", START + 1 + COOLDOWN_NS);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.unstake("t1".into());
        }))
        .is_err());
        act_at("a.near", START + 1 + 3 * COOLDOWN_NS);
        let _ = c.unstake("t1".into());
        assert_eq!(c.seat_count(), 0);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_stranger_cannot_change_the_cooldown() {
        let mut c = council();
        act_as("a.near");
        c.set_cooldown_ns(U64(1));
    }

    #[test]
    #[should_panic(expected = "the cooldown must be positive")]
    fn a_zero_cooldown_is_refused() {
        let mut c = council();
        act_as(OWNER);
        c.set_cooldown_ns(U64(0));
    }

    #[test]
    fn a_failed_upgrade_batch_clears_the_in_flight_flag_and_a_good_one_leaves_it() {
        let mut c = council();
        c.upgrade_in_flight = true;
        c.on_upgrade_done(Ok(()));
        assert!(c.upgrade_in_flight);
        c.on_upgrade_done(Err(PromiseError::Failed));
        assert!(!c.upgrade_in_flight);
    }

    #[test]
    fn a_cooldown_longer_than_a_year_is_refused() {
        let mut c = council();
        act_as(OWNER);
        assert!(refusal(|| c.set_cooldown_ns(U64(MAX_COOLDOWN_NS + 1))).contains("at most a year"));
        c.set_cooldown_ns(U64(MAX_COOLDOWN_NS));
    }

    #[test]
    fn revenue_must_come_from_the_senders_own_balance() {
        let mut c = council();
        act_as(VERIFIER);
        let message = refusal(|| {
            drop(c.mt_on_transfer(
                acct(MARKET),
                vec![acct("someone.else.near")],
                vec![COLLATERAL_ID.to_string()],
                vec![U128(900)],
                format!("{REVENUE_PREFIX}1"),
            ))
        });
        assert!(message.contains("the sender's own balance"), "{message}");
    }

    #[test]
    #[should_panic(expected = "the collateral token id must look like nep141:<token>")]
    fn a_collateral_id_without_the_nep141_prefix_is_refused_at_init() {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as(OWNER);
        CouncilContract::new(
            acct(OWNER),
            acct(ORACLE),
            acct(VERIFIER),
            "usd.near".to_string(),
            U64(COOLDOWN_NS),
            MAX_SEATS,
            None,
        );
    }

    #[test]
    fn config_names_the_verifier_and_the_exact_token_id() {
        let c = council();
        let config = c.config();
        assert_eq!(config["verifier"], VERIFIER);
        assert_eq!(config["collateral_token_id"], COLLATERAL_ID);
        assert!(config.get("collateral").is_none());
    }

    fn mt_transfer_of(r: &near_sdk::mock::Receipt) -> (near_sdk::serde_json::Value, u128, u64) {
        assert_eq!(r.receiver_id, acct(VERIFIER));
        match &r.actions[0] {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                ..
            } => {
                assert_eq!(method_name.as_slice(), b"mt_transfer");
                (
                    near_sdk::serde_json::from_slice(args).unwrap(),
                    attached_deposit.as_yoctonear(),
                    prepaid_gas.as_gas(),
                )
            }
            other => panic!("not a function call: {other:?}"),
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn a_draw_is_distinct_eligible_and_repeatable(
            owners in proptest::collection::vec(0usize..12, 1..40),
            excluded in proptest::collection::vec(any::<bool>(), 12),
            n_raw in 0usize..40,
            seed in proptest::collection::vec(any::<u8>(), 32),
            case_key in any::<u64>()
        ) {
            council();
            let name = |o: usize| acct(&format!("seat{o}.near"));
            let exclude: Vec<AccountId> = (0..12).filter(|o| excluded[*o]).map(name).collect();
            let candidates: Vec<(TokenId, AccountId)> =
                owners.iter().enumerate().map(|(t, o)| (t.to_string(), name(*o))).filter(|(_, a)| !exclude.contains(a)).collect();
            let eligible = candidates.iter().map(|(_, a)| a).collect::<BTreeSet<_>>().len();
            let n = (n_raw % (eligible + 1)) as u32;

            let jury = pick(candidates.clone(), &seed, case_key, n);
            prop_assert_eq!(jury.len(), n as usize);
            let accounts: BTreeSet<&AccountId> = jury.iter().map(|(_, a)| a).collect();
            prop_assert_eq!(accounts.len(), jury.len(), "someone was drawn twice");
            for seat in &jury {
                prop_assert!(candidates.contains(seat), "{:?} was not eligible", seat);
            }
            prop_assert_eq!(pick(candidates, &seed, case_key, n), jury);
        }

        #[test]
        fn staking_and_unstaking_keep_the_seat_list_exact(
            ops in proptest::collection::vec((any::<bool>(), 0usize..20, 0usize..4), 1..80)
        ) {
            let mut c = council();
            let mut model: BTreeMap<TokenId, AccountId> = BTreeMap::new();
            let mut t = START;
            for (add, token, owner) in ops {
                let token = token.to_string();
                let owner = acct(&format!("o{owner}.near"));
                if add && !model.contains_key(&token) {
                    stake(&mut c, &token, owner.as_str());
                    model.insert(token, owner);
                } else if !add {
                    if let Some(owner) = model.remove(&token) {
                        act_at(owner.as_str(), t);
                        c.request_unstake(token.clone());
                        t += COOLDOWN_NS;
                        act_at(owner.as_str(), t);
                        let _ = c.unstake(token);
                    }
                }
                prop_assert_eq!(tokens(&c), model.keys().cloned().collect::<BTreeSet<_>>());
                for o in 0..4 {
                    let a = acct(&format!("o{o}.near"));
                    prop_assert_eq!(c.is_seat(a.clone()), model.values().any(|v| *v == a));
                }
            }
        }
    }

    // ---- the allowlist -------------------------------------------------------------------------------------

    fn guarded_council() -> CouncilContract {
        council_with(None)
    }

    fn refused_stake(c: &mut CouncilContract, token: &str) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| stake(c, token, "a.near"))).is_err()
    }

    fn last_event() -> near_sdk::serde_json::Value {
        let logs = near_sdk::test_utils::get_logs();
        near_sdk::serde_json::from_str(logs.last().unwrap().strip_prefix("EVENT_JSON:").unwrap()).unwrap()
    }

    #[test]
    fn a_new_council_stakes_nothing_until_the_owner_allows_tokens() {
        let mut c = guarded_council();
        assert_eq!(c.config()["allowlist_enabled"], true);
        assert!(!c.is_allowed("1".into()));
        assert!(refused_stake(&mut c, "1"));
        assert_eq!(c.seat_count(), 0);
    }

    #[test]
    #[should_panic(expected = "that token is not on the allowlist")]
    fn a_refused_stake_says_why_so_the_token_goes_back_to_its_owner() {
        let mut c = guarded_council();
        stake(&mut c, "1", "a.near");
    }

    #[test]
    fn only_the_named_tokens_can_stake() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.allow_tokens(vec!["alpha".into(), "beta".into()]);
        stake(&mut c, "alpha", "a.near");
        stake(&mut c, "beta", "b.near");
        assert!(refused_stake(&mut c, "gamma"));
        assert_eq!(c.seat_count(), 2);
        assert!(c.is_allowed("alpha".into()) && !c.is_allowed("gamma".into()));
    }

    #[test]
    fn naming_a_token_twice_changes_nothing() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.allow_tokens(vec!["alpha".into(), "alpha".into()]);
        c.allow_tokens(vec!["alpha".into()]);
        stake(&mut c, "alpha", "a.near");
        assert_eq!(c.seat_count(), 1);
    }

    #[test]
    fn a_range_allows_the_numbers_inside_it_both_ends_included() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.set_token_range(U64(10), U64(20));
        for inside in ["10", "15", "20"] {
            assert!(c.is_allowed(inside.into()), "{inside}");
        }
        for outside in ["9", "21", "0", "100"] {
            assert!(!c.is_allowed(outside.into()), "{outside}");
        }
        stake(&mut c, "10", "a.near");
        stake(&mut c, "20", "b.near");
        assert!(refused_stake(&mut c, "21"));
    }

    // "007" and "+7" parse as 7. If they counted, anyone able to mint an id of that shape could stake past a fixed supply.
    #[test]
    fn only_the_plain_decimal_form_of_a_number_is_in_the_range() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.set_token_range(U64(0), U64(u64::MAX));
        for odd in [
            "007",
            "+7",
            " 7",
            "7 ",
            "7a",
            "-1",
            "0x7",
            "00",
            "18446744073709551616",
            "",
            "seven",
        ] {
            assert!(!c.is_allowed(odd.into()), "{odd:?} is not a plain number");
        }
        for plain in ["0", "7", "18446744073709551615"] {
            assert!(c.is_allowed(plain.into()), "{plain}");
        }
    }

    #[test]
    fn the_range_and_the_named_tokens_work_together_and_a_new_range_replaces_the_old() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.allow_tokens(vec!["special".into()]);
        c.set_token_range(U64(1), U64(5));
        assert!(c.is_allowed("special".into()) && c.is_allowed("3".into()));
        c.set_token_range(U64(50), U64(60));
        assert!(!c.is_allowed("3".into()) && c.is_allowed("55".into()) && c.is_allowed("special".into()));
        c.clear_token_range();
        assert!(!c.is_allowed("55".into()) && c.is_allowed("special".into()));
        assert_eq!(c.config()["allowed_range"], near_sdk::serde_json::Value::Null);
    }

    #[test]
    #[should_panic(expected = "the first id must not be above the last")]
    fn a_range_backwards_is_refused() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.set_token_range(U64(5), U64(4));
    }

    #[test]
    fn switching_the_list_off_lets_any_token_in_and_on_again_keeps_the_seats_already_staked() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.set_allowlist_enabled(false);
        stake(&mut c, "anything", "a.near");
        assert!(c.is_allowed("whatever".into()));
        act_as(OWNER);
        c.set_allowlist_enabled(true);
        assert!(refused_stake(&mut c, "something-else"));
        assert!(c.stake_of("anything".into()).is_some(), "the seat that was in stays in");
    }

    fn switch_collection(c: &mut CouncilContract, to: &str) {
        act_as(OWNER);
        c.set_nft_contract(acct(to));
    }

    fn stake_from(c: &mut CouncilContract, collection: &str, token: &str) {
        act_as(collection);
        let _ = c.nft_on_transfer(acct("market.near"), acct("a.near"), token.to_string(), String::new());
        confirm_stake_from(c, collection, token, "a.near");
    }

    #[test]
    fn named_tokens_allowed_for_one_collection_are_not_allowed_for_the_next() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.allow_tokens(vec!["alpha".into()]);
        assert!(c.is_allowed("alpha".into()));
        switch_collection(&mut c, "other-nft.near");
        assert!(!c.is_allowed("alpha".into()));
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            stake_from(&mut c, "other-nft.near", "alpha");
        }));
        assert!(
            caught.is_err(),
            "an id allowed for the old collection must not stake from the new one"
        );
        act_as(OWNER);
        c.allow_tokens(vec!["beta".into()]);
        stake_from(&mut c, "other-nft.near", "beta");
        assert_eq!(c.seat_count(), 1);
    }

    #[test]
    fn a_range_set_for_one_collection_is_not_in_force_for_the_next_and_shows_so() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.set_token_range(U64(1), U64(1_000));
        assert!(c.is_allowed("500".into()));
        switch_collection(&mut c, "other-nft.near");
        assert!(!c.is_allowed("500".into()));
        assert_eq!(c.config()["allowed_range"], near_sdk::serde_json::Value::Null);
        act_as(OWNER);
        c.set_token_range(U64(5), U64(6));
        assert!(c.is_allowed("5".into()) && !c.is_allowed("500".into()));
        assert_eq!(
            c.config()["allowed_range"],
            near_sdk::serde_json::json!({ "first": "5", "last": "6" })
        );
    }

    #[test]
    fn going_back_to_a_collection_brings_its_own_entries_back() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.allow_tokens(vec!["alpha".into()]);
        switch_collection(&mut c, "other-nft.near");
        switch_collection(&mut c, NFT);
        assert!(c.is_allowed("alpha".into()));
    }

    #[test]
    fn a_batch_is_capped_and_must_name_something() {
        let mut c = guarded_council();
        act_as(OWNER);
        let ids = |n: usize| (0..n).map(|i| format!("t{i}")).collect::<Vec<_>>();
        c.allow_tokens(ids(MAX_ALLOW_BATCH));
        assert!(c.is_allowed(format!("t{}", MAX_ALLOW_BATCH - 1)));
        for bad in [ids(MAX_ALLOW_BATCH + 1), vec![]] {
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.allow_tokens(bad)));
            assert!(caught.is_err());
        }
    }

    #[test]
    fn every_owner_action_on_the_list_says_so_in_an_event() {
        let mut c = guarded_council();
        act_as(OWNER);
        c.allow_tokens(vec!["a".into(), "b".into()]);
        let e = last_event();
        assert_eq!(
            (e["event"].as_str(), e["data"].clone()),
            (
                Some("tokens_allowed"),
                near_sdk::serde_json::json!({ "nft_contract": NFT, "token_ids": ["a", "b"] })
            )
        );
        act_as(OWNER);
        c.set_token_range(U64(3), U64(9));
        let e = last_event();
        assert_eq!(
            (e["event"].as_str(), e["data"].clone()),
            (
                Some("token_range_set"),
                near_sdk::serde_json::json!({ "nft_contract": NFT, "first": "3", "last": "9" })
            )
        );
        act_as(OWNER);
        c.clear_token_range();
        assert_eq!(last_event()["event"], "token_range_cleared");
        act_as(OWNER);
        c.set_allowlist_enabled(false);
        let e = last_event();
        assert_eq!(
            (e["event"].as_str(), e["data"]["enabled"].clone()),
            (Some("allowlist_set"), near_sdk::serde_json::json!(false))
        );
    }

    #[test]
    fn only_the_owner_changes_the_list() {
        let mut c = guarded_council();
        let calls: [fn(&mut CouncilContract); 4] = [
            |c| c.allow_tokens(vec!["1".into()]),
            |c| c.set_token_range(U64(0), U64(1)),
            |c| c.clear_token_range(),
            |c| c.set_allowlist_enabled(false),
        ];
        for (n, call) in calls.into_iter().enumerate() {
            act_as("a.near");
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(&mut c)));
            assert!(caught.is_err(), "list method number {n} must refuse a stranger");
        }
        assert!(!c.is_allowed("1".into()) && c.config()["allowlist_enabled"] == true);
    }

    // ---- total received -----------------------------------------------------------------------------------

    // ---- gas floors ---------------------------------------------------------------------------------------

    fn act_with_gas(who: &str, tgas: u64) {
        testing_env!(context(who)
            .attached_deposit(NearToken::from_yoctonear(1))
            .prepaid_gas(Gas::from_tgas(tgas))
            .build());
    }

    fn refusal(f: impl FnOnce()) -> String {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a refusal");
        let message = err
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        // A panic raised through the host reaches the test inside its error, with the contract's own text in it.
        match message.split_once("panic_msg: \"") {
            Some((_, rest)) => rest.split('"').next().unwrap_or_default().to_string(),
            None => message,
        }
    }

    // ---- code: staging, upgrade, migrate and seal ---------------------------------------------------------

    const WASM: &[u8] = &[0, 97, 115, 109, 1, 0, 0, 0, 9, 9, 9];
    const KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

    fn stage_wasm(c: &mut CouncilContract, deposit: NearToken) -> Base58CryptoHash {
        let mut builder = context("anyone.near");
        builder.attached_deposit(deposit);
        builder.context.input = WASM.to_vec().into();
        testing_env!(builder.build());
        c.stage_code()
    }

    fn staged(c: &mut CouncilContract) -> Base58CryptoHash {
        stage_wasm(c, NearToken::from_near(5))
    }

    fn receipts() -> Vec<near_sdk::mock::Receipt> {
        near_sdk::test_utils::get_created_receipts()
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn staging_with_too_little_deposit_is_refused() {
        let mut c = council();
        stage_wasm(&mut c, NearToken::from_yoctonear(1));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_stranger_cannot_upgrade() {
        let mut c = council();
        let hash = staged(&mut c);
        act_as("a.near");
        let _ = c.upgrade(hash);
    }

    #[test]
    #[should_panic(expected = "no code is staged under that hash")]
    fn an_upgrade_to_a_hash_nobody_staged_is_refused() {
        let mut c = council();
        act_as(OWNER);
        let _ = c.upgrade(Base58CryptoHash::from([5u8; 32]));
    }

    #[test]
    #[should_panic(expected = "attach at least 100 TGas to upgrade")]
    fn an_upgrade_with_too_little_gas_is_refused_and_says_how_much() {
        let mut c = council();
        let hash = staged(&mut c);
        testing_env!(context(OWNER).prepaid_gas(Gas::from_tgas(99)).build());
        let _ = c.upgrade(hash);
    }

    #[test]
    fn the_owner_deploys_the_staged_code_and_migrates_in_one_batch_and_the_copy_is_removed() {
        let mut c = council();
        let hash = staged(&mut c);
        assert!(c.is_staged(hash));
        act_as(OWNER);
        let _ = c.upgrade(hash);
        assert!(!c.is_staged(hash), "the staged copy is gone");
        let batch = &receipts()[0];
        assert_eq!(batch.receiver_id.as_str(), "alice.near");
        assert!(matches!(&batch.actions[0], near_sdk::mock::MockAction::DeployContract { code, .. } if code == WASM));
        assert!(
            matches!(&batch.actions[1], near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } if method_name == b"migrate")
        );
    }

    #[test]
    #[should_panic(expected = "prove the upgrade path before deleting keys")]
    fn seal_is_refused_until_an_upgrade_has_gone_through() {
        let mut c = council();
        act_as(OWNER);
        let _ = c.seal(KEY.parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_stranger_cannot_seal() {
        let mut c = council();
        c.upgrade_proven = true;
        act_as("a.near");
        let _ = c.seal(KEY.parse().unwrap());
    }

    #[test]
    fn once_proven_the_owner_deletes_a_key() {
        let mut c = council();
        c.upgrade_proven = true;
        act_as(OWNER);
        let _ = c.seal(KEY.parse().unwrap());
        assert!(
            matches!(&receipts()[0].actions[0], near_sdk::mock::MockAction::DeleteKey { public_key, .. } if public_key.to_string() == KEY)
        );
    }

    #[test]
    fn migrate_keeps_the_seats_and_marks_the_upgrade_proven() {
        let mut c = council();
        stake(&mut c, "7", "o0.near");
        assert!(!c.upgrade_proven);
        c.upgrade_in_flight = true;
        env::state_write(&c);
        drop(c);
        testing_env!(context("alice.near").build());
        let migrated = CouncilContract::migrate();
        assert_eq!(
            (
                (migrated.upgrade_proven, migrated.upgrade_in_flight),
                migrated.state_version,
                migrated.seat_count()
            ),
            ((true, false), STATE_VERSION, 1)
        );
        assert_eq!(migrated.config()["upgrade_proven"], true);
    }

    #[test]
    #[should_panic(expected = "migrate runs only inside an upgrade")]
    fn migrate_called_by_hand_is_refused_and_proves_nothing() {
        let c = council();
        env::state_write(&c);
        drop(c);
        testing_env!(context("alice.near").build());
        CouncilContract::migrate();
    }

    #[test]
    fn upgrade_marks_the_upgrade_in_flight_and_a_second_one_sets_it_again() {
        let mut c = council();
        let hash = staged(&mut c);
        assert!(!c.upgrade_in_flight);
        act_as(OWNER);
        let _ = c.upgrade(hash);
        assert!(c.upgrade_in_flight);
        assert_eq!(c.config()["upgrade_in_flight"], true);
        c.upgrade_in_flight = false;
        let again = staged(&mut c);
        act_as(OWNER);
        let _ = c.upgrade(again);
        assert!(c.upgrade_in_flight, "the next upgrade sets it again");
    }

    #[test]
    #[should_panic(expected = "unsupported state version")]
    fn migrate_refuses_state_written_by_another_version() {
        let mut c = council();
        c.state_version = STATE_VERSION + 1;
        env::state_write(&c);
        drop(c);
        testing_env!(context("alice.near").build());
        CouncilContract::migrate();
    }

    // ---- two market accounts and the allow-list ------------------------------------------------------------------

    const MARKET2: &str = "market2.near";

    fn send_revenue(c: &mut CouncilContract, market: &str, sweep_id: u64, amount: u128) {
        act_as(VERIFIER);
        let _ = deliver(
            c,
            market,
            vec![COLLATERAL_ID],
            vec![amount],
            &format!("{REVENUE_PREFIX}{sweep_id}"),
        );
    }

    fn two_markets() -> CouncilContract {
        let mut c = council();
        act_as(OWNER);
        c.allow_market(acct(MARKET2));
        c
    }

    fn events_named(name: &str) -> Vec<near_sdk::serde_json::Value> {
        near_sdk::test_utils::get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
            .filter(|e| e["event"] == name)
            .map(|e| e["data"].clone())
            .collect()
    }

    #[test]
    fn the_same_sweep_id_from_two_markets_is_two_sweeps() {
        let mut c = two_markets();
        send_revenue(&mut c, MARKET, 1, 100);
        send_revenue(&mut c, MARKET2, 1, 250);
        assert_eq!(c.total_received().0, 350);
        assert_eq!(c.received_of(acct(MARKET), U64(1)).unwrap().amount.0, 100);
        assert_eq!(c.received_of(acct(MARKET2), U64(1)).unwrap().amount.0, 250);
        assert!(c.received_of(acct("market3.near"), U64(1)).is_none());
        assert_eq!(
            refusal(|| send_revenue(&mut c, MARKET2, 1, 5)),
            "that sweep was already received"
        );
        assert_eq!(c.total_received().0, 350);
    }

    #[test]
    fn revenue_names_the_market_account() {
        let mut c = two_markets();
        send_revenue(&mut c, MARKET2, 4, 77);
        let event = &events_named("revenue")[0];
        assert_eq!(
            (event["market"].as_str(), event["from"].as_str()),
            (Some(MARKET2), Some(MARKET2))
        );
        assert_eq!(event["sweep_id"], "4");
    }

    #[test]
    fn revenue_from_an_account_that_is_not_allowed_is_refused() {
        let mut c = two_markets();
        assert_eq!(
            refusal(|| send_revenue(&mut c, "rogue.near", 1, 5)),
            "revenue comes from an allowed market only"
        );
        assert_eq!(c.total_received().0, 0);
    }

    #[test]
    fn a_disallowed_market_sends_no_more_revenue_but_what_it_sent_stays() {
        let mut c = two_markets();
        send_revenue(&mut c, MARKET2, 1, 40);
        act_as(OWNER);
        c.disallow_market(acct(MARKET2));
        assert_eq!(
            events_named("market_disallowed"),
            [near_sdk::serde_json::json!({ "market": MARKET2 })]
        );
        assert_eq!(
            refusal(|| send_revenue(&mut c, MARKET2, 2, 40)),
            "revenue comes from an allowed market only"
        );
        assert_eq!(c.received_of(acct(MARKET2), U64(1)).unwrap().amount.0, 40);
        assert_eq!(c.total_received().0, 40);
        send_revenue(&mut c, MARKET, 2, 10);
        assert_eq!(c.total_received().0, 50);
    }

    #[test]
    fn the_last_allowed_market_stays_so_claims_keep_working() {
        let mut c = council();
        act_as(OWNER);
        assert_eq!(
            refusal(|| c.disallow_market(acct(MARKET))),
            "keep at least one allowed market"
        );
        assert_eq!(c.config()["markets"], near_sdk::serde_json::json!([MARKET]));
        assert_eq!(refusal(|| c.allow_market(acct(MARKET))), "already an allowed market");
        assert_eq!(
            refusal(|| c.disallow_market(acct("nobody.near"))),
            "not an allowed market"
        );
        c.allow_market(acct(MARKET2));
        assert_eq!(
            events_named("market_allowed"),
            [near_sdk::serde_json::json!({ "market": MARKET2 })]
        );
        c.disallow_market(acct(MARKET));
        assert_eq!(c.config()["markets"], near_sdk::serde_json::json!([MARKET2]));
    }

    #[test]
    fn juries_for_different_case_keys_do_not_collide() {
        let mut c = council();
        for i in 0..12 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        act_with_seed(ORACLE, 1);
        let keys = [1, 2, 1 | (1 << 63)];
        let juries: Vec<Vec<AccountId>> = keys.iter().map(|k| c.draw(U64(*k), 3, vec![])).collect();
        let seated: BTreeSet<_> = juries.iter().flatten().collect();
        assert_eq!(seated.len(), 9, "no seat is on two juries at once");
        for (key, jury) in keys.iter().zip(&juries) {
            assert_eq!(c.jury_of(U64(*key)).len(), jury.len());
        }
        c.unlock_case(U64(2), vec![]);
        assert!(c.jury_of(U64(2)).is_empty());
        assert_eq!(c.jury_of(U64(1)).len(), 3);
        assert_eq!(c.jury_of(U64(1 | (1 << 63))).len(), 3);
    }

    // ---- new events ---------------------------------------------------------------------------------------------

    #[test]
    fn a_draw_logs_the_case_key_the_tokens_and_the_owners_but_a_repeat_draw_logs_nothing() {
        let mut c = council();
        for i in 0..6 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        act_with_seed(ORACLE, 1);
        let owners = c.draw(U64(7), 3, vec![]);
        let drawn = events_named("jury_drawn");
        assert_eq!(drawn.len(), 1);
        assert_eq!(drawn[0]["case_key"], "7");
        assert_eq!(drawn[0]["owners"], near_sdk::serde_json::json!(owners));
        assert_eq!(drawn[0]["tokens"], near_sdk::serde_json::json!(c.jury_of(U64(7))));
        act_with_seed(ORACLE, 2);
        let _ = c.draw(U64(7), 3, vec![]);
        assert!(events_named("jury_drawn").is_empty(), "a repeat draw is not a new jury");
    }

    #[test]
    fn releasing_a_case_logs_who_was_delinquent_once() {
        let mut c = council();
        for i in 0..6 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        act_with_seed(ORACLE, 1);
        let owners = c.draw(U64(7), 3, vec![]);
        act_as(ORACLE);
        c.unlock_case(U64(7), vec![owners[0].clone()]);
        let released = events_named("jury_released");
        assert_eq!(
            released,
            [near_sdk::serde_json::json!({ "case_key": "7", "delinquent": [owners[0].clone()] })]
        );
        act_as(ORACLE);
        c.unlock_case(U64(7), vec![]);
        assert!(
            events_named("jury_released").is_empty(),
            "a second release does nothing"
        );
    }

    #[test]
    fn advancing_quarters_and_booking_seat_time_log_how_far_they_went() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        set_time(quarter_start(Q1_2027) + DAY);
        act_as("anyone.near");
        let moved = c.advance_quarters(None);
        assert_eq!(
            events_named("quarters_advanced"),
            [near_sdk::serde_json::json!({ "steps": moved })]
        );
        assert!(moved > 0);
        let booked = c.book_seat_time("1".into(), None);
        assert_eq!(
            events_named("seat_time_booked"),
            [near_sdk::serde_json::json!({ "token_id": "1", "quarters": booked })]
        );
    }

    // ---- version tags -------------------------------------------------------------------------------------------

    fn bytes_of<T: BorshSerialize>(value: &T) -> Vec<u8> {
        near_sdk::borsh::to_vec(value).unwrap()
    }

    fn sample_stake() -> Stake {
        Stake {
            owner: acct("a.near"),
            staked_at: U64(5),
            unlock_requested_at: Some(U64(9)),
            serving: Some(U64(3)),
            booked_to: U64(6),
            serving_from: 4,
            index: 2,
        }
    }

    fn sample_claim() -> Claim {
        Claim {
            amount: 5,
            status: ClaimStatus::Paid,
            requested_at: 1,
            paid_at: Some(2),
        }
    }

    fn sample_received() -> Received {
        Received {
            amount: 9,
            quarter: Q1_2027,
            at: 3,
        }
    }

    fn sample_book() -> QuarterBook {
        QuarterBook {
            revenue_in: 1,
            carry_in: 2,
            seat_ns: 3,
            forfeit_ns: 4,
            finalized: true,
            pool: 5,
            weight_total: 6,
            rolled_to: Some(7),
            paid: 8,
            pending: 9,
        }
    }

    macro_rules! tagged_round_trip {
        ($wrapper:ident, $value:expr) => {{
            let value = $value;
            let bytes = bytes_of(&$wrapper::current(value.clone()));
            assert_eq!(bytes[0], 0, stringify!($wrapper));
            assert_eq!(&bytes[1..], bytes_of(&value).as_slice(), stringify!($wrapper));
            assert_eq!(bytes_of(&$wrapper::try_from_slice(&bytes).unwrap()), bytes);
            let mut newer = bytes;
            newer[0] = 1;
            let message = refusal(|| {
                let _ = $wrapper::try_from_slice(&newer);
            });
            assert!(message.contains("newer version than this code can read"), "{message}");
        }};
    }

    #[test]
    fn every_stored_record_starts_with_version_byte_zero_round_trips_and_refuses_a_newer_one() {
        tagged_round_trip!(VersionedStake, sample_stake());
        tagged_round_trip!(VersionedQuarterBook, sample_book());
        tagged_round_trip!(VersionedClaim, sample_claim());
        tagged_round_trip!(VersionedReceived, sample_received());
    }

    #[test]
    fn what_the_maps_store_carries_the_version_byte() {
        let mut c = two_markets();
        stake(&mut c, "1", "a.near");
        send_revenue(&mut c, MARKET2, 1, 100);
        c.stakes.flush();
        c.quarters.flush();
        c.received.flush();
        let stored = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let want = [
            bytes_of(&VersionedStake::current(c.stake_of("1".into()).unwrap())),
            bytes_of(&VersionedQuarterBook::current(c.book(quarter_containing(START)))),
            bytes_of(&VersionedReceived::current(Received {
                amount: 100,
                quarter: quarter_containing(START),
                at: START,
            })),
        ];
        for bytes in want {
            assert_eq!(bytes[0], 0);
            assert!(
                stored.values().any(|v| *v == bytes),
                "a record is stored as the tagged bytes"
            );
        }
    }

    #[test]
    fn a_new_council_starts_at_the_current_state_version() {
        assert_eq!(council().state_version, STATE_VERSION);
        assert_eq!(STATE_VERSION, 5);
    }
}
