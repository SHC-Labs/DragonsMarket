// Pay by arrival against the real NEAR Intents verifier: a seat staked on a UTC day starts earning at the next midnight, every
// sweep is split equally among the seats earning when it arrives, and a finished quarter's earnings are claimable for good.
// The sandbox is always inside some UTC quarter and a block takes real time, so a test that needs a midnight to pass or a
// quarter to end edits the Council's day ledger first (see back_date, to_next_day and end_quarters in common).
mod common;
use common::*;
use near_workspaces::Account;
use serde_json::json;

const ACC_SCALE: u128 = 1_000_000_000_000_000_000;

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

// A seat staked now that has not started earning.
async fn stake_new(w: &World, who: &Account, token: &str) -> anyhow::Result<()> {
    mint_nft(w, who, token).await?;
    stake(w, who, token).await
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

// The quarter the seats were back-dated into ends, and the Council catches up with the days since.
async fn close_the_quarter(w: &World) -> anyhow::Result<()> {
    end_quarters(w, 1).await?;
    advance_days(w).await?;
    Ok(())
}

#[tokio::test]
async fn fees_go_from_a_sweep_to_a_share_per_seat_and_a_finished_quarter_is_claimable_once_and_later(
) -> anyhow::Result<()> {
    let w = setup().await?;
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 1_000 * USD).await?;
    let share = fees_swept_to_the_council(&w).await?;
    assert_eq!(share, COUNCIL_SHARE);
    assert_eq!(intents_balance(&w, w.council.id()).await, share);
    let each = share / 5;
    for j in &w.jurors {
        assert_eq!(in_progress_of(&w, j.id()).await, each);
        assert_eq!(claimable_of(&w, j.id()).await, 0, "the quarter is still running");
        assert_eq!(seat_earnings(&w, tok(j)).await["state"], "earning");
        refused(claim(&w, j, &[tok(j)]).await, "nothing to claim");
    }

    close_the_quarter(&w).await?;
    let closed = running_quarter(&w).await - 1;
    assert_eq!(quarter_snapshots(&w).await.last(), Some(&(closed, each * ACC_SCALE)));
    let mut paid = 0;
    for j in w.jurors.iter().take(4) {
        assert_eq!(claimable_of(&w, j.id()).await, each);
        assert_eq!(in_progress_of(&w, j.id()).await, 0);
        let before = holdings(&w, j.id()).await;
        let logs = claim(&w, j, &[tok(j)]).await?;
        assert_eq!(claimed_in(&logs), each);
        assert_eq!(holdings(&w, j.id()).await - before, each);
        paid += each;
        refused(claim(&w, j, &[tok(j)]).await, "nothing to claim");
    }
    assert_eq!(intents_balance(&w, w.council.id()).await, share - paid);
    let totals = reward_totals(&w).await;
    assert_eq!((u(&totals["total_paid"]), u(&totals["pending_claims"])), (paid, 0));

    // The fifth seat did not claim. Fees that arrive now belong to the running quarter, so its claim holds the finished one.
    send_revenue(&w, 500 * USD).await?;
    let fifth = &w.jurors[4];
    assert_eq!(claimable_of(&w, fifth.id()).await, each);
    assert_eq!(in_progress_of(&w, fifth.id()).await, 100 * USD);
    let before = holdings(&w, fifth.id()).await;
    assert_eq!(claimed_in(&claim(&w, fifth, &[tok(fifth)]).await?), each);
    assert_eq!(holdings(&w, fifth.id()).await - before, each);
    assert_eq!(
        intents_balance(&w, w.council.id()).await,
        share + 500 * USD - paid - each,
        "the Council holds the running quarter's money and the finished quarter that was not claimed, and the rounding"
    );
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn a_seat_staked_today_earns_nothing_from_a_sweep_today_and_its_full_share_from_one_after_midnight(
) -> anyhow::Result<()> {
    let w = setup().await?;
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 2_000 * USD).await?;
    stake_new(&w, &w.alice, "newcomer").await?;
    let waiting = seat_earnings(&w, "newcomer").await;
    assert_eq!(waiting["state"], "waiting");
    let starts: u64 = waiting["earning_from"].as_str().unwrap().parse()?;
    assert_eq!(starts % NS_PER_DAY, 0, "a seat starts at 00:00 UTC");
    assert!(starts > now(&w.worker).await);

    send_revenue(&w, 500 * USD).await?;
    assert_eq!(
        in_progress_of(&w, w.alice.id()).await,
        0,
        "the newcomer is not paid for today's sweep"
    );
    for j in &w.jurors {
        assert_eq!(in_progress_of(&w, j.id()).await, 100 * USD);
    }

    to_next_day(&w).await?;
    assert_eq!(seat_earnings(&w, "newcomer").await["state"], "earning");
    send_revenue(&w, 600 * USD).await?;
    assert_eq!(config(&w.council).await["active_seats"], 6);
    assert_eq!(
        in_progress_of(&w, w.alice.id()).await,
        100 * USD,
        "a sixth of the sweep, and none of the one before"
    );
    for j in &w.jurors {
        assert_eq!(in_progress_of(&w, j.id()).await, 200 * USD);
    }
    refused(claim(&w, &w.alice, &["newcomer"]).await, "nothing to claim");

    close_the_quarter(&w).await?;
    let before = holdings(&w, w.alice.id()).await;
    let logs = claim(&w, &w.alice, &["newcomer"]).await?;
    assert_eq!(claimed_in(&logs), 100 * USD);
    assert_eq!(holdings(&w, w.alice.id()).await - before, 100 * USD);
    Ok(())
}

