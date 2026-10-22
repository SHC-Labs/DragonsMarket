// What a decided dispute pays the jurors, and what a juror who never votes forfeits. Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::Account;
use serde_json::json;

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

// Carol proposed Yes and Dave challenged. Two jurors vote No and settle it, the third never votes. Returns the jury as
// (two who voted, the one who did not), the case, and the logs of the reveal that settled it. 1,000 USD of revenue
// arrives before the draw and again while the jury serves, in the quarter the chain is in.
async fn decided_with_one_silent_juror(w: &World) -> anyhow::Result<(Vec<Account>, Account, u64, Vec<String>)> {
    mint(w, w.owner.id(), 10_000 * USD).await?;
    send_revenue(w, 1_000 * USD).await?;
    let id = create_seeded_market(w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(w, &w.carol, id, "yes").await?;
    challenge(w, &w.dave, id).await?;
    let jury = draw_jury(w, id).await?;
    send_revenue(w, 1_000 * USD).await?;

    commit(w, &jury[0], id, "no", "s").await?;
    commit(w, &jury[1], id, "no", "s").await?;
    assert!(
        !stake_of(w, tok(&jury[2])).await["serving"].is_null(),
        "the seat serves until the case is final"
    );

    to_reveal_phase(w, id).await;
    reveal(w, &jury[0], id, "no", "s", "The source says no.").await?;
    let logs = reveal_logs(w, &jury[1], id, "no", "s", "The source says no.").await?;
    assert_eq!(case_json(w, id).await["stage"], "final");
    Ok((jury[..2].to_vec(), jury[2].clone(), id, logs))
}

#[tokio::test]
async fn the_majority_jurors_split_a_quarter_of_the_losing_bond_and_can_withdraw_it() -> anyhow::Result<()> {
    let w = setup().await?;
    let (voters, _, _, _) = decided_with_one_silent_juror(&w).await?;

    // Dave challenged and won, so Carol's bond is the loser's: a quarter, 1,250,000, split between the two jurors who
    // revealed No. Dave gets his own bond back and the other three quarters.
    assert_eq!(claimable(&w, voters[0].id()).await, 625_000);
    assert_eq!(claimable(&w, voters[1].id()).await, 625_000);
    assert_eq!(claimable(&w, w.dave.id()).await, 2 * BOND - 1_250_000);
    assert_eq!(claimable(&w, w.carol.id()).await, 0);

    // It is real money: the juror withdraws it into their Intents account.
    let before = intents_balance(&w, voters[0].id()).await;
    withdraw_bond(&w, &voters[0]).await?;
    assert_eq!(intents_balance(&w, voters[0].id()).await, before + 625_000);
    assert_eq!(claimable(&w, voters[0].id()).await, 0);
    assert_eq!(oracle_total_owed(&w).await, 2 * BOND - 625_000);
    assert_oracle_reconciled(&w).await;
    Ok(())
}

// How long a seat was staked in the quarter, from its entitlement view.
async fn weight(w: &World, quarter: u32, juror: &Account) -> u128 {
    u(&entitlement(w, quarter, tok(juror), juror.id()).await["weight_ns"])
}

#[tokio::test]
async fn a_juror_who_never_voted_forfeits_the_seat_time_of_the_case() -> anyhow::Result<()> {
    let w = setup().await?;
    let (voters, silent, id, logs) = decided_with_one_silent_juror(&w).await?;
    assert_eq!(case_json(&w, id).await["delinquent"], json!([silent.id()]));

    // The council took the time the silent seat served out of the quarter: out of the seat's weight and out of the quarter's total.
    let forfeits = events_named(&logs, "seat_time_forfeited");
    assert_eq!(forfeits.len(), 1, "{logs:?}");
    assert_eq!(forfeits[0]["owner"], json!(silent.id()));
    let forfeited = u(&forfeits[0]["forfeited_ns"]);
    assert!(forfeited > 0, "the seat served for the whole case");
    assert!(
        stake_of(&w, tok(&silent)).await["serving"].is_null(),
        "the seat is free again"
    );
    let current = current_quarter(&w).await;
    assert_eq!(u(&current["forfeit_ns"]), forfeited);

    let quarter = age_current_quarter(&w).await?;
    finalize_quarter(&w, quarter).await?;
    let (kept, voted) = (
        weight(&w, quarter, &silent).await,
        weight(&w, quarter, &voters[0]).await,
    );
    assert!(voted > kept, "{voted} against {kept}");
    assert!(
        (voted - kept).abs_diff(forfeited) <= forfeited / 4,
        "the silent seat lost {} and the forfeit was {forfeited}",
        voted - kept
    );
    assert!(
        weight(&w, quarter, &voters[1]).await.abs_diff(voted) <= 30_000_000_000,
        "a juror who voted keeps everything"
    );

    // The silent seat claims what is left of its share, and a seat that voted claims more.
    let (silent_share, voter_share) = (
        u(&entitlement(&w, quarter, tok(&silent), silent.id()).await["amount"]),
        u(&entitlement(&w, quarter, tok(&voters[0]), voters[0].id()).await["amount"]),
    );
    assert!(voter_share > silent_share);
    let paid = claimed_in(&claim_quarter(&w, &silent, quarter, tok(&silent)).await?);
    assert_eq!(paid, silent_share);
    assert_eq!(holdings(&w, silent.id()).await, paid);
    Ok(())
}

// A juror who committed but had no chance to reveal because the others settled it first is not blamed.
#[tokio::test]
async fn a_juror_who_committed_but_was_not_given_time_to_reveal_is_not_penalised() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    send_revenue(&w, 1_000 * USD).await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    send_revenue(&w, 1_000 * USD).await?;
    for j in &jury {
        commit(&w, j, id, "no", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    reveal(&w, &jury[0], id, "no", "s", "The source says no.").await?;
    let logs = reveal_logs(&w, &jury[1], id, "no", "s", "The source says no.").await?;
    assert_eq!(case_json(&w, id).await["stage"], "final");

    assert_eq!(case_json(&w, id).await["delinquent"], json!([]));
    assert!(
        events_named(&logs, "seat_time_forfeited").is_empty(),
        "nothing forfeited"
    );
    let quarter = age_current_quarter(&w).await?;
    finalize_quarter(&w, quarter).await?;
    let (third, first) = (weight(&w, quarter, &jury[2]).await, weight(&w, quarter, &jury[0]).await);
    assert!(
        third.abs_diff(first) <= 30_000_000_000,
        "the third juror kept all the time it was staked: {third} against {first}"
    );
    Ok(())
}
