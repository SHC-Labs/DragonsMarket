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
        (&w.market, "propose_owner", json!({ "new_owner": w.owner.id() })),
        (&w.oracle, "set_jury_size", json!({ "jury_size": 7 })),
        (&w.oracle, "propose_owner", json!({ "new_owner": w.owner.id() })),
        (&w.council, "set_nft_contract", json!({ "nft_contract": w.owner.id() })),
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
