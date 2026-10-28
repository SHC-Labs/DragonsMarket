mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

#[tokio::test]
async fn trading_keeps_the_invariant_and_never_pays_more_than_paid_in() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 600).await?;
    assert!(invariant(&w, id).await);
    let start_price = market_json(&w, id).await["price_yes"]
        .as_str()
        .unwrap()
        .parse::<u128>()?;
    assert_eq!(start_price, 500_000);
    let history = |w: &World| {
        let w_market = w.market.clone();
        async move {
            let h: serde_json::Value = w_market
                .view("get_history")
                .args_json(json!({ "market_id": id.to_string() }))
                .await
                .unwrap()
                .json()
                .unwrap();
            h.as_array()
                .unwrap()
                .iter()
                .map(|p| p["price_yes"].as_u64().unwrap())
                .collect::<Vec<_>>()
        }
    };
    assert!(history(&w).await.is_empty(), "nobody has traded yet");

    // Alice buys Yes with 10 USD in one transaction.
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    let (yes, no) = shares(&w, id, w.alice.id()).await;
    assert_eq!(
        (yes, no),
        (10 * USD - 200_000, 0),
        "the first buyer of an empty market gets a share for each unit after the fee"
    );
    assert!(invariant(&w, id).await);
    assert_eq!(
        holdings(&w, w.alice.id()).await,
        190 * USD,
        "the ten dollars left her wallet"
    );
    let price_after = market_json(&w, id).await["price_yes"]
        .as_str()
        .unwrap()
        .parse::<u128>()?;
    assert!(price_after > start_price, "buying Yes raises the Yes price");
    let h = history(&w).await;
    assert_eq!(h.len(), 1);
    assert_eq!(
        h[0] as u128, price_after,
        "the log's last point is the price the market shows"
    );

    // Bob buys No. Both sides stay consistent.
    buy(&w, &w.bob, id, "no", 20 * USD).await?;
    assert!(invariant(&w, id).await);

    // Alice sells everything back. The quote says how much she gets.
    let (out, _, fee) = quote_sell(&w, id, "yes", yes).await;
    assert!(out > 0 && out <= 10 * USD, "round trip does not print money, got {out}");
    let got = out - fee;
    sell(&w, &w.alice, id, "yes", yes, got).await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, got);
    assert!(invariant(&w, id).await);
    let h = history(&w).await;
    assert_eq!(h.len(), 3, "two buys and a sell each leave a point");
    assert!(h[2] < h[1], "selling Yes lowers the Yes price");

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
    assert_eq!(holdings(&w, w.alice.id()).await, 190 * USD + got);
    assert_eq!(
        intents_balance(&w, w.alice.id()).await,
        got,
        "the payout is in her Intents account, not her tokens"
    );
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn bad_requests_are_refused_and_money_comes_back() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 600).await?;

    // Carol never paid the storage deposit, so her buy is refused and the transfer is returned.
    let before = holdings(&w, w.carol.id()).await;
    let _ = buy(&w, &w.carol, id, "yes", 5 * USD).await;
    assert_eq!(
        holdings(&w, w.carol.id()).await,
        before,
        "refused transfer must be refunded"
    );
    assert_eq!(shares(&w, id, w.carol.id()).await, (0, 0));

    // A buy for fewer shares than the minimum is refused too.
    let before = holdings(&w, w.alice.id()).await;
    let _ = ft_call(
        &w,
        &w.alice,
        w.market.id(),
        5 * USD,
        &format!("buy:{id}:yes:999999999999"),
    )
    .await;
    assert_eq!(holdings(&w, w.alice.id()).await, before);

    // Only the oracle can set an outcome.
    let r = w
        .owner
        .call(w.market.id(), "set_outcome")
        .args_json(json!({ "market_id": id.to_string(), "outcome": "yes" }))
        .transact()
        .await?;
    assert!(r.is_failure());

    // Nobody can propose before the market closes.
    let before = holdings(&w, w.carol.id()).await;
    let _ = propose(&w, &w.carol, id, "yes").await;
    assert_eq!(holdings(&w, w.carol.id()).await, before, "early bond is refunded");
    assert!(case_json(&w, id).await.is_null());

    // A market without a void policy cannot be created.
    let t = now(&w.worker).await;
    let r = w
        .owner
        .call(w.market.id(), "create_market")
        .deposit(near_workspaces::types::NearToken::from_millinear(60))
        .args_json(json!({ "title": "t", "rule_text": "r", "resolution_source": "s", "void_policy": "  ", "category": "world", "subcategory": "science",
            "close_at": (t + 1_000_000_000_000u64).to_string(), "resolve_by": (t + 2_000_000_000_000u64).to_string() }))
        .transact()
        .await?;
    assert!(r.is_failure());

    // A category that is not a plain lowercase slug is refused too.
    let r = w
        .owner
        .call(w.market.id(), "create_market")
        .deposit(near_workspaces::types::NearToken::from_millinear(60))
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
    let id = new_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    let (alice_yes, _) = shares(&w, id, w.alice.id()).await;

    skip_secs(&w.worker, 130).await; // past close
    assert_eq!(market_json(&w, id).await["status"], "closed");
    let late = buy(&w, &w.alice, id, "yes", USD).await;
    let _ = late;
    assert_eq!(
        shares(&w, id, w.alice.id()).await.0,
        alice_yes,
        "no trading after close"
    );

    propose(&w, &w.carol, id, "yes").await?;
    assert_eq!(case_json(&w, id).await["stage"], "proposed");
    assert_eq!(holdings(&w, w.carol.id()).await, 50 * USD - BOND);

    // Too early to finalise.
    let r = w
        .oracle
        .call("finalize")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
        .transact()
        .await?;
    assert!(r.is_failure());

    skip_secs(&w.worker, 70).await; // past the 60 s window
    w.oracle
        .call("finalize")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let m = market_json(&w, id).await;
    assert_eq!(m["outcome"], "yes");
    assert_eq!(case_json(&w, id).await["applied"], true);

    // The only Yes holder redeems the whole pool, both stakes less their fees, and the loser gets nothing, long after
    // the fact.
    let pool = u(&m["locked"]);
    assert_eq!(pool, 2 * (10 * USD - 200_000));
    skip_secs(&w.worker, 600).await;
    w.alice
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_balance(&w, w.alice.id()).await, pool);
    assert!(invariant(&w, id).await);
    let r = w
        .bob
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(r.json::<String>()?, "0", "bob held No and lost");
    assert!(invariant(&w, id).await);
    assert_eq!(market_json(&w, id).await["locked"], "0");
    refused(
        w.owner
            .call(w.market.id(), "claim_residual")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result(),
        "nothing is left over",
    );

    // Carol's bond comes back.
    assert_eq!(claimable(&w, w.carol.id()).await, BOND);
    assert_oracle_reconciled(&w).await;
    withdraw_bond(&w, &w.carol).await?;
    assert_eq!(holdings(&w, w.carol.id()).await, 50 * USD);
    assert_eq!(
        intents_balance(&w, w.carol.id()).await,
        BOND,
        "the bond is back in her Intents account"
    );
    assert_oracle_reconciled(&w).await;
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn a_challenge_goes_to_the_panel_and_the_majority_decides() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;

    // After close, the owner still cannot decide the outcome. Only the oracle can.
    let r = w
        .owner
        .call(w.market.id(), "set_outcome")
        .args_json(json!({ "market_id": id.to_string(), "outcome": "yes" }))
        .transact()
        .await?;
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
    refused(
        commit(&w, &w.alice, id, "no", "s").await,
        "not on the panel for this case",
    );
    for j in &jury[..2] {
        commit(&w, j, id, "no", "salt-for-no").await?;
    }
    to_reveal_phase(&w, id).await;
    refused(
        reveal(&w, &jury[0], id, "no", "salt-for-no", " ").await,
        "a reason is required",
    );
    for j in &jury[..2] {
        reveal(&w, j, id, "no", "salt-for-no", "The source says no.").await?;
    }
    let case = case_json(&w, id).await;
    assert_eq!(case["stage"], "final");
    assert_eq!(case["final_outcome"], "no");
    assert_eq!(case["applied"], true);
    assert_eq!(market_json(&w, id).await["outcome"], "no");

    // The challenger was right. The proposer loses their bond: a quarter is split between the two jurors who revealed
    // with the majority, and the challenger takes their own bond back and the rest.
    assert_eq!(claimable(&w, w.dave.id()).await, 2 * BOND - BOND / 4);
    assert_eq!(claimable(&w, w.carol.id()).await, 0);
    assert_eq!(
        (claimable(&w, jury[0].id()).await, claimable(&w, jury[1].id()).await),
        (BOND / 8, BOND / 8)
    );
    assert_eq!(claimable(&w, jury[2].id()).await, 0);

    let pool = u(&market_json(&w, id).await["locked"]);
    w.bob
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        market_balance(&w, w.bob.id()).await,
        pool,
        "the only No holder takes the whole pool"
    );
    assert!(invariant(&w, id).await);
    Ok(())
}

