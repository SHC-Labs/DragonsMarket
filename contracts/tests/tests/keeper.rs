// The keeper script, run for real against the sandbox chain with real signed transactions. Four things are stuck that
// only a call can unstick, and one run of the keeper sends each. Needs Node.
mod common;
use common::*;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

// The keeper reads the last final block, which trails the chain by a few blocks, so let it catch up first. The child
// sees only the environment given here, so a key from the shell running the tests can never leak into a run.
async fn run_keeper(w: &World, args: &[&str], env: &[(&str, String)]) -> (String, bool) {
    w.worker.fast_forward(6).await.unwrap();
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../keeper/keeper.mjs");
    let rpc = w.worker.rpc_addr();
    let mut command = Command::new("node");
    command.arg(script).args(args).args([
        "--rpc",
        &rpc,
        "--market",
        w.market.id().as_str(),
        "--oracle",
        w.oracle.id().as_str(),
        "--council",
        w.council.id().as_str(),
        "--account",
        w.dave.id().as_str(),
    ]);
    command
        .env_remove("KEEPER_KEY")
        .env_remove("KEEPER_ORACLE_KEY")
        .env_remove("KEEPER_MARKET_KEY");
    for (name, value) in env {
        command.env(name, value);
    }
    let out = command.output().expect("node runs the keeper");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (text, out.status.success())
}

// The keeper account's full access key, through the environment.
async fn keeper(w: &World, args: &[&str]) -> (String, bool) {
    run_keeper(w, args, &[("KEEPER_KEY", w.dave.secret_key().to_string())]).await
}

fn scratch(w: &World, name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("keeper-{}-{name}", w.market.id()))
}

