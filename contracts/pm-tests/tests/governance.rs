// Governance as the owner of the market, the oracle and the council. Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::types::Gas;
use near_workspaces::{AccountId, Contract};
use serde_json::json;

// create_market arguments for a market that closes a day from `t`.
fn market_args(title: &str, t: u64) -> serde_json::Value {
    let close_at = t + 86_400 * 1_000_000_000;
    json!({
        "title": title, "rule_text": "Resolves Yes if the test says so.", "resolution_source": "https://example.com/source",
        "void_policy": "Void if the test is cancelled.", "category": "world", "subcategory": "science",
        "close_at": close_at.to_string(), "resolve_by": (close_at + 3_600_000_000_000u64).to_string()
    })
}

async fn propose_owner(w: &World, c: &Contract, new_owner: &AccountId) -> anyhow::Result<()> {
    w.owner.call(c.id(), "propose_owner").args_json(json!({ "new_owner": new_owner })).transact().await?.into_result()?;
    Ok(())
}

#[tokio::test]
async fn the_fee_recipients_change_only_after_the_vote_and_the_timelock() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let m = &g.members;
    refused(
        w.owner
            .call(w.market.id(), "set_fee_recipients")
            .args_json(json!({ "revenue_pool": w.owner.id(), "business_wallet": w.owner.id() }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );

    let action = function_call(w.market.id(), "set_fee_recipients", json!({ "revenue_pool": w.alice.id(), "business_wallet": w.bob.id() }), 20);
    let id = gov_propose(&g, &m[1], action).await?;
    gov_vote(&g, &m[1], id, true).await?;
    gov_vote(&g, &m[2], id, true).await?;
    refused(gov_execute(&g, &w.carol, id).await, "not approved");
    gov_vote(&g, &m[3], id, true).await?;
    gov_vote(&g, &m[4], id, false).await?;
    let p = gov_proposal(&g, id).await;
    assert_eq!(p["stage"], "approved");
    assert_eq!(
        p["votes"],
        json!([{ "member": m[1].id(), "approve": true }, { "member": m[2].id(), "approve": true },
               { "member": m[3].id(), "approve": true }, { "member": m[4].id(), "approve": false }])
    );

    refused(gov_execute(&g, &w.carol, id).await, "the timelock has not passed");
    assert_eq!(config(&w.market).await["revenue_pool"], json!(w.council.id()), "nothing changes during the timelock");
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    assert_eq!(event_names(&gov_execute(&g, &w.carol, id).await?), vec!["call_sent", "fee_recipients_set", "executed"]);
    let c = config(&w.market).await;
    assert_eq!((&c["revenue_pool"], &c["business_wallet"]), (&json!(w.alice.id()), &json!(w.bob.id())));
    assert_eq!(gov_proposal(&g, id).await["stage"], "executed");
    Ok(())
}

#[tokio::test]
async fn governance_changes_the_councils_nft_contract_once_nothing_is_staked() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let j = &w.jurors;
    leave(&w, &[&j[0], &j[1], &j[2], &j[3], &j[4]]).await?;
    refused(
        w.owner.call(w.council.id(), "set_nft_contract").args_json(json!({ "nft_contract": w.alice.id() })).transact().await?.into_result(),
        "owner only",
    );

    let id = gov_pass(&g, function_call(w.council.id(), "set_nft_contract", json!({ "nft_contract": w.alice.id() }), 20)).await?;
    refused(gov_execute(&g, &w.carol, id).await, "the timelock has not passed");
    assert_eq!(config(&w.council).await["nft_contract"], json!(w.nft.id()));
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    assert_eq!(event_names(&gov_execute(&g, &w.carol, id).await?), vec!["call_sent", "executed"]);
    assert_eq!(config(&w.council).await["nft_contract"], json!(w.alice.id()));
    Ok(())
}