#[tokio::test]
async fn seats_that_started_on_different_days_split_each_sweep_by_who_was_earning() -> anyhow::Result<()> {
    let w = setup().await?;
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 3_000 * USD).await?;
    stake_new(&w, &w.alice, "alice-seat").await?;
    send_revenue(&w, 500 * USD).await?;

    to_next_day(&w).await?;
    stake_new(&w, &w.bob, "bob-seat").await?;
    send_revenue(&w, 600 * USD).await?;

    to_next_day(&w).await?;
    send_revenue(&w, 700 * USD).await?;
    close_the_quarter(&w).await?;

    // Five seats shared the first sweep, six the second and seven the third: 100 USD a seat each time.
    for j in &w.jurors {
        assert_eq!(claimable_of(&w, j.id()).await, 300 * USD);
    }
    assert_eq!(claimable_of(&w, w.alice.id()).await, 200 * USD);
    assert_eq!(claimable_of(&w, w.bob.id()).await, 100 * USD);
    assert_eq!(config(&w.council).await["active_seats"], 7);
    let totals = reward_totals(&w).await;
    assert_eq!(u(&totals["total_received"]), 1_800 * USD);
    assert_eq!(u(&totals["carry"]), 0);
    Ok(())
}

#[tokio::test]
async fn a_sweep_with_no_earning_seat_is_carried_and_shared_at_the_next() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.owner.id(), 1_000 * USD).await?;
    send_revenue(&w, 100 * USD).await?;
    let totals = reward_totals(&w).await;
    assert_eq!(
        (u(&totals["carry"]), u(&totals["total_received"])),
        (100 * USD, 100 * USD)
    );
    for j in &w.jurors {
        assert_eq!(in_progress_of(&w, j.id()).await, 0, "every seat was staked today");
    }

    to_next_day(&w).await?;
    send_revenue(&w, 400 * USD).await?;
    assert_eq!(u(&reward_totals(&w).await["carry"]), 0);
    for j in &w.jurors {
        assert_eq!(
            in_progress_of(&w, j.id()).await,
            100 * USD,
            "the carried sweep is shared too"
        );
    }
    assert_eq!(
        intents_balance(&w, w.council.id()).await,
        500 * USD,
        "the money never left the Council"
    );
    Ok(())
}

