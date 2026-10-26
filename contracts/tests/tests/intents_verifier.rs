// Proves what the design assumes about the NEAR Intents verifier, using the real contract built from
// github.com/near/intents at 16d04f6ec4401263f8914638710260da50bb46b0 (see contracts/INTENTS-PROOF.md for the build).
// The verifier wasm is not committed. Without it at target/intents/defuse.wasm every test here fails with the build recipe, and
// CI must build it first.
mod common;
use common::{implicit_id, nep413_signed, verifier_wasm, wasm, FAR_DEADLINE, USD};
use ed25519_dalek::SigningKey;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const STORAGE_PRICE_PER_BYTE: u128 = 10_000_000_000_000_000_000;

struct Env {
    worker: Worker<Sandbox>,
    verifier: Contract,
    usdc: Contract,
    recv: Contract,
    owner: Account,
    alice: Account,
    bob: Account,
}

impl Env {
    fn token_id(&self) -> String {
        format!("nep141:{}", self.usdc.id())
    }
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let verifier = worker.dev_deploy(&verifier_wasm()).await?;
    let usdc = worker.dev_deploy(&wasm("mock_ft")).await?;
    let recv = worker.dev_deploy(&wasm("mock_mt_receiver")).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;

    verifier
        .call("new")
        .args_json(json!({ "config": {
            "wnear_id": "wrap.near",
            "fees": { "fee": 0, "fee_collector": owner.id() },
            "roles": {
                "super_admins": [owner.id()],
                "grantees": { "DAO": [owner.id()], "UnrestrictedAccountLocker": [owner.id()], "UnrestrictedAccountUnlocker": [owner.id()] }
            }
        }}))
        .transact()
        .await?
        .into_result()?;
    usdc.call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(usdc.id(), "storage_deposit")
        .args_json(json!({ "account_id": verifier.id(), "registration_only": true }))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    for who in [&alice, &bob] {
        owner
            .call(usdc.id(), "mint")
            .args_json(json!({ "account_id": who.id(), "amount": (1000 * USD).to_string() }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Env {
        worker,
        verifier,
        usdc,
        recv,
        owner,
        alice,
        bob,
    })
}

async fn deposit(e: &Env, from: &Account, amount: u128, msg: &str) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(e.usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": e.verifier.id(), "amount": amount.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
}

async fn balance(e: &Env, who: &AccountId) -> anyhow::Result<u128> {
    let v: String = e
        .verifier
        .view("mt_balance_of")
        .args_json(json!({ "account_id": who, "token_id": e.token_id() }))
        .await?
        .json()?;
    Ok(v.parse()?)
}

async fn balance_of_token(e: &Env, token_id: String) -> anyhow::Result<String> {
    Ok(e.verifier
        .view("mt_balance_of")
        .args_json(json!({ "account_id": e.alice.id(), "token_id": token_id }))
        .await?
        .json()?)
}

async fn mt_supply(e: &Env) -> anyhow::Result<u128> {
    let supply: Option<String> = e
        .verifier
        .view("mt_supply")
        .args_json(json!({ "token_id": e.token_id() }))
        .await?
        .json()?;
    Ok(supply.map_or(Ok(0), |s| s.parse())?)
}

async fn ft_held_by_verifier(e: &Env) -> anyhow::Result<u128> {
    let held: String = e
        .usdc
        .view("ft_balance_of")
        .args_json(json!({ "account_id": e.verifier.id() }))
        .await?
        .json()?;
    Ok(held.parse()?)
}

async fn transfer_call_with(
    e: &Env,
    from: &Account,
    to: &AccountId,
    amount: u128,
    msg: &str,
    gas: Gas,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(e.verifier.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": to, "token_id": e.token_id(), "amount": amount.to_string(), "memo": "test", "msg": msg
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(gas)
        .transact()
        .await?)
}

async fn transfer_call(
    e: &Env,
    from: &Account,
    to: &AccountId,
    amount: u128,
    msg: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    transfer_call_with(e, from, to, amount, msg, Gas::from_tgas(300)).await
}

async fn notifications(contract: &Contract) -> anyhow::Result<Vec<Value>> {
    Ok(contract.view("notifications").await?.json()?)
}

fn burnt_by(r: &ExecutionFinalResult, who: &AccountId) -> f64 {
    r.outcomes()
        .iter()
        .filter(|o| &o.executor_id == who)
        .map(|o| o.gas_burnt.as_gas() as f64 / 1e12)
        .sum()
}

fn total_burnt(r: &ExecutionFinalResult) -> f64 {
    r.total_gas_burnt.as_gas() as f64 / 1e12
}

fn assert_clean(label: &str, r: &ExecutionFinalResult) {
    assert!(
        r.is_success() && r.failures().is_empty(),
        "{label} had a failing receipt: {:?}",
        r.failures()
    );
}

fn touched(r: &ExecutionFinalResult, who: &AccountId) -> bool {
    r.outcomes().iter().any(|o| &o.executor_id == who)
}

// Claim a: ft_transfer_call with a msg naming the recipient credits nep141:<token> to that account.
#[tokio::test]
async fn deposit_credits_the_account_named_in_msg() -> anyhow::Result<()> {
    let e = setup().await?;
    let r = deposit(&e, &e.alice, 10 * USD, e.bob.id().as_str()).await?;
    assert_clean("deposit", &r);
    assert_eq!(
        balance(&e, e.bob.id()).await?,
        10 * USD,
        "the named recipient is credited"
    );
    assert_eq!(
        balance(&e, e.alice.id()).await?,
        0,
        "the sender is not credited when a recipient is named"
    );

    let r = deposit(&e, &e.alice, 4 * USD, "").await?;
    assert_clean("deposit with an empty msg", &r);
    assert_eq!(
        balance(&e, e.alice.id()).await?,
        4 * USD,
        "an empty msg credits the sender"
    );

    let ft_held: String = e
        .usdc
        .view("ft_balance_of")
        .args_json(json!({ "account_id": e.verifier.id() }))
        .await?
        .json()?;
    assert_eq!(
        ft_held,
        (14 * USD).to_string(),
        "the token itself sits in the verifier's account"
    );
    println!(
        "deposit gas: {:.1} TGas total, verifier {:.1}",
        total_burnt(&r),
        burnt_by(&r, e.verifier.id())
    );
    Ok(())
}

// Claim b: no notification on deposit in 0.4.5, whatever the msg asks for.
#[tokio::test]
async fn deposit_never_notifies_the_receiver() -> anyhow::Result<()> {
    let e = setup().await?;
    let r = deposit(&e, &e.alice, 10 * USD, e.recv.id().as_str()).await?;
    assert_clean("deposit to a contract", &r);
    assert!(!touched(&r, e.recv.id()), "no receipt ran on the receiver");
    assert!(notifications(&e.recv).await?.is_empty());
    assert_eq!(balance(&e, e.recv.id()).await?, 10 * USD);

    let old_form = json!({ "receiver_id": e.recv.id(), "msg": "hello", "min_gas": 30_000_000_000_000u64 }).to_string();
    let r = deposit(&e, &e.alice, 5 * USD, &old_form).await?;
    println!(
        "deposit with the old notify form: success {} failures {:?}",
        r.is_success(),
        r.failures()
    );
    assert!(
        !touched(&r, e.recv.id()),
        "the old notify form does not reach the receiver either"
    );
    assert!(notifications(&e.recv).await?.is_empty());
    let credited = balance(&e, e.recv.id()).await?;
    println!("receiver balance after the old notify form: {credited}");
    assert!(credited == 15 * USD || credited == 10 * USD);
    Ok(())
}

// Claim c: mt_transfer_call notifies with the true sender, and the resolve step refunds on a bad receiver.
#[tokio::test]
async fn transfer_call_notifies_and_refunds_on_a_bad_receiver() -> anyhow::Result<()> {
    let e = setup().await?;
    let token = e.token_id();
    deposit(&e, &e.alice, 100 * USD, "").await?.into_result()?;

    let r = transfer_call(&e, &e.alice, e.recv.id(), 30 * USD, "keep").await?;
    assert_clean("keep", &r);
    let kept: Vec<String> = r.json()?;
    assert_eq!(
        kept,
        vec![(30 * USD).to_string()],
        "the verifier reports the amount the receiver kept"
    );
    assert_eq!(balance(&e, e.recv.id()).await?, 30 * USD);
    assert_eq!(balance(&e, e.alice.id()).await?, 70 * USD);
    let seen = notifications(&e.recv).await?;
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["predecessor"], json!(e.verifier.id()));
    assert_eq!(seen[0]["sender_id"], json!(e.alice.id()));
    assert_eq!(seen[0]["previous_owner_ids"], json!([e.alice.id()]));
    assert_eq!(seen[0]["token_ids"], json!([token]));
    assert_eq!(seen[0]["amounts"], json!([(30 * USD).to_string()]));
    assert_eq!(seen[0]["msg"], json!("keep"));

    for bad in ["panic", "malformed", "wrong_len", "refund_all"] {
        let before = (balance(&e, e.alice.id()).await?, balance(&e, e.recv.id()).await?);
        let r = transfer_call(&e, &e.alice, e.recv.id(), 10 * USD, bad).await?;
        assert!(r.is_success(), "{bad}: the verifier call itself succeeds");
        let kept: Vec<String> = r.json()?;
        assert_eq!(kept, vec!["0".to_string()], "{bad}: nothing counts as transferred");
        let after = (balance(&e, e.alice.id()).await?, balance(&e, e.recv.id()).await?);
        assert_eq!(after, before, "{bad}: the sender is refunded in full");
    }

    let r = transfer_call(&e, &e.alice, e.recv.id(), 10 * USD, "refund:4000000").await?;
    assert_clean("partial refund", &r);
    assert_eq!(
        balance(&e, e.recv.id()).await?,
        36 * USD,
        "a partial refund leaves the receiver the rest"
    );
    assert_eq!(balance(&e, e.alice.id()).await?, 64 * USD);

    let r = transfer_call(&e, &e.alice, e.recv.id(), 10 * USD, "refund:99999999999999").await?;
    assert_clean("over-refund", &r);
    assert_eq!(
        balance(&e, e.recv.id()).await?,
        36 * USD,
        "a refund above the amount is clamped to the amount"
    );

    let r = transfer_call(&e, &e.alice, e.bob.id(), 10 * USD, "x").await?;
    assert!(r.is_success());
    assert_eq!(
        balance(&e, e.alice.id()).await?,
        64 * USD,
        "a receiver account with no contract refunds in full"
    );
    assert_eq!(balance(&e, e.bob.id()).await?, 0);

    let r = e
        .alice
        .call(e.verifier.id(), "mt_transfer_call")
        .args_json(json!({ "receiver_id": e.recv.id(), "token_id": token, "amount": "1", "msg": "keep" }))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure(), "no yocto attached is refused");
    let r = transfer_call(&e, &e.bob, e.recv.id(), USD, "keep").await?;
    assert!(
        r.is_failure(),
        "an account with no balance of its own cannot move another account's funds"
    );
    assert_eq!(balance(&e, e.alice.id()).await?, 64 * USD);
    let r = transfer_call(&e, &e.alice, e.alice.id(), USD, "keep").await?;
    assert!(r.is_failure(), "a transfer to oneself is refused");
    let r = transfer_call(&e, &e.alice, e.recv.id(), 0, "keep").await?;
    assert!(r.is_failure(), "a zero amount is refused");
    Ok(())
}

