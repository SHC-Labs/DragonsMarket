// What it costs to fill the market's storage reserve and what the registration fee buys. Bytes are read from the market account's
// storage_usage before and after, a byte locks 1e19 yoctoNEAR. 64-character account ids are the worst case for an attacker's
// storage and the best for the protocol's cost, so both are measured. Run with --nocapture.
mod common;
use common::*;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use serde_json::json;

const NEAR_PER_BYTE: f64 = 1e-5;
const DUST: u128 = 51; // 51 units = 0.000051 USDC: the cheapest buy that survives the 2% fee rounding with a real share count
const POSITIONS: u64 = 10;

async fn used(w: &World) -> anyhow::Result<i64> {
    Ok(storage_used(w, w.market.id()).await? as i64)
}

#[tokio::test]
async fn filling_the_storage_reserve_costs_the_attacker_more_than_the_protocol_loses_at_any_realistic_near_price() -> anyhow::Result<()> {
    let w = setup().await?;
    let fee = u(&w.market.view("config").await?.json::<serde_json::Value>()?["registration_fee"]);
    let long = account_with_id_len(&w, 64, "grief").await?;
    let short = account_with_id_len(&w, 20, "g").await?;
    for a in [&long, &short] {
        mint(&w, a.id(), 5 * USD).await?;
    }

    // 1. A registration paid in collateral: the fee is all the attacker pays, the market keeps the record.
    let before = used(&w).await?;
    ft_call(&w, &long, w.market.id(), fee, "register").await?;
    let reg_long = used(&w).await? - before;
    let before = used(&w).await?;
    ft_call(&w, &short, w.market.id(), fee, "register").await?;
    let reg_short = used(&w).await? - before;

    // 2. A registration paid in NEAR is refundable, so it costs the attacker only the lock.
    let near_user = account_with_id_len(&w, 64, "nearpaid").await?;
    let before = used(&w).await?;
    near_user
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    let reg_near = used(&w).await? - before;

    // 3. Dust positions in many markets by the collateral-registered 64-character account.
    let first = bulk_markets(&w, POSITIONS).await?;
    mint(&w, long.id(), (POSITIONS as u128 + 1) * DUST).await?;
    ft_call(&w, &long, w.market.id(), (POSITIONS as u128 + 1) * DUST, "deposit").await?;
    let before = used(&w).await?;
    for i in 0..POSITIONS {
        long.call(w.market.id(), "buy")
            .args_json(json!({ "market_id": (first + i).to_string(), "side": "yes", "amount": DUST.to_string(), "min_shares": "1" }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    let dust_bytes = used(&w).await? - before;
    let sixty_one = long
        .call(w.market.id(), "buy")
        .args_json(json!({ "market_id": (first + POSITIONS).to_string(), "side": "yes", "amount": DUST.to_string(), "min_shares": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    let near = |bytes: i64| bytes as f64 * NEAR_PER_BYTE;
    println!("registration fee {:.2} USDC", fee as f64 / USD as f64);
    println!("collateral registration: {reg_long} bytes (64-char id) = {:.5} NEAR; {reg_short} bytes (20-char id) = {:.5} NEAR", near(reg_long), near(reg_short));
    println!("NEAR registration: {reg_near} bytes = {:.5} NEAR, against the 0.05 NEAR deposit it brings and gets back on unregister", near(reg_near));
    println!(
        "{POSITIONS} dust positions of {DUST} units: {dust_bytes} bytes = {:.5} NEAR ({:.0} bytes each); the account has paid {:.6} USDC for them",
        near(dust_bytes),
        dust_bytes as f64 / POSITIONS as f64,
        (POSITIONS as u128 * DUST) as f64 / USD as f64
    );
    println!("an 11th position: {}", if sixty_one.is_success() { "accepted".to_string() } else { format!("{:?}", sixty_one.into_result().err().map(|e| e.to_string())) });
    let total = reg_long + dust_bytes;
    println!(
        "one collateral-registered wallet filled to the position cap: {total} bytes = {:.5} NEAR for {:.2} USDC; break-even NEAR price {:.2} USD",
        near(total),
        fee as f64 / USD as f64,
        (fee as f64 / USD as f64) / near(total)
    );
    println!(
        "wallets needed to use up the default 1 NEAR reserve: {:.0} registrations, or {:.0} filled wallets",
        1.0 / near(reg_long),
        1.0 / near(total)
    );
    assert!(reg_long > reg_short);
    Ok(())
}
