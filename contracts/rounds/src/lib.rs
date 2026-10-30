// Up and Down rounds on an asset's price, priced by dynamic parimutuel. A series cuts time into rounds of one interval. A
// round takes stakes while it runs, until a set time before its end, and the prices publishers sign at its start and end
// decide it: the side that was right shares the pool less the fee. An empty side, a tie or a missing price refunds.

use std::cmp::Ordering;

use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, CurveType, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NEP141_PREFIX: &str = "nep141:";
// Two disjoint groups of publishers must never both reach the threshold, or two prices could win for one moment.
const MAJORITY_NEEDED: &str = "the threshold must be more than half of the publishers";
const STATE_VERSION: u16 = 2;
const BPS_DENOMINATOR: u128 = 10_000;
// Taken from what the losing side paid, and capped so a winner never gets back less than the stake.
const DEFAULT_FEE_BPS: u32 = 300;
const HARD_MAX_FEE_BPS: u32 = 1_000;
const DEFAULT_REGISTRATION_FEE: u128 = 250_000;
const HARD_MIN_REGISTRATION_FEE: u128 = 10_000;
const HARD_MAX_REGISTRATION_FEE: u128 = 2_000_000;
const MIN_STAKE: u128 = 100_000;
const MAX_OPEN_STAKES: u32 = 20;
const STORAGE_RESERVE: u128 = 1_000_000_000_000_000_000_000_000;
// Verifying this many signatures fits a call with room to spare, as measured for the oracle.
const MAX_PUBLISHERS: usize = 25;
const MAX_DECIMALS: u8 = 18;
const NS_PER_SECOND: u64 = 1_000_000_000;
const NS_PER_MINUTE: u64 = 60 * NS_PER_SECOND;
const NS_PER_DAY: u64 = 1_440 * NS_PER_MINUTE;
// Stakes close at least a minute before the end, so nobody can wait for the price and then stake on the side that already won.
const HARD_MIN_CLOSE_BEFORE_NS: u64 = NS_PER_MINUTE;
const HARD_MIN_INTERVAL_NS: u64 = NS_PER_MINUTE;
const HARD_MAX_INTERVAL_NS: u64 = NS_PER_DAY;
const HARD_MIN_PRICE_WINDOW_NS: u64 = NS_PER_MINUTE;
const HARD_MAX_PRICE_WINDOW_NS: u64 = NS_PER_DAY;
const RECONCILE_WAIT_NS: u64 = 60 * NS_PER_MINUTE;
const GAS_MT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const SWEEP_GAS: Gas = Gas::from_tgas(60);

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Series,
    Rounds,
    Stakes,
    Accounts,
    Balances,
    Withdrawals,
    PendingByAccount,
    Prices,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Up,
    Down,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Up,
    Down,
    Refund,
}

// Fixed when it is added, so nothing about a round changes after anyone has staked in it. Round r starts at
// first_start + r * interval and ends where round r + 1 starts, and takes stakes until close_before ahead of its end. A
// price is taken from price_window after its moment.
#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Series {
    asset: String,
    decimals: u8,
    first_start: U64,
    interval: U64,
    price_window: U64,
    close_before: U64,
}

// Stored only once someone stakes. `up` and `down` are the shares outstanding, `paid_up` and `paid_down` what each side
// paid for them, and `left` what was paid less the fee and the claims paid so far.
#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Round {
    up: U128,
    down: U128,
    paid_up: U128,
    paid_down: U128,
    left: U128,
    fee_bps: u32,
    outcome: Option<Outcome>,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy)]
pub struct Stake {
    side: Side,
    shares: U128,
    amount: U128,
}

struct Bet {
    series_id: u32,
    round: u64,
    side: Side,
    amount: u128,
    min_shares: u128,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Withdrawal {
    account: AccountId,
    amount: U128,
    at: U64,
}

#[near(serializers=[borsh])]
#[derive(Clone)]
enum VersionedSeries {
    V1(Series),
}

impl VersionedSeries {
    fn into_current(self) -> Series {
        match self {
            Self::V1(s) => s,
        }
    }
}

impl From<Series> for VersionedSeries {
    fn from(s: Series) -> Self {
        Self::V1(s)
    }
}

#[near(serializers=[borsh])]
#[derive(Clone)]
enum VersionedRound {
    V1(Round),
}

impl VersionedRound {
    fn into_current(self) -> Round {
        match self {
            Self::V1(r) => r,
        }
    }
}

impl From<Round> for VersionedRound {
    fn from(r: Round) -> Self {
        Self::V1(r)
    }
}

#[near(serializers=[json])]
pub struct AccountView {
    registered: bool,
    available: U128,
    pending_withdrawals: U128,
    open_stakes: u32,
}

#[near(serializers=[json])]
pub struct OwedView {
    balances: U128,
    locked: U128,
    fees: U128,
    pending_withdrawals: U128,
    total: U128,
}

#[ext_contract(ext_verifier)]
pub trait Verifier {
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

#[near(contract_state, contract_metadata(standard(standard = "nep297", version = "1.0.0")))]
#[derive(PanicOnDefault)]
pub struct RoundsContract {
    state_version: u16,
    upgrade_proven: bool,
    upgrade_in_flight: bool,
    owner: AccountId,
    pending_owner: Option<AccountId>,
    operator: AccountId,
    verifier: AccountId,
    collateral_token_id: String,
    network: String,
    // Blocks registering, deposits and stakes. Never blocks prices, settling, claims or withdrawals.
    paused: bool,
    fee_bps: u32,
    registration_fee: u128,
    publishers: Vec<PublicKey>,
    price_threshold: u32,
    next_series_id: u32,
    series: LookupMap<u32, VersionedSeries>,
    rounds: LookupMap<(u32, u64), VersionedRound>,
    // The price at the start of a round, which is also the end price of the round before. Recorded once.
    prices: LookupMap<(u32, u64), U128>,
    stakes: LookupMap<(u32, u64, AccountId), Stake>,
    // account -> the stakes it has not claimed. Presence means it paid the registration fee.
    accounts: LookupMap<AccountId, u32>,
    balances: LookupMap<AccountId, u128>,
    balances_total: u128,
    locked_total: u128,
    fees: u128,
    next_withdrawal_id: u64,
    withdrawals: LookupMap<u64, Withdrawal>,
    pending_withdrawals_total: u128,
    pending_by_account: LookupMap<AccountId, u128>,
    // Where sweep_fees sends the fees. Unset until the owner names it.
    treasury: Option<AccountId>,
}

// Exact layout of state version 1, which had no treasury.
#[near(serializers=[borsh])]
struct StateV1 {
    state_version: u16,
    upgrade_proven: bool,
    upgrade_in_flight: bool,
    owner: AccountId,
    pending_owner: Option<AccountId>,
    operator: AccountId,
    verifier: AccountId,
    collateral_token_id: String,
    network: String,
    paused: bool,
    fee_bps: u32,
    registration_fee: u128,
    publishers: Vec<PublicKey>,
    price_threshold: u32,
    next_series_id: u32,
    series: LookupMap<u32, VersionedSeries>,
    rounds: LookupMap<(u32, u64), VersionedRound>,
    prices: LookupMap<(u32, u64), U128>,
    stakes: LookupMap<(u32, u64, AccountId), Stake>,
    accounts: LookupMap<AccountId, u32>,
    balances: LookupMap<AccountId, u128>,
    balances_total: u128,
    locked_total: u128,
    fees: u128,
    next_withdrawal_id: u64,
    withdrawals: LookupMap<u64, Withdrawal>,
    pending_withdrawals_total: u128,
    pending_by_account: LookupMap<AccountId, u128>,
}

impl From<StateV1> for RoundsContract {
    fn from(old: StateV1) -> Self {
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: old.upgrade_proven,
            upgrade_in_flight: old.upgrade_in_flight,
            owner: old.owner,
            pending_owner: old.pending_owner,
            operator: old.operator,
            verifier: old.verifier,
            collateral_token_id: old.collateral_token_id,
            network: old.network,
            paused: old.paused,
            fee_bps: old.fee_bps,
            registration_fee: old.registration_fee,
            publishers: old.publishers,
            price_threshold: old.price_threshold,
            next_series_id: old.next_series_id,
            series: old.series,
            rounds: old.rounds,
            prices: old.prices,
            stakes: old.stakes,
            accounts: old.accounts,
            balances: old.balances,
            balances_total: old.balances_total,
            locked_total: old.locked_total,
            fees: old.fees,
            next_withdrawal_id: old.next_withdrawal_id,
            withdrawals: old.withdrawals,
            pending_withdrawals_total: old.pending_withdrawals_total,
            pending_by_account: old.pending_by_account,
            treasury: None,
        }
    }
}

impl Side {
    fn other(self) -> Self {
        match self {
            Side::Up => Side::Down,
            Side::Down => Side::Up,
        }
    }
}

impl Outcome {
    fn winner(self) -> Option<Side> {
        match self {
            Outcome::Up => Some(Side::Up),
            Outcome::Down => Some(Side::Down),
            Outcome::Refund => None,
        }
    }
}

impl Series {
    fn start_of(&self, round: u64) -> u64 {
        self.first_start.0.saturating_add(round.saturating_mul(self.interval.0))
    }

    fn close_of(&self, round: u64) -> u64 {
        self.start_of(round.saturating_add(1))
            .saturating_sub(self.close_before.0)
    }
}

impl Round {
    fn new(fee_bps: u32) -> Self {
        Round {
            up: U128(0),
            down: U128(0),
            paid_up: U128(0),
            paid_down: U128(0),
            left: U128(0),
            fee_bps,
            outcome: None,
        }
    }

