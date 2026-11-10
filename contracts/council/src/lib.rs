// Council registry for the pitch test. A seat is an NFT from one collection staked here with
// nft_transfer_call. The registry draws juries for the oracle from the staked seats and keeps a drawn seat
// from leaving until the oracle says its case is final. Revenue is paid by arrival: a seat staked on a UTC day starts
// earning at the start of the next one, and each sweep is split equally among the seats earning when it arrives. A seat
// never shares a sweep that came before it started. What it earned in a finished UTC quarter can be claimed for good, and
// a seat that asks to leave before its quarter ends gives up half of that quarter's earnings to the seats still earning.
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
use std::cell::Cell;
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
// A longer cooldown overflows nothing, but it locks every seat for as long as it runs.
const MAX_COOLDOWN_NS: u64 = 365 * NS_PER_DAY;
// The revenue index holds units per seat times this, so a split among up to MAX_SEATS seats rounds away less than a
// unit in a quadrillion per seat. The index only grows, so a u128 bounds the whole life of the council, not one sweep: it is
// full once the units shared per earning seat add up to about 3.4 * 10^20, which is all the revenue the council will ever
// take in if one seat earned every sweep. Past that a split panics.
const ACC_SCALE: u128 = 1_000_000_000_000_000_000;
// Days one advance_days call walks, and the most a claim or an unstake request walks on its own before it refuses, since a
// holder can attach the gas it needs. A council nobody touched for longer waits for advance_days. Sweeps come at least daily.
const MAX_DAY_STEPS: u32 = 100;
// Days a revenue receipt, a draw or a release walks on its own. Those calls run on gas their caller fixed, so they take a
// smaller bite and refuse beyond it. A guess, to be measured in the sandbox.
const MAX_RECEIPT_CATCH_UP_DAYS: u32 = 30;
// Basis points of the running quarter's earnings a seat gives up when it asks to leave, and the denominator they are over.
const LEAVER_CUT_BPS: u128 = 5_000;
const BPS_DENOMINATOR: u128 = 10_000;
// Snapshots one quarter_snapshots call returns at most.
const MAX_SNAPSHOT_PAGE: u32 = 50;
// Seats one claim settles. Each is a seat record read and written inside the claim's own work.
const MAX_CLAIM_TOKENS: usize = 10;
// What a version 5 contract may still hold in each finalized quarter and be migrated: the remainder of splitting its
// pool, under a unit a seat. More than that is money a seat can still claim, so the upgrade waits for it.
const MIGRATE_DUST_PER_QUARTER: u128 = MAX_SEATS as u128;
// Where migrate writes the UTC day it ran, which a seat record from version 5 reads when it is upgraded. Every one of those
// seats still earning starts on the day after.
const MIGRATED_DAY_KEY: &[u8] = b"migrated_day";
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
// itself and neither depends on how many seats are staked. A claim also settles up to ten seats inside its own work.
const GAS_OWN_WORK: Gas = Gas::from_tgas(8);
const GAS_UNSTAKE_FLOOR: Gas = Gas::from_gas(GAS_NFT_TRANSFER.as_gas() + GAS_CALLBACK.as_gas() + GAS_OWN_WORK.as_gas());
const GAS_STAKE_FLOOR: Gas =
    Gas::from_gas(GAS_NFT_TOKEN_VIEW.as_gas() + GAS_STAKE_CALLBACK.as_gas() + GAS_OWN_WORK.as_gas());
const GAS_CLAIM_FLOOR: Gas = Gas::from_gas(GAS_MT_TRANSFER.as_gas() + GAS_CALLBACK.as_gas() + GAS_OWN_WORK.as_gas());
// The layout of the state below. migrate reads exactly this one and the one before it, and refuses any other. Version 5
// split revenue by calendar quarter in proportion to seat time. Version 6 pays each sweep to the seats earning when it
// arrives and lets a seat claim a finished quarter.
const STATE_VERSION: u16 = 6;
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
// wrapper is what the maps hold: it reads any stored version up to the current layout (an older one goes through its
// From into the current one) and always writes the current one.
macro_rules! versioned {
    (@wrapper $name:ident, $stored:ident, $ty:ty, $tag:expr) => {
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
                $tag.serialize(writer)?;
                self.0.serialize(writer)
            }
        }

        impl BorshDeserialize for $name {
            fn deserialize_reader<R: borsh::io::Read>(reader: &mut R) -> borsh::io::Result<Self> {
                let tag = u8::deserialize_reader(reader)?;
                Ok(Self($stored::read(tag, reader)?.into_current()))
            }
        }
    };
    ($name:ident, $stored:ident, $ty:ty) => {
        enum $stored {
            V1($ty),
        }

        impl $stored {
            fn read<R: borsh::io::Read>(tag: u8, reader: &mut R) -> borsh::io::Result<Self> {
                match tag {
                    0 => Ok(Self::V1(<$ty>::deserialize_reader(reader)?)),
                    _ => env::panic_str("a stored record has a newer version than this code can read"),
                }
            }

            fn into_current(self) -> $ty {
                match self {
                    Self::V1(value) => value,
                }
            }
        }

        versioned!(@wrapper $name, $stored, $ty, 0u8);
    };
    ($name:ident, $stored:ident, $old:ty => $ty:ty) => {
        enum $stored {
            V1($old),
            V2($ty),
        }

        impl $stored {
            fn read<R: borsh::io::Read>(tag: u8, reader: &mut R) -> borsh::io::Result<Self> {
                match tag {
                    0 => Ok(Self::V1(<$old>::deserialize_reader(reader)?)),
                    1 => Ok(Self::V2(<$ty>::deserialize_reader(reader)?)),
                    _ => env::panic_str("a stored record has a newer version than this code can read"),
                }
            }

            fn into_current(self) -> $ty {
                match self {
                    Self::V1(value) => value.into(),
                    Self::V2(value) => value,
                }
            }
        }

        versioned!(@wrapper $name, $stored, $ty, 1u8);
    };
}

