// The market and the council on the NEAR Intents path: money arrives as an mt_transfer_call and leaves as an mt_transfer from
// the contract's own Intents account. Real contracts and the real verifier, sandbox chain.
mod common;
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

async fn total_owed(w: &World) -> u128 {
    let owed: String = w.market.view("total_owed").await.unwrap().json().unwrap();
    owed.parse().unwrap()
}

async fn withdraw(w: &World, who: &Account, amount: u128) -> anyhow::Result<Vec<String>> {
    let r = who
        .call(w.market.id(), "withdraw")
        .args_json(json!({ "amount": amount.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

fn touched(r: &ExecutionFinalResult, who: &AccountId) -> bool {
    r.outcomes().iter().any(|o| &o.executor_id == who)
}

async fn public_keys_of(w: &World, who: &AccountId) -> Vec<Value> {
    w.verifier
        .view("public_keys_of")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

async fn predecessor_auth_enabled(w: &World, who: &AccountId) -> bool {
    w.verifier
        .view("is_auth_by_predecessor_id_enabled")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

// Deposit, buy, sell, resolve, redeem, claim the residual, withdraw and sweep. After every step that has finished, the market's
// books say exactly what the verifier holds for it, and it never registers a key or turns off predecessor authentication.
#[tokio::test]
async fn a_full_journey_keeps_total_owed_equal_to_the_verifiers_balance() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    assert_reconciled(&w).await;
    assert_eq!(
        intents_balance(&w, w.market.id()).await,
        SEED,
        "the seed is all the market holds"
    );
    assert_eq!(
        ft_balance(&w, w.market.id()).await,
        0,
        "the market never holds the token itself"
    );

    ft_call(&w, &w.alice, w.market.id(), 10 * USD, "deposit").await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, 10 * USD);
    assert_reconciled(&w).await;

    buy(&w, &w.alice, id, "yes", 20 * USD).await?;
    buy(&w, &w.bob, id, "no", 15 * USD).await?;
    assert_reconciled(&w).await;

    let (yes, _) = shares(&w, id, w.alice.id()).await;
    let (out, needed, _) = quote_sell(&w, id, "yes", yes / 2).await;
    sell(&w, &w.alice, id, "yes", out, needed).await?;
    assert_reconciled(&w).await;
    assert!(invariant(&w, id).await);

    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "yes");

    for who in [&w.alice, &w.bob] {
        who.call(w.market.id(), "redeem")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result()?;
    }
    assert_reconciled(&w).await;
    w.owner
        .call(w.market.id(), "claim_residual")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_reconciled(&w).await;

    let balance = market_balance(&w, w.alice.id()).await;
    assert!(balance > 0);
    let before = intents_balance(&w, w.alice.id()).await;
    withdraw(&w, &w.alice, balance).await?;
    assert_eq!(
        intents_balance(&w, w.alice.id()).await - before,
        balance,
        "the payout is in her Intents account"
    );
    assert_eq!(market_balance(&w, w.alice.id()).await, 0);
    assert_reconciled(&w).await;

    let council_before = intents_balance(&w, w.council.id()).await;
    let treasury_before = intents_balance(&w, w.treasury.id()).await;
    sweep(&w, &w.carol).await?;
    assert!(intents_balance(&w, w.council.id()).await > council_before);
    assert!(intents_balance(&w, w.treasury.id()).await > treasury_before);
    assert_reconciled(&w).await;

    for contract in [w.market.id(), w.council.id()] {
        assert!(
            public_keys_of(&w, contract).await.is_empty(),
            "{contract} registered no key in the verifier"
        );
        assert!(
            predecessor_auth_enabled(&w, contract).await,
            "{contract} still authenticates by predecessor"
        );
    }
    let market = config(&w.market).await;
    assert_eq!(
        (&market["verifier"], &market["collateral_token_id"]),
        (&json!(w.verifier.id()), &json!(token_id(&w)))
    );
    let council = config(&w.council).await;
    assert_eq!(
        (&council["verifier"], &council["collateral_token_id"]),
        (&json!(w.verifier.id()), &json!(token_id(&w)))
    );
    Ok(())
}

// A panic in mt_on_transfer is the way the market says no: the verifier refunds the sender in full and reports that nothing was
// kept. Nothing on either side moves.
#[tokio::test]
async fn a_message_the_market_refuses_is_refunded_in_full_by_the_verifier() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    deposit_to_intents(&w, &w.alice, w.alice.id(), 10 * USD).await?;
    deposit_to_intents(&w, &w.carol, w.carol.id(), 10 * USD).await?;
    let (owed, market_held) = (total_owed(&w).await, intents_balance(&w, w.market.id()).await);

    let cases = [
        (&w.alice, "hello".to_string()),
        (&w.alice, format!("buy:{id}:yes:999999999999")),
        (&w.alice, "buy:99:yes:1".to_string()),
        (&w.alice, format!("seed:{id}")),
        (&w.carol, format!("buy:{id}:yes:1")),
    ];
    for (who, msg) in cases {
        let before = intents_balance(&w, who.id()).await;
        let r = intents_call(&w, who, w.market.id(), 5 * USD, &msg).await?;
        assert!(r.is_success(), "{msg}: the verifier call itself succeeds");
        assert_eq!(
            r.json::<Vec<String>>()?,
            vec!["0".to_string()],
            "{msg}: the verifier reports nothing kept"
        );
        assert_eq!(intents_balance(&w, who.id()).await, before, "{msg}: refunded in full");
        assert_eq!(intents_balance(&w, w.market.id()).await, market_held, "{msg}");
        assert_eq!(total_owed(&w).await, owed, "{msg}");
    }
    assert_eq!(market_balance(&w, w.alice.id()).await, 0);
    assert_eq!(
        shares(&w, id, w.carol.id()).await,
        (0, 0),
        "carol never registered, so her buy was refused"
    );
    Ok(())
}

// A second token deposited into the verifier has its own token id. The market and the council refuse it, and the verifier
// returns it.
#[tokio::test]
async fn a_token_id_that_is_not_the_collateral_is_refused_and_refunded() -> anyhow::Result<()> {
    let w = setup().await?;
    let other = w.worker.dev_deploy(&wasm("mock_ft")).await?;
    other
        .call("new")
        .args_json(json!({ "owner_id": w.dave.id() }))
        .transact()
        .await?
        .into_result()?;
    w.dave
        .call(other.id(), "mint")
        .args_json(json!({ "account_id": w.dave.id(), "amount": (100 * USD).to_string() }))
        .transact()
        .await?
        .into_result()?;
    w.dave
        .call(other.id(), "storage_deposit")
        .args_json(json!({ "account_id": w.verifier.id(), "registration_only": true }))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    w.dave
        .call(other.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": w.verifier.id(), "amount": (50 * USD).to_string(), "msg": w.dave.id() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(200))
        .transact()
        .await?
        .into_result()?;
    let other_id = format!("nep141:{}", other.id());
    let balance_of = |who: AccountId| {
        let (verifier, other_id) = (w.verifier.clone(), other_id.clone());
        async move {
            let b: String = verifier
                .view("mt_balance_of")
                .args_json(json!({ "account_id": who, "token_id": other_id }))
                .await
                .unwrap()
                .json()
                .unwrap();
            b.parse::<u128>().unwrap()
        }
    };
    assert_eq!(balance_of(w.dave.id().clone()).await, 50 * USD);

    w.dave
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    let owed = total_owed(&w).await;
    for (to, msg) in [(w.market.id(), "deposit"), (w.council.id(), "revenue:1")] {
        let r = w
            .dave
            .call(w.verifier.id(), "mt_transfer_call")
            .args_json(json!({ "receiver_id": to, "token_id": other_id, "amount": (5 * USD).to_string(), "msg": msg }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        assert!(r.is_success());
        assert_eq!(r.json::<Vec<String>>()?, vec!["0".to_string()], "{to}: nothing kept");
        assert_eq!(balance_of(w.dave.id().clone()).await, 50 * USD, "{to}: refunded");
        assert_eq!(balance_of(to.clone()).await, 0, "{to} holds none of it");
    }
    assert_eq!(market_balance(&w, w.dave.id()).await, 0);
    assert_eq!(total_owed(&w).await, owed);
    assert_eq!(
        council_total_received(&w).await,
        0,
        "no revenue arrived in a token the council does not trust"
    );
    Ok(())
}

// The hook trusts its caller only as the verifier it was configured with, and then checks what the verifier says. Here the test
// plays a verifier it controls, so the checks after the caller check can be reached with a deliberately wrong delivery.
#[tokio::test]
async fn the_hook_checks_the_delivery_as_well_as_the_caller() -> anyhow::Result<()> {
    let w = setup().await?;
    let market = w.worker.dev_deploy(&wasm("market")).await?;
    let council = w.worker.dev_deploy(&wasm("council")).await?;
    let fake_verifier = &w.dave;
    let collateral = "nep141:usdc.test.near";
    market
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "operator_id": w.owner.id(), "oracle_id": w.oracle.id(),
            "verifier_id": fake_verifier.id(), "collateral_token_id": collateral
        }))
        .transact()
        .await?
        .into_result()?;
    council
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "oracle_id": w.oracle.id(),
            "verifier_id": fake_verifier.id(), "collateral_token_id": collateral,
            "cooldown_ns": (COOLDOWN_SECS * 1_000_000_000).to_string(), "max_seats_per_account": 1
        }))
        .transact()
        .await?
        .into_result()?;
    // The Council takes revenue only from its market, which here is the account the test delivers it as.
    w.owner
        .call(council.id(), "set_market")
        .args_json(json!({ "market": w.alice.id() }))
        .transact()
        .await?
        .into_result()?;
    w.alice
        .call(market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;

    let deliver = |to: &AccountId, previous: Vec<&AccountId>, tokens: Vec<&str>, amounts: Vec<&str>, msg: &str| {
        fake_verifier
            .call(to, "mt_on_transfer")
            .args_json(json!({
                "sender_id": w.alice.id(), "previous_owner_ids": previous, "token_ids": tokens, "amounts": amounts, "msg": msg
            }))
            .transact()
    };
    let (alice, bob) = (w.alice.id(), w.bob.id());
    let r = deliver(market.id(), vec![alice], vec![collateral], vec!["5000000"], "deposit").await?;
    assert_eq!(r.into_result()?.json::<Vec<String>>()?, vec!["0".to_string()]);
    let balance: String = market
        .view("get_balance")
        .args_json(json!({ "account_id": alice }))
        .await?
        .json()?;
    assert_eq!(balance, "5000000", "the control delivery was accepted and credited");

    let bad = [
        (
            vec![bob],
            vec![collateral],
            vec!["5000000"],
            "the money must come from the sender's own balance",
        ),
        (
            vec![],
            vec![collateral],
            vec!["5000000"],
            "the money must come from the sender's own balance",
        ),
        (
            vec![alice],
            vec!["nep141:other.test.near"],
            vec!["5000000"],
            "wrong token",
        ),
        (vec![alice], vec!["usdc.test.near"], vec!["5000000"], "wrong token"),
        (vec![alice], vec![collateral], vec!["0"], "amount must be positive"),
        (
            vec![alice, alice],
            vec![collateral, collateral],
            vec!["1", "1"],
            "exactly one token and amount",
        ),
    ];
    for (previous, tokens, amounts, why) in bad {
        let r = deliver(
            market.id(),
            previous.clone(),
            tokens.clone(),
            amounts.clone(),
            "deposit",
        )
        .await?;
        refused(r.into_result(), why);
    }
    let r = deliver(
        council.id(),
        vec![alice],
        vec![collateral],
        vec!["7000000"],
        "revenue:1",
    )
    .await?;
    assert_eq!(r.into_result()?.json::<Vec<String>>()?, vec!["0".to_string()]);
    let received: String = council.view("total_received").await?.json()?;
    assert_eq!(received, "7000000");
    let r = deliver(
        council.id(),
        vec![alice],
        vec!["nep141:other.test.near"],
        vec!["1"],
        "revenue:2",
    )
    .await?;
    refused(r.into_result(), "wrong token");
    let r = deliver(council.id(), vec![alice], vec![collateral], vec!["1"], "deposit").await?;
    refused(r.into_result(), "unknown action");
    Ok(())
}

