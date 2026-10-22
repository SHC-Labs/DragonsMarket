#![allow(dead_code)]
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::str::FromStr;

pub const USD: u128 = 1_000_000; // mock token has 6 decimals
pub const BOND: u128 = 5 * USD;
pub const WINDOW_MS: u64 = 60_000;
pub const PANEL_MS: u64 = 120_000;
pub const DRAW_WINDOW_MS: u64 = 60_000;
pub const SEED: u128 = 100 * USD;
pub const JURY: u32 = 3;
pub const DRAW_DELAY_BLOCKS: u64 = 2;
// With the 60s window, two rounds of a 60s draw window and a 120s panel, and the oracle's 30s apply buffer, a market
// needs 510s between close and resolve_by.
pub const MIN_PROPOSAL_MS: u64 = 60_000;
pub const MIN_RESOLVE_GAP_SECS: u64 = 510;
pub const NETWORK: &str = "sandbox";
pub const PRICE_THRESHOLD: u32 = 2;
pub const MAX_SEATS_PER_ACCOUNT: u32 = 10;
pub const COOLDOWN_SECS: u64 = 60;
pub const CREATE_FEE: u128 = USD;

pub struct World {
    pub worker: Worker<Sandbox>,
    // The real NEAR Intents verifier. The market, the oracle and the council keep their money in their own accounts in it.
    pub verifier: Contract,
    pub ft: Contract,
    pub market: Contract,
    pub oracle: Contract,
    pub council: Contract,
    pub nft: Contract,
    pub owner: Account,
    pub alice: Account,
    pub bob: Account,
    pub carol: Account,
    pub dave: Account,
    // Receives 75% of the fees.
    pub business: Account,
    // Each holds one staked NFT whose token id is their account id. A case's panel is drawn from them.
    pub jurors: Vec<Account>,
}

pub fn wasm(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../target/near/{0}/{0}.wasm", name));
    std::fs::read(&p).unwrap_or_else(|e| panic!("run contracts/build.sh first ({p:?}): {e}"))
}

// The verifier is built outside the repository from the pinned source (contracts/INTENTS-PROOF.md). A missing file fails the
// test with the recipe: a silent skip would hide every test that needs it. CI must build it before it runs the sandbox tests.
pub const VERIFIER_RECIPE: &str =
    "the NEAR Intents verifier wasm is missing. These tests need the real contract, so CI must build it \
before running them. Build it with:\n\
  SCRATCH=$(mktemp -d)\n\
  git clone https://github.com/near/intents $SCRATCH/intents-src\n\
  git -C $SCRATCH/intents-src checkout 16d04f6ec4401263f8914638710260da50bb46b0\n\
  cd $SCRATCH/intents-src/contracts/defuse\n\
  cargo near build reproducible-wasm --out-dir $SCRATCH/intents-repro   (needs docker and cargo-near 0.22.0)\n\
  mkdir -p contracts/target/intents && cp $SCRATCH/intents-repro/defuse.wasm contracts/target/intents/defuse.wasm\n\
The sha256 must be a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547 (the code hash of intents.near). \
Details are in contracts/INTENTS-PROOF.md.";

pub fn verifier_wasm() -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/intents/defuse.wasm");
    std::fs::read(&p).unwrap_or_else(|e| panic!("{VERIFIER_RECIPE}\n(looked at {p:?}: {e})"))
}

// The id of the collateral inside the verifier.
pub fn token_id(w: &World) -> String {
    format!("nep141:{}", w.ft.id())
}

pub async fn now(worker: &Worker<Sandbox>) -> u64 {
    worker.view_block().await.unwrap().timestamp()
}

// Moves chain time forward by about this many seconds (a block is about 0.3 s in the sandbox).
pub async fn skip_secs(worker: &Worker<Sandbox>, secs: u64) {
    worker.fast_forward(secs * 1000 / 300 + 5).await.unwrap();
}

pub async fn setup() -> anyhow::Result<World> {
    setup_with(WINDOW_MS, PANEL_MS, DRAW_DELAY_BLOCKS).await
}

pub async fn setup_with(window_ms: u64, panel_ms: u64, draw_delay_blocks: u64) -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    build(worker, window_ms, panel_ms, draw_delay_blocks, None).await
}