// Prefixes 5 to 8 held version 5's quarter books, seat time, forfeits and quarter claims. Those maps stay in storage
// unread, since a LookupMap cannot be enumerated to delete them, so no new map may use those numbers.
#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh", use_discriminant = true)]
enum Key {
    Staked = 0,
    Stakes = 1,
    SeatsOf = 2,
    Juries = 3,
    Allowed = 4,
    Received = 9,
    TokensOf = 10,
    DayAcc = 11,
    Accrued = 12,
    Claims = 13,
    QuarterAcc = 14,
    JoinsOn = 15,
    Pending = 16,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Stake {
    owner: AccountId,
    staked_at: U64,
    unlock_requested_at: Option<U64>,
    // The case this seat was drawn for. It cannot leave or be drawn again until the oracle releases that case.
    serving: Option<U64>,
    // The UTC day (days since the epoch) the seat starts earning: the day after it was staked.
    earn_from_day: U64,
    // How far up the revenue index this seat is already settled into its owner's balance, or the index when it asked to
    // leave. Below its start day's index it has no meaning, so the higher of the two counts.
    #[serde(skip)]
    settled_acc: u128,
    // Units to take off the next settlement: what a silent juror lost and the others already share.
    #[serde(skip)]
    forfeited: u128,
    // The revenue index when the seat was drawn. A juror who never votes loses what it earns after that, unless that was
    // settled by a claim first.
    #[serde(skip)]
    serving_acc: u128,
    // Where the token sits in `staked`, so unstaking does not scan the list.
    #[serde(skip)]
    index: u32,
}

// A seat record as version 5 wrote it, read only to be upgraded.
#[near(serializers=[borsh])]
struct StakeV1 {
    owner: AccountId,
    staked_at: U64,
    unlock_requested_at: Option<U64>,
    serving: Option<U64>,
    booked_to: U64,
    serving_from: u64,
    index: u32,
}

thread_local! {
    // The day migrate ran, kept for the rest of the call once the first version 5 seat record has read it. A draw reads every
    // seat, and without this each one still on the old layout would pay for a storage read of its own.
    static MIGRATED_DAY: Cell<Option<u64>> = const { Cell::new(None) };
}

fn migrated_day() -> u64 {
    MIGRATED_DAY.with(|cached| {
        cached.get().unwrap_or_else(|| {
            let day = env::storage_read(MIGRATED_DAY_KEY)
                .and_then(|bytes| <[u8; 8]>::try_from(bytes).ok())
                .map(u64::from_le_bytes)
                .unwrap_or_else(|| env::panic_str("a version 5 seat record exists but migrate never ran"));
            cached.set(Some(day));
            day
        })
    })
}

// Version 5 had no start day. migrate counted every seat still earning as starting the day after it ran, so that is the
// day each one starts here. A seat that had asked to leave never earns again, which no day can say.
impl From<StakeV1> for Stake {
    fn from(old: StakeV1) -> Self {
        Self {
            owner: old.owner,
            staked_at: old.staked_at,
            unlock_requested_at: old.unlock_requested_at,
            serving: old.serving,
            earn_from_day: U64(if old.unlock_requested_at.is_some() {
                u64::MAX
            } else {
                migrated_day() + 1
            }),
            settled_acc: 0,
            forfeited: 0,
            serving_acc: 0,
            index: old.index,
        }
    }
}

versioned!(VersionedStake, StoredStake, StakeV1 => Stake);

// One payout of an account's whole balance, from the moment it is sent until its callback (or the owner) says how it went.
// The record is removed then, so a repeated or late callback finds nothing.
#[near(serializers=[borsh])]
#[derive(Clone)]
struct Claim {
    account: AccountId,
    amount: u128,
    tokens: Vec<TokenId>,
    requested_at: u64,
}

versioned!(VersionedClaim, StoredClaim, Claim);

// What a seat that left gave up half of waits here until the quarter it left in is over, one slot to an account. A second
// leave in the same quarter adds to it.
#[near(serializers=[borsh])]
#[derive(Clone)]
struct Pending {
    quarter: u32,
    amount: u128,
}

versioned!(VersionedPending, StoredPending, Pending);

#[near(serializers=[borsh])]
#[derive(Clone)]
struct Received {
    amount: u128,
    at: u64,
}

// A received sweep as version 5 wrote it, with the quarter it was booked to.
#[near(serializers=[borsh])]
struct ReceivedV1 {
    amount: u128,
    quarter: u32,
    at: u64,
}

impl From<ReceivedV1> for Received {
    fn from(old: ReceivedV1) -> Self {
        Self {
            amount: old.amount,
            at: old.at,
        }
    }
}

versioned!(VersionedReceived, StoredReceived, ReceivedV1 => Received);

#[near(serializers=[json])]
pub struct ReceivedView {
    amount: U128,
    at: U64,
}

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SeatState {
    Waiting,
    Earning,
    Leaving,
    Serving,
}

#[near(serializers=[json])]
pub struct SeatEarnings {
    owner: AccountId,
    state: SeatState,
    earning_from: U64,
    // What a claim would pay for this seat now: its earnings up to the last finished quarter.
    earned_closed: U128,
    // What it has earned in the quarter still running, which a claim cannot reach until the quarter ends.
    earned_in_progress: U128,
    // The revenue index at the seat's start day (0 before it has started) and the index it is settled up to.
    start_acc: U128,
    settled_acc: U128,
}

#[near(serializers=[json])]
pub struct RewardTotals {
    total_received: U128,
    total_paid: U128,
    pending_claims: U128,
    carry: U128,
    cut_pool: U128,
    accrued_total: U128,
    pending_total_slots: U128,
}

#[near(serializers=[json])]
pub struct QuarterInfo {
    quarter: u32,
    starts_at: U64,
    ends_at: U64,
    last_closed_quarter: u32,
    last_day: U64,
}

#[near(serializers=[json])]
pub struct QuarterSnapshot {
    quarter: u32,
    acc: U128,
}

// The two parts of what a seat has earned and not settled yet, after the units it lost as a silent juror.
struct SeatShares {
    closed: u128,
    running: u128,
}

// The same two parts before those units come off, with the index each is counted from and to.
struct Earned {
    start: u128,
    bound: u128,
    closed: u128,
    running: u128,
}

fn day_of(at_ns: u64) -> u64 {
    at_ns / NS_PER_DAY
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
    let (year, month, _) = civil_from_days(day_of(at_ns) as i64);
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

fn claim_data(id: u64, claim: &Claim) -> near_sdk::serde_json::Value {
    json!({ "id": id.to_string(), "account": claim.account, "amount": claim.amount.to_string(), "tokens": claim.tokens,
            "requested_at": claim.requested_at.to_string() })
}

// ponytail: every draw walks every staked token and reads its record. Measured in the sandbox at 1,000 seats
// (contracts/tests/tests/scale_council.rs): about 172 TGas, and about 168 to 170 when half the seats have asked to
// leave. The oracle reserves 250 TGas for the draw, so resolve_draw needs about 270 TGas attached. Raising MAX_SEATS needs GAS_DRAW raised to match, measured again at the new cap.
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
    // The tokens each account has staked now. A list kept from version 5 can still name a token the account held then,
    // which every reader skips and the account's next unstake drops.
    tokens_of: LookupMap<AccountId, Vec<TokenId>>,
    // The tokens drawn for each case still open.
    juries: LookupMap<u64, Vec<TokenId>>,
    // How long a claim must be pending before reconcile_claim can decide it.
    reconcile_wait_ns: u64,
    // Revenue by the market account and its sweep id, so a repeated send is refused, two markets can use the same sweep id,
    // and a market can ask what arrived.
    received: LookupMap<(AccountId, u64), VersionedReceived>,
    // Every token received as revenue, every one paid out and the claims in flight. What was received and not paid out is
    // in flight, owed to accounts (`accrued_total`, `pending_total_slots`), earned by live seats and not settled yet, in the
    // `cut_pool` or in `carry`.
    total_received: u128,
    total_paid: u128,
    pending_claims_total: u128,
    // Seats taken out of `staked` whose NFT transfer has not been answered yet. The collection cannot change while one is out,
    // or a failed transfer would restore the seat under another collection.
    unstakes_in_flight: u32,
    // The revenue index: what each seat earning since the start has been credited, times ACC_SCALE. A seat earns the
    // index's rise from its start day (or from where it was last settled) on. It moves when a sweep arrives and when a
    // quarter closes and shares the cut pool.
    acc: u128,
    // The scaled units of the last split that did not divide evenly among the seats. They go into the next one.
    carry_scaled: u128,
    // Revenue waiting for the next sweep: a sweep that came while no seat was earning, and what silent jurors lost.
    carry: u128,
    // The cut halves of the seats that left in the running quarter, shared among the seats earning when it closes.
    cut_pool: u128,
    // Seats earning now. Seats staked and not earning yet are counted in `joins_on` by the day they start.
    active: u32,
    joins_on: LookupMap<u64, u32>,
    // The last UTC day that is folded into `active`. Anything that moves money needs it to be today.
    last_day: u64,
    // The index at the start of each day seats started on, which is where those seats' earnings begin.
    day_acc: LookupMap<u64, u128>,
    // The index at the moment each quarter closed, after the cut pool was shared, and the latest quarter that has one. A
    // quarter's earnings are claimable from then on and never expire.
    quarter_acc: LookupMap<u32, u128>,
    last_closed_quarter: u32,
    // Earnings settled to an account and not paid out yet, and their sum.
    accrued: LookupMap<AccountId, u128>,
    accrued_total: u128,
    // The kept half of what leavers earned in a quarter still running, and their sum.
    pending: LookupMap<AccountId, VersionedPending>,
    pending_total_slots: u128,
    next_claim_id: u64,
    claims: LookupMap<u64, VersionedClaim>,
}

// Exact layout of state version 5, which pooled revenue by calendar quarter. The quarter maps are read only for their
// storage prefix, which is all a map keeps in the state, so their value types are left out.
#[near(serializers=[borsh])]
struct StateV5 {
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
    quarters: LookupMap<u32, ()>,
    seat_weight: LookupMap<(u32, TokenId, AccountId), u64>,
    forfeits: LookupMap<(u32, TokenId, AccountId), u64>,
    claims: LookupMap<(u32, TokenId, AccountId), ()>,
    received: LookupMap<(AccountId, u64), VersionedReceived>,
    total_received: u128,
    total_paid: u128,
    pending_total: u128,
    open_pool: u128,
    final_pool: u128,
    rolled_total: u128,
    unstakes_in_flight: u32,
    fresh: u32,
    rule_from_quarter: u32,
}

// Revenue in quarters not finalized yet has no owner, so it waits in `carry` for the next sweep. Every seat still earning
// starts the day after the migration, and its old stake record learns that day from MIGRATED_DAY_KEY when it is read. The
// quarter before the running one is the last closed, with an index of 0, so nothing is claimable until the running one ends.
// A quarter that ended and was not finalized has a pool that belongs to its seats, which this layout cannot keep, so the
// upgrade waits for it too. The finalized quarters are counted by their books, which version 5 wrote to each one.
// Money a seat could still claim from a finalized quarter, a claim in flight and an unstake in flight have no place in this
// layout, so the upgrade refuses until they are gone. The quarter books, seat time, forfeits and claims of version 5 stay
// in storage under their old prefixes, unread and never reused.
impl From<StateV5> for CouncilContract {
    fn from(old: StateV5) -> Self {
        require!(
            old.pending_total == 0,
            "a claim is still pending, settle it before upgrading"
        );
        require!(
            old.next_to_finalize >= quarter_containing(env::block_timestamp()),
            "a finished quarter is not finalized yet, finalize it and let its holders claim before upgrading"
        );
        let finalized_quarters = (0..old.next_to_finalize)
            .rev()
            .take_while(|quarter| old.quarters.contains_key(quarter))
            .count() as u128;
        let unclaimed = old.final_pool - old.total_paid;
        require!(
            unclaimed <= finalized_quarters * MIGRATE_DUST_PER_QUARTER,
            "a finalized quarter still has money to claim, claim it before upgrading"
        );
        require!(
            old.unstakes_in_flight == 0,
            "an unstake is still waiting for its NFT transfer"
        );
        let today = day_of(env::block_timestamp());
        env::storage_write(MIGRATED_DAY_KEY, &today.to_le_bytes());
        let mut joins_on = LookupMap::new(Key::JoinsOn);
        if old.earning > 0 {
            joins_on.insert(today + 1, old.earning);
        }
        let last_closed_quarter = quarter_containing(env::block_timestamp()) - 1;
        let mut quarter_acc = LookupMap::new(Key::QuarterAcc);
        quarter_acc.insert(last_closed_quarter, 0);
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
            reconcile_wait_ns: old.reconcile_wait_ns,
            received: old.received,
            total_received: old.total_received,
            total_paid: old.total_paid,
            pending_claims_total: 0,
            unstakes_in_flight: 0,
            acc: 0,
            carry_scaled: 0,
            carry: old.open_pool + unclaimed,
            cut_pool: 0,
            active: 0,
            joins_on,
            last_day: today,
            day_acc: LookupMap::new(Key::DayAcc),
            quarter_acc,
            last_closed_quarter,
            accrued: LookupMap::new(Key::Accrued),
            accrued_total: 0,
            pending: LookupMap::new(Key::Pending),
            pending_total_slots: 0,
            next_claim_id: 0,
            claims: LookupMap::new(Key::Claims),
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
        let last_closed_quarter = quarter_containing(now) - 1;
        let mut quarter_acc = LookupMap::new(Key::QuarterAcc);
        quarter_acc.insert(last_closed_quarter, 0);
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
            reconcile_wait_ns: DEFAULT_RECONCILE_WAIT_NS,
            received: LookupMap::new(Key::Received),
            total_received: 0,
            total_paid: 0,
            pending_claims_total: 0,
            unstakes_in_flight: 0,
            acc: 0,
            carry_scaled: 0,
            carry: 0,
            cut_pool: 0,
            active: 0,
            joins_on: LookupMap::new(Key::JoinsOn),
            last_day: day_of(now),
            day_acc: LookupMap::new(Key::DayAcc),
            quarter_acc,
            last_closed_quarter,
            accrued: LookupMap::new(Key::Accrued),
            accrued_total: 0,
            pending: LookupMap::new(Key::Pending),
            pending_total_slots: 0,
            next_claim_id: 0,
            claims: LookupMap::new(Key::Claims),
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

    // Runs in the new code, in the same batch as the deploy. It reads the one layout it was written for and the one before
    // it. A later version keeps a copy of this struct as StateV6, reads that, builds its own state from it and bumps
    // state_version.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let bytes = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("there is no state to migrate"));
        require!(bytes.len() >= 2, "invalid state");
        let mut state: Self = match u16::from_le_bytes([bytes[0], bytes[1]]) {
            STATE_VERSION => env::state_read().unwrap_or_else(|| env::panic_str("invalid current state")),
            5 => Self::from(env::state_read::<StateV5>().unwrap_or_else(|| env::panic_str("invalid previous state"))),
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
    // because claims need a configured Council and what the seats earned could then never be paid out.
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
    // returns the same jury, so retrying after a failed callback cannot reroll it. It walks the days first, as far as its gas
    // margin allows and without refusing, so the index a juror serves from is not one a quarter close was about to raise.
    pub fn draw(&mut self, case_key: U64, n: u32, exclude: Vec<AccountId>) -> Vec<AccountId> {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        if let Some(tokens) = self.juries.get(&case_key.0) {
            return tokens.iter().map(|t| self.stakes[t].owner.clone()).collect();
        }
        self.advance_days_to(day_of(env::block_timestamp()), MAX_RECEIPT_CATCH_UP_DAYS);
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
        let acc = self.acc;
        for (t, _) in &jury {
            let stake = self.stakes.get_mut(t).unwrap();
            stake.serving = Some(case_key);
            stake.serving_acc = acc;
        }
        let (tokens, owners): (Vec<TokenId>, Vec<AccountId>) = jury.into_iter().unzip();
        emit(
            "jury_drawn",
            json!({ "case_key": case_key.0.to_string(), "tokens": tokens, "owners": owners }),
        );
        self.juries.insert(case_key.0, tokens);
        owners
    }

    // Called by the oracle once a case is final, with the jurors who never voted. A juror on that list loses what its seat
    // earned from the draw to now that no claim has settled yet, and the other seats share it at once. A juror who
    // voted loses nothing. A case with no silent juror is always released; one with a silent juror needs the days caught up
    // first. A second call for the same case does nothing, so nobody is penalised twice.
    pub fn unlock_case(&mut self, case_key: U64, delinquent: Vec<AccountId>) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        if !delinquent.is_empty() {
            self.catch_up(MAX_RECEIPT_CATCH_UP_DAYS);
        }
        let released = self.juries.remove(&case_key.0);
        if released.is_some() {
            emit(
                "jury_released",
                json!({ "case_key": case_key.0.to_string(), "delinquent": delinquent }),
            );
        }
        for t in released.unwrap_or_default() {
            let Some(owner) = self.stakes.get(&t).map(|s| s.owner.clone()) else {
                continue;
            };
            if delinquent.contains(&owner) {
                self.forfeit_serving(&t, &owner, case_key.0);
            }
            self.stakes.get_mut(&t).unwrap().serving = None;
        }
    }

    // The seat stops earning here. What it earned in finished quarters is settled to its owner in full. Half of what it
    // earned in the quarter still running goes to the cut pool, which the seats earning when the quarter closes share, and
    // the other half waits in the owner's pending slot until the quarter closes. The numbers are fixed by this call, whenever
    // the snapshot is taken. A seat that has not started yet comes off the count of seats starting on its day, loses nothing
    // and never earns. Every request must say it accepts the cut, so the chain shows the holder was told.
    #[payable]
    pub fn request_unstake(&mut self, token_id: TokenId, accepts_cut: bool) {
        assert_one_yocto();
        require!(
            accepts_cut,
            "leaving before the quarter ends costs 50% of this quarter's earnings: pass accepts_cut true"
        );
        let stake = self.callers_stake(&token_id);
        require!(stake.unlock_requested_at.is_none(), "unstake already requested");
        require!(stake.serving.is_none(), "this seat is serving on an open case");
        let (owner, start_day) = (stake.owner.clone(), stake.earn_from_day.0);
        self.catch_up(MAX_DAY_STEPS);
        self.settle_closed(&token_id);
        self.roll_pending(&owner);
        let earned = self.shares(&self.stakes[&token_id]).running;
        let cut = earned * LEAVER_CUT_BPS / BPS_DENOMINATOR;
        let kept = earned - cut;
        let quarter = self.last_closed_quarter + 1;
        self.cut_pool += cut;
        if kept > 0 {
            let slot = self
                .pending
                .entry(owner.clone())
                .or_insert_with(|| VersionedPending::current(Pending { quarter, amount: 0 }));
            slot.amount += kept;
            self.pending_total_slots += kept;
        }
        if start_day <= self.last_day {
            self.active -= 1;
        } else {
            self.cancel_join(start_day);
        }
        let now = env::block_timestamp();
        let stake = self.stakes.get_mut(&token_id).unwrap();
        stake.unlock_requested_at = Some(U64(now));
        stake.settled_acc = self.acc;
        emit(
            "seat_cut",
            json!({ "token_id": token_id, "owner": owner, "quarter": quarter, "earned": earned.to_string(),
                    "cut": cut.to_string(), "kept": kept.to_string() }),
        );
        emit(
            "unstake_requested",
            json!({ "token_id": token_id, "owner": owner, "unlock_at": (now + self.cooldown_ns).to_string() }),
        );
    }

    // Returns the NFT and nothing else. What the seat earned was settled at its request and stays claimable, so leaving
    // never touches reward money.
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

    // A failed transfer puts the seat back. It keeps its request, so it does not earn again and the earning count stays as
    // it is; the earning fields the record lost on its way through the callback's JSON are never read for a leaving seat.
    // The stake checks count unstakes still in flight against MAX_SEATS, so a restore never takes the council past it. An
    // account can end one seat over its own cap for each unstake of its that failed, which stays until the extra seat leaves.
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
            self.insert_stake(token_id, stake);
            emit("unstake_failed", data);
        }
    }

    // Walks the days up to today, at most `max_steps` of them (and never more than a hundred): closes the quarter that ends
    // on a day and folds in the seats that start on it. Anyone can call it, and every call that moves money does the same
    // first. Returns the days it moved across.
    pub fn advance_days(&mut self, max_steps: Option<u32>) -> u32 {
        let steps = max_steps.unwrap_or(MAX_DAY_STEPS).min(MAX_DAY_STEPS);
        let from = self.last_day;
        self.advance_days_to(day_of(env::block_timestamp()), steps);
        u32::try_from(self.last_day - from).unwrap_or(u32::MAX)
    }

    // Pays the caller everything it is owed in one transfer: its settled balance, the kept half of a leaver's finished
    // quarter, and what the listed seats earned up to the last finished quarter. The seats must all be the caller's. An empty
    // list pays what is already settled, which is how a holder who left is paid. The record is written and the balance
    // debited before the payout is sent, and a failed payout credits it back.
    #[payable]
    pub fn claim(&mut self, token_ids: Vec<TokenId>) -> Promise {
        upgrade::require_gas(GAS_CLAIM_FLOOR, "a claim sends the payout and then settles it");
        assert_one_yocto();
        self.require_configured();
        require!(token_ids.len() <= MAX_CLAIM_TOKENS, "at most 10 tokens in one claim");
        let who = env::predecessor_account_id();
        for token_id in &token_ids {
            let owner = self
                .stakes
                .get(token_id)
                .map(|s| s.owner.clone())
                .unwrap_or_else(|| env::panic_str("not staked"));
            require!(owner == who, "not your seat");
        }
        self.catch_up(MAX_DAY_STEPS);
        self.roll_pending(&who);
        for token_id in &token_ids {
            self.settle_closed(token_id);
        }
        let amount = self.accrued.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        self.accrued_total -= amount;
        self.pending_claims_total += amount;
        let id = self.next_claim_id;
        self.next_claim_id += 1;
        let claim = Claim {
            account: who.clone(),
            amount,
            tokens: token_ids,
            requested_at: env::block_timestamp(),
        };
        emit("claim_requested", claim_data(id, &claim));
        self.claims.insert(id, VersionedClaim::current(claim));
        self.pay(&who, amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_claim_paid(U64(id)),
        )
    }

    // mt_transfer returns nothing and is one verifier receipt, so an error means the payout did not happen (paused, locked,
    // out of gas) and the balance goes back. A claim already closed has no record and is left alone.
    #[private]
    pub fn on_claim_paid(&mut self, id: U64, #[callback_result] result: Result<(), PromiseError>) {
        let Some(claim) = self.claims.get(&id.0).map(|c| c.clone().into_inner()) else {
            return;
        };
        let paid = result.is_ok();
        let data = self.close_claim(id.0, claim, paid);
        emit(if paid { "claim_paid" } else { "claim_failed" }, data);
    }

    // The owner's decision about a claim whose payout callback never arrived. It needs the reconcile wait after the claim,
    // which leaves the callback time to land, and the owner checks the verifier's events first: `paid` true books the
    // payout as made, false credits the balance back. A callback that comes later finds no record and changes nothing.
    pub fn reconcile_claim(&mut self, id: U64, paid: bool) {
        self.only_owner();
        let claim = self
            .claims
            .get(&id.0)
            .map(|c| c.clone().into_inner())
            .unwrap_or_else(|| env::panic_str("no claim is pending with that id"));
        require!(
            env::block_timestamp() >= claim.requested_at.saturating_add(self.reconcile_wait_ns),
            &format!(
                "wait {} minutes after the claim before reconciling",
                self.reconcile_wait_ns / (60 * NS_PER_SEC)
            )
        );
        let mut data = self.close_claim(id.0, claim, paid);
        data["paid"] = json!(paid);
        emit("claim_reconciled", data);
    }

