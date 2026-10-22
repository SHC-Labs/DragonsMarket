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

async fn council_total_received(w: &World) -> u128 {
    let t: String = w.council.view("total_received").await.unwrap().json().unwrap();
    t.parse().unwrap()
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
        sweep_with(86).await?.into_result(),
        "attach at least 87 TGas: a sweep sends the Council its part and the business wallet its part",
    );
    assert_eq!(fees(&w).await.0, CREATE_FEE + 95_193, "a refused sweep changed nothing");
    let r = sweep_with(87).await?;
    assert_clean("sweep_fees at its floor", &r);
    println!(
        "sweep_fees: floor 87, market burnt {:.1} TGas, {} TGas in all",
        burned_by(&r, w.market.id()),
        r.total_gas_burnt.as_tgas()
    );
    assert_eq!(fees(&w).await, (1, 0, 0));
    assert_eq!(
        intents_balance(&w, w.business.id()).await,
        821_394,
        "the business share arrived at the floor"
    );
    assert_eq!(
        council_total_received(&w).await,
        273_798,
        "and so did the Council's, so its receipt got the gas it needs at the floor"
    );

    let j = &w.jurors[0];
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
    assert!(holdings(&w, j.id()).await > 0);

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

// A bond withdrawal sends the payout and then settles it. Its floor is what it reserves for those, 15 TGas for the verifier's
// mt_transfer and 10 for the callback, and 8 for its own work.
#[tokio::test]
async fn a_bond_withdrawal_refuses_less_than_its_floor_and_works_with_exactly_that() -> anyhow::Result<()> {
    const PAYOUT_RESERVE_TGAS: f64 = 15.0;
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, 70).await;
    finalize(&w, id).await?;
    assert_eq!(claimable(&w, w.carol.id()).await, BOND);

    let withdraw_with = |tgas: u64| {
        w.carol
            .call(w.oracle.id(), "withdraw_bond")
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(tgas))
            .transact()
    };
    refused(
        withdraw_with(32).await?.into_result(),
        "attach at least 33 TGas: a withdrawal sends the payout and then settles it",
    );
    assert_eq!(
        claimable(&w, w.carol.id()).await,
        BOND,
        "a refused withdrawal changed nothing"
    );
    let before = intents_balance(&w, w.carol.id()).await;
    let r = withdraw_with(33).await?;
    assert_clean("withdraw_bond at its floor", &r);
    let verifier_burnt = burned_by(&r, w.verifier.id());
    println!(
        "withdraw_bond: floor 33, oracle burnt {:.1} TGas, verifier burnt {verifier_burnt:.1} against a reserve of {PAYOUT_RESERVE_TGAS}, {} TGas in all",
        burned_by(&r, w.oracle.id()),
        r.total_gas_burnt.as_tgas()
    );
    assert_eq!(claimable(&w, w.carol.id()).await, 0);
    assert_eq!(
        intents_balance(&w, w.carol.id()).await - before,
        BOND,
        "the payout arrived at the floor"
    );
    assert!(
        verifier_burnt < PAYOUT_RESERVE_TGAS / 2.0,
        "a payout burns well under what is reserved for it"
    );
    assert_oracle_reconciled(&w).await;
    Ok(())
}

