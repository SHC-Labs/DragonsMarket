// Attacks. Each test plays an attacker against the real contracts on the sandbox chain and checks that it fails, or, where it
// cannot be stopped, measures what it is worth. The attacker is Dave, an account with no role anywhere unless a test says so.
mod common;
use common::*;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::Account;
use serde_json::json;

const GAS: Gas = Gas::from_tgas(100);

async fn attempt(
    attacker: &Account,
    to: &near_workspaces::AccountId,
    method: &str,
    args: serde_json::Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(attacker.call(to, method).args_json(args).gas(GAS).transact().await?)
}

// ---- who may call what ---------------------------------------------------------------------------------------------

// Every method that is meant to be restricted refuses a stranger, with the restriction's own message and not some other
// failure, so the check is what stopped it. A separate owner fixture isolates owner permissions from the operator key.
#[tokio::test]
async fn every_restricted_method_refuses_a_stranger() -> anyhow::Result<()> {
    let (w, _admin) = setup_admin_owned().await?;
    let me = w.dave.id();
    let key = "ed25519:6E8bKz2P1mXhL4G9QdQfJm9xYb1Qb3Ls9mT8Fq7z1xAB";
    let market_args = json!({ "title": "t", "rule_text": "r", "resolution_source": "s", "void_policy": "v", "category": "a", "subcategory": "b",
        "close_at": "1", "resolve_by": "2" });
    let stake =
        json!({ "owner": me, "staked_at": "0", "unlock_requested_at": null, "serving": null, "booked_to": "0" });

    let cases: Vec<(&Contractish, &str, serde_json::Value, &str)> = vec![
        (
            &Contractish::Market,
            "propose_owner",
            json!({ "new_owner": me }),
            "owner only",
        ),
        (
            &Contractish::Market,
            "accept_owner",
            json!({}),
            "not the proposed owner",
        ),
        (
            &Contractish::Market,
            "set_operator",
            json!({ "operator_id": me }),
            "owner only",
        ),
        (
            &Contractish::Market,
            "create_market",
            market_args,
            "operator or owner only",
        ),
        (
            &Contractish::Market,
            "retry_register",
            json!({ "market_id": "0" }),
            "operator or owner only",
        ),
        (
            &Contractish::Market,
            "halt",
            json!({ "market_id": "0", "reason": "x" }),
            "operator or owner only",
        ),
        (
            &Contractish::Market,
            "resume",
            json!({ "market_id": "0" }),
            "operator or owner only",
        ),
        (
            &Contractish::Market,
            "set_paused",
            json!({ "paused": true }),
            "operator or owner only",
        ),
        (
            &Contractish::Market,
            "claim_residual",
            json!({ "market_id": "0" }),
            "operator or owner only",
        ),
        (
            &Contractish::Market,
            "set_fee_recipients",
            json!({ "revenue_pool": me, "treasury": me }),
            "owner only",
        ),
        (
            &Contractish::Market,
            "set_revenue_share_bps",
            json!({ "revenue_share_bps": 2500 }),
            "owner only",
        ),
        (
            &Contractish::Market,
            "set_min_sweep",
            json!({ "min_sweep": "1" }),
            "owner only",
        ),
        (
            &Contractish::Market,
            "set_next_sweep_id",
            json!({ "next_sweep_id": "100" }),
            "owner only",
        ),
        (
            &Contractish::Market,
            "reconcile_leg",
            json!({ "sweep_id": "1", "leg": "council", "arrived": true }),
            "owner only",
        ),
        (
            &Contractish::Market,
            "set_fee_rate_bps",
            json!({ "fee_rate_bps": 0 }),
            "owner only",
        ),
        (
            &Contractish::Market,
            "set_create_fee",
            json!({ "create_fee": "0" }),
            "owner only",
        ),
        (
            &Contractish::Market,
            "set_outcome",
            json!({ "market_id": "0", "outcome": "yes" }),
            "oracle only",
        ),
        (
            &Contractish::Market,
            "on_registered",
            json!({ "market_id": "0" }),
            "private",
        ),
        (
            &Contractish::Market,
            "on_withdraw",
            json!({ "account": me, "amount": "1" }),
            "private",
        ),
        (
            &Contractish::Market,
            "on_revenue_sent",
            json!({ "sweep_id": "1" }),
            "private",
        ),
        (
            &Contractish::Market,
            "on_treasury_sent",
            json!({ "sweep_id": "1" }),
            "private",
        ),
        (
            &Contractish::Market,
            "on_council_checked",
            json!({ "sweep_id": "1" }),
            "private",
        ),
        (
            &Contractish::Market,
            "on_forwarded",
            json!({ "sender_id": me, "amount": "1", "arrival": "deposit" }),
            "private",
        ),
        (
            &Contractish::Oracle,
            "propose_owner",
            json!({ "new_owner": me }),
            "owner only",
        ),
        (
            &Contractish::Oracle,
            "accept_owner",
            json!({}),
            "not the proposed owner",
        ),
        (
            &Contractish::Oracle,
            "set_jury_size",
            json!({ "jury_size": 1 }),
            "owner only",
        ),
        (
            &Contractish::Oracle,
            "set_operator",
            json!({ "operator_id": me }),
            "owner only",
        ),
        (
            &Contractish::Oracle,
            "add_publisher",
            json!({ "key": key }),
            "owner only",
        ),
        (
            &Contractish::Oracle,
            "remove_publisher",
            json!({ "key": key }),
            "operator or owner only",
        ),
        (
            &Contractish::Oracle,
            "set_price_threshold",
            json!({ "threshold": 1 }),
            "owner only",
        ),
        (
            &Contractish::Oracle,
            "register_market",
            json!({ "market_id": "9", "close_at": "1", "resolve_by": "2", "rule_hash": "x" }),
            "that market contract is not allowed",
        ),
        (
            &Contractish::Oracle,
            "on_drawn",
            json!({ "market": me, "market_id": "0", "round": 0 }),
            "private",
        ),
        (
            &Contractish::Oracle,
            "on_applied",
            json!({ "market": me, "market_id": "0" }),
            "private",
        ),
        (
            &Contractish::Oracle,
            "on_bond_withdrawn",
            json!({ "account": me, "amount": "1" }),
            "private",
        ),
        (
            &Contractish::Council,
            "propose_owner",
            json!({ "new_owner": me }),
            "owner only",
        ),
        (
            &Contractish::Council,
            "accept_owner",
            json!({}),
            "not the proposed owner",
        ),
        (
            &Contractish::Council,
            "set_nft_contract",
            json!({ "nft_contract": me }),
            "owner only",
        ),
        (
            &Contractish::Council,
            "set_cooldown_ns",
            json!({ "cooldown_ns": "1" }),
            "owner only",
        ),
        (
            &Contractish::Council,
            "allow_market",
            json!({ "market": me }),
            "owner only",
        ),
        (
            &Contractish::Council,
            "set_close_grace_ns",
            json!({ "close_grace_ns": "86400000000000" }),
            "owner only",
        ),
        (
            &Contractish::Council,
            "set_max_seats_per_account",
            json!({ "max_seats_per_account": 1 }),
            "owner only",
        ),
        (
            &Contractish::Council,
            "draw",
            json!({ "case_key": "0", "n": 1, "exclude": [] }),
            "oracle only",
        ),
        (
            &Contractish::Council,
            "unlock_case",
            json!({ "case_key": "0", "delinquent": [] }),
            "oracle only",
        ),
        (
            &Contractish::Council,
            "on_unstaked",
            json!({ "token_id": "x", "stake": stake }),
            "private",
        ),
        (
            &Contractish::Council,
            "on_claim_paid",
            json!({ "quarter": 1, "token_id": "x", "owner": me, "requested_at": "1" }),
            "private",
        ),
    ];
    for (contract, method, args, why) in cases {
        let to = match contract {
            Contractish::Market => w.market.id(),
            Contractish::Oracle => w.oracle.id(),
            Contractish::Council => w.council.id(),
        };
        let r = attempt(&w.dave, to, method, args).await?;
        let why_failed = format!("{:?}", r.clone().into_result().err());
        assert!(r.is_failure(), "{to}.{method} let a stranger in");
        assert!(
            why_failed.contains(why),
            "{to}.{method} failed, but not because of the access check ({why}): {why_failed}"
        );
    }
    Ok(())
}

