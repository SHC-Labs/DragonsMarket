// Resolution contract for the pitch test. Someone proposes an outcome with a bond, there is a
// challenge window, and a challenge sends the case to a jury drawn from the Council registry that votes
// in two steps, a hidden commitment and then the reveal. Final outcomes are written to the market
// contract, which only trusts this contract.
// The JSON interface takes one argument per field, so a few methods are long on purpose.
#![allow(clippy::too_many_arguments)]

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, CurveType, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_APPLY: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
// Measured against the Council's seat cap; see the note on PmCouncil.
const GAS_DRAW: Gas = Gas::from_tgas(250);
const GAS_DRAWN: Gas = Gas::from_tgas(15);
// unlock_case burned 8.9 TGas for a 21 juror case where every juror forfeits revenue, the most work it can do
// (measured in the sandbox), so 15 leaves room. A settling call needs about 55 TGas attached in all.
const GAS_UNLOCK: Gas = Gas::from_tgas(15);
const NS_PER_MS: u64 = 1_000_000;
// Settling a case still takes one more cross-contract hop (apply) to reach the market. Without this, a
// case that used its full allotted time could have its real outcome raced by a permissionless
// void_if_unresolved call landing in the gap between settle() and apply() taking effect.
const APPLY_BUFFER_NS: u64 = 30_000_000_000;
// Text limits (bytes). Records are paid for out of this contract's own balance, so they must be bounded.
const MAX_EVIDENCE: usize = 512;
const MAX_REASON: usize = 1000;
const MAX_PANEL: usize = 21;
const MAX_SALT: usize = 64;
// A submission with all 10 signing burned 4.5 TGas in this contract, 9.4 in all, and worked with 30 TGas attached
// (measured in the sandbox).
const MAX_PUBLISHERS: usize = 10;
// Of the loser's bond in a decided dispute, the share the jurors who revealed and sat with the majority split.
// The rest goes to the winner.
const JUROR_SHARE_BPS: u128 = 2_500;

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Markets,
    Cases,
    Claimable,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Yes,
    No,
    Void,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Proposed,
    Disputed,
    Final,
}

impl Outcome {
    fn word(self) -> &'static str {
        match self {
            Outcome::Yes => "yes",
            Outcome::No => "no",
            Outcome::Void => "void",
        }
    }
}

// Set by pm-market when it creates a price market, so the oracle knows what to check a signed price against.
// Yes if the price is at or above strike when `above` is true, Yes if it is below strike otherwise. strike and the
// signed price are integers scaled by 10^decimals.
#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PriceRule {
    observation_time: U64,
    strike: U128,
    decimals: u8,
    above: bool,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct MarketInfo {
    close_at: U64,
    resolve_by: U64,
    rule_hash: String,
    price_rule: Option<PriceRule>,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Vote {
    juror: AccountId,
    outcome: Outcome,
    reason: String,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Commit {
    juror: AccountId,
    commitment: String,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Case {
    stage: Stage,
    proposer: AccountId,
    proposed: Outcome,
    evidence: String,
    window_ends_at: U64,
    challenger: Option<AccountId>,
    panel_deadline: U64,
    // The jurors for this case, drawn once after the challenge. Changing the Council later never touches an open case.
    panel: Vec<AccountId>,
    // Revealed votes only.
    votes: Vec<Vote>,
    final_outcome: Option<Outcome>,
    applied: bool,
    challenged_at: U64,
    draw_after_height: U64,
    commit_ends_at: U64,
    commits: Vec<Commit>,
    // Set when a disputed case settles: the drawn jurors who did not vote. The Council takes the revenue their seats
    // earned while serving. Kept on the case so retry_unlock sends the same list.
    delinquent: Vec<AccountId>,
}

#[ext_contract(ext_ft)]
pub trait FtCore {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_market)]
pub trait Market {
    fn set_outcome(&mut self, market_id: U64, outcome: Outcome);
}

#[ext_contract(ext_council)]
pub trait Council {
    fn draw(&mut self, case_key: U64, seed: Vec<u8>, n: u32, exclude: Vec<AccountId>) -> Vec<AccountId>;
    fn unlock_case(&mut self, case_key: U64, delinquent: Vec<AccountId>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PmOracle {
    owner: AccountId,
    // Set by propose_owner. Ownership moves only when this account calls accept_owner.
    pending_owner: Option<AccountId>,
    // The fast key for protective changes: it can remove a price publisher at once. Adding one, and changing how many
    // must agree, stay with the owner, which is governance.
    operator: AccountId,
    market: AccountId,
    bond_token: AccountId,
    bond: u128,
    window_ns: u64,
    panel_deadline_ns: u64,
    // The least time a market must leave after close_at for someone to notice it closed and propose, on top of
    // the time a case needs to finish. register_market refuses markets with less, because they could only end in Void.
    min_proposal_ns: u64,
    council: AccountId,
    jury_size: u32,
    draw_delay_blocks: u64,
    // The network this contract runs on, signed into every price so a price signed for testnet is no use on mainnet.
    network: String,
    // The keys that sign prices, and how many of them must sign the same price for it to count.
    publishers: Vec<PublicKey>,
    price_threshold: u32,
    markets: LookupMap<u64, MarketInfo>,
    cases: LookupMap<u64, Case>,
    // Bonds waiting to be withdrawn, by account.
    claimable: LookupMap<AccountId, u128>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "pm-oracle", "version": "1.0.0", "event": event, "data": data })
    ));
}

fn valid_jury_size(n: u32) -> bool {
    n % 2 == 1 && n as usize <= MAX_PANEL
}

fn distinct(accounts: &[AccountId]) -> bool {
    let mut seen: Vec<&AccountId> = accounts.iter().collect();
    seen.sort();
    seen.dedup();
    seen.len() == accounts.len()
}

fn commitment_of(juror: &AccountId, outcome: Outcome, salt: &str) -> String {
    env::sha256_array(format!("{juror}:{}:{salt}", outcome.word())).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_commitment(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// The drawn jurors who did not vote: those who never committed, and, once the reveal window is over, those who
// committed and never revealed. A case that settles early on a majority leaves the other committed jurors no chance
// to reveal, so while the window is still open they are not counted.
fn delinquent_jurors(case: &Case, now: u64) -> Vec<AccountId> {
    case.panel
        .iter()
        .filter(|j| {
            let revealed = case.votes.iter().any(|v| v.juror == **j);
            let committed = case.commits.iter().any(|c| c.juror == **j);
            !revealed && (!committed || now > case.panel_deadline.0)
        })
        .cloned()
        .collect()
}

// What a publisher signs: this contract and network, the market, its observation time, the price and its decimals.
// Everything but the price is fixed by the market, so one signature is good for exactly one price of one market.
fn price_message(contract: &AccountId, network: &str, market_id: u64, rule: &PriceRule, price: u128) -> String {
    format!("pm-price:v1:{contract}:{network}:{market_id}:{}:{price}:{}", rule.observation_time.0, rule.decimals)
}

fn decode_signature(hex: &str) -> [u8; 64] {
    require!(hex.len() == 128 && hex.is_ascii(), "a signature is 128 hex characters");
    let mut signature = [0u8; 64];
    for (i, byte) in signature.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("a signature is hex"));
    }
    signature
}

fn parse_outcome(s: &str) -> Outcome {
    match s {
        "yes" => Outcome::Yes,
        "no" => Outcome::No,
        "void" => Outcome::Void,
        _ => env::panic_str("outcome must be yes, no or void"),
    }
}

