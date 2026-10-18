// Binary prediction market with built-in constant-product pricing (the pitch test).
// One owner creates markets and seeds each with liquidity. Users hold shares inside this contract.
// A separate oracle contract decides outcomes and is the only caller of set_outcome.
// The JSON interface takes one argument per field, so a few methods are long on purpose.
#![allow(clippy::too_many_arguments)]

mod curve;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

use curve::MAX_POOL;

// Each account pays this once. It covers a balance entry plus MAX_POSITIONS share entries
// (about 100 bytes each at 1 NEAR per 100 KB), so spam accounts cannot drain the contract's storage.
const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(50);
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
// The fee on a trade is rate × shares × p × (1 − p). 2% costs about 1% of what a 50c trade pays. Both fees start at
// these values and governance can change them, but never above the ceilings, which are written here so that even a
// captured governance cannot set a confiscatory fee.
const DEFAULT_FEE_RATE_BPS: u128 = 200;
const MAX_FEE_RATE_BPS: u128 = 500;
// ponytail: placeholder, 1 unit of the 6-decimal test token, taken out of the seed transfer. The ceiling is 10 units.
const DEFAULT_CREATE_FEE: u128 = 1_000_000;
const MAX_CREATE_FEE: u128 = 10_000_000;
const REVENUE_SHARE_BPS: u128 = 2_500;
const BUSINESS_SHARE_BPS: u128 = 7_500;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
// The token keeps 30 TGas for itself and its resolve step; the rest goes to the Council's ft_on_transfer.
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(50);
const GAS_REGISTER: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Markets,
    Balances,
    Accounts,
    Shares,
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
// is the sum of price times how long it held, up to `at`, and `anchor` is (time, acc) where the averaging window opens.
// However many trades there are, each price counts only for how long it was in force.
#[near(serializers=[borsh])]
#[derive(Clone)]
pub struct Twap {
    acc: u128,
    at: u64,
    price: u128,
    anchor: Option<(u64, u128)>,
}

impl Twap {
    // Counts the price in force up to `now`, never past close_at, and fixes the window's start the first time it is passed.
    fn advance(&mut self, close_at: u64, now: u64) {
        let to = now.min(close_at);
        if to <= self.at {
            return;
        }
        let window_start = close_at.saturating_sub(VOID_PRICE_WINDOW_NS);
        if self.anchor.is_none() && to >= window_start {
            let at = window_start.max(self.at);
            self.anchor = Some((at, self.acc + self.price * (at - self.at) as u128));
        }
        self.acc += self.price * (to - self.at) as u128;
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
    status: String,
    registered: bool,
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

#[ext_contract(ext_ft)]
pub trait FtCore {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> U128;
}

#[ext_contract(ext_oracle)]
pub trait Oracle {
    fn register_market(&mut self, market_id: U64, close_at: U64, resolve_by: U64, rule_hash: String, price_rule: Option<PriceRule>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PmMarket {
    // Only the owner can change the operator, add a fee recipient, or hand off ownership. Everything else
    // routine (create a market, seed it, pause, halt, claim a residual) also takes the operator, so day to
    // day running does not need to wait on a governance vote.
    owner: AccountId,
    // Set by propose_owner. Ownership moves only when this account calls accept_owner.
    pending_owner: Option<AccountId>,
    operator: AccountId,
    oracle: AccountId,
    collateral: AccountId,
    paused: bool,
    // What a trade and a new market pay now. Each applies from the next trade or seed; nothing already paid changes.
    fee_rate_bps: u128,
    create_fee: u128,
    next_market_id: u64,
    markets: LookupMap<u64, Market>,
    balances: LookupMap<AccountId, u128>,
    // account -> number of share entries it holds. Presence means the account paid its storage deposit.
    accounts: LookupMap<AccountId, u32>,
    // (market, account, 0 = yes / 1 = no) -> shares
    shares: LookupMap<(u64, AccountId, u8), u128>,
    // The Council registry, which shares its 25% among staked seats.
    revenue_pool: AccountId,
    business_wallet: AccountId,
    // Collected fees, outside every market's collateral. A sweep splits them into the two dues below and sends
    // those; a failed transfer goes back to its own due, so one bad recipient never shifts money to the other.
    fees: u128,
    revenue_due: u128,
    business_due: u128,
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

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "pm-market", "version": "1.0.0", "event": event, "data": data })
    ));
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn side_index(side: &str) -> u8 {
    match side {
        "yes" => 0,
        "no" => 1,
        _ => env::panic_str("side must be yes or no"),
    }
}

#[near]
impl PmMarket {
    #[init]
    pub fn new(
        owner_id: AccountId,
        operator_id: AccountId,
        oracle_id: AccountId,
        collateral_token: AccountId,
        revenue_pool: AccountId,
        business_wallet: AccountId,
    ) -> Self {
        Self {
            owner: owner_id,
            pending_owner: None,
            operator: operator_id,
            oracle: oracle_id,
            collateral: collateral_token,
            paused: false,
            fee_rate_bps: DEFAULT_FEE_RATE_BPS,
            create_fee: DEFAULT_CREATE_FEE,
            next_market_id: 0,
            markets: LookupMap::new(Key::Markets),
            balances: LookupMap::new(Key::Balances),
            accounts: LookupMap::new(Key::Accounts),
            shares: LookupMap::new(Key::Shares),
            revenue_pool,
            business_wallet,
            fees: 0,
            revenue_due: 0,
            business_due: 0,
        }
    }