enum Contractish {
    Market,
    Oracle,
    Council,
}

// Calling `new` again on a deployed contract would let an attacker reset its owner. It must refuse.
#[tokio::test]
async fn a_deployed_contract_cannot_be_initialised_again() -> anyhow::Result<()> {
    let w = setup().await?;
    let me = w.dave.id();
    let again: Vec<(&near_workspaces::AccountId, serde_json::Value)> = vec![
        (
            w.market.id(),
            json!({ "owner_id": me, "operator_id": me, "oracle_id": me, "verifier_id": me, "collateral_token_id": "nep141:x.near" }),
        ),
        (
            w.oracle.id(),
            json!({ "owner_id": me, "market_contract": me, "verifier_id": me, "collateral_token_id": "nep141:x.near", "bond": "1", "window_ms": "1",
            "panel_deadline_ms": "1", "draw_window_ms": "1", "council": me, "jury_size": 1, "draw_delay_blocks": "1", "min_proposal_ms": "1", "operator_id": me, "network": "x", "price_threshold": 1 }),
        ),
        (
            w.council.id(),
            json!({ "owner_id": me, "oracle_id": me, "verifier_id": me, "collateral_token_id": "nep141:x.near", "cooldown_ns": "1", "max_seats_per_account": 1 }),
        ),
    ];
    for (to, args) in again {
        let r = attempt(&w.dave, to, "new", args).await?;
        assert!(r.is_failure(), "{to} accepted a second `new`");
    }
    assert_eq!(config(&w.market).await["owner"], json!(w.owner.id()));
    assert_eq!(config(&w.oracle).await["owner"], json!(w.owner.id()));
    assert_eq!(config(&w.council).await["owner"], json!(w.owner.id()));
    Ok(())
}

// The methods that move value or stake are 1 yocto methods, so a limited-access key (which cannot attach a deposit)
// cannot be used to call them.
#[tokio::test]
async fn value_moving_methods_need_exactly_one_yocto() -> anyhow::Result<()> {
    let w = setup().await?;
    let none = |to: &near_workspaces::AccountId, method: &str, args: serde_json::Value| {
        let to = to.clone();
        let method = method.to_string();
        let a = w.alice.clone();
        async move { a.call(&to, &method).args_json(args).gas(GAS).transact().await }
    };
    for (to, method, args) in [
        (w.market.id(), "withdraw", json!({ "amount": "1" })),
        (
            w.market.id(),
            "buy",
            json!({ "market_id": "0", "side": "yes", "amount": "1", "min_shares": "1" }),
        ),
        (
            w.market.id(),
            "sell",
            json!({ "market_id": "0", "side": "yes", "collateral_out": "1", "max_shares_in": "1" }),
        ),
        (w.oracle.id(), "withdraw_bond", json!({})),
        (
            w.oracle.id(),
            "commit_vote",
            json!({ "market": w.market.id(), "market_id": "0", "commitment": "0".repeat(64) }),
        ),
        (
            w.oracle.id(),
            "reveal_vote",
            json!({ "market": w.market.id(), "market_id": "0", "outcome": "yes", "salt": "s", "reason": "r" }),
        ),
        (
            w.council.id(),
            "claim_quarter",
            json!({ "quarter": 0, "token_id": "x" }),
        ),
        (w.council.id(), "unstake", json!({ "token_id": "x" })),
    ] {
        let r = none(to, method, args).await?;
        let why = format!("{:?}", r.clone().into_result().err());
        assert!(
            r.is_failure() && why.contains("exactly 1 yoctoNEAR"),
            "{to}.{method} without a deposit: {why}"
        );
    }
    Ok(())
}

// ---- fake tokens and fake callers ----------------------------------------------------------------------------------

