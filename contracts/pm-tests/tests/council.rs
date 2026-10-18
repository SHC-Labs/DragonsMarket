// The jury draw and the hidden votes. Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::types::Gas;
use near_workspaces::Account;
use serde_json::json;
use sha2::{Digest, Sha256};

// A closed market with a proposal by Carol challenged by Dave.
async fn disputed(w: &World) -> anyhow::Result<u64> {
    let id = create_seeded_market(w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(w, &w.carol, id, "yes").await?;
    challenge(w, &w.dave, id).await?;
    Ok(id)
}

fn ids(accounts: &[Account]) -> Vec<String> {
    let mut v: Vec<String> = accounts.iter().map(|a| a.id().to_string()).collect();
    v.sort();
    v
}

#[tokio::test]
async fn the_drawn_panel_never_includes_the_proposer_or_the_challenger() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors;
    // Carol and Dave stake seats too. Without them only two seats are eligible, one short of a jury.
    leave(&w, &[&j[2], &j[3], &j[4]]).await?;
    for who in [&w.carol, &w.dave] {
        mint_nft(&w, who, who.id().as_str()).await?;
        stake(&w, who, who.id().as_str()).await?;
    }
    let id = disputed(&w).await?;
    wait_for_draw(&w, id).await;
    assert_eq!(event_names(&resolve_draw(&w, id).await?), vec!["draw_failed"]);
    assert_eq!(case_json(&w, id).await["panel"], json!([]));

    stake(&w, &j[2], j[2].id().as_str()).await?;
    assert_eq!(event_names(&resolve_draw(&w, id).await?), vec!["jury_drawn"]);
    assert_eq!(ids(&panel(&w, id).await), ids(&j[..3]));
    Ok(())
}

#[tokio::test]
async fn a_jury_is_drawn_only_after_the_delay_and_only_once() -> anyhow::Result<()> {
    let w = setup_with(WINDOW_MS, PANEL_MS, 30).await?;
    let id = disputed(&w).await?;

    // Right after the challenge nobody knows the jury, because it does not exist yet.
    let case = case_json(&w, id).await;
    assert_eq!(case["panel"], json!([]));
    let after: u64 = case["draw_after_height"].as_str().unwrap().parse()?;
    assert!(w.worker.view_block().await?.height() < after);
    refused(resolve_draw(&w, id).await, "too early to draw the jury");
    refused(commit(&w, &w.jurors[0], id, "no", "s").await, "not on the panel for this case");

    let jury = draw_jury(&w, id).await?;
    let drawn = case_json(&w, id).await["panel"].clone();
    refused(resolve_draw(&w, id).await, "the jury is already drawn");
    assert_eq!(case_json(&w, id).await["panel"], drawn);
    assert_eq!(jury.len(), 3);
    Ok(())
}

#[tokio::test]
async fn not_enough_seats_fails_the_draw_and_a_retry_works_after_a_seat_is_staked() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors;
    leave(&w, &[&j[0], &j[1], &j[2]]).await?;
    let id = disputed(&w).await?;
    wait_for_draw(&w, id).await;
    assert_eq!(event_names(&resolve_draw(&w, id).await?), vec!["draw_failed"]);
    assert_eq!(case_json(&w, id).await["panel"], json!([]));

    stake(&w, &j[0], j[0].id().as_str()).await?;
    assert_eq!(event_names(&resolve_draw(&w, id).await?), vec!["jury_drawn"]);
    assert_eq!(ids(&panel(&w, id).await), ids(&[j[0].clone(), j[3].clone(), j[4].clone()]));
    Ok(())
}

#[tokio::test]
async fn two_draws_in_flight_end_with_one_jury() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = disputed(&w).await?;
    wait_for_draw(&w, id).await;
    let mut pending = vec![];
    for who in [&w.alice, &w.bob] {
        pending.push(
            who.call(w.oracle.id(), "resolve_draw")
                .args_json(json!({ "market_id": id.to_string() }))
                .gas(Gas::from_tgas(300))
                .transact_async()
                .await?,
        );
    }
    let mut drawn = vec![];
    let mut events = vec![];
    for p in pending {
        let r = p.await?;
        assert!(r.is_success(), "both draws were in flight together: {r:?}");
        for l in r.logs() {
            let e: serde_json::Value = serde_json::from_str(l.strip_prefix("EVENT_JSON:").unwrap())?;
            events.push(e["event"].as_str().unwrap().to_string());
            if e["event"] == "jury_drawn" {
                drawn.push(e["data"]["panel"].clone());
            }
        }
    }
    events.sort();
    assert_eq!(events, vec!["draw_failed", "jury_drawn"]);
    assert_eq!(case_json(&w, id).await["panel"], drawn[0], "the first draw to land is the jury");
    Ok(())
}

