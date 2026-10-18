// What a decided dispute pays the jurors, and what a juror who never votes forfeits. Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::json;

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

async fn send_revenue(w: &World, amount: u128) -> anyhow::Result<()> {
    ft_call(w, &w.owner, w.council.id(), amount, "revenue").await
}

async fn waiting_revenue(w: &World) -> u128 {
    u(&config(&w.council).await["waiting_revenue"])
}

// Carol proposed Yes and Dave challenged. Two jurors vote No and settle it, the third never votes. Returns the jury
// as (two who voted, the one who did not). A fifth of 500,000 of revenue arrives before the draw and again while the
// jury serves.
async fn decided_with_one_silent_juror(w: &World) -> anyhow::Result<(Vec<Account>, Account, u64)> {
    send_revenue(w, 500_000).await?;
    let id = create_seeded_market(w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(w, &w.carol, id, "yes").await?;
    challenge(w, &w.dave, id).await?;
    let jury = draw_jury(w, id).await?;
    send_revenue(w, 500_000).await?;

    commit(w, &jury[0], id, "no", "s").await?;
    commit(w, &jury[1], id, "no", "s").await?;
    // The seat that serves cannot claim, so it cannot get its revenue out before the forfeit.
    refused(claim(w, &jury[2], tok(&jury[2])).await, "this seat is serving on an open case, claim after it is final");
    assert_eq!(pending_reward(w, tok(&jury[2])).await, 200_000);

    to_reveal_phase(w, id).await;
    reveal(w, &jury[0], id, "no", "s", "The source says no.").await?;
    reveal(w, &jury[1], id, "no", "s", "The source says no.").await?;
    assert_eq!(case_json(w, id).await["stage"], "final");
    Ok((jury[..2].to_vec(), jury[2].clone(), id))
}

#[tokio::test]
async fn the_majority_jurors_split_a_quarter_of_the_losing_bond_and_can_withdraw_it() -> anyhow::Result<()> {
    let w = setup().await?;
    let (voters, _, _) = decided_with_one_silent_juror(&w).await?;

    // Dave challenged and won, so Carol's bond is the loser's: a quarter, 1,250,000, split between the two jurors who
    // revealed No. Dave gets his own bond back and the other three quarters.
    assert_eq!(claimable(&w, voters[0].id()).await, 625_000);
    assert_eq!(claimable(&w, voters[1].id()).await, 625_000);
    assert_eq!(claimable(&w, w.dave.id()).await, 2 * BOND - 1_250_000);
    assert_eq!(claimable(&w, w.carol.id()).await, 0);

    // It is real money: the juror withdraws it.
    register_ft(&w, voters[0].id()).await?;
    let before = ft_balance(&w, voters[0].id()).await;
    voters[0]
        .call(w.oracle.id(), "withdraw_bond")
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(ft_balance(&w, voters[0].id()).await, before + 625_000);
    assert_eq!(claimable(&w, voters[0].id()).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_juror_who_never_voted_forfeits_the_revenue_earned_while_serving() -> anyhow::Result<()> {
    let w = setup().await?;
    let (voters, silent, id) = decided_with_one_silent_juror(&w).await?;
    assert_eq!(case_json(&w, id).await["delinquent"], json!([silent.id()]));

    // Five seats took 100,000 each before the draw and 100,000 each after. The silent juror keeps what it earned
    // before the draw and loses the 100,000 earned while serving; those who voted keep both.
    assert_eq!(pending_reward(&w, tok(&silent)).await, 100_000);
    for v in &voters {
        assert_eq!(pending_reward(&w, tok(v)).await, 200_000);
    }
    assert_eq!(waiting_revenue(&w).await, 100_000, "the forfeit waits for the next revenue");
    assert!(stake_of(&w, tok(&silent)).await["serving"].is_null(), "the seat is free again");

    // The next revenue carries it in: 100,000 waiting plus 500,000 new is 120,000 for each of the five seats.
    send_revenue(&w, 500_000).await?;
    assert_eq!(waiting_revenue(&w).await, 0);
    assert_eq!(pending_reward(&w, tok(&silent)).await, 220_000);
    assert_eq!(pending_reward(&w, tok(&voters[0])).await, 320_000);

    // The silent seat can claim again now that the case is over.
    let before = ft_balance(&w, silent.id()).await;
    register_ft(&w, silent.id()).await?;
    claim(&w, &silent, tok(&silent)).await?;
    assert_eq!(ft_balance(&w, silent.id()).await, before + 220_000);
    Ok(())
}

// A juror who committed but had no chance to reveal because the others settled it first is not blamed.
#[tokio::test]
async fn a_juror_who_committed_but_was_not_given_time_to_reveal_is_not_penalised() -> anyhow::Result<()> {
    let w = setup().await?;
    send_revenue(&w, 500_000).await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    send_revenue(&w, 500_000).await?;
    for j in &jury {
        commit(&w, j, id, "no", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    reveal(&w, &jury[0], id, "no", "s", "The source says no.").await?;
    reveal(&w, &jury[1], id, "no", "s", "The source says no.").await?;
    assert_eq!(case_json(&w, id).await["stage"], "final");

    assert_eq!(case_json(&w, id).await["delinquent"], json!([]));
    assert_eq!(pending_reward(&w, tok(&jury[2])).await, 200_000, "nothing forfeited");
    assert_eq!(waiting_revenue(&w).await, 0);
    Ok(())
}