// The market, the oracle and the council are owned by `owner_id` when given, by w.owner otherwise.
async fn build(
    worker: Worker<Sandbox>,
    window_ms: u64,
    panel_ms: u64,
    draw_delay_blocks: u64,
    owner_id: Option<AccountId>,
) -> anyhow::Result<World> {
    let verifier = worker.dev_deploy(&verifier_wasm()).await?;
    let ft = worker.dev_deploy(&wasm("mock_ft")).await?;
    let market = worker.dev_deploy(&wasm("market")).await?;
    let oracle = worker.dev_deploy(&wasm("oracle")).await?;
    let council = worker.dev_deploy(&wasm("council")).await?;
    let nft = worker.dev_deploy(&wasm("mock_nft")).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dave = worker.dev_create_account().await?;
    let business = worker.dev_create_account().await?;
    let mut jurors = vec![];
    for _ in 0..5 {
        jurors.push(worker.dev_create_account().await?);
    }
    let owner_id = owner_id.unwrap_or_else(|| owner.id().clone());

    verifier
        .call("new")
        .args_json(json!({ "config": {
            "wnear_id": "wrap.near",
            "fees": { "fee": 0, "fee_collector": owner.id() },
            "roles": {
                "super_admins": [owner.id()],
                "grantees": { "DAO": [owner.id()], "UnrestrictedAccountLocker": [owner.id()], "UnrestrictedAccountUnlocker": [owner.id()] }
            }
        }}))
        .transact()
        .await?
        .into_result()?;
    ft.call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    let collateral_token_id = format!("nep141:{}", ft.id());
    market
        .call("new")
        .args_json(json!({
            "owner_id": owner_id, "operator_id": owner.id(), "oracle_id": oracle.id(), "verifier_id": verifier.id(),
            "collateral_token_id": collateral_token_id, "revenue_pool": council.id(), "business_wallet": business.id()
        }))
        .transact()
        .await?
        .into_result()?;
    nft.call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    council
        .call("new")
        .args_json(json!({
            "owner_id": owner_id, "oracle_id": oracle.id(), "nft_contract": nft.id(), "verifier_id": verifier.id(),
            "collateral_token_id": collateral_token_id, "cooldown_ns": (COOLDOWN_SECS * 1_000_000_000).to_string(), "max_seats_per_account": MAX_SEATS_PER_ACCOUNT,
            "allowlist_enabled": false
        }))
        .transact()
        .await?
        .into_result()?;
    oracle
        .call("new")
        .args_json(json!({
            "owner_id": owner_id, "market_contract": market.id(), "verifier_id": verifier.id(),
            "collateral_token_id": collateral_token_id, "bond": BOND.to_string(), "window_ms": window_ms.to_string(), "panel_deadline_ms": panel_ms.to_string(),
            "draw_window_ms": DRAW_WINDOW_MS.to_string(), "council": council.id(), "jury_size": JURY, "draw_delay_blocks": draw_delay_blocks.to_string(),
            "min_proposal_ms": MIN_PROPOSAL_MS.to_string(), "operator_id": owner.id(), "network": NETWORK,
            "price_threshold": PRICE_THRESHOLD, "no_decision_recipient": business.id()
        }))
        .transact()
        .await?
        .into_result()?;

    // The token needs to know these accounts before they can receive transfers. The market, the oracle and the council are not
    // among them: the verifier holds their money, and none is ever sent the token itself.
    for c in [verifier.id(), business.id()] {
        owner
            .call(ft.id(), "storage_deposit")
            .args_json(json!({ "account_id": c, "registration_only": true }))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await?
            .into_result()?;
    }
    for who in [&owner, &alice, &bob] {
        who.call(market.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(50))
            .transact()
            .await?
            .into_result()?;
    }
    for (who, amount) in [
        (&owner, 1000 * USD),
        (&alice, 200 * USD),
        (&bob, 200 * USD),
        (&carol, 50 * USD),
        (&dave, 50 * USD),
    ] {
        owner
            .call(ft.id(), "mint")
            .args_json(json!({ "account_id": who.id(), "amount": amount.to_string() }))
            .transact()
            .await?
            .into_result()?;
    }
    let w = World {
        worker,
        verifier,
        ft,
        market,
        oracle,
        council,
        nft,
        owner,
        alice,
        bob,
        carol,
        dave,
        business,
        jurors,
    };
    for j in &w.jurors {
        mint_nft(&w, j, j.id().as_str()).await?;
        stake(&w, j, j.id().as_str()).await?;
    }
    Ok(w)
}

