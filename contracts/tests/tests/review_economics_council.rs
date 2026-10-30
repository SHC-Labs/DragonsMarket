// Economics of the Council's quarterly revenue share: a seat staked late in a quarter takes a share of revenue that arrived
// before it existed, the per-account seat cap does not stop that, and what a seat earns. Real contracts, sandbox chain. The sandbox
// cannot reach the end of a real quarter, so the quarter is read while open: the view's estimate is the same formula the final
// claim uses (pool times seat time over all seat time). Run with --nocapture.
mod common;
use common::*;

const LATE_SEATS: usize = 10;
const HOLD_SECS: u64 = 300;
const HEAD_START_SECS: u64 = 600;
const REVENUE: u128 = 1_000 * USD;

#[tokio::test]
async fn a_seat_staked_after_the_revenue_arrived_still_takes_a_share_of_it() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    // Five long-term seats, then a stretch of time, then the quarter's revenue.
    skip_secs(&w.worker, HEAD_START_SECS).await;
    send_revenue(&w, REVENUE).await?;
    let quarter = current_quarter(&w).await["quarter"].as_u64().unwrap() as u32;

    // Alice stakes ten seats afterwards and leaves five minutes later. No revenue arrives while she is in.
    let tokens: Vec<String> = (0..LATE_SEATS).map(|i| format!("late{i}")).collect();
    for t in &tokens {
        mint_nft(&w, &w.alice, t).await?;
        stake(&w, &w.alice, t).await?;
    }
    // The cap of ten seats per account does not bind anything that matters: another wallet takes the next ten.
    mint_nft(&w, &w.alice, "extra").await?;
    let eleventh = stake(&w, &w.alice, "extra").await;
    println!("eleventh seat for one account: {:?}", eleventh.as_ref().err().map(|e| e.to_string()));
    assert!(eleventh.is_err(), "the per-account cap is ten seats");
    w.alice
        .call(w.nft.id(), "nft_transfer")
        .args_json(serde_json::json!({ "receiver_id": w.bob.id(), "token_id": "extra" }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert!(stake(&w, &w.bob, "extra").await.is_ok(), "the same NFT staked from a second wallet");
    skip_secs(&w.worker, HOLD_SECS).await;
    for t in &tokens {
        request_unstake(&w, &w.alice, t).await?;
    }

    let mut alice = 0u128;
    let mut alice_weight = 0u128;
    for t in &tokens {
        let e = entitlement(&w, quarter, t, w.alice.id()).await;
        alice += u(&e["amount"]);
        alice_weight += u(&e["weight_ns"]);
    }
    let incumbent = entitlement(&w, quarter, w.jurors[0].id().as_str(), w.jurors[0].id()).await;
    let q = current_quarter(&w).await;
    let total = u(&q["seat_ns"]);
    println!(
        "revenue {:.2} arrived BEFORE alice staked. alice: {LATE_SEATS} seats for ~{HOLD_SECS}s end up with {:.4} ({:.2}% of the quarter) \
         = {:.4} per seat-hour, against {:.4} for one incumbent seat. seat-ns: alice {alice_weight} of {total}",
        REVENUE as f64 / USD as f64,
        alice as f64 / USD as f64,
        100.0 * alice as f64 / REVENUE as f64,
        alice as f64 / USD as f64 / (LATE_SEATS as f64 * HOLD_SECS as f64 / 3600.0),
        u(&incumbent["amount"]) as f64 / USD as f64,
    );
    assert!(alice > 0, "she took a share of money that was in the Council before she staked");
    assert!(alice_weight * 100 / total >= 1, "a measurable share of the whole quarter");

    Ok(())
}
