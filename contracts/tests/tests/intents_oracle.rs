// The oracle on the NEAR Intents path: bonds arrive as an mt_transfer_call and leave as an mt_transfer from the oracle's own
// Intents account. Real contracts and the real verifier, sandbox chain.
mod common;
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

fn touched(r: &ExecutionFinalResult, who: &AccountId) -> bool {
    r.outcomes().iter().any(|o| &o.executor_id == who)
}

async fn public_keys_of(w: &World, who: &AccountId) -> Vec<Value> {
    w.verifier
        .view("public_keys_of")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

async fn predecessor_auth_enabled(w: &World, who: &AccountId) -> bool {
    w.verifier
        .view("is_auth_by_predecessor_id_enabled")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

// A market that has closed and is registered with the oracle, ready for a proposal.
async fn closed_market(w: &World) -> anyhow::Result<u64> {
    let id = create_seeded_market(w, 120).await?;
    skip_secs(&w.worker, 130).await;
    Ok(id)
}

// A case nobody challenged, final, with Carol's bond waiting to be withdrawn.
async fn unchallenged_and_final(w: &World) -> anyhow::Result<u64> {
    let id = closed_market(w).await?;
    propose(w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, 70).await;
    finalize(w, id).await?;
    assert_eq!(claimable(w, w.carol.id()).await, BOND);
    Ok(id)
}

// Carol proposes Yes, Dave challenges, and two of the three jurors reveal No: Dave wins. Returns the market id and the jury.
async fn decided_for_the_challenger(w: &World) -> anyhow::Result<(u64, Vec<Account>)> {
    let id = closed_market(w).await?;
    propose(w, &w.carol, id, "yes").await?;
    assert_oracle_reconciled(w).await;
    challenge(w, &w.dave, id).await?;
    assert_oracle_reconciled(w).await;
    let jury = draw_jury(w, id).await?;
    for j in &jury[..2] {
        commit(w, j, id, "no", "a-long-random-salt-0123456789").await?;
    }
    to_reveal_phase(w, id).await;
    for j in &jury[..2] {
        reveal(w, j, id, "no", "a-long-random-salt-0123456789", "The source says no.").await?;
    }
    assert_eq!(case_json(w, id).await["stage"], "final");
    Ok((id, jury))
}

// A bond moved by the sender's own mt_transfer_call is credited to the sender and to nobody else, the oracle's books match what the
// verifier holds for it, and it never registers a key or turns off predecessor authentication.
#[tokio::test]
async fn a_bond_through_the_real_verifier_is_credited_to_the_account_that_sent_it() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = closed_market(&w).await?;
    assert_eq!(oracle_total_owed(&w).await, 0);
    assert_oracle_reconciled(&w).await;

    let carol_before = intents_balance(&w, w.carol.id()).await;
    propose(&w, &w.carol, id, "yes").await?;
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["proposer"]),
        (&json!("proposed"), &json!(w.carol.id()))
    );
    assert_eq!(case["bond"], BOND.to_string());
    assert_eq!(
        holdings(&w, w.carol.id()).await,
        50 * USD - BOND,
        "the bond left Carol's holdings"
    );
    assert_eq!(intents_balance(&w, w.carol.id()).await, carol_before);
    assert_eq!(intents_balance(&w, w.oracle.id()).await, BOND);
    assert_eq!(oracle_total_owed(&w).await, BOND);
    assert_oracle_reconciled(&w).await;
    assert_eq!(
        ft_balance(&w, w.oracle.id()).await,
        0,
        "the oracle never holds the token itself"
    );

    challenge(&w, &w.dave, id).await?;
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["challenger"]),
        (&json!("disputed"), &json!(w.dave.id()))
    );
    assert_eq!(oracle_total_owed(&w).await, 2 * BOND);
    assert_oracle_reconciled(&w).await;
    assert_eq!(
        claimable(&w, w.carol.id()).await,
        0,
        "a bond held is not a bond claimable"
    );

    assert!(
        public_keys_of(&w, w.oracle.id()).await.is_empty(),
        "the oracle registered no key in the verifier"
    );
    assert!(
        predecessor_auth_enabled(&w, w.oracle.id()).await,
        "the oracle still authenticates by predecessor"
    );
    let oracle_config = config(&w.oracle).await;
    assert_eq!(
        (&oracle_config["verifier"], &oracle_config["collateral_token_id"]),
        (&json!(w.verifier.id()), &json!(token_id(&w)))
    );
    assert!(oracle_config.get("bond_token").is_none());
    Ok(())
}

