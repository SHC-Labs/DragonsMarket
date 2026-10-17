// Council registry for the pitch test. A seat is an NFT from one collection staked here with
// nft_transfer_call. The registry draws juries for the oracle from the staked seats and keeps a drawn seat
// from leaving until the oracle says its case is final. Revenue sent here is shared equally among the seats
// staked when it arrives.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::non_fungible_token::core::{ext_nft_core, NonFungibleTokenReceiver};
use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const MAX_SEATS: u32 = 1_000;
// ponytail: 60 seconds so the sandbox tests can cross it. The real cooldown is chosen later and must be at
// least as long as the longest dispute.
const COOLDOWN_NS: u64 = 60_000_000_000;
// Revenue per seat is kept in units of 1e-12 of a token unit, so splitting a small amount over many seats
// loses less than one unit per seat over a trillion revenue events. The total ever received times this must
// stay under u128::MAX: about 3.4e26 units, 3.4e20 tokens at 6 decimals.
const PRECISION: u128 = 1_000_000_000_000;
const GAS_NFT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
// Sends the NFT and schedules on_unstaked, so it covers both of those plus its own work (2.4 TGas measured).
// With 1,000 seats an unstake that pays out needs at least 54 TGas attached and a claim 29 TGas.
const GAS_UNSTAKE_PAID: Gas = Gas::from_tgas(35);

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Staked,
    Stakes,
    SeatsOf,
    Juries,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Stake {
    owner: AccountId,
    staked_at: U64,
    unlock_requested_at: Option<U64>,
    // The case this seat was drawn for. It cannot leave, or be drawn again, until the oracle releases that case.
    serving: Option<U64>,
    // Where the token sits in `staked`, so unstaking does not scan the list.
    #[serde(skip)]
    index: u32,
    // acc_per_seat already paid out or earned before this seat was staked. The seat is owed the difference.
    #[serde(skip)]
    reward_debt: u128,
}

// ponytail: every draw walks every staked token and reads its record. Measured directly at 1,000 seats with
// 64-character account and token ids (contracts/pm-tests/tests/_gas_probe.rs, since deleted): about 190 TGas
// when every seat has its own holder, and up to 210 TGas when 21 holders share them, because the pick then
// sets most tokens aside. The oracle reserves 250 TGas for the draw, so resolve_draw needs about 270 TGas
// attached. Raising MAX_SEATS needs GAS_DRAW raised to match, measured again at the new cap.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PmCouncil {
    owner: AccountId,
    // Set by propose_owner. Ownership moves only when this account calls accept_owner.
    pending_owner: Option<AccountId>,
    oracle: AccountId,
    nft_contract: AccountId,
    collateral: AccountId,
    // Every staked token, in a stable order for the draw.
    staked: Vector<TokenId>,
    stakes: LookupMap<TokenId, Stake>,
    seats_of: LookupMap<AccountId, u32>,
    // The tokens drawn for each case still open.
    juries: LookupMap<u64, Vec<TokenId>>,
    // Revenue per staked seat since the start, times PRECISION.
    acc_per_seat: u128,
    // Revenue that arrived while no seat was staked. The next revenue to arrive with seats staked carries it in.
    waiting: u128,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "pm-council", "version": "1.0.0", "event": event, "data": data })
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
        format!("not enough seat holders to draw a jury: {} eligible, {} needed", jury.len(), n)
    );
    jury
}

