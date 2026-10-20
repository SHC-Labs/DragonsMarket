// The methods that send calls of their own refuse early, with the amount to attach, when given less gas than they reserve.
// Each floor is checked against the worst case this suite can build. Real contracts, sandbox chain.
mod common;
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::json;

const SETTLE_REASON: &str = "a call that settles a case sends the answer to the market and releases the juries";

// Every receipt of the call went through, not only the first.
fn assert_clean(label: &str, r: &ExecutionFinalResult) {
    assert!(
        r.is_success() && r.failures().is_empty(),
        "{label} had a failing receipt: {:?}",
        r.failures()
    );
}

fn burned_by(r: &ExecutionFinalResult, contract: &near_workspaces::AccountId) -> f64 {
    r.outcomes()
        .iter()
        .filter(|o| &o.executor_id == contract)
        .map(|o| o.gas_burnt.as_gas() as f64 / 1e12)
        .fold(0.0, f64::max)
}

async fn more_jurors(w: &World, n: usize) -> anyhow::Result<Vec<Account>> {
    let mut all: Vec<Account> = w.jurors.clone();
    while all.len() < n {
        let a = w.worker.dev_create_account().await?;
        mint_nft(w, &a, a.id().as_str()).await?;
        stake(w, &a, a.id().as_str()).await?;
        all.push(a);
    }
    Ok(all)
}

async fn panel_of(w: &World, all: &[Account], id: u64) -> Vec<Account> {
    case_json(w, id).await["panel"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| {
            all.iter()
                .find(|a| a.id().as_str() == j.as_str().unwrap())
                .unwrap()
                .clone()
        })
        .collect()
}

