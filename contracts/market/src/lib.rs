// Binary prediction market with built-in dynamic parimutuel pricing (the pitch test).
// One owner creates markets. Users hold shares inside this contract.
// A separate oracle contract decides outcomes and is the only caller of set_outcome.
// The JSON interface takes one argument per field, so a few methods are long on purpose.
#![allow(clippy::too_many_arguments)]

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue, PublicKey,
};

// Each account pays this once. It covers a balance entry plus MAX_POSITIONS entries
// (about 100 bytes each at 1 NEAR per 100 KB), so spam accounts cannot drain the contract's storage.
const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(50);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_REMOVE_VERIFIER_KEY: Gas = Gas::from_tgas(15);
// ponytail: flat 0.05 NEAR deposit and a position cap instead of per-byte storage accounting; revisit if users need more positions.
// The cap starts at this and the owner can move it within the hard range. The deposit above covers 30 entries for the longest
// account id, so the range stops there, and 5 keeps an account able to hold a few markets.
const MAX_POSITIONS: u32 = 20;
const HARD_MIN_POSITIONS: u32 = 5;
const HARD_MAX_POSITIONS: u32 = 30;
// Price points kept per market for the chart. Oldest is dropped past this, so storage per market stays bounded.
const HISTORY_MAX: usize = 120;
// Text limits (bytes). Every trade rewrites the whole market record, so unbounded text would make trading expensive.
const MAX_TITLE: usize = 200;
const MAX_RULE: usize = 2000;
const MAX_SOURCE: usize = 300;
const MAX_VOID: usize = 500;
const NS_PER_DAY: u64 = 86_400_000_000_000;
// The oracle answers a market that nobody answered once resolve_by has passed. This much later anyone can void it
// here instead, for the case of an oracle that is gone. 7 days in nanoseconds to start, kept per market.
// The hard range is 1 to 60 days: under a day leaves the oracle no time to answer, over 60 leaves money stuck too long.
const VOID_GRACE_NS: u64 = 7 * NS_PER_DAY;
const HARD_MIN_VOID_GRACE_NS: u64 = NS_PER_DAY;
const HARD_MAX_VOID_GRACE_NS: u64 = 60 * NS_PER_DAY;
// The fee on a trade is the rate times the collateral it moves. It starts at this value and the owner (the DAO) can
// change it, but never above the ceiling. The ceiling starts at the value below and the owner can move it, but only
// within the hard limit, so that even a captured owner cannot set a confiscatory fee and a bad vote cannot lift it
// without bound.
const DEFAULT_FEE_RATE_BPS: u128 = 200;
const MAX_FEE_RATE_BPS: u128 = 500;
const HARD_MAX_FEE_RATE_BPS: u128 = 2_000;
// Fees are split between the Council (revenue) and the treasury in basis points of 10,000. The accepted decision is 25% to the
// Council and 75% to the treasury, so 2,500 is the starting share, and the owner can move it between the two bounds. The
// treasury always gets the rest, so the whole of every fee is accounted for whatever the owner sets.
const BPS_DENOMINATOR: u128 = 10_000;
const DEFAULT_REVENUE_SHARE_BPS: u128 = 2_500;
const MIN_REVENUE_SHARE_BPS: u128 = 1_000;
const MAX_REVENUE_SHARE_BPS: u128 = 5_000;
// The floor cannot go under 5% and the ceiling cannot go over 90%, so neither the Council nor the treasury can be cut out.
const HARD_MIN_REVENUE_SHARE_BPS: u128 = 500;
const HARD_MAX_REVENUE_SHARE_BPS: u128 = 9_000;
// A sweep with less than this to act on does nothing, so the record count stays bounded by the fees collected. 1 unit of the
// 6-decimal collateral to start, with a ceiling of 100.
const DEFAULT_MIN_SWEEP: u128 = 1_000_000;
const MAX_MIN_SWEEP: u128 = 100_000_000;
const HARD_MAX_MIN_SWEEP: u128 = 1_000_000_000;
const FIRST_SWEEP_ID: u64 = 1;
const FIRST_WITHDRAWAL_ID: u64 = 1;
// How long after a sweep its result can be asked for (settle_leg) or overridden by the owner (reconcile_leg). The first lets
// the Council's receipt finish whatever it is doing, the second leaves a callback an hour to arrive before a person decides.
const NS_PER_MINUTE: u64 = 60 * 1_000_000_000;
// Both start at these and the owner can move them live. The hard ranges: settle 1 minute to a day, reconcile 10 minutes to a
// week and never under the settle wait, so settling always comes first.
const SETTLE_WAIT_MINUTES: u64 = 10;
const RECONCILE_WAIT_MINUTES: u64 = 60;
const HARD_MIN_SETTLE_WAIT_MINUTES: u32 = 1;
const HARD_MAX_SETTLE_WAIT_MINUTES: u32 = 1_440;
const HARD_MIN_RECONCILE_WAIT_MINUTES: u32 = 10;
const HARD_MAX_RECONCILE_WAIT_MINUTES: u32 = 10_080;
// The least time between two sweeps. A refused due is retried on purpose, so without this a stranger could sweep it again
// and again, and every sweep keeps a record. At the starting hour this bounds the records at 24 a day whatever the dues do.
// The hard range is one hour to a day: a sweep must stay rate-limited, and must still happen at least daily.
const MIN_SWEEP_INTERVAL_NS: u64 = 60 * NS_PER_MINUTE;
const HARD_MIN_SWEEP_INTERVAL_MINUTES: u32 = 60;
const HARD_MAX_SWEEP_INTERVAL_MINUTES: u32 = 1_440;
// The verifier burned 3.8 TGas for a payout from a contract in the sandbox (INTENTS-PROOF.md), so this is a wide margin.
const GAS_MT_TRANSFER: Gas = Gas::from_tgas(15);
// mt_transfer_call needs 21 TGas attached before the receiver gets any (measured), so the verifier's own part is rounded up
// to 22 and the rest is what the Council's mt_on_transfer gets.
const GAS_VERIFIER_CALL_OVERHEAD: Gas = Gas::from_tgas(22);
const GAS_COUNCIL_RECEIPT: Gas = Gas::from_tgas(20);
const GAS_MT_TRANSFER_CALL: Gas = Gas::from_gas(GAS_VERIFIER_CALL_OVERHEAD.as_gas() + GAS_COUNCIL_RECEIPT.as_gas());
const GAS_REGISTER: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FT_FORWARD: Gas = Gas::from_tgas(50);
const GAS_BUY: Gas = Gas::from_tgas(10);
const GAS_ON_FORWARDED: Gas = Gas::from_gas(GAS_CALLBACK.as_gas() + GAS_BUY.as_gas());
const GAS_FORWARD_OVERHEAD: Gas = Gas::from_tgas(5);
const GAS_FORWARD_FLOOR: Gas =
    Gas::from_gas(GAS_FT_FORWARD.as_gas() + GAS_ON_FORWARDED.as_gas() + GAS_FORWARD_OVERHEAD.as_gas());
// A sweep sends the Council's part with its callback and the treasury's part with its callback, and burns about 3
// TGas itself.
const GAS_SWEEP_OVERHEAD: Gas = Gas::from_tgas(10);
const GAS_SWEEP_FLOOR: Gas = Gas::from_gas(
    GAS_MT_TRANSFER_CALL.as_gas() + GAS_MT_TRANSFER.as_gas() + 2 * GAS_CALLBACK.as_gas() + GAS_SWEEP_OVERHEAD.as_gas(),
);
// settle_leg asks the Council one view and reads the answer in a callback.
const GAS_COUNCIL_VIEW: Gas = Gas::from_tgas(10);
const GAS_SETTLE_FLOOR: Gas =
    Gas::from_gas(GAS_COUNCIL_VIEW.as_gas() + GAS_CALLBACK.as_gas() + GAS_SWEEP_OVERHEAD.as_gas());
// Token ids in the verifier are exactly "nep141:<contract>". Anything else would never match a transfer.
const NEP141_PREFIX: &str = "nep141:";
// Root layout version. Migration reads the exact current root or the one before. Version 2 added the sweep ledger and
// optional recipients; version 3 tagged stored records; version 4 adds storage policy and operational position paging.
const STATE_VERSION: u16 = 8;
// What one market can hold at most, in the collateral's smallest unit: 10,000 at 6 decimals by default for a new contract, and
// never above what the pricing math accepts. A contract migrated from before keeps the 100,000 it was running with.
const DEFAULT_MAX_MARKET_LOCKED: u128 = 10_000_000_000;
const LEGACY_MAX_MARKET_LOCKED: u128 = 100_000_000_000;
// How long a halt stops new buys before it lapses on its own. The owner extends it by halting again and lifts it with resume.
const HALT_DURATION_NS: u64 = 24 * 3_600 * 1_000_000_000;
const HARD_MIN_MARKET_LOCKED: u128 = 1_000_000;
// Pages bound scanned market ids, including ids without a holding.
const POSITION_PAGE_DEFAULT: u64 = 50;
const POSITION_PAGE_MAX: u64 = 100;
// Measured by measure_maximum_market_record_storage, including its key and record overhead.
#[cfg(test)]
const MAX_MARKET_STORAGE_BYTES: u64 = 4_775;
const DEFAULT_MARKET_STORAGE_DEPOSIT: u128 = 47_750_000_000_000_000_000_000;
// Never below the complete maximum record; at most half a NEAR per new market.
const HARD_MIN_MARKET_STORAGE_DEPOSIT: u128 = 47_750_000_000_000_000_000_000;
const HARD_MAX_MARKET_STORAGE_DEPOSIT: u128 = 500_000_000_000_000_000_000_000;
const DEFAULT_STORAGE_RESERVE: u128 = 1_000_000_000_000_000_000_000_000;
// Reserve is available to exits, not new entries: at least 0.1 NEAR, at most 100 NEAR.
const HARD_MIN_STORAGE_RESERVE: u128 = 100_000_000_000_000_000_000_000;
const HARD_MAX_STORAGE_RESERVE: u128 = 100_000_000_000_000_000_000_000_000;
const DEFAULT_REGISTRATION_FEE: u128 = 250_000;
const HARD_MIN_REGISTRATION_FEE: u128 = 10_000;
const HARD_MAX_REGISTRATION_FEE: u128 = 2_000_000;

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Markets,
    Balances,
    Accounts,
    Shares,
    Sweeps,
    Withdrawals,
    PendingByAccount,
    PositionMarkets,
    ExemptAccounts,
    PositionCounts,
    Registrations,
    Costs,
    MarketCaps,
    HaltUntil,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Yes,
    No,
    Void,
}

// How a price market is answered, fixed when it is created and locked into the rule hash. Publishers sign the price at
// observation_time; the oracle compares it with strike. Yes if the price is at or above strike when `above` is
// true, Yes if it is below strike otherwise. strike and the signed price are integers scaled by 10^decimals.
#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PriceRule {
    observation_time: U64,
    strike: U128,
    decimals: u8,
    above: bool,
}

#[near(serializers=[borsh])]
#[derive(Clone)]
pub struct Market {
    title: String,
    rule_text: String,
    resolution_source: String,
    void_policy: String,
    // Short lowercase slugs like "sports" and "nfl". The website owns the list of known ones.
    category: String,
    subcategory: String,
    rule_hash: String,
    price_rule: Option<PriceRule>,
    close_at: u64,
    resolve_by: u64,
    // The void rules in force when the market was created. Changing the rules later does not touch a market that exists.
    void_grace_ns: u64,
    halted: bool,
    registered: bool,
    outcome: Option<Outcome>,
    refunds: bool,
    locked: u128,
    user_yes: u128,
    user_no: u128,
    claims: u128,
    // (block time in ns, Yes price in millionths) after each buy and sell. For the chart only.
    history: Vec<(u64, u32)>,
    holders: u32,
    pruned: bool,
}

// A withdrawal whose transfer has been sent and whose callback has not reported. It stays owed until the verifier confirms it.
#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Withdrawal {
    account: AccountId,
    amount: U128,
    at: U64,
}

// Each stored record sits behind a one-byte version tag, so a later layout can be read next to this one and upgraded as it
// is loaded. Reads go through into_current and every write stores the newest variant. A tag nobody wrote yet fails to
// decode, which stops the read instead of misreading the bytes.
#[near(serializers=[borsh])]
#[derive(Clone)]
enum VersionedMarket {
    V1(Market),
}

impl VersionedMarket {
    fn into_current(self) -> Market {
        match self {
            Self::V1(m) => m,
        }
    }
}

impl From<Market> for VersionedMarket {
    fn from(m: Market) -> Self {
        Self::V1(m)
    }
}

#[near(serializers=[borsh])]
#[derive(Clone)]
enum VersionedSweep {
    V1(Sweep),
}

impl VersionedSweep {
    fn into_current(self) -> Sweep {
        match self {
            Self::V1(s) => s,
        }
    }
}

impl From<Sweep> for VersionedSweep {
    fn from(s: Sweep) -> Self {
        Self::V1(s)
    }
}

#[near(serializers=[borsh])]
#[derive(Clone)]
enum VersionedWithdrawal {
    V1(Withdrawal),
}

impl VersionedWithdrawal {
    fn into_current(self) -> Withdrawal {
        match self {
            Self::V1(w) => w,
        }
    }
}

impl From<Withdrawal> for VersionedWithdrawal {
    fn from(w: Withdrawal) -> Self {
        Self::V1(w)
    }
}

#[near(serializers=[json])]
pub struct AccountView {
    registered: bool,
    available: U128,
    pending_withdrawals: U128,
    positions: Option<u32>,
}

// Money that has been sent and not yet reported: withdrawals, and fee legs that are pending or unresolved.
#[near(serializers=[json])]
pub struct InFlightView {
    withdrawals: U128,
    withdrawal_count: u32,
    legs: U128,
    leg_count: u32,
}

// The buckets total_owed adds, and their sum.
#[near(serializers=[json])]
pub struct OwedView {
    balances: U128,
    locked: U128,
    fees: U128,
    revenue_due: U128,
    treasury_due: U128,
    unresolved: U128,
    pending_withdrawals: U128,
    total: U128,
}

#[near(serializers=[json])]
pub struct MarketView {
    id: U64,
    title: String,
    rule_text: String,
    resolution_source: String,
    void_policy: String,
    category: String,
    subcategory: String,
    rule_hash: String,
    price_rule: Option<PriceRule>,
    close_at: U64,
    resolve_by: U64,
    // resolved, halted, closed, then unregistered while the oracle has not confirmed the market, and open once it can
    // be traded.
    status: String,
    registered: bool,
    outcome: Option<Outcome>,
    refunds: bool,
    price_yes: U128,
    price_no: U128,
    yes_shares: U128,
    no_shares: U128,
    locked: U128,
    holders: u32,
    pruned: bool,
}

// One market in which an account holds shares. redeemable is what redeem would credit now, 0 until the market resolves.
#[near(serializers=[json])]
pub struct PositionView {
    market_id: U64,
    yes: U128,
    no: U128,
    status: String,
    outcome: Option<Outcome>,
    redeemable: U128,
}

#[near(serializers=[json])]
pub struct PricePoint {
    at: U64,
    price_yes: u32,
}

#[near(serializers=[json])]
pub struct BuyQuote {
    shares_out: U128,
    fee: U128,
}

// collateral_out is what leaves the pool; the seller receives collateral_out minus fee.
#[near(serializers=[json])]
pub struct SellQuote {
    collateral_out: U128,
    shares_in: U128,
    fee: U128,
}

// Where a fee leg stands. A leg is pending from the moment its transfer is sent until the callback reports. Settled means the
// recipient has the money. Refused means the verifier gave it back, so it is due again. Unresolved means no usable report came
// and nobody can tell where the money is: only the Council leg can be, because only it is a transfer call.
#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LegStatus {
    Pending,
    Settled,
    Refused,
    Unresolved,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LegKind {
    Council,
    Treasury,
}

// One of the two payments of a sweep: who it went to, how much, and how it ended. `amount` is the leg's share of the sweep plus
// whatever earlier refused legs left due.
#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Leg {
    to: AccountId,
    amount: U128,
    status: LegStatus,
}

// What a sweep did. Both legs are written here before either transfer is sent, so each is accounted for whatever the other does.
#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Sweep {
    id: U64,
    at: U64,
    // The part of `fees` this sweep split. Rounding leaves up to one unit of it in `fees`.
    total: U128,
    carried_council: U128,
    carried_treasury: U128,
    council: Leg,
    treasury: Leg,
}

impl Sweep {
    fn leg(&self, kind: LegKind) -> &Leg {
        match kind {
            LegKind::Council => &self.council,
            LegKind::Treasury => &self.treasury,
        }
    }

    fn leg_mut(&mut self, kind: LegKind) -> &mut Leg {
        match kind {
            LegKind::Council => &mut self.council,
            LegKind::Treasury => &mut self.treasury,
        }
    }
}

// The two accounts fees go to. Both are set together by the owner, and a sweep refuses until they are.
#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct FeeRecipients {
    revenue_pool: AccountId,
    treasury: AccountId,
}

// What the Council answers when asked about a sweep it took in.
#[near(serializers=[json])]
pub struct CouncilReceipt {
    amount: U128,
}

// The NEAR Intents verifier. All the backing sits in this contract's own account there, and it pays out by calling these.
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
    fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

#[ext_contract(ext_oracle)]
pub trait Oracle {
    fn register_market(
        &mut self,
        market_id: U64,
        close_at: U64,
        resolve_by: U64,
        rule_hash: String,
        price_rule: Option<PriceRule>,
    );
}

// What the Council recorded for a market's sweep id is the evidence settle_leg uses for a transfer whose result was lost.
#[ext_contract(ext_council)]
pub trait Council {
    fn received_of(&self, market: AccountId, sweep_id: U64);
}

#[near(serializers=[json])]
#[serde(rename_all = "lowercase")]
pub enum Arrival {
    Deposit,
    Buy { market_id: U64, side: u8, min_shares: U128 },
}

#[near(
    contract_state,
    contract_metadata(
        standard(standard = "nep145", version = "1.0.0"),
        standard(standard = "nep297", version = "1.0.0"),
    )
)]
#[derive(PanicOnDefault)]
pub struct MarketContract {
    // First, so migrate can read it before it trusts the rest of the layout.
    state_version: u16,
    // Set by migrate, so it is true only once an upgrade has gone through. seal refuses until then.
    upgrade_proven: bool,
    // Set by upgrade just before it sends the deploy and migrate batch, cleared by migrate. migrate refuses to run when it
    // is not set, so the proof cannot come from calling migrate by hand. A batch that fails leaves it set in the old code,
    // and the next upgrade sets it again.
    upgrade_in_flight: bool,
    // Only the owner can change the operator, add a fee recipient, or hand off ownership. Everything else
    // routine (create a market, pause, halt, claim a residual) also takes the operator, so day to
    // day running does not need to wait on a DAO proposal.
    owner: AccountId,
    // Set by propose_owner. Ownership moves only when this account calls accept_owner.
    pending_owner: Option<AccountId>,
    operator: AccountId,
    oracle: AccountId,
    // The Intents verifier that holds every unit of backing, and the exact id of the collateral in it, "nep141:<token>".
    verifier: AccountId,
    collateral_token_id: String,
    // Blocks buy, deposit and new markets. The operator can set it. It never blocks sell, withdraw or redeem.
    paused: bool,
    // Blocks sell. Owner only, so the operator cannot trap open positions.
    sells_paused: bool,
    // What a trade pays now. It applies from the next trade; nothing already paid changes.
    fee_rate_bps: u128,
    // The ceilings and floors the fee setters check against, and the other policy values the owner can tune. Each starts at
    // the number the contract was built with and moves only within a hard range.
    max_fee_rate_bps: u128,
    min_revenue_share_bps: u128,
    max_revenue_share_bps: u128,
    max_min_sweep: u128,
    max_positions: u32,
    // Applied to markets created from now on, and copied onto each.
    void_grace_ns: u64,
    settle_wait_minutes: u32,
    reconcile_wait_minutes: u32,
    min_sweep_interval_minutes: u32,
    next_market_id: u64,
    markets: LookupMap<u64, VersionedMarket>,
    balances: LookupMap<AccountId, u128>,
    // The sum of every entry in balances, kept so total_owed can add it up without walking a map.
    balances_total: u128,
    // account -> number of share entries and cost records it holds. Presence means the account paid its storage deposit.
    accounts: LookupMap<AccountId, u32>,
    // (market, account, 0 = yes / 1 = no) -> shares
    shares: LookupMap<(u64, AccountId, u8), u128>,
    costs: LookupMap<(u64, AccountId), i128>,
    // account -> the market ids, sorted and without repeats, in which it holds a non-empty share entry on either side. Kept
    // only by add_shares and take_shares, and absent when empty. An account that holds one position in every market, as
    // the operator and the owner can, has one record of 8 bytes a market that a trade rewrites whole.
    position_markets: LookupMap<AccountId, Vec<u64>>,
    // The Council, which shares its part among staked seats, and the treasury. None until the owner sets them, and a sweep
    // refuses until then, so nothing is sent to an account nobody chose.
    recipients: Option<FeeRecipients>,
    // The Council's share of a sweep in basis points. The treasury gets the rest.
    revenue_share_bps: u128,
    // Collected fees, outside every market's collateral. A sweep splits them into the two dues below and sends
    // those; a transfer that fails goes back to its own due, so one bad recipient never shifts money to the other. A
    // revenue transfer whose result is lost goes to revenue_unresolved below instead.
    fees: u128,
    revenue_due: u128,
    treasury_due: u128,
    // Revenue sent to the Council whose result never came back. The token moves the amount before it reports, so a
    // failed report may mean it arrived. It is neither due nor settled until settle_leg has read the Council's own record
    // of the sweep, or the owner has decided with reconcile_leg.
    revenue_unresolved: u128,
    // The sum of every market's `locked`, kept so total_owed does not walk the markets.
    locked_total: u128,
    // The least a sweep acts on, and the id the next sweep takes. Ids only go up, and the Council refuses a repeat.
    min_sweep: u128,
    next_sweep_id: u64,
    // When the last sweep ran, in ns. None until the first one.
    last_sweep_at: Option<u64>,
    sweeps: LookupMap<u64, VersionedSweep>,
    // The sum and number of fee legs that are pending or unresolved, kept so in_flight does not walk the sweeps.
    legs_in_flight_total: u128,
    legs_in_flight_count: u32,
    // Withdrawals sent and not yet reported, by id. Ids start at 1 and only go up. The total is part of total_owed: the money
    // is still owed until the verifier confirms it, and a callback that never reports leaves it here, in view.
    next_withdrawal_id: u64,
    withdrawals: LookupMap<u64, VersionedWithdrawal>,
    pending_withdrawals_total: u128,
    pending_withdrawal_count: u32,
    // account -> the part of the total that is theirs, so get_account does not walk the withdrawals. Absent when zero.
    pending_by_account: LookupMap<AccountId, u128>,
    // Retained after a role handover so old positions remain pageable.
    exempt_accounts: LookupMap<AccountId, bool>,
    // Missing only for an upgraded legacy exempt account.
    position_counts: LookupMap<AccountId, u32>,
    market_storage_deposit: u128,
    storage_reserve: u128,
    registration_fee: u128,
    registrations: LookupMap<AccountId, Registration>,
    // The most collateral one market can hold, so the oracle's bond stays meaningful against what a wrong answer would move.
    // The operator can set a lower cap for a single market; nothing sets one above this.
    max_market_locked: u128,
    market_caps: LookupMap<u64, u128>,
    // market -> when its halt lapses, in ns. Kept after the halt ends, so the operator cannot halt the same market again; the
    // owner's resume deletes it.
    halt_until: LookupMap<u64, u64>,
}

// Exact layout of state version 6, which had no market caps.
// Exact layout of state version 7, which had no halt expiry.
#[near(serializers=[borsh])]
struct StateV7 {
    state_version: u16,
    upgrade_proven: bool,
    upgrade_in_flight: bool,
    owner: AccountId,
    pending_owner: Option<AccountId>,
    operator: AccountId,
    oracle: AccountId,
    verifier: AccountId,
    collateral_token_id: String,
    paused: bool,
    sells_paused: bool,
    fee_rate_bps: u128,
    max_fee_rate_bps: u128,
    min_revenue_share_bps: u128,
    max_revenue_share_bps: u128,
    max_min_sweep: u128,
    max_positions: u32,
    void_grace_ns: u64,
    settle_wait_minutes: u32,
    reconcile_wait_minutes: u32,
    min_sweep_interval_minutes: u32,
    next_market_id: u64,
    markets: LookupMap<u64, VersionedMarket>,
    balances: LookupMap<AccountId, u128>,
    balances_total: u128,
    accounts: LookupMap<AccountId, u32>,
    shares: LookupMap<(u64, AccountId, u8), u128>,
    costs: LookupMap<(u64, AccountId), i128>,
    position_markets: LookupMap<AccountId, Vec<u64>>,
    recipients: Option<FeeRecipients>,
    revenue_share_bps: u128,
    fees: u128,
    revenue_due: u128,
    treasury_due: u128,
    revenue_unresolved: u128,
    locked_total: u128,
    min_sweep: u128,
    next_sweep_id: u64,
    last_sweep_at: Option<u64>,
    sweeps: LookupMap<u64, VersionedSweep>,
    legs_in_flight_total: u128,
    legs_in_flight_count: u32,
    next_withdrawal_id: u64,
    withdrawals: LookupMap<u64, VersionedWithdrawal>,
    pending_withdrawals_total: u128,
    pending_withdrawal_count: u32,
    pending_by_account: LookupMap<AccountId, u128>,
    exempt_accounts: LookupMap<AccountId, bool>,
    position_counts: LookupMap<AccountId, u32>,
    market_storage_deposit: u128,
    storage_reserve: u128,
    registration_fee: u128,
    registrations: LookupMap<AccountId, Registration>,
    max_market_locked: u128,
    market_caps: LookupMap<u64, u128>,
}

#[near(serializers=[borsh])]
struct StateV6 {
    state_version: u16,
    upgrade_proven: bool,
    upgrade_in_flight: bool,
    owner: AccountId,
    pending_owner: Option<AccountId>,
    operator: AccountId,
    oracle: AccountId,
    verifier: AccountId,
    collateral_token_id: String,
    paused: bool,
    sells_paused: bool,
    fee_rate_bps: u128,
    max_fee_rate_bps: u128,
    min_revenue_share_bps: u128,
    max_revenue_share_bps: u128,
    max_min_sweep: u128,
    max_positions: u32,
    void_grace_ns: u64,
    settle_wait_minutes: u32,
    reconcile_wait_minutes: u32,
    min_sweep_interval_minutes: u32,
    next_market_id: u64,
    markets: LookupMap<u64, VersionedMarket>,
    balances: LookupMap<AccountId, u128>,
    balances_total: u128,
    accounts: LookupMap<AccountId, u32>,
    shares: LookupMap<(u64, AccountId, u8), u128>,
    costs: LookupMap<(u64, AccountId), i128>,
    position_markets: LookupMap<AccountId, Vec<u64>>,
    recipients: Option<FeeRecipients>,
    revenue_share_bps: u128,
    fees: u128,
    revenue_due: u128,
    treasury_due: u128,
    revenue_unresolved: u128,
    locked_total: u128,
    min_sweep: u128,
    next_sweep_id: u64,
    last_sweep_at: Option<u64>,
    sweeps: LookupMap<u64, VersionedSweep>,
    legs_in_flight_total: u128,
    legs_in_flight_count: u32,
    next_withdrawal_id: u64,
    withdrawals: LookupMap<u64, VersionedWithdrawal>,
    pending_withdrawals_total: u128,
    pending_withdrawal_count: u32,
    pending_by_account: LookupMap<AccountId, u128>,
    exempt_accounts: LookupMap<AccountId, bool>,
    position_counts: LookupMap<AccountId, u32>,
    market_storage_deposit: u128,
    storage_reserve: u128,
    registration_fee: u128,
    registrations: LookupMap<AccountId, Registration>,
}

impl From<StateV7> for MarketContract {
    fn from(old: StateV7) -> Self {
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: old.upgrade_proven,
            upgrade_in_flight: old.upgrade_in_flight,
            owner: old.owner,
            pending_owner: old.pending_owner,
            operator: old.operator,
            oracle: old.oracle,
            verifier: old.verifier,
            collateral_token_id: old.collateral_token_id,
            paused: old.paused,
            sells_paused: old.sells_paused,
            fee_rate_bps: old.fee_rate_bps,
            max_fee_rate_bps: old.max_fee_rate_bps,
            min_revenue_share_bps: old.min_revenue_share_bps,
            max_revenue_share_bps: old.max_revenue_share_bps,
            max_min_sweep: old.max_min_sweep,
            max_positions: old.max_positions,
            void_grace_ns: old.void_grace_ns,
            settle_wait_minutes: old.settle_wait_minutes,
            reconcile_wait_minutes: old.reconcile_wait_minutes,
            min_sweep_interval_minutes: old.min_sweep_interval_minutes,
            next_market_id: old.next_market_id,
            markets: old.markets,
            balances: old.balances,
            balances_total: old.balances_total,
            accounts: old.accounts,
            shares: old.shares,
            costs: old.costs,
            position_markets: old.position_markets,
            recipients: old.recipients,
            revenue_share_bps: old.revenue_share_bps,
            fees: old.fees,
            revenue_due: old.revenue_due,
            treasury_due: old.treasury_due,
            revenue_unresolved: old.revenue_unresolved,
            locked_total: old.locked_total,
            min_sweep: old.min_sweep,
            next_sweep_id: old.next_sweep_id,
            last_sweep_at: old.last_sweep_at,
            sweeps: old.sweeps,
            legs_in_flight_total: old.legs_in_flight_total,
            legs_in_flight_count: old.legs_in_flight_count,
            next_withdrawal_id: old.next_withdrawal_id,
            withdrawals: old.withdrawals,
            pending_withdrawals_total: old.pending_withdrawals_total,
            pending_withdrawal_count: old.pending_withdrawal_count,
            pending_by_account: old.pending_by_account,
            exempt_accounts: old.exempt_accounts,
            position_counts: old.position_counts,
            market_storage_deposit: old.market_storage_deposit,
            storage_reserve: old.storage_reserve,
            registration_fee: old.registration_fee,
            registrations: old.registrations,
            max_market_locked: old.max_market_locked,
            market_caps: old.market_caps,
            halt_until: LookupMap::new(Key::HaltUntil),
        }
    }
}

impl From<StateV6> for MarketContract {
    fn from(old: StateV6) -> Self {
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: old.upgrade_proven,
            upgrade_in_flight: old.upgrade_in_flight,
            owner: old.owner,
            pending_owner: old.pending_owner,
            operator: old.operator,
            oracle: old.oracle,
            verifier: old.verifier,
            collateral_token_id: old.collateral_token_id,
            paused: old.paused,
            sells_paused: old.sells_paused,
            fee_rate_bps: old.fee_rate_bps,
            max_fee_rate_bps: old.max_fee_rate_bps,
            min_revenue_share_bps: old.min_revenue_share_bps,
            max_revenue_share_bps: old.max_revenue_share_bps,
            max_min_sweep: old.max_min_sweep,
            max_positions: old.max_positions,
            void_grace_ns: old.void_grace_ns,
            settle_wait_minutes: old.settle_wait_minutes,
            reconcile_wait_minutes: old.reconcile_wait_minutes,
            min_sweep_interval_minutes: old.min_sweep_interval_minutes,
            next_market_id: old.next_market_id,
            markets: old.markets,
            balances: old.balances,
            balances_total: old.balances_total,
            accounts: old.accounts,
            shares: old.shares,
            costs: old.costs,
            position_markets: old.position_markets,
            recipients: old.recipients,
            revenue_share_bps: old.revenue_share_bps,
            fees: old.fees,
            revenue_due: old.revenue_due,
            treasury_due: old.treasury_due,
            revenue_unresolved: old.revenue_unresolved,
            locked_total: old.locked_total,
            min_sweep: old.min_sweep,
            next_sweep_id: old.next_sweep_id,
            last_sweep_at: old.last_sweep_at,
            sweeps: old.sweeps,
            legs_in_flight_total: old.legs_in_flight_total,
            legs_in_flight_count: old.legs_in_flight_count,
            next_withdrawal_id: old.next_withdrawal_id,
            withdrawals: old.withdrawals,
            pending_withdrawals_total: old.pending_withdrawals_total,
            pending_withdrawal_count: old.pending_withdrawal_count,
            pending_by_account: old.pending_by_account,
            exempt_accounts: old.exempt_accounts,
            position_counts: old.position_counts,
            market_storage_deposit: old.market_storage_deposit,
            storage_reserve: old.storage_reserve,
            registration_fee: old.registration_fee,
            registrations: old.registrations,
            max_market_locked: LEGACY_MAX_MARKET_LOCKED,
            market_caps: LookupMap::new(Key::MarketCaps),
            halt_until: LookupMap::new(Key::HaltUntil),
        }
    }
}

#[near(serializers=[borsh])]
#[derive(PartialEq, Eq, Debug)]
enum Registration {
    Sponsored { payer: AccountId },
    Collateral,
}

// Exact previous root layout; record tags remain readable.
#[near(serializers=[borsh])]
struct StateV5 {
    state_version: u16,
    upgrade_proven: bool,
    upgrade_in_flight: bool,
    owner: AccountId,
    pending_owner: Option<AccountId>,
    operator: AccountId,
    oracle: AccountId,
    verifier: AccountId,
    collateral_token_id: String,
    paused: bool,
    sells_paused: bool,
    fee_rate_bps: u128,
    create_fee: u128,
    max_fee_rate_bps: u128,
    max_create_fee: u128,
    min_revenue_share_bps: u128,
    max_revenue_share_bps: u128,
    max_min_sweep: u128,
    max_positions: u32,
    min_open_price: u128,
    max_open_price: u128,
    void_price_window_ns: u64,
    void_grace_ns: u64,
    settle_wait_minutes: u32,
    reconcile_wait_minutes: u32,
    min_sweep_interval_minutes: u32,
    next_market_id: u64,
    markets: LookupMap<u64, VersionedMarket>,
    balances: LookupMap<AccountId, u128>,
    balances_total: u128,
    accounts: LookupMap<AccountId, u32>,
    shares: LookupMap<(u64, AccountId, u8), u128>,
    position_markets: LookupMap<AccountId, Vec<u64>>,
    recipients: Option<FeeRecipients>,
    revenue_share_bps: u128,
    fees: u128,
    revenue_due: u128,
    treasury_due: u128,
    revenue_unresolved: u128,
    locked_total: u128,
    min_sweep: u128,
    next_sweep_id: u64,
    last_sweep_at: Option<u64>,
    sweeps: LookupMap<u64, VersionedSweep>,
    legs_in_flight_total: u128,
    legs_in_flight_count: u32,
    next_withdrawal_id: u64,
    withdrawals: LookupMap<u64, VersionedWithdrawal>,
    pending_withdrawals_total: u128,
    pending_withdrawal_count: u32,
    pending_by_account: LookupMap<AccountId, u128>,
    exempt_accounts: LookupMap<AccountId, bool>,
    position_counts: LookupMap<AccountId, u32>,
    market_storage_deposit: u128,
    storage_reserve: u128,
    registration_fee: u128,
    registrations: LookupMap<AccountId, Registration>,
}

impl From<StateV5> for MarketContract {
    fn from(old: StateV5) -> Self {
        require!(
            old.next_market_id == 0,
            "a version 5 market that has created markets cannot move to dynamic parimutuel pricing; deploy this version fresh"
        );
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: old.upgrade_proven,
            upgrade_in_flight: old.upgrade_in_flight,
            owner: old.owner,
            pending_owner: old.pending_owner,
            operator: old.operator,
            oracle: old.oracle,
            verifier: old.verifier,
            collateral_token_id: old.collateral_token_id,
            paused: old.paused,
            sells_paused: old.sells_paused,
            fee_rate_bps: old.fee_rate_bps,
            max_fee_rate_bps: old.max_fee_rate_bps,
            min_revenue_share_bps: old.min_revenue_share_bps,
            max_revenue_share_bps: old.max_revenue_share_bps,
            max_min_sweep: old.max_min_sweep,
            max_positions: old.max_positions,
            void_grace_ns: old.void_grace_ns,
            settle_wait_minutes: old.settle_wait_minutes,
            reconcile_wait_minutes: old.reconcile_wait_minutes,
            min_sweep_interval_minutes: old.min_sweep_interval_minutes,
            next_market_id: old.next_market_id,
            markets: old.markets,
            balances: old.balances,
            balances_total: old.balances_total,
            accounts: old.accounts,
            shares: old.shares,
            costs: LookupMap::new(Key::Costs),
            position_markets: old.position_markets,
            recipients: old.recipients,
            revenue_share_bps: old.revenue_share_bps,
            fees: old.fees,
            revenue_due: old.revenue_due,
            treasury_due: old.treasury_due,
            revenue_unresolved: old.revenue_unresolved,
            locked_total: old.locked_total,
            min_sweep: old.min_sweep,
            next_sweep_id: old.next_sweep_id,
            last_sweep_at: old.last_sweep_at,
            sweeps: old.sweeps,
            legs_in_flight_total: old.legs_in_flight_total,
            legs_in_flight_count: old.legs_in_flight_count,
            next_withdrawal_id: old.next_withdrawal_id,
            withdrawals: old.withdrawals,
            pending_withdrawals_total: old.pending_withdrawals_total,
            pending_withdrawal_count: old.pending_withdrawal_count,
            pending_by_account: old.pending_by_account,
            exempt_accounts: old.exempt_accounts,
            position_counts: old.position_counts,
            market_storage_deposit: old.market_storage_deposit,
            storage_reserve: old.storage_reserve,
            registration_fee: old.registration_fee,
            registrations: old.registrations,
            max_market_locked: LEGACY_MAX_MARKET_LOCKED,
            market_caps: LookupMap::new(Key::MarketCaps),
            halt_until: LookupMap::new(Key::HaltUntil),
        }
    }
}

// The Council's and the treasury's parts of `total`, both rounded down. Together they are `total` less a remainder of 0 or 1
// that belongs to neither: the two exact parts add up to a whole number, so the two lost fractions add up to 0 or 1. The
// remainder stays collected and joins the next sweep.
fn split_fees(total: u128, revenue_share_bps: u128) -> (u128, u128) {
    (
        total * revenue_share_bps / BPS_DENOMINATOR,
        total * (BPS_DENOMINATOR - revenue_share_bps) / BPS_DENOMINATOR,
    )
}

fn positive(net: i128) -> u128 {
    u128::try_from(net).unwrap_or(0)
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "market", "version": "1.0.0", "event": event, "data": data })
    ));
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn side_index(side: &str) -> u8 {
    match side {
        "yes" => 0,
        "no" => 1,
        _ => env::panic_str("side must be yes or no"),
    }
}

fn parse_part<T: std::str::FromStr>(part: Option<&str>, what: &str) -> T {
    part.and_then(|s| s.parse().ok())
        .unwrap_or_else(|| env::panic_str(&format!("bad {what}")))
}

