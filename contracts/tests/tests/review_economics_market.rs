// Economics review of the dynamic parimutuel (dpm crate) as the market contract runs it: round trips, sandwiching a large buy,
// split buys and dust. Real market wasm in the sandbox; the pure sweeps use a mirror of the dpm functions that the chain test
// checks against the contract's own share counts. Run with --nocapture to see the figures.
mod common;
use common::*;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use serde_json::json;

const FEE_BPS: u128 = 200;

// ---- mirror of dpm/src/lib.rs (the test crate cannot depend on it: its unit tests need proptest) ----
fn cost_floor(y: u128, n: u128) -> u128 {
    (y * y + n * n).isqrt()
}
fn cost_ceil(y: u128, n: u128) -> u128 {
    let sq = y * y + n * n;
    let r = sq.isqrt();
    if r * r == sq {
        r
    } else {
        r + 1
    }
}
fn m_buy(t: u128, o: u128, a: u128) -> Option<(u128, u128)> {
    let b = cost_ceil(t, o) + a;
    let g = (b * b - o * o).isqrt();
    let sh = g.checked_sub(t)?;
    (sh > 0).then_some((sh, g))
}
fn m_sell(t: u128, o: u128, s: u128) -> Option<(u128, u128)> {
    let left = t - s;
    let refund = cost_floor(t, o).checked_sub(cost_ceil(left, o))?;
    (refund > 0).then_some((refund, left))
}
fn fee(a: u128) -> u128 {
    (a * FEE_BPS).div_ceil(10_000)
}
fn buy_f(t: u128, o: u128, a: u128) -> Option<(u128, u128, u128)> {
    let f = fee(a);
    let (sh, g) = m_buy(t, o, a - f)?;
    Some((f, sh, g))
}
fn sell_f(t: u128, o: u128, s: u128) -> Option<(u128, u128, u128)> {
    let (r, l) = m_sell(t, o, s)?;
    let f = fee(r);
    (f < r).then_some((f, r, l))
}

fn usd(v: i128) -> f64 {
    v as f64 / USD as f64
}

// Attacker front-runs a victim buy of `v` on the yes side with a buy of `a`, then sells. The victim only accepts shares
// down to (1 - tol) of what an undisturbed buy would have given. Returns the attacker's profit.
fn sandwich(y0: u128, n0: u128, v: u128, tol_bps: u128, a: u128) -> Option<i128> {
    let (_, undisturbed, _) = buy_f(y0, n0, v)?;
    let floor = undisturbed * (10_000 - tol_bps) / 10_000;
    let (_, sh, y1) = buy_f(y0, n0, a)?;
    let (_, got, y2) = buy_f(y1, n0, v)?;
    if got < floor {
        return None;
    }
    let (_, r, _) = sell_f(y2, n0, sh)?;
    Some(r as i128 - fee(r) as i128 - a as i128)
}

fn best_sandwich(y0: u128, n0: u128, v: u128, tol_bps: u128) -> (i128, u128) {
    let mut best = (i128::MIN, 0);
    let mut a = USD;
    while a <= 200_000 * USD {
        if let Some(p) = sandwich(y0, n0, v, tol_bps, a) {
            if p > best.0 {
                best = (p, a);
            }
        }
        a = a * 5 / 4 + 1;
    }
    best
}

