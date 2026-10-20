// The upgrade path of all four contracts on a real sandbox chain: stage a build, pass it through a governance vote and
// its timelock, and see the state survive, the failed upgrades change nothing, and seal remove every access key.
mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::json;
use sha2::{Digest, Sha256};

const STAGE_DEPOSIT: NearToken = NearToken::from_near(5);
// The gas a governance call to upgrade carries. The contract itself asks for at least 100.
const UPGRADE_CALL_TGAS: u64 = 100;
const GAS_EXECUTE_UPGRADE_TGAS: u64 = 110;

// The same code with a custom section on the end, so it is a different build with its own hash. The section is a name
// and no data, which every wasm reader skips.
fn rebuilt(name: &str, tag: &str) -> Vec<u8> {
    let mut code = wasm(name);
    let body = [&[tag.len() as u8][..], tag.as_bytes()].concat();
    code.push(0);
    code.push(body.len() as u8);
    code.extend(body);
    code
}

fn hash_of(code: &[u8]) -> String {
    bs58::encode(Sha256::digest(code)).into_string()
}

async fn stage(from: &Account, target: &AccountId, code: &[u8]) -> anyhow::Result<String> {
    let hash: String = from
        .call(target, "stage_code")
        .args(code.to_vec())
        .deposit(STAGE_DEPOSIT)
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(
        hash,
        hash_of(code),
        "the contract answers with the sha256 of the call input"
    );
    Ok(hash)
}

async fn deployed_hash(c: &Contract) -> String {
    hash_of(&c.view_code().await.unwrap())
}

async fn public_key(c: &Contract) -> String {
    c.as_account().secret_key().public_key().to_string()
}

async fn key_count(c: &Contract) -> usize {
    c.view_access_keys().await.unwrap().len()
}