// A panic in mt_on_transfer is the way the oracle says no: the verifier refunds the sender in full and reports that nothing was
// kept. Nothing on either side moves. One market has closed, so a bond of the right size would open a case on it and only the
// size or the text can be what refuses these, and one is still open for trading.
#[tokio::test]
async fn a_message_the_oracle_refuses_is_refunded_in_full_by_the_verifier() -> anyhow::Result<()> {
    let w = setup().await?;
    let closed = create_seeded_market(&w, 120).await?;
    let open = create_seeded_market(&w, 600).await?;
    skip_secs(&w.worker, 130).await;
    deposit_to_intents(&w, &w.carol, w.carol.id(), 30 * USD).await?;
    deposit_to_intents(&w, &w.dave, w.dave.id(), 30 * USD).await?;

    let cases = [
        (&w.carol, BOND, "hello".to_string()),
        (&w.carol, BOND, format!("propose:{closed}:maybe:https://x")),
        (&w.carol, BOND, format!("propose:{open}:yes:https://x")),
        (&w.carol, BOND, "propose:99:yes:https://x".to_string()),
        (&w.carol, BOND + 1, format!("propose:{closed}:yes:https://x")),
        (&w.carol, BOND - 1, format!("propose:{closed}:yes:https://x")),
        (&w.dave, BOND, format!("challenge:{closed}:no")),
        (&w.dave, BOND, "revenue".to_string()),
        (&w.dave, BOND, "deposit".to_string()),
    ];
    for (who, amount, msg) in cases {
        let (sender_before, oracle_held) = (
            intents_balance(&w, who.id()).await,
            intents_balance(&w, w.oracle.id()).await,
        );
        let r = intents_call(&w, who, w.oracle.id(), amount, &msg).await?;
        assert!(r.is_success(), "{msg}: the verifier call itself succeeds");
        assert_eq!(
            r.json::<Vec<String>>()?,
            vec!["0".to_string()],
            "{msg}: the verifier reports nothing kept"
        );
        assert_eq!(
            intents_balance(&w, who.id()).await,
            sender_before,
            "{msg}: refunded in full"
        );
        assert_eq!(intents_balance(&w, w.oracle.id()).await, oracle_held, "{msg}");
        assert_eq!(oracle_total_owed(&w).await, 0, "{msg}");
    }
    for id in [closed, open] {
        assert!(case_json(&w, id).await.is_null(), "no case opened on market {id}");
    }

    // The same bond with the right size and a good message is what the refusals above were standing in the way of.
    intents_call(
        &w,
        &w.carol,
        w.oracle.id(),
        BOND,
        &format!("propose:{closed}:yes:https://x"),
    )
    .await?
    .into_result()?;
    assert_eq!(case_json(&w, closed).await["proposer"], json!(w.carol.id()));
    Ok(())
}

