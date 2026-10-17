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
// 2% of shares × p × (1 − p), so about 1% of what a 50c trade pays. Fixed until an owner setter exists.
const FEE_RATE_BPS: u128 = 200;
// ponytail: placeholder, 1 unit of the 6-decimal test token, taken out of the seed transfer.
const CREATE_FEE: u128 = 1_000_000;
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
    close_at: u64,
    resolve_by: u64,
    halted: bool,
    registered: bool,
    seeded: bool,
    outcome: Option<Outcome>,
    pool_yes: u128,
    pool_no: u128,
    locked: u128,
    user_yes: u128,
    user_no: u128,
    residual_claimed: bool,
    // (block time in ns, Yes price in millionths) after each seed, buy and sell.
    history: Vec<(u64, u32)>,
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
    close_at: U64,
    resolve_by: U64,
    status: String,
    registered: bool,
    outcome: Option<Outcome>,
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
    fn register_market(&mut self, market_id: U64, close_at: U64, resolve_by: U64, rule_hash: String);
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

        let hash_input = near_sdk::borsh::to_vec(&(&title, &rule_text, &resolution_source, &void_policy, close_at.0))
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
                close_at: close_at.0,
                resolve_by: resolve_by.0,
                halted: false,
                registered: false,
                seeded: false,
                outcome: None,
                pool_yes: 0,
                pool_no: 0,
                locked: 0,
                user_yes: 0,
                user_no: 0,
                residual_claimed: false,
                history: vec![],
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

    // After resolution the owner takes the pool's leftover collateral. Users' payouts stay reserved.
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
        self.credit(&self.owner.clone(), residual);
        emit("residual_claimed", json!({ "market_id": market_id.0.to_string(), "amount": residual.to_string() }));
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
                m.outcome = Some(outcome);
                self.markets.insert(market_id.0, m);
                emit("outcome_set", json!({ "market_id": market_id.0.to_string(), "outcome": outcome }));
            }
        }
    }

    // Safety net so money is never stuck: if no answer has been applied by resolve_by, anyone can void the
    // market and every holder redeems half a unit per share. The oracle refuses proposals that could not
    // finish before resolve_by, so this cannot cut across a case that is still running.
    pub fn void_if_unresolved(&mut self, market_id: U64) {
        let mut m = self.market(market_id.0);
        require!(m.outcome.is_none(), "already resolved");
        require!(env::block_timestamp() >= m.resolve_by, "the answer deadline has not passed");
        m.outcome = Some(Outcome::Void);
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
            Some("seed") => {
                require!(sender_id == self.owner || sender_id == self.operator, "operator or owner only");
                let id: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("bad market id"));
                self.seed(id, amount.0);
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
        let (fee, shares_in, new_target, new_other) = curve::sell_after_fee(target, other, collateral_out.0, FEE_RATE_BPS)
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
            Outcome::Void => (yes + no) / 2,
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
                "max_positions": MAX_POSITIONS, "fee_rate_bps": FEE_RATE_BPS as u32, "create_fee": CREATE_FEE.to_string(),
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
        match curve::buy_after_fee(target, other, amount.0, FEE_RATE_BPS) {
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
        match curve::sell_after_fee(target, other, c, FEE_RATE_BPS) {
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
    fn record_price(&mut self) {
        let price = curve::price_micro(self.pool_yes, self.pool_no) as u32;
        self.history.push((env::block_timestamp(), price));
        if self.history.len() > HISTORY_MAX {
            self.history.remove(0);
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
            .register_market(U64(id), U64(m.close_at), U64(m.resolve_by), m.rule_hash)
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
            Outcome::Void => (m.user_yes + m.user_no) / 2,
        }
    }

    // The creation fee comes out of the seed transfer, the one payment every market makes before it can trade.
    fn seed(&mut self, id: u64, amount: u128) {
        require!(!self.paused, "paused");
        let mut m = self.market(id);
        require!(m.registered, "market is not registered with the oracle yet");
        require!(!m.seeded, "already seeded");
        require!(amount > CREATE_FEE, "the seed must be more than the creation fee");
        let amount = amount - CREATE_FEE;
        require!(amount <= MAX_POOL, "seed too large");
        m.pool_yes = amount;
        m.pool_no = amount;
        m.locked = amount;
        m.seeded = true;
        m.record_price();
        self.markets.insert(id, m);
        self.fees += CREATE_FEE;
        emit("market_seeded", json!({ "market_id": id.to_string(), "amount": amount.to_string(), "fee": CREATE_FEE.to_string() }));
    }

    // Spend `amount` that has already left the buyer's balance (or arrived by ft_transfer_call). The fee comes out
    // of it first and only the rest enters the market.
    fn buy_with(&mut self, who: &AccountId, id: u64, idx: u8, amount: u128, min_out: u128) {
        require!(!self.paused, "paused");
        require!(self.accounts.contains_key(who), "do the storage deposit first");
        require!(min_out > 0, "min shares must be above zero");
        let mut m = self.open_market(id);
        let (target, other) = if idx == 0 { (m.pool_yes, m.pool_no) } else { (m.pool_no, m.pool_yes) };
        let (fee, out, new_target, new_other) = curve::buy_after_fee(target, other, amount, FEE_RATE_BPS)
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
            close_at: U64(m.close_at),
            resolve_by: U64(m.resolve_by),
            status: status.to_string(),
            registered: m.registered,
            outcome: m.outcome,
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
            rule_hash: String::new(), close_at: 0, resolve_by: 0, halted: false, registered: true, seeded: true,
            outcome: None, pool_yes: 100, pool_no: 100, locked: 100, user_yes: 0, user_no: 0, residual_claimed: false,
            history: vec![],
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
            c.create_market("t".into(), "r".into(), "s".into(), "v".into(), "sports".into(), "nfl".into(), U64(CLOSE), U64(RESOLVE_BY));
        }
        // Skip the oracle round trip: mark both as registered.
        for id in 0..2 {
            let mut m = c.market(id);
            m.registered = true;
            c.markets.insert(id, m);
        }
        act_as(TOKEN, 2);
        for id in 0..2u64 {
            let _ = c.ft_on_transfer(acct(OWNER), U128(SEED_UNITS), format!("seed:{id}"));
        }
        for u in USERS {
            c.accounts.insert(acct(u), 0);
        }
        (c, 2 * SEED_UNITS)
    }

    fn holdings(c: &PmMarket, id: u64, who: &str) -> (u128, u128) {
        let (y, n) = c.get_shares(U64(id), acct(who));
        (y.0, n.0)
    }

    // Every token the contract has received is locked in a market, sitting in someone's balance, or a fee.
    fn assert_conserved(c: &PmMarket, total_in: u128) {
        let locked: u128 = (0..2).map(|id| c.market(id).locked).sum();
        let balances: u128 = USERS.iter().chain([&OWNER]).map(|u| c.get_balance(acct(u)).0).sum();
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
                    prop_assert!(left <= USERS.len() as u128, "too much collateral stranded after a void: {}", left);
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
        assert_eq!(c.fees, 2 * CREATE_FEE, "each seed paid the creation fee");
        let q = c.quote_buy(U64(0), "yes".into(), U128(10_000_000));
        act_as(TOKEN, 3);
        let _ = c.ft_on_transfer(acct(USERS[0]), U128(10_000_000), "buy:0:yes:1".into());
        assert_eq!(holdings(&c, 0, USERS[0]).0, q.shares_out.0);
        assert_eq!(c.fees, 2 * CREATE_FEE + q.fee.0);
        assert_eq!(c.market(0).locked, SEED_UNITS - CREATE_FEE + 10_000_000 - q.fee.0);

        let s = c.quote_sell(U64(0), "yes".into(), q.shares_out);
        act_as(USERS[0], 4);
        c.sell(U64(0), "yes".into(), s.collateral_out, q.shares_out);
        assert_eq!(c.get_balance(acct(USERS[0])).0, s.collateral_out.0 - s.fee.0);
        assert_eq!(c.fees, 2 * CREATE_FEE + q.fee.0 + s.fee.0);
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
    fn after_the_deadline_anyone_can_void_and_holders_get_half_a_unit_per_share() {
        let (mut c, mut total_in) = world();
        step(&mut c, &mut total_in, 0, 0, 0, 10_000_000, 1); // ann buys Yes
        step(&mut c, &mut total_in, 1, 1, 0, 10_000_000, 1); // ben buys No
        act_as(USERS[2], RESOLVE_BY); // a stranger
        c.void_if_unresolved(U64(0));
        assert_eq!(c.market(0).outcome, Some(Outcome::Void));
        let (ann_yes, _) = holdings(&c, 0, USERS[0]);
        act_as(USERS[0], RESOLVE_BY + 1);
        assert_eq!(c.redeem(U64(0)).0, ann_yes / 2);
        assert_conserved(&c, total_in);
    }

    #[test]
    #[should_panic(expected = "text is too long")]
    fn oversized_market_text_is_refused() {
        let (mut c, _) = world();
        act_as(OWNER, 5);
        c.create_market("t".into(), "x".repeat(MAX_RULE + 1), "s".into(), "v".into(), "sports".into(), "nfl".into(), U64(CLOSE), U64(RESOLVE_BY));
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
        let id: U64 = c.create_market("t".into(), "r".into(), "s".into(), "v".into(), "sports".into(), "nfl".into(), U64(CLOSE), U64(RESOLVE_BY));
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
