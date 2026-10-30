// Council gas at scale: the entitlement listing by number of staked tokens, and the jury draw by number of seats. Heavy, so both
// tests are ignored by default. Run one at a time:
//   cargo test -p tests --test scale_council <name> -- --ignored --nocapture --test-threads=1
mod common;
use common::*;
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::{json, Value};
use std::time::Instant;

const TOKEN_STEPS: [usize; 6] = [10, 25, 35, 40, 50, 100];
const QUARTERS: u32 = 25;
const LIMIT: u32 = 25;
const MINT_BATCH: usize = 25;
const MINT_PER_CALL: u64 = 10;
const BATCH_GAS: u64 = 280;
const SEAT_STEPS: [usize; 3] = [300, 600, 1_000];
const HOLDERS: usize = 45;
const JURY_FIRST: u32 = 11;
const JURY_SECOND: u32 = 21;
const DIRECT_CASE_BASE: u64 = 9_000_000;
const ORACLE_DRAW_ALLOWANCE_TGAS: f64 = 250.0;
const DRAW_LIMIT_TGAS: f64 = 275.0;
const CLOSE_SECS: u64 = 100;
const PAST_CLOSE_SECS: u64 = 130;
const LEAVE_BATCH: usize = 20;
const LEAVE_PER_CALL: u64 = 12;
const SEAT_WEIGHT_NS: u64 = 1_000_000_000;
const POOL: u128 = 1_000_000_000;
const WEIGHT_TOTAL: u128 = 1_000_000_000_000;
const SEAT_WEIGHT_KEY: u8 = 6;
const QUARTERS_KEY: u8 = 5;
const PATCH_CHUNK: usize = 500;

