// Outcome review of disputes: what a challenger can lose through no fault of their own, and whether a setting changed during a
// case reaches into it. Real contracts, sandbox chain.
mod common;
use common::*;
use serde_json::json;

async fn set_jury_size(w: &World, size: u32) -> anyhow::Result<()> {
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": size }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn case_time(w: &World, id: u64, field: &str) -> u64 {
    case_json(w, id).await[field].as_str().unwrap().parse().unwrap()
}

// Council of five seats, juries of one. The attacker proposes a wrong answer on the target market, then opens one throwaway
// dispute per seat and leaves them open, which keeps every seat serving. The honest challenger's first draw finds no free
// seat. The case waits instead of ruling, and once the throwaway cases are finalized, as anyone can do, the retried draw seats a
// jury and the honest challenger is not charged.
#[tokio::test]
async fn a_dispute_whose_draw_was_starved_by_other_disputes_waits_for_seats_instead_of_ruling() -> anyhow::Result<()> {
    let w = setup().await?;
    set_jury_size(&w, 1).await?;
    let target = new_market(&w, 120).await?;
    let mut throwaways = vec![];
    for _ in 0..5 {
        throwaways.push(new_market(&w, 120).await?);
    }
    skip_secs(&w.worker, 130).await;

    for id in &throwaways {
        propose(&w, &w.bob, *id, "yes").await?;
        challenge(&w, &w.alice, *id).await?;
        let jury = draw_jury(&w, *id).await?;
        assert_eq!(jury.len(), 1);
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

// Known and left open: the draw delay is read live, so a change reaches an open case (owner only, low). Fixing it needs a new
// stored-case version, so the regression test stays ignored until then. The draw delay is read from the live setting when the second round starts, so a change made while a case is
// open reaches into it. Here the first jury says nothing, the owner raises the delay, and the second jury cannot be drawn for
// 5000 blocks, far past the draw window. The case then ends as a no-decision on a delay nobody had when it was challenged.
#[tokio::test]
#[ignore = "known issue: the draw delay is read live; fixing it needs a stored-case version"]
async fn a_draw_delay_set_during_a_case_does_not_delay_that_cases_second_jury() -> anyhow::Result<()> {
    let w = setup().await?;
    set_jury_size(&w, 1).await?;
    let id = new_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let first = draw_jury(&w, id).await?;
    assert_eq!(first.len(), 1);
    let after_first = case_time(&w, id, "draw_after_height").await;

    skip_until(&w, case_time(&w, id, "panel_deadline").await + 1).await;
    w.owner
        .call(w.oracle.id(), "set_draw_delay_blocks")
        .args_json(json!({ "draw_delay_blocks": "5000" }))
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
    Ok(())
}
