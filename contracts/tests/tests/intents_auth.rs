mod common;
use common::*;
use ed25519_dalek::SigningKey;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::AccountId;
use serde_json::{json, Value};

fn signed(w: &World, key: &SigningKey, intent: Value, nonce: u8) -> Value {
    let message = json!({ "signer_id": implicit_id(key), "deadline": FAR_DEADLINE, "intents": [intent] }).to_string();
    nep413_signed(key, &message, [nonce; 32], w.verifier.id().as_str())
}

fn transfer_to_market(w: &World, amount: u128, msg: &str) -> Value {
    json!({ "intent": "transfer", "receiver_id": w.market.id(), "tokens": { token_id(w): amount.to_string() }, "msg": msg })
}

fn market_action(w: &World, msg: &str) -> Value {
    json!({ "intent": "auth_call", "contract_id": w.market.id(), "msg": msg, "min_gas": Gas::from_tgas(50).as_gas() })
}

async fn relay(w: &World, payload: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(w.bob
        .call(w.verifier.id(), "execute_intents")
        .args_json(json!({ "signed": [payload] }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

fn assert_clean(w: &World, label: &str, r: &ExecutionFinalResult) {
    assert!(
        r.is_success() && r.receipt_failures().is_empty(),
        "{label}: {:?}",
        r.receipt_failures()
    );
    println!(
        "{label}: market {:.1} TGas, total {:.1} TGas",
        burnt_on(r, w.market.id()),
        tg(r.total_gas_burnt)
    );
}

fn market_refused(w: &World, r: &ExecutionFinalResult) -> bool {
    r.receipt_failures().iter().any(|o| &o.executor_id == w.market.id())
}

async fn sponsor(w: &World, who: &AccountId) -> anyhow::Result<()> {
    w.bob
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({ "account_id": who }))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn a_signer_with_no_near_trades_and_exits_by_signed_intents() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 120).await?;
    let key = SigningKey::from_bytes(&[11u8; 32]);
    let signer: AccountId = implicit_id(&key).parse()?;
    assert!(
        w.worker.view_account(&signer).await.is_err(),
        "the signer has no NEAR account"
    );
    sponsor(&w, &signer).await?;
    deposit_to_intents(&w, &w.alice, &signer, 40 * USD).await?;

    let r = relay(
        &w,
        signed(
            &w,
            &key,
            transfer_to_market(&w, 20 * USD, &format!("buy:{id}:yes:1")),
            1,
        ),
    )
    .await?;
    assert_clean(&w, "buy by a signed transfer", &r);
    let (yes, _) = shares(&w, id, &signer).await;
    assert!(yes > 0);
    assert_eq!(intents_balance(&w, &signer).await, 20 * USD);

    let (out, sold, fee) = quote_sell(&w, id, "yes", yes / 2).await;
    let r = relay(
        &w,
        signed(
            &w,
            &key,
            market_action(&w, &format!("sell:{id}:yes:{sold}:{}", out - fee)),
            2,
        ),
    )
    .await?;
    assert_clean(&w, "signed sell", &r);
    assert_eq!(market_balance(&w, &signer).await, out - fee);
    assert_reconciled(&w).await;

    let r = relay(
        &w,
        signed(&w, &key, market_action(&w, &format!("buy:{id}:no:{}:1", USD)), 3),
    )
    .await?;
    assert_clean(&w, "signed buy from the balance", &r);
    assert_eq!(market_balance(&w, &signer).await, out - fee - USD);
    assert!(shares(&w, id, &signer).await.1 > 0);

    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, PAST_WINDOW_SECS).await;
    finalize(&w, id).await?;
    let r = relay(&w, signed(&w, &key, market_action(&w, &format!("redeem:{id}")), 4)).await?;
    assert_clean(&w, "signed redeem", &r);
    assert_eq!(shares(&w, id, &signer).await, (0, 0));
    assert_reconciled(&w).await;

    let owed = market_balance(&w, &signer).await;
    assert!(owed > out - fee - USD);
    let withdrawal = signed(&w, &key, market_action(&w, &format!("withdraw:{owed}")), 5);
    let r = relay(&w, withdrawal.clone()).await?;
    assert_clean(&w, "signed withdrawal", &r);
    assert_eq!(market_balance(&w, &signer).await, 0);
    assert_eq!(intents_balance(&w, &signer).await, 20 * USD + owed);
    assert_reconciled(&w).await;

    let r = relay(&w, withdrawal).await?;
    assert!(r.is_failure(), "a replayed withdrawal is refused");
    assert_eq!(intents_balance(&w, &signer).await, 20 * USD + owed);
    assert!(
        w.worker.view_account(&signer).await.is_err(),
        "the signer still has no NEAR account"
    );
    Ok(())
}

#[tokio::test]
async fn a_signer_registers_with_collateral_and_never_needs_near() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 600).await?;
    let key = SigningKey::from_bytes(&[13u8; 32]);
    let signer: AccountId = implicit_id(&key).parse()?;
    deposit_to_intents(&w, &w.alice, &signer, 30 * USD).await?;

    let r = relay(&w, signed(&w, &key, transfer_to_market(&w, 5 * USD, "deposit"), 1)).await?;
    assert!(market_refused(&w, &r), "an unregistered signer cannot deposit");
    assert_eq!(intents_balance(&w, &signer).await, 30 * USD);

    let fee = u(&config(&w.market).await["registration_fee"]);
    let treasury_before = fees(&w).await.2;
    let r = relay(&w, signed(&w, &key, transfer_to_market(&w, 20 * USD, "register"), 2)).await?;
    assert_clean(&w, "register with collateral", &r);
    assert_eq!(market_balance(&w, &signer).await, 20 * USD - fee);
    assert_eq!(
        fees(&w).await.2,
        treasury_before + fee,
        "the fee is due to the treasury"
    );
    assert_reconciled(&w).await;

    let r = relay(
        &w,
        signed(&w, &key, market_action(&w, &format!("buy:{id}:yes:{}:1", 5 * USD)), 3),
    )
    .await?;
    assert_clean(&w, "signed buy after a collateral registration", &r);
    assert!(shares(&w, id, &signer).await.0 > 0);

    let rest = market_balance(&w, &signer).await;
    let r = relay(&w, signed(&w, &key, market_action(&w, &format!("withdraw:{rest}")), 4)).await?;
    assert_clean(&w, "signed withdrawal after a collateral registration", &r);
    assert_eq!(intents_balance(&w, &signer).await, 10 * USD + rest);
    assert_reconciled(&w).await;

    let r = relay(&w, signed(&w, &key, transfer_to_market(&w, 5 * USD, "register"), 5)).await?;
    assert!(market_refused(&w, &r), "an account registers once");
    assert_eq!(
        intents_balance(&w, &signer).await,
        10 * USD + rest,
        "and the verifier refunds the second attempt in full"
    );
    assert!(
        w.worker.view_account(&signer).await.is_err(),
        "the signer never had a NEAR account"
    );
    Ok(())
}