#[tokio::test]
async fn only_the_panel_commits_once_and_only_during_the_commit_phase() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = disputed(&w).await?;
    let jury = draw_jury(&w, id).await?;
    let outsider = w.jurors.iter().find(|j| !jury.iter().any(|p| p.id() == j.id())).unwrap();

    refused(commit(&w, outsider, id, "no", "s").await, "not on the panel for this case");
    refused(commit_vote(&w, &jury[0], id, &"A".repeat(64)).await, "commitment must be 64 lowercase hex characters");
    refused(commit_vote(&w, &jury[0], id, "abc123").await, "commitment must be 64 lowercase hex characters");
    commit(&w, &jury[0], id, "no", "s").await?;
    refused(commit(&w, &jury[0], id, "yes", "t").await, "already committed");
    refused(reveal(&w, &jury[0], id, "no", "s", "The source says no.").await, "the commit phase is still open");

    to_reveal_phase(&w, id).await;
    refused(commit(&w, &jury[1], id, "no", "s").await, "the commit phase is over");
    refused(reveal(&w, &jury[1], id, "no", "s", "The source says no.").await, "no commitment to reveal");
    reveal(&w, &jury[0], id, "no", "s", "The source says no.").await?;
    refused(reveal(&w, &jury[0], id, "no", "s", "Again.").await, "already revealed");
    let case = case_json(&w, id).await;
    assert_eq!(case["commits"].as_array().unwrap().len(), 1);
    assert_eq!(case["votes"], json!([{ "juror": jury[0].id(), "outcome": "no", "reason": "The source says no." }]));
    Ok(())
}

#[tokio::test]
async fn a_reveal_must_match_the_jurors_own_commitment() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = disputed(&w).await?;
    let jury = draw_jury(&w, id).await?;

    commit(&w, &jury[0], id, "no", "salt-a").await?;
    // The second juror copies the first one's commitment from the chain, hoping to vote the same way blind.
    let copied = case_json(&w, id).await["commits"][0]["commitment"].as_str().unwrap().to_string();
    assert_eq!(copied, commitment(jury[0].id(), "no", "salt-a"));
    commit_vote(&w, &jury[1], id, &copied).await?;
    // A commitment that leaves out the juror's own id is the shape a copy would need, so it never reveals.
    let unbound: String = Sha256::digest("yes:salt-c").iter().map(|b| format!("{b:02x}")).collect();
    commit_vote(&w, &jury[2], id, &unbound).await?;
    to_reveal_phase(&w, id).await;

    refused(reveal(&w, &jury[1], id, "no", "salt-a", "Same as them.").await, "the vote does not match the commitment");
    refused(reveal(&w, &jury[2], id, "yes", "salt-c", "Unbound.").await, "the vote does not match the commitment");
    refused(reveal(&w, &jury[0], id, "no", "salt-x", "Wrong salt.").await, "the vote does not match the commitment");
    refused(reveal(&w, &jury[0], id, "yes", "salt-a", "Wrong outcome.").await, "the vote does not match the commitment");
    reveal(&w, &jury[0], id, "no", "salt-a", "The source says no.").await?;
    assert_eq!(case_json(&w, id).await["votes"], json!([{ "juror": jury[0].id(), "outcome": "no", "reason": "The source says no." }]));
    Ok(())
}

#[tokio::test]
async fn revealed_votes_settle_early_and_a_silent_juror_does_not_block() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = disputed(&w).await?;
    let jury = draw_jury(&w, id).await?;
    commit(&w, &jury[0], id, "no", "a").await?;
    commit(&w, &jury[1], id, "no", "b").await?;
    commit(&w, &jury[2], id, "yes", "c").await?;
    to_reveal_phase(&w, id).await;

    reveal(&w, &jury[0], id, "no", "a", "The source says no.").await?;
    assert_eq!(case_json(&w, id).await["stage"], "disputed");
    reveal(&w, &jury[1], id, "no", "b", "No advisory was issued.").await?;
    let case = case_json(&w, id).await;
    let deadline: u64 = case["panel_deadline"].as_str().unwrap().parse()?;
    assert!(now(&w.worker).await < deadline, "settled before the deadline");
    assert_eq!(case["stage"], "final");
    assert_eq!(case["final_outcome"], "no");
    assert_eq!(case["applied"], true);
    assert_eq!(market_json(&w, id).await["outcome"], "no");
    // Dave won, so Carol's bond is the loser's: a quarter is split between the two jurors who revealed No, and Dave
    // keeps his own bond and the rest.
    assert_eq!(claimable(&w, w.dave.id()).await, 2 * BOND - BOND / 4);
    assert_eq!((claimable(&w, jury[0].id()).await, claimable(&w, jury[1].id()).await), (BOND / 8, BOND / 8));
    assert_eq!(claimable(&w, jury[2].id()).await, 0);
    assert_eq!(case["delinquent"], serde_json::json!([]), "the third juror committed and was given no chance to reveal");

    // The third juror never revealed. The case is closed to them now.
    refused(reveal(&w, &jury[2], id, "yes", "c", "Too late.").await, "no open dispute");
    Ok(())
}

#[tokio::test]
async fn a_case_whose_jury_is_never_drawn_ends_void_at_the_deadline() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = disputed(&w).await?;
    to_reveal_phase(&w, id).await;
    refused(resolve_draw(&w, id).await, "too late to draw a jury");
    refused(finalize(&w, id).await, "the panel still has time");

    let deadline: u64 = case_json(&w, id).await["panel_deadline"].as_str().unwrap().parse()?;
    skip_until(&w, deadline + 1).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "void");
    assert_eq!(claimable(&w, w.carol.id()).await, BOND);
    assert_eq!(claimable(&w, w.dave.id()).await, BOND);
    Ok(())
}
