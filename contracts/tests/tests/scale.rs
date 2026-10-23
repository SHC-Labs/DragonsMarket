// How much the read views cost as the number of markets grows. Heavy, so it is ignored by default:
//   SCALE_MARKETS=300 cargo test -p tests --test scale -- --ignored --nocapture --test-threads=1
// SCALE_MARKETS is the market count for the main table (default 300). From 300 up, the test then adds markets up to
// the sizes in STEP_SIZES and measures get_positions again, to show its gas does not grow with the number of markets. It
// stops early when SCALE_LIMIT_MINUTES (default 20) would be passed.
//
// Gas: a view method can also be sent as an ordinary transaction, and the outcome reports the gas it burnt. Every view is
// measured both ways: wall-clock time as a view call, gas as a transaction from an ordinary account with 300 TGas attached.
// The gas figure includes the fixed cost of a transaction, which total_owed (a view that only reads counters) shows. The RPC
// view limit is about 200 TGas. The sandbox does not enforce that limit on view calls (it served get_positions at 2400
// markets before get_positions kept a list of an account's markets), so a view reported ok here is not proof it fits; the
// gas column is.
mod common;
use common::*;
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};
use std::time::Instant;

const DEFAULT_MARKETS: u64 = 300;
const STEP_SIZES: [u64; 2] = [600, 1_200];
const FLAT_TOLERANCE: f64 = 0.10;
const ENTITLEMENT_LIMIT_TGAS: f64 = 100.0;
const ENTITLEMENT_CAP: u32 = 25;
const ENTITLEMENT_ASKED: u32 = 50;
const VIEW_LIMIT_TGAS: f64 = 200.0;
const CHEAP_LIMIT_TGAS: f64 = 20.0;
const TX_LIMIT_TGAS: u64 = 300;
const CREATE_GAS_TRIES: [u64; 6] = [30, 40, 50, 60, 70, 100];
const THIRTY_DAYS_SECS: u64 = 30 * 24 * 3_600;
const CASE_CLOSE_SECS: u64 = 300;
const RESOLVE_GAP_SECS: u64 = 3_600;
const PAGE: u64 = 50;
const HEAVY_MARKETS: u64 = 50;
const HISTORY_CAP: usize = 120;
const SEAT_HOLDERS: usize = 10;
const SEATS_EACH: usize = 10;
const CHALLENGED_CASES: u64 = 3;
const BIG_LIMIT: u32 = 10_000;

struct Row {
    view: String,
    n: u64,
    ok: bool,
    ms: u128,
    gas: Option<f64>,
    note: String,
}

struct Table(Vec<Row>);

fn tgas(g: Gas) -> f64 {
    g.as_gas() as f64 / 1e12
}

// Sends a view method as a transaction and returns the gas burnt, in TGas.
async fn burn(w: &World, contract: &Contract, method: &str, args: &Value) -> Result<f64, String> {
    let outcome = w
        .carol
        .call(contract.id(), method)
        .args_json(args.clone())
        .gas(Gas::from_tgas(TX_LIMIT_TGAS))
        .transact()
        .await
        .map_err(|e| format!("{e:?}"))?;
    let burnt = outcome.total_gas_burnt;
    outcome
        .into_result()
        .map(|_| tgas(burnt))
        .map_err(|e| e.to_string().chars().take(120).collect())
}

impl Table {
    // Calls a view and then sends it as a transaction. Never panics. A result that fails `check` counts as failed.
    #[allow(clippy::too_many_arguments)]
    async fn view(
        &mut self,
        w: &World,
        label: &str,
        n: u64,
        contract: &Contract,
        method: &str,
        args: Value,
        check: impl Fn(&Value) -> Result<(), String>,
    ) -> Option<f64> {
        let start = Instant::now();
        let result = contract.view(method).args_json(args.clone()).await;
        let ms = start.elapsed().as_millis();
        let (ok, mut note) = match result {
            Ok(r) => match r.json::<Value>() {
                Ok(v) => match check(&v) {
                    Ok(()) => (true, String::new()),
                    Err(e) => (false, e),
                },
                Err(e) => (false, format!("bad json: {e}")),
            },
            Err(e) => (false, format!("{e:?}").chars().take(160).collect()),
        };
        let gas = match burn(w, contract, method, &args).await {
            Ok(g) => Some(g),
            Err(e) => {
                note = format!("{note} as transaction: {e}");
                None
            }
        };
        self.0.push(Row {
            view: label.to_string(),
            n,
            ok,
            ms,
            gas,
            note,
        });
        gas
    }