// Whether a staged copy of this code is stored on the contract.
async fn is_staged(c: &Contract, hash: &str) -> bool {
    c.view("is_staged")
        .args_json(json!({ "code_hash": hash }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

fn upgrade_call(target: &Contract, hash: &str, tgas: u64) -> serde_json::Value {
    function_call(target.id(), "upgrade", json!({ "code_hash": hash }), tgas)
}

fn seal_call(target: &Contract, key: &str) -> serde_json::Value {
    function_call(target.id(), "seal", json!({ "public_key": key }), 20)
}

// Passes the action, waits out the timelock and executes it. Returns the proposal id and the logs of the whole call.
async fn vote_and_execute(w: &World, g: &Governance, action: serde_json::Value) -> anyhow::Result<(u64, Vec<String>)> {
    let id = gov_pass(g, action).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    let logs = gov_execute(g, &w.carol, id).await?;
    Ok((id, logs))
}

async fn config_without_proof(c: &Contract) -> serde_json::Value {
    let mut v = config(c).await;
    v.as_object_mut().unwrap().remove("upgrade_proven");
    v
}

// A market with a position in it, a case waiting for its challenge window, and the five seats the setup stakes.
async fn seed_state(w: &World) -> anyhow::Result<u64> {
    let id = create_seeded_market(w, 40).await?;
    buy(w, &w.alice, id, "yes", 10 * USD).await?;
    skip_secs(&w.worker, 41).await;
    propose(w, &w.carol, id, "yes").await?;
    Ok(id)
}

async fn snapshot(w: &World, id: u64) -> serde_json::Value {
    let (yes, no) = shares(w, id, w.alice.id()).await;
    json!({
        "market": market_json(w, id).await, "case": case_json(w, id).await, "alice": [yes.to_string(), no.to_string()],
        "balance": market_balance(w, w.alice.id()).await.to_string(), "seat": stake_of(w, w.jurors[0].id().as_str()).await,
        "seats": w.council.view("seat_count").await.unwrap().json::<u32>().unwrap(),
        "market_config": config_without_proof(&w.market).await, "oracle_config": config_without_proof(&w.oracle).await,
        "council_config": config_without_proof(&w.council).await,
    })
}

fn governed_contracts(w: &World) -> Vec<(&'static str, &'static str, &Contract)> {
    vec![
        ("market", "market", &w.market),
        ("oracle", "oracle", &w.oracle),
        ("council", "council", &w.council),
    ]
}

#[tokio::test]
async fn the_market_the_oracle_and_the_council_upgrade_through_a_vote_and_keep_their_state() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let id = seed_state(&w).await?;
    let before = snapshot(&w, id).await;

    for (wasm_name, label, target) in governed_contracts(&w) {
        assert_eq!(
            (
                config(target).await["upgrade_proven"].clone(),
                config(target).await["state_version"].clone()
            ),
            (json!(false), json!(1)),
            "{label}"
        );
        let code = rebuilt(wasm_name, "v2");
        refused(
            w.bob
                .call(target.id(), "stage_code")
                .args(code.clone())
                .deposit(NearToken::from_yoctonear(1))
                .max_gas()
                .transact()
                .await?
                .into_result(),
            "attach at least",
        );
        let hash = stage(&w.bob, target.id(), &code).await?;
        assert!(is_staged(target, &hash).await, "{label}");

        // Only governance deploys it: not the owner key that set the contracts up, not the staker.
        for stranger in [&w.owner, &w.bob] {
            refused(
                stranger
                    .call(target.id(), "upgrade")
                    .args_json(json!({ "code_hash": hash }))
                    .max_gas()
                    .transact()
                    .await?
                    .into_result(),
                "owner only",
            );
        }
        let old_code = deployed_hash(target).await;
        assert_ne!(old_code, hash);

        let (proposal, logs) = vote_and_execute(&w, &g, upgrade_call(target, &hash, UPGRADE_CALL_TGAS)).await?;
        assert_eq!(
            event_names(&logs),
            vec!["call_sent", "upgrade_sent", "migrated", "executed"],
            "{label}"
        );
        assert_eq!(gov_proposal(&g, proposal).await["stage"], "executed", "{label}");
        assert_eq!(deployed_hash(target).await, hash, "{label} runs the staged build");
        assert!(!is_staged(target, &hash).await, "{label}: the staged copy is removed");
        let c = config(target).await;
        assert_eq!(
            (&c["upgrade_proven"], &c["state_version"]),
            (&json!(true), &json!(1)),
            "{label}"
        );
    }

    assert_eq!(snapshot(&w, id).await, before, "nothing the contracts hold changed");
    assert!(invariant(&w, id).await);
    Ok(())
}

#[tokio::test]
async fn an_upgrade_that_cannot_finish_leaves_the_old_code_in_place_and_the_state_intact() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let id = seed_state(&w).await?;
    let before = snapshot(&w, id).await;

    for (wasm_name, label, target) in governed_contracts(&w) {
        let old = deployed_hash(target).await;

        // A hash nobody staged.
        let unknown = hash_of(b"nobody staged this");
        let (p, logs) = vote_and_execute(&w, &g, upgrade_call(target, &unknown, UPGRADE_CALL_TGAS)).await?;
        assert_eq!(event_names(&logs), vec!["call_sent", "execution_failed"], "{label}");
        assert_eq!(gov_proposal(&g, p).await["stage"], "execution_failed");

        // A build with no migrate: the batch reverts, and so does the deploy.
        let no_migrate = wasm("mock_ft");
        let hash = stage(&w.bob, target.id(), &no_migrate).await?;
        let (p, logs) = vote_and_execute(&w, &g, upgrade_call(target, &hash, UPGRADE_CALL_TGAS)).await?;
        assert_eq!(
            event_names(&logs),
            vec!["call_sent", "upgrade_sent", "execution_failed"],
            "{label}"
        );
        assert_eq!(gov_proposal(&g, p).await["stage"], "execution_failed");
        assert_eq!(deployed_hash(target).await, old, "{label} still runs its old code");
        assert!(
            !is_staged(target, &hash).await,
            "{label}: a failed upgrade has to stage its code again"
        );
        assert_eq!(config(target).await["upgrade_proven"], false, "{label}");

        // Too little gas is refused at the top, before the staged copy is touched.
        let good = rebuilt(wasm_name, "v2");
        let hash = stage(&w.bob, target.id(), &good).await?;
        let (p, logs) = vote_and_execute(&w, &g, upgrade_call(target, &hash, UPGRADE_CALL_TGAS - 1)).await?;
        assert_eq!(event_names(&logs), vec!["call_sent", "execution_failed"], "{label}");
        assert_eq!(gov_proposal(&g, p).await["stage"], "execution_failed");
        assert!(is_staged(target, &hash).await, "{label}: the copy is still there");
        assert_eq!(deployed_hash(target).await, old, "{label}");
    }
    assert_eq!(snapshot(&w, id).await, before);
    Ok(())
}

// The timelock on an upgrade is the users' exit window, so neither a pause nor an upgrade may close the way out.
#[tokio::test]
async fn a_balance_can_be_withdrawn_while_the_market_is_paused_and_after_it_is_upgraded() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    ft_call(&w, &w.alice, w.market.id(), 20 * USD, "deposit").await?;
    assert_eq!(market_balance(&w, w.alice.id()).await, 20 * USD);
    w.owner
        .call(w.market.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(config(&w.market).await["paused"], true);

    let hash = stage(&w.bob, w.market.id(), &rebuilt("market", "v2")).await?;
    vote_and_execute(&w, &g, upgrade_call(&w.market, &hash, UPGRADE_CALL_TGAS)).await?;
    assert_eq!(config(&w.market).await["upgrade_proven"], true);
    assert_eq!(
        config(&w.market).await["paused"],
        true,
        "the pause survives the upgrade"
    );

    let before = ft_balance(&w, w.alice.id()).await;
    w.alice
        .call(w.market.id(), "withdraw")
        .args_json(json!({ "amount": (20 * USD).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(ft_balance(&w, w.alice.id()).await - before, 20 * USD);
    assert_eq!(market_balance(&w, w.alice.id()).await, 0);
    Ok(())
}

#[tokio::test]
async fn the_upgrade_call_names_the_gas_it_needs() -> anyhow::Result<()> {
    let w = setup().await?;
    let hash = stage(&w.bob, w.market.id(), &rebuilt("market", "v2")).await?;
    refused(
        w.owner
            .call(w.market.id(), "upgrade")
            .args_json(json!({ "code_hash": hash }))
            .gas(Gas::from_tgas(99))
            .transact()
            .await?
            .into_result(),
        "attach at least 100 TGas to upgrade",
    );
    Ok(())
}

#[tokio::test]
async fn seal_waits_for_a_proven_upgrade_and_then_removes_every_access_key() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let id = seed_state(&w).await?;

    for (wasm_name, label, target) in governed_contracts(&w) {
        let key = public_key(target).await;
        assert_eq!(key_count(target).await, 1, "{label} has its one full access key");
        refused(
            w.owner
                .call(target.id(), "seal")
                .args_json(json!({ "public_key": key }))
                .transact()
                .await?
                .into_result(),
            "owner only",
        );

        // Before an upgrade has gone through, the vote to seal is recorded as failed and the key stays.
        let (p, _) = vote_and_execute(&w, &g, seal_call(target, &key)).await?;
        assert_eq!(gov_proposal(&g, p).await["stage"], "execution_failed", "{label}");
        assert_eq!(
            key_count(target).await,
            1,
            "{label}: prove the upgrade path before deleting keys"
        );

        let hash = stage(&w.bob, target.id(), &rebuilt(wasm_name, "v2")).await?;
        vote_and_execute(&w, &g, upgrade_call(target, &hash, UPGRADE_CALL_TGAS)).await?;
        assert_eq!(config(target).await["upgrade_proven"], true);

        // The key still deploys, until it is sealed.
        let (p, logs) = vote_and_execute(&w, &g, seal_call(target, &key)).await?;
        assert_eq!(
            event_names(&logs),
            vec!["call_sent", "seal_sent", "executed"],
            "{label}"
        );
        assert_eq!(gov_proposal(&g, p).await["stage"], "executed");
        assert_eq!(key_count(target).await, 0, "{label} has no access key left");
        let old_key_deploy = target.as_account().deploy(&wasm("mock_ft")).await;
        assert!(old_key_deploy.is_err(), "{label}: the old key can no longer deploy");
        assert_eq!(
            deployed_hash(target).await,
            hash_of(&rebuilt(wasm_name, "v2")),
            "{label} still runs the upgraded code"
        );
    }

    // The contracts keep working with no keys: an account redeems and a case moves on.
    assert!(invariant(&w, id).await);
    assert_eq!(case_json(&w, id).await["stage"], "proposed");
    Ok(())
}

#[tokio::test]
async fn governance_upgrades_itself_through_its_own_vote_and_keeps_its_proposals() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let members_before = g.contract.view("get_members").await?.json::<Vec<String>>()?;
    let key = public_key(&g.contract).await;
    let code = rebuilt("governance", "v2");

    // Anyone stages it, and a seal is refused while the upgrade path is unproven.
    refused(
        w.bob
            .call(g.contract.id(), "stage_code")
            .args(code.clone())
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?
            .into_result(),
        "attach at least",
    );
    let hash = stage(&w.bob, g.contract.id(), &code).await?;
    refused(
        g.members[0]
            .call(g.contract.id(), "propose")
            .args_json(json!({ "action": { "seal": { "public_key": key } } }))
            .transact()
            .await?
            .into_result(),
        "prove the upgrade path before deleting keys",
    );
    refused(
        g.members[0]
            .call(g.contract.id(), "propose")
            .args_json(json!({ "action": { "upgrade_self": { "code_hash": hash_of(b"nobody staged this") } } }))
            .transact()
            .await?
            .into_result(),
        "stage the code first",
    );
    // A call to itself is still not a way around the actions.
    refused(
        g.members[0]
            .call(g.contract.id(), "propose")
            .args_json(json!({ "action": function_call(g.contract.id(), "upgrade", json!({}), 20) }))
            .transact()
            .await?
            .into_result(),
        "governance changes itself only through its own actions",
    );

    // A proposal approved before the upgrade is read, and executed, by the new code afterwards.
    let early = gov_pass(
        &g,
        function_call(w.oracle.id(), "set_jury_size", json!({ "jury_size": 5 }), 20),
    )
    .await?;
    let upgrade = gov_pass(&g, json!({ "upgrade_self": { "code_hash": hash } })).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;

    // Too little gas is refused and says how much to attach; nothing changes.
    refused(
        g.contract
            .call("execute")
            .args_json(json!({ "proposal_id": upgrade.to_string() }))
            .gas(Gas::from_tgas(GAS_EXECUTE_UPGRADE_TGAS - 1))
            .transact()
            .await?
            .into_result(),
        "attach at least 110 TGas to execute an upgrade",
    );
    assert_eq!(gov_proposal(&g, upgrade).await["stage"], "approved");
    assert!(is_staged(&g.contract, &hash).await);

    let old_code = deployed_hash(&g.contract).await;
    let logs = gov_execute(&g, &w.carol, upgrade).await?;
    assert_eq!(event_names(&logs), vec!["upgrade_sent", "migrated", "executed"]);
    assert_eq!(deployed_hash(&g.contract).await, hash);
    assert_ne!(old_code, hash);
    assert!(!is_staged(&g.contract, &hash).await);
    assert_eq!(
        gov_proposal(&g, upgrade).await["stage"],
        "executed",
        "the new code recorded the result of its own deploy"
    );
    let c = config(&g.contract).await;
    assert_eq!(
        (&c["upgrade_proven"], &c["state_version"], &c["proposals"]),
        (&json!(true), &json!(1), &json!("2"))
    );
    assert_eq!(
        g.contract.view("get_members").await?.json::<Vec<String>>()?,
        members_before
    );

    assert_eq!(gov_proposal(&g, early).await["stage"], "approved");
    assert_eq!(
        event_names(&gov_execute(&g, &w.carol, early).await?),
        vec!["call_sent", "executed"]
    );
    assert_eq!(config(&w.oracle).await["jury_size"], 5);

    // And now a seal goes through a vote like any other action and leaves the account with no key.
    assert_eq!(key_count(&g.contract).await, 1);
    let (seal, logs) = vote_and_execute(&w, &g, json!({ "seal": { "public_key": key } })).await?;
    assert_eq!(event_names(&logs), vec!["seal_sent", "executed"]);
    assert_eq!(gov_proposal(&g, seal).await["stage"], "executed");
    assert_eq!(key_count(&g.contract).await, 0);
    assert!(
        g.contract.as_account().deploy(&wasm("mock_ft")).await.is_err(),
        "the old key can no longer deploy"
    );
    // Members still propose: the contract needs no key of its own.
    gov_propose(
        &g,
        &g.members[0],
        function_call(w.oracle.id(), "set_jury_size", json!({ "jury_size": 3 }), 20),
    )
    .await?;
    Ok(())
}

#[tokio::test]
async fn a_failed_governance_self_upgrade_is_recorded_as_failed_and_changes_nothing() -> anyhow::Result<()> {
    let (w, g) = setup_governed().await?;
    let old_code = deployed_hash(&g.contract).await;
    let before = config(&g.contract).await;

    // No migrate, no on_executed: the batch reverts, and the callback runs in the old code that is still there.
    let hash = stage(&w.bob, g.contract.id(), &wasm("mock_ft")).await?;
    let (bad, logs) = vote_and_execute(&w, &g, json!({ "upgrade_self": { "code_hash": hash } })).await?;
    assert_eq!(event_names(&logs), vec!["upgrade_sent", "execution_failed"]);
    assert_eq!(gov_proposal(&g, bad).await["stage"], "execution_failed");
    assert_eq!(deployed_hash(&g.contract).await, old_code);
    let mut after = config(&g.contract).await;
    assert_eq!(after["proposals"], "1");
    after["proposals"] = before["proposals"].clone();
    assert_eq!(after, before);
    assert_eq!(config(&g.contract).await["upgrade_proven"], false);

    // A build whose migrate panics is the same case: the market's migrate cannot read governance's state.
    let hash = stage(&w.bob, g.contract.id(), &wasm("market")).await?;
    let (bad, logs) = vote_and_execute(&w, &g, json!({ "upgrade_self": { "code_hash": hash } })).await?;
    assert_eq!(event_names(&logs), vec!["upgrade_sent", "execution_failed"]);
    assert_eq!(gov_proposal(&g, bad).await["stage"], "execution_failed");
    assert_eq!(deployed_hash(&g.contract).await, old_code);

    // The failed attempts did not break governance: a good upgrade right after goes through.
    let good = stage(&w.bob, g.contract.id(), &rebuilt("governance", "v2")).await?;
    let (ok, logs) = vote_and_execute(&w, &g, json!({ "upgrade_self": { "code_hash": good } })).await?;
    assert_eq!(event_names(&logs), vec!["upgrade_sent", "migrated", "executed"]);
    assert_eq!(gov_proposal(&g, ok).await["stage"], "executed");
    assert_eq!(
        gov_proposal(&g, bad).await["stage"],
        "execution_failed",
        "the old record is still read correctly"
    );
    Ok(())
}

// What each step burns, printed with --nocapture and bounded by what the contracts ask callers to attach.
#[tokio::test]
async fn the_gas_of_staging_upgrading_migrating_and_sealing_fits_what_is_asked() -> anyhow::Result<()> {
    // Here the owner is a plain account, so the calls are made directly and every receipt shows its own burn.
    let w = setup().await?;
    let big = rebuilt("council", "gas");
    let staged = w
        .bob
        .call(w.market.id(), "stage_code")
        .args(big.clone())
        .deposit(STAGE_DEPOSIT)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    println!(
        "stage_code, {} bytes: {} TGas",
        big.len(),
        staged.total_gas_burnt.as_tgas()
    );
    assert!(staged.total_gas_burnt.as_tgas() < 100);

    for (wasm_name, label, target) in governed_contracts(&w) {
        let hash = stage(&w.bob, target.id(), &rebuilt(wasm_name, "gas")).await?;
        let r = w
            .owner
            .call(target.id(), "upgrade")
            .args_json(json!({ "code_hash": hash }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        println!(
            "{label} upgrade, {} bytes, in all: {} TGas",
            rebuilt(wasm_name, "gas").len(),
            r.total_gas_burnt.as_tgas()
        );
        for o in r.outcomes() {
            println!("    {} burnt {} TGas", o.executor_id, o.gas_burnt.as_tgas());
        }
        assert_eq!(
            config(target).await["upgrade_proven"],
            true,
            "{label} ran migrate within 100 TGas"
        );
        assert!(r.total_gas_burnt.as_tgas() < 100, "{label}");
        let key = public_key(target).await;
        let r = w
            .owner
            .call(target.id(), "seal")
            .args_json(json!({ "public_key": key }))
            .transact()
            .await?
            .into_result()?;
        println!("{label} seal in all: {} TGas", r.total_gas_burnt.as_tgas());
        assert_eq!(key_count(target).await, 0, "{label}");
    }

    // Governance executing an upgrade of itself, the largest call: the deploy, migrate and callback in one execute.
    let (w, g) = setup_governed().await?;
    let hash = stage(&w.bob, g.contract.id(), &rebuilt("governance", "gas")).await?;
    let id = gov_pass(&g, json!({ "upgrade_self": { "code_hash": hash } })).await?;
    skip_secs(&w.worker, TIMELOCK_SECS + 1).await;
    let r = g.members[0]
        .call(g.contract.id(), "execute")
        .args_json(json!({ "proposal_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    println!(
        "governance upgrade_self, execute in all: {} TGas",
        r.total_gas_burnt.as_tgas()
    );
    for o in r.outcomes() {
        println!("    {} burnt {} TGas", o.executor_id, o.gas_burnt.as_tgas());
    }
    assert!(r.total_gas_burnt.as_tgas() < GAS_EXECUTE_UPGRADE_TGAS);
    Ok(())
}
