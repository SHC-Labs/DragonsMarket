// A challenge names an answer, jurors vote for one of two answers, and a jury that does not decide is followed by one
// larger jury. The jurors' clock starts when they are seated. Real contracts, sandbox chain.
mod common;
use common::*;
use serde_json::json;

fn tok(a: &near_workspaces::Account) -> &str {
    a.id().as_str()
}

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

// A closed market with Carol's proposal of Yes open for a challenge.
async fn proposed(w: &World) -> anyhow::Result<u64> {
    let id = create_seeded_market(w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(w, &w.carol, id, "yes").await?;
    Ok(id)
}

#[tokio::test]
async fn a_challenge_must_name_a_different_answer_and_the_case_records_it() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = proposed(&w).await?;

    // Naming the proposed answer, or no answer, or a word that is not an answer, bounces and the bond comes back.
    let before = holdings(&w, w.dave.id()).await;
    for msg in [
        format!("challenge:{}:{id}:yes", w.market.id()),
        format!("challenge:{}:{id}", w.market.id()),
        format!("challenge:{}:{id}:maybe", w.market.id()),
    ] {
        let _ = ft_call(&w, &w.dave, w.oracle.id(), BOND, &msg).await;
        assert_eq!(holdings(&w, w.dave.id()).await, before, "{msg} was not bounced");
        assert_eq!(case_json(&w, id).await["stage"], "proposed");
    }

    challenge_with(&w, &w.dave, id, "void").await?;
    let case = case_json(&w, id).await;
    assert_eq!(
        (
            &case["stage"],
            &case["challenger_answer"],
            &case["round"],
            &case["jury_size"]
        ),
        (&json!("disputed"), &json!("void"), &json!(0), &json!(3))
    );
    assert_eq!(
        (&case["commit_ends_at"], &case["panel_deadline"]),
        (&json!("0"), &json!("0")),
        "the jurors' clock has not started"
    );
    let (challenged, draw_by) = (
        case_time(&w, id, "challenged_at").await,
        case_time(&w, id, "draw_by").await,
    );
    assert_eq!(draw_by - challenged, DRAW_WINDOW_MS * 1_000_000);
    Ok(())
}

#[tokio::test]
async fn jurors_can_only_vote_for_the_proposed_answer_or_the_challengers() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = proposed(&w).await?;
    challenge_with(&w, &w.dave, id, "no").await?;
    let jury = draw_jury(&w, id).await?;
    commit(&w, &jury[0], id, "void", "a-long-random-salt").await?;
    to_reveal_phase(&w, id).await;
    refused(
        reveal(&w, &jury[0], id, "void", "a-long-random-salt", "Neither.").await,
        "vote for the proposed answer or the challenger's answer",
    );
    assert!(case_json(&w, id).await["votes"].as_array().unwrap().is_empty());
    Ok(())
}

// A jury of one that says nothing is no decision. One second jury of three, none of them from the first, decides it.
#[tokio::test]
async fn a_first_jury_that_does_not_decide_is_followed_by_one_larger_disjoint_jury_that_does() -> anyhow::Result<()> {
    let w = setup().await?;
    set_jury_size(&w, 1).await?;
    let id = proposed(&w).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    challenge(&w, &w.dave, id).await?;
    let first = draw_jury(&w, id).await?;
    assert_eq!(first.len(), 1);

    let deadline = case_time(&w, id, "panel_deadline").await;
    skip_until(&w, deadline + 1).await;
    finalize(&w, id).await?;
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["round"], &case["jury_size"]),
        (&json!("disputed"), &json!(1), &json!(3))
    );
    assert_eq!(case["first_panel"], json!([first[0].id()]));
    assert_eq!(case["panel"], json!([]));
    // The first jury was seated under the case's own id; the second round's key only differs by its top bit.
    assert!(
        stake_of(&w, tok(&first[0])).await["serving"] == json!(case_time(&w, id, "case_uid").await.to_string()),
        "the first jury's seat is held until the case is final"
    );

    let second = draw_jury(&w, id).await?;
    assert_eq!(second.len(), 3);
    assert!(
        second.iter().all(|j| j.id() != first[0].id()),
        "the second jury is other accounts"
    );
    for j in &second[..2] {
        commit(&w, j, id, "no", "a-long-random-salt").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &second[..2] {
        reveal(&w, j, id, "no", "a-long-random-salt", "The source says no.").await?;
    }
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["final_outcome"], &case["round"]),
        (&json!("final"), &json!("no"), &json!(1))
    );
    assert_eq!(market_json(&w, id).await["outcome"], "no");

    // Dave was right. A quarter of Carol's bond is split by the two who revealed No, and Dave keeps the rest.
    assert_eq!(claimable(&w, w.dave.id()).await, 2 * BOND - BOND / 4);
    assert_eq!(
        (claimable(&w, second[0].id()).await, claimable(&w, second[1].id()).await),
        (BOND / 8, BOND / 8)
    );
    assert_eq!(claimable(&w, w.carol.id()).await, 0);

    // The silent first juror and the second jury's third juror never voted. Every seat of both juries is released.
    assert_eq!(case["delinquent"], json!([first[0].id(), second[2].id()]));
    for j in first.iter().chain(&second) {
        assert!(
            stake_of(&w, tok(j)).await["serving"].is_null(),
            "{} is still held",
            j.id()
        );
    }
    Ok(())
}

// The jury is drawn at the very end of the draw window and still has all of its own time to commit and to reveal.
#[tokio::test]
async fn a_jury_drawn_at_the_last_allowed_moment_still_gets_the_full_commit_period() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = proposed(&w).await?;
    challenge(&w, &w.dave, id).await?;
    let draw_by = case_time(&w, id, "draw_by").await;
    skip_until(&w, draw_by - 15 * 1_000_000_000).await;
    let jury = draw_jury(&w, id).await?;
    let seated = now(&w.worker).await;
    assert!(seated <= draw_by, "the draw landed inside the window");
    let (commit_ends, deadline) = (
        case_time(&w, id, "commit_ends_at").await,
        case_time(&w, id, "panel_deadline").await,
    );
    let half = PANEL_MS * 1_000_000 / 2;
    assert!(
        commit_ends >= seated + half - 5_000_000_000,
        "{} ns of commit period left",
        commit_ends - seated
    );
    assert!(deadline >= seated + 2 * half - 5_000_000_000);

    // The two who vote do so, and the third, who never committed, is the only one at fault. Nobody is marked delinquent
    // for time they never had.
    for j in &jury[..2] {
        commit(&w, j, id, "no", "a-long-random-salt").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..2] {
        reveal(&w, j, id, "no", "a-long-random-salt", "The source says no.").await?;
    }
    let case = case_json(&w, id).await;
    assert_eq!(case["stage"], "final");
    assert_eq!(
        case["delinquent"],
        json!([jury[2].id()]),
        "only the juror who never committed is at fault"
    );
    Ok(())
}

// A setting changed after the challenge touches only later cases.
#[tokio::test]
async fn a_jury_size_change_after_the_challenge_does_not_change_the_case() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = proposed(&w).await?;
    challenge(&w, &w.dave, id).await?;
    set_jury_size(&w, 5).await?;
    let jury = draw_jury(&w, id).await?;
    assert_eq!(jury.len(), 3, "the case was challenged with a jury of three");
    assert_eq!(case_json(&w, id).await["jury_size"], 3);
    Ok(())
}