async fn register(w: &World, who: &Account) -> anyhow::Result<()> {
    who.call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// Puts `amount` into the account's market balance, then buys from it. One yocto, like the real call.
async fn fund_and_buy(
    w: &World,
    who: &Account,
    id: u64,
    side: &str,
    amount: u128,
    min_shares: u128,
) -> anyhow::Result<()> {
    mint(w, who.id(), amount).await?;
    ft_call(w, who, w.market.id(), amount, "deposit").await?;
    who.call(w.market.id(), "buy")
        .args_json(
            json!({ "market_id": id.to_string(), "side": side, "amount": amount.to_string(),
                           "min_shares": min_shares.to_string() }),
        )
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn sell_all(w: &World, who: &Account, id: u64, side: &str) -> anyhow::Result<u128> {
    let (y, n) = shares(w, id, who.id()).await;
    let held = if side == "yes" { y } else { n };
    let before = market_balance(w, who.id()).await;
    sell(w, who, id, side, held, 0).await?;
    Ok(market_balance(w, who.id()).await - before)
}

// The cap the market had by default before it was lowered.
const RAISED_MARKET_CAP_USDC: u128 = 100_000;

#[tokio::test]
async fn a_round_trip_and_a_sandwich_on_the_real_market() -> anyhow::Result<()> {
    let w = setup().await?;
    for who in [&w.carol, &w.dave] {
        register(&w, who).await?;
    }
    // The default cap on what a market can hold is 10,000 USDC, below the two buys this test stacks, so the owner raises it.
    w.owner
        .call(w.market.id(), "set_max_market_locked")
        .args_json(json!({ "max_market_locked": (RAISED_MARKET_CAP_USDC * USD).to_string() }))
        .transact()
        .await?
        .into_result()?;
    let id = new_market(&w, 3_600).await?;

    // Prime the pool: 2,000 on each side, alice first. Replayed in the mirror to prove the mirror is the contract's maths.
    fund_and_buy(&w, &w.alice, id, "yes", 2_000 * USD, 1).await?;
    fund_and_buy(&w, &w.bob, id, "no", 2_000 * USD, 1).await?;
    let (_, a_sh, y) = buy_f(0, 0, 2_000 * USD).unwrap();
    let (_, b_sh, n) = buy_f(0, y, 2_000 * USD).unwrap();
    assert_eq!(
        shares(&w, id, w.alice.id()).await.0,
        a_sh,
        "mirror differs from the contract"
    );
    assert_eq!(
        shares(&w, id, w.bob.id()).await.1,
        b_sh,
        "mirror differs from the contract"
    );

    // Plain round trip by carol: buys 1,000, sells everything straight away.
    fund_and_buy(&w, &w.carol, id, "yes", 1_000 * USD, 1).await?;
    let back = sell_all(&w, &w.carol, id, "yes").await?;
    println!(
        "round trip 1,000 yes on 2,000/2,000: got back {:.4}, loss {:.4} (both fees = 40 + ~39)",
        usd(back as i128),
        usd(1_000 * USD as i128 - back as i128)
    );
    assert!(
        back < 1_000 * USD - 2 * 19 * USD,
        "a round trip must lose at least both fees"
    );

    // The pool is back where it was. Now carol front-runs dave's 10,000 buy (dave takes any share count) and sells after.
    let (y_after, n_after) = (y, n);
    let quote_before = quote_buy(&w, id, "yes", 10_000 * USD).await.0;
    fund_and_buy(&w, &w.carol, id, "yes", 1_000 * USD, 1).await?;
    let carol_shares = shares(&w, id, w.carol.id()).await.0;
    fund_and_buy(&w, &w.dave, id, "yes", 10_000 * USD, 1).await?;
    let dave_shares = shares(&w, id, w.dave.id()).await.0;
    let back = sell_all(&w, &w.carol, id, "yes").await?;
    let profit = back as i128 - 1_000 * USD as i128;
    println!(
        "sandwich: carol front buy 1,000, dave buys 10,000 and gets {} shares instead of the quoted {} ({:.2}% fewer), \
         carol sells for {:.2}: profit {:.2} USDC after both fees",
        dave_shares,
        quote_before,
        100.0 * (quote_before - dave_shares) as f64 / quote_before as f64,
        usd(back as i128),
        usd(profit)
    );
    assert!(profit > 0, "an unprotected 10,000 buy is a profitable sandwich");
    assert!(dave_shares < quote_before);
    // The mirror says the same.
    let (_, sh, y1) = buy_f(y_after, n_after, 1_000 * USD).unwrap();
    assert_eq!(sh, carol_shares);
    let (_, vs, _) = buy_f(y1, n_after, 10_000 * USD).unwrap();
    assert_eq!(vs, dave_shares);
    assert!(invariant(&w, id).await);
    Ok(())
}

// Pure sweeps. Not a chain test: it prints the profit of the best front-run for victims who accept a given slippage.
#[test]
fn how_much_a_sandwich_makes_against_a_victim_with_a_slippage_limit() {
    println!(
        "pool (yes/no shares) | victim buy | slippage accepted | best front buy | attacker profit (after 2% + 2% fees)"
    );
    for (pool, label) in [(500u128, "500/500"), (2_000, "2000/2000"), (20_000, "20000/20000")] {
        for v in [100u128, 1_000, 10_000] {
            for tol in [50u128, 100, 300, 1_000] {
                let (p, a) = best_sandwich(pool * USD, pool * USD, v * USD, tol);
                println!(
                    "{label:>12} | {v:>6} | {:>4.1}% | {:>6.0} | {:>8.2}",
                    tol as f64 / 100.0,
                    usd(a as i128),
                    usd(p)
                );
            }
        }
    }
    let (p, _) = best_sandwich(2_000 * USD, 2_000 * USD, 10_000 * USD, 100);
    assert!(p > 0, "a victim who accepts 1% slippage on a large buy is sandwichable");
    let (p, _) = best_sandwich(20_000 * USD, 20_000 * USD, 100 * USD, 1_000);
    assert!(p <= 0, "a small buy into a deep pool is not worth the two fees");
}

// Splitting a buy, dust positions and rounding: none of it beats a single buy or earns anything.
#[test]
fn splitting_dust_and_rounding_never_earn() {
    // One 1,000 buy against 100 buys of 10, same start.
    let (y0, n0) = (2_000 * USD, 2_000 * USD);
    let (f, one, _) = buy_f(y0, n0, 1_000 * USD).unwrap();
    let (mut y, mut fees, mut got) = (y0, 0u128, 0u128);
    for _ in 0..100 {
        let (f, sh, g) = buy_f(y, n0, 10 * USD).unwrap();
        fees += f;
        got += sh;
        y = g;
    }
    println!("1,000 in one buy: {one} shares, fee {f}; in 100 buys of 10: {got} shares, fees {fees}; y after {y}");
    assert!(
        got <= one + 100,
        "splitting must not give more than one buy (rounding is at most one unit a buy)"
    );

    // The fee rounds up, so odd small amounts pay a higher rate. The cheapest sizes are multiples of 50 units.
    for a in [51u128, 99, 100, 149, 150, 1_000_001] {
        println!("amount {a}: fee {} = {:.2}%", fee(a), 100.0 * fee(a) as f64 / a as f64);
        assert!(fee(a) as f64 / a as f64 >= 0.02);
    }
    // Smallest buy that works: below 51 units the fee eats all of it.
    let smallest = (1u128..200).find(|a| buy_f(USD, USD, *a).is_some()).unwrap();
    println!(
        "smallest buy that returns shares: {smallest} units = {:.6} USDC",
        smallest as f64 / USD as f64
    );

    // A buy and sell of the same shares at the same pool: what rounding alone costs (no fees).
    let mut worst_gain: i128 = i128::MIN;
    for a in [1u128, 7, 99, 12_345, 1_000_003, 7_777_777] {
        let (sh, g) = m_buy(3 * USD + 17, 5 * USD + 3, a).unwrap();
        if let Some((r, _)) = m_sell(g, 5 * USD + 3, sh) {
            worst_gain = worst_gain.max(r as i128 - a as i128);
        }
    }
    println!("best no-fee round trip gain over odd sizes: {worst_gain} units");
    assert!(worst_gain <= 0, "rounding never favours the trader");
}
