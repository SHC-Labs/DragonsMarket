mod common;
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::json;

const SEND_TGAS: u64 = 100;

async fn register_on_token(w: &World, who: &AccountId) -> anyhow::Result<()> {
    w.owner
        .call(w.ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn send(
    w: &World,
    from: &Account,
    to: &AccountId,
    amount: u128,
    msg: &str,
    tgas: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(w.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": to, "amount": amount.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

fn assert_clean(w: &World, label: &str, r: &ExecutionFinalResult) {
    assert!(
        r.is_success() && r.receipt_failures().is_empty(),
        "{label}: {:?}",
        r.receipt_failures()
    );
    println!(
        "{label}: market {:.1} TGas, token {:.1} TGas, verifier {:.1} TGas, total {:.1} TGas",
        burnt_on(r, w.market.id()),
        burnt_on(r, w.ft.id()),
        burnt_on(r, w.verifier.id()),
        tg(r.total_gas_burnt)
    );
}

async fn owed(market: &Contract) -> u128 {
    let s: String = market.view("total_owed").await.unwrap().json().unwrap();
    s.parse().unwrap()
}

async fn credited(market: &Contract, who: &AccountId) -> u128 {
    let s: String = market
        .view("get_balance")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

#[tokio::test]
async fn a_token_holder_registers_in_near_deposits_trades_and_exits() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    register_on_token(&w, w.market.id()).await?;
    let tokens = ft_balance(&w, w.dave.id()).await;
    let held = intents_balance(&w, w.market.id()).await;
    assert_eq!(
        intents_balance(&w, w.dave.id()).await,
        0,
        "dave holds nothing in the verifier"
    );
    w.dave
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;

    let r = send(&w, &w.dave, w.market.id(), 15 * USD, "deposit", SEND_TGAS).await?;
    assert_clean(&w, "deposit by token", &r);
    assert_eq!(credited(&w.market, w.dave.id()).await, 15 * USD);
    assert_eq!(ft_balance(&w, w.dave.id()).await, tokens - 15 * USD);
    assert_eq!(intents_balance(&w, w.market.id()).await, held + 15 * USD);
    assert_eq!(
        ft_balance(&w, w.market.id()).await,
        0,
        "the market keeps no token itself"
    );
    assert_reconciled(&w).await;

    w.dave
        .call(w.market.id(), "buy")
        .args_json(
            json!({ "market_id": id.to_string(), "side": "yes", "amount": (10 * USD).to_string(), "min_shares": "1" }),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    w.dave
        .call(w.market.id(), "withdraw")
        .args_json(json!({ "amount": (5 * USD).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(credited(&w.market, w.dave.id()).await, 0);
    assert_eq!(
        intents_balance(&w, w.dave.id()).await,
        5 * USD,
        "the exit lands in dave's own Intents account"
    );
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn a_refused_transfer_comes_back_whole_and_moves_nothing() -> anyhow::Result<()> {
    let w = setup().await?;
    register_on_token(&w, w.market.id()).await?;
    let held = intents_balance(&w, w.market.id()).await;
    let owed_before = owed(&w.market).await;
    for (from, msg, tgas, why) in [
        (&w.dave, "deposit", SEND_TGAS, "do the storage deposit first"),
        (&w.dave, "register", SEND_TGAS, "unknown action"),
        (&w.alice, "seed:0", SEND_TGAS, "unknown action"),
        (&w.alice, "deposit", 80, "attach at least 75 TGas"),
        (&w.alice, "buy:0:yes:1", SEND_TGAS, "no such market"),
    ] {
        let tokens = ft_balance(&w, from.id()).await;
        let r = send(&w, from, w.market.id(), 4 * USD, msg, tgas).await?;
        assert!(r.is_success(), "{msg}: the token call itself completes");
        assert!(
            format!("{:?}", r.receipt_failures()).contains(why),
            "{msg} at {tgas} TGas: {:?}",
            r.receipt_failures()
        );
        assert_eq!(
            ft_balance(&w, from.id()).await,
            tokens,
            "{msg} at {tgas} TGas: the token came back"
        );
    }
    assert_eq!(ft_balance(&w, w.market.id()).await, 0);
    assert_eq!(intents_balance(&w, w.market.id()).await, held);
    assert_eq!(owed(&w.market).await, owed_before);
    assert_eq!(credited(&w.market, w.alice.id()).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_token_buy_ends_as_shares_or_as_a_balance() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    register_on_token(&w, w.market.id()).await?;
    let held = intents_balance(&w, w.market.id()).await;

    let order = format!("buy:{id}:yes:1");
    let r = send(&w, &w.alice, w.market.id(), 10 * USD, &order, SEND_TGAS).await?;
    assert_clean(&w, "buy by token", &r);
    assert!(shares(&w, id, w.alice.id()).await.0 > 0, "the token became shares");
    assert_eq!(credited(&w.market, w.alice.id()).await, 0);
    assert_eq!(intents_balance(&w, w.market.id()).await, held + 10 * USD);
    assert_reconciled(&w).await;

    let greedy = format!("buy:{id}:no:{}", 100 * USD);
    let r = send(&w, &w.alice, w.market.id(), 4 * USD, &greedy, SEND_TGAS).await?;
    assert!(
        format!("{:?}", r.receipt_failures()).contains("price moved"),
        "{:?}",
        r.receipt_failures()
    );
    assert_eq!(
        credited(&w.market, w.alice.id()).await,
        4 * USD,
        "a buy the price outran stays a balance"
    );
    assert_eq!(shares(&w, id, w.alice.id()).await.1, 0);
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn a_token_buy_that_just_clears_the_floor_completes() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    register_on_token(&w, w.market.id()).await?;
    let order = format!("buy:{id}:yes:1");
    for tgas in 76..100 {
        let r = send(&w, &w.alice, w.market.id(), USD, &order, tgas).await?;
        if format!("{:?}", r.receipt_failures()).contains("attach at least") {
            continue;
        }
        assert_clean(&w, &format!("buy by token at {tgas} TGas"), &r);
        assert!(shares(&w, id, w.alice.id()).await.0 > 0, "the buy filled");
        assert_reconciled(&w).await;
        return Ok(());
    }
    panic!("the floor refused every gas amount tried");
}

#[tokio::test]
async fn a_forward_the_verifier_does_not_take_comes_back_whole() -> anyhow::Result<()> {
    let w = setup().await?;
    let unregistered = w.worker.dev_create_account().await?;
    let codeless = w.worker.dev_create_account().await?;
    register_on_token(&w, codeless.id()).await?;
    for (label, verifier) in [
        ("the forward itself fails", unregistered.id()),
        ("the receiver refuses it", codeless.id()),
    ] {
        let market = w.worker.dev_deploy(&wasm("market")).await?;
        market
            .call("new")
            .args_json(json!({
                "owner_id": w.owner.id(), "operator_id": w.owner.id(), "oracle_id": w.oracle.id(),
                "verifier_id": verifier, "collateral_token_id": token_id(&w)
            }))
            .transact()
            .await?
            .into_result()?;
        register_on_token(&w, market.id()).await?;
        w.dave
            .call(market.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(50))
            .transact()
            .await?
            .into_result()?;
        let tokens = ft_balance(&w, w.dave.id()).await;
        let r = send(&w, &w.dave, market.id(), 7 * USD, "deposit", SEND_TGAS).await?;
        assert!(r.is_success(), "{label}: {:?}", r.failures());
        assert_eq!(
            ft_balance(&w, w.dave.id()).await,
            tokens,
            "{label}: dave has it all back"
        );
        assert_eq!(ft_balance(&w, market.id()).await, 0, "{label}");
        assert_eq!(ft_balance(&w, verifier).await, 0, "{label}");
        assert_eq!(credited(&market, w.dave.id()).await, 0, "{label}");
        assert_eq!(owed(&market).await, 0, "{label}");
    }
    Ok(())
}

#[tokio::test]
async fn a_failed_token_resolve_leaves_surplus_never_a_debt() -> anyhow::Result<()> {
    let w = setup().await?;
    register_on_token(&w, w.market.id()).await?;
    let held = intents_balance(&w, w.market.id()).await;
    let owed_before = owed(&w.market).await;
    w.owner
        .call(w.ft.id(), "set_fail_resolve")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let r = send(&w, &w.alice, w.market.id(), 4 * USD, "deposit", SEND_TGAS).await?;
    assert!(
        format!("{:?}", r.receipt_failures()).contains("the resolve step is set to fail"),
        "{:?}",
        r.receipt_failures()
    );
    assert_eq!(
        credited(&w.market, w.alice.id()).await,
        0,
        "nothing is credited on a lost report"
    );
    assert_eq!(owed(&w.market).await, owed_before);
    assert_eq!(intents_balance(&w, w.market.id()).await, held + 4 * USD);
    assert_eq!(ft_balance(&w, w.market.id()).await, 0);
    Ok(())
}