// What a wallet has to attach for a bond to get through the verifier into the oracle, measured against the real verifier: the least
// gas at which the oracle opens the case, for a proposal and for a challenge. The verifier keeps about 21 TGas for itself, the rest
// is the oracle's receipt. The oracle enforces no floor here: a call that runs short fails in the oracle and the verifier refunds it.
#[tokio::test]
async fn a_bond_gets_through_the_verifier_into_the_oracle_with_what_a_wallet_attaches() -> anyhow::Result<()> {
    const WALLET_TGAS: u64 = 100;
    let gases = [20u64, 21, 22, 23, 24, 25, 26, 28, 30, 35, 40, 60, WALLET_TGAS];
    let w = setup_with(600_000, PANEL_MS, DRAW_DELAY_BLOCKS).await?;
    for who in [&w.carol, &w.dave] {
        mint(&w, who.id(), 500 * USD).await?;
        deposit_to_intents(&w, who, who.id(), 200 * USD).await?;
    }
    let mut markets = vec![];
    for _ in gases {
        markets.push(create_market(&w, 150, 3_600).await?);
    }
    let last_close = u(&market_json(&w, *markets.last().unwrap()).await["close_at"]);
    skip_until(&w, (last_close + 1_000_000_000) as u64).await;

    let attempt = |who: &Account, tgas: u64, msg: String| {
        let (verifier, who, receiver, token) = (
            w.verifier.id().clone(),
            who.clone(),
            w.oracle.id().clone(),
            token_id(&w),
        );
        async move {
            who.call(&verifier, "mt_transfer_call")
                .args_json(json!({
                    "receiver_id": receiver, "token_id": token, "amount": BOND.to_string(), "msg": msg
                }))
                .deposit(NearToken::from_yoctonear(1))
                .gas(Gas::from_tgas(tgas))
                .transact()
                .await
        }
    };
    let mut least_propose = None;
    for (tgas, id) in gases.iter().zip(&markets) {
        let r = attempt(
            &w.carol,
            *tgas,
            format!("propose:{id}:yes:https://example.com/evidence"),
        )
        .await?;
        let opened = !case_json(&w, *id).await.is_null();
        println!(
            "propose with {tgas} TGas: tx {}, case opened: {opened}, oracle burnt {:.1} TGas, {} TGas in all",
            if r.is_success() { "ok" } else { "failed" },
            burned_by(&r, w.oracle.id()),
            r.total_gas_burnt.as_tgas()
        );
        if opened && least_propose.is_none() {
            least_propose = Some(*tgas);
        }
        assert_oracle_reconciled(&w).await;
    }
    let mut least_challenge = None;
    for (tgas, id) in gases.iter().zip(&markets) {
        if case_json(&w, *id).await.is_null() {
            intents_call(
                &w,
                &w.carol,
                w.oracle.id(),
                BOND,
                &format!("propose:{id}:yes:https://x"),
            )
            .await?
            .into_result()?;
        }
        let r = attempt(&w.dave, *tgas, format!("challenge:{id}:no")).await?;
        let opened = case_json(&w, *id).await["stage"] == "disputed";
        println!(
            "challenge with {tgas} TGas: tx {}, challenged: {opened}, oracle burnt {:.1} TGas, {} TGas in all",
            if r.is_success() { "ok" } else { "failed" },
            burned_by(&r, w.oracle.id()),
            r.total_gas_burnt.as_tgas()
        );
        if opened && least_challenge.is_none() {
            least_challenge = Some(*tgas);
        }
        assert_oracle_reconciled(&w).await;
    }
    let (least_propose, least_challenge) = (
        least_propose.expect("a proposal gets through with some amount of gas"),
        least_challenge.expect("a challenge gets through with some amount of gas"),
    );
    println!("least gas that worked: propose {least_propose} TGas, challenge {least_challenge} TGas, a wallet attaches {WALLET_TGAS}");
    assert!(
        least_propose < WALLET_TGAS && least_challenge < WALLET_TGAS,
        "the wallet default of {WALLET_TGAS} TGas leaves room"
    );
    Ok(())
}

// How much gas the verifier calls need, measured: the least a mt_transfer_call can carry for the Council to take its revenue, and
// what a payout and a sweep burn against what the contracts reserve for them. The reserves are GAS_MT_TRANSFER (15 TGas) for a
// payout, and 22 TGas of the verifier's own overhead plus 20 TGas for the Council's receipt for a transfer call.
#[tokio::test]
async fn the_gas_the_contracts_reserve_for_the_verifier_covers_what_it_needs() -> anyhow::Result<()> {
    const PAYOUT_RESERVE_TGAS: f64 = 15.0;
    const TRANSFER_CALL_RESERVE_TGAS: u64 = 42;
    let w = setup().await?;
    let id = create_seeded_market(&w, 600).await?;
    buy(&w, &w.alice, id, "yes", 10 * USD).await?;
    deposit_to_intents(&w, &w.alice, w.alice.id(), 100 * USD).await?;

    let mut least = None;
    for tgas in [21u64, 22, 23, 24, 25, 26, 28, 30, 35, TRANSFER_CALL_RESERVE_TGAS, 60] {
        let before = council_total_received(&w).await;
        let r = w
            .alice
            .call(w.verifier.id(), "mt_transfer_call")
            .args_json(json!({
                "receiver_id": w.council.id(), "token_id": token_id(&w), "amount": USD.to_string(), "msg": "revenue"
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await?;
        let took = council_total_received(&w).await - before == USD;
        println!(
            "mt_transfer_call into the Council with {tgas} TGas: tx {}, Council took it: {took}, council burnt {:.1} TGas",
            if r.is_success() { "ok" } else { "failed" },
            burned_by(&r, w.council.id())
        );
        if took && least.is_none() {
            least = Some(tgas);
        }
    }
    let least = least.expect("the Council takes revenue with some amount of gas");
    println!(
        "least gas the Council's receipt worked with: {least} TGas, the contracts reserve {TRANSFER_CALL_RESERVE_TGAS}"
    );
    assert!(
        least <= TRANSFER_CALL_RESERVE_TGAS,
        "the reserve of {TRANSFER_CALL_RESERVE_TGAS} TGas is below the {least} the Council needs"
    );

    let balance = 3 * USD;
    w.alice
        .call(w.market.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    ft_call(&w, &w.alice, w.market.id(), balance, "deposit").await?;
    let r = w
        .alice
        .call(w.market.id(), "withdraw")
        .args_json(json!({ "amount": balance.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_clean("withdraw", &r);
    let verifier_burnt = burned_by(&r, w.verifier.id());
    println!(
        "withdraw: verifier burnt {verifier_burnt:.1} TGas against a reserve of {PAYOUT_RESERVE_TGAS}, market {:.1}, {} TGas in all",
        burned_by(&r, w.market.id()),
        r.total_gas_burnt.as_tgas()
    );
    assert!(
        verifier_burnt < PAYOUT_RESERVE_TGAS / 2.0,
        "a payout burns well under what is reserved for it"
    );
    Ok(())
}
