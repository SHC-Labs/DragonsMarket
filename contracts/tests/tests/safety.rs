// Protections that keep money from getting stuck or decisions from being steered. Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::types::Gas;
use serde_json::json;

// A seeded market that closes in `close_in` seconds and must be answered within `answer_within` seconds after that.
async fn market_with_deadline(w: &World, close_in: u64, answer_within: u64) -> anyhow::Result<u64> {
    let t = now(&w.worker).await;
    let close_at = t + close_in * 1_000_000_000;
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .args_json(json!({
            "title": "Will the safety test pass?", "rule_text": "Resolves Yes if it does.", "resolution_source": "https://example.com",
            "void_policy": "Void if the test is cancelled.", "category": "tech", "subcategory": "ai",
            "close_at": close_at.to_string(), "resolve_by": (close_at + answer_within * 1_000_000_000).to_string()
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    assert_eq!(market_json(w, id).await["registered"], true);
    ft_call(w, &w.owner, w.market.id(), SEED, &format!("seed:{id}")).await?;
    Ok(id)
}

// resolve_by_deadline is the oracle's, and is open to anyone once resolve_by has passed. The market's own void is for an
// oracle that is gone, and stays shut for a grace period after that.
#[tokio::test]
async fn an_unanswered_market_is_voided_by_anyone_after_its_deadline_so_money_is_never_stuck() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = market_with_deadline(&w, 120, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    let (alice_yes, _) = shares(&w, id, w.alice.id()).await;
    let (_, bob_no) = shares(&w, id, w.bob.id()).await;
    let deadline_call = |who: &near_workspaces::Account| {
        who.call(w.oracle.id(), "resolve_by_deadline")
            .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
            .gas(Gas::from_tgas(100))
            .transact()
    };

    // Closed, nobody answers, and it is too early.
    skip_secs(&w.worker, 130).await;
    refused(
        deadline_call(&w.dave).await?.into_result(),
        "the answer deadline has not passed",
    );

    // Past the deadline a proposal could not finish any more, so it is refused and the bond comes back.
    skip_secs(&w.worker, 620).await;
    let before = holdings(&w, w.carol.id()).await;
    let _ = propose(&w, &w.carol, id, "yes").await;
    assert_eq!(holdings(&w, w.carol.id()).await, before, "a late bond is refunded");
    assert!(case_json(&w, id).await.is_null());

    // The market's own void is still shut: the deadline has passed but the grace period has not.
    refused(
        w.dave
            .call(w.market.id(), "void_if_unresolved")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result(),
        "the answer deadline and the 7 day grace period have not passed",
    );

    // A stranger asks the oracle, which voids it. Everyone redeems at the market's closing price.
    deadline_call(&w.dave).await?.into_result()?;
    let m = market_json(&w, id).await;
    assert_eq!(m["outcome"], "void");
    assert_eq!(m["status"], "resolved");
    let price = u(&m["void_price_yes"]);
    w.alice
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    w.bob
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_balance(&w, w.alice.id()).await, alice_yes * price / 1_000_000);
    assert_eq!(
        market_balance(&w, w.bob.id()).await,
        bob_no * (1_000_000 - price) / 1_000_000
    );
    assert!(invariant(&w, id).await);

    // Asking again changes nothing, and the market's own void refuses a market that is already resolved.
    deadline_call(&w.dave).await?.into_result()?;
    assert_eq!(market_json(&w, id).await["void_price_yes"], m["void_price_yes"]);
    refused(
        w.dave
            .call(w.market.id(), "void_if_unresolved")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result(),
        "already resolved",
    );
    Ok(())
}

// Nobody runs the keeper and no user calls anything from the proposal to well past the deadline. The proposal sat
// unchallenged, so it is the answer: the first caller after the deadline gets it applied, the traders are paid on it,
// the proposer gets the bond back, and the market's own void stayed shut the whole time.
#[tokio::test]
async fn a_keeper_outage_for_the_whole_answer_period_still_ends_with_the_proposed_answer() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = market_with_deadline(&w, 120, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    let (alice_yes, _) = shares(&w, id, w.alice.id()).await;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    let window_ends: u64 = case_json(&w, id).await["window_ends_at"].as_str().unwrap().parse()?;
    let resolve_by: u64 = market_json(&w, id).await["resolve_by"].as_str().unwrap().parse()?;
    assert!(
        window_ends < resolve_by,
        "the proposal was settleable well before the deadline"
    );

    // The outage: no finalize, no apply, no deadline call, until a second past resolve_by.
    skip_until(&w, resolve_by + 1_000_000_000).await;
    let stuck = case_json(&w, id).await;
    assert_eq!(stuck["stage"], "proposed", "still waiting for someone to finalize it");
    assert!(market_json(&w, id).await["outcome"].is_null());
    refused(
        w.dave
            .call(w.market.id(), "void_if_unresolved")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result(),
        "the answer deadline and the 7 day grace period have not passed",
    );
    refused(
        w.alice
            .call(w.market.id(), "redeem")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result(),
        "not resolved yet",
    );

    // Whoever comes back first asks the oracle, and it settles the case instead of voiding over it.
    w.dave
        .call(w.oracle.id(), "resolve_by_deadline")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let case = case_json(&w, id).await;
    assert_eq!(
        (
            case["stage"].as_str(),
            case["final_outcome"].as_str(),
            case["applied"].as_bool()
        ),
        (Some("final"), Some("yes"), Some(true))
    );
    assert_eq!(market_json(&w, id).await["outcome"], "yes");
    assert_eq!(claimable(&w, w.carol.id()).await, BOND, "the proposer's bond is back");

    // Yes holders are paid a unit a share and No holders nothing, and the market's own void is still shut.
    w.alice
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_balance(&w, w.alice.id()).await, alice_yes);
    w.bob
        .call(w.market.id(), "redeem")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_balance(&w, w.bob.id()).await, 0);
    assert!(invariant(&w, id).await);
    refused(
        w.dave
            .call(w.market.id(), "void_if_unresolved")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result(),
        "already resolved",
    );
    Ok(())
}

