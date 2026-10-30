// Council seats as staked NFTs: staking, the unstake cooldown, and seats locked while they serve a case.
// Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use serde_json::json;

// A closed market with a proposal by Carol challenged by Dave.
async fn disputed(w: &World) -> anyhow::Result<u64> {
    let id = new_market(w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(w, &w.carol, id, "yes").await?;
    challenge(w, &w.dave, id).await?;
    Ok(id)
}

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

fn sorted(accounts: &[&Account]) -> Vec<String> {
    let mut v: Vec<String> = accounts.iter().map(|a| a.id().to_string()).collect();
    v.sort();
    v
}

#[tokio::test]
async fn staking_a_token_you_do_not_own_is_refused_by_the_collection() -> anyhow::Result<()> {
    let w = setup().await?;
    mint_nft(&w, &w.bob, "bobs").await?;
    refused(stake(&w, &w.alice, "bobs").await, "Sender not approved");
    assert_eq!(nft_owner(&w, "bobs").await, w.bob.id().as_str());
    assert!(stake_of(&w, "bobs").await.is_null());
    assert!(!is_seat(&w, w.alice.id()).await);
    Ok(())
}

// The Council asks the collection who owns a token before it counts a seat. The collection here is an account the test controls, so
// it can call nft_on_transfer on a token it never sent, as a lying collection would. A fresh Council with the real wasm is
// pointed at it, because the world's Council has staked seats and cannot change collection.
async fn council_with_collection(
    w: &World,
    collection: &near_workspaces::AccountId,
) -> anyhow::Result<near_workspaces::Contract> {
    let council = w.worker.dev_deploy(&wasm("council")).await?;
    council
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "oracle_id": w.oracle.id(), "verifier_id": w.verifier.id(),
            "collateral_token_id": token_id(w), "cooldown_ns": (COOLDOWN_SECS * 1_000_000_000).to_string(),
            "max_seats_per_account": MAX_SEATS_PER_ACCOUNT, "allowlist_enabled": false
        }))
        .transact()
        .await?
        .into_result()?;
    w.owner
        .call(council.id(), "set_nft_contract")
        .args_json(json!({ "nft_contract": collection }))
        .transact()
        .await?
        .into_result()?;
    Ok(council)
}