    fn shares(&self, side: Side) -> u128 {
        match side {
            Side::Up => self.up.0,
            Side::Down => self.down.0,
        }
    }

    fn paid(&self, side: Side) -> u128 {
        match side {
            Side::Up => self.paid_up.0,
            Side::Down => self.paid_down.0,
        }
    }

    // Buys shares of `side` for `amount` at the price the shares outstanding set, and returns how many it bought.
    fn take(&mut self, side: Side, amount: u128) -> Option<u128> {
        let (shares, grown) = dpm::buy(self.shares(side), self.shares(side.other()), amount)?;
        match side {
            Side::Up => {
                self.up = U128(grown);
                self.paid_up = U128(self.paid_up.0 + amount);
            }
            Side::Down => {
                self.down = U128(grown);
                self.paid_down = U128(self.paid_down.0 + amount);
            }
        }
        self.left = U128(self.left.0 + amount);
        Some(shares)
    }

    // fee_bps of what the losing side paid, but never so much that the pool keeps less than a unit for each winning share.
    // No share costs more than a unit, so no winner gets back less than the stake.
    fn fee(&self, outcome: Outcome) -> u128 {
        outcome.winner().map_or(0, |side| {
            let pool = self.paid_up.0 + self.paid_down.0;
            (self.paid(side.other()) * u128::from(self.fee_bps) / BPS_DENOMINATOR)
                .min(pool.saturating_sub(self.shares(side)))
        })
    }

    // Every winning share gets the same part of the pool less the fee, rounded down, so the parts never add up to more
    // than the pool.
    fn payout(&self, outcome: Outcome, stake: &Stake) -> u128 {
        match outcome.winner() {
            None => stake.amount.0,
            Some(side) if side == stake.side => {
                let pool = self.paid_up.0 + self.paid_down.0 - self.fee(outcome);
                dpm::winning_payout(stake.shares.0, self.shares(side), pool)
                    .unwrap_or_else(|| env::panic_str("invariant broken"))
            }
            Some(_) => 0,
        }
    }

    // Only a price recorded inside its window counts and a late one is refused, so once a deadline has passed the answer
    // is fixed, whoever asks and whenever.
    fn decide(
        &self,
        series: &Series,
        round: u64,
        now: u64,
        (start, end): (Option<U128>, Option<U128>),
    ) -> Option<(Outcome, &'static str)> {
        if self.up.0 == 0 || self.down.0 == 0 {
            return Some((Outcome::Refund, "one_sided"));
        }
        if let (Some(start), Some(end)) = (start, end) {
            return Some(match end.0.cmp(&start.0) {
                Ordering::Greater => (Outcome::Up, "price"),
                Ordering::Less => (Outcome::Down, "price"),
                Ordering::Equal => (Outcome::Refund, "tie"),
            });
        }
        let window = series.price_window.0;
        let start_missed = start.is_none() && now > series.start_of(round).saturating_add(window);
        let end_missed = end.is_none() && now > series.start_of(round.saturating_add(1)).saturating_add(window);
        (start_missed || end_missed).then_some((Outcome::Refund, "no_price"))
    }
}

// What a publisher signs: this contract and network, the asset and its decimals, the moment and the price there.
fn price_message(contract: &AccountId, network: &str, series: &Series, at: u64, price: u128) -> String {
    format!(
        "round-price:v1:{contract}:{network}:{}:{at}:{price}:{}",
        series.asset, series.decimals
    )
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "rounds", "version": "1.0.0", "event": event, "data": data })
    ));
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn parse_side(side: &str) -> Side {
    match side {
        "up" => Side::Up,
        "down" => Side::Down,
        _ => env::panic_str("side must be up or down"),
    }
}

fn parse_part<T: std::str::FromStr>(part: Option<&str>, what: &str) -> T {
    part.and_then(|s| s.parse().ok())
        .unwrap_or_else(|| env::panic_str(&format!("bad {what}")))
}

// `<series>:<round>:<up|down>`, then the amount unless the stake came with its money, then the fewest shares to accept.
fn parse_bet<'a>(mut parts: impl Iterator<Item = &'a str>, sent: Option<u128>) -> Bet {
    let series_id = parse_part(parts.next(), "series id");
    let round = parse_part(parts.next(), "round");
    let side = parse_side(parts.next().unwrap_or(""));
    let amount = sent.unwrap_or_else(|| parse_part(parts.next(), "amount"));
    Bet {
        series_id,
        round,
        side,
        amount,
        min_shares: parse_part(parts.next(), "minimum shares"),
    }
}