#[near]
impl PmOracle {
    #[init]
    pub fn new(
        owner_id: AccountId,
        market_contract: AccountId,
        bond_token: AccountId,
        bond: U128,
        window_ms: U64,
        panel_deadline_ms: U64,
        council: AccountId,
        jury_size: u32,
        draw_delay_blocks: U64,
        min_proposal_ms: U64,
        operator_id: AccountId,
        network: String,
        price_threshold: u32,
    ) -> Self {
        require!(bond.0 > 0, "bond must be positive");
        require!(!network.is_empty() && !network.contains(':'), "the network name must be a word without a colon");
        require!(price_threshold > 0, "at least one publisher must sign a price");
        require!(window_ms.0 > 0 && panel_deadline_ms.0 > 0 && min_proposal_ms.0 > 0, "windows must be positive");
        require!(valid_jury_size(jury_size), "jury size must be odd and at most 21");
        Self {
            owner: owner_id,
            pending_owner: None,
            operator: operator_id,
            market: market_contract,
            bond_token,
            bond: bond.0,
            window_ns: window_ms.0 * NS_PER_MS,
            panel_deadline_ns: panel_deadline_ms.0 * NS_PER_MS,
            min_proposal_ns: min_proposal_ms.0 * NS_PER_MS,
            council,
            jury_size,
            draw_delay_blocks: draw_delay_blocks.0,
            network,
            publishers: vec![],
            price_threshold,
            markets: LookupMap::new(Key::Markets),
            cases: LookupMap::new(Key::Cases),
            claimable: LookupMap::new(Key::Claimable),
        }
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

    // Only juries drawn after this use the new size.
    pub fn set_jury_size(&mut self, jury_size: u32) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(valid_jury_size(jury_size), "jury size must be odd and at most 21");
        self.jury_size = jury_size;
    }

    pub fn set_operator(&mut self, operator_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        emit("operator_set", json!({ "operator": operator_id }));
        self.operator = operator_id;
    }

