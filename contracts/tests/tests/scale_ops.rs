// Measurements for the scale review. Heavy, so every test here is ignored by default. Run one at a time:
//   cargo test -p tests --test scale_ops <name> -- --ignored --nocapture --test-threads=1
// A view method can be sent as an ordinary transaction with 300 TGas attached, and the outcome reports the gas it burnt. The
// sandbox does not enforce the 200 TGas view limit, so views are judged by burnt gas.
mod common;
use common::*;
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::AccountId;
use serde_json::{json, Value};
use std::process::Command;
use std::time::Instant;

const SIZES: [u64; 4] = [250, 1_000, 2_500, 5_000];
const SEED_AMOUNT: u128 = 3 * USD;
const SEED_PRICE: &str = "300000";
const CREATE_PER_CALL: u64 = 70;
const CREATE_BATCH: usize = 4;
const SEED_PER_CALL: u64 = 70;
const THIRTY_DAYS_SECS: u64 = 30 * 24 * 3_600;
const MAX_READBACK: u64 = 1_000;
const LIMIT_SECS: f64 = 30.0 * 60.0;
const PROBE_CLOSE_SECS: u64 = 100;
const VIEW_TX_TGAS: u64 = 300;
const PAST_CLOSE_SECS: u64 = 130;
const PAST_WINDOW_SECS: u64 = 70;
const BYTES_PER_RECORD_OVERHEAD: u64 = 40;
const YOCTO_PER_BYTE: f64 = 1e19;

fn rpc(w: &near_workspaces::Worker<near_workspaces::network::Sandbox>, body: Value) -> anyhow::Result<Value> {
    let out = Command::new("curl")
        .args(["-s", "-X", "POST", "-H", "content-type: application/json", "--data"])
        .arg(body.to_string())
        .arg(w.rpc_addr())
        .output()?;
    Ok(serde_json::from_slice(&out.stdout)?)
}

#[tokio::test]
#[ignore]
async fn protocol_constants() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let cfg = rpc(
        &worker,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "EXPERIMENTAL_protocol_config", "params": { "finality": "final" } }),
    )?;
    let status = rpc(
        &worker,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "status", "params": [] }),
    )?;
    let r = &cfg["result"];
    println!("sandbox rpc: {}", worker.rpc_addr());
    println!("node version: {}", status["result"]["version"]);
    println!("protocol_version: {}", r["protocol_version"]);
    println!(
        "storage_amount_per_byte: {}",
        r["runtime_config"]["storage_amount_per_byte"]
    );
    let limits = &r["runtime_config"]["wasm_config"]["limit_config"];
    for key in [
        "max_gas_burnt",
        "max_total_prepaid_gas",
        "max_length_storage_value",
        "max_length_storage_key",
        "max_number_logs",
        "max_total_log_length",
        "max_number_bytes_method_names",
    ] {
        println!("limit_config.{key}: {}", limits[key]);
    }
    let found_view = cfg.to_string().contains("max_gas_burnt_view");
    println!("max_gas_burnt_view present in the protocol config response: {found_view}");
    let ext = &r["runtime_config"]["wasm_config"]["ext_costs"];
    for key in [
        "storage_read_base",
        "storage_read_key_byte",
        "storage_read_value_byte",
        "storage_write_base",
        "storage_write_key_byte",
        "storage_write_value_byte",
        "storage_write_evicted_byte",
        "storage_has_key_base",
        "storage_remove_base",
        "storage_remove_ret_value_byte",
        "read_memory_base",
        "read_memory_byte",
        "write_memory_base",
        "write_memory_byte",
        "sha256_base",
        "sha256_byte",
    ] {
        println!("ext_costs.{key}: {}", ext[key]);
    }
    let fees = &r["runtime_config"]["transaction_costs"];
    println!(
        "action_receipt_creation_config: {}",
        fees["action_receipt_creation_config"]
    );
    println!("data_receipt_creation_config: {}", fees["data_receipt_creation_config"]);
    println!(
        "action_creation_config.function_call_cost: {}",
        fees["action_creation_config"]["function_call_cost"]
    );
    println!(
        "action_creation_config.function_call_cost_per_byte: {}",
        fees["action_creation_config"]["function_call_cost_per_byte"]
    );
    println!("action_creation_config (whole): {}", fees["action_creation_config"]);
    println!("storage_usage_config: {}", fees["storage_usage_config"]);
    println!(
        "wasm regular_op_cost: {}",
        r["runtime_config"]["wasm_config"]["regular_op_cost"]
    );
    Ok(())
}