#[near]
impl RoundsContract {
    #[private]
    #[init]
    pub fn new(
        owner_id: AccountId,
        operator_id: AccountId,
        verifier_id: AccountId,
        collateral_token_id: String,
        network: String,
        price_threshold: u32,
    ) -> Self {
        require!(
            collateral_token_id.starts_with(NEP141_PREFIX),
            "the collateral token id must look like nep141:<token>"
        );
        require!(valid_slug(&network), "the network name must be a short lowercase word");
        require!(price_threshold > 0, "at least one publisher must sign a price");
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: false,
            upgrade_in_flight: false,
            owner: owner_id,
            pending_owner: None,
            operator: operator_id,
            verifier: verifier_id,
            collateral_token_id,
            network,
            paused: false,
            fee_bps: DEFAULT_FEE_BPS,
            registration_fee: DEFAULT_REGISTRATION_FEE,
            publishers: vec![],
            price_threshold,
            next_series_id: 0,
            series: LookupMap::new(Key::Series),
            rounds: LookupMap::new(Key::Rounds),
            prices: LookupMap::new(Key::Prices),
            stakes: LookupMap::new(Key::Stakes),
            accounts: LookupMap::new(Key::Accounts),
            balances: LookupMap::new(Key::Balances),
            balances_total: 0,
            locked_total: 0,
            fees: 0,
            next_withdrawal_id: 1,
            withdrawals: LookupMap::new(Key::Withdrawals),
            pending_withdrawals_total: 0,
            pending_by_account: LookupMap::new(Key::PendingByAccount),
            treasury: None,
        }
    }

    #[payable]
    pub fn stage_code(&mut self) -> Base58CryptoHash {
        let staged = upgrade::stage_code();
        emit(
            "code_staged",
            json!({ "code_hash": staged.code_hash, "bytes": staged.bytes.to_string(), "by": staged.by }),
        );
        staged.code_hash
    }

    pub fn upgrade(&mut self, code_hash: Base58CryptoHash) -> Promise {
        upgrade::require_upgrade_gas();
        self.only_owner();
        let code = upgrade::take_staged(code_hash);
        self.upgrade_in_flight = true;
        emit("upgrade_sent", json!({ "code_hash": code_hash }));
        upgrade::deploy_and_migrate(code)
    }

    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let bytes = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("there is no state to migrate"));
        require!(bytes.len() >= 2, "invalid state");
        let mut state: Self = match u16::from_le_bytes([bytes[0], bytes[1]]) {
            STATE_VERSION => env::state_read().unwrap_or_else(|| env::panic_str("invalid current state")),
            1 => Self::from(env::state_read::<StateV1>().unwrap_or_else(|| env::panic_str("invalid previous state"))),
            _ => env::panic_str("unsupported state version"),
        };
        require!(state.upgrade_in_flight, "migrate runs only inside an upgrade");
        state.upgrade_in_flight = false;
        state.upgrade_proven = true;
        emit("migrated", json!({ "state_version": state.state_version }));
        state
    }

    pub fn seal(&mut self, public_key: PublicKey) -> Promise {
        self.only_owner();
        require!(self.upgrade_proven, "prove the upgrade path before deleting keys");
        emit("seal_sent", json!({ "public_key": public_key }));
        upgrade::delete_key(public_key)
    }

    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.only_owner();
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

    pub fn set_operator(&mut self, operator_id: AccountId) {
        self.only_owner();
        emit("operator_set", json!({ "operator": operator_id }));
        self.operator = operator_id;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.only_operator_or_owner();
        emit("paused_set", json!({ "paused": paused }));
        self.paused = paused;
    }

    // Applies to rounds that take their first stake from now on.
    pub fn set_fee_bps(&mut self, fee_bps: u32) {
        self.only_owner();
        require!(fee_bps <= HARD_MAX_FEE_BPS, "fee outside hard range");
        emit("fee_set", json!({ "fee_bps": fee_bps }));
        self.fee_bps = fee_bps;
    }

    pub fn set_registration_fee(&mut self, registration_fee: U128) {
        self.only_owner();
        require!(
            (HARD_MIN_REGISTRATION_FEE..=HARD_MAX_REGISTRATION_FEE).contains(&registration_fee.0),
            "registration fee outside hard range"
        );
        emit("registration_fee_set", json!({ "registration_fee": registration_fee }));
        self.registration_fee = registration_fee.0;
    }

    pub fn set_treasury(&mut self, treasury: AccountId) {
        self.only_owner();
        emit("treasury_set", json!({ "treasury": treasury }));
        self.treasury = Some(treasury);
    }

    // Anyone can call it: the fees can only go to the treasury. They move to the treasury's balance here and leave as an
    // ordinary withdrawal, so a failure or a lost callback is handled the way every withdrawal is, and a failed sweep leaves the
    // money on the treasury's balance for the next one. Needs the gas for the transfer and its callback.
    pub fn sweep_fees(&mut self) -> Promise {
        require!(
            env::prepaid_gas() >= SWEEP_GAS,
            "attach at least 60 TGas so the callback can run"
        );
        let treasury = self
            .treasury
            .clone()
            .unwrap_or_else(|| env::panic_str("the owner has not named a treasury"));
        let fees = std::mem::take(&mut self.fees);
        self.credit(&treasury, fees);
        let amount = self.balances.get(&treasury).copied().unwrap_or(0);
        require!(amount > 0, "no fees to sweep");
        emit(
            "fees_swept",
            json!({ "treasury": treasury, "fees": fees.to_string(), "amount": amount.to_string() }),
        );
        self.withdraw_for(treasury, amount)
    }

    pub fn add_publisher(&mut self, key: PublicKey) {
        self.only_owner();
        require!(key.curve_type() == CurveType::ED25519, "publishers use ed25519 keys");
        require!(!self.publishers.contains(&key), "already a publisher");
        require!(
            self.publishers.len() < MAX_PUBLISHERS,
            &format!("there can be at most {MAX_PUBLISHERS} publishers")
        );
        require!(
            2 * self.price_threshold as usize > self.publishers.len() + 1,
            MAJORITY_NEEDED
        );
        emit("publisher_added", json!({ "key": key }));
        self.publishers.push(key);
    }

    // The operator can cut off a leaked key at once, since removing only takes power away.
    pub fn remove_publisher(&mut self, key: PublicKey) {
        self.only_operator_or_owner();
        let at = self
            .publishers
            .iter()
            .position(|k| *k == key)
            .unwrap_or_else(|| env::panic_str("not a publisher"));
        require!(
            self.publishers.len() > self.price_threshold as usize,
            "that would leave fewer publishers than must sign"
        );
        emit(
            "publisher_removed",
            json!({ "key": key, "by": env::predecessor_account_id() }),
        );
        self.publishers.remove(at);
    }

    pub fn set_price_threshold(&mut self, threshold: u32) {
        self.only_owner();
        require!(
            threshold > 0 && threshold as usize <= self.publishers.len(),
            "the threshold must be between 1 and the number of publishers"
        );
        require!(2 * threshold as usize > self.publishers.len(), MAJORITY_NEEDED);
        emit("price_threshold_set", json!({ "threshold": threshold }));
        self.price_threshold = threshold;
    }

    pub fn add_series(
        &mut self,
        asset: String,
        decimals: u8,
        first_start: U64,
        interval: U64,
        price_window: U64,
        close_before: U64,
    ) -> u32 {
        self.only_operator_or_owner();
        require!(
            valid_slug(&asset),
            "the asset must be a short lowercase name like btc-usd"
        );
        require!(decimals <= MAX_DECIMALS, "at most 18 decimals");
        require!(
            (HARD_MIN_INTERVAL_NS..=HARD_MAX_INTERVAL_NS).contains(&interval.0),
            "interval outside hard range"
        );
        require!(
            (HARD_MIN_PRICE_WINDOW_NS..=HARD_MAX_PRICE_WINDOW_NS).contains(&price_window.0),
            "price window outside hard range"
        );
        require!(
            (HARD_MIN_CLOSE_BEFORE_NS..=interval.0 / 2).contains(&close_before.0),
            "stakes must close between a minute and half the interval before the end"
        );
        let id = self.next_series_id;
        self.next_series_id += 1;
        let series = Series {
            asset,
            decimals,
            first_start,
            interval,
            price_window,
            close_before,
        };
        emit("series_added", json!({ "series_id": id, "series": series }));
        self.series.insert(id, series.into());
        self.series.flush();
        self.assert_storage_reserve();
        id
    }

    // Anyone can record the price at the start of `round` that enough publishers signed. It is the start price of that
    // round and the end price of the one before, so it is kept once, and only while one of the two holds open stakes.
    pub fn record_price(&mut self, series_id: u32, round: U64, price: U128, signatures: String) {
        let series = self.series_by_id(series_id);
        let at = series.start_of(round.0);
        let now = env::block_timestamp();
        require!(now >= at, "that moment has not come");
        require!(
            now <= at.saturating_add(series.price_window.0),
            "too late to record that price"
        );
        let key = (series_id, round.0);
        require!(!self.prices.contains_key(&key), "that price is already recorded");
        let open = |r: Option<Round>| r.is_some_and(|r| r.outcome.is_none());
        let before = round.0.checked_sub(1).and_then(|b| self.find_round(series_id, b));
        require!(
            open(self.find_round(series_id, round.0)) || open(before),
            "no open round needs that price"
        );
        let message = price_message(&env::current_account_id(), &self.network, &series, at, price.0);
        let signers = price_signatures::verified_signers(&self.publishers, &message, &signatures);
        require!(
            signers.len() >= self.price_threshold as usize,
            "not enough valid publisher signatures"
        );
        self.prices.insert(key, price);
        self.prices.flush();
        self.assert_storage_reserve();
        emit(
            "price_recorded",
            json!({ "series_id": series_id, "round": round, "at": at.to_string(), "price": price, "signers": signers }),
        );
    }

    pub fn settle_round(&mut self, series_id: u32, round: U64) -> Outcome {
        self.settled(series_id, round.0).1
    }

    // Anyone can claim for anyone: the payout only ever goes to the stake's own balance here. A losing stake pays nothing
    // and its record goes, which frees the account's slot.
    pub fn claim(&mut self, series_id: u32, round: U64, account_id: AccountId) -> U128 {
        let key = (series_id, round.0, account_id.clone());
        let stake = self
            .stakes
            .get(&key)
            .copied()
            .unwrap_or_else(|| env::panic_str("no stake in that round"));
        let (mut r, outcome) = self.settled(series_id, round.0);
        let payout = r.payout(outcome, &stake);
        r.left = U128(
            r.left
                .0
                .checked_sub(payout)
                .unwrap_or_else(|| env::panic_str("invariant broken")),
        );
        self.store_round(series_id, round.0, r);
        self.stakes.remove(&key);
        self.locked_total -= payout;
        if payout > 0 {
            self.credit(&account_id, payout);
        }
        let open = self.accounts.get(&account_id).copied().unwrap_or(0);
        self.accounts.insert(account_id.clone(), open - 1);
        emit(
            "claimed",
            json!({ "series_id": series_id, "round": round, "account": account_id, "side": stake.side,
                    "stake": stake.amount, "shares": stake.shares, "payout": payout.to_string() }),
        );
        U128(payout)
    }

    // The verifier calls this once the money is in this contract's Intents account. Panicking makes it refund the sender.
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
        let amount = amounts[0].0;
        require!(amount > 0, "amount must be positive");
        let mut parts = msg.split(':');
        match parts.next() {
            Some("register") => self.register_with_collateral(&sender_id, amount),
            Some("deposit") => {
                require!(!self.paused, "paused");
                require!(self.accounts.contains_key(&sender_id), "register first");
                self.credit(&sender_id, amount);
                emit("deposit", json!({ "account": sender_id, "amount": amount.to_string() }));
            }
            Some("stake") => self.stake_for(&sender_id, parse_bet(parts, Some(amount))),
            _ => env::panic_str("unknown action"),
        }
        vec![U128(0)]
    }

    pub fn on_auth(&mut self, signer_id: AccountId, msg: String) -> PromiseOrValue<()> {
        require!(
            env::predecessor_account_id() == self.verifier,
            "only the verifier can act for a signer"
        );
        let mut parts = msg.split(':');
        match parts.next() {
            Some("stake") => {
                let bet = parse_bet(parts, None);
                self.debit(&signer_id, bet.amount);
                self.stake_for(&signer_id, bet);
            }
            Some("withdraw") => {
                let amount: u128 = parse_part(parts.next(), "amount");
                return PromiseOrValue::Promise(self.withdraw_for(signer_id, amount));
            }
            _ => env::panic_str("unknown action"),
        }
        PromiseOrValue::Value(())
    }

    // Stakes from the balance held here. Needs exactly 1 yocto, so a limited-access key cannot move money.
    #[payable]
    pub fn stake(&mut self, series_id: u32, round: U64, side: String, amount: U128, min_shares: U128) {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        self.debit(&who, amount.0);
        let bet = Bet {
            series_id,
            round: round.0,
            side: parse_side(&side),
            amount: amount.0,
            min_shares: min_shares.0,
        };
        self.stake_for(&who, bet);
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.withdraw_for(env::predecessor_account_id(), amount.0)
    }

    #[private]
    pub fn on_withdraw(&mut self, id: U64, #[callback_result] result: Result<(), PromiseError>) {
        let Some(w) = self.withdrawals.get(&id.0).cloned() else {
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

    // Owner only, for a withdrawal whose callback never came. `paid` is what the verifier's events show: true drops the
    // record, false credits the balance back. A callback that comes later finds no record and changes nothing.
    pub fn reconcile_withdrawal(&mut self, id: U64, paid: bool) {
        self.only_owner();
        let w = self
            .withdrawals
            .get(&id.0)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no withdrawal is pending with that id"));
        require!(
            env::block_timestamp() >= w.at.0.saturating_add(RECONCILE_WAIT_NS),
            "wait an hour after the withdrawal before reconciling"
        );
        let mut data = self.close_withdrawal(id.0, w, !paid);
        data["paid"] = json!(paid);
        emit("withdrawal_reconciled", data);
    }

    pub fn is_staged(&self, code_hash: Base58CryptoHash) -> bool {
        upgrade::is_staged(code_hash)
    }

    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "state_version": self.state_version, "upgrade_proven": self.upgrade_proven,
                "upgrade_in_flight": self.upgrade_in_flight, "owner": self.owner, "pending_owner": self.pending_owner,
                "operator": self.operator, "verifier": self.verifier, "collateral_token_id": self.collateral_token_id,
                "network": self.network, "paused": self.paused, "fee_bps": self.fee_bps,
                "registration_fee": self.registration_fee.to_string(), "min_stake": MIN_STAKE.to_string(),
                "max_open_stakes": MAX_OPEN_STAKES, "publishers": self.publishers, "price_threshold": self.price_threshold,
                "treasury": self.treasury,
                "series": self.next_series_id })
    }

    pub fn get_series(&self, series_id: u32) -> Option<Series> {
        self.find_series(series_id)
    }

    // The round taking stakes now, or the next to open when none is.
    pub fn next_round(&self, series_id: u32) -> U64 {
        let s = self.series_by_id(series_id);
        let now = env::block_timestamp();
        if now < s.first_start.0 {
            return U64(0);
        }
        let current = (now - s.first_start.0) / s.interval.0;
        U64(if now < s.close_of(current) {
            current
        } else {
            current + 1
        })
    }

    pub fn get_round(&self, series_id: u32, round: U64) -> Option<Round> {
        self.find_round(series_id, round.0)
    }

    // The price at the start of `round`, which is also the end price of the round before.
    pub fn get_price(&self, series_id: u32, round: U64) -> Option<U128> {
        self.prices.get(&(series_id, round.0)).copied()
    }

    // The shares `amount` would buy of `side` in `round` at the price it has reached, or 0 when it is more than a round
    // can take.
    pub fn quote_stake(&self, series_id: u32, round: U64, side: String, amount: U128) -> U128 {
        let side = parse_side(&side);
        let r = self
            .find_round(series_id, round.0)
            .unwrap_or_else(|| Round::new(self.fee_bps));
        U128(dpm::buy(r.shares(side), r.shares(side.other()), amount.0).map_or(0, |(shares, _)| shares))
    }

    pub fn get_stake(&self, series_id: u32, round: U64, account_id: AccountId) -> Option<Stake> {
        self.stakes.get(&(series_id, round.0, account_id)).copied()
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.accounts.contains_key(&account_id)
    }

    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        AccountView {
            registered: self.accounts.contains_key(&account_id),
            available: self.get_balance(account_id.clone()),
            pending_withdrawals: U128(self.pending_by_account.get(&account_id).copied().unwrap_or(0)),
            open_stakes: self.accounts.get(&account_id).copied().unwrap_or(0),
        }
    }

    // Everything owed, in collateral units, for the keeper to compare with the verifier's mt_balance_of for this account.
    // A withdrawal counts until its callback confirms it.
    pub fn total_owed(&self) -> U128 {
        self.owed_breakdown().total
    }

    pub fn owed_breakdown(&self) -> OwedView {
        OwedView {
            balances: U128(self.balances_total),
            locked: U128(self.locked_total),
            fees: U128(self.fees),
            pending_withdrawals: U128(self.pending_withdrawals_total),
            total: U128(self.balances_total + self.locked_total + self.fees + self.pending_withdrawals_total),
        }
    }
}

