// Phase 3 hardening: who may initialise, NEP-145 storage, the council allowlist, an unresolved fee transfer, gas floors
// and signed prices on the record. Real contracts, sandbox chain.
mod common;
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

// A deploy with no init in the same batch leaves the contract open until someone calls new. Only the contract's own
// account may, so a stranger cannot take it, whoever deployed it and whatever they pass.
#[tokio::test]
async fn only_the_contract_account_can_initialise_each_contract() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let stranger = worker.dev_create_account().await?;
    let other = stranger.id().clone();
    let day = (24 * 3600 * 1_000_000_000u64).to_string();
    let contracts = [
        (
            "market",
            json!({ "owner_id": other, "operator_id": other, "oracle_id": other, "verifier_id": other,
                    "collateral_token_id": "nep141:token.test.near" }),
        ),
        (
            "oracle",
            json!({ "owner_id": other, "market_contract": other, "verifier_id": other, "collateral_token_id": "nep141:token.test.near",
                    "bond": "1", "window_ms": "1000", "panel_deadline_ms": "1000", "draw_window_ms": "1000", "council": other, "jury_size": 3,
                    "draw_delay_blocks": "1", "min_proposal_ms": "1000", "operator_id": other, "network": NETWORK,
                    "price_threshold": 1, "no_decision_recipient": other }),
        ),
        (
            "council",
            json!({ "owner_id": other, "oracle_id": other, "verifier_id": other,
                    "collateral_token_id": "nep141:token.test.near", "cooldown_ns": day, "max_seats_per_account": 1 }),
        ),
    ];
    for (name, args) in contracts {
        let contract = worker.dev_deploy(&wasm(name)).await?;
        let refused_call = stranger.call(contract.id(), "new").args_json(&args).transact().await?;
        refused(refused_call.into_result(), "Method new is private");
        let uninitialised = contract.view("config").await;
        refused(uninitialised, "not initialized");

        contract.call("new").args_json(&args).transact().await?.into_result()?;
        let config: serde_json::Value = contract.view("config").await?.json()?;
        let version = match name {
            "market" => 7,
            "oracle" => 2,
            _ => 4,
        };
        assert_eq!(
            config["state_version"], version,
            "{name} initialised by its own account"
        );
        let again = contract.call("new").args_json(&args).transact().await?;
        refused(again.into_result(), "has already been initialized");
    }
    Ok(())
}

// ---- NEP-145 storage management on market ------------------------------------------------------------------

async fn native_balance(account: &near_workspaces::Account) -> u128 {
    account.view_account().await.unwrap().balance.as_yoctonear()
}

const FLAT_DEPOSIT: u128 = 50_000_000_000_000_000_000_000;