fn bstr(s: &str) -> Vec<u8> {
    let mut v = (s.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(s.as_bytes());
    v
}

// A finalized quarter: revenue_in, carry_in, seat_ns, forfeit_ns, finalized, pool, weight_total, rolled_to, paid, pending.
fn finalized_book() -> Vec<u8> {
    let mut b = vec![];
    b.extend(POOL.to_le_bytes());
    b.extend(0u128.to_le_bytes());
    b.extend(WEIGHT_TOTAL.to_le_bytes());
    b.extend(0u128.to_le_bytes());
    b.push(1);
    b.extend(POOL.to_le_bytes());
    b.extend(WEIGHT_TOTAL.to_le_bytes());
    b.push(0);
    b.extend(0u128.to_le_bytes());
    b.extend(0u128.to_le_bytes());
    b
}

async fn mint_many(w: &World, to: &Account, tokens: &[String]) -> anyhow::Result<()> {
    for chunk in tokens.chunks(MINT_BATCH) {
        let mut batch = w.owner.batch(w.nft.id());
        for t in chunk {
            batch = batch.call(
                Function::new("nft_mint")
                    .args_json(json!({ "token_id": t, "receiver_id": to.id() }))
                    .gas(Gas::from_tgas(MINT_PER_CALL)),
            );
        }
        batch.transact().await?.into_result()?;
    }
    Ok(())
}

// The gas one stake needs, learned from the first one, then the rest go in batches sized to fit 280 TGas.
async fn stake_many(w: &World, who: &Account, tokens: &[String], per_call: u64) -> anyhow::Result<()> {
    let at_a_time = (BATCH_GAS / per_call) as usize;
    for chunk in tokens.chunks(at_a_time) {
        let mut batch = who.batch(w.nft.id());
        for t in chunk {
            batch = batch.call(
                Function::new("nft_transfer_call")
                    .args_json(json!({ "receiver_id": w.council.id(), "token_id": t, "msg": "" }))
                    .deposit(NearToken::from_yoctonear(1))
                    .gas(Gas::from_tgas(per_call)),
            );
        }
        batch.transact().await?.into_result()?;
    }
    Ok(())
}

async fn seat_count(w: &World) -> anyhow::Result<usize> {
    Ok(w.council.view("seat_count").await?.json::<u32>()? as usize)
}

// Stakes the first token alone to learn what a stake burns, returns the per-action gas to use in batches.
async fn learn_stake_gas(w: &World, who: &Account, token: &str) -> anyhow::Result<u64> {
    let r = who
        .call(w.nft.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": w.council.id(), "token_id": token, "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let burnt = tg(r.total_gas_burnt);
    r.into_result()?;
    let per_call = (burnt * 1.5).ceil().max(30.0) as u64;
    println!("one stake burnt {burnt:.1} TGas; batches use {per_call} TGas an action");
    Ok(per_call)
}

#[tokio::test]
#[ignore]
async fn entitlements_of_gas_by_token_count() -> anyhow::Result<()> {
    let started = Instant::now();
    let w = setup().await?;
    w.owner
        .call(w.council.id(), "set_max_seats_per_account")
        .args_json(json!({ "max_seats_per_account": 200 }))
        .transact()
        .await?
        .into_result()?;
    let holder = w.worker.dev_create_account().await?;
    let current = current_quarter(&w).await["quarter"].as_u64().unwrap() as u32;
    let from = current - QUARTERS;
    println!(
        "current quarter {current}; the listing asks for {QUARTERS} finalized quarters from {from}, limit {LIMIT}"
    );

    let mut patch = w.worker.patch(w.council.id());
    for q in from..from + QUARTERS {
        patch = patch.state(
            &[vec![QUARTERS_KEY], q.to_le_bytes().to_vec()].concat(),
            &finalized_book(),
        );
    }
    patch.transact().await?;

    println!("\n| what | tokens T | burnt TGas | ms | notes |");
    println!("|---|---|---|---|---|");
    let mut per_call = 0;
    let mut have = 0usize;
    let mut points = vec![];
    for t in TOKEN_STEPS {
        let new: Vec<String> = (have..t).map(|i| format!("ent-{i}")).collect();
        mint_many(&w, &holder, &new).await?;
        let rest: &[String] = if have == 0 {
            per_call = learn_stake_gas(&w, &holder, &new[0]).await?;
            &new[1..]
        } else {
            &new
        };
        stake_many(&w, &holder, rest, per_call).await?;
        assert_eq!(seat_count(&w).await?, w.jurors.len() + t);
        // A seat weight for each new token in each quarter.
        for chunk in new.chunks(PATCH_CHUNK / QUARTERS as usize) {
            let mut patch = w.worker.patch(w.council.id());
            for token in chunk {
                for q in from..from + QUARTERS {
                    let key = [
                        vec![SEAT_WEIGHT_KEY],
                        q.to_le_bytes().to_vec(),
                        bstr(token),
                        bstr(holder.id().as_str()),
                    ]
                    .concat();
                    patch = patch.state(&key, &SEAT_WEIGHT_NS.to_le_bytes());
                }
            }
            patch.transact().await?;
        }
        have = t;
        let args = json!({ "account_id": holder.id(), "from_quarter": from, "limit": LIMIT });
        let t0 = Instant::now();
        let r = holder
            .call(w.council.id(), "entitlements_of")
            .args_json(args)
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        let ms = t0.elapsed().as_millis();
        let burnt = tg(r.total_gas_burnt);
        match r.into_result() {
            Ok(ok) => {
                let n = ok.json::<Vec<Value>>()?.len();
                println!("| entitlements_of (as a transaction) | {t} | {burnt:.1} | {ms} | {n} entries returned (T x {QUARTERS} = {}) |", t * QUARTERS as usize);
                points.push((t as f64, burnt));
            }
            Err(e) => {
                println!(
                    "| entitlements_of (as a transaction) | {t} | ran out of 300 TGas | {ms} | {} |",
                    e.to_string().chars().take(80).collect::<String>()
                );
                break;
            }
        }
    }
    if points.len() >= 2 {
        let n = points.len() as f64;
        let (sx, sy): (f64, f64) = (points.iter().map(|p| p.0).sum(), points.iter().map(|p| p.1).sum());
        let sxx: f64 = points.iter().map(|p| p.0 * p.0).sum();
        let sxy: f64 = points.iter().map(|p| p.0 * p.1).sum();
        let b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        let a = (sy - b * sx) / n;
        println!("fit over {} points: gas = {a:.2} + {b:.3} * T TGas", points.len());
        println!(
            "EXTRAPOLATION: reaches 200 TGas at T = {:.0}; reaches 300 TGas at T = {:.0}",
            (200.0 - a) / b,
            (300.0 - a) / b
        );
    }
    println!("total run time {:.0}s", started.elapsed().as_secs_f64());
    Ok(())
}

struct Draw {
    council: f64,
    total: f64,
    ms: u128,
    ok: bool,
}

// The oracle's own account calls the Council's draw, so the Council's receipt is measured alone, then releases the seats.
async fn direct_draw(w: &World, case: u64, n: u32) -> anyhow::Result<Draw> {
    let t0 = Instant::now();
    let r = w
        .oracle
        .as_account()
        .call(w.council.id(), "draw")
        .args_json(json!({ "case_key": case.to_string(), "n": n, "exclude": [] }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let ms = t0.elapsed().as_millis();
    let (council, total) = (burnt_on(&r, w.council.id()), tg(r.total_gas_burnt));
    let ok = r.is_success();
    if ok {
        w.oracle
            .as_account()
            .call(w.council.id(), "unlock_case")
            .args_json(json!({ "case_key": case.to_string(), "delinquent": [] }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Draw { council, total, ms, ok })
}

fn print_draw(label: &str, seats: usize, eligible: usize, d: &Draw) {
    let note = if d.ok {
        ""
    } else {
        "failed (out of gas or not enough holders)"
    };
    println!(
        "| {label} | {seats} seats, {eligible} eligible | {:.1} | {:.1} | {} | {note} |",
        d.council, d.total, d.ms
    );
}

async fn eligible(w: &World, tokens: &[String]) -> anyhow::Result<usize> {
    let mut n = 0;
    for t in tokens {
        let s = stake_of(w, t).await;
        if s["serving"].is_null() && s["unlock_requested_at"].is_null() {
            n += 1;
        }
    }
    Ok(n)
}

#[tokio::test]
#[ignore]
async fn jury_draw_gas_by_seat_count() -> anyhow::Result<()> {
    let started = Instant::now();
    let w = setup().await?;
    w.owner
        .call(w.council.id(), "set_max_seats_per_account")
        .args_json(json!({ "max_seats_per_account": 1000 }))
        .transact()
        .await?
        .into_result()?;
    let mut holders = vec![];
    for _ in 0..HOLDERS {
        holders.push(w.worker.dev_create_account().await?);
    }
    let mut tokens: Vec<Vec<String>> = vec![vec![]; HOLDERS];
    let mut all_tokens: Vec<String> = w.jurors.iter().map(|j| j.id().to_string()).collect();
    let mut per_call = 0;
    let mut case = DIRECT_CASE_BASE;
    let mut points = vec![];
    println!("\n| what | seats | Council receipt TGas | whole tx TGas | ms | notes |");
    println!("|---|---|---|---|---|---|");
    let mut reached = 0;
    for target in SEAT_STEPS {
        if reached > 0 && started.elapsed().as_secs() > 15 * 60 {
            println!("stopped before {target} seats: staking passed 15 minutes");
            break;
        }
        let mut have = seat_count(&w).await?;
        let mut h = 0;
        while have < target {
            let want = (target - have).min(HOLDERS);
            let mut new_per_holder = vec![vec![]; HOLDERS];
            for i in 0..want {
                let idx = (h + i) % HOLDERS;
                let name = format!("seat-{idx}-{}", tokens[idx].len() + new_per_holder[idx].len());
                new_per_holder[idx].push(name);
            }
            h += want;
            for (idx, new) in new_per_holder.into_iter().enumerate() {
                if new.is_empty() {
                    continue;
                }
                mint_many(&w, &holders[idx], &new).await?;
                let rest: Vec<String> = if per_call == 0 {
                    per_call = learn_stake_gas(&w, &holders[idx], &new[0]).await?;
                    new[1..].to_vec()
                } else {
                    new.clone()
                };
                stake_many(&w, &holders[idx], &rest, per_call).await?;
                all_tokens.extend(new.iter().cloned());
                tokens[idx].extend(new);
            }
            have += want;
        }
        let seats = seat_count(&w).await?;
        assert_eq!(seats, target, "every stake should have landed");
        reached = seats;
        println!("-- {seats} seats staked after {:.0}s", started.elapsed().as_secs_f64());
        let free = eligible(&w, &all_tokens).await?;
        case += 1;
        let d = direct_draw(&w, case, JURY_FIRST).await?;
        print_draw(&format!("draw of {JURY_FIRST}, direct"), seats, free, &d);
        if d.ok {
            points.push((seats as f64, d.council));
        }
        case += 1;
        let d = direct_draw(&w, case, JURY_SECOND).await?;
        print_draw(&format!("draw of {JURY_SECOND}, direct"), seats, free, &d);
    }

    // The whole draw through the oracle at the largest size, as a challenged case runs it.
    let seats = reached;
    let id = create_market(&w, CLOSE_SECS, MARKET_GAP_SECS).await?;
    skip_secs(&w.worker, PAST_CLOSE_SECS).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    wait_for_draw(&w, id).await;
    let t0 = Instant::now();
    let r = w
        .bob
        .call(w.oracle.id(), "resolve_draw")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let ms = t0.elapsed().as_millis();
    let (council, total) = (burnt_on(&r, w.council.id()), tg(r.total_gas_burnt));
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    let events = event_names(&logs);
    r.into_result()?;
    println!(
        "| resolve_draw through the oracle (events {events:?}) | {seats} | {council:.1} | {total:.1} | {ms} | the oracle gives the Council {ORACLE_DRAW_ALLOWANCE_TGAS:.0} TGas |"
    );

    // Seats asking to leave are skipped by the draw but still read. 20 percent, then 50 percent in all.
    let leavers_target = |share: f64| (seats as f64 * share) as usize;
    let mut asked = 0usize;
    for share in [0.2, 0.5] {
        let want = leavers_target(share);
        let mut owner_of: Vec<(usize, String)> = vec![];
        for (idx, list) in tokens.iter().enumerate() {
            for t in list {
                owner_of.push((idx, t.clone()));
            }
        }
        let mut pending: Vec<(usize, String)> = vec![];
        for (idx, t) in owner_of {
            if asked + pending.len() >= want {
                break;
            }
            let s = stake_of(&w, &t).await;
            if s["serving"].is_null() && s["unlock_requested_at"].is_null() {
                pending.push((idx, t));
            }
        }
        for (idx, holder) in holders.iter().enumerate() {
            let mine: Vec<&String> = pending.iter().filter(|p| p.0 == idx).map(|p| &p.1).collect();
            for chunk in mine.chunks(LEAVE_BATCH) {
                let mut batch = holder.batch(w.council.id());
                for t in chunk {
                    batch = batch.call(
                        Function::new("request_unstake")
                            .args_json(json!({ "token_id": t }))
                            .gas(Gas::from_tgas(LEAVE_PER_CALL)),
                    );
                }
                batch.transact().await?.into_result()?;
            }
        }
        asked += pending.len();
        let free = eligible(&w, &all_tokens).await?;
        case += 1;
        let d = direct_draw(&w, case, JURY_FIRST).await?;
        print_draw(
            &format!(
                "draw of {JURY_FIRST}, direct, {:.0} percent of seats asking to leave",
                share * 100.0
            ),
            seats,
            free,
            &d,
        );
        case += 1;
        let d = direct_draw(&w, case, JURY_SECOND).await?;
        print_draw(
            &format!(
                "draw of {JURY_SECOND}, direct, {:.0} percent asking to leave",
                share * 100.0
            ),
            seats,
            free,
            &d,
        );
    }

    if points.len() >= 2 {
        let n = points.len() as f64;
        let (sx, sy): (f64, f64) = (points.iter().map(|p| p.0).sum(), points.iter().map(|p| p.1).sum());
        let sxx: f64 = points.iter().map(|p| p.0 * p.0).sum();
        let sxy: f64 = points.iter().map(|p| p.0 * p.1).sum();
        let b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        let a = (sy - b * sx) / n;
        println!(
            "fit over {} points: Council draw of {JURY_FIRST} = {a:.2} + {b:.4} * seats TGas ({:.3} TGas a seat)",
            points.len(),
            b
        );
        println!(
            "EXTRAPOLATION: exceeds {DRAW_LIMIT_TGAS:.0} TGas at {:.0} seats; exceeds the oracle's {ORACLE_DRAW_ALLOWANCE_TGAS:.0} TGas allowance at {:.0} seats",
            (DRAW_LIMIT_TGAS - a) / b,
            (ORACLE_DRAW_ALLOWANCE_TGAS - a) / b
        );
    }
    println!("total run time {:.0}s", started.elapsed().as_secs_f64());
    Ok(())
}