impl RoundsContract {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn only_operator_or_owner(&self) {
        let who = env::predecessor_account_id();
        require!(who == self.operator || who == self.owner, "operator or owner only");
    }

    fn find_series(&self, series_id: u32) -> Option<Series> {
        self.series.get(&series_id).cloned().map(VersionedSeries::into_current)
    }

    fn series_by_id(&self, series_id: u32) -> Series {
        self.find_series(series_id)
            .unwrap_or_else(|| env::panic_str("no such series"))
    }

    fn find_round(&self, series_id: u32, round: u64) -> Option<Round> {
        self.rounds
            .get(&(series_id, round))
            .cloned()
            .map(VersionedRound::into_current)
    }

    fn store_round(&mut self, series_id: u32, round: u64, r: Round) {
        self.rounds.insert((series_id, round), r.into());
    }

    // The round with its outcome, fixed on the first call that can decide it. The fee leaves the round then.
    fn settled(&mut self, series_id: u32, round: u64) -> (Round, Outcome) {
        let mut r = self
            .find_round(series_id, round)
            .unwrap_or_else(|| env::panic_str("nobody staked in that round"));
        if let Some(outcome) = r.outcome {
            return (r, outcome);
        }
        let series = self.series_by_id(series_id);
        let now = env::block_timestamp();
        require!(now >= series.close_of(round), "the round is still taking stakes");
        let prices = (
            self.prices.get(&(series_id, round)).copied(),
            self.prices.get(&(series_id, round.saturating_add(1))).copied(),
        );
        let (outcome, reason) = r
            .decide(&series, round, now, prices)
            .unwrap_or_else(|| env::panic_str("the round is waiting for its prices"));
        let fee = r.fee(outcome);
        r.left = U128(r.left.0 - fee);
        r.outcome = Some(outcome);
        self.store_round(series_id, round, r.clone());
        self.locked_total -= fee;
        self.fees += fee;
        emit(
            "round_settled",
            json!({ "series_id": series_id, "round": round.to_string(), "outcome": outcome, "reason": reason,
                    "fee": fee.to_string() }),
        );
        (r, outcome)
    }

    // A round takes stakes from its start until close_before ahead of its end, and only while its start price is recorded or
    // still can be.
    fn require_taking_stakes(&self, series_id: u32, round: u64) {
        let series = self.series_by_id(series_id);
        let start = series.start_of(round);
        let now = env::block_timestamp();
        require!(now >= start, "the round has not started");
        require!(now < series.close_of(round), "stakes on this round have closed");
        require!(
            self.prices.contains_key(&(series_id, round)) || now <= start.saturating_add(series.price_window.0),
            "the start price of this round can no longer be recorded"
        );
    }

    fn stake_for(&mut self, who: &AccountId, bet: Bet) {
        require!(!self.paused, "paused");
        let open = self
            .accounts
            .get(who)
            .copied()
            .unwrap_or_else(|| env::panic_str("register first"));
        require!(bet.amount >= MIN_STAKE, "the stake is below the minimum");
        self.require_taking_stakes(bet.series_id, bet.round);
        let key = (bet.series_id, bet.round, who.clone());
        let held = self.stakes.get(&key).copied();
        match held {
            Some(s) => require!(s.side == bet.side, "you staked the other side of this round"),
            None => require!(
                open < MAX_OPEN_STAKES,
                "claim a settled round before staking in another"
            ),
        }
        let mut r = self
            .find_round(bet.series_id, bet.round)
            .unwrap_or_else(|| Round::new(self.fee_bps));
        let shares = r
            .take(bet.side, bet.amount)
            .unwrap_or_else(|| env::panic_str("the round cannot take that much"));
        require!(shares >= bet.min_shares, "fewer shares than the minimum");
        let (up, down) = (r.up, r.down);
        self.store_round(bet.series_id, bet.round, r);
        if held.is_none() {
            self.accounts.insert(who.clone(), open + 1);
        }
        let (had_shares, had_amount) = held.map_or((0, 0), |s| (s.shares.0, s.amount.0));
        self.stakes.insert(
            key,
            Stake {
                side: bet.side,
                shares: U128(had_shares + shares),
                amount: U128(had_amount + bet.amount),
            },
        );
        self.locked_total += bet.amount;
        self.stakes.flush();
        self.rounds.flush();
        self.accounts.flush();
        self.assert_storage_reserve();
        emit(
            "staked",
            json!({ "series_id": bet.series_id, "round": bet.round.to_string(), "account": who, "side": bet.side,
                    "amount": bet.amount.to_string(), "shares": shares.to_string(), "up_shares": up,
                    "down_shares": down }),
        );
    }

    fn register_with_collateral(&mut self, who: &AccountId, amount: u128) {
        require!(!self.paused, "paused");
        require!(!self.accounts.contains_key(who), "already registered");
        let fee = self.registration_fee;
        require!(amount >= fee, "send at least the registration fee");
        self.accounts.insert(who.clone(), 0);
        if amount > fee {
            self.credit(who, amount - fee);
        }
        self.accounts.flush();
        self.balances.flush();
        self.assert_storage_reserve();
        self.fees += fee;
        emit("registered", json!({ "account": who, "fee": fee.to_string() }));
    }

