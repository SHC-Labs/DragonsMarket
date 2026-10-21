// What a decided dispute pays the jurors, and what a juror who never votes forfeits. Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::json;

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

// Carol proposed Yes and Dave challenged. Two jurors vote No and settle it, the third never votes. Returns the jury as
// (two who voted, the one who did not), the case, and the logs of the reveal that settled it. 1,000 USD of revenue
// arrives before the draw and again while the jury serves, and streams to the five seats over 30 days.
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
    // The seat that serves cannot claim, so it cannot get its revenue out before the forfeit.
    refused(
        claim(w, &jury[2], tok(&jury[2])).await,
        "this seat is serving on an open case, claim after it is final",
    );
    assert!(pending_reward(w, tok(&jury[2])).await > 0);

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

    // It is real money: the juror withdraws it.
    register_ft(&w, voters[0].id()).await?;
    let before = holdings(&w, voters[0].id()).await;
    voters[0]
        .call(w.oracle.id(), "withdraw_bond")
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(holdings(&w, voters[0].id()).await, before + 625_000);
    assert_eq!(claimable(&w, voters[0].id()).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_juror_who_never_voted_forfeits_the_revenue_earned_while_serving() -> anyhow::Result<()> {
    let w = setup().await?;
    let (voters, silent, id, logs) = decided_with_one_silent_juror(&w).await?;
    assert_eq!(case_json(&w, id).await["delinquent"], json!([silent.id()]));

    // The council took what the silent seat earned while it served and put it back into the stream.
    let forfeits = events_named(&logs, "revenue_forfeited");
    assert_eq!(forfeits.len(), 1, "{logs:?}");
    assert_eq!(forfeits[0]["owner"], json!(silent.id()));
    let forfeited = u(&forfeits[0]["amount"]);
    assert!(forfeited > 0, "the seat served while a stream of 1,000 USD ran");
    assert!(
        stake_of(&w, tok(&silent)).await["serving"].is_null(),
        "the seat is free again"
    );

    // The five seats earned the same from the same stream. The silent one kept what it earned before the draw and has
    // lost what it earned while serving, which those who voted kept. The two reads are a block apart at most.
    let (kept, voted) = (
        pending_reward(&w, tok(&silent)).await,
        pending_reward(&w, tok(&voters[0])).await,
    );
    assert!(voted > kept, "{voted} against {kept}");
    assert!(
        (voted - kept).abs_diff(forfeited) <= forfeited / 20 + 2,
        "the silent seat lost {} and the forfeit was {forfeited}",
        voted - kept
    );
    assert!(
        pending_reward(&w, tok(&voters[1])).await.abs_diff(voted) <= voted / 20 + 2,
        "a juror who voted keeps everything"
    );

    // The silent seat can claim again now that the case is over.
    register_ft(&w, silent.id()).await?;
    let paid = claimed_in(&claim(&w, &silent, tok(&silent)).await?);
    assert!(paid >= kept);
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
    assert!(events_named(&logs, "revenue_forfeited").is_empty(), "nothing forfeited");
    let (third, first) = (
        pending_reward(&w, tok(&jury[2])).await,
        pending_reward(&w, tok(&jury[0])).await,
    );
    assert!(
        third.abs_diff(first) <= first / 20 + 2,
        "the third juror kept everything it earned: {third} against {first}"
    );
    Ok(())
}