#[near]
impl MarketContract {
    // Only this account can run it, so a deploy and init batch signed by it is the one way in.
    #[private]
    #[init]
    pub fn new(
        owner_id: AccountId,
        operator_id: AccountId,
        oracle_id: AccountId,
        verifier_id: AccountId,
        collateral_token_id: String,
    ) -> Self {
        require!(
            collateral_token_id.starts_with(NEP141_PREFIX),
            "the collateral token id must look like nep141:<token>"
        );
        let mut state = Self {
            state_version: STATE_VERSION,
            upgrade_proven: false,
            upgrade_in_flight: false,
            owner: owner_id.clone(),
            pending_owner: None,
            operator: operator_id.clone(),
            oracle: oracle_id,
            verifier: verifier_id,
            collateral_token_id,
            paused: false,
            sells_paused: false,
            fee_rate_bps: DEFAULT_FEE_RATE_BPS,
            max_fee_rate_bps: MAX_FEE_RATE_BPS,
            min_revenue_share_bps: MIN_REVENUE_SHARE_BPS,
            max_revenue_share_bps: MAX_REVENUE_SHARE_BPS,
            max_min_sweep: MAX_MIN_SWEEP,
            max_positions: MAX_POSITIONS,
            void_grace_ns: VOID_GRACE_NS,
            settle_wait_minutes: SETTLE_WAIT_MINUTES as u32,
            reconcile_wait_minutes: RECONCILE_WAIT_MINUTES as u32,
            min_sweep_interval_minutes: (MIN_SWEEP_INTERVAL_NS / NS_PER_MINUTE) as u32,
            next_market_id: 0,
            markets: LookupMap::new(Key::Markets),
            balances: LookupMap::new(Key::Balances),
            balances_total: 0,
            accounts: LookupMap::new(Key::Accounts),
            shares: LookupMap::new(Key::Shares),
            costs: LookupMap::new(Key::Costs),
            position_markets: LookupMap::new(Key::PositionMarkets),
            recipients: None,
            revenue_share_bps: DEFAULT_REVENUE_SHARE_BPS,
            fees: 0,
            revenue_due: 0,
            treasury_due: 0,
            revenue_unresolved: 0,
            locked_total: 0,
            min_sweep: DEFAULT_MIN_SWEEP,
            next_sweep_id: FIRST_SWEEP_ID,
            last_sweep_at: None,
            sweeps: LookupMap::new(Key::Sweeps),
            legs_in_flight_total: 0,
            legs_in_flight_count: 0,
            next_withdrawal_id: FIRST_WITHDRAWAL_ID,
            withdrawals: LookupMap::new(Key::Withdrawals),
            pending_withdrawals_total: 0,
            pending_withdrawal_count: 0,
            pending_by_account: LookupMap::new(Key::PendingByAccount),
            exempt_accounts: LookupMap::new(Key::ExemptAccounts),
            position_counts: LookupMap::new(Key::PositionCounts),
            market_storage_deposit: DEFAULT_MARKET_STORAGE_DEPOSIT,
            storage_reserve: DEFAULT_STORAGE_RESERVE,
            registration_fee: DEFAULT_REGISTRATION_FEE,
            registrations: LookupMap::new(Key::Registrations),
            max_market_locked: DEFAULT_MAX_MARKET_LOCKED,
            market_caps: LookupMap::new(Key::MarketCaps),
            halt_until: LookupMap::new(Key::HaltUntil),
        };
        state.make_exempt(&owner_id);
        state.make_exempt(&operator_id);
        state
    }

    // ---- owner ----------------------------------------------------------------------------

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
    // so the DAO's voting period is the only delay a code change waits out (decided 2026-10-21). Withdraw and redeem never
    // pause. Sell stays open too unless the owner itself has set sells_paused, and the operator's pause does not touch it.
    // The deploy and migrate are one batch: a migrate that panics
    // puts the old code back. Attach at least 100 TGas.
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

    // Runs in the new code, in the same batch as the deploy. Previous roots have explicit structs and conversions;
    // unsupported versions are refused before any collection is decoded.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let bytes = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("there is no state to migrate"));
        require!(bytes.len() >= 2, "invalid state");
        let version = u16::from_le_bytes([bytes[0], bytes[1]]);
        let mut state: Self = match version {
            STATE_VERSION => env::state_read().unwrap_or_else(|| env::panic_str("invalid current state")),
            7 => Self::from(env::state_read::<StateV7>().unwrap_or_else(|| env::panic_str("invalid previous state"))),
            6 => Self::from(env::state_read::<StateV6>().unwrap_or_else(|| env::panic_str("invalid previous state"))),
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
        self.only_owner();
        emit("owner_proposed", json!({ "owner": self.owner, "proposed": new_owner }));
        self.pending_owner = Some(new_owner);
    }

    pub fn accept_owner(&mut self) {
        let who = env::predecessor_account_id();
        require!(self.pending_owner.as_ref() == Some(&who), "not the proposed owner");
        emit("owner_changed", json!({ "from": self.owner, "to": who }));
        self.make_exempt(&who);
        self.owner = who;
        self.pending_owner = None;
    }

    // The fast key for routine operations. Only the owner can change it.
    pub fn set_operator(&mut self, operator_id: AccountId) {
        self.only_owner();
        emit("operator_set", json!({ "operator": operator_id }));
        self.make_exempt(&operator_id);
        self.operator = operator_id;
    }

    #[payable]
    pub fn create_market(
        &mut self,
        title: String,
        rule_text: String,
        resolution_source: String,
        void_policy: String,
        category: String,
        subcategory: String,
        close_at: U64,
        resolve_by: U64,
        price_rule: Option<PriceRule>,
    ) -> U64 {
        self.only_operator_or_owner();
        require!(!self.paused, "paused");
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= self.market_storage_deposit,
            "attach the market storage deposit"
        );
        let refund = attached - self.market_storage_deposit;
        for (name, value) in [
            ("title", &title),
            ("rule_text", &rule_text),
            ("resolution_source", &resolution_source),
            ("void_policy", &void_policy),
        ] {
            require!(!value.trim().is_empty(), format!("{name} is required"));
        }
        require!(
            title.len() <= MAX_TITLE
                && rule_text.len() <= MAX_RULE
                && resolution_source.len() <= MAX_SOURCE
                && void_policy.len() <= MAX_VOID,
            "text is too long"
        );
        require!(
            valid_slug(&category) && valid_slug(&subcategory),
            "category and subcategory must be lowercase slugs of up to 32 characters"
        );
        require!(close_at.0 > env::block_timestamp(), "close_at must be in the future");
        require!(resolve_by.0 > close_at.0, "resolve_by must be after close_at");
        if let Some(rule) = &price_rule {
            // Trading must stop before the moment that decides the market, or traders would know the answer.
            require!(
                rule.observation_time.0 >= close_at.0,
                "observation_time must not be before close_at"
            );
            require!(
                rule.observation_time.0 < resolve_by.0,
                "observation_time must be before resolve_by"
            );
            require!(
                rule.strike.0 > 0 && rule.decimals <= 18,
                "a price rule needs a strike above zero and at most 18 decimals"
            );
        }

        let hash_input = near_sdk::borsh::to_vec(&(
            &title,
            &rule_text,
            &resolution_source,
            &void_policy,
            close_at.0,
            &price_rule,
        ))
        .unwrap_or_else(|_| env::panic_str("hash failed"));
        let rule_hash: String = env::sha256(&hash_input).iter().map(|b| format!("{b:02x}")).collect();

        let id = self.next_market_id;
        self.next_market_id += 1;
        self.store_market(
            id,
            Market {
                title: title.clone(),
                rule_text,
                resolution_source,
                void_policy,
                category: category.clone(),
                subcategory: subcategory.clone(),
                rule_hash: rule_hash.clone(),
                price_rule,
                close_at: close_at.0,
                resolve_by: resolve_by.0,
                void_grace_ns: self.void_grace_ns,
                halted: false,
                registered: false,
                outcome: None,
                refunds: false,
                locked: 0,
                user_yes: 0,
                user_no: 0,
                claims: 0,
                history: vec![],
                holders: 0,
                pruned: false,
            },
        );
        emit(
            "market_created",
            json!({ "market_id": id.to_string(), "rule_hash": rule_hash, "title": title, "category": category,
                    "subcategory": subcategory, "close_at": close_at.0.to_string(), "resolve_by": resolve_by.0.to_string() }),
        );
        self.markets.flush();
        self.assert_storage_reserve(refund);
        if refund > 0 {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        self.register_with_oracle(id);
        U64(id)
    }

    // The oracle call can fail, so trading stays closed until the callback confirms it.
    pub fn retry_register(&mut self, market_id: U64) {
        self.only_operator_or_owner();
        let m = self.market(market_id.0);
        require!(!m.registered, "already registered");
        emit(
            "market_registration_retried",
            json!({ "market_id": market_id.0.to_string() }),
        );
        self.register_with_oracle(market_id.0);
    }

    #[private]
    pub fn on_registered(&mut self, market_id: U64, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_ok() {
            let mut m = self.market(market_id.0);
            m.registered = true;
            self.store_market(market_id.0, m);
            emit("market_registered", json!({ "market_id": market_id.0.to_string() }));
        } else {
            emit(
                "market_registration_failed",
                json!({ "market_id": market_id.0.to_string() }),
            );
        }
    }

    // Stops new buys on one market for HALT_DURATION_NS. Sells, withdrawals, claims and redemptions keep working. The operator
    // can halt a market once; after that only the owner halts it again, which extends the halt by another HALT_DURATION_NS.
    pub fn halt(&mut self, market_id: U64, reason: String) {
        self.only_operator_or_owner();
        let mut m = self.market(market_id.0);
        require!(m.outcome.is_none(), "already resolved");
        require!(
            env::predecessor_account_id() == self.owner || !self.halt_until.contains_key(&market_id.0),
            "the operator halts a market once, the owner halts it again"
        );
        let until = env::block_timestamp().saturating_add(HALT_DURATION_NS);
        m.halted = true;
        self.halt_until.insert(market_id.0, until);
        self.store_market(market_id.0, m);
        emit(
            "market_halted",
            json!({ "market_id": market_id.0.to_string(), "reason": reason, "until": until.to_string() }),
        );
    }

    // Owner only, so a halt the owner set cannot be lifted by the operator key. It also clears the record, which lets the
    // operator halt that market again. A market halted before the record existed (a migrated one) stays halted until here.
    pub fn resume(&mut self, market_id: U64) {
        self.only_owner();
        let mut m = self.market(market_id.0);
        require!(m.outcome.is_none(), "already resolved");
        m.halted = false;
        self.halt_until.remove(&market_id.0);
        self.store_market(market_id.0, m);
        emit("market_resumed", json!({ "market_id": market_id.0.to_string() }));
    }

    // Stops buys, deposits and new markets. Sells, withdrawals and redemptions keep working.
    pub fn set_paused(&mut self, paused: bool) {
        self.only_operator_or_owner();
        self.paused = paused;
        emit("paused", json!({ "paused": paused }));
    }

    // Owner only: stops sells. Kept apart from set_paused so the operator cannot take away the way out of an open position.
    pub fn set_sells_paused(&mut self, sells_paused: bool) {
        self.only_owner();
        self.sells_paused = sells_paused;
        emit("sells_paused", json!({ "sells_paused": sells_paused }));
    }

    // Where fees go: the Council and the treasury. A sweep refuses until this has been called, and the verifier does not
    // check that a receiver exists, so the owner must give accounts it has verified. Amounts still owed go to the new
    // accounts too.
    pub fn set_fee_recipients(&mut self, revenue_pool: AccountId, treasury: AccountId) {
        self.only_owner();
        require!(
            revenue_pool != treasury,
            "the Council and the treasury must be different accounts"
        );
        emit(
            "fee_recipients_set",
            json!({ "revenue_pool": revenue_pool, "treasury": treasury }),
        );
        self.recipients = Some(FeeRecipients { revenue_pool, treasury });
    }

    // The Council's share of every later sweep. The treasury gets the rest. A sweep that already ran keeps its split.
    pub fn set_revenue_share_bps(&mut self, revenue_share_bps: u32) {
        self.only_owner();
        let share = revenue_share_bps as u128;
        let (low, high) = (self.min_revenue_share_bps, self.max_revenue_share_bps);
        require!(
            (low..=high).contains(&share),
            format!("the Council share must be between {low} and {high} basis points")
        );
        emit(
            "revenue_share_set",
            json!({ "revenue_share_bps": revenue_share_bps, "treasury_share_bps": (BPS_DENOMINATOR - share) as u32 }),
        );
        self.revenue_share_bps = share;
    }

    pub fn set_min_sweep(&mut self, min_sweep: U128) {
        self.only_owner();
        require!(
            (1..=self.max_min_sweep).contains(&min_sweep.0),
            format!("the sweep minimum must be between 1 and {}", self.max_min_sweep)
        );
        emit("min_sweep_set", json!({ "min_sweep": min_sweep }));
        self.min_sweep = min_sweep.0;
    }

    // Moves the id of the next sweep up, never down: a sweep id is used once, and a market that replaces an old one must not
    // start below the ids the Council has already taken.
    pub fn set_next_sweep_id(&mut self, next_sweep_id: U64) {
        self.only_owner();
        require!(
            next_sweep_id.0 >= self.next_sweep_id,
            "the next sweep id can only move up"
        );
        emit("next_sweep_id_set", json!({ "next_sweep_id": next_sweep_id }));
        self.next_sweep_id = next_sweep_id.0;
    }

    pub fn set_fee_rate_bps(&mut self, fee_rate_bps: u32) {
        self.only_owner();
        require!(
            fee_rate_bps as u128 <= self.max_fee_rate_bps,
            format!("the fee rate is capped at {} basis points", self.max_fee_rate_bps)
        );
        emit("fee_rate_set", json!({ "fee_rate_bps": fee_rate_bps }));
        self.fee_rate_bps = fee_rate_bps as u128;
    }

    // Owner only. The void grace period for markets created after this call; a market that exists keeps the one it was
    // created with, since traders priced it under it.
    pub fn set_void_grace(&mut self, grace_ns: U64) {
        self.only_owner();
        require!(
            (HARD_MIN_VOID_GRACE_NS..=HARD_MAX_VOID_GRACE_NS).contains(&grace_ns.0),
            "the void grace period must be between 1 day and 60 days"
        );
        emit("void_grace_set", json!({ "grace_ns": grace_ns }));
        self.void_grace_ns = grace_ns.0;
    }

    // Owner only, live for every sweep: how long after a sweep it can be settled or reconciled, and the least time between
    // two sweeps.
    pub fn set_sweep_timing(
        &mut self,
        settle_wait_minutes: u32,
        reconcile_wait_minutes: u32,
        min_interval_minutes: u32,
    ) {
        self.only_owner();
        require!(
            (HARD_MIN_SETTLE_WAIT_MINUTES..=HARD_MAX_SETTLE_WAIT_MINUTES).contains(&settle_wait_minutes),
            "the settle wait must be between 1 and 1440 minutes"
        );
        require!(
            (HARD_MIN_RECONCILE_WAIT_MINUTES..=HARD_MAX_RECONCILE_WAIT_MINUTES).contains(&reconcile_wait_minutes),
            "the reconcile wait must be between 10 and 10080 minutes"
        );
        require!(
            reconcile_wait_minutes >= settle_wait_minutes,
            "the reconcile wait cannot be shorter than the settle wait"
        );
        require!(
            (HARD_MIN_SWEEP_INTERVAL_MINUTES..=HARD_MAX_SWEEP_INTERVAL_MINUTES).contains(&min_interval_minutes),
            "the sweep interval must be between 60 and 1440 minutes"
        );
        emit(
            "sweep_timing_set",
            json!({ "settle_wait_minutes": settle_wait_minutes, "reconcile_wait_minutes": reconcile_wait_minutes,
                    "min_interval_minutes": min_interval_minutes }),
        );
        self.settle_wait_minutes = settle_wait_minutes;
        self.reconcile_wait_minutes = reconcile_wait_minutes;
        self.min_sweep_interval_minutes = min_interval_minutes;
    }

    // Owner only, live: how many entries an account can hold. Accounts already over a lowered cap keep what they have.
    pub fn set_max_positions(&mut self, max_positions: u32) {
        self.only_owner();
        require!(
            (HARD_MIN_POSITIONS..=HARD_MAX_POSITIONS).contains(&max_positions),
            "the position cap must be between 5 and 30"
        );
        emit("max_positions_set", json!({ "max_positions": max_positions }));
        self.max_positions = max_positions;
    }

    // Owner only, live: the most one market can hold. A market already over a lowered ceiling takes no more buys and keeps
    // everything else working.
    pub fn set_max_market_locked(&mut self, max_market_locked: U128) {
        self.only_owner();
        require!(
            (HARD_MIN_MARKET_LOCKED..=dpm::MAX_LOCKED).contains(&max_market_locked.0),
            "the market cap is outside its hard range"
        );
        emit(
            "max_market_locked_set",
            json!({ "max_market_locked": max_market_locked.0.to_string() }),
        );
        self.max_market_locked = max_market_locked.0;
    }

    // Operator or owner: a lower cap for one market, never above the ceiling. Sports and politics can each carry the cap their
    // bond can answer for.
    pub fn set_market_cap(&mut self, market_id: U64, cap: U128) {
        self.only_operator_or_owner();
        require!(self.markets.contains_key(&market_id.0), "no such market");
        require!(
            (HARD_MIN_MARKET_LOCKED..=self.max_market_locked).contains(&cap.0),
            "the cap must be between the hard minimum and the ceiling"
        );
        self.market_caps.insert(market_id.0, cap.0);
        self.market_caps.flush();
        self.assert_storage_reserve(0);
        emit(
            "market_cap_set",
            json!({ "market_id": market_id.0.to_string(), "cap": cap.0.to_string() }),
        );
    }

    pub fn market_cap(&self, market_id: U64) -> U128 {
        U128(self.market_cap_of(market_id.0))
    }

    // Owner only: the ceilings and floors the fee setters check against. A limit that would leave the current fee rate,
    // Council share or sweep minimum outside it is refused, so the value has to be moved first.
    pub fn set_fee_limits(
        &mut self,
        max_fee_rate_bps: u32,
        min_revenue_share_bps: u32,
        max_revenue_share_bps: u32,
        max_min_sweep: U128,
    ) {
        self.only_owner();
        let (max_rate, min_share, max_share) = (
            max_fee_rate_bps as u128,
            min_revenue_share_bps as u128,
            max_revenue_share_bps as u128,
        );
        require!(
            max_rate <= HARD_MAX_FEE_RATE_BPS,
            format!("the fee rate ceiling cannot be over {HARD_MAX_FEE_RATE_BPS} basis points")
        );
        require!(
            min_share >= HARD_MIN_REVENUE_SHARE_BPS,
            format!("the Council share floor cannot be under {HARD_MIN_REVENUE_SHARE_BPS} basis points")
        );
        require!(
            max_share <= HARD_MAX_REVENUE_SHARE_BPS,
            format!("the Council share ceiling cannot be over {HARD_MAX_REVENUE_SHARE_BPS} basis points")
        );
        require!(
            min_share < max_share,
            "the Council share floor must be below its ceiling"
        );
        require!(
            (1..=HARD_MAX_MIN_SWEEP).contains(&max_min_sweep.0),
            format!("the sweep minimum ceiling must be between 1 and {HARD_MAX_MIN_SWEEP}")
        );
        require!(
            self.fee_rate_bps <= max_rate,
            "the current fee rate is above that ceiling, lower the fee rate first"
        );
        require!(
            (min_share..=max_share).contains(&self.revenue_share_bps),
            "the current Council share is outside those limits, move the share first"
        );
        require!(
            self.min_sweep <= max_min_sweep.0,
            "the current sweep minimum is above that ceiling, lower the sweep minimum first"
        );
        emit(
            "fee_limits_set",
            json!({ "max_fee_rate_bps": max_fee_rate_bps, "min_revenue_share_bps": min_revenue_share_bps,
                    "max_revenue_share_bps": max_revenue_share_bps, "max_min_sweep": max_min_sweep }),
        );
        self.max_fee_rate_bps = max_rate;
        self.min_revenue_share_bps = min_share;
        self.max_revenue_share_bps = max_share;
        self.max_min_sweep = max_min_sweep.0;
    }

    // Owner policy, applied to future creations. Retained deposits fund the complete record,
    // including its bounded history. Exits may spend the reserve; new state must leave it intact.
    pub fn set_storage_policy(&mut self, market_storage_deposit: U128, reserve: U128) {
        self.only_owner();
        require!(
            (HARD_MIN_MARKET_STORAGE_DEPOSIT..=HARD_MAX_MARKET_STORAGE_DEPOSIT).contains(&market_storage_deposit.0),
            "market storage deposit outside hard range"
        );
        require!(
            (HARD_MIN_STORAGE_RESERVE..=HARD_MAX_STORAGE_RESERVE).contains(&reserve.0),
            "storage reserve outside hard range"
        );
        self.market_storage_deposit = market_storage_deposit.0;
        self.storage_reserve = reserve.0;
        emit(
            "storage_policy_set",
            json!({ "market_storage_deposit": market_storage_deposit, "reserve": reserve }),
        );
    }

    pub fn set_registration_fee(&mut self, registration_fee: U128) {
        self.only_owner();
        require!(
            (HARD_MIN_REGISTRATION_FEE..=HARD_MAX_REGISTRATION_FEE).contains(&registration_fee.0),
            "registration fee outside hard range"
        );
        self.registration_fee = registration_fee.0;
        emit("registration_fee_set", json!({ "registration_fee": registration_fee }));
    }

    // Permissionless and idempotent. Monetary fields, rule hash and sweep ledgers survive.
    pub fn prune_market(&mut self, market_id: U64) -> bool {
        let mut m = self.market(market_id.0);
        if m.pruned {
            return false;
        }
        require!(m.outcome.is_some(), "market is not resolved");
        require!(
            m.holders == 0 && m.user_yes == 0 && m.user_no == 0,
            "holders must redeem both sides before pruning"
        );
        m.title.clear();
        m.rule_text.clear();
        m.resolution_source.clear();
        m.void_policy.clear();
        m.history.clear();
        m.pruned = true;
        let hash = m.rule_hash.clone();
        self.store_market(market_id.0, m);
        emit(
            "market_pruned",
            json!({ "market_id": market_id.0.to_string(), "rule_hash": hash }),
        );
        true
    }

    // After resolution the pool's leftover collateral is due to the treasury, not the owner: the owner is the DAO, which has
    // no easy way to spend a balance held here. The next sweep pays it on the treasury leg, whole and not split with the
    // Council. Users' payouts stay reserved.
    pub fn claim_residual(&mut self, market_id: U64) {
        self.only_operator_or_owner();
        let mut m = self.market(market_id.0);
        let outcome = m.outcome.unwrap_or_else(|| env::panic_str("not resolved"));
        require!(!m.has_payees(outcome), "holders are still owed their payouts");
        let residual = m.locked;
        require!(residual > 0, "nothing is left over");
        m.locked = 0;
        self.store_market(market_id.0, m);
        self.locked_total -= residual;
        self.treasury_due += residual;
        emit(
            "residual_claimed",
            json!({ "market_id": market_id.0.to_string(), "amount": residual.to_string(),
                    "to": self.recipients.as_ref().map(|r| &r.treasury) }),
        );
    }

    // ---- oracle ---------------------------------------------------------------------------

    // Only the oracle calls this. Calling it again with the same answer does nothing.
    pub fn set_outcome(&mut self, market_id: U64, outcome: Outcome) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        let mut m = self.market(market_id.0);
        require!(env::block_timestamp() >= m.close_at, "market has not closed");
        match m.outcome {
            Some(existing) => require!(existing == outcome, "market already resolved differently"),
            None => {
                m.resolve(outcome);
                let refunds = m.refunds;
                self.store_market(market_id.0, m);
                emit(
                    "outcome_set",
                    json!({ "market_id": market_id.0.to_string(), "outcome": outcome, "refunds": refunds }),
                );
            }
        }
    }

    // The way out if the oracle is gone, so money is never stuck. Once resolve_by has passed the oracle's
    // resolve_by_deadline answers the market, settling whatever can be settled and voiding the rest. This is only open
    // a grace period after that, and then anyone can void the market and every holder redeems what a Void pays
    // (see Market::resolve).
    pub fn void_if_unresolved(&mut self, market_id: U64) {
        let mut m = self.market(market_id.0);
        require!(m.outcome.is_none(), "already resolved");
        require!(
            env::block_timestamp() >= m.resolve_by.saturating_add(m.void_grace_ns),
            format!(
                "the answer deadline and the {} day grace period have not passed",
                m.void_grace_ns.div_ceil(NS_PER_DAY)
            )
        );
        m.resolve(Outcome::Void);
        self.store_market(market_id.0, m);
        emit(
            "outcome_set",
            json!({ "market_id": market_id.0.to_string(), "outcome": Outcome::Void, "by": "deadline", "refunds": true }),
        );
    }

    // ---- money in -------------------------------------------------------------------------

    // Called by the verifier after a user's mt_transfer_call (or a signed transfer with a notification), once the money is
    // already in this contract's Intents account. Returns the amounts to hand back, so 0 keeps everything. Panicking makes
    // the verifier refund the sender in full. A plain deposit never reaches here: it is surplus (see total_owed).
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
            token_ids.len() == 1 && amounts.len() == 1,
            "exactly one token and amount"
        );
        require!(token_ids[0] == self.collateral_token_id, "wrong token");
        require!(
            previous_owner_ids.as_slice() == [sender_id.clone()],
            "the money must come from the sender's own balance"
        );
        let amount = amounts[0];
        require!(amount.0 > 0, "amount must be positive");
        let mut parts = msg.split(':');
        match parts.next() {
            Some("deposit") => {
                self.assert_can_deposit(&sender_id);
                self.credit_deposit(&sender_id, amount.0);
            }
            Some("register") => self.register_with_collateral(&sender_id, amount.0),
            Some("buy") => {
                let id: u64 = parse_part(parts.next(), "market id");
                let side = side_index(parts.next().unwrap_or(""));
                let min_out: u128 = parse_part(parts.next(), "min shares");
                self.buy_with(&sender_id, id, side, amount.0, min_out);
            }
            _ => env::panic_str("unknown action"),
        }
        vec![U128(0)]
    }

    #[private]
    pub fn on_forwarded(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        arrival: Arrival,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> U128 {
        let taken = used.map_or(0, |used| used.0.min(amount.0));
        if taken == 0 {
            return amount;
        }
        self.credit_deposit(&sender_id, taken);
        if let Arrival::Buy {
            market_id,
            side,
            min_shares,
        } = arrival
        {
            let _ = Self::ext(env::current_account_id()).with_static_gas(GAS_BUY).buy_for(
                sender_id,
                market_id,
                side,
                U128(taken),
                min_shares,
            );
        }
        U128(amount.0 - taken)
    }

    #[private]
    pub fn buy_for(&mut self, who: AccountId, market_id: U64, side: u8, amount: U128, min_shares: U128) {
        self.debit(&who, amount.0);
        self.buy_with(&who, market_id.0, side, amount.0, min_shares.0);
    }

    pub fn on_auth(&mut self, signer_id: AccountId, msg: String) -> PromiseOrValue<()> {
        require!(
            env::predecessor_account_id() == self.verifier,
            "only the verifier can act for a signer"
        );
        let mut parts = msg.split(':');
        match parts.next() {
            Some("buy") => {
                let id: u64 = parse_part(parts.next(), "market id");
                let side = side_index(parts.next().unwrap_or(""));
                let amount: u128 = parse_part(parts.next(), "amount");
                let min_out: u128 = parse_part(parts.next(), "min shares");
                self.debit(&signer_id, amount);
                self.buy_with(&signer_id, id, side, amount, min_out);
            }
            Some("sell") => {
                let id: u64 = parse_part(parts.next(), "market id");
                let side = parts.next().unwrap_or("");
                let shares: u128 = parse_part(parts.next(), "shares");
                let min_collateral: u128 = parse_part(parts.next(), "min collateral");
                self.sell_for(&signer_id, id, side, shares, min_collateral);
            }
            Some("redeem") => {
                let _ = self.redeem_for(&signer_id, parse_part(parts.next(), "market id"));
            }
            Some("withdraw") => {
                let amount: u128 = parse_part(parts.next(), "amount");
                return PromiseOrValue::Promise(self.withdraw_for(signer_id, amount));
            }
            _ => env::panic_str("unknown action"),
        }
        PromiseOrValue::Value(())
    }

    // ---- trading --------------------------------------------------------------------------

    // Buy using balance already held here. Like every call that spends or moves a balance, it needs exactly 1 yocto,
    // so a limited-access key, which cannot attach a deposit, cannot be used to trade.
    #[payable]
    pub fn buy(&mut self, market_id: U64, side: String, amount: U128, min_shares: U128) {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        self.debit(&who, amount.0);
        self.buy_with(&who, market_id.0, side_index(&side), amount.0, min_shares.0);
    }

    // Sells `shares` for what they fetch now. The fee is kept and the rest is credited to the seller. Needs exactly 1 yocto.
    #[payable]
    pub fn sell(&mut self, market_id: U64, side: String, shares: U128, min_collateral: U128) {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        self.sell_for(&who, market_id.0, &side, shares.0, min_collateral.0);
    }

    fn sell_for(&mut self, who: &AccountId, id: u64, side: &str, shares: u128, min_collateral: u128) {
        require!(!self.sells_paused, "sells are paused");
        require!(self.accounts.contains_key(who), "do the storage deposit first");
        let idx = side_index(side);
        let mut m = self.tradable_market(id);
        let (target, other) = m.sides(idx);
        let (fee, refund, left) = dpm::sell_after_fee(target, other, shares, self.fee_rate_bps)
            .unwrap_or_else(|| env::panic_str("cannot sell that many shares"));
        require!(
            refund - fee >= min_collateral,
            "price moved, you would get less than your minimum"
        );

        self.take_shares(&mut m, who, id, idx, shares);
        m.set_side(idx, left);
        m.locked -= refund;
        self.locked_total -= refund;
        self.add_cost(&mut m, id, who, 0, refund);
        m.record_price();
        let mut data = json!({ "market_id": id.to_string(), "account": who, "side": side,
                    "shares": shares.to_string(), "collateral": refund.to_string(), "fee": fee.to_string() });
        m.add_prices(&mut data);
        self.store_market(id, m);
        self.fees += fee;
        self.credit(who, refund - fee);
        emit("sell", data);
    }

    // Pays out after resolution. No deadline.
    pub fn redeem(&mut self, market_id: U64) -> U128 {
        U128(self.redeem_for(&env::predecessor_account_id(), market_id.0))
    }

    fn redeem_for(&mut self, who: &AccountId, id: u64) -> u128 {
        let mut m = self.market(id);
        let outcome = m.outcome.unwrap_or_else(|| env::panic_str("not resolved yet"));
        let yes = self.shares.get(&(id, who.clone(), 0)).copied().unwrap_or(0);
        let no = self.shares.get(&(id, who.clone(), 1)).copied().unwrap_or(0);
        require!(yes + no > 0, "nothing to redeem");
        let payout = m.payout(outcome, yes, no, self.claim_of(id, who));
        self.take_shares(&mut m, who, id, 0, yes);
        self.take_shares(&mut m, who, id, 1, no);
        self.add_cost(&mut m, id, who, 0, 0);
        m.user_yes -= yes;
        m.user_no -= no;
        m.locked -= payout;
        self.locked_total -= payout;
        self.store_market(id, m);
        self.credit(who, payout);
        emit(
            "redeemed",
            json!({ "market_id": id.to_string(), "account": who, "amount": payout.to_string(),
                    "yes_shares": yes.to_string(), "no_shares": no.to_string() }),
        );
        payout
    }

    // ---- money out ------------------------------------------------------------------------

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.withdraw_for(env::predecessor_account_id(), amount.0)
    }

    fn withdraw_for(&mut self, who: AccountId, amount: u128) -> Promise {
        require!(amount > 0, "amount must be positive");
        // Take the balance first and record the withdrawal as owed; the callback confirms it or gives the balance back.
        self.debit(&who, amount);
        let id = self.next_withdrawal_id;
        self.next_withdrawal_id += 1;
        self.store_withdrawal(
            id,
            Withdrawal {
                account: who.clone(),
                amount: U128(amount),
                at: U64(env::block_timestamp()),
            },
        );
        self.pending_withdrawals_total += amount;
        self.pending_withdrawal_count += 1;
        let mine = self.pending_by_account.get(&who).copied().unwrap_or(0);
        self.pending_by_account.insert(who.clone(), mine + amount);
        emit(
            "withdraw",
            json!({ "account": who, "amount": amount.to_string(), "id": id.to_string() }),
        );
        // The payout goes to the caller's own Intents account, inside the verifier. mt_transfer returns nothing, so an
        // error here means the verifier's receipt failed (paused, locked, out of gas) and nothing moved.
        ext_verifier::ext(self.verifier.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_MT_TRANSFER)
            .mt_transfer(who, self.collateral_token_id.clone(), U128(amount), None, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw(U64(id)),
            )
    }

    // The amount and the account come from the stored record, never from the callback. An id with no record was already settled,
    // so a repeat changes nothing. A callback that never runs leaves the withdrawal in the pending total, still owed.
    #[private]
    pub fn on_withdraw(&mut self, id: U64, #[callback_result] result: Result<(), PromiseError>) {
        let Some(w) = self.find_withdrawal(id.0) else {
            return;
        };
        let data = self.close_withdrawal(id.0, w, result.is_err());
        emit(
            if result.is_err() {
                "withdraw_failed"
            } else {
                "withdraw_confirmed"
            },
            data,
        );
    }

    // Owner only, for a withdrawal whose callback never came, so it stays in the pending totals and still counts as owed. It
    // needs the same wait as reconcile_leg, which leaves the callback time to land, and the owner checks the verifier's
    // events first: `paid` true means the transfer happened and the record is dropped, false means it did not and the
    // balance is credited back. A callback that comes later finds no record and changes nothing.
    pub fn reconcile_withdrawal(&mut self, id: U64, paid: bool) {
        self.only_owner();
        let w = self
            .find_withdrawal(id.0)
            .unwrap_or_else(|| env::panic_str("no withdrawal is pending with that id"));
        require!(
            env::block_timestamp()
                >= w.at
                    .0
                    .saturating_add(self.reconcile_wait_minutes as u64 * NS_PER_MINUTE),
            format!(
                "wait {} minutes after the withdrawal before reconciling",
                self.reconcile_wait_minutes
            )
        );
        let mut data = self.close_withdrawal(id.0, w, !paid);
        data["paid"] = json!(paid);
        emit("withdrawal_reconciled", data);
    }

    // Takes a withdrawal out of the pending totals and gives the balance back when it failed. Both the payout callback and
    // reconcile_withdrawal end a withdrawal here, so the two cannot disagree about the books. Returns the event data.
    fn close_withdrawal(&mut self, id: u64, w: Withdrawal, failed: bool) -> near_sdk::serde_json::Value {
        self.withdrawals.remove(&id);
        let amount = w.amount.0;
        self.pending_withdrawals_total -= amount;
        self.pending_withdrawal_count -= 1;
        let mine = self.pending_by_account.get(&w.account).copied().unwrap_or(0) - amount;
        if mine == 0 {
            self.pending_by_account.remove(&w.account);
        } else {
            self.pending_by_account.insert(w.account.clone(), mine);
        }
        if failed {
            self.credit(&w.account, amount);
        }
        json!({ "account": w.account, "amount": amount.to_string(), "id": id.to_string() })
    }

    // ---- fees -----------------------------------------------------------------------------

    // Anyone may call it. Splits the collected fees between the Council and the treasury by the owner's share, rounding both
    // parts down so the remainder (0 or 1 unit) stays collected, adds what earlier refused legs left due, records both legs
    // under a new sweep id, and only then sends them. A sweep with less than min_sweep to act on does nothing and takes no id. A second sweep within an hour of the last one is refused.
    // It refuses until the owner has set the recipients. It needs at least 87 TGas attached (GAS_SWEEP_FLOOR) and burns about
    // 20 TGas in all, the verifier's and the Council's receipt included, which does not depend on how many seats are staked.
    pub fn sweep_fees(&mut self) -> Option<U64> {
        upgrade::require_gas(
            GAS_SWEEP_FLOOR,
            "a sweep sends the Council its part and the treasury its part",
        );
        let recipients = self.recipients.clone().unwrap_or_else(|| {
            env::panic_str("the fee recipients are not set, the owner must call set_fee_recipients before a sweep")
        });
        if self.fees + self.revenue_due + self.treasury_due < self.min_sweep {
            return None;
        }
        let (to_council, to_treasury) = split_fees(self.fees, self.revenue_share_bps);
        let (council, treasury) = (to_council + self.revenue_due, to_treasury + self.treasury_due);
        if council == 0 && treasury == 0 {
            return None;
        }
        let now = env::block_timestamp();
        let interval = self.min_sweep_interval_minutes;
        require!(
            self.last_sweep_at
                .is_none_or(|last| now >= last.saturating_add(interval as u64 * NS_PER_MINUTE)),
            if interval == 60 {
                "wait an hour since the last sweep".to_string()
            } else {
                format!("wait {interval} minutes since the last sweep")
            }
        );
        let id = self.next_sweep_id;
        self.next_sweep_id += 1;
        self.last_sweep_at = Some(now);
        let leg = |to: AccountId, amount: u128| Leg {
            to,
            amount: U128(amount),
            status: if amount == 0 {
                LegStatus::Settled
            } else {
                LegStatus::Pending
            },
        };
        let sweep = Sweep {
            id: U64(id),
            at: U64(now),
            total: U128(self.fees),
            carried_council: U128(self.revenue_due),
            carried_treasury: U128(self.treasury_due),
            council: leg(recipients.revenue_pool.clone(), council),
            treasury: leg(recipients.treasury.clone(), treasury),
        };
        // Both legs are on the record, and each due is zeroed, before either transfer is sent. A callback puts back only what
        // did not arrive, in its own bucket.
        self.fees -= to_council + to_treasury;
        self.revenue_due = 0;
        self.treasury_due = 0;
        for leg in [&sweep.council, &sweep.treasury] {
            if leg.status == LegStatus::Pending {
                self.legs_in_flight_total += leg.amount.0;
                self.legs_in_flight_count += 1;
            }
        }
        self.store_sweep(id, sweep.clone());
        emit(
            "fees_swept",
            json!({ "id": id.to_string(), "total": sweep.total, "revenue_pool": recipients.revenue_pool, "council": sweep.council.amount,
                    "treasury_account": recipients.treasury, "treasury": sweep.treasury.amount }),
        );
        if council > 0 {
            let _ = ext_verifier::ext(self.verifier.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_MT_TRANSFER_CALL)
                .mt_transfer_call(
                    recipients.revenue_pool,
                    self.collateral_token_id.clone(),
                    U128(council),
                    None,
                    None,
                    format!("revenue:{id}"),
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_revenue_sent(U64(id)),
                );
        }
        if treasury > 0 {
            let _ = ext_verifier::ext(self.verifier.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_MT_TRANSFER)
                .mt_transfer(
                    recipients.treasury,
                    self.collateral_token_id.clone(),
                    U128(treasury),
                    None,
                    None,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_treasury_sent(U64(id)),
                );
        }
        Some(U64(id))
    }

    // The verifier reports the amount the Council kept, one entry for the one token. A Council that panicked reports 0: the
    // verifier has already refunded the whole amount here, so it is due again. With no usable report the amount is unknown,
    // because the verifier's own resolve step may be what failed and the money may be with the Council already. Crediting
    // it back to revenue_due could then pay it twice, out of users' collateral, so the leg is unresolved and its amount waits
    // in revenue_unresolved until settle_leg reads the Council's own record of the sweep.
    #[private]
    pub fn on_revenue_sent(&mut self, sweep_id: U64, #[callback_result] used: Result<Vec<U128>, PromiseError>) {
        if !self.leg_is(sweep_id.0, LegKind::Council, LegStatus::Pending) {
            return;
        }
        match used {
            Ok(used) if used.len() == 1 => self.end_leg(sweep_id.0, LegKind::Council, used[0].0),
            _ => self.park_council_leg(sweep_id.0),
        }
    }

    #[private]
    pub fn on_treasury_sent(&mut self, sweep_id: U64, #[callback_result] result: Result<(), PromiseError>) {
        if !self.leg_is(sweep_id.0, LegKind::Treasury, LegStatus::Pending) {
            return;
        }
        let kept = if result.is_ok() {
            self.sweep(sweep_id.0).treasury.amount.0
        } else {
            0
        };
        self.end_leg(sweep_id.0, LegKind::Treasury, kept);
    }

    // Anyone may call it for a Council leg whose result was lost, once the Council's receipt has had time to finish. It asks
    // the Council what it recorded under the sweep id: a record settles the leg, no record makes the amount due again. The
    // Council takes a sweep id once, so the answer cannot change afterwards.
    pub fn settle_leg(&mut self, sweep_id: U64) -> Promise {
        upgrade::require_gas(
            GAS_SETTLE_FLOOR,
            "settling asks the Council what it recorded and then reads the answer",
        );
        let sweep = self.sweep(sweep_id.0);
        require!(
            sweep.council.status == LegStatus::Unresolved,
            "the leg is not unresolved"
        );
        require!(
            env::block_timestamp()
                >= sweep
                    .at
                    .0
                    .saturating_add(self.settle_wait_minutes as u64 * NS_PER_MINUTE),
            format!(
                "wait {} minutes after the sweep before settling",
                self.settle_wait_minutes
            )
        );
        ext_council::ext(sweep.council.to)
            .with_static_gas(GAS_COUNCIL_VIEW)
            .received_of(env::current_account_id(), sweep_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_council_checked(sweep_id),
            )
    }

    // An error means the Council could not answer, so the leg stays unresolved and anyone can ask again.
    #[private]
    pub fn on_council_checked(
        &mut self,
        sweep_id: U64,
        #[callback_result] receipt: Result<Option<CouncilReceipt>, PromiseError>,
    ) {
        let Ok(receipt) = receipt else { return };
        if !self.leg_is(sweep_id.0, LegKind::Council, LegStatus::Unresolved) {
            return;
        }
        self.revenue_unresolved -= self.sweep(sweep_id.0).council.amount.0;
        self.end_leg(sweep_id.0, LegKind::Council, receipt.map_or(0, |r| r.amount.0));
    }

    // Owner only, for a leg that is still pending or unresolved an hour after the sweep: the callback never came, or the
    // Council cannot say what it recorded. `arrived` true means the recipient has the money, so the leg is done. False means
    // it never arrived, so the amount is due again and the next sweep sends it. The owner must have checked the verifier's
    // events and the recipient's balance first.
    pub fn reconcile_leg(&mut self, sweep_id: U64, leg: LegKind, arrived: bool) {
        self.only_owner();
        let sweep = self.sweep(sweep_id.0);
        let (status, amount, to) = (
            sweep.leg(leg).status,
            sweep.leg(leg).amount.0,
            sweep.leg(leg).to.clone(),
        );
        require!(
            matches!(status, LegStatus::Pending | LegStatus::Unresolved),
            "the leg is neither pending nor unresolved"
        );
        require!(
            env::block_timestamp()
                >= sweep
                    .at
                    .0
                    .saturating_add(self.reconcile_wait_minutes as u64 * NS_PER_MINUTE),
            format!(
                "wait {} minutes after the sweep before reconciling",
                self.reconcile_wait_minutes
            )
        );
        if status == LegStatus::Unresolved {
            self.revenue_unresolved -= amount;
        }
        self.end_leg(sweep_id.0, leg, if arrived { amount } else { 0 });
        emit(
            "fee_leg_reconciled",
            json!({ "id": sweep_id.0.to_string(), "leg": leg, "to": to, "amount": amount.to_string(), "arrived": arrived }),
        );
    }

    // ---- views ----------------------------------------------------------------------------

    // Whether a wasm with this sha256 is staged here, for the members to check before they vote to deploy it.
    pub fn is_staged(&self, code_hash: Base58CryptoHash) -> bool {
        upgrade::is_staged(code_hash)
    }

    // revenue_pool and treasury are null until the owner has set the fee recipients, and a sweep refuses until then.
    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "state_version": self.state_version, "upgrade_proven": self.upgrade_proven, "upgrade_in_flight": self.upgrade_in_flight,
                "owner": self.owner, "pending_owner": self.pending_owner, "operator": self.operator, "oracle": self.oracle,
                "verifier": self.verifier, "collateral_token_id": self.collateral_token_id,
                "paused": self.paused, "sells_paused": self.sells_paused, "markets": self.next_market_id.to_string(), "storage_deposit": STORAGE_DEPOSIT.as_yoctonear().to_string(),
                "max_positions": self.max_positions, "max_market_locked": self.max_market_locked.to_string(), "fee_rate_bps": self.fee_rate_bps as u32,
                "revenue_pool": self.recipients.as_ref().map(|r| &r.revenue_pool), "treasury": self.recipients.as_ref().map(|r| &r.treasury),
                "revenue_share_bps": self.revenue_share_bps as u32, "treasury_share_bps": (BPS_DENOMINATOR - self.revenue_share_bps) as u32,
                "min_sweep": self.min_sweep.to_string(), "next_sweep_id": self.next_sweep_id.to_string(),
                "revenue_unresolved": self.revenue_unresolved.to_string(),
                "void_grace_ns": self.void_grace_ns.to_string(),
                "settle_wait_minutes": self.settle_wait_minutes, "reconcile_wait_minutes": self.reconcile_wait_minutes,
                "min_sweep_interval_minutes": self.min_sweep_interval_minutes,
                "last_sweep_at": self.last_sweep_at.map(|at| at.to_string()),
                "max_fee_rate_bps": self.max_fee_rate_bps as u32,
                "min_revenue_share_bps": self.min_revenue_share_bps as u32, "max_revenue_share_bps": self.max_revenue_share_bps as u32,
                "max_min_sweep": self.max_min_sweep.to_string(),
                "market_storage_deposit": self.market_storage_deposit.to_string(), "storage_reserve": self.storage_reserve.to_string(),
                "registration_fee": self.registration_fee.to_string(),
                "position_page_default": POSITION_PAGE_DEFAULT, "position_page_max": POSITION_PAGE_MAX })
    }

    pub fn get_fees(&self) -> near_sdk::serde_json::Value {
        json!({ "collected": self.fees.to_string(), "revenue_due": self.revenue_due.to_string(),
                "treasury_due": self.treasury_due.to_string(), "revenue_unresolved": self.revenue_unresolved.to_string() })
    }

    pub fn get_sweep(&self, sweep_id: U64) -> Option<Sweep> {
        self.find_sweep(sweep_id.0)
    }

    // Sweeps by id from `from_index`, oldest first, at most 50 a call. An id that was skipped with set_next_sweep_id is absent.
    pub fn list_sweeps(&self, from_index: U64, limit: U64) -> Vec<Sweep> {
        let end = self.next_sweep_id.min(from_index.0.saturating_add(limit.0.min(50)));
        (from_index.0..end).filter_map(|id| self.find_sweep(id)).collect()
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.accounts.contains_key(&account_id)
    }

    // Everything this contract owes, in collateral units: user balances, what is locked in every market, and every fee
    // bucket. The keeper compares it with the verifier's mt_balance_of for this account at the same finalized block. More
    // there than here is surplus nobody is credited for. Less is an incident. A withdrawal in flight is still counted, because
    // the verifier has not confirmed it, until its callback runs. A fee leg that is pending
    // is out of the books because its money is already on its way, so an unfinished transfer shows as surplus here and never
    // as a shortfall.
    pub fn total_owed(&self) -> U128 {
        self.owed_breakdown().total
    }

    // The buckets total_owed adds, so a reader can see what the number is made of.
    pub fn owed_breakdown(&self) -> OwedView {
        OwedView {
            balances: U128(self.balances_total),
            locked: U128(self.locked_total),
            fees: U128(self.fees),
            revenue_due: U128(self.revenue_due),
            treasury_due: U128(self.treasury_due),
            unresolved: U128(self.revenue_unresolved),
            pending_withdrawals: U128(self.pending_withdrawals_total),
            total: U128(
                self.balances_total
                    + self.locked_total
                    + self.fees
                    + self.revenue_due
                    + self.treasury_due
                    + self.revenue_unresolved
                    + self.pending_withdrawals_total,
            ),
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        AccountView {
            registered: self.accounts.contains_key(&account_id),
            available: self.get_balance(account_id.clone()),
            pending_withdrawals: U128(self.pending_by_account.get(&account_id).copied().unwrap_or(0)),
            positions: if self.is_exempt(&account_id) {
                self.position_counts
                    .get(&account_id)
                    .copied()
                    .or_else(|| (self.accounts.get(&account_id).copied().unwrap_or(0) == 0).then_some(0))
            } else {
                Some(self.position_markets.get(&account_id).map_or(0, |ids| ids.len() as u32))
            },
        }
    }

    // Money sent and not yet reported: withdrawals waiting on their callback, and fee legs that are pending or unresolved.
    pub fn in_flight(&self) -> InFlightView {
        InFlightView {
            withdrawals: U128(self.pending_withdrawals_total),
            withdrawal_count: self.pending_withdrawal_count,
            legs: U128(self.legs_in_flight_total),
            leg_count: self.legs_in_flight_count,
        }
    }

    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_shares(&self, market_id: U64, account_id: AccountId) -> (U128, U128) {
        let y = self
            .shares
            .get(&(market_id.0, account_id.clone(), 0))
            .copied()
            .unwrap_or(0);
        let n = self.shares.get(&(market_id.0, account_id, 1)).copied().unwrap_or(0);
        (U128(y), U128(n))
    }

    // For exempt accounts limit bounds scanned ids, not matches. Advance by the clamped
    // window even when a page is empty. Ordinary accounts read their small index.
    pub fn get_positions(
        &self,
        account_id: AccountId,
        from_market: Option<U64>,
        limit: Option<U64>,
    ) -> Vec<PositionView> {
        let from = from_market.map_or(0, |v| v.0);
        let size = limit.map_or(POSITION_PAGE_DEFAULT, |v| v.0).min(POSITION_PAGE_MAX);
        let ids: Vec<u64> = if self.is_exempt(&account_id) {
            (from..self.next_market_id.min(from.saturating_add(size))).collect()
        } else {
            self.position_markets
                .get(&account_id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|id| *id >= from)
                .take(size as usize)
                .collect()
        };
        ids.into_iter()
            .filter_map(|id| {
                let (yes, no) = self.get_shares(U64(id), account_id.clone());
                if yes.0 == 0 && no.0 == 0 {
                    return None;
                }
                let m = self.find_market(id)?;
                Some(PositionView {
                    market_id: U64(id),
                    yes,
                    no,
                    status: m.status(self.is_halted(id, &m)).to_string(),
                    outcome: m.outcome,
                    redeemable: U128(
                        m.outcome
                            .map_or(0, |o| m.payout(o, yes.0, no.0, self.claim_of(id, &account_id))),
                    ),
                })
            })
            .collect()
    }

    pub fn positions_are_paged(&self, account_id: AccountId) -> bool {
        self.is_exempt(&account_id)
    }

    pub fn get_market(&self, market_id: U64) -> Option<MarketView> {
        self.find_market(market_id.0).map(|m| self.view(market_id.0, &m))
    }

    pub fn list_markets(&self, from_index: U64, limit: U64) -> Vec<MarketView> {
        let end = self.next_market_id.min(from_index.0.saturating_add(limit.0.min(50)));
        (from_index.0..end)
            .filter_map(|id| self.find_market(id).map(|m| self.view(id, &m)))
            .collect()
    }

    // Yes price after each trade, oldest first. The website draws its chart from this.
    pub fn get_history(&self, market_id: U64) -> Vec<PricePoint> {
        self.find_market(market_id.0)
            .map(|m| {
                m.history
                    .iter()
                    .map(|(at, p)| PricePoint {
                        at: U64(*at),
                        price_yes: *p,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    // Shares you would get for `amount` collateral and the fee taken out of it, or zeros when the trade is not possible.
    pub fn quote_buy(&self, market_id: U64, side: String, amount: U128) -> BuyQuote {
        let none = BuyQuote {
            shares_out: U128(0),
            fee: U128(0),
        };
        let Some(m) = self.find_market(market_id.0) else {
            return none;
        };
        let (target, other) = m.sides(side_index(&side));
        match dpm::buy_after_fee(target, other, amount.0, self.fee_rate_bps) {
            Some((fee, out, _)) => BuyQuote {
                shares_out: U128(out),
                fee: U128(fee),
            },
            None => none,
        }
    }

    // What selling `shares` takes out of the pool now, the shares it takes, and the fee kept from it.
    pub fn quote_sell(&self, market_id: U64, side: String, shares: U128) -> SellQuote {
        let none = SellQuote {
            collateral_out: U128(0),
            shares_in: U128(0),
            fee: U128(0),
        };
        let Some(m) = self.find_market(market_id.0) else {
            return none;
        };
        let (target, other) = m.sides(side_index(&side));
        match dpm::sell_after_fee(target, other, shares.0, self.fee_rate_bps) {
            Some((fee, refund, _)) => SellQuote {
                collateral_out: U128(refund),
                shares_in: shares,
                fee: U128(fee),
            },
            None => none,
        }
    }

    // While trading the pool must hold at least the cost of the shares outstanding, and after resolution at least one
    // unit for every winning share still to be paid.
    pub fn check_invariant(&self, market_id: U64) -> bool {
        let Some(m) = self.find_market(market_id.0) else {
            return false;
        };
        match m.outcome {
            None => dpm::cost_ceil(m.user_yes, m.user_no).is_some_and(|cost| m.locked >= cost),
            Some(_) if m.refunds => true,
            Some(o) => m.locked >= m.winners(o),
        }
    }
}

// NEP-145 on a flat deposit: every account pays STORAGE_DEPOSIT once, which is both the least and the most it can hold, so
// nothing is ever available to withdraw. Registering is open to a third party, who pays for someone else.
#[near]
impl StorageManagement for MarketContract {
    // The deposit registers `account_id`, or the caller when none is given. Whatever is not needed goes back to the caller,
    // all of it for an account that is already registered. registration_only changes nothing here, since the most an
    // account can hold is the least it must.
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only;
        let payer = env::predecessor_account_id();
        let who = account_id.unwrap_or_else(|| payer.clone());
        let paid = env::attached_deposit();
        let refund = if self.accounts.contains_key(&who) {
            paid
        } else {
            require!(paid >= STORAGE_DEPOSIT, "attach at least 0.05 NEAR");
            self.accounts.insert(who.clone(), 0);
            if payer != who && payer != self.verifier {
                self.registrations
                    .insert(who.clone(), Registration::Sponsored { payer: payer.clone() });
            }
            emit("registered", json!({ "account": who, "paid_by": payer }));
            paid.saturating_sub(STORAGE_DEPOSIT)
        };
        if !refund.is_zero() {
            // A deposit the verifier relays on behalf of a signer goes back to the account it was for, not to the verifier.
            let to = if payer == self.verifier { who } else { payer };
            let _ = Promise::new(to).transfer(refund);
        }
        Self::registered_balance()
    }

    // There is nothing above the flat deposit, so any amount above zero is refused.
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        require!(
            self.accounts.contains_key(&env::predecessor_account_id()),
            "the account is not registered"
        );
        require!(
            amount.is_none_or(|a| a.is_zero()),
            "nothing above the 0.05 NEAR deposit to withdraw"
        );
        Self::registered_balance()
    }

    // Closes an account that holds no positions and no balance and returns the deposit and yocto to whoever paid each.
    // An account that is not registered gets false. Burning what an account still holds is not offered.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        require!(
            force != Some(true),
            "force is not supported, redeem your shares and withdraw your balance first"
        );
        let who = env::predecessor_account_id();
        let Some(positions) = self.accounts.get(&who).copied() else {
            return false;
        };
        require!(positions == 0, "redeem or sell your positions first");
        require!(
            self.balances.get(&who).copied().unwrap_or(0) == 0,
            "withdraw your balance first"
        );
        // A failed withdrawal credits the balance back, which would be stranded if the account had already left.
        require!(
            self.pending_by_account.get(&who).copied().unwrap_or(0) == 0,
            "a withdrawal is still pending"
        );
        self.accounts.remove(&who);
        self.position_markets.remove(&who);
        self.balances.remove(&who);
        let deposit_to = match self.registrations.remove(&who) {
            None => {
                let _ = Promise::new(who.clone()).transfer(STORAGE_DEPOSIT.saturating_add(ONE_YOCTO));
                Some(who.clone())
            }
            Some(Registration::Sponsored { payer }) => {
                let _ = Promise::new(payer.clone()).transfer(STORAGE_DEPOSIT);
                let _ = Promise::new(who.clone()).transfer(ONE_YOCTO);
                Some(payer)
            }
            Some(Registration::Collateral) => {
                let _ = Promise::new(who.clone()).transfer(ONE_YOCTO);
                None
            }
        };
        emit("unregistered", json!({ "account": who, "deposit_to": deposit_to }));
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: STORAGE_DEPOSIT,
            max: Some(STORAGE_DEPOSIT),
        }
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts.contains_key(&account_id).then(Self::registered_balance)
    }
}

