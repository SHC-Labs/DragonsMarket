#![allow(dead_code)]
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub const USD: u128 = 1_000_000; // mock token has 6 decimals
pub const BOND: u128 = 5 * USD;
pub const WINDOW_MS: u64 = 60_000;
pub const PANEL_MS: u64 = 120_000;
pub const SEED: u128 = 100 * USD;
pub const JURY: u32 = 3;
pub const DRAW_DELAY_BLOCKS: u64 = 2;
pub const COOLDOWN_SECS: u64 = 60;
pub const CREATE_FEE: u128 = USD;

pub struct World {
    pub worker: Worker<Sandbox>,
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

fn wasm(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../target/near/{0}/{0}.wasm", name));
    std::fs::read(&p).unwrap_or_else(|e| panic!("run contracts/build.sh first ({p:?}): {e}"))
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
    let ft = worker.dev_deploy(&wasm("mock_ft")).await?;
    let market = worker.dev_deploy(&wasm("pm_market")).await?;
    let oracle = worker.dev_deploy(&wasm("pm_oracle")).await?;
    let council = worker.dev_deploy(&wasm("pm_council")).await?;
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

    ft.call("new").args_json(json!({ "owner_id": owner.id() })).transact().await?.into_result()?;
    market
        .call("new")
        .args_json(json!({
            "owner_id": owner_id, "operator_id": owner.id(), "oracle_id": oracle.id(), "collateral_token": ft.id(),
            "revenue_pool": council.id(), "business_wallet": business.id()
        }))
        .transact()
        .await?
        .into_result()?;
    nft.call("new").args_json(json!({ "owner_id": owner.id() })).transact().await?.into_result()?;
    council
        .call("new")
        .args_json(json!({ "owner_id": owner_id, "oracle_id": oracle.id(), "nft_contract": nft.id(), "collateral_token": ft.id() }))
        .transact()
        .await?
        .into_result()?;
    oracle
        .call("new")
        .args_json(json!({
            "owner_id": owner_id, "market_contract": market.id(), "bond_token": ft.id(),
            "bond": BOND.to_string(), "window_ms": window_ms.to_string(), "panel_deadline_ms": panel_ms.to_string(),
            "council": council.id(), "jury_size": JURY, "draw_delay_blocks": draw_delay_blocks.to_string()
        }))
        .transact()
        .await?
        .into_result()?;

    // The token needs to know these accounts before they can receive transfers.
    for c in [market.id(), oracle.id(), council.id(), business.id()] {
        owner
            .call(ft.id(), "storage_deposit")
            .args_json(json!({ "account_id": c, "registration_only": true }))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await?
            .into_result()?;
    }
    for who in [&owner, &alice, &bob] {
        who.call(market.id(), "storage_deposit").deposit(NearToken::from_millinear(50)).transact().await?.into_result()?;
    }
    for (who, amount) in [(&owner, 1000 * USD), (&alice, 200 * USD), (&bob, 200 * USD), (&carol, 50 * USD), (&dave, 50 * USD)] {
        owner
            .call(ft.id(), "mint")
            .args_json(json!({ "account_id": who.id(), "amount": amount.to_string() }))
            .transact()
            .await?
            .into_result()?;
    }
    let w = World { worker, ft, market, oracle, council, nft, owner, alice, bob, carol, dave, business, jurors };
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
    who.call(w.council.id(), "request_unstake").args_json(json!({ "token_id": token_id })).transact().await?.into_result()?;
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
        assert_eq!(event_names(&unstake(w, a, a.id().as_str()).await?), vec!["nft_transfer", "unstaked"]);
    }
    Ok(())
}

pub async fn nft_owner(w: &World, token_id: &str) -> String {
    let t: serde_json::Value = w.nft.view("nft_token").args_json(json!({ "token_id": token_id })).await.unwrap().json().unwrap();
    t["owner_id"].as_str().unwrap().to_string()
}

pub async fn stake_of(w: &World, token_id: &str) -> serde_json::Value {
    w.council.view("stake_of").args_json(json!({ "token_id": token_id })).await.unwrap().json().unwrap()
}

pub async fn is_seat(w: &World, who: &AccountId) -> bool {
    w.council.view("is_seat").args_json(json!({ "account_id": who })).await.unwrap().json().unwrap()
}

