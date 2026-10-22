// Price markets: publishers sign a price off chain, anyone submits it with a bond, and it goes through the same
// challenge window and jury as any other answer. Real contracts, sandbox chain.
mod common;
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::types::Gas;
use serde_json::json;

const STRIKE: u128 = 10_000;
const DECIMALS: u8 = 2;

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public_key(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// What a publisher signs: the contract, the network, the market, its observation time, the price and its decimals.
fn message(w: &World, network: &str, market: u64, observation_time: u64, price: u128) -> String {
    format!(
        "price:v1:{}:{network}:{market}:{observation_time}:{price}:{DECIMALS}",
        w.oracle.id()
    )
}

fn entry(key: &SigningKey, message: &str) -> String {
    format!("{}.{}", public_key(key), hex(&key.sign(message.as_bytes()).to_bytes()))
}

async fn add_publisher(w: &World, key: &SigningKey) -> anyhow::Result<()> {
    w.owner
        .call(w.oracle.id(), "add_publisher")
        .args_json(json!({ "key": public_key(key) }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// Three publishers, two of whom must sign.
async fn world_with_publishers() -> anyhow::Result<(World, Vec<SigningKey>)> {
    let w = setup().await?;
    let keys: Vec<SigningKey> = (1..=3).map(signing_key).collect();
    for k in &keys {
        add_publisher(&w, k).await?;
    }
    Ok((w, keys))
}

// A seeded price market that closes in 120s, is observed the moment it closes, and is Yes if the price is at or above STRIKE.
// Returns the market id and its observation time.
async fn price_market(w: &World) -> anyhow::Result<(u64, u64)> {
    let t = now(&w.worker).await;
    let close_at = t + 120 * 1_000_000_000;
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .args_json(json!({
            "title": "Will bitcoin close at or above 100.00 USD?", "rule_text": "Yes if the median of three exchanges' 1 minute closes is at or above 100.00.",
            "resolution_source": "Median of the 1 minute closing prices on three major exchanges", "void_policy": "Fewer than two exchanges publish a price.",
            "category": "crypto", "subcategory": "bitcoin", "close_at": close_at.to_string(),
            "resolve_by": (close_at + 3_600_000_000_000u64).to_string(),
            "price_rule": { "observation_time": close_at.to_string(), "strike": STRIKE.to_string(), "decimals": DECIMALS, "above": true }
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    if market_json(w, id).await["registered"] == true {
        ft_call(w, &w.owner, w.market.id(), SEED, &format!("seed:{id}")).await?;
    }
    Ok((id, close_at))
}

async fn answer_price(w: &World, id: u64, price: u128, entries: &[String]) -> anyhow::Result<()> {
    ft_call(
        w,
        &w.carol,
        w.oracle.id(),
        BOND,
        &format!("price:{id}:{price}:{}", entries.join(",")),
    )
    .await
}

#[tokio::test]
async fn a_signed_price_resolves_the_market_after_the_challenge_window() -> anyhow::Result<()> {
    let (w, k) = world_with_publishers().await?;
    let (id, obs) = price_market(&w).await?;
    assert_eq!(market_json(&w, id).await["registered"], true);
    assert_eq!(market_json(&w, id).await["price_rule"]["strike"], STRIKE.to_string());
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;

    // 105.00, signed by two of the three publishers: at or above the strike, so Yes.
    let price = 10_500;
    let m = message(&w, NETWORK, id, obs, price);
    let before = holdings(&w, w.carol.id()).await;
    answer_price(&w, id, price, &[entry(&k[0], &m), entry(&k[2], &m)]).await?;
    assert_eq!(
        holdings(&w, w.carol.id()).await,
        before - BOND,
        "the submitter's bond is held"
    );
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["proposed"], &case["evidence"]),
        (
            &json!("proposed"),
            &json!("yes"),
            &json!("signed price 10500 by 2 publishers")
        )
    );

    // Nobody challenges. Once the window closes it is final, and the submitter's bond comes back.
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "yes");
    assert_eq!(claimable(&w, w.carol.id()).await, BOND);
    assert!(invariant(&w, id).await);
    Ok(())
}

#[tokio::test]
async fn the_price_below_the_strike_answers_no() -> anyhow::Result<()> {
    let (w, k) = world_with_publishers().await?;
    let (id, obs) = price_market(&w).await?;
    skip_secs(&w.worker, 130).await;
    let m = message(&w, NETWORK, id, obs, STRIKE - 1);
    answer_price(&w, id, STRIKE - 1, &[entry(&k[1], &m), entry(&k[2], &m)]).await?;
    assert_eq!(case_json(&w, id).await["proposed"], "no");
    Ok(())
}

#[tokio::test]
async fn a_submission_the_oracle_refuses_gives_the_bond_back_and_opens_no_case() -> anyhow::Result<()> {
    let (w, k) = world_with_publishers().await?;
    let (id, obs) = price_market(&w).await?;
    skip_secs(&w.worker, 130).await;
    let good = message(&w, NETWORK, id, obs, 10_500);
    let outsider = signing_key(99);
    let before = holdings(&w, w.carol.id()).await;

    let refused_submissions: Vec<(&str, u128, Vec<String>)> = vec![
        ("one signature when two must sign", 10_500, vec![entry(&k[0], &good)]),
        (
            "one publisher signing twice",
            10_500,
            vec![entry(&k[0], &good), entry(&k[0], &good)],
        ),
        (
            "a key that is not a publisher",
            10_500,
            vec![entry(&k[0], &good), entry(&outsider, &good)],
        ),
        (
            "a price other than the one signed",
            10_600,
            vec![entry(&k[0], &good), entry(&k[1], &good)],
        ),
        (
            "a price signed for another network",
            10_500,
            vec![
                entry(&k[0], &message(&w, "mainnet", id, obs, 10_500)),
                entry(&k[1], &message(&w, "mainnet", id, obs, 10_500)),
            ],
        ),
        (
            "a price signed for another market",
            10_500,
            vec![
                entry(&k[0], &message(&w, NETWORK, id + 1, obs, 10_500)),
                entry(&k[1], &message(&w, NETWORK, id + 1, obs, 10_500)),
            ],
        ),
        (
            "a price signed for another moment",
            10_500,
            vec![
                entry(&k[0], &message(&w, NETWORK, id, obs + 1, 10_500)),
                entry(&k[1], &message(&w, NETWORK, id, obs + 1, 10_500)),
            ],
        ),
    ];
    for (what, price, entries) in refused_submissions {
        let _ = answer_price(&w, id, price, &entries).await;
        assert!(case_json(&w, id).await.is_null(), "{what}: no case may open");
        assert_eq!(holdings(&w, w.carol.id()).await, before, "{what}: the bond comes back");
    }

    // A plain proposal is not how a price market is answered.
    let _ = ft_call(
        &w,
        &w.carol,
        w.oracle.id(),
        BOND,
        &format!("propose:{id}:yes:https://example.com"),
    )
    .await;
    assert!(case_json(&w, id).await.is_null());
    assert_eq!(holdings(&w, w.carol.id()).await, before);

    // The right submission still works afterwards.
    answer_price(&w, id, 10_500, &[entry(&k[0], &good), entry(&k[1], &good)]).await?;
    assert_eq!(case_json(&w, id).await["stage"], "proposed");
    Ok(())
}

#[tokio::test]
async fn a_price_cannot_be_submitted_before_its_observation_time() -> anyhow::Result<()> {
    let (w, k) = world_with_publishers().await?;
    let (id, obs) = price_market(&w).await?;
    let m = message(&w, NETWORK, id, obs, 10_500);
    let before = holdings(&w, w.carol.id()).await;
    let _ = answer_price(&w, id, 10_500, &[entry(&k[0], &m), entry(&k[1], &m)]).await;
    assert!(case_json(&w, id).await.is_null(), "the market has not even closed");
    assert_eq!(holdings(&w, w.carol.id()).await, before);
    Ok(())
}

#[tokio::test]
async fn a_wrong_price_that_enough_publishers_signed_is_overturned_by_a_challenge_and_the_jury() -> anyhow::Result<()> {
    let (w, k) = world_with_publishers().await?;
    let (id, obs) = price_market(&w).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;

    // Two publishers sign a price that was wrong (say, from a bad source). It says Yes.
    let m = message(&w, NETWORK, id, obs, 10_500);
    answer_price(&w, id, 10_500, &[entry(&k[0], &m), entry(&k[1], &m)]).await?;
    assert_eq!(case_json(&w, id).await["proposed"], "yes");

    // Dave challenges, and the jury finds the real price was below the strike.
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    for j in &jury[..2] {
        commit(&w, j, id, "no", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..2] {
        reveal(&w, j, id, "no", "s", "The exchanges closed at 99.50.").await?;
    }
    assert_eq!(case_json(&w, id).await["final_outcome"], "no");
    assert_eq!(market_json(&w, id).await["outcome"], "no");

    // The submitter lost their bond, as any proposer does: a quarter to the two jurors, the rest to the challenger.
    assert_eq!(claimable(&w, w.carol.id()).await, 0);
    assert_eq!(claimable(&w, w.dave.id()).await, 2 * BOND - BOND / 4);
    assert_eq!(
        (claimable(&w, jury[0].id()).await, claimable(&w, jury[1].id()).await),
        (BOND / 8, BOND / 8)
    );
    Ok(())
}

#[tokio::test]
async fn the_operator_cuts_off_a_publisher_at_once_and_only_the_owner_adds_one() -> anyhow::Result<()> {
    let (w, k) = world_with_publishers().await?;
    let key = |i: usize| json!({ "key": public_key(&k[i]) });

    // Strangers can do neither.
    refused(
        w.alice
            .call(w.oracle.id(), "add_publisher")
            .args_json(json!({ "key": public_key(&signing_key(40)) }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );
    refused(
        w.alice
            .call(w.oracle.id(), "remove_publisher")
            .args_json(key(0))
            .transact()
            .await?
            .into_result(),
        "operator or owner only",
    );

    // The operator (the owner account here) removes one at once. That leaves exactly the two that must sign.
    w.owner
        .call(w.oracle.id(), "remove_publisher")
        .args_json(key(2))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(config(&w.oracle).await["publishers"].as_array().unwrap().len(), 2);
    refused(
        w.owner
            .call(w.oracle.id(), "remove_publisher")
            .args_json(key(1))
            .transact()
            .await?
            .into_result(),
        "that would leave fewer publishers than must sign",
    );

    // The removed key's signature no longer counts.
    let (id, obs) = price_market(&w).await?;
    skip_secs(&w.worker, 130).await;
    let m = message(&w, NETWORK, id, obs, 10_500);
    let before = holdings(&w, w.carol.id()).await;
    let _ = answer_price(&w, id, 10_500, &[entry(&k[0], &m), entry(&k[2], &m)]).await;
    assert!(case_json(&w, id).await.is_null());
    assert_eq!(holdings(&w, w.carol.id()).await, before);
    answer_price(&w, id, 10_500, &[entry(&k[0], &m), entry(&k[1], &m)]).await?;
    assert_eq!(case_json(&w, id).await["stage"], "proposed");
    Ok(())
}

#[tokio::test]
async fn a_price_market_never_opens_while_too_few_publishers_exist() -> anyhow::Result<()> {
    let w = setup().await?;
    add_publisher(&w, &signing_key(1)).await?;
    let (id, _) = price_market(&w).await?;
    assert_eq!(
        market_json(&w, id).await["registered"],
        false,
        "one publisher, two must sign: the oracle refused it"
    );
    assert_eq!(
        u(&market_json(&w, id).await["locked"]),
        0,
        "so it was never seeded or traded"
    );

    // Once a second publisher exists, the same market registers.
    add_publisher(&w, &signing_key(2)).await?;
    w.owner
        .call(w.market.id(), "retry_register")
        .args_json(json!({ "market_id": id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(market_json(&w, id).await["registered"], true);
    Ok(())
}