// Claims d and e: a contract with no keys pays out of its own Intents balance, and its balance is only reachable by that
// call. Gas is measured on the way.
#[tokio::test]
async fn keyless_contract_pays_out_by_cross_contract_call() -> anyhow::Result<()> {
    let e = setup().await?;
    let token = e.token_id();
    let sink = e.worker.dev_deploy(&wasm("mock_mt_receiver")).await?;
    deposit(&e, &e.alice, 100 * USD, e.recv.id().as_str())
        .await?
        .into_result()?;

    let keys = e.worker.view_access_keys(e.recv.id()).await?;
    let mut batch = e.recv.as_account().batch(e.recv.id());
    for key in keys {
        batch = batch.delete_key(key.public_key);
    }
    batch.transact().await?.into_result()?;
    assert!(
        e.worker.view_access_keys(e.recv.id()).await?.is_empty(),
        "the contract has no access keys"
    );

    let public_keys: Vec<Value> = e
        .verifier
        .view("public_keys_of")
        .args_json(json!({ "account_id": e.recv.id() }))
        .await?
        .json()?;
    assert!(
        public_keys.is_empty(),
        "no public key is registered for the contract in the verifier"
    );
    let auth: bool = e
        .verifier
        .view("is_auth_by_predecessor_id_enabled")
        .args_json(json!({ "account_id": e.recv.id() }))
        .await?
        .json()?;
    assert!(auth, "authentication by predecessor is on");
    let auth_unknown: bool = e
        .verifier
        .view("is_auth_by_predecessor_id_enabled")
        .args_json(json!({ "account_id": "never-seen.test.near" }))
        .await?
        .json()?;
    assert!(auth_unknown, "it is on for an account the verifier has never seen too");

    let pay = |to: &AccountId, amount: u128| {
        e.bob
            .call(e.recv.id(), "pay")
            .args_json(json!({ "verifier": e.verifier.id(), "receiver_id": to, "token_id": token, "amount": amount.to_string() }))
            .max_gas()
            .transact()
    };
    let r = pay(e.alice.id(), 40 * USD).await?;
    assert_clean("pay", &r);
    assert_eq!(balance(&e, e.alice.id()).await?, 40 * USD);
    assert_eq!(balance(&e, e.recv.id()).await?, 60 * USD);
    println!(
        "mt_transfer from a contract: total {:.1} TGas, verifier {:.1}, contract {:.1}",
        total_burnt(&r),
        burnt_by(&r, e.verifier.id()),
        burnt_by(&r, e.recv.id())
    );
    let mt_transfer_verifier = burnt_by(&r, e.verifier.id());

    let pay_call = |to: &AccountId, amount: u128, msg: &str| {
        e.bob
            .call(e.recv.id(), "pay_call")
            .args_json(json!({
                "verifier": e.verifier.id(), "receiver_id": to, "token_id": token, "amount": amount.to_string(), "msg": msg
            }))
            .max_gas()
            .transact()
    };
    let r = pay_call(sink.id(), 10 * USD, "keep").await?;
    assert_clean("pay_call to a receiver that keeps", &r);
    assert_eq!(balance(&e, sink.id()).await?, 10 * USD);
    assert_eq!(balance(&e, e.recv.id()).await?, 50 * USD);
    let seen = notifications(&sink).await?;
    assert_eq!(
        seen[0]["sender_id"],
        json!(e.recv.id()),
        "the receiver sees the paying contract as sender"
    );
    println!(
        "mt_transfer_call keep: total {:.1} TGas, verifier {:.1}, receiver {:.1}, payer {:.1}",
        total_burnt(&r),
        burnt_by(&r, e.verifier.id()),
        burnt_by(&r, sink.id()),
        burnt_by(&r, e.recv.id())
    );
    println!(
        "  notification overhead over a plain mt_transfer: {:.1} TGas verifier, {:.1} TGas receiver",
        burnt_by(&r, e.verifier.id()) - mt_transfer_verifier,
        burnt_by(&r, sink.id())
    );

    let r = pay_call(sink.id(), 10 * USD, "panic").await?;
    assert!(r.is_success());
    assert_eq!(
        balance(&e, e.recv.id()).await?,
        50 * USD,
        "a panicking receiver sends the funds back to the paying contract"
    );
    assert_eq!(balance(&e, sink.id()).await?, 10 * USD);
    println!(
        "mt_transfer_call panic: total {:.1} TGas, verifier {:.1}, receiver {:.1}",
        total_burnt(&r),
        burnt_by(&r, e.verifier.id()),
        burnt_by(&r, sink.id())
    );

    let r = pay(e.alice.id(), 50 * USD).await?;
    assert_clean("pay the rest", &r);
    assert_eq!(balance(&e, e.recv.id()).await?, 0);
    let r = pay(e.alice.id(), 1).await?;
    assert!(r.is_failure(), "paying more than the contract holds is refused");

    let public_keys: Vec<Value> = e
        .verifier
        .view("public_keys_of")
        .args_json(json!({ "account_id": e.recv.id() }))
        .await?
        .json()?;
    assert!(public_keys.is_empty(), "paying out did not register a key");
    Ok(())
}