// A second token deposited into the verifier has its own token id. The oracle refuses it, and the verifier returns it.
#[tokio::test]
async fn a_token_id_that_is_not_the_collateral_is_refused_by_the_oracle_and_refunded() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = closed_market(&w).await?;
    let other = w.worker.dev_deploy(&wasm("mock_ft")).await?;
    other
        .call("new")
        .args_json(json!({ "owner_id": w.dave.id() }))
        .transact()
        .await?
        .into_result()?;
    w.dave
        .call(other.id(), "mint")
        .args_json(json!({ "account_id": w.dave.id(), "amount": (100 * USD).to_string() }))
        .transact()
        .await?
        .into_result()?;
    w.dave
        .call(other.id(), "storage_deposit")
        .args_json(json!({ "account_id": w.verifier.id(), "registration_only": true }))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    w.dave
        .call(other.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": w.verifier.id(), "amount": (50 * USD).to_string(), "msg": w.dave.id() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let other_id = format!("nep141:{}", other.id());
    let balance_of = |who: AccountId| {
        let (verifier, other_id) = (w.verifier.clone(), other_id.clone());
        async move {
            let b: String = verifier
                .view("mt_balance_of")
                .args_json(json!({ "account_id": who, "token_id": other_id }))
                .await
                .unwrap()
                .json()
                .unwrap();
            b.parse::<u128>().unwrap()
        }
    };
    assert_eq!(balance_of(w.dave.id().clone()).await, 50 * USD);

    let r = w
        .dave
        .call(w.verifier.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": w.oracle.id(), "token_id": other_id, "amount": BOND.to_string(),
            "msg": format!("propose:{id}:yes:https://x")
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_success());
    assert_eq!(r.json::<Vec<String>>()?, vec!["0".to_string()], "nothing kept");
    assert_eq!(balance_of(w.dave.id().clone()).await, 50 * USD, "refunded");
    assert_eq!(
        balance_of(w.oracle.id().clone()).await,
        0,
        "the oracle holds none of it"
    );
    assert!(case_json(&w, id).await.is_null());
    assert_eq!(oracle_total_owed(&w).await, 0);
    Ok(())
}

// The hook trusts its caller only as the verifier it was configured with, and then checks what the verifier says. A call from
// anyone else is refused whatever it claims. Then the test plays a verifier it controls, so the checks after the caller check can
// be reached with a deliberately wrong delivery.
#[tokio::test]
async fn the_hook_refuses_an_unauthenticated_call_and_checks_the_delivery_as_well_as_the_caller() -> anyhow::Result<()>
{
    let w = setup().await?;
    let id = closed_market(&w).await?;
    let msg = format!("propose:{id}:yes:https://x");

    let direct = w
        .dave
        .call(w.oracle.id(), "mt_on_transfer")
        .args_json(json!({
            "sender_id": w.dave.id(), "previous_owner_ids": [w.dave.id()], "token_ids": [token_id(&w)],
            "amounts": [BOND.to_string()], "msg": msg
        }))
        .transact()
        .await?;
    refused(direct.into_result(), "only the verifier can deliver money");
    assert!(
        case_json(&w, id).await.is_null(),
        "a direct call opened no case and spent nothing"
    );
    assert_eq!(oracle_total_owed(&w).await, 0);

    let oracle = w.worker.dev_deploy(&wasm("oracle")).await?;
    let fake_verifier = &w.dave;
    let collateral = "nep141:usdc.test.near";
    oracle
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "market_contract": w.market.id(), "verifier_id": fake_verifier.id(),
            "collateral_token_id": collateral, "bond": BOND.to_string(), "window_ms": WINDOW_MS.to_string(),
            "panel_deadline_ms": PANEL_MS.to_string(), "draw_window_ms": DRAW_WINDOW_MS.to_string(),
            "council": w.council.id(), "jury_size": JURY, "draw_delay_blocks": DRAW_DELAY_BLOCKS.to_string(),
            "min_proposal_ms": MIN_PROPOSAL_MS.to_string(), "operator_id": w.owner.id(), "network": NETWORK,
            "price_threshold": PRICE_THRESHOLD, "no_decision_recipient": w.treasury.id()
        }))
        .transact()
        .await?
        .into_result()?;
    let deliver = |previous: Vec<&AccountId>, tokens: Vec<&str>, amounts: Vec<String>, msg: &str| {
        fake_verifier
            .call(oracle.id(), "mt_on_transfer")
            .args_json(json!({
                "sender_id": w.carol.id(), "previous_owner_ids": previous, "token_ids": tokens, "amounts": amounts, "msg": msg
            }))
            .transact()
    };
    let (carol, dave) = (w.carol.id(), w.dave.id());
    let bond = BOND.to_string();
    let bad = [
        (
            vec![dave],
            vec![collateral],
            vec![bond.clone()],
            "the money must come from the sender's own balance",
        ),
        (
            vec![],
            vec![collateral],
            vec![bond.clone()],
            "the money must come from the sender's own balance",
        ),
        (
            vec![carol, carol],
            vec![collateral],
            vec![bond.clone()],
            "the money must come from the sender's own balance",
        ),
        (
            vec![carol],
            vec!["nep141:other.test.near"],
            vec![bond.clone()],
            "wrong token",
        ),
        (vec![carol], vec!["usdc.test.near"], vec![bond.clone()], "wrong token"),
        (
            vec![carol],
            vec![collateral],
            vec!["0".to_string()],
            "amount must be positive",
        ),
        (
            vec![carol],
            vec![collateral],
            vec![(BOND + 1).to_string()],
            "send exactly the bond",
        ),
        (
            vec![carol, carol],
            vec![collateral, collateral],
            vec![bond.clone(), bond.clone()],
            "exactly one token and amount",
        ),
        (vec![carol], vec![], vec![bond.clone()], "exactly one token and amount"),
        (
            vec![carol],
            vec![collateral],
            vec![bond.clone(), bond.clone()],
            "exactly one token and amount",
        ),
    ];
    for (previous, tokens, amounts, why) in bad {
        let r = deliver(previous.clone(), tokens.clone(), amounts.clone(), &msg).await?;
        refused(r.into_result(), why);
    }
    // The oracle has no market registered, so the control delivery stops at the next check, after every one above passed.
    let r = deliver(vec![carol], vec![collateral], vec![bond.clone()], &msg).await?;
    refused(r.into_result(), "market is not registered");
    Ok(())
}

