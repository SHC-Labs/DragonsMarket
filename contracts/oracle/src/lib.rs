// Resolution contract for the pitch test. Someone proposes an outcome with a bond, there is a
// challenge window, and a challenge names a different answer and sends the case to a jury drawn from the Council
// registry that votes in two steps, a hidden commitment and then the reveal, for one of the two answers. A jury that
// does not decide gets one larger second jury. Final outcomes are written to the market contract, which only trusts
// this contract.
// The JSON interface takes one argument per field, so a few methods are long on purpose.
#![allow(clippy::too_many_arguments)]

use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, CurveType, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PublicKey,
};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
// The verifier burned 3.8 TGas for a payout from a contract in the sandbox (INTENTS-PROOF.md), so this is a wide margin.
const GAS_MT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_APPLY: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
// Measured against the Council's seat cap; see the note on CouncilContract.
const GAS_DRAW: Gas = Gas::from_tgas(250);
const GAS_DRAWN: Gas = Gas::from_tgas(15);
// unlock_case burned 8.9 TGas for a 21 juror case where every juror forfeits revenue, the most work it can do
// (measured in the sandbox), so 15 leaves room.
const GAS_UNLOCK: Gas = Gas::from_tgas(15);
// The gas floors. Each is what the method reserves for the calls it sends plus a margin over what it burns itself, and
// each was checked against the least that worked in the sandbox (see contracts/AUDIT.md). A call below its floor fails
// part way through with a host error that names no amount, so these refuse it first and say how much to attach.
//
// A call that settles a case sends the answer to the market with its callback, then releases the first jury and, after a
// second round, the second. Its own work was 8.4 TGas in the worst case measured: a second round of 21 jurors, the 11th
// of them revealing a 1,000 byte reason. 72 TGas was the least that worked there.
const GAS_SETTLE_OVERHEAD: Gas = Gas::from_tgas(20);
const GAS_SETTLE_FLOOR: Gas =
    Gas::from_gas(GAS_APPLY.as_gas() + GAS_CALLBACK.as_gas() + 2 * GAS_UNLOCK.as_gas() + GAS_SETTLE_OVERHEAD.as_gas());
// The draw's own work is about 2.5 TGas; 270 TGas was the least that worked with the 250 it hands the council.
const GAS_DRAW_OVERHEAD: Gas = Gas::from_tgas(10);
const GAS_DRAW_FLOOR: Gas = Gas::from_gas(GAS_DRAW.as_gas() + GAS_DRAWN.as_gas() + GAS_DRAW_OVERHEAD.as_gas());
// retry_unlock attaches no fixed gas, so each of the two releases takes an equal share of what the caller attached. The
// floor leaves each one the 15 that settle gives it.
const GAS_RETRY_UNLOCK_OVERHEAD: Gas = Gas::from_tgas(5);
const GAS_RETRY_UNLOCK_FLOOR: Gas = Gas::from_gas(2 * GAS_UNLOCK.as_gas() + GAS_RETRY_UNLOCK_OVERHEAD.as_gas());
// A bond withdrawal sends the payout and then settles it, and burns about 3 TGas itself. 29 TGas was the least that worked in the
// sandbox.
const GAS_WITHDRAW_OVERHEAD: Gas = Gas::from_tgas(8);
const GAS_WITHDRAW_FLOOR: Gas =
    Gas::from_gas(GAS_MT_TRANSFER.as_gas() + GAS_CALLBACK.as_gas() + GAS_WITHDRAW_OVERHEAD.as_gas());
const SETTLE_REASON: &str = "a call that settles a case sends the answer to the market and releases the juries";
const NS_PER_MS: u64 = 1_000_000;
// The layout of the state below. migrate reads exactly this one and refuses any other.
const STATE_VERSION: u16 = 1;
// Token ids in the verifier are exactly "nep141:<contract>". Anything else would never match a transfer.
const NEP141_PREFIX: &str = "nep141:";
// Settling a case still takes one more cross-contract hop (apply) to reach the market. This keeps a case that used
// its full allotted time clear of resolve_by, after which anyone can send the market its deadline answer.
const APPLY_BUFFER_NS: u64 = 30_000_000_000;
// The council keeps one jury per key. A case's first jury is kept under the market id and its second under this bit
// set on the id, so the two can never be taken for each other.
const SECOND_ROUND_KEY: u64 = 1 << 63;
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
// Of the challenger's bond when neither jury decided, the share the jurors who revealed split. The rest goes to the
// proposer. With no juror having revealed, this share goes to the no-decision recipient instead, so it always leaves the
// two parties.
const NO_DECISION_JUROR_SHARE_BPS: u128 = 5_000;

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

// Set by market when it creates a price market, so the oracle knows what to check a signed price against.
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
    // The windows in force when the market was registered. Every case of this market runs on them, so a longer setting
    // later can never leave an already registered market without the time to be answered.
    window_ns: U64,
    panel_deadline_ns: U64,
    draw_window_ns: U64,
}

impl MarketInfo {
    fn case_span_ns(&self) -> u64 {
        case_span_ns(self.window_ns.0, self.draw_window_ns.0, self.panel_deadline_ns.0)
    }
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
    // The bond in force when the answer was proposed. The challenge must match it and the case pays it out, so a new
    // bond setting touches only new cases.
    bond: U128,
    evidence: String,
    window_ends_at: U64,
    challenger: Option<AccountId>,
    // What the challenger says the answer is. Jurors vote for it or for `proposed`, so with an odd jury and full
    // turnout a majority always exists.
    challenger_answer: Option<Outcome>,
    // 0 for the first jury, 1 for the one jury that is drawn if the first did not decide.
    round: u8,
    // How many jurors the current round draws. Fixed when the round starts, so changing the setting later never
    // touches an open case.
    jury_size: u32,
    // The last moment the current round's jury can be drawn. A round never drawn by then did not decide.
    draw_by: U64,
    draw_after_height: U64,
    // Both are set when the jury is seated, and count from that moment.
    commit_ends_at: U64,
    panel_deadline: U64,
    // The current round's jurors, drawn once. Changing the Council later never touches an open case.
    panel: Vec<AccountId>,
    // The first jury once a second one has been called for. It cannot sit again, and it is still owed or penalised
    // for what it did.
    first_panel: Vec<AccountId>,
    commits: Vec<Commit>,
    // Revealed votes only, from both rounds.
    votes: Vec<Vote>,
    final_outcome: Option<Outcome>,
    applied: bool,
    challenged_at: U64,
    // Set when a disputed case settles: the drawn jurors of either round who did not vote. The Council takes the
    // revenue their seats earned while serving. Kept on the case so retry_unlock sends the same list.
    delinquent: Vec<AccountId>,
}

// The NEAR Intents verifier. Bonds arrive in this contract's account there, and payouts are sent out of it.
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

#[ext_contract(ext_market)]
pub trait Market {
    fn set_outcome(&mut self, market_id: U64, outcome: Outcome);
}

#[ext_contract(ext_council)]
pub trait Council {
    fn draw(&mut self, case_key: U64, n: u32, exclude: Vec<AccountId>) -> Vec<AccountId>;
    fn unlock_case(&mut self, case_key: U64, delinquent: Vec<AccountId>);
}

#[near(contract_state, contract_metadata(standard(standard = "nep297", version = "1.0.0")))]
#[derive(PanicOnDefault)]
pub struct OracleContract {
    // First, so migrate can read it before it trusts the rest of the layout.
    state_version: u16,
    // Set by migrate, so it is true only once an upgrade has gone through. seal refuses until then.
    upgrade_proven: bool,
    // Set by upgrade just before it sends the deploy and migrate batch, cleared by migrate. migrate refuses to run when it
    // is not set, so the proof cannot come from calling migrate by hand. A batch that fails leaves it set in the old code,
    // and the next upgrade sets it again.
    upgrade_in_flight: bool,
    owner: AccountId,
    // Set by propose_owner. Ownership moves only when this account calls accept_owner.
    pending_owner: Option<AccountId>,
    // The fast key for protective changes: it can remove a price publisher at once. Adding one, and changing how many
    // must agree, stay with the owner, which is the DAO.
    operator: AccountId,
    market: AccountId,
    // The Intents verifier that holds every bond, and the exact id of the collateral in it, "nep141:<token>".
    verifier: AccountId,
    collateral_token_id: String,
    bond: u128,
    window_ns: u64,
    // How long each jury has once it is seated, the commit phase and then the reveal phase.
    panel_deadline_ns: u64,
    // How long after a challenge, or after the first jury fails, a jury can still be drawn.
    draw_window_ns: u64,
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
    // Where the challenger's half bond goes when neither jury decided and no juror revealed. The owner is the DAO, which
    // takes no part in the token flow, so this is normally the business wallet.
    no_decision_recipient: AccountId,
    markets: LookupMap<u64, MarketInfo>,
    cases: LookupMap<u64, Case>,
    // Bonds waiting to be withdrawn, by account.
    claimable: LookupMap<AccountId, u128>,
    // The sum of every entry in claimable, and the bonds sitting in cases that are not final: one after a proposal, two
    // after a challenge. Kept so total_owed can add them up without walking a map.
    claimable_total: u128,
    bonds_held: u128,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "oracle", "version": "1.0.0", "event": event, "data": data })
    ));
}

fn valid_jury_size(n: u32) -> bool {
    n % 2 == 1 && n as usize <= MAX_PANEL
}

// How long a case can take from its proposal: the challenge window, then two rounds, each a draw window and a full
// panel deadline.
fn case_span_ns(window_ns: u64, draw_window_ns: u64, panel_deadline_ns: u64) -> u64 {
    window_ns + 2 * (draw_window_ns + panel_deadline_ns)
}

fn distinct(accounts: &[AccountId]) -> bool {
    let mut seen: Vec<&AccountId> = accounts.iter().collect();
    seen.sort();
    seen.dedup();
    seen.len() == accounts.len()
}

fn commitment_of(juror: &AccountId, outcome: Outcome, salt: &str) -> String {
    env::sha256_array(format!("{juror}:{}:{salt}", outcome.word()))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn is_commitment(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// The drawn jurors who did not vote. In the first jury after it was replaced that is everyone who never revealed, its
// time being over. In the current jury it is those who never committed, and, once the reveal window is over, those
// who committed and never revealed. A case that settles early on a majority leaves the other committed jurors no
// chance to reveal, so while the window is still open they are not counted.
fn delinquent_jurors(case: &Case, now: u64) -> Vec<AccountId> {
    let revealed = |j: &AccountId| case.votes.iter().any(|v| v.juror == *j);
    let committed = |j: &AccountId| case.commits.iter().any(|c| c.juror == *j);
    let first = case.first_panel.iter().filter(|j| !revealed(j));
    let current = case
        .panel
        .iter()
        .filter(|j| !revealed(j) && (!committed(j) || now > case.panel_deadline.0));
    first.chain(current).cloned().collect()
}

// Whether the jury drawn for the current round did its work or ran out of time: with no jury seated that is the last
// moment to draw, with one seated it is the end of the reveal phase.
fn round_is_over(case: &Case, now: u64) -> bool {
    if case.panel.is_empty() {
        now > case.draw_by.0
    } else {
        now > case.panel_deadline.0
    }
}

fn council_key(id: u64, round: u8) -> U64 {
    U64(if round == 0 { id } else { id | SECOND_ROUND_KEY })
}

// How a case ended, which decides who is paid what.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ruling {
    Unchallenged,
    // A majority of a jury voted for the outcome.
    Decided,
    // Neither jury reached a majority in time.
    NoDecision,
}

impl Ruling {
    fn word(self) -> &'static str {
        match self {
            Ruling::Unchallenged => "unchallenged",
            Ruling::Decided => "decided",
            Ruling::NoDecision => "no_decision",
        }
    }
}

