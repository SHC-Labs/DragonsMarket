// Economics of the oracle bond: what a wrong answer, a challenge, a sybil pair and a bought jury net against the money a market
// holds. Real contracts, sandbox chain, 6-decimal USDC, default bond here is 5 USDC and a decided dispute pays the jurors 25% of
// the loser's bond. Run with --nocapture for the ledgers.
mod common;
use common::*;
use near_workspaces::Account;

fn usd(v: i128) -> f64 {
    v as f64 / USD as f64
}

const HONEST_NO: u128 = 150 * USD;
const ATTACK_YES: u128 = 20 * USD;

// A market closing in 120 s where alice (honest, 150 on No) and the attacker bob (20 on Yes) have traded. Returns its id.
async fn target(w: &World) -> anyhow::Result<u64> {
    let id = new_market(w, 120).await?;
    buy(w, &w.alice, id, "no", HONEST_NO).await?;
    buy(w, &w.bob, id, "yes", ATTACK_YES).await?;
    Ok(id)
}

async fn redeem(w: &World, who: &Account, id: u64) -> anyhow::Result<u128> {
    let before = market_balance(w, who.id()).await;
    who.call(w.market.id(), "redeem")
        .args_json(serde_json::json!({ "market_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    Ok(market_balance(w, who.id()).await - before)
}

async fn locked(w: &World, id: u64) -> u128 {
    u(&market_json(w, id).await["locked"])
}

// Everything the attacker bob ends with from the market and the oracle, less what he put in (the position and the bond).
async fn bob_net(w: &World, id: u64, bond_put_in: u128) -> anyhow::Result<i128> {
    let payout = redeem(w, &w.bob, id).await.unwrap_or(0);
    let bond_back = claimable(w, w.bob.id()).await;
    Ok(payout as i128 + bond_back as i128 - ATTACK_YES as i128 - bond_put_in as i128)
}

#[tokio::test]
async fn a_wrong_answer_nobody_challenges_pays_far_more_than_the_bond_it_risks() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.bob.id(), 100 * USD).await?;
    let id = target(&w).await?;
    let held = locked(&w, id).await;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.bob, id, "yes").await?; // the truth is No: alice holds the honest side
    skip_secs(&w.worker, PAST_WINDOW_SECS).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "yes");
    let net = bob_net(&w, id, BOND).await?;
    println!(
        "UNCHALLENGED LIE: market holds {:.2}, bob risks {:.2} on Yes + {:.2} bond, ends {:+.2} USDC (M/B = {:.1})",
        usd(held as i128),
        usd(ATTACK_YES as i128),
        usd(BOND as i128),
        usd(net),
        held as f64 / BOND as f64
    );
    assert!(net > 100 * USD as i128, "the wrong answer took most of alice's money");
    Ok(())
}

#[tokio::test]
async fn a_wrong_answer_that_an_honest_jury_overturns_loses_the_bond_and_the_position() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.bob.id(), 100 * USD).await?;
    mint(&w, w.carol.id(), 20 * USD).await?;
    let id = target(&w).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.bob, id, "yes").await?;
    challenge(&w, &w.carol, id).await?;
    let jury = draw_jury(&w, id).await?;
    for j in &jury[..MAJORITY] {
        commit(&w, j, id, "no", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..MAJORITY] {
        reveal(&w, j, id, "no", "s", "The source says no.").await?;
    }
    assert_eq!(market_json(&w, id).await["outcome"], "no");
    let (carol, j0) = (claimable(&w, w.carol.id()).await, claimable(&w, jury[0].id()).await);
    let net = bob_net(&w, id, BOND).await?;
    println!(
        "CHALLENGED LIE, HONEST JURY: bob {:+.2} (position {:.2} + bond {:.2} lost); challenger carol nets {:+.2} on the bond; \
         each of three jurors earns {:.4}",
        usd(net),
        usd(ATTACK_YES as i128),
        usd(BOND as i128),
        usd(carol as i128 - BOND as i128),
        usd(j0 as i128)
    );
    assert_eq!(net, -((ATTACK_YES + BOND) as i128));
    assert_eq!(carol, 2 * BOND - MAJORITY as u128 * JUROR_PAY);
    Ok(())
}

