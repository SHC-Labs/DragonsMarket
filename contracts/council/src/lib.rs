// Council registry for the pitch test. A seat is an NFT from one collection staked here with
// nft_transfer_call. The registry draws juries for the oracle from the staked seats and keeps a drawn seat
// from leaving until the oracle says its case is final. Revenue sent here is released to the staked seats at a
// constant rate over 30 days, so a seat earns in proportion to the time it was staked.
// The JSON interface takes one argument per field, so a few methods are long on purpose.
#![allow(clippy::too_many_arguments)]

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::non_fungible_token::core::{ext_nft_core, NonFungibleTokenReceiver};
use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue, PublicKey,
};

const MAX_SEATS: u32 = 1_000;
// Token ids one allow_tokens call may add. Each is a storage write and an entry in the event, so a call stays far below
// the gas it is given (measured in the sandbox, see contracts/AUDIT.md).
const MAX_ALLOW_BATCH: usize = 100;
// Revenue per seat is kept in units of 1e-12 of a token unit, so splitting a small amount over many seats
// loses less than one unit per seat over a trillion revenue events. The total ever received times this must
// stay under u128::MAX: about 3.4e26 units, 3.4e20 tokens at 6 decimals.
const PRECISION: u128 = 1_000_000_000_000;
// Every revenue arrival and every forfeit is released to the seats over this long, counted from the arrival.
const STREAM_SECS: u64 = 30 * 24 * 60 * 60;
const NS_PER_SEC: u64 = 1_000_000_000;
const STREAM_NS: u64 = STREAM_SECS * NS_PER_SEC;
const GAS_NFT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
// Sends the NFT and schedules on_unstaked, so it covers both of those plus its own work (2.4 TGas measured).
const GAS_UNSTAKE_PAID: Gas = Gas::from_tgas(35);
// The gas floors. An unstake that pays sends the payout and then the NFT, and a claim sends the payout with its callback.
// Each burns about 3 TGas itself and neither depends on how many seats are staked. 55 TGas was the least that worked for
// an unstake and 29 for a claim in the sandbox.
const GAS_PAYOUT_OVERHEAD: Gas = Gas::from_tgas(8);
const GAS_UNSTAKE_FLOOR: Gas =
    Gas::from_gas(GAS_FT_TRANSFER.as_gas() + GAS_UNSTAKE_PAID.as_gas() + GAS_PAYOUT_OVERHEAD.as_gas());
const GAS_CLAIM_FLOOR: Gas =
    Gas::from_gas(GAS_FT_TRANSFER.as_gas() + GAS_CALLBACK.as_gas() + GAS_PAYOUT_OVERHEAD.as_gas());
// The layout of the state below. migrate reads exactly this one and refuses any other.
const STATE_VERSION: u16 = 1;

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Staked,
    Stakes,
    SeatsOf,
    Juries,
    Allowed,
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

// Revenue not yet released to the seats, scaled by PRECISION. It is released at a constant rate until `ends_at`.
// An arrival adds to it and moves `ends_at` towards a full STREAM_NS from then (see top_up).
#[near(serializers=[borsh])]
#[derive(Clone)]
struct Stream {
    remaining: u128,
    updated_at: u64,
    ends_at: u64,
}

// total * elapsed / left without overflowing: total / left * elapsed cannot exceed total, and the rest is
// below left * elapsed.
fn share_of(total: u128, elapsed: u64, left: u64) -> u128 {
    let (elapsed, left) = (elapsed as u128, left as u128);
    total / left * elapsed + total % left * elapsed / left
}

// span * part / whole for part <= whole, with both scaled down together until whole fits in 64 bits so the product
// cannot overflow. The loss is below one part in 2^63.
fn proportion(span: u64, part: u128, whole: u128) -> u64 {
    let shift = (128 - whole.leading_zeros()).saturating_sub(64);
    (span as u128 * (part >> shift) / (whole >> shift)) as u64
}

impl Stream {
    // The stream as it stands at `now`, and what each of `seats` earned since it was last advanced. While no seat is
    // staked nothing is released and the end moves out by the same time, so no revenue is lost. What does not divide
    // evenly among the seats stays in the stream.
    fn advanced(&self, now: u64, seats: u128) -> (Stream, u128) {
        let mut next = self.clone();
        let elapsed = now.saturating_sub(self.updated_at);
        if elapsed == 0 {
            return (next, 0);
        }
        next.updated_at = now;
        if self.remaining == 0 {
            return (next, 0);
        }
        if seats == 0 {
            next.ends_at += elapsed;
            return (next, 0);
        }
        let left = self.ends_at.saturating_sub(self.updated_at);
        let released = if elapsed >= left {
            self.remaining
        } else {
            share_of(self.remaining, elapsed, left)
        };
        let per_seat = released / seats;
        next.remaining -= per_seat * seats;
        (next, per_seat)
    }

    // Adds `amount` (already scaled) to a stream that has been advanced to `now`. The end moves to the average of the
    // old end and a full STREAM_NS from now, weighted by what each part holds, so a tiny arrival cannot slow what is
    // already streaming.
    fn top_up(&mut self, now: u64, amount: u128) {
        let left = self.ends_at.saturating_sub(now);
        let total = self.remaining + amount;
        let new_left = if STREAM_NS >= left {
            left + proportion(STREAM_NS - left, amount, total)
        } else {
            left - proportion(left - STREAM_NS, amount, total)
        };
        self.remaining = total;
        self.ends_at = now + new_left;
    }
}

