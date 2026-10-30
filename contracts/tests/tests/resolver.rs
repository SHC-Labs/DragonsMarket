mod common;
use common::*;
use ed25519_dalek::SigningKey;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

const STRIKE: u128 = 10_000;
const DECIMALS: u8 = 2;
const SETTLE_SECS: u64 = 120;

struct Spawned {
    child: Child,
    url: String,
}

impl Drop for Spawned {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn(script: &str, args: &[&str], env: &[(&str, String)]) -> Spawned {
    let mut command = Command::new("node");
    command
        .arg(script)
        .args(args)
        .env_remove("PUBLISHER_KEY")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.spawn().expect("node runs");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let url = line
        .split_whitespace()
        .last()
        .filter(|u| u.starts_with("http://"))
        .unwrap_or_else(|| panic!("{script} did not start: {line}"))
        .to_string();
    Spawned { child, url }
}

fn keeper_script(name: &str) -> String {
    format!("{}/../keeper/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn secret_of(key: &SigningKey) -> String {
    let mut raw = key.to_bytes().to_vec();
    raw.extend_from_slice(&key.verifying_key().to_bytes());
    format!("ed25519:{}", bs58::encode(raw).into_string())
}

fn public_of(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string())
}

async fn resolver(w: &World, args: &[&str]) -> (String, bool) {
    w.worker.fast_forward(6).await.unwrap();
    let rpc = w.worker.rpc_addr();
    let out = Command::new("node")
        .arg(keeper_script("resolver.mjs"))
        .args(args)
        .args([
            "--rpc",
            &rpc,
            "--market",
            w.market.id().as_str(),
            "--oracle",
            w.oracle.id().as_str(),
        ])
        .args(["--account", w.carol.id().as_str()])
        .env("RESOLVER_KEY", w.carol.secret_key().to_string())
        .output()
        .expect("node runs the resolver");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (text, out.status.success())
}

async fn publishers(w: &World, exchanges: &Spawned) -> anyhow::Result<Vec<Spawned>> {
    let rpc = w.worker.rpc_addr();
    let mut running = vec![];
    for seed in 1u8..=3 {
        let key = SigningKey::from_bytes(&[seed; 32]);
        w.owner
            .call(w.oracle.id(), "add_publisher")
            .args_json(json!({ "key": public_of(&key) }))
            .transact()
            .await?
            .into_result()?;
        let mut args = vec![
            "serve",
            "--rpc",
            &rpc,
            "--oracle",
            w.oracle.id().as_str(),
            "--port",
            "0",
        ];
        for venue in ["--coinbase-url", "--kraken-url", "--bitstamp-url"] {
            args.extend([venue, exchanges.url.as_str()]);
        }
        running.push(spawn(
            &keeper_script("publisher.mjs"),
            &args,
            &[("PUBLISHER_KEY", secret_of(&key))],
        ));
    }
    Ok(running)
}

async fn btc_price_market(w: &World) -> anyhow::Result<u64> {
    let close_at = now(&w.worker).await + 120 * 1_000_000_000;
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .deposit(NearToken::from_millinear(60))
        .args_json(json!({
            "title": "Will bitcoin close at or above 100.00 USD?", "rule_text": "Yes if the price is at or above 100.00.",
            "resolution_source": "Median of BTC-USD one minute closes on Coinbase, Kraken and Bitstamp",
            "void_policy": "Fewer than two exchanges publish a price.",
            "category": "crypto", "subcategory": "bitcoin", "close_at": close_at.to_string(),
            "resolve_by": (close_at + MARKET_GAP_SECS * 1_000_000_000).to_string(),
            "price_rule": { "observation_time": close_at.to_string(), "strike": STRIKE.to_string(), "decimals": DECIMALS, "above": true }
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    Ok(id.parse()?)
}

#[tokio::test]
async fn publishers_sign_the_exchange_median_and_the_resolver_answers_the_price_market() -> anyhow::Result<()> {
    let w = setup().await?;
    let exchanges = spawn(
        concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/exchanges.mjs"),
        &["--coinbase", "105.01", "--kraken", "105.00", "--bitstamp", "104.98"],
        &[],
    );
    let running = publishers(&w, &exchanges).await?;
    let all = running.iter().map(|p| p.url.as_str()).collect::<Vec<_>>().join(",");
    let id = btc_price_market(&w).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    buy(&w, &w.bob, id, "no", 10 * USD).await?;

    let (out, ok) = resolver(&w, &["run", "--publishers", &all]).await;
    assert!(ok && out.contains("no price market is waiting for its price"), "{out}");

    skip_secs(&w.worker, 130 + SETTLE_SECS).await;
    let (out, ok) = resolver(&w, &["run", "--publishers", &running[0].url]).await;
    assert!(
        !ok && out.contains(&format!(
            "market {id}: at most 1 valid signatures agree on one price, and 2 must"
        )),
        "{out}"
    );
    assert!(case_json(&w, id).await.is_null(), "one publisher alone posts no bond");

    let (out, ok) = resolver(&w, &["run", "--publishers", &all]).await;
    assert!(
        !ok && out.contains(&format!("holds 0 in the verifier and a bond is {BOND}")),
        "{out}"
    );

    deposit_to_intents(&w, &w.carol, w.carol.id(), BOND).await?;
    let (out, ok) = resolver(&w, &["run", "--publishers", &all, "--dry-run"]).await;
    assert!(
        ok && out.contains(&format!("market {id}: would submit price 10500 signed by 3 publishers")),
        "{out}"
    );
    assert!(case_json(&w, id).await.is_null(), "a dry run sends nothing");

    let (out, ok) = resolver(&w, &["run", "--publishers", &all]).await;
    assert!(
        ok && out.contains(&format!("market {id}: submitted price 10500 signed by 3 publishers")),
        "{out}"
    );
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["proposed"], &case["evidence"]),
        (
            &json!("proposed"),
            &json!("yes"),
            &json!("signed price 10500 by 3 publishers")
        )
    );
    assert_eq!(intents_balance(&w, w.carol.id()).await, 0, "the bond is held");

    let (out, ok) = resolver(&w, &["run", "--publishers", &all]).await;
    assert!(
        ok && !out.contains("submitted"),
        "a market with a case is left alone: {out}"
    );

    skip_secs(&w.worker, PAST_WINDOW_SECS).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "yes");
    assert_eq!(claimable(&w, w.carol.id()).await, BOND, "the bond comes back");
    Ok(())
}

#[tokio::test]
async fn an_operator_answers_an_event_market_through_the_resolver_with_its_bond() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = new_market(&w, 120).await?;
    let propose = [
        "propose",
        "--market-id",
        &id.to_string(),
        "--answer",
        "yes",
        "--evidence",
        "https://example.com/result",
    ];

