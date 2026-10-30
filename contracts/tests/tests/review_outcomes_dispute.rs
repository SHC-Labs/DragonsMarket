// Outcome review of disputes: what a challenger can lose through no fault of their own, and whether a setting changed during a
// case reaches into it. Real contracts, sandbox chain.
mod common;
use common::*;
use serde_json::json;

// Enough seats for two juries at once, so two open cases hold every one of them.
const COUNCIL_SEATS: usize = 2 * JURY as usize;
// An hour of blocks is about 12,000, so this delay runs well past the draw window.
const RAISED_DELAY_BLOCKS: u64 = 50_000;

async fn case_time(w: &World, id: u64, field: &str) -> u64 {
    case_json(w, id).await[field].as_str().unwrap().parse().unwrap()
}

// Council of ten seats, juries of five. The attacker proposes a wrong answer on the target market, then opens throwaway
// disputes until every seat is serving and leaves them open, which keeps every seat serving. The honest challenger's first draw finds no free
// seat. The case waits instead of ruling, and once the throwaway cases are finalized, as anyone can do, the retried draw seats a
// jury and the honest challenger is not charged.
#[tokio::test]
async fn a_dispute_whose_draw_was_starved_by_other_disputes_waits_for_seats_instead_of_ruling() -> anyhow::Result<()> {
    let mut w = setup().await?;
    let missing = COUNCIL_SEATS - w.jurors.len();
    add_jurors(&mut w, missing).await?;
    let target = new_market(&w, 120).await?;
    let mut throwaways = vec![];
    for _ in 0..COUNCIL_SEATS / JURY as usize {
        throwaways.push(new_market(&w, 120).await?);
    }
    skip_secs(&w.worker, 130).await;

    for id in &throwaways {
        propose(&w, &w.bob, *id, "yes").await?;
        challenge(&w, &w.alice, *id).await?;
        let jury = draw_jury(&w, *id).await?;
        assert_eq!(jury.len(), JURY as usize);
    }

    propose(&w, &w.carol, target, "yes").await?;
    challenge(&w, &w.dave, target).await?;
    wait_for_draw(&w, target).await;
    assert_eq!(event_names(&resolve_draw(&w, target).await?), vec!["draw_failed"]);

    skip_until(&w, case_time(&w, target, "draw_by").await + 1).await;
    finalize(&w, target).await?;
    let case = case_json(&w, target).await;
    assert_eq!(
        (&case["stage"], &case["round"]),
        (&json!("disputed"), &json!(0)),
        "the case waits for seats"
    );

    // Anyone can finalize the throwaway cases once their rounds are over: the silent first jury, then the second round nobody drew.
    for id in &throwaways {
        skip_until(&w, case_time(&w, *id, "panel_deadline").await + 1).await;
        finalize(&w, *id).await?;
        skip_until(&w, case_time(&w, *id, "draw_by").await + 1).await;
        finalize(&w, *id).await?;
        assert_eq!(case_json(&w, *id).await["stage"], "final");
    }
    // The wait for the target moved on window by window while that happened: one more call keeps it alive.
    skip_until(&w, case_time(&w, target, "draw_by").await + 1).await;
    finalize(&w, target).await?;
    assert_eq!(case_json(&w, target).await["round"], 0, "still waiting");
    wait_for_draw(&w, target).await;
    assert_eq!(
        event_names(&resolve_draw(&w, target).await?),
        vec!["jury_drawn", "jury_drawn"]
    );
    assert_eq!(case_json(&w, target).await["seated"], true);
    assert_eq!(claimable(&w, w.dave.id()).await, 0, "nothing was charged");
    Ok(())
}

// The draw delay is stored with each case. Here the first jury says nothing, the owner raises the delay, and the second jury of
// that same case is still drawable after the delay it was challenged under, not after the raised one, which would run far past
// the draw window and end the case as a no-decision.
#[tokio::test]
async fn a_draw_delay_set_during_a_case_does_not_delay_that_cases_second_jury() -> anyhow::Result<()> {
    let mut w = setup().await?;
    add_jurors(&mut w, SECOND_JURY).await?;
    let id = new_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let first = draw_jury(&w, id).await?;
    assert_eq!(first.len(), JURY as usize);
    let after_first = case_time(&w, id, "draw_after_height").await;

    skip_until(&w, case_time(&w, id, "panel_deadline").await + 1).await;
    w.owner
        .call(w.oracle.id(), "set_draw_delay_blocks")
        .args_json(json!({ "draw_delay_blocks": RAISED_DELAY_BLOCKS.to_string() }))
        .transact()
        .await?
        .into_result()?;
    finalize(&w, id).await?;
    let case = case_json(&w, id).await;
    assert_eq!(case["round"], 1);
    let height = w.worker.view_block().await?.height();
    let second = case_time(&w, id, "draw_after_height").await;
    assert!(
        second <= height + DRAW_DELAY_BLOCKS + 5,
        "the second jury may be drawn from block {second}, {} blocks after the first round's delay of {after_first} was set, \
         while the case was challenged under a delay of {DRAW_DELAY_BLOCKS}",
        second - height
    );
    let second_jury = draw_jury(&w, id).await?;
    assert_eq!(second_jury.len(), SECOND_JURY);
    Ok(())
}
