// The Council's quarters end to end against the real NEAR Intents verifier: a sweep arrives, the quarter closes, a claim pays real
// money, and what leaving costs. Real contracts, sandbox chain. A block takes real time, so a quarter is ended by editing the
// Council's day ledger (back_date and end_quarters in common) and everything after that is the contract's own code.
mod common;
use common::*;
use near_workspaces::Account;
use serde_json::json;

const ACC_SCALE: u128 = 1_000_000_000_000_000_000;
const MAX_DAY_STEPS: u64 = 100;
const SHORT_RECONCILE_WAIT_SECS: u64 = 600;

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

// Five seats that have been earning since the first day of a quarter the Council takes to be running, `quarters_back` quarters
// before the chain's own, and an owner with money to stand in for the market.
async fn earning_world(quarters_back: u32) -> anyhow::Result<World> {
    let w = setup().await?;
    back_date(&w, quarters_back).await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    Ok(w)
}

#[tokio::test]
async fn a_staked_seat_a_sweep_and_a_closed_quarter_end_in_a_claim_that_pays_real_usdc() -> anyhow::Result<()> {
    let w = setup().await?;
    back_date(&w, 1).await?;
    mint_nft(&w, &w.alice, "flow-seat").await?;
    stake(&w, &w.alice, "flow-seat").await?;
    to_next_day(&w).await?;
    assert_eq!(seat_earnings(&w, "flow-seat").await["state"], "earning");

    // A buy pays a fee, the sweep sends the Council its quarter of it, and six seats share it.
    let id = new_market(&w, 600).await?;
    buy(&w, &w.bob, id, "yes", SWEEP_BUY).await?;
    past_sweep_interval(&w).await;
    let logs: Vec<String> = sweep(&w, &w.carol)
        .await?
        .logs()
        .iter()
        .map(|l| l.to_string())
        .collect();
    let revenue = &events_named(&logs, "revenue")[0];
    assert_eq!((u(&revenue["amount"]), &revenue["seats"]), (COUNCIL_SHARE, &json!(6)));
    let each = COUNCIL_SHARE / 6;
    assert_eq!(in_progress_of(&w, w.alice.id()).await, each);
    assert_eq!(claimable_of(&w, w.alice.id()).await, 0, "the quarter has not closed");

    end_quarters(&w, 1).await?;
    let logs = advance_days(&w).await?;
    let closed = events_named(&logs, "quarter_closed");
    assert_eq!(closed.len(), 1, "{logs:?}");
    assert_eq!(
        (closed[0]["quarter"].as_u64(), u(&closed[0]["acc"])),
        (
            Some(u64::from(running_quarter(&w).await - 1)),
            each * ACC_SCALE + COUNCIL_SHARE % 6 * ACC_SCALE / 6
        )
    );
    assert_eq!(claimable_of(&w, w.alice.id()).await, each);

    let held = intents_balance(&w, w.council.id()).await;
    let logs = claim(&w, &w.alice, &["flow-seat"]).await?;
    assert_eq!(event_names(&logs), vec!["claim_requested", "mt_transfer", "claim_paid"]);
    assert_eq!(claimed_in(&logs), each);
    assert_eq!(
        intents_balance(&w, w.alice.id()).await,
        each,
        "the money is in her Intents account"
    );
    assert_eq!(
        held - intents_balance(&w, w.council.id()).await,
        each,
        "and it came out of the Council's"
    );
    let totals = reward_totals(&w).await;
    assert_eq!(
        (
            u(&totals["total_paid"]),
            u(&totals["pending_claims"]),
            u(&totals["accrued_total"])
        ),
        (each, 0, 0)
    );
    let owed: u128 = {
        let mut all = 0;
        for j in &w.jurors {
            all += claimable_of(&w, j.id()).await;
        }
        all
    };
    assert_eq!(
        intents_balance(&w, w.council.id()).await - owed,
        COUNCIL_SHARE % 6,
        "the Council holds what the other five seats are owed and the rounding of the split"
    );
    assert_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn a_claim_in_the_middle_of_a_quarter_pays_the_closed_quarters_only() -> anyhow::Result<()> {
    let w = earning_world(1).await?;
    let j = &w.jurors[0];
    send_revenue(&w, 500 * USD).await?;
    end_quarters(&w, 1).await?;
    advance_days(&w).await?;

    // The next quarter's revenue arrives. It is in progress and cannot be claimed.
    send_revenue(&w, 600 * USD).await?;
    assert_eq!(claimable_of(&w, j.id()).await, 100 * USD);
    assert_eq!(in_progress_of(&w, j.id()).await, 120 * USD);
    let seat = seat_earnings(&w, tok(j)).await;
    assert_eq!(
        (u(&seat["earned_closed"]), u(&seat["earned_in_progress"])),
        (100 * USD, 120 * USD)
    );
    let logs = claim(&w, j, &[tok(j)]).await?;
    assert_eq!(claimed_in(&logs), 100 * USD, "nothing of the running quarter");
    assert_eq!(holdings(&w, j.id()).await, 100 * USD);
    assert_eq!(claimable_of(&w, j.id()).await, 0);
    assert_eq!(
        in_progress_of(&w, j.id()).await,
        120 * USD,
        "the running quarter is untouched"
    );
    refused(claim(&w, j, &[tok(j)]).await, "nothing to claim");
    Ok(())
}

#[tokio::test]
async fn a_claim_and_a_leave_run_the_overdue_quarter_close_themselves() -> anyhow::Result<()> {
    let w = earning_world(1).await?;
    let (claimer, leaver) = (&w.jurors[0], &w.jurors[1]);
    send_revenue(&w, 500 * USD).await?;
    end_quarters(&w, 1).await?;
    assert_eq!(
        claimable_of(&w, claimer.id()).await,
        0,
        "nothing has walked the days yet"
    );

    let logs = claim(&w, claimer, &[tok(claimer)]).await?;
    assert_eq!(
        event_names(&logs),
        vec!["quarter_closed", "claim_requested", "mt_transfer", "claim_paid"]
    );
    assert_eq!(claimed_in(&logs), 100 * USD);

    // The leave comes after the close, so the earlier quarter is paid in full and only a quarter that is still running is cut.
    let r = request_unstake_with(&w, leaver, tok(leaver), true)
        .await?
        .into_result()?;
    let cut = &events_named(&logs_of_success(&r), "seat_cut")[0];
    assert_eq!((u(&cut["earned"]), u(&cut["cut"])), (0, 0));
    assert_eq!(claimable_of(&w, leaver.id()).await, 100 * USD);
    Ok(())
}

fn logs_of_success(r: &near_workspaces::result::ExecutionSuccess) -> Vec<String> {
    r.logs().iter().map(|l| l.to_string()).collect()
}

#[tokio::test]
async fn a_quarter_nobody_claims_stays_claimable_and_a_gap_of_several_quarters_is_walked_in_steps() -> anyhow::Result<()>
{
    let w = earning_world(3).await?;
    send_revenue(&w, 500 * USD).await?;
    end_quarters(&w, 3).await?;
    let behind = running_quarter(&w).await;
    let days_behind =
        now(&w.worker).await / NS_PER_DAY - config(&w.council).await["last_day"].as_str().unwrap().parse::<u64>()?;
    assert!(
        days_behind > MAX_DAY_STEPS,
        "{days_behind} days behind, quarter {behind}"
    );

    // A claim cannot catch up that far. The receipt of a sweep cannot either: the verifier gives that money back.
    let j = &w.jurors[0];
    refused(claim(&w, j, &[tok(j)]).await, "call advance_days first");
    refused(
        request_unstake_with(&w, j, tok(j), true).await?.into_result(),
        "call advance_days first",
    );
    send_revenue(&w, 100 * USD).await?;
    assert_eq!(
        council_total_received(&w).await,
        500 * USD,
        "the late sweep was refused"
    );

    let mut calls = 0;
    loop {
        let moved: u32 = w
            .bob
            .call(w.council.id(), "advance_days")
            .args_json(json!({ "max_steps": null }))
            .transact()
            .await?
            .into_result()?
            .json()?;
        calls += 1;
        if u64::from(moved) < MAX_DAY_STEPS {
            break;
        }
    }
    assert!(calls >= 2, "{days_behind} days take more than one call");
    let snapshots = quarter_snapshots(&w).await;
    let closed: Vec<u32> = snapshots.iter().rev().take(3).rev().map(|s| s.0).collect();
    assert_eq!(closed, vec![behind - 3, behind - 2, behind - 1]);
    assert!(
        snapshots.iter().rev().take(3).all(|s| s.1 == 100 * USD * ACC_SCALE),
        "nothing arrived after the first sweep, so every closed quarter holds the same index"
    );

    // The first quarter closed two quarters ago, and its money is still there to claim, once.
    assert_eq!(claimable_of(&w, j.id()).await, 100 * USD);
    assert_eq!(claimed_in(&claim(&w, j, &[tok(j)]).await?), 100 * USD);
    refused(claim(&w, j, &[tok(j)]).await, "nothing to claim");
    Ok(())
}

#[tokio::test]
async fn request_unstake_without_accepting_the_cut_is_refused_and_changes_nothing() -> anyhow::Result<()> {
    let w = earning_world(1).await?;
    let j = &w.jurors[0];
    send_revenue(&w, 500 * USD).await?;
    refused(
        request_unstake_with(&w, j, tok(j), false).await?.into_result(),
        "leaving before the quarter ends costs 50% of this quarter's earnings: pass accepts_cut true",
    );
    assert!(stake_of(&w, tok(j)).await["unlock_requested_at"].is_null());
    assert_eq!(seat_earnings(&w, tok(j)).await["state"], "earning");
    assert_eq!(config(&w.council).await["active_seats"], 5);
    let totals = reward_totals(&w).await;
    assert_eq!((u(&totals["cut_pool"]), u(&totals["pending_total_slots"])), (0, 0));
    refused(
        request_unstake_with(&w, &w.alice, tok(j), true).await?.into_result(),
        "not your seat",
    );
    request_unstake_with(&w, j, tok(j), true).await?.into_result()?;
    Ok(())
}

#[tokio::test]
async fn a_leaver_loses_half_of_the_running_quarter_and_nothing_of_the_quarters_before() -> anyhow::Result<()> {
    let w = earning_world(1).await?;
    let (j, rest) = (&w.jurors[0], &w.jurors[1..]);
    send_revenue(&w, 500 * USD).await?;
    end_quarters(&w, 1).await?;
    advance_days(&w).await?;
    send_revenue(&w, 400 * USD).await?;
    assert_eq!(in_progress_of(&w, j.id()).await, 80 * USD);

    let r = request_unstake_with(&w, j, tok(j), true).await?.into_result()?;
    let cut = &events_named(&logs_of_success(&r), "seat_cut")[0];
    assert_eq!(
        (u(&cut["earned"]), u(&cut["cut"]), u(&cut["kept"])),
        (80 * USD, 40 * USD, 40 * USD),
        "half of the running quarter and none of the finished one"
    );
    let totals = reward_totals(&w).await;
    assert_eq!(
        (
            u(&totals["accrued_total"]),
            u(&totals["cut_pool"]),
            u(&totals["pending_total_slots"])
        ),
        (100 * USD, 40 * USD, 40 * USD),
        "the finished quarter was settled in full"
    );
    assert_eq!(claimable_of(&w, j.id()).await, 100 * USD);
    assert_eq!(
        in_progress_of(&w, j.id()).await,
        40 * USD,
        "the kept half waits for the quarter to close"
    );
    assert_eq!(claimed_in(&claim(&w, j, &[tok(j)]).await?), 100 * USD);

    // Another seat leaving in the same quarter adds its cut to the pool and its kept half to a slot of its own.
    let second = &rest[0];
    request_unstake_with(&w, second, tok(second), true)
        .await?
        .into_result()?;
    assert_eq!(in_progress_of(&w, second.id()).await, 40 * USD);
    let totals = reward_totals(&w).await;
    assert_eq!(
        (u(&totals["cut_pool"]), u(&totals["pending_total_slots"])),
        (80 * USD, 80 * USD)
    );
    Ok(())
}

#[tokio::test]
async fn a_claim_whose_callback_never_came_is_booked_as_paid_by_the_owner_after_the_wait() -> anyhow::Result<()> {
    let w = earning_world(1).await?;
    let j = &w.jurors[0];
    send_revenue(&w, 500 * USD).await?;
    end_quarters(&w, 1).await?;
    advance_days(&w).await?;
    assert_eq!(claimed_in(&claim(&w, j, &[tok(j)]).await?), 100 * USD);
    leave_claim_in_flight(&w, j, 100 * USD, &[tok(j)]).await?;
    let totals = reward_totals(&w).await;
    assert_eq!((u(&totals["pending_claims"]), u(&totals["total_paid"])), (100 * USD, 0));

    refused(reconcile_claim(&w, &w.dave, 0, true).await?.into_result(), "owner only");
    refused(
        reconcile_claim(&w, &w.owner, 0, true).await?.into_result(),
        "wait 60 minutes after the claim before reconciling",
    );
    w.owner
        .call(w.council.id(), "set_reconcile_wait_ns")
        .args_json(json!({ "reconcile_wait_ns": (SHORT_RECONCILE_WAIT_SECS * 1_000_000_000).to_string() }))
        .transact()
        .await?
        .into_result()?;
    refused(
        reconcile_claim(&w, &w.owner, 0, true).await?.into_result(),
        "wait 10 minutes after the claim before reconciling",
    );
    skip_secs(&w.worker, SHORT_RECONCILE_WAIT_SECS + 1).await;
    refused(
        reconcile_claim(&w, &w.owner, 1, true).await?.into_result(),
        "no claim is pending with that id",
    );

    let r = reconcile_claim(&w, &w.owner, 0, true).await?.into_result()?;
    let reconciled = &events_named(&logs_of_success(&r), "claim_reconciled")[0];
    assert_eq!(
        (u(&reconciled["amount"]), &reconciled["paid"]),
        (100 * USD, &json!(true))
    );
    let totals = reward_totals(&w).await;
    assert_eq!(
        (
            u(&totals["pending_claims"]),
            u(&totals["total_paid"]),
            u(&totals["accrued_total"])
        ),
        (0, 100 * USD, 0)
    );
    refused(
        reconcile_claim(&w, &w.owner, 0, true).await?.into_result(),
        "no claim is pending with that id",
    );
    assert_eq!(claimable_of(&w, j.id()).await, 0, "paid, and not credited back");
    Ok(())
}

#[tokio::test]
async fn a_claim_whose_callback_never_came_is_credited_back_by_the_owner_when_the_payout_failed() -> anyhow::Result<()>
{
    let w = earning_world(1).await?;
    let j = &w.jurors[0];
    send_revenue(&w, 500 * USD).await?;
    end_quarters(&w, 1).await?;
    advance_days(&w).await?;
    lock_account(&w, w.council.id()).await?;
    let logs = claim(&w, j, &[tok(j)]).await?;
    assert_eq!(event_names(&logs), vec!["claim_requested", "claim_failed"]);
    unlock_account(&w, w.council.id()).await?;
    leave_claim_in_flight(&w, j, 100 * USD, &[tok(j)]).await?;
    assert_eq!(claimable_of(&w, j.id()).await, 0, "the amount is in flight");

    w.owner
        .call(w.council.id(), "set_reconcile_wait_ns")
        .args_json(json!({ "reconcile_wait_ns": (SHORT_RECONCILE_WAIT_SECS * 1_000_000_000).to_string() }))
        .transact()
        .await?
        .into_result()?;
    skip_secs(&w.worker, SHORT_RECONCILE_WAIT_SECS + 1).await;
    reconcile_claim(&w, &w.owner, 0, false).await?.into_result()?;
    let totals = reward_totals(&w).await;
    assert_eq!(
        (
            u(&totals["pending_claims"]),
            u(&totals["total_paid"]),
            u(&totals["accrued_total"])
        ),
        (0, 0, 100 * USD)
    );
    assert_eq!(claimable_of(&w, j.id()).await, 100 * USD, "the balance is back");
    assert_eq!(claimed_in(&claim(&w, j, &[tok(j)]).await?), 100 * USD);
    assert_eq!(holdings(&w, j.id()).await, 100 * USD, "and a new claim pays it once");
    Ok(())
}