#[near]
impl PmCouncil {
    #[init]
    pub fn new(owner_id: AccountId, oracle_id: AccountId, nft_contract: AccountId, collateral_token: AccountId) -> Self {
        Self {
            owner: owner_id,
            pending_owner: None,
            oracle: oracle_id,
            nft_contract,
            collateral: collateral_token,
            staked: Vector::new(Key::Staked),
            stakes: LookupMap::new(Key::Stakes),
            seats_of: LookupMap::new(Key::SeatsOf),
            juries: LookupMap::new(Key::Juries),
            acc_per_seat: 0,
            waiting: 0,
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

    // Stakes are keyed by token id alone, so the collection can only change while nothing is staked.
    pub fn set_nft_contract(&mut self, nft_contract: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(self.staked.is_empty(), "unstake every seat before changing the NFT contract");
        self.nft_contract = nft_contract;
    }

    // A draw marks the jury as serving. A repeat draw for the same case returns the same jury, so retrying
    // after a failed callback cannot reroll it.
    pub fn draw(&mut self, case_key: U64, seed: Vec<u8>, n: u32, exclude: Vec<AccountId>) -> Vec<AccountId> {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        if let Some(tokens) = self.juries.get(&case_key.0) {
            return tokens.iter().map(|t| self.stakes[t].owner.clone()).collect();
        }
        let candidates = self
            .staked
            .iter()
            .filter_map(|t| {
                let s = &self.stakes[t];
                (s.serving.is_none() && !exclude.contains(&s.owner)).then(|| (t.clone(), s.owner.clone()))
            })
            .collect();
        let jury = pick(candidates, &seed, case_key.0, n);
        for (t, _) in &jury {
            self.stakes.get_mut(t).unwrap().serving = Some(case_key);
        }
        self.juries.insert(case_key.0, jury.iter().map(|(t, _)| t.clone()).collect());
        jury.into_iter().map(|(_, a)| a).collect()
    }

    // Called by the oracle once a case is final.
    pub fn unlock_case(&mut self, case_key: U64) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        for t in self.juries.remove(&case_key.0).unwrap_or_default() {
            if let Some(s) = self.stakes.get_mut(&t) {
                s.serving = None;
            }
        }
    }

    pub fn request_unstake(&mut self, token_id: TokenId) {
        let stake = self.callers_stake(&token_id);
        require!(stake.unlock_requested_at.is_none(), "unstake already requested");
        require!(stake.serving.is_none(), "this seat is serving on an open case");
        let now = env::block_timestamp();
        stake.unlock_requested_at = Some(U64(now));
        let owner = stake.owner.clone();
        emit(
            "unstake_requested",
            json!({ "token_id": token_id, "owner": owner, "unlock_at": (now + COOLDOWN_NS).to_string() }),
        );
    }

    #[payable]
    pub fn unstake(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        let stake = self.callers_stake(&token_id).clone();
        let requested = stake.unlock_requested_at.unwrap_or_else(|| env::panic_str("request an unstake first"));
        require!(env::block_timestamp() >= requested.0 + COOLDOWN_NS, "the cooldown has not passed");
        require!(stake.serving.is_none(), "this seat is serving on an open case");
        // Remove it before any transfer; restore it in a callback if one fails. What the seat earned is paid
        // first, so the NFT leaves carrying nothing.
        let stake = self.remove_stake(&token_id);
        let earned = self.acc_per_seat - stake.reward_debt;
        let amount = earned / PRECISION;
        if amount == 0 {
            return self.return_nft(token_id, stake, earned);
        }
        ext_ft_core::ext(self.collateral.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(stake.owner.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_UNSTAKE_PAID)
                    .on_unstake_paid(token_id, stake, U128(earned)),
            )
    }

    #[private]
    pub fn on_unstake_paid(
        &mut self,
        token_id: TokenId,
        stake: Stake,
        earned: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        if result.is_err() {
            emit("unstake_failed", json!({ "token_id": token_id, "owner": stake.owner }));
            self.restore_stake(token_id, stake, earned.0);
            return PromiseOrValue::Value(());
        }
        emit(
            "revenue_claimed",
            json!({ "token_id": token_id, "owner": stake.owner, "amount": (earned.0 / PRECISION).to_string() }),
        );
        PromiseOrValue::Promise(self.return_nft(token_id, stake, earned.0 % PRECISION))
    }

    #[private]
    pub fn on_unstaked(
        &mut self,
        token_id: TokenId,
        stake: Stake,
        earned: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let data = json!({ "token_id": token_id, "owner": stake.owner });
        if result.is_ok() {
            emit("unstaked", data);
        } else {
            self.restore_stake(token_id, stake, earned.0);
            emit("unstake_failed", data);
        }
    }

    // Pays what the seat has earned to its staker. After an unstake request, unstaking pays it instead.
    #[payable]
    pub fn claim(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        let acc = self.acc_per_seat;
        let stake = self.callers_stake(&token_id);
        require!(stake.unlock_requested_at.is_none(), "an unstake is requested, and unstaking pays what the seat earned");
        let amount = (acc - stake.reward_debt) / PRECISION;
        require!(amount > 0, "nothing to claim");
        // Mark it paid before the transfer; the callback takes the mark back if the transfer fails.
        stake.reward_debt += amount * PRECISION;
        let owner = stake.owner.clone();
        emit("revenue_claimed", json!({ "token_id": token_id, "owner": owner, "amount": amount.to_string() }));
        ext_ft_core::ext(self.collateral.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(owner.clone(), U128(amount), None)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_claimed(token_id, owner, U128(amount)))
    }

    #[private]
    pub fn on_claimed(
        &mut self,
        token_id: TokenId,
        owner: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            match self.stakes.get_mut(&token_id) {
                Some(s) if s.owner == owner => s.reward_debt -= amount.0 * PRECISION,
                // Not reachable while claims stop at an unstake request and the cooldown outlasts a callback.
                // The seats share it rather than it being stranded.
                _ => self.waiting += amount.0,
            }
            emit("claim_failed", json!({ "token_id": token_id, "owner": owner, "amount": amount.0.to_string() }));
        }
    }

