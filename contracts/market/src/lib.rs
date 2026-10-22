// Binary prediction market with built-in constant-product pricing (the pitch test).
// One owner creates markets and seeds each with liquidity. Users hold shares inside this contract.
// A separate oracle contract decides outcomes and is the only caller of set_outcome.
// The JSON interface takes one argument per field, so a few methods are long on purpose.
#![allow(clippy::too_many_arguments)]

mod curve;

use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue, PublicKey,
};

use curve::MAX_POOL;

// Each account pays this once. It covers a balance entry plus MAX_POSITIONS share entries
// (about 100 bytes each at 1 NEAR per 100 KB), so spam accounts cannot drain the contract's storage.
const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(50);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
// ponytail: flat 0.05 NEAR deposit and a 20-position cap instead of per-byte storage accounting; revisit if users need more positions.
const MAX_POSITIONS: u32 = 20;
// Price points kept per market for the chart. Oldest is dropped past this, so storage per market stays bounded.
const HISTORY_MAX: usize = 120;
// Text limits (bytes). Every trade rewrites the whole market record, so unbounded text would make trading expensive.
const MAX_TITLE: usize = 200;
const MAX_RULE: usize = 2000;
const MAX_SOURCE: usize = 300;
const MAX_VOID: usize = 500;
// The Yes prices a market can open at, in millionths: 1% to 99%, the range prices are allowed in.
const MIN_OPEN_PRICE: u128 = 10_000;
const MAX_OPEN_PRICE: u128 = 990_000;
// A Void pays each Yes share the Yes price averaged over this long before close, so a trade just before close
// cannot set it. 24 hours in nanoseconds.
const VOID_PRICE_WINDOW_NS: u64 = 86_400_000_000_000;
// The oracle answers a market that nobody answered once resolve_by has passed. This much later anyone can void it
// here instead, for the case of an oracle that is gone. 7 days in nanoseconds.
const VOID_GRACE_NS: u64 = 7 * 86_400_000_000_000;
// The fee on a trade is rate × shares × p × (1 − p). 2% costs about 1% of what a 50c trade pays. Both fees start at
// these values and the owner (the DAO) can change them, but never above the ceilings, which are written here so that even
// a captured owner cannot set a confiscatory fee.
const DEFAULT_FEE_RATE_BPS: u128 = 200;
const MAX_FEE_RATE_BPS: u128 = 500;
// ponytail: placeholder, 1 unit of the 6-decimal test token, taken out of the seed transfer. The ceiling is 10 units.
const DEFAULT_CREATE_FEE: u128 = 1_000_000;
const MAX_CREATE_FEE: u128 = 10_000_000;
// Fees are split between the Council (revenue) and the treasury in basis points of 10,000. The accepted decision is 25% to the
// Council and 75% to the treasury, so 2,500 is the starting share, and the owner can move it between the two bounds. The
// treasury always gets the rest, so the whole of every fee is accounted for whatever the owner sets.
const BPS_DENOMINATOR: u128 = 10_000;
const DEFAULT_REVENUE_SHARE_BPS: u128 = 2_500;
const MIN_REVENUE_SHARE_BPS: u128 = 1_000;
const MAX_REVENUE_SHARE_BPS: u128 = 5_000;
// A sweep with less than this to act on does nothing, so the record count stays bounded by the fees collected. 1 unit of the
// 6-decimal collateral to start, with a ceiling of 100.
const DEFAULT_MIN_SWEEP: u128 = 1_000_000;
const MAX_MIN_SWEEP: u128 = 100_000_000;
const FIRST_SWEEP_ID: u64 = 1;
// How long after a sweep its result can be asked for (settle_leg) or overridden by the owner (reconcile_leg). The first lets
// the Council's receipt finish whatever it is doing, the second leaves a callback an hour to arrive before a person decides.
const NS_PER_MINUTE: u64 = 60 * 1_000_000_000;
const SETTLE_WAIT_MINUTES: u64 = 10;
const RECONCILE_WAIT_MINUTES: u64 = 60;
// The verifier burned 3.8 TGas for a payout from a contract in the sandbox (INTENTS-PROOF.md), so this is a wide margin.
const GAS_MT_TRANSFER: Gas = Gas::from_tgas(15);
// mt_transfer_call needs 21 TGas attached before the receiver gets any (measured), so the verifier's own part is rounded up
// to 22 and the rest is what the Council's mt_on_transfer gets.
const GAS_VERIFIER_CALL_OVERHEAD: Gas = Gas::from_tgas(22);
const GAS_COUNCIL_RECEIPT: Gas = Gas::from_tgas(20);
const GAS_MT_TRANSFER_CALL: Gas = Gas::from_gas(GAS_VERIFIER_CALL_OVERHEAD.as_gas() + GAS_COUNCIL_RECEIPT.as_gas());
const GAS_REGISTER: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
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
// The layout of the state below. migrate reads exactly this one and refuses any other. Version 2 holds the sweep ledger and
// the optional fee recipients.
const STATE_VERSION: u16 = 2;

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Markets,
    Balances,
    Accounts,
    Shares,
    Sweeps,
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

// A running time-weighted price, kept separately from the chart's price log. The log keeps the newest 120 points by
// number of trades, so enough tiny trades push every earlier point out of it. This is indexed by time instead: `acc`
// is the sum of price times how long it held and `weight` the sum of how long, both up to `at`, and `anchor` is
// (acc, weight) where the averaging window opens. However many trades there are, each price counts only for how long
// it was in force. Time while the market is halted counts for nothing, in both sums, so a halt cannot leave the last
// price holding the average.
#[near(serializers=[borsh])]
#[derive(Clone)]
pub struct Twap {
    acc: u128,
    weight: u128,
    at: u64,
    price: u128,
    anchor: Option<(u128, u128)>,
}

impl Twap {
    // Counts the price in force up to `now`, never past close_at, and fixes the window's start the first time it is
    // passed. Time that passes while the market is not trading moves `at` and counts for nothing.
    fn advance(&mut self, close_at: u64, now: u64, trading: bool) {
        let to = now.min(close_at);
        if to <= self.at {
            return;
        }
        let held = |from: u64, until: u64| if trading { (until - from) as u128 } else { 0 };
        let window_start = close_at.saturating_sub(VOID_PRICE_WINDOW_NS);
        if self.anchor.is_none() && to >= window_start {
            let at = window_start.max(self.at);
            self.anchor = Some((
                self.acc + self.price * held(self.at, at),
                self.weight + held(self.at, at),
            ));
        }
        self.acc += self.price * held(self.at, to);
        self.weight += held(self.at, to);
        self.at = to;
    }
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
    halted: bool,
    registered: bool,
    seeded: bool,
    outcome: Option<Outcome>,
    // Set when the outcome becomes Void: the Yes price in millionths that a Void pays a Yes share. A No share pays the rest.
    void_price_yes: Option<u128>,
    pool_yes: u128,
    pool_no: u128,
    locked: u128,
    user_yes: u128,
    user_no: u128,
    residual_claimed: bool,
    // (block time in ns, Yes price in millionths) after each seed, buy and sell. For the chart only.
    history: Vec<(u64, u32)>,
    // What a Void pays is averaged from this, not from the log: see Twap.
    twap: Option<Twap>,
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
    // resolved, halted, closed, then while trading has not opened unregistered (the oracle has not confirmed the market) or
    // unseeded (it has no liquidity), and open once it can be traded.
    status: String,
    registered: bool,
    seeded: bool,
    outcome: Option<Outcome>,
    void_price_yes: Option<U128>,
    price_yes: U128,
    price_no: U128,
    locked: U128,
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

// What the Council recorded for a sweep id is the evidence settle_leg uses for a transfer whose result was lost.
#[ext_contract(ext_council)]
pub trait Council {
    fn received_of(&self, sweep_id: U64);
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
    // routine (create a market, seed it, pause, halt, claim a residual) also takes the operator, so day to
    // day running does not need to wait on a DAO proposal.
    owner: AccountId,
    // Set by propose_owner. Ownership moves only when this account calls accept_owner.
    pending_owner: Option<AccountId>,
    operator: AccountId,
    oracle: AccountId,
    // The Intents verifier that holds every unit of backing, and the exact id of the collateral in it, "nep141:<token>".
    verifier: AccountId,
    collateral_token_id: String,
    paused: bool,
    // What a trade and a new market pay now. Each applies from the next trade or seed; nothing already paid changes.
    fee_rate_bps: u128,
    create_fee: u128,
    next_market_id: u64,
    markets: LookupMap<u64, Market>,
    balances: LookupMap<AccountId, u128>,
    // The sum of every entry in balances, kept so total_owed can add it up without walking a map.
    balances_total: u128,
    // account -> number of share entries it holds. Presence means the account paid its storage deposit.
    accounts: LookupMap<AccountId, u32>,
    // (market, account, 0 = yes / 1 = no) -> shares
    shares: LookupMap<(u64, AccountId, u8), u128>,
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
    sweeps: LookupMap<u64, Sweep>,
}

// A Yes price of one half, in millionths. What a market with no price points before close falls back to.
const HALF: u128 = 500_000;

// The pools that open a market holding `amount` of collateral at a Yes price of `yes_price` millionths, or at one half
// when none is given. Collateral must equal the shares outstanding of each outcome, so a pool smaller than `amount` is
// made up by the seeder holding the difference: at 30% Yes the Yes pool is the whole `amount`, the No pool is smaller,
// and the seeder holds the No shares the pool does not. This is how a liquidity provider sets the odds in any
// constant-product market, and the seeder is then a trader like any other with those shares.
fn opening_pools(amount: u128, yes_price: Option<u128>) -> (u128, u128) {
    match yes_price {
        None => (amount, amount),
        Some(p) if p <= HALF => (amount, amount * p / (1_000_000 - p)),
        Some(p) => (amount * (1_000_000 - p) / p, amount),
    }
}

// What a holder redeems from a Void: Yes shares at `price_yes`, No shares at the rest. A pair always pays one unit.
fn void_payout(yes: u128, no: u128, price_yes: u128) -> u128 {
    (yes * price_yes + no * (1_000_000 - price_yes)) / 1_000_000
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
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: false,
            upgrade_in_flight: false,
            owner: owner_id,
            pending_owner: None,
            operator: operator_id,
            oracle: oracle_id,
            verifier: verifier_id,
            collateral_token_id,
            paused: false,
            fee_rate_bps: DEFAULT_FEE_RATE_BPS,
            create_fee: DEFAULT_CREATE_FEE,
            next_market_id: 0,
            markets: LookupMap::new(Key::Markets),
            balances: LookupMap::new(Key::Balances),
            balances_total: 0,
            accounts: LookupMap::new(Key::Accounts),
            shares: LookupMap::new(Key::Shares),
            recipients: None,
            revenue_share_bps: DEFAULT_REVENUE_SHARE_BPS,
            fees: 0,
            revenue_due: 0,
            treasury_due: 0,
            revenue_unresolved: 0,
            locked_total: 0,
            min_sweep: DEFAULT_MIN_SWEEP,
            next_sweep_id: FIRST_SWEEP_ID,
            sweeps: LookupMap::new(Key::Sweeps),
        }
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
    // pause, so the exit is open whatever the code does next. The deploy and migrate are one batch: a migrate that panics
    // puts the old code back. Attach at least 100 TGas.
    pub fn upgrade(&mut self, code_hash: Base58CryptoHash) -> Promise {
        upgrade::require_upgrade_gas();
        self.only_owner();
        let code = upgrade::take_staged(code_hash);
        self.upgrade_in_flight = true;
        emit("upgrade_sent", json!({ "code_hash": code_hash }));
        upgrade::deploy_and_migrate(code)
    }

