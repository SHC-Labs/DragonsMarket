// Funds review: NEAR sent to the market's storage_deposit by the Intents verifier (a signed storage deposit intent).
//
// The market treats the verifier as a payer it should not record (market/src/lib.rs:2351), but still sends every refund to
// the predecessor (market/src/lib.rs:2358-2359). When the predecessor is the verifier, that refund is a plain NEAR transfer
// to the verifier's own account, where nobody is credited for it. A deposit for an account that is already registered is
// refunded whole, and any deposit above 0.05 NEAR for a new account loses the surplus the same way.
//
// The test plays the verifier with an account it controls, the same way intents_market.rs does for mt_on_transfer.
mod common;
use common::*;
use near_workspaces::types::NearToken;
use serde_json::json;

async fn near_of(w: &World, who: &near_workspaces::AccountId) -> u128 {
    w.worker.view_account(who).await.unwrap().balance.as_yoctonear()
}

#[tokio::test]
async fn a_storage_deposit_the_verifier_relays_never_refunds_into_the_verifier_account() -> anyhow::Result<()> {
    let w = setup().await?;
    let fake_verifier = &w.dave;
    let market = w.worker.dev_deploy(&wasm("market")).await?;
    market
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "operator_id": w.owner.id(), "oracle_id": w.oracle.id(),
            "verifier_id": fake_verifier.id(), "collateral_token_id": token_id(&w)
        }))
        .transact()
        .await?
        .into_result()?;
    w.alice
        .call(market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;

    // Alice is already registered: the market refunds the whole 0.1 NEAR to its caller, the verifier.
    let before = near_of(&w, fake_verifier.id()).await;
    fake_verifier
        .call(market.id(), "storage_deposit")
        .args_json(json!({ "account_id": w.alice.id() }))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    let after = near_of(&w, fake_verifier.id()).await;
    let back_to_verifier = after.saturating_sub(before.saturating_sub(NearToken::from_millinear(100).as_yoctonear()));
    assert!(
        back_to_verifier < NearToken::from_millinear(1).as_yoctonear(),
        "{} yocto of a relayed deposit for an already registered account went back to the verifier's own account, \
         where the signer of the intent is not credited for it",
        back_to_verifier
    );

    // A new account and 0.08 NEAR: the 0.03 NEAR surplus goes the same way.
    let before = near_of(&w, fake_verifier.id()).await;
    fake_verifier
        .call(market.id(), "storage_deposit")
        .args_json(json!({ "account_id": w.carol.id() }))
        .deposit(NearToken::from_millinear(80))
        .transact()
        .await?
        .into_result()?;
    let after = near_of(&w, fake_verifier.id()).await;
    let back_to_verifier = after.saturating_sub(before.saturating_sub(NearToken::from_millinear(80).as_yoctonear()));
    assert!(
        back_to_verifier < NearToken::from_millinear(1).as_yoctonear(),
        "{} yocto of surplus on a relayed registration went back to the verifier's own account",
        back_to_verifier
    );
    Ok(())
}