#[tokio::test]
async fn a_bought_jury_wins_whatever_the_bond_is_so_the_bond_only_prices_the_bribe_floor() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.bob.id(), 100 * USD).await?;
    mint(&w, w.carol.id(), 20 * USD).await?;
    let id = target(&w).await?;
    let held = locked(&w, id).await;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.bob, id, "yes").await?;
    challenge(&w, &w.carol, id).await?;
    let jury = draw_jury(&w, id).await?;
    // The draw is public the moment it lands (the jury_drawn event), and the commit phase is half the panel time. Three
    // bribed jurors out of five commit and reveal Yes. Nothing on chain tells a bought vote from an honest one.
    for j in &jury[..MAJORITY] {
        commit(&w, j, id, "yes", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..MAJORITY] {
        reveal(&w, j, id, "yes", "s", "The source says yes.").await?;
    }
    assert_eq!(
        market_json(&w, id).await["outcome"],
        "yes",
        "a decided round has no appeal"
    );
    let juror_pay = claimable(&w, jury[0].id()).await;
    let net_before_bribes = bob_net(&w, id, BOND).await?;
    // The bribed jurors are also paid by the oracle, from the challenger's bond.
    let max_bribe_each = net_before_bribes / MAJORITY as i128;
    println!(
        "BOUGHT JURY: market held {:.2}; bob nets {:+.2} before bribes; he can pay each of 3 jurors up to {:.2} and still profit \
         (the oracle already pays each {:.4} for the same vote; bond {:.2})",
        usd(held as i128),
        usd(net_before_bribes),
        usd(max_bribe_each),
        usd(juror_pay as i128),
        usd(BOND as i128)
    );
    assert!(net_before_bribes > 100 * USD as i128);
    assert!(
        juror_pay < USD,
        "an honest juror's pay for a decided case is under one USDC at the default bond"
    );
    Ok(())
}

// The challenger who forces a Void on a correct answer, holding the losing side: what it costs and what it returns.
#[tokio::test]
async fn forcing_a_void_on_a_correct_answer_costs_the_bond_and_returns_the_losing_stake() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.dave.id(), 100 * USD).await?;
    mint(&w, w.carol.id(), 20 * USD).await?;
    w.dave
        .call(w.market.id(), "storage_deposit")
        .args_json(serde_json::json!({}))
        .deposit(near_workspaces::types::NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    let id = new_market(&w, 120).await?;
    // Honest alice holds Yes and the truth is Yes. dave holds a 100 USDC losing No position.
    buy(&w, &w.alice, id, "yes", 100 * USD).await?;
    buy(&w, &w.dave, id, "no", 100 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let _jury = draw_jury(&w, id).await?; // seated, and nobody votes
    let case = case_json(&w, id).await;
    skip_until(&w, case["panel_deadline"].as_str().unwrap().parse()?).await;
    skip_secs(&w.worker, 1).await;
    finalize(&w, id).await?; // escalates to eleven, which five seats cannot make
    wait_for_draw(&w, id).await;
    assert_eq!(event_names(&resolve_draw(&w, id).await?), vec!["draw_failed"]);
    let draw_by: u64 = case_json(&w, id).await["draw_by"].as_str().unwrap().parse()?;
    skip_until(&w, draw_by + 1).await;
    finalize(&w, id).await?;
    assert_eq!(market_json(&w, id).await["outcome"], "void");
    let refund = redeem(&w, &w.dave, id).await?;
    let bond_back = claimable(&w, w.dave.id()).await;
    let alice_refund = redeem(&w, &w.alice, id).await?;
    let net = refund as i128 + bond_back as i128 - 100 * USD as i128 - BOND as i128;
    let without = -100 * USD as i128;
    println!(
        "FORCED VOID (jury seated, silent): dave's refund {:.2}, bond back {:.2}, net {:+.2} vs {:+.2} had the correct answer stood; \
         honest alice gets {:.2} back instead of the winning payout",
        usd(refund as i128),
        usd(bond_back as i128),
        usd(net),
        usd(without),
        usd(alice_refund as i128)
    );
    assert!(net > without, "voiding beats losing the position");
    Ok(())
}

// Sybil proposer + challenger, honest jury decides for the proposer: the pair only pays the jurors.
#[tokio::test]
async fn a_sybil_pair_cycling_bonds_pays_the_jury_and_gains_nothing() -> anyhow::Result<()> {
    let w = setup().await?;
    mint(&w, w.carol.id(), 20 * USD).await?;
    mint(&w, w.dave.id(), 20 * USD).await?;
    let id = new_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    for j in &jury[..MAJORITY] {
        commit(&w, j, id, "yes", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..MAJORITY] {
        reveal(&w, j, id, "yes", "s", "ok").await?;
    }
    let back = claimable(&w, w.carol.id()).await + claimable(&w, w.dave.id()).await;
    let net = back as i128 - 2 * BOND as i128;
    println!(
        "SYBIL PAIR: puts in {:.2}, gets back {:.2}, net {:+.4} (= 25% of one bond rounded down, all of it paid to the jury)",
        usd(2 * BOND as i128),
        usd(back as i128),
        usd(net)
    );
    assert_eq!(net, -(MAJORITY as i128 * JUROR_PAY as i128));
    Ok(())
}
