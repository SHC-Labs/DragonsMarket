// Quarterly claims against the real NEAR Intents verifier: fees swept by the market, revenue booked to a quarter, seats weighed by
// the time they were staked, and each seat's claim paid once. The sandbox cannot reach the end of a real quarter, so every test
// that needs a finished one files the books of the quarter it is in under an earlier quarter (see age_current_quarter in
// common). Those runs are accelerated, and the rest is the contracts' own state.
mod common;
use common::*;
use near_workspaces::Account;
use serde_json::json;

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

async fn amount_of(w: &World, quarter: u32, juror: &Account) -> u128 {
    u(&entitlement(w, quarter, tok(juror), juror.id()).await["amount"])
}

async fn weight_of(w: &World, quarter: u32, token: &str, who: &Account) -> u128 {
    u(&entitlement(w, quarter, token, who.id()).await["weight_ns"])
}

// Trades that pay a fee, and a sweep that sends the Council its share. Returns the share.
async fn fees_swept_to_the_council(w: &World) -> anyhow::Result<u128> {
    let id = new_market(w, 600).await?;
    buy(w, &w.alice, id, "yes", SWEEP_BUY).await?;
    let before = council_total_received(w).await;
    past_sweep_interval(w).await;
    sweep(w, &w.carol).await?;
    Ok(council_total_received(w).await - before)
}