// A token the contracts were not configured with cannot deposit, bond, or add revenue, and its transfers come back. The market,
// the oracle and the council have no token hook any more, so a direct transfer of any token bounces off them; the same token
// arriving through the verifier is covered in intents_market.rs and intents_oracle.rs.
#[tokio::test]
async fn a_token_the_contracts_do_not_trust_cannot_deposit_bond_or_pay_revenue() -> anyhow::Result<()> {
    let w = setup().await?;
    let evil = w.worker.dev_deploy(&wasm("mock_ft")).await?;
    evil.call("new")
        .args_json(json!({ "owner_id": w.dave.id() }))
        .transact()
        .await?
        .into_result()?;
    w.dave
        .call(evil.id(), "mint")
        .args_json(json!({ "account_id": w.dave.id(), "amount": (1_000 * USD).to_string() }))
        .transact()
        .await?
        .into_result()?;
    for target in [w.market.id(), w.oracle.id(), w.council.id()] {
        w.dave
            .call(evil.id(), "storage_deposit")
            .args_json(json!({ "account_id": target, "registration_only": true }))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await?
            .into_result()?;
    }
    let id = create_seeded_market(&w, 120).await?;
    // Registered with the market, so that nothing but the token check stands between the attacker and a credit.
    w.dave
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    let balance = |who: &near_workspaces::AccountId| {
        let evil = evil.clone();
        let who = who.clone();
        async move {
            evil.view("ft_balance_of")
                .args_json(json!({ "account_id": who }))
                .await
                .unwrap()
                .json::<String>()
                .unwrap()
        }
    };
    let before = balance(w.dave.id()).await;
    for (to, msg) in [
        (w.market.id(), "deposit".to_string()),
        (w.market.id(), format!("buy:{id}:yes:1")),
        (w.market.id(), format!("seed:{id}")),
        (w.oracle.id(), format!("propose:{}:{id}:yes:https://x", w.market.id())),
        (w.oracle.id(), format!("challenge:{}:{id}:no", w.market.id())),
        (w.council.id(), "revenue:1".to_string()),
    ] {
        w.dave
            .call(evil.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": to, "amount": BOND.to_string(), "msg": msg }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(200))
            .transact()
            .await?
            .into_result()?;
    }
    assert_eq!(balance(w.dave.id()).await, before, "every transfer came back");
    assert_eq!(market_balance(&w, w.dave.id()).await, 0);
    assert!(case_json(&w, id).await.is_null());
    assert_eq!(
        council_total_received(&w).await,
        0,
        "no revenue arrived from a token the council does not trust"
    );
    Ok(())
}

// The receiver hooks are public methods. Called directly, they must not believe the caller is the verifier or the token.
#[tokio::test]
async fn the_token_hooks_cannot_be_called_directly() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    let direct: Vec<(&near_workspaces::AccountId, &str, serde_json::Value, &str)> = vec![
        (
            w.market.id(),
            "mt_on_transfer",
            json!({ "sender_id": w.dave.id(), "previous_owner_ids": [w.dave.id()], "token_ids": [token_id(&w)],
                    "amounts": ["1000000000"], "msg": "deposit" }),
            "only the verifier can deliver money",
        ),
        (
            w.market.id(),
            "mt_on_transfer",
            json!({ "sender_id": w.owner.id(), "previous_owner_ids": [w.owner.id()], "token_ids": [token_id(&w)],
                    "amounts": ["1000000000"], "msg": format!("seed:{id}") }),
            "only the verifier can deliver money",
        ),
        (
            w.market.id(),
            "ft_on_transfer",
            json!({ "sender_id": w.dave.id(), "amount": "1000000000", "msg": "deposit" }),
            "only the collateral token can deliver money",
        ),
        (
            w.oracle.id(),
            "mt_on_transfer",
            json!({ "sender_id": w.dave.id(), "previous_owner_ids": [w.dave.id()], "token_ids": [token_id(&w)],
                    "amounts": [BOND.to_string()], "msg": format!("propose:{}:{id}:yes:x", w.market.id()) }),
            "only the verifier can deliver money",
        ),
        (
            w.oracle.id(),
            "ft_on_transfer",
            json!({ "sender_id": w.dave.id(), "amount": BOND.to_string(), "msg": format!("propose:{}:{id}:yes:x", w.market.id()) }),
            "MethodNotFound",
        ),
        (
            w.council.id(),
            "mt_on_transfer",
            json!({ "sender_id": w.dave.id(), "previous_owner_ids": [w.dave.id()], "token_ids": [token_id(&w)],
                    "amounts": ["1000000000"], "msg": "revenue:1" }),
            "only the verifier can deliver money",
        ),
        (
            w.council.id(),
            "ft_on_transfer",
            json!({ "sender_id": w.dave.id(), "amount": "1000000000", "msg": "revenue:1" }),
            "MethodNotFound",
        ),
        (
            w.council.id(),
            "nft_on_transfer",
            json!({ "sender_id": w.dave.id(), "previous_owner_id": w.alice.id(), "token_id": "stolen", "msg": "" }),
            "wrong NFT contract",
        ),
    ];
    for (to, method, args, why) in direct {
        let r = attempt(&w.dave, to, method, args).await?;
        let reason = format!("{:?}", r.clone().into_result().err());
        assert!(r.is_failure() && reason.contains(why), "{to}.{method}: {reason}");
    }
    assert_eq!(market_balance(&w, w.dave.id()).await, 0);
    assert!(!is_seat(&w, w.alice.id()).await);
    Ok(())
}