// What a publisher signs: this contract and network, the market, its observation time, the price and its decimals.
// Everything but the price is fixed by the market, so one signature is good for exactly one price of one market.
fn price_message(contract: &AccountId, network: &str, market_id: u64, rule: &PriceRule, price: u128) -> String {
    format!(
        "price:v1:{contract}:{network}:{market_id}:{}:{price}:{}",
        rule.observation_time.0, rule.decimals
    )
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
impl OracleContract {
    // Only this account can run it, so a deploy and init batch signed by it is the one way in.
    #[private]
    #[init]
    pub fn new(
        owner_id: AccountId,
        market_contract: AccountId,
        verifier_id: AccountId,
        collateral_token_id: String,
        bond: U128,
        window_ms: U64,
        panel_deadline_ms: U64,
        draw_window_ms: U64,
        council: AccountId,
        jury_size: u32,
        draw_delay_blocks: U64,
        min_proposal_ms: U64,
        operator_id: AccountId,
        network: String,
        price_threshold: u32,
        no_decision_recipient: AccountId,
    ) -> Self {
        require!(
            collateral_token_id.starts_with(NEP141_PREFIX),
            "the collateral token id must look like nep141:<token>"
        );
        require!(bond.0 > 0, "bond must be positive");
        require!(
            !network.is_empty() && !network.contains(':'),
            "the network name must be a word without a colon"
        );
        require!(price_threshold > 0, "at least one publisher must sign a price");
        require!(
            window_ms.0 > 0 && panel_deadline_ms.0 > 0 && draw_window_ms.0 > 0 && min_proposal_ms.0 > 0,
            "windows must be positive"
        );
        require!(valid_jury_size(jury_size), "jury size must be odd and at most 21");
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: false,
            upgrade_in_flight: false,
            owner: owner_id,
            pending_owner: None,
            operator: operator_id,
            market: market_contract,
            verifier: verifier_id,
            collateral_token_id,
            bond: bond.0,
            window_ns: window_ms.0 * NS_PER_MS,
            panel_deadline_ns: panel_deadline_ms.0 * NS_PER_MS,
            draw_window_ns: draw_window_ms.0 * NS_PER_MS,
            min_proposal_ns: min_proposal_ms.0 * NS_PER_MS,
            council,
            jury_size,
            draw_delay_blocks: draw_delay_blocks.0,
            network,
            publishers: vec![],
            price_threshold,
            no_decision_recipient,
            markets: LookupMap::new(Key::Markets),
            cases: LookupMap::new(Key::Cases),
            claimable: LookupMap::new(Key::Claimable),
            claimable_total: 0,
            bonds_held: 0,
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

    // Owner only, which is the DAO. SputnikDAO runs a proposal as soon as it passes, so its voting period is the only
    // delay a code change waits out. The deploy and migrate are one batch: a migrate that panics puts the old code back.
    // Attach at least 100 TGas.
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

    // Applies to cases proposed from now on. A case already proposed keeps the bond it was proposed with.
    pub fn set_bond(&mut self, bond: U128) {
        self.only_owner();
        require!(bond.0 > 0, "bond must be positive");
        emit("bond_set", json!({ "bond": bond }));
        self.bond = bond.0;
    }

    // The four windows below apply to markets registered from now on. A registered market keeps the ones it was
    // registered with, and min_proposal_ms only matters at registration.
    pub fn set_window_ms(&mut self, window_ms: U64) {
        self.only_owner();
        require!(window_ms.0 > 0, "windows must be positive");
        emit("window_set", json!({ "window_ms": window_ms }));
        self.window_ns = window_ms.0 * NS_PER_MS;
    }

    pub fn set_panel_deadline_ms(&mut self, panel_deadline_ms: U64) {
        self.only_owner();
        require!(panel_deadline_ms.0 > 0, "windows must be positive");
        emit("panel_deadline_set", json!({ "panel_deadline_ms": panel_deadline_ms }));
        self.panel_deadline_ns = panel_deadline_ms.0 * NS_PER_MS;
    }

    pub fn set_min_proposal_ms(&mut self, min_proposal_ms: U64) {
        self.only_owner();
        require!(min_proposal_ms.0 > 0, "windows must be positive");
        emit("min_proposal_set", json!({ "min_proposal_ms": min_proposal_ms }));
        self.min_proposal_ns = min_proposal_ms.0 * NS_PER_MS;
    }

    pub fn set_draw_window_ms(&mut self, draw_window_ms: U64) {
        self.only_owner();
        require!(draw_window_ms.0 > 0, "windows must be positive");
        emit("draw_window_set", json!({ "draw_window_ms": draw_window_ms }));
        self.draw_window_ns = draw_window_ms.0 * NS_PER_MS;
    }

    // Counted from each challenge and each second round from now on, in blocks.
    pub fn set_draw_delay_blocks(&mut self, draw_delay_blocks: U64) {
        self.only_owner();
        emit("draw_delay_set", json!({ "draw_delay_blocks": draw_delay_blocks }));
        self.draw_delay_blocks = draw_delay_blocks.0;
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

    pub fn set_no_decision_recipient(&mut self, recipient: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        emit("no_decision_recipient_set", json!({ "recipient": recipient }));
        self.no_decision_recipient = recipient;
    }

    // Adding a publisher grants power over prices, so it is the owner's (a DAO proposal).
    pub fn add_publisher(&mut self, key: PublicKey) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(key.curve_type() == CurveType::ED25519, "publishers use ed25519 keys");
        require!(!self.publishers.contains(&key), "already a publisher");
        require!(
            self.publishers.len() < MAX_PUBLISHERS,
            "there can be at most 10 publishers"
        );
        emit("publisher_added", json!({ "key": key }));
        self.publishers.push(key);
    }

    // Removing one only ever takes power away, so the operator can do it at once: a leaked key is cut off in one call
    // instead of waiting out a vote. It can never leave fewer publishers than must sign, or no price could be accepted.
    pub fn remove_publisher(&mut self, key: PublicKey) {
        let who = env::predecessor_account_id();
        require!(who == self.operator || who == self.owner, "operator or owner only");
        let at = self
            .publishers
            .iter()
            .position(|k| *k == key)
            .unwrap_or_else(|| env::panic_str("not a publisher"));
        require!(
            self.publishers.len() > self.price_threshold as usize,
            "that would leave fewer publishers than must sign"
        );
        emit("publisher_removed", json!({ "key": key, "by": who }));
        self.publishers.remove(at);
    }

    pub fn set_price_threshold(&mut self, threshold: u32) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(
            threshold > 0 && threshold as usize <= self.publishers.len(),
            "the threshold must be between 1 and the number of publishers"
        );
        emit("price_threshold_set", json!({ "threshold": threshold }));
        self.price_threshold = threshold;
    }

    // Called by the market contract when a market is created. Calling twice changes nothing. A market that
    // leaves less than min_resolve_gap_ns between close_at and resolve_by is refused: no case could ever finish
    // in it, so the only way it could end is a Void at its deadline, which pays the cheap side a windfall.
    // A price market is measured from its observation time, the moment its answer is first known, and needs enough
    // publishers configured that it can be answered at all.
    pub fn register_market(
        &mut self,
        market_id: U64,
        close_at: U64,
        resolve_by: U64,
        rule_hash: String,
        price_rule: Option<PriceRule>,
    ) {
        require!(env::predecessor_account_id() == self.market, "market contract only");
        if self.markets.contains_key(&market_id.0) {
            return;
        }
        let answerable_from = match &price_rule {
            Some(rule) => {
                require!(
                    self.publishers.len() >= self.price_threshold as usize,
                    "not enough price publishers are configured"
                );
                require!(
                    rule.observation_time.0 >= close_at.0,
                    "observation_time must not be before close_at"
                );
                rule.observation_time.0
            }
            None => close_at.0,
        };
        require!(
            resolve_by.0.saturating_sub(answerable_from) >= self.min_resolve_gap_ns(),
            "resolve_by is too soon after close_at for a case to finish"
        );
        self.markets.insert(
            market_id.0,
            MarketInfo {
                close_at,
                resolve_by,
                rule_hash,
                price_rule,
                window_ns: U64(self.window_ns),
                panel_deadline_ns: U64(self.panel_deadline_ns),
                draw_window_ns: U64(self.draw_window_ns),
            },
        );
        emit("market_registered", json!({ "market_id": market_id.0.to_string() }));
    }

    // Bonds arrive here, from the verifier, after a user's mt_transfer_call (or a signed transfer with a notification), once
    // the money is already in this contract's Intents account. Propose: "propose:<market>:<yes|no|void>:<evidence url>".
    // Challenge: "challenge:<market>:<yes|no|void>", naming the answer the challenger says is right.
    // Answer a price market: "price:<market>:<price>:<publisher key>.<signature hex>,<publisher key>.<signature hex>,...".
    // The answer is the amounts to hand back, so 0 keeps the whole bond. Panicking makes the verifier refund the sender in
    // full. A plain deposit never reaches here: it is surplus that nobody is credited for (see total_owed). There is no gas
    // floor: the verifier keeps about 21 TGas of what is attached, a bond opened its case with 22 attached and not with 21
    // (sandbox), and a receipt that runs short fails and is refunded.
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
        let mut parts = msg.splitn(4, ':');
        let action = parts.next().unwrap_or("");
        let id: u64 = parts
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| env::panic_str("bad market id"));
        // A challenge matches the bond its case was proposed with, which may not be today's.
        let due = match action {
            "challenge" => self.cases.get(&id).map_or(self.bond, |case| case.bond.0),
            _ => self.bond,
        };
        require!(amount.0 == due, "send exactly the bond");
        match action {
            "propose" => {
                let outcome = parse_outcome(parts.next().unwrap_or(""));
                let evidence = parts.next().unwrap_or("").to_string();
                let is_price_market = self.markets.get(&id).is_some_and(|m| m.price_rule.is_some());
                require!(!is_price_market, "a price market is answered with a signed price");
                self.propose(sender_id, id, outcome, evidence, &[]);
            }
            "price" => {
                let price: u128 = parts
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| env::panic_str("bad price"));
                self.answer_price(sender_id, id, price, parts.next().unwrap_or(""));
            }
            "challenge" => self.challenge(sender_id, id, parse_outcome(parts.next().unwrap_or(""))),
            _ => env::panic_str("unknown action"),
        }
        self.bonds_held += amount.0;
        vec![U128(0)]
    }

    // Anyone can call this once the draw delay has passed and until the case's draw_by. The seed is the block seed of the
    // council's receipt, a block after the challenge, so nobody knows the jury when they challenge or can steer it with
    // what they pass. A failed draw changes nothing and can be retried. The second jury leaves out the first one, along
    // with the proposer and the challenger.
    pub fn resolve_draw(&mut self, market_id: U64) -> Promise {
        upgrade::require_gas(GAS_DRAW_FLOOR, "the jury draw reads every staked seat");
        let case = self.case(market_id.0);
        require!(case.stage == Stage::Disputed, "no open dispute");
        require!(case.panel.is_empty(), "the jury is already drawn");
        require!(
            env::block_height() >= case.draw_after_height.0,
            "too early to draw the jury"
        );
        require!(env::block_timestamp() <= case.draw_by.0, "too late to draw a jury");
        let challenger = case.challenger.unwrap_or_else(|| env::panic_str("no challenger"));
        let mut exclude = vec![case.proposer, challenger];
        exclude.extend(case.first_panel);
        ext_council::ext(self.council.clone())
            .with_static_gas(GAS_DRAW)
            .draw(council_key(market_id.0, case.round), case.jury_size, exclude)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_DRAWN)
                    .on_drawn(market_id, case.round),
            )
    }

    // Two draws can be in flight at once. The first good one to land is the jury, and the jury's time starts when it
    // lands. A draw for a round the case has moved past is refused.
    #[private]
    pub fn on_drawn(
        &mut self,
        market_id: U64,
        round: u8,
        #[callback_result] result: Result<Vec<AccountId>, PromiseError>,
    ) {
        let mut case = self.case(market_id.0);
        match result {
            Ok(jury)
                if case.stage == Stage::Disputed
                    && case.round == round
                    && case.panel.is_empty()
                    && jury.len() == case.jury_size as usize
                    && distinct(&jury) =>
            {
                let seated = env::block_timestamp();
                let panel_deadline_ns = self.market_info(market_id.0).panel_deadline_ns.0;
                emit(
                    "jury_drawn",
                    json!({ "market_id": market_id.0.to_string(), "round": round, "panel": jury }),
                );
                case.commit_ends_at = U64(seated + panel_deadline_ns / 2);
                case.panel_deadline = U64(seated + panel_deadline_ns);
                case.panel = jury;
                self.cases.insert(market_id.0, case);
            }
            _ => emit(
                "draw_failed",
                json!({ "market_id": market_id.0.to_string(), "round": round }),
            ),
        }
    }

    // A juror's vote stays hidden until the commit phase ends. The commitment is
    // hex(sha256("<juror>:<yes|no|void>:<salt>")), so one juror cannot reuse another's. A juror must commit to the
    // proposed answer or the challenger's, because no other vote can be revealed.
    #[payable]
    pub fn commit_vote(&mut self, market_id: U64, commitment: String) {
        assert_one_yocto();
        let juror = env::predecessor_account_id();
        let mut case = self.case(market_id.0);
        require!(case.panel.contains(&juror), "not on the panel for this case");
        require!(case.stage == Stage::Disputed, "no open dispute");
        require!(
            env::block_timestamp() < case.commit_ends_at.0,
            "the commit phase is over"
        );
        require!(
            is_commitment(&commitment),
            "commitment must be 64 lowercase hex characters"
        );
        require!(!case.commits.iter().any(|c| c.juror == juror), "already committed");
        case.commits.push(Commit {
            juror: juror.clone(),
            commitment: commitment.clone(),
        });
        self.cases.insert(market_id.0, case);
        emit(
            "vote_committed",
            json!({ "market_id": market_id.0.to_string(), "juror": juror, "commitment": commitment }),
        );
    }

    // ponytail: a juror who commits and never reveals just does not count. The penalty for a no-show
    // moves into the Council registry with staking in slice 2.
    #[payable]
    pub fn reveal_vote(&mut self, market_id: U64, outcome: Outcome, salt: String, reason: String) {
        upgrade::require_gas(GAS_SETTLE_FLOOR, SETTLE_REASON);
        assert_one_yocto();
        let juror = env::predecessor_account_id();
        require!(!reason.trim().is_empty(), "a reason is required");
        require!(reason.len() <= MAX_REASON, "reason is too long");
        require!(salt.len() <= MAX_SALT, "salt is too long");
        let mut case = self.case(market_id.0);
        let commit = case
            .commits
            .iter()
            .find(|c| c.juror == juror)
            .unwrap_or_else(|| env::panic_str("no commitment to reveal"));
        require!(case.panel.contains(&juror), "not on the panel for this case");
        require!(case.stage == Stage::Disputed, "no open dispute");
        let answers = [
            case.proposed,
            case.challenger_answer
                .unwrap_or_else(|| env::panic_str("no challenger answer")),
        ];
        require!(
            answers.contains(&outcome),
            "vote for the proposed answer or the challenger's answer"
        );
        let now = env::block_timestamp();
        require!(now >= case.commit_ends_at.0, "the commit phase is still open");
        require!(now <= case.panel_deadline.0, "the panel deadline passed");
        require!(!case.votes.iter().any(|v| v.juror == juror), "already revealed");
        require!(
            commit.commitment == commitment_of(&juror, outcome, &salt),
            "the vote does not match the commitment"
        );
        case.votes.push(Vote {
            juror: juror.clone(),
            outcome,
            reason: reason.clone(),
        });
        emit(
            "vote_revealed",
            json!({ "market_id": market_id.0.to_string(), "juror": juror, "outcome": outcome, "reason": reason }),
        );

        let needed = case.panel.len() / 2 + 1;
        let winner = answers.into_iter().find(|answer| {
            case.votes
                .iter()
                .filter(|v| v.outcome == *answer && case.panel.contains(&v.juror))
                .count()
                >= needed
        });
        self.cases.insert(market_id.0, case);
        if let Some(w) = winner {
            self.settle(market_id.0, w, Ruling::Decided);
        }
    }

    // Anyone can call this. Settles an unchallenged proposal after its window. For a dispute whose jury did not decide
    // in time it calls for the one second jury, or, if that was the second jury or there is no time left for another
    // round before resolve_by, settles it with no decision.
    pub fn finalize(&mut self, market_id: U64) {
        upgrade::require_gas(GAS_SETTLE_FLOOR, SETTLE_REASON);
        let case = self.case(market_id.0);
        let now = env::block_timestamp();
        match case.stage {
            Stage::Proposed => {
                require!(now >= case.window_ends_at.0, "challenge window is still open");
                self.settle(market_id.0, case.proposed, Ruling::Unchallenged);
            }
            Stage::Disputed => {
                require!(round_is_over(&case, now), "the panel still has time");
                self.close_round(market_id.0, case);
            }
            Stage::Final => env::panic_str("already final"),
        }
    }

    // Anyone can call this once the market's resolve_by has passed. It settles whatever is settleable: an unchallenged
    // proposal whose window ended, a dispute whose jury ran out of time, or a final answer the market has not received.
    // A market nobody answered gets Void. A case that still has time is refused: the timing rules in propose and
    // close_round leave none at this point, and voiding the market under it would leave the case to settle an answer that
    // can no longer be applied. The market's own void_if_unresolved is only for an oracle that is gone.
    pub fn resolve_by_deadline(&mut self, market_id: U64) {
        upgrade::require_gas(GAS_SETTLE_FLOOR, SETTLE_REASON);
        let info = self.market_info(market_id.0);
        let now = env::block_timestamp();
        require!(now >= info.resolve_by.0, "the answer deadline has not passed");
        let Some(case) = self.cases.get(&market_id.0).cloned() else {
            emit("deadline_void", json!({ "market_id": market_id.0.to_string() }));
            return self.apply(market_id.0, Outcome::Void);
        };
        match case.stage {
            Stage::Proposed if now >= case.window_ends_at.0 => {
                self.settle(market_id.0, case.proposed, Ruling::Unchallenged)
            }
            Stage::Disputed if round_is_over(&case, now) => self.close_round(market_id.0, case),
            Stage::Final if !case.applied => self.apply(market_id.0, case.final_outcome.unwrap_or(Outcome::Void)),
            Stage::Final => env::panic_str("already resolved"),
            _ => env::panic_str("the case still has time; finalize it when its round is over"),
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
        upgrade::require_gas(
            GAS_RETRY_UNLOCK_FLOOR,
            "each jury's release gets an equal share of what is attached",
        );
        let case = self.case(market_id.0);
        require!(
            case.stage == Stage::Final && case.challenger.is_some(),
            "no settled dispute to unlock"
        );
        // No static gas: each unlock takes an equal share of whatever the caller attached.
        self.unlock_juries(market_id.0, case.round, case.delinquent, Gas::from_gas(0))
    }

    #[private]
    pub fn on_applied(&mut self, market_id: U64, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_ok() {
            // A market voided at its deadline with nobody having answered has no case to mark.
            if let Some(mut case) = self.cases.get(&market_id.0).cloned() {
                case.applied = true;
                self.cases.insert(market_id.0, case);
            }
            emit("outcome_applied", json!({ "market_id": market_id.0.to_string() }));
        }
    }

    // Pays the caller's whole claimable balance into the caller's own Intents account, out of this contract's. The balance
    // is zeroed first and given back in the callback if the verifier refuses.
    #[payable]
    pub fn withdraw_bond(&mut self) -> Promise {
        upgrade::require_gas(GAS_WITHDRAW_FLOOR, "a withdrawal sends the payout and then settles it");
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let amount = self.claimable.get(&who).copied().unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        self.claimable.remove(&who);
        self.claimable_total -= amount;
        // mt_transfer returns nothing, so an error here means the verifier's receipt failed (paused, locked, out of gas) and
        // nothing moved.
        ext_verifier::ext(self.verifier.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_MT_TRANSFER)
            .mt_transfer(who.clone(), self.collateral_token_id.clone(), U128(amount), None, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_bond_withdrawn(who, U128(amount)),
            )
    }

    #[private]
    pub fn on_bond_withdrawn(
        &mut self,
        account: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            self.add_claimable(&account, amount.0);
            emit(
                "bond_payout_failed",
                json!({ "account": account, "amount": amount.0.to_string() }),
            );
        } else {
            emit(
                "bond_paid",
                json!({ "account": account, "amount": amount.0.to_string() }),
            );
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

    // Everything this contract owes, in collateral units: the bonds in cases that are not final and everything waiting to be
    // withdrawn. The keeper compares it with the verifier's mt_balance_of for this account at the same finalized block. More
    // there than here is surplus nobody is credited for, or a payout that is in flight. Less is an incident.
    pub fn total_owed(&self) -> U128 {
        U128(self.bonds_held + self.claimable_total)
    }

    // Whether a wasm with this sha256 is staged here, for the members to check before they vote to deploy it.
    pub fn is_staged(&self, code_hash: Base58CryptoHash) -> bool {
        upgrade::is_staged(code_hash)
    }

    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "state_version": self.state_version, "upgrade_proven": self.upgrade_proven, "upgrade_in_flight": self.upgrade_in_flight,
                "owner": self.owner, "pending_owner": self.pending_owner, "market": self.market, "verifier": self.verifier,
                "collateral_token_id": self.collateral_token_id,
                "bond": self.bond.to_string(), "window_ns": self.window_ns.to_string(),
                "panel_deadline_ns": self.panel_deadline_ns.to_string(),
                "draw_window_ns": self.draw_window_ns.to_string(), "council": self.council,
                "jury_size": self.jury_size, "draw_delay_blocks": self.draw_delay_blocks.to_string(),
                "min_proposal_ns": self.min_proposal_ns.to_string(),
                "min_resolve_gap_ns": self.min_resolve_gap_ns().to_string(), "operator": self.operator,
                "network": self.network, "publishers": self.publishers, "price_threshold": self.price_threshold,
                "no_decision_recipient": self.no_decision_recipient })
    }
}

// ---- private helpers ----------------------------------------------------------------------