    // ---- accounts -------------------------------------------------------------------------

    #[payable]
    pub fn storage_deposit(&mut self) {
        let who = env::predecessor_account_id();
        let paid = env::attached_deposit();
        require!(paid >= STORAGE_DEPOSIT, "attach at least 0.05 NEAR");
        let refund = if self.accounts.contains_key(&who) {
            paid
        } else {
            self.accounts.insert(who.clone(), 0);
            paid.saturating_sub(STORAGE_DEPOSIT)
        };
        if !refund.is_zero() {
            let _ = Promise::new(who).transfer(refund);
        }
    }

    // ---- owner ----------------------------------------------------------------------------

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
            title.len() <= MAX_TITLE && rule_text.len() <= MAX_RULE && resolution_source.len() <= MAX_SOURCE && void_policy.len() <= MAX_VOID,
            "text is too long"
        );
        require!(valid_slug(&category) && valid_slug(&subcategory), "category and subcategory must be lowercase slugs of up to 32 characters");
        require!(close_at.0 > env::block_timestamp(), "close_at must be in the future");
        require!(resolve_by.0 > close_at.0, "resolve_by must be after close_at");
        if let Some(rule) = &price_rule {
            // Trading must stop before the moment that decides the market, or traders would know the answer.
            require!(rule.observation_time.0 >= close_at.0, "observation_time must not be before close_at");
            require!(rule.observation_time.0 < resolve_by.0, "observation_time must be before resolve_by");
            require!(rule.strike.0 > 0 && rule.decimals <= 18, "a price rule needs a strike above zero and at most 18 decimals");
        }

        let hash_input = near_sdk::borsh::to_vec(&(&title, &rule_text, &resolution_source, &void_policy, close_at.0, &price_rule))
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
        emit("market_created", json!({ "market_id": id.to_string(), "rule_hash": rule_hash }));
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

    pub fn halt(&mut self, market_id: U64, reason: String) {
        self.only_operator_or_owner();
        let mut m = self.market(market_id.0);
        require!(m.outcome.is_none(), "already resolved");
        m.halted = true;
        self.markets.insert(market_id.0, m);
        emit("market_halted", json!({ "market_id": market_id.0.to_string(), "reason": reason }));
    }

    pub fn resume(&mut self, market_id: U64) {
        self.only_operator_or_owner();
        let mut m = self.market(market_id.0);
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

    pub fn set_fee_recipients(&mut self, revenue_pool: AccountId, business_wallet: AccountId) {
        self.only_owner();
        emit("fee_recipients_set", json!({ "revenue_pool": revenue_pool, "business_wallet": business_wallet }));
        self.revenue_pool = revenue_pool;
        self.business_wallet = business_wallet;
    }

    pub fn set_fee_rate_bps(&mut self, fee_rate_bps: u32) {
        self.only_owner();
        require!(fee_rate_bps as u128 <= MAX_FEE_RATE_BPS, "the fee rate is capped at 500 basis points");
        emit("fee_rate_set", json!({ "fee_rate_bps": fee_rate_bps }));
        self.fee_rate_bps = fee_rate_bps as u128;
    }

    pub fn set_create_fee(&mut self, create_fee: U128) {
        self.only_owner();
        require!(create_fee.0 <= MAX_CREATE_FEE, "the creation fee is capped at 10 units");
        emit("create_fee_set", json!({ "create_fee": create_fee }));
        self.create_fee = create_fee.0;
    }

    // After resolution the pool's leftover collateral goes to the business wallet, not the owner: the owner is the
    // governance contract, which has no easy way to spend a balance held here. Users' payouts stay reserved.
    pub fn claim_residual(&mut self, market_id: U64) {
        self.only_operator_or_owner();
        let mut m = self.market(market_id.0);
        let outcome = m.outcome.unwrap_or_else(|| env::panic_str("not resolved"));
        require!(!m.residual_claimed, "already claimed");
        let owed = Self::owed(&m, outcome);
        let residual = m.locked.checked_sub(owed).unwrap_or_else(|| env::panic_str("invariant broken"));
        m.locked = owed;
        m.residual_claimed = true;
        self.markets.insert(market_id.0, m);
        self.credit(&self.business_wallet.clone(), residual);
        emit(
            "residual_claimed",
            json!({ "market_id": market_id.0.to_string(), "amount": residual.to_string(), "to": self.business_wallet }),
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
                emit("outcome_set", json!({ "market_id": market_id.0.to_string(), "outcome": outcome }));
            }
        }
    }

    // Safety net so money is never stuck: if no answer has been applied by resolve_by, anyone can void the
    // market and every holder redeems at its closing price (see Market::resolve). The oracle refuses proposals
    // that could not finish before resolve_by, so this cannot cut across a case that is still running.
    pub fn void_if_unresolved(&mut self, market_id: U64) {
        let mut m = self.market(market_id.0);
        require!(m.outcome.is_none(), "already resolved");
        require!(env::block_timestamp() >= m.resolve_by, "the answer deadline has not passed");
        m.resolve(Outcome::Void);
        self.markets.insert(market_id.0, m);
        emit("outcome_set", json!({ "market_id": market_id.0.to_string(), "outcome": Outcome::Void, "by": "deadline" }));
    }