    fn withdraw_for(&mut self, who: AccountId, amount: u128) -> Promise {
        require!(amount > 0, "amount must be positive");
        self.debit(&who, amount);
        let id = self.next_withdrawal_id;
        self.next_withdrawal_id += 1;
        self.withdrawals.insert(
            id,
            Withdrawal {
                account: who.clone(),
                amount: U128(amount),
                at: U64(env::block_timestamp()),
            },
        );
        self.pending_withdrawals_total += amount;
        let mine = self.pending_by_account.get(&who).copied().unwrap_or(0);
        self.pending_by_account.insert(who.clone(), mine + amount);
        emit(
            "withdraw",
            json!({ "account": who, "amount": amount.to_string(), "id": id.to_string() }),
        );
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

    fn close_withdrawal(&mut self, id: u64, w: Withdrawal, failed: bool) -> near_sdk::serde_json::Value {
        self.withdrawals.remove(&id);
        let amount = w.amount.0;
        self.pending_withdrawals_total -= amount;
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

    // New records must leave the reserve intact, so storage the contract pays for can never use up its balance.
    fn assert_storage_reserve(&self) {
        let locked = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        require!(
            env::account_balance().as_yoctonear().saturating_sub(locked) >= STORAGE_RESERVE,
            "storage reserve reached; top up before adding records"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;
    use proptest::prelude::*;

    const CONTRACT: &str = "rounds.near";
    const OWNER: &str = "owner.near";
    const VERIFIER: &str = "intents.near";
    const COLLATERAL_ID: &str = "nep141:usdc.near";
    const NETWORK: &str = "testnet";
    const USERS: [&str; 3] = ["ann.near", "ben.near", "cat.near"];
    const USD: u128 = 1_000_000;
    const START: u64 = 1_000 * NS_PER_MINUTE;
    const INTERVAL: u64 = 5 * NS_PER_MINUTE;
    const WINDOW: u64 = 2 * NS_PER_MINUTE;
    const CLOSE_BEFORE: u64 = NS_PER_MINUTE;
    const BETTING: u64 = START + NS_PER_MINUTE;
    const END: u64 = START + INTERVAL;
    const CLOSE: u64 = END - CLOSE_BEFORE;
    const RECEIVED: u128 = 300 * USD;
    const MEASURED_REGISTRATION_BYTES: u64 = 238;
    const MEASURED_STAKE_BYTES: u64 = 154;
    const MEASURED_ROUND_BYTES: u64 = 140;
    const MEASURED_PRICE_BYTES: u64 = 69;

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn act_as(who: &str, now: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct(CONTRACT))
            .predecessor_account_id(acct(who))
            .block_timestamp(now)
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
    }

    fn refused<T>(f: impl FnOnce() -> T) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }

    // What the verifier calls after a transfer with a message. The caller must already be acting as the verifier.
    fn receive(c: &mut RoundsContract, from: &str, amount: u128, msg: &str) {
        let _ = c.mt_on_transfer(
            acct(from),
            vec![acct(from)],
            vec![COLLATERAL_ID.to_string()],
            vec![U128(amount)],
            msg.to_string(),
        );
    }

    fn deliver(c: &mut RoundsContract, at: u64, from: &str, amount: u128, msg: &str) {
        act_as(VERIFIER, at);
        receive(c, from, amount, msg);
    }

    // A signed stake out of the balance that takes any number of shares, so no new money comes in.
    fn stake(c: &mut RoundsContract, at: u64, who: &str, round: u64, side: &str, amount: u128) {
        act_as(VERIFIER, at);
        let _ = c.on_auth(acct(who), format!("stake:0:{round}:{side}:{amount}:0"));
    }

    // A moment when `round` takes stakes.
    fn betting_on(round: u64) -> u64 {
        START + round * INTERVAL + 1
    }

    fn quote(c: &RoundsContract, at: u64, side: &str, amount: u128) -> u128 {
        act_as("keeper.near", at);
        c.quote_stake(0, U64(0), side.into(), U128(amount)).0
    }

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn public(key: &SigningKey) -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, key.verifying_key().to_bytes().to_vec()).unwrap()
    }

