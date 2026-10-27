mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
const RESERVE: u128 = 1_000_000_000_000_000_000_000_000;
const PAID_STORAGE: u128 = 50_090_000_000_000_000_000_000;

#[tokio::test]
async fn exempt_positions_page_beyond_a_window_with_transaction_measured_gas() -> anyhow::Result<()> {
    let w = setup().await?;
    const COUNT: u64 = 105;
    deposit_to_intents(&w, &w.owner, w.owner.id(), COUNT as u128 * 3 * USD).await?;
    assert_eq!(bulk_seeded_markets(&w, COUNT, Some("600000")).await?, 0);
    assert!(w
        .market
        .view("positions_are_paged")
        .args_json(json!({"account_id": w.owner.id()}))
        .await?
        .json::<bool>()?);
    let mut ids = vec![];
    for cursor in [0, 50, 100] {
        let result = w
            .carol
            .call(w.market.id(), "get_positions")
            .args_json(json!({"account_id": w.owner.id(), "from_market": cursor.to_string(), "limit": "50"}))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        let gas = result.total_gas_burnt.as_gas() as f64 / 1e12;
        let page: Vec<Value> = result.into_result()?.json()?;
        println!(
            "exempt positions from {cursor}, {COUNT} held markets: {gas:.3} TGas, {} positions",
            page.len()
        );
        assert!(gas < 200.0);
        assert_eq!(page.len(), if cursor == 100 { 5 } else { 50 });
        ids.extend(
            page.iter()
                .map(|p| p["market_id"].as_str().unwrap().parse::<u64>().unwrap()),
        );
    }
    assert_eq!(ids, (0..COUNT).collect::<Vec<_>>());
    let account: Value = w
        .market
        .view("get_account")
        .args_json(json!({"account_id": w.owner.id()}))
        .await?
        .json()?;
    assert_eq!(account["positions"], COUNT);
    let seeded = market_json(&w, 104).await;
    assert_eq!(seeded["seeder"]["account_id"], w.owner.id().as_str());
    assert_eq!(seeded["holders"], 1);
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn funded_maximum_text_growth_keeps_withdrawals_open_at_the_reserve_floor() -> anyhow::Result<()> {
    let w = setup().await?;
    ft_call(&w, &w.alice, w.market.id(), 20 * USD, "deposit").await?;
    let before = w.worker.view_account(w.market.id()).await?;
    let before_bytes = before.storage_usage;
    w.worker
        .patch(w.market.id())
        .account(
            near_workspaces::AccountDetailsPatch::from(before).balance(NearToken::from_yoctonear(
                before_bytes as u128 * BYTE_COST + RESERVE + PAID_STORAGE,
            )),
        )
        .transact()
        .await?;
    for id in 0..12 {
        let close = now(&w.worker).await + 86_400_000_000_000;
        let outcome = w
            .owner
            .call(w.market.id(), "create_market")
            .deposit(NearToken::from_yoctonear(PAID_STORAGE))
            .args_json(
                json!({"title":"t".repeat(200),"rule_text":"r".repeat(2000),"resolution_source":"s".repeat(300),
                "void_policy":"v".repeat(500),"category":"c".repeat(32),"subcategory":"s".repeat(32),
                "close_at":close.to_string(),"resolve_by":(close + 3_600_000_000_000).to_string()}),
            )
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        assert_eq!(outcome.json::<String>()?, id.to_string());
    }
    let after = w.worker.view_account(w.market.id()).await?;
    let growth = after.storage_usage - before_bytes;
    println!(
        "12 maximum-text records: {growth} bytes; funded by {} yoctoNEAR",
        12 * PAID_STORAGE
    );
    assert!(growth as u128 * BYTE_COST <= 12 * PAID_STORAGE);
    let after_bytes = after.storage_usage;
    w.worker
        .patch(w.market.id())
        .account(
            near_workspaces::AccountDetailsPatch::from(after)
                .balance(NearToken::from_yoctonear(after_bytes as u128 * BYTE_COST + RESERVE / 2)),
        )
        .transact()
        .await?;
    let close = now(&w.worker).await + 86_400_000_000_000;
    let refused = w.owner.call(w.market.id(), "create_market").deposit(NearToken::from_yoctonear(PAID_STORAGE))
        .args_json(json!({"title":"x","rule_text":"x","resolution_source":"x","void_policy":"x", "category":"world","subcategory":"science",
            "close_at":close.to_string(),"resolve_by":(close + 3_600_000_000_000).to_string()}))
        .gas(Gas::from_tgas(100)).transact().await?;
    assert!(format!("{:?}", refused.failures()).contains("storage reserve reached"));
    assert_eq!(config(&w.market).await["markets"], "12");
    let held = intents_balance(&w, w.alice.id()).await;
    w.alice
        .call(w.market.id(), "withdraw")
        .args_json(json!({"amount":(20 * USD).to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_balance(&w, w.alice.id()).await, 0);
    assert_eq!(intents_balance(&w, w.alice.id()).await, held + 20 * USD);
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn pruning_clears_text_but_keeps_short_records_and_money() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_market(&w, 120, 3_600).await?;
    ft_call(&w, &w.owner, w.market.id(), SEED, &format!("seed:{id}:600000")).await?;
    skip_secs(&w.worker, 125).await;
    propose(&w, &w.carol, id, "yes").await?;
    let case = case_json(&w, id).await;
    skip_until(&w, case["window_ends_at"].as_str().unwrap().parse()?).await;
    finalize(&w, id).await?;
    let refused = w
        .alice
        .call(w.market.id(), "prune_market")
        .args_json(json!({"market_id":id.to_string()}))
        .transact()
        .await?;
    assert!(format!("{:?}", refused.failures()).contains("holders must redeem"));
    w.owner
        .call(w.market.id(), "redeem")
        .args_json(json!({"market_id":id.to_string()}))
        .transact()
        .await?
        .into_result()?;
    let owed: Value = w.market.view("owed_breakdown").await?.json()?;
    let fees_before = fees(&w).await;
    let previous = market_json(&w, id).await;
    let bytes_before = storage_used(&w, w.market.id()).await?;
    w.alice
        .call(w.market.id(), "prune_market")
        .args_json(json!({"market_id":id.to_string()}))
        .transact()
        .await?
        .into_result()?;
    let short = market_json(&w, id).await;
    assert_eq!(short["pruned"], true);
    assert_eq!(short["title"], "");
    assert_eq!(short["holders"], 0);
    for field in ["id", "rule_hash", "outcome", "locked", "price_yes", "price_no"] {
        assert_eq!(short[field], previous[field]);
    }
    assert_eq!(w.market.view("owed_breakdown").await?.json::<Value>()?, owed);
    assert_eq!(fees(&w).await, fees_before);
    assert!(storage_used(&w, w.market.id()).await? < bytes_before);
    assert_reconciled(&w).await;
    Ok(())
}