    // Runs in the new code, in the same batch as the deploy. It reads the one layout it was written for. A later version
    // keeps a copy of this struct as StateV1, reads that, builds its own state from it and bumps state_version.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        upgrade::require_state_version(STATE_VERSION);
        let mut state: Self = env::state_read().unwrap_or_else(|| env::panic_str("there is no state to migrate"));
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
        self.owner = who;
        self.pending_owner = None;
    }

    // The fast key for routine operations. Only the owner can change it.
    pub fn set_operator(&mut self, operator_id: AccountId) {
        self.only_owner();
        emit("operator_set", json!({ "operator": operator_id }));
        self.operator = operator_id;
    }

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
        self.markets.insert(
            id,
            Market {
                title,
                rule_text,
                resolution_source,
                void_policy,
                category,
                subcategory,
                rule_hash: rule_hash.clone(),
                price_rule,
                close_at: close_at.0,
                resolve_by: resolve_by.0,
                halted: false,
                registered: false,
                seeded: false,
                outcome: None,
                void_price_yes: None,
                pool_yes: 0,
                pool_no: 0,
                locked: 0,
                user_yes: 0,
                user_no: 0,
                residual_claimed: false,
                history: vec![],
                twap: None,
            },
        );
        emit(
            "market_created",
            json!({ "market_id": id.to_string(), "rule_hash": rule_hash }),
        );
        self.register_with_oracle(id);
        U64(id)
    }

    // The oracle call can fail, so trading stays closed until the callback confirms it.
    pub fn retry_register(&mut self, market_id: U64) {
        self.only_operator_or_owner();
        let m = self.market(market_id.0);
        require!(!m.registered, "already registered");
        self.register_with_oracle(market_id.0);
    }

    #[private]
    pub fn on_registered(&mut self, market_id: U64, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_ok() {
            let mut m = self.market(market_id.0);
            m.registered = true;
            self.markets.insert(market_id.0, m);
            emit("market_registered", json!({ "market_id": market_id.0.to_string() }));
        }
    }

    // In the last day before close the operator cannot halt, only the owner can: a halt held to close takes that time out
    // of the average a Void pays.
    pub fn halt(&mut self, market_id: U64, reason: String) {
        self.only_operator_or_owner();
        let mut m = self.market(market_id.0);
        require!(m.outcome.is_none(), "already resolved");
        require!(
            env::predecessor_account_id() == self.owner
                || env::block_timestamp().saturating_add(VOID_PRICE_WINDOW_NS) < m.close_at,
            "a halt in the last day before close is an owner action"
        );
        m.advance_twap(env::block_timestamp());
        m.halted = true;
        self.markets.insert(market_id.0, m);
        emit(
            "market_halted",
            json!({ "market_id": market_id.0.to_string(), "reason": reason }),
        );
    }

    pub fn resume(&mut self, market_id: U64) {
        self.only_operator_or_owner();
        let mut m = self.market(market_id.0);
        require!(m.outcome.is_none(), "already resolved");
        m.advance_twap(env::block_timestamp());
        m.halted = false;
        self.markets.insert(market_id.0, m);
        emit("market_resumed", json!({ "market_id": market_id.0.to_string() }));
    }

    // Stops new trades and deposits. Withdrawals and redemptions keep working.
    pub fn set_paused(&mut self, paused: bool) {
        self.only_operator_or_owner();
        self.paused = paused;
        emit("paused", json!({ "paused": paused }));
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
        require!(
            (MIN_REVENUE_SHARE_BPS..=MAX_REVENUE_SHARE_BPS).contains(&share),
            format!(
                "the Council share must be between {MIN_REVENUE_SHARE_BPS} and {MAX_REVENUE_SHARE_BPS} basis points"
            )
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
            (1..=MAX_MIN_SWEEP).contains(&min_sweep.0),
            format!("the sweep minimum must be between 1 and {MAX_MIN_SWEEP}")
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
            fee_rate_bps as u128 <= MAX_FEE_RATE_BPS,
            "the fee rate is capped at 500 basis points"
        );
        emit("fee_rate_set", json!({ "fee_rate_bps": fee_rate_bps }));
        self.fee_rate_bps = fee_rate_bps as u128;
    }

    pub fn set_create_fee(&mut self, create_fee: U128) {
        self.only_owner();
        require!(create_fee.0 <= MAX_CREATE_FEE, "the creation fee is capped at 10 units");
        emit("create_fee_set", json!({ "create_fee": create_fee }));
        self.create_fee = create_fee.0;
    }

    // After resolution the pool's leftover collateral is due to the treasury, not the owner: the owner is the DAO, which has
    // no easy way to spend a balance held here. The next sweep pays it on the treasury leg, whole and not split with the
    // Council. Users' payouts stay reserved.
    pub fn claim_residual(&mut self, market_id: U64) {
        self.only_operator_or_owner();
        let mut m = self.market(market_id.0);
        let outcome = m.outcome.unwrap_or_else(|| env::panic_str("not resolved"));
        require!(!m.residual_claimed, "already claimed");
        let owed = Self::owed(&m, outcome);
        let residual = m
            .locked
            .checked_sub(owed)
            .unwrap_or_else(|| env::panic_str("invariant broken"));
        m.locked = owed;
        m.residual_claimed = true;
        self.markets.insert(market_id.0, m);
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
                self.markets.insert(market_id.0, m);
                emit(
                    "outcome_set",
                    json!({ "market_id": market_id.0.to_string(), "outcome": outcome }),
                );
            }
        }
    }

    // The way out if the oracle is gone, so money is never stuck. Once resolve_by has passed the oracle's
    // resolve_by_deadline answers the market, settling whatever can be settled and voiding the rest. This is only open
    // a grace period after that, and then anyone can void the market and every holder redeems at its closing price
    // (see Market::resolve).
    pub fn void_if_unresolved(&mut self, market_id: U64) {
        let mut m = self.market(market_id.0);
        require!(m.outcome.is_none(), "already resolved");
        require!(
            env::block_timestamp() >= m.resolve_by.saturating_add(VOID_GRACE_NS),
            "the answer deadline and the 7 day grace period have not passed"
        );
        m.resolve(Outcome::Void);
        self.markets.insert(market_id.0, m);
        emit(
            "outcome_set",
            json!({ "market_id": market_id.0.to_string(), "outcome": Outcome::Void, "by": "deadline" }),
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
                require!(!self.paused, "paused");
                require!(self.accounts.contains_key(&sender_id), "do the storage deposit first");
                self.credit(&sender_id, amount.0);
                emit(
                    "deposit",
                    json!({ "account": sender_id, "amount": amount.0.to_string() }),
                );
            }
            // "seed:<market>" opens at one half. "seed:<market>:<Yes price in millionths>" opens at that price.
            Some("seed") => {
                require!(
                    sender_id == self.owner || sender_id == self.operator,
                    "operator or owner only"
                );
                let id: u64 = parts
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| env::panic_str("bad market id"));
                let yes_price = parts.next().map(|p| {
                    p.parse::<u128>()
                        .unwrap_or_else(|_| env::panic_str("bad starting price"))
                });
                self.seed(&sender_id, id, amount.0, yes_price);
            }
            Some("buy") => {
                let id: u64 = parts
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| env::panic_str("bad market id"));
                let side = side_index(parts.next().unwrap_or(""));
                let min_out: u128 = parts
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| env::panic_str("bad min shares"));
                self.buy_with(&sender_id, id, side, amount.0, min_out);
            }
            _ => env::panic_str("unknown action"),
        }
        vec![U128(0)]
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

    // Takes collateral_out out of the pool. The fee is kept and the rest is credited to the seller. Needs exactly 1 yocto.
    #[payable]
    pub fn sell(&mut self, market_id: U64, side: String, collateral_out: U128, max_shares_in: U128) {
        assert_one_yocto();
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        require!(self.accounts.contains_key(&who), "do the storage deposit first");
        let idx = side_index(&side);
        let mut m = self.open_market(market_id.0);
        let (target, other) = if idx == 0 {
            (m.pool_yes, m.pool_no)
        } else {
            (m.pool_no, m.pool_yes)
        };
        let (fee, shares_in, new_target, new_other) =
            curve::sell_after_fee(target, other, collateral_out.0, self.fee_rate_bps)
                .unwrap_or_else(|| env::panic_str("cannot sell that amount"));
        require!(
            shares_in <= max_shares_in.0,
            "price moved, would need more shares than your maximum"
        );

        self.take_shares(&who, market_id.0, idx, shares_in);
        if idx == 0 {
            m.pool_yes = new_target;
            m.pool_no = new_other;
            m.user_yes -= shares_in;
        } else {
            m.pool_no = new_target;
            m.pool_yes = new_other;
            m.user_no -= shares_in;
        }
        m.locked -= collateral_out.0;
        self.locked_total -= collateral_out.0;
        m.record_price();
        self.markets.insert(market_id.0, m);
        self.fees += fee;
        self.credit(&who, collateral_out.0 - fee);
        emit(
            "sell",
            json!({ "market_id": market_id.0.to_string(), "account": who, "side": side,
                    "shares": shares_in.to_string(), "collateral": collateral_out.0.to_string(), "fee": fee.to_string() }),
        );
    }

    // Pays out after resolution. No deadline.
    pub fn redeem(&mut self, market_id: U64) -> U128 {
        let who = env::predecessor_account_id();
        let mut m = self.market(market_id.0);
        let outcome = m.outcome.unwrap_or_else(|| env::panic_str("not resolved yet"));
        let yes = self.shares.get(&(market_id.0, who.clone(), 0)).copied().unwrap_or(0);
        let no = self.shares.get(&(market_id.0, who.clone(), 1)).copied().unwrap_or(0);
        require!(yes + no > 0, "nothing to redeem");
        let payout = match outcome {
            Outcome::Yes => yes,
            Outcome::No => no,
            Outcome::Void => void_payout(yes, no, m.void_price()),
        };
        if yes > 0 {
            self.take_shares(&who, market_id.0, 0, yes);
        }
        if no > 0 {
            self.take_shares(&who, market_id.0, 1, no);
        }
        m.user_yes -= yes;
        m.user_no -= no;
        m.locked -= payout;
        self.locked_total -= payout;
        self.markets.insert(market_id.0, m);
        self.credit(&who, payout);
        emit(
            "redeemed",
            json!({ "market_id": market_id.0.to_string(), "account": who, "amount": payout.to_string() }),
        );
        U128(payout)
    }

    // ---- money out ------------------------------------------------------------------------

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        require!(amount.0 > 0, "amount must be positive");
        // Take the balance first; give it back in the callback if the transfer fails.
        self.debit(&who, amount.0);
        emit("withdraw", json!({ "account": who, "amount": amount.0.to_string() }));
        // The payout goes to the caller's own Intents account, inside the verifier. mt_transfer returns nothing, so an
        // error here means the verifier's receipt failed (paused, locked, out of gas) and nothing moved.
        ext_verifier::ext(self.verifier.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_MT_TRANSFER)
            .mt_transfer(who.clone(), self.collateral_token_id.clone(), amount, None, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw(who, amount),
            )
    }

    #[private]
    pub fn on_withdraw(
        &mut self,
        account: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            self.credit(&account, amount.0);
            emit(
                "withdraw_failed",
                json!({ "account": account, "amount": amount.0.to_string() }),
            );
        }
    }

    // ---- fees -----------------------------------------------------------------------------

    // Anyone may call it. Splits the collected fees between the Council and the treasury by the owner's share, rounding both
    // parts down so the remainder (0 or 1 unit) stays collected, adds what earlier refused legs left due, records both legs
    // under a new sweep id, and only then sends them. A sweep with less than min_sweep to act on does nothing and takes no id.
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
        let id = self.next_sweep_id;
        self.next_sweep_id += 1;
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
            at: U64(env::block_timestamp()),
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
        self.sweeps.insert(id, sweep.clone());
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
            env::block_timestamp() >= sweep.at.0.saturating_add(SETTLE_WAIT_MINUTES * NS_PER_MINUTE),
            format!("wait {SETTLE_WAIT_MINUTES} minutes after the sweep before settling")
        );
        ext_council::ext(sweep.council.to)
            .with_static_gas(GAS_COUNCIL_VIEW)
            .received_of(sweep_id)
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
        let (status, amount) = (sweep.leg(leg).status, sweep.leg(leg).amount.0);
        require!(
            matches!(status, LegStatus::Pending | LegStatus::Unresolved),
            "the leg is neither pending nor unresolved"
        );
        require!(
            env::block_timestamp() >= sweep.at.0.saturating_add(RECONCILE_WAIT_MINUTES * NS_PER_MINUTE),
            format!("wait {RECONCILE_WAIT_MINUTES} minutes after the sweep before reconciling")
        );
        if status == LegStatus::Unresolved {
            self.revenue_unresolved -= amount;
        }
        self.end_leg(sweep_id.0, leg, if arrived { amount } else { 0 });
        emit(
            "fee_leg_reconciled",
            json!({ "id": sweep_id.0.to_string(), "leg": leg, "amount": amount.to_string(), "arrived": arrived }),
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
                "paused": self.paused, "markets": self.next_market_id.to_string(), "storage_deposit": STORAGE_DEPOSIT.as_yoctonear().to_string(),
                "max_positions": MAX_POSITIONS, "fee_rate_bps": self.fee_rate_bps as u32, "create_fee": self.create_fee.to_string(),
                "revenue_pool": self.recipients.as_ref().map(|r| &r.revenue_pool), "treasury": self.recipients.as_ref().map(|r| &r.treasury),
                "revenue_share_bps": self.revenue_share_bps as u32, "treasury_share_bps": (BPS_DENOMINATOR - self.revenue_share_bps) as u32,
                "min_sweep": self.min_sweep.to_string(), "next_sweep_id": self.next_sweep_id.to_string(),
                "revenue_unresolved": self.revenue_unresolved.to_string() })
    }

    pub fn get_fees(&self) -> near_sdk::serde_json::Value {
        json!({ "collected": self.fees.to_string(), "revenue_due": self.revenue_due.to_string(),
                "treasury_due": self.treasury_due.to_string(), "revenue_unresolved": self.revenue_unresolved.to_string() })
    }

    pub fn get_sweep(&self, sweep_id: U64) -> Option<Sweep> {
        self.sweeps.get(&sweep_id.0).cloned()
    }

    // Sweeps by id from `from_index`, oldest first, at most 50 a call. An id that was skipped with set_next_sweep_id is absent.
    pub fn list_sweeps(&self, from_index: U64, limit: U64) -> Vec<Sweep> {
        let end = self.next_sweep_id.min(from_index.0.saturating_add(limit.0.min(50)));
        (from_index.0..end)
            .filter_map(|id| self.sweeps.get(&id).cloned())
            .collect()
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.accounts.contains_key(&account_id)
    }

    // Everything this contract owes, in collateral units: user balances, what is locked in every market, and every fee
    // bucket. The keeper compares it with the verifier's mt_balance_of for this account at the same finalized block. More
    // there than here is surplus nobody is credited for. Less is an incident. A leg that is pending is out of the books
    // because its money is already on its way, so an unfinished transfer shows as surplus here and never as a shortfall.
    pub fn total_owed(&self) -> U128 {
        U128(
            self.balances_total
                + self.locked_total
                + self.fees
                + self.revenue_due
                + self.treasury_due
                + self.revenue_unresolved,
        )
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

    pub fn get_market(&self, market_id: U64) -> Option<MarketView> {
        self.markets.get(&market_id.0).map(|m| self.view(market_id.0, m))
    }

    pub fn list_markets(&self, from_index: U64, limit: U64) -> Vec<MarketView> {
        let end = self.next_market_id.min(from_index.0.saturating_add(limit.0.min(50)));
        (from_index.0..end)
            .filter_map(|id| self.markets.get(&id).map(|m| self.view(id, m)))
            .collect()
    }

    // Yes price after each trade, oldest first. The website draws its chart from this.
    pub fn get_history(&self, market_id: U64) -> Vec<PricePoint> {
        self.markets
            .get(&market_id.0)
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
        let Some(m) = self.markets.get(&market_id.0) else {
            return none;
        };
        let (target, other) = if side_index(&side) == 0 {
            (m.pool_yes, m.pool_no)
        } else {
            (m.pool_no, m.pool_yes)
        };
        match curve::buy_after_fee(target, other, amount.0, self.fee_rate_bps) {
            Some((fee, out, _, _)) => BuyQuote {
                shares_out: U128(out),
                fee: U128(fee),
            },
            None => none,
        }
    }

    // The most collateral selling `shares` can take out, the shares it would really take, and the fee kept from it.
    pub fn quote_sell(&self, market_id: U64, side: String, shares: U128) -> SellQuote {
        let none = SellQuote {
            collateral_out: U128(0),
            shares_in: U128(0),
            fee: U128(0),
        };
        let Some(m) = self.markets.get(&market_id.0) else {
            return none;
        };
        let (target, other) = if side_index(&side) == 0 {
            (m.pool_yes, m.pool_no)
        } else {
            (m.pool_no, m.pool_yes)
        };
        let c = curve::max_collateral_for_shares(target, other, shares.0);
        match curve::sell_after_fee(target, other, c, self.fee_rate_bps) {
            Some((fee, needed, _, _)) => SellQuote {
                collateral_out: U128(c),
                shares_in: U128(needed),
                fee: U128(fee),
            },
            None => none,
        }
    }

    // Collateral locked must equal shares outstanding on both sides while trading, and must cover
    // every payout still owed after resolution.
    pub fn check_invariant(&self, market_id: U64) -> bool {
        let Some(m) = self.markets.get(&market_id.0) else {
            return false;
        };
        match m.outcome {
            None => m.locked == m.pool_yes + m.user_yes && m.locked == m.pool_no + m.user_no,
            Some(o) => m.locked >= Self::owed(m, o),
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
            emit("registered", json!({ "account": who, "paid_by": payer }));
            paid.saturating_sub(STORAGE_DEPOSIT)
        };
        if !refund.is_zero() {
            let _ = Promise::new(payer).transfer(refund);
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

    // Closes an account that holds no positions and no balance and sends it the deposit back, with the yocto it attached.
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
        self.accounts.remove(&who);
        self.balances.remove(&who);
        emit("unregistered", json!({ "account": who }));
        let _ = Promise::new(who).transfer(STORAGE_DEPOSIT.saturating_add(ONE_YOCTO));
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

// ---- private helpers ----------------------------------------------------------------------

impl Market {
    // Fixes the outcome. A Void also fixes its price now, from the log, because the log can no longer change:
    // nothing trades after close.
    fn resolve(&mut self, outcome: Outcome) {
        self.outcome = Some(outcome);
        if outcome == Outcome::Void {
            self.void_price_yes = Some(self.closing_price());
        }
    }

    fn void_price(&self) -> u128 {
        self.void_price_yes
            .unwrap_or_else(|| env::panic_str("a voided market has no closing price"))
    }

    // The Yes price a Void pays: its time-weighted average over the trading time in the last VOID_PRICE_WINDOW_NS before
    // close_at, or since the market opened if that was later. Nothing trades after close, so the price in force at close
    // holds to the end. A market with no trading time in the window pays the average over all its trading time, so a halt
    // that covers the whole window cannot leave the last traded price to set it. Only a market that never traded at all
    // falls back to its last price.
    fn closing_price(&self) -> u128 {
        let Some(mut twap) = self.twap.clone() else { return HALF };
        twap.advance(self.close_at, self.close_at, !self.halted);
        match twap.anchor {
            Some((acc_from, weight_from)) if twap.weight > weight_from => {
                (twap.acc - acc_from) / (twap.weight - weight_from)
            }
            _ if twap.weight > 0 => twap.acc / twap.weight,
            _ => twap.price,
        }
    }

    // Brings the average up to `now` under the market's present state. Halting and resuming call this before they flip
    // the flag, so the time before the flip is counted as it was.
    fn advance_twap(&mut self, now: u64) {
        let trading = !self.halted;
        if let Some(twap) = &mut self.twap {
            twap.advance(self.close_at, now, trading);
        }
    }

    fn record_price(&mut self) {
        self.record_price_at(env::block_timestamp(), curve::price_micro(self.pool_yes, self.pool_no));
    }

    fn record_price_at(&mut self, now: u64, price: u128) {
        self.history.push((now, price as u32));
        if self.history.len() > HISTORY_MAX {
            self.history.remove(0);
        }
        self.advance_twap(now);
        match &mut self.twap {
            Some(twap) => twap.price = price,
            // A market first priced at or after its close has no time before close to average.
            None if now < self.close_at => {
                self.twap = Some(Twap {
                    acc: 0,
                    weight: 0,
                    at: now,
                    price,
                    anchor: None,
                })
            }
            None => {}
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

    fn market(&self, id: u64) -> Market {
        self.markets
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such market"))
    }

    fn open_market(&self, id: u64) -> Market {
        let m = self.market(id);
        require!(m.registered, "market is not registered with the oracle yet");
        require!(m.seeded, "market has no liquidity yet");
        require!(!m.halted, "market is halted");
        require!(m.outcome.is_none(), "market is resolved");
        require!(env::block_timestamp() < m.close_at, "market is closed");
        m
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
        self.sweeps
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no sweep to settle"))
    }

    fn leg_is(&self, id: u64, kind: LegKind, status: LegStatus) -> bool {
        self.sweeps.get(&id).is_some_and(|s| s.leg(kind).status == status)
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
        match kind {
            LegKind::Council => self.revenue_due += back,
            LegKind::Treasury => self.treasury_due += back,
        }
        self.sweeps.insert(id, sweep);
        if back == 0 {
            emit(
                "fee_leg_settled",
                json!({ "id": id.to_string(), "leg": kind, "amount": amount.to_string() }),
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
            json!({ "id": id.to_string(), "to": sweep.council.to, "amount": sweep.council.amount }),
        );
        self.sweeps.insert(id, sweep);
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

    fn owed(m: &Market, outcome: Outcome) -> u128 {
        match outcome {
            Outcome::Yes => m.user_yes,
            Outcome::No => m.user_no,
            Outcome::Void => void_payout(m.user_yes, m.user_no, m.void_price()),
        }
    }

    // The creation fee comes out of the seed transfer, the one payment every market makes before it can trade. A market
    // that opens away from one half leaves the seeder holding the shares its pools do not: see opening_pools.
    fn seed(&mut self, seeder: &AccountId, id: u64, amount: u128, yes_price: Option<u128>) {
        require!(!self.paused, "paused");
        let mut m = self.market(id);
        require!(m.registered, "market is not registered with the oracle yet");
        require!(!m.seeded, "already seeded");
        require!(env::block_timestamp() < m.close_at, "market is closed");
        require!(amount > self.create_fee, "the seed must be more than the creation fee");
        let amount = amount - self.create_fee;
        require!(amount <= MAX_POOL, "seed too large");
        if let Some(p) = yes_price {
            require!(
                (MIN_OPEN_PRICE..=MAX_OPEN_PRICE).contains(&p),
                "the starting price must be between 1% and 99%"
            );
        }
        let (pool_yes, pool_no) = opening_pools(amount, yes_price);
        require!(
            pool_yes > 0 && pool_no > 0,
            "the seed is too small to open at that price"
        );
        m.pool_yes = pool_yes;
        m.pool_no = pool_no;
        m.locked = amount;
        self.locked_total += amount;
        m.seeded = true;
        if pool_yes < amount || pool_no < amount {
            require!(self.accounts.contains_key(seeder), "do the storage deposit first");
        }
        if pool_yes < amount {
            self.add_shares(seeder, id, 0, amount - pool_yes);
            m.user_yes += amount - pool_yes;
        }
        if pool_no < amount {
            self.add_shares(seeder, id, 1, amount - pool_no);
            m.user_no += amount - pool_no;
        }
        m.record_price();
        self.markets.insert(id, m);
        self.fees += self.create_fee;
        emit(
            "market_seeded",
            json!({ "market_id": id.to_string(), "amount": amount.to_string(), "fee": self.create_fee.to_string(),
                    "yes_price": curve::price_micro(pool_yes, pool_no).to_string(), "seeder": seeder }),
        );
    }

    // Spend `amount` that has already left the buyer's balance (or arrived by mt_transfer_call). The fee comes out
    // of it first and only the rest enters the market.
    fn buy_with(&mut self, who: &AccountId, id: u64, idx: u8, amount: u128, min_out: u128) {
        require!(!self.paused, "paused");
        require!(self.accounts.contains_key(who), "do the storage deposit first");
        require!(min_out > 0, "min shares must be above zero");
        let mut m = self.open_market(id);
        let (target, other) = if idx == 0 {
            (m.pool_yes, m.pool_no)
        } else {
            (m.pool_no, m.pool_yes)
        };
        let (fee, out, new_target, new_other) = curve::buy_after_fee(target, other, amount, self.fee_rate_bps)
            .unwrap_or_else(|| env::panic_str("cannot buy that amount"));
        require!(
            out >= min_out,
            "price moved, you would get fewer shares than your minimum"
        );

        self.add_shares(who, id, idx, out);
        if idx == 0 {
            m.pool_yes = new_target;
            m.pool_no = new_other;
            m.user_yes += out;
        } else {
            m.pool_no = new_target;
            m.pool_yes = new_other;
            m.user_no += out;
        }
        m.locked += amount - fee;
        self.locked_total += amount - fee;
        m.record_price();
        self.markets.insert(id, m);
        self.fees += fee;
        emit(
            "buy",
            json!({ "market_id": id.to_string(), "account": who, "side": if idx == 0 { "yes" } else { "no" },
                    "shares": out.to_string(), "collateral": amount.to_string(), "fee": fee.to_string() }),
        );
    }

    fn add_shares(&mut self, who: &AccountId, id: u64, idx: u8, amount: u128) {
        let key = (id, who.clone(), idx);
        let have = self.shares.get(&key).copied().unwrap_or(0);
        if have == 0 {
            let n = self.accounts.get(who).copied().unwrap_or(0);
            // Seeding away from one half leaves the seeder holding shares, one position for each such market, so the
            // operator and the owner, who seed them all, are not held to the cap.
            require!(
                n < MAX_POSITIONS || self.is_operator_or_owner(who),
                "too many positions, redeem or sell one first"
            );
            self.accounts.insert(who.clone(), n + 1);
        }
        self.shares.insert(key, have + amount);
    }

    fn take_shares(&mut self, who: &AccountId, id: u64, idx: u8, amount: u128) {
        let key = (id, who.clone(), idx);
        let have = self.shares.get(&key).copied().unwrap_or(0);
        let left = have
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("not enough shares"));
        if left == 0 {
            self.shares.remove(&key);
            let n = self.accounts.get(who).copied().unwrap_or(1);
            self.accounts.insert(who.clone(), n.saturating_sub(1));
        } else {
            self.shares.insert(key, left);
        }
    }

    fn view(&self, id: u64, m: &Market) -> MarketView {
        let status = if m.outcome.is_some() {
            "resolved"
        } else if m.halted {
            "halted"
        } else if env::block_timestamp() >= m.close_at {
            "closed"
        } else if !m.registered {
            "unregistered"
        } else if !m.seeded {
            "unseeded"
        } else {
            "open"
        };
        let price_yes = curve::price_micro(m.pool_yes, m.pool_no);
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
            status: status.to_string(),
            registered: m.registered,
            seeded: m.seeded,
            outcome: m.outcome,
            void_price_yes: m.void_price_yes.map(U128),
            price_yes: U128(price_yes),
            price_no: U128(1_000_000 - price_yes),
            locked: U128(m.locked),
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
            halted: false,
            registered: true,
            seeded: true,
            outcome: None,
            void_price_yes: None,
            pool_yes: 100,
            pool_no: 100,
            locked: 100,
            user_yes: 0,
            user_no: 0,
            residual_claimed: false,
            history: vec![],
            twap: None,
        }
    }

    #[test]
    fn price_log_records_the_current_price_and_never_grows_past_the_cap() {
        let mut m = blank();
        for i in 0..(HISTORY_MAX + 30) as u128 {
            m.pool_yes = 100 + i;
            m.record_price();
        }
        assert_eq!(m.history.len(), HISTORY_MAX);
        // Newest point is the price for the latest pools, the oldest 30 were dropped.
        let last = m.history.last().unwrap().1 as u128;
        assert_eq!(last, curve::price_micro(m.pool_yes, m.pool_no));
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

    // Two markets, both seeded, three registered users, and the fee recipients set. Returns the contract and the total tokens
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
        }
        // Skip the oracle round trip: mark both as registered.
        for id in 0..2 {
            let mut m = c.market(id);
            m.registered = true;
            c.markets.insert(id, m);
        }
        // The owner is registered because the second market opens at 30%, which leaves the seeder holding shares.
        for u in USERS.iter().chain([&OWNER]) {
            c.accounts.insert(acct(u), 0);
        }
        act_as(VERIFIER, 2);
        let _ = receive(&mut c, acct(OWNER), U128(SEED_UNITS), "seed:0".to_string());
        let _ = receive(&mut c, acct(OWNER), U128(SEED_UNITS), "seed:1:300000".to_string());
        (c, 2 * SEED_UNITS)
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
            locked + balances + c.fees + c.revenue_due + c.treasury_due + c.revenue_unresolved,
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
                if q.collateral_out.0 > 0 {
                    act_as(who, 3);
                    c.sell(U64(id), side.to_string(), q.collateral_out, U128(held));
                }
            }
            // deposit, then buy out of the balance
            _ => {
                act_as(VERIFIER, 3);
                let _ = receive(c, acct(who), U128(amount), "deposit".to_string());
                *total_in += amount;
                act_as(who, 3);
                c.buy(U64(id), "yes".to_string(), U128(amount / 2 + 1), U128(1));
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        // Whatever the sequence, collateral matches shares, no money appears or vanishes, and once every market is
        // resolved and everyone has redeemed, nothing is left locked.
        #[test]
        fn random_trading_never_breaks_the_books(
            ops in proptest::collection::vec((0u8..5, 0usize..3, 0u64..2, 1_000_000u128..40_000_000, 1u128..101), 1..60),
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
            // The owner may take the pool's leftover before or after the holders redeem. Both orders must pay everyone.
            if claim_first {
                act_as(OWNER, CLOSE + 2);
                for id in 0..2u64 {
                    c.claim_residual(U64(id));
                }
                assert_conserved(&c, total_in);
            }
            // The owner seeded the second market away from one half, so it holds shares there like any other holder.
            for id in 0..2u64 {
                for u in USERS.iter().chain([&OWNER]) {
                    let (y, n) = holdings(&c, id, u);
                    if y + n > 0 {
                        act_as(u, CLOSE + 3);
                        c.redeem(U64(id));
                    }
                    assert_conserved(&c, total_in);
                }
            }
            if !claim_first {
                act_as(OWNER, CLOSE + 4);
                for id in 0..2u64 {
                    c.claim_residual(U64(id));
                }
            }
            for id in 0..2u64 {
                let left = c.market(id).locked;
                if claim_first && c.market(id).outcome == Some(Outcome::Void) {
                    // Half units are rounded down per holder, so a few units of dust can stay behind. Never more than one per holder.
                    prop_assert!(left <= USERS.len() as u128 + 1, "too much collateral stranded after a void: {}", left);
                } else {
                    prop_assert_eq!(left, 0, "collateral left locked after everyone was paid");
                }
            }
            assert_conserved(&c, total_in);
        }
    }

    #[test]
    fn the_quoted_fee_is_the_fee_charged_on_a_buy_and_a_sell() {
        let (mut c, _) = world();
        assert_eq!(c.fees, 2 * DEFAULT_CREATE_FEE, "each seed paid the creation fee");
        let q = c.quote_buy(U64(0), "yes".into(), U128(10_000_000));
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        assert_eq!(holdings(&c, 0, USERS[0]).0, q.shares_out.0);
        assert_eq!(c.fees, 2 * DEFAULT_CREATE_FEE + q.fee.0);
        assert_eq!(
            c.market(0).locked,
            SEED_UNITS - DEFAULT_CREATE_FEE + 10_000_000 - q.fee.0
        );

        let s = c.quote_sell(U64(0), "yes".into(), q.shares_out);
        act_as(USERS[0], 4);
        c.sell(U64(0), "yes".into(), s.collateral_out, q.shares_out);
        assert_eq!(c.get_balance(acct(USERS[0])).0, s.collateral_out.0 - s.fee.0);
        assert_eq!(c.fees, 2 * DEFAULT_CREATE_FEE + q.fee.0 + s.fee.0);
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
        act_as(USERS[2], 6);
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

    #[test]
    fn after_the_deadline_anyone_can_void_and_holders_redeem_at_the_closing_price() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1); // ann buys Yes
        step(&mut c, &mut total_in, 1, 1, 0, 10_000_000, 1); // ben buys No
        act_as(USERS[2], VOID_OPEN); // a stranger, once the grace period is over
        c.void_if_unresolved(U64(0));
        assert_eq!(c.market(0).outcome, Some(Outcome::Void));
        let price = c.market(0).void_price_yes.expect("a void records its price");
        assert_eq!(price, c.market(0).closing_price());
        assert_eq!(c.get_market(U64(0)).unwrap().void_price_yes, Some(U128(price)));

        let (ann_yes, _) = holdings(&c, 0, USERS[0]);
        act_as(USERS[0], VOID_OPEN + 1);
        assert_eq!(c.redeem(U64(0)).0, ann_yes * price / 1_000_000);
        let (_, ben_no) = holdings(&c, 0, USERS[1]);
        act_as(USERS[1], VOID_OPEN + 1);
        assert_eq!(c.redeem(U64(0)).0, ben_no * (1_000_000 - price) / 1_000_000);
        assert_conserved(&c, total_in);
    }

    // Under the old flat half, a holder of the cheap side was paid several times what the shares were worth.
    #[test]
    fn a_void_gives_the_cheap_side_no_windfall() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 40_000_000, 1); // ann pushes Yes up
        step(&mut c, &mut total_in, 1, 1, 0, 1_000_000, 1); // ben buys a little of the cheap No
        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(0));
        let price = c.market(0).void_price_yes.unwrap();
        assert!(price > 600_000, "Yes was the favourite at close: {price}");
        let (_, ben_no) = holdings(&c, 0, USERS[1]);
        act_as(USERS[1], VOID_OPEN + 1);
        let paid = c.redeem(U64(0)).0;
        assert_eq!(paid, ben_no * (1_000_000 - price) / 1_000_000);
        assert!(
            paid < ben_no * 2 / 5,
            "the cheap side is paid its price, well under the old half: {paid} for {ben_no} shares"
        );
        assert_conserved(&c, total_in);
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
        c.set_create_fee(U128(10_000_000));
        let rate = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_fee_rate_bps(501)));
        let create = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_create_fee(U128(10_000_001))));
        assert!(rate.is_err() && create.is_err());
        assert_eq!(
            (c.config()["fee_rate_bps"].clone(), c.config()["create_fee"].clone()),
            (500.into(), "10000000".into())
        );
    }

    #[test]
    fn the_next_market_pays_the_new_creation_fee() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_create_fee(U128(2_500_000));
        let id = c.create_market(
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
        c.markets.insert(id.0, m);
        let before = c.fees;
        act_as(VERIFIER, 6);
        let _ = receive(&mut c, acct(OWNER), U128(SEED_UNITS), format!("seed:{}", id.0));
        assert_eq!(c.fees - before, 2_500_000);
        assert_eq!(c.market(id.0).locked, SEED_UNITS - 2_500_000);
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

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_stranger_cannot_change_the_creation_fee() {
        let (mut c, _) = world();
        act_as(USERS[0], 5);
        c.set_create_fee(U128(0));
    }

    // ---- opening away from one half ------------------------------------------------------------------

    fn open_market(c: &mut MarketContract) -> u64 {
        let id = price_market(c, None).0;
        let mut m = c.market(id);
        m.registered = true;
        c.markets.insert(id, m);
        id
    }

    fn seed_with(c: &mut MarketContract, who: &str, id: u64, price: Option<&str>) {
        act_as(VERIFIER, 6);
        let msg = match price {
            Some(p) => format!("seed:{id}:{p}"),
            None => format!("seed:{id}"),
        };
        let _ = receive(c, acct(who), U128(SEED_UNITS), msg);
    }

    #[test]
    fn a_market_seeded_at_thirty_percent_opens_there_and_the_seeder_holds_the_shares_the_pools_do_not() {
        // Market 1 of the test world was seeded at 30%.
        let (c, _) = world();
        let m = c.market(1);
        let price = c.get_market(U64(1)).unwrap().price_yes.0;
        assert!((299_999..=300_000).contains(&price), "opens at 30% Yes: {price}");
        let locked = SEED_UNITS - DEFAULT_CREATE_FEE;
        assert_eq!((m.pool_yes, m.locked), (locked, locked));
        assert!(m.pool_no < locked);
        assert_eq!(
            holdings(&c, 1, OWNER),
            (0, locked - m.pool_no),
            "the seeder holds the No shares the No pool does not"
        );
        assert_eq!((m.user_yes, m.user_no), (0, locked - m.pool_no));
        assert!(c.check_invariant(U64(1)));
        assert_eq!(
            m.history.first().map(|p| p.1 as u128),
            Some(price),
            "the chart starts at the opening price"
        );
        // The even market holds nothing back.
        assert_eq!(holdings(&c, 0, OWNER), (0, 0));
        assert_eq!(c.get_market(U64(0)).unwrap().price_yes.0, 500_000);
    }

    #[test]
    fn a_market_seeded_at_seventy_percent_leaves_the_seeder_holding_yes() {
        let (mut c, _) = world();
        let id = open_market(&mut c);
        seed_with(&mut c, OWNER, id, Some("700000"));
        let price = c.get_market(U64(id)).unwrap().price_yes.0;
        assert!((699_999..=700_001).contains(&price), "{price}");
        let locked = SEED_UNITS - DEFAULT_CREATE_FEE;
        let m = c.market(id);
        assert_eq!((m.pool_no, m.locked), (locked, locked));
        assert_eq!(holdings(&c, id, OWNER), (locked - m.pool_yes, 0));
        assert!(c.check_invariant(U64(id)));
    }

    #[test]
    fn seeding_at_one_half_either_way_leaves_the_seeder_nothing() {
        let (mut c, _) = world();
        let a = open_market(&mut c);
        let b = open_market(&mut c);
        seed_with(&mut c, OWNER, a, None);
        seed_with(&mut c, OWNER, b, Some("500000"));
        for id in [a, b] {
            assert_eq!(holdings(&c, id, OWNER), (0, 0));
            assert_eq!(c.get_market(U64(id)).unwrap().price_yes.0, 500_000);
        }
    }

    #[test]
    fn a_starting_price_outside_one_to_ninety_nine_percent_is_refused() {
        for bad in ["0", "9999", "990001", "1000000"] {
            let (mut c, _) = world();
            let id = open_market(&mut c);
            let caught =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| seed_with(&mut c, OWNER, id, Some(bad))));
            assert!(caught.is_err(), "{bad} must be refused");
            assert!(!c.market(id).seeded);
        }
        for ok in ["10000", "990000"] {
            let (mut c, _) = world();
            let id = open_market(&mut c);
            seed_with(&mut c, OWNER, id, Some(ok));
            assert!(c.market(id).seeded, "{ok} is allowed");
            assert!(c.check_invariant(U64(id)));
        }
    }

    #[test]
    #[should_panic(expected = "bad starting price")]
    fn a_starting_price_that_is_not_a_number_is_refused() {
        let (mut c, _) = world();
        let id = open_market(&mut c);
        seed_with(&mut c, OWNER, id, Some("high"));
    }

    #[test]
    #[should_panic(expected = "the seed is too small to open at that price")]
    fn a_seed_too_small_for_its_price_is_refused_rather_than_opening_with_an_empty_pool() {
        let (mut c, _) = world();
        let id = open_market(&mut c);
        act_as(VERIFIER, 6);
        let _ = receive(
            &mut c,
            acct(OWNER),
            U128(DEFAULT_CREATE_FEE + 5),
            format!("seed:{id}:10000"),
        );
    }

    #[test]
    #[should_panic(expected = "do the storage deposit first")]
    fn a_seeder_who_would_hold_shares_must_be_registered() {
        let (mut c, _) = world();
        let id = open_market(&mut c);
        c.accounts.remove(&acct(OWNER));
        seed_with(&mut c, OWNER, id, Some("300000"));
    }

    #[test]
    fn trading_a_skewed_market_keeps_the_books_and_the_seeder_can_sell_what_it_holds() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 1, 10_000_000, 1); // ann buys Yes in the 30% market
        step(&mut c, &mut total_in, 1, 1, 1, 10_000_000, 1); // ben buys No
        assert!(c.check_invariant(U64(1)));
        let (_, held) = holdings(&c, 1, OWNER);
        let q = c.quote_sell(U64(1), "no".into(), U128(held / 2));
        act_as(OWNER, 7);
        c.sell(U64(1), "no".into(), q.collateral_out, U128(held));
        assert!(c.check_invariant(U64(1)));
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
        let q = c.quote_sell(U64(0), "yes".into(), U128(held));
        act_as(ATTACKER, 5);
        c.sell(U64(0), "yes".into(), q.collateral_out, U128(held));
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
    // buys ahead of a large order still profits from the price that order moves, and that comes out of the pool, which
    // is the seeder. That is true of every constant-product market and is measured here, not prevented.
    #[test]
    fn a_buyers_minimum_bounds_what_a_sandwich_can_take_from_the_buyer() {
        let victim = 20_000_000u128;
        let fronts = [
            10_000u128, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000,
            40_000_000,
        ];
        let mut report = String::from("\nsandwich of a 20,000,000 buy on a 99,000,000 pool\n");
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

    // The fee is rate x shares x p x (1 - p) with p the trade's average price, and p(1 - p) is highest in the middle,
    // so cutting one trade into many smaller ones, each at its own average price, can pay less in total. Measured.
    #[test]
    fn splitting_one_buy_into_many_changes_the_fee_paid_and_this_is_how_much() {
        let total = 40_000_000u128;
        let mut report = String::from("\nfee for buying 40,000,000 of Yes on a fresh 99,000,000 pool\n");
        let mut one_trade = 0;
        for slices in [1u128, 2, 4, 10, 40, 400] {
            let (mut c, _) = world();
            let before = c.fees;
            for _ in 0..slices {
                act_as(VERIFIER, 3);
                let _ = receive(&mut c, acct(ATTACKER), U128(total / slices), "buy:0:yes:1".into());
            }
            let fee = c.fees - before;
            let shares = holdings(&c, 0, ATTACKER).0;
            if slices == 1 {
                one_trade = fee;
            }
            report.push_str(&format!(
                "  {slices:>6} trades: fee {fee:>9} ({:>5} of the single-trade fee), shares {shares}\n",
                format!("{}%", fee * 100 / one_trade)
            ));
            assert!(c.check_invariant(U64(0)));
        }
        println!("{report}");
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
                if q.collateral_out.0 > 0 {
                    act_as(ATTACKER, 4);
                    c.sell(U64(0), "yes".into(), q.collateral_out, U128(held));
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
                    if q.collateral_out.0 > 0 {
                        act_as(ATTACKER, 4);
                        c.sell(U64(0), side.into(), q.collateral_out, U128(held));
                    }
                }
                prop_assert!(c.check_invariant(U64(0)));
            }
            // Sell what is left, both sides.
            for side in ["yes", "no"] {
                let (y, n) = holdings(&c, 0, ATTACKER);
                let held = if side == "yes" { y } else { n };
                let q = c.quote_sell(U64(0), side.into(), U128(held));
                if q.collateral_out.0 > 0 {
                    act_as(ATTACKER, 5);
                    c.sell(U64(0), side.into(), q.collateral_out, U128(held));
                }
            }
            prop_assert!(c.get_balance(acct(ATTACKER)).0 <= put_in, "got back {} for {}", c.get_balance(acct(ATTACKER)).0, put_in);
        }
    }

    // Pump the price, force a Void, redeem. A Void pays the closing price averaged over the last day, and the shares
    // were bought along the way up, so they cost less than they pay. The gain is the pool's loss. It needs a Void,
    // which nobody can force alone; this measures what it would be worth if someone could.
    #[test]
    fn pumping_the_price_and_then_a_void_pays_the_pumper_from_the_pool_and_this_is_how_much() {
        for put in [5_000_000u128, 20_000_000, 40_000_000, 80_000_000] {
            let (mut c, _) = world();
            act_as(VERIFIER, 3);
            let _ = receive(&mut c, acct(ATTACKER), U128(put), "buy:0:yes:1".into());
            act_as(USERS[2], VOID_OPEN);
            c.void_if_unresolved(U64(0));
            let price = c.market(0).void_price_yes.unwrap();
            let (shares, _) = holdings(&c, 0, ATTACKER);
            act_as(ATTACKER, VOID_OPEN + 1);
            let paid = c.redeem(U64(0)).0;
            println!(
                "pump {put:>10}: shares {shares}, void price {price}, redeemed {paid}, profit {}",
                paid as i128 - put as i128
            );
            assert!(c.check_invariant(U64(0)));
        }
    }

    // The closing price is meant to be a day's average, so a trade at the end cannot set it. The price log that feeds it
    // keeps only the newest 120 points, counted by trades and not by time. An attacker who pumps the price and then makes
    // more than 120 tiny trades in the last moments pushes every honest point out of the log, and the "day's average"
    // becomes the last few moments at the pumped price. The market opened at 0.5 for nearly all of its life here.
    #[test]
    fn flooding_the_price_log_with_dust_trades_cannot_turn_a_days_average_into_the_last_minute() {
        let (mut c, _) = world();
        act_as(VERIFIER, CLOSE - 1_000);
        let _ = receive(&mut c, acct(ATTACKER), U128(150_000_000), "buy:0:yes:1".into());
        let pumped = c.get_market(U64(0)).unwrap().price_yes.0;
        assert!(pumped > 750_000, "the pump moved the price to {pumped}");
        for i in 0..130u64 {
            act_as(VERIFIER, CLOSE - 900 + i);
            let _ = receive(&mut c, acct(ATTACKER), U128(1_000), "buy:0:yes:1".into());
        }
        assert_eq!(
            c.market(0).history.len(),
            HISTORY_MAX,
            "the log is full of the attacker's points"
        );
        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(0));
        let price = c.market(0).void_price_yes.unwrap();
        // 0.5 held for 9,000 of the 10,000 nanoseconds, then about 0.76: an honest average is about 0.53.
        assert!(
            price < 600_000,
            "the attacker set the closing price to {price} by flooding the log"
        );
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
    #[should_panic(expected = "market is halted")]
    fn a_halted_market_refuses_sells_as_well_as_buys() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1);
        act_as(OWNER, 4);
        c.halt(U64(0), "grief".into());
        let (held, _) = holdings(&c, 0, USERS[0]);
        let q = c.quote_sell(U64(0), "yes".into(), U128(held));
        act_as(USERS[0], 5);
        c.sell(U64(0), "yes".into(), q.collateral_out, U128(held));
    }

    #[test]
    fn the_residual_is_due_to_the_treasury_and_not_credited_to_the_owner() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1); // ann buys Yes
        act_as(ORACLE, CLOSE + 1);
        c.set_outcome(U64(0), Outcome::Yes);
        let (ann_yes, _) = holdings(&c, 0, USERS[0]);
        let owed = ann_yes;
        let residual = c.market(0).locked - owed;
        assert!(residual > 0);

        act_as(USERS[2], CLOSE + 2);
        let stranger = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_residual(U64(0))));
        assert!(stranger.is_err(), "only the operator or owner claims");
        act_as(OWNER, CLOSE + 2);
        c.claim_residual(U64(0));
        assert_eq!(c.treasury_due, residual, "the next sweep pays it on the treasury leg");
        assert_eq!(
            c.get_balance(acct(OWNER)).0,
            0,
            "the owner, which is the DAO, is not credited"
        );
        assert_eq!(last_event()["data"]["to"], TREASURY);
        assert_eq!(c.market(0).locked, owed, "what users are owed stays reserved");
        assert_conserved(&c, total_in);
    }

    #[test]
    fn a_market_that_resolves_yes_or_no_records_no_void_price() {
        let (mut c, _) = world();
        act_as(ORACLE, CLOSE + 1);
        c.set_outcome(U64(0), Outcome::Yes);
        assert_eq!(c.market(0).void_price_yes, None);
        assert_eq!(c.get_market(U64(0)).unwrap().void_price_yes, None);
    }

    // ---- the closing price a Void pays ------------------------------------------------------------

    const W: u64 = VOID_PRICE_WINDOW_NS;

    // A market closing at `close_at` that was priced at the given (time, Yes price) points, in order.
    fn priced(close_at: u64, points: &[(u64, u128)]) -> u128 {
        let mut m = blank();
        m.close_at = close_at;
        m.history.clear();
        m.twap = None;
        for (t, p) in points {
            m.record_price_at(*t, *p);
        }
        m.closing_price()
    }

    #[test]
    fn one_price_point_is_the_closing_price() {
        assert_eq!(priced(100, &[(5, 123_456)]), 123_456);
    }

    #[test]
    fn the_closing_price_is_averaged_over_time() {
        // 200,000 held for 50 ns, then 800,000 held for 50 ns.
        assert_eq!(priced(100, &[(0, 200_000), (50, 800_000)]), 500_000);
    }

    #[test]
    fn a_trade_in_the_last_second_barely_moves_it() {
        let close = 2 * W;
        // 100,000 for a day less a second, then 900,000 for the final second: 100,009.26 rounded down.
        assert_eq!(
            priced(close, &[(W, 100_000), (close - 1_000_000_000, 900_000)]),
            100_009
        );
    }

    #[test]
    fn history_older_than_the_window_counts_only_from_the_window_start() {
        let close = 2 * W;
        // The first price was set long before the window and holds for its first half; the second for its second half.
        assert_eq!(priced(close, &[(0, 200_000), (close - W / 2, 800_000)]), 500_000);
    }

    #[test]
    fn points_at_or_after_close_are_ignored_and_no_points_means_one_half() {
        assert_eq!(priced(100, &[(10, 300_000), (100, 900_000), (150, 1)]), 300_000);
        assert_eq!(priced(100, &[(100, 900_000)]), HALF);
        assert_eq!(priced(100, &[]), HALF);
    }

    #[test]
    fn several_points_at_one_instant_count_only_as_the_last_one() {
        assert_eq!(priced(10, &[(5, 111_111), (5, 222_222)]), 222_222);
    }

    #[test]
    fn a_pair_of_shares_always_pays_exactly_one_unit_whatever_the_price() {
        for price in [0, 1, 333_333, 500_000, 999_999, 1_000_000] {
            assert_eq!(void_payout(1_000_000, 1_000_000, price), 1_000_000, "price {price}");
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        #[test]
        fn the_closing_price_stays_between_the_prices_it_averages(
            raw in proptest::collection::vec((0u64..200, 0u32..=1_000_000), 1..30),
            close in 1u64..300,
        ) {
            let mut history = raw;
            history.sort_by_key(|(t, _)| *t);
            let used: Vec<u128> = history.iter().filter(|(t, _)| *t < close).map(|(_, p)| *p as u128).collect();
            let points: Vec<(u64, u128)> = history.iter().map(|(t, p)| (*t, *p as u128)).collect();
            let price = priced(close, &points);
            match (used.iter().min(), used.iter().max()) {
                (Some(lo), Some(hi)) => prop_assert!(*lo <= price && price <= *hi, "{} not within {}..={}", price, lo, hi),
                _ => prop_assert_eq!(price, HALF),
            }
        }
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
        c.create_market(
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
        c.create_market(
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
        let id: U64 = c.create_market(
            "t".into(),
            "r".into(),
            "s".into(),
            "v".into(),
            "sports".into(),
            "nfl".into(),
            U64(CLOSE + 2 * W),
            U64(RESOLVE_BY + 2 * W),
            None,
        );
        c.halt(id, "checking something".into());
        c.resume(id);
        c.set_paused(true);
        c.set_paused(false);
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

    // ---- halting stops the clock on the closing price -------------------------------------------------

    // Price 0.2 from the start, then pumped to 0.9 half way through the window and halted at once, for good. The pumped
    // price held for no trading time, so the average is the 0.2 it was before.
    #[test]
    fn time_while_halted_counts_for_nothing_toward_the_closing_price() {
        let close = 2 * W;
        let mut m = blank();
        m.close_at = close;
        m.twap = None;
        m.record_price_at(0, 200_000);
        m.record_price_at(close - W / 2, 900_000);
        m.advance_twap(close - W / 2);
        m.halted = true;
        assert_eq!(m.closing_price(), 200_000);
    }

    #[test]
    fn trading_time_after_a_resume_counts_again() {
        let close = 2 * W;
        let mut m = blank();
        m.close_at = close;
        m.twap = None;
        m.record_price_at(0, 200_000);
        m.advance_twap(close - W / 2);
        m.halted = true;
        m.advance_twap(close - W / 4);
        m.halted = false;
        m.record_price_at(close - W / 4, 800_000);
        // 0.2 for half the window, nothing for a quarter, then 0.8 for the last quarter: (0.2 x 2 + 0.8) / 3.
        assert_eq!(m.closing_price(), 400_000);
    }

    #[test]
    fn a_market_with_no_trading_time_in_the_window_pays_the_average_over_all_its_trading_time() {
        let close = 2 * W;
        let mut m = blank();
        m.close_at = close;
        m.twap = None;
        m.record_price_at(0, 100_000);
        m.record_price_at(close - W, 200_000);
        m.halted = true;
        assert_eq!(m.closing_price(), 100_000);
    }

    #[test]
    fn a_market_that_never_traded_before_it_was_halted_pays_its_last_price() {
        let close = 2 * W;
        let mut m = blank();
        m.close_at = close;
        m.twap = None;
        m.record_price_at(0, 300_000);
        m.halted = true;
        assert_eq!(m.closing_price(), 300_000);
    }

    // The attack: pump the price late, halt, and let the market void. The average used to go on counting the pumped
    // price for the rest of the window, which was most of it.
    #[test]
    fn halting_right_after_a_pump_does_not_pin_the_void_price_at_the_pumped_price() {
        let (mut c, mut total_in) = world();
        act_as(VERIFIER, 5_000);
        let _ = receive(&mut c, acct(USERS[0]), U128(80_000_000), "buy:0:yes:1".into());
        total_in += 80_000_000;
        let pumped = c.get_market(U64(0)).unwrap().price_yes.0;
        assert!(pumped > 650_000, "the buy moved the price to {pumped}");
        act_as(OWNER, 5_001);
        c.halt(U64(0), "pumped".into());
        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(0));
        let price = c.market(0).void_price_yes.unwrap();
        assert!(
            price < 520_000,
            "the pumped price held for one nanosecond of trading, yet the void pays {price}"
        );
        assert_conserved(&c, total_in);
    }

    // The market trades from its seed at 2 to the halt at 9,000 and is Void. Yes was pumped at 5,000, so that price
    // counts for the 4,000 before the halt and nothing after.
    #[test]
    fn halting_counts_the_trading_time_before_the_halt() {
        let (mut c, _) = world();
        act_as(VERIFIER, 5_000);
        let _ = receive(&mut c, acct(USERS[0]), U128(80_000_000), "buy:0:yes:1".into());
        let pumped = c.get_market(U64(0)).unwrap().price_yes.0;
        act_as(OWNER, 9_000);
        c.halt(U64(0), "checking".into());
        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(0));
        let expected = (500_000 * 4_998 + pumped * 4_000) / 8_998;
        assert_eq!(c.market(0).void_price_yes, Some(expected));
    }

    // Halted from 6,000 to 8,000 and trading again after: the two thousand nanoseconds count for nothing.
    #[test]
    fn a_resume_counts_trading_time_from_the_resume_not_from_the_halt() {
        let (mut c, _) = world();
        act_as(VERIFIER, 5_000);
        let _ = receive(&mut c, acct(USERS[0]), U128(80_000_000), "buy:0:yes:1".into());
        let pumped = c.get_market(U64(0)).unwrap().price_yes.0;
        act_as(OWNER, 6_000);
        c.halt(U64(0), "checking".into());
        act_as(OWNER, 8_000);
        c.resume(U64(0));
        act_as(USERS[2], VOID_OPEN);
        c.void_if_unresolved(U64(0));
        let expected = (500_000 * 4_998 + pumped * 3_000) / 7_998;
        assert_eq!(c.market(0).void_price_yes, Some(expected));
    }

    // ---- a halt cannot take the last day out of a Void's price -------------------------------------------

    const HOUR: u64 = 3_600_000_000_000;

    // The scenario of the second review's proof of concept: 50% for 75 hours, then one 400 unit buy that moves the price
    // to 96%, a halt a minute later by the operator and no resume until the market closes at 100 hours. The last 25
    // hours hold no trading time, so the Void used to pay the pumped price itself.
    fn pumped_then_halted(halt_after_pump: bool) -> (u128, u128) {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as("op.near", 1);
        let mut c = MarketContract::new(
            acct("gov.near"),
            acct("op.near"),
            acct(ORACLE),
            acct(VERIFIER),
            COLLATERAL_ID.to_string(),
        );
        let close = 100 * HOUR;
        let id = c
            .create_market(
                "t".into(),
                "r".into(),
                "s".into(),
                "v".into(),
                "crypto".into(),
                "btc".into(),
                U64(close),
                U64(close + 200 * HOUR),
                None,
            )
            .0;
        let mut m = c.market(id);
        m.registered = true;
        c.markets.insert(id, m);
        act_unpaid(VERIFIER, 2);
        let _ = receive(&mut c, acct("op.near"), U128(100_000_000), format!("seed:{id}"));
        c.accounts.insert(acct("pumper.near"), 0);
        c.credit(&acct("pumper.near"), 400_000_000);
        act_as("pumper.near", 75 * HOUR);
        c.buy(U64(id), "yes".into(), U128(400_000_000), U128(1));
        let pumped = c.get_market(U64(id)).unwrap().price_yes.0;
        if halt_after_pump {
            act_unpaid("op.near", 75 * HOUR + 60_000_000_000);
            c.halt(U64(id), "maintenance".into());
        }
        act_unpaid(ORACLE, close + HOUR);
        c.set_outcome(U64(id), Outcome::Void);
        (pumped, c.get_market(U64(id)).unwrap().void_price_yes.unwrap().0)
    }

    #[test]
    fn a_halt_held_through_the_last_day_leaves_the_void_price_near_the_long_run_average() {
        let (pumped, halted_price) = pumped_then_halted(true);
        assert!(pumped > 900_000, "the buy moved the price to {pumped}");
        assert!(
            halted_price.abs_diff(500_000) < 1_000,
            "the pumped price held for one minute of 75 hours, yet the void pays {halted_price}"
        );
    }

    fn late_market() -> (MarketContract, u64) {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        let close = CLOSE + 3 * W;
        let id = c
            .create_market(
                "t".into(),
                "r".into(),
                "s".into(),
                "v".into(),
                "sports".into(),
                "nfl".into(),
                U64(close),
                U64(close + CLOSE),
                None,
            )
            .0;
        (c, id)
    }

    #[test]
    fn the_operator_can_halt_until_the_last_day_starts_and_the_owner_can_halt_any_time() {
        let (mut c, id) = late_market();
        let close = c.market(id).close_at;
        act_as("ops.near", close - W - 1);
        c.halt(U64(id), "early".into());
        act_as(OWNER, close - W);
        c.halt(U64(id), "owner inside the last day".into());
        act_as(OWNER, close - 1);
        c.resume(U64(id));
        c.halt(U64(id), "owner a nanosecond before close".into());
        assert!(c.market(id).halted);
    }

    #[test]
    #[should_panic(expected = "a halt in the last day before close is an owner action")]
    fn the_operator_cannot_halt_in_the_first_nanosecond_of_the_last_day() {
        let (mut c, id) = late_market();
        let close = c.market(id).close_at;
        act_as("ops.near", close - W);
        c.halt(U64(id), "late".into());
    }

    #[test]
    #[should_panic(expected = "a halt in the last day before close is an owner action")]
    fn the_operator_cannot_halt_after_close_either() {
        let (mut c, id) = late_market();
        let close = c.market(id).close_at;
        act_as("ops.near", close + 1);
        c.halt(U64(id), "late".into());
    }

    #[test]
    fn the_operator_can_still_resume_inside_the_last_day() {
        let (mut c, id) = late_market();
        let close = c.market(id).close_at;
        act_as("ops.near", close - 2 * W);
        c.halt(U64(id), "early".into());
        act_as("ops.near", close - 10);
        c.resume(U64(id));
        assert!(!c.market(id).halted);
    }

    // ---- what the view says about a market that cannot trade yet ---------------------------------------------

    fn status_and_seeded(c: &MarketContract, id: u64) -> (String, bool) {
        let v = c.get_market(U64(id)).unwrap();
        (v.status.clone(), v.seeded)
    }

    #[test]
    fn a_market_says_unregistered_then_unseeded_then_open_and_shows_whether_it_is_seeded() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        let id = c
            .create_market(
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
        assert_eq!(status_and_seeded(&c, id), ("unregistered".into(), false));
        let mut m = c.market(id);
        m.registered = true;
        c.markets.insert(id, m);
        assert_eq!(status_and_seeded(&c, id), ("unseeded".into(), false));
        act_unpaid(VERIFIER, 6);
        let _ = receive(&mut c, acct(OWNER), U128(SEED_UNITS), format!("seed:{id}"));
        assert_eq!(status_and_seeded(&c, id), ("open".into(), true));
        assert!(c.list_markets(U64(id), U64(1))[0].seeded);
    }

    #[test]
    fn resolved_halted_and_closed_come_before_unregistered_and_unseeded() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        let id = c
            .create_market(
                "t".into(),
                "r".into(),
                "s".into(),
                "v".into(),
                "sports".into(),
                "nfl".into(),
                U64(CLOSE + 3 * W),
                U64(RESOLVE_BY + 3 * W),
                None,
            )
            .0;
        c.halt(U64(id), "x".into());
        assert_eq!(status_and_seeded(&c, id).0, "halted");
        act_unpaid(OWNER, CLOSE + 3 * W);
        assert_eq!(status_and_seeded(&c, id).0, "halted");
        c.resume(U64(id));
        assert_eq!(status_and_seeded(&c, id).0, "closed");
        let mut m = c.market(id);
        m.outcome = Some(Outcome::No);
        c.markets.insert(id, m);
        assert_eq!(status_and_seeded(&c, id).0, "resolved");
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
        let id = c.create_market(
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
        c.markets.insert(id.0, m);
        id.0
    }

    // Each market seeded away from one half leaves the operator holding a position, and the cap is 20.
    #[test]
    fn the_operator_seeds_25_skewed_markets_and_holds_a_position_in_each() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        c.accounts.insert(acct("ops.near"), 0);
        for _ in 0..25 {
            let id = create_registered(&mut c, "ops.near");
            seed_with(&mut c, "ops.near", id, Some("300000"));
        }
        assert_eq!(c.accounts.get(&acct("ops.near")).copied(), Some(25));
    }

    #[test]
    fn the_owner_is_not_held_to_the_cap_either() {
        let (mut c, _) = world();
        for _ in 0..25 {
            let id = create_registered(&mut c, OWNER);
            seed_with(&mut c, OWNER, id, Some("300000"));
        }
        assert!(c.accounts.get(&acct(OWNER)).copied().unwrap() >= 25);
    }

    #[test]
    fn an_ordinary_trader_still_stops_at_20_positions() {
        let (mut c, _) = world();
        for i in 0..21 {
            let id = create_registered(&mut c, OWNER);
            seed_with(&mut c, OWNER, id, None);
            act_as(VERIFIER, 7);
            let bought = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = receive(&mut c, acct(USERS[0]), U128(1_000_000), format!("buy:{id}:yes:1"));
            }));
            // The two markets of the test world are not part of this count, so the account holds i positions here.
            assert_eq!(bought.is_ok(), i < MAX_POSITIONS, "buy number {}", i + 1);
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

    #[test]
    #[should_panic(expected = "market is closed")]
    fn a_market_cannot_be_seeded_at_its_close() {
        let (mut c, _) = world();
        let id = create_registered(&mut c, OWNER);
        act_as(VERIFIER, CLOSE);
        let _ = receive(&mut c, acct(OWNER), U128(SEED_UNITS), format!("seed:{id}"));
    }

    #[test]
    fn a_market_can_be_seeded_up_to_the_last_moment_before_close() {
        let (mut c, _) = world();
        let id = create_registered(&mut c, OWNER);
        act_as(VERIFIER, CLOSE - 1);
        let _ = receive(&mut c, acct(OWNER), U128(SEED_UNITS), format!("seed:{id}"));
        assert!(c.market(id).seeded);
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
            total_in + 5_000_000 + 41,
            "a withdrawal stops being owed once it is taken from the balance"
        );
    }

    #[test]
    fn a_failed_withdrawal_puts_the_balance_back_and_total_owed_with_it() {
        let (mut c, total_in) = world();
        act_as(VERIFIER, 3);
        let _ = receive(&mut c, acct(USERS[0]), U128(7_000_000), "deposit".to_string());
        act_as(USERS[0], 4);
        let _ = c.withdraw(U128(7_000_000));
        assert_eq!(c.total_owed().0, total_in);
        act_as("market.near", 5);
        c.on_withdraw(acct(USERS[0]), U128(7_000_000), Err(PromiseError::Failed));
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
        c.on_withdraw(acct(USERS[0]), U128(7_000_000), Ok(()));
        assert_eq!(c.get_balance(acct(USERS[0])).0, 0);
        assert_eq!(c.total_owed().0, total_in);
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
        act_as(USERS[2], SETTLE_AT + 1);
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
        act_as(USERS[2], 6);
        assert_eq!(c.sweep_fees(), Some(U64(2)));
        assert_eq!(c.get_sweep(U64(3)).map(|s| s.id), None);
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
            for (op, amount, how) in ops {
                match op {
                    0 => {
                        c.fees += amount;
                        added += amount;
                    }
                    1 => {
                        act_as(USERS[2], 5);
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
                        act_as(OWNER, 5 + RECONCILE_WAIT_MINUTES * NS_PER_MINUTE);
                        c.reconcile_leg(U64(id), LegKind::Council, how == 0);
                        if how == 0 { gone += sent; }
                    }
                    5 if !on_the_way.is_empty() => {
                        let (id, kind, sent) = on_the_way.remove(amount as usize % on_the_way.len());
                        act_as(OWNER, 5 + RECONCILE_WAIT_MINUTES * NS_PER_MINUTE);
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
    #[should_panic(expected = "migrate expects version 2")]
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
        assert!(c.storage_unregister(None));
        assert!(!c.is_registered(acct(USERS[0])));
    }
}
