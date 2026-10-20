// Constant-product pricing for one binary market. Pure integer maths, no NEAR types, so it can be
// tested natively. Every rounding goes in the pool's favour, so the pool's product never shrinks.
//
// Pools hold shares: `target` is the outcome being traded, `other` the opposite one. Price of the
// target outcome = other / (target + other).

/// Largest pool size the contract allows. Keeps every product below u128::MAX with room to spare.
pub const MAX_POOL: u128 = 1_000_000_000_000_000;

fn ceil_div(a: u128, b: u128) -> Option<u128> {
    (b != 0).then(|| a.div_ceil(b))
}

/// Buy the target outcome with `amount` collateral.
/// Returns (shares out, new target pool, new other pool).
pub fn buy(target: u128, other: u128, amount: u128) -> Option<(u128, u128, u128)> {
    if amount == 0 || target == 0 || other == 0 {
        return None;
    }
    let k = target.checked_mul(other)?;
    let other_after = other.checked_add(amount)?;
    let target_after = ceil_div(k, other_after)?;
    let shares_out = target.checked_add(amount)?.checked_sub(target_after)?;
    if shares_out == 0 || target_after == 0 || other_after > MAX_POOL || target_after > MAX_POOL {
        return None;
    }
    Some((shares_out, target_after, other_after))
}

/// Sell target shares to take out exactly `collateral_out`.
/// Returns (shares in, new target pool, new other pool).
pub fn sell(target: u128, other: u128, collateral_out: u128) -> Option<(u128, u128, u128)> {
    if collateral_out == 0 || collateral_out >= other || target == 0 {
        return None;
    }
    let k = target.checked_mul(other)?;
    let other_after = other - collateral_out;
    let target_after = ceil_div(k, other_after)?;
    let shares_in = target_after.checked_add(collateral_out)?.checked_sub(target)?;
    if shares_in == 0 || target_after > MAX_POOL {
        return None;
    }
    Some((shares_in, target_after, other_after))
}

/// Most collateral that selling at most `shares` target shares can return. Shares needed grow with
/// the collateral taken, so a binary search over `sell` finds it.
pub fn max_collateral_for_shares(target: u128, other: u128, shares: u128) -> u128 {
    let (mut lo, mut hi) = (0u128, other.saturating_sub(1));
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        match sell(target, other, mid) {
            Some((needed, _, _)) if needed <= shares => lo = mid,
            _ => hi = mid - 1,
        }
    }
    lo
}

/// Trading fee, rounded up: rate × shares × p × (1 − p), where p = collateral / shares is the trade's average
/// price. shares × p × (1 − p) is collateral × (shares − collateral) / shares.
pub fn fee(collateral: u128, shares: u128, rate_bps: u128) -> Option<u128> {
    let n = rate_bps
        .checked_mul(collateral)?
        .checked_mul(shares.checked_sub(collateral)?)?;
    ceil_div(n, shares.checked_mul(10_000)?)
}

/// Buy with `amount` collateral, fee included. The fee is priced on the trade the whole amount would make
/// before the curve moves, and what is left buys the shares.
/// Returns (fee, shares out, new target pool, new other pool).
pub fn buy_after_fee(target: u128, other: u128, amount: u128, rate_bps: u128) -> Option<(u128, u128, u128, u128)> {
    let (gross, _, _) = buy(target, other, amount)?;
    let fee = fee(amount, gross, rate_bps)?;
    let (out, t, o) = buy(target, other, amount.checked_sub(fee)?)?;
    Some((fee, out, t, o))
}

/// Sell target shares for `collateral_out` taken out of the pool, of which the fee is kept and the rest paid.
/// Returns (fee, shares in, new target pool, new other pool).
pub fn sell_after_fee(
    target: u128,
    other: u128,
    collateral_out: u128,
    rate_bps: u128,
) -> Option<(u128, u128, u128, u128)> {
    let (shares_in, t, o) = sell(target, other, collateral_out)?;
    let fee = fee(collateral_out, shares_in, rate_bps)?;
    (fee < collateral_out).then_some((fee, shares_in, t, o))
}