// The same outage with a dispute in it: nobody draws the jury, so no round can finish, and the deadline call ends the
// case with no decision. An event market goes Void. No jury was ever seated, so each side gets its own bond back and nobody
// else is paid.
#[tokio::test]
async fn a_keeper_outage_through_a_dispute_ends_in_a_void_at_the_deadline_not_in_a_stuck_market() -> anyhow::Result<()>
{
    let w = setup().await?;
    let id = create_seeded_market_gap(&w, 120, 600).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let resolve_by: u64 = market_json(&w, id).await["resolve_by"].as_str().unwrap().parse()?;
    skip_until(&w, resolve_by + 1_000_000_000).await;
    let stuck = case_json(&w, id).await;
    assert!(
        stuck["stage"] == "disputed" && stuck["panel"].as_array().unwrap().is_empty(),
        "nobody drew a jury"
    );
    refused(resolve_draw(&w, id).await, "too late to draw a jury");

    w.alice
        .call(w.oracle.id(), "resolve_by_deadline")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let case = case_json(&w, id).await;
    assert_eq!(
        (
            case["stage"].as_str(),
            case["final_outcome"].as_str(),
            case["applied"].as_bool()
        ),
        (Some("final"), Some("void"), Some(true))
    );
    let market = market_json(&w, id).await;
    assert_eq!(
        (market["outcome"].as_str(), market["status"].as_str()),
        (Some("void"), Some("resolved"))
    );
    assert_eq!(claimable(&w, w.carol.id()).await, BOND);
    assert_eq!(claimable(&w, w.dave.id()).await, BOND);
    assert_eq!(claimable(&w, w.treasury.id()).await, 0);
    assert_eq!(claimable(&w, w.owner.id()).await, 0);
    assert!(invariant(&w, id).await);
    Ok(())
}