    fn signed(keys: &[&SigningKey], message: &str) -> String {
        keys.iter()
            .map(|k| {
                let signature: String = k
                    .sign(message.as_bytes())
                    .to_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                format!("{}.{signature}", public(k))
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    fn btc() -> Series {
        Series {
            asset: "btc-usd".into(),
            decimals: 2,
            first_start: U64(START),
            interval: U64(INTERVAL),
            price_window: U64(WINDOW),
            close_before: U64(CLOSE_BEFORE),
        }
    }

    // Three publishers, two of whom must sign, one series of 5-minute rounds and three users who registered with 100 each.
    fn world() -> (RoundsContract, Vec<SigningKey>) {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as(OWNER, 0);
        let mut c = RoundsContract::new(
            acct(OWNER),
            acct(OWNER),
            acct(VERIFIER),
            COLLATERAL_ID.to_string(),
            NETWORK.to_string(),
            2,
        );
        let keys: Vec<SigningKey> = (1..=3).map(signing_key).collect();
        for k in &keys {
            c.add_publisher(public(k));
        }
        let s = btc();
        c.add_series(
            s.asset,
            s.decimals,
            s.first_start,
            s.interval,
            s.price_window,
            s.close_before,
        );
        for u in USERS {
            deliver(&mut c, 0, u, 100 * USD, "register");
        }
        (c, keys)
    }

    fn message_at(round: u64, price: u128) -> String {
        let s = btc();
        price_message(&acct(CONTRACT), NETWORK, &s, s.start_of(round), price)
    }

    fn record(c: &mut RoundsContract, keys: &[SigningKey], round: u64, price: u128, at: u64) {
        act_as("keeper.near", at);
        let signatures = signed(&[&keys[0], &keys[2]], &message_at(round, price));
        c.record_price(0, U64(round), U128(price), signatures);
    }

    fn claim(c: &mut RoundsContract, at: u64, who: &str, round: u64) -> u128 {
        act_as("keeper.near", at);
        c.claim(0, U64(round), acct(who)).0
    }

    fn balance(c: &RoundsContract, who: &str) -> u128 {
        c.get_balance(acct(who)).0
    }

    fn last_event() -> near_sdk::serde_json::Value {
        let logs = get_logs();
        let line = logs.last().expect("an event").strip_prefix("EVENT_JSON:").unwrap();
        near_sdk::serde_json::from_str(line).unwrap()
    }

    // Every unit received is in a round, a balance, the fees or a pending withdrawal, and the totals agree with the records.
    fn assert_conserved(c: &RoundsContract, received: u128, rounds: std::ops::Range<u64>) {
        let left: u128 = rounds.filter_map(|r| c.find_round(0, r)).map(|r| r.left.0).sum();
        assert_eq!(c.locked_total, left, "locked_total drifted from the rounds");
        let balances: u128 = USERS.iter().map(|u| balance(c, u)).sum();
        assert_eq!(c.balances_total, balances, "balances_total drifted from the balances");
        assert_eq!(c.total_owed().0, received, "money was created or lost");
    }

    // ann and ben back Up with 10 and 30, cat backs Down with 20, and round 0 opens at 100.00.
    fn staked_round(c: &mut RoundsContract, keys: &[SigningKey]) {
        stake(c, BETTING, USERS[0], 0, "up", 10 * USD);
        stake(c, BETTING, USERS[1], 0, "up", 30 * USD);
        stake(c, BETTING, USERS[2], 0, "down", 20 * USD);
        record(c, keys, 0, 10_000, BETTING);
    }

    #[test]
    fn the_side_that_was_right_shares_the_other_pool_less_the_fee() {
        let (mut c, keys) = world();
        staked_round(&mut c, &keys);
        record(&mut c, &keys, 1, 10_100, END);
        assert_eq!(claim(&mut c, END, USERS[0], 0), 14_850_000);
        assert_eq!(claim(&mut c, END, USERS[1], 0), 44_550_000);
        assert_eq!(claim(&mut c, END, USERS[2], 0), 0);
        let r = c.find_round(0, 0).unwrap();
        assert_eq!((r.outcome, r.left.0), (Some(Outcome::Up), 0));
        assert_eq!(c.fees, 3 * DEFAULT_REGISTRATION_FEE + 600_000, "3% of the 20 that lost");
        assert_eq!(balance(&c, USERS[2]), 80 * USD - DEFAULT_REGISTRATION_FEE);
        assert_conserved(&c, RECEIVED, 0..1);
    }

    #[test]
    fn a_fall_pays_the_down_side_and_a_tie_refunds_everyone_without_a_fee() {
        for (end_price, outcome, payouts, fee) in [
            (9_999, Outcome::Down, [0, 0, 60 * USD - 1_200_000], 1_200_000),
            (10_000, Outcome::Refund, [10 * USD, 30 * USD, 20 * USD], 0),
        ] {
            let (mut c, keys) = world();
            staked_round(&mut c, &keys);
            record(&mut c, &keys, 1, end_price, END);
            for (u, expected) in USERS.iter().zip(payouts) {
                assert_eq!(claim(&mut c, END, u, 0), expected, "{u} at {end_price}");
            }
            assert_eq!(c.find_round(0, 0).unwrap().outcome, Some(outcome));
            assert_eq!(c.fees, 3 * DEFAULT_REGISTRATION_FEE + fee);
            assert_conserved(&c, RECEIVED, 0..1);
        }
    }

    #[test]
    fn a_round_with_an_empty_side_refunds_as_soon_as_its_stakes_close() {
        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
        stake(&mut c, BETTING, USERS[1], 0, "up", 5 * USD);
        act_as("keeper.near", CLOSE);
        assert_eq!(c.settle_round(0, U64(0)), Outcome::Refund);
        assert_eq!(last_event()["data"]["reason"], "one_sided");
        assert_eq!(claim(&mut c, CLOSE, USERS[0], 0), 10 * USD);
        assert_eq!(claim(&mut c, CLOSE, USERS[1], 0), 5 * USD);
        assert_conserved(&c, RECEIVED, 0..1);
    }

    #[test]
    #[should_panic(expected = "the round is still taking stakes")]
    fn a_round_cannot_settle_while_it_takes_stakes() {
        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
        act_as("keeper.near", CLOSE - 1);
        c.settle_round(0, U64(0));
    }

    #[test]
    fn a_price_that_never_came_refunds_the_round_once_its_window_closes() {
        let (mut c, keys) = world();
        staked_round(&mut c, &keys);
        act_as("keeper.near", END + WINDOW + 1);
        assert_eq!(c.settle_round(0, U64(0)), Outcome::Refund);
        assert_eq!(last_event()["data"]["reason"], "no_price");
        assert_eq!(claim(&mut c, END + WINDOW + 1, USERS[1], 0), 30 * USD);

        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
        stake(&mut c, BETTING, USERS[2], 0, "down", 20 * USD);
        assert_eq!(
            claim(&mut c, CLOSE, USERS[2], 0),
            20 * USD,
            "a missing start price refunds before the round would have ended"
        );
    }

    #[test]
    #[should_panic(expected = "the round is waiting for its prices")]
    fn a_round_waits_while_its_end_price_can_still_come() {
        let (mut c, keys) = world();
        staked_round(&mut c, &keys);
        act_as("keeper.near", END + WINDOW);
        c.settle_round(0, U64(0));
    }

    #[test]
    #[should_panic(expected = "too late to record that price")]
    fn a_price_after_its_window_is_refused() {
        let (mut c, keys) = world();
        staked_round(&mut c, &keys);
        record(&mut c, &keys, 1, 10_100, END + WINDOW + 1);
    }

    #[test]
    #[should_panic(expected = "that moment has not come")]
    fn a_price_before_its_moment_is_refused() {
        let (mut c, keys) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
        record(&mut c, &keys, 0, 10_000, START - 1);
    }

    #[test]
    #[should_panic(expected = "not enough valid publisher signatures")]
    fn one_signature_is_not_enough_when_two_must_sign() {
        let (mut c, keys) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
        act_as("keeper.near", START);
        c.record_price(0, U64(0), U128(10_000), signed(&[&keys[1]], &message_at(0, 10_000)));
    }

    #[test]
    fn a_signature_is_good_for_one_price_of_one_asset_at_one_moment_on_one_contract_and_network() {
        let other = |change: &dyn Fn(&mut Series, &mut AccountId, &mut String)| {
            let (mut s, mut contract, mut network) = (btc(), acct(CONTRACT), NETWORK.to_string());
            change(&mut s, &mut contract, &mut network);
            price_message(&contract, &network, &s, s.start_of(0), 10_000)
        };
        let messages = [
            other(&|s, _, _| s.asset = "eth-usd".into()),
            other(&|s, _, _| s.decimals = 8),
            other(&|s, _, _| s.first_start = U64(START + 1)),
            other(&|_, c, _| *c = acct("other.near")),
            other(&|_, _, n| *n = "mainnet".into()),
            message_at(0, 10_001),
        ];
        for message in messages {
            let (mut c, keys) = world();
            stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
            act_as("keeper.near", START);
            let signatures = signed(&[&keys[0], &keys[1]], &message);
            assert!(
                refused(|| c.record_price(0, U64(0), U128(10_000), signatures)),
                "a signature over {message} must not record 10000"
            );
            assert_eq!(c.get_price(0, U64(0)), None);
        }
    }

    #[test]
    #[should_panic(expected = "that price is already recorded")]
    fn the_first_quorum_for_a_moment_is_final() {
        let (mut c, keys) = world();
        staked_round(&mut c, &keys);
        record(&mut c, &keys, 0, 10_050, START + 1);
    }

    #[test]
    #[should_panic(expected = "no open round needs that price")]
    fn a_price_no_staked_round_uses_is_refused() {
        let (mut c, keys) = world();
        record(&mut c, &keys, 0, 10_000, START);
    }

    #[test]
    fn one_price_ends_a_round_and_starts_the_next_even_if_it_came_before_anyone_staked_in_the_next() {
        let (mut c, keys) = world();
        staked_round(&mut c, &keys);
        record(&mut c, &keys, 1, 10_100, END);
        stake(&mut c, betting_on(1), USERS[0], 1, "down", 5 * USD);
        stake(&mut c, betting_on(1), USERS[1], 1, "up", 5 * USD);
        record(&mut c, &keys, 2, 10_050, END + INTERVAL);
        act_as("keeper.near", END + INTERVAL);
        assert_eq!(
            c.settle_round(0, U64(0)),
            Outcome::Up,
            "10_100 ends round 0 above 10_000"
        );
        assert_eq!(
            c.settle_round(0, U64(1)),
            Outcome::Down,
            "and starts round 1, which ends below it"
        );
        assert_conserved(&c, RECEIVED, 0..2);
    }

    #[test]
    fn a_round_takes_stakes_from_its_start_until_close_before_its_end() {
        let (mut c, keys) = world();
        act_as("keeper.near", START - 1);
        assert_eq!(c.next_round(0), U64(0));
        assert!(refused(|| stake(&mut c, START - 1, USERS[0], 0, "up", MIN_STAKE)));
        stake(&mut c, START, USERS[0], 0, "up", MIN_STAKE);
        record(&mut c, &keys, 0, 10_000, START);
        stake(&mut c, CLOSE - 1, USERS[0], 0, "up", MIN_STAKE);
        act_as("keeper.near", CLOSE - 1);
        assert_eq!(c.next_round(0), U64(0));
        assert!(refused(|| stake(&mut c, CLOSE, USERS[0], 0, "up", MIN_STAKE)));
        assert!(
            refused(|| stake(&mut c, CLOSE, USERS[0], 1, "up", MIN_STAKE)),
            "between the close and the end no round takes stakes"
        );
        act_as("keeper.near", CLOSE);
        assert_eq!(c.next_round(0), U64(1));
        stake(&mut c, END, USERS[0], 1, "up", MIN_STAKE);
        assert_eq!(c.get_account(acct(USERS[0])).open_stakes, 2);
    }

    #[test]
    #[should_panic(expected = "the round has not started")]
    fn a_round_takes_no_stakes_before_it_starts() {
        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[0], 1, "up", 10 * USD);
    }

    #[test]
    #[should_panic(expected = "stakes on this round have closed")]
    fn a_round_takes_no_stakes_once_they_close() {
        let (mut c, _) = world();
        stake(&mut c, CLOSE, USERS[0], 0, "up", 10 * USD);
    }

    #[test]
    fn a_round_whose_start_price_can_no_longer_be_recorded_takes_no_stakes() {
        let (mut c, keys) = world();
        assert!(
            refused(|| record(&mut c, &keys, 0, 10_000, START)),
            "nobody has staked in round 0 or the round before"
        );
        assert!(refused(|| stake(
            &mut c,
            START + WINDOW + 1,
            USERS[0],
            0,
            "up",
            MIN_STAKE
        )));
        stake(&mut c, betting_on(1), USERS[0], 1, "up", MIN_STAKE);
        record(&mut c, &keys, 1, 10_000, betting_on(1));
        stake(&mut c, END + WINDOW + 1, USERS[1], 1, "down", MIN_STAKE);
        assert_eq!(
            c.get_round(0, U64(1)).unwrap().paid_down.0,
            MIN_STAKE,
            "a recorded start price keeps the round open to stakes"
        );
    }

    #[test]
    fn a_stake_buys_shares_at_the_price_the_round_has_reached_and_the_quote_says_how_many() {
        let (mut c, keys) = world();
        assert_eq!(
            quote(&c, BETTING, "up", 10 * USD),
            10 * USD,
            "a share a unit in an empty round"
        );
        stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
        stake(&mut c, BETTING, USERS[2], 0, "down", 10 * USD);
        let quoted = quote(&c, BETTING, "up", 10 * USD);
        stake(&mut c, BETTING, USERS[1], 0, "up", 10 * USD);
        assert_eq!(last_event()["data"]["shares"], quoted.to_string());
        let shares = |c: &RoundsContract, u: &str| c.get_stake(0, U64(0), acct(u)).unwrap().shares.0;
        assert_eq!(shares(&c, USERS[1]), quoted);
        assert!(
            shares(&c, USERS[2]) > shares(&c, USERS[0]),
            "Down was cheaper when cat staked"
        );
        assert!(
            shares(&c, USERS[1]) > shares(&c, USERS[0]),
            "and cat's stake made Up cheaper"
        );
        record(&mut c, &keys, 0, 10_000, BETTING);
        record(&mut c, &keys, 1, 10_100, END);
        let (ann, ben) = (claim(&mut c, END, USERS[0], 0), claim(&mut c, END, USERS[1], 0));
        assert!(
            ann >= 10 * USD && ben > ann,
            "each winner gets the stake back at least, more shares more"
        );
        assert_eq!(c.fees, 3 * DEFAULT_REGISTRATION_FEE + 300_000, "3% of the 10 Down paid");
        assert!(
            30 * USD - 300_000 - ann - ben < 2,
            "the winners share the pool less the fee"
        );
        assert_conserved(&c, RECEIVED, 0..1);
    }

    #[test]
    fn a_winner_never_gets_back_less_than_the_stake_even_when_the_losers_paid_almost_nothing() {
        let (mut c, keys) = world();
        stake(&mut c, BETTING, USERS[2], 0, "down", MIN_STAKE);
        stake(&mut c, BETTING, USERS[0], 0, "up", 99 * USD);
        stake(&mut c, BETTING, USERS[1], 0, "up", 99 * USD);
        record(&mut c, &keys, 0, 10_000, BETTING);
        record(&mut c, &keys, 1, 10_100, END);
        let r = c.find_round(0, 0).unwrap();
        let cap = r.paid_up.0 + r.paid_down.0 - r.up.0;
        assert!(
            cap < MIN_STAKE * u128::from(DEFAULT_FEE_BPS) / BPS_DENOMINATOR,
            "the cap is lower than 3% here"
        );
        assert!(claim(&mut c, END, USERS[0], 0) >= 99 * USD);
        assert!(
            claim(&mut c, END, USERS[1], 0) >= 99 * USD,
            "the last stake bought at almost a unit a share"
        );
        assert_eq!(c.fees, 3 * DEFAULT_REGISTRATION_FEE + cap);
        assert_conserved(&c, RECEIVED, 0..1);
    }

    #[test]
    fn a_stake_that_would_get_fewer_shares_than_asked_is_refused() {
        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[2], 0, "down", 10 * USD);
        let quoted = quote(&c, BETTING, "up", 10 * USD);
        stake(&mut c, BETTING, USERS[1], 0, "up", 10 * USD);
        act_as(VERIFIER, BETTING);
        let stale = format!("stake:0:0:up:{}:{quoted}", 10 * USD);
        assert!(
            refused(|| c.on_auth(acct(USERS[0]), stale)),
            "ben's stake moved the price first"
        );
        let now = quote(&c, BETTING, "up", 10 * USD);
        assert!(now < quoted);
        act_as(VERIFIER, BETTING);
        let _ = c.on_auth(acct(USERS[0]), format!("stake:0:0:up:{}:{now}", 10 * USD));
        assert_eq!(c.get_stake(0, U64(0), acct(USERS[0])).unwrap().shares.0, now);
    }

    #[test]
    fn a_stake_can_arrive_with_its_money() {
        let (mut c, _) = world();
        deliver(&mut c, BETTING, USERS[0], 7 * USD, "stake:0:0:down:0");
        let s = c.get_stake(0, U64(0), acct(USERS[0])).unwrap();
        assert_eq!((s.side, s.amount.0, s.shares.0), (Side::Down, 7 * USD, 7 * USD));
        assert_eq!(balance(&c, USERS[0]), 100 * USD - DEFAULT_REGISTRATION_FEE);
        assert_conserved(&c, RECEIVED + 7 * USD, 0..1);
        assert!(
            refused(|| deliver(&mut c, BETTING, USERS[0], 7 * USD, "stake:0:0:down")),
            "a stake names the fewest shares it takes"
        );
    }

    #[test]
    fn a_second_stake_on_the_same_side_adds_to_the_first() {
        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
        stake(&mut c, BETTING, USERS[0], 0, "up", 5 * USD);
        let s = c.get_stake(0, U64(0), acct(USERS[0])).unwrap();
        assert_eq!((s.side, s.amount.0, s.shares.0), (Side::Up, 15 * USD, 15 * USD));
        assert_eq!(c.get_account(acct(USERS[0])).open_stakes, 1);
    }

    #[test]
    #[should_panic(expected = "you staked the other side of this round")]
    fn an_account_backs_one_side_of_a_round() {
        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
        stake(&mut c, BETTING, USERS[0], 0, "down", 10 * USD);
    }

    #[test]
    #[should_panic(expected = "the stake is below the minimum")]
    fn a_stake_below_the_minimum_is_refused() {
        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", MIN_STAKE - 1);
    }

    #[test]
    fn registering_keeps_the_fee_and_credits_the_rest() {
        let (c, _) = world();
        assert_eq!(balance(&c, USERS[0]), 100 * USD - DEFAULT_REGISTRATION_FEE);
        assert_eq!(c.fees, 3 * DEFAULT_REGISTRATION_FEE);
        assert_conserved(&c, RECEIVED, 0..0);
    }

    #[test]
    #[should_panic(expected = "register first")]
    fn an_unregistered_account_cannot_stake() {
        let (mut c, _) = world();
        deliver(&mut c, BETTING, "dan.near", 10 * USD, "stake:0:0:up:0");
    }

    #[test]
    #[should_panic(expected = "already registered")]
    fn an_account_registers_once() {
        let (mut c, _) = world();
        deliver(&mut c, 0, USERS[0], USD, "register");
    }

    #[test]
    #[should_panic(expected = "send at least the registration fee")]
    fn registering_needs_the_fee() {
        let (mut c, _) = world();
        deliver(&mut c, 0, "dan.near", DEFAULT_REGISTRATION_FEE - 1, "register");
    }

    #[test]
    fn an_account_holds_a_bounded_number_of_open_stakes_and_a_claim_frees_one() {
        let (mut c, _) = world();
        let limit = u64::from(MAX_OPEN_STAKES);
        for round in 0..limit {
            stake(&mut c, betting_on(round), USERS[0], round, "up", MIN_STAKE);
        }
        let at = betting_on(limit);
        assert!(refused(|| stake(&mut c, at, USERS[0], limit, "up", MIN_STAKE)));
        assert_eq!(claim(&mut c, at, USERS[0], 0), MIN_STAKE, "a one-sided round refunds");
        stake(&mut c, at, USERS[0], limit, "up", MIN_STAKE);
        assert_eq!(c.get_account(acct(USERS[0])).open_stakes, MAX_OPEN_STAKES);
    }

    #[test]
    fn a_round_pays_the_fee_in_force_when_it_took_its_first_stake() {
        let (mut c, keys) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", 10 * USD);
        act_as(OWNER, BETTING);
        c.set_fee_bps(HARD_MAX_FEE_BPS);
        stake(&mut c, BETTING, USERS[2], 0, "down", 20 * USD);
        record(&mut c, &keys, 0, 10_000, BETTING);
        record(&mut c, &keys, 1, 10_100, END);
        assert_eq!(claim(&mut c, END, USERS[0], 0), 10 * USD + 20 * USD - 600_000);
    }

    #[test]
    fn a_pause_stops_money_coming_in_but_never_prices_claims_or_withdrawals() {
        let (mut c, keys) = world();
        staked_round(&mut c, &keys);
        act_as(OWNER, START);
        c.set_paused(true);
        for msg in ["register", "deposit", "stake:0:0:up:0"] {
            assert!(
                refused(|| deliver(&mut c, START, USERS[0], USD, msg)),
                "{msg} while paused"
            );
        }
        record(&mut c, &keys, 1, 10_100, END);
        let paid = claim(&mut c, END, USERS[0], 0);
        act_as(VERIFIER, END);
        let _ = c.on_auth(acct(USERS[0]), format!("withdraw:{paid}"));
        assert_eq!(c.pending_withdrawals_total, paid);
        assert_conserved(&c, RECEIVED, 0..1);
    }

    #[test]
    fn a_signed_stake_spends_the_signers_balance() {
        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[0], 0, "down", 4 * USD);
        assert_eq!(balance(&c, USERS[0]), 96 * USD - DEFAULT_REGISTRATION_FEE);
        assert_eq!(c.get_stake(0, U64(0), acct(USERS[0])).unwrap().side, Side::Down);
        assert_conserved(&c, RECEIVED, 0..1);
    }

