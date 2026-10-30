// Outcome review of the jury draw. Real contracts, sandbox chain.
mod common;
use common::*;

// A seat staked after the challenge cannot sit on that case's jury while the older seats can make one on their own. Five
// seats are older than the cooldown, the jury needs five, and a sixth is staked after the challenge.
#[tokio::test]
async fn a_seat_staked_after_the_challenge_cannot_sit_on_that_cases_jury() -> anyhow::Result<()> {
    let w = setup().await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 5).await;

    let id = new_market(&w, 1).await?;
    skip_secs(&w.worker, 2).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;

    mint_nft(&w, &w.alice, "late-seat").await?;
    stake(&w, &w.alice, "late-seat").await?;
    wait_for_draw(&w, id).await;
    let events = event_names(&resolve_draw(&w, id).await?);
    assert_eq!(events, vec!["jury_drawn", "jury_drawn"]);
    let panel = case_json(&w, id).await["panel"].to_string();
    assert!(
        !panel.contains(w.alice.id().as_str()),
        "a seat staked after the challenge was drawn onto its jury: {panel}"
    );
    Ok(())
}
