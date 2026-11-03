// What a decided dispute pays the jurors, and what a juror who never votes forfeits. Real contracts, sandbox chain. The five
// seats are back-dated into a quarter that has not ended, so revenue is shared among them and a test can end the quarter.
mod common;
use common::*;
use near_workspaces::Account;
use serde_json::json;

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

// Five seats that have been earning since the start of a quarter the Council takes to be running.
async fn earning_world() -> anyhow::Result<World> {
    let w = setup().await?;
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    Ok(w)
}

// The back-dated quarter ends and the Council catches up with the days since.
async fn close_the_quarter(w: &World) -> anyhow::Result<()> {
    end_quarters(w, 1).await?;
    advance_days(w).await?;
    Ok(())
}

// Carol proposed Yes and Dave challenged. The case is closed to proposals and its jury is drawn.
async fn challenged_and_drawn(w: &World) -> anyhow::Result<(u64, Vec<Account>)> {
    let id = new_market(w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(w, &w.carol, id, "yes").await?;
    challenge(w, &w.dave, id).await?;
    let jury = draw_jury(w, id).await?;
    Ok((id, jury))
}

// Carol proposed Yes and Dave challenged. Three jurors vote No and settle it, a fourth votes Yes and the fifth never votes.
// Returns the jury as (three who voted No, the one who never voted), the case, and the logs of the reveal that settled it. 1,000 USD of revenue
// arrives before the draw and again while the jury serves, in the quarter the Council takes to be running.
async fn decided_with_one_silent_juror(w: &World) -> anyhow::Result<(Vec<Account>, Account, u64, Vec<String>)> {
    send_revenue(w, 1_000 * USD).await?;
    let id = new_market(w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(w, &w.carol, id, "yes").await?;
    challenge(w, &w.dave, id).await?;
    let jury = draw_jury(w, id).await?;
    send_revenue(w, 1_000 * USD).await?;

    for j in &jury[..MAJORITY] {
        commit(w, j, id, "no", "s").await?;
    }
    let (dissenter, silent) = (&jury[MAJORITY], &jury[MAJORITY + 1]);
    commit(w, dissenter, id, "yes", "s").await?;
    assert!(
        !stake_of(w, tok(silent)).await["serving"].is_null(),
        "the seat serves until the case is final"
    );

    to_reveal_phase(w, id).await;
    reveal(w, dissenter, id, "yes", "s", "The source says yes.").await?;
    for j in &jury[..MAJORITY - 1] {
        reveal(w, j, id, "no", "s", "The source says no.").await?;
    }
    let logs = reveal_logs(w, &jury[MAJORITY - 1], id, "no", "s", "The source says no.").await?;
    assert_eq!(case_json(w, id).await["stage"], "final");
    Ok((jury[..MAJORITY].to_vec(), silent.clone(), id, logs))
}

#[tokio::test]
async fn the_majority_jurors_split_a_quarter_of_the_losing_bond_and_can_withdraw_it() -> anyhow::Result<()> {
    let w = earning_world().await?;
    let (voters, _, _, _) = decided_with_one_silent_juror(&w).await?;

    // Dave challenged and won, so Carol's bond is the loser's: a quarter, 1,250,000, split between the three jurors who
    // revealed No, 416,666 each. Dave gets his own bond back and the rest.
    for voter in &voters {
        assert_eq!(claimable(&w, voter.id()).await, JUROR_PAY);
    }
    assert_eq!(claimable(&w, w.dave.id()).await, 2 * BOND - 3 * JUROR_PAY);
    assert_eq!(claimable(&w, w.carol.id()).await, 0);

    // It is real money: the juror withdraws it into their Intents account.
    let before = intents_balance(&w, voters[0].id()).await;
    withdraw_bond(&w, &voters[0]).await?;
    assert_eq!(intents_balance(&w, voters[0].id()).await, before + JUROR_PAY);
    assert_eq!(claimable(&w, voters[0].id()).await, 0);
    assert_eq!(oracle_total_owed(&w).await, 2 * BOND - JUROR_PAY);
    assert_oracle_reconciled(&w).await;
    Ok(())
}

#[tokio::test]
async fn a_juror_who_never_voted_forfeits_what_the_seat_earned_while_it_served_to_the_other_seats() -> anyhow::Result<()>
{
    let w = earning_world().await?;
    let (voters, silent, id, logs) = decided_with_one_silent_juror(&w).await?;
    assert_eq!(case_json(&w, id).await["delinquent"], json!([silent.id()]));

    // The seat earned 200 USD while it served. The other four seats share that, 50 USD each, and the silent seat is docked
    // its own 50 USD share of the rise too, so nothing of what it lost comes back to it.
    let forfeits = events_named(&logs, "seat_earnings_forfeited");
    assert_eq!(forfeits.len(), 1, "{logs:?}");
    assert_eq!(forfeits[0]["owner"], json!(silent.id()));
    assert_eq!(u(&forfeits[0]["amount"]), 200 * USD);
    assert!(
        stake_of(&w, tok(&silent)).await["serving"].is_null(),
        "the seat is free again"
    );
    assert_eq!(
        in_progress_of(&w, silent.id()).await,
        200 * USD,
        "what it earned before the draw is kept"
    );
    for voter in &voters {
        assert_eq!(
            in_progress_of(&w, voter.id()).await,
            450 * USD,
            "400 USD of its own and a quarter of the forfeit"
        );
    }

    close_the_quarter(&w).await?;
    assert_eq!(claimable_of(&w, silent.id()).await, 200 * USD);
    for voter in &voters {
        assert_eq!(claimable_of(&w, voter.id()).await, 450 * USD);
    }
    let paid = claimed_in(&claim(&w, &silent, &[tok(&silent)]).await?);
    assert_eq!(paid, 200 * USD);
    assert_eq!(holdings(&w, silent.id()).await, paid);
    Ok(())
}

// A juror who committed but had no chance to reveal because the others settled it first is not blamed.
#[tokio::test]
async fn a_juror_who_committed_but_was_not_given_time_to_reveal_is_not_penalised() -> anyhow::Result<()> {
    let w = earning_world().await?;
    send_revenue(&w, 1_000 * USD).await?;
    let (id, jury) = challenged_and_drawn(&w).await?;
    send_revenue(&w, 1_000 * USD).await?;
    for j in &jury {
        commit(&w, j, id, "no", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..MAJORITY - 1] {
        reveal(&w, j, id, "no", "s", "The source says no.").await?;
    }
    let logs = reveal_logs(&w, &jury[MAJORITY - 1], id, "no", "s", "The source says no.").await?;
    assert_eq!(case_json(&w, id).await["stage"], "final");

    assert_eq!(case_json(&w, id).await["delinquent"], json!([]));
    assert!(
        events_named(&logs, "seat_earnings_forfeited").is_empty(),
        "nothing forfeited"
    );
    close_the_quarter(&w).await?;
    for j in &jury {
        assert_eq!(
            claimable_of(&w, j.id()).await,
            400 * USD,
            "{} keeps all it earned",
            j.id()
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_juror_cannot_claim_what_its_seat_earns_while_it_serves_until_the_case_is_released() -> anyhow::Result<()> {
    let w = earning_world().await?;
    send_revenue(&w, 1_000 * USD).await?;
    let (id, jury) = challenged_and_drawn(&w).await?;
    send_revenue(&w, 1_000 * USD).await?;
    close_the_quarter(&w).await?;

    // The quarter holds 400 USD for each seat. Only the 200 USD from before the draw can be claimed while the seat serves.
    let juror = &jury[0];
    assert_eq!(claimable_of(&w, juror.id()).await, 200 * USD);
    assert_eq!(claimed_in(&claim(&w, juror, &[tok(juror)]).await?), 200 * USD);
    assert_eq!(claimable_of(&w, juror.id()).await, 0);

    for j in &jury {
        commit(&w, j, id, "no", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..MAJORITY] {
        reveal(&w, j, id, "no", "s", "The source says no.").await?;
    }
    assert_eq!(case_json(&w, id).await["stage"], "final");
    assert!(stake_of(&w, tok(juror)).await["serving"].is_null());
    assert_eq!(
        claimable_of(&w, juror.id()).await,
        200 * USD,
        "the rest is released with the case"
    );
    assert_eq!(claimed_in(&claim(&w, juror, &[tok(juror)]).await?), 200 * USD);
    assert_eq!(holdings(&w, juror.id()).await, 400 * USD);
    Ok(())
}

#[tokio::test]
async fn a_draw_after_a_quarter_ended_closes_it_before_the_jury_is_picked() -> anyhow::Result<()> {
    let w = earning_world().await?;
    send_revenue(&w, 1_000 * USD).await?;
    end_quarters(&w, 1).await?;
    let closed = running_quarter(&w).await - 1;
    assert_ne!(
        config(&w.council).await["last_closed_quarter"],
        closed,
        "nothing has walked the days yet"
    );

    let id = new_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    wait_for_draw(&w, id).await;
    let logs = resolve_draw(&w, id).await?;
    assert_eq!(event_names(&logs), vec!["quarter_closed", "jury_drawn", "jury_drawn"]);
    assert_eq!(
        config(&w.council).await["last_closed_quarter"],
        closed,
        "the draw walked the days first"
    );
    assert_eq!(quarter_snapshots(&w).await.last().map(|s| s.0), Some(closed));
    for j in &w.jurors {
        assert_eq!(claimable_of(&w, j.id()).await, 200 * USD);
    }
    Ok(())
}