    fn row(&self, view: &str) -> Vec<&Row> {
        self.0.iter().filter(|r| r.view == view).collect()
    }

    fn print(&self) {
        println!(
            "\n{:<44} {:>6} {:>7} {:>16} {:>7}  note",
            "view", "N", "result", "gas", "ms"
        );
        for r in &self.0 {
            let gas = r
                .gas
                .map_or("n/a".to_string(), |g| format!("{g:.1} of {VIEW_LIMIT_TGAS:.0} TGas"));
            println!(
                "{:<44} {:>6} {:>7} {:>16} {:>7}  {}",
                r.view,
                r.n,
                if r.ok { "ok" } else { "failed" },
                gas,
                r.ms,
                r.note
            );
        }
    }
}

fn any(_: &Value) -> Result<(), String> {
    Ok(())
}

fn len_is(n: usize) -> impl Fn(&Value) -> Result<(), String> {
    move |v| match v.as_array().map(Vec::len) {
        Some(got) if got == n => Ok(()),
        got => Err(format!("expected {n} entries, got {got:?}")),
    }
}

fn create_args(index: u64, close_at: u64) -> Value {
    json!({
        "title": format!("Scale market number {index}"),
        "rule_text": "Resolves Yes if the test says so.",
        "resolution_source": "https://example.com/source",
        "void_policy": "Void if the test is cancelled.",
        "category": "world",
        "subcategory": "science",
        "close_at": close_at.to_string(),
        "resolve_by": (close_at + RESOLVE_GAP_SECS * 1_000_000_000).to_string()
    })
}

async fn close_after(w: &World, secs: u64) -> u64 {
    now(&w.worker).await + secs * 1_000_000_000
}

// One create_market as its own transaction with `gas_tgas` attached. Returns the gas burnt in all (the oracle registration
// included) when it went through.
async fn create_single(w: &World, index: u64, close_at: u64, gas_tgas: u64) -> anyhow::Result<Option<f64>> {
    let outcome = w
        .owner
        .call(w.market.id(), "create_market")
        .args_json(create_args(index, close_at))
        .gas(Gas::from_tgas(gas_tgas))
        .transact()
        .await?;
    let burnt = tgas(outcome.total_gas_burnt);
    Ok(outcome.into_result().ok().map(|_| burnt))
}