    // ---- money in -------------------------------------------------------------------------

    // Called by the collateral token. Panicking here makes the token refund the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.collateral, "wrong token");
        require!(amount.0 > 0, "amount must be positive");
        let mut parts = msg.split(':');
        match parts.next() {
            Some("deposit") => {
                require!(!self.paused, "paused");
                require!(self.accounts.contains_key(&sender_id), "do the storage deposit first");
                self.credit(&sender_id, amount.0);
                emit("deposit", json!({ "account": sender_id, "amount": amount.0.to_string() }));
            }
            // "seed:<market>" opens at one half. "seed:<market>:<Yes price in millionths>" opens at that price.
            Some("seed") => {
                require!(sender_id == self.owner || sender_id == self.operator, "operator or owner only");
                let id: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("bad market id"));
                let yes_price = parts.next().map(|p| p.parse::<u128>().unwrap_or_else(|_| env::panic_str("bad starting price")));
                self.seed(&sender_id, id, amount.0, yes_price);
            }
            Some("buy") => {
                let id: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("bad market id"));
                let side = side_index(parts.next().unwrap_or(""));
                let min_out: u128 = parts.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("bad min shares"));
                self.buy_with(&sender_id, id, side, amount.0, min_out);
            }
            _ => env::panic_str("unknown action"),
        }
        PromiseOrValue::Value(U128(0))
    }

    // ---- trading --------------------------------------------------------------------------

    // Buy using balance already held here.
    pub fn buy(&mut self, market_id: U64, side: String, amount: U128, min_shares: U128) {
        let who = env::predecessor_account_id();
        let have = self.balances.get(&who).copied().unwrap_or(0);
        let left = have.checked_sub(amount.0).unwrap_or_else(|| env::panic_str("not enough balance"));
        self.balances.insert(who.clone(), left);
        self.buy_with(&who, market_id.0, side_index(&side), amount.0, min_shares.0);
    }

    // Takes collateral_out out of the pool. The fee is kept and the rest is credited to the seller.
    pub fn sell(&mut self, market_id: U64, side: String, collateral_out: U128, max_shares_in: U128) {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        require!(self.accounts.contains_key(&who), "do the storage deposit first");
        let idx = side_index(&side);
        let mut m = self.open_market(market_id.0);
        let (target, other) = if idx == 0 { (m.pool_yes, m.pool_no) } else { (m.pool_no, m.pool_yes) };
        let (fee, shares_in, new_target, new_other) = curve::sell_after_fee(target, other, collateral_out.0, self.fee_rate_bps)
            .unwrap_or_else(|| env::panic_str("cannot sell that amount"));
        require!(shares_in <= max_shares_in.0, "price moved, would need more shares than your maximum");

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
        self.markets.insert(market_id.0, m);
        self.credit(&who, payout);
        emit("redeemed", json!({ "market_id": market_id.0.to_string(), "account": who, "amount": payout.to_string() }));
        U128(payout)
    }

    // ---- money out ------------------------------------------------------------------------

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let have = self.balances.get(&who).copied().unwrap_or(0);
        let left = have.checked_sub(amount.0).unwrap_or_else(|| env::panic_str("not enough balance"));
        require!(amount.0 > 0, "amount must be positive");
        // Take the balance first; give it back in the callback if the transfer fails.
        self.balances.insert(who.clone(), left);
        emit("withdraw", json!({ "account": who, "amount": amount.0.to_string() }));
        ext_ft::ext(self.collateral.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(who.clone(), amount, None)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_withdraw(who, amount))
    }

    #[private]
    pub fn on_withdraw(&mut self, account: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.credit(&account, amount.0);
            emit("withdraw_failed", json!({ "account": account, "amount": amount.0.to_string() }));
        }
    }

    // ---- fees -----------------------------------------------------------------------------

    // Anyone may call it. Splits the collected fees 25/75, rounding both shares down so the remainder stays
    // collected, then sends whatever is due. With nothing due it does nothing. Measured with 1,000 staked seats:
    // it needs at least 91 TGas attached and burns about 15 TGas in all.
    pub fn sweep_fees(&mut self) {
        let revenue = self.fees * REVENUE_SHARE_BPS / 10_000;
        let business = self.fees * BUSINESS_SHARE_BPS / 10_000;
        self.fees -= revenue + business;
        self.revenue_due += revenue;
        self.business_due += business;
        let (revenue, business) = (self.revenue_due, self.business_due);
        if revenue == 0 && business == 0 {
            return;
        }
        emit("fees_swept", json!({ "revenue_pool": self.revenue_pool, "revenue": revenue.to_string(),
                                   "business_wallet": self.business_wallet, "business": business.to_string() }));
        // Zero each due before its transfer; the callback restores what did not arrive.
        if revenue > 0 {
            self.revenue_due = 0;
            let _ = ext_ft::ext(self.collateral.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FT_TRANSFER_CALL)
                .ft_transfer_call(self.revenue_pool.clone(), U128(revenue), None, "revenue".to_string())
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_revenue_sent(U128(revenue)));
        }
        if business > 0 {
            self.business_due = 0;
            let _ = ext_ft::ext(self.collateral.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(self.business_wallet.clone(), U128(business), None)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_business_sent(U128(business)));
        }
    }

    // The token reports how much the pool kept; the rest came back here.
    #[private]
    pub fn on_revenue_sent(&mut self, amount: U128, #[callback_result] used: Result<U128, PromiseError>) {
        let back = amount.0.saturating_sub(used.map(|u| u.0).unwrap_or(0));
        if back > 0 {
            self.revenue_due += back;
            emit("fee_transfer_failed", json!({ "to": self.revenue_pool, "amount": back.to_string() }));
        }
    }

    #[private]
    pub fn on_business_sent(&mut self, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.business_due += amount.0;
            emit("fee_transfer_failed", json!({ "to": self.business_wallet, "amount": amount.0.to_string() }));
        }
    }

    // ---- views ----------------------------------------------------------------------------

    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "owner": self.owner, "pending_owner": self.pending_owner, "operator": self.operator, "oracle": self.oracle, "collateral": self.collateral,
                "paused": self.paused, "markets": self.next_market_id.to_string(), "storage_deposit": STORAGE_DEPOSIT.as_yoctonear().to_string(),
                "max_positions": MAX_POSITIONS, "fee_rate_bps": self.fee_rate_bps as u32, "create_fee": self.create_fee.to_string(),
                "revenue_pool": self.revenue_pool, "business_wallet": self.business_wallet })
    }

    pub fn get_fees(&self) -> near_sdk::serde_json::Value {
        json!({ "collected": self.fees.to_string(), "revenue_due": self.revenue_due.to_string(),
                "business_due": self.business_due.to_string() })
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.accounts.contains_key(&account_id)
    }

    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_shares(&self, market_id: U64, account_id: AccountId) -> (U128, U128) {
        let y = self.shares.get(&(market_id.0, account_id.clone(), 0)).copied().unwrap_or(0);
        let n = self.shares.get(&(market_id.0, account_id, 1)).copied().unwrap_or(0);
        (U128(y), U128(n))
    }

    pub fn get_market(&self, market_id: U64) -> Option<MarketView> {
        self.markets.get(&market_id.0).map(|m| self.view(market_id.0, m))
    }

    pub fn list_markets(&self, from_index: U64, limit: U64) -> Vec<MarketView> {
        let end = self.next_market_id.min(from_index.0.saturating_add(limit.0.min(50)));
        (from_index.0..end).filter_map(|id| self.markets.get(&id).map(|m| self.view(id, m))).collect()
    }

    // Yes price after each trade, oldest first. The website draws its chart from this.
    pub fn get_history(&self, market_id: U64) -> Vec<PricePoint> {
        self.markets
            .get(&market_id.0)
            .map(|m| m.history.iter().map(|(at, p)| PricePoint { at: U64(*at), price_yes: *p }).collect())
            .unwrap_or_default()
    }

    // Shares you would get for `amount` collateral and the fee taken out of it, or zeros when the trade is not possible.
    pub fn quote_buy(&self, market_id: U64, side: String, amount: U128) -> BuyQuote {
        let none = BuyQuote { shares_out: U128(0), fee: U128(0) };
        let Some(m) = self.markets.get(&market_id.0) else { return none };
        let (target, other) = if side_index(&side) == 0 { (m.pool_yes, m.pool_no) } else { (m.pool_no, m.pool_yes) };
        match curve::buy_after_fee(target, other, amount.0, self.fee_rate_bps) {
            Some((fee, out, _, _)) => BuyQuote { shares_out: U128(out), fee: U128(fee) },
            None => none,
        }
    }

    // The most collateral selling `shares` can take out, the shares it would really take, and the fee kept from it.
    pub fn quote_sell(&self, market_id: U64, side: String, shares: U128) -> SellQuote {
        let none = SellQuote { collateral_out: U128(0), shares_in: U128(0), fee: U128(0) };
        let Some(m) = self.markets.get(&market_id.0) else { return none };
        let (target, other) = if side_index(&side) == 0 { (m.pool_yes, m.pool_no) } else { (m.pool_no, m.pool_yes) };
        let c = curve::max_collateral_for_shares(target, other, shares.0);
        match curve::sell_after_fee(target, other, c, self.fee_rate_bps) {
            Some((fee, needed, _, _)) => SellQuote { collateral_out: U128(c), shares_in: U128(needed), fee: U128(fee) },
            None => none,
        }
    }

    // Collateral locked must equal shares outstanding on both sides while trading, and must cover
    // every payout still owed after resolution.
    pub fn check_invariant(&self, market_id: U64) -> bool {
        let Some(m) = self.markets.get(&market_id.0) else { return false };
        match m.outcome {
            None => m.locked == m.pool_yes + m.user_yes && m.locked == m.pool_no + m.user_no,
            Some(o) => m.locked >= Self::owed(m, o),
        }
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
        self.void_price_yes.unwrap_or_else(|| env::panic_str("a voided market has no closing price"))
    }

    // The Yes price a Void pays: its time-weighted average over the last VOID_PRICE_WINDOW_NS before close_at, or since the
    // market opened if that was later. Nothing trades after close, so the price in force at close holds to the end.
    fn closing_price(&self) -> u128 {
        let Some(mut twap) = self.twap.clone() else { return HALF };
        twap.advance(self.close_at, self.close_at);
        match twap.anchor {
            Some((from, acc_from)) if self.close_at > from => (twap.acc - acc_from) / (self.close_at - from) as u128,
            _ => twap.price,
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
        match &mut self.twap {
            Some(twap) => {
                twap.advance(self.close_at, now);
                twap.price = price;
            }
            // A market first priced at or after its close has no time before close to average.
            None if now < self.close_at => self.twap = Some(Twap { acc: 0, at: now, price, anchor: None }),
            None => {}
        }
    }
}