pub async fn ft_call(w: &World, from: &Account, to: &AccountId, amount: u128, msg: &str) -> anyhow::Result<()> {
    from.call(w.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": to, "amount": amount.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(200))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn ft_balance(w: &World, who: &AccountId) -> u128 {
    let s: String = w.ft.view("ft_balance_of").args_json(json!({ "account_id": who })).await.unwrap().json().unwrap();
    s.parse().unwrap()
}

pub async fn market_balance(w: &World, who: &AccountId) -> u128 {
    let s: String = w.market.view("get_balance").args_json(json!({ "account_id": who })).await.unwrap().json().unwrap();
    s.parse().unwrap()
}

pub async fn shares(w: &World, id: u64, who: &AccountId) -> (u128, u128) {
    let (y, n): (String, String) =
        w.market.view("get_shares").args_json(json!({ "market_id": id.to_string(), "account_id": who })).await.unwrap().json().unwrap();
    (y.parse().unwrap(), n.parse().unwrap())
}

pub async fn invariant(w: &World, id: u64) -> bool {
    w.market.view("check_invariant").args_json(json!({ "market_id": id.to_string() })).await.unwrap().json().unwrap()
}

pub async fn market_json(w: &World, id: u64) -> serde_json::Value {
    w.market.view("get_market").args_json(json!({ "market_id": id.to_string() })).await.unwrap().json().unwrap()
}

pub async fn case_json(w: &World, id: u64) -> serde_json::Value {
    w.oracle.view("get_case").args_json(json!({ "market_id": id.to_string() })).await.unwrap().json().unwrap()
}

// Creates market 0 closing in `close_in_secs`, waits for the oracle registration, and seeds it.
pub async fn create_seeded_market(w: &World, close_in_secs: u64) -> anyhow::Result<u64> {
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
            "resolve_by": (close_at + 3_600_000_000_000u64).to_string()
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    assert_eq!(market_json(w, id).await["registered"], true, "oracle registration callback should have landed");
    ft_call(w, &w.owner, w.market.id(), SEED, &format!("seed:{id}")).await?;
    Ok(id)
}

pub async fn buy(w: &World, who: &Account, id: u64, side: &str, amount: u128) -> anyhow::Result<()> {
    ft_call(w, who, w.market.id(), amount, &format!("buy:{id}:{side}:1")).await
}

pub async fn propose(w: &World, who: &Account, id: u64, outcome: &str) -> anyhow::Result<()> {
    ft_call(w, who, w.oracle.id(), BOND, &format!("propose:{id}:{outcome}:https://example.com/evidence?a=b")).await
}

pub async fn challenge(w: &World, who: &Account, id: u64) -> anyhow::Result<()> {
    ft_call(w, who, w.oracle.id(), BOND, &format!("challenge:{id}")).await
}

pub async fn claimable(w: &World, who: &AccountId) -> u128 {
    let s: String = w.oracle.view("claimable_of").args_json(json!({ "account_id": who })).await.unwrap().json().unwrap();
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
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap()["event"].as_str().unwrap().to_string())
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
    let known: Vec<&Account> = w.jurors.iter().chain([&w.owner, &w.alice, &w.bob, &w.carol, &w.dave]).collect();
    case_json(w, id).await["panel"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| (*known.iter().find(|a| a.id().as_str() == j.as_str().unwrap()).expect("a panel member we created")).clone())
        .collect()
}

pub async fn draw_jury(w: &World, id: u64) -> anyhow::Result<Vec<Account>> {
    wait_for_draw(w, id).await;
    let logs = resolve_draw(w, id).await?;
    assert_eq!(event_names(&logs), vec!["jury_drawn"]);
    Ok(panel(w, id).await)
}