#[tokio::test]
async fn a_claim_pays_through_the_verifier_by_exactly_what_claimable_of_said() -> anyhow::Result<()> {
    let w = setup().await?;
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 1_000 * USD).await?;
    send_revenue(&w, 777 * USD + 3).await?;
    close_the_quarter(&w).await?;
    let j = &w.jurors[0];
    let owed = claimable_of(&w, j.id()).await;
    assert_eq!(owed, (777 * USD + 3) / 5);

    let before = intents_balance(&w, j.id()).await;
    let logs = claim(&w, j, &[tok(j)]).await?;
    assert_eq!(event_names(&logs), vec!["claim_requested", "mt_transfer", "claim_paid"]);
    assert_eq!(claimed_in(&logs), owed);
    assert_eq!(intents_balance(&w, j.id()).await - before, owed);
    assert_eq!(claimable_of(&w, j.id()).await, 0);
    let totals = reward_totals(&w).await;
    assert_eq!(
        (
            u(&totals["total_paid"]),
            u(&totals["pending_claims"]),
            u(&totals["accrued_total"])
        ),
        (owed, 0, 0)
    );
    Ok(())
}

#[tokio::test]
async fn a_claim_by_someone_who_does_not_hold_the_seat_is_refused() -> anyhow::Result<()> {
    let w = setup().await?;
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 1_000 * USD).await?;
    send_revenue(&w, 500 * USD).await?;
    close_the_quarter(&w).await?;
    let (owner, thief) = (&w.jurors[0], &w.jurors[1]);
    refused(claim(&w, &w.alice, &[tok(owner)]).await, "not your seat");
    refused(claim(&w, thief, &[tok(thief), tok(owner)]).await, "not your seat");
    refused(claim(&w, thief, &["no-such-seat"]).await, "not staked");
    refused(claim(&w, thief, &[tok(thief); 11]).await, "at most 10 tokens");
    assert_eq!(claimable_of(&w, owner.id()).await, 100 * USD, "nothing moved");
    assert_eq!(holdings(&w, thief.id()).await, 0);
    assert_eq!(u(&reward_totals(&w).await["total_paid"]), 0);
    Ok(())
}