    // Called by the verifier after an mt_transfer_call, once the money is already in this contract's Intents account. The
    // message is "revenue:<sweep id>" and only an allowed market may send it. The money is split among the seats earning
    // now, and a sweep id is taken once per market, so a repeated send is refused and the verifier gives it back. The
    // answer is the amounts to hand back, so 0 keeps everything. Panicking makes the verifier refund the sender in full.
    // A plain deposit never reaches here: it sits in the account as surplus and is never counted.
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
        self.catch_up(MAX_RECEIPT_CATCH_UP_DAYS);
        let amount = amounts[0].0;
        let at = env::block_timestamp();
        self.received
            .insert(received_key, VersionedReceived::current(Received { amount, at }));
        self.total_received += amount;
        let seats = self.active;
        let step = self.split(amount);
        emit(
            "revenue",
            json!({ "from": sender_id, "market": sender_id, "amount": amount.to_string(), "sweep_id": sweep_id.to_string(),
                    "seats": seats, "per_seat": step.map(|s| (s / ACC_SCALE).to_string()), "carried": step.is_none() }),
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
                at: U64(r.at),
            })
    }

    // total_received less total_paid less the claims in flight is the least this contract's Intents account must hold. Of
    // that, `accrued_total` and `pending_total_slots` are owed to accounts, `cut_pool` waits for the quarter to close,
    // `carry` waits for the next sweep and the rest is earned by live seats. The account holds more by the rounding the
    // splits left behind and by any plain deposit.
    pub fn reward_totals(&self) -> RewardTotals {
        RewardTotals {
            total_received: U128(self.total_received),
            total_paid: U128(self.total_paid),
            pending_claims: U128(self.pending_claims_total),
            carry: U128(self.carry),
            cut_pool: U128(self.cut_pool),
            accrued_total: U128(self.accrued_total),
            pending_total_slots: U128(self.pending_total_slots),
        }
    }

    // What a claim of every seat the account holds would pay now: the settled balance, the kept half of a finished
    // quarter, and the finished-quarter earnings of its seats. It does not move the days, so after a quarter ends it shows
    // that quarter's earnings only once something has closed it.
    pub fn claimable_of(&self, account_id: AccountId) -> U128 {
        let slot = self
            .pending
            .get(&account_id)
            .filter(|p| p.quarter <= self.last_closed_quarter)
            .map_or(0, |p| p.amount);
        let live: u128 = self
            .seats_of(account_id.clone())
            .iter()
            .map(|t| self.shares(&self.stakes[t]).closed)
            .sum();
        U128(self.accrued.get(&account_id).copied().unwrap_or(0) + slot + live)
    }

    // What the account's earning seats have made in the quarter still running, and the kept half of a leaver's quarter that
    // is not over yet. None of it can be claimed until the quarter closes.
    pub fn in_progress_of(&self, account_id: AccountId) -> U128 {
        let slot = self
            .pending
            .get(&account_id)
            .filter(|p| p.quarter > self.last_closed_quarter)
            .map_or(0, |p| p.amount);
        let live: u128 = self
            .seats_of(account_id)
            .iter()
            .map(|t| self.shares(&self.stakes[t]).running)
            .sum();
        U128(slot + live)
    }

    // Null for a token that is not staked. `earning_from` is the start of the seat's first earning day.
    pub fn seat_earnings(&self, token_id: TokenId) -> Option<SeatEarnings> {
        let today = day_of(env::block_timestamp());
        self.stakes.get(&token_id).map(|s| {
            let shares = self.shares(s);
            SeatEarnings {
                owner: s.owner.clone(),
                state: if s.serving.is_some() {
                    SeatState::Serving
                } else if s.unlock_requested_at.is_some() {
                    SeatState::Leaving
                } else if s.earn_from_day.0 <= today {
                    SeatState::Earning
                } else {
                    SeatState::Waiting
                },
                earning_from: U64(s.earn_from_day.0.saturating_mul(NS_PER_DAY)),
                earned_closed: U128(shares.closed),
                earned_in_progress: U128(shares.running),
                start_acc: U128(self.day_acc.get(&s.earn_from_day.0).copied().unwrap_or(0)),
                settled_acc: U128(s.settled_acc),
            }
        })
    }

    // The running quarter and the last one that has a snapshot.
    pub fn quarter_info(&self) -> QuarterInfo {
        let quarter = quarter_containing(env::block_timestamp());
        QuarterInfo {
            quarter,
            starts_at: U64(quarter_start(quarter)),
            ends_at: U64(quarter_end(quarter)),
            last_closed_quarter: self.last_closed_quarter,
            last_day: U64(self.last_day),
        }
    }

    // The index each finished quarter closed with, oldest first, so a holder's open claim for a quarter is the rise from the
    // seat's start to that index. From `from` on, at most `limit` (and never more than 50); with no `from`, the latest ones.
    pub fn quarter_snapshots(&self, from: Option<u32>, limit: Option<u32>) -> Vec<QuarterSnapshot> {
        let limit = limit.unwrap_or(MAX_SNAPSHOT_PAGE).min(MAX_SNAPSHOT_PAGE);
        let from = from.unwrap_or_else(|| self.last_closed_quarter.saturating_sub(limit.saturating_sub(1)));
        (from..=self.last_closed_quarter)
            .take(limit as usize)
            .filter_map(|quarter| self.quarter_acc.get(&quarter).map(|acc| (quarter, *acc)))
            .map(|(quarter, acc)| QuarterSnapshot {
                quarter,
                acc: U128(acc),
            })
            .collect()
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

    // Whether a wasm with this sha256 is staged here, for the members to check before they vote to deploy it.
    pub fn is_staged(&self, code_hash: Base58CryptoHash) -> bool {
        upgrade::is_staged(code_hash)
    }

    // nft_contract is null until the owner sets it, and markets is empty until the owner allows one.
    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "state_version": self.state_version, "upgrade_proven": self.upgrade_proven, "upgrade_in_flight": self.upgrade_in_flight,
                "owner": self.owner, "pending_owner": self.pending_owner, "oracle": self.oracle, "nft_contract": self.nft_contract,
                "markets": self.allowed_markets, "verifier": self.verifier, "collateral_token_id": self.collateral_token_id,
                "cooldown_ns": self.cooldown_ns.to_string(), "reconcile_wait_ns": self.reconcile_wait_ns.to_string(),
                "max_seats_per_account": self.max_seats_per_account, "allowlist_enabled": self.allowlist_enabled,
                "allowed_range": self.current_range().map(|(first, last)| json!({ "first": first.to_string(), "last": last.to_string() })),
                "total_received": self.total_received.to_string(), "last_day": self.last_day.to_string(),
                "active_seats": self.active, "last_closed_quarter": self.last_closed_quarter })
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
        require!(
            self.staked.len() + self.unstakes_in_flight < MAX_SEATS,
            "the council is full"
        );
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
            && self.staked.len() + self.unstakes_in_flight < MAX_SEATS
            && self.seats_of.get(&previous_owner_id).copied().unwrap_or(0) < self.max_seats_per_account;
        if !owned || !open {
            emit(
                "stake_refused",
                json!({ "token_id": token_id, "owner": previous_owner_id, "owned": owned }),
            );
            return true;
        }
        let now = env::block_timestamp();
        let start_day = day_of(now) + 1;
        emit("staked", json!({ "token_id": token_id, "owner": previous_owner_id }));
        let stake = Stake {
            owner: previous_owner_id,
            staked_at: U64(now),
            unlock_requested_at: None,
            serving: None,
            earn_from_day: U64(start_day),
            settled_acc: 0,
            forfeited: 0,
            serving_acc: 0,
            index: 0,
        };
        self.insert_stake(token_id, stake);
        let joining = self.joins_on.get(&start_day).copied().unwrap_or(0);
        self.joins_on.insert(start_day, joining + 1);
        false
    }
}