#[tokio::test]
async fn only_the_holders_own_signature_moves_their_balance() -> anyhow::Result<()> {
    let w = setup().await?;
    let key = SigningKey::from_bytes(&[11u8; 32]);
    let signer: AccountId = implicit_id(&key).parse()?;
    sponsor(&w, &signer).await?;
    deposit_to_intents(&w, &w.alice, &signer, 10 * USD).await?;
    let r = relay(&w, signed(&w, &key, transfer_to_market(&w, 10 * USD, "deposit"), 1)).await?;
    assert_clean(&w, "deposit by a signed transfer", &r);
    assert_eq!(market_balance(&w, &signer).await, 10 * USD);
    let take_all = format!("withdraw:{}", 10 * USD);

    let r = w
        .alice
        .call(w.market.id(), "on_auth")
        .args_json(json!({ "signer_id": signer, "msg": take_all }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(r.is_failure(), "only the verifier may call on_auth");

    let stranger = SigningKey::from_bytes(&[12u8; 32]);
    let mut forged = signed(&w, &key, market_action(&w, &take_all), 2);
    let theirs = signed(&w, &stranger, market_action(&w, &take_all), 2);
    forged["public_key"] = theirs["public_key"].clone();
    forged["signature"] = theirs["signature"].clone();
    let r = relay(&w, forged).await?;
    assert!(
        r.is_failure(),
        "a signature from a key that is not the holder's is refused"
    );

    let r = relay(&w, theirs.clone()).await?;
    assert!(
        market_refused(&w, &r),
        "the stranger's own signature acts only for the stranger, who has nothing"
    );
    let r = relay(&w, theirs).await?;
    assert!(r.is_failure(), "a refused action still spends its nonce");

    let r = relay(&w, signed(&w, &key, market_action(&w, "steal:0"), 3)).await?;
    assert!(market_refused(&w, &r), "an unknown action is refused");

    assert_eq!(market_balance(&w, &signer).await, 10 * USD);
    assert_eq!(intents_balance(&w, &signer).await, 0);
    assert_reconciled(&w).await;
    Ok(())
}