// The next market ids come from a running counter, checked against the chain after each size.
struct Fleet {
    next_id: u64,
    seeded: u64,
}

async fn create_batch(w: &World, fleet: &mut Fleet, count: usize) -> anyhow::Result<()> {
    let close_at = now(&w.worker).await + THIRTY_DAYS_SECS * 1_000_000_000;
    let mut batch = w.owner.batch(w.market.id());
    for i in 0..count as u64 {
        batch = batch.call(
            Function::new("create_market")
                .deposit(near_workspaces::types::NearToken::from_millinear(60))
                .args_json(json!({
                    "title": format!("Scale market number {}", fleet.next_id + i),
                    "rule_text": "Resolves Yes if the test says so.",
                    "resolution_source": "https://example.com/source",
                    "void_policy": "Void if the test is cancelled.",
                    "category": "world",
                    "subcategory": "science",
                    "close_at": close_at.to_string(),
                    "resolve_by": (close_at + 3_600 * 1_000_000_000).to_string()
                }))
                .gas(Gas::from_tgas(CREATE_PER_CALL)),
        );
    }
    batch.transact().await?.into_result()?;
    fleet.next_id += count as u64;
    Ok(())
}

fn seed_args(w: &World, id: u64, price: Option<&str>) -> Value {
    let msg = match price {
        Some(p) => format!("seed:{id}:{p}"),
        None => format!("seed:{id}"),
    };
    json!({ "receiver_id": w.market.id(), "token_id": token_id(w), "amount": SEED_AMOUNT.to_string(), "msg": msg })
}

// Seeds markets first..first+count in one transaction, from the operator's Intents balance.
async fn seed_batch(w: &World, first: u64, count: usize, price: Option<&str>) -> anyhow::Result<()> {
    let mut batch = w.owner.batch(w.verifier.id());
    for id in first..first + count as u64 {
        batch = batch.call(
            Function::new("mt_transfer_call")
                .args_json(seed_args(w, id, price))
                .deposit(NearToken::from_yoctonear(1))
                .gas(Gas::from_tgas(SEED_PER_CALL)),
        );
    }
    batch.transact().await?.into_result()?;
    Ok(())
}

// Creates and seeds markets until `target` are held by the operator.
async fn grow_to(w: &World, fleet: &mut Fleet, target: u64) -> anyhow::Result<()> {
    while fleet.seeded < target {
        let take = CREATE_BATCH.min((target - fleet.seeded) as usize);
        let first = fleet.next_id;
        create_batch(w, fleet, take).await?;
        seed_batch(w, first, take, Some(SEED_PRICE)).await?;
        fleet.seeded += take as u64;
    }
    Ok(())
}

async fn held(w: &World, who: &AccountId) -> anyhow::Result<usize> {
    let v: Vec<Value> = w
        .market
        .view("get_positions")
        .args_json(json!({ "account_id": who }))
        .await?
        .json()?;
    Ok(v.len())
}

// The list is only read back while it is short: past that the view itself runs out of gas, which is part of the finding.
async fn check_held(w: &World, size: u64) -> anyhow::Result<()> {
    if size <= MAX_READBACK {
        assert_eq!(
            held(w, w.owner.id()).await? as u64,
            size,
            "the operator should hold {size} markets"
        );
    }
    Ok(())
}