async fn claim_to_stake(
    collection: &Account,
    council: &near_workspaces::Contract,
    owner: &Account,
    token: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(collection
        .call(council.id(), "nft_on_transfer")
        .args_json(json!({ "sender_id": owner.id(), "previous_owner_id": owner.id(), "token_id": token, "msg": "" }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?)
}

#[tokio::test]
async fn the_council_counts_no_seat_for_a_token_it_does_not_really_hold_and_sends_it_back() -> anyhow::Result<()> {
    let w = setup().await?;
    let collection = w.worker.dev_deploy(&wasm("mock_nft")).await?;
    collection
        .call("new")
        .args_json(json!({ "owner_id": w.owner.id() }))
        .transact()
        .await?
        .into_result()?;
    w.owner
        .call(collection.id(), "nft_mint")
        .args_json(json!({ "token_id": "ghost", "receiver_id": w.alice.id() }))
        .transact()
        .await?
        .into_result()?;
    let council = council_with_collection(&w, collection.id()).await?;
    let seat_count = || async { council.view("seat_count").await.unwrap().json::<u32>().unwrap() };

    // The collection claims it sent "ghost" to the Council, but Alice still holds it: the Council asks the collection who owns it.
    let r = claim_to_stake(collection.as_account(), &council, &w.alice, "ghost")
        .await?
        .into_result()?;
    assert!(r.json::<bool>()?, "true tells the collection to return the token");
    assert_eq!(
        event_names(&r.logs().iter().map(|l| l.to_string()).collect::<Vec<_>>()),
        vec!["stake_refused"]
    );
    assert_eq!(seat_count().await, 0);
    let stake: serde_json::Value = council
        .view("stake_of")
        .args_json(json!({ "token_id": "ghost" }))
        .await?
        .json()?;
    assert!(stake.is_null());

    // A real transfer from the collection to this Council is counted: the check passes when the token is held.
    let r = w
        .alice
        .call(collection.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": council.id(), "token_id": "ghost", "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(r.json::<bool>()?, "the collection kept the transfer: the seat stands");
    assert_eq!(seat_count().await, 1);

    // A collection that fails the ownership question is refused the same way. Dave is an account with no contract on it.
    let broken = council_with_collection(&w, w.dave.id()).await?;
    let r = claim_to_stake(&w.dave, &broken, &w.alice, "anything")
        .await?
        .into_result()?;
    assert!(
        r.json::<bool>()?,
        "the token goes back when the collection cannot answer"
    );
    assert_eq!(broken.view("seat_count").await?.json::<u32>()?, 0);
    Ok(())
}

#[tokio::test]
async fn staking_makes_a_seat_and_the_council_holds_the_token() -> anyhow::Result<()> {
    let w = setup().await?;
    mint_nft(&w, &w.alice, "alices").await?;
    assert!(!is_seat(&w, w.alice.id()).await);
    stake(&w, &w.alice, "alices").await?;

    assert!(is_seat(&w, w.alice.id()).await);
    assert_eq!(nft_owner(&w, "alices").await, w.council.id().as_str());
    let s = stake_of(&w, "alices").await;
    assert_eq!(
        (&s["owner"], &s["unlock_requested_at"], &s["serving"]),
        (&json!(w.alice.id()), &json!(null), &json!(null))
    );
    assert_eq!(w.council.view("seat_count").await?.json::<u32>()?, 6);
    Ok(())
}

#[tokio::test]
async fn a_token_staked_by_an_approved_relayer_is_a_seat_for_its_owner() -> anyhow::Result<()> {
    let w = setup().await?;
    mint_nft(&w, &w.alice, "alices").await?;
    w.alice
        .call(w.nft.id(), "nft_approve")
        .args_json(json!({ "token_id": "alices", "account_id": w.bob.id() }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    stake(&w, &w.bob, "alices").await?;

    assert_eq!(stake_of(&w, "alices").await["owner"], json!(w.alice.id()));
    assert!(is_seat(&w, w.alice.id()).await);
    assert!(!is_seat(&w, w.bob.id()).await);
    refused(request_unstake(&w, &w.bob, "alices").await, "not your seat");
    request_unstake(&w, &w.alice, "alices").await?;
    Ok(())
}

#[tokio::test]
async fn only_the_configured_collection_can_stake() -> anyhow::Result<()> {
    let w = setup().await?;
    let other = w
        .worker
        .dev_deploy(&std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/near/mock_nft/mock_nft.wasm"
        ))?)
        .await?;
    other
        .call("new")
        .args_json(json!({ "owner_id": w.alice.id() }))
        .transact()
        .await?
        .into_result()?;
    w.alice
        .call(other.id(), "nft_mint")
        .args_json(json!({ "token_id": "x", "receiver_id": w.alice.id() }))
        .transact()
        .await?
        .into_result()?;
    let r = w
        .alice
        .call(other.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": w.council.id(), "token_id": "x", "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(!r.json::<bool>()?, "the token came back");
    assert!(format!("{:?}", r.receipt_failures()).contains("wrong NFT contract"));
    let t: serde_json::Value = other
        .view("nft_token")
        .args_json(json!({ "token_id": "x" }))
        .await?
        .json()?;
    assert_eq!(t["owner_id"], json!(w.alice.id()));
    assert!(!is_seat(&w, w.alice.id()).await);
    Ok(())
}

#[tokio::test]
async fn a_staker_unstakes_after_the_cooldown_and_gets_the_token_back() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors[0];
    request_unstake(&w, j, tok(j)).await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    assert_eq!(
        event_names(&unstake(&w, j, tok(j)).await?),
        vec!["nft_transfer", "unstaked"]
    );

    assert_eq!(nft_owner(&w, tok(j)).await, j.id().as_str());
    assert!(stake_of(&w, tok(j)).await.is_null());
    assert!(!is_seat(&w, j.id()).await);
    assert_eq!(w.council.view("seat_count").await?.json::<u32>()?, 4);
    Ok(())
}

#[tokio::test]
async fn unstaking_before_the_cooldown_is_refused() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors[0];
    request_unstake(&w, j, tok(j)).await?;
    refused(unstake(&w, j, tok(j)).await, "the cooldown has not passed");
    skip_secs(&w.worker, COOLDOWN_SECS / 2).await;
    refused(unstake(&w, j, tok(j)).await, "the cooldown has not passed");
    assert_eq!(nft_owner(&w, tok(j)).await, w.council.id().as_str());
    assert!(is_seat(&w, j.id()).await);
    Ok(())
}

#[tokio::test]
async fn unstaking_a_token_never_staked_or_staked_by_someone_else_is_refused() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors[0];
    refused(request_unstake(&w, &w.alice, "nothing").await, "not staked");
    refused(unstake(&w, &w.alice, "nothing").await, "not staked");
    refused(request_unstake(&w, &w.alice, tok(j)).await, "not your seat");
    request_unstake(&w, j, tok(j)).await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    refused(unstake(&w, &w.alice, tok(j)).await, "not your seat");
    refused(
        unstake(&w, &w.jurors[1], tok(&w.jurors[1])).await,
        "request an unstake first",
    );
    assert_eq!(nft_owner(&w, tok(j)).await, w.council.id().as_str());
    Ok(())
}

#[tokio::test]
async fn requesting_an_unstake_twice_is_refused() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors[0];
    request_unstake(&w, j, tok(j)).await?;
    let first = stake_of(&w, tok(j)).await["unlock_requested_at"].clone();
    skip_secs(&w.worker, 10).await;
    refused(request_unstake(&w, j, tok(j)).await, "unstake already requested");
    assert_eq!(
        stake_of(&w, tok(j)).await["unlock_requested_at"],
        first,
        "the cooldown did not restart"
    );
    Ok(())
}