// A plain deposit to the oracle is surplus: the verifier credits the oracle's account and tells nobody. Nothing is credited to the
// sender, no callback runs, and total_owed does not move, so the difference is visible and stays unattributed.
#[tokio::test]
async fn a_plain_deposit_to_the_oracle_is_surplus_with_no_callback_and_no_credit() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = closed_market(&w).await?;
    assert_oracle_reconciled(&w).await;

    let propose_msg = format!("propose:{id}:yes:https://x");
    let old_form =
        json!({ "receiver_id": w.oracle.id(), "msg": propose_msg, "min_gas": 30_000_000_000_000u64 }).to_string();
    let mut surplus = 0;
    for msg in [w.oracle.id().to_string(), old_form, propose_msg] {
        let before = intents_balance(&w, w.oracle.id()).await;
        let r = w
            .carol
            .call(w.ft.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": w.verifier.id(), "amount": BOND.to_string(), "msg": msg }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        assert!(r.is_success(), "{msg}: the verifier accepts it");
        assert!(!touched(&r, w.oracle.id()), "{msg}: no receipt ran on the oracle");
        let gained = intents_balance(&w, w.oracle.id()).await - before;
        println!("deposit with msg {msg:?}: the oracle's Intents balance grew by {gained}");
        assert!(
            gained == 0 || gained == BOND,
            "{msg}: credited to the oracle or to the sender, nothing else"
        );
        surplus += gained;
    }
    assert!(surplus > 0, "at least the plain form credited the oracle");
    assert!(case_json(&w, id).await.is_null(), "no deposit opened a case");
    assert_eq!(claimable(&w, w.carol.id()).await, 0, "Carol was credited nothing");
    assert_eq!(oracle_total_owed(&w).await, 0, "the books do not move");
    assert_eq!(
        intents_balance(&w, w.oracle.id()).await - oracle_total_owed(&w).await,
        surplus,
        "the unattributed money is exactly the difference"
    );

    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;
    withdraw_bond(&w, &w.carol).await?;
    assert_eq!(
        intents_balance(&w, w.oracle.id()).await - oracle_total_owed(&w).await,
        surplus,
        "running a case through the oracle neither spends nor credits the surplus"
    );
    Ok(())
}

