// What each contract says about itself through contract_source_metadata (NEP-330): where the source is and which
// standards it follows. Real wasm, sandbox chain.
mod common;
use common::*;
use serde_json::{json, Value};

const REPOSITORY: &str = "https://github.com/SHC-Labs/Council-PM";

async fn metadata(contract: &near_workspaces::Contract) -> Value {
    contract.view("contract_source_metadata").await.unwrap().json().unwrap()
}

fn standards(metadata: &Value) -> Vec<(String, String)> {
    metadata["standards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["standard"].as_str().unwrap().to_string(),
                s["version"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[tokio::test]
async fn every_contract_names_its_source_and_the_standards_it_follows() -> anyhow::Result<()> {
    let w = setup().await?;
    let nep = |name: &str, version: &str| (name.to_string(), version.to_string());
    let cases = [
        (
            &w.market,
            vec![nep("nep145", "1.0.0"), nep("nep297", "1.0.0"), nep("nep330", "1.3.0")],
        ),
        (&w.oracle, vec![nep("nep297", "1.0.0"), nep("nep330", "1.3.0")]),
        (&w.council, vec![nep("nep297", "1.0.0"), nep("nep330", "1.3.0")]),
    ];
    for (contract, want) in cases {
        let m = metadata(contract).await;
        assert_eq!(m["link"], json!(REPOSITORY), "{}", contract.id());
        assert_eq!(m["version"], "0.1.0");
        assert_eq!(standards(&m), want, "{}", contract.id());
    }
    Ok(())
}
