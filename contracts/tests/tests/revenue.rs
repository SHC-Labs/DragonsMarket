// Trading fees and the 25/75 sweep to the Council and the treasury. Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

// The fee formula from spec section 4, with p = collateral / shares the trade's average price.
fn fee_shape(collateral: u128, shares: u128) -> u128 {
    (200 * collateral * (shares - collateral)).div_ceil(10_000 * shares)
}

#[tokio::test]
async fn trades_pay_the_quoted_fee_and_redeem_and_withdraw_pay_none() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    assert_eq!(fees(&w).await, (CREATE_FEE, 0, 0), "the seed paid the creation fee");
    assert_eq!(u(&market_json(&w, id).await["locked"]), SEED - CREATE_FEE);

    // 10 USD at 50c: the whole amount would buy 19,082,568 shares, an average price of 0.524, so the fee is
    // 2% x 19,082,568 x 0.524 x 0.476 = 95,193 and the remaining 9,904,807 buys 18,908,779 shares.
    assert_eq!(quote_buy(&w, id, "yes", 10 * USD).await, (18_908_779, 95_193));
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    assert_eq!(shares(&w, id, w.alice.id()).await, (18_908_779, 0));
    assert_eq!(fees(&w).await.0, CREATE_FEE + 95_193);
    assert_eq!(
        u(&market_json(&w, id).await["locked"]),
        SEED - CREATE_FEE + 10 * USD - 95_193
    );
    assert!(invariant(&w, id).await);

    let (bob_shares, bob_fee) = quote_buy(&w, id, "no", 20 * USD).await;
    buy(&w, &w.bob, id, "no", 20 * USD).await?;
    assert_eq!(shares(&w, id, w.bob.id()).await, (0, bob_shares));
    assert_eq!(fees(&w).await.0, CREATE_FEE + 95_193 + bob_fee);
    assert!(invariant(&w, id).await);

    // Alice sells half. The quoted fee has the documented shape and is what she is charged.
    let (c, s, f) = quote_sell(&w, id, "yes", 18_908_779 / 2).await;
    assert_eq!(f, fee_shape(c, s));
    sell(&w, &w.alice, id, "yes", c, s).await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, c - f);
    assert_eq!(shares(&w, id, w.alice.id()).await.0, 18_908_779 - s);
    let collected = CREATE_FEE + 95_193 + bob_fee + f;
    assert_eq!(fees(&w).await.0, collected);
    assert!(invariant(&w, id).await);

    // Resolved Yes. Redeeming pays one unit a share and withdrawing moves the whole balance: no fee on either.
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;
    w.alice
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    let balance = c - f + 18_908_779 - s;
    assert_eq!(market_balance(&w, w.alice.id()).await, balance);
    let before = holdings(&w, w.alice.id()).await;
    w.alice
        .call(w.market.id(), "withdraw")
        .args_json(json!({ "amount": balance.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(holdings(&w, w.alice.id()).await, before + balance);
    assert_eq!(fees(&w).await, (collected, 0, 0));
    assert!(invariant(&w, id).await);
    Ok(())
}

#[tokio::test]
async fn a_sweep_sends_25_percent_to_the_council_and_75_to_the_treasury_once() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    let collected = CREATE_FEE + 95_193;
    assert_eq!(collected % 4, 1, "neither share is a whole number of units");
    let (council_before, treasury_before) = (holdings(&w, w.council.id()).await, holdings(&w, w.treasury.id()).await);

    // Anyone can sweep. Both shares round down and the one unit left over stays collected.
    let logs = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>();
    let events = event_names(&logs);
    assert_eq!(events.first().map(String::as_str), Some("fees_swept"), "{logs:?}");
    assert_eq!(events.iter().filter(|e| *e == "fee_leg_settled").count(), 2, "{logs:?}");
    assert!(
        events.contains(&"revenue".to_string()),
        "the Council's receipt logged: {logs:?}"
    );
    let swept = &events_named(&logs, "fees_swept")[0];
    assert_eq!(
        (
            swept["id"].as_str(),
            swept["council"].as_str(),
            swept["treasury"].as_str(),
            swept["total"].as_str()
        ),
        (Some("1"), Some("273798"), Some("821394"), Some("1095193"))
    );
    assert_eq!(holdings(&w, w.council.id()).await - council_before, 273_798);
    assert_eq!(holdings(&w, w.treasury.id()).await - treasury_before, 821_394);
    assert_eq!(fees(&w).await, (1, 0, 0));
    let record: serde_json::Value = w
        .market
        .view("get_sweep")
        .args_json(json!({ "sweep_id": "1" }))
        .await?
        .json()?;
    assert_eq!(
        (
            record["council"]["status"].as_str(),
            record["treasury"]["status"].as_str()
        ),
        (Some("settled"), Some("settled"))
    );
    assert_eq!(record["council"]["to"], json!(w.council.id()));
    assert_eq!(record["treasury"]["to"], json!(w.treasury.id()));

    // The Council took it as revenue of the quarter it arrived in, under the sweep's id.
    let received: serde_json::Value = w
        .council
        .view("received_of")
        .args_json(json!({ "sweep_id": "1" }))
        .await?
        .json()?;
    assert_eq!(u(&received["amount"]), 273_798);
    assert_eq!(received["quarter"], current_quarter(&w).await["quarter"]);
    assert_eq!(u(&current_quarter(&w).await["revenue_in"]), 273_798);
    assert_eq!(council_total_received(&w).await, 273_798);
    assert_reconciled(&w).await;

    // Nothing new: a second sweep sends nothing, takes no id and changes nothing.
    let logs = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>();
    assert!(event_names(&logs).is_empty(), "{logs:?}");
    assert_eq!(holdings(&w, w.council.id()).await - council_before, 273_798);
    assert_eq!(holdings(&w, w.treasury.id()).await - treasury_before, 821_394);
    assert_eq!(fees(&w).await, (1, 0, 0));
    assert!(w
        .market
        .view("get_sweep")
        .args_json(json!({ "sweep_id": "2" }))
        .await?
        .json::<serde_json::Value>()?
        .is_null());
    Ok(())
}

// Receiving in the verifier needs no registration anywhere, so a new treasury is paid on the next sweep with no setup.
// A payout that fails is covered where the verifier refuses it (hardening.rs).
#[tokio::test]
async fn a_treasury_that_never_registered_anywhere_is_paid_its_share() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    let new_treasury = w.worker.dev_create_account().await?;
    w.owner
        .call(w.market.id(), "set_fee_recipients")
        .args_json(json!({ "revenue_pool": w.council.id(), "treasury": new_treasury.id() }))
        .transact()
        .await?
        .into_result()?;
    let council_before = intents_balance(&w, w.council.id()).await;
    let logs = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>();
    assert!(!event_names(&logs).contains(&"fee_transfer_failed".to_string()));
    assert_eq!(intents_balance(&w, new_treasury.id()).await, 821_394);
    assert_eq!(
        ft_balance(&w, new_treasury.id()).await,
        0,
        "paid in the verifier, not in tokens"
    );
    assert_eq!(intents_balance(&w, w.council.id()).await - council_before, 273_798);
    assert_eq!(fees(&w).await, (1, 0, 0));
    assert_reconciled(&w).await;
    Ok(())
}