#[near]
impl FungibleTokenReceiver for MarketContract {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(
            self.collateral_token_id.strip_prefix(NEP141_PREFIX) == Some(token.as_str()),
            "only the collateral token can deliver money"
        );
        require!(
            sender_id != self.verifier,
            "send from your own account, not out of the verifier"
        );
        require!(amount.0 > 0, "amount must be positive");
        upgrade::require_gas(
            GAS_FORWARD_FLOOR,
            "the market moves the money into its Intents account before crediting it",
        );
        let mut parts = msg.split(':');
        let arrival = match parts.next() {
            Some("deposit") => {
                self.assert_can_deposit(&sender_id);
                Arrival::Deposit
            }
            Some("buy") => {
                let id: u64 = parse_part(parts.next(), "market id");
                let side = side_index(parts.next().unwrap_or(""));
                let min_out: u128 = parse_part(parts.next(), "min shares");
                self.market_to_buy(&sender_id, id, min_out);
                Arrival::Buy {
                    market_id: U64(id),
                    side,
                    min_shares: U128(min_out),
                }
            }
            _ => env::panic_str("unknown action"),
        };
        PromiseOrValue::Promise(
            ext_ft_core::ext(token)
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_FORWARD)
                .ft_transfer_call(
                    self.verifier.clone(),
                    amount,
                    None,
                    env::current_account_id().to_string(),
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_FORWARDED)
                        .on_forwarded(sender_id, amount, arrival),
                ),
        )
    }
}

// ---- private helpers ----------------------------------------------------------------------

impl Market {
    // Fixes the outcome, and whether the market pays back what holders put in: a Void does, and so does an answer
    // nobody holds a share of.
    fn resolve(&mut self, outcome: Outcome) {
        self.outcome = Some(outcome);
        self.refunds = outcome == Outcome::Void || self.winners(outcome) == 0;
    }

    fn winners(&self, outcome: Outcome) -> u128 {
        match outcome {
            Outcome::Yes => self.user_yes,
            Outcome::No => self.user_no,
            Outcome::Void => 0,
        }
    }

    fn has_payees(&self, outcome: Outcome) -> bool {
        if self.refunds {
            self.claims > 0
        } else {
            self.winners(outcome) > 0
        }
    }

    // What holders of `yes` and `no` shares redeem once the market has `outcome`.
    fn payout(&self, outcome: Outcome, yes: u128, no: u128, claim: u128) -> u128 {
        if self.refunds {
            return (claim * self.locked.min(self.claims))
                .checked_div(self.claims)
                .unwrap_or(0);
        }
        let held = match outcome {
            Outcome::Yes => yes,
            Outcome::No => no,
            Outcome::Void => 0,
        };
        dpm::winning_payout(held, self.winners(outcome), self.locked).unwrap_or(0)
    }

    fn status(&self, halted: bool) -> &'static str {
        if self.outcome.is_some() {
            "resolved"
        } else if halted {
            "halted"
        } else if env::block_timestamp() >= self.close_at {
            "closed"
        } else if !self.registered {
            "unregistered"
        } else {
            "open"
        }
    }

    fn sides(&self, idx: u8) -> (u128, u128) {
        if idx == 0 {
            (self.user_yes, self.user_no)
        } else {
            (self.user_no, self.user_yes)
        }
    }

    fn set_side(&mut self, idx: u8, shares: u128) {
        if idx == 0 {
            self.user_yes = shares;
        } else {
            self.user_no = shares;
        }
    }

    fn price_yes(&self) -> u128 {
        dpm::chance_micro(self.user_yes, self.user_no)
    }

    // Adds the shares and the Yes and No prices as they stand, so an indexer can follow the market without a view call.
    fn add_prices(&self, data: &mut near_sdk::serde_json::Value) {
        let price_yes = self.price_yes();
        data["price_yes"] = json!(price_yes.to_string());
        data["price_no"] = json!((1_000_000 - price_yes).to_string());
        data["yes_shares"] = json!(self.user_yes.to_string());
        data["no_shares"] = json!(self.user_no.to_string());
    }

    fn record_price(&mut self) {
        self.history.push((env::block_timestamp(), self.price_yes() as u32));
        if self.history.len() > HISTORY_MAX {
            self.history.remove(0);
        }
    }
}

impl MarketContract {
    fn registered_balance() -> StorageBalance {
        StorageBalance {
            total: STORAGE_DEPOSIT,
            available: NearToken::from_yoctonear(0),
        }
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn is_operator_or_owner(&self, who: &AccountId) -> bool {
        *who == self.operator || *who == self.owner
    }

    fn only_operator_or_owner(&self) {
        require!(
            self.is_operator_or_owner(&env::predecessor_account_id()),
            "operator or owner only"
        );
    }

    fn find_market(&self, id: u64) -> Option<Market> {
        self.markets.get(&id).cloned().map(VersionedMarket::into_current)
    }

    fn store_market(&mut self, id: u64, m: Market) {
        self.markets.insert(id, m.into());
    }

    fn find_sweep(&self, id: u64) -> Option<Sweep> {
        self.sweeps.get(&id).cloned().map(VersionedSweep::into_current)
    }

    fn store_sweep(&mut self, id: u64, sweep: Sweep) {
        let fresh = !self.sweeps.contains_key(&id);
        self.sweeps.insert(id, sweep.into());
        if fresh {
            self.sweeps.flush();
            self.assert_storage_reserve(0);
        }
    }

    fn find_withdrawal(&self, id: u64) -> Option<Withdrawal> {
        self.withdrawals
            .get(&id)
            .cloned()
            .map(VersionedWithdrawal::into_current)
    }

    fn store_withdrawal(&mut self, id: u64, w: Withdrawal) {
        self.withdrawals.insert(id, w.into());
    }

    fn market(&self, id: u64) -> Market {
        self.find_market(id).unwrap_or_else(|| env::panic_str("no such market"))
    }

    fn open_market(&self, id: u64) -> Market {
        let m = self.tradable_market(id);
        require!(!self.is_halted(id, &m), "market is halted");
        m
    }

    // A market a holder can still sell in, halted or not.
    fn tradable_market(&self, id: u64) -> Market {
        let m = self.market(id);
        require!(m.registered, "market is not registered with the oracle yet");
        require!(m.outcome.is_none(), "market is resolved");
        require!(env::block_timestamp() < m.close_at, "market is closed");
        m
    }

    fn is_halted(&self, id: u64, m: &Market) -> bool {
        m.halted
            && self
                .halt_until
                .get(&id)
                .is_none_or(|until| env::block_timestamp() < *until)
    }

    fn register_with_oracle(&self, id: u64) {
        let m = self.market(id);
        let _ = ext_oracle::ext(self.oracle.clone())
            .with_static_gas(GAS_REGISTER)
            .register_market(U64(id), U64(m.close_at), U64(m.resolve_by), m.rule_hash, m.price_rule)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_registered(U64(id)),
            );
    }

    fn sweep(&self, id: u64) -> Sweep {
        self.find_sweep(id)
            .unwrap_or_else(|| env::panic_str("no sweep to settle"))
    }

    fn leg_is(&self, id: u64, kind: LegKind, status: LegStatus) -> bool {
        self.find_sweep(id).is_some_and(|s| s.leg(kind).status == status)
    }

    // Ends a leg that was pending or unresolved. `kept` is how much of the leg its recipient has: all of it settles the leg,
    // anything less refuses it and returns the rest to the leg's own due bucket, which only the next sweep touches.
    fn end_leg(&mut self, id: u64, kind: LegKind, kept: u128) {
        let mut sweep = self.sweep(id);
        let leg = sweep.leg_mut(kind);
        let back = leg.amount.0.saturating_sub(kept);
        leg.status = if back == 0 {
            LegStatus::Settled
        } else {
            LegStatus::Refused
        };
        let (to, amount) = (leg.to.clone(), leg.amount.0);
        self.legs_in_flight_total -= amount;
        self.legs_in_flight_count -= 1;
        match kind {
            LegKind::Council => self.revenue_due += back,
            LegKind::Treasury => self.treasury_due += back,
        }
        self.store_sweep(id, sweep);
        if back == 0 {
            emit(
                "fee_leg_settled",
                json!({ "id": id.to_string(), "leg": kind, "to": to, "amount": amount.to_string() }),
            );
        } else {
            emit(
                "fee_transfer_failed",
                json!({ "id": id.to_string(), "leg": kind, "to": to, "amount": back.to_string() }),
            );
        }
    }

    fn park_council_leg(&mut self, id: u64) {
        let mut sweep = self.sweep(id);
        sweep.council.status = LegStatus::Unresolved;
        self.revenue_unresolved += sweep.council.amount.0;
        emit(
            "fee_transfer_unresolved",
            json!({ "id": id.to_string(), "leg": LegKind::Council, "to": sweep.council.to, "amount": sweep.council.amount }),
        );
        self.store_sweep(id, sweep);
    }

    fn credit(&mut self, who: &AccountId, amount: u128) {
        let have = self.balances.get(who).copied().unwrap_or(0);
        self.balances.insert(who.clone(), have + amount);
        self.balances_total += amount;
    }

