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
    let members = [
        worker.dev_create_account().await?,
        worker.dev_create_account().await?,
        worker.dev_create_account().await?,
    ];
    let other = stranger.id().clone();
    let day = (24 * 3600 * 1_000_000_000u64).to_string();
    let three_days = (72 * 3600 * 1_000_000_000u64).to_string();
    let contracts = [
        (
            "market",
            json!({ "owner_id": other, "operator_id": other, "oracle_id": other, "collateral_token": other,
                    "revenue_pool": other, "business_wallet": other }),
        ),
        (
            "oracle",
            json!({ "owner_id": other, "market_contract": other, "bond_token": other, "bond": "1", "window_ms": "1000",
                    "panel_deadline_ms": "1000", "draw_window_ms": "1000", "council": other, "jury_size": 3,
                    "draw_delay_blocks": "1", "min_proposal_ms": "1000", "operator_id": other, "network": NETWORK,
                    "price_threshold": 1, "no_decision_recipient": other }),
        ),
        (
            "council",
            json!({ "owner_id": other, "oracle_id": other, "nft_contract": other, "collateral_token": other,
                    "cooldown_ns": day, "max_seats_per_account": 1 }),
        ),
        (
            "governance",
            json!({ "members": members.iter().map(|m| m.id()).collect::<Vec<_>>(), "threshold": 2,
                    "voting_period_ns": day, "timelock_ns": three_days, "execution_window_ns": day }),
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
        assert_eq!(config["state_version"], 1, "{name} initialised by its own account");
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
    let id = create_seeded_market(&w, 600).await?;
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
    let tokens = ft_balance(&w, w.carol.id()).await;
    ft_call(&w, &w.carol, w.market.id(), 5 * USD, "deposit").await?;
    assert_eq!(
        (
            ft_balance(&w, w.carol.id()).await,
            market_balance(&w, w.carol.id()).await
        ),
        (tokens, 0)
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
            "owner_id": w.owner.id(), "oracle_id": w.oracle.id(), "nft_contract": w.nft.id(), "collateral_token": w.ft.id(),
            "cooldown_ns": (COOLDOWN_SECS * 1_000_000_000).to_string(), "max_seats_per_account": MAX_SEATS_PER_ACCOUNT
        }))
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

// What a full batch costs, and the owner being governance: the list is changed by a vote like any other setting.
#[tokio::test]
async fn governance_switches_the_list_on_and_allows_a_full_batch_of_tokens() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    mint_nft(&w, &w.alice, "late").await?;
    assert!(
        try_stake(&w.nft, w.council.id(), &w.alice, "late").await?,
        "the test world starts with the list off"
    );

    let on = gov_pass(
        &g,
        function_call(w.council.id(), "set_allowlist_enabled", json!({ "enabled": true }), 20),
    )
    .await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    gov_execute(&g, &w.carol, on).await?;
    mint_nft(&w, &w.alice, "later").await?;
    assert!(!try_stake(&w.nft, w.council.id(), &w.alice, "later").await?);

    // The vote carries the arguments, and governance caps them at 4,096 bytes, so a full batch needs short ids.
    let batch: Vec<String> = (0..100).map(|i| format!("token-{i:03}")).collect();
    mint_nft(&w, &w.alice, &batch[99]).await?;
    let allow = gov_pass(
        &g,
        function_call(w.council.id(), "allow_tokens", json!({ "token_ids": batch }), 60),
    )
    .await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    let logs = gov_execute(&g, &w.carol, allow).await?;
    assert_eq!(event_names(&logs), vec!["call_sent", "tokens_allowed", "executed"]);
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

const REVENUE_SHARE: u128 = 273_798;
const BUSINESS_SHARE: u128 = 821_394;

async fn revenue_unresolved(w: &World) -> u128 {
    let f: serde_json::Value = w.market.view("get_fees").await.unwrap().json().unwrap();
    u(&f["revenue_unresolved"])
}

async fn total_received(w: &World) -> u128 {
    let t: String = w.council.view("total_received").await.unwrap().json().unwrap();
    t.parse().unwrap()
}