// A jury of one that stays silent is no decision. A second jury of three is called for, and one of them votes. That is
// not a majority of three either, so the market is Void. The proposer gets their bond back and the challenger's bond
// goes half to the one juror who revealed and half to the proposer.
#[tokio::test]
async fn a_dispute_no_jury_settles_resolves_void_and_pays_the_bonds_as_stated() -> anyhow::Result<()> {
    let w = setup().await?;
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": 1 }))
        .transact()
        .await?
        .into_result()?;
    let id = new_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let first = draw_jury(&w, id).await?;
    assert_eq!(first.len(), 1);

    // The first jury never votes. When its time is out, a second jury is called for, and only once.
    refused(finalize(&w, id).await, "the panel still has time");
    let deadline: u64 = case_json(&w, id).await["panel_deadline"].as_str().unwrap().parse()?;
    skip_until(&w, deadline + 1).await;
    finalize(&w, id).await?;
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["round"], &case["jury_size"]),
        (&json!("disputed"), &json!(1), &json!(3))
    );
    assert!(market_json(&w, id).await["outcome"].is_null());

    let second = draw_jury(&w, id).await?;
    assert_eq!(second.len(), 3);
    assert!(
        second.iter().all(|j| j.id() != first[0].id()),
        "the second jury is other accounts than the first"
    );
    commit(&w, &second[0], id, "yes", "salt-for-yes-0123456789").await?;
    to_reveal_phase(&w, id).await;
    reveal(&w, &second[0], id, "yes", "salt-for-yes-0123456789", "Leaning yes.").await?;
    assert_eq!(
        case_json(&w, id).await["stage"],
        "disputed",
        "one vote is not a majority of three"
    );
    let deadline: u64 = case_json(&w, id).await["panel_deadline"].as_str().unwrap().parse()?;
    skip_until(&w, deadline + 1).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "void");
    assert_eq!(claimable(&w, w.carol.id()).await, 2 * BOND - BOND / 2);
    assert_eq!(claimable(&w, w.dave.id()).await, 0);
    assert_eq!(claimable(&w, second[0].id()).await, BOND / 2);
    assert_eq!(
        case_json(&w, id).await["delinquent"].as_array().unwrap().len(),
        1 + 2,
        "the silent first juror and the two silent second jurors"
    );

    // Void: each holder gets back what they put in less the fee, whatever the price did, and the invariant covers it.
    assert_eq!(market_json(&w, id).await["refunds"], true);
    for who in [&w.alice, &w.bob] {
        who.call(w.market.id(), "redeem")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result()?;
        assert_eq!(market_balance(&w, who.id()).await, 10 * USD - 200_000);
    }
    assert!(invariant(&w, id).await);
    assert_eq!(market_json(&w, id).await["locked"], "0");
    Ok(())
}

