// Economics of Up/Down rounds: what a trader with the public live price can do in the last allowed minute, the cost of staking both
// sides, the empty-side refund, pool skew and the 3% fee. A mirror of rounds::Round (take, fee, payout) on top of the dpm maths,
// so no chain is involved: COMPUTED FROM CODE, NOT RUN against the wasm. Run with --nocapture for the tables.
const USD: u128 = 1_000_000;
const FEE_BPS: u128 = 300;
const MIN_STAKE: u128 = 100_000;

fn cost_ceil(y: u128, n: u128) -> u128 {
    let sq = y * y + n * n;
    let r = sq.isqrt();
    if r * r == sq {
        r
    } else {
        r + 1
    }
}

fn dpm_buy(t: u128, o: u128, a: u128) -> (u128, u128) {
    let b = cost_ceil(t, o) + a;
    let g = (b * b - o * o).isqrt();
    (g - t, g)
}

#[derive(Clone, Default)]
struct Round {
    up: u128,
    down: u128,
    paid_up: u128,
    paid_down: u128,
}

impl Round {
    fn stake(&mut self, up: bool, amount: u128) -> u128 {
        let (t, o) = if up { (self.up, self.down) } else { (self.down, self.up) };
        let (shares, grown) = dpm_buy(t, o, amount);
        if up {
            self.up = grown;
            self.paid_up += amount;
        } else {
            self.down = grown;
            self.paid_down += amount;
        }
        shares
    }

    // The winning side's holders split the pool less 3% of what the losing side paid, never taking the pool below one unit per
    // winning share. A one-sided round refunds everyone.
    fn fee(&self, up_wins: bool) -> u128 {
        let (winners, loser_paid) = if up_wins { (self.up, self.paid_down) } else { (self.down, self.paid_up) };
        let pool = self.paid_up + self.paid_down;
        (loser_paid * FEE_BPS / 10_000).min(pool.saturating_sub(winners))
    }

    fn payout(&self, shares: u128, up_wins: bool) -> u128 {
        if self.up == 0 || self.down == 0 {
            return 0; // callers use the refund instead
        }
        let pool = self.paid_up + self.paid_down - self.fee(up_wins);
        let winners = if up_wins { self.up } else { self.down };
        shares * pool / winners
    }

    // Implied chance of Up in millionths, as the market's chance_micro shows it.
    fn chance_up(&self) -> f64 {
        if self.up == 0 && self.down == 0 {
            return 0.5;
        }
        (self.up as f64).powi(2) / ((self.up as f64).powi(2) + (self.down as f64).powi(2))
    }
}

fn usd(v: f64) -> f64 {
    v / USD as f64
}

// P(a staker who bets the side the price already favours wins), when stakes close `l` seconds before an interval of `t` seconds ends
// and the price walks as Brownian motion: 1/2 + arctan(sqrt((t - l) / l)) / pi.
fn favourite_wins(t: f64, l: f64) -> f64 {
    0.5 + ((t - l) / l).sqrt().atan() / std::f64::consts::PI
}

#[test]
fn what_the_live_price_is_worth_in_the_last_minute() {
    println!("series interval | close_before | a staker who backs the side the price already favours wins");
    for (t, l) in [(120.0, 60.0), (300.0, 60.0), (300.0, 150.0), (900.0, 60.0), (3_600.0, 60.0), (3_600.0, 1_800.0)] {
        println!("{t:>8}s | {l:>6}s | {:.1}%", 100.0 * favourite_wins(t, l));
    }
    assert!(favourite_wins(300.0, 60.0) > 0.85);
    assert!((favourite_wins(300.0, 150.0) - 0.75).abs() < 1e-9, "at the hard maximum of half the interval, still 75%");

    // Edge in money. Crowd: 1,000 USDC on Up first, 1,000 on Down second (the order matters: see below). A late staker backs Up with
    // probability p. EV is p times the payout minus the stake.
    println!("\nlate staker x on Up into a crowd that staked 1000 Up then 1000 Down; implied chance of Up before = 25%");
    println!("p     | x=10 EV%  | x=100 EV% | x=1000 EV%");
    for p in [0.5, 0.6, 0.75, 0.85, 0.96] {
        let mut row = format!("{p:.2}  ");
        for x in [10 * USD, 100 * USD, 1_000 * USD] {
            let mut r = Round::default();
            r.stake(true, 1_000 * USD);
            r.stake(false, 1_000 * USD);
            let sh = r.stake(true, x);
            let ev = p * r.payout(sh, true) as f64 - x as f64;
            row += &format!("| {:>+8.1}% ", 100.0 * ev / x as f64);
        }
        println!("{row}");
    }

    // The same bet when the crowd has already priced the move: Up 1,800 / Down 200 in money. The edge is the gap between p and the
    // implied chance, so a crowd that reads the same feed removes it.
    println!("\nsame late stake of 100 at p=0.85, crowd already leaning Up (money Up/Down):");
    for (a, b) in [(1_000u128, 1_000u128), (1_500, 500), (1_800, 200), (1_900, 100)] {
        let mut r = Round::default();
        r.stake(false, b * USD);
        r.stake(true, a * USD);
        let before = r.chance_up();
        let sh = r.stake(true, 100 * USD);
        let ev = 0.85 * r.payout(sh, true) as f64 - 100.0 * USD as f64;
        println!("{a}/{b} (Down staked first): chance of Up before {:.0}%  EV {:+.1}%", 100.0 * before, ev / USD as f64);
    }
}