    // Called by the collateral token. msg "revenue" shares the amount equally among the seats staked right now.
    // Anyone may send it. Panicking here makes the token refund the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.collateral, "wrong token");
        require!(msg == "revenue", "unknown action");
        let seats = self.staked.len() as u128;
        let total = self.waiting + amount.0;
        match (total * PRECISION).checked_div(seats) {
            Some(per_seat) => {
                self.acc_per_seat += per_seat;
                self.waiting = 0;
            }
            None => self.waiting = total,
        }
        emit("revenue", json!({ "from": sender_id, "amount": amount.0.to_string(), "seats": seats as u32 }));
        PromiseOrValue::Value(U128(0))
    }

    // ---- views ----------------------------------------------------------------------------

    pub fn seat_count(&self) -> u32 {
        self.staked.len()
    }

    pub fn is_seat(&self, account_id: AccountId) -> bool {
        self.seats_of.contains_key(&account_id)
    }

    pub fn staked_tokens(&self, from_index: u32, limit: u32) -> Vec<TokenId> {
        self.staked.iter().skip(from_index as usize).take(limit as usize).cloned().collect()
    }

    pub fn stake_of(&self, token_id: TokenId) -> Option<Stake> {
        self.stakes.get(&token_id).cloned()
    }

    // What claim would pay now, in token units.
    pub fn pending_reward(&self, token_id: TokenId) -> U128 {
        U128(self.stakes.get(&token_id).map(|s| (self.acc_per_seat - s.reward_debt) / PRECISION).unwrap_or(0))
    }

    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "owner": self.owner, "pending_owner": self.pending_owner, "oracle": self.oracle, "nft_contract": self.nft_contract,
                "collateral": self.collateral, "cooldown_ns": COOLDOWN_NS.to_string(),
                "waiting_revenue": self.waiting.to_string() })
    }
}

#[near]
impl NonFungibleTokenReceiver for PmCouncil {
    // Staking. msg is ignored. The seat goes to previous_owner_id, who owned the token, not to sender_id,
    // which can be an approved marketplace. Returning false keeps the token; a panic sends it back.
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: TokenId,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (sender_id, msg);
        require!(env::predecessor_account_id() == self.nft_contract, "wrong NFT contract");
        require!(!self.stakes.contains_key(&token_id), "already staked");
        require!(self.staked.len() < MAX_SEATS, "the council is full");
        let now = U64(env::block_timestamp());
        emit("staked", json!({ "token_id": token_id, "owner": previous_owner_id }));
        let stake = Stake {
            owner: previous_owner_id,
            staked_at: now,
            unlock_requested_at: None,
            serving: None,
            index: 0,
            reward_debt: self.acc_per_seat,
        };
        self.insert_stake(token_id, stake);
        PromiseOrValue::Value(false)
    }
}