    // Adding a publisher grants power over prices, so it is the owner's (a governance vote and its timelock).
    pub fn add_publisher(&mut self, key: PublicKey) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(key.curve_type() == CurveType::ED25519, "publishers use ed25519 keys");
        require!(!self.publishers.contains(&key), "already a publisher");
        require!(self.publishers.len() < MAX_PUBLISHERS, "there can be at most 10 publishers");
        emit("publisher_added", json!({ "key": key }));
        self.publishers.push(key);
    }

    // Removing one only ever takes power away, so the operator can do it at once: a leaked key is cut off in one call
    // instead of waiting out a vote. It can never leave fewer publishers than must sign, or no price could be accepted.
    pub fn remove_publisher(&mut self, key: PublicKey) {
        let who = env::predecessor_account_id();
        require!(who == self.operator || who == self.owner, "operator or owner only");
        let at = self.publishers.iter().position(|k| *k == key).unwrap_or_else(|| env::panic_str("not a publisher"));
        require!(self.publishers.len() > self.price_threshold as usize, "that would leave fewer publishers than must sign");
        emit("publisher_removed", json!({ "key": key, "by": who }));
        self.publishers.remove(at);
    }

    pub fn set_price_threshold(&mut self, threshold: u32) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(threshold > 0 && threshold as usize <= self.publishers.len(), "the threshold must be between 1 and the number of publishers");
        emit("price_threshold_set", json!({ "threshold": threshold }));
        self.price_threshold = threshold;
    }

    // Called by the market contract when a market is created. Calling twice changes nothing. A market that
    // leaves less than min_resolve_gap_ns between close_at and resolve_by is refused: no case could ever finish
    // in it, so the only way it could end is a Void at its deadline, which pays the cheap side a windfall.
    // A price market is measured from its observation time, the moment its answer is first known, and needs enough
    // publishers configured that it can be answered at all.
    pub fn register_market(&mut self, market_id: U64, close_at: U64, resolve_by: U64, rule_hash: String, price_rule: Option<PriceRule>) {
        require!(env::predecessor_account_id() == self.market, "market contract only");
        if self.markets.contains_key(&market_id.0) {
            return;
        }
        let answerable_from = match &price_rule {
            Some(rule) => {
                require!(self.publishers.len() >= self.price_threshold as usize, "not enough price publishers are configured");
                require!(rule.observation_time.0 >= close_at.0, "observation_time must not be before close_at");
                rule.observation_time.0
            }
            None => close_at.0,
        };
        require!(
            resolve_by.0.saturating_sub(answerable_from) >= self.min_resolve_gap_ns(),
            "resolve_by is too soon after close_at for a case to finish"
        );
        self.markets.insert(market_id.0, MarketInfo { close_at, resolve_by, rule_hash, price_rule });
        emit("market_registered", json!({ "market_id": market_id.0.to_string() }));
    }

    // Bonds arrive here. Propose: "propose:<market>:<yes|no|void>:<evidence url>". Challenge: "challenge:<market>".
    // Answer a price market: "price:<market>:<price>:<publisher key>.<signature hex>,<publisher key>.<signature hex>,...".
    // Panicking makes the token refund the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.bond_token, "wrong token");
        require!(amount.0 == self.bond, "send exactly the bond");
        let mut parts = msg.splitn(4, ':');
        let action = parts.next().unwrap_or("");
        let id: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("bad market id"));
        match action {
            "propose" => {
                let outcome = parse_outcome(parts.next().unwrap_or(""));
                let evidence = parts.next().unwrap_or("").to_string();
                let is_price_market = self.markets.get(&id).is_some_and(|m| m.price_rule.is_some());
                require!(!is_price_market, "a price market is answered with a signed price");
                self.propose(sender_id, id, outcome, evidence);
            }
            "price" => {
                let price: u128 = parts.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("bad price"));
                self.answer_price(sender_id, id, price, parts.next().unwrap_or(""));
            }
            "challenge" => self.challenge(sender_id, id),
            _ => env::panic_str("unknown action"),
        }
        PromiseOrValue::Value(U128(0))
    }

    // Anyone can call this once the draw delay has passed. The seed comes from a block after the challenge,
    // so nobody knows the jury when they challenge. A failed draw changes nothing and can be retried.
    pub fn resolve_draw(&mut self, market_id: U64) -> Promise {
        let case = self.case(market_id.0);
        require!(case.stage == Stage::Disputed, "no open dispute");
        require!(case.panel.is_empty(), "the jury is already drawn");
        require!(env::block_height() >= case.draw_after_height.0, "too early to draw the jury");
        require!(env::block_timestamp() < case.commit_ends_at.0, "too late to draw a jury");
        let challenger = case.challenger.unwrap_or_else(|| env::panic_str("no challenger"));
        ext_council::ext(self.council.clone())
            .with_static_gas(GAS_DRAW)
            .draw(market_id, env::random_seed(), self.jury_size, vec![case.proposer, challenger])
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_DRAWN).on_drawn(market_id))
    }

    // Two draws can be in flight at once. The first good one to land is the jury.
    #[private]
    pub fn on_drawn(&mut self, market_id: U64, #[callback_result] result: Result<Vec<AccountId>, PromiseError>) {
        let mut case = self.case(market_id.0);
        match result {
            Ok(jury)
                if case.stage == Stage::Disputed
                    && case.panel.is_empty()
                    && jury.len() == self.jury_size as usize
                    && distinct(&jury) =>
            {
                emit("jury_drawn", json!({ "market_id": market_id.0.to_string(), "panel": jury }));
                case.panel = jury;
                self.cases.insert(market_id.0, case);
            }
            _ => emit("draw_failed", json!({ "market_id": market_id.0.to_string() })),
        }
    }

    // A juror's vote stays hidden until the commit phase ends. The commitment is
    // hex(sha256("<juror>:<yes|no|void>:<salt>")), so one juror cannot reuse another's.
    pub fn commit_vote(&mut self, market_id: U64, commitment: String) {
        let juror = env::predecessor_account_id();
        let mut case = self.case(market_id.0);
        require!(case.panel.contains(&juror), "not on the panel for this case");
        require!(case.stage == Stage::Disputed, "no open dispute");
        require!(env::block_timestamp() < case.commit_ends_at.0, "the commit phase is over");
        require!(is_commitment(&commitment), "commitment must be 64 lowercase hex characters");
        require!(!case.commits.iter().any(|c| c.juror == juror), "already committed");
        case.commits.push(Commit { juror: juror.clone(), commitment: commitment.clone() });
        self.cases.insert(market_id.0, case);
        emit("vote_committed", json!({ "market_id": market_id.0.to_string(), "juror": juror, "commitment": commitment }));
    }

    // ponytail: a juror who commits and never reveals just does not count. The penalty for a no-show
    // moves into the Council registry with staking in slice 2.
    pub fn reveal_vote(&mut self, market_id: U64, outcome: Outcome, salt: String, reason: String) {
        let juror = env::predecessor_account_id();
        require!(!reason.trim().is_empty(), "a reason is required");
        require!(reason.len() <= MAX_REASON, "reason is too long");
        require!(salt.len() <= MAX_SALT, "salt is too long");
        let mut case = self.case(market_id.0);
        let commit = case.commits.iter().find(|c| c.juror == juror).unwrap_or_else(|| env::panic_str("no commitment to reveal"));
        require!(case.stage == Stage::Disputed, "no open dispute");
        let now = env::block_timestamp();
        require!(now >= case.commit_ends_at.0, "the commit phase is still open");
        require!(now <= case.panel_deadline.0, "the panel deadline passed");
        require!(!case.votes.iter().any(|v| v.juror == juror), "already revealed");
        require!(commit.commitment == commitment_of(&juror, outcome, &salt), "the vote does not match the commitment");
        case.votes.push(Vote { juror: juror.clone(), outcome, reason: reason.clone() });
        emit(
            "vote_revealed",
            json!({ "market_id": market_id.0.to_string(), "juror": juror, "outcome": outcome, "reason": reason }),
        );

        let needed = case.panel.len() / 2 + 1;
        let winner = [Outcome::Yes, Outcome::No, Outcome::Void]
            .into_iter()
            .find(|o| case.votes.iter().filter(|v| v.outcome == *o).count() >= needed);
        self.cases.insert(market_id.0, case);
        if let Some(w) = winner {
            self.settle(market_id.0, w);
        }
    }

    // Anyone can call this. Settles an unchallenged proposal after its window, or a dispute the panel
    // did not decide in time (that resolves Void and returns both bonds).
    pub fn finalize(&mut self, market_id: U64) {
        let case = self.case(market_id.0);
        let now = env::block_timestamp();
        match case.stage {
            Stage::Proposed => {
                require!(now >= case.window_ends_at.0, "challenge window is still open");
                self.settle(market_id.0, case.proposed);
            }
            Stage::Disputed => {
                require!(now > case.panel_deadline.0, "the panel still has time");
                self.settle(market_id.0, Outcome::Void);
            }
            Stage::Final => env::panic_str("already final"),
        }
    }

    // Writing the answer to the market is a separate call and can fail. Anyone can retry it.
    pub fn retry_apply(&mut self, market_id: U64) {
        let case = self.case(market_id.0);
        require!(case.stage == Stage::Final && !case.applied, "nothing to apply");
        let outcome = case.final_outcome.unwrap_or_else(|| env::panic_str("no final outcome"));
        self.apply(market_id.0, outcome);
    }

    // settle() sends unlock_case once and nothing waits for it, so if that call ever fails the jurors' seats stay
    // locked. Anyone can send it again. The council ignores a case it has already released, so repeating it is
    // harmless. It takes whatever gas the caller attaches, so a retry is never capped below what the unlock needs.
    pub fn retry_unlock(&mut self, market_id: U64) -> Promise {
        let case = self.case(market_id.0);
        require!(case.stage == Stage::Final && case.challenger.is_some(), "no settled dispute to unlock");
        ext_council::ext(self.council.clone()).unlock_case(market_id, case.delinquent)
    }

    #[private]
    pub fn on_applied(&mut self, market_id: U64, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_ok() {
            let mut case = self.case(market_id.0);
            case.applied = true;
            self.cases.insert(market_id.0, case);
            emit("outcome_applied", json!({ "market_id": market_id.0.to_string() }));
        }
    }

    #[payable]
    pub fn withdraw_bond(&mut self) -> Promise {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let amount = self.claimable.get(&who).copied().unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        // Zero it before the transfer; restore it in the callback if the transfer fails.
        self.claimable.remove(&who);
        ext_ft::ext(self.bond_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(who.clone(), U128(amount), None)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_bond_withdrawn(who, U128(amount)))
    }

    #[private]
    pub fn on_bond_withdrawn(&mut self, account: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.add_claimable(&account, amount.0);
        }
    }

    // ---- views ----------------------------------------------------------------------------

    pub fn get_case(&self, market_id: U64) -> Option<Case> {
        self.cases.get(&market_id.0).cloned()
    }

    pub fn get_market_info(&self, market_id: U64) -> Option<MarketInfo> {
        self.markets.get(&market_id.0).cloned()
    }

    pub fn claimable_of(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "owner": self.owner, "pending_owner": self.pending_owner, "market": self.market, "bond_token": self.bond_token,
                "bond": self.bond.to_string(), "window_ns": self.window_ns.to_string(),
                "panel_deadline_ns": self.panel_deadline_ns.to_string(), "council": self.council,
                "jury_size": self.jury_size, "draw_delay_blocks": self.draw_delay_blocks.to_string(),
                "min_proposal_ns": self.min_proposal_ns.to_string(),
                "min_resolve_gap_ns": self.min_resolve_gap_ns().to_string(), "operator": self.operator,
                "network": self.network, "publishers": self.publishers, "price_threshold": self.price_threshold })
    }
}

// ---- private helpers ----------------------------------------------------------------------

impl PmOracle {
    // Anyone can answer a price market with a price that enough publishers signed for this market and its observation
    // time. The answer then goes through the same bond, challenge window and jury as any other, so a wrong price that
    // enough publishers signed can still be challenged. There is no staleness limit: each signature covers exactly the
    // observation time, so a publisher that was down at that moment can sign the price later.
    fn answer_price(&mut self, proposer: AccountId, id: u64, price: u128, signatures: &str) {
        let info = self.markets.get(&id).cloned().unwrap_or_else(|| env::panic_str("market is not registered"));
        let rule = info.price_rule.unwrap_or_else(|| env::panic_str("not a price market"));
        require!(env::block_timestamp() >= rule.observation_time.0, "the observation time has not come");
        let message = price_message(&env::current_account_id(), &self.network, id, &rule, price);
        let signers = self.verified_signers(&message, signatures);
        require!(signers >= self.price_threshold as usize, "not enough valid publisher signatures");
        let outcome = if (price >= rule.strike.0) == rule.above { Outcome::Yes } else { Outcome::No };
        self.propose(proposer, id, outcome, format!("signed price {price} by {signers} publishers"));
    }

