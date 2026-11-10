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

#[tokio::test]
async fn an_empty_intents_key_list_does_not_prove_an_eth_implicit_account_is_keyless() -> anyhow::Result<()> {
    let w = setup().await?;
    let account = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
    let generator = concat!(
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
    );
    let bytes: Vec<u8> = (0..generator.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&generator[i..i + 2], 16).unwrap())
        .collect();
    let public_key = format!("secp256k1:{}", bs58::encode(bytes).into_string());
    let listed: Vec<String> = w
        .verifier
        .view("public_keys_of")
        .args_json(json!({ "account_id": account }))
        .await?
        .json()?;
    assert!(listed.is_empty());
    let authorized: bool = w
        .verifier
        .view("has_public_key")
        .args_json(json!({ "account_id": account, "public_key": public_key }))
        .await?
        .json()?;
    assert!(
        authorized,
        "the implicit key remains authorized without appearing in the list"
    );
    Ok(())
}

#[tokio::test]
async fn a_restricted_holder_key_cannot_request_an_unstake_but_the_wallet_can() -> anyhow::Result<()> {
    let w = setup().await?;
    let holder = &w.jurors[0];
    let args = json!({ "token_id": holder.id(), "accepts_cut": true });
    let before: serde_json::Value = w
        .council
        .view("stake_of")
        .args_json(json!({ "token_id": holder.id() }))
        .await?
        .json()?;
    assert!(before["unlock_requested_at"].is_null());
    let secret = SecretKey::from_random(KeyType::ED25519);
    holder
        .batch(holder.id())
        .add_key(
            secret.public_key(),
            AccessKey::function_call_access(w.council.id(), &["request_unstake"], Some(NearToken::from_near(1))),
        )
        .transact()
        .await?
        .into_result()?;
    let limited = Account::from_secret_key(holder.id().clone(), secret, &w.worker);
    refused(
        limited
            .call(w.council.id(), "request_unstake")
            .args_json(args.clone())
            .gas(Gas::from_tgas(30))
            .transact()
            .await?
            .into_result(),
        "exactly 1 yoctoNEAR",
    );
    let paid = limited
        .call(w.council.id(), "request_unstake")
        .args_json(args.clone())
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(30))
        .transact()
        .await;
    assert!(
        format!("{:?}", paid.expect_err("a function-call key cannot attach a deposit"))
            .contains("DepositWithFunctionCall")
    );
    let unchanged: serde_json::Value = w
        .council
        .view("stake_of")
        .args_json(json!({ "token_id": holder.id() }))
        .await?
        .json()?;
    assert_eq!(unchanged, before);
    request_unstake(&w, holder, holder.id().as_str()).await?;
    let after: serde_json::Value = w
        .council
        .view("stake_of")
        .args_json(json!({ "token_id": holder.id() }))
        .await?
        .json()?;
    assert!(after["unlock_requested_at"].is_string());
    Ok(())
}

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

#[tokio::test]
async fn publisher_replacement_uses_the_owner_and_fits_the_dao_gas_budget() -> anyhow::Result<()> {
    let (w, admin) = setup_admin_owned().await?;
    let rounds = w.worker.dev_deploy(&wasm("rounds")).await?;
    rounds
        .call("new")
        .args_json(json!({
            "owner_id": admin.id(), "operator_id": w.owner.id(), "verifier_id": w.verifier.id(),
            "collateral_token_id": token_id(&w), "network": "sandbox", "price_threshold": 1,
        }))
        .transact()
        .await?
        .into_result()?;
    admin
        .call(w.oracle.id(), "set_max_publishers")
        .args_json(json!({ "max_publishers": 25 }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    let keys: Vec<String> = (1..=25)
        .map(|seed| ed25519_public(&SigningKey::from_bytes(&[seed; 32])))
        .collect();
    for target in [&w.oracle, &rounds] {
        for (publishers, threshold) in [(&keys[0..1], 1), (&keys[1..2], 1), (&keys[..], 13)] {
            let args = json!({ "publishers": publishers, "threshold": threshold });
            refused(
                w.owner
                    .call(target.id(), "set_publishers")
                    .args_json(args.clone())
                    .gas(Gas::from_tgas(30))
                    .transact()
                    .await?
                    .into_result(),
                "owner only",
            );
            admin
                .call(target.id(), "set_publishers")
                .args_json(args)
                .gas(Gas::from_tgas(30))
                .transact()
                .await?
                .into_result()?;
            let settings = config(target).await;
            assert_eq!(settings["publishers"], json!(publishers));
            assert_eq!(settings["price_threshold"], threshold);
        }
        let before = config(target).await;
        refused(
            admin
                .call(target.id(), "set_publishers")
                .args_json(json!({ "publishers": keys, "threshold": 12 }))
                .gas(Gas::from_tgas(30))
                .transact()
                .await?
                .into_result(),
            "more than half",
        );
        assert_eq!(config(target).await, before);
    }
    Ok(())
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
// user collateral included, by a signed intent that anyone relays. Sealing NEAR keys does not remove the verifier key.
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

// Property 1. The operator hot key (w.owner here; admin is the owner) can halt buys on an open market, but never the exit
// (sell), and it cannot touch any destination, the owner-only pause on sells or the upgrade.
#[tokio::test]
async fn the_operator_can_halt_buys_but_never_exits_and_reaches_no_destination() -> anyhow::Result<()> {
    let (w, admin) = setup_admin_owned().await?;
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
    sell(&w, &w.alice, id, "yes", yes, 0).await?;
    let before = holdings(&w, w.bob.id()).await;
    let _ = buy(&w, &w.bob, id, "no", USD).await;
    assert_eq!(
        holdings(&w, w.bob.id()).await,
        before,
        "a buy during the halt comes back"
    );

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

    refused(
        operator
            .call(w.market.id(), "resume")
            .args_json(json!({ "market_id": id.to_string() }))
            .transact()
            .await?
            .into_result(),
        "owner only",
    );
    admin
        .call(w.market.id(), "resume")
        .args_json(json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    buy(&w, &w.bob, id, "no", USD).await?;
    assert!(
        shares(&w, id, w.bob.id()).await.1 > 0,
        "buying works again after the resume"
    );
    Ok(())
}

// Property 4, nft contract link. The Council used to take a stake on the word of whatever account is its NFT contract, so whoever
// held a key of the collection account seated anyone on any allowed token id without the token existing or moving. The Council now
// asks the collection who owns the token before it counts a seat: a token that was never minted is sent back and seats nobody.
#[tokio::test]
async fn the_collection_account_key_cannot_seat_anyone_on_a_token_that_never_moved() -> anyhow::Result<()> {
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

    let r = w
        .nft
        .as_account()
        .call(w.council.id(), "nft_on_transfer")
        .args_json(
            json!({ "sender_id": sybil, "previous_owner_id": sybil, "token_id": "seat-never-minted", "msg": "" }),
        )
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(
        r.json::<bool>()?,
        "the Council sends back a token the collection does not show it holding"
    );
    assert!(!is_seat(&w, sybil).await, "no seat without a token behind it");
    Ok(())
}
