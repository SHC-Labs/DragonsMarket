mod common;

use common::{verifier_wasm, wasm, USD};
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

#[tokio::test]
async fn human_cash_out_pays_the_wallet_and_refunds_an_unregistered_receiver() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let missing = worker.dev_create_account().await?;
    let verifier = worker.dev_deploy(&verifier_wasm()).await?;
    let token = worker.dev_deploy(&wasm("mock_ft")).await?;
    verifier
        .call("new")
        .args_json(json!({ "config": {
            "wnear_id": "wrap.near",
            "fees": { "fee": 0, "fee_collector": owner.id() },
            "roles": { "super_admins": [owner.id()], "grantees": {} }
        }}))
        .transact()
        .await?
        .into_result()?;
    token
        .call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(token.id(), "storage_deposit")
        .args_json(json!({ "account_id": verifier.id(), "registration_only": true }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(token.id(), "mint")
        .args_json(json!({ "account_id": alice.id(), "amount": (10 * USD).to_string() }))
        .transact()
        .await?
        .into_result()?;
    alice
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": verifier.id(), "amount": (10 * USD).to_string(), "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for (receiver, paid, remaining) in [(alice.id(), USD, 9 * USD), (missing.id(), 0, 9 * USD)] {
        let result = alice
            .call(verifier.id(), "ft_withdraw")
            .args_json(json!({ "token": token.id(), "receiver_id": receiver, "amount": USD.to_string() }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?;
        assert!(
            result.is_success(),
            "the resolver can succeed even when the token transfer failed"
        );
        assert_eq!(result.receipt_failures().is_empty(), paid > 0);
        assert_eq!(result.json::<String>()?, paid.to_string());
        let held: String = verifier
            .view("mt_balance_of")
            .args_json(json!({ "account_id": alice.id(), "token_id": format!("nep141:{}", token.id()) }))
            .await?
            .json()?;
        assert_eq!(held, remaining.to_string());
        let wallet: String = token
            .view("ft_balance_of")
            .args_json(json!({ "account_id": receiver }))
            .await?
            .json()?;
        assert_eq!(wallet, paid.to_string());
    }
    Ok(())
}
