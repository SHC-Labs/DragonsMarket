mod common;
use common::*;
use serde_json::json;

#[tokio::test]
async fn faucet_gives_test_money_until_there_is_enough() -> anyhow::Result<()> {
    let w = setup().await?;
    let before = ft_balance(&w, w.carol.id()).await;
    for _ in 0..10 {
        w.carol.call(w.ft.id(), "faucet").transact().await?.into_result()?;
    }
    assert_eq!(ft_balance(&w, w.carol.id()).await, before + 1000 * USD);
    // Over the cap the faucet refuses and nothing changes.
    let r = w.carol.call(w.ft.id(), "faucet").transact().await?;
    assert!(r.is_failure());
    assert_eq!(ft_balance(&w, w.carol.id()).await, before + 1000 * USD);
    // A brand new account is registered by its first call.
    let erin = w.worker.dev_create_account().await?;
    erin.call(w.ft.id(), "faucet").transact().await?.into_result()?;
    let bal: String =
        w.ft.view("ft_balance_of")
            .args_json(json!({ "account_id": erin.id() }))
            .await?
            .json()?;
    assert_eq!(bal, (100 * USD).to_string());
    Ok(())
}
