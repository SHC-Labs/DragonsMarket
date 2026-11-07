// A challenge names an answer, jurors vote for one of two answers, and a jury that does not decide is followed by one
// larger jury. The jurors' clock starts when they are seated. Real contracts, sandbox chain.
mod common;
use common::*;
use serde_json::json;

fn tok(a: &near_workspaces::Account) -> &str {
    a.id().as_str()
}

async fn case_time(w: &World, id: u64, field: &str) -> u64 {
    case_json(w, id).await[field].as_str().unwrap().parse().unwrap()
}

// A closed market with Carol's proposal of Yes open for a challenge.
async fn proposed(w: &World) -> anyhow::Result<u64> {
    let id = new_market(w, 120).await?;
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
        (&json!("disputed"), &json!("void"), &json!(0), &json!(JURY))
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

// A jury of five that says nothing is no decision. One second jury of eleven, none of them from the first, decides it.
#[tokio::test]
async fn a_first_jury_that_does_not_decide_is_followed_by_one_larger_disjoint_jury_that_does() -> anyhow::Result<()> {
    let mut w = setup().await?;
    add_jurors(&mut w, SECOND_JURY).await?;
    let id = proposed(&w).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    challenge(&w, &w.dave, id).await?;
    let first = draw_jury(&w, id).await?;
    assert_eq!(first.len(), JURY as usize);

    let deadline = case_time(&w, id, "panel_deadline").await;
    skip_until(&w, deadline + 1).await;
    finalize(&w, id).await?;
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["round"], &case["jury_size"]),
        (&json!("disputed"), &json!(1), &json!(SECOND_JURY))
    );
    assert_eq!(
        case["first_panel"],
        json!(first.iter().map(|j| j.id()).collect::<Vec<_>>())
    );
    assert_eq!(case["panel"], json!([]));
    // The first jury was seated under the case's own id; the second round's key only differs by its top bit.
    assert!(
        stake_of(&w, tok(&first[0])).await["serving"] == json!(case_time(&w, id, "case_uid").await.to_string()),
        "the first jury's seat is held until the case is final"
    );

    let second = draw_jury(&w, id).await?;
    assert_eq!(second.len(), SECOND_JURY);
    assert!(
        second.iter().all(|j| first.iter().all(|f| f.id() != j.id())),
        "the second jury is other accounts"
    );
    for j in &second[..SECOND_MAJORITY] {
        commit(&w, j, id, "no", "a-long-random-salt").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &second[..SECOND_MAJORITY] {
        reveal(&w, j, id, "no", "a-long-random-salt", "The source says no.").await?;
    }
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["final_outcome"], &case["round"]),
        (&json!("final"), &json!("no"), &json!(1))
    );
    assert_eq!(market_json(&w, id).await["outcome"], "no");

    // Dave was right. A quarter of Carol's bond is split by the six who revealed No, and Dave keeps the rest.
    let each = BOND / 4 / SECOND_MAJORITY as u128;
    assert_eq!(
        claimable(&w, w.dave.id()).await,
        2 * BOND - each * SECOND_MAJORITY as u128
    );
    for j in &second[..SECOND_MAJORITY] {
        assert_eq!(claimable(&w, j.id()).await, each);
    }
    assert_eq!(claimable(&w, w.carol.id()).await, 0);

    // The silent first jury and the five silent jurors of the second never voted. Every seat of both juries is released.
    let silent: Vec<_> = first.iter().chain(&second[SECOND_MAJORITY..]).map(|j| j.id()).collect();
    assert_eq!(case["delinquent"], json!(silent));
    for j in first.iter().chain(&second) {
        assert!(
            stake_of(&w, tok(j)).await["serving"].is_null(),
            "{} is still held",
            j.id()
        );
    }
    Ok(())
}

// Exact draw_by boundaries are covered by oracle unit tests. Sandbox block skipping and receipts also advance time.
#[tokio::test]
async fn a_jury_drawn_late_gets_the_full_commit_and_reveal_period() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = proposed(&w).await?;
    challenge(&w, &w.dave, id).await?;
    let draw_by = case_time(&w, id, "draw_by").await;
    let late = draw_by - 300 * 1_000_000_000;
    skip_until(&w, late).await;
    let before_draw = now(&w.worker).await;
    assert!(
        before_draw >= late && before_draw < draw_by,
        "draw must start in the last five minutes: now={before_draw}, draw_by={draw_by}"
    );
    let jury = draw_jury(&w, id).await?;
    let after_draw = now(&w.worker).await;
    let (commit_ends, deadline) = (
        case_time(&w, id, "commit_ends_at").await,
        case_time(&w, id, "panel_deadline").await,
    );
    let half = PANEL_MS * 1_000_000 / 2;
    assert!(
        commit_ends >= before_draw + half && commit_ends <= after_draw + half,
        "commit clock must start during the draw: before={before_draw}, after={after_draw}, commit_ends={commit_ends}"
    );
    assert_eq!(
        deadline,
        commit_ends + half,
        "the reveal period follows the full commit period"
    );

    // The three who vote do so, and the two who never committed are the only ones at fault. Nobody is marked delinquent
    // for time they never had.
    for j in &jury[..MAJORITY] {
        commit(&w, j, id, "no", "a-long-random-salt").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..MAJORITY] {
        reveal(&w, j, id, "no", "a-long-random-salt", "The source says no.").await?;
    }
    let case = case_json(&w, id).await;
    assert_eq!(case["stage"], "final");
    assert_eq!(
        case["delinquent"],
        json!(jury[MAJORITY..].iter().map(|j| j.id()).collect::<Vec<_>>()),
        "only the jurors who never committed are at fault"
    );
    Ok(())
}

// A setting changed after the challenge touches only later cases.
#[tokio::test]
async fn a_jury_size_change_after_the_challenge_does_not_change_the_case() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = proposed(&w).await?;
    challenge(&w, &w.dave, id).await?;
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": JURY + 2 }))
        .transact()
        .await?
        .into_result()?;
    let jury = draw_jury(&w, id).await?;
    assert_eq!(jury.len(), JURY as usize, "the case was challenged with a jury of five");
    assert_eq!(case_json(&w, id).await["jury_size"], JURY);
    Ok(())
}
