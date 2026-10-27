// Storage bytes per record, read from the contract account's storage_usage before and after. Heavy, so it is ignored by default:
//   cargo test -p tests --test scale_storage -- --ignored --nocapture --test-threads=1
// A byte of storage locks 1e19 yoctoNEAR (the sandbox's storage_amount_per_byte), so 100,000 bytes lock 1 NEAR.
mod common;
use common::*;
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

const THIRTY_DAYS_SECS: u64 = 30 * 24 * 3_600;
const NEAR_PER_BYTE: f64 = 1e-5;
const TRADES: usize = 130;
const PRE_TRADES: usize = 2;
const HISTORY_POINTS: i64 = 120;
const POSITION_STEPS: [usize; 3] = [1, 20, 30];
const POSITION_POOL: u64 = 30;
const SEED_AMOUNT: u128 = 3 * USD;
const CLOSE_SECS: u64 = 100;
const PAST_CLOSE_SECS: u64 = 130;
const LONG_EVIDENCE: usize = 512;

fn row(what: &str, bytes: i64, estimate: &str, note: &str) {
    println!(
        "| {what} | {bytes} | {:.5} | {estimate} | {note} |",
        bytes as f64 * NEAR_PER_BYTE
    );
}

async fn used(w: &World, who: &AccountId) -> anyhow::Result<i64> {
    Ok(storage_used(w, who).await? as i64)
}

fn typical_args(close_at: u64, gap_secs: u64) -> Value {
    json!({
        "title": "Will the test question resolve Yes?",
        "rule_text": "Resolves Yes if the test says so.",
        "resolution_source": "https://example.com/source",
        "void_policy": "Void if the test is cancelled.",
        "category": "world", "subcategory": "science",
        "close_at": close_at.to_string(), "resolve_by": (close_at + gap_secs * 1_000_000_000).to_string()
    })
}

fn minimum_args(close_at: u64) -> Value {
    json!({
        "title": "a", "rule_text": "a", "resolution_source": "a", "void_policy": "a",
        "category": "a", "subcategory": "a",
        "close_at": close_at.to_string(), "resolve_by": (close_at + 3_600 * 1_000_000_000).to_string()
    })
}

fn maximum_args(close_at: u64) -> Value {
    json!({
        "title": "x".repeat(200), "rule_text": "x".repeat(2000), "resolution_source": "x".repeat(300), "void_policy": "x".repeat(500),
        "category": "w".repeat(32), "subcategory": "s".repeat(32),
        "close_at": close_at.to_string(), "resolve_by": (close_at + 3_600 * 1_000_000_000).to_string()
    })
}

// Creates a market and returns its id with the change in the market's and the oracle's storage.
async fn create_measured(w: &World, args: Value) -> anyhow::Result<(u64, i64, i64)> {
    let (market_before, oracle_before) = (used(w, w.market.id()).await?, used(w, w.oracle.id()).await?);
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .deposit(near_workspaces::types::NearToken::from_millinear(60))
        .args_json(args)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    assert_eq!(market_json(w, id).await["registered"], true);
    Ok((
        id,
        used(w, w.market.id()).await? - market_before,
        used(w, w.oracle.id()).await? - oracle_before,
    ))
}

// Seeds at one half from the owner's Intents balance and returns the market's change in storage.
async fn seed_measured(w: &World, id: u64) -> anyhow::Result<i64> {
    let before = used(w, w.market.id()).await?;
    intents_call(w, &w.owner, w.market.id(), SEED_AMOUNT, &format!("seed:{id}"))
        .await?
        .into_result()?;
    assert_eq!(market_json(w, id).await["seeded"], true);
    Ok(used(w, w.market.id()).await? - before)
}