#[tokio::test]
async fn governance_changes_the_councils_unstake_cooldown_and_an_unstake_waits_the_new_length() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let longer = 10 * COOLDOWN_SECS * 1_000_000_000;
    refused(
        w.owner.call(w.council.id(), "set_cooldown_ns").args_json(json!({ "cooldown_ns": longer.to_string() })).transact().await?.into_result(),
        "owner only",
    );

    let id = gov_pass(&g, function_call(w.council.id(), "set_cooldown_ns", json!({ "cooldown_ns": longer.to_string() }), 20)).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    assert_eq!(event_names(&gov_execute(&g, &w.carol, id).await?), vec!["call_sent", "cooldown_set", "executed"]);
    assert_eq!(config(&w.council).await["cooldown_ns"], longer.to_string());

    // The old 60s no longer frees a seat.
    let seat = w.jurors[0].id().to_string();
    request_unstake(&w, &w.jurors[0], &seat).await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    refused(unstake(&w, &w.jurors[0], &seat).await, "the cooldown has not passed");
    Ok(())
}

// An approval does not stay armed for ever: anyone can execute, so an old one could otherwise be fired months later.
#[tokio::test]
async fn an_approved_change_nobody_executed_in_time_can_no_longer_be_executed() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let id = gov_pass(&g, function_call(w.oracle.id(), "set_jury_size", json!({ "jury_size": 5 }), 20)).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + EXECUTION_WINDOW_SECS + 30).await;
    assert_eq!(gov_proposal(&g, id).await["stage"], "expired");
    refused(gov_execute(&g, &w.carol, id).await, "the execution window has passed");
    assert_eq!(config(&w.oracle).await["jury_size"], JURY, "the old approval changed nothing");

    // A fresh proposal inside its window still executes.
    let fresh = gov_pass(&g, function_call(w.oracle.id(), "set_jury_size", json!({ "jury_size": 5 }), 20)).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    gov_execute(&g, &w.carol, fresh).await?;
    assert_eq!(config(&w.oracle).await["jury_size"], 5);
    Ok(())
}

// Governance can change the fees, but never above the ceilings written in the contract: a vote that tries is
// recorded as failed and changes nothing.
#[tokio::test]
async fn governance_changes_the_trade_fee_but_not_above_the_ceiling() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    refused(w.owner.call(w.market.id(), "set_fee_rate_bps").args_json(json!({ "fee_rate_bps": 100 })).transact().await?.into_result(), "owner only");
    let id = create_seeded_market(&w, 3_000).await?;
    let (_, fee_at_200) = quote_buy(&w, id, "yes", 10 * USD).await;

    let too_high = gov_pass(&g, function_call(w.market.id(), "set_fee_rate_bps", json!({ "fee_rate_bps": 501 }), 20)).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    assert_eq!(event_names(&gov_execute(&g, &w.carol, too_high).await?), vec!["call_sent", "execution_failed"]);
    assert_eq!(config(&w.market).await["fee_rate_bps"], 200);
    assert_eq!(gov_proposal(&g, too_high).await["stage"], "execution_failed");

    let doubled = gov_pass(&g, function_call(w.market.id(), "set_fee_rate_bps", json!({ "fee_rate_bps": 400 }), 20)).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    assert_eq!(event_names(&gov_execute(&g, &w.carol, doubled).await?), vec!["call_sent", "fee_rate_set", "executed"]);
    assert_eq!(config(&w.market).await["fee_rate_bps"], 400);
    let (_, fee_at_400) = quote_buy(&w, id, "yes", 10 * USD).await;
    assert!(fee_at_400 > fee_at_200 * 19 / 10 && fee_at_400 < fee_at_200 * 21 / 10, "twice the rate, about twice the fee: {fee_at_200} then {fee_at_400}");

    // And the trade is charged what was quoted.
    let before = fees(&w).await.0;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    assert_eq!(fees(&w).await.0 - before, fee_at_400);
    Ok(())
}

