use serde_json::json;
use std::path::PathBuf;

fn wasm(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../target/near/{0}/{0}.wasm", name));
    std::fs::read(&p).unwrap_or_else(|e| panic!("build {name} first with cargo near build ({p:?}): {e}"))
}

#[tokio::test]
async fn mock_token_mints_in_the_sandbox() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let ft = worker.dev_deploy(&wasm("mock_ft")).await?;
    let owner = worker.dev_create_account().await?;
    ft.call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(ft.id(), "mint")
        .args_json(json!({ "account_id": owner.id(), "amount": "25000000" }))
        .transact()
        .await?
        .into_result()?;
    let bal: String = ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": owner.id() }))
        .await?
        .json()?;
    assert_eq!(bal, "25000000");
    Ok(())
}