async fn trade_from_balance(w: &World, who: &Account, id: u64, side: &str) -> anyhow::Result<()> {
    who.call(w.market.id(), "buy")
        .args_json(json!({ "market_id": id.to_string(), "side": side, "amount": USD.to_string(), "min_shares": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// The change in the market's storage from `PRE_TRADES` trades to `TRADES`, which only adds price history points.
async fn history_growth(w: &World, id: u64) -> anyhow::Result<(i64, i64)> {
    for i in 0..PRE_TRADES {
        trade_from_balance(w, &w.bob, id, if i % 2 == 0 { "yes" } else { "no" }).await?;
    }
    let before = used(w, w.market.id()).await?;
    let points_before: Vec<Value> = w
        .market
        .view("get_history")
        .args_json(json!({ "market_id": id.to_string() }))
        .await?
        .json()?;
    for i in PRE_TRADES..TRADES {
        trade_from_balance(w, &w.bob, id, if i % 2 == 0 { "yes" } else { "no" }).await?;
    }
    let points_after: Vec<Value> = w
        .market
        .view("get_history")
        .args_json(json!({ "market_id": id.to_string() }))
        .await?
        .json()?;
    assert_eq!(points_after.len() as i64, HISTORY_POINTS);
    Ok((
        used(w, w.market.id()).await? - before,
        points_after.len() as i64 - points_before.len() as i64,
    ))
}

#[tokio::test]
#[ignore]
async fn storage_bytes_per_record() -> anyhow::Result<()> {
    let w = setup().await?;
    let started = std::time::Instant::now();
    let base = used(&w, w.market.id()).await?;
    println!("market contract storage_usage at the start: {base} B; 1 NEAR locks 100,000 B");
    mint(&w, w.owner.id(), 300 * SEED_AMOUNT).await?;
    deposit_to_intents(&w, &w.owner, w.owner.id(), 300 * SEED_AMOUNT).await?;
    mint(&w, w.bob.id(), 600 * USD).await?;
    ft_call(&w, &w.bob, w.market.id(), 500 * USD, "deposit").await?;
    w.owner
        .call(w.market.id(), "set_max_positions")
        .args_json(json!({ "max_positions": 30 }))
        .transact()
        .await?
        .into_result()?;

    println!("\n| what | bytes | NEAR locked | estimate to compare | notes |");
    println!("|---|---|---|---|---|");
    // Warm up: the first market and the first account entries can grow the state's own bookkeeping.
    let warm = now(&w.worker).await + THIRTY_DAYS_SECS * 1_000_000_000;
    let (warm_id, _, _) = create_measured(&w, typical_args(warm, 3_600)).await?;
    seed_measured(&w, warm_id).await?;

    let close = now(&w.worker).await + THIRTY_DAYS_SECS * 1_000_000_000;
    let (min_id, min_market, min_oracle) = create_measured(&w, minimum_args(close)).await?;
    row(
        "create_market, minimum text (market record)",
        min_market,
        "-",
        "every text field one character",
    );
    row(
        "create_market, minimum text (oracle market registration)",
        min_oracle,
        "about 180",
        "the oracle's info for the market",
    );
    let min_seed = seed_measured(&w, min_id).await?;
    row(
        "seed of the minimum market (record update, first history point)",
        min_seed,
        "-",
        "seeded at one half",
    );

    let (typ_id, typ_market, typ_oracle) = create_measured(&w, typical_args(close, 3_600)).await?;
    row(
        "create_market, typical text (market record)",
        typ_market,
        "-",
        "titles and rules about 30 characters",
    );
    row(
        "create_market, typical text (oracle registration)",
        typ_oracle,
        "about 180",
        "",
    );
    let typ_seed = seed_measured(&w, typ_id).await?;
    row("seed of the typical market", typ_seed, "-", "");
    let (typ_growth, typ_points) = history_growth(&w, typ_id).await?;
    let per_point = typ_growth as f64 / typ_points as f64;
    row(
        &format!("typical market, history grown by {typ_points} points ({PRE_TRADES} to {TRADES} trades)"),
        typ_growth,
        "-",
        &format!("{per_point:.1} bytes per history point"),
    );
    let typ_total = typ_market + typ_seed + typ_growth + (PRE_TRADES as f64 * per_point) as i64;
    row(
        "typical market record after 120 trades (create + seed + history, computed)",
        typ_total,
        "about 2800",
        "market record only, not the trader's entries",
    );

    let (max_id, max_market, max_oracle) = create_measured(&w, maximum_args(close)).await?;
    row(
        "create_market, maximum text (market record)",
        max_market,
        "-",
        "title 200, rule 2000, source 300, void 500",
    );
    row(
        "create_market, maximum text (oracle registration)",
        max_oracle,
        "about 180",
        "",
    );
    let max_seed = seed_measured(&w, max_id).await?;
    let (max_growth, max_points) = history_growth(&w, max_id).await?;
    let max_per_point = max_growth as f64 / max_points as f64;
    row(
        "maximum market, history grown (same trades)",
        max_growth,
        "-",
        &format!("{max_per_point:.1} bytes per history point"),
    );
    let max_total = max_market + max_seed + max_growth + (PRE_TRADES as f64 * max_per_point) as i64;
    row(
        "maximum market record after 120 trades (create + seed + history, computed)",
        max_total,
        "about 4900",
        "market record only",
    );
    let min_total = min_market + min_seed + max_growth + (PRE_TRADES as f64 * max_per_point) as i64;
    row(
        "minimum market record with a full 120-point history (computed)",
        min_total,
        "-",
        "measured minimum create and seed, plus the measured history growth",
    );

    // Sweep: the fees collected so far are over the minimum, so one sweep goes out.
    past_sweep_interval(&w).await;
    let (market_before, council_before) = (used(&w, w.market.id()).await?, used(&w, w.council.id()).await?);
    sweep(&w, &w.carol).await?;
    row(
        "one sweep (market's sweep record and counters)",
        used(&w, w.market.id()).await? - market_before,
        "about 205",
        "after both legs settled",
    );
    row(
        "the Council's record of the revenue that sweep sent",
        used(&w, w.council.id()).await? - council_before,
        "-",
        "received entry and the quarter's book",
    );

    // Accounts: a storage deposit, a credited balance, then positions. Each buy also adds a history point to its market, so the
    // growth of that is taken off to leave what the account itself costs.
    let pool_first = bulk_seeded_markets(&w, POSITION_POOL, None).await?;
    for id_len in [20usize, 64] {
        let user = account_with_id_len(&w, id_len, &format!("s{id_len}")).await?;
        mint(&w, user.id(), 400 * USD).await?;
        let before = used(&w, w.market.id()).await?;
        user.call(w.market.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(50))
            .transact()
            .await?
            .into_result()?;
        let registered = used(&w, w.market.id()).await? - before;
        row(
            &format!("storage_deposit, {id_len}-character id"),
            registered,
            "-",
            "the accounts entry",
        );
        ft_call(&w, &user, w.market.id(), 200 * USD, "deposit").await?;
        let funded = used(&w, w.market.id()).await? - before;
        row(
            &format!("  plus a credited balance, {id_len}-character id"),
            funded,
            "-",
            "cumulative from before the storage deposit",
        );
        let mut held = 0usize;
        for target in POSITION_STEPS {
            let ids: Vec<u64> = (held..target).map(|i| pool_first + i as u64).collect();
            for chunk in ids.chunks(10) {
                let mut batch = user.batch(w.market.id());
                for id in chunk {
                    batch = batch.call(
                        Function::new("buy")
                            .args_json(json!({ "market_id": id.to_string(), "side": "yes", "amount": USD.to_string(), "min_shares": "1" }))
                            .deposit(NearToken::from_yoctonear(1))
                            .gas(Gas::from_tgas(28)),
                    );
                }
                batch.transact().await?.into_result()?;
            }
            held = target;
            let raw = used(&w, w.market.id()).await? - before;
            let account_only = raw - (held as f64 * per_point) as i64;
            row(
                &format!("{id_len}-character id, {held} positions held (cumulative, history growth taken off)"),
                account_only,
                if id_len == 20 {
                    "20 positions: 2300 to 3200"
                } else {
                    "-"
                },
                &format!(
                    "raw storage_usage change {raw} B, about {:.0} B per position beyond the first deposit",
                    (account_only - funded) as f64 / held as f64
                ),
            );
        }
    }

    // Oracle cases. Three markets close soon after they are made.
    let short_a = create_market(&w, CLOSE_SECS, 3_600).await?;
    let long_b = create_market(&w, CLOSE_SECS, 3_600).await?;
    let disputed = create_market(&w, CLOSE_SECS, 3_600).await?;
    skip_secs(&w.worker, PAST_CLOSE_SECS).await;
    let before = used(&w, w.oracle.id()).await?;
    propose(&w, &w.carol, short_a, "yes").await?;
    row(
        "undisputed case, propose with a 32-character evidence link",
        used(&w, w.oracle.id()).await? - before,
        "about 300",
        "case record and the bond's bookkeeping",
    );
    let before = used(&w, w.oracle.id()).await?;
    ft_call(
        &w,
        &w.carol,
        w.oracle.id(),
        BOND,
        &format!("propose:{}:{long_b}:yes:{}", w.market.id(), "e".repeat(LONG_EVIDENCE)),
    )
    .await?;
    row(
        "undisputed case, propose with 512 bytes of evidence",
        used(&w, w.oracle.id()).await? - before,
        "about 300 plus 480",
        "",
    );
    propose(&w, &w.dave, disputed, "yes").await?;
    let before = used(&w, w.oracle.id()).await?;
    challenge(&w, &w.bob, disputed).await?;
    row(
        "challenge added to a case",
        used(&w, w.oracle.id()).await? - before,
        "-",
        "challenger, answer, round fields",
    );
    let before = used(&w, w.oracle.id()).await?;
    let jury = draw_jury(&w, disputed).await?;
    row(
        &format!("jury of {} drawn for the case", jury.len()),
        used(&w, w.oracle.id()).await? - before,
        "-",
        "panel list; the two-round dispute with 11 and 21 jurors was not built: it needs 21 more staked seats and four time skips",
    );

    // The Council: seat weight entry, then a claim.
    skip_secs(&w.worker, 3_600).await;
    let before = used(&w, w.council.id()).await?;
    w.bob
        .call(w.council.id(), "book_seat_time")
        .args_json(json!({ "token_id": w.jurors[1].id() }))
        .transact()
        .await?
        .into_result()?;
    row(
        "book_seat_time for one seat (one seat_weight entry, stake updated)",
        used(&w, w.council.id()).await? - before,
        "-",
        "one quarter covered",
    );
    let aged = age_current_quarter(&w).await?;
    finalize_quarter(&w, aged).await?;
    let before = used(&w, w.council.id()).await?;
    let juror = &w.jurors[0];
    claim_quarter(&w, juror, aged, juror.id().as_str()).await?;
    row(
        "one Council claim (claim record, after the payout callback)",
        used(&w, w.council.id()).await? - before,
        "-",
        "the seat_weight entry was written earlier by book_seat_time",
    );
    println!("total run time {:.0}s", started.elapsed().as_secs_f64());
    Ok(())
}