    fn debit(&mut self, who: &AccountId, amount: u128) {
        let have = self.balances.get(who).copied().unwrap_or(0);
        let left = have
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("not enough balance"));
        self.balances.insert(who.clone(), left);
        self.balances_total -= amount;
    }

    fn assert_can_deposit(&self, who: &AccountId) {
        require!(!self.paused, "paused");
        require!(self.accounts.contains_key(who), "do the storage deposit first");
    }

    fn credit_deposit(&mut self, who: &AccountId, amount: u128) {
        self.credit(who, amount);
        emit("deposit", json!({ "account": who, "amount": amount.to_string() }));
    }

    fn register_with_collateral(&mut self, who: &AccountId, amount: u128) {
        require!(!self.paused, "paused");
        require!(!self.accounts.contains_key(who), "already registered");
        let fee = self.registration_fee;
        require!(amount >= fee, "send at least the registration fee");
        self.accounts.insert(who.clone(), 0);
        self.registrations.insert(who.clone(), Registration::Collateral);
        if amount > fee {
            self.credit(who, amount - fee);
        }
        self.accounts.flush();
        self.registrations.flush();
        self.balances.flush();
        self.assert_storage_reserve(0);
        self.treasury_due += fee;
        emit(
            "registered",
            json!({ "account": who, "paid_by": who, "fee": fee.to_string() }),
        );
    }

    fn market_to_buy(&self, who: &AccountId, id: u64, min_out: u128) -> Market {
        self.assert_can_deposit(who);
        require!(min_out > 0, "min shares must be above zero");
        self.open_market(id)
    }

    // Spend `amount` that has already left the buyer's balance (or arrived by mt_transfer_call). The fee comes out
    // of it first and only the rest enters the market.
    fn buy_with(&mut self, who: &AccountId, id: u64, idx: u8, amount: u128, min_out: u128) {
        let mut m = self.market_to_buy(who, id, min_out);
        let (target, other) = m.sides(idx);
        let (fee, out, grown) = dpm::buy_after_fee(target, other, amount, self.fee_rate_bps)
            .unwrap_or_else(|| env::panic_str("cannot buy that amount"));
        require!(
            out >= min_out,
            "price moved, you would get fewer shares than your minimum"
        );
        require!(
            m.locked + (amount - fee) <= self.market_cap_of(id),
            "this market has reached its cap"
        );

        self.add_shares(&mut m, who, id, idx, out);
        m.set_side(idx, grown);
        m.locked += amount - fee;
        self.locked_total += amount - fee;
        self.add_cost(&mut m, id, who, amount - fee, 0);
        m.record_price();
        let mut data = json!({ "market_id": id.to_string(), "account": who, "side": if idx == 0 { "yes" } else { "no" },
                    "shares": out.to_string(), "collateral": amount.to_string(), "fee": fee.to_string() });
        m.add_prices(&mut data);
        self.store_market(id, m);
        self.markets.flush();
        self.assert_storage_reserve(0);
        self.fees += fee;
        emit("buy", data);
    }

    fn claim_of(&self, id: u64, who: &AccountId) -> u128 {
        self.costs.get(&(id, who.clone())).map_or(0, |&net| positive(net))
    }

    fn add_cost(&mut self, m: &mut Market, id: u64, who: &AccountId, paid: u128, received: u128) {
        let key = (id, who.clone());
        let before = self.costs.get(&key).copied();
        m.claims -= before.map_or(0, positive);
        let n = self.accounts.get(who).copied().unwrap_or(0);
        let holds = self.shares.contains_key(&(id, who.clone(), 0)) || self.shares.contains_key(&(id, who.clone(), 1));
        if !holds {
            if before.is_some() {
                self.costs.remove(&key);
                self.accounts.insert(who.clone(), n.saturating_sub(1));
            }
            return;
        }
        let net = before.unwrap_or(0) + paid as i128 - received as i128;
        m.claims += positive(net);
        self.costs.insert(key, net);
        if before.is_none() {
            require!(
                n < self.max_positions || self.is_operator_or_owner(who),
                "too many positions, redeem or sell one first"
            );
            self.accounts.insert(who.clone(), n + 1);
            self.costs.flush();
            self.accounts.flush();
            self.assert_storage_reserve(0);
        }
    }

    fn market_cap_of(&self, id: u64) -> u128 {
        self.market_caps
            .get(&id)
            .map_or(self.max_market_locked, |&cap| cap.min(self.max_market_locked))
    }

    fn assert_storage_reserve(&self, refund: u128) {
        let locked = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        require!(
            env::account_balance().as_yoctonear().saturating_sub(locked) >= self.storage_reserve.saturating_add(refund),
            "storage reserve reached; top up before adding records"
        );
    }

    fn is_exempt(&self, who: &AccountId) -> bool {
        self.exempt_accounts.get(who).copied().unwrap_or(false)
    }

    fn make_exempt(&mut self, who: &AccountId) {
        if self.is_exempt(who) {
            return;
        }
        let count = self.position_markets.get(who).map_or(0, |ids| ids.len() as u32);
        self.position_counts.insert(who.clone(), count);
        self.position_markets.remove(who);
        self.exempt_accounts.insert(who.clone(), true);
    }

    fn add_shares(&mut self, m: &mut Market, who: &AccountId, id: u64, idx: u8, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (id, who.clone(), idx);
        let have = self.shares.get(&key).copied().unwrap_or(0);
        let fresh = have == 0;
        if fresh {
            let n = self.accounts.get(who).copied().unwrap_or(0);
            require!(
                n < self.max_positions || self.is_operator_or_owner(who),
                "too many positions, redeem or sell one first"
            );
            self.accounts.insert(who.clone(), n + 1);
            if !self.shares.contains_key(&(id, who.clone(), 1 - idx)) {
                m.holders += 1;
                if self.is_exempt(who) {
                    if let Some(count) = self.position_counts.get(who).copied().or_else(|| (n == 0).then_some(0)) {
                        self.position_counts.insert(who.clone(), count + 1);
                    }
                } else {
                    let mut ids = self.position_markets.get(who).cloned().unwrap_or_default();
                    if let Err(at) = ids.binary_search(&id) {
                        ids.insert(at, id);
                    }
                    self.position_markets.insert(who.clone(), ids);
                }
            }
        }
        self.shares.insert(key, have + amount);
        if fresh {
            self.shares.flush();
            self.accounts.flush();
            self.position_markets.flush();
            self.position_counts.flush();
            self.assert_storage_reserve(0);
        }
    }

    fn take_shares(&mut self, m: &mut Market, who: &AccountId, id: u64, idx: u8, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (id, who.clone(), idx);
        let have = self.shares.get(&key).copied().unwrap_or(0);
        let left = have
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("not enough shares"));
        if left == 0 {
            self.shares.remove(&key);
            let n = self.accounts.get(who).copied().unwrap_or(1);
            self.accounts.insert(who.clone(), n.saturating_sub(1));
            if !self.shares.contains_key(&(id, who.clone(), 1 - idx)) {
                m.holders = m.holders.checked_sub(1).expect("holder count underflow");
                if self.is_exempt(who) {
                    if let Some(count) = self.position_counts.get(who).copied() {
                        self.position_counts
                            .insert(who.clone(), count.checked_sub(1).expect("position count underflow"));
                    } else if n == 1 {
                        // The last legacy share entry just burned; future totals are exact again.
                        self.position_counts.insert(who.clone(), 0);
                    }
                } else {
                    let mut ids = self.position_markets.get(who).cloned().unwrap_or_default();
                    if let Ok(at) = ids.binary_search(&id) {
                        ids.remove(at);
                    }
                    if ids.is_empty() {
                        self.position_markets.remove(who);
                    } else {
                        self.position_markets.insert(who.clone(), ids);
                    }
                }
            }
        } else {
            self.shares.insert(key, left);
        }
    }

    fn view(&self, id: u64, m: &Market) -> MarketView {
        let price_yes = m.price_yes();
        MarketView {
            id: U64(id),
            title: m.title.clone(),
            rule_text: m.rule_text.clone(),
            resolution_source: m.resolution_source.clone(),
            void_policy: m.void_policy.clone(),
            category: m.category.clone(),
            subcategory: m.subcategory.clone(),
            rule_hash: m.rule_hash.clone(),
            price_rule: m.price_rule,
            close_at: U64(m.close_at),
            resolve_by: U64(m.resolve_by),
            status: m.status(self.is_halted(id, m)).to_string(),
            registered: m.registered,
            outcome: m.outcome,
            refunds: m.refunds,
            price_yes: U128(price_yes),
            price_no: U128(1_000_000 - price_yes),
            yes_shares: U128(m.user_yes),
            no_shares: U128(m.user_no),
            locked: U128(m.locked),
            holders: m.holders,
            pruned: m.pruned,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> Market {
        Market {
            title: String::new(),
            rule_text: String::new(),
            resolution_source: String::new(),
            void_policy: String::new(),
            category: String::new(),
            subcategory: String::new(),
            rule_hash: String::new(),
            price_rule: None,
            close_at: 0,
            resolve_by: 0,
            void_grace_ns: VOID_GRACE_NS,
            halted: false,
            registered: true,
            outcome: None,
            refunds: false,
            locked: 0,
            user_yes: 0,
            user_no: 0,
            claims: 0,
            history: vec![],
            holders: 0,
            pruned: false,
        }
    }

    #[test]
    fn price_log_records_the_current_price_and_never_grows_past_the_cap() {
        let mut m = blank();
        m.user_no = 100;
        for i in 0..(HISTORY_MAX + 30) as u128 {
            m.user_yes = 100 + i;
            m.record_price();
        }
        assert_eq!(m.history.len(), HISTORY_MAX);
        let last = m.history.last().unwrap().1 as u128;
        assert_eq!(last, dpm::chance_micro(m.user_yes, m.user_no));
    }

    #[test]
    fn category_slugs_are_short_lowercase_words() {
        for good in ["sports", "nfl", "college-football", "f1", "world-cup"] {
            assert!(valid_slug(good), "{good}");
        }
        for bad in ["", "Sports", "us elections", "nfl!", "../x", &"a".repeat(33)] {
            assert!(!valid_slug(bad), "{bad}");
        }
    }

    // ---- contract-level properties: the real methods under random sequences of trades -------------

    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use proptest::prelude::*;

    const OWNER: &str = "owner.near";
    const ORACLE: &str = "oracle.near";
    const VERIFIER: &str = "intents.near";
    const TOKEN: &str = "usdc.near";
    const COLLATERAL_ID: &str = "nep141:usdc.near";
    const COUNCIL: &str = "council.near";
    const TREASURY: &str = "treasury.near";
    const USERS: [&str; 3] = ["ann.near", "ben.near", "cat.near"];
    const SEED_UNITS: u128 = 100_000_000; // 100 in 6-decimal units
    const CLOSE: u64 = 10_000;
    const RESOLVE_BY: u64 = 20_000;
    // The moment the market's own emergency void opens.
    const VOID_OPEN: u64 = RESOLVE_BY + VOID_GRACE_NS;

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    // What the verifier calls after a user's mt_transfer_call. The caller must already be acting as the verifier.
    fn receive(c: &mut MarketContract, from: AccountId, amount: U128, msg: String) -> Vec<U128> {
        c.mt_on_transfer(
            from.clone(),
            vec![from],
            vec![COLLATERAL_ID.to_string()],
            vec![amount],
            msg,
        )
    }

    // Every call carries the one yocto that buy and sell need.
    fn act_as(who: &str, now_ns: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .block_timestamp(now_ns)
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
    }

    fn act_unpaid(who: &str, now_ns: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .block_timestamp(now_ns)
            .build());
    }

    impl MarketContract {
        fn create_paid(
            &mut self,
            title: String,
            rule_text: String,
            resolution_source: String,
            void_policy: String,
            category: String,
            subcategory: String,
            close_at: U64,
            resolve_by: U64,
            price_rule: Option<PriceRule>,
        ) -> U64 {
            let who = env::predecessor_account_id();
            let now = env::block_timestamp();
            testing_env!(VMContextBuilder::new()
                .predecessor_account_id(who.clone())
                .block_timestamp(now)
                .attached_deposit(NearToken::from_yoctonear(self.market_storage_deposit))
                .build());
            self.create_market(
                title,
                rule_text,
                resolution_source,
                void_policy,
                category,
                subcategory,
                close_at,
                resolve_by,
                price_rule,
            )
        }
    }

    // Two open markets, three registered users, and the fee recipients set. Returns the contract and the total tokens
    // received so far.
    fn world() -> (MarketContract, u128) {
        let (mut c, total_in) = unconfigured_world();
        act_as(OWNER, 2);
        c.set_fee_recipients(acct(COUNCIL), acct(TREASURY));
        (c, total_in)
    }

    // The same, as it is deployed: nobody has said yet where fees go.
    fn unconfigured_world() -> (MarketContract, u128) {
        // The mock chain keeps its storage between cases; start each one empty.
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as(OWNER, 1);
        let mut c = MarketContract::new(
            acct(OWNER),
            acct(OWNER),
            acct(ORACLE),
            acct(VERIFIER),
            COLLATERAL_ID.to_string(),
        );
        for _ in 0..2 {
            c.create_paid(
                "t".into(),
                "r".into(),
                "s".into(),
                "v".into(),
                "sports".into(),
                "nfl".into(),
                U64(CLOSE),
                U64(RESOLVE_BY),
                None,
            );
        }
        // Skip the oracle round trip: mark both as registered.
        for id in 0..2 {
            let mut m = c.market(id);
            m.registered = true;
            c.store_market(id, m);
        }
        for u in USERS.iter().chain([&OWNER]) {
            c.accounts.insert(acct(u), 0);
        }
        (c, 0)
    }

    fn holdings(c: &MarketContract, id: u64, who: &str) -> (u128, u128) {
        let (y, n) = c.get_shares(U64(id), acct(who));
        (y.0, n.0)
    }

    // Every token the contract has received is locked in a market, sitting in someone's balance, or a fee.
    fn assert_conserved(c: &MarketContract, total_in: u128) {
        let locked: u128 = (0..2).map(|id| c.market(id).locked).sum();
        let balances: u128 = USERS.iter().chain([&OWNER]).map(|u| c.get_balance(acct(u)).0).sum();
        assert_eq!(c.locked_total, locked, "locked_total drifted from the markets");
        assert_eq!(
            locked
                + balances
                + c.fees
                + c.revenue_due
                + c.treasury_due
                + c.revenue_unresolved
                + c.pending_withdrawals_total,
            total_in,
            "money was created or lost"
        );
        assert_eq!(
            c.total_owed().0,
            total_in,
            "total_owed disagrees with what was received"
        );
        for id in 0..2 {
            assert!(
                c.check_invariant(U64(id)),
                "collateral no longer matches shares in market {id}"
            );
        }
    }

    fn step(c: &mut MarketContract, total_in: &mut u128, op: u8, user: usize, id: u64, amount: u128, frac: u128) {
        let who = USERS[user];
        match op {
            // buy Yes or No by sending tokens in one transfer
            0 | 1 => {
                act_as(VERIFIER, 3);
                let side = if op == 0 { "yes" } else { "no" };
                let _ = receive(c, acct(who), U128(amount), format!("buy:{id}:{side}:1"));
                *total_in += amount;
            }
            // sell part of a holding
            2 | 3 => {
                let (y, n) = holdings(c, id, who);
                let (held, side) = if op == 2 { (y, "yes") } else { (n, "no") };
                let offer = held * frac / 100;
                let q = c.quote_sell(U64(id), side.to_string(), U128(offer));
                if q.collateral_out.0 > q.fee.0 {
                    act_as(who, 3);
                    c.sell(U64(id), side.to_string(), U128(offer), U128(1));
                }
            }
            // deposit, then buy out of the balance
            4 => {
                act_as(VERIFIER, 3);
                let _ = receive(c, acct(who), U128(amount), "deposit".to_string());
                *total_in += amount;
                act_as(who, 3);
                c.buy(U64(id), "yes".to_string(), U128(amount / 2 + 1), U128(1));
            }
            _ => {
                let (y, _) = holdings(c, id, who);
                let offer = y * frac / 100;
                let q = c.quote_sell(U64(id), "yes".to_string(), U128(offer));
                if q.collateral_out.0 > q.fee.0 {
                    act_as(VERIFIER, 3);
                    let _ = c.on_auth(acct(who), format!("sell:{id}:yes:{offer}:1"));
                }
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        // Whatever the sequence, collateral matches shares, no money appears or vanishes, and once every market is
        // resolved and everyone has redeemed, nothing is left locked.
        #[test]
        fn random_trading_never_breaks_the_books(
            ops in proptest::collection::vec((0u8..6, 0usize..3, 0u64..2, 1_000_000u128..40_000_000, 1u128..101), 1..60),
            outcomes in proptest::collection::vec(0u8..3, 2),
            claim_first in any::<bool>()
        ) {
            let (mut c, mut total_in) = world();
            for (op, user, id, amount, frac) in ops {
                step(&mut c, &mut total_in, op, user, id, amount, frac);
                assert_conserved(&c, total_in);
            }

            // Resolve each market.
            act_as(ORACLE, CLOSE + 1);
            for id in 0..2u64 {
                let outcome = [Outcome::Yes, Outcome::No, Outcome::Void][outcomes[id as usize] as usize];
                c.set_outcome(U64(id), outcome);
            }
            // The leftover cannot be taken while anyone is still owed a payout.
            if claim_first {
                act_as(OWNER, CLOSE + 2);
                for id in 0..2u64 {
                    let m = c.market(id);
                    if m.has_payees(m.outcome.unwrap()) {
                        prop_assert!(refused(|| c.claim_residual(U64(id))));
                    }
                }
                assert_conserved(&c, total_in);
            }
            for id in 0..2u64 {
                for u in USERS {
                    let (y, n) = holdings(&c, id, u);
                    if y + n > 0 {
                        act_as(u, CLOSE + 3);
                        c.redeem(U64(id));
                    }
                    assert_conserved(&c, total_in);
                }
            }
            act_as(OWNER, CLOSE + 4);
            for id in 0..2u64 {
                if c.market(id).locked > 0 {
                    c.claim_residual(U64(id));
                }
                prop_assert_eq!(c.market(id).locked, 0, "collateral left locked after everyone was paid");
                prop_assert_eq!(c.market(id).claims, 0);
            }
            assert_conserved(&c, total_in);
        }
    }

    #[test]
    fn the_quoted_fee_is_the_fee_charged_on_a_buy_and_a_sell() {
        let (mut c, _) = world();
        assert_eq!(c.fees, 0, "a market opens without a seed or a creation fee");
        let q = c.quote_buy(U64(0), "yes".into(), U128(10_000_000));
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        assert_eq!(holdings(&c, 0, USERS[0]).0, q.shares_out.0);
        assert_eq!(c.fees, q.fee.0);
        assert_eq!(c.market(0).locked, 10_000_000 - q.fee.0);

        let s = c.quote_sell(U64(0), "yes".into(), q.shares_out);
        assert_eq!(s.shares_in, q.shares_out);
        act_as(USERS[0], 4);
        c.sell(U64(0), "yes".into(), q.shares_out, U128(s.collateral_out.0 - s.fee.0));
        assert_eq!(c.get_balance(acct(USERS[0])).0, s.collateral_out.0 - s.fee.0);
        assert_eq!(c.fees, q.fee.0 + s.fee.0);
        let back = s.collateral_out.0 - s.fee.0;
        assert!(
            10_000_000 - back >= q.fee.0 + s.fee.0,
            "the round trip lost at least both fees"
        );
        assert!(c.check_invariant(U64(0)));
    }

    fn swept() -> near_sdk::serde_json::Value {
        let logs = near_sdk::test_utils::get_logs();
        let j: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(logs.last().unwrap().strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(j["event"], "fees_swept");
        j["data"].clone()
    }

    #[test]
    fn a_sweep_splits_25_75_keeps_the_rounding_and_a_failed_transfer_stays_owed_to_its_recipient() {
        let (mut c, _) = world();
        c.fees = 1_000_003;
        act_as(USERS[2], 5);
        assert_eq!(c.sweep_fees(), Some(U64(1)));
        let d = swept();
        assert_eq!(
            (d["council"].as_str(), d["treasury"].as_str(), d["total"].as_str()),
            (Some("250000"), Some("750002"), Some("1000003"))
        );
        assert_eq!(
            (c.fees, c.revenue_due, c.treasury_due),
            (1, 0, 0),
            "one unit of rounding stays collected"
        );

        // The treasury refuses its transfer and the Council takes only part of its share.
        c.on_treasury_sent(U64(1), Err(PromiseError::Failed));
        c.on_revenue_sent(U64(1), Ok(vec![U128(249_000)]));
        assert_eq!((c.fees, c.revenue_due, c.treasury_due), (1, 1_000, 750_002));

        // The next sweep resends each due to its own recipient under a new id; nothing is split again.
        act_as(OWNER, 6);
        c.set_min_sweep(U128(1));
        act_as(USERS[2], 6 + MIN_SWEEP_INTERVAL_NS);
        assert_eq!(c.sweep_fees(), Some(U64(2)));
        let d = swept();
        assert_eq!(
            (d["council"].as_str(), d["treasury"].as_str(), d["total"].as_str()),
            (Some("1000"), Some("750002"), Some("1"))
        );
        assert_eq!((c.fees, c.revenue_due, c.treasury_due), (1, 0, 0));

        // Nothing due: a sweep does nothing.
        act_as(USERS[2], 7);
        assert_eq!(c.sweep_fees(), None);
        assert!(near_sdk::test_utils::get_logs().is_empty());
        assert_eq!((c.fees, c.revenue_due, c.treasury_due), (1, 0, 0));
    }

    #[test]
    #[should_panic(expected = "the answer deadline and the 7 day grace period have not passed")]
    fn nobody_can_void_a_market_between_its_deadline_and_the_end_of_the_grace_period() {
        let (mut c, _) = world();
        act_as(ORACLE, VOID_OPEN - 1);
        c.void_if_unresolved(U64(0));
    }

    #[test]
    #[should_panic(expected = "the answer deadline and the 7 day grace period have not passed")]
    fn the_deadline_alone_does_not_open_the_emergency_void() {
        let (mut c, _) = world();
        act_as(ORACLE, RESOLVE_BY);
        c.void_if_unresolved(U64(0));
    }

    fn net_in(amount: u128) -> u128 {
        amount - dpm::fee(amount, DEFAULT_FEE_RATE_BPS).unwrap()
    }

    #[test]
    fn after_the_deadline_anyone_can_void_and_each_holder_gets_back_what_they_put_in() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1); // ann buys Yes
        step(&mut c, &mut total_in, 1, 1, 0, 4_000_000, 1); // ben buys No
        act_as(USERS[2], VOID_OPEN); // a stranger, once the grace period is over
        c.void_if_unresolved(U64(0));
        assert_eq!(c.market(0).outcome, Some(Outcome::Void));
        assert!(c.market(0).refunds && c.get_market(U64(0)).unwrap().refunds);

        act_as(USERS[0], VOID_OPEN + 1);
        assert_eq!(c.redeem(U64(0)).0, net_in(10_000_000));
        act_as(USERS[1], VOID_OPEN + 1);
        assert_eq!(c.redeem(U64(0)).0, net_in(4_000_000));
        assert_eq!(c.market(0).locked, 0);
        assert_conserved(&c, total_in);
    }

    // A profit-taker has already taken more out than they put in, so what is left cannot repay everyone in full. The
    // holders still in share it in proportion to what each put in.
    #[test]
    fn a_void_after_a_profit_taker_left_scales_every_refund_down_alike() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 1, 2, 0, 10_000_000, 1); // cat buys No
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1); // ann buys the cheap Yes
        step(&mut c, &mut total_in, 0, 1, 0, 30_000_000, 1); // ben piles into Yes after her
        step(&mut c, &mut total_in, 2, 0, 0, 0, 100); // ann sells all her Yes at a profit
        assert!(c.get_balance(acct(USERS[0])).0 > 10_000_000, "ann left with a profit");
        assert_eq!(c.claim_of(0, &acct(USERS[0])), 0, "an exit is final");

        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(0));
        let m = c.market(0);
        let (ben, cat) = (net_in(30_000_000), net_in(10_000_000));
        assert_eq!(m.claims, ben + cat);
        assert!(m.locked < m.claims, "the pool is short of what the holders put in");
        act_as(USERS[1], VOID_OPEN + 1);
        assert_eq!(c.redeem(U64(0)).0, ben * m.locked / m.claims);
        act_as(USERS[2], VOID_OPEN + 1);
        let cat_paid = c.redeem(U64(0)).0;
        assert!(cat_paid >= cat * m.locked / m.claims, "{cat_paid}");
        assert_eq!(c.market(0).locked, 0, "the last refund takes what rounding left");
        assert_conserved(&c, total_in);
    }

    // A sale takes what it fetched off the position's record, so a holder who sold part before a Void is paid back what
    // is left of what they put in.
    #[test]
    fn a_partial_sale_before_a_void_comes_off_the_refund() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1); // ann buys Yes
        step(&mut c, &mut total_in, 1, 1, 0, 10_000_000, 1); // ben buys No
        let half = holdings(&c, 0, USERS[0]).0 / 2;
        let fetched = c.quote_sell(U64(0), "yes".into(), U128(half)).collateral_out.0;
        step(&mut c, &mut total_in, 2, 0, 0, 0, 50); // ann sells half her Yes
        assert_eq!(c.claim_of(0, &acct(USERS[0])), net_in(10_000_000) - fetched);

        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(0));
        act_as(USERS[0], VOID_OPEN + 1);
        assert_eq!(c.redeem(U64(0)).0, net_in(10_000_000) - fetched);
        act_as(USERS[1], VOID_OPEN + 1);
        assert_eq!(c.redeem(U64(0)).0, net_in(10_000_000));
        assert_eq!(c.market(0).locked, 0);
        assert_conserved(&c, total_in);
    }

    // ---- get_positions -------------------------------------------------------------------------------------

    // Ann holds both sides of markets 0 to 3. Markets 2 and 3 are made here, so the order of ids is the order of creation.
    fn positions_world() -> MarketContract {
        let (mut c, mut total_in) = world();
        for _ in 0..2 {
            create_registered(&mut c, OWNER);
        }
        for id in 0..4 {
            step(&mut c, &mut total_in, 0, 0, id, 10_000_000, 1);
            step(&mut c, &mut total_in, 1, 0, id, 4_000_000, 1);
        }
        c
    }

    // Market 1 resolves Yes, market 2 No, market 3 is voided, market 0 is left unresolved.
    fn resolve_positions_world(c: &mut MarketContract) {
        act_as(ORACLE, CLOSE + 1);
        c.set_outcome(U64(1), Outcome::Yes);
        c.set_outcome(U64(2), Outcome::No);
        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(3));
    }

    fn positions_json(c: &MarketContract, who: &str) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::to_value(c.get_positions(acct(who), None, None)).unwrap()
    }

    #[test]
    fn positions_of_an_open_market_show_the_shares_and_redeem_nothing() {
        let c = positions_world();
        act_as(USERS[0], 7);
        let (yes, no) = holdings(&c, 0, USERS[0]);
        assert_eq!(
            positions_json(&c, USERS[0])[0],
            json!({ "market_id": "0", "yes": yes.to_string(), "no": no.to_string(), "status": "open",
                    "outcome": null, "redeemable": "0" })
        );
        for p in c.get_positions(acct(USERS[0]), None, None) {
            assert_eq!((p.status.as_str(), p.redeemable.0), ("open", 0));
        }
    }

    // Ann is the only holder of each market, so whatever the answer, a Void included, she redeems the whole pool.
    #[test]
    fn positions_of_resolved_markets_show_the_outcome_and_the_exact_payout() {
        let mut c = positions_world();
        resolve_positions_world(&mut c);
        let held = |id| holdings(&c, id, USERS[0]);
        let pool = |id| c.market(id).locked.to_string();
        let ((y1, n1), (y2, n2), (y3, n3), (y0, n0)) = (held(1), held(2), held(3), held(0));
        assert_eq!(c.claim_of(3, &acct(USERS[0])), net_in(10_000_000) + net_in(4_000_000));
        assert_eq!(
            positions_json(&c, USERS[0]),
            json!([
                { "market_id": "0", "yes": y0.to_string(), "no": n0.to_string(), "status": "closed",
                  "outcome": null, "redeemable": "0" },
                { "market_id": "1", "yes": y1.to_string(), "no": n1.to_string(), "status": "resolved",
                  "outcome": "yes", "redeemable": pool(1) },
                { "market_id": "2", "yes": y2.to_string(), "no": n2.to_string(), "status": "resolved",
                  "outcome": "no", "redeemable": pool(2) },
                { "market_id": "3", "yes": y3.to_string(), "no": n3.to_string(), "status": "resolved",
                  "outcome": "void", "redeemable": pool(3) },
            ])
        );
    }

    #[test]
    fn what_positions_say_is_redeemable_is_what_redeem_credits() {
        let mut c = positions_world();
        resolve_positions_world(&mut c);
        for p in c.get_positions(acct(USERS[0]), None, None) {
            if p.outcome.is_none() {
                continue;
            }
            let before = c.get_balance(acct(USERS[0])).0;
            act_as(USERS[0], VOID_OPEN + 1);
            let paid = c.redeem(p.market_id).0;
            assert_eq!(paid, p.redeemable.0, "market {}", p.market_id.0);
            assert_eq!(c.get_balance(acct(USERS[0])).0 - before, p.redeemable.0);
        }
        // Redeemed positions are gone; only the unresolved market is left.
        let left = c.get_positions(acct(USERS[0]), None, None);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].market_id.0, 0);
    }

    #[test]
    fn positions_are_empty_for_an_account_with_none_and_for_an_unknown_one() {
        let c = positions_world();
        act_as(USERS[1], 7);
        assert!(c.get_positions(acct(USERS[1]), None, None).is_empty());
        assert!(c.get_positions(acct("nobody.near"), None, None).is_empty());
    }

    #[test]
    fn positions_come_in_market_id_order_and_skip_markets_without_shares() {
        let (mut c, mut total_in) = world();
        for _ in 0..3 {
            create_registered(&mut c, OWNER);
        }
        for id in [4, 0, 3] {
            step(&mut c, &mut total_in, 1, 1, id, 3_000_000, 1);
        }
        act_as(USERS[1], 7);
        let ids: Vec<u64> = c
            .get_positions(acct(USERS[1]), None, None)
            .iter()
            .map(|p| p.market_id.0)
            .collect();
        assert_eq!(ids, vec![0, 3, 4]);
    }

    #[test]
    fn reading_positions_changes_no_state() {
        let mut c = positions_world();
        resolve_positions_world(&mut c);
        let snapshot = |c: &MarketContract| {
            let markets: Vec<Vec<u8>> = (0..4)
                .map(|id| near_sdk::borsh::to_vec(&c.market(id)).unwrap())
                .collect();
            (
                markets,
                c.accounts.get(&acct(USERS[0])).copied(),
                c.get_balance(acct(USERS[0])),
                c.locked_total,
                c.fees,
            )
        };
        let before = snapshot(&c);
        let _ = c.get_positions(acct(USERS[0]), None, None);
        let _ = c.get_positions(acct(USERS[0]), None, None);
        assert!(before == snapshot(&c));
    }

    // A position in a market is a share entry and the record of what was put in, so the cap holds half as many markets.
    #[test]
    fn an_account_at_the_position_cap_gets_every_position() {
        let (mut c, _) = world();
        let markets = MAX_POSITIONS / 2;
        for i in 0..markets {
            let id = create_registered(&mut c, OWNER);
            act_as(VERIFIER, 7);
            let _ = receive(&mut c, acct(USERS[0]), U128(1_000_000), format!("buy:{id}:yes:1"));
            assert_eq!(c.get_positions(acct(USERS[0]), None, None).len() as u32, i + 1);
        }
        assert_eq!(c.accounts.get(&acct(USERS[0])).copied(), Some(MAX_POSITIONS));
        act_as(USERS[0], 7);
        let ids: Vec<u64> = c
            .get_positions(acct(USERS[0]), None, None)
            .iter()
            .map(|p| p.market_id.0)
            .collect();
        assert_eq!(ids, (2..2 + u64::from(markets)).collect::<Vec<_>>());
        act_as(VERIFIER, 8);
        assert!(refused(|| {
            let _ = receive(&mut c, acct(USERS[0]), U128(1_000_000), "buy:0:yes:1".into());
        }));
    }

    // ---- owner-set fees, with ceilings ------------------------------------------------------------

    #[test]
    fn the_owner_sets_the_trade_fee_and_the_next_trade_pays_it() {
        let (mut c, _) = world();
        let at_default = c.quote_buy(U64(0), "yes".into(), U128(10_000_000)).fee.0;
        act_as(OWNER, 5);
        c.set_fee_rate_bps(400);
        assert_eq!(c.config()["fee_rate_bps"], 400);
        let at_double = c.quote_buy(U64(0), "yes".into(), U128(10_000_000)).fee.0;
        assert!(
            at_double > at_default * 19 / 10 && at_double < at_default * 21 / 10,
            "twice the rate, about twice the fee: {at_default} then {at_double}"
        );

        // The quote is what is charged.
        act_as(VERIFIER, 6);
        let q = c.quote_buy(U64(0), "yes".into(), U128(10_000_000));
        let fees_before = c.fees;
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        assert_eq!(c.fees - fees_before, q.fee.0);

        act_as(OWNER, 7);
        c.set_fee_rate_bps(0);
        assert_eq!(
            c.quote_buy(U64(0), "yes".into(), U128(10_000_000)).fee.0,
            0,
            "a rate of zero is allowed"
        );
    }

    #[test]
    fn the_ceiling_is_allowed_and_one_above_it_is_refused() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_fee_rate_bps(500);
        assert!(refused(|| c.set_fee_rate_bps(501)));
        assert_eq!(c.config()["fee_rate_bps"], 500);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn the_operator_cannot_change_the_trade_fee() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        act_as("ops.near", 6);
        c.set_fee_rate_bps(1);
    }

    // ---- opening without a seed ------------------------------------------------------------------

    fn fund(c: &mut MarketContract, id: u64, yes: u128, no: u128) {
        act_as(VERIFIER, 3);
        let _ = receive(c, acct(OWNER), U128(yes), format!("buy:{id}:yes:1"));
        let _ = receive(c, acct(OWNER), U128(no), format!("buy:{id}:no:1"));
    }

    #[test]
    fn a_market_opens_for_trading_with_no_seed_and_the_first_buyer_pays_a_unit_a_share() {
        let (mut c, mut total_in) = world();
        let view = c.get_market(U64(0)).unwrap();
        assert_eq!(
            (view.status.as_str(), view.locked.0, view.price_yes.0),
            ("open", 0, 500_000)
        );
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1);
        let shares = holdings(&c, 0, USERS[0]).0;
        assert_eq!(
            shares,
            net_in(10_000_000),
            "with nobody on the other side a share costs one unit"
        );
        let view = c.get_market(U64(0)).unwrap();
        assert_eq!(
            (view.price_yes.0, view.yes_shares.0, view.no_shares.0),
            (1_000_000, shares, 0)
        );
        step(&mut c, &mut total_in, 1, 1, 0, 10_000_000, 1);
        assert!(
            holdings(&c, 0, USERS[1]).1 > net_in(10_000_000),
            "the other side is cheaper"
        );
        assert!(c.check_invariant(U64(0)));
        assert_conserved(&c, total_in);
    }

    #[test]
    #[should_panic(expected = "unknown action")]
    fn a_seed_is_no_longer_a_way_in() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(OWNER), U128(SEED_UNITS), "seed:0".into());
    }

    #[test]
    fn a_late_buyer_on_the_side_that_wins_still_gets_back_at_least_what_they_paid() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1); // ann buys Yes early
        step(&mut c, &mut total_in, 1, 1, 0, 10_000_000, 1); // ben buys No
        step(&mut c, &mut total_in, 0, 2, 0, 30_000_000, 1); // cat piles into Yes late
        act_as(ORACLE, CLOSE + 1);
        c.set_outcome(U64(0), Outcome::Yes);
        assert!(!c.market(0).refunds);
        for (who, paid) in [(USERS[0], 10_000_000), (USERS[2], 30_000_000)] {
            act_as(who, CLOSE + 2);
            assert!(c.redeem(U64(0)).0 >= net_in(paid), "{who}");
        }
        act_as(USERS[1], CLOSE + 2);
        assert_eq!(c.redeem(U64(0)).0, 0, "the losing side is paid nothing");
        assert_eq!(c.market(0).locked, 0);
        assert_conserved(&c, total_in);
    }

    #[test]
    fn an_answer_nobody_holds_pays_everyone_back_like_a_void() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1);
        step(&mut c, &mut total_in, 0, 1, 0, 5_000_000, 1);
        act_as(ORACLE, CLOSE + 1);
        c.set_outcome(U64(0), Outcome::No);
        assert!(c.market(0).refunds, "nobody holds No");
        for (who, paid) in [(USERS[0], 10_000_000), (USERS[1], 5_000_000)] {
            act_as(who, CLOSE + 2);
            assert_eq!(c.redeem(U64(0)).0, net_in(paid), "{who}");
        }
        assert_conserved(&c, total_in);
    }

    // ---- attacks: economics -----------------------------------------------------------------------

    const ATTACKER: &str = "ben.near";
    const VICTIM: &str = "ann.near";

    struct Sandwich {
        // Whether the victim's buy went through.
        filled: bool,
        // Shares the victim ended with, and what they were quoted before the front-run.
        victim_shares: u128,
        quoted: u128,
        // The attacker's profit from buying ahead of the victim and selling everything straight after. Negative is a loss.
        attacker_profit: i128,
    }

    // An attacker buys `front` of Yes ahead of a victim's buy of `victim` collateral, which carries a minimum of
    // `tolerance_bps` below the quote the victim saw, then sells everything back.
    fn sandwich(front: u128, victim: u128, tolerance_bps: u128) -> Sandwich {
        let (mut c, _) = world();
        fund(&mut c, 0, SEED_UNITS / 2, SEED_UNITS / 2);
        let quoted = c.quote_buy(U64(0), "yes".into(), U128(victim)).shares_out.0;
        let min_out = quoted * (10_000 - tolerance_bps) / 10_000;

        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(ATTACKER), U128(front), "buy:0:yes:1".into());
        act_as(VERIFIER, 4);
        let filled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = receive(&mut c, acct(VICTIM), U128(victim), format!("buy:0:yes:{min_out}"));
        }))
        .is_ok();

        let (held, _) = holdings(&c, 0, ATTACKER);
        act_as(ATTACKER, 5);
        c.sell(U64(0), "yes".into(), U128(held), U128(1));
        assert!(c.check_invariant(U64(0)));
        Sandwich {
            filled,
            victim_shares: holdings(&c, 0, VICTIM).0,
            quoted,
            attacker_profit: c.get_balance(acct(ATTACKER)).0 as i128 - front as i128,
        }
    }

    // A buyer's minimum is the defence, and it does what it says: whatever the attacker does, the victim either gets at
    // least their minimum or is refused and keeps their money. It protects the victim, not the pool. An attacker who
    // buys ahead of a large order still profits from the price that order moves, and that comes out of the pool. That
    // is true of every automated market and is measured here, not prevented.
    #[test]
    fn a_buyers_minimum_bounds_what_a_sandwich_can_take_from_the_buyer() {
        let victim = 20_000_000u128;
        let fronts = [
            10_000u128, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000,
            40_000_000,
        ];
        let mut report = String::from("\nsandwich of a 20,000,000 buy on a pool of 100,000,000 bought on both sides\n");
        for tolerance in [0u128, 10, 50, 100, 500, 2_000, 10_000] {
            let (mut worst_harm_bps, mut best_profit, mut best_front, mut refused) = (0u128, i128::MIN, 0u128, 0);
            for &f in &fronts {
                let r = sandwich(f, victim, tolerance);
                if !r.filled {
                    refused += 1;
                    continue;
                }
                let min = r.quoted * (10_000 - tolerance) / 10_000;
                assert!(
                    r.victim_shares >= min,
                    "the victim got {} shares, under their minimum {min}",
                    r.victim_shares
                );
                worst_harm_bps = worst_harm_bps.max((r.quoted - r.victim_shares) * 10_000 / r.quoted);
                if r.attacker_profit > best_profit {
                    best_profit = r.attacker_profit;
                    best_front = f;
                }
            }
            assert!(
                worst_harm_bps <= tolerance,
                "the victim lost {worst_harm_bps} bps with a tolerance of {tolerance}"
            );
            report.push_str(&format!(
                "  minimum {tolerance:>5} bps: victim lost at most {worst_harm_bps:>4} bps, {refused:>2} of {} front-runs refused, best attacker profit {} at {best_front}\n",
                fronts.len(),
                if best_profit == i128::MIN { "n/a".to_string() } else { best_profit.to_string() },
            ));
        }
        println!("{report}");
    }

    // The victim's refusal costs the attacker: they are left holding shares bought at a higher price.
    #[test]
    fn when_the_victims_minimum_refuses_the_trade_the_attacker_is_left_with_a_loss() {
        let r = sandwich(30_000_000, 20_000_000, 50);
        assert!(!r.filled, "a 30,000,000 front-run moves the price more than 0.5%");
        assert_eq!(
            r.victim_shares, 0,
            "the refused victim holds nothing and kept their money"
        );
        assert!(
            r.attacker_profit < 0,
            "the attacker lost money and gained nothing: {}",
            r.attacker_profit
        );
    }

    #[test]
    fn splitting_one_buy_into_many_never_pays_less_fee() {
        let total = 40_000_000u128;
        let mut one_trade = 0;
        for slices in [1u128, 2, 4, 10, 40, 400] {
            let (mut c, _) = world();
            fund(&mut c, 0, SEED_UNITS / 2, SEED_UNITS / 2);
            let before = c.fees;
            for _ in 0..slices {
                act_as(VERIFIER, 3);
                let _ = receive(&mut c, acct(ATTACKER), U128(total / slices), "buy:0:yes:1".into());
            }
            let fee = c.fees - before;
            if slices == 1 {
                one_trade = fee;
            }
            assert!(
                fee >= one_trade,
                "{slices} trades paid {fee} against {one_trade} for one"
            );
            assert!(c.check_invariant(U64(0)));
        }
    }

    // One unit trades. Rounding goes in the pool's favour, so repeating tiny round trips must never make money.
    #[test]
    fn thousands_of_tiny_round_trips_never_make_money() {
        let (mut c, _) = world();
        let mut spent = 0u128;
        for amount in [1u128, 2, 3, 7, 11, 100, 999] {
            for _ in 0..300 {
                act_as(VERIFIER, 3);
                let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _ = receive(&mut c, acct(ATTACKER), U128(amount), "buy:0:yes:1".into());
                }))
                .is_ok();
                if ok {
                    spent += amount;
                }
                let (held, _) = holdings(&c, 0, ATTACKER);
                let q = c.quote_sell(U64(0), "yes".into(), U128(held));
                if q.collateral_out.0 > q.fee.0 {
                    act_as(ATTACKER, 4);
                    c.sell(U64(0), "yes".into(), U128(held), U128(1));
                }
            }
        }
        let (held, _) = holdings(&c, 0, ATTACKER);
        assert!(
            c.get_balance(acct(ATTACKER)).0 <= spent,
            "the attacker made money from rounding: spent {spent}, balance {}, still holding {held} shares",
            c.get_balance(acct(ATTACKER)).0
        );
        assert!(c.check_invariant(U64(0)));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(150))]

        // Whatever a single trader does with buys and sells on both sides, selling everything at the end never returns
        // more than they put in. The pool and the fee both only ever gain from a round trip.
        #[test]
        fn no_sequence_of_trades_by_one_trader_ends_in_profit(
            ops in proptest::collection::vec((0u8..4, 1u128..60_000_000, 1u128..101), 1..40),
        ) {
            let (mut c, _) = world();
            let mut put_in = 0u128;
            for (op, amount, frac) in ops {
                let side = if op % 2 == 0 { "yes" } else { "no" };
                if op < 2 {
                    act_as(VERIFIER, 3);
                    let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let _ = receive(&mut c, acct(ATTACKER), U128(amount), format!("buy:0:{side}:1"));
                    })).is_ok();
                    if ok { put_in += amount; }
                } else {
                    let (y, n) = holdings(&c, 0, ATTACKER);
                    let held = if side == "yes" { y } else { n } * frac / 100;
                    let q = c.quote_sell(U64(0), side.into(), U128(held));
                    if q.collateral_out.0 > q.fee.0 {
                        act_as(ATTACKER, 4);
                        c.sell(U64(0), side.into(), U128(held), U128(1));
                    }
                }
                prop_assert!(c.check_invariant(U64(0)));
            }
            // Sell what is left, both sides.
            for side in ["yes", "no"] {
                let (y, n) = holdings(&c, 0, ATTACKER);
                let held = if side == "yes" { y } else { n };
                let q = c.quote_sell(U64(0), side.into(), U128(held));
                if q.collateral_out.0 > q.fee.0 {
                    act_as(ATTACKER, 5);
                    c.sell(U64(0), side.into(), U128(held), U128(1));
                }
            }
            prop_assert!(c.get_balance(acct(ATTACKER)).0 <= put_in, "got back {} for {}", c.get_balance(acct(ATTACKER)).0, put_in);
        }
    }

    #[test]
    fn pumping_one_side_before_a_void_returns_the_pumper_only_what_they_put_in() {
        for put in [5_000_000u128, 20_000_000, 40_000_000, 80_000_000] {
            let (mut c, _) = world();
            fund(&mut c, 0, SEED_UNITS / 2, SEED_UNITS / 2);
            act_as(VERIFIER, CLOSE - 1);
            let _ = receive(&mut c, acct(ATTACKER), U128(put), "buy:0:yes:1".into());
            act_as(USERS[2], VOID_OPEN);
            c.void_if_unresolved(U64(0));
            act_as(ATTACKER, VOID_OPEN + 1);
            assert_eq!(
                c.redeem(U64(0)).0,
                net_in(put),
                "a pump of {put} earns nothing from a Void"
            );
            assert!(c.check_invariant(U64(0)));
        }
    }

    // ---- attacks: timing -----------------------------------------------------------------------------

    #[test]
    #[should_panic(expected = "market is closed")]
    fn nobody_can_trade_at_the_exact_moment_of_close() {
        let (mut c, _) = world();
        act_as(VERIFIER, CLOSE);
        let _ = receive(&mut c, acct(ATTACKER), U128(1_000_000), "buy:0:yes:1".into());
    }

    #[test]
    fn trading_works_up_to_the_last_nanosecond_before_close() {
        let (mut c, _) = world();
        act_as(VERIFIER, CLOSE - 1);
        let _ = receive(&mut c, acct(ATTACKER), U128(1_000_000), "buy:0:yes:1".into());
        assert!(holdings(&c, 0, ATTACKER).0 > 0);
    }

    #[test]
    #[should_panic(expected = "market has not closed")]
    fn the_oracle_cannot_set_an_outcome_before_close_so_nobody_trades_knowing_the_answer() {
        let (mut c, _) = world();
        act_as(ORACLE, CLOSE - 1);
        c.set_outcome(U64(0), Outcome::Yes);
    }

    #[test]
    fn a_halted_market_still_lets_holders_sell() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1);
        act_as(OWNER, 4);
        c.halt(U64(0), "grief".into());
        let (held, _) = holdings(&c, 0, USERS[0]);
        act_as(USERS[0], 5);
        c.sell(U64(0), "yes".into(), U128(held), U128(1));
        assert_eq!(holdings(&c, 0, USERS[0]).0, 0);
    }

    // Ann sells out at a loss before a Void. An exit is final, so what she left behind is owed to nobody once the
    // holders still in have their refunds, and it goes to the treasury.
    #[test]
    fn the_residual_is_due_to_the_treasury_and_not_credited_to_the_owner() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1); // ann buys Yes
        step(&mut c, &mut total_in, 1, 1, 0, 10_000_000, 1); // ben buys No
        step(&mut c, &mut total_in, 2, 0, 0, 0, 100); // ann sells all her Yes for less than she paid
        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(0));
        act_as(OWNER, VOID_OPEN + 1);
        assert!(refused(|| c.claim_residual(U64(0))), "ben is still owed his refund");
        act_as(USERS[1], VOID_OPEN + 1);
        assert_eq!(c.redeem(U64(0)).0, net_in(10_000_000));
        let residual = c.market(0).locked;
        assert!(residual > 0, "ann's loss is still in the pool");

        act_as(USERS[2], VOID_OPEN + 2);
        assert!(
            refused(|| c.claim_residual(U64(0))),
            "only the operator or owner claims"
        );
        act_as(OWNER, VOID_OPEN + 2);
        c.claim_residual(U64(0));
        assert_eq!(c.treasury_due, residual, "the next sweep pays it on the treasury leg");
        assert_eq!(
            c.get_balance(acct(OWNER)).0,
            0,
            "the owner, which is the DAO, is not credited"
        );
        assert_eq!(last_event()["data"]["to"], TREASURY);
        assert_eq!(c.market(0).locked, 0);
        assert!(
            refused(|| c.claim_residual(U64(0))),
            "nothing is left over the second time"
        );
        assert_conserved(&c, total_in);
    }

    #[test]
    fn a_market_that_resolves_to_an_answer_someone_holds_pays_winners_and_refunds_nobody() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1);
        act_as(ORACLE, CLOSE + 1);
        c.set_outcome(U64(0), Outcome::Yes);
        assert!(!c.market(0).refunds);
        assert!(!c.get_market(U64(0)).unwrap().refunds);
        assert_eq!(last_event()["data"]["refunds"], false);
    }

    // ---- price markets -------------------------------------------------------------------------------

    fn rule(observation_time: u64, strike: u128) -> PriceRule {
        PriceRule {
            observation_time: U64(observation_time),
            strike: U128(strike),
            decimals: 8,
            above: true,
        }
    }

    fn price_market(c: &mut MarketContract, rule: Option<PriceRule>) -> U64 {
        act_as(OWNER, 5);
        c.create_paid(
            "t".into(),
            "r".into(),
            "s".into(),
            "v".into(),
            "crypto".into(),
            "bitcoin".into(),
            U64(CLOSE),
            U64(RESOLVE_BY),
            rule,
        )
    }

    #[test]
    fn a_price_market_keeps_its_rule_and_the_rule_is_part_of_what_is_locked() {
        let (mut c, _) = world();
        let plain = price_market(&mut c, None);
        let a = price_market(&mut c, Some(rule(CLOSE, 8_500_000_000_000)));
        let b = price_market(&mut c, Some(rule(CLOSE, 8_500_000_000_001)));
        let later = price_market(&mut c, Some(rule(CLOSE + 1, 8_500_000_000_000)));
        let view = c.get_market(a).unwrap();
        assert_eq!(view.price_rule, Some(rule(CLOSE, 8_500_000_000_000)));
        assert_eq!(c.get_market(plain).unwrap().price_rule, None);
        let hashes: Vec<String> = [plain, a, b, later]
            .iter()
            .map(|id| c.get_market(*id).unwrap().rule_hash)
            .collect();
        for i in 0..hashes.len() {
            for j in i + 1..hashes.len() {
                assert_ne!(
                    hashes[i], hashes[j],
                    "a different rule must give a different hash ({i} and {j})"
                );
            }
        }
    }

    #[test]
    #[should_panic(expected = "observation_time must not be before close_at")]
    fn a_price_cannot_be_observed_before_trading_stops() {
        let (mut c, _) = world();
        price_market(&mut c, Some(rule(CLOSE - 1, 1)));
    }

    #[test]
    #[should_panic(expected = "observation_time must be before resolve_by")]
    fn a_price_must_be_observed_before_the_answer_deadline() {
        let (mut c, _) = world();
        price_market(&mut c, Some(rule(RESOLVE_BY, 1)));
    }

    #[test]
    #[should_panic(expected = "a price rule needs a strike above zero and at most 18 decimals")]
    fn a_strike_of_zero_is_refused() {
        let (mut c, _) = world();
        price_market(&mut c, Some(rule(CLOSE, 0)));
    }

    #[test]
    #[should_panic(expected = "a price rule needs a strike above zero and at most 18 decimals")]
    fn more_than_eighteen_decimals_are_refused() {
        let (mut c, _) = world();
        let mut r = rule(CLOSE, 1);
        r.decimals = 19;
        price_market(&mut c, Some(r));
    }

    #[test]
    fn a_price_market_may_be_observed_at_the_very_close() {
        let (mut c, _) = world();
        let id = price_market(&mut c, Some(rule(CLOSE, 1)));
        assert!(c.get_market(id).is_some());
    }

    #[test]
    #[should_panic(expected = "text is too long")]
    fn oversized_market_text_is_refused() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.create_paid(
            "t".into(),
            "x".repeat(MAX_RULE + 1),
            "s".into(),
            "v".into(),
            "sports".into(),
            "nfl".into(),
            U64(CLOSE),
            U64(RESOLVE_BY),
            None,
        );
    }

    // A DAO owner and a separate fast operator: the operator runs routine business, the owner alone
    // changes who the operator is and where fees go.
    #[test]
    fn the_operator_runs_routine_business_and_only_the_owner_changes_who_that_is() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        assert_eq!(c.config()["operator"], "ops.near");

        act_as("ops.near", 6);
        let id: U64 = c.create_paid(
            "t".into(),
            "r".into(),
            "s".into(),
            "v".into(),
            "sports".into(),
            "nfl".into(),
            U64(CLOSE + 2 * NS_PER_DAY),
            U64(RESOLVE_BY + 2 * NS_PER_DAY),
            None,
        );
        c.halt(id, "checking something".into());
        assert!(refused(|| c.resume(id)));
        c.set_paused(true);
        c.set_paused(false);
        act_as(OWNER, 7);
        c.resume(id);
    }

    #[test]
    #[should_panic(expected = "operator or owner only")]
    fn a_stranger_cannot_act_as_the_operator() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        act_as("stranger.near", 6);
        c.set_paused(true);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn the_operator_cannot_set_fee_recipients_or_appoint_a_new_operator() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        act_as("ops.near", 6);
        c.set_fee_recipients(acct("new-council.near"), acct("new-treasury.near"));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn the_operator_cannot_appoint_a_new_operator() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        act_as("ops.near", 6);
        c.set_operator(acct("someone-else.near"));
    }

    // ---- halting -----------------------------------------------------------------------------------------

    #[test]
    fn the_operator_can_halt_and_resume_right_up_to_close() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        act_as("ops.near", CLOSE - 1);
        c.halt(U64(0), "late".into());
        assert!(c.market(0).halted);
        act_as(VERIFIER, CLOSE - 1);
        assert!(refused(|| {
            let _ = receive(&mut c, acct(USERS[0]), U128(1_000_000), "buy:0:yes:1".into());
        }));
        act_as(OWNER, CLOSE - 1);
        c.resume(U64(0));
        assert!(!c.market(0).halted);
    }

    fn halted_market_world() -> MarketContract {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1);
        let mut m = c.market(0);
        m.close_at = 10 * NS_PER_DAY;
        c.store_market(0, m);
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        act_as("ops.near", 10);
        c.halt(U64(0), "checking".into());
        c
    }

    fn buy_one_unit(c: &mut MarketContract, at: u64) {
        act_as(VERIFIER, at);
        let _ = receive(c, acct(USERS[0]), U128(1_000_000), "buy:0:yes:1".into());
    }

    #[test]
    fn an_operator_halt_stops_buys_and_lapses_after_the_halt_duration() {
        let mut c = halted_market_world();
        assert!(refused(|| buy_one_unit(&mut c, 11)));
        assert!(refused(|| buy_one_unit(&mut c, 10 + HALT_DURATION_NS - 1)));
        assert_eq!(status(&c, 0), "halted");
        buy_one_unit(&mut c, 10 + HALT_DURATION_NS);
        assert_eq!(status(&c, 0), "open");
    }

    #[test]
    fn a_new_contract_caps_a_market_at_ten_thousand() {
        let (c, _) = world();
        assert_eq!(DEFAULT_MAX_MARKET_LOCKED, 10_000 * 1_000_000);
        assert_eq!(c.market_cap(U64(0)), U128(DEFAULT_MAX_MARKET_LOCKED));
    }

    #[test]
    fn exits_keep_working_while_a_market_is_halted() {
        let mut c = halted_market_world();
        let (held, _) = holdings(&c, 0, USERS[0]);
        act_as(USERS[0], 20);
        c.sell(U64(0), "yes".into(), U128(held / 2), U128(1));
        let after_sell = c.get_account(acct(USERS[0])).available;
        assert!(after_sell.0 > 0);
        act_as(USERS[0], 21);
        let _ = c.withdraw(U128(after_sell.0));
    }

    #[test]
    fn the_operator_halts_a_market_once_and_the_owner_extends_it() {
        let mut c = halted_market_world();
        act_as("ops.near", 11);
        assert!(refused(|| c.halt(U64(0), "again".into())), "the operator cannot extend");
        act_as(OWNER, HALT_DURATION_NS);
        c.halt(U64(0), "still looking".into());
        assert!(refused(|| buy_one_unit(&mut c, 10 + HALT_DURATION_NS + 1)));
        buy_one_unit(&mut c, 2 * HALT_DURATION_NS);
    }

    #[test]
    fn only_the_owner_can_resume_a_halt_and_that_frees_the_operator_to_halt_again() {
        let mut c = halted_market_world();
        act_as("ops.near", 11);
        assert!(refused(|| c.resume(U64(0))));
        assert!(refused(|| buy_one_unit(&mut c, 12)));
        act_as("ops.near", 13);
        assert!(refused(|| c.halt(U64(0), "again".into())));
        act_as(OWNER, 14);
        c.resume(U64(0));
        buy_one_unit(&mut c, 15);
        act_as("ops.near", 16);
        c.halt(U64(0), "again".into());
        assert!(refused(|| buy_one_unit(&mut c, 17)));
    }

    // ---- what the view says about a market that cannot trade yet ---------------------------------------------

    fn status(c: &MarketContract, id: u64) -> String {
        c.get_market(U64(id)).unwrap().status
    }

    #[test]
    fn a_market_says_unregistered_then_open_once_the_oracle_confirms_it() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        let id = c
            .create_paid(
                "t".into(),
                "r".into(),
                "s".into(),
                "v".into(),
                "sports".into(),
                "nfl".into(),
                U64(CLOSE),
                U64(RESOLVE_BY),
                None,
            )
            .0;
        assert_eq!(status(&c, id), "unregistered");
        let mut m = c.market(id);
        m.registered = true;
        c.store_market(id, m);
        assert_eq!(status(&c, id), "open");
        assert_eq!(c.list_markets(U64(id), U64(1))[0].status, "open");
    }

    #[test]
    fn resolved_halted_and_closed_come_before_unregistered() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        let id = c
            .create_paid(
                "t".into(),
                "r".into(),
                "s".into(),
                "v".into(),
                "sports".into(),
                "nfl".into(),
                U64(CLOSE + 3 * NS_PER_DAY),
                U64(RESOLVE_BY + 3 * NS_PER_DAY),
                None,
            )
            .0;
        c.halt(U64(id), "x".into());
        assert_eq!(status(&c, id), "halted");
        act_unpaid(OWNER, 6);
        assert_eq!(status(&c, id), "halted");
        act_unpaid(OWNER, CLOSE + 3 * NS_PER_DAY);
        assert_eq!(status(&c, id), "closed", "the halt lapsed on its own");
        c.resume(U64(id));
        assert_eq!(status(&c, id), "closed");
        let mut m = c.market(id);
        m.outcome = Some(Outcome::No);
        c.store_market(id, m);
        assert_eq!(status(&c, id), "resolved");
    }

    // ---- buy, sell, the position cap, resume and seed --------------------------------------------------

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn buy_from_a_balance_refuses_a_call_with_no_deposit() {
        let (mut c, _) = world();
        act_unpaid(USERS[0], 5);
        c.buy(U64(0), "yes".into(), U128(1), U128(1));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn sell_refuses_a_call_with_no_deposit() {
        let (mut c, _) = world();
        act_unpaid(USERS[0], 5);
        c.sell(U64(0), "yes".into(), U128(1), U128(1));
    }

    fn create_registered(c: &mut MarketContract, by: &str) -> u64 {
        act_as(by, 5);
        let id = c.create_paid(
            "t".into(),
            "r".into(),
            "s".into(),
            "v".into(),
            "sports".into(),
            "nfl".into(),
            U64(CLOSE),
            U64(RESOLVE_BY),
            None,
        );
        let mut m = c.market(id.0);
        m.registered = true;
        c.store_market(id.0, m);
        id.0
    }

    #[test]
    fn a_failed_upgrade_batch_clears_the_in_flight_flag_and_a_good_one_leaves_it() {
        let (mut c, _) = world();
        c.upgrade_in_flight = true;
        c.on_upgrade_done(Ok(()));
        assert!(c.upgrade_in_flight);
        c.on_upgrade_done(Err(PromiseError::Failed));
        assert!(!c.upgrade_in_flight);
    }

    #[test]
    fn a_market_takes_no_buy_past_its_cap_and_still_sells_and_takes_buys_after_the_cap_rises() {
        let mut c = deployed_with_a_balance();
        let id = create_registered(&mut c, OWNER);
        act_as(OWNER, 6);
        c.set_market_cap(U64(id), U128(4_000_000));
        assert_eq!(c.market_cap(U64(id)), U128(4_000_000));
        act_as(USERS[0], 7);
        c.buy(U64(id), "yes".into(), U128(3_000_000), U128(1));
        assert!(c.market(id).locked <= 4_000_000);
        // The unit-test host keeps the balance debit of a refused call, which a real receipt would roll back.
        let message = refusal(|| c.buy(U64(id), "yes".into(), U128(3_000_000), U128(1)));
        assert!(message.contains("this market has reached its cap"), "{message}");
        act_as(OWNER, 8);
        c.set_market_cap(U64(id), U128(10_000_000));
        act_as(USERS[0], 9);
        c.buy(U64(id), "yes".into(), U128(1_000_000), U128(1));
        assert!(c.check_invariant(U64(id)));
    }

    #[test]
    fn the_operator_lowers_one_market_but_only_the_owner_moves_the_ceiling() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_max_market_locked(U128(50_000_000));
        assert_eq!(c.market_cap(U64(0)), U128(50_000_000));
        act_as("stranger.near", 6);
        assert!(refused(|| c.set_market_cap(U64(0), U128(2_000_000))));
        assert!(refused(|| c.set_max_market_locked(U128(60_000_000))));
        act_as(OWNER, 7);
        assert!(
            refused(|| c.set_market_cap(U64(0), U128(50_000_001))),
            "above the ceiling"
        );
        assert!(refused(|| c.set_market_cap(U64(0), U128(HARD_MIN_MARKET_LOCKED - 1))));
        assert!(refused(|| c.set_market_cap(U64(99), U128(2_000_000))), "no such market");
        assert!(refused(|| c.set_max_market_locked(U128(dpm::MAX_LOCKED + 1))));
        c.set_market_cap(U64(0), U128(2_000_000));
        assert_eq!(c.market_cap(U64(0)), U128(2_000_000));
        c.set_max_market_locked(U128(1_500_000));
        assert_eq!(
            c.market_cap(U64(0)),
            U128(1_500_000),
            "a lowered ceiling wins over a higher cap"
        );
    }

    #[test]
    fn the_operator_trades_in_25_markets_past_the_cap() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        c.accounts.insert(acct("ops.near"), 0);
        for _ in 0..25 {
            let id = create_registered(&mut c, "ops.near");
            act_as(VERIFIER, 6);
            let _ = receive(&mut c, acct("ops.near"), U128(1_000_000), format!("buy:{id}:yes:1"));
        }
        assert_eq!(c.accounts.get(&acct("ops.near")).copied(), Some(50));
    }

    #[test]
    fn the_owner_is_not_held_to_the_cap_either() {
        let (mut c, _) = world();
        for _ in 0..25 {
            let id = create_registered(&mut c, OWNER);
            fund(&mut c, id, 1_000_000, 1_000_000);
        }
        assert!(c.accounts.get(&acct(OWNER)).copied().unwrap() >= 75);
    }

    #[test]
    fn an_ordinary_trader_still_stops_at_the_cap() {
        let (mut c, _) = world();
        for i in 0..MAX_POSITIONS / 2 + 1 {
            let id = create_registered(&mut c, OWNER);
            act_as(VERIFIER, 7);
            let bought = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = receive(&mut c, acct(USERS[0]), U128(1_000_000), format!("buy:{id}:yes:1"));
            }));
            assert_eq!(bought.is_ok(), i < MAX_POSITIONS / 2, "buy number {}", i + 1);
        }
    }

    #[test]
    #[should_panic(expected = "already resolved")]
    fn resume_refuses_a_market_that_already_has_an_outcome() {
        let (mut c, _) = world();
        act_as(OWNER, 4);
        c.halt(U64(0), "checking".into());
        act_as(ORACLE, CLOSE + 1);
        c.set_outcome(U64(0), Outcome::Yes);
        act_as(OWNER, CLOSE + 2);
        c.resume(U64(0));
    }

    // ---- money in comes only from the verifier, as one token from the sender's own balance ----------------------

    fn deliver(
        who: &str,
        sender: &str,
        previous: Vec<&str>,
        token_ids: Vec<&str>,
        amounts: Vec<u128>,
        msg: &str,
    ) -> (MarketContract, Vec<U128>) {
        let (mut c, _) = world();
        act_as(who, 4);
        let out = c.mt_on_transfer(
            acct(sender),
            previous.into_iter().map(acct).collect(),
            token_ids.into_iter().map(String::from).collect(),
            amounts.into_iter().map(U128).collect(),
            msg.to_string(),
        );
        (c, out)
    }

    #[test]
    fn money_from_the_verifier_is_kept_in_full_and_the_receipt_returns_a_zero_refund() {
        let (c, out) = deliver(
            VERIFIER,
            USERS[0],
            vec![USERS[0]],
            vec![COLLATERAL_ID],
            vec![5_000_000],
            "deposit",
        );
        assert_eq!(out, vec![U128(0)]);
        assert_eq!(c.get_balance(acct(USERS[0])).0, 5_000_000);
    }

    #[test]
    #[should_panic(expected = "only the verifier can deliver money")]
    fn money_from_anyone_but_the_verifier_is_refused() {
        deliver(
            USERS[1],
            USERS[0],
            vec![USERS[0]],
            vec![COLLATERAL_ID],
            vec![5_000_000],
            "deposit",
        );
    }

    #[test]
    #[should_panic(expected = "wrong token")]
    fn a_token_that_is_not_the_collateral_is_refused() {
        deliver(
            VERIFIER,
            USERS[0],
            vec![USERS[0]],
            vec!["nep141:other.near"],
            vec![5_000_000],
            "deposit",
        );
    }

    #[test]
    #[should_panic(expected = "wrong token")]
    fn the_bare_contract_id_is_not_the_collateral() {
        deliver(
            VERIFIER,
            USERS[0],
            vec![USERS[0]],
            vec!["usdc.near"],
            vec![5_000_000],
            "deposit",
        );
    }

    #[test]
    #[should_panic(expected = "the money must come from the sender's own balance")]
    fn money_that_belonged_to_someone_else_is_refused() {
        deliver(
            VERIFIER,
            USERS[0],
            vec![USERS[1]],
            vec![COLLATERAL_ID],
            vec![5_000_000],
            "deposit",
        );
    }

    #[test]
    #[should_panic(expected = "the money must come from the sender's own balance")]
    fn no_previous_owner_is_refused() {
        deliver(
            VERIFIER,
            USERS[0],
            vec![],
            vec![COLLATERAL_ID],
            vec![5_000_000],
            "deposit",
        );
    }

    #[test]
    #[should_panic(expected = "exactly one token and amount")]
    fn two_tokens_in_one_delivery_are_refused() {
        deliver(
            VERIFIER,
            USERS[0],
            vec![USERS[0], USERS[0]],
            vec![COLLATERAL_ID, COLLATERAL_ID],
            vec![1_000_000, 1_000_000],
            "deposit",
        );
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn a_zero_delivery_is_refused() {
        deliver(
            VERIFIER,
            USERS[0],
            vec![USERS[0]],
            vec![COLLATERAL_ID],
            vec![0],
            "deposit",
        );
    }

    #[test]
    #[should_panic(expected = "unknown action")]
    fn a_message_that_names_no_action_is_refused_so_the_verifier_refunds() {
        deliver(
            VERIFIER,
            USERS[0],
            vec![USERS[0]],
            vec![COLLATERAL_ID],
            vec![5_000_000],
            "hello",
        );
    }

    #[test]
    #[should_panic(expected = "the collateral token id must look like nep141:<token>")]
    fn a_collateral_id_without_the_nep141_prefix_is_refused_at_init() {
        act_as(OWNER, 1);
        MarketContract::new(
            acct(OWNER),
            acct(OWNER),
            acct(ORACLE),
            acct(VERIFIER),
            "usdc.near".to_string(),
        );
    }

    #[test]
    fn config_names_the_verifier_and_the_exact_token_id() {
        let (c, _) = world();
        let config = c.config();
        assert_eq!(config["verifier"], VERIFIER);
        assert_eq!(config["collateral_token_id"], COLLATERAL_ID);
        assert!(config.get("collateral").is_none());
    }

    // ---- total_owed: what the verifier must hold for this contract --------------------------------------------

    #[test]
    fn total_owed_adds_balances_locked_collateral_and_every_fee_bucket() {
        let (mut c, total_in) = world();
        assert_eq!(c.total_owed().0, total_in);
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(7_000_000), "deposit".to_string());
        assert_eq!(
            c.total_owed().0,
            total_in + 7_000_000,
            "a deposit is owed to its sender"
        );
        c.revenue_due = 11;
        c.treasury_due = 13;
        c.revenue_unresolved = 17;
        assert_eq!(c.total_owed().0, total_in + 7_000_000 + 41);
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(2_000_000));
        assert_eq!(
            c.total_owed().0,
            total_in + 7_000_000 + 41,
            "a withdrawal in flight is still owed until the verifier confirms it"
        );
        assert_eq!(c.owed_breakdown().total.0, c.total_owed().0);
    }

    #[test]
    fn a_failed_withdrawal_puts_the_balance_back_and_total_owed_with_it() {
        let (mut c, total_in) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(7_000_000), "deposit".to_string());
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(7_000_000));
        assert_eq!(c.total_owed().0, total_in + 7_000_000);
        act_as("market.near", 5);
        c.on_withdraw(U64(1), Err(PromiseError::Failed));
        assert_eq!(c.get_balance(acct(USERS[0])).0, 7_000_000);
        assert_eq!(c.total_owed().0, total_in + 7_000_000);
        assert_eq!(last_event()["event"], "withdraw_failed");
    }

    #[test]
    fn a_successful_withdrawal_leaves_the_balance_gone() {
        let (mut c, total_in) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(7_000_000), "deposit".to_string());
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(7_000_000));
        act_as("market.near", 5);
        c.on_withdraw(U64(1), Ok(()));
        assert_eq!(c.get_balance(acct(USERS[0])).0, 0);
        assert_eq!(c.total_owed().0, total_in);
    }

    // ---- withdrawals in flight ----------------------------------------------------------------------------------

    fn deposit(c: &mut MarketContract, who: &str, amount: u128) {
        act_as(VERIFIER, 3);
        let _ = receive(c, acct(who), U128(amount), "deposit".to_string());
    }

    fn json_of<T: near_sdk::serde::Serialize>(v: &T) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::to_value(v).unwrap()
    }

    #[test]
    fn a_withdrawal_writes_its_record_and_emits_the_event_with_an_id() {
        let (mut c, total_in) = world();
        deposit(&mut c, USERS[0], 7_000_000);
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(3_000_000));
        let e = last_event();
        assert_eq!(e["event"], "withdraw");
        assert_eq!(
            e["data"],
            near_sdk::serde_json::json!({ "account": USERS[0], "amount": "3000000", "id": "1" })
        );
        let w = c.find_withdrawal(1).unwrap();
        assert_eq!((w.account.as_str(), w.amount.0, w.at.0), (USERS[0], 3_000_000, 4));
        assert_eq!(
            (c.pending_withdrawals_total, c.pending_withdrawal_count),
            (3_000_000, 1)
        );
        assert_eq!(c.get_balance(acct(USERS[0])).0, 4_000_000);
        assert_eq!(c.total_owed().0, total_in + 7_000_000);
        act_as(USERS[0], 5);
        let _ = c.withdraw(U128(1));
        assert_eq!(last_event()["data"]["id"], "2");
    }

    #[test]
    fn a_confirmed_withdrawal_leaves_no_record_and_emits_withdraw_confirmed() {
        let (mut c, total_in) = world();
        deposit(&mut c, USERS[0], 7_000_000);
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(3_000_000));
        act_as("market.near", 5);
        c.on_withdraw(U64(1), Ok(()));
        let e = last_event();
        assert_eq!(e["event"], "withdraw_confirmed");
        assert_eq!(
            e["data"],
            near_sdk::serde_json::json!({ "account": USERS[0], "amount": "3000000", "id": "1" })
        );
        assert!(c.find_withdrawal(1).is_none());
        assert_eq!((c.pending_withdrawals_total, c.pending_withdrawal_count), (0, 0));
        assert_eq!(c.get_balance(acct(USERS[0])).0, 4_000_000);
        assert_eq!(c.total_owed().0, total_in + 4_000_000);
    }

    #[test]
    fn a_failed_withdrawal_credits_back_and_emits_withdraw_failed_with_the_id() {
        let (mut c, total_in) = world();
        deposit(&mut c, USERS[0], 7_000_000);
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(3_000_000));
        act_as("market.near", 5);
        c.on_withdraw(U64(1), Err(PromiseError::Failed));
        let e = last_event();
        assert_eq!(e["event"], "withdraw_failed");
        assert_eq!(
            e["data"],
            near_sdk::serde_json::json!({ "account": USERS[0], "amount": "3000000", "id": "1" })
        );
        assert_eq!(c.get_balance(acct(USERS[0])).0, 7_000_000);
        assert_eq!((c.pending_withdrawals_total, c.pending_withdrawal_count), (0, 0));
        assert_eq!(c.get_account(acct(USERS[0])).pending_withdrawals.0, 0);
        assert_eq!(c.total_owed().0, total_in + 7_000_000);
    }

    #[test]
    fn a_repeated_or_unknown_callback_changes_nothing() {
        let (mut c, total_in) = world();
        deposit(&mut c, USERS[0], 7_000_000);
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(3_000_000));
        act_as("market.near", 5);
        c.on_withdraw(U64(1), Err(PromiseError::Failed));
        for (id, result) in [
            (1, Err(PromiseError::Failed)),
            (1, Ok(())),
            (99, Err(PromiseError::Failed)),
        ] {
            act_as("market.near", 6);
            c.on_withdraw(U64(id), result);
            assert!(near_sdk::test_utils::get_logs().is_empty());
            assert_eq!(c.get_balance(acct(USERS[0])).0, 7_000_000);
            assert_eq!((c.pending_withdrawals_total, c.pending_withdrawal_count), (0, 0));
            assert_eq!(c.total_owed().0, total_in + 7_000_000);
        }
    }

    #[test]
    fn two_withdrawals_in_flight_keep_their_own_ids_and_amounts() {
        let (mut c, total_in) = world();
        deposit(&mut c, USERS[0], 7_000_000);
        deposit(&mut c, USERS[1], 5_000_000);
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(3_000_000));
        act_as(USERS[1], 4);
        let _ = c.withdraw(U128(2_000_000));
        assert_eq!(last_event()["data"]["id"], "2");
        assert_eq!(
            (c.pending_withdrawals_total, c.pending_withdrawal_count),
            (5_000_000, 2)
        );
        assert_eq!(c.get_account(acct(USERS[0])).pending_withdrawals.0, 3_000_000);
        assert_eq!(c.get_account(acct(USERS[1])).pending_withdrawals.0, 2_000_000);
        assert_eq!(c.total_owed().0, total_in + 12_000_000);
        act_as("market.near", 5);
        c.on_withdraw(U64(2), Err(PromiseError::Failed));
        assert_eq!(c.get_balance(acct(USERS[1])).0, 5_000_000);
        assert_eq!(
            (c.pending_withdrawals_total, c.pending_withdrawal_count),
            (3_000_000, 1)
        );
        assert_eq!(c.get_account(acct(USERS[0])).pending_withdrawals.0, 3_000_000);
        assert_eq!(c.find_withdrawal(1).unwrap().amount.0, 3_000_000);
        c.on_withdraw(U64(1), Ok(()));
        assert_eq!(c.pending_withdrawals_total, 0);
        assert_eq!(c.total_owed().0, total_in + 9_000_000);
    }

    #[test]
    fn a_callback_pays_the_stored_amount_and_account() {
        let (mut c, _) = world();
        deposit(&mut c, USERS[0], 7_000_000);
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(3_000_000));
        act_as("market.near", 5);
        c.on_withdraw(U64(1), Err(PromiseError::Failed));
        assert_eq!(c.get_balance(acct(USERS[0])).0, 7_000_000);
        assert_eq!(c.get_balance(acct(USERS[1])).0, 0);
    }

    // ---- reconcile_withdrawal: the owner decides when the callback never came ---------------------------------

    const WITHDRAWN_AT: u64 = 4;
    const WITHDRAWAL_DECIDABLE_AT: u64 = WITHDRAWN_AT + RECONCILE_WAIT_MINUTES * NS_PER_MINUTE;

    // One user holds 7 000 000 and has 3 000 000 of it in flight as withdrawal 1.
    fn a_stuck_withdrawal() -> (MarketContract, u128) {
        let (mut c, total_in) = world();
        deposit(&mut c, USERS[0], 7_000_000);
        act_as(USERS[0], WITHDRAWN_AT);
        let _ = c.withdraw(U128(3_000_000));
        (c, total_in + 7_000_000)
    }

    #[test]
    fn only_the_owner_reconciles_a_withdrawal() {
        let (mut c, total) = a_stuck_withdrawal();
        act_as(OWNER, 7);
        c.set_operator(acct("ops.near"));
        for who in ["ops.near", USERS[0], USERS[1]] {
            act_as(who, WITHDRAWAL_DECIDABLE_AT);
            let caught =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.reconcile_withdrawal(U64(1), false)));
            assert!(caught.is_err(), "{who} must be refused");
        }
        assert_eq!(
            (c.pending_withdrawals_total, c.pending_withdrawal_count),
            (3_000_000, 1)
        );
        assert_conserved(&c, total);
    }

    #[test]
    fn an_unknown_withdrawal_id_is_refused() {
        let (mut c, _) = a_stuck_withdrawal();
        act_as(OWNER, WITHDRAWAL_DECIDABLE_AT);
        assert!(refusal(|| c.reconcile_withdrawal(U64(9), true)).contains("no withdrawal is pending with that id"));
    }

    #[test]
    fn a_withdrawal_is_decided_exactly_at_the_wait_and_not_before() {
        let (mut c, _) = a_stuck_withdrawal();
        act_as(OWNER, WITHDRAWAL_DECIDABLE_AT - 1);
        assert_eq!(
            refusal(|| c.reconcile_withdrawal(U64(1), true)),
            "wait 60 minutes after the withdrawal before reconciling"
        );
        assert_eq!(c.pending_withdrawals_total, 3_000_000);
        act_as(OWNER, WITHDRAWAL_DECIDABLE_AT);
        c.reconcile_withdrawal(U64(1), true);
        assert_eq!(c.pending_withdrawals_total, 0);
    }

    #[test]
    fn a_withdrawal_that_was_paid_is_dropped_and_no_longer_owed() {
        let (mut c, total) = a_stuck_withdrawal();
        act_as(OWNER, WITHDRAWAL_DECIDABLE_AT);
        c.reconcile_withdrawal(U64(1), true);
        let e = last_event();
        assert_eq!(e["event"], "withdrawal_reconciled");
        assert_eq!(
            e["data"],
            near_sdk::serde_json::json!({ "account": USERS[0], "amount": "3000000", "id": "1", "paid": true })
        );
        assert!(c.find_withdrawal(1).is_none());
        assert_eq!((c.pending_withdrawals_total, c.pending_withdrawal_count), (0, 0));
        assert_eq!(c.get_account(acct(USERS[0])).pending_withdrawals.0, 0);
        assert_eq!(c.get_balance(acct(USERS[0])).0, 4_000_000);
        assert_eq!(c.total_owed().0, total - 3_000_000);
        assert_conserved(&c, total - 3_000_000);
    }

    #[test]
    fn a_withdrawal_that_never_happened_is_credited_back() {
        let (mut c, total) = a_stuck_withdrawal();
        act_as(OWNER, WITHDRAWAL_DECIDABLE_AT);
        c.reconcile_withdrawal(U64(1), false);
        let e = last_event();
        assert_eq!(e["event"], "withdrawal_reconciled");
        assert_eq!(
            e["data"],
            near_sdk::serde_json::json!({ "account": USERS[0], "amount": "3000000", "id": "1", "paid": false })
        );
        assert!(c.find_withdrawal(1).is_none());
        assert_eq!((c.pending_withdrawals_total, c.pending_withdrawal_count), (0, 0));
        assert_eq!(c.get_account(acct(USERS[0])).pending_withdrawals.0, 0);
        assert_eq!(c.get_balance(acct(USERS[0])).0, 7_000_000);
        assert_eq!(c.total_owed().0, total);
        assert_conserved(&c, total);
    }

    #[test]
    fn a_withdrawal_cannot_be_reconciled_twice() {
        let (mut c, _) = a_stuck_withdrawal();
        act_as(OWNER, WITHDRAWAL_DECIDABLE_AT);
        c.reconcile_withdrawal(U64(1), false);
        for paid in [false, true] {
            assert!(refusal(|| c.reconcile_withdrawal(U64(1), paid)).contains("no withdrawal is pending with that id"));
        }
        assert_eq!(c.get_balance(acct(USERS[0])).0, 7_000_000);
    }

    #[test]
    fn a_late_callback_after_a_reconcile_changes_nothing() {
        for (paid, balance, owed_drop) in [(true, 4_000_000, 3_000_000), (false, 7_000_000, 0)] {
            let (mut c, total) = a_stuck_withdrawal();
            act_as(OWNER, WITHDRAWAL_DECIDABLE_AT);
            c.reconcile_withdrawal(U64(1), paid);
            for result in [Ok(()), Err(PromiseError::Failed)] {
                act_as("market.near", WITHDRAWAL_DECIDABLE_AT + 1);
                c.on_withdraw(U64(1), result);
                assert!(near_sdk::test_utils::get_logs().is_empty());
                assert_eq!(c.get_balance(acct(USERS[0])).0, balance);
                assert_eq!((c.pending_withdrawals_total, c.pending_withdrawal_count), (0, 0));
                assert_eq!(c.total_owed().0, total - owed_drop);
            }
            assert_conserved(&c, total - owed_drop);
        }
    }

    #[test]
    fn the_views_report_each_state_and_change_nothing() {
        let (mut c, total_in) = world();
        let nothing =
            near_sdk::serde_json::json!({ "withdrawals": "0", "withdrawal_count": 0, "legs": "0", "leg_count": 0 });
        assert_eq!(json_of(&c.in_flight()), nothing);
        assert_eq!(
            json_of(&c.get_account(acct("stranger.near"))),
            near_sdk::serde_json::json!({ "registered": false, "available": "0", "pending_withdrawals": "0", "positions": 0 })
        );
        assert_eq!(
            json_of(&c.get_account(acct(USERS[0]))),
            near_sdk::serde_json::json!({ "registered": true, "available": "0", "pending_withdrawals": "0", "positions": 0 })
        );
        deposit(&mut c, USERS[0], 7_000_000);
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        let locked = c.locked_total;
        let fees = c.fees;
        let expect = |c: &MarketContract, available: u128, pending: u128| {
            assert_eq!(
                json_of(&c.get_account(acct(USERS[0]))),
                near_sdk::serde_json::json!({ "registered": true, "available": available.to_string(),
                    "pending_withdrawals": pending.to_string(), "positions": 1 })
            );
        };
        expect(&c, 7_000_000, 0);
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(3_000_000));
        expect(&c, 4_000_000, 3_000_000);
        assert_eq!(
            json_of(&c.in_flight()),
            near_sdk::serde_json::json!({ "withdrawals": "3000000", "withdrawal_count": 1, "legs": "0", "leg_count": 0 })
        );
        let expected = near_sdk::serde_json::json!({
            "balances": "4000000", "locked": locked.to_string(), "fees": fees.to_string(), "revenue_due": "0",
            "treasury_due": "0", "unresolved": "0", "pending_withdrawals": "3000000",
            "total": (total_in + 17_000_000).to_string() });
        assert_eq!(json_of(&c.owed_breakdown()), expected);
        assert_eq!(c.owed_breakdown().total.0, c.total_owed().0);
        let (balances, pending, count) = (
            c.balances_total,
            c.pending_withdrawals_total,
            c.pending_withdrawal_count,
        );
        let _ = (c.in_flight(), c.get_account(acct(USERS[0])), c.owed_breakdown());
        assert_eq!(
            (
                c.balances_total,
                c.pending_withdrawals_total,
                c.pending_withdrawal_count
            ),
            (balances, pending, count)
        );
        act_as("market.near", 5);
        c.on_withdraw(U64(1), Ok(()));
        expect(&c, 4_000_000, 0);
        assert_eq!(json_of(&c.in_flight()), nothing);
        assert_eq!(c.owed_breakdown().pending_withdrawals.0, 0);
        assert_eq!(c.owed_breakdown().total.0, total_in + 14_000_000);
        act_as(USERS[0], 6);
        let _ = c.withdraw(U128(1_000_000));
        act_as("market.near", 7);
        c.on_withdraw(U64(2), Err(PromiseError::Failed));
        expect(&c, 4_000_000, 0);
        assert_eq!(json_of(&c.in_flight()), nothing);
    }

    #[test]
    fn in_flight_counts_fee_legs_that_are_pending_or_unresolved() {
        let mut c = after_a_sweep();
        let sweep = c.get_sweep(U64(1)).unwrap();
        let (council, treasury) = (sweep.council.amount.0, sweep.treasury.amount.0);
        assert!(council > 0 && treasury > 0);
        let legs = |c: &MarketContract| {
            let v = c.in_flight();
            (v.legs.0, v.leg_count)
        };
        assert_eq!(legs(&c), (council + treasury, 2));
        act_as("market.near", 6);
        c.on_treasury_sent(U64(1), Ok(()));
        assert_eq!(legs(&c), (council, 1));
        c.on_revenue_sent(U64(1), Err(PromiseError::Failed));
        assert_eq!(legs(&c), (council, 1), "an unresolved leg is still in flight");
        assert_eq!(c.owed_breakdown().unresolved.0, council);
        assert_eq!(c.owed_breakdown().total.0, c.total_owed().0);
        act_as("market.near", SETTLE_AT);
        c.on_council_checked(U64(1), Ok(None));
        assert_eq!(legs(&c), (0, 0));
        assert_eq!(c.in_flight().withdrawals.0, 0, "fee legs never show as withdrawals");
        assert_eq!(c.owed_breakdown().pending_withdrawals.0, 0);
    }

    // A withdrawal's callback can succeed, fail, or never come. Whatever the mix, total_owed moves only when a callback
    // confirms, and money in flight stays in pending until one reports.
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        #[test]
        fn withdrawals_with_any_mix_of_callbacks_never_create_or_lose_money(
            ops in proptest::collection::vec((0usize..3, 1u128..3_000_000, 0u8..3), 1..30)
        ) {
            let (mut c, total_in) = world();
            let mut total_in = total_in;
            for u in USERS {
                deposit(&mut c, u, 20_000_000);
                total_in += 20_000_000;
            }
            let mut confirmed = 0u128;
            let mut never: u128 = 0;
            let mut unreported = Vec::new();
            let mut next_id = 1u64;
            for (user, amount, fate) in ops {
                let held = c.get_balance(acct(USERS[user])).0;
                let amount = amount.min(held);
                if amount == 0 {
                    continue;
                }
                let before = c.total_owed().0;
                act_as(USERS[user], 4);
                let _ = c.withdraw(U128(amount));
                prop_assert_eq!(c.total_owed().0, before);
                prop_assert_eq!(c.get_balance(acct(USERS[user])).0, held - amount);
                let id = next_id;
                next_id += 1;
                act_as("market.near", 5);
                match fate {
                    0 => {
                        c.on_withdraw(U64(id), Ok(()));
                        confirmed += amount;
                    }
                    1 => c.on_withdraw(U64(id), Err(PromiseError::Failed)),
                    _ => {
                        never += amount;
                        unreported.push(id);
                    }
                }
                prop_assert_eq!(c.pending_withdrawals_total, never);
                prop_assert_eq!(c.total_owed().0, total_in - confirmed);
                assert_conserved(&c, total_in - confirmed);
            }
            let held: u128 = unreported.iter().map(|id| c.find_withdrawal(*id).unwrap().amount.0).sum();
            prop_assert_eq!(held, never);
            prop_assert_eq!(c.pending_withdrawal_count as usize, unreported.len());
        }
    }

    // ---- payouts are verifier calls to accounts the records name ---------------------------------------------

    fn call_of(r: &near_sdk::mock::Receipt) -> (String, near_sdk::serde_json::Value, u128, u64) {
        match &r.actions[0] {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                ..
            } => (
                String::from_utf8(method_name.clone()).unwrap(),
                near_sdk::serde_json::from_slice(args).unwrap(),
                attached_deposit.as_yoctonear(),
                prepaid_gas.as_gas(),
            ),
            other => panic!("not a function call: {other:?}"),
        }
    }

    #[test]
    fn a_withdrawal_is_one_mt_transfer_of_one_yocto_to_the_caller() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(7_000_000), "deposit".to_string());
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(3_000_000));
        let sent = receipts();
        assert_eq!(sent[0].receiver_id, acct(VERIFIER));
        let (method, args, deposit, gas) = call_of(&sent[0]);
        assert_eq!(method, "mt_transfer");
        assert_eq!(deposit, 1);
        assert_eq!(gas, GAS_MT_TRANSFER.as_gas());
        assert_eq!(args["receiver_id"], USERS[0]);
        assert_eq!(args["token_id"], COLLATERAL_ID);
        assert_eq!(args["amount"], "3000000");
    }

    #[test]
    fn a_sweep_sends_the_council_a_transfer_call_and_the_treasury_a_plain_transfer() {
        let (mut c, _) = world();
        c.fees = 1_000_000;
        act_as(USERS[2], 5);
        c.sweep_fees();
        let sent = receipts();
        let to_verifier: Vec<_> = sent.iter().filter(|r| r.receiver_id == acct(VERIFIER)).collect();
        assert_eq!(to_verifier.len(), 2);
        let (method, args, deposit, gas) = call_of(to_verifier[0]);
        assert_eq!(method, "mt_transfer_call");
        assert_eq!((deposit, gas), (1, GAS_MT_TRANSFER_CALL.as_gas()));
        assert_eq!(args["receiver_id"], COUNCIL);
        assert_eq!(args["token_id"], COLLATERAL_ID);
        assert_eq!(args["amount"], "250000");
        assert_eq!(args["msg"], "revenue:1", "the Council takes each sweep id once");
        let (method, args, deposit, gas) = call_of(to_verifier[1]);
        assert_eq!(method, "mt_transfer");
        assert_eq!((deposit, gas), (1, GAS_MT_TRANSFER.as_gas()));
        assert_eq!(args["receiver_id"], TREASURY);
        assert_eq!(args["amount"], "750000");
    }

    // ---- what the verifier's report on a revenue transfer means -----------------------------------------------

    fn legs(c: &MarketContract, id: u64) -> (LegStatus, LegStatus) {
        let s = c.get_sweep(U64(id)).unwrap();
        (s.council.status, s.treasury.status)
    }

    #[test]
    fn a_council_that_refused_reports_zero_kept_and_the_whole_amount_is_due_again() {
        let mut c = after_a_sweep();
        act_as("market.near", 6);
        c.on_revenue_sent(U64(1), Ok(vec![U128(0)]));
        assert_eq!((c.revenue_due, c.revenue_unresolved), (250_000, 0));
        assert_eq!(legs(&c, 1).0, LegStatus::Refused);
        let e = last_event();
        assert_eq!(e["event"], "fee_transfer_failed");
        assert_eq!(
            (e["data"]["leg"].as_str(), e["data"]["id"].as_str()),
            (Some("council"), Some("1"))
        );
    }

    #[test]
    fn a_council_that_kept_everything_leaves_nothing_due() {
        let mut c = after_a_sweep();
        act_as("market.near", 6);
        c.on_revenue_sent(U64(1), Ok(vec![U128(250_000)]));
        assert_eq!((c.revenue_due, c.revenue_unresolved), (0, 0));
        assert_eq!(legs(&c, 1).0, LegStatus::Settled);
        assert_eq!(last_event()["event"], "fee_leg_settled");
    }

    #[test]
    fn a_report_of_the_wrong_shape_is_unknown_and_parks_the_amount() {
        for report in [Ok(vec![]), Ok(vec![U128(0), U128(0)])] {
            let mut c = after_a_sweep();
            act_as("market.near", 6);
            c.on_revenue_sent(U64(1), report);
            assert_eq!((c.revenue_due, c.revenue_unresolved), (0, 250_000));
            assert_eq!(legs(&c, 1).0, LegStatus::Unresolved);
        }
    }

    #[test]
    fn a_report_that_claims_more_than_was_sent_never_creates_money() {
        let mut c = after_a_sweep();
        act_as("market.near", 6);
        c.on_revenue_sent(U64(1), Ok(vec![U128(999_999_999)]));
        assert_eq!((c.revenue_due, c.revenue_unresolved), (0, 0));
    }

    // A callback that runs twice, or after the owner has already decided the leg, changes nothing.
    #[test]
    fn a_leg_ends_once_whatever_the_callback_does_next() {
        let mut c = after_a_sweep();
        act_as("market.near", 6);
        c.on_revenue_sent(U64(1), Ok(vec![U128(0)]));
        c.on_revenue_sent(U64(1), Ok(vec![U128(0)]));
        c.on_revenue_sent(U64(1), Err(PromiseError::Failed));
        c.on_treasury_sent(U64(1), Err(PromiseError::Failed));
        c.on_treasury_sent(U64(1), Err(PromiseError::Failed));
        assert_eq!(
            (c.revenue_due, c.treasury_due, c.revenue_unresolved),
            (250_000, 750_000, 0)
        );
    }

    // ---- a revenue transfer whose result is lost ---------------------------------------------------------

    fn after_a_sweep() -> MarketContract {
        let (mut c, _) = world();
        c.fees = 1_000_000;
        act_as(USERS[2], 5);
        c.sweep_fees();
        c
    }

    fn last_event() -> near_sdk::serde_json::Value {
        let logs = near_sdk::test_utils::get_logs();
        near_sdk::serde_json::from_str(logs.last().unwrap().strip_prefix("EVENT_JSON:").unwrap()).unwrap()
    }

    // The time a sweep made at nanosecond 5 can be settled and reconciled.
    const SETTLE_AT: u64 = 5 + SETTLE_WAIT_MINUTES * NS_PER_MINUTE;
    const RECONCILE_AT: u64 = 5 + RECONCILE_WAIT_MINUTES * NS_PER_MINUTE;

    fn lost_report() -> MarketContract {
        let mut c = after_a_sweep();
        act_as("market.near", 6);
        c.on_revenue_sent(U64(1), Err(PromiseError::Failed));
        c
    }

    #[test]
    fn a_lost_report_parks_the_amount_and_does_not_make_it_due_again() {
        let mut c = lost_report();
        assert_eq!((c.revenue_due, c.revenue_unresolved), (0, 250_000));
        assert_eq!(legs(&c, 1).0, LegStatus::Unresolved);
        let e = last_event();
        assert_eq!(e["event"], "fee_transfer_unresolved");
        assert_eq!(
            (e["data"]["amount"].as_str(), e["data"]["to"].as_str()),
            (Some("250000"), Some(COUNCIL))
        );
        assert_eq!(c.get_fees()["revenue_unresolved"], "250000");
        assert_eq!(c.config()["revenue_unresolved"], "250000");

        // The next sweep has nothing to send for it, so the same money cannot be paid twice.
        act_as(USERS[2], 7);
        assert_eq!(c.sweep_fees(), None);
        assert!(
            near_sdk::test_utils::get_logs().is_empty(),
            "nothing is due, so nothing is sent"
        );
        assert!(receipts().is_empty());
    }

    #[test]
    fn a_report_that_says_part_was_kept_still_returns_the_rest_to_due() {
        let mut c = after_a_sweep();
        act_as("market.near", 6);
        c.on_revenue_sent(U64(1), Ok(vec![U128(100_000)]));
        assert_eq!((c.revenue_due, c.revenue_unresolved), (150_000, 0));
        assert_eq!(legs(&c, 1).0, LegStatus::Refused);
        assert_eq!(last_event()["event"], "fee_transfer_failed");
    }

    // ---- settle_leg: the Council's own record decides ---------------------------------------------------------

    fn settle(c: &mut MarketContract, at: u64) {
        act_as(USERS[0], at);
        let _ = c.settle_leg(U64(1));
    }

    fn council_answers(c: &mut MarketContract, recorded: Option<u128>) {
        act_as("market.near", SETTLE_AT);
        c.on_council_checked(
            U64(1),
            Ok(recorded.map(|amount| CouncilReceipt { amount: U128(amount) })),
        );
    }

    #[test]
    fn a_leg_whose_result_was_lost_is_settled_when_the_council_recorded_the_sweep() {
        let mut c = lost_report();
        settle(&mut c, SETTLE_AT);
        let sent = receipts();
        let (method, args, _, gas) = call_of(&sent[0]);
        assert_eq!((method.as_str(), gas), ("received_of", GAS_COUNCIL_VIEW.as_gas()));
        assert_eq!(sent[0].receiver_id, acct(COUNCIL));
        assert_eq!(args["sweep_id"], "1");
        council_answers(&mut c, Some(250_000));
        assert_eq!((c.revenue_due, c.revenue_unresolved), (0, 0));
        assert_eq!(legs(&c, 1).0, LegStatus::Settled);
        assert_eq!(last_event()["event"], "fee_leg_settled");
    }

    #[test]
    fn a_leg_whose_result_was_lost_is_due_again_when_the_council_has_no_record() {
        let mut c = lost_report();
        settle(&mut c, SETTLE_AT);
        council_answers(&mut c, None);
        assert_eq!((c.revenue_due, c.revenue_unresolved), (250_000, 0));
        assert_eq!(legs(&c, 1).0, LegStatus::Refused);
        act_as(OWNER, SETTLE_AT);
        c.set_min_sweep(U128(1));
        act_as(USERS[2], SETTLE_AT + MIN_SWEEP_INTERVAL_NS);
        assert_eq!(c.sweep_fees(), Some(U64(2)));
        assert_eq!(c.get_sweep(U64(2)).unwrap().council.amount.0, 250_000);
        assert_eq!(c.get_sweep(U64(2)).unwrap().carried_council.0, 250_000);
    }

    #[test]
    fn a_council_that_cannot_answer_leaves_the_leg_unresolved_to_ask_again() {
        let mut c = lost_report();
        settle(&mut c, SETTLE_AT);
        act_as("market.near", SETTLE_AT);
        c.on_council_checked(U64(1), Err(PromiseError::Failed));
        assert_eq!((c.revenue_due, c.revenue_unresolved), (0, 250_000));
        assert_eq!(legs(&c, 1).0, LegStatus::Unresolved);
        settle(&mut c, SETTLE_AT + 1);
    }

    #[test]
    fn two_answers_to_the_same_question_settle_the_leg_once() {
        let mut c = lost_report();
        settle(&mut c, SETTLE_AT);
        council_answers(&mut c, None);
        council_answers(&mut c, None);
        council_answers(&mut c, Some(250_000));
        assert_eq!((c.revenue_due, c.revenue_unresolved), (250_000, 0));
    }

    #[test]
    #[should_panic(expected = "wait 10 minutes after the sweep before settling")]
    fn a_leg_is_not_settled_before_the_council_had_time_to_finish() {
        let mut c = lost_report();
        settle(&mut c, SETTLE_AT - 1);
    }

    #[test]
    #[should_panic(expected = "the leg is not unresolved")]
    fn only_an_unresolved_leg_is_settled() {
        let mut c = after_a_sweep();
        settle(&mut c, SETTLE_AT);
    }

    #[test]
    #[should_panic(expected = "no sweep to settle")]
    fn a_sweep_that_never_happened_is_not_settled() {
        let mut c = lost_report();
        act_as(USERS[0], SETTLE_AT);
        let _ = c.settle_leg(U64(2));
    }

    // ---- reconcile_leg: the owner decides when nothing else can ----------------------------------------------

    fn reconcile(c: &mut MarketContract, leg: LegKind, arrived: bool) {
        act_as(OWNER, RECONCILE_AT);
        c.reconcile_leg(U64(1), leg, arrived);
    }

    #[test]
    fn the_owner_returns_an_amount_that_never_arrived_to_due_and_the_next_sweep_sends_it_once() {
        let mut c = lost_report();
        reconcile(&mut c, LegKind::Council, false);
        assert_eq!((c.revenue_due, c.revenue_unresolved), (250_000, 0));
        let e = last_event();
        assert_eq!(e["event"], "fee_leg_reconciled");
        assert_eq!(
            (
                e["data"]["amount"].as_str(),
                e["data"]["arrived"].clone(),
                e["data"]["leg"].as_str()
            ),
            (Some("250000"), near_sdk::serde_json::json!(false), Some("council"))
        );
        act_as(OWNER, RECONCILE_AT);
        c.set_min_sweep(U128(1));
        act_as(USERS[2], RECONCILE_AT + 1);
        c.sweep_fees();
        assert_eq!(swept()["council"], "250000");
        assert_eq!(c.revenue_due, 0);
    }

    #[test]
    fn the_owner_settles_an_amount_that_did_arrive_and_it_is_never_sent_again() {
        let mut c = lost_report();
        reconcile(&mut c, LegKind::Council, true);
        assert_eq!((c.revenue_due, c.revenue_unresolved), (0, 0));
        assert_eq!(last_event()["data"]["arrived"], true);
        assert_eq!(legs(&c, 1).0, LegStatus::Settled);
        act_as(USERS[2], RECONCILE_AT + 1);
        assert_eq!(c.sweep_fees(), None);
        assert!(receipts().is_empty());
    }

    #[test]
    fn a_pending_leg_whose_callback_never_came_is_decided_by_the_owner_after_an_hour() {
        let mut c = after_a_sweep();
        reconcile(&mut c, LegKind::Treasury, false);
        assert_eq!((c.treasury_due, legs(&c, 1).1), (750_000, LegStatus::Refused));
        // The slow callback arrives after all and finds the leg decided.
        act_as("market.near", RECONCILE_AT + 1);
        c.on_treasury_sent(U64(1), Ok(()));
        assert_eq!((c.treasury_due, legs(&c, 1).1), (750_000, LegStatus::Refused));
    }

    #[test]
    #[should_panic(expected = "wait 60 minutes after the sweep before reconciling")]
    fn the_owner_waits_an_hour_before_deciding() {
        let mut c = lost_report();
        act_as(OWNER, RECONCILE_AT - 1);
        c.reconcile_leg(U64(1), LegKind::Council, true);
    }

    #[test]
    #[should_panic(expected = "the leg is neither pending nor unresolved")]
    fn a_leg_that_ended_cannot_be_reconciled() {
        let mut c = after_a_sweep();
        act_as("market.near", 6);
        c.on_treasury_sent(U64(1), Ok(()));
        reconcile(&mut c, LegKind::Treasury, false);
    }

    #[test]
    #[should_panic(expected = "no sweep to settle")]
    fn a_sweep_that_never_happened_is_not_reconciled() {
        let mut c = lost_report();
        act_as(OWNER, RECONCILE_AT);
        c.reconcile_leg(U64(9), LegKind::Council, true);
    }

    #[test]
    fn only_the_owner_reconciles() {
        let mut c = lost_report();
        act_as(OWNER, 7);
        c.set_operator(acct("ops.near"));
        for who in ["ops.near", USERS[0]] {
            act_as(who, RECONCILE_AT);
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                c.reconcile_leg(U64(1), LegKind::Council, false)
            }));
            assert!(caught.is_err(), "{who} must be refused");
        }
        assert_eq!((c.revenue_due, c.revenue_unresolved), (0, 250_000));
    }

    // ---- the split: exact rounding, a share the owner can move, and a record before any transfer ----------------

    #[test]
    fn the_split_rounds_both_parts_down_and_leaves_the_remainder_collected() {
        for (total, council, treasury, carry) in [
            (1_095_193, 273_798, 821_394, 1),
            (100, 25, 75, 0),
            (7, 1, 5, 1),
            (3, 0, 2, 1),
            (0, 0, 0, 0),
        ] {
            let (c, t) = split_fees(total, DEFAULT_REVENUE_SHARE_BPS);
            assert_eq!((c, t, total - c - t), (council, treasury, carry), "{total}");
        }
    }

    proptest! {
        // For any total and any share the owner may set, the two parts never exceed the total and the remainder is 0 or 1.
        #[test]
        fn the_two_parts_and_the_remainder_always_add_up_to_the_total(
            total in 0u128..1_000_000_000_000_000_000,
            share in MIN_REVENUE_SHARE_BPS..=MAX_REVENUE_SHARE_BPS
        ) {
            let (council, treasury) = split_fees(total, share);
            prop_assert!(council + treasury <= total);
            prop_assert!(total - council - treasury <= 1);
            prop_assert!(council <= total * share / BPS_DENOMINATOR);
        }
    }

    #[test]
    fn a_sweep_records_both_legs_before_it_sends_either_and_takes_the_next_id() {
        let (mut c, _) = world();
        c.fees = 1_095_193;
        c.revenue_due = 50;
        c.treasury_due = 70;
        act_as(USERS[2], 5);
        assert_eq!(c.sweep_fees(), Some(U64(1)));
        let s = c.get_sweep(U64(1)).unwrap();
        assert_eq!(
            (s.at.0, s.total.0, s.carried_council.0, s.carried_treasury.0),
            (5, 1_095_193, 50, 70)
        );
        assert_eq!(
            (s.council.amount.0, s.council.status, s.council.to.as_str()),
            (273_848, LegStatus::Pending, COUNCIL)
        );
        assert_eq!(
            (s.treasury.amount.0, s.treasury.status, s.treasury.to.as_str()),
            (821_464, LegStatus::Pending, TREASURY)
        );
        assert_eq!((c.fees, c.revenue_due, c.treasury_due), (1, 0, 0));
        let d = swept();
        assert_eq!(
            (
                d["id"].as_str(),
                d["total"].as_str(),
                d["council"].as_str(),
                d["treasury"].as_str()
            ),
            (Some("1"), Some("1095193"), Some("273848"), Some("821464"))
        );
        assert_eq!(
            (d["revenue_pool"].as_str(), d["treasury_account"].as_str()),
            (Some(COUNCIL), Some(TREASURY))
        );
        assert_eq!(c.list_sweeps(U64(0), U64(10)).len(), 1);
        c.fees = 2_000_000;
        act_as(USERS[2], 6 + MIN_SWEEP_INTERVAL_NS);
        assert_eq!(c.sweep_fees(), Some(U64(2)));
        assert_eq!(c.get_sweep(U64(3)).map(|s| s.id), None);
    }

    fn refusal(f: impl FnOnce()) -> String {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a refusal");
        err.downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    // A world where the first user already holds Yes shares in market 0, bought before any pause.
    fn world_with_a_holder() -> MarketContract {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        c
    }

    #[test]
    fn a_second_sweep_inside_the_interval_is_refused_and_one_after_it_works() {
        let (mut c, _) = world();
        c.fees = 2_000_000;
        act_as(USERS[2], 5);
        assert_eq!(c.sweep_fees(), Some(U64(1)));
        c.fees = 2_000_000;
        act_as(USERS[2], 5 + MIN_SWEEP_INTERVAL_NS - 1);
        let message = refusal(|| {
            let _ = c.sweep_fees();
        });
        assert_eq!(message, "wait an hour since the last sweep");
        assert_eq!(c.next_sweep_id, 2);
        act_as(USERS[2], 5 + MIN_SWEEP_INTERVAL_NS);
        assert_eq!(c.sweep_fees(), Some(U64(2)));
    }

    // A refused due stays owed and is retried on purpose, so a stranger could keep re-sweeping it. 200 tries in a day make
    // at most 24 records.
    #[test]
    fn two_hundred_sweep_attempts_in_a_day_leave_at_most_24_records() {
        let (mut c, _) = world();
        c.revenue_due = DEFAULT_MIN_SWEEP;
        let step = 24 * MIN_SWEEP_INTERVAL_NS / 200;
        for i in 0..200u64 {
            act_as(USERS[2], 5 + i * step);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sweep_fees()));
            c.revenue_due = DEFAULT_MIN_SWEEP;
        }
        assert!(
            c.next_sweep_id - FIRST_SWEEP_ID <= 24,
            "{} records",
            c.next_sweep_id - FIRST_SWEEP_ID
        );
    }

    #[test]
    fn the_operator_pause_leaves_sell_working_and_blocks_buy_and_deposit() {
        let mut c = world_with_a_holder();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        act_as("ops.near", 6);
        c.set_paused(true);
        assert_eq!(c.config()["sells_paused"], false);
        act_as(USERS[0], 7);
        c.sell(U64(0), "yes".into(), U128(1_000_000), U128(1));
        act_as(VERIFIER, 8);
        for msg in ["deposit", "buy:0:yes:1"] {
            let message = refusal(|| drop(receive(&mut c, acct(USERS[0]), U128(10_000_000), msg.into())));
            assert_eq!(message, "paused", "{msg}");
        }
    }

    #[test]
    fn only_the_owner_pauses_sells_and_it_stops_sell_alone() {
        let mut c = world_with_a_holder();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        act_as("ops.near", 6);
        assert_eq!(refusal(|| c.set_sells_paused(true)), "owner only");
        act_as(OWNER, 7);
        c.set_sells_paused(true);
        assert_eq!(c.config()["sells_paused"], true);
        act_as(USERS[0], 8);
        let message = refusal(|| c.sell(U64(0), "yes".into(), U128(1_000_000), U128(1)));
        assert_eq!(message, "sells are paused");
        act_as(VERIFIER, 9);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "deposit".into());
        act_as(OWNER, 10);
        c.set_sells_paused(false);
        act_as(USERS[0], 11);
        c.sell(U64(0), "yes".into(), U128(1_000_000), U128(1));
    }

    #[test]
    fn a_sweep_below_the_minimum_does_nothing_and_takes_no_id() {
        let (mut c, _) = world();
        c.fees = DEFAULT_MIN_SWEEP - 1;
        act_as(USERS[2], 5);
        assert_eq!(c.sweep_fees(), None);
        assert!(near_sdk::test_utils::get_logs().is_empty() && receipts().is_empty());
        assert_eq!((c.fees, c.next_sweep_id), (DEFAULT_MIN_SWEEP - 1, FIRST_SWEEP_ID));
        c.fees = DEFAULT_MIN_SWEEP;
        assert_eq!(c.sweep_fees(), Some(U64(FIRST_SWEEP_ID)));
    }

    #[test]
    fn dues_that_a_refusal_left_count_towards_the_minimum() {
        let (mut c, _) = world();
        c.fees = 0;
        c.revenue_due = 400_000;
        c.treasury_due = DEFAULT_MIN_SWEEP - 400_000;
        act_as(USERS[2], 5);
        assert_eq!(c.sweep_fees(), Some(U64(1)));
        assert_eq!(c.get_sweep(U64(1)).unwrap().total.0, 0);
    }

    // One unit cannot be split into a whole unit for either leg, so it waits.
    #[test]
    fn a_sweep_whose_legs_would_both_be_empty_takes_no_id() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_min_sweep(U128(1));
        c.fees = 1;
        assert_eq!(c.sweep_fees(), None);
        assert_eq!((c.fees, c.next_sweep_id), (1, FIRST_SWEEP_ID));
    }

    #[test]
    fn a_leg_with_nothing_in_it_is_settled_and_sends_nothing() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_min_sweep(U128(1));
        c.fees = 2;
        act_as(USERS[2], 5);
        assert_eq!(c.sweep_fees(), Some(U64(1)));
        assert_eq!(legs(&c, 1), (LegStatus::Settled, LegStatus::Pending));
        let sent = receipts();
        assert_eq!(sent.iter().filter(|r| r.receiver_id == acct(VERIFIER)).count(), 1);
        assert_eq!(c.fees, 1);
    }

    #[test]
    #[should_panic(expected = "the fee recipients are not set, the owner must call set_fee_recipients before a sweep")]
    fn a_sweep_refuses_until_the_owner_has_set_where_fees_go() {
        let (mut c, _) = unconfigured_world();
        c.fees = 5_000_000;
        act_as(USERS[2], 5);
        c.sweep_fees();
    }

    #[test]
    fn nothing_moves_and_nothing_is_recorded_while_the_recipients_are_unset() {
        let (mut c, _) = unconfigured_world();
        c.fees = 5_000_000;
        act_as(USERS[2], 5);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sweep_fees()));
        assert!(caught.is_err());
        assert_eq!(
            (c.fees, c.next_sweep_id, c.config()["treasury"].clone()),
            (5_000_000, 1, near_sdk::serde_json::Value::Null)
        );
        assert_eq!(c.config()["revenue_pool"], near_sdk::serde_json::Value::Null);
        act_as(OWNER, 6);
        c.set_fee_recipients(acct(COUNCIL), acct(TREASURY));
        act_as(USERS[2], 7);
        assert_eq!(c.sweep_fees(), Some(U64(1)));
    }

    #[test]
    fn the_owner_moves_the_council_share_and_the_treasury_gets_the_rest() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_revenue_share_bps(4_000);
        let e = last_event();
        assert_eq!(
            (
                e["event"].as_str(),
                e["data"]["revenue_share_bps"].clone(),
                e["data"]["treasury_share_bps"].clone()
            ),
            (
                Some("revenue_share_set"),
                near_sdk::serde_json::json!(4_000),
                near_sdk::serde_json::json!(6_000)
            )
        );
        assert_eq!(
            (
                c.config()["revenue_share_bps"].clone(),
                c.config()["treasury_share_bps"].clone()
            ),
            (near_sdk::serde_json::json!(4_000), near_sdk::serde_json::json!(6_000))
        );
        c.fees = 1_000_000;
        act_as(USERS[2], 5);
        c.sweep_fees();
        let d = swept();
        assert_eq!(
            (d["council"].as_str(), d["treasury"].as_str()),
            (Some("400000"), Some("600000"))
        );
    }

    #[test]
    fn a_sweep_keeps_the_split_it_was_made_with() {
        let (mut c, _) = world();
        c.fees = 1_000_000;
        act_as(USERS[2], 5);
        c.sweep_fees();
        act_as(OWNER, 6);
        c.set_revenue_share_bps(MAX_REVENUE_SHARE_BPS as u32);
        let s = c.get_sweep(U64(1)).unwrap();
        assert_eq!((s.council.amount.0, s.treasury.amount.0), (250_000, 750_000));
    }

    #[test]
    fn the_share_stays_between_its_bounds() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_revenue_share_bps(MIN_REVENUE_SHARE_BPS as u32);
        c.set_revenue_share_bps(MAX_REVENUE_SHARE_BPS as u32);
        for bad in [
            0,
            MIN_REVENUE_SHARE_BPS as u32 - 1,
            MAX_REVENUE_SHARE_BPS as u32 + 1,
            10_000,
            u32::MAX,
        ] {
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_revenue_share_bps(bad)));
            assert!(caught.is_err(), "{bad} must be refused");
        }
        assert_eq!(c.revenue_share_bps, MAX_REVENUE_SHARE_BPS);
    }

    #[test]
    fn the_minimum_sweep_and_the_first_sweep_id_are_the_owners_to_set_within_bounds() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_min_sweep(U128(MAX_MIN_SWEEP));
        assert_eq!(last_event()["event"], "min_sweep_set");
        assert_eq!(c.config()["min_sweep"], MAX_MIN_SWEEP.to_string());
        for bad in [0, MAX_MIN_SWEEP + 1] {
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_min_sweep(U128(bad))));
            assert!(caught.is_err(), "{bad} must be refused");
        }
        c.set_next_sweep_id(U64(500));
        assert_eq!(c.config()["next_sweep_id"], "500");
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_next_sweep_id(U64(499))));
        assert!(caught.is_err(), "an id is never reused");
        c.set_min_sweep(U128(1));
        c.fees = 1_000_000;
        act_as(USERS[2], 5);
        assert_eq!(c.sweep_fees(), Some(U64(500)));
    }

    #[test]
    fn only_the_owner_sets_the_split_the_minimum_and_the_ids() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_operator(acct("ops.near"));
        let calls: [fn(&mut MarketContract); 3] = [
            |c| c.set_revenue_share_bps(3_000),
            |c| c.set_min_sweep(U128(5)),
            |c| c.set_next_sweep_id(U64(9)),
        ];
        for who in ["ops.near", USERS[0]] {
            for (n, call) in calls.into_iter().enumerate() {
                act_as(who, 4);
                let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(&mut c)));
                assert!(caught.is_err(), "{who} must be refused setter {n}");
            }
        }
        assert_eq!(
            (c.revenue_share_bps, c.min_sweep, c.next_sweep_id),
            (DEFAULT_REVENUE_SHARE_BPS, DEFAULT_MIN_SWEEP, FIRST_SWEEP_ID)
        );
    }

    #[test]
    #[should_panic(expected = "the Council and the treasury must be different accounts")]
    fn the_council_and_the_treasury_cannot_be_one_account() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_fee_recipients(acct(COUNCIL), acct(COUNCIL));
    }

    #[test]
    fn the_recipients_are_the_owners_to_change_and_later_sweeps_follow_them() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_fee_recipients(acct("new-council.near"), acct("new-treasury.near"));
        assert_eq!(c.config()["revenue_pool"], "new-council.near");
        assert_eq!(c.config()["treasury"], "new-treasury.near");
        assert_eq!(last_event()["event"], "fee_recipients_set");
        c.fees = 1_000_000;
        act_as(USERS[2], 5);
        c.sweep_fees();
        let s = c.get_sweep(U64(1)).unwrap();
        assert_eq!(
            (s.council.to.as_str(), s.treasury.to.as_str()),
            ("new-council.near", "new-treasury.near")
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // Whatever the transfers report and whenever the owner or anyone settles a leg, every unit of fee is in exactly one
        // place: still collected, due, unresolved, on its way out, or gone for good. Nothing is created and nothing is paid
        // twice, and every leg of every sweep ends in settled or refused.
        #[test]
        fn fee_money_is_in_exactly_one_place_whatever_the_transfers_report(
            ops in proptest::collection::vec((0u8..6, 1u128..5_000_000, 0u8..3), 1..80)
        ) {
            let (mut c, _) = world();
            act_as(OWNER, 3);
            c.set_min_sweep(U128(1));
            let (mut added, mut gone) = (c.fees, 0u128);
            let mut on_the_way: Vec<(u64, LegKind, u128)> = vec![];
            let mut unresolved: Vec<(u64, u128)> = vec![];
            let mut sweep_clock = 5;
            for (op, amount, how) in ops {
                match op {
                    0 => {
                        c.fees += amount;
                        added += amount;
                    }
                    1 => {
                        sweep_clock += MIN_SWEEP_INTERVAL_NS;
                        act_as(USERS[2], sweep_clock);
                        if let Some(id) = c.sweep_fees() {
                            let s = c.get_sweep(id).unwrap();
                            if s.council.status == LegStatus::Pending { on_the_way.push((id.0, LegKind::Council, s.council.amount.0)); }
                            if s.treasury.status == LegStatus::Pending { on_the_way.push((id.0, LegKind::Treasury, s.treasury.amount.0)); }
                        }
                    }
                    2 if !on_the_way.is_empty() => {
                        let (id, kind, sent) = on_the_way.remove(amount as usize % on_the_way.len());
                        act_as("market.near", 6);
                        match (kind, how) {
                            (LegKind::Council, 0) => { c.on_revenue_sent(U64(id), Ok(vec![U128(sent)])); gone += sent; }
                            (LegKind::Council, 1) => { let used = sent / 3; c.on_revenue_sent(U64(id), Ok(vec![U128(used)])); gone += used; }
                            (LegKind::Council, _) => { c.on_revenue_sent(U64(id), Err(PromiseError::Failed)); unresolved.push((id, sent)); }
                            (LegKind::Treasury, 0) => { c.on_treasury_sent(U64(id), Ok(())); gone += sent; }
                            (LegKind::Treasury, _) => c.on_treasury_sent(U64(id), Err(PromiseError::Failed)),
                        }
                    }
                    3 if !unresolved.is_empty() => {
                        let (id, sent) = unresolved.remove(amount as usize % unresolved.len());
                        act_as("market.near", 7);
                        let recorded = if how == 0 { Some(sent) } else { None };
                        c.on_council_checked(U64(id), Ok(recorded.map(|a| CouncilReceipt { amount: U128(a) })));
                        gone += recorded.unwrap_or(0);
                    }
                    4 if !unresolved.is_empty() => {
                        let (id, sent) = unresolved.remove(amount as usize % unresolved.len());
                        act_as(OWNER, sweep_clock + RECONCILE_WAIT_MINUTES * NS_PER_MINUTE);
                        c.reconcile_leg(U64(id), LegKind::Council, how == 0);
                        if how == 0 { gone += sent; }
                    }
                    5 if !on_the_way.is_empty() => {
                        let (id, kind, sent) = on_the_way.remove(amount as usize % on_the_way.len());
                        act_as(OWNER, sweep_clock + RECONCILE_WAIT_MINUTES * NS_PER_MINUTE);
                        c.reconcile_leg(U64(id), kind, how == 0);
                        if how == 0 { gone += sent; }
                    }
                    _ => {}
                }
                let sent_not_reported: u128 = on_the_way.iter().map(|(_, _, a)| a).sum();
                let held = c.fees + c.revenue_due + c.treasury_due + c.revenue_unresolved;
                prop_assert_eq!(held + sent_not_reported + gone, added, "a unit of fee is missing or counted twice");
                prop_assert_eq!(c.revenue_unresolved, unresolved.iter().map(|(_, a)| a).sum::<u128>());
            }
        }
    }

    // ---- the sweep's gas floor ---------------------------------------------------------------------------

    fn act_with_gas(who: &str, tgas: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .block_timestamp(5)
            .prepaid_gas(Gas::from_tgas(tgas))
            .build());
    }

    #[test]
    #[should_panic(expected = "attach at least 87 TGas: a sweep sends the Council its part and the treasury its part")]
    fn a_sweep_with_less_than_its_floor_is_refused_and_says_how_much() {
        let (mut c, _) = world();
        c.fees = 1_000_000;
        act_with_gas(USERS[2], 86);
        c.sweep_fees();
    }

    // The mocked chain meters gas by its own fee table, so the sweep that sends is measured in the sandbox; here nothing is
    // due, which gets past the check and stops.
    #[test]
    fn a_sweep_with_exactly_its_floor_gets_past_the_check() {
        let (mut c, _) = world();
        c.fees = 0;
        act_with_gas(USERS[2], 87);
        c.sweep_fees();
        assert_eq!(
            GAS_SWEEP_FLOOR,
            Gas::from_tgas(87),
            "the Council's 22 and 20, the treasury's 15 and 10, and 10 for the call itself"
        );
    }

    // ---- code: staging, upgrade, migrate and seal ---------------------------------------------------------

    const WASM: &[u8] = &[0, 97, 115, 109, 1, 0, 0, 0, 9, 9, 9];
    const KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
    const SELF: &str = "alice.near";

    fn stage_wasm(c: &mut MarketContract, deposit: NearToken) -> Base58CryptoHash {
        let mut builder = VMContextBuilder::new();
        builder
            .predecessor_account_id(acct("anyone.near"))
            .attached_deposit(deposit);
        builder.context.input = WASM.to_vec().into();
        testing_env!(builder.build());
        c.stage_code()
    }

    fn staged(c: &mut MarketContract) -> Base58CryptoHash {
        stage_wasm(c, NearToken::from_near(5))
    }

    fn receipts() -> Vec<near_sdk::mock::Receipt> {
        near_sdk::test_utils::get_created_receipts()
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn staging_with_too_little_deposit_is_refused() {
        let (mut c, _) = world();
        stage_wasm(&mut c, NearToken::from_yoctonear(1));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_stranger_cannot_upgrade() {
        let (mut c, _) = world();
        let hash = staged(&mut c);
        act_unpaid("stranger.near", 5);
        let _ = c.upgrade(hash);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn the_operator_cannot_upgrade() {
        let (mut c, _) = world();
        let hash = staged(&mut c);
        act_unpaid(OWNER, 5);
        c.set_operator(acct("ops.near"));
        act_unpaid("ops.near", 6);
        let _ = c.upgrade(hash);
    }

    #[test]
    #[should_panic(expected = "no code is staged under that hash")]
    fn an_upgrade_to_a_hash_nobody_staged_is_refused() {
        let (mut c, _) = world();
        act_unpaid(OWNER, 5);
        let _ = c.upgrade(Base58CryptoHash::from([5u8; 32]));
    }

    #[test]
    #[should_panic(expected = "attach at least 100 TGas to upgrade")]
    fn an_upgrade_with_too_little_gas_is_refused_and_says_how_much() {
        let (mut c, _) = world();
        let hash = staged(&mut c);
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(OWNER))
            .prepaid_gas(Gas::from_tgas(99))
            .build());
        let _ = c.upgrade(hash);
    }

    #[test]
    fn the_owner_deploys_the_staged_code_and_migrates_in_one_batch_and_the_copy_is_removed() {
        let (mut c, _) = world();
        let hash = staged(&mut c);
        assert!(c.is_staged(hash));
        act_unpaid(OWNER, 5);
        let _ = c.upgrade(hash);
        assert!(!c.is_staged(hash), "the staged copy is gone");
        let batch = &receipts()[0];
        assert_eq!(batch.receiver_id.as_str(), SELF);
        assert!(matches!(&batch.actions[0], near_sdk::mock::MockAction::DeployContract { code, .. } if code == WASM));
        assert!(
            matches!(&batch.actions[1], near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } if method_name == b"migrate")
        );
    }

    #[test]
    #[should_panic(expected = "prove the upgrade path before deleting keys")]
    fn seal_is_refused_until_an_upgrade_has_gone_through() {
        let (mut c, _) = world();
        act_unpaid(OWNER, 5);
        let _ = c.seal(KEY.parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_stranger_cannot_seal() {
        let (mut c, _) = world();
        c.upgrade_proven = true;
        act_unpaid("stranger.near", 5);
        let _ = c.seal(KEY.parse().unwrap());
    }

    #[test]
    fn once_proven_the_owner_deletes_a_key() {
        let (mut c, _) = world();
        c.upgrade_proven = true;
        act_unpaid(OWNER, 5);
        let _ = c.seal(KEY.parse().unwrap());
        assert!(
            matches!(&receipts()[0].actions[0], near_sdk::mock::MockAction::DeleteKey { public_key, .. } if public_key.to_string() == KEY)
        );
    }

    #[test]
    fn migrate_keeps_the_markets_and_balances_and_marks_the_upgrade_proven() {
        let (mut c, _) = world();
        assert!(!c.upgrade_proven);
        c.upgrade_in_flight = true;
        let locked = c.market(0).locked;
        env::state_write(&c);
        drop(c);
        act_unpaid(SELF, 5);
        let migrated = MarketContract::migrate();
        assert_eq!(
            (
                (migrated.upgrade_proven, migrated.upgrade_in_flight),
                migrated.state_version,
                migrated.market(0).locked
            ),
            ((true, false), STATE_VERSION, locked)
        );
        assert_eq!(migrated.config()["upgrade_proven"], true);
        assert!(migrated.check_invariant(U64(0)));
    }

    #[test]
    #[should_panic(expected = "migrate runs only inside an upgrade")]
    fn migrate_called_by_hand_is_refused_and_proves_nothing() {
        let (c, _) = world();
        env::state_write(&c);
        drop(c);
        act_unpaid(SELF, 5);
        MarketContract::migrate();
    }

    #[test]
    fn upgrade_marks_the_upgrade_in_flight_and_a_second_one_sets_it_again() {
        let (mut c, _) = world();
        let hash = staged(&mut c);
        assert!(!c.upgrade_in_flight);
        act_unpaid(OWNER, 5);
        let _ = c.upgrade(hash);
        assert!(c.upgrade_in_flight);
        assert_eq!(c.config()["upgrade_in_flight"], true);
        c.upgrade_in_flight = false;
        let again = staged(&mut c);
        act_unpaid(OWNER, 6);
        let _ = c.upgrade(again);
        assert!(c.upgrade_in_flight, "the next upgrade sets it again");
    }

    #[test]
    #[should_panic(expected = "unsupported state version")]
    fn migrate_refuses_state_written_by_another_version() {
        let (mut c, _) = world();
        c.state_version = STATE_VERSION + 1;
        env::state_write(&c);
        drop(c);
        act_unpaid(SELF, 5);
        MarketContract::migrate();
    }

    // The way out is the users' protection around an upgrade, so no pause may close it.
    #[test]
    fn withdraw_and_redeem_still_work_while_the_market_is_paused() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        act_as(ORACLE, CLOSE);
        c.set_outcome(U64(0), Outcome::Yes);
        act_as(OWNER, CLOSE + 1);
        c.set_paused(true);
        act_as(USERS[0], CLOSE + 2);
        let paid = c.redeem(U64(0));
        assert!(paid.0 > 0);
        let _ = c.withdraw(paid);
        assert_eq!(c.get_balance(acct(USERS[0])).0, 0);
    }

    #[test]
    fn a_signed_action_moves_only_the_signers_money() {
        let (mut c, mut total_in) = world();
        let ann = acct(USERS[0]);
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, ann.clone(), U128(20_000_000), "deposit".into());
        total_in += 20_000_000;
        let _ = c.on_auth(ann.clone(), "buy:0:yes:10000000:1".into());
        let (yes, _) = holdings(&c, 0, USERS[0]);
        assert!(yes > 0);
        assert_eq!(c.get_balance(ann.clone()).0, 10_000_000);
        let q = c.quote_sell(U64(0), "yes".into(), U128(yes / 2));
        let _ = c.on_auth(
            ann.clone(),
            format!("sell:0:yes:{}:{}", yes / 2, q.collateral_out.0 - q.fee.0),
        );
        assert_eq!(c.get_balance(ann.clone()).0, 10_000_000 + q.collateral_out.0 - q.fee.0);
        assert_conserved(&c, total_in);

        act_as(ORACLE, CLOSE);
        c.set_outcome(U64(0), Outcome::Yes);
        act_as(VERIFIER, CLOSE + 1);
        let _ = c.on_auth(ann.clone(), "redeem:0".into());
        assert_eq!(holdings(&c, 0, USERS[0]), (0, 0));
        let all = c.get_balance(ann.clone()).0;
        let _ = c.on_auth(ann.clone(), format!("withdraw:{all}"));
        assert_eq!(c.get_balance(ann.clone()).0, 0);
        assert_eq!(c.pending_by_account.get(&ann).copied(), Some(all));
        for other in [USERS[1], USERS[2], VERIFIER] {
            assert_eq!(c.get_balance(acct(other)).0, 0);
        }
        assert_conserved(&c, total_in);
    }

    #[test]
    #[should_panic(expected = "only the verifier can act for a signer")]
    fn a_signed_action_comes_only_from_the_verifier() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(5_000_000), "deposit".into());
        act_as(USERS[1], 3);
        let _ = c.on_auth(acct(USERS[0]), "withdraw:5000000".into());
    }

    #[test]
    #[should_panic(expected = "unknown action")]
    fn an_unknown_signed_action_is_refused() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = c.on_auth(acct(USERS[0]), "deposit".into());
    }

    #[test]
    #[should_panic(expected = "bad amount")]
    fn a_signed_withdrawal_names_its_amount() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = c.on_auth(acct(USERS[0]), "withdraw:".into());
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn a_signed_buy_is_refused_while_the_market_is_paused() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(5_000_000), "deposit".into());
        act_as(OWNER, 4);
        c.set_paused(true);
        act_as(VERIFIER, 5);
        let _ = c.on_auth(acct(USERS[0]), "buy:0:yes:5000000:1".into());
    }

    #[test]
    fn a_signed_exit_still_works_while_the_market_is_paused() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        act_as(ORACLE, CLOSE);
        c.set_outcome(U64(0), Outcome::Yes);
        act_as(OWNER, CLOSE + 1);
        c.set_paused(true);
        act_as(VERIFIER, CLOSE + 2);
        let _ = c.on_auth(acct(USERS[0]), "redeem:0".into());
        let paid = c.get_balance(acct(USERS[0])).0;
        assert!(paid > 0);
        let _ = c.on_auth(acct(USERS[0]), format!("withdraw:{paid}"));
        assert_eq!(c.get_balance(acct(USERS[0])).0, 0);
    }

    #[test]
    #[should_panic(expected = "sells are paused")]
    fn a_signed_sell_obeys_the_owners_sell_pause() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        act_as(OWNER, 4);
        c.set_sells_paused(true);
        act_as(VERIFIER, 5);
        let _ = c.on_auth(acct(USERS[0]), "sell:0:yes:1000000:1".into());
    }

    // ---- NEP-145 storage management ---------------------------------------------------------------------

    const FIFTY_MILLI: NearToken = NearToken::from_millinear(50);

    fn act_paying(who: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .block_timestamp(5)
            .attached_deposit(deposit)
            .build());
    }

    // Every plain transfer the last call created, as (receiver, amount).
    fn refunds() -> Vec<(String, NearToken)> {
        receipts()
            .iter()
            .flat_map(|r| {
                r.actions.iter().filter_map(|a| match a {
                    near_sdk::mock::MockAction::Transfer { deposit, .. } => Some((r.receiver_id.to_string(), *deposit)),
                    _ => None,
                })
            })
            .collect()
    }

    fn blank_world() -> MarketContract {
        let (c, _) = world();
        c
    }

    #[test]
    fn a_deposit_of_exactly_the_minimum_registers_the_caller_and_refunds_nothing() {
        let mut c = blank_world();
        act_paying("zed.near", FIFTY_MILLI);
        let balance = c.storage_deposit(None, None);
        assert_eq!(
            (balance.total, balance.available),
            (FIFTY_MILLI, NearToken::from_yoctonear(0))
        );
        assert!(c.is_registered(acct("zed.near")));
        assert!(refunds().is_empty());
    }

    #[test]
    fn the_surplus_goes_back_to_the_caller() {
        let mut c = blank_world();
        act_paying("zed.near", NearToken::from_millinear(200));
        c.storage_deposit(None, Some(true));
        assert_eq!(
            refunds(),
            vec![("zed.near".to_string(), NearToken::from_millinear(150))]
        );
    }

    #[test]
    fn a_third_party_registers_another_account_and_gets_the_surplus_back() {
        let mut c = blank_world();
        act_paying("ann2.near", NearToken::from_millinear(80));
        let balance = c.storage_deposit(Some(acct("zed.near")), Some(true));
        assert_eq!(balance.total, FIFTY_MILLI);
        assert!(c.is_registered(acct("zed.near")), "the named account is registered");
        assert!(!c.is_registered(acct("ann2.near")), "the payer is not");
        assert_eq!(
            refunds(),
            vec![("ann2.near".to_string(), NearToken::from_millinear(30))]
        );
    }

    #[test]
    fn registering_an_account_that_is_already_registered_refunds_the_whole_deposit() {
        let mut c = blank_world();
        act_paying(USERS[0], FIFTY_MILLI);
        let balance = c.storage_deposit(None, None);
        assert_eq!(balance.total, FIFTY_MILLI);
        assert_eq!(refunds(), vec![(USERS[0].to_string(), FIFTY_MILLI)]);
    }

    #[test]
    #[should_panic(expected = "attach at least 0.05 NEAR")]
    fn a_deposit_one_yocto_short_registers_nobody() {
        let mut c = blank_world();
        act_paying("zed.near", NearToken::from_yoctonear(FIFTY_MILLI.as_yoctonear() - 1));
        c.storage_deposit(None, None);
    }

    #[test]
    fn the_bounds_are_the_flat_deposit_and_the_balance_of_a_registered_account_has_nothing_available() {
        let c = blank_world();
        let bounds = c.storage_balance_bounds();
        assert_eq!((bounds.min, bounds.max), (FIFTY_MILLI, Some(FIFTY_MILLI)));
        let balance = c.storage_balance_of(acct(USERS[0])).unwrap();
        assert_eq!(
            (balance.total, balance.available),
            (FIFTY_MILLI, NearToken::from_yoctonear(0))
        );
        assert!(c.storage_balance_of(acct("zed.near")).is_none());
    }

    #[test]
    fn the_json_shapes_are_the_ones_the_standard_names() {
        let c = blank_world();
        let balance = near_sdk::serde_json::to_value(c.storage_balance_of(acct(USERS[0])).unwrap()).unwrap();
        assert_eq!(balance, json!({ "total": "50000000000000000000000", "available": "0" }));
        let bounds = near_sdk::serde_json::to_value(c.storage_balance_bounds()).unwrap();
        assert_eq!(
            bounds,
            json!({ "min": "50000000000000000000000", "max": "50000000000000000000000" })
        );
    }

    #[test]
    fn withdrawing_nothing_is_fine_and_withdrawing_anything_is_refused() {
        let mut c = blank_world();
        act_as(USERS[0], 5);
        assert_eq!(c.storage_withdraw(None).available, NearToken::from_yoctonear(0));
        assert_eq!(
            c.storage_withdraw(Some(NearToken::from_yoctonear(0))).total,
            FIFTY_MILLI
        );
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.storage_withdraw(Some(NearToken::from_yoctonear(1)))
        }));
        assert!(caught.is_err(), "there is nothing above the flat deposit");
    }

    #[test]
    #[should_panic(expected = "the account is not registered")]
    fn an_unregistered_account_cannot_withdraw() {
        let mut c = blank_world();
        act_as("zed.near", 5);
        c.storage_withdraw(None);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn withdraw_and_unregister_need_exactly_one_yocto() {
        let mut c = blank_world();
        act_unpaid(USERS[0], 5);
        c.storage_unregister(None);
    }

    #[test]
    fn an_empty_account_unregisters_and_gets_the_deposit_back() {
        let mut c = blank_world();
        act_as(USERS[0], 5);
        assert!(c.storage_unregister(None));
        assert!(!c.is_registered(acct(USERS[0])));
        assert_eq!(
            refunds(),
            vec![(USERS[0].to_string(), FIFTY_MILLI.saturating_add(ONE_YOCTO))]
        );
        assert_eq!(c.get_balance(acct(USERS[0])).0, 0);
        act_as(USERS[0], 6);
        assert!(!c.storage_unregister(None), "a second call finds nothing to close");
    }

    #[test]
    #[should_panic(expected = "redeem or sell your positions first")]
    fn an_account_with_shares_cannot_unregister() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1);
        act_as(USERS[0], 5);
        c.storage_unregister(None);
    }

    #[test]
    #[should_panic(expected = "withdraw your balance first")]
    fn an_account_with_a_balance_cannot_unregister() {
        let mut c = blank_world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(5_000_000), "deposit".into());
        act_as(USERS[0], 5);
        c.storage_unregister(None);
    }

    #[test]
    #[should_panic(expected = "force is not supported")]
    fn force_is_refused_so_nobody_burns_a_balance_by_accident() {
        let mut c = blank_world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(5_000_000), "deposit".into());
        act_as(USERS[0], 5);
        c.storage_unregister(Some(true));
    }

    #[test]
    #[should_panic(expected = "do the storage deposit first")]
    fn after_unregistering_a_deposit_is_refused_until_the_account_registers_again() {
        let mut c = blank_world();
        act_as(USERS[0], 5);
        assert!(c.storage_unregister(None));
        act_as(VERIFIER, 6);
        let _ = receive(&mut c, acct(USERS[0]), U128(5_000_000), "deposit".into());
    }

    // Selling everything can leave a share of dust (the quote rounds against the seller), so the way out is to redeem.
    #[test]
    fn an_account_that_redeemed_and_withdrew_everything_can_leave() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1);
        act_as(ORACLE, CLOSE + 1);
        c.set_outcome(U64(0), Outcome::Yes);
        act_as(USERS[0], CLOSE + 2);
        let paid = c.redeem(U64(0));
        let _ = c.withdraw(paid);
        act_as("market.near", CLOSE + 3);
        c.on_withdraw(U64(1), Ok(()));
        act_as(USERS[0], CLOSE + 4);
        assert!(c.storage_unregister(None));
        assert!(!c.is_registered(acct(USERS[0])));
    }

    // A user with nothing but one withdrawal of their whole balance in flight.
    fn leaving_with_a_withdrawal_in_flight() -> MarketContract {
        let (mut c, _) = world();
        deposit(&mut c, USERS[0], 3_000_000);
        act_as(USERS[0], WITHDRAWN_AT);
        let _ = c.withdraw(U128(3_000_000));
        c
    }

    #[test]
    fn an_account_cannot_leave_while_a_withdrawal_is_in_flight() {
        let mut c = leaving_with_a_withdrawal_in_flight();
        act_as(USERS[0], 5);
        assert!(refusal(|| {
            c.storage_unregister(None);
        })
        .contains("a withdrawal is still pending"));
        assert!(c.is_registered(acct(USERS[0])));
    }

    #[test]
    fn an_account_can_leave_after_the_withdrawal_is_confirmed() {
        let mut c = leaving_with_a_withdrawal_in_flight();
        act_as("market.near", 5);
        c.on_withdraw(U64(1), Ok(()));
        act_as(USERS[0], 6);
        assert!(c.storage_unregister(None));
        assert!(!c.is_registered(acct(USERS[0])));
    }

    #[test]
    fn a_failed_withdrawal_credits_back_and_the_account_still_leaves_only_empty() {
        let mut c = leaving_with_a_withdrawal_in_flight();
        act_as("market.near", 5);
        c.on_withdraw(U64(1), Err(PromiseError::Failed));
        act_as(USERS[0], 6);
        assert!(refusal(|| {
            c.storage_unregister(None);
        })
        .contains("withdraw your balance first"));
        assert!(refusal(|| {
            c.storage_unregister(Some(true));
        })
        .contains("force is not supported"));
        let _ = c.withdraw(U128(3_000_000));
        act_as("market.near", 7);
        c.on_withdraw(U64(2), Ok(()));
        act_as(USERS[0], 8);
        assert!(c.storage_unregister(None));
    }

    #[test]
    fn an_account_can_leave_after_the_owner_reconciles_its_withdrawal() {
        let mut c = leaving_with_a_withdrawal_in_flight();
        act_as(OWNER, WITHDRAWAL_DECIDABLE_AT);
        c.reconcile_withdrawal(U64(1), true);
        act_as(USERS[0], WITHDRAWAL_DECIDABLE_AT + 1);
        assert!(c.storage_unregister(None));
        assert!(!c.is_registered(acct(USERS[0])));
    }

    #[test]
    fn a_collateral_registration_takes_the_fee_for_the_treasury_and_credits_the_rest() {
        let (mut c, total_in) = world();
        let treasury_before = c.treasury_due;
        let paid = DEFAULT_REGISTRATION_FEE + 5_000_000;
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct("zed.near"), U128(paid), "register".into());
        assert!(c.is_registered(acct("zed.near")));
        assert_eq!(c.registrations.get(&acct("zed.near")), Some(&Registration::Collateral));
        assert_eq!(c.get_balance(acct("zed.near")).0, 5_000_000);
        assert_eq!(c.treasury_due, treasury_before + DEFAULT_REGISTRATION_FEE);
        assert_eq!(c.total_owed().0, total_in + paid);
        let _ = receive(&mut c, acct("zed.near"), U128(10_000_000), "buy:0:yes:1".into());
        assert!(holdings(&c, 0, "zed.near").0 > 0);
    }

    #[test]
    #[should_panic(expected = "send at least the registration fee")]
    fn a_collateral_registration_below_the_fee_is_refused() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(
            &mut c,
            acct("zed.near"),
            U128(DEFAULT_REGISTRATION_FEE - 1),
            "register".into(),
        );
    }

    #[test]
    #[should_panic(expected = "already registered")]
    fn an_account_registers_only_once() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(
            &mut c,
            acct(USERS[0]),
            U128(DEFAULT_REGISTRATION_FEE),
            "register".into(),
        );
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn a_collateral_registration_waits_out_a_pause() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_paused(true);
        act_as(VERIFIER, 4);
        let _ = receive(
            &mut c,
            acct("zed.near"),
            U128(DEFAULT_REGISTRATION_FEE),
            "register".into(),
        );
    }

    #[test]
    fn a_sponsor_gets_the_deposit_back_and_the_account_its_yocto() {
        let mut c = blank_world();
        act_paying("ann2.near", FIFTY_MILLI);
        c.storage_deposit(Some(acct("zed.near")), None);
        assert_eq!(
            c.registrations.get(&acct("zed.near")),
            Some(&Registration::Sponsored {
                payer: acct("ann2.near")
            })
        );
        act_as("zed.near", 5);
        assert!(c.storage_unregister(None));
        assert_eq!(
            refunds(),
            vec![
                ("ann2.near".to_string(), FIFTY_MILLI),
                ("zed.near".to_string(), ONE_YOCTO)
            ]
        );
        assert!(c.registrations.get(&acct("zed.near")).is_none());
    }

    #[test]
    fn an_account_registered_with_collateral_leaves_with_only_its_yocto() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(
            &mut c,
            acct("zed.near"),
            U128(DEFAULT_REGISTRATION_FEE),
            "register".into(),
        );
        act_as("zed.near", 4);
        assert!(c.storage_unregister(None));
        assert_eq!(refunds(), vec![("zed.near".to_string(), ONE_YOCTO)]);
        assert!(!c.is_registered(acct("zed.near")));
        assert!(c.registrations.get(&acct("zed.near")).is_none());
    }

    #[test]
    fn a_registration_the_verifier_paid_for_refunds_the_account_itself() {
        let mut c = blank_world();
        act_paying(VERIFIER, FIFTY_MILLI);
        c.storage_deposit(Some(acct("zed.near")), None);
        assert!(c.registrations.get(&acct("zed.near")).is_none());
        act_as("zed.near", 5);
        assert!(c.storage_unregister(None));
        assert_eq!(
            refunds(),
            vec![("zed.near".to_string(), FIFTY_MILLI.saturating_add(ONE_YOCTO))]
        );
    }

    #[test]
    fn the_registration_fee_moves_only_within_its_hard_range_and_only_by_the_owner() {
        let (mut c, _) = world();
        act_as(USERS[0], 3);
        assert!(refused(|| c.set_registration_fee(U128(DEFAULT_REGISTRATION_FEE))));
        act_as(OWNER, 3);
        for fee in [HARD_MIN_REGISTRATION_FEE - 1, HARD_MAX_REGISTRATION_FEE + 1] {
            assert!(refused(|| c.set_registration_fee(U128(fee))));
        }
        for fee in [HARD_MIN_REGISTRATION_FEE, HARD_MAX_REGISTRATION_FEE] {
            c.set_registration_fee(U128(fee));
            assert_eq!(c.config()["registration_fee"], fee.to_string());
        }
    }

    // ---- owner-set policy values, each inside a hard range ---------------------------------------------------

    const HOUR_NS: u64 = 3_600_000_000_000;
    const DAY_NS: u64 = 24 * HOUR_NS;

    fn refused(f: impl FnOnce()) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }

    #[test]
    fn only_the_owner_sets_the_policy_values() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_operator(acct("ops.near"));
        let calls: [fn(&mut MarketContract); 4] = [
            |c| c.set_void_grace(U64(2 * DAY_NS)),
            |c| c.set_sweep_timing(5, 90, 60),
            |c| c.set_max_positions(30),
            |c| c.set_fee_limits(400, 1_500, 4_000, U128(50_000_000)),
        ];
        for who in ["ops.near", USERS[0]] {
            for (n, call) in calls.into_iter().enumerate() {
                act_as(who, 4);
                let message = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(&mut c)))
                    .err()
                    .map(|e| {
                        e.downcast_ref::<String>()
                            .cloned()
                            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                assert!(message.contains("owner only"), "{who} setter {n}: {message}");
            }
        }
    }

    #[test]
    fn the_config_starts_at_the_built_in_values() {
        let (c, _) = world();
        let cfg = c.config();
        assert_eq!(
            (
                cfg["void_grace_ns"].as_str(),
                cfg["settle_wait_minutes"].as_u64(),
                cfg["reconcile_wait_minutes"].as_u64(),
                cfg["min_sweep_interval_minutes"].as_u64(),
                cfg["max_positions"].as_u64(),
            ),
            (Some("604800000000000"), Some(10), Some(60), Some(60), Some(20))
        );
        assert_eq!(
            (
                cfg["max_fee_rate_bps"].as_u64(),
                cfg["min_revenue_share_bps"].as_u64(),
                cfg["max_revenue_share_bps"].as_u64(),
                cfg["max_min_sweep"].as_str(),
            ),
            (Some(500), Some(1_000), Some(5_000), Some("100000000"))
        );
        for gone in [
            "create_fee",
            "max_create_fee",
            "min_open_price",
            "max_open_price",
            "void_price_window_ns",
        ] {
            assert!(cfg.get(gone).is_none(), "{gone}");
        }
    }

    #[test]
    fn the_void_grace_stays_inside_its_range() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_void_grace(U64(DAY_NS));
        c.set_void_grace(U64(60 * DAY_NS));
        for grace in [DAY_NS - 1, 60 * DAY_NS + 1, 0] {
            assert!(refused(|| c.set_void_grace(U64(grace))), "{grace}");
        }
        assert_eq!(c.void_grace_ns, 60 * DAY_NS);
        assert_eq!(last_event()["event"], "void_grace_set");
    }

    #[test]
    fn the_void_grace_reaches_only_markets_created_after_the_change() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_void_grace(U64(2 * DAY_NS));
        let e = last_event();
        assert_eq!(e["event"], "void_grace_set");
        assert_eq!(e["data"]["grace_ns"].as_str(), Some("172800000000000"));
        assert_eq!(c.config()["void_grace_ns"], "172800000000000");
        let fresh = create_registered(&mut c, OWNER);
        assert_eq!(c.market(0).void_grace_ns, VOID_GRACE_NS);
        assert_eq!(c.market(fresh).void_grace_ns, 2 * DAY_NS);

        act_as(USERS[2], RESOLVE_BY + 2 * DAY_NS);
        assert!(
            refused(|| c.void_if_unresolved(U64(0))),
            "the old market still waits 7 days"
        );
        c.void_if_unresolved(U64(fresh));
        assert_eq!(c.market(fresh).outcome, Some(Outcome::Void));
        act_as(USERS[2], RESOLVE_BY + VOID_GRACE_NS);
        c.void_if_unresolved(U64(0));
        assert_eq!(c.market(0).outcome, Some(Outcome::Void));
    }

    #[test]
    fn sweep_timing_stays_inside_its_ranges() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_sweep_timing(1, 10, 60);
        c.set_sweep_timing(1_440, 10_080, 1_440);
        assert_eq!(last_event()["event"], "sweep_timing_set");
        for (settle, reconcile, interval) in [
            (0, 60, 60),
            (1_441, 10_080, 60),
            (10, 9, 60),
            (10, 10_081, 60),
            (30, 20, 60),
            (10, 60, 0),
            (10, 60, 59),
            (10, 60, 1_441),
        ] {
            assert!(
                refused(|| c.set_sweep_timing(settle, reconcile, interval)),
                "{settle} {reconcile} {interval}"
            );
        }
        assert_eq!(
            (
                c.settle_wait_minutes,
                c.reconcile_wait_minutes,
                c.min_sweep_interval_minutes
            ),
            (1_440, 10_080, 1_440)
        );
    }

    #[test]
    fn a_longer_settle_wait_refuses_settling_at_eleven_minutes() {
        let mut c = lost_report();
        act_as(OWNER, 6);
        c.set_sweep_timing(30, 120, 60);
        let e = last_event();
        assert_eq!(
            (
                e["event"].as_str(),
                e["data"]["settle_wait_minutes"].as_u64(),
                e["data"]["reconcile_wait_minutes"].as_u64()
            ),
            (Some("sweep_timing_set"), Some(30), Some(120))
        );
        assert_eq!(c.config()["settle_wait_minutes"], 30);
        assert_eq!(c.config()["reconcile_wait_minutes"], 120);
        assert_eq!(c.config()["min_sweep_interval_minutes"], 60);
        act_as(USERS[0], SETTLE_AT);
        assert!(refused(|| {
            let _ = c.settle_leg(U64(1));
        }));
        act_as(USERS[0], 5 + 30 * NS_PER_MINUTE);
        let _ = c.settle_leg(U64(1));
    }

    #[test]
    fn a_longer_reconcile_wait_refuses_reconciling_at_an_hour() {
        let mut c = lost_report();
        act_as(OWNER, 6);
        c.set_sweep_timing(10, 120, 60);
        act_as(OWNER, RECONCILE_AT);
        assert!(refused(|| c.reconcile_leg(U64(1), LegKind::Council, false)));
        act_as(OWNER, 5 + 120 * NS_PER_MINUTE);
        c.reconcile_leg(U64(1), LegKind::Council, false);
        assert_eq!((c.revenue_due, c.revenue_unresolved), (250_000, 0));
    }

    #[test]
    fn a_two_hour_sweep_interval_allows_a_second_sweep_after_121_minutes() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_min_sweep(U128(1));
        c.set_sweep_timing(10, 60, 120);
        c.fees = 1_000_000;
        act_as(USERS[2], 5);
        assert_eq!(c.sweep_fees(), Some(U64(1)));
        c.fees = 1_000_000;
        act_as(USERS[2], 5 + 4 * NS_PER_MINUTE);
        assert!(refused(|| {
            c.sweep_fees();
        }));
        act_as(USERS[2], 5 + 121 * NS_PER_MINUTE);
        assert_eq!(c.sweep_fees(), Some(U64(2)));
    }

    #[test]
    fn max_positions_stays_inside_its_range() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_max_positions(5);
        c.set_max_positions(30);
        assert_eq!(last_event()["event"], "max_positions_set");
        for bad in [0, 4, 31, 100] {
            assert!(refused(|| c.set_max_positions(bad)), "{bad}");
        }
        assert_eq!(c.config()["max_positions"], 30);
    }

    // A full account is either a share and a cost record in each of 15 markets, or both sides and a cost record in each
    // of 10. Both must fit the flat deposit for the longest account id.
    #[test]
    fn the_deposit_pays_for_an_account_at_the_hard_position_cap_with_the_longest_id() {
        for sides in [1u8, 2] {
            let (mut c, _) = world();
            act_as(OWNER, 3);
            let flush = |c: &mut MarketContract| {
                c.accounts.flush();
                c.balances.flush();
                c.shares.flush();
                c.costs.flush();
                c.position_markets.flush();
                c.pending_by_account.flush();
                c.registrations.flush();
            };
            flush(&mut c);
            let who: AccountId = "f".repeat(64).parse().unwrap();
            let before = env::storage_usage();
            c.accounts.insert(who.clone(), 0);
            c.registrations.insert(
                who.clone(),
                Registration::Sponsored {
                    payer: "e".repeat(64).parse().unwrap(),
                },
            );
            c.max_positions = HARD_MAX_POSITIONS;
            c.credit(&who, 1);
            c.pending_by_account.insert(who.clone(), 1);
            let markets = u64::from(HARD_MAX_POSITIONS) / (u64::from(sides) + 1);
            for id in 0..markets {
                let mut m = blank();
                for idx in 0..sides {
                    c.add_shares(&mut m, &who, 1_000 + id, idx, 1);
                }
                c.add_cost(&mut m, 1_000 + id, &who, 1, 0);
            }
            assert_eq!(c.accounts.get(&who).copied(), Some(HARD_MAX_POSITIONS));
            flush(&mut c);
            let used = u128::from(env::storage_usage() - before);
            let paid = STORAGE_DEPOSIT.as_yoctonear() / env::storage_byte_cost().as_yoctonear();
            assert!(
                used <= paid,
                "{used} bytes for {markets} markets on {sides} side(s), the deposit pays for {paid}"
            );
        }
    }

    #[test]
    fn a_lower_position_cap_stops_new_positions_and_leaves_held_ones() {
        let (mut c, _) = world();
        let mut ids = vec![];
        for _ in 0..4 {
            ids.push(create_registered(&mut c, OWNER));
        }
        act_as(VERIFIER, 7);
        for id in &ids[..3] {
            let _ = receive(&mut c, acct(USERS[0]), U128(1_000_000), format!("buy:{id}:yes:1"));
        }
        assert_eq!(c.accounts.get(&acct(USERS[0])).copied(), Some(6));
        act_as(OWNER, 8);
        c.set_max_positions(5);
        assert_eq!(c.config()["max_positions"], 5);
        act_as(VERIFIER, 9);
        let fourth = refused(|| {
            let _ = receive(&mut c, acct(USERS[0]), U128(1_000_000), format!("buy:{}:yes:1", ids[3]));
        });
        assert!(fourth, "the account holds 6 entries and the cap is 5");
        let _ = receive(&mut c, acct(USERS[0]), U128(1_000_000), format!("buy:{}:yes:1", ids[0]));
        assert_eq!(
            c.accounts.get(&acct(USERS[0])).copied(),
            Some(6),
            "adding to a held position needs no entry"
        );
    }

    #[test]
    fn fee_limits_stay_inside_their_ranges() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_fee_limits(2_000, 500, 9_000, U128(1_000_000_000));
        assert_eq!(last_event()["event"], "fee_limits_set");
        c.set_fee_limits(200, 2_400, 2_600, U128(1_000_000));
        let bad: [(u32, u32, u32, u128); 7] = [
            (2_001, 1_000, 5_000, 100_000_000),
            (500, 499, 5_000, 100_000_000),
            (500, 1_000, 9_001, 100_000_000),
            (500, 3_000, 3_000, 100_000_000),
            (500, 4_000, 3_000, 100_000_000),
            (500, 1_000, 5_000, 0),
            (500, 1_000, 5_000, 1_000_000_001),
        ];
        for (rate, low, high, sweep) in bad {
            assert!(
                refused(|| c.set_fee_limits(rate, low, high, U128(sweep))),
                "{rate} {low} {high} {sweep}"
            );
        }
        assert_eq!(
            (c.max_fee_rate_bps, c.min_revenue_share_bps, c.max_revenue_share_bps),
            (200, 2_400, 2_600)
        );
    }

    #[test]
    fn a_limit_that_would_leave_a_current_value_outside_it_is_refused() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        // Current values: rate 200, share 2_500, minimum sweep 1_000_000.
        let cases: [(u32, u32, u32, u128); 5] = [
            (199, 1_000, 5_000, 100_000_000),
            (500, 2_501, 5_000, 100_000_000),
            (500, 1_000, 2_499, 100_000_000),
            (500, 1_000, 5_000, 999_999),
            (0, 1_000, 5_000, 1),
        ];
        for (rate, low, high, sweep) in cases {
            assert!(
                refused(|| c.set_fee_limits(rate, low, high, U128(sweep))),
                "{rate} {low} {high} {sweep}"
            );
        }
        c.set_fee_limits(200, 2_500, 2_501, U128(1_000_000));
        c.set_fee_rate_bps(100);
        c.set_fee_limits(100, 1_000, 5_000, U128(1_000_000));
        assert_eq!(c.max_fee_rate_bps, 100);
    }

    #[test]
    fn the_fee_setters_check_the_stored_limits() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_fee_limits(1_000, 1_000, 7_000, U128(400_000_000));
        let e = last_event();
        assert_eq!(e["event"], "fee_limits_set");
        assert_eq!(
            (
                e["data"]["max_fee_rate_bps"].as_u64(),
                e["data"]["min_revenue_share_bps"].as_u64(),
                e["data"]["max_revenue_share_bps"].as_u64(),
                e["data"]["max_min_sweep"].as_str(),
            ),
            (Some(1_000), Some(1_000), Some(7_000), Some("400000000"))
        );
        let cfg = c.config();
        assert_eq!(
            (
                cfg["max_fee_rate_bps"].as_u64(),
                cfg["min_revenue_share_bps"].as_u64(),
                cfg["max_revenue_share_bps"].as_u64(),
                cfg["max_min_sweep"].as_str(),
            ),
            (Some(1_000), Some(1_000), Some(7_000), Some("400000000"))
        );
        c.set_fee_rate_bps(1_000);
        c.set_revenue_share_bps(7_000);
        c.set_min_sweep(U128(400_000_000));
        assert!(refused(|| c.set_fee_rate_bps(1_001)));
        assert!(refused(|| c.set_revenue_share_bps(7_001)));
        assert!(refused(|| c.set_min_sweep(U128(400_000_001))));
    }

    // ---- the account's list of markets ------------------------------------------------------------------

    const HOLDERS: [&str; 4] = [USERS[0], USERS[1], USERS[2], OWNER];

    fn indexed(c: &MarketContract, who: &str) -> Vec<u64> {
        c.position_markets.get(&acct(who)).cloned().unwrap_or_default()
    }

    fn held_in(c: &MarketContract, who: &str) -> Vec<u64> {
        (0..c.next_market_id)
            .filter(|&id| {
                let (y, n) = holdings(c, id, who);
                y + n > 0
            })
            .collect()
    }

    // The list of markets is exactly the markets with a non-empty entry, and get_positions lists exactly those.
    fn assert_index_matches(c: &MarketContract, who: &str) {
        let held = held_in(c, who);
        assert_eq!(
            if c.is_exempt(&acct(who)) {
                Vec::new()
            } else {
                indexed(c, who)
            },
            if c.is_exempt(&acct(who)) {
                Vec::new()
            } else {
                held.clone()
            },
            "the index of {who} drifted from its share entries"
        );
        let listed: Vec<u64> = c
            .get_positions(acct(who), None, None)
            .iter()
            .map(|p| p.market_id.0)
            .collect();
        assert_eq!(listed, held, "get_positions of {who} lists other markets than it holds");
        assert_eq!(c.get_account(acct(who)).positions.unwrap() as usize, held.len());
    }

    // The scan get_positions used before the index, kept to compare against.
    fn scanned_positions(c: &MarketContract, who: &str) -> near_sdk::serde_json::Value {
        let account_id = acct(who);
        let mut left = c.accounts.get(&account_id).copied().unwrap_or(0);
        let mut out = Vec::new();
        for id in 0..c.next_market_id {
            if left == 0 {
                break;
            }
            let yes = c.shares.get(&(id, account_id.clone(), 0)).copied().unwrap_or(0);
            let no = c.shares.get(&(id, account_id.clone(), 1)).copied().unwrap_or(0);
            left = left.saturating_sub(u32::from(yes > 0) + u32::from(no > 0));
            let Some(m) = c.find_market(id).filter(|_| yes + no > 0) else {
                continue;
            };
            out.push(PositionView {
                market_id: U64(id),
                yes: U128(yes),
                no: U128(no),
                status: m.status(c.is_halted(id, &m)).to_string(),
                outcome: m.outcome,
                redeemable: U128(
                    m.outcome
                        .map_or(0, |o| m.payout(o, yes, no, c.claim_of(id, &account_id))),
                ),
            });
        }
        near_sdk::serde_json::to_value(out).unwrap()
    }

    // Empties one side.
    fn sell_all(c: &mut MarketContract, who: &str, id: u64, side: &str) {
        let (y, n) = holdings(c, id, who);
        let held = if side == "yes" { y } else { n };
        act_as(who, 3);
        c.sell(U64(id), side.to_string(), U128(held), U128(1));
        let (y, n) = holdings(c, id, who);
        assert_eq!(if side == "yes" { y } else { n }, 0);
    }

    #[test]
    fn yes_and_no_in_one_market_keep_one_index_entry() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 5_000_000, 1);
        step(&mut c, &mut total_in, 1, 0, 0, 5_000_000, 1);
        let (y, n) = holdings(&c, 0, USERS[0]);
        assert!(y > 0 && n > 0);
        assert_eq!(indexed(&c, USERS[0]), vec![0]);
        assert_eq!(
            c.accounts.get(&acct(USERS[0])).copied(),
            Some(3),
            "two share entries and one cost record"
        );
        assert_index_matches(&c, USERS[0]);
    }

    #[test]
    fn selling_one_side_keeps_the_market_and_selling_the_other_drops_it() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 5_000_000, 1);
        step(&mut c, &mut total_in, 1, 0, 0, 5_000_000, 1);
        step(&mut c, &mut total_in, 0, 0, 1, 5_000_000, 1);
        sell_all(&mut c, USERS[0], 0, "yes");
        assert_eq!(indexed(&c, USERS[0]), vec![0, 1]);
        assert_index_matches(&c, USERS[0]);
        sell_all(&mut c, USERS[0], 0, "no");
        assert_eq!(indexed(&c, USERS[0]), vec![1]);
        assert_index_matches(&c, USERS[0]);
        sell_all(&mut c, USERS[0], 1, "yes");
        assert!(
            c.position_markets.get(&acct(USERS[0])).is_none(),
            "an empty list leaves no record"
        );
        assert_index_matches(&c, USERS[0]);
    }

    #[test]
    fn redeem_removes_the_market_from_the_index() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 1, 0, 5_000_000, 1);
        step(&mut c, &mut total_in, 1, 1, 0, 5_000_000, 1);
        step(&mut c, &mut total_in, 0, 1, 1, 5_000_000, 1);
        act_as(ORACLE, CLOSE + 1);
        c.set_outcome(U64(0), Outcome::Yes);
        act_as(USERS[1], CLOSE + 2);
        c.redeem(U64(0));
        assert_eq!(indexed(&c, USERS[1]), vec![1]);
        assert_index_matches(&c, USERS[1]);
    }

    #[test]
    fn the_owner_holds_shares_without_an_index_entry() {
        let (mut c, _) = world();
        let id = create_registered(&mut c, OWNER);
        fund(&mut c, id, 7_000_000, 3_000_000);
        assert!(indexed(&c, OWNER).is_empty(), "exempt accounts are not indexed");
        assert_index_matches(&c, OWNER);
    }

    #[test]
    fn the_operator_holds_a_position_in_every_market_past_the_cap() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        c.accounts.insert(acct("ops.near"), 0);
        let count = MAX_POSITIONS as u64 + 15;
        for _ in 0..count {
            let id = create_registered(&mut c, "ops.near");
            act_as(VERIFIER, 6);
            let _ = receive(&mut c, acct("ops.near"), U128(1_000_000), format!("buy:{id}:no:1"));
        }
        let ids = indexed(&c, "ops.near");
        assert!(ids.is_empty());
        assert_eq!(c.get_positions(acct("ops.near"), None, None).len(), count as usize);
        assert_index_matches(&c, "ops.near");
        assert_eq!(scanned_positions(&c, "ops.near"), positions_json(&c, "ops.near"));
    }

    #[test]
    fn unregistering_leaves_no_index_record() {
        let (mut c, mut total_in) = world();
        c.accounts.insert(acct("dan.near"), 0);
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct("dan.near"), U128(5_000_000), "buy:0:yes:1".to_string());
        total_in += 5_000_000;
        let _ = total_in;
        assert_eq!(indexed(&c, "dan.near"), vec![0]);
        sell_all(&mut c, "dan.near", 0, "yes");
        c.balances.remove(&acct("dan.near"));
        act_as("dan.near", 4);
        assert!(c.storage_unregister(None));
        assert!(c.position_markets.get(&acct("dan.near")).is_none());
    }

    #[test]
    fn get_positions_matches_the_old_scan_for_a_mixed_state() {
        let mut c = positions_world();
        let mut total_in = 0;
        step(&mut c, &mut total_in, 0, 1, 2, 3_000_000, 1);
        step(&mut c, &mut total_in, 1, 2, 3, 3_000_000, 1);
        let all_match = |c: &MarketContract| {
            for who in HOLDERS.iter().chain(["nobody.near"].iter()) {
                assert_eq!(scanned_positions(c, who), positions_json(c, who), "{who}");
            }
        };
        all_match(&c);
        resolve_positions_world(&mut c);
        all_match(&c);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // After every buy, sell, resolution, redeem and withdrawal, each account's list of markets is exactly the
        // markets in which it has a non-empty share entry, and get_positions lists exactly those.
        #[test]
        fn the_index_always_equals_the_markets_an_account_holds(
            ops in proptest::collection::vec((0u8..8, 0usize..4, 0u64..4, 1_000_000u128..40_000_000, 1u128..101), 1..80)
        ) {
            let (mut c, _) = world();
            for _ in 0..2 {
                create_registered(&mut c, OWNER);
            }
            for (op, user, id, amount, frac) in ops {
                let who = HOLDERS[user];
                let m = c.market(id);
                let live = m.outcome.is_none();
                match op {
                    0 | 1 | 4 if live => {
                        act_as(VERIFIER, 3);
                        let side = if op == 1 { "no" } else { "yes" };
                        let _ = receive(&mut c, acct(who), U128(amount), format!("buy:{id}:{side}:1"));
                    }
                    2 | 3 if live => {
                        let (y, n) = holdings(&c, id, who);
                        let (held, side) = if op == 2 { (y, "yes") } else { (n, "no") };
                        let offer = held * frac / 100;
                        let q = c.quote_sell(U64(id), side.to_string(), U128(offer));
                        if q.collateral_out.0 > q.fee.0 {
                            act_as(who, 3);
                            c.sell(U64(id), side.to_string(), U128(offer), U128(1));
                        }
                    }
                    5 if live => {
                        act_as(ORACLE, CLOSE + 1);
                        c.set_outcome(U64(id), [Outcome::Yes, Outcome::No, Outcome::Void][(amount % 3) as usize]);
                    }
                    6 if m.outcome.is_some() => {
                        let (y, n) = holdings(&c, id, who);
                        if y + n > 0 {
                            act_as(who, CLOSE + 3);
                            c.redeem(U64(id));
                        }
                    }
                    7 => {
                        let bal = c.get_balance(acct(who)).0;
                        if bal > 0 {
                            act_as(who, 4);
                            let _ = c.withdraw(U128(bal.min(amount)));
                        }
                    }
                    _ => {}
                }
                for h in HOLDERS {
                    assert_index_matches(&c, h);
                }
            }
        }
    }

    // ---- events an indexer rebuilds state from, and the version tags on stored records ----------------------------

    fn event_named(name: &str) -> near_sdk::serde_json::Value {
        near_sdk::test_utils::get_logs()
            .iter()
            .rev()
            .filter_map(|l| {
                near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(l.strip_prefix("EVENT_JSON:")?).ok()
            })
            .find(|e| e["event"] == name)
            .unwrap_or_else(|| panic!("no {name} event was logged"))["data"]
            .clone()
    }

    fn assert_prices(e: &near_sdk::serde_json::Value, c: &MarketContract, id: u64) {
        let m = c.market(id);
        let price_yes = m.price_yes();
        assert_eq!(
            (
                e["price_yes"].as_str(),
                e["price_no"].as_str(),
                e["yes_shares"].as_str(),
                e["no_shares"].as_str()
            ),
            (
                Some(price_yes.to_string().as_str()),
                Some((1_000_000 - price_yes).to_string().as_str()),
                Some(m.user_yes.to_string().as_str()),
                Some(m.user_no.to_string().as_str())
            )
        );
    }

    #[test]
    fn a_new_market_logs_what_an_indexer_needs_to_list_it() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.create_paid(
            "Will it rain".into(),
            "r".into(),
            "s".into(),
            "v".into(),
            "weather".into(),
            "rain".into(),
            U64(CLOSE),
            U64(RESOLVE_BY),
            None,
        );
        let e = event_named("market_created");
        assert_eq!(e["market_id"], "2");
        assert_eq!(
            (
                e["title"].as_str(),
                e["category"].as_str(),
                e["subcategory"].as_str(),
                e["close_at"].as_str(),
                e["resolve_by"].as_str()
            ),
            (
                Some("Will it rain"),
                Some("weather"),
                Some("rain"),
                Some("10000"),
                Some("20000")
            )
        );
        assert!(e["rule_hash"].as_str().is_some_and(|h| h.len() == 64));
    }

    #[test]
    fn a_buy_and_a_sell_log_the_shares_and_prices_after_the_trade() {
        let (mut c, _) = world();
        fund(&mut c, 0, 3_000_000, 7_000_000);
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        let e = event_named("buy");
        assert_eq!((e["market_id"].as_str(), e["side"].as_str()), (Some("0"), Some("yes")));
        assert_prices(&e, &c, 0);
        let bought = holdings(&c, 0, USERS[0]).0;

        let s = c.quote_sell(U64(0), "yes".into(), U128(bought));
        act_as(USERS[0], 4);
        c.sell(U64(0), "yes".into(), U128(bought), U128(1));
        let e = event_named("sell");
        assert_eq!(
            (e["side"].as_str(), e["fee"].as_str(), e["collateral"].as_str()),
            (
                Some("yes"),
                Some(s.fee.0.to_string().as_str()),
                Some(s.collateral_out.0.to_string().as_str())
            )
        );
        assert_prices(&e, &c, 0);
    }

    #[test]
    fn a_redeem_logs_the_shares_it_burned() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        let yes = holdings(&c, 0, USERS[0]).0;
        act_as(ORACLE, CLOSE);
        c.set_outcome(U64(0), Outcome::Yes);
        act_as(USERS[0], CLOSE + 1);
        let paid = c.redeem(U64(0));
        let e = event_named("redeemed");
        assert_eq!(
            (e["amount"].as_str(), e["yes_shares"].as_str(), e["no_shares"].as_str()),
            (
                Some(paid.0.to_string().as_str()),
                Some(yes.to_string().as_str()),
                Some("0")
            )
        );
    }

    #[test]
    fn outcome_set_says_whether_the_market_refunds() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 1_000_000, 1);
        act_as(ORACLE, CLOSE);
        c.set_outcome(U64(0), Outcome::Yes);
        let e = event_named("outcome_set");
        assert_eq!(
            (e["outcome"].as_str(), e["refunds"].as_bool()),
            (Some("yes"), Some(false))
        );

        act_as(ORACLE, CLOSE);
        c.set_outcome(U64(1), Outcome::Void);
        let e = event_named("outcome_set");
        assert_eq!(
            (e["market_id"].as_str(), e["outcome"].as_str(), e["refunds"].as_bool()),
            (Some("1"), Some("void"), Some(true))
        );
    }

    #[test]
    fn the_deadline_void_refunds_too() {
        let (mut c, _) = world();
        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(0));
        let e = event_named("outcome_set");
        assert_eq!(
            (e["by"].as_str(), e["refunds"].as_bool()),
            (Some("deadline"), Some(true))
        );
    }

    #[test]
    fn a_failed_registration_and_its_retry_are_logged() {
        let (mut c, _) = world();
        let mut m = c.market(0);
        m.registered = false;
        c.store_market(0, m);
        act_as("market.near", 5);
        c.on_registered(U64(0), Err(PromiseError::Failed));
        assert_eq!(event_named("market_registration_failed")["market_id"], "0");
        assert!(!c.market(0).registered);

        act_as(OWNER, 6);
        c.retry_register(U64(0));
        assert_eq!(event_named("market_registration_retried")["market_id"], "0");

        act_as("market.near", 7);
        c.on_registered(U64(0), Ok(()));
        assert_eq!(event_named("market_registered")["market_id"], "0");
    }

    #[test]
    fn withdrawal_events_carry_the_id_the_account_and_the_amount() {
        let (mut c, _) = world();
        c.credit(&acct(USERS[0]), 5_000_000);
        act_as(USERS[0], 5);
        let _ = c.withdraw(U128(3_000_000));
        let sent = event_named("withdraw");
        act_as("market.near", 6);
        c.on_withdraw(U64(1), Ok(()));
        let done = event_named("withdraw_confirmed");
        for e in [sent, done] {
            assert_eq!(
                (e["id"].as_str(), e["account"].as_str(), e["amount"].as_str()),
                (Some("1"), Some(USERS[0]), Some("3000000"))
            );
        }

        act_as(USERS[0], 7);
        let _ = c.withdraw(U128(1_000_000));
        act_as("market.near", 8);
        c.on_withdraw(U64(2), Err(PromiseError::Failed));
        let e = event_named("withdraw_failed");
        assert_eq!(
            (e["id"].as_str(), e["account"].as_str(), e["amount"].as_str()),
            (Some("2"), Some(USERS[0]), Some("1000000"))
        );

        act_as(USERS[0], 9);
        let _ = c.withdraw(U128(500_000));
        act_as(OWNER, 9 + RECONCILE_WAIT_MINUTES * NS_PER_MINUTE);
        c.reconcile_withdrawal(U64(3), true);
        let e = event_named("withdrawal_reconciled");
        assert_eq!(
            (
                e["id"].as_str(),
                e["account"].as_str(),
                e["amount"].as_str(),
                e["paid"].as_bool()
            ),
            (Some("3"), Some(USERS[0]), Some("500000"), Some(true))
        );
    }

    #[test]
    fn every_fee_leg_event_names_the_sweep_the_leg_and_the_recipient() {
        let mut c = after_a_sweep();
        let e = event_named("fees_swept");
        assert_eq!(
            (
                e["id"].as_str(),
                e["revenue_pool"].as_str(),
                e["treasury_account"].as_str()
            ),
            (Some("1"), Some(COUNCIL), Some(TREASURY))
        );

        act_as("market.near", 6);
        c.on_treasury_sent(U64(1), Ok(()));
        let e = event_named("fee_leg_settled");
        assert_eq!(
            (
                e["id"].as_str(),
                e["leg"].as_str(),
                e["to"].as_str(),
                e["amount"].as_str()
            ),
            (Some("1"), Some("treasury"), Some(TREASURY), Some("750000"))
        );

        c.on_revenue_sent(U64(1), Err(PromiseError::Failed));
        let e = event_named("fee_transfer_unresolved");
        assert_eq!(
            (
                e["id"].as_str(),
                e["leg"].as_str(),
                e["to"].as_str(),
                e["amount"].as_str()
            ),
            (Some("1"), Some("council"), Some(COUNCIL), Some("250000"))
        );

        act_as(OWNER, RECONCILE_AT);
        c.reconcile_leg(U64(1), LegKind::Council, false);
        let e = event_named("fee_leg_reconciled");
        assert_eq!(
            (
                e["id"].as_str(),
                e["leg"].as_str(),
                e["to"].as_str(),
                e["amount"].as_str(),
                e["arrived"].as_bool()
            ),
            (Some("1"), Some("council"), Some(COUNCIL), Some("250000"), Some(false))
        );
    }

    #[test]
    fn a_refused_leg_names_the_recipient_and_the_amount_that_came_back() {
        let mut c = after_a_sweep();
        act_as("market.near", 6);
        c.on_revenue_sent(U64(1), Ok(vec![U128(100_000)]));
        let e = event_named("fee_transfer_failed");
        assert_eq!(
            (
                e["id"].as_str(),
                e["leg"].as_str(),
                e["to"].as_str(),
                e["amount"].as_str()
            ),
            (Some("1"), Some("council"), Some(COUNCIL), Some("150000"))
        );
    }

    #[test]
    fn settle_leg_asks_the_council_about_this_market_and_the_sweep() {
        let mut c = lost_report();
        settle(&mut c, SETTLE_AT);
        let sent = receipts();
        let (method, args, _, _) = call_of(&sent[0]);
        assert_eq!(method, "received_of");
        assert_eq!(sent[0].receiver_id, acct(COUNCIL));
        assert_eq!(args["market"], env::current_account_id().as_str());
        assert_eq!(args["sweep_id"], "1");
    }

    use near_sdk::borsh::BorshDeserialize;

    fn storage_key<K: near_sdk::borsh::BorshSerialize>(prefix: Key, id: K) -> Vec<u8> {
        [
            near_sdk::borsh::to_vec(&prefix).unwrap(),
            near_sdk::borsh::to_vec(&id).unwrap(),
        ]
        .concat()
    }

    #[test]
    fn a_stored_market_starts_with_version_byte_zero_and_reads_back() {
        let (mut c, _) = world();
        c.markets.flush();
        let bytes = env::storage_read(&storage_key(Key::Markets, 0u64)).unwrap();
        assert_eq!(bytes[0], 0);
        let again = VersionedMarket::try_from_slice(&bytes).unwrap().into_current();
        assert_eq!(
            near_sdk::borsh::to_vec(&again).unwrap(),
            near_sdk::borsh::to_vec(&c.market(0)).unwrap()
        );
        assert_eq!(bytes[1..], near_sdk::borsh::to_vec(&c.market(0)).unwrap()[..]);
    }

    #[test]
    fn a_stored_sweep_starts_with_version_byte_zero_and_reads_back() {
        let mut c = after_a_sweep();
        c.sweeps.flush();
        let bytes = env::storage_read(&storage_key(Key::Sweeps, 1u64)).unwrap();
        assert_eq!(bytes[0], 0);
        let again = VersionedSweep::try_from_slice(&bytes).unwrap().into_current();
        assert_eq!(again.council.amount.0, 250_000);
        assert_eq!(bytes[1..], near_sdk::borsh::to_vec(&c.sweep(1)).unwrap()[..]);
    }

    #[test]
    fn a_stored_withdrawal_starts_with_version_byte_zero_and_reads_back() {
        let (mut c, _) = world();
        c.credit(&acct(USERS[0]), 5_000_000);
        act_as(USERS[0], 5);
        let _ = c.withdraw(U128(3_000_000));
        c.withdrawals.flush();
        let bytes = env::storage_read(&storage_key(Key::Withdrawals, 1u64)).unwrap();
        assert_eq!(bytes[0], 0);
        let again = VersionedWithdrawal::try_from_slice(&bytes).unwrap().into_current();
        assert_eq!((again.account, again.amount.0), (acct(USERS[0]), 3_000_000));
    }

    // No second layout exists yet, so what can be checked is that a tag nobody wrote is refused on the real read path.
    #[test]
    #[should_panic(expected = "Cannot deserialize element")]
    fn a_market_with_an_unknown_version_tag_is_refused() {
        let (mut c, _) = world();
        c.markets.flush();
        let key = storage_key(Key::Markets, 0u64);
        let mut bytes = env::storage_read(&key).unwrap();
        bytes[0] = 2;
        env::storage_write(&key, &bytes);
        c.markets = LookupMap::new(Key::Markets);
        c.market(0);
    }

    #[test]
    #[should_panic(expected = "Cannot deserialize element")]
    fn a_sweep_with_an_unknown_version_tag_is_refused() {
        let mut c = after_a_sweep();
        c.sweeps.flush();
        let key = storage_key(Key::Sweeps, 1u64);
        let mut bytes = env::storage_read(&key).unwrap();
        bytes[0] = 1;
        env::storage_write(&key, &bytes);
        c.sweeps = LookupMap::new(Key::Sweeps);
        c.sweep(1);
    }

    #[test]
    #[should_panic(expected = "Cannot deserialize element")]
    fn a_withdrawal_with_an_unknown_version_tag_is_refused() {
        let (mut c, _) = world();
        c.credit(&acct(USERS[0]), 5_000_000);
        act_as(USERS[0], 5);
        let _ = c.withdraw(U128(3_000_000));
        c.withdrawals.flush();
        let key = storage_key(Key::Withdrawals, 1u64);
        let mut bytes = env::storage_read(&key).unwrap();
        bytes[0] = 1;
        env::storage_write(&key, &bytes);
        c.withdrawals = LookupMap::new(Key::Withdrawals);
        c.find_withdrawal(1);
    }
    #[test]
    fn exempt_positions_scan_bounded_windows_and_survive_role_changes() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_operator(acct("ops.near"));
        c.accounts.insert(acct("ops.near"), 0);
        let count = POSITION_PAGE_MAX + 17;
        for _ in 0..count {
            let id = create_registered(&mut c, "ops.near");
            act_as(VERIFIER, 4);
            let _ = receive(&mut c, acct("ops.near"), U128(1_000_000), format!("buy:{id}:no:1"));
        }
        assert!(indexed(&c, "ops.near").is_empty());
        let first = c.get_positions(acct("ops.near"), Some(U64(0)), Some(U64(u64::MAX)));
        assert_eq!(first.len(), POSITION_PAGE_MAX as usize - 2);
        assert_eq!(first.last().unwrap().market_id.0, POSITION_PAGE_MAX - 1);
        let rest = c.get_positions(
            acct("ops.near"),
            Some(U64(POSITION_PAGE_MAX)),
            Some(U64(POSITION_PAGE_MAX)),
        );
        assert_eq!(first.len() + rest.len(), count as usize);
        assert_eq!(rest.last().unwrap().market_id.0, count + 1);
        assert!(c.get_positions(acct("ops.near"), Some(U64(u64::MAX)), None).is_empty());
        assert!(c.get_positions(acct("ops.near"), None, Some(U64(0))).is_empty());
        act_as(OWNER, 4);
        c.set_operator(acct("next.near"));
        assert!(c.positions_are_paged(acct("ops.near")));
        assert_eq!(c.get_account(acct("ops.near")).positions, Some(count as u32));
        assert_eq!(c.get_positions(acct("ops.near"), Some(U64(100)), None).len(), 19);
    }

    #[test]
    fn holder_count_is_per_account_not_per_side_and_losing_shares_must_exit() {
        let (mut c, _) = world();
        assert_eq!(c.market(0).holders, 0);
        act_as(VERIFIER, 3);
        receive(&mut c, acct(USERS[0]), U128(5_000_000), "buy:0:yes:1".into());
        receive(&mut c, acct(USERS[0]), U128(5_000_000), "buy:0:no:1".into());
        receive(&mut c, acct(USERS[1]), U128(5_000_000), "buy:0:no:1".into());
        assert_eq!(c.market(0).holders, 2);
        act_as(ORACLE, CLOSE);
        c.set_outcome(U64(0), Outcome::Yes);
        act_as(USERS[0], CLOSE + 1);
        c.redeem(U64(0));
        assert_eq!(c.market(0).holders, 1);
        act_as(USERS[1], CLOSE + 2);
        assert_eq!(c.redeem(U64(0)), U128(0));
        assert_eq!(c.market(0).holders, 0);
    }

    #[test]
    fn measure_maximum_market_record_storage() {
        let (mut c, _) = world();
        c.markets.flush();
        let mut m = blank();
        m.title = "x".repeat(MAX_TITLE);
        m.rule_text = "x".repeat(MAX_RULE);
        m.resolution_source = "x".repeat(MAX_SOURCE);
        m.void_policy = "x".repeat(MAX_VOID);
        m.category = "x".repeat(32);
        m.subcategory = "x".repeat(32);
        m.rule_hash = "f".repeat(64);
        m.price_rule = Some(PriceRule {
            observation_time: U64(u64::MAX - 1),
            strike: U128(u128::MAX),
            decimals: 18,
            above: true,
        });
        m.outcome = Some(Outcome::Void);
        m.refunds = true;
        m.history = vec![(u64::MAX, 999_999); HISTORY_MAX];
        let before = env::storage_usage();
        c.store_market(999, m);
        c.markets.flush();
        let bytes = env::storage_usage() - before;
        println!(
            "maximum complete market record: {bytes} bytes; deposit: {} yoctoNEAR",
            u128::from(bytes) * env::storage_byte_cost().as_yoctonear()
        );
        assert_eq!(bytes, MAX_MARKET_STORAGE_BYTES);
        assert_eq!(
            u128::from(bytes) * env::storage_byte_cost().as_yoctonear(),
            DEFAULT_MARKET_STORAGE_DEPOSIT
        );
    }

    #[test]
    fn pruning_preserves_money_and_unsettled_sweeps() {
        let mut c = after_a_sweep();
        c.on_revenue_sent(U64(1), Err(PromiseError::Failed));
        let sweep_before = near_sdk::borsh::to_vec(&c.sweep(1)).unwrap();
        act_as(ORACLE, CLOSE);
        c.set_outcome(U64(0), Outcome::Yes);
        let owed = c.total_owed();
        let buckets = near_sdk::serde_json::to_value(c.owed_breakdown()).unwrap();
        assert!(c.prune_market(U64(0)));
        assert!(!c.prune_market(U64(0)));
        assert_eq!(c.total_owed(), owed);
        assert_eq!(near_sdk::serde_json::to_value(c.owed_breakdown()).unwrap(), buckets);
        assert_eq!(near_sdk::borsh::to_vec(&c.sweep(1)).unwrap(), sweep_before);
        let m = c.get_market(U64(0)).unwrap();
        assert!(m.pruned);
        assert_eq!(m.rule_text, "");
        assert!(!m.rule_hash.is_empty());
        assert_eq!(m.outcome, Some(Outcome::Yes));
        assert!(c.get_history(U64(0)).is_empty());
        act_as(OWNER, CLOSE + 1);
        assert!(
            refused(|| c.claim_residual(U64(0))),
            "a market nobody traded leaves nothing over"
        );
        assert_eq!(c.total_owed(), owed);
    }

    #[test]
    fn pruning_waits_for_losing_holders_as_well_as_winners() {
        let (mut c, _) = world();
        act_as(VERIFIER, 3);
        receive(&mut c, acct(USERS[0]), U128(5_000_000), "buy:0:no:1".into());
        receive(&mut c, acct(USERS[1]), U128(5_000_000), "buy:0:yes:1".into());
        act_as(ORACLE, CLOSE);
        c.set_outcome(U64(0), Outcome::Yes);
        act_as(USERS[1], CLOSE + 1);
        assert!(c.redeem(U64(0)).0 > 0);
        assert!(refused(|| {
            c.prune_market(U64(0));
        }));
        act_as(USERS[0], CLOSE + 2);
        assert_eq!(c.redeem(U64(0)), U128(0));
        assert!(c.prune_market(U64(0)));
    }

    #[test]
    fn storage_policy_has_a_payer_hard_ranges_and_an_owner_guard() {
        let (mut c, _) = world();
        assert_eq!(c.market_storage_deposit, DEFAULT_MARKET_STORAGE_DEPOSIT);
        act_as(USERS[0], 3);
        assert!(refused(|| c.set_storage_policy(
            U128(DEFAULT_MARKET_STORAGE_DEPOSIT),
            U128(DEFAULT_STORAGE_RESERVE)
        )));
        act_as(OWNER, 3);
        for (deposit, reserve) in [
            (HARD_MIN_MARKET_STORAGE_DEPOSIT - 1, DEFAULT_STORAGE_RESERVE),
            (HARD_MAX_MARKET_STORAGE_DEPOSIT + 1, DEFAULT_STORAGE_RESERVE),
            (DEFAULT_MARKET_STORAGE_DEPOSIT, HARD_MIN_STORAGE_RESERVE - 1),
            (DEFAULT_MARKET_STORAGE_DEPOSIT, HARD_MAX_STORAGE_RESERVE + 1),
        ] {
            assert!(refused(|| c.set_storage_policy(U128(deposit), U128(reserve))));
        }
        let before = c.next_market_id;
        assert!(refused(|| {
            c.create_market(
                "t".into(),
                "r".into(),
                "s".into(),
                "v".into(),
                "sports".into(),
                "nfl".into(),
                U64(CLOSE),
                U64(RESOLVE_BY),
                None,
            );
        }));
        assert_eq!(c.next_market_id, before);
    }

    fn version_five(c: MarketContract) -> StateV5 {
        StateV5 {
            state_version: 5,
            upgrade_proven: c.upgrade_proven,
            upgrade_in_flight: true,
            owner: c.owner,
            pending_owner: c.pending_owner,
            operator: c.operator,
            oracle: c.oracle,
            verifier: c.verifier,
            collateral_token_id: c.collateral_token_id,
            paused: c.paused,
            sells_paused: c.sells_paused,
            fee_rate_bps: c.fee_rate_bps,
            create_fee: 0,
            max_fee_rate_bps: c.max_fee_rate_bps,
            max_create_fee: 50_000_000,
            min_revenue_share_bps: c.min_revenue_share_bps,
            max_revenue_share_bps: c.max_revenue_share_bps,
            max_min_sweep: c.max_min_sweep,
            max_positions: c.max_positions,
            min_open_price: 200_000,
            max_open_price: 800_000,
            void_price_window_ns: 86_400_000_000_000,
            void_grace_ns: c.void_grace_ns,
            settle_wait_minutes: c.settle_wait_minutes,
            reconcile_wait_minutes: c.reconcile_wait_minutes,
            min_sweep_interval_minutes: c.min_sweep_interval_minutes,
            next_market_id: c.next_market_id,
            markets: c.markets,
            balances: c.balances,
            balances_total: c.balances_total,
            accounts: c.accounts,
            shares: c.shares,
            position_markets: c.position_markets,
            recipients: c.recipients,
            revenue_share_bps: c.revenue_share_bps,
            fees: c.fees,
            revenue_due: c.revenue_due,
            treasury_due: c.treasury_due,
            revenue_unresolved: c.revenue_unresolved,
            locked_total: c.locked_total,
            min_sweep: c.min_sweep,
            next_sweep_id: c.next_sweep_id,
            last_sweep_at: c.last_sweep_at,
            sweeps: c.sweeps,
            legs_in_flight_total: c.legs_in_flight_total,
            legs_in_flight_count: c.legs_in_flight_count,
            next_withdrawal_id: c.next_withdrawal_id,
            withdrawals: c.withdrawals,
            pending_withdrawals_total: c.pending_withdrawals_total,
            pending_withdrawal_count: c.pending_withdrawal_count,
            pending_by_account: c.pending_by_account,
            exempt_accounts: c.exempt_accounts,
            position_counts: c.position_counts,
            market_storage_deposit: c.market_storage_deposit,
            storage_reserve: c.storage_reserve,
            registration_fee: c.registration_fee,
            registrations: c.registrations,
        }
    }

    fn deployed_with_a_balance() -> MarketContract {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as(OWNER, 1);
        let mut c = MarketContract::new(
            acct(OWNER),
            acct(OWNER),
            acct(ORACLE),
            acct(VERIFIER),
            COLLATERAL_ID.to_string(),
        );
        act_as(VERIFIER, 2);
        let _ = receive(
            &mut c,
            acct(USERS[0]),
            U128(DEFAULT_REGISTRATION_FEE + 7_000_000),
            "register".into(),
        );
        c
    }

    #[test]
    fn a_version_five_contract_with_no_markets_moves_to_parimutuel_pricing_with_its_balances() {
        let c = deployed_with_a_balance();
        let owed = c.total_owed();
        env::state_write(&version_five(c));
        act_unpaid(SELF, 5);
        let mut upgraded = MarketContract::migrate();
        assert_eq!(upgraded.state_version, STATE_VERSION);
        assert!(upgraded.upgrade_proven && !upgraded.upgrade_in_flight);
        assert_eq!(upgraded.total_owed(), owed);
        assert_eq!(upgraded.get_balance(acct(USERS[0])), U128(7_000_000));
        assert!(upgraded.is_registered(acct(USERS[0])));
        assert!(upgraded.positions_are_paged(acct(OWNER)));
        let id = create_registered(&mut upgraded, OWNER);
        act_as(USERS[0], 6);
        upgraded.buy(U64(id), "yes".into(), U128(5_000_000), U128(1));
        assert_eq!(holdings(&upgraded, id, USERS[0]).0, 4_900_000);
        assert!(upgraded.check_invariant(U64(id)));
    }

    #[test]
    fn a_version_six_contract_moves_to_seven_with_the_default_market_cap() {
        let mut c = deployed_with_a_balance();
        let id = create_registered(&mut c, OWNER);
        let owed = c.total_owed();
        let old = StateV6 {
            state_version: 6,
            upgrade_proven: c.upgrade_proven,
            upgrade_in_flight: true,
            owner: c.owner,
            pending_owner: c.pending_owner,
            operator: c.operator,
            oracle: c.oracle,
            verifier: c.verifier,
            collateral_token_id: c.collateral_token_id,
            paused: c.paused,
            sells_paused: c.sells_paused,
            fee_rate_bps: c.fee_rate_bps,
            max_fee_rate_bps: c.max_fee_rate_bps,
            min_revenue_share_bps: c.min_revenue_share_bps,
            max_revenue_share_bps: c.max_revenue_share_bps,
            max_min_sweep: c.max_min_sweep,
            max_positions: c.max_positions,
            void_grace_ns: c.void_grace_ns,
            settle_wait_minutes: c.settle_wait_minutes,
            reconcile_wait_minutes: c.reconcile_wait_minutes,
            min_sweep_interval_minutes: c.min_sweep_interval_minutes,
            next_market_id: c.next_market_id,
            markets: c.markets,
            balances: c.balances,
            balances_total: c.balances_total,
            accounts: c.accounts,
            shares: c.shares,
            costs: c.costs,
            position_markets: c.position_markets,
            recipients: c.recipients,
            revenue_share_bps: c.revenue_share_bps,
            fees: c.fees,
            revenue_due: c.revenue_due,
            treasury_due: c.treasury_due,
            revenue_unresolved: c.revenue_unresolved,
            locked_total: c.locked_total,
            min_sweep: c.min_sweep,
            next_sweep_id: c.next_sweep_id,
            last_sweep_at: c.last_sweep_at,
            sweeps: c.sweeps,
            legs_in_flight_total: c.legs_in_flight_total,
            legs_in_flight_count: c.legs_in_flight_count,
            next_withdrawal_id: c.next_withdrawal_id,
            withdrawals: c.withdrawals,
            pending_withdrawals_total: c.pending_withdrawals_total,
            pending_withdrawal_count: c.pending_withdrawal_count,
            pending_by_account: c.pending_by_account,
            exempt_accounts: c.exempt_accounts,
            position_counts: c.position_counts,
            market_storage_deposit: c.market_storage_deposit,
            storage_reserve: c.storage_reserve,
            registration_fee: c.registration_fee,
            registrations: c.registrations,
        };
        env::state_write(&old);
        act_unpaid(SELF, 5);
        let upgraded = MarketContract::migrate();
        assert_eq!(upgraded.state_version, STATE_VERSION);
        assert_eq!(upgraded.total_owed(), owed);
        assert_eq!(upgraded.market_cap(U64(id)), U128(LEGACY_MAX_MARKET_LOCKED));
        assert!(upgraded.upgrade_proven && !upgraded.upgrade_in_flight);
    }

    fn version_seven(c: MarketContract) -> StateV7 {
        StateV7 {
            state_version: 7,
            upgrade_proven: c.upgrade_proven,
            upgrade_in_flight: true,
            owner: c.owner,
            pending_owner: c.pending_owner,
            operator: c.operator,
            oracle: c.oracle,
            verifier: c.verifier,
            collateral_token_id: c.collateral_token_id,
            paused: c.paused,
            sells_paused: c.sells_paused,
            fee_rate_bps: c.fee_rate_bps,
            max_fee_rate_bps: c.max_fee_rate_bps,
            min_revenue_share_bps: c.min_revenue_share_bps,
            max_revenue_share_bps: c.max_revenue_share_bps,
            max_min_sweep: c.max_min_sweep,
            max_positions: c.max_positions,
            void_grace_ns: c.void_grace_ns,
            settle_wait_minutes: c.settle_wait_minutes,
            reconcile_wait_minutes: c.reconcile_wait_minutes,
            min_sweep_interval_minutes: c.min_sweep_interval_minutes,
            next_market_id: c.next_market_id,
            markets: c.markets,
            balances: c.balances,
            balances_total: c.balances_total,
            accounts: c.accounts,
            shares: c.shares,
            costs: c.costs,
            position_markets: c.position_markets,
            recipients: c.recipients,
            revenue_share_bps: c.revenue_share_bps,
            fees: c.fees,
            revenue_due: c.revenue_due,
            treasury_due: c.treasury_due,
            revenue_unresolved: c.revenue_unresolved,
            locked_total: c.locked_total,
            min_sweep: c.min_sweep,
            next_sweep_id: c.next_sweep_id,
            last_sweep_at: c.last_sweep_at,
            sweeps: c.sweeps,
            legs_in_flight_total: c.legs_in_flight_total,
            legs_in_flight_count: c.legs_in_flight_count,
            next_withdrawal_id: c.next_withdrawal_id,
            withdrawals: c.withdrawals,
            pending_withdrawals_total: c.pending_withdrawals_total,
            pending_withdrawal_count: c.pending_withdrawal_count,
            pending_by_account: c.pending_by_account,
            exempt_accounts: c.exempt_accounts,
            position_counts: c.position_counts,
            market_storage_deposit: c.market_storage_deposit,
            storage_reserve: c.storage_reserve,
            registration_fee: c.registration_fee,
            registrations: c.registrations,
            max_market_locked: c.max_market_locked,
            market_caps: c.market_caps,
        }
    }

    #[test]
    fn a_version_seven_contract_moves_to_eight_keeping_its_caps_and_halting_nothing() {
        let mut c = deployed_with_a_balance();
        let id = create_registered(&mut c, OWNER);
        c.max_market_locked = LEGACY_MAX_MARKET_LOCKED;
        let owed = c.total_owed();
        let old = version_seven(c);
        env::state_write(&old);
        act_unpaid(SELF, 5);
        let upgraded = MarketContract::migrate();
        assert_eq!(upgraded.state_version, STATE_VERSION);
        assert_eq!(upgraded.total_owed(), owed);
        assert_eq!(upgraded.market_cap(U64(id)), U128(LEGACY_MAX_MARKET_LOCKED));
        assert!(!upgraded.halt_until.contains_key(&id));
        assert!(upgraded.upgrade_proven && !upgraded.upgrade_in_flight);
    }

    #[test]
    fn a_market_halted_before_the_upgrade_stays_halted_after_it() {
        let mut c = deployed_with_a_balance();
        let id = create_registered(&mut c, OWNER);
        let mut m = c.market(id);
        m.halted = true;
        c.store_market(id, m);
        env::state_write(&version_seven(c));
        act_unpaid(SELF, 5);
        let upgraded = MarketContract::migrate();
        assert_eq!(upgraded.get_market(U64(id)).unwrap().status, "halted");
        assert!(upgraded.is_halted(id, &upgraded.market(id)));
    }

    #[test]
    fn a_version_five_contract_that_has_created_markets_is_refused() {
        let mut c = deployed_with_a_balance();
        let _ = create_registered(&mut c, OWNER);
        env::state_write(&version_five(c));
        act_unpaid(SELF, 5);
        assert!(refused(|| {
            MarketContract::migrate();
        }));
    }

    fn token_sends(c: &mut MarketContract, from: &str, amount: u128, msg: &str, tgas: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(TOKEN))
            .block_timestamp(3)
            .prepaid_gas(Gas::from_tgas(tgas))
            .build());
        let _ = c.ft_on_transfer(acct(from), U128(amount), msg.into());
    }

    #[test]
    fn a_token_deposit_moves_on_to_intents_before_it_is_credited() {
        let (mut c, total_in) = world();
        let before = c.get_balance(acct(USERS[0])).0;
        token_sends(&mut c, USERS[0], 5_000_000, "deposit", 100);
        let sent = receipts();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].receiver_id, acct(TOKEN));
        let (method, args, deposit, gas) = call_of(&sent[0]);
        assert_eq!(method, "ft_transfer_call");
        assert_eq!((deposit, gas), (1, GAS_FT_FORWARD.as_gas()));
        assert_eq!(args["receiver_id"], VERIFIER);
        assert_eq!(args["amount"], "5000000");
        assert_eq!(args["msg"], SELF, "the verifier credits the market's own account");
        assert_eq!(sent[1].receiver_id, acct(SELF));
        let (method, args, _, gas) = call_of(&sent[1]);
        assert_eq!((method.as_str(), gas), ("on_forwarded", GAS_ON_FORWARDED.as_gas()));
        assert_eq!(args["sender_id"], USERS[0]);
        assert_eq!(args["amount"], "5000000");
        assert_eq!(args["arrival"], "deposit");
        assert_eq!(c.get_balance(acct(USERS[0])).0, before);
        assert_eq!(c.total_owed().0, total_in, "nothing is owed for money still on its way");
    }

    #[test]
    fn every_token_refusal_comes_before_the_forward() {
        let (mut c, total_in) = world();
        let (paid, floor) = (5_000_000, GAS_FORWARD_FLOOR.as_tgas());
        let not_the_token = "only the collateral token can deliver money";
        let cases: [(&str, &str, u128, &str, u64, &str); 13] = [
            ("evil.near", USERS[0], paid, "deposit", 100, not_the_token),
            (VERIFIER, USERS[0], paid, "deposit", 100, not_the_token),
            (TOKEN, VERIFIER, paid, "deposit", 100, "not out of the verifier"),
            (TOKEN, USERS[0], 0, "deposit", 100, "amount must be positive"),
            (TOKEN, USERS[0], paid, "deposit", floor - 1, "attach at least"),
            (TOKEN, USERS[0], paid, "register", 100, "unknown action"),
            (TOKEN, USERS[0], paid, "seed:0", 100, "unknown action"),
            (TOKEN, USERS[0], paid, "", 100, "unknown action"),
            (TOKEN, "zed.near", paid, "deposit", 100, "storage deposit first"),
            (TOKEN, "zed.near", paid, "buy:0:yes:1", 100, "storage deposit first"),
            (TOKEN, USERS[0], paid, "buy:7:yes:1", 100, "no such market"),
            (TOKEN, USERS[0], paid, "buy:0:maybe:1", 100, "side must be yes or no"),
            (TOKEN, USERS[0], paid, "buy:0:yes:0", 100, "must be above zero"),
        ];
        for (caller, from, amount, msg, tgas, expected) in cases {
            testing_env!(VMContextBuilder::new()
                .predecessor_account_id(acct(caller))
                .block_timestamp(3)
                .prepaid_gas(Gas::from_tgas(tgas))
                .build());
            let reason = refusal(|| {
                let _ = c.ft_on_transfer(acct(from), U128(amount), msg.into());
            });
            assert!(reason.contains(expected), "{caller} {from} {msg}: {reason}");
            assert!(receipts().is_empty(), "{msg}: nothing was sent");
        }
        assert_eq!(c.total_owed().0, total_in);
    }

    #[test]
    fn a_pause_refuses_every_token_arrival() {
        let (mut c, _) = world();
        act_as(OWNER, 3);
        c.set_paused(true);
        for msg in ["deposit", "buy:0:yes:1"] {
            let reason = refusal(|| token_sends(&mut c, USERS[0], 5_000_000, msg, 100));
            assert!(reason.contains("paused"), "{msg}: {reason}");
        }
    }

    #[test]
    fn what_reached_intents_is_credited_and_nothing_goes_back() {
        let (mut c, total_in) = world();
        let before = c.get_balance(acct(USERS[0])).0;
        act_as(SELF, 4);
        let back = c.on_forwarded(acct(USERS[0]), U128(5_000_000), Arrival::Deposit, Ok(U128(5_000_000)));
        assert_eq!(back.0, 0);
        assert_eq!(c.get_balance(acct(USERS[0])).0, before + 5_000_000);
        assert_eq!(c.total_owed().0, total_in + 5_000_000);
        let e = last_event();
        assert_eq!(
            (e["event"].as_str(), &e["data"]["amount"]),
            (Some("deposit"), &json!("5000000"))
        );
    }

    #[test]
    fn a_failed_or_refused_forward_credits_nothing() {
        let (mut c, total_in) = world();
        for result in [Err(PromiseError::Failed), Ok(U128(0))] {
            act_as(SELF, 4);
            let back = c.on_forwarded(acct("zed.near"), U128(5_000_000), Arrival::Deposit, result);
            assert_eq!(back.0, 5_000_000);
        }
        assert_eq!(c.get_balance(acct("zed.near")).0, 0);
        assert!(!c.is_registered(acct("zed.near")));
        assert_eq!(c.total_owed().0, total_in);
    }

    #[test]
    fn a_token_buy_carries_its_order_to_the_callback() {
        let (mut c, _) = world();
        token_sends(&mut c, USERS[0], 5_000_000, "buy:1:no:7", 100);
        let (method, args, _, _) = call_of(&receipts()[1]);
        assert_eq!(method, "on_forwarded");
        assert_eq!(
            args["arrival"],
            json!({ "buy": { "market_id": "1", "side": 1, "min_shares": "7" } })
        );
    }

    #[test]
    fn a_token_buy_is_credited_first_and_bought_in_its_own_receipt() {
        let (mut c, total_in) = world();
        let before = c.get_balance(acct(USERS[0])).0;
        let order = Arrival::Buy {
            market_id: U64(0),
            side: 0,
            min_shares: U128(1),
        };
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(SELF))
            .block_timestamp(4)
            .prepaid_gas(GAS_ON_FORWARDED)
            .build());
        let back = c.on_forwarded(acct(USERS[0]), U128(5_000_000), order, Ok(U128(4_000_000)));
        assert_eq!(back.0, 1_000_000);
        assert_eq!(c.get_balance(acct(USERS[0])).0, before + 4_000_000);
        let sent = receipts();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].receiver_id, acct(SELF));
        let (method, args, _, gas) = call_of(&sent[0]);
        assert_eq!((method.as_str(), gas), ("buy_for", GAS_BUY.as_gas()));
        assert_eq!(args["who"], USERS[0]);
        assert_eq!(args["amount"], "4000000", "only what reached Intents is spent");
        act_as(SELF, 5);
        c.buy_for(acct(USERS[0]), U64(0), 0, U128(4_000_000), U128(1));
        assert_eq!(c.get_balance(acct(USERS[0])).0, before);
        assert!(holdings(&c, 0, USERS[0]).0 > 0);
        assert_eq!(c.total_owed().0, total_in + 4_000_000);
    }

    #[test]
    fn an_account_that_leaves_in_flight_keeps_its_money() {
        let (mut c, total_in) = world();
        act_paying("zed.near", FIFTY_MILLI);
        c.storage_deposit(None, None);
        token_sends(&mut c, "zed.near", 5_000_000, "deposit", 100);
        act_as("zed.near", 4);
        assert!(c.storage_unregister(None));
        act_as(SELF, 5);
        let _ = c.on_forwarded(acct("zed.near"), U128(5_000_000), Arrival::Deposit, Ok(U128(5_000_000)));
        assert!(!c.is_registered(acct("zed.near")));
        assert_eq!(c.get_balance(acct("zed.near")).0, 5_000_000);
        assert_eq!(c.total_owed().0, total_in + 5_000_000);
        act_as("zed.near", 6);
        let _ = c.withdraw(U128(5_000_000));
        assert_eq!(c.get_balance(acct("zed.near")).0, 0);
        act_as("zed.near", 7);
        assert!(!c.storage_unregister(None), "the deposit was handed back once already");
        assert!(refunds().is_empty());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        #[test]
        fn the_market_owes_exactly_what_reached_intents(
            amount in 1u128..1_000_000_000_000,
            report in proptest::option::of(0u128..2_000_000_000_000),
            buy in any::<bool>(),
            registered in any::<bool>(),
        ) {
            let (mut c, total_in) = world();
            let who = if registered { USERS[0] } else { "zed.near" };
            let arrival = if buy {
                Arrival::Buy { market_id: U64(0), side: 0, min_shares: U128(1) }
            } else {
                Arrival::Deposit
            };
            let result = report.map(U128).ok_or(PromiseError::Failed);
            let taken = report.map_or(0, |used| used.min(amount));
            act_as(SELF, 4);
            let back = c.on_forwarded(acct(who), U128(amount), arrival, result).0;
            prop_assert_eq!(back, amount - taken);
            prop_assert_eq!(c.total_owed().0, total_in + taken);
        }
    }
}