// A market method sent as an ordinary transaction with 300 TGas. Returns the gas burnt, or why it failed.
async fn view_gas(w: &World, method: &str, args: Value) -> Result<f64, String> {
    let outcome = w
        .carol
        .call(w.market.id(), method)
        .args_json(args)
        .gas(Gas::from_tgas(VIEW_TX_TGAS))
        .transact()
        .await
        .map_err(|e| format!("{e:?}"))?;
    let burnt = tg(outcome.total_gas_burnt);
    outcome
        .into_result()
        .map(|_| burnt)
        .map_err(|e| e.to_string().chars().take(100).collect())
}

struct Fit {
    a: f64,
    b: f64,
}

fn fit(points: &[(f64, f64)]) -> Fit {
    let n = points.len() as f64;
    let sx: f64 = points.iter().map(|p| p.0).sum();
    let sy: f64 = points.iter().map(|p| p.1).sum();
    let sxx: f64 = points.iter().map(|p| p.0 * p.0).sum();
    let sxy: f64 = points.iter().map(|p| p.0 * p.1).sum();
    let b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    Fit {
        a: (sy - b * sx) / n,
        b,
    }
}

fn report_fit(name: &str, points: &[(f64, f64)]) {
    if points.len() < 2 {
        return;
    }
    let f = fit(points);
    println!(
        "{name}: gas = {:.3} + {:.6} * N TGas (linear fit over {} points)",
        f.a,
        f.b,
        points.len()
    );
    for n in [10_000.0, 50_000.0, 100_000.0] {
        println!("  EXTRAPOLATION at N = {n:.0}: {:.1} TGas", f.a + f.b * n);
    }
    if f.b > 0.0 {
        println!("  EXTRAPOLATION: reaches 300 TGas at N = {:.0}", (300.0 - f.a) / f.b);
    }
}