// The timelock lets everyone see a change coming. Members can use it: enough of them cancel an approved change
// before it takes effect, and it never does.
#[tokio::test]
async fn members_cancel_an_approved_change_during_its_timelock_and_it_never_takes_effect() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let id = gov_pass(&g, function_call(w.oracle.id(), "set_jury_size", json!({ "jury_size": 5 }), 20)).await?;
    let cancel = |m: &near_workspaces::Account| m.call(g.contract.id(), "cancel").args_json(json!({ "proposal_id": id.to_string() })).transact();

    refused(cancel(&w.alice).await?.into_result(), "members only");
    cancel(&g.members[3]).await?.into_result()?;
    cancel(&g.members[4]).await?.into_result()?;
    assert_eq!(gov_proposal(&g, id).await["stage"], "approved", "two of the three that are needed");
    refused(cancel(&g.members[3]).await?.into_result(), "already voted to cancel");
    cancel(&g.members[0]).await?.into_result()?;
    assert_eq!(gov_proposal(&g, id).await["stage"], "cancelled");

    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    refused(gov_execute(&g, &w.carol, id).await, "this proposal was cancelled");
    assert_eq!(config(&w.oracle).await["jury_size"], JURY);
    refused(
        g.members[1].call(g.contract.id(), "vote").args_json(json!({ "proposal_id": id.to_string(), "approve": true })).transact().await?.into_result(),
        "this proposal was cancelled",
    );

    // Other changes are untouched.
    let other = gov_pass(&g, function_call(w.oracle.id(), "set_jury_size", json!({ "jury_size": 7 }), 20)).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    gov_execute(&g, &w.carol, other).await?;
    assert_eq!(config(&w.oracle).await["jury_size"], 7);
    Ok(())
}

#[tokio::test]
async fn governance_changes_the_oracles_jury_size() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    refused(
        w.owner.call(w.oracle.id(), "set_jury_size").args_json(json!({ "jury_size": 5 })).transact().await?.into_result(),
        "owner only",
    );

    let id = gov_pass(&g, function_call(w.oracle.id(), "set_jury_size", json!({ "jury_size": 5 }), 20)).await?;
    refused(gov_execute(&g, &w.carol, id).await, "the timelock has not passed");
    assert_eq!(config(&w.oracle).await["jury_size"], JURY);
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    gov_execute(&g, &w.carol, id).await?;
    assert_eq!(config(&w.oracle).await["jury_size"], 5);
    Ok(())
}

#[tokio::test]
async fn ownership_moves_to_governance_only_when_it_accepts_and_the_old_key_is_locked_out() -> anyhow::Result<()> {
    let w = setup().await?;
    let g = deploy_governance(&w.worker).await?;
    let gov = g.contract.id();
    let contracts = [&w.market, &w.oracle, &w.council];
    for c in contracts {
        refused(
            w.alice.call(c.id(), "propose_owner").args_json(json!({ "new_owner": w.alice.id() })).transact().await?.into_result(),
            "owner only",
        );
        propose_owner(&w, c, gov).await?;
        assert_eq!(config(c).await["pending_owner"], json!(gov));
        refused(w.alice.call(c.id(), "accept_owner").transact().await?.into_result(), "not the proposed owner");
    }
    // Until governance accepts, the old key is still the owner.
    w.owner.call(w.oracle.id(), "set_jury_size").args_json(json!({ "jury_size": 5 })).transact().await?.into_result()?;
    assert_eq!(config(&w.market).await["owner"], json!(w.owner.id()));

    let mut ids = vec![];
    for c in contracts {
        ids.push(gov_pass(&g, function_call(c.id(), "accept_owner", json!({}), 10)).await?);
    }
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    for id in ids {
        assert_eq!(event_names(&gov_execute(&g, &w.alice, id).await?), vec!["call_sent", "owner_changed", "executed"]);
    }
    for c in contracts {
        let cfg = config(c).await;
        assert_eq!((&cfg["owner"], &cfg["pending_owner"]), (&json!(gov), &json!(null)));
    }

    let calls = [
        (&w.market, "set_fee_recipients", json!({ "revenue_pool": w.owner.id(), "business_wallet": w.owner.id() })),
        // set_paused is not here: it is now an operator-or-owner method, and the old owner key is still the
        // market's operator by default, so it keeps that narrower access on purpose. set_operator is owner only.
        (&w.market, "set_operator", json!({ "operator_id": w.alice.id() })),
        (&w.market, "set_fee_rate_bps", json!({ "fee_rate_bps": 1 })),
        (&w.market, "set_create_fee", json!({ "create_fee": "1" })),
        (&w.market, "propose_owner", json!({ "new_owner": w.owner.id() })),
        (&w.oracle, "set_jury_size", json!({ "jury_size": 7 })),
        (&w.oracle, "propose_owner", json!({ "new_owner": w.owner.id() })),
        (&w.council, "set_nft_contract", json!({ "nft_contract": w.owner.id() })),
        (&w.council, "set_cooldown_ns", json!({ "cooldown_ns": "1" })),
        (&w.council, "set_max_seats_per_account", json!({ "max_seats_per_account": 1 })),
        (&w.council, "propose_owner", json!({ "new_owner": w.owner.id() })),
    ];
    for (c, method, args) in calls {
        refused(w.owner.call(c.id(), method).args_json(args).transact().await?.into_result(), "owner only");
    }
    // The old owner key is still the market's operator, and keeps that narrower, routine access on purpose.
    w.owner.call(w.market.id(), "set_paused").args_json(json!({ "paused": true })).transact().await?.into_result()?;
    assert_eq!(config(&w.market).await["paused"], true);
    w.owner.call(w.market.id(), "set_paused").args_json(json!({ "paused": false })).transact().await?.into_result()?;

    let id = gov_pass(&g, function_call(w.oracle.id(), "set_jury_size", json!({ "jury_size": 7 }), 20)).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    gov_execute(&g, &w.alice, id).await?;
    assert_eq!(config(&w.oracle).await["jury_size"], 7);
    Ok(())
}