    // How many different publishers signed `message`. Any entry that is malformed, from a key that is not a
    // publisher, repeated, or that does not verify refuses the whole submission.
    fn verified_signers(&self, message: &str, signatures: &str) -> usize {
        let mut seen: Vec<PublicKey> = vec![];
        for entry in signatures.split(',') {
            let (key, signature) = entry.rsplit_once('.').unwrap_or_else(|| env::panic_str("a signature is <publisher key>.<hex>"));
            let key: PublicKey = key.parse().unwrap_or_else(|_| env::panic_str("bad publisher key"));
            require!(self.publishers.contains(&key), "not a publisher");
            require!(!seen.contains(&key), "a publisher signed twice");
            let raw: [u8; 32] = key.as_bytes()[1..].try_into().unwrap_or_else(|_| env::panic_str("publishers use ed25519 keys"));
            require!(env::ed25519_verify(&decode_signature(signature), message.as_bytes(), &raw), "a signature does not match");
            seen.push(key);
        }
        seen.len()
    }

    // The least a market must leave between close_at and resolve_by: time to propose, then a full challenge
    // window and panel deadline, then room for apply() to land (see APPLY_BUFFER_NS).
    fn min_resolve_gap_ns(&self) -> u64 {
        self.min_proposal_ns + self.window_ns + self.panel_deadline_ns + APPLY_BUFFER_NS
    }

    fn case(&self, id: u64) -> Case {
        self.cases.get(&id).cloned().unwrap_or_else(|| env::panic_str("no case for that market"))
    }

    fn add_claimable(&mut self, who: &AccountId, amount: u128) {
        let have = self.claimable.get(who).copied().unwrap_or(0);
        self.claimable.insert(who.clone(), have + amount);
    }

    fn propose(&mut self, proposer: AccountId, id: u64, outcome: Outcome, evidence: String) {
        let info = self.markets.get(&id).cloned().unwrap_or_else(|| env::panic_str("market is not registered"));
        let now = env::block_timestamp();
        require!(now >= info.close_at.0, "the market has not closed yet");
        require!(evidence.len() <= MAX_EVIDENCE, "evidence link is too long");
        // A case must be able to finish, challenge and panel included, with room left for apply() to land,
        // before the market can be voided for lack of an answer.
        require!(
            now + self.window_ns + self.panel_deadline_ns + APPLY_BUFFER_NS <= info.resolve_by.0,
            "too late to propose, the market will be voided at its deadline"
        );
        require!(!self.cases.contains_key(&id), "an answer was already proposed");
        let window_ends_at = U64(now + self.window_ns);
        self.cases.insert(
            id,
            Case {
                stage: Stage::Proposed,
                proposer: proposer.clone(),
                proposed: outcome,
                evidence: evidence.clone(),
                window_ends_at,
                challenger: None,
                panel_deadline: U64(0),
                panel: vec![],
                votes: vec![],
                final_outcome: None,
                applied: false,
                challenged_at: U64(0),
                draw_after_height: U64(0),
                commit_ends_at: U64(0),
                commits: vec![],
                delinquent: vec![],
            },
        );
        emit(
            "proposed",
            json!({ "market_id": id.to_string(), "proposer": proposer, "outcome": outcome, "evidence": evidence,
                    "window_ends_at": window_ends_at.0.to_string() }),
        );
    }

    fn challenge(&mut self, challenger: AccountId, id: u64) {
        let mut case = self.case(id);
        require!(case.stage == Stage::Proposed, "nothing to challenge");
        require!(env::block_timestamp() < case.window_ends_at.0, "the challenge window closed");
        require!(challenger != case.proposer, "you cannot challenge your own answer");
        let now = env::block_timestamp();
        case.stage = Stage::Disputed;
        case.challenger = Some(challenger.clone());
        case.challenged_at = U64(now);
        case.panel_deadline = U64(now + self.panel_deadline_ns);
        case.commit_ends_at = U64(now + self.panel_deadline_ns / 2);
        case.draw_after_height = U64(env::block_height() + self.draw_delay_blocks);
        let deadline = case.panel_deadline.0;
        self.cases.insert(id, case);
        emit(
            "challenged",
            json!({ "market_id": id.to_string(), "challenger": challenger, "panel_deadline": deadline.to_string() }),
        );
    }

    // Fix the outcome, hand out bonds, then tell the market. State changes first, call last.
    fn settle(&mut self, id: u64, outcome: Outcome) {
        let mut case = self.case(id);
        case.stage = Stage::Final;
        case.final_outcome = Some(outcome);
        let disputed = case.challenger.is_some();
        if disputed {
            case.delinquent = delinquent_jurors(&case, env::block_timestamp());
        }
        let proposer = case.proposer.clone();
        let challenger = case.challenger.clone();
        let proposed = case.proposed;
        // Jurors who revealed and sat with the final outcome. A majority of the jury is what decides a dispute, so
        // anything short of that, a timeout above all, is a dispute nobody won.
        let majority: Vec<AccountId> = case.votes.iter().filter(|v| v.outcome == outcome).map(|v| v.juror.clone()).collect();
        let decided = disputed && majority.len() > case.panel.len() / 2;
        let delinquent = case.delinquent.clone();
        self.cases.insert(id, case);

        let bond = self.bond;
        let mut juror_pay = 0;
        match challenger {
            None => self.add_claimable(&proposer, bond),
            // The jury did not decide in time: nobody lost, so both get their own bond back.
            Some(c) if !decided => {
                self.add_claimable(&proposer, bond);
                self.add_claimable(&c, bond);
            }
            // The loser's bond: a quarter shared by the majority jurors, the rest to the winner with the winner's own
            // bond. The division rounds down and the winner keeps the remainder, so the two bonds are paid out exactly.
            Some(c) => {
                let winner = if outcome == proposed { proposer } else { c };
                let pool = bond * JUROR_SHARE_BPS / 10_000;
                juror_pay = pool / majority.len() as u128;
                for juror in &majority {
                    self.add_claimable(juror, juror_pay);
                }
                self.add_claimable(&winner, 2 * bond - juror_pay * majority.len() as u128);
            }
        }
        emit(
            "final",
            json!({ "market_id": id.to_string(), "outcome": outcome, "juror_pay_each": juror_pay.to_string(),
                    "paid_jurors": if decided { majority } else { vec![] }, "delinquent": delinquent }),
        );
        self.apply(id, outcome);
        // Lets the jury unstake. Nothing waits on it: if it fails, retry_unlock sends it again.
        if disputed {
            let _ = ext_council::ext(self.council.clone()).with_static_gas(GAS_UNLOCK).unlock_case(U64(id), delinquent);
        }
    }

    fn apply(&self, id: u64, outcome: Outcome) {
        let _ = ext_market::ext(self.market.clone())
            .with_static_gas(GAS_APPLY)
            .set_outcome(U64(id), outcome)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_applied(U64(id)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const OWNER: &str = "owner.near";
    const OPERATOR: &str = "ops.near";
    const MARKET: &str = "market.near";
    const TOKEN: &str = "token.near";
    const COUNCIL: &str = "council.near";
    const NETWORK: &str = "testnet";

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn act_as(who: &str, now_ns: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acct(who)).block_timestamp(now_ns).build());
    }