#[tokio::test]
async fn fees_go_from_a_sweep_to_a_quarter_to_one_claim_per_seat_and_a_late_claim_is_still_paid() -> anyhow::Result<()>
{
    let w = setup().await?;
    let share = fees_swept_to_the_council(&w).await?;
    assert_eq!(share, COUNCIL_SHARE);
    assert_eq!(intents_balance(&w, w.council.id()).await, share);
    assert_eq!(u(&current_quarter(&w).await["revenue_in"]), share);

    // The quarter is running: nothing can be finalized or claimed yet.
    let running = current_quarter(&w).await;
    assert_eq!(running["state"], "open");
    let q = running["quarter"].as_u64().unwrap() as u32;
    refused(finalize_quarter(&w, q).await, "the quarter cannot be finalized yet");
    refused(
        claim_quarter(&w, &w.jurors[0], q, tok(&w.jurors[0])).await,
        "that quarter is not final",
    );
    let accruing = entitlement(&w, q, tok(&w.jurors[0]), w.jurors[0].id()).await;
    assert_eq!(
        (accruing["status"].as_str(), accruing["estimated"].as_bool()),
        (Some("accruing"), Some(true))
    );

    // Accelerated: the quarter ends and its grace period has passed.
    let aged = age_current_quarter(&w).await?;
    let ended = get_quarter(&w, aged).await;
    assert_eq!(
        (u(&ended["revenue_in"]), ended["state"].as_str()),
        (share, Some("closing"))
    );
    let logs = finalize_quarter(&w, aged).await?;
    let finalized = &events_named(&logs, "quarter_finalized")[0];
    assert_eq!(
        (u(&finalized["pool"]), finalized["rolled_to"].clone()),
        (share, json!(null))
    );
    refused(finalize_quarter(&w, aged).await, "that quarter is already final");

    // Each seat is paid its share once, and the Council's balance falls by what was paid.
    let mut shares = vec![];
    for j in &w.jurors {
        shares.push(amount_of(&w, aged, j).await);
    }
    assert!(
        shares.iter().all(|s| *s > 0)
            && shares.iter().sum::<u128>() <= share
            && share - shares.iter().sum::<u128>() < 5
    );
    let mut paid = 0;
    for (j, expected) in w.jurors.iter().zip(&shares).take(4) {
        let before = holdings(&w, j.id()).await;
        let logs = claim_quarter(&w, j, aged, tok(j)).await?;
        assert_eq!(claimed_in(&logs), *expected);
        assert_eq!(holdings(&w, j.id()).await - before, *expected);
        paid += expected;
        refused(claim_quarter(&w, j, aged, tok(j)).await, "already claimed");
    }
    assert_eq!(intents_balance(&w, w.council.id()).await, share - paid);
    let totals = reward_totals(&w).await;
    assert_eq!((u(&totals["total_paid"]), u(&totals["pending_claims"])), (paid, 0));
    refused(
        claim_quarter(&w, &w.alice, aged, tok(&w.jurors[4])).await,
        "nothing to claim",
    );

    // The fifth seat did not claim. Later fees land in the quarter the chain is in and never in the finished one.
    let late = fees_swept_to_the_council(&w).await?;
    assert!(late > 0);
    assert_eq!(
        u(&current_quarter(&w).await["revenue_in"]),
        late,
        "late fees are this quarter's"
    );
    assert_eq!(
        u(&get_quarter(&w, aged).await["pool"]),
        share,
        "and the finished quarter's pool did not move"
    );
    skip_secs(&w.worker, 60).await;
    let before = holdings(&w, w.jurors[4].id()).await;
    let logs = claim_quarter(&w, &w.jurors[4], aged, tok(&w.jurors[4])).await?;
    assert_eq!(claimed_in(&logs), shares[4], "an unclaimed share is still there later");
    assert_eq!(holdings(&w, w.jurors[4].id()).await - before, shares[4]);
    let totals = reward_totals(&w).await;
    assert_eq!(u(&totals["total_paid"]), shares.iter().sum::<u128>());
    assert_eq!(
        intents_balance(&w, w.council.id()).await,
        share + late - shares.iter().sum::<u128>(),
        "the Council holds the rounding dust and the late revenue"
    );
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn a_payout_the_verifier_refuses_leaves_the_claim_open_and_a_paid_claim_cannot_be_made_again(
) -> anyhow::Result<()> {
    let w = setup().await?;
    let share = fees_swept_to_the_council(&w).await?;
    let aged = age_current_quarter(&w).await?;
    finalize_quarter(&w, aged).await?;
    let j = &w.jurors[0];
    let owed = amount_of(&w, aged, j).await;
    assert!(owed > 0 && owed < share);

    // The verifier refuses the Council's payouts while its account is locked: the claim is undone and can be made again.
    lock_account(&w, w.council.id()).await?;
    let logs = claim_quarter(&w, j, aged, tok(j)).await?;
    assert_eq!(event_names(&logs), vec!["claim_requested", "claim_failed"]);
    assert_eq!(holdings(&w, j.id()).await, 0);
    assert_eq!(u(&reward_totals(&w).await["pending_claims"]), 0);
    assert_eq!(entitlement(&w, aged, tok(j), j.id()).await["status"], "claimable");
    unlock_account(&w, w.council.id()).await?;

    let logs = claim_quarter(&w, j, aged, tok(j)).await?;
    assert_eq!(claimed_in(&logs), owed);
    assert_eq!(holdings(&w, j.id()).await, owed);
    assert_eq!(entitlement(&w, aged, tok(j), j.id()).await["status"], "paid");
    refused(claim_quarter(&w, j, aged, tok(j)).await, "already claimed");
    assert_eq!(holdings(&w, j.id()).await, owed, "paid once");

    // A paused transfer feature fails the payout the same way.
    pause_transfers(&w).await?;
    let other = &w.jurors[1];
    let logs = claim_quarter(&w, other, aged, tok(other)).await?;
    assert_eq!(event_names(&logs), vec!["claim_requested", "claim_failed"]);
    unpause_transfers(&w).await?;
    assert_eq!(
        claimed_in(&claim_quarter(&w, other, aged, tok(other)).await?),
        amount_of(&w, aged, other).await
    );
    Ok(())
}

#[tokio::test]
async fn a_sweep_id_is_taken_once_and_only_the_market_sends_revenue_and_the_verifier_gives_back_the_rest(
) -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.owner.id(), 100 * USD).await?;
    mint(&w, w.dave.id(), 100 * USD).await?;
    deposit_to_intents(&w, &w.owner, w.owner.id(), 100 * USD).await?;
    deposit_to_intents(&w, &w.dave, w.dave.id(), 100 * USD).await?;
    set_council_market(&w, w.owner.id()).await?;

    // The first send of sweep 77 is taken. The second is refused by the Council and the verifier gives it back.
    intents_call(&w, &w.owner, w.council.id(), 10 * USD, "revenue:77")
        .await?
        .into_result()?;
    assert_eq!(council_total_received(&w).await, 10 * USD);
    let before = intents_balance(&w, w.owner.id()).await;
    let r = intents_call(&w, &w.owner, w.council.id(), 10 * USD, "revenue:77").await?;
    assert!(r.is_success(), "the verifier call itself succeeds");
    assert_eq!(r.json::<Vec<String>>()?, vec!["0".to_string()], "nothing was kept");
    assert_eq!(intents_balance(&w, w.owner.id()).await, before, "refunded in full");
    assert_eq!(council_total_received(&w).await, 10 * USD);
    let received: serde_json::Value = w
        .council
        .view("received_of")
        .args_json(json!({ "market": w.owner.id(), "sweep_id": "77" }))
        .await?
        .json()?;
    assert_eq!(u(&received["amount"]), 10 * USD);

    // Another account is refused whatever it sends, and so is a message that is not a sweep.
    set_council_market(&w, w.market.id()).await?;
    let before = intents_balance(&w, w.dave.id()).await;
    for msg in ["revenue:78", "revenue", "revenue:x", "deposit"] {
        let r = intents_call(&w, &w.dave, w.council.id(), 5 * USD, msg).await?;
        assert_eq!(r.json::<Vec<String>>()?, vec!["0".to_string()], "{msg}");
        assert_eq!(intents_balance(&w, w.dave.id()).await, before, "{msg}: refunded");
    }
    assert_eq!(council_total_received(&w).await, 10 * USD);
    Ok(())
}

