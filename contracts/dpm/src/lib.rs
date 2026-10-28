pub const MAX_LOCKED: u128 = 1_000_000_000_000;

fn norm_sq(yes: u128, no: u128) -> Option<u128> {
    yes.checked_mul(yes)?.checked_add(no.checked_mul(no)?)
}

pub fn cost_floor(yes: u128, no: u128) -> Option<u128> {
    norm_sq(yes, no).map(u128::isqrt)
}

pub fn cost_ceil(yes: u128, no: u128) -> Option<u128> {
    let sq = norm_sq(yes, no)?;
    let root = sq.isqrt();
    Some(if root * root == sq { root } else { root + 1 })
}

pub fn buy(target: u128, other: u128, amount: u128) -> Option<(u128, u128)> {
    if amount == 0 {
        return None;
    }
    let budget = cost_ceil(target, other)?.checked_add(amount)?;
    if budget > MAX_LOCKED {
        return None;
    }
    let grown = (budget * budget - other * other).isqrt();
    let shares = grown.checked_sub(target)?;
    (shares > 0).then_some((shares, grown))
}

pub fn sell(target: u128, other: u128, shares: u128) -> Option<(u128, u128)> {
    if shares == 0 || shares > target {
        return None;
    }
    let left = target - shares;
    let refund = cost_floor(target, other)?.checked_sub(cost_ceil(left, other)?)?;
    (refund > 0).then_some((refund, left))
}

pub fn fee(amount: u128, rate_bps: u128) -> Option<u128> {
    Some(amount.checked_mul(rate_bps)?.div_ceil(10_000))
}

pub fn buy_after_fee(target: u128, other: u128, amount: u128, rate_bps: u128) -> Option<(u128, u128, u128)> {
    let fee = fee(amount, rate_bps)?;
    let (shares, grown) = buy(target, other, amount.checked_sub(fee)?)?;
    Some((fee, shares, grown))
}

pub fn sell_after_fee(target: u128, other: u128, shares: u128, rate_bps: u128) -> Option<(u128, u128, u128)> {
    let (refund, left) = sell(target, other, shares)?;
    let fee = fee(refund, rate_bps)?;
    (fee < refund).then_some((fee, refund, left))
}

pub fn winning_payout(shares: u128, winners: u128, locked: u128) -> Option<u128> {
    if winners == 0 || shares > winners {
        return None;
    }
    Some(shares.checked_mul(locked)? / winners)
}