/// Price of the target outcome in millionths of one collateral unit (1_000_000 = 1.00).
pub fn price_micro(target: u128, other: u128) -> u128 {
    let total = target + other;
    if total == 0 {
        return 500_000;
    }
    other * 1_000_000 / total
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn opening_price_is_half() {
        assert_eq!(price_micro(100_000_000, 100_000_000), 500_000);
    }

    #[test]
    fn buying_raises_the_price() {
        let (out, t, o) = buy(100_000_000, 100_000_000, 10_000_000).unwrap();
        assert!(
            out > 10_000_000,
            "buying at 50c should return more than the collateral paid"
        );
        assert!(price_micro(t, o) > 500_000);
    }

    #[test]
    fn buy_then_sell_never_returns_more_than_paid() {
        let (out, t, o) = buy(100_000_000, 100_000_000, 10_000_000).unwrap();
        let back = max_collateral_for_shares(t, o, out);
        assert!(back <= 10_000_000);
    }

    #[test]
    fn rejects_zero_and_oversize() {
        assert!(buy(100, 100, 0).is_none());
        assert!(sell(100, 100, 100).is_none());
        assert!(buy(MAX_POOL, MAX_POOL, 1).is_none());
    }

    #[test]
    fn the_fee_is_rate_times_shares_times_p_times_one_minus_p() {
        // 2%: 100 shares at 50c cost 0.5 in fees, 1% of the 50 paid. At 97c, 0.06% of the 97 paid.
        assert_eq!(fee(50_000_000, 100_000_000, 200), Some(500_000));
        assert_eq!(fee(97_000_000, 100_000_000, 200), Some(58_200));
        assert_eq!(fee(1, 3, 200), Some(1), "a fraction of a unit rounds up");
        assert_eq!(fee(100, 100, 200), Some(0), "nothing at a price of 1");
        assert!(fee(101, 100, 200).is_none());
    }

    #[test]
    fn a_buy_pays_its_fee_out_of_the_amount_and_buys_with_the_rest() {
        let (gross, _, _) = buy(99_000_000, 99_000_000, 10_000_000).unwrap();
        let (f, out, t, o) = buy_after_fee(99_000_000, 99_000_000, 10_000_000, 200).unwrap();
        assert_eq!(f, fee(10_000_000, gross, 200).unwrap());
        assert_eq!((out, t, o), buy(99_000_000, 99_000_000, 10_000_000 - f).unwrap());
    }

    proptest! {
        // A full round trip through the fees always comes back with less than was paid, by at least both fees.
        #[test]
        fn round_trip_with_fees_loses_at_least_the_fees(
            seed in 1_000_000u128..100_000_000_000,
            amount in 2u128..50_000_000_000
        ) {
            if let Some((buy_fee, out, t, o)) = buy_after_fee(seed, seed, amount, 200) {
                let c = max_collateral_for_shares(t, o, out);
                if let Some((sell_fee, _, _, _)) = sell_after_fee(t, o, c, 200) {
                    let back = c - sell_fee;
                    prop_assert!(amount - back >= buy_fee + sell_fee, "paid {} got back {} fees {} {}", amount, back, buy_fee, sell_fee);
                }
            }
        }

        // The product of the pools never falls, whatever sequence of trades happens.
        #[test]
        fn product_never_shrinks(
            seed in 1_000_000u128..100_000_000_000,
            trades in proptest::collection::vec((any::<bool>(), 1u128..50_000_000_000), 1..40)
        ) {
            let (mut y, mut n) = (seed, seed);
            for (buy_yes, amount) in trades {
                let before = y * n;
                let step = if buy_yes {
                    buy(y, n, amount).map(|(_, ny, nn)| (ny, nn))
                } else {
                    buy(n, y, amount).map(|(_, nn, ny)| (ny, nn))
                };
                if let Some((ny, nn)) = step {
                    y = ny;
                    n = nn;
                    prop_assert!(y * n >= before);
                }
            }
        }

        // Selling what you bought can never return more than you paid.
        #[test]
        fn round_trip_never_profits(
            seed in 1_000_000u128..100_000_000_000,
            amount in 1u128..50_000_000_000
        ) {
            if let Some((out, t, o)) = buy(seed, seed, amount) {
                let back = max_collateral_for_shares(t, o, out);
                prop_assert!(back <= amount);
            }
        }

        // The quoted sell, applied for real, takes no more shares than offered.
        #[test]
        fn sell_quote_is_honest(
            seed in 1_000_000u128..100_000_000_000,
            amount in 1u128..50_000_000_000,
            frac in 1u128..100
        ) {
            if let Some((out, t, o)) = buy(seed, seed, amount) {
                let offer = out * frac / 100;
                let c = max_collateral_for_shares(t, o, offer);
                if c > 0 {
                    let (needed, _, _) = sell(t, o, c).unwrap();
                    prop_assert!(needed <= offer);
                }
            }
        }
    }
}