// ponytail: every draw walks every staked token and reads its record. Measured directly at 1,000 seats with
// 64-character account and token ids (contracts/tests/tests/_gas_probe.rs, since deleted): about 190 TGas
// when every seat has its own holder, and up to 210 TGas when 21 holders share them, because the pick then
// sets most tokens aside. The oracle reserves 250 TGas for the draw, so resolve_draw needs about 270 TGas
// attached. Raising MAX_SEATS needs GAS_DRAW raised to match, measured again at the new cap.
#[near(contract_state, contract_metadata(standard(standard = "nep297", version = "1.0.0")))]
#[derive(PanicOnDefault)]
pub struct CouncilContract {
    // First, so migrate can read it before it trusts the rest of the layout.
    state_version: u16,
    // Set by migrate, so it is true only once an upgrade has gone through. seal refuses until then.
    upgrade_proven: bool,
    owner: AccountId,
    // Set by propose_owner. Ownership moves only when this account calls accept_owner.
    pending_owner: Option<AccountId>,
    oracle: AccountId,
    nft_contract: AccountId,
    collateral: AccountId,
    // How long a seat waits between asking to unstake and leaving. The council cannot see the oracle's settings, so
    // whoever sets this must keep it at least as long as the oracle's challenge window plus panel deadline.
    cooldown_ns: u64,
    // The most seats one account can hold. It limits how much of the jury draw and the revenue share one buyer can
    // gather in a single wallet, and nothing more: one person can still use many wallets. Lowering it does not
    // remove seats an account already holds.
    max_seats_per_account: u32,
    // While on, only a token on the allowlist can be staked. A token is on it when the owner named it with allow_tokens,
    // or when its id is the decimal form of a number inside allowed_range. The collection must have a fixed supply
    // with minting closed before staking opens, or anyone could mint their way onto the list.
    allowlist_enabled: bool,
    allowed_tokens: LookupSet<TokenId>,
    allowed_range: Option<(u64, u64)>,
    // Every staked token, in a stable order for the draw.
    staked: Vector<TokenId>,
    stakes: LookupMap<TokenId, Stake>,
    seats_of: LookupMap<AccountId, u32>,
    // The tokens drawn for each case still open.
    juries: LookupMap<u64, Vec<TokenId>>,
    // Revenue released per staked seat since the start, times PRECISION. It only moves when the stream is advanced,
    // so every method that changes the seat count or pays a seat advances it first.
    acc_per_seat: u128,
    stream: Stream,
    // Every token received as revenue since the start. The market compares it with what it sent when a transfer's result
    // was lost (see its revenue_unresolved). Forfeits are not revenue and are not counted.
    total_received: u128,
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
    // Only this account can run it, so a deploy and init batch signed by it is the one way in.
    #[private]
    #[init]
    pub fn new(
        owner_id: AccountId,
        oracle_id: AccountId,
        nft_contract: AccountId,
        collateral_token: AccountId,
        cooldown_ns: U64,
        max_seats_per_account: u32,
        allowlist_enabled: Option<bool>,
    ) -> Self {
        require!(cooldown_ns.0 > 0, "the cooldown must be positive");
        require!(
            max_seats_per_account > 0,
            "an account must be allowed at least one seat"
        );
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: false,
            owner: owner_id,
            pending_owner: None,
            oracle: oracle_id,
            nft_contract,
            collateral: collateral_token,
            cooldown_ns: cooldown_ns.0,
            max_seats_per_account,
            allowlist_enabled: allowlist_enabled.unwrap_or(true),
            allowed_tokens: LookupSet::new(Key::Allowed),
            allowed_range: None,
            staked: Vector::new(Key::Staked),
            stakes: LookupMap::new(Key::Stakes),
            seats_of: LookupMap::new(Key::SeatsOf),
            juries: LookupMap::new(Key::Juries),
            acc_per_seat: 0,
            stream: Stream {
                remaining: 0,
                updated_at: 0,
                ends_at: 0,
            },
            total_received: 0,
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

    // Owner only, which is the governance contract, so code changes wait out its vote and timelock. Staking, unstaking
    // and claiming never pause, so the timelock is the stakers' window to leave. The deploy and migrate are one batch: a
    // migrate that panics puts the old code back. Attach at least 100 TGas.
    pub fn upgrade(&mut self, code_hash: Base58CryptoHash) -> Promise {
        upgrade::require_upgrade_gas();
        self.only_owner();
        let code = upgrade::take_staged(code_hash);
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

    // Stakes are keyed by token id alone, so the collection can only change while nothing is staked.
    pub fn set_nft_contract(&mut self, nft_contract: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(
            self.staked.is_empty(),
            "unstake every seat before changing the NFT contract"
        );
        self.nft_contract = nft_contract;
    }

    // Adds token ids to the allowlist, at most MAX_ALLOW_BATCH a call. Naming one twice changes nothing. A token already
    // staked stays staked if the allowlist is later switched on or the collection changes.
    pub fn allow_tokens(&mut self, token_ids: Vec<TokenId>) {
        self.only_owner();
        require!(!token_ids.is_empty(), "name at least one token");
        require!(token_ids.len() <= MAX_ALLOW_BATCH, "at most 100 tokens in one call");
        for token_id in &token_ids {
            self.allowed_tokens.insert(token_id.clone());
        }
        emit("tokens_allowed", json!({ "token_ids": token_ids }));
    }

    // For a collection whose ids are decimal numbers: every id from `first` to `last`, both included, is allowed. It
    // replaces any earlier range.
    pub fn set_token_range(&mut self, first: U64, last: U64) {
        self.only_owner();
        require!(first.0 <= last.0, "the first id must not be above the last");
        self.allowed_range = Some((first.0, last.0));
        emit(
            "token_range_set",
            json!({ "first": first.0.to_string(), "last": last.0.to_string() }),
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
    // returns the same jury, so retrying after a failed callback cannot reroll it.
    pub fn draw(&mut self, case_key: U64, n: u32, exclude: Vec<AccountId>) -> Vec<AccountId> {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        if let Some(tokens) = self.juries.get(&case_key.0) {
            return tokens.iter().map(|t| self.stakes[t].owner.clone()).collect();
        }
        self.accrue();
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
        let jury = pick(candidates, &env::random_seed_array(), case_key.0, n);
        let acc = self.acc_per_seat;
        for (t, _) in &jury {
            let stake = self.stakes.get_mut(t).unwrap();
            stake.serving = Some(case_key);
            stake.serving_since_acc = acc;
        }
        self.juries
            .insert(case_key.0, jury.iter().map(|(t, _)| t.clone()).collect());
        jury.into_iter().map(|(_, a)| a).collect()
    }

    // Called by the oracle once a case is final, with the jurors who never voted. A juror on that list loses the
    // revenue their seat earned while serving: it goes back into the stream for all the seats. Claims are refused
    // while a seat serves, so that revenue is still pending and cannot be dodged by claiming it first. A second call
    // for the same case does nothing, so nobody is penalised twice.
    pub fn unlock_case(&mut self, case_key: U64, delinquent: Vec<AccountId>) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        self.accrue();
        let acc = self.acc_per_seat;
        let mut forfeited_total = 0;
        for t in self.juries.remove(&case_key.0).unwrap_or_default() {
            let Some(s) = self.stakes.get_mut(&t) else { continue };
            if delinquent.contains(&s.owner) {
                let forfeited = (acc - s.serving_since_acc) / PRECISION;
                s.reward_debt += forfeited * PRECISION;
                forfeited_total += forfeited;
                emit(
                    "revenue_forfeited",
                    json!({ "token_id": t, "owner": s.owner, "amount": forfeited.to_string(), "case": case_key }),
                );
            }
            s.serving = None;
        }
        self.add_to_stream(forfeited_total);
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
        upgrade::require_gas(
            GAS_UNSTAKE_FLOOR,
            "an unstake pays what the seat earned and then returns the NFT",
        );
        assert_one_yocto();
        self.accrue();
        let stake = self.callers_stake(&token_id).clone();
        let requested = stake
            .unlock_requested_at
            .unwrap_or_else(|| env::panic_str("request an unstake first"));
        require!(
            env::block_timestamp() >= requested.0 + self.cooldown_ns,
            "the cooldown has not passed"
        );
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
        upgrade::require_gas(GAS_CLAIM_FLOOR, "a claim sends the payout and then settles it");
        assert_one_yocto();
        self.accrue();
        let acc = self.acc_per_seat;
        let stake = self.callers_stake(&token_id);
        require!(
            stake.serving.is_none(),
            "this seat is serving on an open case, claim after it is final"
        );
        require!(
            stake.unlock_requested_at.is_none(),
            "an unstake is requested, and unstaking pays what the seat earned"
        );
        let amount = (acc - stake.reward_debt) / PRECISION;
        require!(amount > 0, "nothing to claim");
        // Mark it paid before the transfer; the callback takes the mark back if the transfer fails.
        stake.reward_debt += amount * PRECISION;
        let owner = stake.owner.clone();
        emit(
            "revenue_claimed",
            json!({ "token_id": token_id, "owner": owner, "amount": amount.to_string() }),
        );
        ext_ft_core::ext(self.collateral.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(owner.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_claimed(token_id, owner, U128(amount)),
            )
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
                _ => self.add_to_stream(amount.0),
            }
            emit(
                "claim_failed",
                json!({ "token_id": token_id, "owner": owner, "amount": amount.0.to_string() }),
            );
        }
    }

    // Called by the collateral token. msg "revenue" adds the amount to the stream that releases to the staked seats
    // over the next 30 days. Anyone may send it. Panicking here makes the token refund the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.collateral, "wrong token");
        require!(msg == "revenue", "unknown action");
        self.total_received += amount.0;
        self.add_to_stream(amount.0);
        emit(
            "revenue",
            json!({ "from": sender_id, "amount": amount.0.to_string(), "seats": self.staked.len() }),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ---- views ----------------------------------------------------------------------------

    // All revenue tokens this registry has taken in over its life, whether released to the seats yet or not.
    pub fn total_received(&self) -> U128 {
        U128(self.total_received)
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

    pub fn staked_tokens(&self, from_index: u32, limit: u32) -> Vec<TokenId> {
        self.staked
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    pub fn stake_of(&self, token_id: TokenId) -> Option<Stake> {
        self.stakes.get(&token_id).cloned()
    }

    // What claim would pay now, in token units. It counts what the stream has released up to this moment, which the
    // stored accumulator has not caught up with yet.
    pub fn pending_reward(&self, token_id: TokenId) -> U128 {
        let (_, released) = self.stream.advanced(env::block_timestamp(), self.staked.len() as u128);
        U128(
            self.stakes
                .get(&token_id)
                .map(|s| (self.acc_per_seat + released - s.reward_debt) / PRECISION)
                .unwrap_or(0),
        )
    }

    // Whether a wasm with this sha256 is staged here, for the members to check before they vote to deploy it.
    pub fn is_staged(&self, code_hash: Base58CryptoHash) -> bool {
        upgrade::is_staged(code_hash)
    }

    // stream_remaining is the revenue still to be released, in token units, as of now.
    pub fn config(&self) -> near_sdk::serde_json::Value {
        let (stream, _) = self.stream.advanced(env::block_timestamp(), self.staked.len() as u128);
        json!({ "state_version": self.state_version, "upgrade_proven": self.upgrade_proven,
                "owner": self.owner, "pending_owner": self.pending_owner, "oracle": self.oracle, "nft_contract": self.nft_contract,
                "collateral": self.collateral, "cooldown_ns": self.cooldown_ns.to_string(),
                "max_seats_per_account": self.max_seats_per_account, "allowlist_enabled": self.allowlist_enabled,
                "allowed_range": self.allowed_range.map(|(first, last)| json!({ "first": first.to_string(), "last": last.to_string() })),
                "total_received": self.total_received.to_string(), "stream_ns": STREAM_NS.to_string(), "stream_remaining": (stream.remaining / PRECISION).to_string(),
                "stream_ends_at": stream.ends_at.to_string() })
    }
}

#[near]
impl NonFungibleTokenReceiver for CouncilContract {
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
        require!(self.is_allowed(token_id.clone()), "that token is not on the allowlist");
        require!(!self.stakes.contains_key(&token_id), "already staked");
        require!(self.staked.len() < MAX_SEATS, "the council is full");
        let held = self.seats_of.get(&previous_owner_id).copied().unwrap_or(0);
        require!(
            held < self.max_seats_per_account,
            "that account already holds the most seats allowed"
        );
        self.accrue();
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

impl CouncilContract {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    // An id counts as a number only in its plain decimal form, so "007" and "+7" are not the token "7".
    fn on_allowlist(&self, token_id: &TokenId) -> bool {
        let in_range = || {
            let (first, last) = self.allowed_range?;
            let n: u64 = token_id.parse().ok()?;
            (n.to_string() == *token_id && (first..=last).contains(&n)).then_some(())
        };
        self.allowed_tokens.contains(token_id) || in_range().is_some()
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
        self.staked.push(token_id.clone());
        self.stakes.insert(token_id, stake);
    }

    // Moves the accumulator up to now. It must run before the seat count changes, because what was released since the
    // last advance belongs to the seats that were staked during it.
    fn accrue(&mut self) {
        let (stream, released) = self.stream.advanced(env::block_timestamp(), self.staked.len() as u128);
        self.stream = stream;
        self.acc_per_seat += released;
    }

    fn add_to_stream(&mut self, amount: u128) {
        if amount == 0 {
            return;
        }
        self.accrue();
        self.stream.top_up(env::block_timestamp(), amount * PRECISION);
    }

    // The seat was not counted while it was out, so it keeps exactly what it had earned when it left.
    fn restore_stake(&mut self, token_id: TokenId, mut stake: Stake, earned: u128) {
        self.accrue();
        stake.reward_debt = self.acc_per_seat - earned;
        self.insert_stake(token_id, stake);
    }

    fn return_nft(&self, token_id: TokenId, stake: Stake, earned: u128) -> Promise {
        ext_nft_core::ext(self.nft_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_NFT_TRANSFER)
            .nft_transfer(stake.owner.clone(), token_id.clone(), None, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_unstaked(token_id, stake, U128(earned)),
            )
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
    use std::cell::Cell;
    use std::collections::{BTreeMap, BTreeSet};

    const OWNER: &str = "owner.near";
    const ORACLE: &str = "oracle.near";
    const NFT: &str = "nft.near";
    const TOKEN: &str = "usd.near";
    const COOLDOWN_NS: u64 = 60_000_000_000;
    const SECOND: u64 = NS_PER_SEC;
    const DAY: u64 = 24 * 60 * 60 * SECOND;

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

    // Long enough after the last arrival for the stream to have released all of it.
    fn release_all() {
        set_time(now() + STREAM_NS);
    }

    // The allowlist is off unless a test asks for it, so tests of other things stake any token they like.
    fn council() -> CouncilContract {
        council_with(Some(false))
    }

    fn council_with(allowlist_enabled: Option<bool>) -> CouncilContract {
        // The mock chain keeps its storage between cases; start each one empty.
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        CLOCK.with(|c| c.set(0));
        act_as(OWNER);
        CouncilContract::new(
            acct(OWNER),
            acct(ORACLE),
            acct(NFT),
            acct(TOKEN),
            U64(COOLDOWN_NS),
            MAX_SEATS,
            allowlist_enabled,
        )
    }

    fn revenue(c: &mut CouncilContract, amount: u128) {
        act_as(TOKEN);
        let _ = c.ft_on_transfer(acct("market.near"), U128(amount), "revenue".into());
    }

    fn pending(c: &CouncilContract, token: &str) -> u128 {
        c.pending_reward(token.into()).0
    }

    // Revenue still to be released, in token units, as of the clock.
    fn streaming(c: &CouncilContract) -> u128 {
        c.config()["stream_remaining"].as_str().unwrap().parse().unwrap()
    }

    // Requests the unstake, waits out the cooldown, unstakes, and returns what the unstake pays.
    fn leave(c: &mut CouncilContract, token: &str, owner: &str) -> u128 {
        act_paid(owner);
        c.request_unstake(token.into());
        act_at(owner, now() + COOLDOWN_NS);
        let paid = pending(c, token);
        let _ = c.unstake(token.into());
        paid
    }

    fn claim(c: &mut CouncilContract, token: &str, owner: &str) -> u128 {
        act_paid(owner);
        let paid = pending(c, token);
        let _ = c.claim(token.into());
        paid
    }

    fn stake(c: &mut CouncilContract, token: &str, owner: &str) {
        act_as(NFT);
        let _ = c.nft_on_transfer(acct("market.near"), acct(owner), token.to_string(), String::new());
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

    // Four seats, token "i" held by seat{i}.near. Each seat has earned 100 before a jury of three is drawn, and earns
    // another 100 while it serves. Returns the token ids of the jury.
    fn serving_case_with_revenue() -> (CouncilContract, Vec<String>) {
        let mut c = council();
        for i in 0..4 {
            stake(&mut c, &i.to_string(), &format!("seat{i}.near"));
        }
        revenue(&mut c, 400);
        release_all();
        act_with_seed(ORACLE, 3);
        let jury = c.draw(U64(1), 3, vec![]);
        let tokens: Vec<String> = jury
            .iter()
            .map(|a| {
                a.as_str()
                    .trim_start_matches("seat")
                    .trim_end_matches(".near")
                    .to_string()
            })
            .collect();
        revenue(&mut c, 400);
        release_all();
        (c, tokens)
    }

    fn unlock(c: &mut CouncilContract, delinquent: Vec<AccountId>) {
        act_as(ORACLE);
        c.unlock_case(U64(1), delinquent);
    }

    #[test]
    fn a_juror_who_never_voted_forfeits_what_the_seat_earned_while_serving_and_keeps_the_rest() {
        let (mut c, jury) = serving_case_with_revenue();
        let silent = &jury[0];
        assert_eq!(pending(&c, silent), 200);
        unlock(&mut c, vec![acct(&format!("seat{silent}.near"))]);
        assert_eq!(
            pending(&c, silent),
            100,
            "the 100 earned before the draw stays, the 100 earned while serving is gone"
        );
        for t in &jury[1..] {
            assert_eq!(pending(&c, t), 200, "a juror who voted keeps everything");
        }
        assert_eq!(streaming(&c), 100, "the forfeit goes back into the stream");

        // The forfeit is released with the next revenue: 100 streaming plus 400 new is 125 for each of the four seats.
        revenue(&mut c, 400);
        release_all();
        assert_eq!(streaming(&c), 0);
        assert_eq!(pending(&c, silent), 225);
        let total: u128 = (0..4).map(|i| pending(&c, &i.to_string())).sum();
        assert_eq!(
            total, 1_200,
            "every token received is still owed to a seat: nothing created or lost"
        );
    }

    // ---- attacks: economics -------------------------------------------------------------------------

    // Revenue used to go to the seats staked at the moment a sweep landed, and a sweep can be called by anyone. A buyer
    // who staked many NFTs just before a sweep took a share of everything gathered since the last one, then left after
    // the cooldown. Revenue now streams over 30 days, so a stake of one block earns one block of it.
    #[test]
    fn staking_just_before_a_sweep_earns_only_the_time_the_seats_were_staked() {
        let mut c = council();
        for i in 0..5 {
            stake(&mut c, &format!("honest{i}"), &format!("honest{i}.near"));
        }
        // A month of fees has gathered. Ten NFTs are staked a moment before the sweep lands, and a block later it has.
        for i in 0..10 {
            stake(&mut c, &format!("sniper{i}"), "sniper.near");
        }
        set_time(SECOND);
        revenue(&mut c, 3_000_000_000_000);
        set_time(2 * SECOND);
        let sniper: u128 = (0..10).map(|i| pending(&c, &format!("sniper{i}"))).sum();
        let honest: u128 = (0..5).map(|i| pending(&c, &format!("honest{i}"))).sum();
        // One second of 30 days is 1 / 2,592,000 of the revenue, and the snipers hold two thirds of the seats.
        let released = 3_000_000_000_000 / STREAM_SECS as u128;
        assert!(
            sniper + honest <= released && released - (sniper + honest) <= 15,
            "one second of the stream has been released"
        );
        assert!(
            sniper <= honest * 2,
            "the snipers' share is their share of that second: {sniper} against {honest}"
        );
        assert!(
            sniper < 3_000_000_000_000 / 1_000_000,
            "nowhere near the two thirds of everything it took before"
        );

        // The cooldown still holds the NFT, and the seat keeps earning while it waits, as any seat would.
        let taken = leave(&mut c, "sniper0", "sniper.near");
        assert!(taken < 3_000_000_000_000 / 1_000, "a minute of staking took {taken}");
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

        // Money received as revenue is always either owed to a seat, still in the stream, or already claimed, whatever
        // order stakes, revenue, time, jury draws, forfeits and claims come in. Nothing is created and nothing is lost
        // beyond a unit of rounding dust per seat.
        #[test]
        fn revenue_is_never_created_or_lost_through_draws_forfeits_and_claims(
            ops in prop::collection::vec((0u8..6, 0u32..16, 1u128..5_000_000), 1..70),
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
                        act_with_seed(ORACLE, pick as u8);
                        let n = 1 + pick % 3;
                        let case = next_case;
                        if let Ok(jury) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.draw(U64(case), n, vec![]))) {
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
                        act_as(OWNER);
                        if stake.serving.is_none() && pending(&c, &token) > 0 {
                            claimed += claim(&mut c, &token, stake.owner.as_str());
                        }
                    }
                    5 => set_time(now() + (amount as u64 % 40) * DAY),
                    _ => {}
                }
                act_as(OWNER);
                let owed: u128 = (0..tokens).map(|t| pending(&c, &t.to_string())).sum();
                let accounted = owed + streaming(&c) + claimed;
                prop_assert!(accounted <= total_in, "more is owed than was ever received: {} against {}", accounted, total_in);
                prop_assert!(total_in - accounted <= tokens as u128 + 2, "revenue was lost: {} of {} unaccounted", total_in - accounted, total_in);
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
        assert_eq!(streaming(&c), 0);
    }

    #[test]
    fn a_second_unlock_does_not_penalise_anyone_twice() {
        let (mut c, jury) = serving_case_with_revenue();
        let silent = vec![acct(&format!("seat{}.near", jury[0]))];
        unlock(&mut c, silent.clone());
        unlock(&mut c, silent);
        assert_eq!((pending(&c, &jury[0]), streaming(&c)), (100, 100));
    }

    #[test]
    fn naming_an_account_that_was_not_on_the_jury_changes_nothing() {
        let (mut c, jury) = serving_case_with_revenue();
        let outsider = (0..4).map(|i| i.to_string()).find(|t| !jury.contains(t)).unwrap();
        unlock(&mut c, vec![acct(&format!("seat{outsider}.near"))]);
        assert_eq!(pending(&c, &outsider), 200);
        assert_eq!(streaming(&c), 0);
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

        let _ = leave(&mut c, "t1", "a.near");
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
        act_at("seat0.near", 1);
        c.request_unstake("0".into());
        act_as(ORACLE);
        c.draw(U64(1), 4, vec![]);
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
        release_all();
        assert_eq!(pending(&c, "t1"), 1_000_000);
        assert_eq!(claim(&mut c, "t1", "a.near"), 1_000_000);
        assert_eq!(pending(&c, "t1"), 0);
        revenue(&mut c, 7);
        release_all();
        assert_eq!(pending(&c, "t1"), 7);
    }

    #[test]
    fn two_seats_split_evenly_and_the_odd_unit_waits_in_the_accumulator() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        stake(&mut c, "t2", "b.near");
        revenue(&mut c, 1_000_001);
        release_all();
        assert_eq!((pending(&c, "t1"), pending(&c, "t2")), (500_000, 500_000));
        revenue(&mut c, 1);
        release_all();
        assert_eq!((pending(&c, "t1"), pending(&c, "t2")), (500_001, 500_001));
    }

    // 2,592,000 units over 30 days is one unit a second.
    #[test]
    fn a_seat_earns_in_proportion_to_the_time_it_was_staked() {
        let mut c = council();
        stake(&mut c, "a", "a.near");
        stake(&mut c, "b", "b.near");
        set_time(DAY);
        revenue(&mut c, STREAM_SECS as u128);
        set_time(11 * DAY);
        stake(&mut c, "c", "c.near");
        assert_eq!(pending(&c, "c"), 0, "a new seat has earned nothing yet");
        set_time(DAY + STREAM_NS);
        // Ten days with two seats, then twenty with three.
        assert_eq!(
            (pending(&c, "a"), pending(&c, "b"), pending(&c, "c")),
            (1_008_000, 1_008_000, 576_000)
        );
    }

    // One seat is staked all along. The other seat is X for the first ten days and Y for the next ten, so each of them
    // is staked for ten days, one right after the arrival and one well after it.
    #[test]
    fn equal_time_staked_earns_equally_whatever_the_arrival_time() {
        let mut c = council();
        stake(&mut c, "always", "z.near");
        stake(&mut c, "x", "x.near");
        revenue(&mut c, STREAM_SECS as u128 * 1_000);
        set_time(10 * DAY - COOLDOWN_NS);
        let x = leave(&mut c, "x", "x.near");
        assert_eq!(now(), 10 * DAY);
        stake(&mut c, "y", "y.near");
        set_time(20 * DAY - COOLDOWN_NS);
        let y = leave(&mut c, "y", "y.near");
        // Ten days at one thousand units a second shared by two seats.
        let expected = 10 * 24 * 60 * 60 * 1_000 / 2;
        assert!(
            x.abs_diff(expected) <= 1 && y.abs_diff(expected) <= 1,
            "x earned {x}, y earned {y}, expected {expected}"
        );
    }

    #[test]
    fn pending_reward_counts_what_has_streamed_but_not_been_accrued() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, 30_000_000);
        set_time(DAY);
        assert_eq!(c.acc_per_seat, 0, "nothing has touched the accumulator");
        assert_eq!(pending(&c, "t1"), 1_000_000, "one day of thirty");
        assert_eq!(claim(&mut c, "t1", "a.near"), 1_000_000);
    }

    #[test]
    fn a_dust_arrival_does_not_slow_what_is_already_streaming() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, STREAM_SECS as u128);
        set_time(15 * DAY);
        let ends = c.stream.ends_at;
        revenue(&mut c, 1);
        // One unit added to 1.3 million left moves the end by that fraction of 15 days, about a second, not by 15 days.
        assert!(
            c.stream.ends_at - ends <= 2 * SECOND,
            "the end moved by {} ns",
            c.stream.ends_at - ends
        );
    }

    #[test]
    fn a_large_arrival_moves_the_end_towards_a_full_thirty_days() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, STREAM_SECS as u128);
        set_time(15 * DAY);
        // Half is left and ends in 15 days. As much again arrives, so the end is the average of 15 and 30 days.
        revenue(&mut c, STREAM_SECS as u128 / 2);
        assert_eq!(c.stream.ends_at, 15 * DAY + 22 * DAY + DAY / 2);
    }

    #[test]
    fn unstaking_pays_the_seat_and_the_token_restaked_by_someone_else_starts_at_zero() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        stake(&mut c, "t2", "b.near");
        revenue(&mut c, 1_000);
        release_all();
        assert_eq!(leave(&mut c, "t1", "a.near"), 500);
        assert_eq!(pending(&c, "t1"), 0);
        stake(&mut c, "t1", "c.near");
        assert_eq!(pending(&c, "t1"), 0, "the token carries nothing to its next owner");
        revenue(&mut c, 1_000);
        release_all();
        assert_eq!((pending(&c, "t1"), pending(&c, "t2")), (500, 1_000));
    }

    // Time with no seats stretches the end of the stream by the same time, so nothing is lost.
    #[test]
    fn revenue_that_arrives_with_no_seats_is_released_once_a_seat_exists() {
        let mut c = council();
        revenue(&mut c, STREAM_SECS as u128);
        set_time(10 * DAY);
        stake(&mut c, "t1", "a.near");
        assert_eq!((pending(&c, "t1"), streaming(&c)), (0, STREAM_SECS as u128));
        set_time(10 * DAY + SECOND);
        assert_eq!(pending(&c, "t1"), 1);
        set_time(40 * DAY - SECOND);
        assert!(pending(&c, "t1") < STREAM_SECS as u128);
        set_time(40 * DAY);
        assert_eq!((pending(&c, "t1"), streaming(&c)), (STREAM_SECS as u128, 0));
    }

    // While a seat is out for a transfer it is not counted, so what streams then goes to the others. A failed
    // transfer brings it back with what it had when it left, never a share of what streamed meanwhile.
    #[test]
    fn a_failed_unstake_restores_the_seat_with_exactly_what_it_had_earned() {
        for fail_at_nft in [false, true] {
            let mut c = council();
            stake(&mut c, "t1", "a.near");
            stake(&mut c, "t2", "b.near");
            revenue(&mut c, 1_000);
            release_all();
            act_paid("a.near");
            c.request_unstake("t1".into());
            let s = c.stake_of("t1".into()).unwrap();
            act_at("a.near", now() + COOLDOWN_NS);
            let _ = c.unstake("t1".into());
            revenue(&mut c, 3_000);
            // The transfer fails a day later.
            set_time(now() + DAY);
            act_as("council.near");
            if fail_at_nft {
                // The payout went through, only the sub-unit remainder is left on the seat.
                c.on_unstaked("t1".into(), s, U128(0), Err(PromiseError::Failed));
                assert_eq!(pending(&c, "t1"), 0);
            } else {
                let _ = c.on_unstake_paid("t1".into(), s, U128(500 * PRECISION), Err(PromiseError::Failed));
                assert_eq!(pending(&c, "t1"), 500);
            }
            assert_eq!(
                pending(&c, "t2"),
                600,
                "t2 was the only seat for the day, so that day's 100 is all its own"
            );
            assert_eq!((streaming(&c), c.seat_count()), (2_900, 2));

            // From now on the restored seat shares the stream like any other.
            release_all();
            assert_eq!(pending(&c, "t2"), 600 + 1_450);
            assert_eq!(pending(&c, "t1"), if fail_at_nft { 1_450 } else { 500 + 1_450 });
        }
    }

    #[test]
    fn a_failed_claim_can_be_claimed_again() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, 900);
        release_all();
        assert_eq!(claim(&mut c, "t1", "a.near"), 900);
        revenue(&mut c, 100);
        release_all();
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

        // Against an exact model of the stream: one arrival of 1,000 units a second for 30 days, then seats staking,
        // claiming and time passing at random. For each stretch of time a seat is owed the rate times the stretch,
        // divided by the seats staked in it. What a seat has earned and claimed never differs from the model by more
        // than a unit or two.
        #[test]
        fn a_seat_earns_what_the_stream_released_while_it_was_staked(
            ops in proptest::collection::vec((0u8..3, 0usize..4, 1u64..2_000_000), 1..40)
        ) {
            const RATE: u128 = 1_000;
            let total = STREAM_SECS as u128 * RATE;
            let mut c = council();
            stake(&mut c, "t0", "o0.near");
            revenue(&mut c, total);
            let (mut staked, mut owed, mut claimed) = ([false; 4], [0u128; 4], [0u128; 4]);
            staked[0] = true;
            let mut seconds = 0u64;
            for (op, token, amount) in ops {
                match op {
                    0 if seconds + amount <= STREAM_SECS => {
                        let seats = staked.iter().filter(|s| **s).count() as u128;
                        for t in 0..4 {
                            if staked[t] {
                                owed[t] += total * PRECISION * amount as u128 / STREAM_SECS as u128 / seats;
                            }
                        }
                        seconds += amount;
                        set_time(seconds * SECOND);
                    }
                    1 if !staked[token] => {
                        stake(&mut c, &format!("t{token}"), &format!("o{token}.near"));
                        staked[token] = true;
                    }
                    2 if staked[token] => {
                        act_as(OWNER);
                        if pending(&c, &format!("t{token}")) > 0 {
                            claimed[token] += claim(&mut c, &format!("t{token}"), &format!("o{token}.near"));
                        }
                    }
                    _ => {}
                }
                act_as(OWNER);
                for t in 0..4 {
                    if staked[t] {
                        let got = pending(&c, &format!("t{t}")) + claimed[t];
                        let expected = owed[t] / PRECISION;
                        prop_assert!(got <= expected + 1 && expected <= got + 2, "t{} has {} but the stream released {}", t, got, expected);
                    }
                }
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
            (e["event"].as_str(), e["data"]["token_ids"].clone()),
            (Some("tokens_allowed"), near_sdk::serde_json::json!(["a", "b"]))
        );
        act_as(OWNER);
        c.set_token_range(U64(3), U64(9));
        let e = last_event();
        assert_eq!(
            (e["event"].as_str(), e["data"].clone()),
            (
                Some("token_range_set"),
                near_sdk::serde_json::json!({ "first": "3", "last": "9" })
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

    #[test]
    fn total_received_counts_every_revenue_arrival_and_nothing_else() {
        let mut c = council();
        assert_eq!(c.total_received().0, 0);
        stake(&mut c, "t1", "a.near");
        revenue(&mut c, 400);
        revenue(&mut c, 7);
        assert_eq!(
            (c.total_received().0, c.config()["total_received"].as_str()),
            (407, Some("407"))
        );
        release_all();
        claim(&mut c, "t1", "a.near");
        assert_eq!(c.total_received().0, 407, "paying a seat out does not lower it");
    }

    #[test]
    fn a_forfeit_is_not_revenue_received() {
        let (mut c, jury) = serving_case_with_revenue();
        assert_eq!(c.total_received().0, 800);
        unlock(&mut c, vec![acct(&format!("seat{}.near", jury[0]))]);
        assert_eq!(streaming(&c), 100, "a forfeit went back into the stream");
        assert_eq!(c.total_received().0, 800);
    }

    // ---- gas floors ---------------------------------------------------------------------------------------

    fn act_with_gas(who: &str, tgas: u64) {
        testing_env!(context(who)
            .attached_deposit(NearToken::from_yoctonear(1))
            .prepaid_gas(Gas::from_tgas(tgas))
            .build());
    }

    fn refusal(f: impl FnOnce()) -> String {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a refusal");
        err.downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    #[test]
    fn an_unstake_or_claim_below_its_gas_floor_is_refused_with_the_amount_to_attach() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_with_gas("a.near", 57);
        assert_eq!(
            refusal(|| drop(c.unstake("t1".into()))),
            "attach at least 58 TGas: an unstake pays what the seat earned and then returns the NFT"
        );
        act_with_gas("a.near", 32);
        assert_eq!(
            refusal(|| drop(c.claim("t1".into()))),
            "attach at least 33 TGas: a claim sends the payout and then settles it"
        );
    }

    #[test]
    fn an_unstake_or_claim_with_exactly_its_floor_gets_past_the_check() {
        let mut c = council();
        stake(&mut c, "t1", "a.near");
        act_with_gas("a.near", 58);
        let unstake = refusal(|| drop(c.unstake("t1".into())));
        assert!(unstake.contains("request an unstake first"), "{unstake}");
        act_with_gas("a.near", 33);
        let claim = refusal(|| drop(c.claim("t1".into())));
        assert!(claim.contains("nothing to claim"), "{claim}");
        assert_eq!(
            (GAS_UNSTAKE_FLOOR, GAS_CLAIM_FLOOR),
            (Gas::from_tgas(58), Gas::from_tgas(33))
        );
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
        env::state_write(&c);
        drop(c);
        testing_env!(context("alice.near").build());
        let migrated = CouncilContract::migrate();
        assert_eq!(
            (migrated.upgrade_proven, migrated.state_version, migrated.seat_count()),
            (true, 1, 1)
        );
        assert_eq!(migrated.config()["upgrade_proven"], true);
    }

    #[test]
    #[should_panic(expected = "migrate expects version 1")]
    fn migrate_refuses_state_written_by_another_version() {
        let mut c = council();
        c.state_version = 2;
        env::state_write(&c);
        drop(c);
        testing_env!(context("alice.near").build());
        CouncilContract::migrate();
    }
}