#[tokio::test]
async fn the_owner_cannot_change_who_decides_an_open_dispute() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    let drawn = case_json(&w, id).await["panel"].clone();
    assert_eq!(
        drawn.as_array().unwrap().len(),
        3,
        "the jurors are fixed when the jury is drawn"
    );

    // The owner changes the jury size and cannot swap the collection while seats are staked. A drawn juror
    // cannot leave, and Alice stakes a new seat.
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": 5 }))
        .transact()
        .await?
        .into_result()?;
    refused(
        w.owner
            .call(w.council.id(), "set_nft_contract")
            .args_json(json!({ "nft_contract": w.alice.id() }))
            .transact()
            .await?
            .into_result(),
        "unstake every seat before changing the NFT contract",
    );
    refused(
        request_unstake(&w, &jury[0], jury[0].id().as_str()).await,
        "this seat is serving on an open case",
    );
    mint_nft(&w, &w.alice, "alice-seat").await?;
    stake(&w, &w.alice, "alice-seat").await?;
    assert_eq!(case_json(&w, id).await["panel"], drawn, "the open case keeps its jury");
    refused(resolve_draw(&w, id).await, "the jury is already drawn");

    // The new seat has no say in the open case.
    refused(
        commit(&w, &w.alice, id, "yes", "s").await,
        "not on the panel for this case",
    );

    // The original jurors still decide it, by a majority of the original three.
    for j in &jury[..2] {
        commit(&w, j, id, "no", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..2] {
        reveal(&w, j, id, "no", "s", "The source says no.").await?;
    }
    let case = case_json(&w, id).await;
    assert_eq!(case["stage"], "final");
    assert_eq!(case["final_outcome"], "no");
    Ok(())
}

#[tokio::test]
async fn a_jury_must_be_an_odd_size_of_at_most_21() -> anyhow::Result<()> {
    let w = setup().await?;
    let jury_size = |w: &World| {
        let oracle = w.oracle.clone();
        async move {
            oracle
                .view("config")
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .unwrap()["jury_size"]
                .clone()
        }
    };
    for bad in [0, 2, 4, 23] {
        refused(
            w.owner
                .call(w.oracle.id(), "set_jury_size")
                .args_json(json!({ "jury_size": bad }))
                .transact()
                .await?
                .into_result(),
            "jury size must be odd and at most 21",
        );
    }
    assert_eq!(jury_size(&w).await, 3);
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": 21 }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(jury_size(&w).await, 21);
    // Only the owner may change it.
    refused(
        w.alice
            .call(w.oracle.id(), "set_jury_size")
            .args_json(json!({ "jury_size": 1 }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );

    // A new oracle with an even jury is refused at init.
    let other = w
        .worker
        .dev_deploy(&std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/near/oracle/oracle.wasm"
        ))?)
        .await?;
    let r = other
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "market_contract": w.market.id(), "verifier_id": w.verifier.id(),
            "collateral_token_id": token_id(&w), "bond": BOND.to_string(), "window_ms": WINDOW_MS.to_string(), "panel_deadline_ms": PANEL_MS.to_string(), "draw_window_ms": DRAW_WINDOW_MS.to_string(),
            "council": w.council.id(), "jury_size": 4, "draw_delay_blocks": "2", "min_proposal_ms": "60000",
            "operator_id": w.owner.id(), "network": "sandbox", "price_threshold": 2,
            "no_decision_recipient": w.treasury.id()
        }))
        .transact()
        .await?
        .into_result();
    refused(r, "jury size must be odd and at most 21");
    Ok(())
}

// A proposal is refused unless there is real slack, beyond the challenge window and the panel deadline,
// for the final apply() call to reach the market before a permissionless void could race it.
#[tokio::test]
async fn a_late_proposal_is_refused_when_apply_could_not_land_but_an_early_one_opens() -> anyhow::Result<()> {
    let w = setup().await?;
    // Both markets leave 600s after close. A proposal needs the window, two rounds of a draw window and a panel
    // deadline, and the buffer, 450s of it left, so it is accepted until 150s after close and refused after. (skip_secs
    // and real transaction time both drift a little, so each check keeps 30s or more of headroom from that line.)
    let late = market_with_deadline(&w, 120, 600).await?;
    let early = market_with_deadline(&w, 120, 600).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, early, "yes").await?;
    assert_eq!(
        case_json(&w, early).await["stage"],
        "proposed",
        "10s after close there is room for a case to finish"
    );

    skip_secs(&w.worker, 180).await;
    let before = holdings(&w, w.carol.id()).await;
    let _ = propose(&w, &w.carol, late, "yes").await;
    assert_eq!(
        holdings(&w, w.carol.id()).await,
        before,
        "a bond with no room for apply() is refunded"
    );
    assert!(case_json(&w, late).await.is_null(), "no case opened 190s after close");
    Ok(())
}