impl PmCouncil {
    fn callers_stake(&mut self, token_id: &TokenId) -> &mut Stake {
        let stake = self.stakes.get_mut(token_id).unwrap_or_else(|| env::panic_str("not staked"));
        require!(stake.owner == env::predecessor_account_id(), "not your seat");
        stake
    }

    fn insert_stake(&mut self, token_id: TokenId, mut stake: Stake) {
        stake.index = self.staked.len();
        *self.seats_of.entry(stake.owner.clone()).or_insert(0) += 1;
        self.staked.push(token_id.clone());
        self.stakes.insert(token_id, stake);
    }

    // The seat was not counted while it was out, so it keeps exactly what it had earned when it left.
    fn restore_stake(&mut self, token_id: TokenId, mut stake: Stake, earned: u128) {
        stake.reward_debt = self.acc_per_seat - earned;
        self.insert_stake(token_id, stake);
    }

    fn return_nft(&self, token_id: TokenId, stake: Stake, earned: u128) -> Promise {
        ext_nft_core::ext(self.nft_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_NFT_TRANSFER)
            .nft_transfer(stake.owner.clone(), token_id.clone(), None, None)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_unstaked(token_id, stake, U128(earned)))
    }

    fn remove_stake(&mut self, token_id: &TokenId) -> Stake {
        let stake = self.stakes.remove(token_id).unwrap();
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use proptest::prelude::*;
    use std::collections::{BTreeMap, BTreeSet};

    const OWNER: &str = "owner.near";
    const ORACLE: &str = "oracle.near";
    const NFT: &str = "nft.near";
    const TOKEN: &str = "usd.near";

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn act_as(who: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acct(who)).build());
    }

    fn act_at(who: &str, t: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .block_timestamp(t)
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
    }

    fn council() -> PmCouncil {
        // The mock chain keeps its storage between cases; start each one empty.
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as(OWNER);
        PmCouncil::new(acct(OWNER), acct(ORACLE), acct(NFT), acct(TOKEN))
    }

    fn revenue(c: &mut PmCouncil, amount: u128) {
        act_as(TOKEN);
        let _ = c.ft_on_transfer(acct("market.near"), U128(amount), "revenue".into());
    }

    fn pending(c: &PmCouncil, token: &str) -> u128 {
        c.pending_reward(token.into()).0
    }

    // Requests the unstake at *t, unstakes after the cooldown, and returns what the unstake pays.
    fn leave(c: &mut PmCouncil, token: &str, owner: &str, t: &mut u64) -> u128 {
        let paid = pending(c, token);
        act_at(owner, *t);
        c.request_unstake(token.into());
        *t += COOLDOWN_NS;
        act_at(owner, *t);
        let _ = c.unstake(token.into());
        paid
    }

    fn claim(c: &mut PmCouncil, token: &str, owner: &str) -> u128 {
        let paid = pending(c, token);
        act_at(owner, 0);
        let _ = c.claim(token.into());
        paid
    }

    fn stake(c: &mut PmCouncil, token: &str, owner: &str) {
        act_as(NFT);
        let _ = c.nft_on_transfer(acct("market.near"), acct(owner), token.to_string(), String::new());
    }

    fn tokens(c: &PmCouncil) -> BTreeSet<TokenId> {
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
        assert!(c.is_seat(acct("a.near")));
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
        c.draw(U64(0), vec![1; 32], 3, vec![]);
    }

    #[test]
    #[should_panic(expected = "not enough seat holders to draw a jury: 2 eligible, 3 needed")]
    fn a_draw_needs_enough_distinct_holders_after_the_exclusions() {
        let mut c = council();
        for i in 0..6 {
            stake(&mut c, &i.to_string(), ["a.near", "b.near", "c.near"][i % 3]);
        }
        act_as(ORACLE);
        c.draw(U64(0), vec![1; 32], 3, vec![acct("c.near")]);
    }

    #[test]
    fn a_drawn_jury_serves_until_released_and_a_repeat_draw_returns_it() {
        let mut c = council();
        for i in 0..6 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        act_as(ORACLE);
        let first = c.draw(U64(7), vec![1; 32], 3, vec![]);
        assert_eq!(c.draw(U64(7), vec![2; 32], 3, vec![]), first);
        let second = c.draw(U64(8), vec![1; 32], 3, vec![]);
        assert!(second.iter().all(|a| !first.contains(a)), "a serving seat is not drawn again");
        let serving = |c: &PmCouncil| (0..6).filter(|i| c.stake_of(i.to_string()).unwrap().serving.is_some()).count();
        assert_eq!(serving(&c), 6);
        c.unlock_case(U64(7));
        assert_eq!(serving(&c), 3);
        c.unlock_case(U64(7));
        assert_eq!(serving(&c), 3);
    }

    #[test]
    fn one_seat_takes_all_revenue_and_a_claim_pays_it_once() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, 1_000_000);
        assert_eq!(pending(&c, "t1"), 1_000_000);
        assert_eq!(claim(&mut c, "t1", "a.near"), 1_000_000);
        assert_eq!(pending(&c, "t1"), 0);
        revenue(&mut c, 7);
        assert_eq!(pending(&c, "t1"), 7);
    }

    #[test]
    fn two_seats_split_evenly_and_the_odd_unit_waits_in_the_accumulator() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        stake(&mut c, "t2", "b.near");
        revenue(&mut c, 1_000_001);
        assert_eq!((pending(&c, "t1"), pending(&c, "t2")), (500_000, 500_000));
        revenue(&mut c, 1);
        assert_eq!((pending(&c, "t1"), pending(&c, "t2")), (500_001, 500_001));
    }

    #[test]
    fn a_seat_staked_after_revenue_gets_none_of_it_and_its_share_of_the_next() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, 600);
        stake(&mut c, "t2", "b.near");
        assert_eq!(pending(&c, "t2"), 0);
        revenue(&mut c, 400);
        assert_eq!((pending(&c, "t1"), pending(&c, "t2")), (800, 200));
    }

    #[test]
    fn unstaking_pays_the_seat_and_the_token_restaked_by_someone_else_starts_at_zero() {
        let mut c = council();
        let mut t = 1;
        stake(&mut c, "t1", "a.near");
        stake(&mut c, "t2", "b.near");
        revenue(&mut c, 1_000);
        assert_eq!(leave(&mut c, "t1", "a.near", &mut t), 500);
        assert_eq!(pending(&c, "t1"), 0);
        stake(&mut c, "t1", "c.near");
        assert_eq!(pending(&c, "t1"), 0, "the token carries nothing to its next owner");
        revenue(&mut c, 1_000);
        assert_eq!((pending(&c, "t1"), pending(&c, "t2")), (500, 1_000));
    }

    #[test]
    fn revenue_with_no_seats_waits_for_the_next_revenue_with_seats() {
        let mut c = council();
        revenue(&mut c, 300);
        assert_eq!(c.waiting, 300);
        stake(&mut c, "t1", "a.near");
        assert_eq!(pending(&c, "t1"), 0);
        revenue(&mut c, 100);
        assert_eq!((pending(&c, "t1"), c.waiting), (400, 0));
    }

    // While a seat is out for a transfer it is not counted, so revenue then goes to the others. A failed
    // transfer brings it back with what it had when it left, never a share of what arrived meanwhile.
    #[test]
    fn a_failed_unstake_restores_the_seat_with_exactly_what_it_had_earned() {
        for fail_at_nft in [false, true] {
            let mut c = council();
            stake(&mut c, "t1", "a.near");
            stake(&mut c, "t2", "b.near");
            revenue(&mut c, 1_000);
            act_at("a.near", 1);
            c.request_unstake("t1".into());
            let s = c.stake_of("t1".into()).unwrap();
            act_at("a.near", 1 + COOLDOWN_NS);
            let _ = c.unstake("t1".into());
            revenue(&mut c, 1_000);
            act_as("council.near");
            if fail_at_nft {
                // The payout went through, only the sub-unit remainder is left on the seat.
                c.on_unstaked("t1".into(), s, U128(0), Err(PromiseError::Failed));
                assert_eq!(pending(&c, "t1"), 0);
            } else {
                let _ = c.on_unstake_paid("t1".into(), s, U128(500 * PRECISION), Err(PromiseError::Failed));
                assert_eq!(pending(&c, "t1"), 500);
            }
            assert_eq!(pending(&c, "t2"), 1_500);
            assert_eq!(c.seat_count(), 2);
        }
    }

    #[test]
    fn a_failed_claim_can_be_claimed_again() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, 900);
        assert_eq!(claim(&mut c, "t1", "a.near"), 900);
        revenue(&mut c, 100);
        c.on_claimed("t1".into(), acct("a.near"), U128(900), Err(PromiseError::Failed));
        assert_eq!(pending(&c, "t1"), 1_000);
    }

    #[test]
    #[should_panic(expected = "not your seat")]
    fn only_the_staker_claims() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, 900);
        claim(&mut c, "t1", "b.near");
    }

    #[test]
    #[should_panic(expected = "an unstake is requested, and unstaking pays what the seat earned")]
    fn a_seat_on_its_way_out_is_paid_by_the_unstake_not_a_claim() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, 900);
        act_at("a.near", 1);
        c.request_unstake("t1".into());
        claim(&mut c, "t1", "a.near");
    }

    #[test]
    #[should_panic(expected = "unknown action")]
    fn a_plain_transfer_is_refused() {
        let mut c = council();
        act_as(TOKEN);
        let _ = c.ft_on_transfer(acct("a.near"), U128(5), "deposit".into());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // Against an exact model: every seat is owed amount / seats of each revenue that arrives while it is staked.
        // A seat's pending reward is never above that and at most one unit below, and nothing is paid out that
        // did not come in.
        #[test]
        fn revenue_is_shared_exactly_among_the_seats_staked_when_it_arrives(
            ops in proptest::collection::vec((0u8..4, 0usize..4, 0usize..3, 1u128..1_000_000_000), 1..80)
        ) {
            let mut c = council();
            // Owed amounts times 12, which every seat count from 1 to 4 divides.
            let mut owed12: BTreeMap<TokenId, u128> = BTreeMap::new();
            let mut staked: BTreeMap<TokenId, String> = BTreeMap::new();
            let (mut waiting, mut received, mut paid, mut t) = (0u128, 0u128, 0u128, 1u64);
            for (op, token, owner, amount) in ops {
                let token = format!("t{token}");
                let owner = format!("o{owner}.near");
                match op {
                    0 if !staked.contains_key(&token) => {
                        stake(&mut c, &token, &owner);
                        staked.insert(token.clone(), owner);
                        owed12.insert(token, 0);
                    }
                    1 => {
                        revenue(&mut c, amount);
                        received += amount;
                        let pot = waiting + amount;
                        if staked.is_empty() {
                            waiting = pot;
                        } else {
                            waiting = 0;
                            for tok in staked.keys() {
                                *owed12.get_mut(tok).unwrap() += pot * 12 / staked.len() as u128;
                            }
                        }
                    }
                    2 if staked.contains_key(&token) && pending(&c, &token) > 0 => {
                        let p = claim(&mut c, &token, &staked[&token].clone());
                        *owed12.get_mut(&token).unwrap() -= p * 12;
                        paid += p;
                    }
                    3 if staked.contains_key(&token) => {
                        let who = staked.remove(&token).unwrap();
                        let p = leave(&mut c, &token, &who, &mut t);
                        prop_assert!(owed12[&token] - p * 12 <= 12, "unstaking left more than a unit behind");
                        paid += p;
                    }
                    _ => {}
                }
                prop_assert_eq!(c.waiting, waiting);
                let mut outstanding = 0;
                for tok in staked.keys() {
                    let p = pending(&c, tok);
                    prop_assert!(p * 12 <= owed12[tok], "{} is pending {} but owed only {}/12", tok, p, owed12[tok]);
                    prop_assert!(owed12[tok] <= (p + 1) * 12, "{} is pending {} but owed {}/12", tok, p, owed12[tok]);
                    outstanding += p;
                }
                prop_assert!(paid + outstanding + waiting <= received, "more owed or paid than came in");
            }
        }

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
            let mut t = 0u64;
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
}
