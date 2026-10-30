// Outcome review of the rounds contract: who can stop a price from being recorded, and whether the quorum rules hold. Real
// contracts, sandbox chain.
mod common;
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{AccountDetailsPatch, Contract};
use serde_json::{json, Value};

const SECOND: u64 = 1_000_000_000;
const INTERVAL_SECS: u64 = 300;
const WINDOW_SECS: u64 = 60;
const CLOSE_BEFORE_SECS: u64 = 150;
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

struct Rounds {
    contract: Contract,
    publishers: Vec<SigningKey>,
    first_start: u64,
}

impl Rounds {
    fn start_of(&self, round: u64) -> u64 {
        self.first_start + round * INTERVAL_SECS * SECOND
    }

    fn signatures_spelled(&self, signers: &[&SigningKey], round: u64, price: u128, bare: &[bool]) -> String {
        let message = format!(
            "round-price:v1:{}:{NETWORK}:btc-usd:{}:{price}:2",
            self.contract.id(),
            self.start_of(round)
        );
        signers
            .iter()
            .zip(bare)
            .map(|(k, bare)| {
                let signature: String = k
                    .sign(message.as_bytes())
                    .to_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                let key = bs58::encode(k.verifying_key().as_bytes()).into_string();
                if *bare {
                    format!("{key}.{signature}")
                } else {
                    format!("ed25519:{key}.{signature}")
                }
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    fn quorum(&self, round: u64, price: u128) -> String {
        self.signatures_spelled(
            &[&self.publishers[0], &self.publishers[2]],
            round,
            price,
            &[false, false],
        )
    }
}

fn public_key(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().as_bytes()).into_string())
}

async fn deploy(w: &World, publishers: u8) -> anyhow::Result<Rounds> {
    let contract = w.worker.dev_deploy(&wasm("rounds")).await?;
    contract
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "operator_id": w.owner.id(), "verifier_id": w.verifier.id(),
            "collateral_token_id": token_id(w), "network": NETWORK, "price_threshold": 2
        }))
        .transact()
        .await?
        .into_result()?;
    let publishers: Vec<SigningKey> = (41..41 + publishers)
        .map(|s| SigningKey::from_bytes(&[s; 32]))
        .collect();
    for k in &publishers {
        w.owner
            .call(contract.id(), "add_publisher")
            .args_json(json!({ "key": public_key(k) }))
            .transact()
            .await?
            .into_result()?;
    }
    let first_start = now(&w.worker).await + 30 * SECOND;
    w.owner
        .call(contract.id(), "add_series")
        .args_json(json!({
            "asset": "btc-usd", "decimals": 2, "first_start": first_start.to_string(),
            "interval": (INTERVAL_SECS * SECOND).to_string(), "price_window": (WINDOW_SECS * SECOND).to_string(),
            "close_before": (CLOSE_BEFORE_SECS * SECOND).to_string()
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Rounds {
        contract,
        publishers,
        first_start,
    })
}

async fn record_price(
    w: &World,
    r: &Rounds,
    round: u64,
    price: u128,
    signatures: String,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(w.carol
        .call(r.contract.id(), "record_price")
        .args_json(
            json!({ "series_id": 0, "round": round.to_string(), "price": price.to_string(), "signatures": signatures }),
        )
        .gas(Gas::from_tgas(50))
        .transact()
        .await?)
}

async fn owner_call(w: &World, r: &Rounds, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(w.owner.call(r.contract.id(), method).args_json(args).transact().await?)
}

// FAILS TODAY. record_price asserts the same storage reserve as registering and staking. Once the contract's free NEAR is used
// up by user records, the one call that settles rounds is refused with them, and every round whose price is still missing
// refunds as "no_price": whoever holds the side that is losing is paid back by the exhaustion.
#[tokio::test]
async fn a_price_can_still_be_recorded_when_user_records_have_used_up_the_storage_reserve() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w, 3).await?;
    let id = r.contract.id().clone();
    ft_call(&w, &w.bob, &id, 5 * USD, "register").await?;
    ft_call(&w, &w.dave, &id, 10 * USD, "register").await?;
    skip_until(&w, r.start_of(0)).await;
    ft_call(&w, &w.bob, &id, 5 * USD, "stake:0:0:up:1").await?;
    ft_call(&w, &w.dave, &id, 5 * USD, "stake:0:0:down:1").await?;

    // The contract now holds exactly the reserve and room for ten more bytes.
    let details = w.worker.view_account(&id).await?;
    let balance = u128::from(details.storage_usage) * BYTE_COST + NEAR + 10 * BYTE_COST;
    w.worker
        .patch(&id)
        .account(AccountDetailsPatch::from(details).balance(NearToken::from_yoctonear(balance)))
        .transact()
        .await?;

    let refused_user = ft_call(&w, &w.alice, &id, 5 * USD, "register").await;
    println!("a new registration at the limit: {refused_user:?}");

    let result = record_price(&w, &r, 0, 6_500_000, r.quorum(0, 6_500_000)).await?;
    assert!(
        result.is_success(),
        "a quorum price must be recorded even when the reserve is used up, got {:?}",
        result.receipt_failures()
    );
    Ok(())
}

