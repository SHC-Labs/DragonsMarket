mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

#[tokio::test]
async fn trading_keeps_the_invariant_and_never_pays_more_than_paid_in() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    assert!(invariant(&w, id).await);
    let start_price = market_json(&w, id).await["price_yes"].as_str().unwrap().parse::<u128>()?;
    assert_eq!(start_price, 500_000);
    let history = |w: &World| {
        let w_market = w.market.clone();
        async move {
            let h: serde_json::Value = w_market.view("get_history").args_json(json!({ "market_id": id.to_string() })).await.unwrap().json().unwrap();
            h.as_array().unwrap().iter().map(|p| p["price_yes"].as_u64().unwrap()).collect::<Vec<_>>()
        }
    };
    assert_eq!(history(&w).await, vec![500_000], "seeding records the opening price");

    // Alice buys Yes with 10 USD in one transaction.
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    let (yes, no) = shares(&w, id, w.alice.id()).await;
    assert!(yes > 10 * USD && no == 0, "buying at 50c returns more shares than dollars: {yes}");
    assert!(invariant(&w, id).await);
    assert_eq!(ft_balance(&w, w.alice.id()).await, 190 * USD, "the ten dollars left her wallet");
    let price_after = market_json(&w, id).await["price_yes"].as_str().unwrap().parse::<u128>()?;
    assert!(price_after > start_price, "buying Yes raises the Yes price");
    let h = history(&w).await;
    assert_eq!(h.len(), 2);
    assert_eq!(h[1] as u128, price_after, "the log's last point is the price the market shows");

    // Bob buys No. Both sides stay consistent.
    buy(&w, &w.bob, id, "no", 20 * USD).await?;
    assert!(invariant(&w, id).await);

    // Alice sells everything back. The quote says how much she gets.
    let q: serde_json::Value =
        w.market.view("quote_sell").args_json(json!({ "market_id": id.to_string(), "side": "yes", "shares": yes.to_string() })).await?.json()?;
    let out: u128 = q["collateral_out"].as_str().unwrap().parse()?;
    assert!(out > 0 && out <= 10 * USD + 5 * USD, "round trip does not print money, got {out}");
    let got = out - u(&q["fee"]);
    w.alice
        .call(w.market.id(), "sell")
        .args_json(json!({ "market_id": id.to_string(), "side": "yes", "collateral_out": out.to_string(), "max_shares_in": yes.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_balance(&w, w.alice.id()).await, got);
    assert!(invariant(&w, id).await);
    let h = history(&w).await;
    assert_eq!(h.len(), 4, "seed, two buys and a sell each leave a point");
    assert!(h[3] < h[2], "selling Yes lowers the Yes price");

    // Alice withdraws to her wallet.
    w.alice
        .call(w.market.id(), "withdraw")
        .args_json(json!({ "amount": got.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_balance(&w, w.alice.id()).await, 0);
    assert_eq!(ft_balance(&w, w.alice.id()).await, 190 * USD + got);
    Ok(())
}

#[tokio::test]
async fn bad_requests_are_refused_and_money_comes_back() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;

    // Carol never paid the storage deposit, so her buy is refused and the transfer is returned.
    let before = ft_balance(&w, w.carol.id()).await;
    let _ = buy(&w, &w.carol, id, "yes", 5 * USD).await;
    assert_eq!(ft_balance(&w, w.carol.id()).await, before, "refused transfer must be refunded");
    assert_eq!(shares(&w, id, w.carol.id()).await, (0, 0));

    // A buy for fewer shares than the minimum is refused too.
    let before = ft_balance(&w, w.alice.id()).await;
    let _ = ft_call(&w, &w.alice, w.market.id(), 5 * USD, &format!("buy:{id}:yes:999999999999")).await;
    assert_eq!(ft_balance(&w, w.alice.id()).await, before);

    // Only the oracle can set an outcome.
    let r = w.owner.call(w.market.id(), "set_outcome").args_json(json!({ "market_id": id.to_string(), "outcome": "yes" })).transact().await?;
    assert!(r.is_failure());

    // Nobody can propose before the market closes.
    let before = ft_balance(&w, w.carol.id()).await;
    let _ = propose(&w, &w.carol, id, "yes").await;
    assert_eq!(ft_balance(&w, w.carol.id()).await, before, "early bond is refunded");
    assert!(case_json(&w, id).await.is_null());

    // A market without a void policy cannot be created.
    let t = now(&w.worker).await;
    let r = w
        .owner
        .call(w.market.id(), "create_market")
        .args_json(json!({ "title": "t", "rule_text": "r", "resolution_source": "s", "void_policy": "  ", "category": "world", "subcategory": "science",
            "close_at": (t + 1_000_000_000_000u64).to_string(), "resolve_by": (t + 2_000_000_000_000u64).to_string() }))
        .transact()
        .await?;
    assert!(r.is_failure());

    // A category that is not a plain lowercase slug is refused too.
    let r = w
        .owner
        .call(w.market.id(), "create_market")
        .args_json(json!({ "title": "t", "rule_text": "r", "resolution_source": "s", "void_policy": "v", "category": "Sports!", "subcategory": "nfl",
            "close_at": (t + 1_000_000_000_000u64).to_string(), "resolve_by": (t + 2_000_000_000_000u64).to_string() }))
        .transact()
        .await?;
    assert!(r.is_failure());
    Ok(())
}

#[tokio::test]
async fn unchallenged_answer_becomes_final_and_pays_out_with_no_deadline() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    let (alice_yes, _) = shares(&w, id, w.alice.id()).await;

    skip_secs(&w.worker, 130).await; // past close
    assert_eq!(market_json(&w, id).await["status"], "closed");
    let late = buy(&w, &w.alice, id, "yes", USD).await;
    let _ = late;
    assert_eq!(shares(&w, id, w.alice.id()).await.0, alice_yes, "no trading after close");

    propose(&w, &w.carol, id, "yes").await?;
    assert_eq!(case_json(&w, id).await["stage"], "proposed");
    assert_eq!(ft_balance(&w, w.carol.id()).await, 50 * USD - BOND);

    // Too early to finalise.
    let r = w.oracle.call("finalize").args_json(json!({ "market_id": id.to_string() })).transact().await?;
    assert!(r.is_failure());

    skip_secs(&w.worker, 70).await; // past the 60 s window
    w.oracle.call("finalize").args_json(json!({ "market_id": id.to_string() })).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    let m = market_json(&w, id).await;
    assert_eq!(m["outcome"], "yes");
    assert_eq!(case_json(&w, id).await["applied"], true);

    // Winners redeem one dollar a share, losers get nothing, long after the fact.
    skip_secs(&w.worker, 600).await;
    w.alice.call(w.market.id(), "redeem").args_json(json!({ "market_id": id.to_string() })).transact().await?.into_result()?;
    assert_eq!(market_balance(&w, w.alice.id()).await, alice_yes);
    assert!(invariant(&w, id).await);
    let r = w.bob.call(w.market.id(), "redeem").args_json(json!({ "market_id": id.to_string() })).transact().await?.into_result()?;
    assert_eq!(r.json::<String>()?, "0", "bob held No and lost");
    assert!(invariant(&w, id).await);

    // The owner takes the pool's leftover. Everything owed to users stays reserved.
    w.owner.call(w.market.id(), "claim_residual").args_json(json!({ "market_id": id.to_string() })).transact().await?.into_result()?;
    assert!(invariant(&w, id).await);
    assert_eq!(market_json(&w, id).await["locked"], "0");

    // Carol's bond comes back.
    assert_eq!(claimable(&w, w.carol.id()).await, BOND);
    w.carol.call(w.oracle.id(), "withdraw_bond").deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    assert_eq!(ft_balance(&w, w.carol.id()).await, 50 * USD);
    Ok(())
}

#[tokio::test]
async fn a_challenge_goes_to_the_panel_and_the_majority_decides() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;

    // After close, the owner still cannot decide the outcome. Only the oracle can.
    let r = w.owner.call(w.market.id(), "set_outcome").args_json(json!({ "market_id": id.to_string(), "outcome": "yes" })).transact().await?;
    assert!(r.is_failure());
    assert!(market_json(&w, id).await["outcome"].is_null());

    propose(&w, &w.carol, id, "yes").await?;
    // Carol cannot challenge herself; Dave can.
    let _ = challenge(&w, &w.carol, id).await;
    assert_eq!(case_json(&w, id).await["stage"], "proposed");
    challenge(&w, &w.dave, id).await?;
    assert_eq!(case_json(&w, id).await["stage"], "disputed");

    let jury = draw_jury(&w, id).await?;
    assert_eq!(jury.len(), 3);

    // Someone off the panel cannot vote. Voting needs a reason.
    refused(commit(&w, &w.alice, id, "no", "s").await, "not on the panel for this case");
    for j in &jury[..2] {
        commit(&w, j, id, "no", "salt-for-no").await?;
    }
    to_reveal_phase(&w, id).await;
    refused(reveal(&w, &jury[0], id, "no", "salt-for-no", " ").await, "a reason is required");
    for j in &jury[..2] {
        reveal(&w, j, id, "no", "salt-for-no", "The source says no.").await?;
    }
    let case = case_json(&w, id).await;
    assert_eq!(case["stage"], "final");
    assert_eq!(case["final_outcome"], "no");
    assert_eq!(case["applied"], true);
    assert_eq!(market_json(&w, id).await["outcome"], "no");

    // The challenger was right and takes both bonds. The proposer loses theirs.
    assert_eq!(claimable(&w, w.dave.id()).await, 2 * BOND);
    assert_eq!(claimable(&w, w.carol.id()).await, 0);

    let (_, bob_no) = shares(&w, id, w.bob.id()).await;
    w.bob.call(w.market.id(), "redeem").args_json(json!({ "market_id": id.to_string() })).transact().await?.into_result()?;
    assert_eq!(market_balance(&w, w.bob.id()).await, bob_no);
    assert!(invariant(&w, id).await);
    Ok(())
}

