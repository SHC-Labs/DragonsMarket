// The upgrade of a Council from state version 5 to version 6 on a real sandbox, with the code that is deployed today (see
// V5_RECIPE in common) staged and swapped for the new build by the owner, as an upgrade does it. A seat staked on version 5 keeps
// its stake and its owner, the revenue version 5 had not paid out becomes the carry, and an upgrade that would strand money
// refuses and leaves the old code running.
mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::json;
use sha2::{Digest, Sha256};

const STAGE_DEPOSIT: NearToken = NearToken::from_near(5);
const UPGRADE_TGAS: u64 = 300;
const STATE_KEY: &[u8] = b"STATE";
const MIGRATED_DAY_KEY: &[u8] = b"migrated_day";
const QUARTERS_PREFIX: u8 = 5;
const JOINS_ON_PREFIX: u8 = 15;
const STAKES_PREFIX: u8 = 1;
// Where the fields of the version 5 state sit, counted back from the end of the record: it ends with the quarter map prefixes,
// then six totals, then the counts of unstakes in flight, fresh seats and the late-seat rule's first quarter.
const V5_NEXT_TO_FINALIZE_FROM_END: usize = 137;
const V5_UNSTAKES_IN_FLIGHT_FROM_END: usize = 12;
const V5_FINAL_POOL_FROM_END: usize = 44;
const V5_OPEN_POOL_FROM_END: usize = 60;
const V5_PENDING_TOTAL_FROM_END: usize = 76;
const MIGRATE_DUST_PER_QUARTER: u128 = 1_000;
const V1_STAKE_TAG: u8 = 0;
const V2_STAKE_TAG: u8 = 1;

// A version 5 Council beside the world's own, owned by the world's owner, with the world's collection and the owner standing in
// for the market. It starts with no seats.
async fn v5_council(w: &World) -> anyhow::Result<Contract> {
    let council = w.worker.dev_deploy(&v5_wasm()).await?;
    council
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "oracle_id": w.oracle.id(), "verifier_id": w.verifier.id(),
            "collateral_token_id": token_id(w), "cooldown_ns": (COOLDOWN_SECS * 1_000_000_000).to_string(),
            "max_seats_per_account": MAX_SEATS_PER_ACCOUNT, "allowlist_enabled": false
        }))
        .transact()
        .await?
        .into_result()?;
    for (method, args) in [
        ("set_nft_contract", json!({ "nft_contract": w.nft.id() })),
        ("allow_market", json!({ "market": w.owner.id() })),
    ] {
        w.owner
            .call(council.id(), method)
            .args_json(args)
            .transact()
            .await?
            .into_result()?;
    }
    Ok(council)
}

async fn stake_in(w: &World, council: &Contract, who: &Account, token: &str) -> anyhow::Result<()> {
    mint_nft(w, who, token).await?;
    let r = who
        .call(w.nft.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": council.id(), "token_id": token, "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    anyhow::ensure!(r.json::<bool>()?, "the Council sent the token back");
    Ok(())
}

// The owner sends revenue as the one market the Council trusts, under sweep id `sweep`.
async fn revenue_to(w: &World, council: &Contract, sweep: u64, amount: u128) -> anyhow::Result<()> {
    ft_call(w, &w.owner, council.id(), amount, &format!("revenue:{sweep}")).await
}

// Three seats on version 5: two of Alice's and one of Bob's, and a fourth of Bob's that has asked to leave. 500 USD of revenue
// has arrived in two sweeps.
async fn v5_with_seats_and_revenue(w: &World) -> anyhow::Result<Contract> {
    let council = v5_council(w).await?;
    mint(w, w.owner.id(), 2_000 * USD).await?;
    for (who, token) in [(&w.alice, "a1"), (&w.alice, "a2"), (&w.bob, "b1"), (&w.bob, "b2")] {
        stake_in(w, &council, who, token).await?;
    }
    w.bob
        .call(council.id(), "request_unstake")
        .args_json(json!({ "token_id": "b2" }))
        .transact()
        .await?
        .into_result()?;
    revenue_to(w, &council, 1, 300 * USD).await?;
    revenue_to(w, &council, 2, 200 * USD).await?;
    Ok(council)
}

async fn stage(w: &World, council: &Contract, code: &[u8]) -> anyhow::Result<String> {
    Ok(w.bob
        .call(council.id(), "stage_code")
        .args(code.to_vec())
        .deposit(STAGE_DEPOSIT)
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?)
}

fn hash_of(code: &[u8]) -> String {
    bs58::encode(Sha256::digest(code)).into_string()
}

// Stages the version 6 build and has the owner upgrade to it. The outcome is left unchecked so a test can look at a refusal.
async fn upgrade_to_v6(w: &World, council: &Contract) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let code = wasm("council");
    let hash = stage(w, council, &code).await?;
    assert_eq!(hash, hash_of(&code));
    Ok(w.owner
        .call(council.id(), "upgrade")
        .args_json(json!({ "code_hash": hash }))
        .gas(Gas::from_tgas(UPGRADE_TGAS))
        .transact()
        .await?)
}