// An NFT contract that is not the configured collection cannot become a seat, even with token ids that match.
#[tokio::test]
async fn a_fake_nft_collection_cannot_stake_seats() -> anyhow::Result<()> {
    let w = setup().await?;
    let fake = w.worker.dev_deploy(&wasm("mock_nft")).await?;
    fake.call("new")
        .args_json(json!({ "owner_id": w.dave.id() }))
        .transact()
        .await?
        .into_result()?;
    w.dave
        .call(fake.id(), "nft_mint")
        .args_json(json!({ "token_id": w.jurors[0].id().as_str(), "receiver_id": w.dave.id() }))
        .transact()
        .await?
        .into_result()?;
    let r = w
        .dave
        .call(fake.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": w.council.id(), "token_id": w.jurors[0].id().as_str(), "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    assert!(!r.json::<bool>()?, "the token came back");
    assert!(!is_seat(&w, w.dave.id()).await);
    assert_eq!(
        stake_of(&w, w.jurors[0].id().as_str()).await["owner"],
        json!(w.jurors[0].id()),
        "the real seat is untouched"
    );
    Ok(())
}

// ---- hostile input ---------------------------------------------------------------------------------------------------

// Malformed or hostile messages bounce: the tokens come back and nothing changes.
#[tokio::test]
async fn malformed_messages_bounce_with_the_money_back() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    let locked = u(&market_json(&w, id).await["locked"]);
    let huge = "9".repeat(60);
    for msg in [
        String::new(),
        "seed:0".into(),
        format!("buy:{id}"),
        format!("buy:{id}:yes"),
        format!("buy:{id}:maybe:1"),
        format!("buy:{id}:yes:0"),
        format!("buy:{id}:yes:-1"),
        format!("buy:{id}:yes:{huge}"),
        "buy:abc:yes:1".into(),
        "buy:99999:yes:1".into(),
        "sell:0".into(),
        "revenue".into(),
        "\u{0}\u{0}".into(),
        "buy::::".into(),
    ] {
        let before = holdings(&w, w.alice.id()).await;
        let _ = ft_call(&w, &w.alice, w.market.id(), USD, &msg).await;
        assert_eq!(holdings(&w, w.alice.id()).await, before, "{msg:?} was not bounced");
    }
    assert_eq!(u(&market_json(&w, id).await["locked"]), locked, "no market money moved");

    // Extra text after a complete message is ignored, so "buy:0:yes:1:more" is a buy and "deposit:more" is a deposit. That is
    // harmless: the sender only ever spends their own money and gets exactly what they asked for.
    let shares_before = shares(&w, id, w.alice.id()).await.0;
    ft_call(&w, &w.alice, w.market.id(), USD, &format!("buy:{id}:yes:1:and:more")).await?;
    assert!(shares(&w, id, w.alice.id()).await.0 > shares_before);
    // A deposit with extra text is credited to the sender, not lost, and she can take it out.
    let (tokens, held) = (holdings(&w, w.alice.id()).await, market_balance(&w, w.alice.id()).await);
    let _ = ft_call(&w, &w.alice, w.market.id(), USD, "deposit:extra:parts").await;
    assert_eq!(holdings(&w, w.alice.id()).await + USD, tokens);
    assert_eq!(market_balance(&w, w.alice.id()).await, held + USD);

    let mk = w.market.id();
    for msg in [
        "".to_string(),
        "propose".to_string(),
        format!("propose:{mk}:0"),
        format!("propose:{mk}:0:bogus:x"),
        format!("propose:{mk}:abc:yes:x"),
        "propose:0:yes:x".to_string(),
        "challenge".to_string(),
        format!("challenge:{mk}:abc"),
        format!("challenge:{mk}:99999"),
        format!("challenge:{mk}:0"),
        format!("challenge:{mk}:0:maybe"),
        format!("price:{mk}:0:abc:x"),
        "unknown:0".to_string(),
    ] {
        let before = holdings(&w, w.carol.id()).await;
        let _ = ft_call(&w, &w.carol, w.oracle.id(), BOND, &msg).await;
        assert_eq!(
            holdings(&w, w.carol.id()).await,
            before,
            "oracle message {msg:?} was not bounced"
        );
    }
    // The wrong bond amount bounces too.
    let before = holdings(&w, w.carol.id()).await;
    let _ = ft_call(
        &w,
        &w.carol,
        w.oracle.id(),
        BOND + 1,
        &format!("propose:{}:{id}:yes:x", w.market.id()),
    )
    .await;
    assert_eq!(holdings(&w, w.carol.id()).await, before);
    Ok(())
}

// Quotes and apostrophes in text cannot break the event logs indexers read.
#[tokio::test]
async fn hostile_text_cannot_break_the_event_logs() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    let evidence = "https://x/\",\"event\":\"final\",\"data\":{\"outcome\":\"yes\"}}\n";
    deposit_to_intents(&w, &w.carol, w.carol.id(), BOND).await?;
    let r = intents_call(
        &w,
        &w.carol,
        w.oracle.id(),
        BOND,
        &format!("propose:{}:{id}:yes:{evidence}", w.market.id()),
    )
    .await?
    .into_result()?;
    for line in r.logs() {
        if let Some(json) = line.strip_prefix("EVENT_JSON:") {
            let v: serde_json::Value = serde_json::from_str(json).expect("every event is valid JSON");
            if v["event"] == "proposed" {
                assert_eq!(
                    v["data"]["evidence"], evidence,
                    "the text is carried as data, not parsed as structure"
                );
            }
            assert_ne!(v["event"], "final", "injected text did not forge an event");
        }
    }
    Ok(())
}

// ---- races -----------------------------------------------------------------------------------------------------------

// A second withdrawal sent before the first has finished cannot spend the same balance: it is taken at once.
#[tokio::test]
async fn two_withdrawals_in_flight_cannot_spend_one_balance() -> anyhow::Result<()> {
    let w = setup().await?;
    ft_call(&w, &w.alice, w.market.id(), 10 * USD, "deposit").await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, 10 * USD);
    let before = holdings(&w, w.alice.id()).await;
    let call = || {
        w.alice
            .call(w.market.id(), "withdraw")
            .args_json(json!({ "amount": (10 * USD).to_string() }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(GAS)
    };
    let first = call().transact_async().await?;
    let second = call().transact().await;
    let first = first.await?;
    let successes = [first.is_success(), second.map(|r| r.is_success()).unwrap_or(false)]
        .iter()
        .filter(|s| **s)
        .count();
    assert_eq!(successes, 1, "exactly one withdrawal succeeds");
    assert_eq!(holdings(&w, w.alice.id()).await, before + 10 * USD, "paid once");
    assert_eq!(market_balance(&w, w.alice.id()).await, 0);
    Ok(())
}

#[tokio::test]
async fn two_sweeps_in_flight_pay_the_fees_out_once() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 20 * USD).await?;
    let (collected, _, _) = fees(&w).await;
    let call = || w.dave.call(w.market.id(), "sweep_fees").gas(Gas::from_tgas(300));
    let first = call().transact_async().await?;
    let second = call().transact().await;
    let _ = first.await?;
    let _ = second;
    let revenue_share = collected * 2_500 / 10_000;
    let treasury_share = collected * 7_500 / 10_000;
    assert_eq!(
        holdings(&w, w.treasury.id()).await,
        treasury_share,
        "the treasury was paid once"
    );
    assert_eq!(
        council_total_received(&w).await,
        revenue_share,
        "the council received its share once"
    );
    let (left, _, _) = fees(&w).await;
    assert!(left <= 1, "nothing is left to sweep again: {left}");
    Ok(())
}