impl OracleContract {
    // Anyone can answer a price market with a price that enough publishers signed for this market and its observation
    // time. The answer then goes through the same bond, challenge window and jury as any other, so a wrong price that
    // enough publishers signed can still be challenged. There is no staleness limit: each signature covers exactly the
    // observation time, so a publisher that was down at that moment can sign the price later.
    fn answer_price(&mut self, proposer: AccountId, id: u64, price: u128, signatures: &str) {
        let info = self
            .markets
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("market is not registered"));
        let rule = info.price_rule.unwrap_or_else(|| env::panic_str("not a price market"));
        require!(
            env::block_timestamp() >= rule.observation_time.0,
            "the observation time has not come"
        );
        let message = price_message(&env::current_account_id(), &self.network, id, &rule, price);
        let signers = self.verified_signers(&message, signatures);
        require!(
            signers.len() >= self.price_threshold as usize,
            "not enough valid publisher signatures"
        );
        let outcome = if (price >= rule.strike.0) == rule.above {
            Outcome::Yes
        } else {
            Outcome::No
        };
        self.propose(
            proposer,
            id,
            outcome,
            format!("signed price {price} by {} publishers", signers.len()),
            &signers,
        );
    }

    // The different publishers who signed `message`, in the order they were given, so the record can name them. Any entry
    // that is malformed, from a key that is not a publisher, repeated, or that does not verify refuses the whole submission.
    fn verified_signers(&self, message: &str, signatures: &str) -> Vec<PublicKey> {
        let mut seen: Vec<PublicKey> = vec![];
        for entry in signatures.split(',') {
            let (key, signature) = entry
                .rsplit_once('.')
                .unwrap_or_else(|| env::panic_str("a signature is <publisher key>.<hex>"));
            let key: PublicKey = key.parse().unwrap_or_else(|_| env::panic_str("bad publisher key"));
            require!(self.publishers.contains(&key), "not a publisher");
            require!(!seen.contains(&key), "a publisher signed twice");
            let raw: [u8; 32] = key.as_bytes()[1..]
                .try_into()
                .unwrap_or_else(|_| env::panic_str("publishers use ed25519 keys"));
            require!(
                env::ed25519_verify(&decode_signature(signature), message.as_bytes(), &raw),
                "a signature does not match"
            );
            seen.push(key);
        }
        seen
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    // The least a market registered now must leave between close_at and resolve_by: time to propose, then the longest a
    // case can take, then room for apply() to land (see APPLY_BUFFER_NS).
    fn min_resolve_gap_ns(&self) -> u64 {
        self.min_proposal_ns
            + case_span_ns(self.window_ns, self.draw_window_ns, self.panel_deadline_ns)
            + APPLY_BUFFER_NS
    }

    fn case(&self, id: u64) -> Case {
        self.cases
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no case for that market"))
    }

    fn market_info(&self, id: u64) -> MarketInfo {
        self.markets
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("market is not registered"))
    }

    fn add_claimable(&mut self, who: &AccountId, amount: u128) {
        let have = self.claimable.get(who).copied().unwrap_or(0);
        self.claimable.insert(who.clone(), have + amount);
        self.claimable_total += amount;
    }

    // `signers` are the publishers behind a price answer, empty for any other. They go into the event, which is where the
    // record shows who signed without anyone having to read the transaction.
    fn propose(&mut self, proposer: AccountId, id: u64, outcome: Outcome, evidence: String, signers: &[PublicKey]) {
        let info = self.market_info(id);
        let now = env::block_timestamp();
        require!(now >= info.close_at.0, "the market has not closed yet");
        require!(evidence.len() <= MAX_EVIDENCE, "evidence link is too long");
        // A case must be able to finish, challenge and both juries included, with room left for apply() to land,
        // before the market's deadline answer is due.
        require!(
            now + info.case_span_ns() + APPLY_BUFFER_NS <= info.resolve_by.0,
            "too late to propose, the market will be voided at its deadline"
        );
        require!(!self.cases.contains_key(&id), "an answer was already proposed");
        let window_ends_at = U64(now + info.window_ns.0);
        self.cases.insert(
            id,
            Case {
                stage: Stage::Proposed,
                proposer: proposer.clone(),
                proposed: outcome,
                bond: U128(self.bond),
                evidence: evidence.clone(),
                window_ends_at,
                challenger: None,
                challenger_answer: None,
                round: 0,
                jury_size: 0,
                draw_by: U64(0),
                draw_after_height: U64(0),
                commit_ends_at: U64(0),
                panel_deadline: U64(0),
                panel: vec![],
                first_panel: vec![],
                commits: vec![],
                votes: vec![],
                final_outcome: None,
                applied: false,
                challenged_at: U64(0),
                delinquent: vec![],
            },
        );
        emit(
            "proposed",
            json!({ "market_id": id.to_string(), "proposer": proposer, "outcome": outcome, "evidence": evidence,
                    "window_ends_at": window_ends_at.0.to_string(), "signers": signers }),
        );
    }

    fn challenge(&mut self, challenger: AccountId, id: u64, answer: Outcome) {
        let mut case = self.case(id);
        require!(case.stage == Stage::Proposed, "nothing to challenge");
        require!(
            env::block_timestamp() < case.window_ends_at.0,
            "the challenge window closed"
        );
        require!(challenger != case.proposer, "you cannot challenge your own answer");
        require!(
            answer != case.proposed,
            "a challenge must name a different answer than the proposal"
        );
        let draw_window_ns = self.market_info(id).draw_window_ns.0;
        let now = env::block_timestamp();
        case.stage = Stage::Disputed;
        case.challenger = Some(challenger.clone());
        case.challenger_answer = Some(answer);
        case.jury_size = self.jury_size;
        case.challenged_at = U64(now);
        case.draw_by = U64(now + draw_window_ns);
        case.draw_after_height = U64(env::block_height() + self.draw_delay_blocks);
        let draw_by = case.draw_by.0;
        self.cases.insert(id, case);
        emit(
            "challenged",
            json!({ "market_id": id.to_string(), "challenger": challenger, "answer": answer, "draw_by": draw_by.to_string() }),
        );
    }

    // A round ended without a majority. The first one is followed by a larger jury of other accounts, unless there is
    // no longer time for it to finish before resolve_by. Otherwise nobody decided: a price market keeps the price the
    // publishers signed, and an event market is Void.
    fn close_round(&mut self, id: u64, mut case: Case) {
        let info = self.market_info(id);
        let now = env::block_timestamp();
        let round_ns = info.draw_window_ns.0 + info.panel_deadline_ns.0;
        if case.round == 0 && now + round_ns + APPLY_BUFFER_NS <= info.resolve_by.0 {
            case.round = 1;
            case.jury_size = (2 * case.jury_size + 1).min(MAX_PANEL as u32);
            case.draw_by = U64(now + info.draw_window_ns.0);
            case.draw_after_height = U64(env::block_height() + self.draw_delay_blocks);
            case.commit_ends_at = U64(0);
            case.panel_deadline = U64(0);
            case.first_panel = std::mem::take(&mut case.panel);
            emit(
                "escalated",
                json!({ "market_id": id.to_string(), "jury_size": case.jury_size, "draw_by": case.draw_by.0.to_string() }),
            );
            self.cases.insert(id, case);
        } else {
            let outcome = if info.price_rule.is_some() {
                case.proposed
            } else {
                Outcome::Void
            };
            self.settle(id, outcome, Ruling::NoDecision);
        }
    }

    // Fix the outcome, hand out bonds, then tell the market. State changes first, call last.
    fn settle(&mut self, id: u64, outcome: Outcome, ruling: Ruling) {
        let mut case = self.case(id);
        case.stage = Stage::Final;
        case.final_outcome = Some(outcome);
        let disputed = ruling != Ruling::Unchallenged;
        if disputed {
            case.delinquent = delinquent_jurors(&case, env::block_timestamp());
        }
        let proposer = case.proposer.clone();
        let challenger = case.challenger.clone();
        let proposed = case.proposed;
        // Jurors who revealed, and those of them who sat with the final outcome. A majority of a jury is what decides a
        // dispute, so anything short of that, a timeout above all, is a dispute nobody won.
        let revealed: Vec<AccountId> = case.votes.iter().map(|v| v.juror.clone()).collect();
        let majority: Vec<AccountId> = case
            .votes
            .iter()
            .filter(|v| v.outcome == outcome)
            .map(|v| v.juror.clone())
            .collect();
        let delinquent = case.delinquent.clone();
        let round = case.round;
        let bond = case.bond.0;
        self.cases.insert(id, case);
        // The bonds that were put into this case are all handed out below, to the accounts that earned them.
        self.bonds_held -= if challenger.is_some() { 2 * bond } else { bond };

        let mut juror_pay = 0;
        let mut paid: Vec<AccountId> = vec![];
        match (challenger, ruling) {
            (Some(c), Ruling::Decided) => {
                // The loser's bond: a quarter shared by the majority jurors, the rest to the winner with the winner's own
                // bond. The division rounds down and the winner keeps the remainder, so the two bonds are paid out exactly.
                let winner = if outcome == proposed { proposer } else { c };
                let pool = bond * JUROR_SHARE_BPS / 10_000;
                juror_pay = pool / majority.len() as u128;
                for juror in &majority {
                    self.add_claimable(juror, juror_pay);
                }
                self.add_claimable(&winner, 2 * bond - juror_pay * majority.len() as u128);
                paid = majority;
            }
            (Some(_), Ruling::NoDecision) => {
                // Nobody won, so the proposer gets their own bond back. The challenger put a case in front of two juries
                // and neither found for them: half of their bond goes to the jurors who revealed, the rest to the
                // proposer. With no juror having revealed, the no-decision recipient holds that half, so a pair of accounts
                // that propose and challenge each other loses it whatever the juries do.
                let pool = bond * NO_DECISION_JUROR_SHARE_BPS / 10_000;
                if revealed.is_empty() {
                    let recipient = self.no_decision_recipient.clone();
                    self.add_claimable(&recipient, pool);
                    self.add_claimable(&proposer, 2 * bond - pool);
                } else {
                    juror_pay = pool / revealed.len() as u128;
                    for juror in &revealed {
                        self.add_claimable(juror, juror_pay);
                    }
                    self.add_claimable(&proposer, 2 * bond - juror_pay * revealed.len() as u128);
                }
                paid = revealed;
            }
            _ => self.add_claimable(&proposer, bond),
        }
        emit(
            "final",
            json!({ "market_id": id.to_string(), "outcome": outcome, "ruling": ruling.word(),
                    "juror_pay_each": juror_pay.to_string(), "paid_jurors": paid, "delinquent": delinquent }),
        );
        self.apply(id, outcome);
        // Lets the juries unstake. Nothing waits on it: if it fails, retry_unlock sends it again.
        if disputed {
            let _ = self.unlock_juries(id, round, delinquent, GAS_UNLOCK);
        }
    }

    fn apply(&self, id: u64, outcome: Outcome) {
        let _ = ext_market::ext(self.market.clone())
            .with_static_gas(GAS_APPLY)
            .set_outcome(U64(id), outcome)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_applied(U64(id)),
            );
    }

    // Releases the seats of the case's first jury and, once there was a second round, of its second. Both calls carry
    // the same list of jurors who never voted: the council only looks at the seats of the jury it is releasing. They run
    // one after the other, because retry_unlock returns this promise and the runtime refuses to return a joint one.
    fn unlock_juries(&self, id: u64, round: u8, delinquent: Vec<AccountId>, gas: Gas) -> Promise {
        let unlock = |round: u8| {
            ext_council::ext(self.council.clone())
                .with_static_gas(gas)
                .unlock_case(council_key(id, round), delinquent.clone())
        };
        if round == 0 {
            unlock(0)
        } else {
            unlock(0).then(unlock(1))
        }
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
    const VERIFIER: &str = "intents.near";
    const COLLATERAL: &str = "nep141:usdc.near";
    const COUNCIL: &str = "council.near";
    const RECIPIENT: &str = "biz.near";
    const NETWORK: &str = "testnet";

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    // Every call carries the one yocto the juror methods need.
    fn act_as(who: &str, now_ns: u64) {
        act_at_height(who, now_ns, 0);
    }

    fn act_at_height(who: &str, now_ns: u64, height: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .block_timestamp(now_ns)
            .block_height(height)
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
    }

    fn act_unpaid(who: &str, now_ns: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .block_timestamp(now_ns)
            .build());
    }

    // What the verifier hands over after `sender` moved `amount` of the collateral out of their own Intents balance. The caller
    // acts as the verifier first.
    fn deliver(o: &mut OracleContract, sender: &str, amount: u128, msg: &str) -> Vec<U128> {
        o.mt_on_transfer(
            acct(sender),
            vec![acct(sender)],
            vec![COLLATERAL.to_string()],
            vec![U128(amount)],
            msg.to_string(),
        )
    }

    fn fresh_oracle() -> OracleContract {
        oracle_with_bond(1)
    }

    fn oracle_with_bond(bond: u128) -> OracleContract {
        oracle_with(bond, 2)
    }

    const SECOND: u64 = 1_000_000_000;
    // The oracle below is deployed with a 60 second window, a 60 second draw window and a 120 second panel deadline.
    const WINDOW: u64 = 60 * SECOND;
    const DRAW_WINDOW: u64 = 60 * SECOND;
    const PANEL: u64 = 120 * SECOND;
    const PROPOSAL_TIME: u64 = 60 * SECOND;

    fn oracle_with(bond: u128, price_threshold: u32) -> OracleContract {
        oracle_on(COLLATERAL, bond, price_threshold)
    }

    fn oracle_on(collateral_token_id: &str, bond: u128, price_threshold: u32) -> OracleContract {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_as(OWNER, 0);
        OracleContract::new(
            acct(OWNER),
            acct(MARKET),
            acct(VERIFIER),
            collateral_token_id.to_string(),
            U128(bond),
            U64(60_000),
            U64(120_000),
            U64(60_000),
            acct(COUNCIL),
            3,
            U64(2),
            U64(60_000),
            acct(OPERATOR),
            NETWORK.to_string(),
            price_threshold,
            acct(RECIPIENT),
        )
    }

    // A market closed at 0 with the oracle's test windows: 60 seconds each way, 120 for the panel.
    fn base_info() -> MarketInfo {
        MarketInfo {
            close_at: U64(0),
            resolve_by: U64(0),
            rule_hash: "hash".to_string(),
            price_rule: None,
            window_ns: U64(WINDOW),
            panel_deadline_ns: U64(PANEL),
            draw_window_ns: U64(DRAW_WINDOW),
        }
    }

    // The market is written straight into storage: register_market would refuse one this tight, and propose()
    // still has to hold for a market that was fine when created and is proposed on late.
    fn oracle_with_resolve_by(resolve_by_ns: u64) -> OracleContract {
        let mut o = fresh_oracle();
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(resolve_by_ns),
                ..base_info()
            },
        );
        o
    }

    // The window and two rounds of a draw window and a panel deadline: what a case can take from its proposal.
    const CASE_SPAN: u64 = WINDOW + 2 * (DRAW_WINDOW + PANEL);
    const MIN_GAP: u64 = PROPOSAL_TIME + CASE_SPAN + APPLY_BUFFER_NS;

    // ---- what a settled dispute pays, and who is delinquent -------------------------------------------

    const BOND: u128 = 5_000_000;
    const DEADLINE: u64 = 120 * SECOND;
    const JURORS: [&str; 3] = ["j0.near", "j1.near", "j2.near"];

    fn other_answer(proposed: Outcome) -> Outcome {
        if proposed == Outcome::Yes {
            Outcome::No
        } else {
            Outcome::Yes
        }
    }

    // A challenged case, proposed by carol and challenged by dave, with a jury of three. `commits` and `votes` are
    // who committed and who revealed what. Dave's answer is the other one of Yes and No unless a test names it.
    fn disputed_case(o: &mut OracleContract, proposed: Outcome, commits: &[&str], votes: &[(&str, Outcome)]) {
        disputed_case_answering(o, proposed, other_answer(proposed), commits, votes);
    }

    fn disputed_case_answering(
        o: &mut OracleContract,
        proposed: Outcome,
        answer: Outcome,
        commits: &[&str],
        votes: &[(&str, Outcome)],
    ) {
        // Both bonds are in the case, as they would be had it been proposed and challenged through the hook.
        o.bonds_held += 2 * o.bond;
        o.cases.insert(
            0,
            Case {
                stage: Stage::Disputed,
                proposer: acct("carol.near"),
                proposed,
                bond: U128(o.bond),
                evidence: String::new(),
                window_ends_at: U64(0),
                challenger: Some(acct("dave.near")),
                challenger_answer: Some(answer),
                round: 0,
                jury_size: 3,
                draw_by: U64(DRAW_WINDOW),
                draw_after_height: U64(0),
                commit_ends_at: U64(DEADLINE / 2),
                panel_deadline: U64(DEADLINE),
                panel: JURORS.iter().map(|j| acct(j)).collect(),
                first_panel: vec![],
                commits: commits
                    .iter()
                    .map(|j| Commit {
                        juror: acct(j),
                        commitment: "c".into(),
                    })
                    .collect(),
                votes: votes
                    .iter()
                    .map(|(j, outcome)| Vote {
                        juror: acct(j),
                        outcome: *outcome,
                        reason: "r".into(),
                    })
                    .collect(),
                final_outcome: None,
                applied: false,
                challenged_at: U64(0),
                delinquent: vec![],
            },
        );
    }

    // Like disputed_case, with a jury of any size.
    fn put_case_with_panel(
        o: &mut OracleContract,
        proposed: Outcome,
        panel: &[String],
        commits: &[&str],
        votes: &[(&str, Outcome)],
    ) {
        disputed_case(o, proposed, commits, votes);
        let mut case = o.case(0);
        case.panel = panel.iter().map(|j| acct(j)).collect();
        case.jury_size = panel.len() as u32;
        o.cases.insert(0, case);
    }

    fn owed(o: &OracleContract, who: &str) -> u128 {
        o.claimable_of(acct(who)).0
    }

    // The arguments of each call the last transaction sent to `method`, in the order they were sent.
    fn calls_to(method: &str) -> Vec<near_sdk::serde_json::Value> {
        near_sdk::test_utils::get_created_receipts()
            .iter()
            .flat_map(|r| r.actions.iter())
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. }
                    if method_name == method.as_bytes() =>
                {
                    Some(near_sdk::serde_json::from_slice(args).unwrap())
                }
                _ => None,
            })
            .collect()
    }

    fn unlock_call() -> Option<near_sdk::serde_json::Value> {
        calls_to("unlock_case").into_iter().next()
    }

    fn names(count: usize, prefix: &str) -> Vec<String> {
        (0..count).map(|i| format!("{prefix}{i}.near")).collect()
    }

    // ---- a case run through the real calls ---------------------------------------------------------------

    // Far enough away that no deadline of the market comes into play.
    const MARKET_DEADLINE: u64 = 1_000_000 * SECOND;
    const CHALLENGED_AT: u64 = 2 * SECOND;
    const DRAW_BY: u64 = CHALLENGED_AT + DRAW_WINDOW;

    // Market 0 closed at 0. Carol proposes `proposed` a second later and Dave challenges naming `answer` the second after.
    fn challenged(proposed: Outcome, answer: Outcome) -> OracleContract {
        let mut o = oracle_with_bond(BOND);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        act_as(VERIFIER, SECOND);
        deliver(
            &mut o,
            "carol.near",
            BOND,
            &format!("propose:0:{}:https://x", proposed.word()),
        );
        act_as(VERIFIER, CHALLENGED_AT);
        deliver(&mut o, "dave.near", BOND, &format!("challenge:0:{}", answer.word()));
        o
    }

    // The council answers the draw at `at` with these jurors.
    fn seat(o: &mut OracleContract, at: u64, jurors: &[String]) {
        act_as(COUNCIL, at);
        let round = o.case(0).round;
        o.on_drawn(U64(0), round, Ok(jurors.iter().map(|j| acct(j)).collect()));
    }

    fn commit(o: &mut OracleContract, juror: &str, at: u64, outcome: Outcome, salt: &str) {
        act_as(juror, at);
        o.commit_vote(U64(0), commitment_of(&acct(juror), outcome, salt));
    }

    fn reveal(o: &mut OracleContract, juror: &str, at: u64, outcome: Outcome, salt: &str) {
        act_as(juror, at);
        o.reveal_vote(U64(0), outcome, salt.into(), "because".into());
    }

    // A reveal at the moment the current round's reveal phase opens.
    fn reveal_when_open(o: &mut OracleContract, juror: &str, outcome: Outcome, salt: &str) {
        let opens = o.case(0).commit_ends_at.0;
        reveal(o, juror, opens, outcome, salt);
    }

    // Round 0 with `jurors` seated at the last moment a draw is allowed, none of whom do anything. Returns when the
    // round is over.
    fn first_round_that_does_nothing(o: &mut OracleContract, jurors: &[String]) -> u64 {
        seat(o, DRAW_BY, jurors);
        o.case(0).panel_deadline.0 + 1
    }

    // ---- attacks: randomized ---------------------------------------------------------------------------

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(400))]

        // However the jury behaves, a settled dispute pays out exactly the two bonds that were put in: not a unit more
        // (money created), not a unit less (money stuck). Only jurors who revealed are paid, and in a decided dispute
        // only those who sat with the outcome. A dispute nobody decided pays the proposer, the jurors who revealed and,
        // if none did, the owner, and never the challenger. The delinquent are only jurors who did not vote.
        #[test]
        fn a_settled_dispute_pays_out_exactly_the_bonds_and_only_to_those_who_earned_it(
            bond in 1u128..50_000_000,
            jury_size in prop::sample::select(vec![1usize, 3, 5, 7, 11, 21]),
            behaviour in prop::collection::vec((0u8..3, any::<bool>()), 21),
            proposed in 0u8..3,
            after_deadline in any::<bool>(),
        ) {
            let proposed = [Outcome::Yes, Outcome::No, Outcome::Void][proposed as usize];
            let answer = other_answer(proposed);
            let mut o = oracle_with_bond(bond);
            let jurors = names(jury_size, "j");
            // Each juror: did not commit, committed only, or committed and revealed; and which of the two answers.
            let mut commits = vec![];
            let mut votes = vec![];
            for (i, (kind, for_challenger)) in behaviour.iter().take(jury_size).enumerate() {
                if *kind >= 1 { commits.push(jurors[i].as_str()); }
                if *kind == 2 { votes.push((jurors[i].as_str(), if *for_challenger { answer } else { proposed })); }
            }
            let needed = jury_size / 2 + 1;
            let majority = [proposed, answer].into_iter().find(|a| votes.iter().filter(|(_, v)| v == a).count() >= needed);
            // The case settles on a majority the moment it forms, or with no decision once the deadline has passed.
            let (outcome, ruling, now) = match (majority, after_deadline) {
                (Some(m), _) => (m, Ruling::Decided, DEADLINE - 1),
                (None, true) => (Outcome::Void, Ruling::NoDecision, DEADLINE + 1),
                (None, false) => return Ok(()),
            };
            put_case_with_panel(&mut o, proposed, &jurors, &commits, &votes);
            act_as("anyone.near", now);
            o.settle(0, outcome, ruling);

            let paid_jurors: u128 = jurors.iter().map(|j| owed(&o, j)).sum();
            let (carol, dave, recipient) = (owed(&o, "carol.near"), owed(&o, "dave.near"), owed(&o, RECIPIENT));
            prop_assert_eq!(paid_jurors + carol + dave + recipient, 2 * bond, "the two bonds are paid out exactly");
            prop_assert_eq!((o.total_owed().0, o.bonds_held), (2 * bond, 0), "settling moves the bonds into claimable and owes nothing new");
            prop_assert_eq!(owed(&o, OWNER), 0, "the owner is never paid");

            let case = o.case(0);
            let revealed = |j: &String| votes.iter().any(|(v, _)| v == j);
            for j in &jurors {
                let sat_with_outcome = votes.iter().any(|(v, out)| v == j && *out == outcome);
                let may_be_paid = match ruling {
                    Ruling::Decided => sat_with_outcome,
                    _ => revealed(j),
                };
                if !may_be_paid {
                    prop_assert_eq!(owed(&o, j), 0, "{} was paid without earning it", j);
                }
            }
            let pool = match ruling {
                Ruling::Decided => bond * JUROR_SHARE_BPS / 10_000,
                _ => bond * NO_DECISION_JUROR_SHARE_BPS / 10_000,
            };
            // The two parties of a case that went to a jury get back less than they put in by the jurors' share, up
            // to a unit of rounding for each juror.
            prop_assert!(2 * bond - (carol + dave) + jury_size as u128 >= pool, "the parties kept {} of the jurors' {}", carol + dave, pool);
            if ruling == Ruling::NoDecision {
                prop_assert_eq!(dave, 0, "the challenger's bond is not returned when nobody decided");
                prop_assert!(carol >= bond, "the proposer's own bond comes back");
                prop_assert_eq!(recipient, if votes.is_empty() { pool } else { 0 }, "the recipient holds the jurors' half only when none revealed");
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

        // With any odd jury and every juror voting for one of the two answers, the case settles: some answer always has
        // a majority, so a full binary ballot cannot stall.
        #[test]
        fn a_full_binary_ballot_always_settles(
            jury_size in prop::sample::select(vec![1usize, 3, 5, 7, 11, 21]),
            ballot in prop::collection::vec(any::<bool>(), 21),
        ) {
            let mut o = challenged(Outcome::Yes, Outcome::No);
            let jurors = names(jury_size, "j");
            o.cases.insert(0, Case { jury_size: jury_size as u32, ..o.case(0) });
            seat(&mut o, DRAW_BY, &jurors);
            let commit_ends = o.case(0).commit_ends_at.0;
            let vote = |i: usize| if ballot[i] { Outcome::No } else { Outcome::Yes };
            for (i, j) in jurors.iter().enumerate() {
                commit(&mut o, j, DRAW_BY + SECOND, vote(i), "a-long-random-salt");
            }
            for (i, j) in jurors.iter().enumerate() {
                if o.case(0).stage == Stage::Final {
                    break;
                }
                reveal(&mut o, j, commit_ends, vote(i), "a-long-random-salt");
            }
            let case = o.case(0);
            prop_assert_eq!(case.stage, Stage::Final, "a full ballot left the case open");
            let for_no = (0..jury_size).filter(|i| ballot[*i]).count();
            let expected = if for_no * 2 > jury_size { Outcome::No } else { Outcome::Yes };
            prop_assert_eq!(case.final_outcome, Some(expected));
        }

        // Two accounts that propose and challenge each other to stall a case end down by at least the jurors' share,
        // whatever the jurors, in either round, do. Both rounds' jurors are other accounts than the pair.
        #[test]
        fn a_self_challenging_pair_ends_down_by_at_least_the_juror_share_whatever_the_jury_does(
            bond in 400u128..50_000_000,
            first_size in prop::sample::select(vec![1usize, 3, 5, 11]),
            first in prop::collection::vec((0u8..3, any::<bool>()), 11),
            second in prop::collection::vec((0u8..3, any::<bool>()), 21),
            two_rounds in any::<bool>(),
            decided in any::<bool>(),
        ) {
            let (proposed, answer) = (Outcome::Yes, Outcome::No);
            let mut o = oracle_with_bond(bond);
            let first_jurors = names(first_size, "f");
            let second_size = (2 * first_size + 1).min(MAX_PANEL);
            let second_jurors = names(second_size, "s");
            let mut commits: Vec<String> = vec![];
            let mut votes: Vec<(String, Outcome)> = vec![];
            for (i, (kind, for_challenger)) in first.iter().take(first_size).enumerate() {
                if *kind >= 1 { commits.push(first_jurors[i].clone()); }
                if *kind == 2 { votes.push((first_jurors[i].clone(), if *for_challenger { answer } else { proposed })); }
            }
            if two_rounds {
                for (i, (kind, for_challenger)) in second.iter().take(second_size).enumerate() {
                    if *kind >= 1 { commits.push(second_jurors[i].clone()); }
                    if *kind == 2 { votes.push((second_jurors[i].clone(), if *for_challenger { answer } else { proposed })); }
                }
            }
            let commit_refs: Vec<&str> = commits.iter().map(String::as_str).collect();
            let vote_refs: Vec<(&str, Outcome)> = votes.iter().map(|(j, v)| (j.as_str(), *v)).collect();
            let panel = if two_rounds { &second_jurors } else { &first_jurors };
            put_case_with_panel(&mut o, proposed, panel, &commit_refs, &vote_refs);
            if two_rounds {
                let mut case = o.case(0);
                case.round = 1;
                case.first_panel = first_jurors.iter().map(|j| acct(j)).collect();
                o.cases.insert(0, case);
            }
            // A decided case needs a vote for the outcome. Give the outcome to whoever the votes favour, or to the
            // proposer when none were cast.
            let for_proposed = votes.iter().filter(|(_, v)| *v == proposed).count();
            let outcome = if for_proposed * 2 >= votes.len() { proposed } else { answer };
            let decided = decided && votes.iter().any(|(_, v)| *v == outcome);
            act_as("anyone.near", DEADLINE + 1);
            if decided {
                o.settle(0, outcome, Ruling::Decided);
            } else {
                o.settle(0, Outcome::Void, Ruling::NoDecision);
            }
            let pair = owed(&o, "carol.near") + owed(&o, "dave.near");
            let share = if decided { bond * JUROR_SHARE_BPS / 10_000 } else { bond * NO_DECISION_JUROR_SHARE_BPS / 10_000 };
            let jurors_paid = first_size + if two_rounds { second_size } else { 0 };
            prop_assert!(2 * bond - pair + jurors_paid as u128 >= share, "the pair kept {} of {}, the jurors' share is {}", pair, 2 * bond, share);
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
            &[
                (JURORS[2], Outcome::Yes),
                (JURORS[0], Outcome::No),
                (JURORS[1], Outcome::No),
            ],
        );
        act_as(JURORS[1], 100);
        o.settle(0, Outcome::No, Ruling::Decided);
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
        disputed_case(
            &mut o,
            Outcome::Yes,
            &JURORS,
            &[(JURORS[0], Outcome::Yes), (JURORS[1], Outcome::Yes)],
        );
        act_as(JURORS[1], 100);
        o.settle(0, Outcome::Yes, Ruling::Decided);
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
        o.settle(0, Outcome::No, Ruling::Decided);
        // A quarter is 250,000, three ways is 83,333 each and 1 over, which the winner keeps.
        assert_eq!(
            (owed(&o, "j0.near"), owed(&o, "j1.near"), owed(&o, "j2.near")),
            (83_333, 83_333, 83_333)
        );
        let paid: u128 = ["j0.near", "j1.near", "j2.near", "carol.near", "dave.near"]
            .iter()
            .map(|a| owed(&o, a))
            .sum();
        assert_eq!(paid, 2 * bond, "nothing created or lost");
    }

    #[test]
    fn a_jury_that_votes_void_makes_the_proposer_of_another_answer_the_loser() {
        let mut o = oracle_with_bond(BOND);
        disputed_case_answering(
            &mut o,
            Outcome::Yes,
            Outcome::Void,
            &JURORS,
            &[(JURORS[0], Outcome::Void), (JURORS[1], Outcome::Void)],
        );
        act_as(JURORS[1], 100);
        o.settle(0, Outcome::Void, Ruling::Decided);
        assert_eq!(
            (owed(&o, "j0.near"), owed(&o, "j1.near")),
            (625_000, 625_000),
            "voting Void is paid like any other decision"
        );
        assert_eq!(
            (owed(&o, "dave.near"), owed(&o, "carol.near")),
            (2 * BOND - 1_250_000, 0)
        );
    }

    // Nobody decided, so the proposer gets their own bond back. The challenger's bond is split: half to the jurors who
    // revealed, the other half to the proposer.
    #[test]
    fn a_dispute_nobody_decided_returns_the_proposers_bond_and_splits_the_challengers() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(
            &mut o,
            Outcome::Yes,
            &JURORS[..2],
            &[(JURORS[0], Outcome::Yes), (JURORS[1], Outcome::No)],
        );
        act_as("anyone.near", DEADLINE + 1);
        o.settle(0, Outcome::Void, Ruling::NoDecision);
        assert_eq!(
            (owed(&o, "j0.near"), owed(&o, "j1.near"), owed(&o, "j2.near")),
            (1_250_000, 1_250_000, 0)
        );
        assert_eq!((owed(&o, "carol.near"), owed(&o, "dave.near")), (BOND + BOND / 2, 0));
        assert_eq!((owed(&o, OWNER), owed(&o, RECIPIENT)), (0, 0));
    }

    // With nobody having revealed, the jurors' half is held by the no-decision recipient, so it still leaves the two
    // parties, and it does not land in the owner's claimable, which is the DAO's.
    #[test]
    fn when_no_juror_revealed_the_no_decision_recipient_holds_the_jurors_half() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(&mut o, Outcome::Void, &[], &[]);
        act_as("anyone.near", DEADLINE + 1);
        o.settle(0, Outcome::Void, Ruling::NoDecision);
        assert_eq!(
            (
                owed(&o, "carol.near"),
                owed(&o, "dave.near"),
                owed(&o, RECIPIENT),
                owed(&o, OWNER)
            ),
            (BOND + BOND / 2, 0, BOND / 2, 0)
        );
    }

    #[test]
    fn a_recipient_the_owner_set_receives_the_half_instead_of_the_one_given_at_deploy() {
        let mut o = oracle_with_bond(BOND);
        act_unpaid(OWNER, 1);
        o.set_no_decision_recipient(acct("council-revenue.near"));
        disputed_case(&mut o, Outcome::Void, &[], &[]);
        act_as("anyone.near", DEADLINE + 1);
        o.settle(0, Outcome::Void, Ruling::NoDecision);
        assert_eq!((owed(&o, "council-revenue.near"), owed(&o, RECIPIENT)), (BOND / 2, 0));
    }

    #[test]
    fn only_the_owner_sets_the_recipient_and_the_change_is_logged_and_shown() {
        let mut o = fresh_oracle();
        assert_eq!(o.config()["no_decision_recipient"], RECIPIENT);
        for who in ["stranger.near", OPERATOR] {
            act_unpaid(who, 5);
            assert!(refusal(|| o.set_no_decision_recipient(acct("x.near"))).contains("owner only"));
        }
        act_unpaid(OWNER, 5);
        o.set_no_decision_recipient(acct("x.near"));
        assert_eq!(o.config()["no_decision_recipient"], "x.near");
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("no_decision_recipient_set") && l.contains("x.near")));
    }

    // Carol proposed Void herself and nobody decided. She must not win both bonds just because the answer is the one she
    // proposed: the challenger's half for the jurors still leaves her.
    #[test]
    fn a_timeout_does_not_hand_the_proposer_both_bonds_when_she_proposed_void() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(&mut o, Outcome::Void, &[], &[]);
        act_as("anyone.near", DEADLINE + 1);
        o.settle(0, Outcome::Void, Ruling::NoDecision);
        assert!(owed(&o, "carol.near") < 2 * BOND, "{}", owed(&o, "carol.near"));
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
        case.challenger_answer = None;
        case.panel = vec![];
        o.cases.insert(0, case);
        o.bonds_held = BOND;
        act_as("anyone.near", 100);
        o.settle(0, Outcome::Yes, Ruling::Unchallenged);
        assert_eq!((owed(&o, "carol.near"), owed(&o, "dave.near")), (BOND, 0));
        assert!(o.case(0).delinquent.is_empty());
    }

    #[test]
    fn jurors_who_never_committed_are_delinquent_but_a_case_settled_early_does_not_blame_a_committed_juror() {
        let mut o = oracle_with_bond(BOND);
        // j0 and j1 revealed No, j2 never committed. j1's commit counts as voted. A fourth juror who committed and has
        // not revealed would still have time, so is not counted.
        disputed_case(
            &mut o,
            Outcome::Yes,
            &JURORS[..2],
            &[(JURORS[0], Outcome::No), (JURORS[1], Outcome::No)],
        );
        let mut case = o.case(0);
        case.panel.push(acct("j3.near"));
        case.commits.push(Commit {
            juror: acct("j3.near"),
            commitment: "c".into(),
        });
        o.cases.insert(0, case);
        act_as(JURORS[1], DEADLINE - 1);
        o.settle(0, Outcome::No, Ruling::Decided);
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
        o.settle(0, Outcome::Void, Ruling::NoDecision);
        assert_eq!(o.case(0).delinquent, vec![acct("j1.near"), acct("j2.near")]);
    }

    #[test]
    fn retry_unlock_sends_the_same_delinquent_list_again() {
        let mut o = oracle_with_bond(BOND);
        disputed_case(&mut o, Outcome::Yes, &JURORS, &[]);
        act_as("anyone.near", DEADLINE + 1);
        o.settle(0, Outcome::Void, Ruling::NoDecision);
        let first = unlock_call().unwrap();
        act_as("stranger.near", DEADLINE + 2);
        assert!(
            unlock_call().is_none(),
            "a new transaction starts with no receipts, so the next one is the retry's"
        );
        let _ = o.retry_unlock(U64(0));
        assert_eq!(unlock_call().expect("the retry sends it"), first);
        assert_eq!(
            first["delinquent"],
            near_sdk::serde_json::json!(["j0.near", "j1.near", "j2.near"])
        );
    }

    // ---- challenges name an answer --------------------------------------------------------------------

    #[test]
    #[should_panic(expected = "a challenge must name a different answer than the proposal")]
    fn a_challenge_naming_the_proposed_answer_is_refused() {
        challenged(Outcome::Yes, Outcome::Yes);
    }

    #[test]
    #[should_panic(expected = "outcome must be yes, no or void")]
    fn a_challenge_with_no_answer_is_refused() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        o.cases.insert(
            0,
            Case {
                stage: Stage::Proposed,
                challenger: None,
                challenger_answer: None,
                ..o.case(0)
            },
        );
        act_as(VERIFIER, CHALLENGED_AT);
        deliver(&mut o, "dave.near", BOND, "challenge:0");
    }

    #[test]
    fn a_challenge_records_the_answer_the_round_and_the_jury_size_at_that_moment() {
        let mut o = oracle_with_bond(BOND);
        act_as(OWNER, 0);
        o.set_jury_size(5);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        act_as(VERIFIER, SECOND);
        deliver(&mut o, "carol.near", BOND, "propose:0:yes:https://x");
        act_at_height(VERIFIER, CHALLENGED_AT, 10);
        deliver(&mut o, "dave.near", BOND, "challenge:0:void");
        let case = o.case(0);
        assert_eq!(
            (case.stage, case.challenger_answer, case.round, case.jury_size),
            (Stage::Disputed, Some(Outcome::Void), 0, 5)
        );
        assert_eq!(
            (case.challenged_at.0, case.draw_by.0, case.draw_after_height.0),
            (CHALLENGED_AT, DRAW_BY, 12)
        );
        assert_eq!(
            (case.commit_ends_at.0, case.panel_deadline.0),
            (0, 0),
            "the jurors' clock has not started"
        );
    }

    #[test]
    #[should_panic(expected = "vote for the proposed answer or the challenger's answer")]
    fn a_vote_for_a_third_outcome_is_refused() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        let jurors = names(3, "j");
        seat(&mut o, DRAW_BY, &jurors);
        commit(&mut o, "j0.near", DRAW_BY + SECOND, Outcome::Void, "a-long-random-salt");
        reveal_when_open(&mut o, "j0.near", Outcome::Void, "a-long-random-salt");
    }

    // ---- the jurors' clock starts at the draw -----------------------------------------------------------------

    #[test]
    fn a_jury_drawn_at_the_last_allowed_moment_still_gets_the_full_commit_and_reveal_time() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        let jurors = names(3, "j");
        act_at_height(OWNER, DRAW_BY, 5);
        let _ = o.resolve_draw(U64(0));
        seat(&mut o, DRAW_BY, &jurors);
        let case = o.case(0);
        assert_eq!(case.commit_ends_at.0, DRAW_BY + PANEL / 2);
        assert_eq!(case.panel_deadline.0, DRAW_BY + PANEL);
        // The jurors can commit right up to the end of their own commit phase and reveal right up to their deadline.
        commit(
            &mut o,
            "j0.near",
            case.commit_ends_at.0 - 1,
            Outcome::No,
            "a-long-random-salt",
        );
        reveal(
            &mut o,
            "j0.near",
            case.panel_deadline.0,
            Outcome::No,
            "a-long-random-salt",
        );
        assert_eq!(o.case(0).votes.len(), 1);
    }

    #[test]
    fn the_jury_clock_counts_from_when_the_jury_lands_not_from_the_challenge() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        seat(&mut o, CHALLENGED_AT + 17 * SECOND, &names(3, "j"));
        assert_eq!(o.case(0).panel_deadline.0, CHALLENGED_AT + 17 * SECOND + PANEL);
    }

    #[test]
    fn a_jury_can_be_drawn_up_to_and_including_draw_by() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_at_height(OWNER, DRAW_BY, 5);
        let _ = o.resolve_draw(U64(0));
    }

    #[test]
    #[should_panic(expected = "too late to draw a jury")]
    fn a_jury_cannot_be_drawn_after_draw_by() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_at_height(OWNER, DRAW_BY + 1, 5);
        let _ = o.resolve_draw(U64(0));
    }

    #[test]
    fn a_draw_carries_the_case_key_the_jury_size_and_who_may_not_sit_and_no_seed() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_at_height(OWNER, DRAW_BY, 5);
        let _ = o.resolve_draw(U64(0));
        let sent = calls_to("draw");
        assert_eq!(
            sent,
            vec![near_sdk::serde_json::json!({ "case_key": "0", "n": 3, "exclude": ["carol.near", "dave.near"] })]
        );
    }

    // A size change after the challenge leaves the case on the size it was challenged with.
    #[test]
    fn a_jury_size_change_between_challenge_and_draw_does_not_strand_the_case() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_as(OWNER, 3 * SECOND);
        o.set_jury_size(5);
        act_at_height(OWNER, DRAW_BY, 5);
        let _ = o.resolve_draw(U64(0));
        assert_eq!(
            calls_to("draw")[0]["n"],
            3,
            "the draw asks for the size the case was challenged with"
        );
        seat(&mut o, DRAW_BY, &names(3, "j"));
        assert_eq!(
            o.case(0).panel.len(),
            3,
            "a jury of that size is accepted although the setting is 5 now"
        );
        assert_eq!(o.get_case(U64(0)).unwrap().jury_size, 3);
    }

    #[test]
    fn a_jury_of_the_wrong_size_or_for_another_round_is_refused() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        seat(&mut o, DRAW_BY, &names(2, "j"));
        assert!(o.case(0).panel.is_empty(), "two jurors for a jury of three");
        act_as(COUNCIL, DRAW_BY);
        o.on_drawn(U64(0), 1, Ok(names(3, "j").iter().map(|j| acct(j)).collect()));
        assert!(
            o.case(0).panel.is_empty(),
            "a draw for the second round while the case is in the first"
        );
    }

    // ---- a stalled jury is no longer free ------------------------------------------------------------------

    #[test]
    fn a_case_never_drawn_is_a_no_decision_that_calls_for_the_second_jury() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_as("anyone.near", DRAW_BY);
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.finalize(U64(0))));
        assert!(early.is_err(), "a jury can still be drawn at draw_by");
        act_at_height("anyone.near", DRAW_BY + 1, 20);
        o.finalize(U64(0));
        let case = o.case(0);
        assert_eq!((case.stage, case.round, case.jury_size), (Stage::Disputed, 1, 7));
        assert_eq!(case.draw_by.0, DRAW_BY + 1 + DRAW_WINDOW);
        assert_eq!(case.draw_after_height.0, 22);
        assert!(case.first_panel.is_empty() && case.panel.is_empty());
    }

    #[test]
    fn a_no_decision_escalates_exactly_once_to_a_larger_disjoint_jury() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        let first = names(3, "j");
        let over = first_round_that_does_nothing(&mut o, &first);
        // One juror commits and reveals, which is not a majority of three.
        let case = o.case(0);
        commit(&mut o, "j0.near", DRAW_BY + SECOND, Outcome::No, "a-long-random-salt");
        reveal(
            &mut o,
            "j0.near",
            case.commit_ends_at.0,
            Outcome::No,
            "a-long-random-salt",
        );
        act_at_height("anyone.near", over, 30);
        o.finalize(U64(0));
        let case = o.case(0);
        assert_eq!(
            (case.stage, case.round, case.jury_size),
            (Stage::Disputed, 1, 7),
            "it called for a larger jury"
        );
        assert_eq!(case.first_panel, first.iter().map(|j| acct(j)).collect::<Vec<_>>());
        assert!(case.panel.is_empty(), "and the second jury is drawn afresh");
        assert_eq!(case.votes.len(), 1, "what the first jury did is kept");

        // The second draw names the second round's own key, the larger size, and leaves out the parties and the first jury.
        act_at_height("anyone.near", over + SECOND, 40);
        let _ = o.resolve_draw(U64(0));
        let sent = calls_to("draw");
        assert_eq!(
            sent,
            vec![near_sdk::serde_json::json!({
                "case_key": SECOND_ROUND_KEY.to_string(), "n": 7,
                "exclude": ["carol.near", "dave.near", "j0.near", "j1.near", "j2.near"]
            })]
        );

        // The second jury sits and does nothing. Its deadline passing settles the case, and it does not escalate again.
        let second = names(7, "k");
        seat(&mut o, over + 2 * SECOND, &second);
        let over_again = o.case(0).panel_deadline.0 + 1;
        act_as("anyone.near", over_again);
        o.finalize(U64(0));
        let case = o.case(0);
        assert_eq!((case.stage, case.final_outcome), (Stage::Final, Some(Outcome::Void)));
        assert_eq!(case.round, 1);
        // Both juries are released, each under its own key, with the same list of who never voted.
        let unlocks = calls_to("unlock_case");
        let keys: Vec<_> = unlocks.iter().map(|u| u["case_key"].clone()).collect();
        assert_eq!(
            keys,
            vec![
                near_sdk::serde_json::json!("0"),
                near_sdk::serde_json::json!(SECOND_ROUND_KEY.to_string())
            ]
        );
        assert_eq!(unlocks[0]["delinquent"], unlocks[1]["delinquent"]);
        assert_eq!(
            unlocks[0]["delinquent"].as_array().unwrap().len(),
            2 + 7,
            "j1 and j2 and all seven second jurors never voted"
        );
    }

    #[test]
    fn a_late_draw_for_the_first_round_cannot_seat_a_jury_in_the_second() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_as("anyone.near", DRAW_BY + 1);
        o.finalize(U64(0));
        act_as(COUNCIL, DRAW_BY + 2);
        o.on_drawn(U64(0), 0, Ok(names(7, "k").iter().map(|j| acct(j)).collect()));
        assert!(o.case(0).panel.is_empty());
    }

    #[test]
    fn the_second_jury_is_twice_the_first_plus_one_and_never_more_than_21() {
        for (first, second) in [(1u32, 3u32), (3, 7), (7, 15), (9, 19), (11, 21), (21, 21)] {
            let mut o = challenged(Outcome::Yes, Outcome::No);
            o.cases.insert(
                0,
                Case {
                    jury_size: first,
                    ..o.case(0)
                },
            );
            act_as("anyone.near", DRAW_BY + 1);
            o.finalize(U64(0));
            assert_eq!(o.case(0).jury_size, second, "from {first}");
        }
    }

    // No time left for another round before the market's deadline: the case ends with no decision instead.
    #[test]
    fn a_failed_first_jury_does_not_call_for_a_second_when_there_is_no_time_for_it() {
        let over = DRAW_BY + 1;
        let fits = over + DRAW_WINDOW + PANEL + APPLY_BUFFER_NS;
        for (resolve_by, escalates) in [(fits, true), (fits - 1, false)] {
            let mut o = challenged(Outcome::Yes, Outcome::No);
            o.markets.insert(
                0,
                MarketInfo {
                    resolve_by: U64(resolve_by),
                    ..o.get_market_info(U64(0)).unwrap()
                },
            );
            act_as("anyone.near", over);
            o.finalize(U64(0));
            let case = o.case(0);
            assert_eq!(case.stage == Stage::Disputed, escalates, "resolve_by {resolve_by}");
            assert_eq!(case.stage == Stage::Final, !escalates);
        }
    }

    #[test]
    fn a_second_no_decision_pays_the_proposer_and_every_juror_who_revealed() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        let first = names(3, "j");
        let over = first_round_that_does_nothing(&mut o, &first);
        commit(&mut o, "j0.near", DRAW_BY + SECOND, Outcome::Yes, "a-long-random-salt");
        reveal_when_open(&mut o, "j0.near", Outcome::Yes, "a-long-random-salt");
        act_at_height("anyone.near", over, 30);
        o.finalize(U64(0));
        let second = names(7, "k");
        seat(&mut o, over + SECOND, &second);
        let case = o.case(0);
        for (juror, outcome) in [("k0.near", Outcome::No), ("k1.near", Outcome::Yes)] {
            commit(&mut o, juror, over + 2 * SECOND, outcome, "a-long-random-salt");
            reveal(&mut o, juror, case.commit_ends_at.0, outcome, "a-long-random-salt");
        }
        act_as("anyone.near", case.panel_deadline.0 + 1);
        o.finalize(U64(0));
        // Three jurors revealed, in two rounds. Half the challenger's bond, 2,500,000, is split three ways and the rest
        // of both bonds is the proposer's.
        assert_eq!(
            (owed(&o, "j0.near"), owed(&o, "k0.near"), owed(&o, "k1.near")),
            (833_333, 833_333, 833_333)
        );
        assert_eq!(owed(&o, "carol.near"), 2 * BOND - 3 * 833_333);
        assert_eq!(
            (owed(&o, "dave.near"), owed(&o, "k2.near"), owed(&o, "j1.near")),
            (0, 0, 0)
        );
        assert_eq!(o.case(0).final_outcome, Some(Outcome::Void));
    }

    #[test]
    fn a_price_market_whose_dispute_never_decides_keeps_the_signed_price_and_an_event_market_is_void() {
        for (price_rule, expected) in [
            (
                Some(PriceRule {
                    observation_time: U64(0),
                    strike: U128(1),
                    decimals: 2,
                    above: true,
                }),
                Outcome::Yes,
            ),
            (None, Outcome::Void),
        ] {
            let mut o = challenged(Outcome::Yes, Outcome::No);
            o.markets.insert(
                0,
                MarketInfo {
                    price_rule,
                    ..o.get_market_info(U64(0)).unwrap()
                },
            );
            let mut case = o.case(0);
            case.round = 1;
            o.cases.insert(0, case);
            act_as("anyone.near", DRAW_BY + 1);
            o.finalize(U64(0));
            assert_eq!(o.case(0).final_outcome, Some(expected));
            let applied = calls_to("set_outcome");
            assert_eq!(
                applied,
                vec![near_sdk::serde_json::json!({ "market_id": "0", "outcome": expected })]
            );
        }
    }

    #[test]
    #[should_panic(expected = "not on the panel for this case")]
    fn a_juror_of_the_first_jury_cannot_reveal_in_the_second_round() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        let first = names(3, "j");
        let over = first_round_that_does_nothing(&mut o, &first);
        commit(&mut o, "j0.near", DRAW_BY + SECOND, Outcome::No, "a-long-random-salt");
        act_as("anyone.near", over);
        o.finalize(U64(0));
        seat(&mut o, over + SECOND, &names(7, "k"));
        reveal_when_open(&mut o, "j0.near", Outcome::No, "a-long-random-salt");
    }

    // Round one: j0 revealed No, j1 committed and never revealed, j2 never committed. Round two of seven: k0 to k3
    // reveal No and decide it, k4 committed and has time left, k5 and k6 never committed.
    #[test]
    fn jurors_who_never_voted_in_either_round_are_delinquent_and_every_revealer_with_the_outcome_is_paid() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        let first = names(3, "j");
        let over = first_round_that_does_nothing(&mut o, &first);
        commit(&mut o, "j0.near", DRAW_BY + SECOND, Outcome::No, "a-long-random-salt");
        commit(&mut o, "j1.near", DRAW_BY + SECOND, Outcome::No, "a-long-random-salt");
        reveal_when_open(&mut o, "j0.near", Outcome::No, "a-long-random-salt");
        act_at_height("anyone.near", over, 30);
        o.finalize(U64(0));
        seat(&mut o, over + SECOND, &names(7, "k"));
        let case = o.case(0);
        for i in 0..5 {
            commit(
                &mut o,
                &format!("k{i}.near"),
                over + 2 * SECOND,
                Outcome::No,
                "a-long-random-salt",
            );
        }
        for i in 0..4 {
            reveal(
                &mut o,
                &format!("k{i}.near"),
                case.commit_ends_at.0,
                Outcome::No,
                "a-long-random-salt",
            );
        }
        let case = o.case(0);
        assert_eq!((case.stage, case.final_outcome), (Stage::Final, Some(Outcome::No)));
        assert_eq!(
            case.delinquent,
            vec![acct("j1.near"), acct("j2.near"), acct("k5.near"), acct("k6.near")],
            "the first jury's non-voters, and the second jury's who never committed"
        );
        // Carol proposed Yes and lost. A quarter of her bond is split by the five who revealed No, across both rounds.
        for juror in ["j0.near", "k0.near", "k1.near", "k2.near", "k3.near"] {
            assert_eq!(owed(&o, juror), 250_000, "{juror}");
        }
        assert_eq!(owed(&o, "dave.near"), 2 * BOND - 1_250_000);
        assert_eq!(owed(&o, "carol.near"), 0);
    }

    #[test]
    fn retry_unlock_after_a_second_round_releases_both_juries() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        let mut case = o.case(0);
        case.round = 1;
        o.cases.insert(0, case);
        act_as("anyone.near", DRAW_BY + 1);
        o.finalize(U64(0));
        act_as("stranger.near", DRAW_BY + 2);
        let _ = o.retry_unlock(U64(0));
        let keys: Vec<_> = calls_to("unlock_case").iter().map(|u| u["case_key"].clone()).collect();
        assert_eq!(
            keys,
            vec![
                near_sdk::serde_json::json!("0"),
                near_sdk::serde_json::json!(SECOND_ROUND_KEY.to_string())
            ]
        );
    }

    // ---- gas floors ---------------------------------------------------------------------------------------

    fn act_with_gas(who: &str, now_ns: u64, tgas: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .block_timestamp(now_ns)
            .attached_deposit(NearToken::from_yoctonear(1))
            .prepaid_gas(Gas::from_tgas(tgas))
            .build());
    }

    // The least a method may be called with, and the words its refusal starts with.
    #[test]
    fn a_call_below_its_gas_floor_is_refused_with_the_amount_to_attach() {
        let settle = "attach at least 80 TGas: a call that settles a case sends the answer to the market and releases the juries";
        let mut o = challenged(Outcome::Yes, Outcome::No);
        let at = DRAW_BY + 1;
        act_with_gas("anyone.near", at, 79);
        assert_eq!(refusal(|| o.finalize(U64(0))), settle);
        act_with_gas("anyone.near", at, 79);
        assert_eq!(refusal(|| o.resolve_by_deadline(U64(0))), settle);
        act_with_gas("j0.near", at, 79);
        assert_eq!(
            refusal(|| o.reveal_vote(U64(0), Outcome::Yes, "s".into(), "r".into())),
            settle
        );
        act_with_gas("anyone.near", at, 274);
        assert_eq!(
            refusal(|| drop(o.resolve_draw(U64(0)))),
            "attach at least 275 TGas: the jury draw reads every staked seat"
        );
        act_with_gas("anyone.near", at, 34);
        assert_eq!(
            refusal(|| drop(o.retry_unlock(U64(0)))),
            "attach at least 35 TGas: each jury's release gets an equal share of what is attached"
        );
        act_with_gas("anyone.near", at, 32);
        assert_eq!(
            refusal(|| drop(o.withdraw_bond())),
            "attach at least 33 TGas: a withdrawal sends the payout and then settles it"
        );
    }

    // At the floor the gas check passes and the call goes on to whatever else it checks, here a market with no case.
    #[test]
    fn a_call_with_exactly_its_gas_floor_gets_past_the_check() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        let at = DRAW_BY + 1;
        let past = |refused: String| {
            assert!(
                refused.contains("not registered") || refused.contains("no case"),
                "{refused}"
            )
        };
        act_with_gas("anyone.near", at, 80);
        past(refusal(|| o.finalize(U64(99))));
        act_with_gas("anyone.near", at, 80);
        past(refusal(|| o.resolve_by_deadline(U64(99))));
        act_with_gas("j0.near", at, 80);
        past(refusal(|| o.reveal_vote(U64(99), Outcome::Yes, "s".into(), "r".into())));
        act_with_gas("anyone.near", at, 275);
        past(refusal(|| drop(o.resolve_draw(U64(99)))));
        act_with_gas("anyone.near", at, 35);
        past(refusal(|| drop(o.retry_unlock(U64(99)))));
        let refused = {
            act_with_gas("anyone.near", at, 33);
            refusal(|| drop(o.withdraw_bond()))
        };
        assert_eq!(refused, "nothing to withdraw");
    }

    #[test]
    fn the_floors_follow_from_what_the_methods_reserve() {
        assert_eq!(
            GAS_SETTLE_FLOOR,
            Gas::from_tgas(80),
            "apply 20, its callback 10, two releases of 15, and 20 for the call itself"
        );
        assert_eq!(
            GAS_DRAW_FLOOR,
            Gas::from_tgas(275),
            "the draw 250, its callback 15, and 10 for the call itself"
        );
        assert_eq!(GAS_RETRY_UNLOCK_FLOOR, Gas::from_tgas(35));
        assert_eq!(
            GAS_WITHDRAW_FLOOR,
            Gas::from_tgas(33),
            "the payout 15, its callback 10, and 8 for the call itself"
        );
        assert!(
            GAS_DRAW_FLOOR < Gas::from_tgas(300),
            "a transaction carries at most 300 TGas"
        );
    }

    // ---- the deadline answer is the oracle's ----------------------------------------------------------------

    #[test]
    #[should_panic(expected = "the answer deadline has not passed")]
    fn nobody_can_ask_for_the_deadline_answer_early() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..o.get_market_info(U64(0)).unwrap()
            },
        );
        act_as("anyone.near", MARKET_DEADLINE - 1);
        o.resolve_by_deadline(U64(0));
    }

    #[test]
    fn with_no_case_the_deadline_voids_the_market_and_there_is_no_case_to_mark_applied() {
        let mut o = fresh_oracle();
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(1_000),
                ..base_info()
            },
        );
        act_as("anyone.near", 1_000);
        o.resolve_by_deadline(U64(0));
        assert_eq!(
            calls_to("set_outcome"),
            vec![near_sdk::serde_json::json!({ "market_id": "0", "outcome": "void" })]
        );
        act_as(MARKET, 1_001);
        o.on_applied(U64(0), Ok(()));
        assert!(o.get_case(U64(0)).is_none());
    }

    // The answer nobody finalized is applied instead of voided over.
    #[test]
    fn a_settleable_unchallenged_proposal_is_settled_at_the_deadline_not_voided() {
        let mut o = oracle_with_bond(BOND);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MIN_GAP),
                ..base_info()
            },
        );
        act_as(VERIFIER, SECOND);
        deliver(&mut o, "carol.near", BOND, "propose:0:yes:https://x");
        act_as("anyone.near", MIN_GAP);
        o.resolve_by_deadline(U64(0));
        assert_eq!(
            calls_to("set_outcome"),
            vec![near_sdk::serde_json::json!({ "market_id": "0", "outcome": "yes" })]
        );
        assert_eq!((o.case(0).stage, owed(&o, "carol.near")), (Stage::Final, BOND));
    }

    #[test]
    fn a_dispute_that_ran_out_of_time_is_settled_with_no_decision_at_the_deadline() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(DRAW_BY + 1),
                ..o.get_market_info(U64(0)).unwrap()
            },
        );
        act_as("anyone.near", DRAW_BY + 1);
        o.resolve_by_deadline(U64(0));
        assert_eq!(
            (o.case(0).stage, o.case(0).final_outcome),
            (Stage::Final, Some(Outcome::Void))
        );
        assert_eq!(calls_to("set_outcome").len(), 1);
    }

    #[test]
    fn a_final_answer_the_market_never_received_is_sent_again_and_a_received_one_is_refused() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(DRAW_BY + 1),
                ..o.get_market_info(U64(0)).unwrap()
            },
        );
        act_as("anyone.near", DRAW_BY + 1);
        o.resolve_by_deadline(U64(0));
        act_as("anyone.near", DRAW_BY + 2);
        o.resolve_by_deadline(U64(0));
        assert_eq!(calls_to("set_outcome").len(), 1, "sent again");
        let mut case = o.case(0);
        case.applied = true;
        o.cases.insert(0, case);
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.resolve_by_deadline(U64(0))));
        assert!(again.is_err());
    }

    // The timing rules leave no case with time at resolve_by. If a later change ever does, the deadline call refuses
    // instead of voiding the market under a case that would settle an answer nobody can apply.
    #[test]
    fn a_proposal_whose_window_is_still_open_at_the_deadline_is_refused_not_voided() {
        let mut o = oracle_with_bond(BOND);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        act_as(VERIFIER, SECOND);
        deliver(&mut o, "carol.near", BOND, "propose:0:yes:https://x");
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(10 * SECOND),
                ..base_info()
            },
        );
        act_as("anyone.near", 10 * SECOND);
        assert!(refusal(|| o.resolve_by_deadline(U64(0))).contains("the case still has time"));
        assert!(calls_to("set_outcome").is_empty(), "the market was not told anything");
        assert_eq!(o.case(0).stage, Stage::Proposed);
    }

    #[test]
    fn a_dispute_whose_jury_still_has_time_at_the_deadline_is_refused_not_voided() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        seat(&mut o, DRAW_BY, &names(3, "j"));
        let panel_deadline = o.case(0).panel_deadline.0;
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(panel_deadline),
                ..o.get_market_info(U64(0)).unwrap()
            },
        );
        act_as("anyone.near", panel_deadline);
        assert!(refusal(|| o.resolve_by_deadline(U64(0))).contains("the case still has time"));
        assert!(calls_to("set_outcome").is_empty());
        assert_eq!(o.case(0).stage, Stage::Disputed);
        act_as("anyone.near", panel_deadline + 1);
        o.resolve_by_deadline(U64(0));
        assert_eq!(
            o.case(0).stage,
            Stage::Final,
            "one nanosecond later the round is over and it settles"
        );
    }

    // The most a jury can be seated after the last block a draw is allowed in: a few blocks.
    const SEAT_LAG: u64 = 10 * SECOND;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(300))]

        // Whatever the windows, whenever the answer is proposed and challenged, whenever the juries are seated (up to a few
        // blocks after the last allowed moment) and whenever, if ever, someone finalizes, a market that registered is never
        // at resolve_by with a case that still has time. Nobody ever has to act: the deadline call alone settles it.
        #[test]
        fn no_registered_market_reaches_its_deadline_with_a_case_that_still_has_time(
            window in 1u64..300,
            draw_window in 1u64..300,
            panel in 2u64..300,
            min_proposal in 1u64..300,
            extra in 0u64..600,
            propose_at in 0u64..=1000,
            challenge_at in proptest::option::of(0u64..1000),
            seat_at in proptest::collection::vec(
                proptest::option::of((prop_oneof![Just(1000), 0u64..=1000], prop_oneof![Just(SEAT_LAG), 0..=SEAT_LAG])),
                2,
            ),
            finalize_after in proptest::collection::vec(proptest::option::of(0u64..=1000), 2),
            at_the_limit in proptest::collection::vec(proptest::option::of(prop_oneof![Just(35), 0u64..=35]), 2),
        ) {
            let mut o = oracle_with_bond(BOND);
            o.window_ns = window * SECOND;
            o.draw_window_ns = draw_window * SECOND;
            o.panel_deadline_ns = panel * SECOND;
            o.min_proposal_ns = min_proposal * SECOND;
            let close = 1_000 * SECOND;
            let deadline = close + o.min_resolve_gap_ns() + extra * SECOND;
            act_as(MARKET, 0);
            o.register_market(U64(0), U64(close), U64(deadline), "hash".to_string(), None);
            let round = o.draw_window_ns + o.panel_deadline_ns;
            let span = case_span_ns(o.window_ns, o.draw_window_ns, o.panel_deadline_ns);
            // Proposals are tried up to the last moment a case could finish by the deadline with no buffer at all. The
            // buffered moment is the last one that has to be accepted. Any between is accepted or refused, never unsafe.
            let latest_proposal = deadline - span - APPLY_BUFFER_NS;
            let proposed = close + (latest_proposal + APPLY_BUFFER_NS - close) * propose_at / 1000;
            act_as(VERIFIER, proposed);
            let accepted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                deliver(&mut o, "carol.near", BOND, "propose:0:yes:https://x");
            }))
            .is_ok();
            prop_assert!(accepted || proposed > latest_proposal, "a proposal in time was refused");
            if !accepted {
                return Ok(());
            }
            if let Some(at) = challenge_at {
                let challenged_at = proposed + (o.window_ns - 1) * at / 1000;
                act_as(VERIFIER, challenged_at);
                deliver(&mut o, "dave.near", BOND, "challenge:0:no");
                let mut round_started = challenged_at;
                for turn in 0..2 {
                    let case = o.case(0);
                    if let Some((at, lag)) = seat_at[turn] {
                        let seated = round_started + (case.draw_by.0 - round_started) * at / 1000 + lag;
                        seat(&mut o, seated, &names(case.jury_size as usize, "j"));
                    }
                    let case = o.case(0);
                    let over = if case.panel.is_empty() { case.draw_by.0 } else { case.panel_deadline.0 } + 1;
                    let Some(after) = finalize_after[turn] else { break };
                    let at = match at_the_limit[turn] {
                        Some(offset) => (deadline - round - APPLY_BUFFER_NS + offset * SECOND).saturating_sub(5 * SECOND).max(over),
                        None => over + deadline.saturating_sub(over) * after / 1000,
                    };
                    if at >= deadline {
                        break;
                    }
                    act_as("anyone.near", at);
                    o.finalize(U64(0));
                    if o.case(0).stage == Stage::Final {
                        break;
                    }
                    round_started = at;
                }
            }
            let case = o.case(0);
            match case.stage {
                Stage::Proposed => prop_assert!(deadline >= case.window_ends_at.0, "the challenge window is still open"),
                Stage::Disputed => prop_assert!(round_is_over(&case, deadline), "the round is not over"),
                Stage::Final => {}
            }
            act_as("anyone.near", deadline);
            o.resolve_by_deadline(U64(0));
            prop_assert_eq!(o.case(0).stage, Stage::Final);
        }
    }

    // ---- the juror methods need exactly one yocto -----------------------------------------------------------

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn commit_vote_refuses_a_call_with_no_deposit() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_unpaid("j0.near", DRAW_BY);
        o.commit_vote(U64(0), "0".repeat(64));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn reveal_vote_refuses_a_call_with_no_deposit() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_unpaid("j0.near", DRAW_BY);
        o.reveal_vote(U64(0), Outcome::Yes, "salt".into(), "because".into());
    }

    // ---- the minimum gap counts the draw window and both rounds -----------------------------------------------

    #[test]
    fn the_minimum_gap_counts_the_proposal_time_the_window_both_rounds_and_the_apply_buffer() {
        let o = fresh_oracle();
        let expected = 60 * SECOND + WINDOW + 2 * (DRAW_WINDOW + PANEL) + APPLY_BUFFER_NS;
        assert_eq!(o.config()["min_resolve_gap_ns"], expected.to_string());
        assert_eq!(o.config()["draw_window_ns"], DRAW_WINDOW.to_string());
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
        PriceRule {
            observation_time: U64(OBS),
            strike: U128(STRIKE),
            decimals: 2,
            above,
        }
    }

    // `signer`'s entry for a submission: its key, a dot, and its signature over `message` in hex.
    fn entry(signer: &SigningKey, message: &str) -> String {
        let signature: String = signer
            .sign(message.as_bytes())
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        format!("{}.{signature}", public(signer))
    }

    // What the market's own rule makes publishers sign for `price`.
    fn message(market: u64, rule: &PriceRule, price: u128) -> String {
        price_message(&env::current_account_id(), NETWORK, market, rule, price)
    }

    // Three publishers, two of whom must sign, and price market 0 observed at OBS with room to be answered.
    fn price_oracle(above: bool) -> (OracleContract, Vec<SigningKey>) {
        let mut o = oracle_with(BOND, 2);
        let keys: Vec<SigningKey> = (1..=3).map(signing_key).collect();
        act_as(OWNER, 0);
        for k in &keys {
            o.add_publisher(public(k));
        }
        act_as(MARKET, 0);
        o.register_market(
            U64(0),
            U64(OBS),
            U64(OBS + MIN_GAP + 10_000_000_000),
            "hash".to_string(),
            Some(rule(above)),
        );
        (o, keys)
    }

    fn submit(o: &mut OracleContract, at: u64, price: u128, entries: &[String]) {
        act_as(VERIFIER, at);
        deliver(o, "carol.near", BOND, &format!("price:0:{price}:{}", entries.join(",")));
    }

    fn signed_by(keys: &[&SigningKey], market: u64, rule: &PriceRule, price: u128) -> Vec<String> {
        act_as(VERIFIER, 0);
        keys.iter().map(|k| entry(k, &message(market, rule, price))).collect()
    }

    #[test]
    fn two_of_three_publishers_signing_the_markets_own_price_open_a_case() {
        let (mut o, k) = price_oracle(true);
        let sigs = signed_by(&[&k[0], &k[2]], 0, &rule(true), 1_250);
        submit(&mut o, OBS, 1_250, &sigs);
        let case = o.case(0);
        assert_eq!(
            (case.stage, case.proposed, case.proposer),
            (Stage::Proposed, Outcome::Yes, acct("carol.near"))
        );
        assert_eq!(case.evidence, "signed price 1250 by 2 publishers");
    }

    // The data of the last proposed event the call logged.
    fn proposed_event() -> near_sdk::serde_json::Value {
        near_sdk::test_utils::get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
            .find(|e| e["event"] == "proposed")
            .expect("a proposed event")["data"]
            .clone()
    }

    #[test]
    fn the_proposed_event_of_a_price_answer_names_the_publishers_who_signed() {
        let (mut o, k) = price_oracle(true);
        let sigs = signed_by(&[&k[2], &k[0]], 0, &rule(true), 1_250);
        submit(&mut o, OBS, 1_250, &sigs);
        let event = proposed_event();
        assert_eq!(
            event["signers"],
            near_sdk::serde_json::json!([public(&k[2]).to_string(), public(&k[0]).to_string()])
        );
        assert_eq!(event["evidence"], "signed price 1250 by 2 publishers");
    }

    #[test]
    fn every_signer_counts_and_is_named_when_more_than_the_threshold_sign() {
        let (mut o, k) = price_oracle(true);
        let sigs = signed_by(&[&k[0], &k[1], &k[2]], 0, &rule(true), 900);
        submit(&mut o, OBS, 900, &sigs);
        let signers = proposed_event()["signers"].clone();
        assert_eq!(signers.as_array().unwrap().len(), 3);
        assert_eq!(o.case(0).evidence, "signed price 900 by 3 publishers");
    }

    #[test]
    fn a_plain_proposal_names_no_signers() {
        let mut o = oracle_with_resolve_by(MARKET_DEADLINE);
        act_as(VERIFIER, 10 * SECOND);
        let bond = o.bond;
        deliver(&mut o, "carol.near", bond, "propose:0:yes:https://example.com");
        assert_eq!(proposed_event()["signers"], near_sdk::serde_json::json!([]));
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
        act_as(VERIFIER, 0);
        let contract = env::current_account_id();
        let message = signed(&contract);
        let sigs = vec![entry(&k[0], &message), entry(&k[1], &message)];
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            submit(&mut o, OBS, price_submitted, &sigs)
        }));
        assert!(
            outcome.is_err(),
            "a signature over {message} must not open a case for price {price_submitted}"
        );
        assert!(o.cases.get(&0).is_none());
    }

    #[test]
    fn a_signature_is_good_for_one_price_of_one_market_on_one_network_and_one_contract_only() {
        let r = rule(true);
        assert_refused_when_signed_over(|c| price_message(c, NETWORK, 1, &r, 1_250), 1_250); // another market
        assert_refused_when_signed_over(|c| price_message(c, "mainnet", 0, &r, 1_250), 1_250); // another network
        assert_refused_when_signed_over(|_| price_message(&acct("other.near"), NETWORK, 0, &r, 1_250), 1_250); // another contract
        assert_refused_when_signed_over(
            |c| {
                price_message(
                    c,
                    NETWORK,
                    0,
                    &PriceRule {
                        observation_time: U64(OBS + 1),
                        ..r
                    },
                    1_250,
                )
            },
            1_250,
        ); // another moment
        assert_refused_when_signed_over(
            |c| price_message(c, NETWORK, 0, &PriceRule { decimals: 8, ..r }, 1_250),
            1_250,
        ); // other decimals
        assert_refused_when_signed_over(|c| price_message(c, NETWORK, 0, &r, 1_250), 1_251);
        // a different price than was signed
    }

    #[test]
    #[should_panic(expected = "a price market is answered with a signed price")]
    fn a_price_market_cannot_be_answered_with_a_plain_proposal() {
        let (mut o, _) = price_oracle(true);
        act_as(VERIFIER, OBS);
        deliver(&mut o, "carol.near", BOND, "propose:0:yes:https://x");
    }

    #[test]
    #[should_panic(expected = "not a price market")]
    fn an_event_market_does_not_take_a_signed_price() {
        let (mut o, k) = price_oracle(true);
        act_as(MARKET, 0);
        o.register_market(U64(1), U64(OBS), U64(OBS + MIN_GAP), "hash".to_string(), None);
        let sigs = signed_by(&[&k[0], &k[1]], 1, &rule(true), 1_250);
        act_as(VERIFIER, OBS);
        deliver(&mut o, "carol.near", BOND, &format!("price:1:1250:{}", sigs.join(",")));
    }

    #[test]
    #[should_panic(expected = "not enough price publishers are configured")]
    fn a_price_market_cannot_register_before_enough_publishers_exist() {
        let mut o = oracle_with(BOND, 2);
        act_as(OWNER, 0);
        o.add_publisher(public(&signing_key(1)));
        act_as(MARKET, 0);
        o.register_market(
            U64(0),
            U64(OBS),
            U64(OBS + MIN_GAP),
            "hash".to_string(),
            Some(rule(true)),
        );
    }

    #[test]
    fn a_price_market_is_measured_from_its_observation_time_not_its_close() {
        let mut o = oracle_with(BOND, 1);
        act_as(OWNER, 0);
        o.add_publisher(public(&signing_key(1)));
        act_as(MARKET, 0);
        // Closes at 0 and is observed a day later, so a gap measured from the close would be huge.
        let obs = 86_400_000_000_000;
        let late = PriceRule {
            observation_time: U64(obs),
            ..rule(true)
        };
        o.register_market(U64(0), U64(0), U64(obs + MIN_GAP), "hash".to_string(), Some(late));
        assert!(o.get_market_info(U64(0)).is_some());
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            o.register_market(U64(1), U64(0), U64(obs + MIN_GAP - 1), "hash".to_string(), Some(late));
        }));
        assert!(
            caught.is_err(),
            "one nanosecond short of the gap after the observation is refused"
        );
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
        let mut o = oracle_with_resolve_by(CASE_SPAN);
        act_as(VERIFIER, 0);
        deliver(&mut o, "carol.near", 1, "propose:0:yes:https://x");
    }

    #[test]
    fn a_proposal_is_accepted_with_exactly_apply_buffer_of_slack() {
        let mut o = oracle_with_resolve_by(CASE_SPAN + APPLY_BUFFER_NS);
        act_as(VERIFIER, 0);
        deliver(&mut o, "carol.near", 1, "propose:0:yes:https://x");
        assert_eq!(
            o.case(0).stage,
            Stage::Proposed,
            "exactly the buffer's worth of slack is accepted"
        );
    }

    #[test]
    #[should_panic(expected = "too late to propose, the market will be voided at its deadline")]
    fn a_proposal_is_refused_one_nanosecond_short_of_the_buffer() {
        let mut o = oracle_with_resolve_by(CASE_SPAN + APPLY_BUFFER_NS - 1);
        act_as(VERIFIER, 0);
        deliver(&mut o, "carol.near", 1, "propose:0:yes:https://x");
    }

    // ---- code: staging, upgrade, migrate and seal ---------------------------------------------------------

    const WASM: &[u8] = &[0, 97, 115, 109, 1, 0, 0, 0, 9, 9, 9];
    const KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
    const SELF: &str = "alice.near";

    fn stage_wasm(o: &mut OracleContract, deposit: NearToken) -> Base58CryptoHash {
        let mut builder = VMContextBuilder::new();
        builder
            .predecessor_account_id(acct("anyone.near"))
            .attached_deposit(deposit);
        builder.context.input = WASM.to_vec().into();
        testing_env!(builder.build());
        o.stage_code()
    }

    fn staged(o: &mut OracleContract) -> Base58CryptoHash {
        stage_wasm(o, NearToken::from_near(5))
    }

    fn receipts() -> Vec<near_sdk::mock::Receipt> {
        near_sdk::test_utils::get_created_receipts()
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn staging_with_too_little_deposit_is_refused() {
        let mut o = fresh_oracle();
        stage_wasm(&mut o, NearToken::from_yoctonear(1));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_stranger_cannot_upgrade() {
        let mut o = fresh_oracle();
        let hash = staged(&mut o);
        act_unpaid("stranger.near", 5);
        let _ = o.upgrade(hash);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn the_operator_cannot_upgrade() {
        let mut o = fresh_oracle();
        let hash = staged(&mut o);
        act_unpaid(OPERATOR, 5);
        let _ = o.upgrade(hash);
    }

    #[test]
    #[should_panic(expected = "no code is staged under that hash")]
    fn an_upgrade_to_a_hash_nobody_staged_is_refused() {
        let mut o = fresh_oracle();
        act_unpaid(OWNER, 5);
        let _ = o.upgrade(Base58CryptoHash::from([5u8; 32]));
    }

    #[test]
    #[should_panic(expected = "attach at least 100 TGas to upgrade")]
    fn an_upgrade_with_too_little_gas_is_refused_and_says_how_much() {
        let mut o = fresh_oracle();
        let hash = staged(&mut o);
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(OWNER))
            .prepaid_gas(Gas::from_tgas(99))
            .build());
        let _ = o.upgrade(hash);
    }

    #[test]
    fn the_owner_deploys_the_staged_code_and_migrates_in_one_batch_and_the_copy_is_removed() {
        let mut o = fresh_oracle();
        let hash = staged(&mut o);
        assert!(o.is_staged(hash));
        act_unpaid(OWNER, 5);
        let _ = o.upgrade(hash);
        assert!(!o.is_staged(hash), "the staged copy is gone");
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
        let mut o = fresh_oracle();
        act_unpaid(OWNER, 5);
        let _ = o.seal(KEY.parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_stranger_cannot_seal() {
        let mut o = fresh_oracle();
        o.upgrade_proven = true;
        act_unpaid("stranger.near", 5);
        let _ = o.seal(KEY.parse().unwrap());
    }

    #[test]
    fn once_proven_the_owner_deletes_a_key() {
        let mut o = fresh_oracle();
        o.upgrade_proven = true;
        act_unpaid(OWNER, 5);
        let _ = o.seal(KEY.parse().unwrap());
        assert!(
            matches!(&receipts()[0].actions[0], near_sdk::mock::MockAction::DeleteKey { public_key, .. } if public_key.to_string() == KEY)
        );
    }

    #[test]
    fn migrate_keeps_markets_and_cases_and_marks_the_upgrade_proven() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        assert!(!o.upgrade_proven);
        o.upgrade_in_flight = true;
        env::state_write(&o);
        drop(o);
        act_unpaid(SELF, 5);
        let migrated = OracleContract::migrate();
        assert_eq!(
            (
                migrated.upgrade_proven,
                migrated.upgrade_in_flight,
                migrated.state_version
            ),
            (true, false, 1)
        );
        assert_eq!(migrated.case(0).stage, Stage::Disputed);
        assert_eq!(migrated.config()["upgrade_proven"], true);
    }

    #[test]
    #[should_panic(expected = "migrate runs only inside an upgrade")]
    fn migrate_called_by_hand_is_refused_and_proves_nothing() {
        let o = fresh_oracle();
        env::state_write(&o);
        drop(o);
        act_unpaid(SELF, 5);
        OracleContract::migrate();
    }

    #[test]
    fn upgrade_marks_the_upgrade_in_flight_and_a_second_one_sets_it_again() {
        let mut o = fresh_oracle();
        let hash = staged(&mut o);
        assert!(!o.upgrade_in_flight);
        act_unpaid(OWNER, 5);
        let _ = o.upgrade(hash);
        assert!(o.upgrade_in_flight);
        assert_eq!(o.config()["upgrade_in_flight"], true);
        o.upgrade_in_flight = false;
        let again = staged(&mut o);
        act_unpaid(OWNER, 6);
        let _ = o.upgrade(again);
        assert!(o.upgrade_in_flight, "the next upgrade sets it again");
    }

    #[test]
    #[should_panic(expected = "migrate expects version 1")]
    fn migrate_refuses_state_written_by_another_version() {
        let mut o = fresh_oracle();
        o.state_version = 2;
        env::state_write(&o);
        drop(o);
        act_unpaid(SELF, 5);
        OracleContract::migrate();
    }

    // ---- the owner's settings ---------------------------------------------------------------------------

    type Setter = fn(&mut OracleContract, u64);
    // (name, setter, the config key it changes, the event it emits, the config value after setting 7)
    const SETTERS: [(&str, Setter, &str, &str, &str); 6] = [
        ("set_bond", |o, v| o.set_bond(U128(v as u128)), "bond", "bond_set", "7"),
        (
            "set_window_ms",
            |o, v| o.set_window_ms(U64(v)),
            "window_ns",
            "window_set",
            "7000000",
        ),
        (
            "set_panel_deadline_ms",
            |o, v| o.set_panel_deadline_ms(U64(v)),
            "panel_deadline_ns",
            "panel_deadline_set",
            "7000000",
        ),
        (
            "set_min_proposal_ms",
            |o, v| o.set_min_proposal_ms(U64(v)),
            "min_proposal_ns",
            "min_proposal_set",
            "7000000",
        ),
        (
            "set_draw_window_ms",
            |o, v| o.set_draw_window_ms(U64(v)),
            "draw_window_ns",
            "draw_window_set",
            "7000000",
        ),
        (
            "set_draw_delay_blocks",
            |o, v| o.set_draw_delay_blocks(U64(v)),
            "draw_delay_blocks",
            "draw_delay_set",
            "7",
        ),
    ];

    fn refusal(f: impl FnOnce()) -> String {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a refusal");
        err.downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    #[test]
    fn every_setting_refuses_a_stranger_and_the_operator() {
        let mut o = fresh_oracle();
        for who in ["stranger.near", OPERATOR] {
            for (name, set, ..) in SETTERS {
                act_unpaid(who, 5);
                assert!(refusal(|| set(&mut o, 7)).contains("owner only"), "{name} by {who}");
            }
        }
    }

    #[test]
    fn every_setting_but_the_draw_delay_refuses_zero() {
        let mut o = fresh_oracle();
        for (name, set, ..) in &SETTERS[..5] {
            act_unpaid(OWNER, 5);
            let message = refusal(|| set(&mut o, 0));
            assert!(message.contains("must be positive"), "{name}: {message}");
        }
    }

    #[test]
    fn every_setting_changes_its_value_and_emits_its_event() {
        let mut o = fresh_oracle();
        for (name, set, key, event, shown) in SETTERS {
            act_unpaid(OWNER, 5);
            set(&mut o, 7);
            assert_eq!(o.config()[key], shown, "{name}");
            assert!(
                near_sdk::test_utils::get_logs().iter().any(|l| l.contains(event)),
                "{name} emits {event}"
            );
        }
    }

    #[test]
    fn a_market_registered_before_a_setting_change_keeps_its_windows_and_one_registered_after_uses_the_new_ones() {
        let mut o = fresh_oracle();
        act_as(MARKET, 0);
        o.register_market(U64(0), U64(1_000), U64(1_000 + MIN_GAP), "hash".to_string(), None);
        act_unpaid(OWNER, 1);
        o.set_window_ms(U64(600_000));
        o.set_panel_deadline_ms(U64(1_200_000));
        o.set_draw_window_ms(U64(600_000));
        assert_ne!(
            o.config()["min_resolve_gap_ns"],
            MIN_GAP.to_string(),
            "the longer settings raise the gap new markets need"
        );
        act_as(MARKET, 2);
        o.register_market(U64(1), U64(1_000), U64(1_000 + 20 * MIN_GAP), "hash".to_string(), None);

        let (old, new) = (o.market_info(0), o.market_info(1));
        assert_eq!(
            (old.window_ns.0, old.draw_window_ns.0, old.panel_deadline_ns.0),
            (WINDOW, DRAW_WINDOW, PANEL)
        );
        assert_eq!(
            (new.window_ns.0, new.draw_window_ns.0, new.panel_deadline_ns.0),
            (10 * WINDOW, 10 * DRAW_WINDOW, 10 * PANEL)
        );

        // The old market still fits a whole case in its time, and every deadline of the case is on the old windows.
        act_as(VERIFIER, 1_000);
        deliver(&mut o, "carol.near", 1, "propose:0:yes:https://x");
        assert_eq!(o.case(0).window_ends_at.0, 1_000 + WINDOW);
        act_as(VERIFIER, 1_001);
        deliver(&mut o, "dave.near", 1, "challenge:0:no");
        assert_eq!(o.case(0).draw_by.0, 1_001 + DRAW_WINDOW);
        seat(&mut o, 1_002, &names(3, "j"));
        let case = o.case(0);
        assert_eq!(
            (case.commit_ends_at.0, case.panel_deadline.0),
            (1_002 + PANEL / 2, 1_002 + PANEL)
        );

        // The new market runs on the new windows.
        act_as(VERIFIER, 1_000);
        deliver(&mut o, "carol.near", 1, "propose:1:yes:https://x");
        assert_eq!(o.case(1).window_ends_at.0, 1_000 + 10 * WINDOW);
    }

    #[test]
    fn a_round_two_draw_on_an_old_market_gets_the_old_draw_window() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_unpaid(OWNER, 3);
        o.set_draw_window_ms(U64(600_000));
        o.set_panel_deadline_ms(U64(1_200_000));
        act_as("anyone.near", DRAW_BY + 1);
        o.finalize(U64(0));
        let case = o.case(0);
        assert_eq!((case.round, case.draw_by.0), (1, DRAW_BY + 1 + DRAW_WINDOW));
    }

    // ---- the bond ---------------------------------------------------------------------------------------

    #[test]
    fn a_new_bond_applies_to_new_cases_and_a_challenge_matches_the_bond_its_case_was_proposed_with() {
        let mut o = fresh_oracle();
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        o.markets.insert(
            1,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        act_as(VERIFIER, SECOND);
        deliver(&mut o, "carol.near", 1, "propose:0:yes:https://x");
        act_unpaid(OWNER, 2 * SECOND);
        o.set_bond(U128(5));
        assert_eq!(o.case(0).bond.0, 1, "the open case keeps its bond");

        act_as(VERIFIER, 3 * SECOND);
        assert!(refusal(|| {
            deliver(&mut o, "dave.near", 5, "challenge:0:no");
        })
        .contains("send exactly the bond"));
        deliver(&mut o, "dave.near", 1, "challenge:0:no");
        assert_eq!(o.case(0).stage, Stage::Disputed);

        act_as(VERIFIER, 4 * SECOND);
        assert!(refusal(|| {
            deliver(&mut o, "carol.near", 1, "propose:1:yes:https://x");
        })
        .contains("send exactly the bond"));
        deliver(&mut o, "carol.near", 5, "propose:1:yes:https://x");
        assert_eq!(o.case(1).bond.0, 5);
    }

    #[test]
    fn a_settled_case_pays_the_bond_it_was_proposed_with_not_the_current_one() {
        let mut o = fresh_oracle();
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        act_as(VERIFIER, SECOND);
        deliver(&mut o, "carol.near", 1, "propose:0:yes:https://x");
        act_unpaid(OWNER, 2 * SECOND);
        o.set_bond(U128(5));
        act_as("anyone.near", SECOND + WINDOW);
        o.finalize(U64(0));
        assert_eq!(owed(&o, "carol.near"), 1);
    }

    // ---- money through the verifier ---------------------------------------------------------------------------

    fn logged(event: &str) -> Vec<near_sdk::serde_json::Value> {
        near_sdk::test_utils::get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
            .filter(|e| e["event"] == event)
            .map(|e| e["data"].clone())
            .collect()
    }

    // The verifier call a payout sent: its arguments, the yocto attached and the gas reserved.
    fn mt_transfer_sent() -> (near_sdk::serde_json::Value, u128, u64) {
        let sent = receipts();
        assert_eq!(sent[0].receiver_id, acct(VERIFIER));
        match &sent[0].actions[0] {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                ..
            } => {
                assert_eq!(method_name.as_slice(), b"mt_transfer");
                (
                    near_sdk::serde_json::from_slice(args).unwrap(),
                    attached_deposit.as_yoctonear(),
                    prepaid_gas.as_gas(),
                )
            }
            other => panic!("not a function call: {other:?}"),
        }
    }

    // Market 0 is open for answers. Carol puts her bond in through the hook at one second and nobody challenges, so it is
    // hers to withdraw once anyone finalizes.
    fn unchallenged_and_final() -> OracleContract {
        let mut o = oracle_with_bond(BOND);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        act_as(VERIFIER, SECOND);
        deliver(&mut o, "carol.near", BOND, "propose:0:yes:https://x");
        act_as("anyone.near", SECOND + WINDOW);
        o.finalize(U64(0));
        o
    }

    #[test]
    fn a_bond_from_the_verifier_is_kept_in_full_and_counted_as_owed() {
        let mut o = oracle_with_bond(BOND);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        act_as(VERIFIER, SECOND);
        assert_eq!(
            deliver(&mut o, "carol.near", BOND, "propose:0:yes:https://x"),
            vec![U128(0)]
        );
        assert_eq!(o.case(0).proposer, acct("carol.near"));
        assert_eq!((o.total_owed().0, o.bonds_held, o.claimable_total), (BOND, BOND, 0));
        act_as(VERIFIER, CHALLENGED_AT);
        assert_eq!(deliver(&mut o, "dave.near", BOND, "challenge:0:no"), vec![U128(0)]);
        assert_eq!(o.case(0).challenger, Some(acct("dave.near")));
        assert_eq!(
            (o.total_owed().0, o.bonds_held, o.claimable_total),
            (2 * BOND, 2 * BOND, 0)
        );
    }

    #[test]
    fn a_bond_from_anyone_but_the_verifier_is_refused_and_counts_for_nothing() {
        let mut o = oracle_with_resolve_by(MARKET_DEADLINE);
        for who in ["carol.near", COUNCIL, MARKET, OWNER, OPERATOR, "stranger.near"] {
            act_as(who, SECOND);
            let message = refusal(|| {
                deliver(&mut o, "carol.near", 1, "propose:0:yes:https://x");
            });
            assert_eq!(message, "only the verifier can deliver money", "{who}");
        }
        assert!(o.cases.get(&0).is_none());
        assert_eq!(o.total_owed().0, 0);
    }

    #[test]
    fn a_delivery_that_is_not_one_bond_of_the_collateral_from_the_senders_own_balance_is_refused() {
        let mut o = oracle_with_bond(BOND);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        let (carol, dave) = (acct("carol.near"), acct("dave.near"));
        let bond = U128(BOND);
        let msg = "propose:0:yes:https://x";
        // What is wrong, then the previous owners, token ids and amounts of the delivery, then the refusal.
        type Delivery = (&'static str, Vec<AccountId>, Vec<String>, Vec<U128>, &'static str);
        let cases: Vec<Delivery> = vec![
            (
                "another token",
                vec![carol.clone()],
                vec!["nep141:other.near".into()],
                vec![bond],
                "wrong token",
            ),
            (
                "the bare contract id",
                vec![carol.clone()],
                vec!["usdc.near".into()],
                vec![bond],
                "wrong token",
            ),
            (
                "two tokens in one delivery",
                vec![carol.clone(), carol.clone()],
                vec![COLLATERAL.into(), COLLATERAL.into()],
                vec![bond, bond],
                "exactly one token and amount",
            ),
            (
                "no token at all",
                vec![],
                vec![],
                vec![],
                "exactly one token and amount",
            ),
            (
                "one token with two amounts",
                vec![carol.clone()],
                vec![COLLATERAL.into()],
                vec![bond, bond],
                "exactly one token and amount",
            ),
            (
                "money that was somebody else's",
                vec![dave.clone()],
                vec![COLLATERAL.into()],
                vec![bond],
                "the money must come from the sender's own balance",
            ),
            (
                "no previous owner",
                vec![],
                vec![COLLATERAL.into()],
                vec![bond],
                "the money must come from the sender's own balance",
            ),
            (
                "money passed through two owners",
                vec![carol.clone(), dave.clone()],
                vec![COLLATERAL.into()],
                vec![bond],
                "the money must come from the sender's own balance",
            ),
            (
                "a zero amount",
                vec![carol.clone()],
                vec![COLLATERAL.into()],
                vec![U128(0)],
                "amount must be positive",
            ),
            (
                "an amount that is not the bond",
                vec![carol.clone()],
                vec![COLLATERAL.into()],
                vec![U128(BOND + 1)],
                "send exactly the bond",
            ),
        ];
        for (what, previous, tokens, amounts, why) in cases {
            act_as(VERIFIER, SECOND);
            let message = refusal(|| {
                let _ = o.mt_on_transfer(carol.clone(), previous, tokens, amounts, msg.to_string());
            });
            assert_eq!(message, why, "{what}");
        }
        assert!(o.cases.get(&0).is_none(), "nothing was proposed");
        assert_eq!(o.total_owed().0, 0, "nothing was counted");
    }

    #[test]
    fn a_message_the_hook_does_not_know_is_refused_so_the_verifier_gives_the_money_back() {
        let mut o = oracle_with_bond(BOND);
        o.markets.insert(
            0,
            MarketInfo {
                resolve_by: U64(MARKET_DEADLINE),
                ..base_info()
            },
        );
        for (msg, why) in [
            ("hello", "bad market id"),
            ("deposit", "bad market id"),
            ("propose:x:yes:https://x", "bad market id"),
            ("propose:0:maybe:https://x", "outcome must be yes, no or void"),
            ("withdraw:0", "unknown action"),
            ("challenge:0:no", "no case for that market"),
        ] {
            act_as(VERIFIER, SECOND);
            let message = refusal(|| {
                deliver(&mut o, "carol.near", BOND, msg);
            });
            assert!(message.contains(why), "{msg}: {message}");
        }
        assert!(o.cases.get(&0).is_none());
        assert_eq!(o.total_owed().0, 0);
    }

    #[test]
    fn an_unchallenged_case_releases_its_one_bond_into_claimable() {
        let o = unchallenged_and_final();
        assert_eq!((o.total_owed().0, o.bonds_held, o.claimable_total), (BOND, 0, BOND));
        assert_eq!(owed(&o, "carol.near"), BOND);
    }

    #[test]
    fn total_owed_follows_the_bonds_through_a_dispute_and_falls_only_as_payees_withdraw() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        assert_eq!(o.total_owed().0, 2 * BOND, "both bonds are held while the case is open");
        let jurors = names(3, "j");
        seat(&mut o, DRAW_BY, &jurors);
        for j in &jurors[..2] {
            commit(&mut o, j, DRAW_BY + SECOND, Outcome::No, "a-long-random-salt");
        }
        reveal_when_open(&mut o, &jurors[0], Outcome::No, "a-long-random-salt");
        assert_eq!(o.total_owed().0, 2 * BOND, "a vote does not move money");
        reveal_when_open(&mut o, &jurors[1], Outcome::No, "a-long-random-salt");
        assert_eq!(o.case(0).stage, Stage::Final);
        assert_eq!(
            (o.total_owed().0, o.bonds_held, o.claimable_total),
            (2 * BOND, 0, 2 * BOND)
        );

        let mut left = 2 * BOND;
        for who in ["dave.near", "j0.near", "j1.near"] {
            let due = owed(&o, who);
            assert!(due > 0, "{who} is owed something");
            act_as(who, 10 * DEADLINE);
            let _ = o.withdraw_bond();
            left -= due;
            assert_eq!(o.total_owed().0, left, "{who} took {due}");
        }
        assert_eq!(left, 0, "two bonds, paid to three accounts, and nobody else is owed");
        assert_eq!(o.total_owed().0, 0);
    }

    #[test]
    fn a_withdrawal_is_one_mt_transfer_of_one_yocto_to_the_caller_and_to_nobody_else() {
        let mut o = unchallenged_and_final();
        act_as("stranger.near", 10 * DEADLINE);
        assert_eq!(refusal(|| drop(o.withdraw_bond())), "nothing to withdraw");
        act_as("carol.near", 10 * DEADLINE);
        let _ = o.withdraw_bond();
        let (args, deposit, gas) = mt_transfer_sent();
        assert_eq!((deposit, gas), (1, GAS_MT_TRANSFER.as_gas()));
        assert_eq!(args["receiver_id"], "carol.near");
        assert_eq!(args["token_id"], COLLATERAL);
        assert_eq!(args["amount"], BOND.to_string());
        assert_eq!((owed(&o, "carol.near"), o.total_owed().0), (0, 0));
    }

    #[test]
    fn a_withdrawal_without_the_one_yocto_is_refused() {
        let mut o = unchallenged_and_final();
        act_unpaid("carol.near", 10 * DEADLINE);
        assert_eq!(
            refusal(|| drop(o.withdraw_bond())),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        assert_eq!(owed(&o, "carol.near"), BOND, "nothing was taken");
    }

    #[test]
    fn a_payout_the_verifier_refused_gives_the_balance_back_and_a_paid_one_stays_paid() {
        let mut o = unchallenged_and_final();
        act_as("carol.near", 10 * DEADLINE);
        let _ = o.withdraw_bond();
        assert_eq!((owed(&o, "carol.near"), o.total_owed().0), (0, 0));

        act_as(OWNER, 10 * DEADLINE);
        o.on_bond_withdrawn(acct("carol.near"), U128(BOND), Err(PromiseError::Failed));
        assert_eq!(
            (owed(&o, "carol.near"), o.total_owed().0, o.claimable_total),
            (BOND, BOND, BOND),
            "the balance and the books are back"
        );
        assert_eq!(
            logged("bond_payout_failed"),
            vec![near_sdk::serde_json::json!({ "account": "carol.near", "amount": BOND.to_string() })]
        );

        act_as("carol.near", 10 * DEADLINE);
        let _ = o.withdraw_bond();
        act_as(OWNER, 10 * DEADLINE);
        o.on_bond_withdrawn(acct("carol.near"), U128(BOND), Ok(()));
        assert_eq!((owed(&o, "carol.near"), o.total_owed().0), (0, 0));
        assert_eq!(
            logged("bond_paid"),
            vec![near_sdk::serde_json::json!({ "account": "carol.near", "amount": BOND.to_string() })]
        );
        assert!(logged("bond_payout_failed").is_empty());
    }

    #[test]
    fn two_accounts_with_a_balance_each_withdraw_only_their_own() {
        let mut o = challenged(Outcome::Yes, Outcome::No);
        act_as("anyone.near", DRAW_BY + 1);
        o.finalize(U64(0));
        act_as("anyone.near", DRAW_BY + 1 + PANEL + DRAW_WINDOW + PANEL);
        o.finalize(U64(0));
        let (carol, dave) = (owed(&o, "carol.near"), owed(&o, "dave.near"));
        assert!(
            carol > 0 && dave == 0,
            "the challenger gets nothing back after no decision"
        );
        act_as("carol.near", 10 * DEADLINE);
        let _ = o.withdraw_bond();
        assert_eq!(mt_transfer_sent().0["receiver_id"], "carol.near");
        assert_eq!(o.total_owed().0, 2 * BOND - carol);
    }

    #[test]
    fn the_collateral_id_must_be_the_exact_nep141_form() {
        let message = refusal(|| drop(oracle_on("usdc.near", BOND, 2)));
        assert_eq!(message, "the collateral token id must look like nep141:<token>");
        let message = refusal(|| drop(oracle_on("NEP141:usdc.near", BOND, 2)));
        assert_eq!(message, "the collateral token id must look like nep141:<token>");
    }

    #[test]
    fn config_names_the_verifier_and_the_exact_token_id_and_no_token_contract() {
        let o = fresh_oracle();
        let config = o.config();
        assert_eq!(config["verifier"], VERIFIER);
        assert_eq!(config["collateral_token_id"], COLLATERAL);
        assert!(config.get("bond_token").is_none());
    }
}