    fn fresh_oracle() -> PmOracle {
        oracle_with_bond(1)
    }

    fn oracle_with_bond(bond: u128) -> PmOracle {
        oracle_with(bond, 2)
    }

    fn oracle_with(bond: u128, price_threshold: u32) -> PmOracle {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as(OWNER, 0);
        PmOracle::new(
            acct(OWNER), acct(MARKET), acct(TOKEN), U128(bond), U64(60_000), U64(120_000), acct(COUNCIL), 3, U64(2), U64(60_000),
            acct(OPERATOR), NETWORK.to_string(), price_threshold,
        )
    }

    // window + panel_deadline = 60s + 120s, so a case that used its full allotted time settles at that mark.
    // propose() must leave APPLY_BUFFER_NS of real room after that before it will accept the market's resolve_by.
    // The market is written straight into storage: register_market would refuse one this tight, and propose()
    // still has to hold for a market that was fine when created and is proposed on late.
    fn oracle_with_resolve_by(resolve_by_ns: u64) -> PmOracle {
        let mut o = fresh_oracle();
        o.markets.insert(0, MarketInfo { close_at: U64(0), resolve_by: U64(resolve_by_ns), rule_hash: "hash".to_string(), price_rule: None });
        o
    }

    const WINDOW_PLUS_PANEL: u64 = 180_000_000_000;
    // The 60s proposal period the oracle above is deployed with, on top of window, panel and apply buffer.
    const MIN_GAP: u64 = 60_000_000_000 + WINDOW_PLUS_PANEL + APPLY_BUFFER_NS;


    // ---- what a settled dispute pays, and who is delinquent -------------------------------------------

    const BOND: u128 = 5_000_000;
    const DEADLINE: u64 = 120_000_000_000;
    const JURORS: [&str; 3] = ["j0.near", "j1.near", "j2.near"];

    // A challenged case, proposed by carol and challenged by dave, with a jury of three. `commits` and `votes` are
    // who committed and who revealed what.
    fn disputed_case(o: &mut PmOracle, proposed: Outcome, commits: &[&str], votes: &[(&str, Outcome)]) {
        o.cases.insert(
            0,
            Case {
                stage: Stage::Disputed,
                proposer: acct("carol.near"),
                proposed,
                evidence: String::new(),
                window_ends_at: U64(0),
                challenger: Some(acct("dave.near")),
                panel_deadline: U64(DEADLINE),
                panel: JURORS.iter().map(|j| acct(j)).collect(),
                votes: votes.iter().map(|(j, outcome)| Vote { juror: acct(j), outcome: *outcome, reason: "r".into() }).collect(),
                final_outcome: None,
                applied: false,
                challenged_at: U64(0),
                draw_after_height: U64(0),
                commit_ends_at: U64(DEADLINE / 2),
                commits: commits.iter().map(|j| Commit { juror: acct(j), commitment: "c".into() }).collect(),
                delinquent: vec![],
            },
        );
    }

    // Like disputed_case, with a jury of any size.
    fn put_case_with_panel(o: &mut PmOracle, proposed: Outcome, panel: &[String], commits: &[&str], votes: &[(&str, Outcome)]) {
        disputed_case(o, proposed, commits, votes);
        let mut case = o.case(0);
        case.panel = panel.iter().map(|j| acct(j)).collect();
        o.cases.insert(0, case);
    }

    fn owed(o: &PmOracle, who: &str) -> u128 {
        o.claimable_of(acct(who)).0
    }