#[tokio::test]
async fn two_claims_and_two_unstakes_in_flight_pay_a_seat_once() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    send_revenue(&w, 10_000 * USD).await?;
    let seat = &w.jurors[0];
    let quarter = age_current_quarter(&w).await?;
    finalize_quarter(&w, quarter).await?;
    let owed = u(&entitlement(&w, quarter, seat.id().as_str(), seat.id()).await["amount"]);
    assert!(owed > 0);
    let claim = || {
        seat.call(w.council.id(), "claim_quarter")
            .args_json(json!({ "quarter": quarter, "token_id": seat.id().as_str() }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(GAS)
    };
    let before = holdings(&w, seat.id()).await;
    let first = claim().transact_async().await?;
    let second = claim().transact().await;
    let _ = first.await?;
    let _ = second;
    assert_eq!(holdings(&w, seat.id()).await - before, owed, "claimed once");
    assert_eq!(u(&reward_totals(&w).await["total_paid"]), owed);

    request_unstake(&w, seat, seat.id().as_str()).await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    let unstake = || {
        seat.call(w.council.id(), "unstake")
            .args_json(json!({ "token_id": seat.id().as_str() }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(GAS)
    };
    let first = unstake().transact_async().await?;
    let second = unstake().transact().await;
    let _ = first.await?;
    let _ = second;
    assert_eq!(
        nft_owner(&w, seat.id().as_str()).await,
        seat.id().as_str(),
        "the NFT went back once"
    );
    assert!(!is_seat(&w, seat.id()).await);
    assert_eq!(w.council.view("seat_count").await?.json::<u32>()?, 4);
    Ok(())
}

// ---- gas griefing ----------------------------------------------------------------------------------------------------

// Starving a call of gas cannot half-settle a case: it reverts whole, and the same call with enough gas still works.
#[tokio::test]
async fn starving_the_settling_call_of_gas_cannot_half_settle_a_case() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    for j in &jury[..2] {
        commit(&w, j, id, "no", "salt-for-no-0123456789").await?;
    }
    to_reveal_phase(&w, id).await;
    reveal(&w, &jury[0], id, "no", "salt-for-no-0123456789", "first").await?;

    // The second reveal settles the case. With 40 TGas it cannot reserve what the settlement needs, so it fails whole.
    let starved = jury[1]
        .call(w.oracle.id(), "reveal_vote")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string(), "outcome": "no", "salt": "salt-for-no-0123456789", "reason": "second" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(40))
        .transact()
        .await?;
    assert!(starved.is_failure());
    let case = case_json(&w, id).await;
    assert_eq!(case["stage"], "disputed", "nothing was half done");
    assert_eq!(
        case["votes"].as_array().unwrap().len(),
        1,
        "the starved vote was not recorded"
    );
    assert!(market_json(&w, id).await["outcome"].is_null());
    assert_eq!(claimable(&w, w.dave.id()).await, 0);
    assert!(
        stake_of(&w, jury[0].id().as_str()).await["serving"] == json!(council_key(&w, id).await),
        "seats still held"
    );

    jury[1]
        .call(w.oracle.id(), "reveal_vote")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string(), "outcome": "no", "salt": "salt-for-no-0123456789", "reason": "second" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(case_json(&w, id).await["stage"], "final");
    assert_eq!(market_json(&w, id).await["outcome"], "no");
    Ok(())
}

// Sending a transfer with too little gas for the receiver to finish must not leave money taken and state half written. Whatever
// gas is given, the sender either has the result or has their money back. The market and the oracle are both paid through the
// verifier, and after every attempt their books match what the verifier holds for them.
#[tokio::test]
async fn a_transfer_with_too_little_gas_for_the_receiver_never_loses_the_senders_money() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    w.carol
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    mint(&w, w.carol.id(), 100 * USD).await?;
    deposit_to_intents(&w, &w.carol, w.carol.id(), 60 * USD).await?;
    skip_secs(&w.worker, 130).await;
    for tgas in [10u64, 20, 21, 22, 25, 30, 32, 34, 36, 40, 45, 50, 60] {
        for (target, msg) in [
            (w.market.id(), "deposit".to_string()),
            (w.oracle.id(), format!("propose:{}:{id}:yes:https://x", w.market.id())),
        ] {
            let tokens = holdings(&w, w.carol.id()).await;
            let held = market_balance(&w, w.carol.id()).await;
            let bonds = claimable(&w, w.carol.id()).await;
            let case_before = case_json(&w, id).await;
            let r = w
                .carol
                .call(w.verifier.id(), "mt_transfer_call")
                .args_json(json!({
                    "receiver_id": target, "token_id": token_id(&w), "amount": BOND.to_string(), "msg": msg
                }))
                .deposit(NearToken::from_yoctonear(1))
                .gas(Gas::from_tgas(tgas))
                .transact()
                .await;
            let spent = tokens - holdings(&w, w.carol.id()).await;
            let credited = market_balance(&w, w.carol.id()).await - held;
            let case_now = case_json(&w, id).await;
            let answered = !case_now.is_null() && case_before.is_null();
            // Every unit the sender lost is accounted for by something they received: a deposit credit, or a case with their bond.
            if target == w.market.id() {
                assert_eq!(
                    spent, credited,
                    "at {tgas} TGas: money left but {credited} was credited ({r:?})"
                );
                assert_reconciled(&w).await;
            } else {
                assert_eq!(
                    spent,
                    if answered { BOND } else { 0 },
                    "at {tgas} TGas: bond spent {spent} but case opened = {answered} ({r:?})"
                );
                assert_oracle_reconciled(&w).await;
                if answered {
                    // Reset for the next round: finalize is not possible yet, so stop after a case exists.
                    return Ok(());
                }
            }
            assert_eq!(claimable(&w, w.carol.id()).await, bonds);
        }
    }
    Ok(())
}