// Passes today. One publisher cannot be counted twice by spelling its key two ways, so a lone signer never makes a 2-of-3 quorum.
#[tokio::test]
async fn one_publisher_cannot_fill_two_places_by_writing_its_key_two_ways() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w, 3).await?;
    let id = r.contract.id().clone();
    ft_call(&w, &w.bob, &id, 5 * USD, "register").await?;
    skip_until(&w, r.start_of(0)).await;
    ft_call(&w, &w.bob, &id, 5 * USD, "stake:0:0:up:1").await?;
    let k = &r.publishers[0];
    let twice = r.signatures_spelled(&[k, k], 0, 6_500_000, &[false, true]);
    let result = record_price(&w, &r, 0, 6_500_000, twice).await?;
    assert!(
        result.is_failure(),
        "one key written two ways must not reach two signatures"
    );
    let get: Value = r
        .contract
        .view("get_price")
        .args_json(json!({ "series_id": 0, "round": "0" }))
        .await?
        .json()?;
    assert_eq!(get, Value::Null);
    Ok(())
}

// Passes today. The majority rule holds through every setter: no sequence of adds, removes and threshold changes leaves two
// groups that could each reach the threshold.
#[tokio::test]
async fn no_setter_sequence_lets_two_disjoint_groups_reach_the_threshold() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w, 3).await?;
    let extra: Vec<SigningKey> = (60..64).map(|s| SigningKey::from_bytes(&[s; 32])).collect();
    // 2 of 3. A fourth would let {0,1} and {2,3} both be a quorum of two.
    let add = |k: &SigningKey| json!({ "key": public_key(k) });
    assert!(owner_call(&w, &r, "add_publisher", add(&extra[0])).await?.is_failure());
    // Lowering the threshold to 1 of 3 is refused, raising to 3 of 3 is allowed.
    assert!(owner_call(&w, &r, "set_price_threshold", json!({ "threshold": 1 }))
        .await?
        .is_failure());
    owner_call(&w, &r, "set_price_threshold", json!({ "threshold": 3 }))
        .await?
        .into_result()?;
    // With 3 of 3 two more may join (5 publishers, a quorum of 3 is still more than half), a sixth may not.
    owner_call(&w, &r, "add_publisher", add(&extra[0]))
        .await?
        .into_result()?;
    owner_call(&w, &r, "add_publisher", add(&extra[1]))
        .await?
        .into_result()?;
    assert!(owner_call(&w, &r, "add_publisher", add(&extra[2])).await?.is_failure());
    // Removal can go down to the threshold and no lower.
    owner_call(&w, &r, "remove_publisher", add(&extra[1]))
        .await?
        .into_result()?;
    owner_call(&w, &r, "remove_publisher", add(&extra[0]))
        .await?
        .into_result()?;
    assert!(owner_call(&w, &r, "remove_publisher", add(&r.publishers[2]))
        .await?
        .is_failure());
    // Back at 3 of 3, the threshold can come down only to 2.
    owner_call(&w, &r, "set_price_threshold", json!({ "threshold": 2 }))
        .await?
        .into_result()?;
    let config: Value = r.contract.view("config").await?.json()?;
    assert_eq!(config["price_threshold"], 2);
    assert_eq!(config["publishers"].as_array().unwrap().len(), 3);
    Ok(())
}
