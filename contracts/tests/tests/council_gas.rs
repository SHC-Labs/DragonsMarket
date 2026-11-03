// What the Council's calls cost in gas on the real chain, against the floors and caps the contracts set themselves: the claim
// floor, the gas the oracle gives a release, the gas the market gives a revenue receipt, and the number of days a receipt, a draw
// and a release walk. Real contracts, sandbox chain. Each test prints a table; run with --nocapture. The Council is put behind
// by editing its day ledger (see fall_behind and end_quarters in common), because a block takes real time, and the work after
// that is the contract's own.
mod common;
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::json;

const CLAIM_FLOOR_TGAS: u64 = 33;
const MAX_CLAIM_TOKENS: usize = 10;
const GAS_UNLOCK_TGAS: u64 = 25;
// The market gives the verifier 42 TGas for a revenue transfer: 22 of its own and 20 for the Council's receipt.
const MARKET_TRANSFER_TGAS: u64 = 42;
const MARKET_RECEIPT_TGAS: f64 = 20.0;
const MAX_RECEIPT_CATCH_UP_DAYS: u64 = 30;
const SETTLE_CASE_BASE: u64 = 7_000_000;
const LARGEST_JURY: usize = 21;
const UNMETERED_TGAS: u64 = 300;

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

// Gas burnt by each receipt that ran on the Council, in order.
fn council_receipts(r: &ExecutionFinalResult, w: &World) -> Vec<f64> {
    r.receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id == *w.council.id())
        .map(|o| tg(o.gas_burnt))
        .collect()
}

fn row(what: &str, detail: &str, r: &ExecutionFinalResult, w: &World) {
    println!(
        "| {what} | {detail} | {:.1} | {:?} | {:.1} |",
        burnt_on(r, w.council.id()),
        council_receipts(r, w)
            .iter()
            .map(|g| format!("{g:.1}"))
            .collect::<Vec<_>>(),
        tg(r.total_gas_burnt)
    );
}

fn header() {
    println!("\n| what | detail | Council burnt TGas | per receipt | whole transaction TGas |");
    println!("|---|---|---|---|---|");
}

// An account holding `seats` seats, staked now.
async fn holder_with(w: &World, seats: usize, tag: &str) -> anyhow::Result<(Account, Vec<String>)> {
    let holder = w.worker.dev_create_account().await?;
    let tokens: Vec<String> = (0..seats).map(|i| format!("{tag}-{i}")).collect();
    for token in &tokens {
        mint_nft(w, &holder, token).await?;
        stake(w, &holder, token).await?;
    }
    Ok((holder, tokens))
}

fn refs(tokens: &[String]) -> Vec<&str> {
    tokens.iter().map(String::as_str).collect()
}

#[tokio::test]
async fn claim_and_leave_gas_by_the_number_of_seats() -> anyhow::Result<()> {
    let w = setup().await?;
    // Two holders for each size, so a claim at the floor and a claim with plenty of gas each see a quarter's earnings.
    let mut holders = vec![];
    for seats in [1usize, MAX_CLAIM_TOKENS / 2, MAX_CLAIM_TOKENS] {
        for set in 0..2 {
            holders.push((seats, set, holder_with(&w, seats, &format!("h{seats}s{set}")).await?));
        }
    }
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    send_revenue(&w, 5_000 * USD).await?;
    end_quarters(&w, 1).await?;
    advance_days(&w).await?;

    header();
    for (seats, set, (holder, tokens)) in &holders {
        let attached = if *set == 0 { CLAIM_FLOOR_TGAS } else { 100 };
        let r = claim_with_gas(&w, holder, &refs(tokens), attached).await?;
        row(
            &format!("claim, {seats} seats"),
            &format!(
                "{attached} TGas attached, {}",
                if r.is_success() && r.failures().is_empty() {
                    "paid"
                } else {
                    "FAILED"
                }
            ),
            &r,
            &w,
        );
        assert!(
            r.is_success() && r.failures().is_empty(),
            "a claim of {seats} seats with {attached} TGas failed: {:?}",
            r.failures()
        );
        assert!(holdings(&w, holder.id()).await > 0, "{seats} seats were paid");
    }

    // The heaviest request: a seat with earnings in a finished quarter and in the running one, with nothing settled yet.
    send_revenue(&w, 500 * USD).await?;
    let leaver = &w.jurors[0];
    let r = leaver
        .call(w.council.id(), "request_unstake")
        .args_json(json!({ "token_id": tok(leaver), "accepts_cut": true }))
        .max_gas()
        .transact()
        .await?;
    row(
        "request_unstake",
        "earnings in a finished and in the running quarter",
        &r,
        &w,
    );
    r.into_result()?;

    // The most seats a claim takes, and one more.
    let (holder, tokens) = holder_with(&w, MAX_CLAIM_TOKENS, "extra").await?;
    let mut eleven = refs(&tokens);
    eleven.push(tok(leaver));
    refused(claim(&w, &holder, &eleven).await, "at most 10 tokens in one claim");
    Ok(())
}