// ---- jurors ----------------------------------------------------------------------------------------------------------

// Copying another juror's commitment does not let you vote their way: the commitment names its owner.
#[tokio::test]
async fn a_copied_commitment_cannot_be_revealed_by_the_copier() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    let honest = commitment(jury[0].id(), "no", "a-long-random-salt-0123456789");
    commit_vote(&w, &jury[0], id, &honest).await?;
    commit_vote(&w, &jury[1], id, &honest).await?;
    to_reveal_phase(&w, id).await;
    refused(
        reveal(&w, &jury[1], id, "no", "a-long-random-salt-0123456789", "copied").await,
        "does not match the commitment",
    );
    reveal(&w, &jury[0], id, "no", "a-long-random-salt-0123456789", "honest").await?;
    Ok(())
}

// A juror who commits with a guessable salt gives their vote away, because only three outcomes exist. The contract
// cannot stop that (it never sees the salt until the reveal); it is up to the client to use a random salt. This shows
// the weakness is real, so the voting client must generate 128 bits of salt.
#[tokio::test]
async fn a_guessable_salt_leaks_the_vote_so_clients_must_use_a_random_one() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    commit(&w, &jury[0], id, "no", "s").await?;
    let published = case_json(&w, id).await["commits"][0]["commitment"]
        .as_str()
        .unwrap()
        .to_string();

    let guessed = ["yes", "no", "void"].iter().find(|o| {
        ["", "s", "salt", "1", "0"]
            .iter()
            .any(|salt| commitment(jury[0].id(), o, salt) == published)
    });
    assert_eq!(
        guessed,
        Some(&"no"),
        "anyone can read the vote of a juror who used salt \"s\""
    );

    let strong = commitment(jury[0].id(), "no", "6f1c2b9e4d7a3085b1c6e2f90a47d3cb");
    let found = ["yes", "no", "void"].iter().any(|o| {
        ["", "s", "salt", "1", "0", "password", "abc123"]
            .iter()
            .any(|salt| commitment(jury[0].id(), o, salt) == strong)
    });
    assert!(!found, "a random salt cannot be guessed");
    Ok(())
}

// ---- griefing costs --------------------------------------------------------------------------------------------------

// Challenging a correct answer to lock jurors and waste their time costs the challenger their bond.
#[tokio::test]
async fn a_bogus_challenge_costs_the_attacker_and_pays_the_jurors() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    let before = holdings(&w, w.dave.id()).await;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    for j in &jury[..2] {
        commit(&w, j, id, "yes", "salt-for-yes-0123456789").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..2] {
        reveal(&w, j, id, "yes", "salt-for-yes-0123456789", "The answer is right.").await?;
    }
    assert_eq!(case_json(&w, id).await["final_outcome"], "yes");
    assert_eq!(claimable(&w, w.dave.id()).await, 0, "the attacker gets nothing back");
    assert_eq!(
        holdings(&w, w.dave.id()).await,
        before - BOND,
        "and is out the whole bond"
    );
    assert_eq!(
        claimable(&w, jury[0].id()).await + claimable(&w, jury[1].id()).await,
        BOND / 4,
        "a quarter went to the jurors"
    );
    assert_eq!(
        claimable(&w, w.carol.id()).await,
        2 * BOND - BOND / 4,
        "the rest went to the proposer they attacked"
    );
    Ok(())
}

// ---- compromised keys ------------------------------------------------------------------------------------------------