// Fail closed: a market that nobody has told where fees go refuses to sweep, and a Council that nobody has told which market to
// trust takes no revenue and pays no claim.
#[tokio::test]
async fn nothing_is_swept_or_claimed_until_the_owner_has_configured_the_recipients() -> anyhow::Result<()> {
    let w = setup_unconfigured().await?;
    let cfg = config(&w.market).await;
    assert_eq!((&cfg["revenue_pool"], &cfg["treasury"]), (&json!(null), &json!(null)));
    assert_eq!(
        (
            &config(&w.council).await["market"],
            &config(&w.council).await["nft_contract"]
        ),
        (&json!(null), &json!(w.nft.id()))
    );
    let id = create_seeded_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    let collected = fees(&w).await.0;
    refused(
        sweep(&w, &w.carol).await,
        "the fee recipients are not set, the owner must call set_fee_recipients before a sweep",
    );
    assert_eq!(fees(&w).await, (collected, 0, 0), "a refused sweep changed nothing");
    assert_reconciled(&w).await;

    // The recipients are set but the Council has no market: it refuses the revenue and the verifier gives it back.
    w.owner
        .call(w.market.id(), "set_fee_recipients")
        .args_json(json!({ "revenue_pool": w.council.id(), "treasury": w.treasury.id() }))
        .transact()
        .await?
        .into_result()?;
    w.owner
        .call(w.market.id(), "set_min_sweep")
        .args_json(json!({ "min_sweep": "1" }))
        .transact()
        .await?
        .into_result()?;
    let logs = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>();
    assert!(
        event_names(&logs).contains(&"fee_transfer_failed".to_string()),
        "{logs:?}"
    );
    assert_eq!(council_total_received(&w).await, 0);
    assert_eq!(
        intents_balance(&w, w.treasury.id()).await,
        821_394,
        "the treasury leg did not wait for the Council's"
    );
    assert_eq!(fees(&w).await, (1, 273_798, 0), "the Council's share is due again");
    refused(
        claim_quarter(&w, &w.jurors[0], 0, w.jurors[0].id().as_str()).await,
        "the Council is not configured, the owner must call set_market",
    );
    assert_reconciled(&w).await;
    Ok(())
}