    #[test]
    #[should_panic(expected = "only the verifier can act for a signer")]
    fn only_the_verifier_acts_for_a_signer() {
        let (mut c, _) = world();
        act_as(USERS[1], BETTING);
        let _ = c.on_auth(acct(USERS[0]), "withdraw:1".to_string());
    }

    #[test]
    #[should_panic(expected = "not enough balance")]
    fn a_signed_stake_cannot_spend_more_than_the_balance() {
        let (mut c, _) = world();
        stake(&mut c, BETTING, USERS[0], 0, "up", 100 * USD);
    }

    #[test]
    fn a_failed_withdrawal_gives_the_balance_back_and_a_repeat_changes_nothing() {
        let (mut c, _) = world();
        let all = balance(&c, USERS[0]);
        act_as(VERIFIER, 1);
        let _ = c.on_auth(acct(USERS[0]), format!("withdraw:{all}"));
        assert_eq!((balance(&c, USERS[0]), c.pending_withdrawals_total), (0, all));
        assert_conserved(&c, RECEIVED, 0..0);
        act_as(CONTRACT, 2);
        c.on_withdraw(U64(1), Err(PromiseError::Failed));
        assert_eq!((balance(&c, USERS[0]), c.pending_withdrawals_total), (all, 0));
        assert_eq!(last_event()["event"], "withdraw_failed");
        c.on_withdraw(U64(1), Ok(()));
        assert_eq!(balance(&c, USERS[0]), all);
        assert_conserved(&c, RECEIVED, 0..0);
    }

    #[test]
    fn the_owner_settles_a_withdrawal_whose_callback_never_came_after_an_hour() {
        let (mut c, _) = world();
        act_as(VERIFIER, 1);
        let _ = c.on_auth(acct(USERS[0]), format!("withdraw:{USD}"));
        act_as(OWNER, RECONCILE_WAIT_NS);
        assert!(refused(|| c.reconcile_withdrawal(U64(1), true)));
        act_as(OWNER, RECONCILE_WAIT_NS + 1);
        c.reconcile_withdrawal(U64(1), true);
        assert_eq!(c.total_owed().0, RECEIVED - USD);
    }

    const TREASURY: &str = "treasury.near";

    #[test]
    fn the_fees_leave_for_the_treasury_as_a_withdrawal_and_come_back_if_it_fails() {
        let (mut c, _) = world();
        let fees = c.fees;
        assert!(fees > 0);
        act_as(OWNER, 1);
        assert!(refused(|| c.sweep_fees()), "no treasury is named yet");
        c.set_treasury(acct(TREASURY));
        assert_eq!(c.config()["treasury"], TREASURY);
        act_as("anyone.near", 2);
        let _ = c.sweep_fees();
        assert_eq!((c.fees, c.pending_withdrawals_total), (0, fees));
        assert_eq!(
            c.total_owed().0,
            RECEIVED,
            "nothing is created or lost while it is in flight"
        );
        assert!(get_logs().iter().any(|l| l.contains("fees_swept")));
        act_as(CONTRACT, 3);
        c.on_withdraw(U64(1), Err(PromiseError::Failed));
        assert_eq!((c.fees, c.pending_withdrawals_total), (0, 0));
        assert_eq!(
            balance(&c, TREASURY),
            fees,
            "a failed sweep leaves the money on the treasury's balance"
        );
        assert_eq!(c.total_owed().0, RECEIVED);

        act_as("anyone.near", 4);
        let _ = c.sweep_fees();
        act_as(CONTRACT, 5);
        c.on_withdraw(U64(2), Ok(()));
        assert_eq!((balance(&c, TREASURY), c.pending_withdrawals_total), (0, 0));
        assert_eq!(
            c.total_owed().0,
            RECEIVED - fees,
            "the fees are gone from what the verifier must hold"
        );
        act_as("anyone.near", 6);
        assert!(refused(|| c.sweep_fees()), "nothing left to sweep");
    }