async fn is_registered(w: &World, who: &near_workspaces::AccountId) -> bool {
    w.market
        .view("is_registered")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

#[tokio::test]
async fn a_user_registers_alone_or_is_registered_by_someone_else_and_leaves_with_the_deposit() -> anyhow::Result<()> {
    let w = setup().await?;

    let bounds: serde_json::Value = w.market.view("storage_balance_bounds").await?.json()?;
    assert_eq!(
        bounds,
        json!({ "min": FLAT_DEPOSIT.to_string(), "max": FLAT_DEPOSIT.to_string() })
    );
    let unknown: serde_json::Value = w
        .market
        .view("storage_balance_of")
        .args_json(json!({ "account_id": w.carol.id() }))
        .await?
        .json()?;
    assert!(unknown.is_null(), "carol has not registered");

    // Carol pays for herself and overpays: the surplus comes back to her.
    let before = native_balance(&w.carol).await;
    let registered: serde_json::Value = w
        .carol
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(200))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(
        registered,
        json!({ "total": FLAT_DEPOSIT.to_string(), "available": "0" })
    );
    let spent = before - native_balance(&w.carol).await;
    assert!(
        (FLAT_DEPOSIT..FLAT_DEPOSIT + 10_000_000_000_000_000_000_000).contains(&spent),
        "carol paid the deposit and gas only: {spent}"
    );
    let balance: serde_json::Value = w
        .market
        .view("storage_balance_of")
        .args_json(json!({ "account_id": w.carol.id() }))
        .await?
        .json()?;
    assert_eq!(balance, registered);

    // Owner registers dave and pays for it, dave pays nothing.
    let owner_before = native_balance(&w.owner).await;
    let dave_before = native_balance(&w.dave).await;
    w.owner
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({ "account_id": w.dave.id(), "registration_only": true }))
        .deposit(NearToken::from_millinear(80))
        .transact()
        .await?
        .into_result()?;
    assert!(is_registered(&w, w.dave.id()).await);
    let owner_spent = owner_before - native_balance(&w.owner).await;
    assert!(
        (FLAT_DEPOSIT..FLAT_DEPOSIT + 10_000_000_000_000_000_000_000).contains(&owner_spent),
        "the payer bore the deposit: {owner_spent}"
    );
    assert_eq!(
        native_balance(&w.dave).await,
        dave_before,
        "the registered account paid nothing"
    );

    // A deposit short of the minimum registers nobody.
    refused(
        w.jurors[0]
            .call(w.market.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result(),
        "attach at least 0.05 NEAR",
    );
    assert!(!is_registered(&w, w.jurors[0].id()).await);

    // Holding a balance or a position keeps the account registered, and force does not get around it.
    ft_call(&w, &w.carol, w.market.id(), 10 * USD, "deposit").await?;
    let unregister = |who: &near_workspaces::Account, args: serde_json::Value| {
        who.call(w.market.id(), "storage_unregister")
            .args_json(args)
            .deposit(NearToken::from_yoctonear(1))
            .transact()
    };
    refused(
        unregister(&w.carol, json!({})).await?.into_result(),
        "withdraw your balance first",
    );
    refused(
        unregister(&w.carol, json!({ "force": true })).await?.into_result(),
        "force is not supported",
    );
    let id = new_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    refused(
        unregister(&w.alice, json!({})).await?.into_result(),
        "redeem or sell your positions first",
    );
    refused(
        w.carol
            .call(w.market.id(), "storage_unregister")
            .args_json(json!({}))
            .transact()
            .await?
            .into_result(),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    refused(
        w.carol
            .call(w.market.id(), "storage_withdraw")
            .args_json(json!({ "amount": "1" }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result(),
        "nothing above the 0.05 NEAR deposit to withdraw",
    );

    // After withdrawing everything carol leaves and gets the deposit back.
    let balance = market_balance(&w, w.carol.id()).await;
    w.carol
        .call(w.market.id(), "withdraw")
        .args_json(json!({ "amount": balance.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let before = native_balance(&w.carol).await;
    let left: bool = unregister(&w.carol, json!({})).await?.into_result()?.json()?;
    assert!(left && !is_registered(&w, w.carol.id()).await);
    let gained = native_balance(&w.carol).await as i128 - before as i128;
    assert!(
        gained > FLAT_DEPOSIT as i128 - 10_000_000_000_000_000_000_000,
        "the deposit came back: {gained}"
    );
    let again: bool = unregister(&w.carol, json!({})).await?.into_result()?.json()?;
    assert!(!again, "an account that is not registered gets false, not a panic");

    // Unregistered, she cannot deposit until she registers again: the token comes back.
    let tokens = holdings(&w, w.carol.id()).await;
    ft_call(&w, &w.carol, w.market.id(), 5 * USD, "deposit").await?;
    assert_eq!(
        (holdings(&w, w.carol.id()).await, market_balance(&w, w.carol.id()).await),
        (tokens, 0)
    );
    Ok(())
}

#[tokio::test]
async fn a_sponsor_gets_the_deposit_back_when_the_account_it_registered_leaves() -> anyhow::Result<()> {
    let w = setup().await?;
    w.owner
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({ "account_id": w.dave.id() }))
        .deposit(NearToken::from_yoctonear(FLAT_DEPOSIT))
        .transact()
        .await?
        .into_result()?;
    assert!(is_registered(&w, w.dave.id()).await);
    w.worker.fast_forward(3).await?;

    let owner_before = native_balance(&w.owner).await;
    let dave_before = native_balance(&w.dave).await;
    let left = w
        .dave
        .call(w.market.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let unregistered = &events_named(
        &left.logs().iter().map(|l| l.to_string()).collect::<Vec<_>>(),
        "unregistered",
    )[0];
    assert_eq!(unregistered["deposit_to"], json!(w.owner.id()));
    assert!(left.json::<bool>()? && !is_registered(&w, w.dave.id()).await);
    assert_eq!(
        native_balance(&w.owner).await - owner_before,
        FLAT_DEPOSIT,
        "the sponsor gets its deposit back"
    );
    let dave_after = native_balance(&w.dave).await;
    assert!(
        dave_after < dave_before && dave_before - dave_after < 10_000_000_000_000_000_000_000,
        "the account that leaves pays its gas and keeps nobody's deposit: {dave_before} to {dave_after}"
    );
    Ok(())
}

// ---- the council allowlist ------------------------------------------------------------------------------------

// Sends the token to the council and says whether the council kept it. A refused stake comes back to its owner.
async fn try_stake(
    nft: &near_workspaces::Contract,
    council: &near_workspaces::AccountId,
    who: &near_workspaces::Account,
    token_id: &str,
) -> anyhow::Result<bool> {
    let r = who
        .call(nft.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": council, "token_id": token_id, "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.json::<bool>()?)
}

async fn council_with_default_allowlist(w: &World) -> anyhow::Result<near_workspaces::Contract> {
    let council = w.worker.dev_deploy(&wasm("council")).await?;
    council
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "oracle_id": w.oracle.id(), "verifier_id": w.verifier.id(), "collateral_token_id": token_id(w),
            "cooldown_ns": (COOLDOWN_SECS * 1_000_000_000).to_string(), "max_seats_per_account": MAX_SEATS_PER_ACCOUNT
        }))
        .transact()
        .await?
        .into_result()?;
    w.owner
        .call(council.id(), "set_nft_contract")
        .args_json(json!({ "nft_contract": w.nft.id() }))
        .transact()
        .await?
        .into_result()?;
    Ok(council)
}

async fn owner_calls(
    w: &World,
    council: &near_workspaces::Contract,
    method: &str,
    args: serde_json::Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(w.owner.call(council.id(), method).args_json(args).transact().await?)
}

#[tokio::test]
async fn a_council_built_with_no_setting_stakes_only_what_the_owner_allows() -> anyhow::Result<()> {
    let w = setup().await?;
    let council = council_with_default_allowlist(&w).await?;
    let config = config(&council).await;
    assert_eq!(
        (&config["allowlist_enabled"], &config["allowed_range"]),
        (&json!(true), &json!(null))
    );
    for id in ["1", "2", "99", "007", "extra"] {
        mint_nft(&w, &w.alice, id).await?;
    }

    assert!(
        !try_stake(&w.nft, council.id(), &w.alice, "1").await?,
        "nothing is allowed yet"
    );
    assert_eq!(
        nft_owner(&w, "1").await,
        w.alice.id().to_string(),
        "the token went back to its owner"
    );
    assert_eq!(council.view("seat_count").await?.json::<u32>()?, 0);

    refused(
        w.alice
            .call(council.id(), "allow_tokens")
            .args_json(json!({ "token_ids": ["1"] }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );
    let allowed = owner_calls(&w, &council, "allow_tokens", json!({ "token_ids": ["1", "extra"] }))
        .await?
        .into_result()?;
    assert_eq!(
        event_names(&allowed.logs().iter().map(|l| l.to_string()).collect::<Vec<_>>()),
        vec!["tokens_allowed"]
    );
    assert!(try_stake(&w.nft, council.id(), &w.alice, "1").await?);
    assert!(try_stake(&w.nft, council.id(), &w.alice, "extra").await?);
    assert!(!try_stake(&w.nft, council.id(), &w.alice, "2").await?);

    owner_calls(&w, &council, "set_token_range", json!({ "first": "2", "last": "50" }))
        .await?
        .into_result()?;
    assert!(try_stake(&w.nft, council.id(), &w.alice, "2").await?);
    assert!(
        !try_stake(&w.nft, council.id(), &w.alice, "99").await?,
        "past the end of the range"
    );
    assert!(
        !try_stake(&w.nft, council.id(), &w.alice, "007").await?,
        "007 is not the number 7"
    );
    assert_eq!(council.view("seat_count").await?.json::<u32>()?, 3);

    owner_calls(&w, &council, "set_allowlist_enabled", json!({ "enabled": false }))
        .await?
        .into_result()?;
    assert!(
        try_stake(&w.nft, council.id(), &w.alice, "99").await?,
        "with the list off any token stakes"
    );
    owner_calls(&w, &council, "set_allowlist_enabled", json!({ "enabled": true }))
        .await?
        .into_result()?;
    assert_eq!(
        council.view("seat_count").await?.json::<u32>()?,
        4,
        "switching it on again unstakes nobody"
    );
    Ok(())
}

// An id allowed for one collection says nothing about the next: after a change of collection the old entries match
// nothing, and the owner names the new collection's tokens again.
#[tokio::test]
async fn the_allowlist_belongs_to_the_collection_it_was_made_for() -> anyhow::Result<()> {
    let w = setup().await?;
    let council = council_with_default_allowlist(&w).await?;
    owner_calls(&w, &council, "allow_tokens", json!({ "token_ids": ["1"] }))
        .await?
        .into_result()?;
    owner_calls(&w, &council, "set_token_range", json!({ "first": "5", "last": "9" }))
        .await?
        .into_result()?;
    let is_allowed = |token: &'static str| {
        let council = council.clone();
        async move {
            council
                .view("is_allowed")
                .args_json(json!({ "token_id": token }))
                .await
                .unwrap()
                .json::<bool>()
                .unwrap()
        }
    };
    assert!(is_allowed("1").await && is_allowed("7").await);

    owner_calls(
        &w,
        &council,
        "set_nft_contract",
        json!({ "nft_contract": w.alice.id() }),
    )
    .await?
    .into_result()?;
    assert!(
        !is_allowed("1").await && !is_allowed("7").await,
        "the old collection's entries are not the new collection's"
    );
    assert_eq!(config(&council).await["allowed_range"], json!(null));

    owner_calls(&w, &council, "set_nft_contract", json!({ "nft_contract": w.nft.id() }))
        .await?
        .into_result()?;
    assert!(
        is_allowed("1").await && is_allowed("7").await,
        "back on the collection they were made for"
    );
    Ok(())
}

// The configured owner can manage a full batch; other callers remain restricted.
#[tokio::test]
async fn the_configured_owner_switches_the_list_on_and_allows_a_full_batch_of_tokens() -> anyhow::Result<()> {
    let (w, admin) = setup_admin_owned().await?;
    mint_nft(&w, &w.alice, "late").await?;
    assert!(
        try_stake(&w.nft, w.council.id(), &w.alice, "late").await?,
        "the test world starts with the list off"
    );

    admin
        .call(w.council.id(), "set_allowlist_enabled")
        .args_json(json!({ "enabled": true }))
        .transact()
        .await?
        .into_result()?;
    mint_nft(&w, &w.alice, "later").await?;
    assert!(!try_stake(&w.nft, w.council.id(), &w.alice, "later").await?);

    // Exercise a full batch of short IDs through the application owner interface.
    let batch: Vec<String> = (0..100).map(|i| format!("token-{i:03}")).collect();
    mint_nft(&w, &w.alice, &batch[99]).await?;
    let result = admin
        .call(w.council.id(), "allow_tokens")
        .args_json(json!({ "token_ids": batch }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?
        .into_result()?;
    let logs: Vec<String> = result.logs().iter().map(|l| l.to_string()).collect();
    assert_eq!(event_names(&logs), vec!["tokens_allowed"]);
    assert!(try_stake(&w.nft, w.council.id(), &w.alice, &batch[99]).await?);
    assert!(
        !try_stake(&w.nft, w.council.id(), &w.alice, "later").await?,
        "only the named ones"
    );
    Ok(())
}

// Prints what a full batch burns when the owner calls it directly, so the cap is a measured number.
#[tokio::test]
async fn a_full_batch_of_long_token_ids_fits_in_one_call() -> anyhow::Result<()> {
    let w = setup().await?;
    let council = council_with_default_allowlist(&w).await?;
    let batch: Vec<String> = (0..100)
        .map(|i| format!("a-64-byte-token-id-{i:03}-{}", "x".repeat(40)))
        .collect();
    let r = w
        .owner
        .call(council.id(), "allow_tokens")
        .args_json(json!({ "token_ids": batch }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    println!(
        "allow_tokens with 100 ids of {} bytes burnt {} TGas",
        batch[0].len(),
        r.total_gas_burnt.as_tgas()
    );
    let too_many = [batch.clone(), vec!["one more".to_string()]].concat();
    refused(
        w.owner
            .call(council.id(), "allow_tokens")
            .args_json(json!({ "token_ids": too_many }))
            .transact()
            .await?
            .into_result(),
        "at most 100 tokens in one call",
    );
    Ok(())
}

// ---- a revenue transfer whose result is lost ------------------------------------------------------------------

async fn revenue_unresolved(w: &World) -> u128 {
    let f: serde_json::Value = w.market.view("get_fees").await.unwrap().json().unwrap();
    u(&f["revenue_unresolved"])
}

async fn total_received(w: &World) -> u128 {
    let t: String = w.council.view("total_received").await.unwrap().json().unwrap();
    t.parse().unwrap()
}

async fn settle_leg(w: &World, who: &near_workspaces::Account, sweep_id: u64) -> anyhow::Result<Vec<String>> {
    let r = who
        .call(w.market.id(), "settle_leg")
        .args_json(json!({ "sweep_id": sweep_id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

async fn reconcile_leg(w: &World, sweep_id: u64, leg: &str, arrived: bool) -> anyhow::Result<Vec<String>> {
    let r = w
        .owner
        .call(w.market.id(), "reconcile_leg")
        .args_json(json!({ "sweep_id": sweep_id.to_string(), "leg": leg, "arrived": arrived }))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

// Lets a sweep act on the small amounts these tests leave due.
async fn sweep_anything(w: &World) -> anyhow::Result<()> {
    w.owner
        .call(w.market.id(), "set_min_sweep")
        .args_json(json!({ "min_sweep": "1" }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn market_with_fees(w: &World) -> anyhow::Result<()> {
    let id = new_market(w, 600).await?;
    buy(w, &w.alice, id, "yes", SWEEP_BUY).await?;
    Ok(())
}

// The verifier refuses the market's payouts (its account is locked there), so neither share moves. The Council's share has
// no usable report and waits as unresolved, the treasury share goes back to its own due, and nothing is paid twice. Anyone then
// asks the Council what it recorded: nothing, so the share is due again and the next sweep sends it once.
#[tokio::test]
async fn a_revenue_transfer_the_verifier_refused_is_parked_and_not_paid_a_second_time() -> anyhow::Result<()> {
    let w = setup().await?;
    market_with_fees(&w).await?;
    sweep_anything(&w).await?;
    lock_account(&w, w.market.id()).await?;
    let council_before = intents_balance(&w, w.council.id()).await;

    let logs = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>();
    let events = event_names(&logs);
    assert!(events.contains(&"fee_transfer_unresolved".to_string()), "{logs:?}");
    assert!(events.contains(&"fee_transfer_failed".to_string()), "{logs:?}");
    assert_eq!(
        intents_balance(&w, w.council.id()).await,
        council_before,
        "nothing reached the Council"
    );
    assert_eq!(total_received(&w).await, 0);
    assert_eq!(
        fees(&w).await,
        (1, 0, TREASURY_SHARE),
        "the treasury share is due again, the Council share is not"
    );
    assert_eq!(revenue_unresolved(&w).await, COUNCIL_SHARE);
    assert_eq!(config(&w.market).await["revenue_unresolved"], COUNCIL_SHARE.to_string());
    let first = sweep_record(&w, 1).await;
    assert_eq!(
        (
            first["council"]["status"].as_str(),
            first["treasury"]["status"].as_str()
        ),
        (Some("unresolved"), Some("refused"))
    );
    assert_reconciled(&w).await;

    // Only the owner decides by hand, and not before an hour has passed. Anyone asks the Council, and not before ten minutes.
    // These run before the second sweep, which has to wait an hour and so leaves the first one too old to be refused.
    refused(
        w.carol
            .call(w.market.id(), "reconcile_leg")
            .args_json(json!({ "sweep_id": "1", "leg": "council", "arrived": false }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );
    refused(
        reconcile_leg(&w, 1, "council", false).await,
        "wait 60 minutes after the sweep before reconciling",
    );
    refused(
        settle_leg(&w, &w.carol, 1).await,
        "wait 10 minutes after the sweep before settling",
    );

    // Sweeping again retries the treasury share and sends the Council nothing, so the Council is not paid the same money twice.
    past_sweep_interval(&w).await;
    let logs = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>();
    assert!(
        !event_names(&logs).contains(&"fee_transfer_unresolved".to_string()),
        "{logs:?}"
    );
    assert_eq!(revenue_unresolved(&w).await, COUNCIL_SHARE);
    assert_eq!(fees(&w).await, (1, 0, TREASURY_SHARE));

    unlock_account(&w, w.market.id()).await?;
    let swept_at: u64 = sweep_record(&w, 1).await["at"].as_str().unwrap().parse()?;
    skip_until(&w, swept_at + (10 * 60 + 5) * 1_000_000_000).await;
    refused(settle_leg(&w, &w.carol, 2).await, "the leg is not unresolved");
    let logs = settle_leg(&w, &w.carol, 1).await?;
    assert_eq!(events_named(&logs, "fee_transfer_failed")[0]["leg"], "council");
    assert_eq!(
        (revenue_unresolved(&w).await, fees(&w).await),
        (0, (1, COUNCIL_SHARE, TREASURY_SHARE)),
        "the Council has no record of the sweep, so its share is due again"
    );
    assert_eq!(sweep_record(&w, 1).await["council"]["status"], "refused");
    refused(settle_leg(&w, &w.carol, 1).await, "the leg is not unresolved");

    past_sweep_interval(&w).await;
    sweep(&w, &w.carol).await?;
    assert_eq!(
        intents_balance(&w, w.council.id()).await - council_before,
        COUNCIL_SHARE
    );
    assert_eq!((total_received(&w).await, fees(&w).await), (COUNCIL_SHARE, (1, 0, 0)));
    assert_eq!(intents_balance(&w, w.treasury.id()).await, TREASURY_SHARE);
    assert_reconciled(&w).await;
    Ok(())
}

async fn sweep_record(w: &World, id: u64) -> serde_json::Value {
    w.market
        .view("get_sweep")
        .args_json(json!({ "sweep_id": id.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

// Telling the market a transfer arrived when it did not drops it from the books while the verifier still holds it. The
// reconciliation view shows that as a surplus, which nothing credits to anyone.
#[tokio::test]
async fn settling_an_unresolved_amount_as_arrived_when_it_did_not_shows_up_as_surplus() -> anyhow::Result<()> {
    let w = setup().await?;
    market_with_fees(&w).await?;
    lock_account(&w, w.market.id()).await?;
    sweep(&w, &w.carol).await?;
    unlock_account(&w, w.market.id()).await?;
    assert_eq!(total_received(&w).await, 0, "the Council never got it");

    let swept_at: u64 = sweep_record(&w, 1).await["at"].as_str().unwrap().parse()?;
    skip_until(&w, swept_at + (60 * 60 + 5) * 1_000_000_000).await;
    let logs = reconcile_leg(&w, 1, "council", true).await?;
    assert_eq!(events_named(&logs, "fee_leg_reconciled")[0]["arrived"], true);
    sweep_anything(&w).await?;
    sweep(&w, &w.carol).await?;
    assert_eq!(revenue_unresolved(&w).await, 0);
    assert_eq!(total_received(&w).await, 0, "still nothing at the Council");
    let owed: String = w.market.view("total_owed").await?.json()?;
    assert_eq!(
        intents_balance(&w, w.market.id()).await - owed.parse::<u128>()?,
        COUNCIL_SHARE,
        "the verifier holds what the books no longer owe"
    );
    Ok(())
}

// A receiver that refuses the revenue (a contract that panics in mt_on_transfer, or an account with no contract) makes the
// verifier refund it, and the report says nothing was kept. The amount is due again and is not parked as unresolved.
#[tokio::test]
async fn a_council_that_refuses_the_revenue_gets_it_back_as_due_and_is_not_paid_twice() -> anyhow::Result<()> {
    let w = setup().await?;
    market_with_fees(&w).await?;
    sweep_anything(&w).await?;
    let wrong_token = w.worker.dev_deploy(&wasm("council")).await?;
    wrong_token
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "oracle_id": w.oracle.id(),
            "verifier_id": w.verifier.id(), "collateral_token_id": "nep141:some-other-token.test.near",
            "cooldown_ns": (COOLDOWN_SECS * 1_000_000_000).to_string(), "max_seats_per_account": MAX_SEATS_PER_ACCOUNT
        }))
        .transact()
        .await?
        .into_result()?;
    let stranger = w.worker.dev_create_account().await?;
    let set_pool = |pool: near_workspaces::AccountId| {
        w.owner
            .call(w.market.id(), "set_fee_recipients")
            .args_json(json!({ "revenue_pool": pool, "treasury": w.treasury.id() }))
            .transact()
    };
    for refuser in [wrong_token.id().clone(), stranger.id().clone()] {
        set_pool(refuser.clone()).await?.into_result()?;
        past_sweep_interval(&w).await;
        let logs = sweep(&w, &w.carol)
            .await?
            .logs()
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>();
        let events = event_names(&logs);
        assert!(events.contains(&"fee_transfer_failed".to_string()), "{logs:?}");
        assert!(!events.contains(&"fee_transfer_unresolved".to_string()), "{logs:?}");
        assert_eq!(intents_balance(&w, &refuser).await, 0, "{refuser} kept nothing");
        assert_eq!(revenue_unresolved(&w).await, 0);
        assert_eq!(
            fees(&w).await,
            (1, COUNCIL_SHARE, 0),
            "the Council's share is due again"
        );
        assert_reconciled(&w).await;
    }
    assert_eq!(total_received(&w).await, 0);
    assert_eq!(
        intents_balance(&w, w.treasury.id()).await,
        TREASURY_SHARE,
        "the treasury was paid once"
    );

    set_pool(w.council.id().clone()).await?.into_result()?;
    past_sweep_interval(&w).await;
    sweep(&w, &w.carol).await?;
    assert_eq!(intents_balance(&w, w.council.id()).await, COUNCIL_SHARE);
    assert_eq!((total_received(&w).await, fees(&w).await), (COUNCIL_SHARE, (1, 0, 0)));
    assert_eq!(intents_balance(&w, w.treasury.id()).await, TREASURY_SHARE);
    assert_reconciled(&w).await;
    Ok(())
}

// Legacy controller gas tests are archived; DAO execution gas requires real integration evidence.

// ---- the publishers behind a signed price ---------------------------------------------------------------------

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public_key(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string())
}

fn signed_entry(key: &SigningKey, message: &str) -> String {
    let signature: String = key
        .sign(message.as_bytes())
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{}.{signature}", public_key(key))
}

#[tokio::test]
async fn the_proposed_event_of_a_signed_price_names_the_publishers_who_signed_it() -> anyhow::Result<()> {
    let w = setup().await?;
    let keys: Vec<SigningKey> = (1..=3).map(signing_key).collect();
    for k in &keys {
        w.owner
            .call(w.oracle.id(), "add_publisher")
            .args_json(json!({ "key": public_key(k) }))
            .transact()
            .await?
            .into_result()?;
    }
    let close_at = now(&w.worker).await + 120 * 1_000_000_000;
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .deposit(near_workspaces::types::NearToken::from_millinear(60))
        .args_json(json!({
            "title": "Will bitcoin close at or above 100.00 USD?", "rule_text": "Yes if the median close is at or above 100.00.",
            "resolution_source": "Three exchanges", "void_policy": "Fewer than two publish a price.",
            "category": "crypto", "subcategory": "bitcoin", "close_at": close_at.to_string(),
            "resolve_by": (close_at + 3_600_000_000_000u64).to_string(),
            "price_rule": { "observation_time": close_at.to_string(), "strike": "10000", "decimals": 2, "above": true }
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    skip_secs(&w.worker, 130).await;

    let message = format!(
        "price:v2:{}:{NETWORK}:{}:{id}:{close_at}:10500:2",
        w.oracle.id(),
        w.market.id()
    );
    let entries = [signed_entry(&keys[2], &message), signed_entry(&keys[0], &message)];
    deposit_to_intents(&w, &w.carol, w.carol.id(), BOND).await?;
    let r = intents_call(
        &w,
        &w.carol,
        w.oracle.id(),
        BOND,
        &format!("price:{}:{id}:10500:{}", w.market.id(), entries.join(",")),
    )
    .await?
    .into_result()?;
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    let proposed = &events_named(&logs, "proposed")[0];
    assert_eq!(
        proposed["signers"],
        json!([public_key(&keys[2]), public_key(&keys[0])]),
        "named in the order they were submitted"
    );
    assert_eq!(proposed["evidence"], "signed price 10500 by 2 publishers");
    Ok(())
}