// A plain deposit to the market is surplus: the verifier credits the market's account and tells nobody. Nothing is credited to
// the sender, no callback runs, and total_owed does not move, so the difference is visible and stays unattributed.
#[tokio::test]
async fn a_plain_deposit_to_the_market_is_surplus_with_no_callback_and_no_credit() -> anyhow::Result<()> {
    let w = setup().await?;
    create_seeded_market(&w, 600).await?;
    let owed = total_owed(&w).await;
    assert_reconciled(&w).await;

    let old_form =
        json!({ "receiver_id": w.market.id(), "msg": "deposit", "min_gas": 30_000_000_000_000u64 }).to_string();
    let mut surplus = 0;
    for msg in [w.market.id().to_string(), old_form, "deposit".to_string()] {
        let before = intents_balance(&w, w.market.id()).await;
        let r = w
            .alice
            .call(w.ft.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": w.verifier.id(), "amount": (4 * USD).to_string(), "msg": msg }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        assert!(r.is_success(), "{msg}: the verifier accepts it");
        assert!(!touched(&r, w.market.id()), "{msg}: no receipt ran on the market");
        let gained = intents_balance(&w, w.market.id()).await - before;
        println!("deposit with msg {msg:?}: the market's Intents balance grew by {gained}");
        assert!(
            gained == 0 || gained == 4 * USD,
            "{msg}: credited to the market or to the sender, nothing else"
        );
        surplus += gained;
    }
    assert!(surplus > 0, "at least the plain form credited the market");
    assert_eq!(
        market_balance(&w, w.alice.id()).await,
        0,
        "alice was credited nothing in the market"
    );
    assert_eq!(total_owed(&w).await, owed, "the books do not move");
    assert_eq!(
        intents_balance(&w, w.market.id()).await - total_owed(&w).await,
        surplus,
        "the unattributed money is exactly the difference"
    );

    sweep(&w, &w.carol).await?;
    assert_eq!(
        intents_balance(&w, w.market.id()).await - total_owed(&w).await,
        surplus,
        "operating the market does not spend or credit the surplus"
    );
    Ok(())
}

// A payout the verifier refuses leaves the user's balance exactly where it was. Paused or locked, the market still takes money in
// where the verifier allows it, which is why the keeper must watch the lock.
#[tokio::test]
async fn a_withdrawal_the_verifier_refuses_restores_the_balance() -> anyhow::Result<()> {
    let w = setup().await?;
    create_seeded_market(&w, 600).await?;
    ft_call(&w, &w.alice, w.market.id(), 10 * USD, "deposit").await?;
    let owed = total_owed(&w).await;
    let alice_intents = intents_balance(&w, w.alice.id()).await;

    lock_account(&w, w.market.id()).await?;
    let logs = withdraw(&w, &w.alice, 10 * USD).await?;
    assert!(event_names(&logs).contains(&"withdraw_failed".to_string()), "{logs:?}");
    assert_eq!(market_balance(&w, w.alice.id()).await, 10 * USD, "the balance is back");
    assert_eq!(intents_balance(&w, w.alice.id()).await, alice_intents);
    assert_eq!(total_owed(&w).await, owed);
    assert_reconciled(&w).await;

    ft_call(&w, &w.bob, w.market.id(), 3 * USD, "deposit").await?;
    assert_eq!(
        market_balance(&w, w.bob.id()).await,
        3 * USD,
        "a locked account still receives"
    );
    unlock_account(&w, w.market.id()).await?;

    pause_transfers(&w).await?;
    let logs = withdraw(&w, &w.alice, 10 * USD).await?;
    assert!(event_names(&logs).contains(&"withdraw_failed".to_string()), "{logs:?}");
    assert_eq!(market_balance(&w, w.alice.id()).await, 10 * USD);
    let r = intents_call(&w, &w.bob, w.market.id(), USD, "deposit").await?;
    assert!(
        r.is_failure(),
        "a paused verifier refuses transfer calls into the market too"
    );
    unpause_transfers(&w).await?;

    withdraw(&w, &w.alice, 10 * USD).await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, 0);
    assert_eq!(intents_balance(&w, w.alice.id()).await, alice_intents + 10 * USD);
    assert_reconciled(&w).await;
    Ok(())
}

// While the verifier refuses its payouts the market keeps its books: users can still redeem inside it, and the exit works the moment
// the verifier allows it.
#[tokio::test]
async fn redeeming_works_inside_the_market_while_the_verifier_refuses_payouts() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;

    lock_account(&w, w.market.id()).await?;
    w.alice
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    let credited = market_balance(&w, w.alice.id()).await;
    assert!(credited > 0);
    withdraw(&w, &w.alice, credited).await?;
    assert_eq!(
        market_balance(&w, w.alice.id()).await,
        credited,
        "the payout failed and was restored"
    );
    unlock_account(&w, w.market.id()).await?;
    withdraw(&w, &w.alice, credited).await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, 0);
    assert_reconciled(&w).await;
    Ok(())
}