// A payout the verifier refuses leaves the claimable balance exactly where it was. Paused or locked, the oracle still takes bonds in
// where the verifier allows it, which is why the keeper must watch the lock.
#[tokio::test]
async fn a_bond_withdrawal_the_verifier_refuses_restores_the_claimable() -> anyhow::Result<()> {
    let w = setup().await?;
    unchallenged_and_final(&w).await?;
    let carol_intents = intents_balance(&w, w.carol.id()).await;
    assert_eq!(oracle_total_owed(&w).await, BOND);
    assert_oracle_reconciled(&w).await;

    lock_account(&w, w.oracle.id()).await?;
    let logs = withdraw_bond(&w, &w.carol).await?;
    assert_eq!(
        event_names(&logs),
        vec!["bond_payout_requested", "bond_payout_failed"],
        "{logs:?}"
    );
    assert_eq!(claimable(&w, w.carol.id()).await, BOND, "the claimable is back");
    assert_eq!(intents_balance(&w, w.carol.id()).await, carol_intents);
    assert_eq!(oracle_total_owed(&w).await, BOND);
    assert_oracle_reconciled(&w).await;
    unlock_account(&w, w.oracle.id()).await?;

    pause_transfers(&w).await?;
    let logs = withdraw_bond(&w, &w.carol).await?;
    assert_eq!(
        event_names(&logs),
        vec!["bond_payout_requested", "bond_payout_failed"],
        "{logs:?}"
    );
    assert_eq!(claimable(&w, w.carol.id()).await, BOND);
    assert_oracle_reconciled(&w).await;
    unpause_transfers(&w).await?;

    let logs = withdraw_bond(&w, &w.carol).await?;
    assert_eq!(
        event_names(&logs),
        vec!["bond_payout_requested", "mt_transfer", "bond_paid"],
        "{logs:?}"
    );
    assert_eq!(claimable(&w, w.carol.id()).await, 0);
    assert_eq!(intents_balance(&w, w.carol.id()).await, carol_intents + BOND);
    assert_eq!(oracle_total_owed(&w).await, 0);
    assert_oracle_reconciled(&w).await;
    refused(withdraw_bond(&w, &w.carol).await, "nothing to withdraw");
    Ok(())
}

// Propose, challenge, jury, reveal, settle, and every payee withdraws. After each step that has finished, the oracle's books say
// exactly what the verifier holds for it.
#[tokio::test]
async fn a_full_dispute_keeps_total_owed_equal_to_the_verifiers_balance() -> anyhow::Result<()> {
    let w = setup().await?;
    let (_, jury) = decided_for_the_challenger(&w).await?;
    assert_eq!(
        oracle_total_owed(&w).await,
        2 * BOND,
        "settling moves bonds into claimable"
    );
    assert_oracle_reconciled(&w).await;

    let payees = [
        (w.dave.clone(), 2 * BOND - 1_250_000),
        (jury[0].clone(), 625_000),
        (jury[1].clone(), 625_000),
    ];
    let mut left = 2 * BOND;
    for (who, due) in payees {
        assert_eq!(claimable(&w, who.id()).await, due);
        let before = intents_balance(&w, who.id()).await;
        let logs = withdraw_bond(&w, &who).await?;
        assert_eq!(
            event_names(&logs),
            vec!["bond_payout_requested", "mt_transfer", "bond_paid"],
            "{logs:?}"
        );
        assert_eq!(intents_balance(&w, who.id()).await - before, due, "paid into Intents");
        assert_eq!(claimable(&w, who.id()).await, 0);
        left -= due;
        assert_eq!(oracle_total_owed(&w).await, left);
        assert_oracle_reconciled(&w).await;
    }
    assert_eq!(left, 0);
    assert_eq!(
        intents_balance(&w, w.oracle.id()).await,
        0,
        "every unit went to its payee"
    );
    assert_eq!(
        claimable(&w, w.carol.id()).await,
        0,
        "the loser's bond went to the jurors and the winner"
    );
    Ok(())
}