async fn finalize_with(w: &World, id: u64, tgas: u64) -> anyhow::Result<ExecutionFinalResult> {
    Ok(w.bob
        .call(w.oracle.id(), "finalize")
        .args_json(json!({ "market_id": id.to_string() }))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

async fn reveal_with(w: &World, j: &Account, id: u64, salt: &str, tgas: u64) -> anyhow::Result<ExecutionFinalResult> {
    Ok(j.call(w.oracle.id(), "reveal_vote")
        .args_json(json!({ "market_id": id.to_string(), "outcome": "no", "salt": salt, "reason": "r".repeat(1000) }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

async fn draw_with(w: &World, id: u64, tgas: u64) -> anyhow::Result<ExecutionFinalResult> {
    wait_for_draw(w, id).await;
    Ok(w.bob
        .call(w.oracle.id(), "resolve_draw")
        .args_json(json!({ "market_id": id.to_string() }))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

// A challenged case whose first jury of 11 said nothing, so a second jury of 21 is drawn: the largest case there is, with
// the first jury still held. Returns the market id and the second jury.
async fn second_round_of_21(w: &World, all: &[Account]) -> anyhow::Result<(u64, Vec<Account>)> {
    let id = create_seeded_market(w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(w, &w.carol, id, "yes").await?;
    challenge(w, &w.dave, id).await?;
    draw_with(w, id, 300).await?.into_result()?;
    assert_eq!(panel_of(w, all, id).await.len(), 11);
    skip_until(
        w,
        case_json(w, id).await["panel_deadline"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 1_000_000_000,
    )
    .await;
    finalize_with(w, id, 100).await?.into_result()?;
    draw_with(w, id, 300).await?.into_result()?;
    let second = panel_of(w, all, id).await;
    assert_eq!(second.len(), 21);
    Ok((id, second))
}

async fn assert_all_released(w: &World, jurors: &[Account]) {
    for j in jurors {
        assert!(
            stake_of(w, j.id().as_str()).await["serving"].is_null(),
            "{} is still held",
            j.id()
        );
    }
}

// The 11th reveal of a second jury of 21 settles the case: the answer to the market and the release of both juries. The
// 10th juror of the other case is short of a majority, and finalize settles that one with 22 jurors at fault.
#[tokio::test]
async fn the_settling_floor_covers_the_largest_case_there_is() -> anyhow::Result<()> {
    let w = setup().await?;
    let all = more_jurors(&w, 34).await?;
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": 11 }))
        .transact()
        .await?
        .into_result()?;

    // Too little gas for the draw is refused with the amount, and the case is not changed.
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let r = draw_with(&w, id, 274).await?;
    refused(
        r.into_result(),
        "attach at least 275 TGas: the jury draw reads every staked seat",
    );
    assert!(case_json(&w, id).await["panel"].as_array().unwrap().is_empty());
    let r = draw_with(&w, id, 275).await?;
    assert_clean("resolve_draw at its floor", &r);
    println!(
        "resolve_draw: floor 275, oracle burnt {:.1} TGas, {} TGas in all",
        burned_by(&r, w.oracle.id()),
        r.total_gas_burnt.as_tgas()
    );
    let first = panel_of(&w, &all, id).await;
    assert_eq!(first.len(), 11);

    // Reveal that settles, at the floor.
    skip_until(
        &w,
        case_json(&w, id).await["panel_deadline"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 1_000_000_000,
    )
    .await;
    finalize_with(&w, id, 100).await?.into_result()?;
    draw_with(&w, id, 300).await?.into_result()?;
    let second = panel_of(&w, &all, id).await;
    assert_eq!(second.len(), 21);
    for (i, j) in second.iter().enumerate() {
        commit(&w, j, id, "no", &format!("salt-{i}")).await?;
    }
    to_reveal_phase(&w, id).await;
    for (i, j) in second.iter().enumerate().take(10) {
        reveal_with(&w, j, id, &format!("salt-{i}"), 100).await?.into_result()?;
    }
    let last = &second[10];
    refused(
        reveal_with(&w, last, id, "salt-10", 79).await?.into_result(),
        &format!("attach at least 80 TGas: {SETTLE_REASON}"),
    );
    assert_eq!(
        case_json(&w, id).await["stage"],
        "disputed",
        "a refused reveal changed nothing"
    );
    assert_eq!(case_json(&w, id).await["votes"].as_array().unwrap().len(), 10);
    let r = reveal_with(&w, last, id, "salt-10", 80).await?;
    assert_clean("the settling reveal at its floor", &r);
    println!(
        "reveal_vote that settles round 1 of 21: floor 80, oracle burnt {:.1} TGas, {} TGas in all",
        burned_by(&r, w.oracle.id()),
        r.total_gas_burnt.as_tgas()
    );
    assert_eq!(case_json(&w, id).await["stage"], "final");
    assert_eq!(
        market_json(&w, id).await["outcome"],
        "no",
        "the answer reached the market"
    );
    assert_all_released(&w, &all).await;

    // Releasing the juries again after a second round: each of the two releases gets half of what is attached.
    let retry = |tgas: u64| {
        w.bob
            .call(w.oracle.id(), "retry_unlock")
            .args_json(json!({ "market_id": id.to_string() }))
            .gas(Gas::from_tgas(tgas))
            .transact()
    };
    refused(
        retry(34).await?.into_result(),
        "attach at least 35 TGas: each jury's release gets an equal share of what is attached",
    );
    assert_clean("retry_unlock after a second round", &retry(35).await?);

    // Finalize that settles a no-decision with 10 revealed and 22 jurors at fault, at the floor.
    let (id, second) = second_round_of_21(&w, &all).await?;
    for (i, j) in second.iter().enumerate().take(20) {
        commit(&w, j, id, "no", &format!("salt-{i}")).await?;
    }
    to_reveal_phase(&w, id).await;
    for (i, j) in second.iter().enumerate().take(10) {
        reveal_with(&w, j, id, &format!("salt-{i}"), 100).await?.into_result()?;
    }
    assert_eq!(case_json(&w, id).await["stage"], "disputed");
    skip_until(
        &w,
        case_json(&w, id).await["panel_deadline"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 1_000_000_000,
    )
    .await;
    refused(
        finalize_with(&w, id, 79).await?.into_result(),
        &format!("attach at least 80 TGas: {SETTLE_REASON}"),
    );
    assert_eq!(case_json(&w, id).await["stage"], "disputed");
    let r = finalize_with(&w, id, 80).await?;
    assert_clean("finalize at its floor", &r);
    println!("finalize that settles a no-decision, 10 revealed, 22 at fault: floor 80, oracle burnt {:.1} TGas, {} TGas in all", burned_by(&r, w.oracle.id()), r.total_gas_burnt.as_tgas());
    assert_eq!(case_json(&w, id).await["stage"], "final");
    assert_all_released(&w, &all).await;
    Ok(())
}

// A seat that a failed unlock left held is freed by a retry that carries only the floor.
#[tokio::test]
async fn a_retry_with_exactly_the_floor_frees_a_seat_a_failed_unlock_left_held() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    challenge(&w, &w.dave, id).await?;
    let jury = draw_jury(&w, id).await?;
    for j in &jury[..2] {
        commit(&w, j, id, "no", "s").await?;
    }
    to_reveal_phase(&w, id).await;
    for j in &jury[..2] {
        reveal(&w, j, id, "no", "s", "The source says no.").await?;
    }
    let token = jury[2].id().to_string();
    relock_seat(&w, &token, id).await?;
    let retry = |tgas: u64| {
        w.dave
            .call(w.oracle.id(), "retry_unlock")
            .args_json(json!({ "market_id": id.to_string() }))
            .gas(Gas::from_tgas(tgas))
            .transact()
    };
    refused(retry(34).await?.into_result(), "attach at least 35 TGas");
    assert_eq!(
        stake_of(&w, &token).await["serving"],
        id.to_string(),
        "a refused retry changed nothing"
    );
    assert_clean("retry_unlock at its floor", &retry(35).await?);
    assert!(stake_of(&w, &token).await["serving"].is_null());
    Ok(())
}

#[tokio::test]
async fn the_sweep_the_claim_and_the_unstake_refuse_less_than_their_floors_and_work_with_exactly_that(
) -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;

    let sweep_with = |tgas: u64| {
        w.carol
            .call(w.market.id(), "sweep_fees")
            .gas(Gas::from_tgas(tgas))
            .transact()
    };
    refused(
        sweep_with(94).await?.into_result(),
        "attach at least 95 TGas: a sweep sends the Council its part and the business wallet its part",
    );
    assert_eq!(fees(&w).await.0, CREATE_FEE + 95_193, "a refused sweep changed nothing");
    let r = sweep_with(95).await?;
    assert_clean("sweep_fees at its floor", &r);
    println!(
        "sweep_fees: floor 95, market burnt {:.1} TGas, {} TGas in all",
        burned_by(&r, w.market.id()),
        r.total_gas_burnt.as_tgas()
    );
    assert_eq!(fees(&w).await, (1, 0, 0));
    assert_eq!(ft_balance(&w, w.business.id()).await, 821_394);

    let j = &w.jurors[0];
    register_ft(&w, j.id()).await?;
    let token = j.id().to_string();
    send_revenue(&w, 100 * USD).await?;
    skip_secs(&w.worker, 20).await;
    let claim_with = |tgas: u64| {
        j.call(w.council.id(), "claim")
            .args_json(json!({ "token_id": token }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(tgas))
            .transact()
    };
    refused(
        claim_with(32).await?.into_result(),
        "attach at least 33 TGas: a claim sends the payout and then settles it",
    );
    let r = claim_with(33).await?;
    assert_clean("claim at its floor", &r);
    println!(
        "claim: floor 33, council burnt {:.1} TGas, {} TGas in all",
        burned_by(&r, w.council.id()),
        r.total_gas_burnt.as_tgas()
    );
    assert!(ft_balance(&w, j.id()).await > 0);

    request_unstake(&w, j, &token).await?;
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    let unstake_with = |tgas: u64| {
        j.call(w.council.id(), "unstake")
            .args_json(json!({ "token_id": token }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(tgas))
            .transact()
    };
    refused(
        unstake_with(57).await?.into_result(),
        "attach at least 58 TGas: an unstake pays what the seat earned and then returns the NFT",
    );
    assert!(is_seat(&w, j.id()).await, "a refused unstake changed nothing");
    let r = unstake_with(58).await?;
    assert_clean("unstake at its floor", &r);
    println!(
        "unstake: floor 58, council burnt {:.1} TGas, {} TGas in all",
        burned_by(&r, w.council.id()),
        r.total_gas_burnt.as_tgas()
    );
    assert!(!is_seat(&w, j.id()).await);
    assert_eq!(nft_owner(&w, &token).await, j.id().to_string());
    Ok(())
}

#[tokio::test]
async fn the_deadline_answer_refuses_less_than_the_settling_floor() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market_gap(&w, 120, 600).await?;
    skip_secs(&w.worker, 120 + 600 + 10).await;
    let call = |tgas: u64| {
        w.dave
            .call(w.oracle.id(), "resolve_by_deadline")
            .args_json(json!({ "market_id": id.to_string() }))
            .gas(Gas::from_tgas(tgas))
            .transact()
    };
    refused(
        call(79).await?.into_result(),
        &format!("attach at least 80 TGas: {SETTLE_REASON}"),
    );
    assert_eq!(market_json(&w, id).await["outcome"], serde_json::Value::Null);
    assert_clean("resolve_by_deadline at its floor", &call(80).await?);
    assert_eq!(market_json(&w, id).await["outcome"], "void");
    Ok(())
}