// A market whose deadline leaves no room for any case to finish could only end in a flat-half Void, which pays
// whoever holds the cheap side. The oracle refuses to register it, and market keeps an unregistered market shut.
#[tokio::test]
async fn a_market_that_leaves_too_little_time_to_resolve_never_opens() -> anyhow::Result<()> {
    let w = setup().await?;
    assert_eq!(
        config(&w.oracle).await["min_resolve_gap_ns"],
        (MIN_RESOLVE_GAP_SECS * 1_000_000_000).to_string()
    );
    let t = now(&w.worker).await;
    let close_at = t + 120 * 1_000_000_000;
    let create = |gap_ns: u64| {
        w.owner
            .call(w.market.id(), "create_market")
            .args_json(json!({
                "title": "Gap test", "rule_text": "Resolves Yes if it does.", "resolution_source": "https://example.com",
                "void_policy": "Void if cancelled.", "category": "tech", "subcategory": "ai",
                "close_at": close_at.to_string(), "resolve_by": (close_at + gap_ns).to_string()
            }))
            .gas(Gas::from_tgas(100))
            .transact()
    };

    let too_short: String = create(MIN_RESOLVE_GAP_SECS * 1_000_000_000 - 1)
        .await?
        .into_result()?
        .json()?;
    let too_short: u64 = too_short.parse()?;
    assert_eq!(
        market_json(&w, too_short).await["registered"],
        false,
        "one nanosecond short: the oracle refused it"
    );
    w.owner
        .call(w.market.id(), "retry_register")
        .args_json(json!({ "market_id": too_short.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        market_json(&w, too_short).await["registered"],
        false,
        "retrying cannot change the dates"
    );
    let before = holdings(&w, w.owner.id()).await;
    ft_call(&w, &w.owner, w.market.id(), SEED, &format!("seed:{too_short}")).await?;
    assert_eq!(
        holdings(&w, w.owner.id()).await,
        before,
        "the seed is refunded: the market cannot be funded or traded"
    );
    assert_eq!(u(&market_json(&w, too_short).await["locked"]), 0);

    let exact: String = create(MIN_RESOLVE_GAP_SECS * 1_000_000_000)
        .await?
        .into_result()?
        .json()?;
    let exact: u64 = exact.parse()?;
    assert_eq!(
        market_json(&w, exact).await["registered"],
        true,
        "exactly the minimum gap registers"
    );
    Ok(())
}

#[tokio::test]
async fn oversized_evidence_and_reasons_are_refused() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;

    // A 600 byte evidence link is refused and the bond is refunded.
    let before = holdings(&w, w.carol.id()).await;
    let long = "a".repeat(600);
    let _ = ft_call(
        &w,
        &w.carol,
        w.oracle.id(),
        BOND,
        &format!("propose:{}:{id}:yes:https://example.com/{long}", w.market.id()),
    )
    .await;
    assert_eq!(holdings(&w, w.carol.id()).await, before);
    assert!(case_json(&w, id).await.is_null());

    // A normal one works, and a 1200 byte juror reason or a 65 byte salt is refused.
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    let long_salt = "s".repeat(65);
    commit(&w, &jury[0], id, "no", "s").await?;
    commit(&w, &jury[1], id, "no", &long_salt).await?;
    to_reveal_phase(&w, id).await;
    refused(
        reveal(&w, &jury[0], id, "no", "s", &"r".repeat(1200)).await,
        "reason is too long",
    );
    refused(
        reveal(&w, &jury[1], id, "no", &long_salt, "The source says no.").await,
        "salt is too long",
    );
    reveal(&w, &jury[0], id, "no", "s", &"r".repeat(1000)).await?;
    Ok(())
}

// settle() sends unlock_case once and does not wait for it. If that call fails the jury's seats are stuck as serving,
// and anyone can call retry_unlock to send it again.
#[tokio::test]
async fn a_failed_unlock_leaves_seats_locked_until_anyone_retries_it() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;
    let retry = |who: &near_workspaces::Account| {
        who.call(w.oracle.id(), "retry_unlock")
            .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
            .gas(Gas::from_tgas(100))
            .transact()
    };

    // Nothing to unlock before there is a case, or while it is only proposed or still being decided.
    refused(retry(&w.dave).await?.into_result(), "no case for that market");
    propose(&w, &w.carol, id, "yes").await?;
    refused(retry(&w.dave).await?.into_result(), "no settled dispute to unlock");
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    refused(retry(&w.dave).await?.into_result(), "no settled dispute to unlock");

    for j in &jury[..2] {
        commit(&w, j, id, "no", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..2] {
        reveal(&w, j, id, "no", "s", "The source says no.").await?;
    }
    assert_eq!(case_json(&w, id).await["stage"], "final");
    let token = jury[2].id().to_string();
    assert!(
        stake_of(&w, &token).await["serving"].is_null(),
        "the normal unlock freed the seat"
    );

    // Put one seat back as a failed unlock would have left it.
    relock_seat(&w, &token, id).await?;
    assert_eq!(stake_of(&w, &token).await["serving"], council_key(&w, id).await);
    refused(
        request_unstake(&w, &jury[2], &token).await,
        "this seat is serving on an open case",
    );

    // A stranger retries, and the seat is free again.
    retry(&w.dave).await?.into_result()?;
    assert!(stake_of(&w, &token).await["serving"].is_null());
    request_unstake(&w, &jury[2], &token).await?;

    // Retrying again changes nothing and does not fail.
    retry(&w.dave).await?.into_result()?;
    Ok(())
}

#[tokio::test]
async fn an_unchallenged_case_has_no_jury_to_unlock() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;
    assert_eq!(case_json(&w, id).await["stage"], "final");
    refused(
        w.dave
            .call(w.oracle.id(), "retry_unlock")
            .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result(),
        "no settled dispute to unlock",
    );
    Ok(())
}