// How much one market receipt of the operator's seed and redeem costs as the operator's list of held markets grows.
#[tokio::test]
#[ignore]
async fn operator_index_cost() -> anyhow::Result<()> {
    let started = Instant::now();
    let w = setup().await?;
    top_up(&w, w.market.id()).await?;
    top_up(&w, w.oracle.id()).await?;
    let needed = (SIZES[SIZES.len() - 1] + 20) as u128 * SEED_AMOUNT;
    mint(&w, w.owner.id(), needed).await?;
    deposit_to_intents(&w, &w.owner, w.owner.id(), needed).await?;
    let mut fleet = Fleet { next_id: 0, seeded: 0 };
    let mut seed_points = vec![];
    let mut redeem_points = vec![];
    let mut rate = 0.0;
    println!("\nwhat | held N | burnt TGas (market receipt) | whole tx TGas | ms | notes");
    let largest: u64 = std::env::var("SCALE_OPS_MAX")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(u64::MAX);
    for size in SIZES.into_iter().filter(|s| *s <= largest) {
        if rate > 0.0 && started.elapsed().as_secs_f64() + (size - fleet.seeded) as f64 / rate > LIMIT_SECS {
            println!("stopped before {size}: the run would pass 30 minutes");
            break;
        }
        let step = Instant::now();
        let before = fleet.seeded;
        grow_to(&w, &mut fleet, size).await?;
        if fleet.seeded > before {
            rate = (fleet.seeded - before) as f64 / step.elapsed().as_secs_f64();
        }
        check_held(&w, size).await?;
        println!(
            "-- {size} markets created and seeded, {:.1} markets per second, {:.0}s since start",
            rate,
            started.elapsed().as_secs_f64()
        );

        // The list's size on disk. The sandbox refuses view_state on a state this large, so this is computed from the Borsh
        // layout: the key is a 1 byte prefix, a 4 byte length and the id; the value is a 4 byte length and 8 bytes per id.
        let list_key = 1 + 4 + w.owner.id().as_str().len() as u64;
        let list_value = 4 + 8 * size;
        let list_total = list_key + list_value + BYTES_PER_RECORD_OVERHEAD;
        println!(
            "operator list at N = {size} (computed): key {list_key} B + value {list_value} B + {BYTES_PER_RECORD_OVERHEAD} B overhead = {list_total} B, locks {:.4} NEAR",
            list_total as f64 * YOCTO_PER_BYTE / 1e24
        );

        // (a) one more seed.
        let probe = create_market(&w, PROBE_CLOSE_SECS, 3_600).await?;
        fleet.next_id = fleet.next_id.max(probe + 1);
        let usage_before = storage_used(&w, w.market.id()).await?;
        let t = Instant::now();
        let r = w
            .owner
            .call(w.verifier.id(), "mt_transfer_call")
            .args_json(seed_args(&w, probe, Some(SEED_PRICE)))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        let ms = t.elapsed().as_millis();
        let (market_gas, total) = (burnt_on(&r, w.market.id()), tg(r.total_gas_burnt));
        r.into_result()?;
        assert_eq!(market_json(&w, probe).await["seeded"], true);
        let usage_after = storage_used(&w, w.market.id()).await?;
        println!(
            "seed (operator, 1 more) | {size} | {market_gas:.2} | {total:.2} | {ms} | market storage_usage +{} B",
            usage_after - usage_before
        );
        seed_points.push((size as f64, market_gas));

        // (c) the account views at size + 1 held.
        let args = json!({ "account_id": w.owner.id() });
        for method in ["get_positions", "get_account"] {
            let t = Instant::now();
            let ok = w.market.view(method).args_json(args.clone()).await.is_ok();
            let ms = t.elapsed().as_millis();
            match view_gas(&w, method, args.clone()).await {
                Ok(g) => println!(
                    "{method} (as a transaction) | {} | {g:.2} | n/a | {ms} | view call ok: {ok}",
                    size + 1
                ),
                Err(e) => println!(
                    "{method} (as a transaction) | {} | ran out of 300 TGas | n/a | {ms} | {e}",
                    size + 1
                ),
            }
        }

        // (b) the probe market resolves and the operator redeems it.
        skip_secs(&w.worker, PAST_CLOSE_SECS).await;
        propose(&w, &w.carol, probe, "no").await?;
        skip_secs(&w.worker, PAST_WINDOW_SECS).await;
        w.oracle
            .call("finalize")
            .args_json(json!({ "market": w.market.id(), "market_id": probe.to_string() }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        let t = Instant::now();
        let r = w
            .owner
            .call(w.market.id(), "redeem")
            .args_json(json!({ "market_id": probe.to_string() }))
            .max_gas()
            .transact()
            .await?;
        let ms = t.elapsed().as_millis();
        let (market_gas, total) = (burnt_on(&r, w.market.id()), tg(r.total_gas_burnt));
        r.into_result()?;
        println!(
            "redeem (operator, one position) | {} | {market_gas:.2} | {total:.2} | {ms} |",
            size + 1
        );
        redeem_points.push((size as f64 + 1.0, market_gas));
        check_held(&w, size).await?;
    }
    println!();
    report_fit("seed market receipt", &seed_points);
    report_fit("redeem market receipt", &redeem_points);
    println!("total run time {:.0}s", started.elapsed().as_secs_f64());
    Ok(())
}

// ---- M2: gas for ordinary trades and the verifier path -----------------------------------------------------------------

const POOL_MARKETS: u64 = 102;
const LEVELS: [u64; 3] = [0, 20, 100];
const ID_LENGTHS: [usize; 2] = [20, 64];
const BUILD_BATCH: usize = 10;
const BUILD_PER_CALL: u64 = 28;
const R_CLOSE_SECS: u64 = 3_000;
const R_PAST_CLOSE_SECS: u64 = 3_030;
const ATTACHED_TRIES: [u64; 13] = [22, 24, 26, 28, 30, 35, 40, 50, 60, 80, 100, 150, 300];
const MAX_POSITIONS: u32 = 30;
const TRADE: u128 = USD;

fn row(what: &str, size: &str, market: f64, total: f64, ms: u128, note: &str) {
    println!("| {what} | {size} | {market:.2} | {total:.2} | {ms} | {note} |");
}

// One transaction, timed. Returns the result and the milliseconds it took.
async fn timed(
    call: near_workspaces::operations::CallTransaction,
) -> anyhow::Result<(near_workspaces::result::ExecutionFinalResult, u128)> {
    let t = Instant::now();
    let r = call.transact().await?;
    Ok((r, t.elapsed().as_millis()))
}

async fn long_user(w: &World, id_len: usize, tag: &str) -> anyhow::Result<near_workspaces::Account> {
    let user = account_with_id_len(w, id_len, tag).await?;
    user.call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    mint(w, user.id(), 600 * USD).await?;
    Ok(user)
}

// Buys one dollar of Yes in each market of `ids`, from the user's balance in the market, `BUILD_BATCH` to a transaction.
async fn build_positions(w: &World, user: &near_workspaces::Account, ids: &[u64]) -> anyhow::Result<()> {
    for chunk in ids.chunks(BUILD_BATCH) {
        let mut batch = user.batch(w.market.id());
        for id in chunk {
            batch = batch.call(
                Function::new("buy")
                    .args_json(json!({ "market_id": id.to_string(), "side": "yes", "amount": TRADE.to_string(), "min_shares": "1" }))
                    .deposit(NearToken::from_yoctonear(1))
                    .gas(Gas::from_tgas(BUILD_PER_CALL)),
            );
        }
        batch.transact().await?.into_result()?;
    }
    Ok(())
}

fn buy_balance(w: &World, user: &near_workspaces::Account, id: u64) -> near_workspaces::operations::CallTransaction {
    user.call(w.market.id(), "buy")
        .args_json(
            json!({ "market_id": id.to_string(), "side": "yes", "amount": TRADE.to_string(), "min_shares": "1" }),
        )
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(300))
}

async fn ask_held(w: &World, user: &near_workspaces::Account) -> anyhow::Result<usize> {
    held(w, user.id()).await
}

#[tokio::test]
#[ignore]
async fn trade_gas_by_account_length_and_positions() -> anyhow::Result<()> {
    let started = Instant::now();
    let w = setup().await?;
    w.owner
        .call(w.market.id(), "set_max_positions")
        .args_json(json!({ "max_positions": MAX_POSITIONS }))
        .transact()
        .await?
        .into_result()?;
    let needed = (POOL_MARKETS + 10) as u128 * SEED_AMOUNT;
    mint(&w, w.owner.id(), needed).await?;
    deposit_to_intents(&w, &w.owner, w.owner.id(), needed).await?;
    let mut fleet = Fleet { next_id: 0, seeded: 0 };
    while fleet.next_id < POOL_MARKETS {
        let take = CREATE_BATCH.min((POOL_MARKETS - fleet.next_id) as usize);
        let first = fleet.next_id;
        create_batch(&w, &mut fleet, take).await?;
        seed_batch(&w, first, take, None).await?;
    }
    assert_eq!(market_json(&w, POOL_MARKETS - 1).await["seeded"], true);
    println!(
        "pool of {POOL_MARKETS} seeded markets ready after {:.0}s",
        started.elapsed().as_secs_f64()
    );
    println!("\n| what | account id length / positions held | market receipt TGas | whole tx TGas | ms | notes |");
    println!("|---|---|---|---|---|---|");

    for id_len in ID_LENGTHS {
        for p in LEVELS {
            let user = long_user(&w, id_len, &format!("u{p}x")).await?;
            // The reserved market R that the user redeems at the end.
            let r_id = create_market(&w, R_CLOSE_SECS, 3_600).await?;
            seed_batch(&w, r_id, 1, None).await?;
            ft_call(&w, &user, w.market.id(), 200 * USD, "deposit").await?;
            deposit_to_intents(&w, &user, user.id(), 300 * USD).await?;
            if p >= 1 {
                let mut ids = vec![r_id];
                ids.extend(0..p - 1);
                build_positions(&w, &user, &ids).await?;
            }
            assert_eq!(ask_held(&w, &user).await? as u64, p);
            let (new1, new2) = if p == 0 { (r_id, 0) } else { (p.saturating_sub(1), p) };
            let at_cap = p >= MAX_POSITIONS as u64;
            let tag = format!("id {id_len} chars / {p} held");
            let mut sell_market = new1;
            if !at_cap {
                let h = ask_held(&w, &user).await?;
                let (r, ms) = timed(buy_balance(&w, &user, new1)).await?;
                row(
                    "buy from balance, new position",
                    &format!("{id_len} / {h}"),
                    burnt_on(&r, w.market.id()),
                    tg(r.total_gas_burnt),
                    ms,
                    "",
                );
                r.into_result()?;
                let h = ask_held(&w, &user).await?;
                let t = Instant::now();
                let r = intents_call(&w, &user, w.market.id(), TRADE, &format!("buy:{new2}:yes:1")).await?;
                let ms = t.elapsed().as_millis();
                row(
                    "buy via mt_transfer_call, new position",
                    &format!("{id_len} / {h}"),
                    burnt_on(&r, w.market.id()),
                    tg(r.total_gas_burnt),
                    ms,
                    "",
                );
                r.into_result()?;
            } else {
                sell_market = 0;
                println!("(at the position cap of {MAX_POSITIONS}: a buy into a new market is refused, so only held markets are measured) {tag}");
            }
            let held_market = sell_market;
            let h = ask_held(&w, &user).await?;
            let (r, ms) = timed(buy_balance(&w, &user, held_market)).await?;
            row(
                "buy from balance, held market",
                &format!("{id_len} / {h}"),
                burnt_on(&r, w.market.id()),
                tg(r.total_gas_burnt),
                ms,
                "",
            );
            r.into_result()?;
            let t = Instant::now();
            let r = intents_call(&w, &user, w.market.id(), TRADE, &format!("buy:{held_market}:yes:1")).await?;
            let ms = t.elapsed().as_millis();
            row(
                "buy via mt_transfer_call, held market",
                &format!("{id_len} / {h}"),
                burnt_on(&r, w.market.id()),
                tg(r.total_gas_burnt),
                ms,
                "",
            );
            r.into_result()?;

            // A partial sell, then a sell of everything in a second market.
            let (yes, _) = shares(&w, held_market, user.id()).await;
            let (out, shares_in, _) = quote_sell(&w, held_market, "yes", yes / 2).await;
            let (r, ms) = timed(
                user.call(w.market.id(), "sell")
                    .args_json(json!({ "market_id": held_market.to_string(), "side": "yes", "collateral_out": out.to_string(), "max_shares_in": shares_in.to_string() }))
                    .deposit(NearToken::from_yoctonear(1))
                    .gas(Gas::from_tgas(300)),
            )
            .await?;
            row(
                "sell, partial (entry stays)",
                &format!("{id_len} / {h}"),
                burnt_on(&r, w.market.id()),
                tg(r.total_gas_burnt),
                ms,
                "",
            );
            r.into_result()?;

            let zero_market = if at_cap { held_market } else { new2 };
            let (all, _) = shares(&w, zero_market, user.id()).await;
            let (out, _, _) = quote_sell(&w, zero_market, "yes", all).await;
            let mut done = false;
            for extra in 0..4u128 {
                let (r, ms) = timed(
                    user.call(w.market.id(), "sell")
                        .args_json(json!({ "market_id": zero_market.to_string(), "side": "yes", "collateral_out": (out + extra).to_string(), "max_shares_in": all.to_string() }))
                        .deposit(NearToken::from_yoctonear(1))
                        .gas(Gas::from_tgas(300)),
                )
                .await?;
                if r.is_success() && shares(&w, zero_market, user.id()).await.0 == 0 {
                    row(
                        "sell, everything (entry closes)",
                        &format!("{id_len} / {h}"),
                        burnt_on(&r, w.market.id()),
                        tg(r.total_gas_burnt),
                        ms,
                        "",
                    );
                    done = true;
                    break;
                }
            }
            if !done {
                println!("sell of everything could not be made exact at {tag}: dust always left");
            }

            // Resolve R and redeem.
            skip_secs(&w.worker, R_PAST_CLOSE_SECS).await;
            propose(&w, &w.carol, r_id, "yes").await?;
            skip_secs(&w.worker, PAST_WINDOW_SECS).await;
            w.oracle
                .call("finalize")
                .args_json(json!({ "market": w.market.id(), "market_id": r_id.to_string() }))
                .gas(Gas::from_tgas(100))
                .transact()
                .await?
                .into_result()?;
            let h = ask_held(&w, &user).await?;
            let (r, ms) = timed(
                user.call(w.market.id(), "redeem")
                    .args_json(json!({ "market_id": r_id.to_string() }))
                    .gas(Gas::from_tgas(300)),
            )
            .await?;
            row(
                "redeem",
                &format!("{id_len} / {h}"),
                burnt_on(&r, w.market.id()),
                tg(r.total_gas_burnt),
                ms,
                "",
            );
            r.into_result()?;
            println!("-- done {tag}, {:.0}s", started.elapsed().as_secs_f64());
        }
    }
    println!("total run time {:.0}s", started.elapsed().as_secs_f64());
    Ok(())
}

async fn intents_call_gas(
    w: &World,
    from: &near_workspaces::Account,
    to: &AccountId,
    amount: u128,
    msg: &str,
    tgas: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(from
        .call(w.verifier.id(), "mt_transfer_call")
        .args_json(json!({ "receiver_id": to, "token_id": token_id(w), "amount": amount.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

#[tokio::test]
#[ignore]
async fn verifier_gas_floors_for_buy_and_seed() -> anyhow::Result<()> {
    let w = setup().await?;
    let needed = 40 * SEED_AMOUNT;
    mint(&w, w.owner.id(), needed).await?;
    deposit_to_intents(&w, &w.owner, w.owner.id(), needed).await?;
    deposit_to_intents(&w, &w.alice, w.alice.id(), 100 * USD).await?;
    let trading = create_seeded_market(&w, 3_600).await?;

    println!("\n| what | attached TGas | landed? | market receipt TGas | whole tx TGas | notes |");
    println!("|---|---|---|---|---|---|");
    for tgas in ATTACHED_TRIES {
        let before = shares(&w, trading, w.alice.id()).await.0;
        let r = intents_call_gas(
            &w,
            &w.alice,
            w.market.id(),
            TRADE,
            &format!("buy:{trading}:yes:1"),
            tgas,
        )
        .await?;
        let landed = shares(&w, trading, w.alice.id()).await.0 > before;
        println!(
            "| buy via mt_transfer_call | {tgas} | {landed} | {:.2} | {:.2} | tx ok: {} |",
            burnt_on(&r, w.market.id()),
            tg(r.total_gas_burnt),
            r.is_success()
        );
    }
    for (label, price) in [
        ("seed at one half", None),
        ("seed off-middle (seeder holds shares)", Some(SEED_PRICE)),
    ] {
        for tgas in ATTACHED_TRIES {
            let id = create_market(&w, 3_600, 3_600).await?;
            let r = intents_call_gas(
                &w,
                &w.owner,
                w.market.id(),
                SEED_AMOUNT,
                &match price {
                    Some(p) => format!("seed:{id}:{p}"),
                    None => format!("seed:{id}"),
                },
                tgas,
            )
            .await?;
            let landed = market_json(&w, id).await["seeded"] == true;
            println!(
                "| {label} via mt_transfer_call | {tgas} | {landed} | {:.2} | {:.2} | tx ok: {} |",
                burnt_on(&r, w.market.id()),
                tg(r.total_gas_burnt),
                r.is_success()
            );
        }
    }

    // The gas the verifier hands the receiver, read from a receiver that records its prepaid gas.
    let recv = w.worker.dev_deploy(&wasm("mock_mt_receiver")).await?;
    println!("\n| attached TGas | prepaid gas the receiver saw (TGas) | attached minus seen (TGas) |");
    println!("|---|---|---|");
    let mut seen_before = 0;
    for tgas in ATTACHED_TRIES {
        let r = intents_call_gas(&w, &w.alice, recv.id(), 1, "keep", tgas).await?;
        let seen: Vec<Value> = recv.view("notifications").await?.json()?;
        if seen.len() > seen_before {
            let gas = seen[seen.len() - 1]["prepaid_gas"].as_u64().unwrap_or(0) as f64 / 1e12;
            println!("| {tgas} | {gas:.2} | {:.2} |", tgas as f64 - gas);
        } else {
            println!("| {tgas} | receiver never called | tx ok: {} |", r.is_success());
        }
        seen_before = seen.len();
    }
    Ok(())
}

fn max_text(len: usize) -> String {
    "x".repeat(len)
}

#[tokio::test]
#[ignore]
async fn cost_of_rewriting_one_market_record() -> anyhow::Result<()> {
    let w = setup().await?;
    let needed = 5 * SEED_AMOUNT;
    mint(&w, w.owner.id(), needed).await?;
    deposit_to_intents(&w, &w.owner, w.owner.id(), needed).await?;
    deposit_to_intents(&w, &w.alice, w.alice.id(), 20 * USD).await?;
    ft_call(&w, &w.bob, w.market.id(), 150 * USD, "deposit").await?;
    let small = create_seeded_market(&w, THIRTY_DAYS_SECS).await?;
    let close_at = now(&w.worker).await + THIRTY_DAYS_SECS * 1_000_000_000;
    let big: String = w
        .owner
        .call(w.market.id(), "create_market")
        .deposit(near_workspaces::types::NearToken::from_millinear(60))
        .args_json(json!({
            "title": max_text(200), "rule_text": max_text(2000), "resolution_source": max_text(300), "void_policy": max_text(500),
            "category": "w".repeat(32), "subcategory": "s".repeat(32),
            "close_at": close_at.to_string(), "resolve_by": (close_at + 3_600 * 1_000_000_000).to_string()
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let big: u64 = big.parse()?;
    seed_batch(&w, big, 1, None).await?;
    let trades = 130;
    for i in 0..trades {
        let side = if i % 2 == 0 { "yes" } else { "no" };
        w.bob
            .call(w.market.id(), "buy")
            .args_json(
                json!({ "market_id": big.to_string(), "side": side, "amount": USD.to_string(), "min_shares": "1" }),
            )
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
    }
    let history: Vec<Value> = w
        .market
        .view("get_history")
        .args_json(json!({ "market_id": big.to_string() }))
        .await?
        .json()?;
    println!("history points on the big market: {}", history.len());
    println!("\n| what | market | market receipt TGas | whole tx TGas | notes |");
    println!("|---|---|---|---|---|");
    let mut halts = vec![];
    for (label, id) in [
        ("typical text, 1 history point", small),
        ("big (maximum text, 120 history points)", big),
    ] {
        for round in 0..2 {
            for method in ["halt", "resume"] {
                let args = if method == "halt" {
                    json!({ "market_id": id.to_string(), "reason": "measure" })
                } else {
                    json!({ "market_id": id.to_string() })
                };
                let r = w
                    .owner
                    .call(w.market.id(), method)
                    .args_json(args)
                    .gas(Gas::from_tgas(300))
                    .transact()
                    .await?;
                let (m, t) = (burnt_on(&r, w.market.id()), tg(r.total_gas_burnt));
                r.into_result()?;
                println!("| {method} {label} | round {round} | {m:.2} | {t:.2} | |");
                if id == big {
                    halts.push(m);
                }
            }
        }
    }
    let r = w
        .owner
        .call(w.market.id(), "set_paused")
        .args_json(json!({ "paused": false }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let base = burnt_on(&r, w.market.id());
    r.into_result()?;
    println!(
        "| set_paused(false), no market record | n/a | {base:.2} | | baseline for a call that touches no record |"
    );
    let per = halts.iter().sum::<f64>() / halts.len() as f64;
    println!("average rewrite of the big record (halt and resume): {per:.2} TGas");
    println!("rewrites in 300 TGas, whole call cost: {:.0}", 300.0 / per);
    println!(
        "rewrites in 300 TGas, taking the baseline off each: {:.0}",
        300.0 / (per - base)
    );
    Ok(())
}