// Creates `count` markets in as few transactions as gas allows, `per_call` TGas attached to each. A batch that fails is
// retried at half the size.
async fn create_many(
    w: &World,
    first_index: u64,
    count: u64,
    close_in_secs: u64,
    per_call: u64,
    batch_size: &mut usize,
) -> anyhow::Result<()> {
    let mut made = 0;
    while made < count {
        let take = (*batch_size as u64).min(count - made) as usize;
        let close_at = close_after(w, close_in_secs).await;
        let mut batch = w.owner.batch(w.market.id());
        for i in 0..take as u64 {
            batch = batch.call(
                Function::new("create_market")
                    .args_json(create_args(first_index + made + i, close_at))
                    .gas(Gas::from_tgas(per_call)),
            );
        }
        match batch.transact().await?.into_result() {
            Ok(_) => made += take as u64,
            Err(e) if take > 1 => {
                println!(
                    "batch of {take} did not fit ({}), halving",
                    e.to_string().chars().take(100).collect::<String>()
                );
                *batch_size = take / 2;
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

// An account with the token, a market storage deposit and no positions.
async fn fresh_trader(w: &World, usd: u128) -> anyhow::Result<Account> {
    let who = w.worker.dev_create_account().await?;
    who.call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    mint(w, who.id(), usd * USD).await?;
    Ok(who)
}

// A seeded market that closes in 30 days. Returns its id.
async fn seeded_market(w: &World) -> anyhow::Result<u64> {
    create_seeded_market_gap(w, THIRTY_DAYS_SECS, RESOLVE_GAP_SECS).await
}

// Returns the get_positions gas.
async fn account_views(t: &mut Table, w: &World, n: u64, who: &Account, positions: usize) -> Option<f64> {
    let args = json!({ "account_id": who.id() });
    let gas = t
        .view(
            w,
            &format!("market.get_positions ({positions} held)"),
            n,
            &w.market,
            "get_positions",
            args.clone(),
            len_is(positions),
        )
        .await;
    t.view(
        w,
        &format!("market.get_account ({positions} held)"),
        n,
        &w.market,
        "get_account",
        args,
        |v| {
            if v["positions"] == positions as u64 {
                Ok(())
            } else {
                Err(format!("positions was {}", v["positions"]))
            }
        },
    )
    .await;
    gas
}

#[tokio::test]
#[ignore]
async fn views_keep_working_as_markets_pile_up() -> anyhow::Result<()> {
    let started = Instant::now();
    let target: u64 = std::env::var("SCALE_MARKETS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MARKETS);
    let limit_minutes: u64 = std::env::var("SCALE_LIMIT_MINUTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);
    let w = setup().await?;
    let held: u64 = config(&w.market).await["max_positions"]
        .as_u64()
        .expect("max_positions");
    assert!(
        target >= HEAVY_MARKETS + 10,
        "SCALE_MARKETS must be at least {}",
        HEAVY_MARKETS + 10
    );
    mint(&w, w.owner.id(), (HEAVY_MARKETS + 10) as u128 * SEED).await?;
    mint(&w, w.carol.id(), 300 * USD).await?;

    // Markets 0..cases close soon and get real cases. The rest are bare until the last HEAVY_MARKETS, which are seeded and
    // traded (alice holds a position in each of the newest `held`).
    let bulk = target - HEAVY_MARKETS;
    let cases = bulk.min(PAGE);
    let create_start = Instant::now();
    let mut created = 0;
    let mut one_call = None;
    let mut min_attached = None;
    for tries in CREATE_GAS_TRIES {
        let close_at = close_after(&w, CASE_CLOSE_SECS).await;
        match create_single(&w, created, close_at, tries).await? {
            Some(burnt) => {
                created += 1;
                one_call = Some(burnt);
                min_attached = Some(tries);
                break;
            }
            None => println!("create_market with {tries} TGas attached ran out of gas"),
        }
    }
    let (burnt, attached) = one_call.zip(min_attached).expect("create_market never fit in 100 TGas");
    let per_call = attached + 5;
    let mut batch_size = (TX_LIMIT_TGAS / per_call) as usize;
    println!(
        "create_market burnt {burnt:.1} TGas in all; the least that was enough to attach is {attached} TGas of the sizes tried {CREATE_GAS_TRIES:?}"
    );
    println!("batching {batch_size} calls of {per_call} TGas in one transaction");
    create_many(&w, created, cases - created, CASE_CLOSE_SECS, per_call, &mut batch_size).await?;
    create_many(&w, cases, bulk - cases, THIRTY_DAYS_SECS, per_call, &mut batch_size).await?;
    let bulk_secs = create_start.elapsed().as_secs_f64();
    println!(
        "created {bulk} unseeded markets in {bulk_secs:.0}s ({:.2}/s), largest batch that went through: {batch_size}",
        bulk as f64 / bulk_secs.max(0.001)
    );
    let rate = bulk as f64 / bulk_secs.max(0.001);

    for i in 0..HEAVY_MARKETS {
        let id = seeded_market(&w).await?;
        if i >= HEAVY_MARKETS - held {
            buy(&w, &w.alice, id, "yes", USD).await?;
        } else {
            buy(&w, &w.owner, id, "yes", USD).await?;
        }
    }
    let n = target;
    println!(
        "{n} markets after {:.0}s, alice holds {held} positions in the newest {held}",
        started.elapsed().as_secs_f64()
    );
    assert_eq!(market_json(&w, n - 1).await["registered"], true);

    // Fill the newest market's price history to its cap.
    let history_market = n - 1;
    let trades = HISTORY_CAP + 10;
    deposit_to_intents(&w, &w.bob, w.bob.id(), trades as u128 * USD).await?;
    for i in 0..trades {
        let side = if i % 2 == 0 { "yes" } else { "no" };
        intents_call(
            &w,
            &w.bob,
            w.market.id(),
            USD,
            &format!("buy:{history_market}:{side}:1"),
        )
        .await?
        .into_result()?;
    }

    // Seats: SEAT_HOLDERS accounts with SEATS_EACH staked tokens each, besides the jurors.
    let mut holder = None;
    for h in 0..SEAT_HOLDERS {
        let who = w.worker.dev_create_account().await?;
        for s in 0..SEATS_EACH {
            let token = format!("scale-{h}-{s}");
            mint_nft(&w, &who, &token).await?;
            stake(&w, &who, &token).await?;
        }
        holder.get_or_insert(who);
    }
    let holder = holder.expect("a seat holder");
    let seats = SEAT_HOLDERS * SEATS_EACH + w.jurors.len();

    // Real cases: the close time passes, then each case market gets a proposal, and a few get a challenge.
    skip_secs(&w.worker, CASE_CLOSE_SECS + 60).await;
    for id in 0..cases {
        propose(&w, &w.carol, id, "yes").await?;
    }
    let challenged = cases.min(CHALLENGED_CASES);
    for id in 0..challenged {
        challenge(&w, &w.bob, id).await?;
    }
    println!(
        "{cases} cases proposed ({challenged} challenged), history filled, {seats} seats staked, after {:.0}s",
        started.elapsed().as_secs_f64()
    );

    let mut t = Table(Vec::new());
    let none = json!({});
    let page = |from: u64| json!({ "from_index": from.to_string(), "limit": PAGE.to_string() });
    t.view(
        &w,
        "market.list_markets (50, bare, start)",
        n,
        &w.market,
        "list_markets",
        page(0),
        len_is(50.min(n) as usize),
    )
    .await;
    t.view(
        &w,
        "market.list_markets (50, traded, end)",
        n,
        &w.market,
        "list_markets",
        page(n - PAGE),
        len_is(PAGE as usize),
    )
    .await;
    account_views(&mut t, &w, n, &w.alice, held as usize).await;
    t.view(
        &w,
        "market.owed_breakdown",
        n,
        &w.market,
        "owed_breakdown",
        none.clone(),
        any,
    )
    .await;
    t.view(&w, "market.in_flight", n, &w.market, "in_flight", none.clone(), any)
        .await;
    t.view(&w, "market.total_owed", n, &w.market, "total_owed", none.clone(), any)
        .await;
    t.view(&w, "market.list_sweeps (50)", n, &w.market, "list_sweeps", page(0), any)
        .await;
    t.view(
        &w,
        &format!("market.get_history ({HISTORY_CAP} points)"),
        n,
        &w.market,
        "get_history",
        json!({ "market_id": history_market.to_string() }),
        len_is(HISTORY_CAP),
    )
    .await;

    t.view(
        &w,
        &format!("oracle.list_cases (50, {cases} cases)"),
        n,
        &w.oracle,
        "list_cases",
        json!({ "market": w.market.id(), "from_market_id": "0", "limit": PAGE }),
        len_is(cases as usize),
    )
    .await;
    let pages_start = Instant::now();
    let mut pages_ok = true;
    let mut worst_page: f64 = 0.0;
    for from in (0..n).step_by(PAGE as usize) {
        match burn(
            &w,
            &w.oracle,
            "list_cases",
            &json!({ "market": w.market.id(), "from_market_id": from.to_string(), "limit": PAGE }),
        )
        .await
        {
            Ok(g) => worst_page = worst_page.max(g),
            Err(e) => {
                pages_ok = false;
                println!("list_cases page from {from} failed: {e}");
            }
        }
    }
    t.0.push(Row {
        view: format!("oracle.list_cases (all {} pages)", n.div_ceil(PAGE)),
        n,
        ok: pages_ok,
        ms: pages_start.elapsed().as_millis(),
        gas: Some(worst_page),
        note: "gas is the worst page; ms includes the transactions".to_string(),
    });
    t.view(&w, "oracle.bond_totals", n, &w.oracle, "bond_totals", none.clone(), any)
        .await;
    t.view(&w, "oracle.total_owed", n, &w.oracle, "total_owed", none.clone(), any)
        .await;

    t.view(
        &w,
        "council.list_quarters (50)",
        n,
        &w.council,
        "list_quarters",
        json!({ "from_quarter": 0, "limit": 50 }),
        any,
    )
    .await;
    t.view(&w, "council.reward_totals", n, &w.council, "reward_totals", none, any)
        .await;
    for (asked, label) in [
        (
            ENTITLEMENT_CAP,
            format!("council.entitlements_of ({ENTITLEMENT_CAP}, {SEATS_EACH} seats)"),
        ),
        (
            ENTITLEMENT_ASKED,
            format!("council.entitlements_of ({ENTITLEMENT_ASKED} asked, clamped, {SEATS_EACH} seats)"),
        ),
    ] {
        t.view(
            &w,
            &label,
            n,
            &w.council,
            "entitlements_of",
            json!({ "account_id": holder.id(), "from_quarter": 0, "limit": asked }),
            any,
        )
        .await;
    }
    t.view(
        &w,
        &format!("council.staked_tokens ({seats} seats)"),
        n,
        &w.council,
        "staked_tokens",
        json!({ "from_index": 0, "limit": BIG_LIMIT }),
        len_is(seats),
    )
    .await;

    // Whether get_positions still depends on the number of markets. A fresh account holds one position in the newest market,
    // and alice holds her `held` positions in older ones; both are read at the target size and again after each step adds
    // markets. The sandbox accepts view calls that burn more than the 200 TGas a public RPC allows, so the verdict comes
    // from the gas column. A step whose transaction cannot carry 300 TGas ends the pass.
    let mut reached = n;
    let mut stopped = String::new();
    let mut next_index = n;
    let mut newest = n - 1;
    let mut one_held = fresh_trader(&w, 200).await?;
    buy(&w, &one_held, newest, "yes", USD).await?;
    account_views(&mut t, &w, n, &one_held, 1).await;
    for size in STEP_SIZES.into_iter().filter(|&s| s > n) {
        let bulk = size - 1 - next_index;
        let estimate = bulk as f64 / rate + 30.0;
        if started.elapsed().as_secs_f64() + estimate > (limit_minutes * 60) as f64 {
            stopped =
                format!("stopped before {size} markets: the next step would pass the {limit_minutes} minute limit");
            break;
        }
        let step = Instant::now();
        if let Err(e) = create_many(&w, next_index, bulk, THIRTY_DAYS_SECS, per_call, &mut batch_size).await {
            stopped = format!(
                "market creation stopped before {size}: {}",
                e.to_string().chars().take(160).collect::<String>()
            );
            break;
        }
        one_held = fresh_trader(&w, 200).await?;
        newest = seeded_market(&w).await?;
        buy(&w, &one_held, newest, "yes", USD).await?;
        next_index = size;
        reached = size;
        println!("reached {size} markets, step took {:.0}s", step.elapsed().as_secs_f64());
        account_views(&mut t, &w, size, &one_held, 1).await;
        account_views(&mut t, &w, size, &w.alice, held as usize).await;
    }

    t.print();
    println!(
        "\ntotal run time: {:.0}s, markets reached: {reached}",
        started.elapsed().as_secs_f64()
    );
    if !stopped.is_empty() {
        println!("{stopped}");
    }

    for cheap in [
        "market.total_owed",
        "market.owed_breakdown",
        "market.in_flight",
        "oracle.bond_totals",
        "council.reward_totals",
    ] {
        for r in t.row(cheap) {
            assert!(r.ok, "{cheap} failed at N = {}: {}", r.n, r.note);
            let gas = r.gas.expect("gas");
            assert!(
                gas < CHEAP_LIMIT_TGAS,
                "{cheap} burnt {gas:.1} TGas at N = {}, expected under {CHEAP_LIMIT_TGAS}",
                r.n
            );
        }
    }
    for views in ["get_positions", "get_account"] {
        for positions in [1, held as usize] {
            let rows = t.row(&format!("market.{views} ({positions} held)"));
            for r in &rows {
                assert!(r.ok, "{views} ({positions} held) failed at N = {}: {}", r.n, r.note);
                let gas = r.gas.expect("gas");
                assert!(
                    gas < CHEAP_LIMIT_TGAS,
                    "{views} ({positions} held) burnt {gas:.1} TGas at N = {}, expected under {CHEAP_LIMIT_TGAS}",
                    r.n
                );
            }
            let (first, last) = (rows.first().expect("row"), rows.last().expect("row"));
            if last.n > first.n {
                let (g1, g2) = (first.gas.expect("gas"), last.gas.expect("gas"));
                assert!(
                    g2 <= g1 * (1.0 + FLAT_TOLERANCE),
                    "{views} ({positions} held) grew with the market count: {g1:.1} TGas at N = {}, {g2:.1} TGas at N = {}",
                    first.n,
                    last.n
                );
            }
        }
    }
    for r in t.0.iter().filter(|r| r.view.starts_with("council.entitlements_of")) {
        assert!(r.ok, "{} failed: {}", r.view, r.note);
        let gas = r.gas.expect("gas");
        assert!(
            gas < ENTITLEMENT_LIMIT_TGAS,
            "{} burnt {gas:.1} TGas, expected under {ENTITLEMENT_LIMIT_TGAS}",
            r.view
        );
    }
    Ok(())
}