async fn code_hash_of(council: &Contract) -> String {
    hash_of(&council.view_code().await.unwrap())
}

async fn state_of(council: &Contract, w: &World) -> std::collections::HashMap<Vec<u8>, Vec<u8>> {
    w.worker.view_state(council.id()).await.unwrap()
}

// Writes `value` into the version 5 record, `from_end` bytes before its end.
async fn patch_v5(w: &World, council: &Contract, from_end: usize, value: &[u8]) -> anyhow::Result<()> {
    let mut record = state_of(council, w).await[STATE_KEY].clone();
    let at = record.len() - from_end;
    record[at..at + value.len()].copy_from_slice(value);
    w.worker.patch_state(council.id(), STATE_KEY, &record).await?;
    Ok(())
}

async fn v5_u128(w: &World, council: &Contract, from_end: usize) -> u128 {
    let record = &state_of(council, w).await[STATE_KEY];
    let at = record.len() - from_end;
    u128::from_le_bytes(record[at..at + 16].try_into().unwrap())
}

fn quarter_book_key(quarter: u32) -> Vec<u8> {
    [vec![QUARTERS_PREFIX], quarter.to_le_bytes().to_vec()].concat()
}

fn today(now_ns: u64) -> u64 {
    now_ns / NS_PER_DAY
}

async fn totals_of(council: &Contract) -> serde_json::Value {
    council.view("reward_totals").await.unwrap().json().unwrap()
}