#[test]
fn the_cheap_ticket_on_the_thin_side_of_a_lopsided_pool() {
    // A crowd stakes only Up. With no Down shares the round would refund everybody. One minimum stake on Down turns it into a live
    // round whose Down shares are almost free, and if Down wins the ticket takes the whole Up pool less 3%.
    println!("crowd only on Up | ticket on Down | win payout | EV at p(Down)=50% | EV at 15%");
    for crowd in [100u128, 1_000, 10_000, 100_000] {
        let mut r = Round::default();
        r.stake(true, crowd * USD);
        let sh = r.stake(false, MIN_STAKE);
        let win = r.payout(sh, false) as f64;
        let ev = |p: f64| p * win - MIN_STAKE as f64;
        println!(
            "{crowd:>9} | {:.1} | {:>10.2} | {:>+10.2} | {:>+8.2}",
            usd(MIN_STAKE as f64),
            usd(win),
            usd(ev(0.5)),
            usd(ev(0.15))
        );
        assert!(ev(0.5) > 0.0);
        // What the crowd would have had without the ticket: its money back. With it, at p=0.5, it expects half.
        let up_expected = 0.5 * r.payout(r.up, true) as f64;
        assert!(up_expected < (crowd * USD + MIN_STAKE) as f64 * 0.51);
    }
}

#[test]
fn staking_both_sides_with_two_wallets_only_pays_the_fee_on_the_loser() {
    // Wallet A on Up, wallet B on Down, same owner. Whatever wins the pair gets the pool less 3% of the loser's stake.
    println!("A up | B down | pair puts in | gets back if Up wins | if Down wins | cost");
    for (a, b) in [(1_000u128, 1_000u128), (1_000, 100), (100, 1_000)] {
        let mut r = Round::default();
        let sa = r.stake(true, a * USD);
        let sb = r.stake(false, b * USD);
        let up = r.payout(sa, true);
        let down = r.payout(sb, false);
        let put = (a + b) * USD;
        println!("{a:>5} | {b:>6} | {:>8.2} | {:>8.2} | {:>8.2} | {:>6.2}", usd(put as f64), usd(up as f64), usd(down as f64), usd((put - up.min(down)) as f64));
        assert!(up <= put && down <= put, "no riskless profit from holding both sides");
        assert!(put - up.min(down) <= put * 3 / 100);
    }
}

#[test]
fn the_order_of_the_first_two_stakes_moves_the_price_and_an_empty_side_refunds() {
    // Equal money, opposite order: whoever staked first holds fewer shares per unit.
    let mut r = Round::default();
    let first = r.stake(true, 1_000 * USD);
    let second = r.stake(false, 1_000 * USD);
    println!(
        "1000 Up first gets {} shares, 1000 Down second gets {}; chance of Up now {:.0}%; a winner's multiple: Up {:.2}x, Down {:.2}x",
        first / USD,
        second / USD,
        100.0 * r.chance_up(),
        r.payout(first, true) as f64 / (1_000 * USD) as f64,
        r.payout(second, false) as f64 / (1_000 * USD) as f64
    );
    assert!(second > first);
    // 3% fee on the losing side and what it does to a winner's multiple.
    let fee = r.fee(true);
    println!("fee if Up wins: {:.2} (3% of the Down side's {:.0})", usd(fee as f64), usd(r.paid_down as f64));
    assert_eq!(fee, 30 * USD);
    // A round with one side empty is refunded in full at no fee (rounds::Round::decide, reason one_sided). So a lone big stake is safe
    // until someone takes the other side, and the cheapest way to take it is the minimum stake above.
}
