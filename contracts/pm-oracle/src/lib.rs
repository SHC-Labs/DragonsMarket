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
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_APPLY: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
// Measured against the Council's seat cap; see the note on PmCouncil.
const GAS_DRAW: Gas = Gas::from_tgas(250);
const GAS_DRAWN: Gas = Gas::from_tgas(15);
const GAS_UNLOCK: Gas = Gas::from_tgas(10);
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

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct MarketInfo {
    close_at: U64,
    resolve_by: U64,
    rule_hash: String,
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
    fn unlock_case(&mut self, case_key: U64);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PmOracle {
    owner: AccountId,
    // Set by propose_owner. Ownership moves only when this account calls accept_owner.
    pending_owner: Option<AccountId>,
    market: AccountId,
    bond_token: AccountId,
    bond: u128,
    window_ns: u64,
    panel_deadline_ns: u64,
    council: AccountId,
    jury_size: u32,
    draw_delay_blocks: u64,
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
    ) -> Self {
        require!(bond.0 > 0, "bond must be positive");
        require!(window_ms.0 > 0 && panel_deadline_ms.0 > 0, "windows must be positive");
        require!(valid_jury_size(jury_size), "jury size must be odd and at most 21");
        Self {
            owner: owner_id,
            pending_owner: None,
            market: market_contract,
            bond_token,
            bond: bond.0,
            window_ns: window_ms.0 * NS_PER_MS,
            panel_deadline_ns: panel_deadline_ms.0 * NS_PER_MS,
            council,
            jury_size,
            draw_delay_blocks: draw_delay_blocks.0,
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

    // Called by the market contract when a market is created. Calling twice changes nothing.
    pub fn register_market(&mut self, market_id: U64, close_at: U64, resolve_by: U64, rule_hash: String) {
        require!(env::predecessor_account_id() == self.market, "market contract only");
        if self.markets.contains_key(&market_id.0) {
            return;
        }
        self.markets.insert(market_id.0, MarketInfo { close_at, resolve_by, rule_hash });
        emit("market_registered", json!({ "market_id": market_id.0.to_string() }));
    }

    // Bonds arrive here. Propose: "propose:<market>:<yes|no|void>:<evidence url>". Challenge: "challenge:<market>".
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
                self.propose(sender_id, id, outcome, evidence);
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
                "jury_size": self.jury_size, "draw_delay_blocks": self.draw_delay_blocks.to_string() })
    }
}

// ---- private helpers ----------------------------------------------------------------------

impl PmOracle {
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
        let proposer = case.proposer.clone();
        let challenger = case.challenger.clone();
        let proposed = case.proposed;
        let disputed = challenger.is_some();
        self.cases.insert(id, case);

        let bond = self.bond;
        match challenger {
            None => self.add_claimable(&proposer, bond),
            Some(_) if outcome == proposed => self.add_claimable(&proposer, bond * 2),
            // ponytail: the winner takes both bonds and the panel earns nothing yet. Pay jurors a share
            // before a panel exists that is not us.
            Some(c) if outcome == Outcome::Void => {
                self.add_claimable(&proposer, bond);
                self.add_claimable(&c, bond);
            }
            Some(c) => self.add_claimable(&c, bond * 2),
        }
        emit("final", json!({ "market_id": id.to_string(), "outcome": outcome }));
        self.apply(id, outcome);
        // Lets the jury unstake. Nothing waits on it: if it fails, those seats stay locked.
        if disputed {
            let _ = ext_council::ext(self.council.clone()).with_static_gas(GAS_UNLOCK).unlock_case(U64(id));
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
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const OWNER: &str = "owner.near";
    const MARKET: &str = "market.near";
    const TOKEN: &str = "token.near";
    const COUNCIL: &str = "council.near";

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn act_as(who: &str, now_ns: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acct(who)).block_timestamp(now_ns).build());
    }

    // window + panel_deadline = 60s + 120s, so a case that used its full allotted time settles at that mark.
    // propose() must leave APPLY_BUFFER_NS of real room after that before it will accept the market's resolve_by.
    fn oracle_with_resolve_by(resolve_by_ns: u64) -> PmOracle {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as(OWNER, 0);
        let mut o = PmOracle::new(
            acct(OWNER), acct(MARKET), acct(TOKEN), U128(1), U64(60_000), U64(120_000), acct(COUNCIL), 3, U64(2),
        );
        act_as(MARKET, 0);
        o.register_market(U64(0), U64(0), U64(resolve_by_ns), "hash".to_string());
        o
    }

    const WINDOW_PLUS_PANEL: u64 = 180_000_000_000;

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