#[tokio::test]
async fn a_drawn_seat_cannot_leave_until_its_case_is_final() -> anyhow::Result<()> {
    let mut w = setup().await?;
    add_jurors(&mut w, 2).await?;
    let id = disputed(&w).await?;
    let jury = draw_jury(&w, id).await?;
    for j in &jury {
        assert_eq!(stake_of(&w, tok(j)).await["serving"], json!(council_key(&w, id).await));
        refused(
            request_unstake(&w, j, tok(j)).await,
            "this seat is serving on an open case",
        );
    }
    for j in &jury[..MAJORITY] {
        commit(&w, j, id, "no", "s").await?;
    }

    // The seats that were not drawn leave while the case runs.
    let outsiders: Vec<&Account> = w
        .jurors
        .iter()
        .filter(|j| !jury.iter().any(|p| p.id() == j.id()))
        .collect();
    assert_eq!(outsiders.len(), 2);
    leave(&w, &outsiders).await?;
    for j in &jury {
        assert_eq!(nft_owner(&w, tok(j)).await, w.council.id().as_str());
    }

    to_reveal_phase(&w, id).await;
    for j in &jury[..MAJORITY] {
        reveal(&w, j, id, "no", "s", "The source says no.").await?;
    }
    assert_eq!(case_json(&w, id).await["stage"], "final");
    leave(&w, &jury.iter().collect::<Vec<_>>()).await?;
    for j in &jury {
        assert_eq!(nft_owner(&w, tok(j)).await, j.id().as_str());
    }
    Ok(())
}

#[tokio::test]
async fn a_draw_picks_only_staked_seats_that_are_not_serving_or_leaving() -> anyhow::Result<()> {
    let mut w = setup().await?;
    add_jurors(&mut w, 2).await?;
    let j = &w.jurors;
    // j1 and j2 leave for good, so exactly five seats are left.
    leave(&w, &[&j[1], &j[2]]).await?;
    let first = disputed(&w).await?;
    let jury = draw_jury(&w, first).await?;
    assert_eq!(
        sorted(&jury.iter().collect::<Vec<_>>()),
        sorted(&[&j[0], &j[3], &j[4], &j[5], &j[6]])
    );
    for who in &jury[..MAJORITY] {
        commit(&w, who, first, "no", "s").await?;
    }
    to_reveal_phase(&w, first).await;

    // A second case while all five are serving the first: nobody is left to draw.
    let second = new_market(&w, 1).await?;
    skip_secs(&w.worker, 2).await;
    propose(&w, &w.carol, second, "yes").await?;
    challenge(&w, &w.dave, second).await?;
    wait_for_draw(&w, second).await;
    assert_eq!(event_names(&resolve_draw(&w, second).await?), vec!["draw_failed"]);

    // The first case settles and frees its jury. j0 asks to leave straight away, so it is not available to
    // serve, and four seats are not enough for a jury of five.
    for who in &jury[..MAJORITY] {
        reveal(&w, who, first, "no", "s", "The source says no.").await?;
    }
    assert_eq!(case_json(&w, first).await["stage"], "final");
    request_unstake(&w, &j[0], tok(&j[0])).await?;
    assert_eq!(event_names(&resolve_draw(&w, second).await?), vec!["draw_failed"]);

    // A new seat makes up the numbers, and the seat on its way out is still not drawn.
    mint_nft(&w, &w.alice, "alice-seat").await?;
    stake(&w, &w.alice, "alice-seat").await?;
    assert_eq!(
        event_names(&resolve_draw(&w, second).await?),
        vec!["jury_drawn", "jury_drawn"]
    );
    assert_eq!(
        sorted(&panel(&w, second).await.iter().collect::<Vec<_>>()),
        sorted(&[&j[3], &j[4], &j[5], &j[6], &w.alice])
    );
    Ok(())
}