// How little gas each call survives with, for a receiver that does almost nothing.
#[tokio::test]
async fn gas_floors_of_the_verifier_calls() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, &e.alice, 100 * USD, "").await?.into_result()?;

    let mut floor_transfer = None;
    for tgas in [1u64, 2, 3, 5, 8, 15] {
        let r = e
            .alice
            .call(e.verifier.id(), "mt_transfer")
            .args_json(json!({ "receiver_id": e.bob.id(), "token_id": e.token_id(), "amount": "1", "memo": "g" }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await?;
        println!(
            "mt_transfer with {tgas} TGas: {}",
            if r.is_success() { "ok" } else { "failed" }
        );
        if r.is_success() && floor_transfer.is_none() {
            floor_transfer = Some(tgas);
        }
    }
    println!("mt_transfer floor among the tried values: {floor_transfer:?} TGas");

    let mut floor_call = None;
    for tgas in [15u64, 20, 21, 25, 30, 50, 100, 200, 300] {
        let before = balance(&e, e.recv.id()).await?;
        let r = transfer_call_with(&e, &e.alice, e.recv.id(), 1, "keep", Gas::from_tgas(tgas)).await?;
        let kept = balance(&e, e.recv.id()).await? - before;
        let given = notifications(&e.recv)
            .await?
            .last()
            .map_or(0, |n| n["prepaid_gas"].as_u64().unwrap())
            / 1_000_000_000;
        println!(
            "mt_transfer_call with {tgas} TGas: tx {} funds kept by receiver {kept}, last mt_on_transfer got {given} GGas",
            if r.is_success() { "ok" } else { "failed" }
        );
        if kept == 1 && floor_call.is_none() {
            floor_call = Some(tgas);
        }
    }
    println!("mt_transfer_call floor among the tried values: {floor_call:?} TGas");
    assert!(floor_transfer.is_some() && floor_call.is_some());
    Ok(())
}

fn signed_transfer(
    e: &Env,
    key: &SigningKey,
    to: &AccountId,
    amount: u128,
    msg: &str,
    nonce: u8,
    min_gas: Option<u64>,
) -> Value {
    let mut transfer = json!({
        "intent": "transfer", "receiver_id": to, "tokens": { e.token_id(): amount.to_string() }, "msg": msg
    });
    if let Some(gas) = min_gas {
        transfer["min_gas"] = json!(gas);
    }
    let message = json!({ "signer_id": implicit_id(key), "deadline": FAR_DEADLINE, "intents": [transfer] }).to_string();
    nep413_signed(key, &message, [nonce; 32], e.verifier.id().as_str())
}

// Claim f: a signed transfer with a notification, relayed by anyone, calls mt_on_transfer with the signer as sender.
#[tokio::test]
async fn signed_transfer_notifies_with_the_signer_as_sender() -> anyhow::Result<()> {
    let e = setup().await?;
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let signer = implicit_id(&key);
    deposit(&e, &e.alice, 100 * USD, &signer).await?.into_result()?;
    let signer_id: AccountId = signer.parse()?;
    assert_eq!(balance(&e, &signer_id).await?, 100 * USD);

    let relay = |payload: Value, gas: Gas| {
        e.bob
            .call(e.verifier.id(), "execute_intents")
            .args_json(json!({ "signed": [payload] }))
            .gas(gas)
            .transact()
    };

    let payload = signed_transfer(&e, &key, e.recv.id(), 30 * USD, "keep", 1, None);
    let r = relay(payload.clone(), Gas::from_tgas(300)).await?;
    assert_clean("signed transfer", &r);
    assert_eq!(balance(&e, e.recv.id()).await?, 30 * USD);
    assert_eq!(balance(&e, &signer_id).await?, 70 * USD);
    let seen = notifications(&e.recv).await?;
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["predecessor"], json!(e.verifier.id()));
    assert_eq!(
        seen[0]["sender_id"],
        json!(signer_id),
        "the signer, not the relayer, is the sender"
    );
    assert_eq!(seen[0]["previous_owner_ids"], json!([signer_id]));
    assert_eq!(seen[0]["msg"], json!("keep"));
    println!(
        "signed transfer with a notification: total {:.1} TGas, verifier {:.1}, receiver {:.1}",
        total_burnt(&r),
        burnt_by(&r, e.verifier.id()),
        burnt_by(&r, e.recv.id())
    );

    let r = relay(payload, Gas::from_tgas(300)).await?;
    assert!(r.is_failure(), "replaying the same signed intent is refused");
    assert_eq!(balance(&e, e.recv.id()).await?, 30 * USD);

    let r = relay(
        signed_transfer(&e, &key, e.recv.id(), 10 * USD, "panic", 2, None),
        Gas::from_tgas(300),
    )
    .await?;
    assert!(
        r.is_success(),
        "the relayer transaction succeeds although the receiver refused"
    );
    assert_eq!(
        balance(&e, e.recv.id()).await?,
        30 * USD,
        "the refusing receiver keeps nothing"
    );
    assert_eq!(
        balance(&e, &signer_id).await?,
        70 * USD,
        "the signer is refunded inside the verifier"
    );
    assert!(
        r.logs().iter().any(|l| l.contains("\"memo\":\"refund\"")),
        "the refund is logged with the memo refund: {:?}",
        r.logs()
    );

    let r = relay(
        signed_transfer(&e, &key, e.recv.id(), 5 * USD, "keep", 3, Some(60_000_000_000_000)),
        Gas::from_tgas(300),
    )
    .await?;
    assert_clean("signed transfer with min_gas", &r);
    assert_eq!(balance(&e, e.recv.id()).await?, 35 * USD);

    let other = SigningKey::from_bytes(&[9u8; 32]);
    let mut forged = signed_transfer(&e, &key, e.recv.id(), USD, "keep", 4, None);
    let stranger = signed_transfer(&e, &other, e.recv.id(), USD, "keep", 4, None);
    forged["public_key"] = stranger["public_key"].clone();
    forged["signature"] = stranger["signature"].clone();
    let r = relay(forged, Gas::from_tgas(300)).await?;
    assert!(
        r.is_failure(),
        "a signature from a key that is not the signer's is refused"
    );

    for tgas in [40u64, 45, 50, 55, 60, 100, 300] {
        let before = balance(&e, e.recv.id()).await?;
        let r = relay(
            signed_transfer(&e, &key, e.recv.id(), 1, "keep", 10 + tgas as u8, None),
            Gas::from_tgas(tgas),
        )
        .await?;
        let kept = balance(&e, e.recv.id()).await? - before;
        let given = notifications(&e.recv)
            .await?
            .last()
            .map_or(0, |n| n["prepaid_gas"].as_u64().unwrap())
            / 1_000_000_000;
        println!(
            "execute_intents with a default notification and {tgas} TGas: tx {} kept by receiver {kept}, last mt_on_transfer got {given} GGas",
            if r.is_success() { "ok" } else { "failed" }
        );
    }
    Ok(())
}

