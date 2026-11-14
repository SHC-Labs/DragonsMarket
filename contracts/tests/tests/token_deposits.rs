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
    let id = new_market(&w, 600).await?;
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

    deposit_to_intents(&w, &w.dave, w.dave.id(), 15 * USD).await?;
    let r = intents_call(&w, &w.dave, w.market.id(), 15 * USD, "deposit").await?;
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
async fn an_owner_funds_an_agent_that_never_holds_the_token_and_it_trades() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 600).await?;
    register_on_token(&w, w.market.id()).await?;
    let (owner, agent) = (&w.dave, &w.alice);
    owner
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({ "account_id": agent.id() }))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    let tokens = ft_balance(&w, agent.id()).await;
    let before = credited(&w.market, agent.id()).await;
    let gift = format!("deposit_for:{}", agent.id());
    deposit_to_intents(&w, owner, owner.id(), 15 * USD).await?;
    let r = intents_call(&w, owner, w.market.id(), 15 * USD, &gift).await?;
    assert_clean(&w, "deposit for the agent", &r);
    let from = format!("\"from\":\"{}\"", owner.id());
    assert!(
        r.logs()
            .iter()
            .any(|l| l.contains("\"event\":\"deposit\"") && l.contains(&from)),
        "the deposit names who paid: {:?}",
        r.logs()
    );
    assert_eq!(credited(&w.market, agent.id()).await, before + 15 * USD);
    assert_eq!(credited(&w.market, owner.id()).await, 0);
    assert_eq!(
        ft_balance(&w, agent.id()).await,
        tokens,
        "no token ever reaches the agent"
    );
    assert_reconciled(&w).await;

    agent
        .call(w.market.id(), "buy")
        .args_json(
            json!({ "market_id": id.to_string(), "side": "yes", "amount": (5 * USD).to_string(), "min_shares": "1" }),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(credited(&w.market, agent.id()).await, before + 10 * USD);
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn a_refused_transfer_comes_back_whole_and_moves_nothing() -> anyhow::Result<()> {
    let w = setup().await?;
    register_on_token(&w, w.market.id()).await?;
    let held = intents_balance(&w, w.market.id()).await;
    let owed_before = owed(&w.market).await;
    for (from, msg, tgas) in [
        (&w.dave, "deposit", SEND_TGAS),
        (&w.dave, "register", SEND_TGAS),
        (&w.alice, "seed:0", SEND_TGAS),
        (&w.alice, "deposit", 80),
        (&w.alice, "buy:0:yes:1", SEND_TGAS),
    ] {
        let tokens = ft_balance(&w, from.id()).await;
        let r = send(&w, from, w.market.id(), 4 * USD, msg, tgas).await?;
        assert!(r.is_success(), "{msg}: the token call itself completes");
        assert!(
            format!("{:?}", r.receipt_failures()).contains("deposit into your own Intents account"),
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
async fn an_intents_buy_ends_as_shares_or_a_refund_to_user_custody() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 600).await?;
    register_on_token(&w, w.market.id()).await?;
    let held = intents_balance(&w, w.market.id()).await;

    let order = format!("buy:{id}:yes:1");
    deposit_to_intents(&w, &w.alice, w.alice.id(), 10 * USD).await?;
    let r = intents_call(&w, &w.alice, w.market.id(), 10 * USD, &order).await?;
    assert_clean(&w, "buy by token", &r);
    assert!(shares(&w, id, w.alice.id()).await.0 > 0, "the token became shares");
    assert_eq!(credited(&w.market, w.alice.id()).await, 0);
    assert_eq!(intents_balance(&w, w.market.id()).await, held + 10 * USD);
    assert_reconciled(&w).await;

    let greedy = format!("buy:{id}:no:{}", 100 * USD);
    let own = intents_balance(&w, w.alice.id()).await;
    deposit_to_intents(&w, &w.alice, w.alice.id(), 4 * USD).await?;
    let r = intents_call(&w, &w.alice, w.market.id(), 4 * USD, &greedy).await?;
    assert!(
        format!("{:?}", r.receipt_failures()).contains("price moved"),
        "{:?}",
        r.receipt_failures()
    );
    assert_eq!(
        credited(&w.market, w.alice.id()).await,
        0,
        "a refused Intents buy creates no market credit"
    );
    assert_eq!(intents_balance(&w, w.alice.id()).await, own + 4 * USD);
    assert_eq!(shares(&w, id, w.alice.id()).await.1, 0);
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn an_invalid_beneficiary_refunds_to_the_senders_own_intents_account() -> anyhow::Result<()> {
    let w = setup().await?;
    deposit_to_intents(&w, &w.dave, w.dave.id(), 5 * USD).await?;
    let own = intents_balance(&w, w.dave.id()).await;
    let held = intents_balance(&w, w.market.id()).await;
    for msg in [
        "deposit_for:nobody.near",
        "deposit_for:!",
        "deposit_for:alice.near:extra",
    ] {
        let r = intents_call(&w, &w.dave, w.market.id(), 5 * USD, msg).await?;
        assert!(!r.receipt_failures().is_empty(), "{msg} must refuse");
        assert_eq!(intents_balance(&w, w.dave.id()).await, own);
        assert_eq!(intents_balance(&w, w.market.id()).await, held);
        assert_reconciled(&w).await;
    }
    Ok(())
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
async fn a_failed_token_resolve_leaves_the_supported_deposit_in_user_custody() -> anyhow::Result<()> {
    let w = setup().await?;
    let held = intents_balance(&w, w.market.id()).await;
    let own = intents_balance(&w, w.alice.id()).await;
    w.owner
        .call(w.ft.id(), "set_fail_resolve")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let r = send(&w, &w.alice, w.verifier.id(), 4 * USD, w.alice.id().as_str(), 200).await?;
    assert!(format!("{:?}", r.receipt_failures()).contains("the resolve step is set to fail"));
    assert_eq!(credited(&w.market, w.alice.id()).await, 0);
    assert_eq!(intents_balance(&w, w.market.id()).await, held);
    assert_eq!(
        intents_balance(&w, w.alice.id()).await,
        own + 4 * USD,
        "the failed resolver cannot orphan the deposit under the market's identity"
    );
    // A separate user-authorized transfer consumes those funds, even while the FT resolver is broken.
    let r = intents_call(&w, &w.alice, w.market.id(), 4 * USD, "deposit").await?;
    assert_clean(&w, "credit from user custody", &r);
    assert_eq!(credited(&w.market, w.alice.id()).await, 4 * USD);
    assert_eq!(intents_balance(&w, w.alice.id()).await, own);
    assert_reconciled(&w).await;
    Ok(())
}
