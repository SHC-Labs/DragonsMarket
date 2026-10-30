// Keys and authority review. Each test shows what one key or role can do on its own, so a fix can turn it into a
// regression test: the tests marked VIOLATION pass today because the violation happens, and should be inverted once fixed.
mod common;
use common::*;
use ed25519_dalek::SigningKey;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde_json::json;
use sha2::{Digest, Sha256};

const STAGE_DEPOSIT: NearToken = NearToken::from_near(5);

fn rebuilt(name: &str, tag: &str) -> Vec<u8> {
    let mut code = wasm(name);
    let body = [&[tag.len() as u8][..], tag.as_bytes()].concat();
    code.push(0);
    code.push(body.len() as u8);
    code.extend(body);
    code
}

fn hash_of(code: &[u8]) -> String {
    bs58::encode(Sha256::digest(code)).into_string()
}

async fn stage(from: &Account, target: &Contract, code: &[u8]) -> anyhow::Result<String> {
    from.call(target.id(), "stage_code")
        .args(code.to_vec())
        .deposit(STAGE_DEPOSIT)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(hash_of(code))
}

async fn upgrade(admin: &Account, target: &Contract, hash: &str) -> anyhow::Result<bool> {
    let r = admin
        .call(target.id(), "upgrade")
        .args_json(json!({ "code_hash": hash }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?;
    Ok(r.is_success() && r.receipt_failures().is_empty())
}

async fn seal_all(admin: &Account, target: &Contract) -> anyhow::Result<()> {
    for key in target.view_access_keys().await? {
        admin
            .call(target.id(), "seal")
            .args_json(json!({ "public_key": key.public_key }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(())
}

fn ed25519_public(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().as_bytes()).into_string())
}

// A batch that fails clears upgrade_in_flight in a callback, so the account key cannot call the private migrate by hand to fake
// the proof, and the owner's seal is refused because nothing was ever proven.
#[tokio::test]
async fn after_a_failed_upgrade_nobody_can_prove_the_path_by_hand_and_seal_is_refused() -> anyhow::Result<()> {
    let (w, admin) = setup_admin_owned().await?;

    let broken = stage(&w.bob, &w.market, &wasm("mock_ft")).await?;
    assert!(
        !upgrade(&admin, &w.market, &broken).await?,
        "the batch fails: mock_ft has no migrate"
    );
    let c = config(&w.market).await;
    assert_eq!(
        (&c["upgrade_in_flight"], &c["upgrade_proven"]),
        (&json!(false), &json!(false)),
        "the failed batch cleared the flag"
    );

    refused(
        w.market.call("migrate").max_gas().transact().await?.into_result(),
        "migrate runs only inside an upgrade",
    );
    let key = w.market.view_access_keys().await?.remove(0).public_key;
    refused(
        admin
            .call(w.market.id(), "seal")
            .args_json(json!({ "public_key": key }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?
            .into_result(),
        "prove the upgrade path before deleting keys",
    );
    assert!(
        !w.market.view_access_keys().await?.is_empty(),
        "the deploy key is still there"
    );
    Ok(())
}

// VIOLATION (property 3, what seal protects). buy_for is #[private] and takes no callback result, so any key of the market
// account, even a function-call key limited to buy_for on the market itself, spends any user's balance on any side of any
// market. Before seal the deployer's key, and any key added to the account, holds this power.
#[tokio::test]
async fn a_function_call_key_on_the_market_account_spends_a_users_balance_through_buy_for() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 600).await?;
    ft_call(&w, &w.alice, w.market.id(), 20 * USD, "deposit").await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, 20 * USD);

    let secret = SecretKey::from_random(KeyType::ED25519);
    w.market
        .as_account()
        .batch(w.market.id())
        .add_key(
            secret.public_key(),
            AccessKey::function_call_access(w.market.id(), &["buy_for"], Some(NearToken::from_near(1))),
        )
        .transact()
        .await?
        .into_result()?;
    let limited = Account::from_secret_key(w.market.id().clone(), secret, &w.worker);

    limited
        .call(w.market.id(), "buy_for")
        .args_json(json!({ "who": w.alice.id(), "market_id": id.to_string(), "side": 1, "amount": (20 * USD).to_string(), "min_shares": "1" }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        market_balance(&w, w.alice.id()).await,
        0,
        "alice's whole balance was spent without her signature"
    );
    let (yes, no) = shares(&w, id, w.alice.id()).await;
    assert!(yes == 0 && no > 0, "on the side the key holder chose");
    Ok(())
}

// VIOLATION (property 3, what seal does not protect). A public key registered in the verifier under the market's account
// before seal survives the upgrade proof and seal of every NEAR access key, and moves the market's whole Intents balance,
// user collateral included, by a signed intent that anyone relays. The contracts have no way to remove it.
#[tokio::test]
async fn an_intents_key_registered_before_seal_survives_seal_and_moves_the_market_collateral() -> anyhow::Result<()> {
    let (w, admin) = setup_admin_owned().await?;
    let id = new_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 30 * USD).await?;
    let held = intents_balance(&w, w.market.id()).await;
    assert!(held >= 30 * USD);

    let backdoor = SigningKey::from_bytes(&[77u8; 32]);
    w.market
        .as_account()
        .call(w.verifier.id(), "add_public_key")
        .args_json(json!({ "public_key": ed25519_public(&backdoor) }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let hash = stage(&w.bob, &w.market, &rebuilt("market", "v2")).await?;
    assert!(upgrade(&admin, &w.market, &hash).await?);
    seal_all(&admin, &w.market).await?;
    assert!(w.market.view_access_keys().await?.is_empty(), "sealed");

    let thief = w.carol.id();
    let message = json!({ "signer_id": w.market.id(), "deadline": FAR_DEADLINE, "intents": [
        { "intent": "transfer", "receiver_id": thief, "tokens": { token_id(&w): held.to_string() } }
    ]})
    .to_string();
    let signed = nep413_signed(&backdoor, &message, [9u8; 32], w.verifier.id().as_str());
    let before = intents_balance(&w, thief).await;
    w.dave
        .call(w.verifier.id(), "execute_intents")
        .args_json(json!({ "signed": [signed] }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        intents_balance(&w, w.market.id()).await,
        0,
        "the market's collateral is gone"
    );
    assert_eq!(intents_balance(&w, thief).await - before, held);
    Ok(())
}

// The fix for the test above: the owner removes the key as the market account, and the collateral stays put.
#[tokio::test]
async fn the_owner_can_remove_an_intents_key_registered_for_the_market_and_the_collateral_stays() -> anyhow::Result<()>
{
    let (w, admin) = setup_admin_owned().await?;
    let id = new_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 30 * USD).await?;
    let held = intents_balance(&w, w.market.id()).await;

    let backdoor = SigningKey::from_bytes(&[78u8; 32]);
    w.market
        .as_account()
        .call(w.verifier.id(), "add_public_key")
        .args_json(json!({ "public_key": ed25519_public(&backdoor) }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let keys = |w: &World| {
        let verifier = w.verifier.clone();
        let account = w.market.id().clone();
        async move {
            verifier
                .view("public_keys_of")
                .args_json(json!({ "account_id": account }))
                .await
                .unwrap()
                .json::<Vec<String>>()
                .unwrap()
        }
    };
    assert_eq!(keys(&w).await.len(), 1);

    refused(
        w.bob
            .call(w.market.id(), "remove_verifier_key")
            .args_json(json!({ "public_key": ed25519_public(&backdoor) }))
            .max_gas()
            .transact()
            .await?
            .into_result(),
        "owner only",
    );
    admin
        .call(w.market.id(), "remove_verifier_key")
        .args_json(json!({ "public_key": ed25519_public(&backdoor) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(keys(&w).await.is_empty(), "the key is gone");

    let message = json!({ "signer_id": w.market.id(), "deadline": FAR_DEADLINE, "intents": [
        { "intent": "transfer", "receiver_id": w.carol.id(), "tokens": { token_id(&w): held.to_string() } }
    ]})
    .to_string();
    let signed = nep413_signed(&backdoor, &message, [9u8; 32], w.verifier.id().as_str());
    let attempt = w
        .dave
        .call(w.verifier.id(), "execute_intents")
        .args_json(json!({ "signed": [signed] }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result();
    assert!(attempt.is_err(), "a signature from the removed key moves nothing");
    assert_eq!(intents_balance(&w, w.market.id()).await, held);
    Ok(())
}

// Property 1. The operator hot key (w.owner here; admin is the owner) halts any open market indefinitely, which closes the
// only exit before resolution (sell), and it cannot touch any destination, the owner-only pause on sells or the upgrade.
#[tokio::test]
async fn the_operator_can_freeze_exits_of_a_market_but_reaches_no_destination() -> anyhow::Result<()> {
    let (w, _admin) = setup_admin_owned().await?;
    let operator = &w.owner;
    let id = new_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    let (yes, _) = shares(&w, id, w.alice.id()).await;

    operator
        .call(w.market.id(), "halt")
        .args_json(json!({ "market_id": id.to_string(), "reason": "operator" }))
        .transact()
        .await?
        .into_result()?;
    refused(sell(&w, &w.alice, id, "yes", yes, 0).await, "market is halted");

    let owner_only = [
        (
            w.market.id(),
            "set_fee_recipients",
            json!({ "revenue_pool": operator.id(), "treasury": operator.id().to_string() + "x" }),
        ),
        (w.market.id(), "set_sells_paused", json!({ "sells_paused": false })),
        (w.market.id(), "set_operator", json!({ "operator_id": w.bob.id() })),
        (
            w.market.id(),
            "reconcile_withdrawal",
            json!({ "id": "1", "paid": false }),
        ),
        (w.market.id(), "upgrade", json!({ "code_hash": hash_of(b"x") })),
        (
            w.oracle.id(),
            "set_no_decision_recipient",
            json!({ "recipient": operator.id() }),
        ),
        (
            w.oracle.id(),
            "add_publisher",
            json!({ "key": ed25519_public(&SigningKey::from_bytes(&[5u8; 32])) }),
        ),
        (w.oracle.id(), "allow_market", json!({ "market": operator.id() })),
        (w.council.id(), "allow_market", json!({ "market": operator.id() })),
    ];
    for (to, method, args) in owner_only {
        let r = operator
            .call(to, method)
            .args_json(args)
            .gas(Gas::from_tgas(150))
            .transact()
            .await?;
        assert!(r.is_failure(), "operator called {method}");
    }

    operator
        .call(w.market.id(), "resume")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    sell(&w, &w.alice, id, "yes", yes, 0).await?;
    Ok(())
}

// VIOLATION (property 4, nft contract link). The Council takes a stake on the word of whatever account is its NFT contract:
// nft_on_transfer checks only the predecessor. Whoever holds a key of the collection account (its deployer, or its code
// after an upgrade there) seats any account on any allowed token id without the token existing or moving, and seats decide
// disputes and share Council revenue. Nothing in keeper check reads the collection's keys or code.
#[tokio::test]
async fn the_collection_account_key_seats_anyone_on_a_token_that_never_moved() -> anyhow::Result<()> {
    let w = setup().await?;
    w.owner
        .call(w.council.id(), "allow_tokens")
        .args_json(json!({ "token_ids": ["seat-never-minted"] }))
        .transact()
        .await?
        .into_result()?;
    w.owner
        .call(w.council.id(), "set_allowlist_enabled")
        .args_json(json!({ "enabled": true }))
        .transact()
        .await?
        .into_result()?;
    let sybil = w.dave.id();
    assert!(!is_seat(&w, sybil).await);

    w.nft
        .as_account()
        .call(w.council.id(), "nft_on_transfer")
        .args_json(
            json!({ "sender_id": sybil, "previous_owner_id": sybil, "token_id": "seat-never-minted", "msg": "" }),
        )
        .transact()
        .await?
        .into_result()?;
    assert!(is_seat(&w, sybil).await, "a seat with no token behind it");
    Ok(())
}