// A second jury that decides nothing sends the proposer's refund and the recipient's half to claimable, and the same reconciliation
// holds through both of them withdrawing.
#[tokio::test]
async fn a_dispute_nobody_decided_pays_the_proposer_and_the_recipient_and_reconciles() -> anyhow::Result<()> {
    let w = setup().await?;
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": 1 }))
        .transact()
        .await?
        .into_result()?;
    send_revenue(&w, 100 * USD).await?;
    let council_held = intents_balance(&w, w.council.id()).await;
    let id = closed_market(&w).await?;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    for _ in 0..2 {
        draw_jury(&w, id).await?;
        let deadline: u64 = case_json(&w, id).await["panel_deadline"].as_str().unwrap().parse()?;
        skip_until(&w, deadline + 1).await;
        finalize(&w, id).await?;
    }
    assert_eq!(case_json(&w, id).await["stage"], "final");
    assert_eq!(oracle_total_owed(&w).await, 2 * BOND);
    assert_oracle_reconciled(&w).await;

    let (carol, recipient) = (2 * BOND - BOND / 2, BOND / 2);
    assert_eq!(claimable(&w, w.carol.id()).await, carol);
    assert_eq!(claimable(&w, w.dave.id()).await, 0);
    assert_eq!(claimable(&w, w.treasury.id()).await, recipient);

    let before = intents_balance(&w, w.treasury.id()).await;
    withdraw_bond(&w, &w.treasury).await?;
    assert_eq!(intents_balance(&w, w.treasury.id()).await - before, recipient);
    assert_eq!(oracle_total_owed(&w).await, carol);
    assert_oracle_reconciled(&w).await;
    withdraw_bond(&w, &w.carol).await?;
    assert_eq!(oracle_total_owed(&w).await, 0);
    assert_oracle_reconciled(&w).await;
    assert_eq!(
        intents_balance(&w, w.council.id()).await,
        council_held,
        "the recipient's share did not come out of the Council's revenue"
    );
    Ok(())
}

// R-06: juror pay and the no-decision share are paid out of the oracle's own Intents account, and holder revenue in the Council's
// account is not touched by a settlement or by any payout.
#[tokio::test]
async fn juror_pay_is_separate_from_holder_revenue() -> anyhow::Result<()> {
    let w = setup().await?;
    send_revenue(&w, 100 * USD).await?;
    let council_held = intents_balance(&w, w.council.id()).await;
    assert_eq!(council_held, 100 * USD);
    let received = u(&w.council.view("total_received").await?.json::<Value>()?);

    let (_, jury) = decided_for_the_challenger(&w).await?;
    assert_eq!(
        intents_balance(&w, w.council.id()).await,
        council_held,
        "a settlement does not touch it"
    );
    for who in [&jury[0], &jury[1], &w.dave] {
        withdraw_bond(&w, who).await?;
    }
    assert_eq!(
        intents_balance(&w, w.council.id()).await,
        council_held,
        "no payout came out of the Council's account"
    );
    assert_eq!(
        u(&w.council.view("total_received").await?.json::<Value>()?),
        received,
        "and the Council counted no bond as revenue"
    );
    assert_eq!(
        intents_balance(&w, w.oracle.id()).await,
        0,
        "the oracle paid them itself"
    );
    assert_oracle_reconciled(&w).await;
    Ok(())
}