pub fn commitment(juror: &AccountId, outcome: &str, salt: &str) -> String {
    Sha256::digest(format!("{juror}:{outcome}:{salt}")).iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn commit_vote(w: &World, juror: &Account, id: u64, commitment: &str) -> anyhow::Result<()> {
    juror
        .call(w.oracle.id(), "commit_vote")
        .args_json(json!({ "market_id": id.to_string(), "commitment": commitment }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn commit(w: &World, juror: &Account, id: u64, outcome: &str, salt: &str) -> anyhow::Result<()> {
    commit_vote(w, juror, id, &commitment(juror.id(), outcome, salt)).await
}

pub async fn reveal(w: &World, juror: &Account, id: u64, outcome: &str, salt: &str, reason: &str) -> anyhow::Result<()> {
    juror
        .call(w.oracle.id(), "reveal_vote")
        .args_json(json!({ "market_id": id.to_string(), "outcome": outcome, "salt": salt, "reason": reason }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
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
    w.oracle.call("finalize").args_json(json!({ "market_id": id.to_string() })).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
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

pub async fn sell(w: &World, who: &Account, id: u64, side: &str, collateral_out: u128, max_shares_in: u128) -> anyhow::Result<()> {
    who.call(w.market.id(), "sell")
        .args_json(json!({ "market_id": id.to_string(), "side": side, "collateral_out": collateral_out.to_string(),
                           "max_shares_in": max_shares_in.to_string() }))
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
    Ok(who.call(w.market.id(), "sweep_fees").gas(Gas::from_tgas(300)).transact().await?.into_result()?)
}

pub async fn pending_reward(w: &World, token_id: &str) -> u128 {
    let s: String = w.council.view("pending_reward").args_json(json!({ "token_id": token_id })).await.unwrap().json().unwrap();
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

pub const VOTING_SECS: u64 = 600;
pub const TIMELOCK_SECS: u64 = 120;
pub const THRESHOLD: u32 = 3;

pub struct Governance {
    pub contract: Contract,
    pub members: Vec<Account>,
}

// Five members, three yes votes to approve.
pub async fn deploy_governance(worker: &Worker<Sandbox>) -> anyhow::Result<Governance> {
    let contract = worker.dev_deploy(&wasm("pm_governance")).await?;
    let mut members = vec![];
    for _ in 0..5 {
        members.push(worker.dev_create_account().await?);
    }
    contract
        .call("new")
        .args_json(json!({
            "members": members.iter().map(|m| m.id()).collect::<Vec<_>>(), "threshold": THRESHOLD,
            "voting_period_ns": (VOTING_SECS * 1_000_000_000).to_string(),
            "timelock_ns": (TIMELOCK_SECS * 1_000_000_000).to_string()
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Governance { contract, members })
}

// Governance is deployed first and owns the market, the oracle and the council from the start.
pub async fn setup_governed() -> anyhow::Result<(World, Governance)> {
    let worker = near_workspaces::sandbox().await?;
    let g = deploy_governance(&worker).await?;
    let w = build(worker, WINDOW_MS, PANEL_MS, DRAW_DELAY_BLOCKS, Some(g.contract.id().clone())).await?;
    Ok((w, g))
}

pub fn function_call(receiver: &AccountId, method: &str, args: serde_json::Value, tgas: u64) -> serde_json::Value {
    use base64::Engine;
    json!({ "function_call": {
        "receiver_id": receiver, "method_name": method,
        "args": base64::engine::general_purpose::STANDARD.encode(args.to_string()),
        "deposit": "0", "gas": Gas::from_tgas(tgas).as_gas().to_string()
    } })
}

pub async fn gov_propose(g: &Governance, by: &Account, action: serde_json::Value) -> anyhow::Result<u64> {
    let id: String =
        by.call(g.contract.id(), "propose").args_json(json!({ "action": action })).transact().await?.into_result()?.json()?;
    Ok(id.parse()?)
}

pub async fn gov_vote(g: &Governance, by: &Account, id: u64, approve: bool) -> anyhow::Result<()> {
    by.call(g.contract.id(), "vote")
        .args_json(json!({ "proposal_id": id.to_string(), "approve": approve }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// Returns the logs of the whole call, the target call and the callback included.
pub async fn gov_execute(g: &Governance, by: &Account, id: u64) -> anyhow::Result<Vec<String>> {
    let r = by
        .call(g.contract.id(), "execute")
        .args_json(json!({ "proposal_id": id.to_string() }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

// Proposed by the first member and approved by the first THRESHOLD members. The timelock starts now.
pub async fn gov_pass(g: &Governance, action: serde_json::Value) -> anyhow::Result<u64> {
    let id = gov_propose(g, &g.members[0], action).await?;
    for m in &g.members[..THRESHOLD as usize] {
        gov_vote(g, m, id, true).await?;
    }
    assert_eq!(gov_proposal(g, id).await["stage"], "approved");
    Ok(id)
}

pub async fn gov_proposal(g: &Governance, id: u64) -> serde_json::Value {
    g.contract.view("get_proposal").args_json(json!({ "proposal_id": id.to_string() })).await.unwrap().json().unwrap()
}

pub async fn config(c: &Contract) -> serde_json::Value {
    c.view("config").await.unwrap().json().unwrap()
}