// What a thief holding the operator key can and cannot do. They can be a nuisance: halt trading, pause deposits. They
// cannot take anyone's money, redirect fees, or install themselves for good, and users can still get out. The market
// here closes in two days, so the halt is outside the last day, which the operator cannot halt in.
#[tokio::test]
async fn a_stolen_operator_key_can_halt_trading_but_cannot_take_money_or_keep_the_key() -> anyhow::Result<()> {
    let (w, admin) = setup_admin_owned().await?;
    let thief = &w.owner; // the harness operator
    let id = create_seeded_market(&w, 2 * 86_400).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    ft_call(&w, &w.bob, w.market.id(), 5 * USD, "deposit").await?;

    // A nuisance: halt the market, then pause the whole contract.
    thief
        .call(w.market.id(), "halt")
        .args_json(json!({ "market_id": id.to_string(), "reason": "attack" }))
        .transact()
        .await?
        .into_result()?;
    let (alice_yes, _) = shares(&w, id, w.alice.id()).await;
    refused(sell(&w, &w.alice, id, "yes", 1, alice_yes).await, "market is halted");
    thief
        .call(w.market.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?
        .into_result()?;
    let (tokens, held) = (holdings(&w, w.alice.id()).await, shares(&w, id, w.alice.id()).await);
    let _ = buy(&w, &w.alice, id, "yes", USD).await;
    assert_eq!(
        (holdings(&w, w.alice.id()).await, shares(&w, id, w.alice.id()).await),
        (tokens, held),
        "a paused contract bounces trades"
    );

    // But money stays reachable: balances can be withdrawn while paused, and after resolution holders redeem.
    w.bob
        .call(w.market.id(), "withdraw")
        .args_json(json!({ "amount": (5 * USD).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_balance(&w, w.bob.id()).await, 0);

    // It cannot take user money or reroute fees, claim a residual before anything resolves, or reseed a live market.
    refused(
        thief
            .call(w.market.id(), "claim_residual")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result(),
        "not resolved",
    );
    refused(
        thief
            .call(w.market.id(), "set_fee_recipients")
            .args_json(json!({ "revenue_pool": thief.id(), "treasury": thief.id() }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );
    refused(
        thief
            .call(w.market.id(), "set_operator")
            .args_json(json!({ "operator_id": thief.id() }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );
    refused(
        thief
            .call(w.market.id(), "propose_owner")
            .args_json(json!({ "new_owner": thief.id() }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );

    // The configured owner replaces the operator. DAO approvals/delay are tested separately. The old key is then locked out.
    let replacement = &w.carol;
    admin
        .call(w.market.id(), "set_operator")
        .args_json(json!({ "operator_id": replacement.id() }))
        .transact()
        .await?
        .into_result()?;
    refused(
        thief
            .call(w.market.id(), "resume")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result(),
        "operator or owner only",
    );
    replacement
        .call(w.market.id(), "set_paused")
        .args_json(json!({ "paused": false }))
        .transact()
        .await?
        .into_result()?;
    replacement
        .call(w.market.id(), "resume")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    let (out, needed, _) = quote_sell(&w, id, "yes", alice_yes).await;
    sell(&w, &w.alice, id, "yes", out, needed).await?;
    assert!(
        market_balance(&w, w.alice.id()).await > 0,
        "alice got out once the thief was replaced"
    );
    Ok(())
}

// Legacy custom-controller voting tests are archived outside the active suite.

// ---- the contract fixes of 2026-10-19 ------------------------------------------------------------------------------

// A key that can only call functions cannot attach a deposit, and buy, sell, commit_vote and reveal_vote need one yocto.
// So a leaked limited key can no longer trade a balance or vote for a juror. Their own full key still works.
#[tokio::test]
async fn a_function_call_key_cannot_buy_sell_commit_or_reveal() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    ft_call(&w, &w.alice, w.market.id(), 10 * USD, "deposit").await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    let juror = &jury[0];

    let limited = |account: &near_workspaces::Account, receiver: &near_workspaces::AccountId, methods: &[&str]| {
        let key = SecretKey::from_random(KeyType::ED25519);
        let public = key.public_key();
        let granted = AccessKey::function_call_access(receiver, methods, None);
        let account = account.clone();
        let worker = w.worker.clone();
        async move {
            account
                .batch(account.id())
                .add_key(public, granted)
                .transact()
                .await?
                .into_result()?;
            anyhow::Ok(near_workspaces::Account::from_secret_key(
                account.id().clone(),
                key,
                &worker,
            ))
        }
    };
    let alice = limited(&w.alice, w.market.id(), &["buy", "sell"]).await?;
    let juror_key = limited(juror, w.oracle.id(), &["commit_vote", "reveal_vote"]).await?;

    let attempts = [
        (
            &alice,
            w.market.id(),
            "buy",
            json!({ "market_id": "0", "side": "yes", "amount": USD.to_string(), "min_shares": "1" }),
        ),
        (
            &alice,
            w.market.id(),
            "sell",
            json!({ "market_id": "0", "side": "yes", "collateral_out": "1", "max_shares_in": "1" }),
        ),
        (
            &juror_key,
            w.oracle.id(),
            "commit_vote",
            json!({ "market": w.market.id(), "market_id": id.to_string(), "commitment": commitment(juror.id(), "no", "a-long-random-salt") }),
        ),
    ];
    for (key, to, method, args) in attempts {
        let r = key.call(to, method).args_json(args.clone()).gas(GAS).transact().await?;
        let why = format!("{:?}", r.clone().into_result().err());
        assert!(
            r.is_failure() && why.contains("exactly 1 yoctoNEAR"),
            "{method} by a function call key: {why}"
        );
        // The way round it, attaching the yocto, is refused by the network for a function call key.
        let with_deposit = key
            .call(to, method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(1))
            .gas(GAS)
            .transact()
            .await;
        assert!(
            with_deposit.map(|r| r.is_failure()).unwrap_or(true),
            "{method} with a deposit from a function call key went through"
        );
    }
    assert_eq!(market_balance(&w, w.alice.id()).await, 10 * USD, "nothing was spent");
    assert!(case_json(&w, id).await["commits"].as_array().unwrap().is_empty());

    // The full key gets past the deposit check: the market is closed by now, which is the refusal it meets, and the
    // juror's own commit goes through.
    refused(
        w.alice
            .call(w.market.id(), "buy")
            .args_json(
                json!({ "market_id": id.to_string(), "side": "yes", "amount": USD.to_string(), "min_shares": "1" }),
            )
            .deposit(NearToken::from_yoctonear(1))
            .gas(GAS)
            .transact()
            .await?
            .into_result(),
        "market is closed",
    );
    commit(&w, juror, id, "no", "a-long-random-salt").await?;
    Ok(())
}

// Two accounts propose and challenge each other and the jury says nothing, to tie up the market or to show a stalled
// case costs nothing. Both bonds used to come back. Now a jury that does not decide is followed by a second one, and when
// that fails too the pair ends down by half the challenger's bond, which goes to the jurors who revealed or, with none,
// to the owner. The silent jurors forfeit what their seats earned and every seat is released.
#[tokio::test]
async fn two_colluding_accounts_cannot_stall_a_case_for_free() -> anyhow::Result<()> {
    let w = setup().await?;
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": 1 }))
        .transact()
        .await?
        .into_result()?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let first = draw_jury(&w, id).await?;
    let deadline: u64 = case_json(&w, id).await["panel_deadline"].as_str().unwrap().parse()?;
    skip_until(&w, deadline + 1).await;
    finalize(&w, id).await?;
    let second = draw_jury(&w, id).await?;
    let deadline: u64 = case_json(&w, id).await["panel_deadline"].as_str().unwrap().parse()?;
    skip_until(&w, deadline + 1).await;
    finalize(&w, id).await?;

    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["final_outcome"]),
        (&json!("final"), &json!("void"))
    );
    let (carol, dave, recipient) = (
        claimable(&w, w.carol.id()).await,
        claimable(&w, w.dave.id()).await,
        claimable(&w, w.treasury.id()).await,
    );
    assert_eq!(claimable(&w, w.owner.id()).await, 0, "the owner is not paid");
    assert_eq!(
        carol + dave,
        2 * BOND - BOND / 2,
        "the pair put in two bonds and gets back a bond and a half"
    );
    assert_eq!(
        recipient,
        BOND / 2,
        "with no juror having revealed, the no-decision recipient holds the jurors' half"
    );
    assert_eq!(
        case["delinquent"].as_array().unwrap().len(),
        first.len() + second.len(),
        "every juror of both rounds was silent"
    );
    for j in first.iter().chain(&second) {
        assert!(
            stake_of(&w, j.id().as_str()).await["serving"].is_null(),
            "{} is still held",
            j.id()
        );
    }
    Ok(())
}

// Asking for the draw again, or calling the council for a draw, cannot re-roll a jury that was drawn.
#[tokio::test]
async fn a_drawn_jury_cannot_be_rerolled() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    let drawn = case_json(&w, id).await["panel"].clone();
    refused(resolve_draw(&w, id).await, "the jury is already drawn");
    let direct = attempt(
        &w.dave,
        w.council.id(),
        "draw",
        json!({ "case_key": id.to_string(), "n": 3, "exclude": [] }),
    )
    .await?;
    assert!(direct.is_failure() && format!("{:?}", direct.into_result().err()).contains("oracle only"));
    assert_eq!(case_json(&w, id).await["panel"], drawn);
    assert_eq!(jury.len(), 3);
    Ok(())
}

// A proposal nobody finalized is still the answer at the deadline. The market's own void is shut for a grace period,
// so the oracle's deadline call settles the proposal, instead of a void landing over it. A market nobody answered is
// voided by the same call.
#[tokio::test]
async fn at_the_deadline_an_unfinalized_proposal_is_applied_and_not_voided_over() -> anyhow::Result<()> {
    let w = setup().await?;
    let answered = create_seeded_market_gap(&w, 120, 600).await?;
    let unanswered = create_seeded_market_gap(&w, 120, 600).await?;
    buy(&w, &w.alice, answered, "yes", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, answered, "yes").await?;
    let resolve_by: u64 = market_json(&w, answered).await["resolve_by"]
        .as_str()
        .unwrap()
        .parse()?;
    skip_until(&w, resolve_by + 1_000_000_000).await;
    assert_eq!(
        case_json(&w, answered).await["stage"],
        "proposed",
        "nobody finalized it"
    );

    for id in [answered, unanswered] {
        refused(
            attempt(
                &w.dave,
                w.market.id(),
                "void_if_unresolved",
                json!({ "market_id": id.to_string() }),
            )
            .await?
            .into_result(),
            "the answer deadline and the 7 day grace period have not passed",
        );
    }
    for id in [answered, unanswered] {
        attempt(
            &w.dave,
            w.oracle.id(),
            "resolve_by_deadline",
            json!({ "market": w.market.id(), "market_id": id.to_string() }),
        )
        .await?
        .into_result()?;
    }
    assert_eq!(market_json(&w, answered).await["outcome"], "yes", "the proposal stood");
    assert_eq!(claimable(&w, w.carol.id()).await, BOND);
    assert_eq!(market_json(&w, unanswered).await["outcome"], "void");
    Ok(())
}

// A seat that stakes a block before a large arrival used to take its share of everything gathered so far. A seat now earns
// for the time it was staked inside the quarter, so five seats staked just before 10,000 USD arrives have earned less than
// the five that were there all along, though they hold half the seats.
#[tokio::test]
async fn staking_one_block_before_a_sweep_earns_only_the_time_staked() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    skip_secs(&w.worker, 30).await;
    let sniper = w.worker.dev_create_account().await?;
    let tokens: Vec<String> = (0..5).map(|i| format!("sniper{i}")).collect();
    for t in &tokens {
        mint_nft(&w, &sniper, t).await?;
        stake(&w, &sniper, t).await?;
    }
    send_revenue(&w, 10_000 * USD).await?;
    skip_secs(&w.worker, 5).await;
    let quarter = age_current_quarter(&w).await?;
    finalize_quarter(&w, quarter).await?;

    let mut sniped = 0;
    for t in &tokens {
        sniped += u(&entitlement(&w, quarter, t, sniper.id()).await["amount"]);
    }
    let mut honest = 0;
    for j in &w.jurors {
        honest += u(&entitlement(&w, quarter, j.id().as_str(), j.id()).await["amount"]);
    }
    assert!(
        sniped > 0 && sniped < honest / 2,
        "five seats staked a moment before the arrival earned {sniped} against {honest} for the five that were there"
    );
    assert!(
        sniped + honest <= 10_000 * USD && 10_000 * USD - (sniped + honest) < 10,
        "the shares and the dust are the whole pool"
    );
    Ok(())
}

// A halt held to close takes the last day out of the average a Void pays, so in that day only the owner can halt: the
// operator, whose key is the one a thief is likeliest to hold, is refused. The owner is separate from the operator here.
#[tokio::test]
async fn the_operator_cannot_halt_in_the_last_day_before_close() -> anyhow::Result<()> {
    let (w, _admin) = setup_admin_owned().await?;
    let id = create_seeded_market(&w, 3_000).await?;
    refused(
        w.owner
            .call(w.market.id(), "halt")
            .args_json(json!({ "market_id": id.to_string(), "reason": "late" }))
            .transact()
            .await?
            .into_result(),
        "a halt in the last day before close is an owner action",
    );
    assert_eq!(market_json(&w, id).await["status"], "open");
    Ok(())
}

// Pump the price late and halt the market so it stays pumped until it is voided. The average used to go on counting the
// pumped price for the rest of the time before close, which was most of it. Now halted time counts for nothing.
#[tokio::test]
async fn halting_after_a_pump_cannot_pin_the_void_price_at_the_pumped_price() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market_gap(&w, 150, 600).await?;
    skip_secs(&w.worker, 30).await;
    buy(&w, &w.alice, id, "yes", 80 * USD).await?;
    let pumped = u(&market_json(&w, id).await["price_yes"]);
    assert!(pumped > 700_000, "the buy moved the price to {pumped}");
    w.owner
        .call(w.market.id(), "halt")
        .args_json(json!({ "market_id": id.to_string(), "reason": "pumped" }))
        .transact()
        .await?
        .into_result()?;

    let resolve_by: u64 = market_json(&w, id).await["resolve_by"].as_str().unwrap().parse()?;
    skip_until(&w, resolve_by + 1_000_000_000).await;
    attempt(
        &w.dave,
        w.oracle.id(),
        "resolve_by_deadline",
        json!({ "market": w.market.id(), "market_id": id.to_string() }),
    )
    .await?
    .into_result()?;
    let price = u(&market_json(&w, id).await["void_price_yes"]);
    assert!(
        price < (500_000 + pumped) / 2,
        "the pump held for a second or two of trading yet the void pays {price}, pumped to {pumped}"
    );
    Ok(())
}