fn write_key_file(path: &Path, key: &SecretKey, mode: u32) {
    std::fs::write(path, key.to_string()).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

// A function call key on the keeper account, limited to one receiver and the given methods.
async fn scoped_key(w: &World, receiver: &near_workspaces::AccountId, methods: &[&str]) -> anyhow::Result<SecretKey> {
    let key = SecretKey::from_random(KeyType::ED25519);
    let access = AccessKey::function_call_access(receiver, methods, Some(NearToken::from_near(1)));
    w.dave
        .batch(w.dave.id())
        .add_key(key.public_key(), access)
        .transact()
        .await?
        .into_result()?;
    Ok(key)
}

// A seeded market that closes in 120s and must be answered within `gap_secs` after that, with nobody to answer it.
async fn market_with_gap(w: &World, gap_secs: u64) -> anyhow::Result<u64> {
    let close_at = now(&w.worker).await + 120 * 1_000_000_000;
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .args_json(json!({
            "title": "Will nobody answer?", "rule_text": "Resolves Yes if it does.", "resolution_source": "https://example.com",
            "void_policy": "Void if cancelled.", "category": "tech", "subcategory": "ai",
            "close_at": close_at.to_string(), "resolve_by": (close_at + gap_secs * 1_000_000_000).to_string()
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    ft_call(w, &w.owner, w.market.id(), SEED, &format!("seed:{id}")).await?;
    Ok(id)
}

// `extra` new accounts each holding a staked seat, on top of the five the setup stakes.
async fn add_seat_holders(w: &World, extra: usize) -> anyhow::Result<()> {
    for _ in 0..extra {
        let holder = w.worker.dev_create_account().await?;
        mint_nft(w, &holder, holder.id().as_str()).await?;
        stake(w, &holder, holder.id().as_str()).await?;
    }
    Ok(())
}

#[tokio::test]
async fn one_run_of_the_keeper_unsticks_everything_that_is_due_and_a_second_finds_nothing() -> anyhow::Result<()> {
    let w = setup().await?;
    let state = scratch(&w, "state.json");
    let state_arg = state.to_str().unwrap();
    let unfinalized = create_seeded_market(&w, 120).await?;
    let undrawn = create_seeded_market(&w, 120).await?;
    let locked = create_seeded_market(&w, 120).await?;
    let unanswered = market_with_gap(&w, 600).await?;
    skip_secs(&w.worker, 130).await;

    // 1. A proposal whose challenge window ends while the dispute below plays out. Nobody finalizes it.
    propose(&w, &w.carol, unfinalized, "yes").await?;

    // 2. A dispute that settles normally, then a seat put back as a failed unlock would have left it.
    propose(&w, &w.carol, locked, "yes").await?;
    challenge(&w, &w.dave, locked).await?;
    let jury = draw_jury(&w, locked).await?;
    for j in &jury[..2] {
        commit(&w, j, locked, "no", "s").await?;
    }
    to_reveal_phase(&w, locked).await;
    for j in &jury[..2] {
        reveal(&w, j, locked, "no", "s", "The source says no.").await?;
    }
    assert_eq!(case_json(&w, locked).await["stage"], "final");
    let token = jury[2].id().to_string();
    relock_seat(&w, &token, locked).await?;

    // 3. A challenge late enough that its jury is still drawable when the unanswered market's deadline has passed.
    let deadline: u64 = market_json(&w, unanswered).await["resolve_by"]
        .as_str()
        .unwrap()
        .parse()?;
    skip_until(&w, deadline - 25 * 1_000_000_000).await;
    propose(&w, &w.carol, undrawn, "yes").await?;
    challenge(&w, &w.dave, undrawn).await?;
    // Far enough past the deadline that the keeper's last final block, which trails the tip, is past it too, and
    // still inside the 60 s draw window that opened at the challenge.
    skip_until(&w, deadline + 10_000_000_000).await;
    wait_for_draw(&w, undrawn).await;

    // Nothing has been sent yet.
    assert_eq!(case_json(&w, unfinalized).await["stage"], "proposed");
    assert!(case_json(&w, undrawn).await["panel"].as_array().unwrap().is_empty());
    assert!(market_json(&w, unanswered).await["outcome"].is_null());
    assert!(!stake_of(&w, &token).await["serving"].is_null());

    // A dry run says what is due and sends nothing, and keeps no cursor.
    let (dry, ok) = keeper(&w, &["run", "--dry-run", "--state-file", state_arg]).await;
    assert!(ok, "{dry}");
    for due in [
        format!("due oracle.finalize({unfinalized})"),
        format!("due oracle.resolve_draw({undrawn})"),
        format!("due oracle.resolve_by_deadline({unanswered})"),
        format!("due oracle.retry_unlock({locked})"),
    ] {
        assert!(dry.contains(&due), "{due} missing from:\n{dry}");
    }
    assert_eq!(
        case_json(&w, unfinalized).await["stage"],
        "proposed",
        "a dry run sends nothing"
    );
    assert!(!state.exists());

    let (run, ok) = keeper(&w, &["run", "--state-file", state_arg]).await;
    assert!(ok, "{run}");
    for line in [
        format!("oracle.finalize({unfinalized}): ok"),
        format!("oracle.resolve_draw({undrawn}): ok"),
        format!("oracle.resolve_by_deadline({unanswered}): ok"),
        format!("oracle.retry_unlock({locked}): ok"),
    ] {
        assert!(run.contains(&line), "{line} missing from:\n{run}");
    }
    assert!(
        !state.exists(),
        "nothing was finished when this run began, so the cursor did not move"
    );

    assert_eq!(market_json(&w, unfinalized).await["outcome"], "yes");
    assert_eq!(case_json(&w, undrawn).await["panel"].as_array().unwrap().len(), 3);
    assert_eq!(market_json(&w, unanswered).await["outcome"], "void");
    assert!(
        stake_of(&w, &token).await["serving"].is_null(),
        "the seat is free again"
    );

    // Everything due was sent, so a second run finds nothing. Market 0 is finished, and market 1 still has a jury at
    // work, so the cursor stops after market 0 although markets 2 and 3 are finished too.
    let (again, ok) = keeper(&w, &["run", "--state-file", state_arg]).await;
    assert!(ok, "{again}");
    assert!(
        again.contains("nothing due") && again.contains("finished through id 0"),
        "{again}"
    );
    assert_eq!(std::fs::read_to_string(&state)?.trim(), r#"{"finished_through":"0"}"#);

    // The jury decides. The next run starts after market 0, and the cursor moves over all the rest.
    let jury = panel(&w, undrawn).await;
    for j in &jury[..2] {
        commit(&w, j, undrawn, "no", "s").await?;
    }
    to_reveal_phase(&w, undrawn).await;
    for j in &jury[..2] {
        reveal(&w, j, undrawn, "no", "s", "The source says no.").await?;
    }
    assert_eq!(case_json(&w, undrawn).await["stage"], "final");
    let (last, ok) = keeper(&w, &["run", "--state-file", state_arg]).await;
    assert!(ok, "{last}");
    assert!(
        last.contains("nothing due") && last.contains(&format!("finished through id {unanswered}")),
        "{last}"
    );
    assert_eq!(
        std::fs::read_to_string(&state)?.trim(),
        format!(r#"{{"finished_through":"{unanswered}"}}"#)
    );
    std::fs::remove_file(&state)?;
    Ok(())
}

#[tokio::test]
async fn the_keeper_sweeps_fees_once_they_reach_the_minimum_with_keys_scoped_to_each_receiver() -> anyhow::Result<()> {
    let w = setup().await?;
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 100 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    skip_secs(&w.worker, WINDOW_MS / 1000 + 5).await;
    let (collected, _, _) = fees(&w).await;
    assert!(collected > CREATE_FEE, "the trade paid a fee: {collected}");

    // One more unit than there is: not due. Exactly what there is: due.
    let (below, ok) = keeper(&w, &["run", "--dry-run", "--min-sweep", &(collected + 1).to_string()]).await;
    assert!(ok && !below.contains("sweep_fees"), "{below}");
    let (at, ok) = keeper(&w, &["run", "--dry-run", "--min-sweep", &collected.to_string()]).await;
    assert!(ok && at.contains("due market.sweep_fees()"), "{at}");

    let dir = scratch(&w, "keys");
    std::fs::create_dir_all(&dir)?;
    let oracle_key = scoped_key(
        &w,
        w.oracle.id(),
        &[
            "finalize",
            "resolve_draw",
            "retry_apply",
            "retry_unlock",
            "resolve_by_deadline",
        ],
    )
    .await?;
    let market_key = scoped_key(&w, w.market.id(), &["sweep_fees"]).await?;
    let (oracle_file, market_file) = (dir.join("oracle"), dir.join("market"));
    write_key_file(&oracle_file, &oracle_key, 0o600);
    write_key_file(&market_file, &market_key, 0o600);
    let (oracle_arg, market_arg) = (oracle_file.to_str().unwrap(), market_file.to_str().unwrap());

    // No key at all: nothing is sent.
    let (none, ok) = run_keeper(&w, &["run", "--min-sweep", &collected.to_string()], &[]).await;
    assert!(!ok && none.contains("no key for oracle"), "{none}");

    // A key file anyone on the machine can read is refused before anything is sent.
    let loose = dir.join("loose");
    write_key_file(&loose, &oracle_key, 0o644);
    let (readable, ok) = run_keeper(&w, &["run", "--key-file", loose.to_str().unwrap()], &[]).await;
    assert!(
        !ok && readable.contains("can be read by group or others") && readable.contains("chmod 600"),
        "{readable}"
    );

    // A key on the command line is refused.
    let (inline, ok) = run_keeper(&w, &["run", "--key", &oracle_key.to_string()], &[]).await;
    assert!(
        !ok && inline.contains("--key is refused") && !inline.contains(&oracle_key.to_string()),
        "{inline}"
    );

    // The market's key in the oracle's place is turned away by the network, and the proposal stays unfinalized.
    let (wrong, ok) = run_keeper(
        &w,
        &["run", "--oracle-key-file", market_arg, "--market-key-file", market_arg],
        &[],
    )
    .await;
    assert!(!ok && wrong.contains("Receiver"), "{wrong}");
    assert_eq!(case_json(&w, id).await["stage"], "proposed");

    // Each receiver gets its own key, and the full access key is not involved.
    let (run, ok) = run_keeper(
        &w,
        &[
            "run",
            "--min-sweep",
            &collected.to_string(),
            "--oracle-key-file",
            oracle_arg,
            "--market-key-file",
            market_arg,
        ],
        &[],
    )
    .await;
    assert!(ok, "{run}");
    assert!(
        run.contains(&format!("oracle.finalize({id}): ok")) && run.contains("market.sweep_fees(): ok"),
        "{run}"
    );
    assert_eq!(market_json(&w, id).await["outcome"], "yes");
    let (left, revenue_due, treasury_due) = fees(&w).await;
    assert!(
        left <= 1 && revenue_due == 0 && treasury_due == 0,
        "the sweep paid everything out: {left} {revenue_due} {treasury_due}"
    );
    assert!(
        holdings(&w, w.treasury.id()).await >= collected * 3 / 4 - 1,
        "the treasury got its 75%"
    );

    // Fees are below the minimum now, so a second run sweeps nothing.
    let (again, ok) = run_keeper(
        &w,
        &["run", "--oracle-key-file", oracle_arg, "--market-key-file", market_arg],
        &[],
    )
    .await;
    assert!(ok && again.contains("nothing due"), "{again}");
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[tokio::test]
async fn the_deploy_check_reports_whether_the_council_can_seat_a_jury_and_a_second_one() -> anyhow::Result<()> {
    let w = setup().await?;
    for seed in [1u8, 2] {
        let key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        let public = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string());
        w.owner
            .call(w.oracle.id(), "add_publisher")
            .args_json(json!({ "key": public }))
            .transact()
            .await?
            .into_result()?;
    }
    // Five seat holders and a jury of three: enough for a first jury with a proposer and a challenger who hold seats,
    // too few for the second jury of 7 that a failed first round calls for.
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(
        !ok && out.contains("5 different seat holders") && out.contains("12 are needed (3 + 7 + 2)"),
        "{out}"
    );
    assert!(
        !out.contains("every draw will fail") && !out.contains("to be safe"),
        "{out}"
    );

    // Raise the jury to 5: exactly as many holders as jurors, so a dispute whose parties hold seats cannot be drawn.
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": 5 }))
        .transact()
        .await?
        .into_result()?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(
        !ok && out.contains("PROBLEM") && out.contains("7 are needed to be safe"),
        "{out}"
    );

    // And 7 jurors with five holders: every draw fails.
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": 7 }))
        .transact()
        .await?
        .into_result()?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(!ok && out.contains("every draw will fail"), "{out}");

    // Back to 3 with 12 different holders: both juries and both parties fit.
    w.owner
        .call(w.oracle.id(), "set_jury_size")
        .args_json(json!({ "jury_size": 3 }))
        .transact()
        .await?
        .into_result()?;
    add_seat_holders(&w, 6).await?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(
        !ok && out.contains("11 different seat holders") && out.contains("12 are needed (3 + 7 + 2)"),
        "{out}"
    );
    add_seat_holders(&w, 1).await?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(
        ok && out.contains("12 different seat holders") && out.trim_end().ends_with("ok"),
        "{out}"
    );
    Ok(())
}

#[tokio::test]
async fn the_deploy_check_reports_what_each_account_has_left_after_storage_and_warns_under_the_margin(
) -> anyhow::Result<()> {
    let w = setup().await?;
    let treasury = w.worker.dev_create_account().await?;
    let treasury_id = treasury.id().to_string();
    let (out, _) = keeper(&w, &["check", "--treasury", &treasury_id]).await;
    for (name, id) in [
        ("market", w.market.id()),
        ("oracle", w.oracle.id()),
        ("council", w.council.id()),
        ("treasury", treasury.id()),
    ] {
        let line = out
            .lines()
            .find(|l| l.starts_with(&format!("{name} {id}: balance ")))
            .unwrap_or_else(|| panic!("no {name} line in:\n{out}"));
        assert!(
            line.contains("bytes of storage") && line.ends_with("NEAR left after storage"),
            "{line}"
        );
    }
    assert!(
        !out.contains("left after paying for its storage"),
        "every account is funded: {out}"
    );

    // The same accounts under a margin no sandbox account has: each one is a problem.
    let (out, ok) = keeper(&w, &["check", "--treasury", &treasury_id, "--min-margin", "1000"]).await;
    assert!(!ok, "{out}");
    for name in ["market", "oracle", "council", "treasury"] {
        assert!(
            out.contains(&format!("PROBLEM: {name} ")) && out.contains("under the 1000.000 NEAR margin"),
            "{name} missing from:\n{out}"
        );
    }

    // Without --treasury only the three accounts are reported.
    let (out, _) = keeper(&w, &["check"]).await;
    assert!(!out.contains("treasury "), "{out}");
    Ok(())
}

#[tokio::test]
async fn the_deploy_check_reconciles_the_oracle_with_what_the_verifier_holds_for_it() -> anyhow::Result<()> {
    let w = setup().await?;
    let (out, _) = keeper(&w, &["check"]).await;
    assert!(out.contains("oracle owes 0 and holds 0 in the verifier\n"), "{out}");

    let id = create_seeded_market(&w, 120).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    let (out, _) = keeper(&w, &["check"]).await;
    assert!(
        out.contains(&format!("oracle owes {BOND} and holds {BOND} in the verifier\n")),
        "{out}"
    );

    // A plain deposit to the oracle's account is credited to nobody: the verifier holds more than the oracle owes, which is not a
    // problem.
    w.carol
        .call(w.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": w.verifier.id(), "amount": (3 * USD).to_string(), "msg": w.oracle.id() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let (out, _) = keeper(&w, &["check"]).await;
    assert!(
        out.contains(&format!(
            "oracle owes {BOND} and holds {} in the verifier, {} more than it owes",
            BOND + 3 * USD,
            3 * USD
        )),
        "{out}"
    );
    assert!(!out.contains("PROBLEM: the oracle owes"), "{out}");
    Ok(())
}

// The text after `prefix` on the line that starts with it, split at the words that separate the two figures.
fn books_of(out: &str, prefix: &str) -> (u128, u128) {
    let line = out
        .lines()
        .find(|l| l.starts_with(prefix))
        .unwrap_or_else(|| panic!("no line starting {prefix:?} in:\n{out}"));
    let rest = &line[prefix.len()..];
    let (owed, held) = rest.split_once(" and holds ").unwrap();
    let held = held.split(" in the verifier").next().unwrap();
    (owed.parse().unwrap(), held.parse().unwrap())
}

#[tokio::test]
async fn the_deploy_check_reconciles_all_three_contracts_and_reads_what_the_verifier_says_about_each(
) -> anyhow::Result<()> {
    let w = setup().await?;
    let (out, _) = keeper(&w, &["check"]).await;
    for line in [
        "market owes 0 and holds 0 in the verifier\n",
        "oracle owes 0 and holds 0 in the verifier\n",
        "council owes at least 0 and holds 0 in the verifier\n",
        "no keys registered, predecessor authentication on, not locked and mt_transfer running for the market, oracle and council\n",
        "access keys: market 1, oracle 1, council 1\n",
    ] {
        assert!(out.contains(line), "{line:?} missing from:\n{out}");
    }
    assert!(
        !out.contains("is locked") && !out.contains("paused") && !out.contains("public key"),
        "{out}"
    );

    // Money in all three: a market with a trade, a bond in the oracle, and a sweep that sends the Council its 25%.
    let id = create_seeded_market(&w, 120).await?;
    buy(&w, &w.alice, id, "yes", 100 * USD).await?;
    skip_secs(&w.worker, 130).await;
    propose(&w, &w.carol, id, "yes").await?;
    w.carol
        .call(w.market.id(), "sweep_fees")
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    skip_secs(&w.worker, 60).await;
    let (out, _) = keeper(&w, &["check"]).await;
    let (owed, held) = books_of(&out, "market owes ");
    assert!(owed > 0 && owed == held, "{out}");
    assert_eq!(books_of(&out, "oracle owes "), (BOND, BOND), "{out}");
    let (floor, held) = books_of(&out, "council owes at least ");
    assert!(
        held > 0 && floor == held,
        "the Council holds exactly what it took in and has paid nothing: {floor} {held}\n{out}"
    );
    assert!(!out.contains("PROBLEM: the"), "{out}");

    // The verifier locks the market: it can still be paid and cannot pay.
    lock_account(&w, w.market.id()).await?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(
        !ok && out.contains(&format!("PROBLEM: market {} is locked in the verifier", w.market.id())),
        "{out}"
    );
    unlock_account(&w, w.market.id()).await?;

    // The verifier pauses transfers: every payout fails. Its views keep working, so the books are still read.
    pause_transfers(&w).await?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(
        !ok && out.contains(&format!(
            "PROBLEM: the verifier {} has mt_transfer paused",
            w.verifier.id()
        )),
        "{out}"
    );
    assert!(out.contains("market owes "), "{out}");
    unpause_transfers(&w).await?;

    // A key registered in the verifier under the Council's account could move its funds.
    let key = SecretKey::from_random(KeyType::ED25519).public_key();
    w.council
        .as_account()
        .call(w.verifier.id(), "add_public_key")
        .args_json(json!({ "public_key": key }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(
        !ok && out.contains(&format!(
            "PROBLEM: council {} has 1 public key registered in the verifier",
            w.council.id()
        )),
        "{out}"
    );

    // Access keys are a problem only when the contracts are expected to be sealed.
    assert!(!out.contains("still has"), "{out}");
    let (out, _) = keeper(&w, &["check", "--expect-sealed"]).await;
    for (name, who) in [
        ("market", w.market.id()),
        ("oracle", w.oracle.id()),
        ("council", w.council.id()),
    ] {
        assert!(
            out.contains(&format!(
                "PROBLEM: {name} {who} still has 1 access key: the owner has not sealed it"
            )),
            "{out}"
        );
    }

    // The oracle turns off authentication by its predecessor in the verifier, and its own payout calls would be refused.
    w.oracle
        .as_account()
        .call(w.verifier.id(), "disable_auth_by_predecessor_id")
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(
        !ok && out.contains(&format!(
            "PROBLEM: oracle {} does not authenticate by predecessor in the verifier",
            w.oracle.id()
        )),
        "{out}"
    );
    Ok(())
}

#[tokio::test]
async fn the_deploy_check_reports_money_missing_from_the_verifier_only_after_reading_again() -> anyhow::Result<()> {
    let w = setup().await?;
    create_seeded_market(&w, 120).await?;
    let (owed, held) = books_of(&keeper(&w, &["check"]).await.0, "market owes ");
    assert!(owed > 0 && owed == held);

    // The market's own key takes one unit out of its verifier account without touching its books: the shortfall a deployer
    // key could cause, and what sealing exists to prevent.
    w.market
        .as_account()
        .call(w.verifier.id(), "mt_transfer")
        .args_json(json!({ "receiver_id": w.alice.id(), "token_id": token_id(&w), "amount": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let started = std::time::Instant::now();
    let (out, ok) = keeper(&w, &["check"]).await;
    assert!(
        !ok && out.contains(&format!(
            "PROBLEM: the market owes {owed} but the verifier holds only {} for it: 1 is missing",
            owed - 1
        )),
        "{out}"
    );
    assert!(
        started.elapsed() > std::time::Duration::from_secs(2),
        "a shortfall is read again some blocks later before it is reported"
    );
    assert!(
        !out.contains("PROBLEM: the oracle") && !out.contains("PROBLEM: the council"),
        "{out}"
    );
    Ok(())
}