// Claim g: receiving needs no registration, and the verifier carries the storage.
#[tokio::test]
async fn receiving_needs_no_storage_registration() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, &e.alice, 100 * USD, "").await?.into_result()?;

    let fresh: AccountId = "never-registered.test.near".parse()?;
    let before = e.worker.view_account(e.verifier.id()).await?;
    let r = e
        .alice
        .call(e.verifier.id(), "mt_transfer")
        .args_json(json!({ "receiver_id": fresh, "token_id": e.token_id(), "amount": "1000000" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_clean("transfer to an account that never registered", &r);
    assert_eq!(balance(&e, &fresh).await?, USD);
    let after = e.worker.view_account(e.verifier.id()).await?;
    println!(
        "a new Intents account grew the verifier's storage by {} bytes, about {} yocto locked in the verifier",
        after.storage_usage - before.storage_usage,
        (after.storage_usage - before.storage_usage) as u128 * STORAGE_PRICE_PER_BYTE
    );
    assert!(
        after.storage_usage > before.storage_usage,
        "the verifier stores the new account"
    );

    let before = e.worker.view_account(e.verifier.id()).await?;
    deposit(&e, &e.alice, 10 * USD, e.bob.id().as_str())
        .await?
        .into_result()?;
    let after = e.worker.view_account(e.verifier.id()).await?;
    println!(
        "a deposit that creates a new account grew storage by {} bytes",
        after.storage_usage - before.storage_usage
    );

    let r = e
        .alice
        .call(e.verifier.id(), "mt_transfer")
        .args_json(json!({ "receiver_id": e.bob.id(), "token_id": e.token_id(), "amount": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_clean("transfer to an existing account", &r);
    Ok(())
}

// Claim h: money sent without a callback shows up as a balance the receiver never accounted for.
#[tokio::test]
async fn unattributed_surplus_is_visible_without_a_callback() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, &e.alice, 25 * USD, e.recv.id().as_str())
        .await?
        .into_result()?;
    assert!(notifications(&e.recv).await?.is_empty(), "the receiver was never told");
    assert_eq!(
        balance(&e, e.recv.id()).await?,
        25 * USD,
        "but mt_balance_of shows the credit"
    );

    assert_eq!(mt_supply(&e).await?, ft_held_by_verifier(&e).await?);

    e.alice
        .call(e.usdc.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": e.verifier.id(), "amount": (7 * USD).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        ft_held_by_verifier(&e).await? - mt_supply(&e).await?,
        7 * USD,
        "a plain ft_transfer to the verifier credits nobody"
    );
    assert_eq!(balance(&e, e.alice.id()).await?, 0);
    Ok(())
}

// Token id formats: only the nep141:<contract> form is a balance.
#[tokio::test]
async fn token_id_must_be_the_nep141_form() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, &e.alice, 10 * USD, "").await?.into_result()?;
    assert_eq!(balance_of_token(&e, e.token_id()).await?, (10 * USD).to_string());
    assert_eq!(
        balance_of_token(&e, e.usdc.id().to_string()).await?,
        "0",
        "the bare contract id is not a token id"
    );
    assert_eq!(
        balance_of_token(&e, e.token_id().to_uppercase()).await?,
        "0",
        "the prefix is case sensitive"
    );
    let r = e
        .alice
        .call(e.verifier.id(), "mt_transfer")
        .args_json(json!({ "receiver_id": e.bob.id(), "token_id": e.usdc.id(), "amount": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure(), "a transfer with a bare contract id is refused");
    Ok(())
}

// The emergency powers the design has to disclose: a pause or an account lock stops payouts, and neither stops receipts.
#[tokio::test]
async fn pause_and_lock_stop_payouts_but_not_receipts() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, &e.alice, 100 * USD, e.recv.id().as_str())
        .await?
        .into_result()?;
    deposit(&e, &e.bob, 50 * USD, "").await?.into_result()?;
    let pay = || {
        e.alice
            .call(e.recv.id(), "pay")
            .args_json(json!({
                "verifier": e.verifier.id(), "receiver_id": e.alice.id(), "token_id": e.token_id(), "amount": "1000000"
            }))
            .max_gas()
            .transact()
    };
    let admin = |method: &str, args: Value| {
        let yocto = if method.starts_with("force_") { 1 } else { 0 };
        e.owner
            .call(e.verifier.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(yocto))
            .transact()
    };

    admin("pa_pause_feature", json!({ "key": "mt_transfer" }))
        .await?
        .into_result()?;
    assert!(
        pay().await?.is_failure(),
        "a paused verifier refuses the contract's payout"
    );
    assert_eq!(
        balance(&e, e.recv.id()).await?,
        100 * USD,
        "the refused payout moved nothing"
    );
    let r = transfer_call(&e, &e.bob, e.recv.id(), 5 * USD, "keep").await?;
    assert!(
        r.is_failure(),
        "a paused verifier refuses transfer calls to the contract as well"
    );
    admin("pa_unpause_feature", json!({ "key": "mt_transfer" }))
        .await?
        .into_result()?;
    assert_clean("payout after unpause", &pay().await?);

    let locked: bool = admin("force_lock_account", json!({ "account_id": e.recv.id() }))
        .await?
        .json()?;
    assert!(locked);
    assert!(pay().await?.is_failure(), "a locked account cannot send");
    let r = transfer_call(&e, &e.bob, e.recv.id(), 5 * USD, "keep").await?;
    assert_clean("transfer call into a locked account", &r);
    assert_eq!(
        balance(&e, e.recv.id()).await?,
        104 * USD,
        "a locked account still receives"
    );
    admin("force_unlock_account", json!({ "account_id": e.recv.id() }))
        .await?
        .into_result()?;
    assert_clean("payout after unlock", &pay().await?);
    Ok(())
}