// One leg failing must not touch the other, spend backing, or be paid twice when it is retried.
#[tokio::test]
async fn a_council_leg_that_fails_leaves_the_treasury_leg_alone_and_is_retried_once() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    w.owner
        .call(w.market.id(), "set_min_sweep")
        .args_json(json!({ "min_sweep": "1" }))
        .transact()
        .await?
        .into_result()?;
    // The Council trusts another account as its market, so it refuses the sweep.
    set_council_market(&w, w.dave.id()).await?;
    let (council_before, treasury_before) = (holdings(&w, w.council.id()).await, holdings(&w, w.treasury.id()).await);
    sweep(&w, &w.carol).await?;
    assert_eq!(
        holdings(&w, w.treasury.id()).await - treasury_before,
        821_394,
        "the treasury leg was paid"
    );
    assert_eq!(
        holdings(&w, w.council.id()).await,
        council_before,
        "the Council's leg was given back"
    );
    assert_eq!(fees(&w).await, (1, 273_798, 0));
    let first: serde_json::Value = w
        .market
        .view("get_sweep")
        .args_json(json!({ "sweep_id": "1" }))
        .await?
        .json()?;
    assert_eq!(
        (
            first["council"]["status"].as_str(),
            first["treasury"]["status"].as_str()
        ),
        (Some("refused"), Some("settled"))
    );
    assert_reconciled(&w).await;

    // The owner points the Council at the market again. The retry is a sweep of its own under a new id and carries the
    // refused amount once. The treasury has nothing more to be paid.
    set_council_market(&w, w.market.id()).await?;
    past_sweep_interval(&w).await;
    sweep(&w, &w.carol).await?;
    assert_eq!(holdings(&w, w.council.id()).await - council_before, 273_798);
    assert_eq!(
        holdings(&w, w.treasury.id()).await - treasury_before,
        821_394,
        "the treasury was paid once"
    );
    assert_eq!(fees(&w).await, (1, 0, 0));
    let second: serde_json::Value = w
        .market
        .view("get_sweep")
        .args_json(json!({ "sweep_id": "2" }))
        .await?
        .json()?;
    assert_eq!(
        (
            second["council"]["amount"].as_str(),
            second["carried_council"].as_str(),
            second["treasury"]["status"].as_str()
        ),
        (Some("273798"), Some("273798"), Some("settled"))
    );
    let received: serde_json::Value = w
        .council
        .view("received_of")
        .args_json(json!({ "sweep_id": "1" }))
        .await?
        .json()?;
    assert!(received.is_null(), "the Council never took sweep 1");
    assert_eq!(council_total_received(&w).await, 273_798);
    assert_reconciled(&w).await;
    Ok(())
}