pub async fn mint_nft(w: &World, to: &Account, token_id: &str) -> anyhow::Result<()> {
    w.owner
        .call(w.nft.id(), "nft_mint")
        .args_json(json!({ "token_id": token_id, "receiver_id": to.id() }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// `who` sends the token to the Council. A refused stake does not fail the call: the token just comes back.
pub async fn stake(w: &World, who: &Account, token_id: &str) -> anyhow::Result<()> {
    let r = who
        .call(w.nft.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": w.council.id(), "token_id": token_id, "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    if !r.json::<bool>()? {
        anyhow::bail!("the Council sent the token back: {:?}", r.receipt_failures());
    }
    Ok(())
}

pub async fn request_unstake(w: &World, who: &Account, token_id: &str) -> anyhow::Result<()> {
    who.call(w.council.id(), "request_unstake")
        .args_json(json!({ "token_id": token_id }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// Returns the logs of the whole call, the transfer and the callback included.
pub async fn unstake(w: &World, who: &Account, token_id: &str) -> anyhow::Result<Vec<String>> {
    let r = who
        .call(w.council.id(), "unstake")
        .args_json(json!({ "token_id": token_id }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

// Each account takes back the token named after it, after one shared cooldown.
pub async fn leave(w: &World, who: &[&Account]) -> anyhow::Result<()> {
    for a in who {
        request_unstake(w, a, a.id().as_str()).await?;
    }
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    for a in who {
        assert_eq!(
            event_names(&unstake(w, a, a.id().as_str()).await?),
            vec!["nft_transfer", "unstaked"]
        );
    }
    Ok(())
}

pub async fn nft_owner(w: &World, token_id: &str) -> String {
    let t: serde_json::Value = w
        .nft
        .view("nft_token")
        .args_json(json!({ "token_id": token_id }))
        .await
        .unwrap()
        .json()
        .unwrap();
    t["owner_id"].as_str().unwrap().to_string()
}

pub async fn stake_of(w: &World, token_id: &str) -> serde_json::Value {
    w.council
        .view("stake_of")
        .args_json(json!({ "token_id": token_id }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

pub async fn is_seat(w: &World, who: &AccountId) -> bool {
    w.council
        .view("is_seat")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

// Sends `amount` of the token to a contract with a message. The market, the oracle and the council take it through the
// verifier: the token goes into the sender's own Intents account first, then an mt_transfer_call moves it to the contract, so a
// refusal puts it back in the sender's Intents account.
pub async fn ft_call(w: &World, from: &Account, to: &AccountId, amount: u128, msg: &str) -> anyhow::Result<()> {
    deposit_to_intents(w, from, from.id(), amount).await?;
    intents_call(w, from, to, amount, msg).await?.into_result()?;
    Ok(())
}

// Moves tokens from `from`'s NEP-141 balance into `to`'s Intents account.
pub async fn deposit_to_intents(w: &World, from: &Account, to: &AccountId, amount: u128) -> anyhow::Result<()> {
    from.call(w.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": w.verifier.id(), "amount": amount.to_string(), "msg": to }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(200))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// The user's mt_transfer_call of collateral from their Intents account to a contract. The result is not unwrapped, so a test
// can look at refusals.
pub async fn intents_call(
    w: &World,
    from: &Account,
    to: &AccountId,
    amount: u128,
    msg: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(from
        .call(w.verifier.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": to, "token_id": token_id(w), "amount": amount.to_string(), "msg": msg
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
}

// What the verifier holds for an account.
pub async fn intents_balance(w: &World, who: &AccountId) -> u128 {
    let s: String = w
        .verifier
        .view("mt_balance_of")
        .args_json(json!({ "account_id": who, "token_id": token_id(w) }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

// The verifier's emergency powers, held by w.owner in these tests. A paused feature stops every transfer, and a locked account
// cannot send anything while it can still receive.
async fn verifier_admin(w: &World, method: &str, args: serde_json::Value) -> anyhow::Result<()> {
    let yocto = if method.starts_with("force_") { 1 } else { 0 };
    w.owner
        .call(w.verifier.id(), method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(yocto))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn lock_account(w: &World, who: &AccountId) -> anyhow::Result<()> {
    verifier_admin(w, "force_lock_account", json!({ "account_id": who })).await
}

pub async fn unlock_account(w: &World, who: &AccountId) -> anyhow::Result<()> {
    verifier_admin(w, "force_unlock_account", json!({ "account_id": who })).await
}

pub async fn pause_transfers(w: &World) -> anyhow::Result<()> {
    verifier_admin(w, "pa_pause_feature", json!({ "key": "mt_transfer" })).await
}

pub async fn unpause_transfers(w: &World) -> anyhow::Result<()> {
    verifier_admin(w, "pa_unpause_feature", json!({ "key": "mt_transfer" })).await
}

// All the collateral an account has outside the market, the oracle and the council: its tokens plus its Intents balance. Every
// payout from the three lands in the Intents balance, and what a test starts with is tokens, so a test that follows one
// person's money across both reads this.
pub async fn holdings(w: &World, who: &AccountId) -> u128 {
    ft_balance(w, who).await + intents_balance(w, who).await
}

// The market's books must match what the verifier holds for it. Only valid while nothing is in flight.
pub async fn assert_reconciled(w: &World) {
    let owed: String = w.market.view("total_owed").await.unwrap().json().unwrap();
    assert_eq!(
        u128::from_str(&owed).unwrap(),
        intents_balance(w, w.market.id()).await,
        "the market's total_owed differs from its balance in the verifier"
    );
}

// The oracle's books must match what the verifier holds for it. Only valid while no payout is in flight.
pub async fn assert_oracle_reconciled(w: &World) {
    assert_eq!(
        oracle_total_owed(w).await,
        intents_balance(w, w.oracle.id()).await,
        "the oracle's total_owed differs from its balance in the verifier"
    );
}

pub async fn oracle_total_owed(w: &World) -> u128 {
    let owed: String = w.oracle.view("total_owed").await.unwrap().json().unwrap();
    u128::from_str(&owed).unwrap()
}

pub async fn ft_balance(w: &World, who: &AccountId) -> u128 {
    let s: String =
        w.ft.view("ft_balance_of")
            .args_json(json!({ "account_id": who }))
            .await
            .unwrap()
            .json()
            .unwrap();
    s.parse().unwrap()
}

pub async fn market_balance(w: &World, who: &AccountId) -> u128 {
    let s: String = w
        .market
        .view("get_balance")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

pub async fn shares(w: &World, id: u64, who: &AccountId) -> (u128, u128) {
    let (y, n): (String, String) = w
        .market
        .view("get_shares")
        .args_json(json!({ "market_id": id.to_string(), "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap();
    (y.parse().unwrap(), n.parse().unwrap())
}

pub async fn invariant(w: &World, id: u64) -> bool {
    w.market
        .view("check_invariant")
        .args_json(json!({ "market_id": id.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

pub async fn market_json(w: &World, id: u64) -> serde_json::Value {
    w.market
        .view("get_market")
        .args_json(json!({ "market_id": id.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

pub async fn case_json(w: &World, id: u64) -> serde_json::Value {
    w.oracle
        .view("get_case")
        .args_json(json!({ "market_id": id.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

// Creates market 0 closing in `close_in_secs`, waits for the oracle registration, and seeds it. It must be answered
// within an hour after it closes.
pub async fn create_seeded_market(w: &World, close_in_secs: u64) -> anyhow::Result<u64> {
    create_seeded_market_gap(w, close_in_secs, 3_600).await
}

// Like create_seeded_market, with resolve_by `gap_secs` after the close.
pub async fn create_seeded_market_gap(w: &World, close_in_secs: u64, gap_secs: u64) -> anyhow::Result<u64> {
    let id = create_market(w, close_in_secs, gap_secs).await?;
    ft_call(w, &w.owner, w.market.id(), SEED, &format!("seed:{id}")).await?;
    Ok(id)
}

// Creates a market closing in `close_in_secs` and waits for the oracle registration. It is not seeded.
pub async fn create_market(w: &World, close_in_secs: u64, gap_secs: u64) -> anyhow::Result<u64> {
    let t = now(&w.worker).await;
    let close_at = t + close_in_secs * 1_000_000_000;
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .args_json(json!({
            "title": "Will the test question resolve Yes?",
            "rule_text": "Resolves Yes if the test says so.",
            "resolution_source": "https://example.com/source",
            "void_policy": "Void if the test is cancelled.",
            "category": "world",
            "subcategory": "science",
            "close_at": close_at.to_string(),
            "resolve_by": (close_at + gap_secs * 1_000_000_000).to_string()
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    assert_eq!(
        market_json(w, id).await["registered"],
        true,
        "oracle registration callback should have landed"
    );
    Ok(id)
}

pub async fn buy(w: &World, who: &Account, id: u64, side: &str, amount: u128) -> anyhow::Result<()> {
    ft_call(w, who, w.market.id(), amount, &format!("buy:{id}:{side}:1")).await
}

pub async fn propose(w: &World, who: &Account, id: u64, outcome: &str) -> anyhow::Result<()> {
    ft_call(
        w,
        who,
        w.oracle.id(),
        BOND,
        &format!("propose:{id}:{outcome}:https://example.com/evidence?a=b"),
    )
    .await
}

// Challenges naming the other one of Yes and No than the proposal.
pub async fn challenge(w: &World, who: &Account, id: u64) -> anyhow::Result<()> {
    let answer = if case_json(w, id).await["proposed"] == "yes" {
        "no"
    } else {
        "yes"
    };
    challenge_with(w, who, id, answer).await
}

pub async fn challenge_with(w: &World, who: &Account, id: u64, answer: &str) -> anyhow::Result<()> {
    ft_call(w, who, w.oracle.id(), BOND, &format!("challenge:{id}:{answer}")).await
}

// Returns the logs of the whole call, the verifier's payout and the callback included.
pub async fn withdraw_bond(w: &World, who: &Account) -> anyhow::Result<Vec<String>> {
    let r = who
        .call(w.oracle.id(), "withdraw_bond")
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

pub async fn claimable(w: &World, who: &AccountId) -> u128 {
    let s: String = w
        .oracle
        .view("claimable_of")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

// Asserts the call failed with the contract's own message, not for some other reason.
pub fn refused<T: std::fmt::Debug, E: std::fmt::Debug>(r: Result<T, E>, why: &str) {
    match r {
        Ok(v) => panic!("expected a refusal ({why}), got {v:?}"),
        Err(e) => assert!(format!("{e:?}").contains(why), "expected a refusal ({why}), got {e:?}"),
    }
}

pub fn event_names(logs: &[String]) -> Vec<String> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| {
            serde_json::from_str::<serde_json::Value>(j).unwrap()["event"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

fn case_u64(case: &serde_json::Value, field: &str) -> u64 {
    case[field].as_str().unwrap().parse().unwrap()
}

// Moves the chain past the case's draw delay.
pub async fn wait_for_draw(w: &World, id: u64) {
    let after = case_u64(&case_json(w, id).await, "draw_after_height");
    let height = w.worker.view_block().await.unwrap().height();
    if height < after {
        w.worker.fast_forward(after - height).await.unwrap();
    }
}

// Returns the logs of the whole call, the council's draw and the callback included.
pub async fn resolve_draw(w: &World, id: u64) -> anyhow::Result<Vec<String>> {
    let r = w
        .bob
        .call(w.oracle.id(), "resolve_draw")
        .args_json(json!({ "market_id": id.to_string() }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

pub async fn panel(w: &World, id: u64) -> Vec<Account> {
    let known: Vec<&Account> = w
        .jurors
        .iter()
        .chain([&w.owner, &w.alice, &w.bob, &w.carol, &w.dave])
        .collect();
    case_json(w, id).await["panel"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| {
            (*known
                .iter()
                .find(|a| a.id().as_str() == j.as_str().unwrap())
                .expect("a panel member we created"))
            .clone()
        })
        .collect()
}

pub async fn draw_jury(w: &World, id: u64) -> anyhow::Result<Vec<Account>> {
    wait_for_draw(w, id).await;
    let logs = resolve_draw(w, id).await?;
    assert_eq!(event_names(&logs), vec!["jury_drawn"]);
    Ok(panel(w, id).await)
}

pub fn commitment(juror: &AccountId, outcome: &str, salt: &str) -> String {
    Sha256::digest(format!("{juror}:{outcome}:{salt}"))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub async fn commit_vote(w: &World, juror: &Account, id: u64, commitment: &str) -> anyhow::Result<()> {
    juror
        .call(w.oracle.id(), "commit_vote")
        .args_json(json!({ "market_id": id.to_string(), "commitment": commitment }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn commit(w: &World, juror: &Account, id: u64, outcome: &str, salt: &str) -> anyhow::Result<()> {
    commit_vote(w, juror, id, &commitment(juror.id(), outcome, salt)).await
}

pub async fn reveal(
    w: &World,
    juror: &Account,
    id: u64,
    outcome: &str,
    salt: &str,
    reason: &str,
) -> anyhow::Result<()> {
    reveal_logs(w, juror, id, outcome, salt, reason).await?;
    Ok(())
}

// Returns the logs of the whole call, the settlement and the release of the jury included.
pub async fn reveal_logs(
    w: &World,
    juror: &Account,
    id: u64,
    outcome: &str,
    salt: &str,
    reason: &str,
) -> anyhow::Result<Vec<String>> {
    let r = juror
        .call(w.oracle.id(), "reveal_vote")
        .args_json(json!({ "market_id": id.to_string(), "outcome": outcome, "salt": salt, "reason": reason }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

// The data of each event with this name in `logs`.
pub fn events_named(logs: &[String], name: &str) -> Vec<serde_json::Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap())
        .filter(|e| e["event"] == name)
        .map(|e| e["data"].clone())
        .collect()
}

// What a claim or an unstake paid, from its revenue_claimed event.
pub fn claimed_in(logs: &[String]) -> u128 {
    events_named(logs, "revenue_claimed")
        .iter()
        .map(|e| u(&e["amount"]))
        .sum()
}

pub async fn mint(w: &World, to: &AccountId, amount: u128) -> anyhow::Result<()> {
    w.owner
        .call(w.ft.id(), "mint")
        .args_json(json!({ "account_id": to, "amount": amount.to_string() }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// Revenue for the council's seats: the owner sends it.
pub async fn send_revenue(w: &World, amount: u128) -> anyhow::Result<()> {
    ft_call(w, &w.owner, w.council.id(), amount, "revenue").await
}

// Revenue the council has not yet released to its seats, in token units.
pub async fn stream_remaining(w: &World) -> u128 {
    u(&config(&w.council).await["stream_remaining"])
}

pub async fn skip_until(w: &World, t_ns: u64) {
    loop {
        let t = now(&w.worker).await;
        if t >= t_ns {
            return;
        }
        skip_secs(&w.worker, (t_ns - t) / 1_000_000_000 + 1).await;
    }
}

// Moves chain time to the end of the commit phase, where reveals open.
pub async fn to_reveal_phase(w: &World, id: u64) {
    skip_until(w, case_u64(&case_json(w, id).await, "commit_ends_at")).await;
}

pub async fn finalize(w: &World, id: u64) -> anyhow::Result<()> {
    w.oracle
        .call("finalize")
        .args_json(json!({ "market_id": id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub fn u(v: &serde_json::Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

// (shares out, fee) for a buy of `amount`.
pub async fn quote_buy(w: &World, id: u64, side: &str, amount: u128) -> (u128, u128) {
    let q: serde_json::Value = w
        .market
        .view("quote_buy")
        .args_json(json!({ "market_id": id.to_string(), "side": side, "amount": amount.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap();
    (u(&q["shares_out"]), u(&q["fee"]))
}

// (collateral out, shares in, fee) for selling up to `shares`.
pub async fn quote_sell(w: &World, id: u64, side: &str, shares: u128) -> (u128, u128, u128) {
    let q: serde_json::Value = w
        .market
        .view("quote_sell")
        .args_json(json!({ "market_id": id.to_string(), "side": side, "shares": shares.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap();
    (u(&q["collateral_out"]), u(&q["shares_in"]), u(&q["fee"]))
}

pub async fn sell(
    w: &World,
    who: &Account,
    id: u64,
    side: &str,
    collateral_out: u128,
    max_shares_in: u128,
) -> anyhow::Result<()> {
    who.call(w.market.id(), "sell")
        .args_json(
            json!({ "market_id": id.to_string(), "side": side, "collateral_out": collateral_out.to_string(),
                           "max_shares_in": max_shares_in.to_string() }),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// (collected, revenue due, business due) in the market.
pub async fn fees(w: &World) -> (u128, u128, u128) {
    let f: serde_json::Value = w.market.view("get_fees").await.unwrap().json().unwrap();
    (u(&f["collected"]), u(&f["revenue_due"]), u(&f["business_due"]))
}

pub async fn sweep(w: &World, who: &Account) -> anyhow::Result<near_workspaces::result::ExecutionSuccess> {
    Ok(who
        .call(w.market.id(), "sweep_fees")
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?)
}

pub async fn pending_reward(w: &World, token_id: &str) -> u128 {
    let s: String = w
        .council
        .view("pending_reward")
        .args_json(json!({ "token_id": token_id }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

// Returns the logs of the whole call, the transfer and the callback included.
pub async fn claim(w: &World, who: &Account, token_id: &str) -> anyhow::Result<Vec<String>> {
    let r = who
        .call(w.council.id(), "claim")
        .args_json(json!({ "token_id": token_id }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

// Lets `who` receive the collateral token.
pub async fn register_ft(w: &World, who: &AccountId) -> anyhow::Result<()> {
    w.owner
        .call(w.ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// Application owner fixture only. This does not simulate Trezu voting or its execution delay.
// Real Sputnik proposal/callback integration must be tested against the selected deployment separately.
pub async fn setup_admin_owned() -> anyhow::Result<(World, Account)> {
    let worker = near_workspaces::sandbox().await?;
    let admin = worker.dev_create_account().await?;
    let w = build(worker, WINDOW_MS, PANEL_MS, DRAW_DELAY_BLOCKS, Some(admin.id().clone())).await?;
    Ok((w, admin))
}

pub fn function_call(receiver: &AccountId, method: &str, args: serde_json::Value, tgas: u64) -> serde_json::Value {
    use base64::Engine;
    json!({ "function_call": {
        "receiver_id": receiver, "method_name": method,
        "args": base64::engine::general_purpose::STANDARD.encode(args.to_string()),
        "deposit": "0", "gas": Gas::from_tgas(tgas).as_gas().to_string()
    } })
}

pub async fn config(c: &Contract) -> serde_json::Value {
    c.view("config").await.unwrap().json().unwrap()
}

// borsh of a String: a u32 length, then the bytes.
pub fn borsh_string(s: &str) -> Vec<u8> {
    let mut v = (s.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(s.as_bytes());
    v
}

// Puts a seat back in the state a failed unlock_case would have left it in: marked as serving `case`, and the case's
// jury list still holding it. Storage keys are the enum prefix (Stakes = 1, Juries = 3) then the borsh key.
pub async fn relock_seat(w: &World, token_id: &str, case: u64) -> anyhow::Result<()> {
    let state = w.worker.view_state(w.council.id()).await?;
    let stake_key = [vec![1u8], borsh_string(token_id)].concat();
    let old = state
        .get(&stake_key)
        .expect("the staked seat is stored under the key this test expects")
        .clone();
    // Stake = owner: String, staked_at: u64, unlock_requested_at: Option<u64>, serving: Option<u64>, index: u32, reward_debt: u128
    let owner_len = u32::from_le_bytes(old[..4].try_into()?) as usize;
    let mut at = 4 + owner_len + 8;
    let mut new = old[..at].to_vec();
    assert_eq!(old[at], 0, "the seat has not asked to unstake");
    new.push(0);
    at += 1;
    assert_eq!(old[at], 0, "the first unlock freed the seat");
    new.push(1);
    new.extend_from_slice(&case.to_le_bytes());
    new.extend_from_slice(&old[at + 1..]);
    w.worker.patch_state(w.council.id(), &stake_key, &new).await?;
    let jury_key = [vec![3u8], case.to_le_bytes().to_vec()].concat();
    let jury = [1u32.to_le_bytes().to_vec(), borsh_string(token_id)].concat();
    w.worker.patch_state(w.council.id(), &jury_key, &jury).await?;
    Ok(())
}