#[tokio::test]
async fn seats_that_stake_late_or_leave_early_are_weighed_by_their_time_and_leaving_pays_nothing() -> anyhow::Result<()>
{
    let w = setup().await?;
    let j = &w.jurors;
    skip_secs(&w.worker, 30).await;

    // Two seats leave. Unstaking returns the NFT and moves no money.
    for leaver in [&j[0], &j[1]] {
        request_unstake(&w, leaver, tok(leaver)).await?;
    }
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    for leaver in [&j[0], &j[1]] {
        let before = intents_balance(&w, leaver.id()).await;
        let logs = unstake(&w, leaver, tok(leaver)).await?;
        assert_eq!(event_names(&logs), vec!["nft_transfer", "unstaked"]);
        assert_eq!(intents_balance(&w, leaver.id()).await, before);
        assert_eq!(nft_owner(&w, tok(leaver)).await, leaver.id().as_str());
    }
    // A new seat stakes late, just before the revenue arrives.
    let late = w.worker.dev_create_account().await?;
    mint_nft(&w, &late, "late").await?;
    stake(&w, &late, "late").await?;
    mint(&w, w.owner.id(), 1_000 * USD).await?;
    send_revenue(&w, 1_000 * USD).await?;
    skip_secs(&w.worker, 5).await;

    let aged = age_current_quarter(&w).await?;
    finalize_quarter(&w, aged).await?;
    let (staying, left, newcomer) = (
        weight_of(&w, aged, tok(&j[2]), &j[2]).await,
        weight_of(&w, aged, tok(&j[0]), &j[0]).await,
        weight_of(&w, aged, "late", &late).await,
    );
    assert!(
        staying >= left,
        "a seat that stayed counts at least as long as one that left: {staying} and {left}"
    );
    assert!(
        left > newcomer && newcomer > 0,
        "a seat that left after a minute counts longer than one staked just now: {left} and {newcomer}"
    );

    // The seat that left claims what it earned, and the newcomer a smaller share.
    let (left_share, new_share) = (
        u(&entitlement(&w, aged, tok(&j[0]), j[0].id()).await["amount"]),
        u(&entitlement(&w, aged, "late", late.id()).await["amount"]),
    );
    assert!(left_share > new_share && new_share > 0);
    assert_eq!(
        claimed_in(&claim_quarter(&w, &j[0], aged, tok(&j[0])).await?),
        left_share
    );
    assert_eq!(claimed_in(&claim_quarter(&w, &late, aged, "late").await?), new_share);
    assert!(!is_seat(&w, j[0].id()).await);
    Ok(())
}

#[tokio::test]
async fn a_quarter_nobody_held_a_seat_in_rolls_its_pool_into_the_next_and_has_nothing_to_claim() -> anyhow::Result<()> {
    let w = setup().await?;
    let share = fees_swept_to_the_council(&w).await?;
    let aged = age_revenue_only(&w).await?;
    let logs = finalize_quarter(&w, aged).await?;
    let finalized = &events_named(&logs, "quarter_finalized")[0];
    assert_eq!(
        (u(&finalized["pool"]), finalized["weight_ns"].as_str()),
        (share, Some("0"))
    );
    assert_eq!(finalized["rolled_to"], json!(aged + 1));
    let next = get_quarter(&w, aged + 1).await;
    assert_eq!(u(&next["carry_in"]), share, "the pool moved on");
    assert_eq!(get_quarter(&w, aged).await["rolled_to"], json!(aged + 1));
    let totals = reward_totals(&w).await;
    assert_eq!(
        (
            u(&totals["rolled"]),
            u(&totals["open_pool"]),
            u(&totals["final_unclaimed"])
        ),
        (share, share, 0)
    );
    refused(
        claim_quarter(&w, &w.jurors[0], aged, tok(&w.jurors[0])).await,
        "nothing to claim",
    );
    assert_eq!(
        intents_balance(&w, w.council.id()).await,
        share,
        "the money never left the Council"
    );
    Ok(())
}
