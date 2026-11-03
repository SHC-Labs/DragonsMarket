// Economics of the Council's revenue share: a seat staked after revenue arrived takes none of it, the per-account seat cap does
// not change that, and what leaving costs a seat that has earned nothing. Real contracts, sandbox chain.
mod common;
use common::*;

const LATE_SEATS: usize = 10;
const HOLD_SECS: u64 = 300;
const HEAD_START_SECS: u64 = 600;
const REVENUE: u128 = 1_000 * USD;

#[tokio::test]
async fn a_seat_staked_after_the_revenue_arrived_takes_no_share_of_it() -> anyhow::Result<()> {
    let w = setup_earning().await?;
    mint(&w, w.owner.id(), 10_000 * USD).await?;
    // Five long-term seats, then a stretch of time, then the revenue.
    skip_secs(&w.worker, HEAD_START_SECS).await;
    send_revenue(&w, REVENUE).await?;

    // Alice stakes ten seats afterwards and leaves five minutes later. No revenue arrives while she is in.
    let tokens: Vec<String> = (0..LATE_SEATS).map(|i| format!("late{i}")).collect();
    for t in &tokens {
        mint_nft(&w, &w.alice, t).await?;
        stake(&w, &w.alice, t).await?;
    }
    // The cap of ten seats per account does not bind anything that matters: another wallet takes the next ten.
    mint_nft(&w, &w.alice, "extra").await?;
    let eleventh = stake(&w, &w.alice, "extra").await;
    println!(
        "eleventh seat for one account: {:?}",
        eleventh.as_ref().err().map(|e| e.to_string())
    );
    assert!(eleventh.is_err(), "the per-account cap is ten seats");
    w.alice
        .call(w.nft.id(), "nft_transfer")
        .args_json(serde_json::json!({ "receiver_id": w.bob.id(), "token_id": "extra" }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert!(
        stake(&w, &w.bob, "extra").await.is_ok(),
        "the same NFT staked from a second wallet"
    );
    skip_secs(&w.worker, HOLD_SECS).await;
    for t in &tokens {
        request_unstake(&w, &w.alice, t).await?;
    }

    let incumbent = in_progress_of(&w, w.jurors[0].id()).await;
    println!(
        "revenue {:.2} arrived BEFORE alice staked. alice: {LATE_SEATS} seats for ~{HOLD_SECS}s end up with {:.4} \
         against {:.4} for one incumbent seat",
        REVENUE as f64 / USD as f64,
        in_progress_of(&w, w.alice.id()).await as f64 / USD as f64,
        incumbent as f64 / USD as f64,
    );
    assert_eq!(incumbent, REVENUE / 5, "the five seats that were there share all of it");
    assert_eq!(
        in_progress_of(&w, w.alice.id()).await + claimable_of(&w, w.alice.id()).await,
        0,
        "she took nothing from money that was in the Council before she staked"
    );
    let totals = reward_totals(&w).await;
    assert_eq!(
        (u(&totals["cut_pool"]), u(&totals["pending_total_slots"])),
        (0, 0),
        "leaving with nothing earned costs nothing"
    );
    Ok(())
}