// The vote and the timelock cannot be reused: a call that failed stays failed.
#[tokio::test]
async fn a_call_that_fails_is_recorded_as_failed_and_cannot_be_retried() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let t = now(&w.worker).await;
    let id = gov_pass(&g, function_call(w.market.id(), "create_market", market_args("", t), 100)).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;

    let r = w
        .alice
        .call(g.contract.id(), "execute")
        .args_json(json!({ "proposal_id": id.to_string() }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let failures = r.receipt_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(&failures[0].executor_id, w.market.id());
    assert!(format!("{:?}", failures[0]).contains("title is required"));
    let logs: Vec<String> = r.into_result()?.logs().iter().map(|l| l.to_string()).collect();
    assert_eq!(event_names(&logs), vec!["call_sent", "execution_failed"]);
    assert_eq!(gov_proposal(&g, id).await["stage"], "execution_failed");

    refused(gov_execute(&g, &w.bob, id).await, "already executed");
    assert_eq!(config(&w.market).await["markets"], "0");
    Ok(())
}

#[tokio::test]
async fn two_executes_in_flight_fire_the_call_once() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let t = now(&w.worker).await;
    let id = gov_pass(&g, function_call(w.market.id(), "create_market", market_args("Will the test pass?", t), 100)).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    let mut pending = vec![];
    for who in [&w.alice, &w.bob] {
        pending.push(
            who.call(g.contract.id(), "execute")
                .args_json(json!({ "proposal_id": id.to_string() }))
                .gas(Gas::from_tgas(300))
                .transact_async()
                .await?,
        );
    }
    let mut events = vec![];
    let mut refusals = vec![];
    for p in pending {
        match p.await?.into_result() {
            Ok(r) => events.extend(event_names(&r.logs().iter().map(|l| l.to_string()).collect::<Vec<_>>())),
            Err(e) => refusals.push(format!("{e:?}")),
        }
    }
    let count = |name: &str| events.iter().filter(|e| *e == name).count();
    assert_eq!((count("call_sent"), count("market_created"), count("executed")), (1, 1, 1));
    assert_eq!(refusals.len(), 1);
    assert!(refusals[0].contains("already executed"), "{}", refusals[0]);
    assert_eq!(config(&w.market).await["markets"], "1", "the market was created once");
    assert_eq!(gov_proposal(&g, id).await["stage"], "executed");
    Ok(())
}
