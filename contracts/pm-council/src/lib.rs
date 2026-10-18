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
    // The case this seat was drawn for. It cannot leave, claim, or be drawn again, until the oracle releases that case.
    serving: Option<U64>,
    // acc_per_seat when the seat was drawn. What it earns after that, while serving, is forfeited if the juror
    // never votes (see unlock_case).
    #[serde(skip)]
    serving_since_acc: u128,
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
    // How long a seat waits between asking to unstake and leaving. The council cannot see the oracle's settings, so
    // whoever sets this must keep it at least as long as the oracle's challenge window plus panel deadline, and long
    // enough that staking just before a sweep to catch its revenue, then leaving, is not worth the wait.
    cooldown_ns: u64,
    // The most seats one account can hold. It limits how much of the jury draw and the revenue share one buyer can
    // gather in a single wallet, and nothing more: one person can still use many wallets. Lowering it does not
    // remove seats an account already holds.
    max_seats_per_account: u32,
    // Every staked token, in a stable order for the draw.
    staked: Vector<TokenId>,
    stakes: LookupMap<TokenId, Stake>,
    seats_of: LookupMap<AccountId, u32>,
    // The tokens drawn for each case still open.
    juries: LookupMap<u64, Vec<TokenId>>,
    // Revenue per staked seat since the start, times PRECISION.
    acc_per_seat: u128,
    // Revenue that arrived while no seat was staked, and revenue forfeited by jurors who never voted. The next revenue
    // to arrive with seats staked carries it in.
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
    pub fn new(
        owner_id: AccountId,
        oracle_id: AccountId,
        nft_contract: AccountId,
        collateral_token: AccountId,
        cooldown_ns: U64,
        max_seats_per_account: u32,
    ) -> Self {
        require!(cooldown_ns.0 > 0, "the cooldown must be positive");
        require!(max_seats_per_account > 0, "an account must be allowed at least one seat");
        Self {
            owner: owner_id,
            pending_owner: None,
            oracle: oracle_id,
            nft_contract,
            collateral: collateral_token,
            cooldown_ns: cooldown_ns.0,
            max_seats_per_account,
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

    // Applies to every unstake from now on, including ones already requested, which wait out the new length.
    pub fn set_cooldown_ns(&mut self, cooldown_ns: U64) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(cooldown_ns.0 > 0, "the cooldown must be positive");
        emit("cooldown_set", json!({ "cooldown_ns": cooldown_ns.0.to_string() }));
        self.cooldown_ns = cooldown_ns.0;
    }

    pub fn set_max_seats_per_account(&mut self, max_seats_per_account: u32) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(max_seats_per_account > 0, "an account must be allowed at least one seat");
        emit("max_seats_per_account_set", json!({ "max_seats_per_account": max_seats_per_account }));
        self.max_seats_per_account = max_seats_per_account;
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
                // A seat on its way out is not available to serve, so it cannot be drawn and then be stuck waiting.
                (s.serving.is_none() && s.unlock_requested_at.is_none() && !exclude.contains(&s.owner))
                    .then(|| (t.clone(), s.owner.clone()))
            })
            .collect();
        let jury = pick(candidates, &seed, case_key.0, n);
        let acc = self.acc_per_seat;
        for (t, _) in &jury {
            let stake = self.stakes.get_mut(t).unwrap();
            stake.serving = Some(case_key);
            stake.serving_since_acc = acc;
        }
        self.juries.insert(case_key.0, jury.iter().map(|(t, _)| t.clone()).collect());
        jury.into_iter().map(|(_, a)| a).collect()
    }

    // Called by the oracle once a case is final, with the jurors who never voted. A juror on that list loses the
    // revenue their seat earned while serving: it goes back into the pool for the next revenue to share among the
    // seats. Claims are refused while a seat serves, so that revenue is still pending and cannot be dodged by
    // claiming it first. A second call for the same case does nothing, so nobody is penalised twice.
    pub fn unlock_case(&mut self, case_key: U64, delinquent: Vec<AccountId>) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        let acc = self.acc_per_seat;
        for t in self.juries.remove(&case_key.0).unwrap_or_default() {
            let Some(s) = self.stakes.get_mut(&t) else { continue };
            if delinquent.contains(&s.owner) {
                let forfeited = (acc - s.serving_since_acc) / PRECISION;
                s.reward_debt += forfeited * PRECISION;
                self.waiting += forfeited;
                emit("revenue_forfeited", json!({ "token_id": t, "owner": s.owner, "amount": forfeited.to_string(), "case": case_key }));
            }
            s.serving = None;
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
            json!({ "token_id": token_id, "owner": owner, "unlock_at": (now + self.cooldown_ns).to_string() }),
        );
    }

    #[payable]
    pub fn unstake(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        let stake = self.callers_stake(&token_id).clone();
        let requested = stake.unlock_requested_at.unwrap_or_else(|| env::panic_str("request an unstake first"));
        require!(env::block_timestamp() >= requested.0 + self.cooldown_ns, "the cooldown has not passed");
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
        require!(stake.serving.is_none(), "this seat is serving on an open case, claim after it is final");
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

    // The seats still held for a case. Empty once the oracle has released it, so a settled dispute that still lists
    // seats here is one whose unlock failed and needs retry_unlock.
    pub fn jury_of(&self, case_key: U64) -> Vec<TokenId> {
        self.juries.get(&case_key.0).cloned().unwrap_or_default()
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
                "collateral": self.collateral, "cooldown_ns": self.cooldown_ns.to_string(),
                "max_seats_per_account": self.max_seats_per_account,
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
        let held = self.seats_of.get(&previous_owner_id).copied().unwrap_or(0);
        require!(held < self.max_seats_per_account, "that account already holds the most seats allowed");
        let now = U64(env::block_timestamp());
        emit("staked", json!({ "token_id": token_id, "owner": previous_owner_id }));
        let stake = Stake {
            owner: previous_owner_id,
            staked_at: now,
            unlock_requested_at: None,
            serving: None,
            serving_since_acc: 0,
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
    const COOLDOWN_NS: u64 = 60_000_000_000;

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
        PmCouncil::new(acct(OWNER), acct(ORACLE), acct(NFT), acct(TOKEN), U64(COOLDOWN_NS), MAX_SEATS)
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
        c.unlock_case(U64(7), vec![]);
        assert_eq!(serving(&c), 3);
        c.unlock_case(U64(7), vec![]);
        assert_eq!(serving(&c), 3);
    }

    // Four seats, token "i" held by seat{i}.near. Each seat has earned 100 before a jury of three is drawn, and earns
    // another 100 while it serves. Returns the token ids of the jury.
    fn serving_case_with_revenue() -> (PmCouncil, Vec<String>) {
        let mut c = council();
        for i in 0..4 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        revenue(&mut c, 400);
        act_as(ORACLE);
        let jury = c.draw(U64(1), vec![3; 32], 3, vec![]);
        let tokens: Vec<String> = jury.iter().map(|a| a.as_str().trim_start_matches("seat").trim_end_matches(".near").to_string()).collect();
        revenue(&mut c, 400);
        (c, tokens)
    }

    fn unlock(c: &mut PmCouncil, delinquent: Vec<AccountId>) {
        act_as(ORACLE);
        c.unlock_case(U64(1), delinquent);
    }

    #[test]
    fn a_juror_who_never_voted_forfeits_what_the_seat_earned_while_serving_and_keeps_the_rest() {
        let (mut c, jury) = serving_case_with_revenue();
        let silent = &jury[0];
        assert_eq!(pending(&c, silent), 200);
        unlock(&mut c, vec![acct(&format!("seat{silent}.near"))]);
        assert_eq!(pending(&c, silent), 100, "the 100 earned before the draw stays, the 100 earned while serving is gone");
        for t in &jury[1..] {
            assert_eq!(pending(&c, t), 200, "a juror who voted keeps everything");
        }
        assert_eq!(c.waiting, 100);

        // The forfeit is shared with the next revenue: 100 waiting plus 400 new is 125 for each of the four seats.
        revenue(&mut c, 400);
        assert_eq!(c.waiting, 0);
        assert_eq!(pending(&c, silent), 225);
        let total: u128 = (0..4).map(|i| pending(&c, &i.to_string())).sum();
        assert_eq!(total, 1_200, "every token received is still owed to a seat: nothing created or lost");
    }

    // ---- attacks: economics -------------------------------------------------------------------------

    // Revenue goes to the seats staked at the moment a sweep lands, and a sweep can be called by anyone. So a buyer who
    // stakes many NFTs just before a sweep takes a share of everything gathered since the last one, then leaves after
    // the cooldown. This test pins down how much, so that a fix (earning only after a minimum time staked, or sweeping
    // so often that the bucket is small) shows up as a change here.
    #[test]
    fn staking_just_before_a_sweep_captures_a_share_of_everything_gathered_since_the_last_one() {
        let mut c = council();
        for i in 0..5 {
            stake(&mut c, &format!("honest{i}"), &format!("honest{i}.near"));
        }
        // A month of fees has gathered. Ten NFTs are staked a moment before the sweep lands.
        for i in 0..10 {
            stake(&mut c, &format!("sniper{i}"), "sniper.near");
        }
        revenue(&mut c, 3_000_000);
        let sniper: u128 = (0..10).map(|i| pending(&c, &format!("sniper{i}"))).sum();
        let honest: u128 = (0..5).map(|i| pending(&c, &format!("honest{i}"))).sum();
        assert_eq!(sniper + honest, 3_000_000);
        assert_eq!(sniper, 2_000_000, "ten seats staked for the length of one block took two thirds of the month's revenue");

        // The cooldown is the only thing that costs them: they must wait it out before the NFTs are theirs again, and
        // unstaking pays out what the seats earned.
        let mut t = 1;
        let mut taken = 0;
        for i in 0..10 {
            taken += leave(&mut c, &format!("sniper{i}"), "sniper.near", &mut t);
        }
        assert_eq!(taken, 2_000_000);
    }

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
                        (format!("a{i}"), acct(&format!("attacker{}.near", (i - honest_seats) / 10)))
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
                attacker_seats as f64 * 100.0 / total as f64, rows[0] * 100.0, rows[1] * 100.0, rows[2] * 100.0
            ));
            for column in 0..3 {
                assert!(rows[column] + 0.06 >= previous[column], "more seats should not make capture less likely");
            }
            previous = rows;
            if attacker_seats == 0 {
                assert!(rows.iter().all(|r| *r == 0.0), "an attacker with no seats never sits on a jury");
            }
            if attacker_seats == 100 {
                assert!(rows[2] < 0.01, "9% of the seats captured {:.2}% of juries of 21", rows[2] * 100.0);
            }
            if attacker_seats == 500 {
                assert!(rows[2] < rows[0], "a jury of 21 is harder to capture than a jury of 3: {rows:?}");
            }
        }
        println!("{report}");
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(60))]

        // Money received as revenue is always either owed to a seat, waiting in the pool, or already claimed, whatever
        // order stakes, revenue, jury draws, forfeits and claims come in. Nothing is created and nothing is lost beyond
        // a unit of rounding dust per seat.
        #[test]
        fn revenue_is_never_created_or_lost_through_draws_forfeits_and_claims(
            ops in prop::collection::vec((0u8..5, 0u32..16, 1u128..5_000_000), 1..70),
        ) {
            let mut c = council();
            let (mut total_in, mut claimed, mut tokens, mut next_case) = (0u128, 0u128, 0u32, 0u64);
            let mut open_cases: Vec<(u64, Vec<AccountId>)> = vec![];
            for (op, pick, amount) in ops {
                match op {
                    0 => {
                        stake(&mut c, &tokens.to_string(), &format!("o{}.near", pick % 6));
                        tokens += 1;
                    }
                    1 => {
                        revenue(&mut c, amount);
                        total_in += amount;
                    }
                    2 => {
                        act_as(ORACLE);
                        let n = 1 + pick % 3;
                        let seed = vec![pick as u8; 32];
                        let case = next_case;
                        if let Ok(jury) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.draw(U64(case), seed, n, vec![]))) {
                            open_cases.push((case, jury));
                            next_case += 1;
                        }
                    }
                    3 if !open_cases.is_empty() => {
                        let (case, jury) = open_cases.remove(pick as usize % open_cases.len());
                        let delinquent: Vec<AccountId> = jury.iter().enumerate().filter(|(i, _)| (pick >> i) & 1 == 1).map(|(_, a)| a.clone()).collect();
                        act_as(ORACLE);
                        c.unlock_case(U64(case), delinquent);
                    }
                    4 if tokens > 0 => {
                        let token = (pick % tokens).to_string();
                        let stake = c.stake_of(token.clone()).unwrap();
                        if stake.serving.is_none() && pending(&c, &token) > 0 {
                            claimed += claim(&mut c, &token, stake.owner.as_str());
                        }
                    }
                    _ => {}
                }
                let owed: u128 = (0..tokens).map(|t| pending(&c, &t.to_string())).sum();
                let accounted = owed + c.waiting + claimed;
                prop_assert!(accounted <= total_in, "more is owed than was ever received: {} against {}", accounted, total_in);
                prop_assert!(total_in - accounted <= tokens as u128 + 1, "revenue was lost: {} of {} unaccounted", total_in - accounted, total_in);
            }
        }
    }

    #[test]
    fn jury_of_lists_a_cases_seats_until_it_is_released() {
        let (mut c, jury) = serving_case_with_revenue();
        let mut listed = c.jury_of(U64(1));
        listed.sort();
        let mut expected = jury.clone();
        expected.sort();
        assert_eq!(listed, expected);
        assert!(c.jury_of(U64(2)).is_empty(), "no such case");
        unlock(&mut c, vec![]);
        assert!(c.jury_of(U64(1)).is_empty());
    }

    #[test]
    fn nothing_is_forfeited_when_every_juror_voted() {
        let (mut c, jury) = serving_case_with_revenue();
        unlock(&mut c, vec![]);
        for t in &jury {
            assert_eq!(pending(&c, t), 200);
        }
        assert_eq!(c.waiting, 0);
    }

    #[test]
    fn a_second_unlock_does_not_penalise_anyone_twice() {
        let (mut c, jury) = serving_case_with_revenue();
        let silent = vec![acct(&format!("seat{}.near", jury[0]))];
        unlock(&mut c, silent.clone());
        unlock(&mut c, silent);
        assert_eq!((pending(&c, &jury[0]), c.waiting), (100, 100));
    }

    #[test]
    fn naming_an_account_that_was_not_on_the_jury_changes_nothing() {
        let (mut c, jury) = serving_case_with_revenue();
        let outsider = (0..4).map(|i| i.to_string()).find(|t| !jury.contains(t)).unwrap();
        unlock(&mut c, vec![acct(&format!("seat{outsider}.near"))]);
        assert_eq!(pending(&c, &outsider), 200);
        assert_eq!(c.waiting, 0);
    }

    #[test]
    #[should_panic(expected = "this seat is serving on an open case, claim after it is final")]
    fn a_serving_seat_cannot_claim_so_it_cannot_dodge_the_forfeit() {
        let (mut c, jury) = serving_case_with_revenue();
        claim(&mut c, &jury[0], &format!("seat{}.near", jury[0]));
    }

    #[test]
    fn a_seat_claims_again_once_its_case_is_released() {
        let (mut c, jury) = serving_case_with_revenue();
        unlock(&mut c, vec![]);
        assert_eq!(claim(&mut c, &jury[0], &format!("seat{}.near", jury[0])), 200);
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

        let mut t = 1;
        let _ = leave(&mut c, "t1", "a.near", &mut t);
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
        act_at("seat0.near", 1);
        c.request_unstake("0".into());
        // Three of the four seats are drawn each time, so one draw could miss the seat by luck. Twenty cannot.
        act_as(ORACLE);
        for case in 0..20u64 {
            let jury = c.draw(U64(case), vec![case as u8; 32], 3, vec![]);
            assert!(!jury.contains(&acct("seat0.near")), "the seat on its way out is left out of case {case}");
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
        act_at("seat0.near", 1);
        c.request_unstake("0".into());
        act_as(ORACLE);
        c.draw(U64(1), vec![1; 32], 4, vec![]);
    }

    #[test]
    #[should_panic(expected = "the cooldown has not passed")]
    fn an_unstake_waits_the_full_cooldown() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_at("a.near", 1);
        c.request_unstake("t1".into());
        act_at("a.near", 1 + COOLDOWN_NS - 1);
        let _ = c.unstake("t1".into());
    }

    #[test]
    fn the_owner_changes_the_cooldown_and_it_applies_to_a_request_already_made() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_at("a.near", 1);
        c.request_unstake("t1".into());
        act_as(OWNER);
        c.set_cooldown_ns(U64(3 * COOLDOWN_NS));
        assert_eq!(c.config()["cooldown_ns"], (3 * COOLDOWN_NS).to_string());
        // The old length no longer frees the seat, the new one does.
        act_at("a.near", 1 + COOLDOWN_NS);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.unstake("t1".into());
        }))
        .is_err());
        act_at("a.near", 1 + 3 * COOLDOWN_NS);
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