// Alice sells her Yes at a loss after Bob's No has made Yes cheap, and the market is then voided. An exit is final:
// Bob gets back what he put in, Alice keeps what her sale paid, and the loss she left in the pool is the residual,
// which goes to the treasury on the next sweep.
#[tokio::test]
async fn a_loss_taken_by_selling_before_a_void_is_the_residual_and_goes_to_the_treasury() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    let (alice_yes, _) = shares(&w, id, w.alice.id()).await;
    let (out, _, fee) = quote_sell(&w, id, "yes", alice_yes).await;
    assert!(out < 10 * USD - 200_000, "Yes is worth less now: {out}");
    sell(&w, &w.alice, id, "yes", alice_yes, out - fee).await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, out - fee);

    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "void").await?;
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "void");
    w.bob
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_balance(&w, w.bob.id()).await, 10 * USD - 200_000);

    let leftover = u(&market_json(&w, id).await["locked"]);
    assert_eq!(
        leftover,
        10 * USD - 200_000 - out,
        "what Alice paid in and did not take back out"
    );
    w.owner
        .call(w.market.id(), "claim_residual")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert!(invariant(&w, id).await);
    assert_eq!(market_json(&w, id).await["locked"], "0", "nothing stranded");
    assert_eq!(fees(&w).await.2, leftover, "the next sweep pays it on the treasury leg");
    assert_eq!(
        market_balance(&w, w.treasury.id()).await,
        0,
        "it is not a balance the treasury must withdraw"
    );
    assert_eq!(market_balance(&w, w.owner.id()).await, 0);
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn a_registered_market_is_open_at_even_odds_before_anyone_trades() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_market(&w, 600, 3_600).await?;
    let m = market_json(&w, id).await;
    assert_eq!(
        (&m["status"], &m["registered"], &m["price_yes"], &m["locked"]),
        (&json!("open"), &json!(true), &json!("500000"), &json!("0"))
    );
    buy(&w, &w.alice, id, "no", 5 * USD).await?;
    assert_eq!(market_json(&w, id).await["price_yes"], "0");
    Ok(())
}
