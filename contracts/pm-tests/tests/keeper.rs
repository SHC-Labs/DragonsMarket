// The keeper script, run for real against the sandbox chain with real signed transactions. Four things are stuck that
// only a call can unstick, and one run of the keeper sends each. Needs Node.
mod common;
use common::*;
use near_workspaces::types::Gas;
use serde_json::json;
use std::process::Command;

// The keeper reads the last final block, which trails the chain by a few blocks, so let it catch up first.
async fn keeper(w: &World, args: &[&str]) -> (String, bool) {
    w.worker.fast_forward(6).await.unwrap();
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../keeper/keeper.mjs");
    let rpc = w.worker.rpc_addr();
    let key = w.dave.secret_key().to_string();
    let mut command = Command::new("node");
    command.arg(script).args(args).args([
        "--rpc", &rpc, "--market", w.market.id().as_str(), "--oracle", w.oracle.id().as_str(), "--council", w.council.id().as_str(),
        "--account", w.dave.id().as_str(), "--key", &key,
    ]);
    let out = command.output().expect("node runs the keeper");
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    (text, out.status.success())
}

// A seeded market that closes in 120s and must be answered within 300s after that, with nobody to answer it.
async fn market_with_gap(w: &World, gap_secs: u64) -> anyhow::Result<u64> {
    let close_at = now(&w.worker).await + 120 * 1_000_000_000;
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .args_json(json!({
            "title": "Will nobody answer?", "rule_text": "Resolves Yes if it does.", "resolution_source": "https://example.com",
            "void_policy": "Void if cancelled.", "category": "tech", "subcategory": "ai",
            "close_at": close_at.to_string(), "resolve_by": (close_at + gap_secs * 1_000_000_000).to_string()
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    ft_call(w, &w.owner, w.market.id(), SEED, &format!("seed:{id}")).await?;
    Ok(id)
}

#[tokio::test]
async fn one_run_of_the_keeper_unsticks_everything_that_is_due_and_a_second_finds_nothing() -> anyhow::Result<()> {
    let w = setup().await?;
    let unfinalized = create_seeded_market(&w, 120).await?;
    let undrawn = create_seeded_market(&w, 120).await?;
    let locked = create_seeded_market(&w, 120).await?;
    let unanswered = market_with_gap(&w, 300).await?;
    skip_secs(&w.worker, 130).await;

    // 1. A proposal whose challenge window ends while the dispute below plays out. Nobody finalizes it.
    propose(&w, &w.carol, unfinalized, "yes").await?;

    // 2. A dispute that settles normally, then a seat put back as a failed unlock would have left it.
    propose(&w, &w.carol, locked, "yes").await?;
    challenge(&w, &w.dave, locked).await?;
    let jury = draw_jury(&w, locked).await?;
    for j in &jury[..2] {
        commit(&w, j, locked, "no", "s").await?;
    }
    to_reveal_phase(&w, locked).await;
    for j in &jury[..2] {
        reveal(&w, j, locked, "no", "s", "The source says no.").await?;
    }
    assert_eq!(case_json(&w, locked).await["stage"], "final");
    let token = jury[2].id().to_string();
    relock_seat(&w, &token, locked).await?;

    // 3. A challenge late enough that its jury is still drawable when the unanswered market's deadline has passed.
    let deadline: u64 = market_json(&w, unanswered).await["resolve_by"].as_str().unwrap().parse()?;
    skip_until(&w, deadline - 25 * 1_000_000_000).await;
    propose(&w, &w.carol, undrawn, "yes").await?;
    challenge(&w, &w.dave, undrawn).await?;
    skip_until(&w, deadline + 1_000_000_000).await;
    wait_for_draw(&w, undrawn).await;

    // Nothing has been sent yet.
    assert_eq!(case_json(&w, unfinalized).await["stage"], "proposed");
    assert!(case_json(&w, undrawn).await["panel"].as_array().unwrap().is_empty());
    assert!(market_json(&w, unanswered).await["outcome"].is_null());
    assert!(!stake_of(&w, &token).await["serving"].is_null());

    // A dry run says what is due and sends nothing.
    let (dry, ok) = keeper(&w, &["run", "--dry-run"]).await;
    assert!(ok, "{dry}");
    for due in [
        format!("due oracle.finalize({unfinalized})"),
        format!("due oracle.resolve_draw({undrawn})"),
        format!("due market.void_if_unresolved({unanswered})"),
        format!("due oracle.retry_unlock({locked})"),
    ] {
        assert!(dry.contains(&due), "{due} missing from:\n{dry}");
    }
    assert_eq!(case_json(&w, unfinalized).await["stage"], "proposed", "a dry run sends nothing");

    let (run, ok) = keeper(&w, &["run"]).await;
    assert!(ok, "{run}");
    for line in [
        format!("oracle.finalize({unfinalized}): ok"),
        format!("oracle.resolve_draw({undrawn}): ok"),
        format!("market.void_if_unresolved({unanswered}): ok"),
        format!("oracle.retry_unlock({locked}): ok"),
    ] {
        assert!(run.contains(&line), "{line} missing from:\n{run}");
    }

    assert_eq!(market_json(&w, unfinalized).await["outcome"], "yes");
    assert_eq!(case_json(&w, undrawn).await["panel"].as_array().unwrap().len(), 3);
    assert_eq!(market_json(&w, unanswered).await["outcome"], "void");
    assert!(stake_of(&w, &token).await["serving"].is_null(), "the seat is free again");

    // Everything due was sent, so a second run finds nothing.
    let (again, ok) = keeper(&w, &["run"]).await;
    assert!(ok, "{again}");
    assert!(again.contains("nothing due"), "{again}");
    Ok(())
}

#[tokio::test]
async fn the_deploy_check_reports_whether_the_council_can_seat_a_jury() -> anyhow::Result<()> {
    let w = setup().await?;
    for seed in [1u8, 2] {
        let key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        let public = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string());
        w.owner.call(w.oracle.id(), "add_publisher").args_json(json!({ "key": public })).transact().await?.into_result()?;
    }
    // Five seat holders and a jury of three: enough, with two to spare for a proposer and a challenger who hold seats.
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(ok && out.contains("5 different seat holders") && out.trim_end().ends_with("ok"), "{out}");

    // Raise the jury to 5: exactly as many holders as jurors, so a dispute whose parties hold seats cannot be drawn.
    w.owner.call(w.oracle.id(), "set_jury_size").args_json(json!({ "jury_size": 5 })).transact().await?.into_result()?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(!ok && out.contains("PROBLEM") && out.contains("7 are needed to be safe"), "{out}");

    // And 7 jurors with five holders: every draw fails.
    w.owner.call(w.oracle.id(), "set_jury_size").args_json(json!({ "jury_size": 7 })).transact().await?.into_result()?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(!ok && out.contains("every draw will fail"), "{out}");
    Ok(())
}