impl CouncilContract {
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
        let held = self.tokens_of.entry(stake.owner.clone()).or_default();
        if !held.contains(&token_id) {
            held.push(token_id.clone());
        }
        self.staked.push(token_id.clone());
        self.stakes.insert(token_id, VersionedStake::current(stake));
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
        let held = self.tokens_of.get_mut(&stake.owner).map(|held| {
            held.retain(|t| self.stakes.get(t).is_some_and(|s| s.owner == stake.owner));
            held.len()
        });
        if held == Some(0) {
            self.tokens_of.remove(&stake.owner);
        }
        stake
    }

    // Takes a pending claim out of the in-flight total and either books it as paid or credits the balance back. Both the
    // payout callback and reconcile_claim end a claim here, so the two cannot disagree about the books. Returns the event data.
    fn close_claim(&mut self, id: u64, claim: Claim, paid: bool) -> near_sdk::serde_json::Value {
        self.claims.remove(&id);
        self.pending_claims_total -= claim.amount;
        if paid {
            self.total_paid += claim.amount;
        } else {
            self.credit(&claim.account, claim.amount);
        }
        claim_data(id, &claim)
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        *self.accrued.entry(account.clone()).or_insert(0) += amount;
        self.accrued_total += amount;
    }

    // Walks the days after `last_day` up to `today`, at most `max_steps` of them. A day that opens a quarter closes the
    // quarter before it first: the cut pool and the carry are shared among the seats earning, or the pool is carried when
    // there are none, and the index is stored as that quarter's snapshot. Then the seats starting that day join, so they
    // never share the pool. Nothing moved the index since the last call that did, so the index now is the index at every day
    // walked here. A walk logs one line for all the seats it started and one for each quarter it closes, so it stays far
    // under the logs one call may write.
    fn advance_days_to(&mut self, today: u64, max_steps: u32) {
        let target = today.min(self.last_day.saturating_add(u64::from(max_steps)));
        let (mut start_days, mut started) = (0u32, 0u32);
        for day in self.last_day + 1..=target {
            if quarter_start(quarter_containing(day * NS_PER_DAY)) == day * NS_PER_DAY {
                self.close_quarter(quarter_containing(day * NS_PER_DAY) - 1);
            }
            if let Some(count) = self.joins_on.remove(&day) {
                self.active += count;
                self.day_acc.insert(day, self.acc);
                start_days += 1;
                started += count;
            }
        }
        if started > 0 {
            emit(
                "seats_started",
                json!({ "from_day": (self.last_day + 1).to_string(), "to_day": target.to_string(), "start_days": start_days,
                        "count": started }),
            );
        }
        self.last_day = self.last_day.max(target);
    }

    fn close_quarter(&mut self, quarter: u32) {
        let pool = std::mem::take(&mut self.cut_pool);
        let (shared, carried) = if self.active > 0 {
            let units = pool + std::mem::take(&mut self.carry);
            self.spread(units, self.active);
            (pool, 0)
        } else {
            self.carry += pool;
            (0, pool)
        };
        self.quarter_acc.insert(quarter, self.acc);
        self.last_closed_quarter = quarter;
        emit(
            "quarter_closed",
            json!({ "quarter": quarter, "acc": self.acc.to_string(), "cut_shared": shared.to_string(),
                    "carried": carried.to_string() }),
        );
    }

    // Anything that moves money runs this first, so a quarter that ended and a seat whose day has come are counted. It walks
    // at most `max_days` and refuses if that is not enough.
    fn catch_up(&mut self, max_days: u32) {
        let today = day_of(env::block_timestamp());
        self.advance_days_to(today, max_days);
        require!(self.last_day == today, "call advance_days first");
    }

    fn cancel_join(&mut self, day: u64) {
        let waiting = self
            .joins_on
            .get(&day)
            .copied()
            .unwrap_or_else(|| env::panic_str("the seat is not waiting to start"));
        if waiting == 1 {
            self.joins_on.remove(&day);
        } else {
            self.joins_on.insert(day, waiting - 1);
        }
    }

    // Adds `units` to the index as a rise for every earning seat, so that `seats` of them share the units equally, with the
    // remainder of the last split. Returns the rise of the index. Needs at least one seat to share with.
    fn spread(&mut self, units: u128, seats: u32) -> u128 {
        let pool = units
            .checked_mul(ACC_SCALE)
            .and_then(|scaled| scaled.checked_add(self.carry_scaled))
            .unwrap_or_else(|| env::panic_str("the sweep is too large to split"));
        let seats = u128::from(seats);
        let rise = pool / seats;
        self.acc += rise;
        self.carry_scaled = pool % seats;
        rise
    }

    // Adds a sweep and the carry to the index. With no seat earning it all waits in `carry`. Returns the rise of the index.
    fn split(&mut self, amount: u128) -> Option<u128> {
        if self.active == 0 {
            self.carry += amount;
            return None;
        }
        let units = amount + std::mem::take(&mut self.carry);
        Some(self.spread(units, self.active))
    }

    // The index a seat's earnings count from: its start day's index, or where it was last settled if that is higher. None
    // for a seat that has not started, which no start index exists for yet.
    fn start_eff(&self, stake: &Stake) -> Option<u128> {
        self.day_acc
            .get(&stake.earn_from_day.0)
            .map(|start| (*start).max(stake.settled_acc))
    }

    // What a seat has earned and not settled, before the units a silent juror lost come off: `closed` is what a claim can
    // settle now, up to `bound`, and `running` is everything after it. The bound is the last finished quarter, and for a
    // seat that is serving no further than the index when it was drawn, so a juror cannot claim what it earns while serving
    // before its case is released. None for a seat that has not started or that asked to leave, whose earnings were
    // settled or put in the cut when it asked.
    fn earned_since_settled(&self, stake: &Stake) -> Option<Earned> {
        let start = self.start_eff(stake).filter(|_| stake.unlock_requested_at.is_none())?;
        let cap = self.quarter_acc.get(&self.last_closed_quarter).copied().unwrap_or(0);
        let bound = if stake.serving.is_some() {
            cap.min(stake.serving_acc)
        } else {
            cap
        };
        Some(Earned {
            bound,
            start,
            closed: bound.saturating_sub(start) / ACC_SCALE,
            running: (self.acc - start.max(bound)) / ACC_SCALE,
        })
    }

    // What a claim could settle now and what the seat has made since, after the units a silent juror lost. Those come off the
    // running part first, so the finished quarters are paid in full whenever the running one can absorb them.
    fn shares(&self, stake: &Stake) -> SeatShares {
        let Some(earned) = self.earned_since_settled(stake) else {
            return SeatShares { closed: 0, running: 0 };
        };
        let from_running = stake.forfeited.min(earned.running);
        let from_closed = (stake.forfeited - from_running).min(earned.closed);
        SeatShares {
            closed: earned.closed - from_closed,
            running: earned.running - from_running,
        }
    }

    // Moves what a seat earned up to its bound into its owner's balance. What came after stays unsettled and cannot be
    // claimed. The fraction of a unit left over stays in the contract.
    fn settle_closed(&mut self, token_id: &TokenId) {
        let stake = &self.stakes[token_id];
        let Some(earned) = self.earned_since_settled(stake).filter(|e| e.bound > e.start) else {
            return;
        };
        let docked = stake.forfeited.saturating_sub(earned.running).min(earned.closed);
        let owner = stake.owner.clone();
        let stake = self.stakes.get_mut(token_id).unwrap();
        stake.forfeited -= docked;
        stake.settled_acc = earned.bound;
        self.credit(&owner, earned.closed - docked);
    }

    // The kept half of a leaver's quarter is paid with the rest once that quarter has closed.
    fn roll_pending(&mut self, account: &AccountId) {
        if self
            .pending
            .get(account)
            .is_some_and(|p| p.quarter <= self.last_closed_quarter)
        {
            let slot = self.pending.remove(account).unwrap().into_inner();
            self.pending_total_slots -= slot.amount;
            self.credit(account, slot.amount);
        }
    }

    // A silent juror loses what its seat earned from the draw (or from its start, if it started later) and no claim has
    // settled, up to what it has not settled at all. The other earning seats share that at once: the index rises for every
    // earning seat by an equal share of it, and the juror's own share of that rise comes off the seat too, so nothing of the
    // forfeit comes back to it. That share is rounded up, so the seat never keeps more than it lost. With no other seat
    // earning there is nobody to share with and the units wait in `carry`. The units come off the seat's next settlements.
    // Money already settled stays.
    fn forfeit_serving(&mut self, token_id: &TokenId, owner: &AccountId, case_key: u64) {
        let stake = &self.stakes[token_id];
        let Some(start) = self.start_eff(stake) else {
            return;
        };
        let unsettled = ((self.acc - start) / ACC_SCALE).saturating_sub(stake.forfeited);
        let lost = ((self.acc - stake.serving_acc.max(start)) / ACC_SCALE).min(unsettled);
        let others = self.active.saturating_sub(1);
        let own_share = if lost == 0 {
            0
        } else if others == 0 {
            self.carry += lost;
            0
        } else {
            self.spread(lost, others).div_ceil(ACC_SCALE)
        };
        self.stakes.get_mut(token_id).unwrap().forfeited += lost + own_share;
        emit(
            "seat_earnings_forfeited",
            json!({ "token_id": token_id, "owner": owner, "case_key": case_key.to_string(), "amount": lost.to_string() }),
        );
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
    // 2026-10-01T00:00:00Z, the start of a UTC day. Every test begins here unless it says otherwise.
    const START: u64 = 1_790_812_800 * SECOND;

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
        MIGRATED_DAY.with(|day| day.set(None));
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

    // The market's sweep `sweep_id` arrives at the time the clock shows.
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
        c.request_unstake(token.into(), true);
        act_at(owner, now() + COOLDOWN_NS);
        let _ = c.unstake(token.into());
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
    fn a_failed_unstake_cannot_push_the_council_past_max_seats() {
        let mut c = council();
        for i in 0..MAX_SEATS {
            stake(&mut c, &i.to_string(), "a.near");
        }
        let before = c.stake_of("0".into()).unwrap();
        leave(&mut c, "0", "a.near");
        assert_eq!((c.seat_count(), c.unstakes_in_flight), (MAX_SEATS - 1, 1));
        let message = refusal(|| stake(&mut c, "new", "b.near"));
        assert!(message.contains("the council is full"), "{message}");
        act_as("council.near");
        c.on_unstaked("0".into(), before, Err(PromiseError::Failed));
        assert_eq!(c.seat_count(), MAX_SEATS);
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
        assert_eq!((c.seat_count(), earning(&c)), (1, 1));
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
            assert_eq!((c.seat_count(), earning(&c), c.unstakes_in_flight), (0, 0, 0));
            assert_eq!(last_event()["event"], "stake_refused");
        }
    }

    #[test]
    fn a_failed_ownership_check_never_counts_the_seat() {
        let mut c = council();
        assert!(check_stake(&mut c, Err(PromiseError::Failed)));
        assert_eq!((c.seat_count(), earning(&c), c.unstakes_in_flight), (0, 0, 0));
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

    #[test]
    fn claims_and_revenue_refuse_until_the_owner_has_named_the_market() {
        let mut c = unconfigured_council(Some(false));
        act_as(OWNER);
        c.set_nft_contract(acct(NFT));
        act_paid("a.near");
        assert_eq!(
            refusal(|| drop(c.claim(vec!["1".into()]))),
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
                e["data"]["carried"].as_bool(),
                e["data"]["amount"].as_str()
            ),
            (Some("7"), Some(true), Some("900"))
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
        set_time(day(20) + 5);
        revenue(&mut c, 12, 321);
        let r = c.received_of(acct(MARKET), U64(12)).unwrap();
        assert_eq!((r.amount.0, r.at.0), (321, day(20) + 5));
        assert!(c.received_of(acct(MARKET), U64(13)).is_none());
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
    fn only_the_owner_changes_the_markets() {
        let mut c = council();
        for who in ["a.near", ORACLE, MARKET] {
            act_as(who);
            assert_eq!(refusal(|| c.allow_market(acct("other.near"))), "owner only", "{who}");
            assert_eq!(refusal(|| c.disallow_market(acct(MARKET))), "owner only", "{who}");
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
        c.request_unstake("0".into(), true);
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
        c.request_unstake("0".into(), true);
        act_as(ORACLE);
        c.draw(U64(1), 4, vec![]);
    }

    #[test]
    #[should_panic(expected = "the cooldown has not passed")]
    fn an_unstake_waits_the_full_cooldown() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_at("a.near", START + 1);
        c.request_unstake("t1".into(), true);
        act_at("a.near", START + 1 + COOLDOWN_NS - 1);
        let _ = c.unstake("t1".into());
    }

    #[test]
    fn the_owner_changes_the_cooldown_and_it_applies_to_a_request_already_made() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_at("a.near", START + 1);
        c.request_unstake("t1".into(), true);
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
                        c.request_unstake(token.clone(), true);
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

    fn day(n: u64) -> u64 {
        START + n * DAY
    }

    // 2026 Q4 runs 92 days from START and 2027 Q1 the next 90.
    const Q4_2026: u32 = 8_107;
    const Q1_2027: u32 = 8_108;
    const Q4_DAYS: u64 = 92;
    const Q1_DAYS: u64 = 90;

    // Claims for the tokens and reports the transfer as done. Returns what was paid.
    fn claim(c: &mut CouncilContract, owner: &str, tokens: &[&str]) -> u128 {
        let (id, amount) = claim_without_reply(c, owner, tokens);
        act_as("council.near");
        c.on_claim_paid(U64(id), Ok(()));
        amount
    }

    // Claims and leaves the transfer's result unreported. Returns the claim's id and what it reserved.
    fn claim_without_reply(c: &mut CouncilContract, owner: &str, tokens: &[&str]) -> (u64, u128) {
        act_paid(owner);
        let _ = c.claim(tokens.iter().map(|t| t.to_string()).collect());
        let requested = last_event();
        assert_eq!(requested["event"], "claim_requested");
        let data = &requested["data"];
        (
            data["id"].as_str().unwrap().parse().unwrap(),
            data["amount"].as_str().unwrap().parse().unwrap(),
        )
    }

    // What the account can claim now: finished quarters only.
    fn claimable(c: &CouncilContract, owner: &str) -> u128 {
        c.claimable_of(acct(owner)).0
    }

    // Everything the account has earned and not been paid, whether a claim can reach it yet or not.
    fn earned(c: &CouncilContract, owner: &str) -> u128 {
        claimable(c, owner) + c.in_progress_of(acct(owner)).0
    }

    // Seats staked and not asking to leave: the ones earning now and the ones waiting for their first day.
    fn earning(c: &CouncilContract) -> u32 {
        c.staked
            .iter()
            .filter(|t| c.stakes[*t].unlock_requested_at.is_none())
            .count() as u32
    }

    fn advance(c: &mut CouncilContract) -> u32 {
        act_as("anyone.near");
        c.advance_days(None)
    }

    // Moves the clock to the first day of 2027 Q1 and closes 2026 Q4.
    fn close_quarter(c: &mut CouncilContract) {
        set_time(day(Q4_DAYS));
        advance(c);
        assert_eq!(c.last_closed_quarter, Q4_2026);
    }

    fn request(c: &mut CouncilContract, token: &str, owner: &str) {
        act_paid(owner);
        c.request_unstake(token.into(), true);
    }

    // Seats 1 and 2 of a.near and b.near from day 0, and 1,000 on day 1, half each.
    fn two_seats_paid() -> CouncilContract {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(1));
        revenue(&mut c, 1, 1_000);
        c
    }

    // The same, with the quarter closed, so each holds 500 a claim can reach.
    fn two_seats_closed() -> CouncilContract {
        let mut c = two_seats_paid();
        close_quarter(&mut c);
        c
    }

    // ---- pay by arrival ----------------------------------------------------------------------------------------

    #[test]
    fn a_seat_staked_on_a_day_earns_nothing_from_that_day_and_its_full_share_from_the_next() {
        let mut c = council();
        stake(&mut c, "old", "old.near");
        set_time(day(1));
        stake(&mut c, "new", "new.near");
        set_time(day(1) + DAY / 2);
        revenue(&mut c, 1, 1_000);
        assert_eq!((earned(&c, "old.near"), earned(&c, "new.near")), (1_000, 0));
        set_time(day(2));
        revenue(&mut c, 2, 1_000);
        assert_eq!((earned(&c, "old.near"), earned(&c, "new.near")), (1_500, 500));
    }

    #[test]
    fn a_payment_that_came_before_a_seat_started_is_never_shared_with_it() {
        let mut c = council();
        stake(&mut c, "old", "old.near");
        set_time(day(3));
        revenue(&mut c, 1, 600);
        set_time(day(5));
        stake(&mut c, "new", "new.near");
        set_time(day(5) + 3_600 * SECOND);
        revenue(&mut c, 2, 400);
        set_time(day(9));
        advance(&mut c);
        let seat = c.seat_earnings("new".into()).unwrap();
        assert_eq!(
            (seat.state, seat.earned_closed.0, seat.earned_in_progress.0),
            (SeatState::Earning, 0, 0)
        );
        revenue(&mut c, 3, 100);
        assert_eq!((earned(&c, "old.near"), earned(&c, "new.near")), (1_050, 50));
    }

    #[test]
    fn two_payments_are_split_by_whoever_is_earning_at_each() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(2));
        stake(&mut c, "3", "c.near");
        revenue(&mut c, 1, 900);
        set_time(day(4));
        revenue(&mut c, 2, 900);
        assert_eq!(["a.near", "b.near", "c.near"].map(|o| earned(&c, o)), [750, 750, 300]);
    }

    #[test]
    fn a_payment_with_no_earning_seat_is_carried_and_shared_at_the_next() {
        let mut c = council();
        revenue(&mut c, 1, 500);
        let carried = last_event()["data"].clone();
        assert_eq!(
            (
                carried["seats"].as_u64(),
                carried["carried"].as_bool(),
                carried["per_seat"].is_null()
            ),
            (Some(0), Some(true), true)
        );
        assert_eq!(c.reward_totals().carry.0, 500);
        stake(&mut c, "1", "a.near");
        set_time(day(1));
        revenue(&mut c, 2, 100);
        let shared = last_event()["data"].clone();
        assert_eq!(
            (shared["per_seat"].as_str(), shared["carried"].as_bool()),
            (Some("600"), Some(false))
        );
        assert_eq!((earned(&c, "a.near"), c.reward_totals().carry.0), (600, 0));
    }

    #[test]
    fn rounding_leaves_the_remainder_in_the_contract_and_the_next_split_uses_it() {
        let mut c = council();
        for i in 0..3 {
            stake(&mut c, &i.to_string(), &format!("s{i}.near"));
        }
        set_time(day(1));
        revenue(&mut c, 1, 100);
        let owners = ["s0.near", "s1.near", "s2.near"];
        assert_eq!(owners.map(|o| earned(&c, o)), [33, 33, 33]);
        revenue(&mut c, 2, 2);
        assert_eq!(
            owners.map(|o| earned(&c, o)),
            [34, 34, 34],
            "the two thirds left over add up"
        );
        assert_eq!(c.carry_scaled, 0);
    }

    // ---- quarters ----------------------------------------------------------------------------------------------

    #[test]
    fn advance_days_closes_a_quarter_and_stores_its_snapshot() {
        let mut c = two_seats_paid();
        set_time(day(Q4_DAYS - 1));
        advance(&mut c);
        assert_eq!(c.last_closed_quarter, Q4_2026 - 1, "the quarter is not over yet");
        set_time(day(Q4_DAYS));
        advance(&mut c);
        assert_eq!(c.last_closed_quarter, Q4_2026);
        let closed = events_named("quarter_closed");
        assert_eq!(
            closed,
            [
                near_sdk::serde_json::json!({ "quarter": Q4_2026, "acc": (500 * ACC_SCALE).to_string(), "cut_shared": "0", "carried": "0" })
            ]
        );
        let snapshots = c.quarter_snapshots(Some(Q4_2026), None);
        assert_eq!(snapshots.len(), 1);
        assert_eq!((snapshots[0].quarter, snapshots[0].acc.0), (Q4_2026, 500 * ACC_SCALE));
        assert_eq!(c.quarter_info().last_closed_quarter, Q4_2026);
    }

    #[test]
    fn a_seat_starting_on_the_first_day_of_a_quarter_does_not_share_the_closing_cut_pool() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "l.near");
        set_time(day(1));
        revenue(&mut c, 1, 1_000);
        set_time(day(10));
        request(&mut c, "2", "l.near");
        set_time(day(Q4_DAYS - 1));
        stake(&mut c, "3", "b.near");
        assert_eq!(c.stake_of("3".into()).unwrap().earn_from_day.0, START / DAY + Q4_DAYS);
        set_time(day(Q4_DAYS));
        advance(&mut c);
        assert_eq!(
            events_named("quarter_closed")[0]["cut_shared"],
            "250",
            "the leaver's cut goes to the one seat earning"
        );
        assert_eq!((claimable(&c, "a.near"), claimable(&c, "b.near")), (750, 0));
        assert_eq!(
            c.seat_earnings("3".into()).unwrap().start_acc.0,
            c.quarter_acc.get(&Q4_2026).copied().unwrap(),
            "it starts from the index after the pool"
        );
        revenue(&mut c, 2, 600);
        assert_eq!((earned(&c, "a.near"), earned(&c, "b.near")), (1_050, 300));
    }

    #[test]
    fn the_cut_pool_is_split_among_the_seats_earning_at_the_boundary() {
        let mut c = council();
        for (token, owner) in [("1", "a.near"), ("2", "b.near"), ("3", "c.near"), ("4", "l.near")] {
            stake(&mut c, token, owner);
        }
        set_time(day(1));
        revenue(&mut c, 1, 1_200);
        set_time(day(2));
        request(&mut c, "4", "l.near");
        assert_eq!(c.reward_totals().cut_pool.0, 150);
        close_quarter(&mut c);
        assert_eq!(c.reward_totals().cut_pool.0, 0);
        assert_eq!(
            ["a.near", "b.near", "c.near", "l.near"].map(|o| claimable(&c, o)),
            [350, 350, 350, 150]
        );
    }

    #[test]
    fn the_cut_pool_is_carried_when_nobody_is_earning_at_the_boundary() {
        let mut c = council();
        stake(&mut c, "1", "l.near");
        set_time(day(1));
        revenue(&mut c, 1, 1_000);
        set_time(day(5));
        request(&mut c, "1", "l.near");
        close_quarter(&mut c);
        let data = &events_named("quarter_closed")[0];
        assert_eq!(
            (data["cut_shared"].as_str(), data["carried"].as_str()),
            (Some("0"), Some("500"))
        );
        let totals = c.reward_totals();
        assert_eq!((totals.cut_pool.0, totals.carry.0), (0, 500));
        stake(&mut c, "2", "b.near");
        set_time(day(Q4_DAYS + 2));
        revenue(&mut c, 2, 100);
        assert_eq!(
            earned(&c, "b.near"),
            600,
            "the carried pool is shared at the next payment"
        );
    }

    #[test]
    fn a_quarter_nobody_claims_stays_claimable_two_quarters_later() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        set_time(day(1));
        revenue(&mut c, 1, 1_000);
        set_time(day(70));
        advance(&mut c);
        set_time(day(100));
        revenue(&mut c, 2, 600);
        set_time(day(200));
        assert_eq!(advance(&mut c), 100);
        assert_eq!(c.last_closed_quarter, Q1_2027);
        assert_eq!(
            c.quarter_snapshots(None, None).len(),
            3,
            "the initial one and the two closed"
        );
        assert_eq!(claim(&mut c, "a.near", &["1"]), 1_600);
    }

    #[test]
    fn a_claim_in_the_middle_of_a_quarter_pays_the_closed_quarters_only() {
        let mut c = two_seats_closed();
        set_time(day(Q4_DAYS + 1));
        revenue(&mut c, 2, 500);
        assert_eq!(
            (claimable(&c, "a.near"), c.in_progress_of(acct("a.near")).0),
            (500, 250)
        );
        assert_eq!(claim(&mut c, "a.near", &["1"]), 500);
        assert_eq!((claimable(&c, "a.near"), c.in_progress_of(acct("a.near")).0), (0, 250));
        close_quarter_two(&mut c);
        assert_eq!(
            claim(&mut c, "a.near", &["1"]),
            250,
            "the same claim after the quarter closes includes it"
        );
    }

    // Closes 2027 Q1, the quarter after the one close_quarter closes.
    fn close_quarter_two(c: &mut CouncilContract) {
        set_time(day(Q4_DAYS + Q1_DAYS));
        advance(c);
        assert_eq!(c.last_closed_quarter, Q1_2027);
    }

    #[test]
    fn the_kept_half_of_a_leaver_cannot_be_claimed_until_the_quarter_closes() {
        let mut c = two_seats_paid();
        set_time(day(2));
        request(&mut c, "1", "a.near");
        assert_eq!((claimable(&c, "a.near"), c.in_progress_of(acct("a.near")).0), (0, 250));
        act_paid("a.near");
        assert_eq!(refusal(|| drop(c.claim(vec![]))), "nothing to claim");
        close_quarter(&mut c);
        assert_eq!((claimable(&c, "a.near"), c.in_progress_of(acct("a.near")).0), (250, 0));
        assert_eq!(
            claim(&mut c, "a.near", &[]),
            250,
            "an empty list pays a holder who left"
        );
        assert_eq!(c.reward_totals().pending_total_slots.0, 0);
    }

    // ---- leaving -----------------------------------------------------------------------------------------------

    #[test]
    fn requesting_an_unstake_requires_exactly_one_yocto_before_changing_rewards() {
        let mut c = two_seats_paid();
        let before = c.config();
        for deposit in [0, 2] {
            testing_env!(context("a.near")
                .attached_deposit(NearToken::from_yoctonear(deposit))
                .build());
            assert!(refusal(|| c.request_unstake("1".into(), true)).contains("exactly 1 yoctoNEAR"));
            assert_eq!(c.config(), before);
            assert_eq!(c.cut_pool, 0);
            assert_eq!(c.in_progress_of(acct("a.near")).0, 500);
            assert!(c.stake_of("1".into()).unwrap().unlock_requested_at.is_none());
        }
        request(&mut c, "1", "a.near");
        assert_eq!(c.cut_pool, 250);
        assert_eq!(c.in_progress_of(acct("a.near")).0, 250);
        assert!(c.stake_of("1".into()).unwrap().unlock_requested_at.is_some());
    }

    #[test]
    fn a_request_to_leave_is_refused_without_accepts_cut_and_for_a_seat_that_is_not_the_callers() {
        let mut c = two_seats_paid();
        act_paid("a.near");
        assert_eq!(
            refusal(|| c.request_unstake("1".into(), false)),
            "leaving before the quarter ends costs 50% of this quarter's earnings: pass accepts_cut true"
        );
        assert!(c.stake_of("1".into()).unwrap().unlock_requested_at.is_none());
        act_paid("b.near");
        assert_eq!(refusal(|| c.request_unstake("1".into(), true)), "not your seat");
        act_paid("a.near");
        assert_eq!(refusal(|| c.request_unstake("9".into(), true)), "not staked");
        c.request_unstake("1".into(), true);
        assert_eq!(
            refusal(|| c.request_unstake("1".into(), true)),
            "unstake already requested"
        );
    }

    #[test]
    fn a_leaver_loses_half_of_the_running_quarter_and_nothing_from_earlier_ones() {
        let mut c = two_seats_closed();
        set_time(day(Q4_DAYS + 1));
        revenue(&mut c, 2, 999);
        request(&mut c, "1", "a.near");
        assert_eq!(
            c.accrued.get(&acct("a.near")).copied(),
            Some(500),
            "the finished quarter is paid in full"
        );
        let slot = c.pending.get(&acct("a.near")).unwrap().clone().into_inner();
        assert_eq!((slot.quarter, slot.amount), (Q1_2027, 250));
        assert_eq!(c.reward_totals().cut_pool.0, 249);
        let cut = &events_named("seat_cut")[0];
        assert_eq!(
            (
                cut["quarter"].as_u64(),
                cut["earned"].as_str(),
                cut["cut"].as_str(),
                cut["kept"].as_str()
            ),
            (Some(u64::from(Q1_2027)), Some("499"), Some("249"), Some("250")),
            "an odd amount rounds the cut down, so cut plus kept is what was earned"
        );
    }

    #[test]
    fn a_second_leave_in_the_same_quarter_adds_to_the_same_slot() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "a.near");
        stake(&mut c, "3", "b.near");
        set_time(day(1));
        revenue(&mut c, 1, 900);
        set_time(day(2));
        request(&mut c, "1", "a.near");
        request(&mut c, "2", "a.near");
        let slot = c.pending.get(&acct("a.near")).unwrap().clone().into_inner();
        assert_eq!((slot.quarter, slot.amount, c.pending_total_slots), (Q4_2026, 300, 300));
        assert_eq!(c.reward_totals().cut_pool.0, 300);
    }

    #[test]
    fn an_older_closed_slot_is_paid_into_the_balance_before_a_new_one_is_written() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "a.near");
        stake(&mut c, "3", "b.near");
        set_time(day(1));
        revenue(&mut c, 1, 900);
        set_time(day(2));
        request(&mut c, "1", "a.near");
        close_quarter(&mut c);
        set_time(day(Q4_DAYS + 1));
        revenue(&mut c, 2, 300);
        request(&mut c, "2", "a.near");
        assert_eq!(
            c.accrued.get(&acct("a.near")).copied(),
            Some(375 + 150),
            "seat 2's finished quarter (300 and 75 of the cut) and the old slot (150) are in the balance"
        );
        let slot = c.pending.get(&acct("a.near")).unwrap().clone().into_inner();
        assert_eq!(
            (slot.quarter, slot.amount),
            (Q1_2027, 75),
            "150 earned this quarter, half kept"
        );
    }

    #[test]
    fn a_seat_that_never_started_loses_nothing_and_earns_nothing() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(1));
        revenue(&mut c, 1, 100);
        stake(&mut c, "3", "c.near");
        request(&mut c, "3", "c.near");
        let cut = &events_named("seat_cut")[0];
        assert_eq!(
            (cut["earned"].as_str(), cut["cut"].as_str(), cut["kept"].as_str()),
            (Some("0"), Some("0"), Some("0"))
        );
        assert!(c.joins_on.get(&(START / DAY + 2)).is_none(), "its start day is gone");
        assert!(c.pending.get(&acct("c.near")).is_none());
        set_time(day(2));
        revenue(&mut c, 2, 100);
        assert_eq!(earned(&c, "c.near"), 0);
        assert_eq!((c.active, earning(&c)), (2, 2));
        assert_eq!(c.reward_totals().cut_pool.0, 0);
    }

    #[test]
    fn a_leavers_amounts_are_the_same_whether_the_snapshot_is_taken_on_time_or_days_late() {
        let run = |on_time: bool| {
            let mut c = two_seats_paid();
            set_time(day(70));
            advance(&mut c);
            set_time(day(Q4_DAYS - 1));
            revenue(&mut c, 2, 600);
            set_time(day(Q4_DAYS));
            if on_time {
                advance(&mut c);
            }
            set_time(day(Q4_DAYS + 8));
            request(&mut c, "1", "a.near");
            let totals = c.reward_totals();
            (
                c.accrued.get(&acct("a.near")).copied(),
                c.pending.get(&acct("a.near")).is_none(),
                totals.cut_pool.0,
                c.quarter_acc.get(&Q4_2026).copied(),
            )
        };
        assert_eq!(run(true), run(false));
        assert_eq!(
            run(false).0,
            Some(800),
            "all of the finished quarter, though its snapshot came late"
        );
    }

    #[test]
    fn an_unstake_request_settles_the_seat_and_it_stops_earning() {
        let mut c = two_seats_paid();
        set_time(day(2));
        request(&mut c, "1", "a.near");
        assert_eq!((c.active, c.pending_total_slots, c.cut_pool), (1, 250, 250));
        set_time(day(3));
        revenue(&mut c, 2, 1_000);
        assert_eq!((earned(&c, "a.near"), earned(&c, "b.near")), (250, 1_500));
        let leaving = c.seat_earnings("1".into()).unwrap();
        assert_eq!(
            (leaving.state, leaving.earned_closed.0, leaving.earned_in_progress.0),
            (SeatState::Leaving, 0, 0)
        );
        close_quarter(&mut c);
        assert_eq!((claimable(&c, "a.near"), claimable(&c, "b.near")), (250, 1_750));
    }

    #[test]
    fn a_seat_that_asks_to_leave_on_the_day_it_would_start_earns_only_what_came_that_day() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(1));
        request(&mut c, "1", "a.near");
        assert_eq!(
            (c.active, c.last_day),
            (1, START / DAY + 1),
            "it had started, so it leaves the count"
        );
        revenue(&mut c, 1, 800);
        assert_eq!((earned(&c, "a.near"), earned(&c, "b.near")), (0, 800));

        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(1));
        revenue(&mut c, 1, 800);
        request(&mut c, "1", "a.near");
        set_time(day(1) + DAY / 2);
        revenue(&mut c, 2, 800);
        assert_eq!((earned(&c, "a.near"), earned(&c, "b.near")), (200, 1_200));
    }

    #[test]
    fn a_seat_leaving_mid_day_does_not_change_the_other_shares_of_earlier_payments() {
        let mut c = council();
        for (token, owner) in [("1", "a.near"), ("2", "b.near"), ("3", "c.near")] {
            stake(&mut c, token, owner);
        }
        set_time(day(1) + DAY / 2);
        revenue(&mut c, 1, 900);
        set_time(day(1) + DAY / 2 + 3_600 * SECOND);
        request(&mut c, "3", "c.near");
        set_time(day(1) + DAY - 1);
        revenue(&mut c, 2, 600);
        assert_eq!(["a.near", "b.near", "c.near"].map(|o| earned(&c, o)), [600, 600, 150]);
    }

    #[test]
    fn a_token_unstaked_and_restaked_the_same_day_starts_again_the_next_day() {
        let mut c = two_seats_paid();
        set_time(day(2));
        leave(&mut c, "1", "a.near");
        assert!(c.stake_of("1".into()).is_none());
        stake(&mut c, "1", "c.near");
        assert_eq!(c.stake_of("1".into()).unwrap().earn_from_day.0, START / DAY + 3);
        set_time(day(2) + DAY / 2);
        revenue(&mut c, 2, 1_000);
        set_time(day(3));
        revenue(&mut c, 3, 1_000);
        assert_eq!(["a.near", "b.near", "c.near"].map(|o| earned(&c, o)), [250, 2_000, 500]);
        close_quarter(&mut c);
        assert_eq!(
            claim(&mut c, "a.near", &[]),
            250,
            "an account with no seat left claims its kept half"
        );
    }

    #[test]
    fn a_failed_unstake_restores_the_seat_and_it_does_not_earn_again() {
        let mut c = two_seats_paid();
        set_time(day(2));
        request(&mut c, "1", "a.near");
        let before = c.stake_of("1".into()).unwrap();
        act_at("a.near", day(2) + COOLDOWN_NS);
        let _ = c.unstake("1".into());
        assert_eq!(c.seat_count(), 1);
        set_time(day(2) + COOLDOWN_NS + 3_600 * SECOND);
        act_as("council.near");
        c.on_unstaked("1".into(), before, Err(PromiseError::Failed));
        assert_eq!(last_event()["event"], "unstake_failed");
        assert_eq!((c.seat_count(), c.active), (2, 1));
        assert_eq!(c.seats_of(acct("a.near")), vec!["1".to_string()]);
        set_time(day(3));
        revenue(&mut c, 2, 1_000);
        close_quarter(&mut c);
        assert_eq!(
            (claimable(&c, "a.near"), claimable(&c, "b.near")),
            (250, 1_750),
            "the restored seat earns nothing and a claim cannot settle it again"
        );
        assert_eq!(claim(&mut c, "a.near", &["1"]), 250);
    }

    // ---- self-healing ------------------------------------------------------------------------------------------

    // One seat from day 0 with a sweep on day 1, then the clock on day 95: 2026 Q4 is over and nobody has advanced.
    fn overdue() -> CouncilContract {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(1));
        revenue(&mut c, 1, 1_000);
        set_time(day(95));
        assert_eq!(c.last_closed_quarter, Q4_2026 - 1);
        c
    }

    #[test]
    fn revenue_request_unstake_and_claim_run_the_overdue_snapshot_themselves() {
        let mut c = overdue();
        set_time(day(80));
        advance(&mut c);
        set_time(day(95));
        revenue(&mut c, 2, 100);
        assert_eq!(c.last_closed_quarter, Q4_2026);
        assert_eq!(events_named("quarter_closed").len(), 1);
        let mut c = overdue();
        request(&mut c, "1", "a.near");
        assert_eq!(c.last_closed_quarter, Q4_2026);
        assert_eq!(c.accrued.get(&acct("a.near")).copied(), Some(500));
        let mut c = overdue();
        assert_eq!(claim(&mut c, "a.near", &["1"]), 500);
        assert_eq!(c.last_closed_quarter, Q4_2026);
    }

    // The mock chain keeps what a refused call changed, so each refusal gets a council of its own.
    fn a_day_too_far_behind() -> CouncilContract {
        let c = two_seats_paid();
        set_time(day(1) + (u64::from(MAX_DAY_STEPS) + 1) * DAY);
        c
    }

    #[test]
    fn a_claim_and_an_unstake_refuse_only_when_the_council_is_more_than_a_hundred_days_behind() {
        let mut c = two_seats_paid();
        set_time(day(1) + u64::from(MAX_DAY_STEPS) * DAY);
        request(&mut c, "1", "a.near");
        assert_eq!(c.last_day, START / DAY + 1 + u64::from(MAX_DAY_STEPS));

        let mut c = a_day_too_far_behind();
        act_as(VERIFIER);
        assert_eq!(
            refusal(|| drop(deliver(&mut c, MARKET, vec![COLLATERAL_ID], vec![900], "revenue:2"))),
            "call advance_days first"
        );
        let mut c = a_day_too_far_behind();
        act_paid("a.near");
        assert_eq!(
            refusal(|| c.request_unstake("1".into(), true)),
            "call advance_days first"
        );
        let mut c = a_day_too_far_behind();
        act_paid("a.near");
        assert_eq!(refusal(|| drop(c.claim(vec!["1".into()]))), "call advance_days first");
        let mut c = a_day_too_far_behind();
        assert_eq!(advance(&mut c), MAX_DAY_STEPS);
        revenue(&mut c, 2, 100);
        assert_eq!(c.total_received().0, 1_100);
    }

    // One seat of two is drawn, then the clock is `days` past the day the sweep came in.
    fn drawn_and_behind(days: u64) -> CouncilContract {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        act_with_seed(ORACLE, 1);
        c.draw(U64(1), 2, vec![]);
        set_time(day(days));
        c
    }

    #[test]
    fn a_receipt_and_a_release_walk_at_most_thirty_days_and_a_claim_or_an_unstake_a_hundred() {
        let thirty = u64::from(MAX_RECEIPT_CATCH_UP_DAYS);
        let behind = |days: u64| {
            let c = two_seats_paid();
            set_time(day(1) + days * DAY);
            c
        };
        let mut c = behind(thirty);
        revenue(&mut c, 2, 100);
        assert_eq!(c.last_day, START / DAY + 1 + thirty);
        let mut c = drawn_and_behind(thirty);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("a.near")]);
        assert!(c.jury_of(U64(1)).is_empty());

        let mut c = behind(thirty + 1);
        act_as(VERIFIER);
        assert_eq!(
            refusal(|| drop(deliver(&mut c, MARKET, vec![COLLATERAL_ID], vec![900], "revenue:2"))),
            "call advance_days first"
        );
        let mut c = drawn_and_behind(thirty + 1);
        act_as(ORACLE);
        assert_eq!(
            refusal(|| c.unlock_case(U64(1), vec![acct("a.near")])),
            "call advance_days first"
        );
        let mut c = behind(thirty + 1);
        request(&mut c, "1", "a.near");
        assert_eq!(c.last_day, START / DAY + 1 + thirty + 1);
        let mut c = behind(thirty + 1);
        act_paid("a.near");
        assert_eq!(
            refusal(|| drop(c.claim(vec!["1".into()]))),
            "nothing to claim",
            "the claim got past the catch-up"
        );
    }

    #[test]
    fn a_hundred_days_of_joiners_log_one_summary_for_the_walk_and_the_capped_paths_leave_it_to_advance_days() {
        let hundred = u64::from(MAX_DAY_STEPS);
        let behind = || {
            let mut c = council();
            for d in 0..hundred {
                set_time(day(d));
                stake(&mut c, &d.to_string(), &format!("s{d}.near"));
            }
            set_time(day(hundred));
            c
        };
        let mut c = behind();
        act_as(VERIFIER);
        assert_eq!(
            refusal(|| drop(deliver(&mut c, MARKET, vec![COLLATERAL_ID], vec![900], "revenue:1"))),
            "call advance_days first"
        );
        let mut c = behind();
        assert_eq!(advance(&mut c), MAX_DAY_STEPS);
        assert!(
            near_sdk::test_utils::get_logs().len() < 100,
            "a walk can never log a line a day"
        );
        let started = events_named("seats_started");
        assert_eq!(started.len(), 1);
        assert_eq!(
            (started[0]["count"].as_u64(), started[0]["start_days"].as_u64()),
            (Some(hundred), Some(hundred))
        );
        assert_eq!(events_named("quarter_closed").len(), 1);
        assert_eq!((c.active, c.last_day), (MAX_DAY_STEPS, START / DAY + hundred));
        revenue(&mut c, 1, 900);
        assert_eq!(c.total_received().0, 900);
    }

    #[test]
    fn advance_days_walks_at_most_a_hundred_days_a_call_and_as_many_as_it_is_asked() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        set_time(day(250));
        act_as("anyone.near");
        assert_eq!(c.advance_days(Some(0)), 0);
        assert_eq!(c.advance_days(Some(5)), 5);
        assert_eq!(c.advance_days(Some(1_000)), MAX_DAY_STEPS);
        assert_eq!(c.advance_days(None), MAX_DAY_STEPS);
        assert_eq!(c.advance_days(None), 45);
        assert_eq!(c.advance_days(None), 0);
        assert_eq!((c.last_day, c.active), (START / DAY + 250, 1));
        assert_eq!(c.last_closed_quarter, Q1_2027, "two quarters closed on the way");
    }

    #[test]
    fn advance_days_logs_one_summary_of_the_seats_it_started_and_each_quarter_it_closes() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        set_time(day(1));
        stake(&mut c, "2", "b.near");
        set_time(day(Q4_DAYS + 3));
        act_as("anyone.near");
        assert_eq!(c.advance_days(Some(1)), 1);
        let first_day = START / DAY + 1;
        assert_eq!(
            events_named("seats_started"),
            [
                near_sdk::serde_json::json!({ "from_day": first_day.to_string(), "to_day": first_day.to_string(),
                                           "start_days": 1, "count": 1 })
            ]
        );
        assert_eq!(c.advance_days(None), Q4_DAYS as u32 + 2);
        let started = events_named("seats_started");
        assert_eq!(started.len(), 2, "one more summary for the second walk");
        assert_eq!(
            started[1],
            near_sdk::serde_json::json!({ "from_day": (first_day + 1).to_string(),
                                          "to_day": (START / DAY + Q4_DAYS + 3).to_string(), "start_days": 1, "count": 1 })
        );
        assert_eq!(events_named("quarter_closed").len(), 1);
        assert_eq!(c.active, 2);
        assert!(c.joins_on.get(&(START / DAY + 2)).is_none());
    }

    // ---- claims ------------------------------------------------------------------------------------------------

    #[test]
    fn a_claim_pays_once_and_a_failed_transfer_puts_the_balance_back() {
        let mut c = two_seats_closed();
        let (first, amount) = claim_without_reply(&mut c, "a.near", &["1"]);
        assert_eq!(amount, 500);
        let totals = c.reward_totals();
        assert_eq!((totals.pending_claims.0, totals.accrued_total.0), (500, 0));
        assert_eq!(claimable(&c, "a.near"), 0);
        act_paid("a.near");
        assert_eq!(refusal(|| drop(c.claim(vec!["1".into()]))), "nothing to claim");
        act_as("council.near");
        c.on_claim_paid(U64(first), Err(PromiseError::Failed));
        let failed = last_event();
        assert_eq!(failed["event"], "claim_failed");
        assert_eq!(
            (failed["data"]["id"].as_str(), failed["data"]["amount"].as_str()),
            (Some(first.to_string().as_str()), Some("500"))
        );
        assert_eq!(failed["data"]["tokens"], near_sdk::serde_json::json!(["1"]));
        assert_eq!(
            (c.pending_claims_total, c.total_paid, claimable(&c, "a.near")),
            (0, 0, 500)
        );
        let (second, again) = claim_without_reply(&mut c, "a.near", &["1"]);
        assert_ne!(first, second);
        act_as("council.near");
        c.on_claim_paid(U64(second), Ok(()));
        assert_eq!((last_event()["event"].as_str(), again), (Some("claim_paid"), 500));
        c.on_claim_paid(U64(second), Ok(()));
        c.on_claim_paid(U64(second), Err(PromiseError::Failed));
        c.on_claim_paid(U64(first), Ok(()));
        let totals = c.reward_totals();
        assert_eq!(
            (totals.total_paid.0, totals.pending_claims.0, totals.accrued_total.0),
            (500, 0, 0),
            "a late or repeated callback changes nothing"
        );
        assert_eq!(claimable(&c, "a.near"), 0);
    }

    #[test]
    fn nobody_claims_for_a_seat_they_do_not_hold() {
        let mut c = two_seats_closed();
        for who in ["b.near", "stranger.near"] {
            act_paid(who);
            assert_eq!(refusal(|| drop(c.claim(vec!["1".into()]))), "not your seat", "{who}");
        }
        act_paid("a.near");
        assert_eq!(refusal(|| drop(c.claim(vec!["9".into()]))), "not staked");
        act_paid("stranger.near");
        assert_eq!(refusal(|| drop(c.claim(vec![]))), "nothing to claim");
        assert_eq!(
            claim(&mut c, "a.near", &["1"]),
            500,
            "the attempts did not touch the seat"
        );
    }

    #[test]
    fn a_claim_needs_one_yocto_and_the_gas_for_its_payout_and_takes_at_most_ten_tokens() {
        let mut c = two_seats_closed();
        act_as("a.near");
        assert_eq!(
            refusal(|| drop(c.claim(vec!["1".into()]))),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        act_with_gas("a.near", 32);
        assert_eq!(
            refusal(|| drop(c.claim(vec!["1".into()]))),
            "attach at least 33 TGas: a claim sends the payout and then settles it"
        );
        act_with_gas("a.near", 33);
        let eleven: Vec<TokenId> = (0..=MAX_CLAIM_TOKENS).map(|i| i.to_string()).collect();
        assert_eq!(refusal(|| drop(c.claim(eleven))), "at most 10 tokens in one claim");
        assert_eq!(GAS_CLAIM_FLOOR, Gas::from_tgas(33));
    }

    #[test]
    fn one_claim_settles_ten_seats_into_one_payout() {
        let mut c = council();
        let tokens: Vec<String> = (0..MAX_CLAIM_TOKENS).map(|i| format!("t{i}")).collect();
        for t in &tokens {
            stake(&mut c, t, "big.near");
        }
        stake(&mut c, "other", "other.near");
        set_time(day(1));
        revenue(&mut c, 1, 1_100);
        close_quarter(&mut c);
        let refs: Vec<&str> = tokens.iter().map(String::as_str).collect();
        let (_, amount) = claim_without_reply(&mut c, "big.near", &refs);
        assert_eq!(amount, 1_000);
        let sent = near_sdk::test_utils::get_created_receipts();
        let (args, deposit, gas) = mt_transfer_of(&sent[0]);
        assert_eq!((deposit, gas), (1, GAS_MT_TRANSFER.as_gas()));
        assert_eq!(
            (
                args["receiver_id"].as_str(),
                args["token_id"].as_str(),
                args["amount"].as_str()
            ),
            (Some("big.near"), Some(COLLATERAL_ID), Some("1000"))
        );
        assert_eq!(sent.iter().filter(|r| r.receiver_id == acct(VERIFIER)).count(), 1);
    }

    fn stuck_claim() -> (CouncilContract, u64) {
        let mut c = two_seats_closed();
        let (id, _) = claim_without_reply(&mut c, "a.near", &["1"]);
        (c, id)
    }

    #[test]
    fn only_the_owner_decides_a_stuck_claim_and_not_before_the_wait() {
        let (mut c, id) = stuck_claim();
        set_time(now() + RECONCILE_WAIT_NS - 1);
        assert_eq!(
            refusal(|| c.reconcile_claim(U64(id), false)),
            "wait 60 minutes after the claim before reconciling"
        );
        set_time(now() + 1);
        act_as("a.near");
        assert_eq!(refusal(|| c.reconcile_claim(U64(id), false)), "owner only");
        act_as(OWNER);
        assert_eq!(
            refusal(|| c.reconcile_claim(U64(id + 1), false)),
            "no claim is pending with that id"
        );
        assert_eq!(c.reward_totals().pending_claims.0, 500, "nothing moved");
    }

    #[test]
    fn a_stuck_claim_the_owner_finds_unpaid_goes_back_to_the_balance() {
        let (mut c, id) = stuck_claim();
        set_time(now() + RECONCILE_WAIT_NS);
        c.reconcile_claim(U64(id), false);
        let event = last_event();
        assert_eq!(
            (event["event"].as_str(), event["data"]["paid"].as_bool()),
            (Some("claim_reconciled"), Some(false))
        );
        assert_eq!(
            (c.pending_claims_total, c.total_paid, claimable(&c, "a.near")),
            (0, 0, 500)
        );
        assert_eq!(claim(&mut c, "a.near", &[]), 500);
    }

    #[test]
    fn a_stuck_claim_the_owner_finds_paid_is_booked_once_and_a_late_callback_changes_nothing() {
        let (mut c, id) = stuck_claim();
        set_time(now() + RECONCILE_WAIT_NS);
        c.reconcile_claim(U64(id), true);
        assert_eq!(last_event()["data"]["paid"].as_bool(), Some(true));
        act_as("council.near");
        c.on_claim_paid(U64(id), Err(PromiseError::Failed));
        c.on_claim_paid(U64(id), Ok(()));
        assert_eq!(
            (c.pending_claims_total, c.total_paid, claimable(&c, "a.near")),
            (0, 500, 0)
        );
        act_as(OWNER);
        assert_eq!(
            refusal(|| c.reconcile_claim(U64(id), false)),
            "no claim is pending with that id"
        );
    }

    #[test]
    fn a_longer_reconcile_wait_refuses_a_reconcile_the_old_wait_would_allow() {
        let (mut c, id) = stuck_claim();
        act_as(OWNER);
        c.set_reconcile_wait_ns(U64(2 * DEFAULT_RECONCILE_WAIT_NS));
        set_time(now() + RECONCILE_WAIT_NS);
        assert_eq!(
            refusal(|| c.reconcile_claim(U64(id), false)),
            "wait 120 minutes after the claim before reconciling"
        );
        set_time(now() + RECONCILE_WAIT_NS);
        c.reconcile_claim(U64(id), false);
        assert_eq!(last_event()["event"], "claim_reconciled");
    }

    #[test]
    fn a_shorter_reconcile_wait_lets_the_owner_decide_sooner() {
        let (mut c, id) = stuck_claim();
        act_as(OWNER);
        c.set_reconcile_wait_ns(U64(MIN_RECONCILE_WAIT_NS));
        set_time(now() + MIN_RECONCILE_WAIT_NS - 1);
        assert!(refusal(|| c.reconcile_claim(U64(id), false)).starts_with("wait 10 minutes"));
        set_time(now() + 1);
        c.reconcile_claim(U64(id), false);
    }

    // ---- silent jurors -----------------------------------------------------------------------------------------

    // Three seats from day 0 and 900 on day 1. All three are drawn on day 2, another 900 comes on day 3 and the case is
    // released on day 4 with `delinquent` silent.
    fn released_case(delinquent: &[&str]) -> CouncilContract {
        let mut c = council();
        for (token, owner) in [("1", "a.near"), ("2", "b.near"), ("3", "c.near")] {
            stake(&mut c, token, owner);
        }
        set_time(day(1));
        revenue(&mut c, 1, 900);
        set_time(day(2));
        act_with_seed(ORACLE, 1);
        assert_eq!(c.draw(U64(1), 3, vec![]).len(), 3);
        set_time(day(3));
        revenue(&mut c, 2, 900);
        set_time(day(4));
        act_as(ORACLE);
        c.unlock_case(U64(1), delinquent.iter().map(|o| acct(o)).collect());
        c
    }

    #[test]
    fn a_silent_juror_loses_what_its_seat_earned_while_serving_and_only_the_others_share_it() {
        let mut c = released_case(&["a.near"]);
        assert_eq!(
            c.reward_totals().carry.0,
            0,
            "the others' shares went into the index at the release"
        );
        assert_eq!(
            events_named("seat_earnings_forfeited"),
            [near_sdk::serde_json::json!({ "token_id": "1", "owner": "a.near", "case_key": "1", "amount": "300" })]
        );
        assert_eq!(["a.near", "b.near", "c.near"].map(|o| earned(&c, o)), [300, 750, 750]);
        set_time(day(5));
        revenue(&mut c, 3, 300);
        assert_eq!(
            ["a.near", "b.near", "c.near"].map(|o| earned(&c, o)),
            [400, 850, 850],
            "the juror does not get a third of its own forfeit back"
        );
    }

    #[test]
    fn a_silent_juror_that_is_the_only_seat_earning_leaves_its_forfeit_in_the_carry() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(1));
        request(&mut c, "2", "b.near");
        act_with_seed(ORACLE, 1);
        c.draw(U64(1), 1, vec![]);
        revenue(&mut c, 1, 200);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("a.near")]);
        assert_eq!(c.reward_totals().carry.0, 200, "nobody else is earning to share it");
        assert_eq!(earned(&c, "a.near"), 0);
    }

    #[test]
    fn jurors_who_voted_lose_nothing() {
        let c = released_case(&[]);
        assert_eq!(c.reward_totals().carry.0, 0);
        assert_eq!(["a.near", "b.near", "c.near"].map(|o| earned(&c, o)), [600, 600, 600]);
    }

    #[test]
    fn a_case_is_forfeited_once_and_naming_an_outsider_changes_nothing() {
        let mut c = released_case(&["a.near", "a.near", "nobody.near"]);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("a.near")]);
        assert_eq!(c.reward_totals().carry.0, 0);
        assert_eq!(["a.near", "b.near", "c.near"].map(|o| earned(&c, o)), [300, 750, 750]);
    }

    // Two seats from day 0, 1,000 on day 1, both drawn, 1,000 more, and the quarter closed with each seat at 1,000.
    fn serving_pair() -> CouncilContract {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(1));
        revenue(&mut c, 1, 1_000);
        act_with_seed(ORACLE, 1);
        c.draw(U64(1), 2, vec![]);
        revenue(&mut c, 2, 1_000);
        close_quarter(&mut c);
        c
    }

    #[test]
    fn what_a_silent_juror_has_not_settled_is_forfeited_and_comes_off_its_next_claim() {
        let mut c = serving_pair();
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("a.near")]);
        assert_eq!(c.reward_totals().carry.0, 0);
        assert_eq!((claimable(&c, "a.near"), claimable(&c, "b.near")), (500, 1_000));
        assert_eq!(claim(&mut c, "a.near", &["1"]), 500);
        assert_eq!(
            c.stakes["1"].forfeited, 500,
            "the part its share of the others' split still owes comes off the running quarter"
        );
        assert_eq!(claimable(&c, "a.near"), 0);
    }

    #[test]
    fn a_claim_while_serving_pays_only_what_came_before_the_draw_and_the_rest_waits_for_the_release() {
        let mut c = serving_pair();
        assert_eq!(
            (claimable(&c, "a.near"), earned(&c, "a.near")),
            (500, 1_000),
            "what it earned after the draw is held back, not gone"
        );
        assert_eq!(claim(&mut c, "a.near", &["1"]), 500);
        assert_eq!(earned(&c, "a.near"), 500);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("a.near")]);
        assert_eq!(events_named("seat_earnings_forfeited")[0]["amount"], "500");
        assert_eq!(
            (claimable(&c, "a.near"), claimable(&c, "b.near")),
            (0, 1_000),
            "the silent juror could not claim the serving period before the release"
        );
        let mut c = serving_pair();
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![]);
        assert_eq!(
            claim(&mut c, "a.near", &["1"]),
            1_000,
            "a juror who voted is paid all of it"
        );
    }

    #[test]
    fn a_seat_drawn_before_it_started_forfeits_only_what_came_after_its_start() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        act_with_seed(ORACLE, 1);
        c.draw(U64(1), 2, vec![]);
        set_time(day(1));
        revenue(&mut c, 1, 600);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("a.near")]);
        assert_eq!((c.reward_totals().carry.0, earned(&c, "b.near")), (0, 600));
        assert_eq!(earned(&c, "a.near"), 0);
    }

    // Two seats from day 0 and 1,000 on day 1, the quarter closed at 500 each, 400 more, both drawn, 400 more, and a.near
    // silent: it lost the 200 it earned after the draw.
    fn silent_in_the_running_quarter() -> CouncilContract {
        let mut c = two_seats_closed();
        set_time(day(Q4_DAYS + 1));
        revenue(&mut c, 2, 400);
        act_with_seed(ORACLE, 1);
        c.draw(U64(1), 2, vec![]);
        revenue(&mut c, 3, 400);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("a.near")]);
        c
    }

    #[test]
    fn a_forfeit_comes_off_the_running_quarter_first_so_the_finished_one_is_paid_in_full() {
        let c = silent_in_the_running_quarter();
        assert_eq!(
            (claimable(&c, "a.near"), c.in_progress_of(acct("a.near")).0),
            (500, 200),
            "its 200 and the 200 it got of the others' split come off the running 600"
        );
        assert_eq!(
            (claimable(&c, "b.near"), c.in_progress_of(acct("b.near")).0),
            (500, 600)
        );
        assert_eq!(held(&c), 1_800);
    }

    #[test]
    fn a_leaver_is_cut_on_what_its_quarter_earned_after_the_forfeit() {
        let mut c = silent_in_the_running_quarter();
        request(&mut c, "1", "a.near");
        let cut = &events_named("seat_cut")[0];
        assert_eq!(
            (cut["earned"].as_str(), cut["cut"].as_str(), cut["kept"].as_str()),
            (Some("200"), Some("100"), Some("100"))
        );
        assert_eq!(c.accrued.get(&acct("a.near")).copied(), Some(500));
    }

    #[test]
    fn the_carry_is_shared_when_a_quarter_closes_even_if_no_sweep_comes() {
        let mut c = council();
        revenue(&mut c, 1, 500);
        assert_eq!(c.reward_totals().carry.0, 500);
        stake(&mut c, "1", "a.near");
        close_quarter(&mut c);
        assert_eq!(c.reward_totals().carry.0, 0);
        assert_eq!(claimable(&c, "a.near"), 500);
    }

    #[test]
    fn a_draw_on_the_first_day_of_a_quarter_closes_the_quarter_first_so_the_juror_keeps_what_the_pool_gave_it() {
        let mut c = council();
        for (token, owner) in [("1", "a.near"), ("2", "b.near"), ("3", "l.near")] {
            stake(&mut c, token, owner);
        }
        set_time(day(1));
        revenue(&mut c, 1, 900);
        set_time(day(2));
        request(&mut c, "3", "l.near");
        set_time(day(70));
        advance(&mut c);
        set_time(day(Q4_DAYS));
        act_with_seed(ORACLE, 1);
        assert_eq!(c.draw(U64(1), 2, vec![]).len(), 2);
        assert_eq!(c.last_closed_quarter, Q4_2026, "the draw walked the days first");
        set_time(day(Q4_DAYS + 1));
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![acct("a.near")]);
        assert_eq!(events_named("seat_earnings_forfeited")[0]["amount"], "0");
        assert_eq!(claimable(&c, "a.near"), 375, "300 earned and 75 of the leaver's cut");
    }

    #[test]
    fn a_release_with_a_silent_juror_needs_the_days_caught_up_and_one_without_never_does() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        act_with_seed(ORACLE, 1);
        c.draw(U64(1), 2, vec![]);
        set_time(day(u64::from(MAX_DAY_STEPS) + 5));
        act_as(ORACLE);
        assert_eq!(
            refusal(|| c.unlock_case(U64(1), vec![acct("a.near")])),
            "call advance_days first"
        );
        assert_eq!(c.jury_of(U64(1)).len(), 2, "the refused release changed nothing");
        c.unlock_case(U64(1), vec![]);
        assert!(c.jury_of(U64(1)).is_empty());
    }

    // ---- views and totals --------------------------------------------------------------------------------------

    #[test]
    fn seat_earnings_shows_waiting_earning_serving_and_leaving() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        let state = |c: &CouncilContract| c.seat_earnings("1".into()).unwrap();
        assert_eq!(
            (state(&c).state, state(&c).earning_from.0, state(&c).owner),
            (SeatState::Waiting, day(1), acct("a.near"))
        );
        set_time(day(1));
        assert_eq!(state(&c).state, SeatState::Earning);
        act_with_seed(ORACLE, 1);
        c.draw(U64(1), 2, vec![]);
        assert_eq!(state(&c).state, SeatState::Serving);
        act_as(ORACLE);
        c.unlock_case(U64(1), vec![]);
        request(&mut c, "1", "a.near");
        assert_eq!(state(&c).state, SeatState::Leaving);
        assert!(c.seat_earnings("9".into()).is_none());
    }

    #[test]
    fn seat_earnings_splits_the_closed_quarters_from_the_running_one() {
        let mut c = two_seats_closed();
        set_time(day(Q4_DAYS + 1));
        revenue(&mut c, 2, 400);
        let seat = c.seat_earnings("1".into()).unwrap();
        assert_eq!((seat.earned_closed.0, seat.earned_in_progress.0), (500, 200));
        assert_eq!(
            (seat.start_acc.0, seat.settled_acc.0),
            (0, 0),
            "the index at its start day and where it is settled to"
        );
        assert_eq!(claim(&mut c, "a.near", &["1"]), 500);
        let seat = c.seat_earnings("1".into()).unwrap();
        assert_eq!(
            (seat.earned_closed.0, seat.earned_in_progress.0, seat.settled_acc.0),
            (0, 200, 500 * ACC_SCALE)
        );
    }

    #[test]
    fn quarter_info_and_the_snapshots_follow_the_calendar() {
        let mut c = council();
        let info = c.quarter_info();
        assert_eq!(
            (
                info.quarter,
                info.starts_at.0,
                info.ends_at.0,
                info.last_closed_quarter,
                info.last_day.0
            ),
            (Q4_2026, START, day(Q4_DAYS), Q4_2026 - 1, START / DAY)
        );
        stake(&mut c, "1", "a.near");
        set_time(day(1));
        revenue(&mut c, 1, 1_000);
        set_time(day(Q4_DAYS + Q1_DAYS + 5));
        advance(&mut c);
        advance(&mut c);
        let info = c.quarter_info();
        assert_eq!((info.quarter, info.last_closed_quarter), (Q1_2027 + 1, Q1_2027));
        let all: Vec<(u32, u128)> = c
            .quarter_snapshots(None, None)
            .iter()
            .map(|s| (s.quarter, s.acc.0))
            .collect();
        assert_eq!(
            all,
            [
                (Q4_2026 - 1, 0),
                (Q4_2026, 1_000 * ACC_SCALE),
                (Q1_2027, 1_000 * ACC_SCALE)
            ]
        );
        let last: Vec<u32> = c.quarter_snapshots(None, Some(1)).iter().map(|s| s.quarter).collect();
        assert_eq!(last, [Q1_2027], "no start means the latest ones");
        let page: Vec<u32> = c
            .quarter_snapshots(Some(Q4_2026), Some(1))
            .iter()
            .map(|s| s.quarter)
            .collect();
        assert_eq!(page, [Q4_2026]);
    }

    #[test]
    fn claimable_of_adds_the_balance_and_every_closed_seat_the_account_holds() {
        let mut c = council();
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "a.near");
        stake(&mut c, "3", "b.near");
        set_time(day(1));
        revenue(&mut c, 1, 900);
        close_quarter(&mut c);
        request(&mut c, "2", "a.near");
        assert_eq!(claimable(&c, "a.near"), 600);
        assert_eq!(claim(&mut c, "a.near", &["1"]), 600);
        assert_eq!(claimable(&c, "nobody.near"), 0);
    }

    #[test]
    fn reward_totals_track_received_paid_pending_owed_cut_and_carried() {
        let mut c = council();
        revenue(&mut c, 1, 100);
        stake(&mut c, "1", "a.near");
        stake(&mut c, "2", "b.near");
        set_time(day(1));
        revenue(&mut c, 2, 900);
        request(&mut c, "2", "b.near");
        let t = c.reward_totals();
        assert_eq!(
            (t.cut_pool.0, t.pending_total_slots.0, t.carry.0, t.accrued_total.0),
            (250, 250, 0, 0)
        );
        close_quarter(&mut c);
        let (id, _) = claim_without_reply(&mut c, "a.near", &["1"]);
        let t = c.reward_totals();
        assert_eq!(
            (
                t.total_received.0,
                t.total_paid.0,
                t.pending_claims.0,
                t.cut_pool.0,
                t.accrued_total.0,
                t.pending_total_slots.0
            ),
            (1_000, 0, 750, 0, 0, 250)
        );
        act_as("council.near");
        c.on_claim_paid(U64(id), Ok(()));
        let t = c.reward_totals();
        assert_eq!((t.total_paid.0, t.pending_claims.0, t.accrued_total.0), (750, 0, 0));
    }

    #[test]
    fn config_names_the_day_cursor_and_none_of_the_old_quarter_books() {
        let c = council();
        let config = c.config();
        for field in ["close_grace_ns", "next_to_finalize", "last_tick", "stream_ns"] {
            assert!(config.get(field).is_none(), "{field}");
        }
        assert_eq!(config["markets"], near_sdk::serde_json::json!([MARKET]));
        assert_eq!(config["nft_contract"], NFT);
        assert_eq!(config["state_version"], 6);
        assert_eq!(config["last_day"], (START / DAY).to_string());
        assert_eq!(config["active_seats"], 0);
        assert_eq!(config["last_closed_quarter"], Q4_2026 - 1);
    }

    // ---- the calendar ------------------------------------------------------------------------------------------

    #[test]
    fn the_quarter_table_holds() {
        for (id, start_s, days) in [
            (8_107u32, 1_790_812_800u64, 92u64),
            (8_108, 1_798_761_600, 90),
            (8_109, 1_806_537_600, 91),
            (8_110, 1_814_400_000, 92),
            (8_112, 1_830_297_600, 91),
        ] {
            assert_eq!(quarter_start(id), start_s * SECOND, "start of {id}");
            assert_eq!(quarter_end(id) - quarter_start(id), days * DAY, "length of {id}");
            assert_eq!(quarter_containing(start_s * SECOND), id);
            assert_eq!(quarter_containing(start_s * SECOND - 1), id - 1);
        }
        assert_eq!(
            quarter_containing(1_835_438_400_000_000_000),
            8_112,
            "29 February 2028 is in 2028 Q1"
        );
    }

    // An independent count of the days from 1970-01-01 to the first of every month, by month lengths and the leap rule.
    #[test]
    fn every_month_boundary_from_1970_to_2100_falls_in_the_right_quarter() {
        let leap = |y: u64| y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400));
        let mut days = 0u64;
        for year in 1970u64..=2100 {
            for month in 1u64..=12 {
                let start = days * DAY;
                let quarter = year as u32 * 4 + (month as u32 - 1) / 3;
                assert_eq!(quarter_containing(start), quarter, "{year}-{month:02}-01");
                if month % 3 == 1 {
                    assert_eq!(quarter_start(quarter), start, "start of {year} Q{}", month / 3 + 1);
                    assert_eq!(quarter_end(quarter - 1), start);
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

    // ---- the money identity ------------------------------------------------------------------------------------

    // Everything each staked seat could still be paid out of the index, finished quarters and running one.
    fn live_earnings(c: &CouncilContract) -> u128 {
        c.staked
            .iter()
            .map(|t| c.shares(&c.stakes[t]))
            .map(|s| s.closed + s.running)
            .sum()
    }

    // Every unit the books place somewhere. It is what was received, less the rounding left in the contract.
    fn held(c: &CouncilContract) -> u128 {
        c.total_paid
            + c.pending_claims_total
            + c.accrued_total
            + c.pending_total_slots
            + c.cut_pool
            + c.carry
            + live_earnings(c)
    }

    #[test]
    fn with_round_numbers_every_unit_is_in_exactly_one_place() {
        let mut c = council();
        for (token, owner) in [("1", "a.near"), ("2", "b.near"), ("3", "c.near"), ("4", "l.near")] {
            stake(&mut c, token, owner);
        }
        set_time(day(1));
        revenue(&mut c, 1, 1_200);
        assert_eq!(held(&c), 1_200);
        set_time(day(2));
        request(&mut c, "4", "l.near");
        assert_eq!(held(&c), 1_200);
        set_time(day(3));
        revenue(&mut c, 2, 600);
        assert_eq!(held(&c), 1_800);
        close_quarter(&mut c);
        assert_eq!(held(&c), 1_800);
        let (id, paid) = claim_without_reply(&mut c, "a.near", &["1"]);
        assert_eq!((paid, held(&c)), (550, 1_800));
        act_as("council.near");
        c.on_claim_paid(U64(id), Ok(()));
        assert_eq!(held(&c), 1_800);
        claim(&mut c, "l.near", &[]);
        assert_eq!((held(&c), c.total_paid), (1_800, 700));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // Stakes, unstake requests, unstakes, sweeps, draws, releases with silent jurors and claims that pay or fail, in any
        // order over weeks and quarters. What was paid, what is in flight, what accounts are owed, what the cut pool and
        // the carry hold and what live seats earned never add up to more than was received, and fall short of it only by
        // rounding: a unit or two for each settlement, and the split remainder. Every claim pays what claimable_of said.
        #[test]
        fn every_unit_received_is_placed_once_and_never_more(
            ops in proptest::collection::vec((0u8..9, 0u32..6, 0u32..3, 1u64..5_000), 1..80)
        ) {
            let mut c = council();
            let (mut sent, mut sweep, mut case, mut slack) = (0u128, 0u64, 0u64, 12u128);
            let mut open_cases: Vec<(u64, Vec<AccountId>)> = vec![];
            for (op, token, owner, amount) in ops {
                let (name, who) = (token.to_string(), format!("o{owner}.near"));
                let seat = c.stake_of(name.clone());
                slack += 8;
                match op {
                    0 if seat.is_none() && c.unstakes_in_flight == 0 => stake(&mut c, &name, &who),
                    1 => {
                        sweep += 1;
                        let paid_in = u128::from(amount) * 7_919;
                        revenue(&mut c, sweep, paid_in);
                        sent += paid_in;
                    }
                    2 => {
                        set_time(now() + amount % 40 * DAY + 1);
                        advance(&mut c);
                    }
                    3 if seat.as_ref().is_some_and(|s| s.serving.is_none() && s.unlock_requested_at.is_none()) => {
                        request(&mut c, &name, seat.unwrap().owner.as_str());
                    }
                    4 if seat.as_ref().is_some_and(|s| s.unlock_requested_at.is_some()) => {
                        let s = seat.unwrap();
                        act_at(s.owner.as_str(), now().max(s.unlock_requested_at.unwrap().0 + COOLDOWN_NS));
                        let _ = c.unstake(name.clone());
                        act_as("council.near");
                        let result = if amount % 2 == 0 { Ok(()) } else { Err(PromiseError::Failed) };
                        c.on_unstaked(name, s, result);
                    }
                    5 if c.seat_count() >= 2 => {
                        act_with_seed(ORACLE, amount as u8);
                        let n = 1 + (amount % 2) as u32;
                        if let Ok(jury) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.draw(U64(case), n, vec![]))) {
                            open_cases.push((case, jury));
                            case += 1;
                        }
                    }
                    6 if !open_cases.is_empty() => {
                        let (id, jury) = open_cases.remove(amount as usize % open_cases.len());
                        let silent: Vec<AccountId> = jury.iter().enumerate().filter(|(i, _)| (amount >> i) & 1 == 1).map(|(_, a)| a.clone()).collect();
                        act_as(ORACLE);
                        c.unlock_case(U64(id), silent);
                    }
                    7 | 8 => {
                        let owed = claimable(&c, &who);
                        if owed > 0 {
                            let tokens = c.seats_of(acct(&who));
                            let refs: Vec<&str> = tokens.iter().map(String::as_str).collect();
                            let paid_before = c.total_paid;
                            let (id, got) = claim_without_reply(&mut c, &who, &refs);
                            prop_assert_eq!(got, owed, "the claim pays what the ledger said");
                            let (args, _, _) = mt_transfer_of(&near_sdk::test_utils::get_created_receipts()[0]);
                            prop_assert_eq!(args["amount"].clone(), json!(got.to_string()));
                            act_as("council.near");
                            c.on_claim_paid(U64(id), if op == 7 { Ok(()) } else { Err(PromiseError::Failed) });
                            let want = if op == 7 { paid_before + got } else { paid_before };
                            prop_assert_eq!(c.total_paid, want);
                        }
                    }
                    _ => {}
                }
                let owed_total: u128 = (0..3).map(|o| c.accrued.get(&acct(&format!("o{o}.near"))).copied().unwrap_or(0)).sum();
                prop_assert_eq!(owed_total, c.accrued_total);
                let slots: u128 = (0..3).map(|o| c.pending.get(&acct(&format!("o{o}.near"))).map_or(0, |p| p.amount)).sum();
                prop_assert_eq!(slots, c.pending_total_slots);
                prop_assert_eq!(c.total_received, sent);
                let held = held(&c);
                prop_assert!(held <= c.total_received, "{} held of {} received", held, c.total_received);
                let dust = c.total_received - held;
                prop_assert!(dust <= slack, "{} lost to rounding, allowed {}", dust, slack);
            }
        }
    }

    // ---- migration from version 5 ------------------------------------------------------------------------------

    fn write_v5_stake(token: &str, old: StakeV1) {
        let key = [bytes_of(&Key::Stakes), bytes_of(&token.to_string())].concat();
        env::storage_write(&key, &[vec![0u8], bytes_of(&old)].concat());
    }

    fn v5_stake(owner: &str, index: u32, unlock: Option<u64>, serving: Option<u64>) -> StakeV1 {
        StakeV1 {
            owner: acct(owner),
            staked_at: U64(START),
            unlock_requested_at: unlock.map(U64),
            serving: serving.map(U64),
            booked_to: U64(START),
            serving_from: START,
            index,
        }
    }

    // A version 5 contract with three seats: 1 earning, 2 asking to leave and 3 serving on case 9. It received 1,000, paid
    // 400 of the 500 in finalized quarters (one, the quarter before the running one), and 500 is in quarters still open.
    fn version_five(adjust: impl FnOnce(&mut StateV5)) -> CouncilContract {
        let mut c = council();
        for (token, owner) in [("1", "a.near"), ("2", "b.near"), ("3", "c.near")] {
            stake(&mut c, token, owner);
        }
        c.juries.insert(9, vec!["3".to_string()]);
        c.stakes.flush();
        let mut quarters = LookupMap::new(b"q5".to_vec());
        quarters.insert(Q4_2026 - 1, ());
        write_v5_stake("1", v5_stake("a.near", 0, None, None));
        write_v5_stake("2", v5_stake("b.near", 1, Some(START + 1), None));
        write_v5_stake("3", v5_stake("c.near", 2, None, Some(9)));
        let mut old = StateV5 {
            state_version: 5,
            upgrade_proven: false,
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
            open_juries: BTreeMap::from([(START, 1)]),
            earning: 2,
            close_grace_ns: 7 * DAY,
            reconcile_wait_ns: c.reconcile_wait_ns,
            last_tick: START,
            next_to_finalize: 8_107,
            quarters,
            seat_weight: LookupMap::new(b"w5".to_vec()),
            forfeits: LookupMap::new(b"f5".to_vec()),
            claims: LookupMap::new(b"c5".to_vec()),
            received: c.received,
            total_received: 1_000,
            total_paid: 400,
            pending_total: 0,
            open_pool: 500,
            final_pool: 500,
            rolled_total: 0,
            unstakes_in_flight: 0,
            fresh: 1,
            rule_from_quarter: 8_107,
        };
        adjust(&mut old);
        env::state_write(&old);
        drop(old);
        testing_env!(context("alice.near").build());
        CouncilContract::migrate()
    }

    #[test]
    fn migrate_moves_version_five_to_six_keeps_the_seats_and_carries_the_open_revenue() {
        let mut c = version_five(|_| {});
        let today = START / DAY;
        assert_eq!(
            (c.state_version, c.upgrade_proven, c.upgrade_in_flight),
            (6, true, false)
        );
        assert_eq!(c.seat_count(), 3);
        assert_eq!(
            (c.carry, c.active, c.last_day),
            (600, 0, today),
            "open revenue and the dust wait for the seats"
        );
        assert_eq!(c.joins_on.get(&(today + 1)).copied(), Some(2));
        assert_eq!(
            (
                c.cut_pool,
                c.accrued_total,
                c.pending_total_slots,
                c.pending_claims_total
            ),
            (0, 0, 0, 0)
        );
        assert_eq!(
            (c.last_closed_quarter, c.quarter_acc.get(&(Q4_2026 - 1)).copied()),
            (Q4_2026 - 1, Some(0)),
            "the quarter before the running one is closed at zero"
        );
        let first = c.stake_of("1".into()).unwrap();
        assert_eq!((first.owner, first.earn_from_day.0), (acct("a.near"), today + 1));
        let leaver = c.stake_of("2".into()).unwrap();
        assert!(leaver.unlock_requested_at.is_some());
        assert_eq!(
            leaver.earn_from_day.0,
            u64::MAX,
            "a seat that asked to leave never earns"
        );
        assert_eq!(c.seat_earnings("3".into()).unwrap().state, SeatState::Serving);
        set_time(day(1));
        revenue(&mut c, 1, 300);
        assert_eq!(
            (earned(&c, "a.near"), earned(&c, "b.near"), earned(&c, "c.near")),
            (450, 0, 450)
        );
        act_as(ORACLE);
        c.unlock_case(U64(9), vec![]);
        act_paid("b.near");
        let _ = c.unstake("2".into());
        assert_eq!(
            c.seat_count(),
            2,
            "the seat that asked to leave in version 5 still leaves"
        );
    }

    #[test]
    fn migrate_refuses_while_a_finalized_quarter_has_money_to_claim() {
        for (adjust, why) in [
            (
                (|s: &mut StateV5| s.final_pool = 1_500) as fn(&mut StateV5),
                "a finalized quarter still has money to claim, claim it before upgrading",
            ),
            (
                |s: &mut StateV5| {
                    s.pending_total = 50;
                    s.total_paid = 350;
                },
                "a claim is still pending, settle it before upgrading",
            ),
            (
                |s: &mut StateV5| s.unstakes_in_flight = 1,
                "an unstake is still waiting for its NFT transfer",
            ),
        ] {
            assert_eq!(refusal(|| drop(version_five(adjust))), why);
        }
    }

    #[test]
    fn migrate_refuses_while_a_finished_quarter_is_not_finalized() {
        assert_eq!(
            refusal(|| drop(version_five(|s| s.next_to_finalize = Q4_2026 - 1))),
            "a finished quarter is not finalized yet, finalize it and let its holders claim before upgrading"
        );
    }

    #[test]
    fn migrate_allows_a_rounding_leftover_for_each_finalized_quarter() {
        let c = version_five(|s| {
            s.quarters.insert(Q4_2026 - 2, ());
            s.final_pool = 1_900;
        });
        assert_eq!(
            c.carry, 2_000,
            "1,500 left in two quarters' pools wait with the open 500"
        );
        let why = "a finalized quarter still has money to claim, claim it before upgrading";
        assert_eq!(refusal(|| drop(version_five(|s| s.final_pool = 1_900))), why);
        assert_eq!(
            refusal(|| drop(version_five(|s| {
                s.quarters.insert(Q4_2026 - 2, ());
                s.final_pool = 2_401;
            }))),
            why
        );
    }

    #[test]
    fn a_version_five_seat_record_costs_one_read_of_the_migrated_day_for_the_whole_call() {
        let c = version_five(|_| {});
        let start_day = START / DAY + 1;
        assert_eq!(c.stake_of("1".into()).unwrap().earn_from_day.0, start_day);
        env::storage_remove(MIGRATED_DAY_KEY);
        assert_eq!(
            c.stake_of("3".into()).unwrap().earn_from_day.0,
            start_day,
            "the second record did not read the day again"
        );
    }

    #[test]
    fn the_version_six_layout_starts_with_the_version_bytes() {
        let bytes = bytes_of(&council());
        assert_eq!(&bytes[..2], STATE_VERSION.to_le_bytes().as_slice());
        assert_eq!(STATE_VERSION, 6);
    }

    #[test]
    fn a_new_council_starts_at_the_current_state_version() {
        assert_eq!(council().state_version, STATE_VERSION);
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
            earn_from_day: U64(6),
            settled_acc: 7,
            forfeited: 4,
            serving_acc: 8,
            index: 2,
        }
    }

    fn sample_claim() -> Claim {
        Claim {
            account: acct("a.near"),
            amount: 5,
            tokens: vec!["1".into()],
            requested_at: 1,
        }
    }

    fn sample_received() -> Received {
        Received { amount: 9, at: 3 }
    }

    fn sample_pending() -> Pending {
        Pending {
            quarter: Q4_2026,
            amount: 6,
        }
    }

    macro_rules! tagged_round_trip {
        ($wrapper:ident, $value:expr, $tag:expr) => {{
            let value = $value;
            let bytes = bytes_of(&$wrapper::current(value.clone()));
            assert_eq!(bytes[0], $tag, stringify!($wrapper));
            assert_eq!(&bytes[1..], bytes_of(&value).as_slice(), stringify!($wrapper));
            assert_eq!(bytes_of(&$wrapper::try_from_slice(&bytes).unwrap()), bytes);
            let mut newer = bytes;
            newer[0] = $tag + 1;
            let message = refusal(|| {
                let _ = $wrapper::try_from_slice(&newer);
            });
            assert!(message.contains("newer version than this code can read"), "{message}");
        }};
    }

    #[test]
    fn every_stored_record_carries_its_version_tag_round_trips_and_refuses_a_newer_one() {
        tagged_round_trip!(VersionedStake, sample_stake(), 1);
        tagged_round_trip!(VersionedClaim, sample_claim(), 0);
        tagged_round_trip!(VersionedReceived, sample_received(), 1);
        tagged_round_trip!(VersionedPending, sample_pending(), 0);
    }

    #[test]
    fn a_version_five_seat_record_reads_with_the_day_migrate_wrote() {
        MIGRATED_DAY.with(|day| day.set(None));
        env::storage_write(MIGRATED_DAY_KEY, &42u64.to_le_bytes());
        let staying = [vec![0u8], bytes_of(&v5_stake("a.near", 3, None, None))].concat();
        let read = VersionedStake::try_from_slice(&staying).unwrap().into_inner();
        assert_eq!((read.earn_from_day.0, read.index, read.forfeited), (43, 3, 0));
        let leaving = [vec![0u8], bytes_of(&v5_stake("a.near", 3, Some(1), None))].concat();
        let read = VersionedStake::try_from_slice(&leaving).unwrap().into_inner();
        assert_eq!(read.earn_from_day.0, u64::MAX);
    }

    #[test]
    fn a_new_council_has_the_quarter_before_the_running_one_closed() {
        let c = council();
        assert_eq!(c.last_closed_quarter, Q4_2026 - 1);
        assert_eq!(c.quarter_acc.get(&(Q4_2026 - 1)).copied(), Some(0));
    }

    #[test]
    fn a_version_five_received_record_reads_without_its_quarter() {
        let old = [vec![0u8], bytes_of(&(9u128, 8_107u32, 3u64))].concat();
        let read = VersionedReceived::try_from_slice(&old).unwrap().into_inner();
        assert_eq!((read.amount, read.at), (9, 3));
    }

    #[test]
    fn what_the_maps_store_carries_the_version_byte() {
        let mut c = two_markets();
        stake(&mut c, "1", "a.near");
        send_revenue(&mut c, MARKET2, 1, 100);
        c.stakes.flush();
        c.received.flush();
        let stored = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let want = [
            bytes_of(&VersionedStake::current(c.stake_of("1".into()).unwrap())),
            bytes_of(&VersionedReceived::current(Received { amount: 100, at: START })),
        ];
        for bytes in want {
            assert_eq!(bytes[0], 1);
            assert!(
                stored.values().any(|v| *v == bytes),
                "a record is stored as the tagged bytes"
            );
        }
    }
}