async fn stake_json(council: &Contract, token: &str) -> serde_json::Value {
    council
        .view("stake_of")
        .args_json(json!({ "token_id": token }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

async fn earnings_json(council: &Contract, token: &str) -> serde_json::Value {
    council
        .view("seat_earnings")
        .args_json(json!({ "token_id": token }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

// An upgrade that is refused leaves the version 5 code running, the mark cleared, and the stakes as they were.
async fn assert_still_version_5(
    w: &World,
    council: &Contract,
    v5_hash: &str,
    r: near_workspaces::result::ExecutionFinalResult,
    why: &str,
) {
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    assert_eq!(event_names(&logs), vec!["upgrade_sent", "upgrade_failed"], "{why}");
    assert!(
        format!("{:?}", r.receipt_failures()).contains(why),
        "expected a refusal ({why}), got {:?}",
        r.receipt_failures()
    );
    assert_eq!(&code_hash_of(council).await, v5_hash, "{why}: the old code still runs");
    let c = config(council).await;
    assert_eq!(
        (&c["state_version"], &c["upgrade_in_flight"]),
        (&json!(5), &json!(false))
    );
    assert_eq!(council.view("seat_count").await.unwrap().json::<u32>().unwrap(), 4);
    assert_eq!(nft_owner(w, "a1").await, council.id().as_str());
}

#[tokio::test]
async fn a_version_5_council_upgrades_to_version_6_with_its_stakes_and_its_open_revenue_as_the_carry(
) -> anyhow::Result<()> {
    let w = setup().await?;
    let council = v5_with_seats_and_revenue(&w).await?;
    let v5_hash = code_hash_of(&council).await;
    assert_eq!(config(&council).await["state_version"], 5);
    let before: Vec<serde_json::Value> = {
        let mut all = vec![];
        for token in ["a1", "a2", "b1", "b2"] {
            all.push(stake_json(&council, token).await);
        }
        all
    };
    let held = intents_balance(&w, council.id()).await;
    assert_eq!(held, 500 * USD);
    assert_eq!(state_of(&council, &w).await[STATE_KEY][..2], [5, 0]);

    let r = upgrade_to_v6(&w, &council).await?;
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    assert_eq!(
        event_names(&logs),
        vec!["upgrade_sent", "migrated"],
        "{:?}",
        r.receipt_failures()
    );
    assert_ne!(code_hash_of(&council).await, v5_hash);
    assert_eq!(
        state_of(&council, &w).await[STATE_KEY][..2],
        [6, 0],
        "the new layout starts with its version"
    );
    let c = config(&council).await;
    assert_eq!(
        (&c["state_version"], &c["upgrade_proven"], &c["upgrade_in_flight"]),
        (&json!(6), &json!(true), &json!(false))
    );

    // Every stake, with its owner, its time and its request, is as it was. A seat that did not ask to leave starts earning the
    // day after the upgrade. One that did never earns again.
    let day = today(now(&w.worker).await);
    for (token, old) in ["a1", "a2", "b1", "b2"].into_iter().zip(&before) {
        let now_json = stake_json(&council, token).await;
        for field in ["owner", "staked_at", "unlock_requested_at", "serving"] {
            assert_eq!(now_json[field], old[field], "{token} {field}");
        }
        let leaving = token == "b2";
        assert_eq!(
            now_json["earn_from_day"],
            json!(if leaving { u64::MAX } else { day + 1 }.to_string()),
            "{token}"
        );
        assert_eq!(nft_owner(&w, token).await, council.id().as_str());
    }
    assert_eq!(council.view("seat_count").await?.json::<u32>()?, 4);
    for token in ["a1", "a2", "b1"] {
        let seat = earnings_json(&council, token).await;
        assert_eq!(seat["state"], "waiting", "{token}");
        assert_eq!(u(&seat["earning_from"]) as u64, (day + 1) * NS_PER_DAY);
    }
    assert_eq!(earnings_json(&council, "b2").await["state"], "leaving");
    assert_eq!(c["active_seats"], 0, "nothing earns until the day after");
    assert_eq!(c["last_day"], day.to_string());

    // The revenue version 5 held for its running quarter is the carry, and no quarter has money to claim.
    let totals = totals_of(&council).await;
    assert_eq!(u(&totals["carry"]), 500 * USD);
    assert_eq!(u(&totals["total_received"]), 500 * USD);
    for field in [
        "total_paid",
        "pending_claims",
        "cut_pool",
        "accrued_total",
        "pending_total_slots",
    ] {
        assert_eq!(u(&totals[field]), 0, "{field}");
    }
    assert_eq!(intents_balance(&w, council.id()).await, held, "no money moved");
    let quarter = council.view("quarter_info").await?.json::<serde_json::Value>()?;
    let closed = quarter["quarter"].as_u64().unwrap() - 1;
    assert_eq!(quarter["last_closed_quarter"], closed);
    let snapshots: Vec<serde_json::Value> = council
        .view("quarter_snapshots")
        .args_json(json!({ "from": null, "limit": null }))
        .await?
        .json()?;
    assert_eq!(snapshots, vec![json!({ "quarter": closed, "acc": "0" })]);
    Ok(())
}

#[tokio::test]
async fn a_seat_staked_on_version_5_is_rewritten_in_the_new_layout_only_when_it_is_next_changed() -> anyhow::Result<()>
{
    let w = setup().await?;
    let council = v5_with_seats_and_revenue(&w).await?;
    upgrade_to_v6(&w, &council).await?.into_result()?;
    let stake_key = |token: &str| [vec![STAKES_PREFIX], borsh_string(token)].concat();
    let tag = |state: &std::collections::HashMap<Vec<u8>, Vec<u8>>, token: &str| state[&stake_key(token)][0];
    let state = state_of(&council, &w).await;
    assert_eq!((tag(&state, "a1"), tag(&state, "b1")), (V1_STAKE_TAG, V1_STAKE_TAG));

    let r = w
        .alice
        .call(council.id(), "request_unstake")
        .args_json(json!({ "token_id": "a1", "accepts_cut": true }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    let cut = &events_named(&logs, "seat_cut")[0];
    assert_eq!(
        (u(&cut["earned"]), u(&cut["cut"])),
        (0, 0),
        "a seat that never started loses nothing"
    );
    let state = state_of(&council, &w).await;
    assert_eq!((tag(&state, "a1"), tag(&state, "b1")), (V2_STAKE_TAG, V1_STAKE_TAG));
    assert_eq!(earnings_json(&council, "a1").await["state"], "leaving");
    assert_eq!(
        config(&council).await["last_day"],
        today(now(&w.worker).await).to_string()
    );

    // The seat that left was one of the three due to start tomorrow, so two are.
    let joining = state[&[
        vec![JOINS_ON_PREFIX],
        (today(now(&w.worker).await) + 1).to_le_bytes().to_vec(),
    ]
    .concat()]
        .clone();
    assert_eq!(joining, 2u32.to_le_bytes());
    refused(
        w.bob
            .call(council.id(), "claim")
            .args_json(json!({ "token_ids": ["b1"] }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result(),
        "nothing to claim",
    );
    Ok(())
}

#[tokio::test]
async fn seats_from_version_5_start_the_day_after_the_upgrade_and_share_the_carried_revenue() -> anyhow::Result<()> {
    let w = setup().await?;
    let council = v5_with_seats_and_revenue(&w).await?;
    upgrade_to_v6(&w, &council).await?.into_result()?;

    // ACCELERATED. One UTC midnight passes: the day the upgrade ran is a day earlier, so the seats due the next day start on
    // the day the chain is in, and the Council's day cursor goes back one day for the walk to fold them in.
    let day = today(now(&w.worker).await);
    w.worker
        .patch_state(council.id(), MIGRATED_DAY_KEY, &(day - 1).to_le_bytes())
        .await?;
    let joining =
        state_of(&council, &w).await[&[vec![JOINS_ON_PREFIX], (day + 1).to_le_bytes().to_vec()].concat()].clone();
    w.worker
        .patch_state(
            council.id(),
            &[vec![JOINS_ON_PREFIX], day.to_le_bytes().to_vec()].concat(),
            &joining,
        )
        .await?;
    let mut record = state_of(&council, &w).await[STATE_KEY].clone();
    let last_day_at = record.len() - 77;
    assert_eq!(
        u64::from_le_bytes(record[last_day_at..last_day_at + 8].try_into()?),
        day
    );
    record[last_day_at..last_day_at + 8].copy_from_slice(&(day - 1).to_le_bytes());
    w.worker.patch_state(council.id(), STATE_KEY, &record).await?;

    let w6 = w.with_council(council.clone());
    send_revenue(&w6, 100 * USD).await?;
    assert_eq!(config(&council).await["active_seats"], 3);
    let totals = totals_of(&council).await;
    assert_eq!((u(&totals["carry"]), u(&totals["total_received"])), (0, 600 * USD));
    for (who, seats) in [(&w.alice, 2), (&w.bob, 1)] {
        assert_eq!(
            in_progress_of(&w6, who.id()).await,
            seats * 200 * USD,
            "the carried 500 and the new 100 are shared among the three seats"
        );
    }
    assert_eq!(earnings_json(&council, "b2").await["state"], "leaving");
    assert_eq!(u(&earnings_json(&council, "b2").await["earned_in_progress"]), 0);
    Ok(())
}

#[tokio::test]
async fn an_upgrade_is_refused_while_a_finished_quarter_is_not_finalized() -> anyhow::Result<()> {
    let w = setup().await?;
    let council = v5_with_seats_and_revenue(&w).await?;
    let v5_hash = code_hash_of(&council).await;
    let quarter = w.council.view("quarter_info").await?.json::<serde_json::Value>()?["quarter"]
        .as_u64()
        .unwrap() as u32;
    let state = state_of(&council, &w).await;
    let record = &state[STATE_KEY];
    let at = record.len() - V5_NEXT_TO_FINALIZE_FROM_END;
    assert_eq!(
        record[at..at + 4],
        quarter.to_le_bytes(),
        "next_to_finalize is not where this test expects it: the version 5 layout changed"
    );
    patch_v5(&w, &council, V5_NEXT_TO_FINALIZE_FROM_END, &(quarter - 1).to_le_bytes()).await?;

    let r = upgrade_to_v6(&w, &council).await?;
    assert_still_version_5(
        &w,
        &council,
        &v5_hash,
        r,
        "a finished quarter is not finalized yet, finalize it and let its holders claim before upgrading",
    )
    .await;
    Ok(())
}

#[tokio::test]
async fn an_upgrade_is_refused_while_a_finalized_quarter_has_money_to_claim_and_allows_the_rounding_of_the_quarters_finalized(
) -> anyhow::Result<()> {
    let w = setup().await?;
    let council = v5_with_seats_and_revenue(&w).await?;
    let v5_hash = code_hash_of(&council).await;
    let quarter = w.council.view("quarter_info").await?.json::<serde_json::Value>()?["quarter"]
        .as_u64()
        .unwrap() as u32;
    assert_eq!(
        v5_u128(&w, &council, V5_OPEN_POOL_FROM_END).await,
        500 * USD,
        "the open pool is where this test expects it"
    );

    // No quarter has a book, so none is finalized and any money in the final pool is unclaimed.
    patch_v5(&w, &council, V5_FINAL_POOL_FROM_END, &1u128.to_le_bytes()).await?;
    let r = upgrade_to_v6(&w, &council).await?;
    assert_still_version_5(
        &w,
        &council,
        &v5_hash,
        r,
        "a finalized quarter still has money to claim, claim it before upgrading",
    )
    .await;

    // One finalized quarter allows the rounding version 5 leaves behind, and no more.
    w.worker
        .patch_state(council.id(), &quarter_book_key(quarter - 1), &[0u8; 8])
        .await?;
    patch_v5(
        &w,
        &council,
        V5_FINAL_POOL_FROM_END,
        &(MIGRATE_DUST_PER_QUARTER + 1).to_le_bytes(),
    )
    .await?;
    let r = upgrade_to_v6(&w, &council).await?;
    assert_still_version_5(
        &w,
        &council,
        &v5_hash,
        r,
        "a finalized quarter still has money to claim, claim it before upgrading",
    )
    .await;
    patch_v5(
        &w,
        &council,
        V5_FINAL_POOL_FROM_END,
        &MIGRATE_DUST_PER_QUARTER.to_le_bytes(),
    )
    .await?;
    let r = upgrade_to_v6(&w, &council).await?;
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    assert_eq!(
        event_names(&logs),
        vec!["upgrade_sent", "migrated"],
        "{:?}",
        r.receipt_failures()
    );
    assert_eq!(
        u(&totals_of(&council).await["carry"]),
        500 * USD + MIGRATE_DUST_PER_QUARTER,
        "the open pool and the rounding left in the quarter are the carry"
    );
    Ok(())
}

#[tokio::test]
async fn an_upgrade_is_refused_while_a_claim_or_an_unstake_is_in_flight() -> anyhow::Result<()> {
    let w = setup().await?;
    let council = v5_with_seats_and_revenue(&w).await?;
    let v5_hash = code_hash_of(&council).await;

    assert_eq!(v5_u128(&w, &council, V5_PENDING_TOTAL_FROM_END).await, 0);
    patch_v5(&w, &council, V5_PENDING_TOTAL_FROM_END, &1u128.to_le_bytes()).await?;
    let r = upgrade_to_v6(&w, &council).await?;
    assert_still_version_5(
        &w,
        &council,
        &v5_hash,
        r,
        "a claim is still pending, settle it before upgrading",
    )
    .await;
    patch_v5(&w, &council, V5_PENDING_TOTAL_FROM_END, &0u128.to_le_bytes()).await?;

    patch_v5(&w, &council, V5_UNSTAKES_IN_FLIGHT_FROM_END, &1u32.to_le_bytes()).await?;
    let r = upgrade_to_v6(&w, &council).await?;
    assert_still_version_5(
        &w,
        &council,
        &v5_hash,
        r,
        "an unstake is still waiting for its NFT transfer",
    )
    .await;
    patch_v5(&w, &council, V5_UNSTAKES_IN_FLIGHT_FROM_END, &0u32.to_le_bytes()).await?;

    // With both gone the same Council upgrades.
    let r = upgrade_to_v6(&w, &council).await?;
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    assert_eq!(
        event_names(&logs),
        vec!["upgrade_sent", "migrated"],
        "{:?}",
        r.receipt_failures()
    );
    Ok(())
}

#[tokio::test]
async fn an_upgrade_from_any_other_version_is_refused() -> anyhow::Result<()> {
    let w = setup().await?;
    let council = v5_with_seats_and_revenue(&w).await?;
    let v5_hash = code_hash_of(&council).await;
    let record = state_of(&council, &w).await[STATE_KEY].clone();
    for version in [4u16, 7] {
        let mut changed = record.clone();
        changed[..2].copy_from_slice(&version.to_le_bytes());
        w.worker.patch_state(council.id(), STATE_KEY, &changed).await?;
        let r = upgrade_to_v6(&w, &council).await?;
        let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
        assert_eq!(
            event_names(&logs),
            vec!["upgrade_sent", "upgrade_failed"],
            "version {version}"
        );
        assert!(
            format!("{:?}", r.receipt_failures()).contains("unsupported state version"),
            "version {version}: {:?}",
            r.receipt_failures()
        );
        assert_eq!(code_hash_of(&council).await, v5_hash, "version {version}");
    }
    Ok(())
}