async fn reconcile(w: &World, amount: u128, arrived: bool) -> anyhow::Result<Vec<String>> {
    let r = w
        .owner
        .call(w.market.id(), "reconcile_revenue")
        .args_json(json!({ "amount": amount.to_string(), "arrived": arrived }))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

async fn market_with_fees(w: &World) -> anyhow::Result<()> {
    let id = create_seeded_market(w, 600).await?;
    buy(w, &w.alice, id, "yes", 10 * USD).await?;
    Ok(())
}

// The token moved the tokens and then its own resolve step failed. The market saw a failure, the Council has the money.
#[tokio::test]
async fn a_revenue_transfer_that_arrived_but_reported_a_failure_is_not_paid_a_second_time() -> anyhow::Result<()> {
    let w = setup().await?;
    market_with_fees(&w).await?;
    w.owner
        .call(w.ft.id(), "set_fail_resolve")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let council_before = ft_balance(&w, w.council.id()).await;

    let logs = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>();
    assert!(
        event_names(&logs).contains(&"fee_transfer_unresolved".to_string()),
        "{logs:?}"
    );
    assert_eq!(
        ft_balance(&w, w.council.id()).await - council_before,
        REVENUE_SHARE,
        "the tokens did arrive"
    );
    assert_eq!(
        total_received(&w).await,
        REVENUE_SHARE,
        "the Council counted them, which is how the owner can tell"
    );
    assert_eq!(fees(&w).await, (1, 0, 0), "nothing is due again");
    assert_eq!(revenue_unresolved(&w).await, REVENUE_SHARE);
    let config = config(&w.market).await;
    assert_eq!(config["revenue_unresolved"], REVENUE_SHARE.to_string());

    // Sweeping again sends nothing, so the Council is not paid the same money twice.
    let logs = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>();
    assert!(event_names(&logs).is_empty(), "{logs:?}");
    assert_eq!(ft_balance(&w, w.council.id()).await - council_before, REVENUE_SHARE);

    // Only the owner settles it, and only up to what is unresolved.
    refused(
        w.carol
            .call(w.market.id(), "reconcile_revenue")
            .args_json(json!({ "amount": "1", "arrived": true }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );
    refused(
        reconcile(&w, REVENUE_SHARE + 1, true).await,
        "that is more than is unresolved",
    );
    let logs = reconcile(&w, REVENUE_SHARE, true).await?;
    assert_eq!(events_named(&logs, "revenue_reconciled")[0]["arrived"], true);
    assert_eq!((revenue_unresolved(&w).await, fees(&w).await), (0, (1, 0, 0)));
    sweep(&w, &w.carol).await?;
    assert_eq!(
        ft_balance(&w, w.council.id()).await - council_before,
        REVENUE_SHARE,
        "still paid once"
    );
    Ok(())
}

// Nothing moved: the receiver is unknown to the token. The owner sees the Council's total unchanged and sends it back to due.
#[tokio::test]
async fn a_revenue_transfer_that_never_arrived_is_sent_again_after_the_owner_says_so() -> anyhow::Result<()> {
    let w = setup().await?;
    market_with_fees(&w).await?;
    let stranger = w.worker.dev_create_account().await?;
    let set_pool = |pool: near_workspaces::AccountId| {
        w.owner
            .call(w.market.id(), "set_fee_recipients")
            .args_json(json!({ "revenue_pool": pool, "business_wallet": w.business.id() }))
            .transact()
    };
    set_pool(stranger.id().clone()).await?.into_result()?;
    let logs = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>();
    assert!(
        event_names(&logs).contains(&"fee_transfer_unresolved".to_string()),
        "{logs:?}"
    );
    assert_eq!(ft_balance(&w, stranger.id()).await, 0);
    assert_eq!(
        (revenue_unresolved(&w).await, fees(&w).await.1, total_received(&w).await),
        (REVENUE_SHARE, 0, 0)
    );

    set_pool(w.council.id().clone()).await?.into_result()?;
    let council_before = ft_balance(&w, w.council.id()).await;
    reconcile(&w, REVENUE_SHARE, false).await?;
    assert_eq!((revenue_unresolved(&w).await, fees(&w).await.1), (0, REVENUE_SHARE));
    sweep(&w, &w.carol).await?;
    assert_eq!(ft_balance(&w, w.council.id()).await - council_before, REVENUE_SHARE);
    assert_eq!((total_received(&w).await, fees(&w).await), (REVENUE_SHARE, (1, 0, 0)));
    assert_eq!(ft_balance(&w, w.business.id()).await, BUSINESS_SHARE);
    Ok(())
}

// ---- the gas a governance call carries ------------------------------------------------------------------------

#[tokio::test]
async fn a_governance_call_carries_between_5_and_250_tgas_and_the_view_says_what_to_attach() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    for bad in [0, 4, 251, 300] {
        let action = function_call(w.market.id(), "set_paused", json!({ "paused": true }), bad);
        let r = g.members[0]
            .call(g.contract.id(), "propose")
            .args_json(json!({ "action": action }))
            .transact()
            .await?;
        refused(r.into_result(), "the call's gas must be between 5 and 250 TGas");
    }
    for ok in [5, 250] {
        gov_propose(
            &g,
            &g.members[0],
            function_call(w.market.id(), "set_paused", json!({ "paused": true }), ok),
        )
        .await?;
    }

    let id = gov_pass(
        &g,
        function_call(w.market.id(), "set_paused", json!({ "paused": true }), 20),
    )
    .await?;
    assert_eq!(
        gov_proposal(&g, id).await["execute_gas"],
        Gas::from_tgas(34).as_gas().to_string(),
        "20 TGas plus 14"
    );
    let listed: serde_json::Value = g
        .contract
        .view("list_proposals")
        .args_json(json!({ "from_index": "0", "limit": "10" }))
        .await?
        .json()?;
    assert_eq!(listed[2]["execute_gas"], Gas::from_tgas(34).as_gas().to_string());
    assert_eq!(listed[2]["stage"], "approved", "the stored fields are still shown");

    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    let execute_with = |tgas: u64| {
        w.carol
            .call(g.contract.id(), "execute")
            .args_json(json!({ "proposal_id": id.to_string() }))
            .gas(Gas::from_tgas(tgas))
            .transact()
    };
    refused(
        execute_with(33).await?.into_result(),
        "attach at least 34 TGas to execute this call",
    );
    assert_eq!(
        gov_proposal(&g, id).await["stage"],
        "approved",
        "a refused execute leaves it approved"
    );
    let logs: Vec<String> = execute_with(34)
        .await?
        .into_result()?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect();
    assert_eq!(
        event_names(&logs),
        vec!["call_sent", "paused", "executed"],
        "the amount the view shows is enough"
    );
    Ok(())
}

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

    let message = format!("price:v1:{}:{NETWORK}:{id}:{close_at}:10500:2", w.oracle.id());
    let entries = [signed_entry(&keys[2], &message), signed_entry(&keys[0], &message)];
    let r = w
        .carol
        .call(w.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": w.oracle.id(), "amount": BOND.to_string(), "msg": format!("price:{id}:10500:{}", entries.join(",")) }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(200))
        .transact()
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