impl PmMarket {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn only_operator_or_owner(&self) {
        let who = env::predecessor_account_id();
        require!(who == self.operator || who == self.owner, "operator or owner only");
    }

    fn market(&self, id: u64) -> Market {
        self.markets.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such market"))
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
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_registered(U64(id)));
    }

    fn credit(&mut self, who: &AccountId, amount: u128) {
        let have = self.balances.get(who).copied().unwrap_or(0);
        self.balances.insert(who.clone(), have + amount);
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
        require!(amount > self.create_fee, "the seed must be more than the creation fee");
        let amount = amount - self.create_fee;
        require!(amount <= MAX_POOL, "seed too large");
        if let Some(p) = yes_price {
            require!((MIN_OPEN_PRICE..=MAX_OPEN_PRICE).contains(&p), "the starting price must be between 1% and 99%");
        }
        let (pool_yes, pool_no) = opening_pools(amount, yes_price);
        require!(pool_yes > 0 && pool_no > 0, "the seed is too small to open at that price");
        m.pool_yes = pool_yes;
        m.pool_no = pool_no;
        m.locked = amount;
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

    // Spend `amount` that has already left the buyer's balance (or arrived by ft_transfer_call). The fee comes out
    // of it first and only the rest enters the market.
    fn buy_with(&mut self, who: &AccountId, id: u64, idx: u8, amount: u128, min_out: u128) {
        require!(!self.paused, "paused");
        require!(self.accounts.contains_key(who), "do the storage deposit first");
        require!(min_out > 0, "min shares must be above zero");
        let mut m = self.open_market(id);
        let (target, other) = if idx == 0 { (m.pool_yes, m.pool_no) } else { (m.pool_no, m.pool_yes) };
        let (fee, out, new_target, new_other) = curve::buy_after_fee(target, other, amount, self.fee_rate_bps)
            .unwrap_or_else(|| env::panic_str("cannot buy that amount"));
        require!(out >= min_out, "price moved, you would get fewer shares than your minimum");

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
            require!(n < MAX_POSITIONS, "too many positions, redeem or sell one first");
            self.accounts.insert(who.clone(), n + 1);
        }
        self.shares.insert(key, have + amount);
    }

    fn take_shares(&mut self, who: &AccountId, id: u64, idx: u8, amount: u128) {
        let key = (id, who.clone(), idx);
        let have = self.shares.get(&key).copied().unwrap_or(0);
        let left = have.checked_sub(amount).unwrap_or_else(|| env::panic_str("not enough shares"));
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
            title: String::new(), rule_text: String::new(), resolution_source: String::new(), void_policy: String::new(),
            category: String::new(), subcategory: String::new(),
            rule_hash: String::new(), price_rule: None, close_at: 0, resolve_by: 0, halted: false, registered: true, seeded: true,
            outcome: None, void_price_yes: None, pool_yes: 100, pool_no: 100, locked: 100, user_yes: 0, user_no: 0, residual_claimed: false,
            history: vec![], twap: None,
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
    const TOKEN: &str = "usdc.near";
    const COUNCIL: &str = "council.near";
    const BUSINESS: &str = "business.near";
    const USERS: [&str; 3] = ["ann.near", "ben.near", "cat.near"];
    const SEED_UNITS: u128 = 100_000_000; // 100 in 6-decimal units
    const CLOSE: u64 = 10_000;
    const RESOLVE_BY: u64 = 20_000;

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn act_as(who: &str, now_ns: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acct(who)).block_timestamp(now_ns).build());
    }

    // Two markets, both seeded, three registered users. Returns the contract and the total tokens received so far.
    fn world() -> (PmMarket, u128) {
        // The mock chain keeps its storage between cases; start each one empty.
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as(OWNER, 1);
        let mut c = PmMarket::new(acct(OWNER), acct(OWNER), acct(ORACLE), acct(TOKEN), acct(COUNCIL), acct(BUSINESS));
        for _ in 0..2 {
            c.create_market("t".into(), "r".into(), "s".into(), "v".into(), "sports".into(), "nfl".into(), U64(CLOSE), U64(RESOLVE_BY), None);
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
        act_as(TOKEN, 2);
        let _ = c.ft_on_transfer(acct(OWNER), U128(SEED_UNITS), "seed:0".to_string());
        let _ = c.ft_on_transfer(acct(OWNER), U128(SEED_UNITS), "seed:1:300000".to_string());
        (c, 2 * SEED_UNITS)
    }

    fn holdings(c: &PmMarket, id: u64, who: &str) -> (u128, u128) {
        let (y, n) = c.get_shares(U64(id), acct(who));
        (y.0, n.0)
    }

    // Every token the contract has received is locked in a market, sitting in someone's balance, or a fee.
    fn assert_conserved(c: &PmMarket, total_in: u128) {
        let locked: u128 = (0..2).map(|id| c.market(id).locked).sum();
        let balances: u128 = USERS.iter().chain([&OWNER, &BUSINESS]).map(|u| c.get_balance(acct(u)).0).sum();
        assert_eq!(locked + balances + c.fees + c.revenue_due + c.business_due, total_in, "money was created or lost");
        for id in 0..2 {
            assert!(c.check_invariant(U64(id)), "collateral no longer matches shares in market {id}");
        }
    }

    fn step(c: &mut PmMarket, total_in: &mut u128, op: u8, user: usize, id: u64, amount: u128, frac: u128) {
        let who = USERS[user];
        match op {
            // buy Yes or No by sending tokens in one transfer
            0 | 1 => {
                act_as(TOKEN, 3);
                let side = if op == 0 { "yes" } else { "no" };
                let _ = c.ft_on_transfer(acct(who), U128(amount), format!("buy:{id}:{side}:1"));
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
                act_as(TOKEN, 3);
                let _ = c.ft_on_transfer(acct(who), U128(amount), "deposit".to_string());
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
        act_as(TOKEN, 3);
        let _ = c.ft_on_transfer(acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        assert_eq!(holdings(&c, 0, USERS[0]).0, q.shares_out.0);
        assert_eq!(c.fees, 2 * DEFAULT_CREATE_FEE + q.fee.0);
        assert_eq!(c.market(0).locked, SEED_UNITS - DEFAULT_CREATE_FEE + 10_000_000 - q.fee.0);

        let s = c.quote_sell(U64(0), "yes".into(), q.shares_out);
        act_as(USERS[0], 4);
        c.sell(U64(0), "yes".into(), s.collateral_out, q.shares_out);
        assert_eq!(c.get_balance(acct(USERS[0])).0, s.collateral_out.0 - s.fee.0);
        assert_eq!(c.fees, 2 * DEFAULT_CREATE_FEE + q.fee.0 + s.fee.0);
        let back = s.collateral_out.0 - s.fee.0;
        assert!(10_000_000 - back >= q.fee.0 + s.fee.0, "the round trip lost at least both fees");
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
        c.sweep_fees();
        let d = swept();
        assert_eq!((d["revenue"].as_str(), d["business"].as_str()), (Some("250000"), Some("750002")));
        assert_eq!((c.fees, c.revenue_due, c.business_due), (1, 0, 0), "one unit of rounding stays collected");

        // The business wallet refuses its transfer and the Council takes only part of its share.
        c.on_business_sent(U128(750_002), Err(PromiseError::Failed));
        c.on_revenue_sent(U128(250_000), Ok(U128(249_000)));
        assert_eq!((c.fees, c.revenue_due, c.business_due), (1, 1_000, 750_002));

        // The next sweep resends each due to its own recipient; nothing is split again.
        act_as(USERS[2], 6);
        c.sweep_fees();
        let d = swept();
        assert_eq!((d["revenue"].as_str(), d["business"].as_str()), (Some("1000"), Some("750002")));
        assert_eq!((c.fees, c.revenue_due, c.business_due), (1, 0, 0));

        // Nothing due: a sweep does nothing.
        act_as(USERS[2], 7);
        c.sweep_fees();
        assert!(near_sdk::test_utils::get_logs().is_empty());
        assert_eq!((c.fees, c.revenue_due, c.business_due), (1, 0, 0));
    }

    #[test]
    #[should_panic(expected = "the answer deadline has not passed")]
    fn nobody_can_void_a_market_before_its_deadline() {
        let (mut c, _) = world();
        act_as(ORACLE, RESOLVE_BY - 1);
        c.void_if_unresolved(U64(0));
    }

    #[test]
    fn after_the_deadline_anyone_can_void_and_holders_redeem_at_the_closing_price() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1); // ann buys Yes
        step(&mut c, &mut total_in, 1, 1, 0, 10_000_000, 1); // ben buys No
        act_as(USERS[2], RESOLVE_BY); // a stranger
        c.void_if_unresolved(U64(0));
        assert_eq!(c.market(0).outcome, Some(Outcome::Void));
        let price = c.market(0).void_price_yes.expect("a void records its price");
        assert_eq!(price, c.market(0).closing_price());
        assert_eq!(c.get_market(U64(0)).unwrap().void_price_yes, Some(U128(price)));

        let (ann_yes, _) = holdings(&c, 0, USERS[0]);
        act_as(USERS[0], RESOLVE_BY + 1);
        assert_eq!(c.redeem(U64(0)).0, ann_yes * price / 1_000_000);
        let (_, ben_no) = holdings(&c, 0, USERS[1]);
        act_as(USERS[1], RESOLVE_BY + 1);
        assert_eq!(c.redeem(U64(0)).0, ben_no * (1_000_000 - price) / 1_000_000);
        assert_conserved(&c, total_in);
    }

    // Under the old flat half, a holder of the cheap side was paid several times what the shares were worth.
    #[test]
    fn a_void_gives_the_cheap_side_no_windfall() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 40_000_000, 1); // ann pushes Yes up
        step(&mut c, &mut total_in, 1, 1, 0, 1_000_000, 1); // ben buys a little of the cheap No
        act_as(USERS[2], RESOLVE_BY);
        c.void_if_unresolved(U64(0));
        let price = c.market(0).void_price_yes.unwrap();
        assert!(price > 600_000, "Yes was the favourite at close: {price}");
        let (_, ben_no) = holdings(&c, 0, USERS[1]);
        act_as(USERS[1], RESOLVE_BY + 1);
        let paid = c.redeem(U64(0)).0;
        assert_eq!(paid, ben_no * (1_000_000 - price) / 1_000_000);
        assert!(paid < ben_no * 2 / 5, "the cheap side is paid its price, well under the old half: {paid} for {ben_no} shares");
        assert_conserved(&c, total_in);
    }

    // ---- governance-set fees, with ceilings ------------------------------------------------------------

    #[test]
    fn the_owner_sets_the_trade_fee_and_the_next_trade_pays_it() {
        let (mut c, _) = world();
        let at_default = c.quote_buy(U64(0), "yes".into(), U128(10_000_000)).fee.0;
        act_as(OWNER, 5);
        c.set_fee_rate_bps(400);
        assert_eq!(c.config()["fee_rate_bps"], 400);
        let at_double = c.quote_buy(U64(0), "yes".into(), U128(10_000_000)).fee.0;
        assert!(at_double > at_default * 19 / 10 && at_double < at_default * 21 / 10, "twice the rate, about twice the fee: {at_default} then {at_double}");

        // The quote is what is charged.
        act_as(TOKEN, 6);
        let q = c.quote_buy(U64(0), "yes".into(), U128(10_000_000));
        let fees_before = c.fees;
        let _ = c.ft_on_transfer(acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        assert_eq!(c.fees - fees_before, q.fee.0);

        act_as(OWNER, 7);
        c.set_fee_rate_bps(0);
        assert_eq!(c.quote_buy(U64(0), "yes".into(), U128(10_000_000)).fee.0, 0, "a rate of zero is allowed");
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
        assert_eq!((c.config()["fee_rate_bps"].clone(), c.config()["create_fee"].clone()), (500.into(), "10000000".into()));
    }

    #[test]
    fn the_next_market_pays_the_new_creation_fee() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_create_fee(U128(2_500_000));
        let id = c.create_market("t".into(), "r".into(), "s".into(), "v".into(), "sports".into(), "nfl".into(), U64(CLOSE), U64(RESOLVE_BY), None);
        let mut m = c.market(id.0);
        m.registered = true;
        c.markets.insert(id.0, m);
        let before = c.fees;
        act_as(TOKEN, 6);
        let _ = c.ft_on_transfer(acct(OWNER), U128(SEED_UNITS), format!("seed:{}", id.0));
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

    fn open_market(c: &mut PmMarket) -> u64 {
        let id = price_market(c, None).0;
        let mut m = c.market(id);
        m.registered = true;
        c.markets.insert(id, m);
        id
    }

    fn seed_with(c: &mut PmMarket, who: &str, id: u64, price: Option<&str>) {
        act_as(TOKEN, 6);
        let msg = match price {
            Some(p) => format!("seed:{id}:{p}"),
            None => format!("seed:{id}"),
        };
        let _ = c.ft_on_transfer(acct(who), U128(SEED_UNITS), msg);
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
        assert_eq!(holdings(&c, 1, OWNER), (0, locked - m.pool_no), "the seeder holds the No shares the No pool does not");
        assert_eq!((m.user_yes, m.user_no), (0, locked - m.pool_no));
        assert!(c.check_invariant(U64(1)));
        assert_eq!(m.history.first().map(|p| p.1 as u128), Some(price), "the chart starts at the opening price");
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
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| seed_with(&mut c, OWNER, id, Some(bad))));
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
        act_as(TOKEN, 6);
        let _ = c.ft_on_transfer(acct(OWNER), U128(DEFAULT_CREATE_FEE + 5), format!("seed:{id}:10000"));
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

        act_as(TOKEN, 3);
        let _ = c.ft_on_transfer(acct(ATTACKER), U128(front), "buy:0:yes:1".into());
        act_as(TOKEN, 4);
        let filled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.ft_on_transfer(acct(VICTIM), U128(victim), format!("buy:0:yes:{min_out}"));
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
        let fronts = [10_000u128, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 40_000_000];
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
                assert!(r.victim_shares >= min, "the victim got {} shares, under their minimum {min}", r.victim_shares);
                worst_harm_bps = worst_harm_bps.max((r.quoted - r.victim_shares) * 10_000 / r.quoted);
                if r.attacker_profit > best_profit {
                    best_profit = r.attacker_profit;
                    best_front = f;
                }
            }
            assert!(worst_harm_bps <= tolerance, "the victim lost {worst_harm_bps} bps with a tolerance of {tolerance}");
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
        assert_eq!(r.victim_shares, 0, "the refused victim holds nothing and kept their money");
        assert!(r.attacker_profit < 0, "the attacker lost money and gained nothing: {}", r.attacker_profit);
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
                act_as(TOKEN, 3);
                let _ = c.ft_on_transfer(acct(ATTACKER), U128(total / slices), "buy:0:yes:1".into());
            }
            let fee = c.fees - before;
            let shares = holdings(&c, 0, ATTACKER).0;
            if slices == 1 {
                one_trade = fee;
            }
            report.push_str(&format!("  {slices:>6} trades: fee {fee:>9} ({:>5} of the single-trade fee), shares {shares}\n", format!("{}%", fee * 100 / one_trade)));
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
                act_as(TOKEN, 3);
                let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _ = c.ft_on_transfer(acct(ATTACKER), U128(amount), "buy:0:yes:1".into());
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
        assert!(c.get_balance(acct(ATTACKER)).0 <= spent, "the attacker made money from rounding: spent {spent}, balance {}, still holding {held} shares", c.get_balance(acct(ATTACKER)).0);
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
                    act_as(TOKEN, 3);
                    let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let _ = c.ft_on_transfer(acct(ATTACKER), U128(amount), format!("buy:0:{side}:1"));
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
            act_as(TOKEN, 3);
            let _ = c.ft_on_transfer(acct(ATTACKER), U128(put), "buy:0:yes:1".into());
            act_as(USERS[2], RESOLVE_BY);
            c.void_if_unresolved(U64(0));
            let price = c.market(0).void_price_yes.unwrap();
            let (shares, _) = holdings(&c, 0, ATTACKER);
            act_as(ATTACKER, RESOLVE_BY + 1);
            let paid = c.redeem(U64(0)).0;
            println!("pump {put:>10}: shares {shares}, void price {price}, redeemed {paid}, profit {}", paid as i128 - put as i128);
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
        act_as(TOKEN, CLOSE - 1_000);
        let _ = c.ft_on_transfer(acct(ATTACKER), U128(150_000_000), "buy:0:yes:1".into());
        let pumped = c.get_market(U64(0)).unwrap().price_yes.0;
        assert!(pumped > 750_000, "the pump moved the price to {pumped}");
        for i in 0..130u64 {
            act_as(TOKEN, CLOSE - 900 + i);
            let _ = c.ft_on_transfer(acct(ATTACKER), U128(1_000), "buy:0:yes:1".into());
        }
        assert_eq!(c.market(0).history.len(), HISTORY_MAX, "the log is full of the attacker's points");
        act_as(USERS[2], RESOLVE_BY);
        c.void_if_unresolved(U64(0));
        let price = c.market(0).void_price_yes.unwrap();
        // 0.5 held for 9,000 of the 10,000 nanoseconds, then about 0.76: an honest average is about 0.53.
        assert!(price < 600_000, "the attacker set the closing price to {price} by flooding the log");
    }

    // ---- attacks: timing -----------------------------------------------------------------------------

    #[test]
    #[should_panic(expected = "market is closed")]
    fn nobody_can_trade_at_the_exact_moment_of_close() {
        let (mut c, _) = world();
        act_as(TOKEN, CLOSE);
        let _ = c.ft_on_transfer(acct(ATTACKER), U128(1_000_000), "buy:0:yes:1".into());
    }

    #[test]
    fn trading_works_up_to_the_last_nanosecond_before_close() {
        let (mut c, _) = world();
        act_as(TOKEN, CLOSE - 1);
        let _ = c.ft_on_transfer(acct(ATTACKER), U128(1_000_000), "buy:0:yes:1".into());
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
    fn the_residual_goes_to_the_business_wallet_and_not_to_the_owner() {
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
        assert_eq!(c.get_balance(acct(BUSINESS)).0, residual);
        assert_eq!(c.get_balance(acct(OWNER)).0, 0, "the owner, which is governance, is not credited");
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
        assert_eq!(priced(close, &[(W, 100_000), (close - 1_000_000_000, 900_000)]), 100_009);
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
        PriceRule { observation_time: U64(observation_time), strike: U128(strike), decimals: 8, above: true }
    }

    fn price_market(c: &mut PmMarket, rule: Option<PriceRule>) -> U64 {
        act_as(OWNER, 5);
        c.create_market("t".into(), "r".into(), "s".into(), "v".into(), "crypto".into(), "bitcoin".into(), U64(CLOSE), U64(RESOLVE_BY), rule)
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
        let hashes: Vec<String> = [plain, a, b, later].iter().map(|id| c.get_market(*id).unwrap().rule_hash).collect();
        for i in 0..hashes.len() {
            for j in i + 1..hashes.len() {
                assert_ne!(hashes[i], hashes[j], "a different rule must give a different hash ({i} and {j})");
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
        c.create_market("t".into(), "x".repeat(MAX_RULE + 1), "s".into(), "v".into(), "sports".into(), "nfl".into(), U64(CLOSE), U64(RESOLVE_BY), None);
    }

    // A governance owner and a separate fast operator: the operator runs routine business, the owner alone
    // changes who the operator is and where fees go.
    #[test]
    fn the_operator_runs_routine_business_and_only_the_owner_changes_who_that_is() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.set_operator(acct("ops.near"));
        assert_eq!(c.config()["operator"], "ops.near");

        act_as("ops.near", 6);
        let id: U64 = c.create_market("t".into(), "r".into(), "s".into(), "v".into(), "sports".into(), "nfl".into(), U64(CLOSE), U64(RESOLVE_BY), None);
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
        c.set_fee_recipients(acct("new-council.near"), acct("new-business.near"));
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
}
