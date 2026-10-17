// Trading fees, the 25/75 sweep, and revenue shared among staked Council seats. Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::json;

fn tok(a: &Account) -> &str {
    a.id().as_str()
}

// The fee formula from spec section 4, with p = collateral / shares the trade's average price.
fn fee_shape(collateral: u128, shares: u128) -> u128 {
    (200 * collateral * (shares - collateral)).div_ceil(10_000 * shares)
}

async fn send_revenue(w: &World, amount: u128) -> anyhow::Result<()> {
    ft_call(w, &w.owner, w.council.id(), amount, "revenue").await
}

async fn waiting_revenue(w: &World) -> u128 {
    u(&w.council.view("config").await.unwrap().json::<serde_json::Value>().unwrap()["waiting_revenue"])
}

#[tokio::test]
async fn trades_pay_the_quoted_fee_and_redeem_and_withdraw_pay_none() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    assert_eq!(fees(&w).await, (CREATE_FEE, 0, 0), "the seed paid the creation fee");
    assert_eq!(u(&market_json(&w, id).await["locked"]), SEED - CREATE_FEE);

    // 10 USD at 50c: the whole amount would buy 19,082,568 shares, an average price of 0.524, so the fee is
    // 2% x 19,082,568 x 0.524 x 0.476 = 95,193 and the remaining 9,904,807 buys 18,908,779 shares.
    assert_eq!(quote_buy(&w, id, "yes", 10 * USD).await, (18_908_779, 95_193));
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    assert_eq!(shares(&w, id, w.alice.id()).await, (18_908_779, 0));
    assert_eq!(fees(&w).await.0, CREATE_FEE + 95_193);
    assert_eq!(u(&market_json(&w, id).await["locked"]), SEED - CREATE_FEE + 10 * USD - 95_193);
    assert!(invariant(&w, id).await);

    let (bob_shares, bob_fee) = quote_buy(&w, id, "no", 20 * USD).await;
    buy(&w, &w.bob, id, "no", 20 * USD).await?;
    assert_eq!(shares(&w, id, w.bob.id()).await, (0, bob_shares));
    assert_eq!(fees(&w).await.0, CREATE_FEE + 95_193 + bob_fee);
    assert!(invariant(&w, id).await);

    // Alice sells half. The quoted fee has the documented shape and is what she is charged.
    let (c, s, f) = quote_sell(&w, id, "yes", 18_908_779 / 2).await;
    assert_eq!(f, fee_shape(c, s));
    sell(&w, &w.alice, id, "yes", c, s).await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, c - f);
    assert_eq!(shares(&w, id, w.alice.id()).await.0, 18_908_779 - s);
    let collected = CREATE_FEE + 95_193 + bob_fee + f;
    assert_eq!(fees(&w).await.0, collected);
    assert!(invariant(&w, id).await);

    // Resolved Yes. Redeeming pays one unit a share and withdrawing moves the whole balance: no fee on either.
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;
    w.alice.call(w.market.id(), "redeem").args_json(json!({ "market_id": id.to_string() })).transact().await?.into_result()?;
    let balance = c - f + 18_908_779 - s;
    assert_eq!(market_balance(&w, w.alice.id()).await, balance);
    let before = ft_balance(&w, w.alice.id()).await;
    w.alice
        .call(w.market.id(), "withdraw")
        .args_json(json!({ "amount": balance.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(ft_balance(&w, w.alice.id()).await, before + balance);
    assert_eq!(fees(&w).await, (collected, 0, 0));
    assert!(invariant(&w, id).await);
    Ok(())
}

#[tokio::test]
async fn a_sweep_sends_25_percent_to_the_council_and_75_to_the_business_once() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    let collected = CREATE_FEE + 95_193;
    assert_eq!(collected % 4, 1, "neither share is a whole number of units");
    let (council_before, business_before) = (ft_balance(&w, w.council.id()).await, ft_balance(&w, w.business.id()).await);

    // Anyone can sweep. Both shares round down and the one unit left over stays collected.
    let logs = sweep(&w, &w.carol).await?.logs().iter().map(|l| l.to_string()).collect::<Vec<_>>();
    assert!(event_names(&logs).contains(&"fees_swept".to_string()));
    assert_eq!(ft_balance(&w, w.council.id()).await - council_before, 273_798);
    assert_eq!(ft_balance(&w, w.business.id()).await - business_before, 821_394);
    assert_eq!(fees(&w).await, (1, 0, 0));
    // The five staked seats share the Council's part.
    for j in &w.jurors {
        assert_eq!(pending_reward(&w, tok(j)).await, 273_798 / 5);
    }

    // Nothing new: a second sweep sends nothing and changes nothing.
    let logs = sweep(&w, &w.carol).await?.logs().iter().map(|l| l.to_string()).collect::<Vec<_>>();
    assert!(event_names(&logs).is_empty(), "{logs:?}");
    assert_eq!(ft_balance(&w, w.council.id()).await - council_before, 273_798);
    assert_eq!(ft_balance(&w, w.business.id()).await - business_before, 821_394);
    assert_eq!(fees(&w).await, (1, 0, 0));

    // A seat holder claims its share of the trading fees.
    let j = &w.jurors[0];
    register_ft(&w, j.id()).await?;
    claim(&w, j, tok(j)).await?;
    assert_eq!(ft_balance(&w, j.id()).await, 273_798 / 5);
    assert_eq!(pending_reward(&w, tok(j)).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_failed_business_transfer_stays_owed_to_the_business() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    // The business wallet moves to an account the token does not know, so its transfer fails.
    let new_wallet = w.worker.dev_create_account().await?;
    w.owner
        .call(w.market.id(), "set_fee_recipients")
        .args_json(json!({ "revenue_pool": w.council.id(), "business_wallet": new_wallet.id() }))
        .transact()
        .await?
        .into_result()?;
    let logs = sweep(&w, &w.carol).await?.logs().iter().map(|l| l.to_string()).collect::<Vec<_>>();
    assert!(event_names(&logs).contains(&"fee_transfer_failed".to_string()));
    assert_eq!(fees(&w).await, (1, 0, 821_394));

    // Once it can receive, the next sweep sends the business exactly its share and the Council nothing more.
    let council_before = ft_balance(&w, w.council.id()).await;
    register_ft(&w, new_wallet.id()).await?;
    sweep(&w, &w.carol).await?;
    assert_eq!(ft_balance(&w, new_wallet.id()).await, 821_394);
    assert_eq!(ft_balance(&w, w.council.id()).await, council_before);
    assert_eq!(fees(&w).await, (1, 0, 0));
    Ok(())
}

#[tokio::test]
async fn revenue_is_shared_by_the_seats_staked_when_it_arrives_and_leaves_with_the_staker() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors;
    for a in j {
        register_ft(&w, a.id()).await?;
    }
    leave(&w, &[&j[1], &j[2], &j[3], &j[4]]).await?;

    // One seat takes the whole event.
    send_revenue(&w, USD).await?;
    assert_eq!(pending_reward(&w, tok(&j[0])).await, USD);
    claim(&w, &j[0], tok(&j[0])).await?;
    assert_eq!(ft_balance(&w, j[0].id()).await, USD);
    assert_eq!(pending_reward(&w, tok(&j[0])).await, 0);
    refused(claim(&w, &j[0], tok(&j[0])).await, "nothing to claim");

    // Two seats split an odd amount, each rounded down.
    stake(&w, &j[1], tok(&j[1])).await?;
    send_revenue(&w, 1_000_001).await?;
    assert_eq!(pending_reward(&w, tok(&j[0])).await, 500_000);
    assert_eq!(pending_reward(&w, tok(&j[1])).await, 500_000);

    // A seat staked after an event gets none of it, then a third of the next one.
    stake(&w, &j[2], tok(&j[2])).await?;
    assert_eq!(pending_reward(&w, tok(&j[2])).await, 0);
    send_revenue(&w, 3 * USD).await?;
    assert_eq!(pending_reward(&w, tok(&j[2])).await, USD);
    assert_eq!(pending_reward(&w, tok(&j[0])).await, 500_000 + USD);

    // Unstaking pays the staker first, then returns the token.
    request_unstake(&w, &j[0], tok(&j[0])).await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    let before = ft_balance(&w, j[0].id()).await;
    assert_eq!(
        event_names(&unstake(&w, &j[0], tok(&j[0])).await?),
        vec!["ft_transfer", "revenue_claimed", "nft_transfer", "unstaked"]
    );
    assert_eq!(ft_balance(&w, j[0].id()).await, before + 500_000 + USD);
    assert_eq!(nft_owner(&w, tok(&j[0])).await, j[0].id().as_str());

    // The token is sold to Alice, who stakes it. It brings her nothing earned before.
    j[0].call(w.nft.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": w.alice.id(), "token_id": tok(&j[0]) }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    stake(&w, &w.alice, tok(&j[0])).await?;
    assert_eq!(pending_reward(&w, tok(&j[0])).await, 0);
    send_revenue(&w, 3 * USD).await?;
    assert_eq!(pending_reward(&w, tok(&j[0])).await, USD);
    assert_eq!(pending_reward(&w, tok(&j[1])).await, 500_000 + 2 * USD);
    Ok(())
}

#[tokio::test]
async fn revenue_that_arrives_with_no_seats_waits_for_the_next_revenue() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors;
    leave(&w, &[&j[0], &j[1], &j[2], &j[3], &j[4]]).await?;
    send_revenue(&w, USD).await?;
    assert_eq!(waiting_revenue(&w).await, USD);
    assert_eq!(ft_balance(&w, w.council.id()).await, USD, "the Council kept it");

    stake(&w, &j[0], tok(&j[0])).await?;
    assert_eq!(pending_reward(&w, tok(&j[0])).await, 0, "staking does not collect what waited");
    send_revenue(&w, 2 * USD).await?;
    assert_eq!(pending_reward(&w, tok(&j[0])).await, 3 * USD);
    assert_eq!(waiting_revenue(&w).await, 0);
    Ok(())
}

#[tokio::test]
async fn only_the_staker_claims_and_a_failed_payout_stays_claimable() -> anyhow::Result<()> {
    let w = setup().await?;
    let j = &w.jurors;
    send_revenue(&w, USD).await?;
    assert_eq!(pending_reward(&w, tok(&j[0])).await, USD / 5);
    refused(claim(&w, &w.alice, tok(&j[0])).await, "not your seat");
    refused(claim(&w, &w.alice, "nothing").await, "not staked");

    // j0 cannot receive the token yet, so the payout fails and the claim is restored.
    let logs = claim(&w, &j[0], tok(&j[0])).await?;
    assert_eq!(event_names(&logs), vec!["revenue_claimed", "claim_failed"]);
    assert_eq!(pending_reward(&w, tok(&j[0])).await, USD / 5);
    register_ft(&w, j[0].id()).await?;
    claim(&w, &j[0], tok(&j[0])).await?;
    assert_eq!(ft_balance(&w, j[0].id()).await, USD / 5);

    // The same for an unstake: the payout fails, so the seat stays staked with what it earned. Erin stakes
    // after the first revenue, so her seat is owed only its sixth of the second.
    let erin = w.worker.dev_create_account().await?;
    mint_nft(&w, &erin, "erins").await?;
    stake(&w, &erin, "erins").await?;
    request_unstake(&w, &erin, "erins").await?;
    refused(claim(&w, &erin, "erins").await, "an unstake is requested, and unstaking pays what the seat earned");
    send_revenue(&w, 6 * USD).await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    let before = stake_of(&w, "erins").await;
    assert_eq!(event_names(&unstake(&w, &erin, "erins").await?), vec!["unstake_failed"]);
    assert_eq!(stake_of(&w, "erins").await, before);
    assert_eq!(pending_reward(&w, "erins").await, USD);
    assert_eq!(nft_owner(&w, "erins").await, w.council.id().as_str());
    register_ft(&w, erin.id()).await?;
    assert_eq!(event_names(&unstake(&w, &erin, "erins").await?), vec!["ft_transfer", "revenue_claimed", "nft_transfer", "unstaked"]);
    assert_eq!(ft_balance(&w, erin.id()).await, USD);
    Ok(())
}