#[tokio::test]
async fn a_payout_the_verifier_refuses_leaves_the_balance_claimable_and_a_retry_pays() -> anyhow::Result<()> {
    let w = setup().await?;
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 1_000 * USD).await?;
    send_revenue(&w, 500 * USD).await?;
    close_the_quarter(&w).await?;
    let j = &w.jurors[0];
    let owed = claimable_of(&w, j.id()).await;
    assert_eq!(owed, 100 * USD);

    lock_account(&w, w.council.id()).await?;
    let logs = claim(&w, j, &[tok(j)]).await?;
    assert_eq!(event_names(&logs), vec!["claim_requested", "claim_failed"]);
    assert_eq!(holdings(&w, j.id()).await, 0);
    let totals = reward_totals(&w).await;
    assert_eq!((u(&totals["pending_claims"]), u(&totals["accrued_total"])), (0, owed));
    assert_eq!(claimable_of(&w, j.id()).await, owed, "still claimable");
    unlock_account(&w, w.council.id()).await?;

    let logs = claim(&w, j, &[tok(j)]).await?;
    assert_eq!(claimed_in(&logs), owed);
    assert_eq!(holdings(&w, j.id()).await, owed);
    refused(claim(&w, j, &[tok(j)]).await, "nothing to claim");
    assert_eq!(holdings(&w, j.id()).await, owed, "paid once");

    // A paused transfer feature fails the payout the same way.
    pause_transfers(&w).await?;
    let other = &w.jurors[1];
    let logs = claim(&w, other, &[tok(other)]).await?;
    assert_eq!(event_names(&logs), vec!["claim_requested", "claim_failed"]);
    unpause_transfers(&w).await?;
    assert_eq!(claimed_in(&claim(&w, other, &[tok(other)]).await?), owed);
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
async fn a_seat_that_asks_to_leave_gives_up_half_of_the_running_quarter_and_its_money_stays_claimable_after_unstake(
) -> anyhow::Result<()> {
    let w = setup().await?;
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 2_000 * USD).await?;
    let j = &w.jurors;
    send_revenue(&w, 500 * USD).await?;

    let r = request_unstake_with(&w, &j[0], tok(&j[0]), true).await?.into_result()?;
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    assert_eq!(event_names(&logs), vec!["seat_cut", "unstake_requested"]);
    let cut = &events_named(&logs, "seat_cut")[0];
    assert_eq!(
        (u(&cut["earned"]), u(&cut["cut"]), u(&cut["kept"])),
        (100 * USD, 50 * USD, 50 * USD)
    );
    assert_eq!(seat_earnings(&w, tok(&j[0])).await["state"], "leaving");
    assert_eq!(config(&w.council).await["active_seats"], 4);
    let totals = reward_totals(&w).await;
    assert_eq!(
        (
            u(&totals["cut_pool"]),
            u(&totals["pending_total_slots"]),
            u(&totals["accrued_total"])
        ),
        (50 * USD, 50 * USD, 0),
        "the cut half waits for the close, the kept half waits in the leaver's slot"
    );
    send_revenue(&w, 400 * USD).await?;
    assert_eq!(
        in_progress_of(&w, j[0].id()).await,
        50 * USD,
        "it earns nothing after asking"
    );
    assert_eq!(claimable_of(&w, j[0].id()).await, 0);
    assert_eq!(in_progress_of(&w, j[1].id()).await, 200 * USD);

    // The close shares the cut half among the four seats still earning, and frees the kept half.
    close_the_quarter(&w).await?;
    assert_eq!(claimable_of(&w, j[1].id()).await, 200 * USD + 12_500_000);
    assert_eq!(claimable_of(&w, j[0].id()).await, 50 * USD);
    let totals = reward_totals(&w).await;
    assert_eq!((u(&totals["cut_pool"]), u(&totals["carry"])), (0, 0));

    // Unstaking returns the NFT and moves no money.
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    let before = intents_balance(&w, j[0].id()).await;
    let logs = unstake(&w, &j[0], tok(&j[0])).await?;
    assert_eq!(event_names(&logs), vec!["nft_transfer", "unstaked"]);
    assert_eq!(intents_balance(&w, j[0].id()).await, before);
    assert!(!is_seat(&w, j[0].id()).await);
    assert_eq!(claimable_of(&w, j[0].id()).await, 50 * USD, "still owed after it left");

    // With no seat left to name, an empty claim pays the kept half.
    let logs = claim(&w, &j[0], &[]).await?;
    assert_eq!(claimed_in(&logs), 50 * USD);
    assert_eq!(intents_balance(&w, j[0].id()).await - before, 50 * USD);
    assert_eq!(claimable_of(&w, j[0].id()).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_seat_that_asks_to_leave_before_it_started_earns_nothing_and_does_not_change_the_count() -> anyhow::Result<()>
{
    let w = setup_earning().await?;
    mint(&w, w.owner.id(), 1_000 * USD).await?;
    stake_new(&w, &w.alice, "short-stay").await?;
    let r = request_unstake_with(&w, &w.alice, "short-stay", true)
        .await?
        .into_result()?;
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    let cut = &events_named(&logs, "seat_cut")[0];
    assert_eq!(
        (u(&cut["earned"]), u(&cut["cut"]), u(&cut["kept"])),
        (0, 0, 0),
        "a seat that never started loses nothing"
    );
    assert_eq!(seat_earnings(&w, "short-stay").await["state"], "leaving");

    to_next_day(&w).await?;
    send_revenue(&w, 500 * USD).await?;
    assert_eq!(config(&w.council).await["active_seats"], 5);
    assert_eq!(in_progress_of(&w, w.alice.id()).await, 0);
    for j in &w.jurors {
        assert_eq!(in_progress_of(&w, j.id()).await, 100 * USD);
    }
    Ok(())
}
