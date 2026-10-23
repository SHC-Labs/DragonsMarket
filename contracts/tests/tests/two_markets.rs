// Two market contracts on one oracle and one Council. Both are allowed, both use market id 0 and sweep id 1, and neither
// touches the other's cases or books.
mod common;
use common::*;
use near_workspaces::types::NearToken;
use near_workspaces::Contract;
use serde_json::json;

// A World whose market is a second instance of the market contract, so every helper acts on it.
async fn second_world(w: &World) -> anyhow::Result<World> {
    let market = w.worker.dev_deploy(&wasm("market")).await?;
    market
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "operator_id": w.owner.id(), "oracle_id": w.oracle.id(),
            "verifier_id": w.verifier.id(), "collateral_token_id": token_id(w)
        }))
        .transact()
        .await?
        .into_result()?;
    w.owner
        .call(market.id(), "set_fee_recipients")
        .args_json(json!({ "revenue_pool": w.council.id(), "treasury": w.treasury.id() }))
        .transact()
        .await?
        .into_result()?;
    w.owner
        .call(market.id(), "set_min_sweep")
        .args_json(json!({ "min_sweep": "1" }))
        .transact()
        .await?
        .into_result()?;
    for who in [&w.owner, &w.alice] {
        who.call(market.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(50))
            .transact()
            .await?
            .into_result()?;
    }
    for (contract, method) in [(w.oracle.id(), "allow_market"), (w.council.id(), "allow_market")] {
        w.owner
            .call(contract, method)
            .args_json(json!({ "market": market.id() }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(World {
        worker: w.worker.clone(),
        verifier: w.verifier.clone(),
        ft: w.ft.clone(),
        market,
        oracle: w.oracle.clone(),
        council: w.council.clone(),
        nft: w.nft.clone(),
        owner: w.owner.clone(),
        alice: w.alice.clone(),
        bob: w.bob.clone(),
        carol: w.carol.clone(),
        dave: w.dave.clone(),
        treasury: w.treasury.clone(),
        jurors: w.jurors.clone(),
    })
}

async fn received(w: &World, market: &Contract, sweep_id: &str) -> serde_json::Value {
    w.council
        .view("received_of")
        .args_json(json!({ "market": market.id(), "sweep_id": sweep_id }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

#[tokio::test]
async fn two_markets_share_one_oracle_and_one_council_without_colliding() -> anyhow::Result<()> {
    let w1 = setup().await?;
    w1.owner
        .call(w1.market.id(), "set_min_sweep")
        .args_json(json!({ "min_sweep": "1" }))
        .transact()
        .await?
        .into_result()?;
    let w2 = second_world(&w1).await?;
    let markets = json!([w1.market.id(), w2.market.id()]);
    assert_eq!(config(&w1.oracle).await["markets"], markets);
    assert_eq!(config(&w1.council).await["markets"], markets);

    // A third account is not allowed to register markets.
    refused(
        w1.dave
            .call(w1.oracle.id(), "register_market")
            .args_json(json!({ "market_id": "9", "close_at": "1", "resolve_by": "2", "rule_hash": "x" }))
            .transact()
            .await?
            .into_result(),
        "that market contract is not allowed",
    );

    // Both markets have a market 0, trade, and sweep their fees under sweep id 1.
    let (id1, id2) = (
        create_seeded_market(&w1, 600).await?,
        create_seeded_market(&w2, 600).await?,
    );
    assert_eq!((id1, id2), (0, 0));
    buy(&w1, &w1.alice, 0, "yes", 10 * USD).await?;
    buy(&w2, &w2.alice, 0, "yes", 10 * USD).await?;
    sweep(&w1, &w1.carol).await?;
    sweep(&w2, &w2.carol).await?;
    let (first, second) = (
        received(&w1, &w1.market, "1").await,
        received(&w1, &w2.market, "1").await,
    );
    assert!(!first.is_null() && !second.is_null(), "{first} {second}");
    assert_eq!(u(&first["amount"]), u(&second["amount"]));
    assert_eq!(
        council_total_received(&w1).await,
        u(&first["amount"]) + u(&second["amount"]),
        "the same sweep id from two markets was taken twice"
    );

    // The same market id is a separate case in each market, answered differently and applied to its own market.
    skip_secs(&w1.worker, 601).await;
    propose(&w1, &w1.carol, 0, "yes").await?;
    propose(&w2, &w2.carol, 0, "no").await?;
    let (case1, case2) = (case_json(&w1, 0).await, case_json(&w2, 0).await);
    assert_ne!(case1["case_uid"], case2["case_uid"]);
    assert_eq!((&case1["proposed"], &case2["proposed"]), (&json!("yes"), &json!("no")));

    // Taking the second market off the oracle leaves its open case able to finish.
    w1.owner
        .call(w1.oracle.id(), "disallow_market")
        .args_json(json!({ "market": w2.market.id() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(config(&w1.oracle).await["markets"], json!([w1.market.id()]));
    skip_secs(&w1.worker, WINDOW_MS / 1000 + 1).await;
    finalize(&w1, 0).await?;
    finalize(&w2, 0).await?;
    assert_eq!(market_json(&w1, 0).await["outcome"], "yes");
    assert_eq!(market_json(&w2, 0).await["outcome"], "no");
    assert!(invariant(&w1, 0).await && invariant(&w2, 0).await);
    Ok(())
}