    let (out, ok) = resolver(&w, &["pending"]).await;
    assert!(ok && out.contains("no closed market is waiting for an answer"), "{out}");
    let (out, ok) = resolver(&w, &propose).await;
    assert!(!ok && out.contains(&format!("market {id} has not closed")), "{out}");

    skip_secs(&w.worker, 130).await;
    let (out, ok) = resolver(&w, &["pending"]).await;
    assert!(ok && out.contains(&format!("event market {id}, resolve by ")), "{out}");
    let (out, ok) = resolver(&w, &propose).await;
    assert!(
        !ok && out.contains(&format!("holds 0 in the verifier and a bond is {BOND}")),
        "{out}"
    );

    deposit_to_intents(&w, &w.carol, w.carol.id(), BOND).await?;
    let (out, ok) = resolver(&w, &propose).await;
    assert!(
        ok && out.contains(&format!("market {id}: proposed yes with a bond of {BOND}")),
        "{out}"
    );
    let case = case_json(&w, id).await;
    assert_eq!(
        (&case["stage"], &case["proposed"], &case["evidence"], &case["proposer"]),
        (
            &json!("proposed"),
            &json!("yes"),
            &json!("https://example.com/result"),
            &json!(w.carol.id())
        )
    );

    let (out, ok) = resolver(&w, &propose).await;
    assert!(!ok && out.contains("already has a case"), "{out}");
    let (out, _) = resolver(&w, &["pending"]).await;
    assert!(!out.contains(&format!("event market {id},")), "{out}");

    skip_secs(&w.worker, PAST_WINDOW_SECS).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "yes");
    Ok(())
}