// Seeding away from one half leaves the seeder holding shares, one position for each market. The operator, here the owner
// account, seeds 25 of them: more than the 20 positions an ordinary account can hold.
#[tokio::test]
async fn the_operator_can_seed_25_markets_away_from_one_half() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.owner.id(), 5_000 * USD).await?;
    let mut ids = vec![];
    for _ in 0..25 {
        let id = create_market(&w, 600, 3_600).await?;
        ft_call(&w, &w.owner, w.market.id(), SEED, &format!("seed:{id}:300000")).await?;
        ids.push(id);
    }
    for id in ids {
        assert!(u(&market_json(&w, id).await["locked"]) > 0, "market {id} was seeded");
        assert_ne!(
            shares(&w, id, w.owner.id()).await,
            (0, 0),
            "the seeder holds the shares the pools do not"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_market_cannot_be_seeded_once_it_has_closed() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_market(&w, 20, 3_600).await?;
    skip_secs(&w.worker, 30).await;
    let before = holdings(&w, w.owner.id()).await;
    ft_call(&w, &w.owner, w.market.id(), SEED, &format!("seed:{id}")).await?;
    assert_eq!(holdings(&w, w.owner.id()).await, before, "the seed came back");
    assert_eq!(u(&market_json(&w, id).await["locked"]), 0);
    Ok(())
}

#[tokio::test]
async fn a_resolved_market_cannot_be_resumed() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    let call = |method: &str| {
        w.owner
            .call(w.market.id(), method)
            .args_json(json!({ "market_id": id.to_string(), "reason": "checking" }))
            .transact()
    };
    call("halt").await?.into_result()?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "yes");
    refused(call("resume").await?.into_result(), "already resolved");
    Ok(())
}