    #[test]
    fn a_sweep_needs_the_gas_for_its_callback() {
        let (mut c, _) = world();
        act_as(OWNER, 1);
        c.set_treasury(acct(TREASURY));
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct(CONTRACT))
            .predecessor_account_id(acct("anyone.near"))
            .prepaid_gas(Gas::from_tgas(30))
            .build());
        assert!(refused(|| c.sweep_fees()));
        assert!(c.fees > 0, "a refused sweep changes nothing");
    }

    #[test]
    fn only_the_owner_names_the_treasury() {
        let (mut c, _) = world();
        act_as("anyone.near", 1);
        assert!(refused(|| c.set_treasury(acct(TREASURY))));
    }

    #[test]
    fn migrate_moves_version_one_state_to_two_with_no_treasury() {
        let (c, _) = world();
        let old = StateV1 {
            state_version: 1,
            upgrade_proven: false,
            upgrade_in_flight: true,
            owner: acct(OWNER),
            pending_owner: None,
            operator: acct(OWNER),
            verifier: acct(VERIFIER),
            collateral_token_id: COLLATERAL_ID.to_string(),
            network: NETWORK.to_string(),
            paused: false,
            fee_bps: DEFAULT_FEE_BPS,
            registration_fee: DEFAULT_REGISTRATION_FEE,
            publishers: c.publishers.clone(),
            price_threshold: 2,
            next_series_id: 1,
            series: LookupMap::new(Key::Series),
            rounds: LookupMap::new(Key::Rounds),
            prices: LookupMap::new(Key::Prices),
            stakes: LookupMap::new(Key::Stakes),
            accounts: LookupMap::new(Key::Accounts),
            balances: LookupMap::new(Key::Balances),
            balances_total: 7,
            locked_total: 8,
            fees: 9,
            next_withdrawal_id: 4,
            withdrawals: LookupMap::new(Key::Withdrawals),
            pending_withdrawals_total: 5,
            pending_by_account: LookupMap::new(Key::PendingByAccount),
        };
        env::state_write(&old);
        drop(c);
        act_as(CONTRACT, 5);
        let migrated = RoundsContract::migrate();
        assert_eq!(migrated.state_version, STATE_VERSION);
        assert_eq!(
            (migrated.balances_total, migrated.locked_total, migrated.fees),
            (7, 8, 9)
        );
        assert_eq!(
            (migrated.pending_withdrawals_total, migrated.next_withdrawal_id),
            (5, 4)
        );
        assert!(migrated.treasury.is_none());
        assert!(migrated.upgrade_proven && !migrated.upgrade_in_flight);
    }

    #[test]
    fn the_threshold_must_stay_above_half_of_the_publishers() {
        let (mut c, _) = world();
        act_as(OWNER, 1);
        assert!(
            refused(|| c.add_publisher(public(&signing_key(40)))),
            "2 of 4 would let two prices win"
        );
        c.set_price_threshold(3);
        c.add_publisher(public(&signing_key(40)));
        assert!(refused(|| c.set_price_threshold(2)), "2 of 4 again");
        c.remove_publisher(public(&signing_key(40)));
        c.set_price_threshold(2);
        assert_eq!(c.config()["price_threshold"], 2);
    }

    #[test]
    fn the_owner_sets_fees_series_and_publishers_only_within_hard_limits() {
        let (mut c, keys) = world();
        act_as(OWNER, 1);
        assert!(refused(|| c.set_fee_bps(HARD_MAX_FEE_BPS + 1)));
        assert!(refused(|| c.set_registration_fee(U128(HARD_MIN_REGISTRATION_FEE - 1))));
        assert!(refused(|| c.set_registration_fee(U128(HARD_MAX_REGISTRATION_FEE + 1))));
        assert!(refused(|| c.set_price_threshold(0)));
        assert!(refused(|| c.set_price_threshold(4)));
        let secp = PublicKey::from_parts(CurveType::SECP256K1, vec![7; 64]).unwrap();
        assert!(refused(|| c.add_publisher(secp)));
        assert!(refused(|| c.add_publisher(public(&keys[0]))));
        let s = btc();
        let add = |c: &mut RoundsContract, change: &dyn Fn(&mut Series)| {
            let mut s = btc();
            change(&mut s);
            c.add_series(
                s.asset,
                s.decimals,
                s.first_start,
                s.interval,
                s.price_window,
                s.close_before,
            )
        };
        let changes: [&dyn Fn(&mut Series); 6] = [
            &|s| s.asset = "BTC".into(),
            &|s| s.decimals = 19,
            &|s| s.interval = U64(HARD_MIN_INTERVAL_NS - 1),
            &|s| s.price_window = U64(HARD_MAX_PRICE_WINDOW_NS + 1),
            &|s| s.close_before = U64(HARD_MIN_CLOSE_BEFORE_NS - 1),
            &|s| s.close_before = U64(INTERVAL / 2 + 1),
        ];
        for change in changes {
            assert!(refused(|| add(&mut c, change)));
        }
        add(&mut c, &|s| s.close_before = U64(INTERVAL / 2));
        c.remove_publisher(public(&keys[0]));
        assert!(
            refused(|| c.remove_publisher(public(&keys[1]))),
            "two must still sign, so two publishers stay"
        );
        act_as(USERS[0], 1);
        assert!(
            refused(|| c.add_publisher(public(&keys[0]))),
            "only the owner adds a publisher"
        );
        assert!(refused(|| c.add_series(
            s.asset.clone(),
            2,
            s.first_start,
            s.interval,
            s.price_window,
            s.close_before
        )));
    }

    #[test]
    fn measure_an_account_at_its_open_stake_limit() {
        let (mut c, _) = world();
        let longest = "a".repeat(64);
        act_as(VERIFIER, BETTING);
        let before = env::storage_usage();
        receive(&mut c, &longest, 100 * USD, "register");
        let registered = env::storage_usage() - before;
        let _ = c.on_auth(acct(USERS[0]), format!("stake:0:0:up:{MIN_STAKE}:0"));
        let before = env::storage_usage();
        let _ = c.on_auth(acct(&longest), format!("stake:0:0:up:{MIN_STAKE}:0"));
        let per_stake = env::storage_usage() - before;
        let before = env::storage_usage();
        let largest = Round {
            up: U128(u128::MAX),
            down: U128(u128::MAX),
            paid_up: U128(u128::MAX),
            paid_down: U128(u128::MAX),
            left: U128(u128::MAX),
            fee_bps: HARD_MAX_FEE_BPS,
            outcome: Some(Outcome::Refund),
        };
        c.store_round(u32::MAX, u64::MAX, largest);
        c.rounds.flush();
        let per_round = env::storage_usage() - before;
        let before = env::storage_usage();
        c.prices.insert((u32::MAX, u64::MAX), U128(u128::MAX));
        c.prices.flush();
        let per_price = env::storage_usage() - before;
        assert_eq!(
            (registered, per_stake, per_round, per_price),
            (
                MEASURED_REGISTRATION_BYTES,
                MEASURED_STAKE_BYTES,
                MEASURED_ROUND_BYTES,
                MEASURED_PRICE_BYTES
            ),
            "update the storage figures in docs/contracts/rounds.md"
        );
    }

    proptest! {
        #[test]
        fn no_round_pays_out_more_than_it_took_and_every_unit_is_accounted_for(
            stakes in proptest::collection::vec((0usize..3, any::<bool>(), 0u128..8_000_000), 1..12),
            ending in 0usize..4,
        ) {
            let (mut c, keys) = world();
            for (user, up, extra) in &stakes {
                let side = if *up { Side::Up } else { Side::Down };
                if c.get_stake(0, U64(0), acct(USERS[*user])).is_some_and(|s| s.side != side) {
                    continue;
                }
                let word = if *up { "up" } else { "down" };
                stake(&mut c, BETTING, USERS[*user], 0, word, MIN_STAKE + extra);
            }
            let staked: Vec<Option<Stake>> = USERS.iter().map(|u| c.get_stake(0, U64(0), acct(u))).collect();
            let at = if ending == 3 {
                END + WINDOW + 1
            } else {
                record(&mut c, &keys, 0, 10_000, BETTING);
                record(&mut c, &keys, 1, [10_001, 9_999, 10_000][ending], END);
                END
            };
            let before: u128 = USERS.iter().map(|u| balance(&c, u)).sum();
            let mut paid = 0;
            for (u, s) in USERS.iter().zip(&staked) {
                let Some(s) = s else { continue };
                let payout = claim(&mut c, at, u, 0);
                match c.find_round(0, 0).unwrap().outcome.unwrap().winner() {
                    None => prop_assert_eq!(payout, s.amount.0),
                    Some(side) if side == s.side => prop_assert!(payout >= s.amount.0),
                    Some(_) => prop_assert_eq!(payout, 0),
                }
                paid += payout;
            }
            let r = c.find_round(0, 0).unwrap();
            prop_assert_eq!(paid + r.fee(r.outcome.unwrap()) + r.left.0, r.paid_up.0 + r.paid_down.0);
            prop_assert!(r.left.0 < 3, "rounding leaves less than one unit a winner");
            prop_assert_eq!(USERS.iter().map(|u| balance(&c, u)).sum::<u128>(), before + paid);
            assert_conserved(&c, RECEIVED, 0..1);
        }
    }
}