// Sends 1 USD of revenue the way the market does: a transfer through the verifier with the gas the market gives it. Returns the
// result and whether the Council took it.
async fn receipt_with(w: &World, sweep: u64, tgas: u64) -> anyhow::Result<(ExecutionFinalResult, bool)> {
    let before = council_total_received(w).await;
    let r = w
        .owner
        .call(w.verifier.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": w.council.id(), "token_id": token_id(w), "amount": USD.to_string(), "msg": format!("revenue:{sweep}")
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?;
    let took = council_total_received(w).await - before == USD;
    Ok((r, took))
}

#[tokio::test]
async fn revenue_receipt_gas_by_the_days_the_council_is_behind() -> anyhow::Result<()> {
    header();
    for days in [0u64, 1, 10, MAX_RECEIPT_CATCH_UP_DAYS, MAX_RECEIPT_CATCH_UP_DAYS + 1] {
        let w = setup().await?;
        mint(&w, w.owner.id(), 100 * USD).await?;
        deposit_to_intents(&w, &w.owner, w.owner.id(), 100 * USD).await?;
        set_council_market(&w, w.owner.id()).await?;
        if days > 0 {
            fall_behind(&w, days).await?;
        }
        let mut least = None;
        for (sweep, tgas) in [MARKET_TRANSFER_TGAS, 60, 100, 300].into_iter().enumerate() {
            let (r, took) = receipt_with(&w, sweep as u64, tgas).await?;
            if took {
                row(
                    &format!("revenue receipt, {days} days behind"),
                    &format!("{tgas} TGas attached, a seat starting on every day"),
                    &r,
                    &w,
                );
                least = Some((tgas, burnt_on(&r, w.council.id())));
                break;
            }
        }
        if days <= MAX_RECEIPT_CATCH_UP_DAYS {
            let (tgas, burnt) =
                least.unwrap_or_else(|| panic!("the receipt of a Council {days} days behind failed with 300 TGas"));
            assert_eq!(
                tgas, MARKET_TRANSFER_TGAS,
                "{days} days behind needs {tgas} TGas through the verifier, and the market gives {MARKET_TRANSFER_TGAS}"
            );
            assert!(
                burnt < MARKET_RECEIPT_TGAS,
                "{days} days behind burnt {burnt:.1} TGas of the {MARKET_RECEIPT_TGAS} the market gives the receipt"
            );
        } else {
            assert!(
                least.is_none(),
                "past the cap the receipt is refused and the verifier gives the money back"
            );
            assert_eq!(council_total_received(&w).await, 0);
        }
    }
    Ok(())
}

// A direct call from the oracle's account, which is how the oracle reaches the Council.
async fn as_oracle(
    w: &World,
    method: &str,
    args: serde_json::Value,
    tgas: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(w.oracle
        .as_account()
        .call(w.council.id(), method)
        .args_json(args)
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

// A jury of `jury` seats, all the seats there are and all earning, drawn after 1,000 USD, 1,000 USD more while they serve, and
// the Council `days` days behind. Returns the world and the case key.
async fn serving_world(days: u64, jury: usize) -> anyhow::Result<(World, u64)> {
    let mut w = setup().await?;
    let missing = jury - w.jurors.len();
    add_jurors(&mut w, missing).await?;
    back_date(&w, 0).await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    send_revenue(&w, 1_000 * USD).await?;
    let case = SETTLE_CASE_BASE + days;
    as_oracle(
        &w,
        "draw",
        json!({ "case_key": case.to_string(), "n": jury, "exclude": [] }),
        300,
    )
    .await?
    .into_result()?;
    send_revenue(&w, 1_000 * USD).await?;
    if days > 0 {
        fall_behind(&w, days).await?;
    }
    Ok((w, case))
}

// The oracle's release of a jury with `silent` jurors who never voted, with `tgas` attached, `days` days behind.
async fn release_with_silent_jurors(
    days: u64,
    jury: usize,
    silent: usize,
    tgas: u64,
) -> anyhow::Result<(World, ExecutionFinalResult)> {
    let (w, case) = serving_world(days, jury).await?;
    let delinquent: Vec<_> = w.jurors.iter().take(silent).map(|j| j.id().clone()).collect();
    let r = as_oracle(
        &w,
        "unlock_case",
        json!({ "case_key": case.to_string(), "delinquent": delinquent }),
        tgas,
    )
    .await?;
    row(
        "unlock_case",
        &format!(
            "{days} days behind, {jury} seats drawn, {silent} silent, {tgas} TGas attached, {}",
            if released(&r) { "released" } else { "FAILED" }
        ),
        &r,
        &w,
    );
    Ok((w, r))
}

fn released(r: &ExecutionFinalResult) -> bool {
    r.is_success() && r.failures().is_empty()
}

#[tokio::test]
async fn unlock_case_gas_with_silent_jurors_after_a_gap() -> anyhow::Result<()> {
    header();
    for (days, jury, silent) in [
        (0u64, JURY as usize, 2usize),
        (MAX_RECEIPT_CATCH_UP_DAYS, JURY as usize, 0),
        (MAX_RECEIPT_CATCH_UP_DAYS, JURY as usize, 2),
        (MAX_RECEIPT_CATCH_UP_DAYS, JURY as usize, JURY as usize),
    ] {
        let (w, r) = release_with_silent_jurors(days, jury, silent, GAS_UNLOCK_TGAS).await?;
        assert!(
            released(&r),
            "unlock_case with {silent} silent jurors after {days} days did not fit {GAS_UNLOCK_TGAS} TGas: {:?}",
            r.failures()
        );
        for j in &w.jurors {
            assert!(stake_of(&w, tok(j)).await["serving"].is_null(), "{} is free", j.id());
        }
        let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
        assert_eq!(events_named(&logs, "seat_earnings_forfeited").len(), silent);
    }
    // The juries a second round seats are larger, so they are only measured here, with the gas to finish. The next test asks
    // whether the smaller of them fits the gas the oracle gives.
    for jury in [SECOND_JURY, LARGEST_JURY] {
        let (_, r) = release_with_silent_jurors(MAX_RECEIPT_CATCH_UP_DAYS, jury, jury, UNMETERED_TGAS).await?;
        assert!(
            released(&r),
            "{jury} silent jurors did not release with {UNMETERED_TGAS} TGas"
        );
    }
    Ok(())
}

#[tokio::test]
async fn releasing_an_eleven_seat_jury_of_silent_jurors_fits_the_gas_the_oracle_gives_it_after_a_30_day_gap(
) -> anyhow::Result<()> {
    header();
    let (w, r) =
        release_with_silent_jurors(MAX_RECEIPT_CATCH_UP_DAYS, SECOND_JURY, SECOND_JURY, GAS_UNLOCK_TGAS).await?;
    assert!(
        released(&r),
        "the release burnt {:.1} TGas of the {GAS_UNLOCK_TGAS} the oracle gives it and ran out",
        burnt_on(&r, w.council.id())
    );
    Ok(())
}

// The longest walk a claim takes on its own: a hundred days, a seat starting on every one, and a quarter closing on the way.
#[tokio::test]
async fn claim_gas_after_the_longest_walk_a_claim_takes_on_its_own() -> anyhow::Result<()> {
    const WALK_DAYS: u64 = 100;
    let w = setup().await?;
    let mut holders = vec![];
    for seats in [MAX_CLAIM_TOKENS, 1usize] {
        holders.push((seats, holder_with(&w, seats, &format!("w{seats}")).await?));
    }
    back_date(&w, 1).await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    send_revenue(&w, 5_000 * USD).await?;
    fall_behind(&w, WALK_DAYS).await?;

    header();
    for (call, (seats, (holder, tokens))) in holders.iter().enumerate() {
        let r = claim_with_gas(&w, holder, &refs(tokens), 300).await?;
        row(
            &format!("claim, {seats} seats"),
            &if call == 0 {
                format!("first call after {WALK_DAYS} days with a seat starting every day and a quarter closing, 300 TGas attached")
            } else {
                "the Council is current, 300 TGas attached".to_string()
            },
            &r,
            &w,
        );
        r.into_result()?;
        assert!(holdings(&w, holder.id()).await > 0, "{seats} seats were paid");
    }
    Ok(())
}

#[tokio::test]
async fn the_first_call_after_a_quarter_boundary_pays_for_the_walk_and_the_close() -> anyhow::Result<()> {
    header();
    // The chain is some days into its quarter, so ending the Council's quarter makes it that many days and one behind. The
    // same walk without the boundary is the days alone.
    let w = setup().await?;
    let day = now(&w.worker).await / NS_PER_DAY;
    let into_quarter = day - quarter_start_day(running_quarter(&w).await);
    println!("the chain is {into_quarter} days into its quarter");
    drop(w);
    for (boundary, label) in [
        (false, "walks the days only"),
        (true, "walks the days and closes the quarter"),
    ] {
        for call in ["advance_days", "claim", "request_unstake", "mt_on_transfer"] {
            if !boundary && call == "claim" {
                continue;
            }
            let w = setup().await?;
            back_date(&w, 1).await?;
            mint(&w, w.owner.id(), 10_000 * USD).await?;
            send_revenue(&w, 1_000 * USD).await?;
            let days = if boundary {
                end_quarters(&w, 1).await?;
                into_quarter + 1
            } else {
                rewind_days(&w, into_quarter).await?;
                into_quarter
            };
            let j = &w.jurors[0];
            let r = match call {
                "advance_days" => {
                    w.bob
                        .call(w.council.id(), "advance_days")
                        .args_json(json!({ "max_steps": null }))
                        .max_gas()
                        .transact()
                        .await?
                }
                "claim" => claim_with_gas(&w, j, &[tok(j)], 100).await?,
                "request_unstake" => {
                    j.call(w.council.id(), "request_unstake")
                        .args_json(json!({ "token_id": tok(j), "accepts_cut": true }))
                        .max_gas()
                        .transact()
                        .await?
                }
                _ => {
                    set_council_market(&w, w.owner.id()).await?;
                    deposit_to_intents(&w, &w.owner, w.owner.id(), USD).await?;
                    receipt_with(&w, 1, MARKET_TRANSFER_TGAS).await?.0
                }
            };
            let ok = r.is_success() && r.failures().is_empty();
            row(
                &format!("{call}, {days} days, {label}"),
                if ok { "ok" } else { "refused or failed" },
                &r,
                &w,
            );
            if call == "advance_days" {
                assert!(ok);
            }
        }
    }
    Ok(())
}