    fn unlock_call() -> Option<near_sdk::serde_json::Value> {
        near_sdk::test_utils::get_created_receipts().iter().flat_map(|r| r.actions.iter()).find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"unlock_case" => {
                Some(near_sdk::serde_json::from_slice(args).unwrap())
            }
            _ => None,
        })
    }

    // ---- attacks: randomized ---------------------------------------------------------------------------

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(400))]

        // However the jury behaves, a settled dispute pays out exactly the two bonds that were put in: not a unit more
        // (money created), not a unit less (money stuck). Only jurors who revealed and sat with a decided majority are
        // paid, a dispute nobody decided pays nobody but the bonds' owners, and the delinquent are only jurors who did not vote.
        #[test]
        fn a_settled_dispute_pays_out_exactly_the_bonds_and_only_to_those_who_earned_it(
            bond in 1u128..50_000_000,
            jury_size in prop::sample::select(vec![1usize, 3, 5, 7, 11, 21]),
            behaviour in prop::collection::vec((0u8..3, 0u8..3, any::<bool>()), 21),
            proposed in 0u8..3,
            after_deadline in any::<bool>(),
        ) {
            let outcomes = [Outcome::Yes, Outcome::No, Outcome::Void];
            let mut o = oracle_with_bond(bond);
            let jurors: Vec<String> = (0..jury_size).map(|i| format!("j{i}.near")).collect();
            // Each juror: did not commit, committed only, or committed and revealed; and what they voted.
            let mut commits = vec![];
            let mut votes = vec![];
            for (i, (kind, vote, _)) in behaviour.iter().take(jury_size).enumerate() {
                if *kind >= 1 { commits.push(jurors[i].as_str()); }
                if *kind == 2 { votes.push((jurors[i].as_str(), outcomes[*vote as usize])); }
            }
            let needed = jury_size / 2 + 1;
            let majority = outcomes.iter().copied().find(|o| votes.iter().filter(|(_, v)| v == o).count() >= needed);
            // The case settles on a majority the moment it forms, or as Void once the deadline has passed.
            let (outcome, now) = match (majority, after_deadline) {
                (Some(m), _) => (m, DEADLINE - 1),
                (None, true) => (Outcome::Void, DEADLINE + 1),
                (None, false) => return Ok(()),
            };
            put_case_with_panel(&mut o, outcomes[proposed as usize], &jurors, &commits, &votes);
            act_as("anyone.near", now);
            o.settle(0, outcome);

            let paid: u128 = jurors.iter().map(|j| owed(&o, j)).sum::<u128>() + owed(&o, "carol.near") + owed(&o, "dave.near");
            prop_assert_eq!(paid, 2 * bond, "the two bonds are paid out exactly");

            let case = o.case(0);
            let decided = majority.is_some();
            for j in &jurors {
                let revealed_with_majority = decided && votes.iter().any(|(v, out)| v == j && *out == outcome);
                if !revealed_with_majority {
                    prop_assert_eq!(owed(&o, j), 0, "{} was paid without sitting with the majority", j);
                }
            }
            if !decided {
                prop_assert_eq!((owed(&o, "carol.near"), owed(&o, "dave.near")), (bond, bond), "nobody won, so nobody lost");
            }
            // Delinquent means did not vote: never a juror who revealed.
            for d in &case.delinquent {
                prop_assert!(!votes.iter().any(|(v, _)| *v == d.as_str()), "{} revealed and is delinquent", d);
                prop_assert!(jurors.iter().any(|j| j == d.as_str()), "a delinquent juror is on the panel");
            }
            // Everyone who never committed is delinquent, however the case ended.
            for j in &jurors {
                if !commits.contains(&j.as_str()) {
                    prop_assert!(case.delinquent.iter().any(|d| d.as_str() == j), "{} never committed and is not delinquent", j);
                }
            }
        }
    }

    #[test]
    fn the_majority_jurors_share_a_quarter_of_the_losing_bond_and_the_winner_keeps_the_rest() {
        let mut o = oracle_with_bond(BOND);
        // Carol proposed Yes. j2 reveals Yes first, then j0 and j1 reveal No and settle it. Dave wins; the two No
        // jurors are paid and the Yes juror, who revealed but sat with the minority, is not.
        disputed_case(
            &mut o,
            Outcome::Yes,
            &JURORS,
            &[(JURORS[2], Outcome::Yes), (JURORS[0], Outcome::No), (JURORS[1], Outcome::No)],
        );
        act_as(JURORS[1], 100);
        o.settle(0, Outcome::No);
        assert_eq!(owed(&o, "j0.near"), 625_000);
        assert_eq!(owed(&o, "j1.near"), 625_000);
        assert_eq!(owed(&o, "j2.near"), 0, "revealed with the minority, so no pay");
        assert!(o.case(0).delinquent.is_empty(), "everyone voted");
        assert_eq!(owed(&o, "dave.near"), 2 * BOND - 1_250_000);
        assert_eq!(owed(&o, "carol.near"), 0);
    }

    #[test]
    fn when_the_proposer_wins_the_challengers_bond_is_the_one_split() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(&mut o, Outcome::Yes, &JURORS, &[(JURORS[0], Outcome::Yes), (JURORS[1], Outcome::Yes)]);
        act_as(JURORS[1], 100);
        o.settle(0, Outcome::Yes);
        assert_eq!((owed(&o, "j0.near"), owed(&o, "j1.near")), (625_000, 625_000));
        assert_eq!(owed(&o, "carol.near"), 2 * BOND - 1_250_000);
        assert_eq!(owed(&o, "dave.near"), 0);
    }

    #[test]
    fn rounding_stays_with_the_winner_so_both_bonds_are_paid_out_exactly() {
        let bond = 1_000_003;
        let mut o = oracle_with_bond(bond);
        disputed_case(&mut o, Outcome::Yes, &JURORS, &JURORS.map(|j| (j, Outcome::No)));
        act_as(JURORS[2], 100);
        o.settle(0, Outcome::No);
        // A quarter is 250,000, three ways is 83,333 each and 1 over, which the winner keeps.
        assert_eq!((owed(&o, "j0.near"), owed(&o, "j1.near"), owed(&o, "j2.near")), (83_333, 83_333, 83_333));
        let paid: u128 = ["j0.near", "j1.near", "j2.near", "carol.near", "dave.near"].iter().map(|a| owed(&o, a)).sum();
        assert_eq!(paid, 2 * bond, "nothing created or lost");
    }

    #[test]
    fn a_jury_that_votes_void_makes_the_proposer_of_another_answer_the_loser() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(&mut o, Outcome::Yes, &JURORS, &[(JURORS[0], Outcome::Void), (JURORS[1], Outcome::Void)]);
        act_as(JURORS[1], 100);
        o.settle(0, Outcome::Void);
        assert_eq!((owed(&o, "j0.near"), owed(&o, "j1.near")), (625_000, 625_000), "voting Void is paid like any other decision");
        assert_eq!((owed(&o, "dave.near"), owed(&o, "carol.near")), (2 * BOND - 1_250_000, 0));
    }

    #[test]
    fn a_dispute_the_jury_never_decided_returns_both_bonds_and_pays_no_juror() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(&mut o, Outcome::Yes, &JURORS[..2], &[(JURORS[0], Outcome::Yes), (JURORS[1], Outcome::No)]);
        act_as("anyone.near", DEADLINE + 1);
        o.settle(0, Outcome::Void);
        assert_eq!((owed(&o, "carol.near"), owed(&o, "dave.near")), (BOND, BOND));
        assert_eq!((owed(&o, "j0.near"), owed(&o, "j1.near"), owed(&o, "j2.near")), (0, 0, 0));
    }

    // Carol proposed Void herself. Nobody decided the dispute, so she must not win both bonds just because the
    // timeout resolves to the answer she proposed.
    #[test]
    fn a_timeout_does_not_hand_the_proposer_both_bonds_when_she_proposed_void() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(&mut o, Outcome::Void, &[], &[]);
        act_as("anyone.near", DEADLINE + 1);
        o.settle(0, Outcome::Void);
        assert_eq!((owed(&o, "carol.near"), owed(&o, "dave.near")), (BOND, BOND));
    }

    #[test]
    fn an_unchallenged_answer_only_returns_the_proposers_bond() {
        let mut o = oracle_with_bond(BOND);
        let mut case = {
            disputed_case(&mut o, Outcome::Yes, &[], &[]);
            o.case(0)
        };
        case.stage = Stage::Proposed;
        case.challenger = None;
        case.panel = vec![];
        o.cases.insert(0, case);
        act_as("anyone.near", 100);
        o.settle(0, Outcome::Yes);
        assert_eq!((owed(&o, "carol.near"), owed(&o, "dave.near")), (BOND, 0));
        assert!(o.case(0).delinquent.is_empty());
    }

    #[test]
    fn jurors_who_never_committed_are_delinquent_but_a_case_settled_early_does_not_blame_a_committed_juror() {
        let mut o = oracle_with_bond(BOND);
        // j0 and j1 revealed No, j2 never committed. j1's commit counts as voted. A fourth juror who committed and has
        // not revealed would still have time, so is not counted.
        disputed_case(&mut o, Outcome::Yes, &JURORS[..2], &[(JURORS[0], Outcome::No), (JURORS[1], Outcome::No)]);
        let mut case = o.case(0);
        case.panel.push(acct("j3.near"));
        case.commits.push(Commit { juror: acct("j3.near"), commitment: "c".into() });
        o.cases.insert(0, case);
        act_as(JURORS[1], DEADLINE - 1);
        o.settle(0, Outcome::No);
        assert_eq!(o.case(0).delinquent, vec![acct("j2.near")]);
        let sent = unlock_call().expect("the council is told to release the jury");
        assert_eq!(sent["delinquent"], near_sdk::serde_json::json!(["j2.near"]));
        assert_eq!(sent["case_key"], "0");
    }

    #[test]
    fn once_the_reveal_window_is_over_a_juror_who_committed_and_never_revealed_is_delinquent_too() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(&mut o, Outcome::Yes, &JURORS, &[(JURORS[0], Outcome::Yes)]);
        act_as("anyone.near", DEADLINE + 1);
        o.settle(0, Outcome::Void);
        assert_eq!(o.case(0).delinquent, vec![acct("j1.near"), acct("j2.near")]);
    }

    #[test]
    fn retry_unlock_sends_the_same_delinquent_list_again() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(&mut o, Outcome::Yes, &JURORS, &[]);
        act_as("anyone.near", DEADLINE + 1);
        o.settle(0, Outcome::Void);
        let first = unlock_call().unwrap();
        act_as("stranger.near", DEADLINE + 2);
        assert!(unlock_call().is_none(), "a new transaction starts with no receipts, so the next one is the retry's");
        let _ = o.retry_unlock(U64(0));
        assert_eq!(unlock_call().expect("the retry sends it"), first);
        assert_eq!(first["delinquent"], near_sdk::serde_json::json!(["j0.near", "j1.near", "j2.near"]));
    }


    // ---- price markets: signed prices ----------------------------------------------------------------

    const OBS: u64 = 1_000_000_000_000;
    const STRIKE: u128 = 1_000;

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn public(key: &SigningKey) -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, key.verifying_key().to_bytes().to_vec()).unwrap()
    }

    fn rule(above: bool) -> PriceRule {
        PriceRule { observation_time: U64(OBS), strike: U128(STRIKE), decimals: 2, above }
    }

    // `signer`'s entry for a submission: its key, a dot, and its signature over `message` in hex.
    fn entry(signer: &SigningKey, message: &str) -> String {
        let signature: String = signer.sign(message.as_bytes()).to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        format!("{}.{signature}", public(signer))
    }

    // What the market's own rule makes publishers sign for `price`.
    fn message(market: u64, rule: &PriceRule, price: u128) -> String {
        price_message(&env::current_account_id(), NETWORK, market, rule, price)
    }

    // Three publishers, two of whom must sign, and price market 0 observed at OBS with room to be answered.
    fn price_oracle(above: bool) -> (PmOracle, Vec<SigningKey>) {
        let mut o = oracle_with(BOND, 2);
        let keys: Vec<SigningKey> = (1..=3).map(signing_key).collect();
        act_as(OWNER, 0);
        for k in &keys {
            o.add_publisher(public(k));
        }
        act_as(MARKET, 0);
        o.register_market(U64(0), U64(OBS), U64(OBS + MIN_GAP + 10_000_000_000), "hash".to_string(), Some(rule(above)));
        (o, keys)
    }

    fn submit(o: &mut PmOracle, at: u64, price: u128, entries: &[String]) {
        act_as(TOKEN, at);
        let _ = o.ft_on_transfer(acct("carol.near"), U128(BOND), format!("price:0:{price}:{}", entries.join(",")));
    }

    fn signed_by(keys: &[&SigningKey], market: u64, rule: &PriceRule, price: u128) -> Vec<String> {
        act_as(TOKEN, 0);
        keys.iter().map(|k| entry(k, &message(market, rule, price))).collect()
    }

    #[test]
    fn two_of_three_publishers_signing_the_markets_own_price_open_a_case() {
        let (mut o, k) = price_oracle(true);
        let sigs = signed_by(&[&k[0], &k[2]], 0, &rule(true), 1_250);
        submit(&mut o, OBS, 1_250, &sigs);
        let case = o.case(0);
        assert_eq!((case.stage, case.proposed, case.proposer), (Stage::Proposed, Outcome::Yes, acct("carol.near")));
        assert_eq!(case.evidence, "signed price 1250 by 2 publishers");
    }

    #[test]
    fn the_price_decides_yes_or_no_against_the_strike_in_the_markets_direction() {
        for (above, price, expected) in [
            (true, STRIKE, Outcome::Yes),
            (true, STRIKE - 1, Outcome::No),
            (true, STRIKE + 1, Outcome::Yes),
            (false, STRIKE, Outcome::No),
            (false, STRIKE - 1, Outcome::Yes),
            (false, STRIKE + 1, Outcome::No),
        ] {
            let (mut o, k) = price_oracle(above);
            let sigs = signed_by(&[&k[0], &k[1]], 0, &rule(above), price);
            submit(&mut o, OBS, price, &sigs);
            assert_eq!(o.case(0).proposed, expected, "above={above} price={price}");
        }
    }

    #[test]
    fn a_publisher_that_was_down_at_the_observation_time_can_sign_it_later() {
        let (mut o, k) = price_oracle(true);
        let sigs = signed_by(&[&k[0], &k[1]], 0, &rule(true), 900);
        submit(&mut o, OBS + 5_000_000_000, 900, &sigs);
        assert_eq!(o.case(0).proposed, Outcome::No);
    }

    #[test]
    #[should_panic(expected = "the observation time has not come")]
    fn a_price_cannot_be_submitted_before_its_observation_time() {
        let (mut o, k) = price_oracle(true);
        let sigs = signed_by(&[&k[0], &k[1]], 0, &rule(true), 1_250);
        submit(&mut o, OBS - 1, 1_250, &sigs);
    }

    #[test]
    #[should_panic(expected = "not enough valid publisher signatures")]
    fn one_signature_is_not_enough_when_two_must_sign() {
        let (mut o, k) = price_oracle(true);
        let sigs = signed_by(&[&k[0]], 0, &rule(true), 1_250);
        submit(&mut o, OBS, 1_250, &sigs);
    }

    #[test]
    #[should_panic(expected = "a publisher signed twice")]
    fn one_publisher_signing_twice_does_not_count_twice() {
        let (mut o, k) = price_oracle(true);
        let sigs = signed_by(&[&k[0], &k[0]], 0, &rule(true), 1_250);
        submit(&mut o, OBS, 1_250, &sigs);
    }

    #[test]
    #[should_panic(expected = "not a publisher")]
    fn a_signature_from_a_key_that_is_not_a_publisher_is_refused() {
        let (mut o, k) = price_oracle(true);
        let sigs = signed_by(&[&k[0], &signing_key(99)], 0, &rule(true), 1_250);
        submit(&mut o, OBS, 1_250, &sigs);
    }

    // Each of these signs something that is not exactly this market, moment, price or contract.
    fn assert_refused_when_signed_over(signed: impl Fn(&AccountId) -> String, price_submitted: u128) {
        let (mut o, k) = price_oracle(true);
        act_as(TOKEN, 0);
        let contract = env::current_account_id();
        let message = signed(&contract);
        let sigs = vec![entry(&k[0], &message), entry(&k[1], &message)];
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| submit(&mut o, OBS, price_submitted, &sigs)));
        assert!(outcome.is_err(), "a signature over {message} must not open a case for price {price_submitted}");
        assert!(o.cases.get(&0).is_none());
    }

    #[test]
    fn a_signature_is_good_for_one_price_of_one_market_on_one_network_and_one_contract_only() {
        let r = rule(true);
        assert_refused_when_signed_over(|c| price_message(c, NETWORK, 1, &r, 1_250), 1_250); // another market
        assert_refused_when_signed_over(|c| price_message(c, "mainnet", 0, &r, 1_250), 1_250); // another network
        assert_refused_when_signed_over(|_| price_message(&acct("other.near"), NETWORK, 0, &r, 1_250), 1_250); // another contract
        assert_refused_when_signed_over(|c| price_message(c, NETWORK, 0, &PriceRule { observation_time: U64(OBS + 1), ..r }, 1_250), 1_250); // another moment
        assert_refused_when_signed_over(|c| price_message(c, NETWORK, 0, &PriceRule { decimals: 8, ..r }, 1_250), 1_250); // other decimals
        assert_refused_when_signed_over(|c| price_message(c, NETWORK, 0, &r, 1_250), 1_251); // a different price than was signed
    }

    #[test]
    #[should_panic(expected = "a price market is answered with a signed price")]
    fn a_price_market_cannot_be_answered_with_a_plain_proposal() {
        let (mut o, _) = price_oracle(true);
        act_as(TOKEN, OBS);
        let _ = o.ft_on_transfer(acct("carol.near"), U128(BOND), "propose:0:yes:https://x".to_string());
    }

    #[test]
    #[should_panic(expected = "not a price market")]
    fn an_event_market_does_not_take_a_signed_price() {
        let (mut o, k) = price_oracle(true);
        act_as(MARKET, 0);
        o.register_market(U64(1), U64(OBS), U64(OBS + MIN_GAP), "hash".to_string(), None);
        let sigs = signed_by(&[&k[0], &k[1]], 1, &rule(true), 1_250);
        act_as(TOKEN, OBS);
        let _ = o.ft_on_transfer(acct("carol.near"), U128(BOND), format!("price:1:1250:{}", sigs.join(",")));
    }

    #[test]
    #[should_panic(expected = "not enough price publishers are configured")]
    fn a_price_market_cannot_register_before_enough_publishers_exist() {
        let mut o = oracle_with(BOND, 2);
        act_as(OWNER, 0);
        o.add_publisher(public(&signing_key(1)));
        act_as(MARKET, 0);
        o.register_market(U64(0), U64(OBS), U64(OBS + MIN_GAP), "hash".to_string(), Some(rule(true)));
    }

    #[test]
    fn a_price_market_is_measured_from_its_observation_time_not_its_close() {
        let mut o = oracle_with(BOND, 1);
        act_as(OWNER, 0);
        o.add_publisher(public(&signing_key(1)));
        act_as(MARKET, 0);
        // Closes at 0 and is observed a day later, so a gap measured from the close would be huge.
        let obs = 86_400_000_000_000;
        let late = PriceRule { observation_time: U64(obs), ..rule(true) };
        o.register_market(U64(0), U64(0), U64(obs + MIN_GAP), "hash".to_string(), Some(late));
        assert!(o.get_market_info(U64(0)).is_some());
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            o.register_market(U64(1), U64(0), U64(obs + MIN_GAP - 1), "hash".to_string(), Some(late));
        }));
        assert!(caught.is_err(), "one nanosecond short of the gap after the observation is refused");
    }

    // ---- price markets: who manages the publishers ---------------------------------------------------

    #[test]
    #[should_panic(expected = "owner only")]
    fn the_operator_cannot_add_a_publisher() {
        let (mut o, _) = price_oracle(true);
        act_as(OPERATOR, 1);
        o.add_publisher(public(&signing_key(50)));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn the_operator_cannot_change_how_many_must_sign() {
        let (mut o, _) = price_oracle(true);
        act_as(OPERATOR, 1);
        o.set_price_threshold(3);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn the_operator_cannot_appoint_a_new_operator() {
        let (mut o, _) = price_oracle(true);
        act_as(OPERATOR, 1);
        o.set_operator(acct("someone.near"));
    }

    #[test]
    fn the_operator_cuts_off_a_publisher_at_once_but_never_below_the_threshold() {
        let (mut o, k) = price_oracle(true);
        act_as(OPERATOR, 1);
        o.remove_publisher(public(&k[2]));
        assert_eq!(o.publishers.len(), 2);
        // The two left are exactly the two that must sign. Removing another would leave no price able to pass.
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.remove_publisher(public(&k[1]))));
        assert!(caught.is_err());
        assert_eq!(o.publishers.len(), 2);
    }

    #[test]
    #[should_panic(expected = "operator or owner only")]
    fn a_stranger_cannot_remove_a_publisher() {
        let (mut o, k) = price_oracle(true);
        act_as("stranger.near", 1);
        o.remove_publisher(public(&k[0]));
    }

    #[test]
    #[should_panic(expected = "not a publisher")]
    fn removing_someone_who_is_not_a_publisher_is_refused() {
        let (mut o, _) = price_oracle(true);
        act_as(OPERATOR, 1);
        o.remove_publisher(public(&signing_key(77)));
    }

    #[test]
    fn a_removed_publisher_can_no_longer_sign_a_price() {
        let (mut o, k) = price_oracle(true);
        act_as(OPERATOR, 1);
        o.remove_publisher(public(&k[0]));
        let sigs = signed_by(&[&k[0], &k[1]], 0, &rule(true), 1_250);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| submit(&mut o, OBS, 1_250, &sigs)));
        assert!(caught.is_err());
    }

    #[test]
    #[should_panic(expected = "already a publisher")]
    fn the_same_key_cannot_be_added_twice() {
        let (mut o, k) = price_oracle(true);
        act_as(OWNER, 1);
        o.add_publisher(public(&k[0]));
    }

    #[test]
    #[should_panic(expected = "publishers use ed25519 keys")]
    fn only_ed25519_keys_can_be_publishers() {
        let (mut o, _) = price_oracle(true);
        act_as(OWNER, 1);
        o.add_publisher(PublicKey::from_parts(CurveType::SECP256K1, vec![1; 64]).unwrap());
    }

    #[test]
    #[should_panic(expected = "there can be at most 10 publishers")]
    fn there_can_be_at_most_ten_publishers() {
        let (mut o, _) = price_oracle(true);
        act_as(OWNER, 1);
        for seed in 10..20 {
            o.add_publisher(public(&signing_key(seed)));
        }
    }

    #[test]
    fn the_owner_sets_how_many_must_sign_within_the_publishers_there_are() {
        let (mut o, _) = price_oracle(true);
        act_as(OWNER, 1);
        o.set_price_threshold(3);
        assert_eq!(o.config()["price_threshold"], 3);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.set_price_threshold(4)));
        assert!(caught.is_err(), "more than the publishers there are");
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.set_price_threshold(0)));
        assert!(caught.is_err(), "nobody signing at all");
    }

    #[test]
    fn a_market_with_exactly_the_minimum_gap_registers() {
        let mut o = fresh_oracle();
        act_as(MARKET, 0);
        o.register_market(U64(0), U64(1_000), U64(1_000 + MIN_GAP), "hash".to_string(), None);
        assert!(o.get_market_info(U64(0)).is_some());
        assert_eq!(o.config()["min_resolve_gap_ns"], MIN_GAP.to_string());
    }

    #[test]
    #[should_panic(expected = "resolve_by is too soon after close_at for a case to finish")]
    fn a_market_one_nanosecond_short_of_the_minimum_gap_is_refused() {
        let mut o = fresh_oracle();
        act_as(MARKET, 0);
        o.register_market(U64(0), U64(1_000), U64(1_000 + MIN_GAP - 1), "hash".to_string(), None);
    }

    #[test]
    #[should_panic(expected = "resolve_by is too soon after close_at for a case to finish")]
    fn a_market_that_resolves_before_it_closes_is_refused_without_overflow() {
        let mut o = fresh_oracle();
        act_as(MARKET, 0);
        o.register_market(U64(0), U64(1_000_000), U64(5), "hash".to_string(), None);
    }

    #[test]
    #[should_panic(expected = "too late to propose, the market will be voided at its deadline")]
    fn a_proposal_is_refused_with_exactly_zero_slack_for_apply_to_land() {
        let mut o = oracle_with_resolve_by(WINDOW_PLUS_PANEL);
        act_as(TOKEN, 0);
        let _ = o.ft_on_transfer(acct("carol.near"), U128(1), "propose:0:yes:https://x".to_string());
    }

    #[test]
    fn a_proposal_is_accepted_with_exactly_apply_buffer_of_slack() {
        let mut o = oracle_with_resolve_by(WINDOW_PLUS_PANEL + APPLY_BUFFER_NS);
        act_as(TOKEN, 0);
        let _ = o.ft_on_transfer(acct("carol.near"), U128(1), "propose:0:yes:https://x".to_string());
        assert_eq!(o.case(0).stage, Stage::Proposed, "exactly the buffer's worth of slack is accepted");
    }

    #[test]
    #[should_panic(expected = "too late to propose, the market will be voided at its deadline")]
    fn a_proposal_is_refused_one_nanosecond_short_of_the_buffer() {
        let mut o = oracle_with_resolve_by(WINDOW_PLUS_PANEL + APPLY_BUFFER_NS - 1);
        act_as(TOKEN, 0);
        let _ = o.ft_on_transfer(acct("carol.near"), U128(1), "propose:0:yes:https://x".to_string());
    }
}