// One wallet cannot gather more seats than the cap, so it cannot gather more of the jury draw and the revenue share.
#[tokio::test]
async fn an_account_cannot_stake_more_seats_than_the_cap_and_the_token_comes_back() -> anyhow::Result<()> {
    let w = setup().await?;
    refused(
        w.alice
            .call(w.council.id(), "set_max_seats_per_account")
            .args_json(json!({ "max_seats_per_account": 2 }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );
    w.owner
        .call(w.council.id(), "set_max_seats_per_account")
        .args_json(json!({ "max_seats_per_account": 2 }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(config(&w.council).await["max_seats_per_account"], 2);

    for id in ["a1", "a2", "a3"] {
        mint_nft(&w, &w.alice, id).await?;
    }
    stake(&w, &w.alice, "a1").await?;
    stake(&w, &w.alice, "a2").await?;
    refused(
        stake(&w, &w.alice, "a3").await,
        "that account already holds the most seats allowed",
    );
    assert_eq!(nft_owner(&w, "a3").await, w.alice.id().as_str(), "the token came back");
    assert!(stake_of(&w, "a3").await.is_null());

    // Another account is not held back, and a seat that leaves makes room.
    mint_nft(&w, &w.bob, "b1").await?;
    stake(&w, &w.bob, "b1").await?;
    request_unstake(&w, &w.alice, "a1").await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    unstake(&w, &w.alice, "a1").await?;
    stake(&w, &w.alice, "a3").await?;
    Ok(())
}

#[tokio::test]
async fn a_failed_return_transfer_restores_the_stake() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors[0];
    request_unstake(&w, j, tok(j)).await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    let before = stake_of(&w, tok(j)).await;

    // The collection breaks: its code is swapped for one with no nft_transfer, so the return transfer fails.
    let wasm = |name: &str| {
        std::fs::read(format!(
            "{}/../target/near/{name}/{name}.wasm",
            env!("CARGO_MANIFEST_DIR")
        ))
    };
    w.nft.as_account().deploy(&wasm("mock_ft")?).await?.into_result()?;
    assert_eq!(event_names(&unstake(&w, j, tok(j)).await?), vec!["unstake_failed"]);
    // The seat is back as it was, except that it counts again from the moment it came back.
    let after = stake_of(&w, tok(j)).await;
    let counted = |stake: &serde_json::Value| stake["booked_to"].as_str().unwrap().parse::<u64>().unwrap();
    assert!(
        counted(&after) > counted(&before),
        "the time the seat was out is not counted"
    );
    let (mut after_rest, mut before_rest) = (after.clone(), before.clone());
    after_rest["booked_to"] = serde_json::Value::Null;
    before_rest["booked_to"] = serde_json::Value::Null;
    assert_eq!(after_rest, before_rest);
    assert!(is_seat(&w, j.id()).await);
    assert_eq!(w.council.view("seat_count").await?.json::<u32>()?, 5);

    // Once the collection works again, the same stake unstakes without a new cooldown.
    w.nft.as_account().deploy(&wasm("mock_nft")?).await?.into_result()?;
    assert_eq!(nft_owner(&w, tok(j)).await, w.council.id().as_str());
    assert_eq!(
        event_names(&unstake(&w, j, tok(j)).await?),
        vec!["nft_transfer", "unstaked"]
    );
    assert_eq!(nft_owner(&w, tok(j)).await, j.id().as_str());
    Ok(())
}