#[tokio::test]
async fn a_dispute_the_panel_does_not_settle_resolves_void_and_returns_both_bonds() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    let (ay, _) = shares(&w, id, w.alice.id()).await;
    let (_, bn) = shares(&w, id, w.bob.id()).await;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;

    // One vote is not a majority of three. Time runs out.
    commit(&w, &jury[0], id, "yes", "s0").await?;
    commit(&w, &jury[1], id, "no", "s1").await?;
    to_reveal_phase(&w, id).await;
    reveal(&w, &jury[0], id, "yes", "s0", "Leaning yes.").await?;
    reveal(&w, &jury[1], id, "no", "s1", "Leaning no.").await?;
    assert_eq!(case_json(&w, id).await["stage"], "disputed");
    refused(finalize(&w, id).await, "the panel still has time");

    let deadline: u64 = case_json(&w, id).await["panel_deadline"].as_str().unwrap().parse()?;
    skip_until(&w, deadline + 1).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "void");
    assert_eq!(claimable(&w, w.carol.id()).await, BOND);
    assert_eq!(claimable(&w, w.dave.id()).await, BOND);

    // Void: every share is worth half a dollar, and the invariant covers it.
    w.alice.call(w.market.id(), "redeem").args_json(json!({ "market_id": id.to_string() })).transact().await?.into_result()?;
    w.bob.call(w.market.id(), "redeem").args_json(json!({ "market_id": id.to_string() })).transact().await?.into_result()?;
    assert_eq!(market_balance(&w, w.alice.id()).await, ay / 2);
    assert_eq!(market_balance(&w, w.bob.id()).await, bn / 2);
    assert!(invariant(&w, id).await);
    Ok(())
}