pub fn chance_micro(yes: u128, no: u128) -> u128 {
    match norm_sq(yes, no) {
        Some(0) | None => 500_000,
        Some(total) => yes * yes * 1_000_000 / total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const USD: u128 = 1_000_000;

    #[test]
    fn the_cost_is_the_length_of_the_share_vector() {
        assert_eq!((cost_floor(3, 4), cost_ceil(3, 4)), (Some(5), Some(5)));
        assert_eq!((cost_floor(1, 1), cost_ceil(1, 1)), (Some(1), Some(2)));
        assert_eq!((cost_floor(0, 0), cost_ceil(0, 0)), (Some(0), Some(0)));
    }

    #[test]
    fn the_first_buyer_of_an_empty_market_gets_a_share_per_unit_and_the_other_side_gets_more() {
        assert_eq!(buy(0, 0, 100 * USD), Some((100 * USD, 100 * USD)));
        let (no, _) = buy(0, 100 * USD, 100 * USD).unwrap();
        assert_eq!(no, (200 * USD * 200 * USD - 100 * USD * 100 * USD).isqrt());
        assert_eq!(chance_micro(0, 0), 500_000);
        assert_eq!(chance_micro(100 * USD, 0), 1_000_000);
        assert_eq!(chance_micro(3, 4), 360_000);
    }

    #[test]
    fn early_winners_are_diluted_by_late_money_but_never_below_what_they_paid() {
        let (alice, yes) = buy(0, 0, 100 * USD).unwrap();
        let (_, no) = buy(0, yes, 100 * USD).unwrap();
        let mut locked = 200 * USD;
        let (sniper, yes) = buy(yes, no, 100 * USD).unwrap();
        locked += 100 * USD;
        let alice_gets = winning_payout(alice, yes, locked).unwrap();
        let sniper_gets = winning_payout(sniper, yes, locked).unwrap();
        assert_eq!((alice_gets / USD, sniper_gets / USD), (122, 177));
        assert!(alice_gets >= 100 * USD && sniper_gets >= 100 * USD);
    }

    #[test]
    fn zero_oversize_and_overlarge_trades_are_refused() {
        assert_eq!(buy(10, 10, 0), None);
        assert_eq!(buy(0, 0, MAX_LOCKED + 1), None);
        assert_eq!(buy(0, 0, MAX_LOCKED), Some((MAX_LOCKED, MAX_LOCKED)));
        assert_eq!(sell(10, 10, 0), None);
        assert_eq!(sell(10, 10, 11), None);
        assert_eq!(winning_payout(1, 0, 10), None);
        assert_eq!(winning_payout(2, 1, 10), None);
    }

    #[test]
    fn a_buy_starts_from_the_cost_rounded_up_so_a_share_never_costs_more_than_a_unit() {
        assert_eq!(
            (cost_floor(1_000_000, 1), cost_ceil(1_000_000, 1)),
            (Some(1_000_000), Some(1_000_001))
        );
        assert_eq!(buy(1_000_000, 1, 500), Some((500, 1_000_500)));
    }

    #[test]
    fn the_fee_rounds_up_and_comes_out_of_the_amount_or_the_refund() {
        assert_eq!(fee(100 * USD, 200), Some(2 * USD));
        assert_eq!(fee(1, 200), Some(1));
        assert_eq!(fee(0, 200), Some(0));
        let (f, shares, grown) = buy_after_fee(0, 0, 100 * USD, 200).unwrap();
        assert_eq!((f, shares, grown), (2 * USD, 98 * USD, 98 * USD));
        let (f, refund, left) = sell_after_fee(98 * USD, 0, 98 * USD, 200).unwrap();
        assert_eq!((f, refund, left), (1_960_000, 98 * USD, 0));
    }

    fn apply(yes: &mut u128, no: &mut u128, locked: &mut u128, (buy_yes, amount, sell_pct): (bool, u128, u128)) {
        let (target, other) = if buy_yes { (*yes, *no) } else { (*no, *yes) };
        let next = if sell_pct == 0 {
            buy(target, other, amount).map(|(_, grown)| (grown, *locked + amount))
        } else {
            sell(target, other, target * sell_pct / 100).map(|(refund, left)| (left, *locked - refund))
        };
        if let Some((side, pool)) = next {
            if buy_yes {
                *yes = side;
            } else {
                *no = side;
            }
            *locked = pool;
        }
    }

    fn trade() -> impl Strategy<Value = (bool, u128, u128)> {
        (
            any::<bool>(),
            1u128..10_000 * USD,
            prop_oneof![Just(0u128), 1u128..=100],
        )
    }

    proptest! {
        #[test]
        fn the_pool_always_holds_at_least_its_cost(trades in proptest::collection::vec(trade(), 1..60)) {
            let (mut yes, mut no, mut locked) = (0, 0, 0);
            for t in trades {
                apply(&mut yes, &mut no, &mut locked, t);
                prop_assert!(locked >= cost_ceil(yes, no).unwrap(), "{} < cost of {} {}", locked, yes, no);
            }
        }

        #[test]
        fn a_round_trip_returns_what_was_paid_at_most_and_loses_two_units_at_most(
            trades in proptest::collection::vec(trade(), 0..30),
            amount in 1u128..10_000 * USD,
            buy_yes in any::<bool>(),
        ) {
            let (mut yes, mut no, mut locked) = (0, 0, 0);
            for t in trades {
                apply(&mut yes, &mut no, &mut locked, t);
            }
            let (target, other) = if buy_yes { (yes, no) } else { (no, yes) };
            let (shares, grown) = buy(target, other, amount).unwrap();
            let back = sell(grown, other, shares).map_or(0, |(refund, _)| refund);
            prop_assert!(back <= amount && amount - back <= 2, "paid {} got back {}", amount, back);
        }

        #[test]
        fn with_fees_a_round_trip_loses_at_least_both_fees(
            trades in proptest::collection::vec(trade(), 0..30),
            amount in 100u128..10_000 * USD,
        ) {
            let (mut yes, mut no, mut locked) = (0, 0, 0);
            for t in trades {
                apply(&mut yes, &mut no, &mut locked, t);
            }
            let (buy_fee, shares, grown) = buy_after_fee(yes, no, amount, 200).unwrap();
            if let Some((sell_fee, refund, _)) = sell_after_fee(grown, no, shares, 200) {
                prop_assert!(amount - (refund - sell_fee) >= buy_fee + sell_fee);
            }
        }

        #[test]
        fn a_winning_share_pays_back_at_least_what_it_cost(
            before in proptest::collection::vec(trade(), 0..30),
            after in proptest::collection::vec(trade(), 0..30),
            amount in 1u128..10_000 * USD,
            buy_yes in any::<bool>(),
        ) {
            let (mut yes, mut no, mut locked) = (0, 0, 0);
            for t in before {
                apply(&mut yes, &mut no, &mut locked, t);
            }
            let (target, other) = if buy_yes { (yes, no) } else { (no, yes) };
            let (shares, grown) = buy(target, other, amount).unwrap();
            prop_assert!(shares >= amount, "{} bought only {} shares", amount, shares);
            if buy_yes { yes = grown } else { no = grown }
            locked += amount;
            for (side, add, _) in after {
                apply(&mut yes, &mut no, &mut locked, (side, add, 0));
            }
            let winners = if buy_yes { yes } else { no };
            prop_assert!(winning_payout(shares, winners, locked).unwrap() >= amount);
        }

        #[test]
        fn winning_payouts_together_never_exceed_the_pool(
            holders in proptest::collection::vec((any::<bool>(), 1u128..10_000 * USD), 1..40),
            yes_wins in any::<bool>(),
        ) {
            let (mut yes, mut no, mut locked) = (0u128, 0u128, 0u128);
            let mut held = vec![];
            for (buy_yes, amount) in holders {
                let (target, other) = if buy_yes { (yes, no) } else { (no, yes) };
                let (shares, grown) = buy(target, other, amount).unwrap();
                if buy_yes { yes = grown } else { no = grown }
                locked += amount;
                held.push(if buy_yes { (shares, 0) } else { (0, shares) });
            }
            let winners = if yes_wins { yes } else { no };
            prop_assume!(winners > 0);
            let paid: u128 = held
                .iter()
                .map(|&(y, n)| winning_payout(if yes_wins { y } else { n }, winners, locked).unwrap())
                .sum();
            prop_assert!(paid <= locked, "paid {} out of {}", paid, locked);
            prop_assert!(locked - paid <= held.len() as u128, "{} left over from {}", locked - paid, locked);
        }
    }
}
