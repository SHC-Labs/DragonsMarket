// Up and Down rounds against the real verifier. Stakers who hold no NEAR register, stake and withdraw by signed intents, and
// prices that two of three publishers signed decide the round. Real contracts, sandbox chain.
mod common;
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::{json, Value};

const SECOND: u64 = 1_000_000_000;
const INTERVAL_SECS: u64 = 300;
const WINDOW_SECS: u64 = 60;
const CLOSE_BEFORE_SECS: u64 = 150;

struct Rounds {
    contract: Contract,
    publishers: Vec<SigningKey>,
    first_start: u64,
}

impl Rounds {
    fn start_of(&self, round: u64) -> u64 {
        self.first_start + round * INTERVAL_SECS * SECOND
    }

    fn close_of(&self, round: u64) -> u64 {
        self.start_of(round + 1) - CLOSE_BEFORE_SECS * SECOND
    }

    // `signers`' entries over the price at the start of `round`.
    fn signatures(&self, signers: &[&SigningKey], round: u64, price: u128) -> String {
        let message = format!(
            "round-price:v1:{}:{NETWORK}:btc-usd:{}:{price}:2",
            self.contract.id(),
            self.start_of(round)
        );
        signers
            .iter()
            .map(|k| {
                let signature: String = k
                    .sign(message.as_bytes())
                    .to_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                format!("{}.{signature}", public_key(k))
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    fn quorum(&self, round: u64, price: u128) -> String {
        self.signatures(&[&self.publishers[0], &self.publishers[2]], round, price)
    }
}

fn public_key(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().as_bytes()).into_string())
}

// Three publishers, two of whom must sign, and one series of 2-minute rounds whose round 0 starts shortly.
async fn deploy(w: &World) -> anyhow::Result<Rounds> {
    let contract = w.worker.dev_deploy(&wasm("rounds")).await?;
    contract
        .call("new")
        .args_json(json!({
            "owner_id": w.owner.id(), "operator_id": w.owner.id(), "verifier_id": w.verifier.id(),
            "collateral_token_id": token_id(w), "network": NETWORK, "price_threshold": 2
        }))
        .transact()
        .await?
        .into_result()?;
    let publishers: Vec<SigningKey> = (31..=33).map(|s| SigningKey::from_bytes(&[s; 32])).collect();
    for k in &publishers {
        w.owner
            .call(contract.id(), "add_publisher")
            .args_json(json!({ "key": public_key(k) }))
            .transact()
            .await?
            .into_result()?;
    }
    let first_start = now(&w.worker).await + 30 * SECOND;
    w.owner
        .call(contract.id(), "add_series")
        .args_json(json!({
            "asset": "btc-usd", "decimals": 2, "first_start": first_start.to_string(),
            "interval": (INTERVAL_SECS * SECOND).to_string(), "price_window": (WINDOW_SECS * SECOND).to_string(),
            "close_before": (CLOSE_BEFORE_SECS * SECOND).to_string()
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Rounds {
        contract,
        publishers,
        first_start,
    })
}

fn signed(w: &World, key: &SigningKey, intent: Value, nonce: u8) -> Value {
    let message = json!({ "signer_id": implicit_id(key), "deadline": FAR_DEADLINE, "intents": [intent] }).to_string();
    nep413_signed(key, &message, [nonce; 32], w.verifier.id().as_str())
}

fn transfer(w: &World, to: &AccountId, amount: u128, msg: &str) -> Value {
    json!({ "intent": "transfer", "receiver_id": to, "tokens": { token_id(w): amount.to_string() }, "msg": msg })
}

fn action(to: &AccountId, msg: &str) -> Value {
    json!({ "intent": "auth_call", "contract_id": to, "msg": msg, "min_gas": Gas::from_tgas(50).as_gas() })
}

async fn relay(w: &World, payload: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(w.bob
        .call(w.verifier.id(), "execute_intents")
        .args_json(json!({ "signed": [payload] }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

fn assert_clean(r: &Rounds, label: &str, result: &ExecutionFinalResult) {
    assert!(
        result.is_success() && result.receipt_failures().is_empty(),
        "{label}: {:?}",
        result.receipt_failures()
    );
    println!(
        "{label}: rounds {:.1} TGas, total {:.1} TGas",
        burnt_on(result, r.contract.id()),
        tg(result.total_gas_burnt)
    );
}

async fn record_price(
    w: &World,
    r: &Rounds,
    round: u64,
    price: u128,
    signatures: String,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(w.carol
        .call(r.contract.id(), "record_price")
        .args_json(
            json!({ "series_id": 0, "round": round.to_string(), "price": price.to_string(), "signatures": signatures }),
        )
        .gas(Gas::from_tgas(50))
        .transact()
        .await?)
}

async fn claim(w: &World, r: &Rounds, round: u64, who: &AccountId) -> anyhow::Result<u128> {
    let result = w
        .carol
        .call(r.contract.id(), "claim")
        .args_json(json!({ "series_id": 0, "round": round.to_string(), "account_id": who }))
        .transact()
        .await?
        .into_result()?;
    Ok(result.json::<String>()?.parse()?)
}

async fn view_u128(r: &Rounds, method: &str, args: Value) -> u128 {
    let s: String = r.contract.view(method).args_json(args).await.unwrap().json().unwrap();
    s.parse().unwrap()
}

async fn balance(r: &Rounds, who: &AccountId) -> u128 {
    view_u128(r, "get_balance", json!({ "account_id": who })).await
}

async fn round(r: &Rounds, round: u64) -> Value {
    r.contract
        .view("get_round")
        .args_json(json!({ "series_id": 0, "round": round.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

async fn recorded(r: &Rounds, round: u64) -> Value {
    r.contract
        .view("get_price")
        .args_json(json!({ "series_id": 0, "round": round.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

async fn assert_books_match(w: &World, r: &Rounds) {
    assert_eq!(
        view_u128(r, "total_owed", json!({})).await,
        intents_balance(w, r.contract.id()).await,
        "the rounds contract's total_owed differs from its balance in the verifier"
    );
}

const SEND_TGAS: u64 = 100;

async fn register_on_token(w: &World, who: &AccountId) -> anyhow::Result<()> {
    w.owner
        .call(w.ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn register_in_near(r: &Rounds, who: &Account) -> anyhow::Result<()> {
    who.call(r.contract.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn send(
    w: &World,
    from: &Account,
    r: &Rounds,
    amount: u128,
    msg: &str,
    tgas: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(w.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": r.contract.id(), "amount": amount.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

async fn round_stake(r: &Rounds, who: &AccountId) -> Value {
    r.contract
        .view("get_stake")
        .args_json(json!({ "series_id": 0, "round": "0", "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

async fn stake_from_balance(
    r: &Rounds,
    who: &Account,
    side: &str,
    amount: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(r.contract.id(), "stake")
        .args_json(
            json!({ "series_id": 0, "round": "0", "side": side, "amount": amount.to_string(), "min_shares": "1" }),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?)
}

#[tokio::test]
async fn a_signer_with_no_near_registers_stakes_wins_and_withdraws_by_signed_intents() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w).await?;
    let id = r.contract.id().clone();
    let winner_key = SigningKey::from_bytes(&[21u8; 32]);
    let loser_key = SigningKey::from_bytes(&[22u8; 32]);
    let winner: AccountId = implicit_id(&winner_key).parse()?;
    let loser: AccountId = implicit_id(&loser_key).parse()?;
    for who in [&winner, &loser] {
        assert!(w.worker.view_account(who).await.is_err(), "{who} has no NEAR account");
        deposit_to_intents(&w, &w.alice, who, 30 * USD).await?;
    }
    let fee = u(&config(&r.contract).await["registration_fee"]);

    let result = relay(&w, signed(&w, &winner_key, transfer(&w, &id, 20 * USD, "register"), 1)).await?;
    assert_clean(&r, "register with collateral", &result);
    let result = relay(&w, signed(&w, &loser_key, transfer(&w, &id, USD, "register"), 1)).await?;
    assert_clean(&r, "second registration", &result);

    skip_until(&w, r.start_of(0)).await;
    let result = relay(
        &w,
        signed(&w, &winner_key, action(&id, &format!("stake:0:0:up:{}:1", 10 * USD)), 2),
    )
    .await?;
    assert_clean(&r, "signed stake from the balance", &result);
    let result = relay(
        &w,
        signed(&w, &loser_key, transfer(&w, &id, 8 * USD, "stake:0:0:down:1"), 2),
    )
    .await?;
    assert_clean(&r, "stake that arrives with its money", &result);
    assert_eq!(balance(&r, &winner).await, 10 * USD - fee);
    let down: Value = r
        .contract
        .view("get_stake")
        .args_json(json!({ "series_id": 0, "round": "0", "account_id": loser }))
        .await?
        .json()?;
    assert_eq!(
        down["shares"], "14966629",
        "8 on Down after 10 on Up buys sqrt(18^2 - 10^2) million shares"
    );
    assert_books_match(&w, &r).await;

    let result = record_price(&w, &r, 0, 6_500_000, r.quorum(0, 6_500_000)).await?;
    assert_clean(&r, "start price, two signatures", &result);
    skip_until(&w, r.start_of(1)).await;
    let result = record_price(&w, &r, 1, 6_512_345, r.quorum(1, 6_512_345)).await?;
    assert_clean(&r, "end price, two signatures", &result);

    let payout = claim(&w, &r, 0, &winner).await?;
    assert_eq!(
        payout,
        10 * USD + 8 * USD - 240_000,
        "the stake back, and the losing 8 less 3%"
    );
    assert_eq!(claim(&w, &r, 0, &loser).await?, 0);
    assert_eq!(round(&r, 0).await["outcome"], "up");
    assert_books_match(&w, &r).await;

    let owed = balance(&r, &winner).await;
    let withdrawal = signed(&w, &winner_key, action(&id, &format!("withdraw:{owed}")), 3);
    let result = relay(&w, withdrawal.clone()).await?;
    assert_clean(&r, "signed withdrawal", &result);
    assert_eq!(balance(&r, &winner).await, 0);
    assert_eq!(intents_balance(&w, &winner).await, 10 * USD + owed);
    assert_books_match(&w, &r).await;
    assert!(
        relay(&w, withdrawal).await?.is_failure(),
        "a replayed withdrawal is refused"
    );
    assert_eq!(
        view_u128(&r, "total_owed", json!({})).await,
        2 * fee + 240_000 + (USD - fee),
        "the two registration fees, the round's fee and the loser's change are all that is left"
    );
    for who in [&winner, &loser] {
        assert!(
            w.worker.view_account(who).await.is_err(),
            "{who} still has no NEAR account"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_round_its_publishers_never_priced_refunds_both_sides() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w).await?;
    let id = r.contract.id().clone();
    ft_call(&w, &w.bob, &id, 5 * USD, "register").await?;
    ft_call(&w, &w.dave, &id, 10 * USD, "register").await?;
    assert!(
        stake_from_balance(&r, &w.dave, "down", USD).await?.is_failure(),
        "round 0 takes no stakes before it starts"
    );
    skip_until(&w, r.start_of(0)).await;
    ft_call(&w, &w.bob, &id, 5 * USD, "stake:0:0:up:1").await?;
    stake_from_balance(&r, &w.dave, "down", 5 * USD).await?.into_result()?;
    assert_books_match(&w, &r).await;

    skip_until(&w, r.start_of(0) + WINDOW_SECS * SECOND + SECOND).await;
    assert!(
        record_price(&w, &r, 0, 6_500_000, r.quorum(0, 6_500_000))
            .await?
            .is_failure(),
        "a price after its window is refused"
    );
    skip_until(&w, r.close_of(0)).await;
    assert!(
        stake_from_balance(&r, &w.dave, "down", USD).await?.is_failure(),
        "and stakes close before the round ends"
    );
    assert_eq!(claim(&w, &r, 0, w.bob.id()).await?, 5 * USD);
    assert_eq!(claim(&w, &r, 0, w.dave.id()).await?, 5 * USD);
    assert_eq!(round(&r, 0).await["outcome"], "refund");
    assert_books_match(&w, &r).await;
    Ok(())
}

#[tokio::test]
async fn only_two_publishers_signing_the_exact_moment_and_price_record_it() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w).await?;
    let id = r.contract.id().clone();
    ft_call(&w, &w.bob, &id, 5 * USD, "register").await?;
    skip_until(&w, r.start_of(0)).await;
    ft_call(&w, &w.bob, &id, 5 * USD, "stake:0:0:up:1").await?;

    let stranger = SigningKey::from_bytes(&[99u8; 32]);
    let price = 6_500_000;
    for (submission, why) in [
        (r.signatures(&[&r.publishers[1]], 0, price), "one signature"),
        (r.quorum(0, price + 1), "signatures over another price"),
        (r.quorum(1, price), "signatures over another moment"),
        (
            r.signatures(&[&r.publishers[0], &stranger], 0, price),
            "a key that is not a publisher",
        ),
        (
            r.signatures(&[&r.publishers[0], &r.publishers[0]], 0, price),
            "one publisher twice",
        ),
    ] {
        let result = record_price(&w, &r, 0, price, submission).await?;
        assert!(result.is_failure(), "{why} must not record a price");
    }
    assert_eq!(recorded(&r, 0).await, Value::Null);

    let quorum = r.quorum(0, price);
    let result = record_price(&w, &r, 0, price, quorum.clone()).await?;
    assert_clean(&r, "a valid quorum", &result);
    assert!(
        record_price(&w, &r, 0, price, quorum).await?.is_failure(),
        "the same quorum a second time is refused"
    );
    assert!(
        record_price(&w, &r, 0, price + 5, r.quorum(0, price + 5))
            .await?
            .is_failure(),
        "and so is a later quorum for another price"
    );
    assert_eq!(recorded(&r, 0).await, Value::String(price.to_string()));
    Ok(())
}

#[tokio::test]
async fn a_token_holder_registers_in_near_stakes_wins_and_leaves() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w).await?;
    let id = r.contract.id().clone();
    register_on_token(&w, &id).await?;
    register_in_near(&r, &w.dave).await?;
    let result = send(&w, &w.dave, &r, 15 * USD, "deposit", SEND_TGAS).await?;
    assert_clean(&r, "deposit by token", &result);
    assert_eq!(balance(&r, w.dave.id()).await, 15 * USD, "no registration fee is taken");
    assert_eq!(ft_balance(&w, &id).await, 0, "the contract keeps no token itself");
    assert_books_match(&w, &r).await;

    ft_call(&w, &w.bob, &id, 5 * USD, "register").await?;
    skip_until(&w, r.start_of(0)).await;
    let result = send(&w, &w.dave, &r, 5 * USD, "stake:0:0:up:1", SEND_TGAS).await?;
    assert_clean(&r, "stake by token", &result);
    stake_from_balance(&r, &w.dave, "up", 5 * USD).await?.into_result()?;
    ft_call(&w, &w.bob, &id, 10 * USD, "stake:0:0:down:1").await?;
    assert_eq!(round_stake(&r, w.dave.id()).await["amount"], (10 * USD).to_string());
    assert_eq!(balance(&r, w.dave.id()).await, 10 * USD);
    assert_books_match(&w, &r).await;

    record_price(&w, &r, 0, 6_500_000, r.quorum(0, 6_500_000))
        .await?
        .into_result()?;
    skip_until(&w, r.start_of(1)).await;
    record_price(&w, &r, 1, 6_512_345, r.quorum(1, 6_512_345))
        .await?
        .into_result()?;
    assert_eq!(
        claim(&w, &r, 0, w.dave.id()).await?,
        20 * USD - 300_000,
        "both stakes back, and bob's 10 less 3%"
    );
    let owed = balance(&r, w.dave.id()).await;
    let held = intents_balance(&w, w.dave.id()).await;
    w.dave
        .call(&id, "withdraw")
        .args_json(json!({ "amount": owed.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        intents_balance(&w, w.dave.id()).await,
        held + owed,
        "the exit lands in dave's own Intents account"
    );
    assert_books_match(&w, &r).await;

    let before = w.worker.view_account(w.dave.id()).await?.balance;
    let result = w
        .dave
        .call(&id, "storage_unregister")
        .args_json(json!({}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert_clean(&r, "leave", &result);
    let after = w.worker.view_account(w.dave.id()).await?.balance;
    assert!(
        after.as_yoctonear() > before.as_yoctonear() + NearToken::from_millinear(45).as_yoctonear(),
        "the 0.05 NEAR came back, less the gas of leaving"
    );
    let registered: bool = r
        .contract
        .view("is_registered")
        .args_json(json!({ "account_id": w.dave.id() }))
        .await?
        .json()?;
    assert!(!registered);
    assert_books_match(&w, &r).await;
    Ok(())
}

#[tokio::test]
async fn a_refused_token_transfer_comes_back_whole() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w).await?;
    let id = r.contract.id().clone();
    register_on_token(&w, &id).await?;
    register_in_near(&r, &w.alice).await?;
    let held = intents_balance(&w, &id).await;
    let owed = view_u128(&r, "total_owed", json!({})).await;
    let dust = format!("deposit_for:{}", w.alice.id());
    for (from, msg, amount, tgas, why) in [
        (&w.dave, "deposit", USD, SEND_TGAS, "register first"),
        (&w.alice, "deposit_for:nobody.near", USD, SEND_TGAS, "register first"),
        (&w.dave, dust.as_str(), 50_000, SEND_TGAS, "at least the minimum stake"),
        (&w.alice, "register", USD, SEND_TGAS, "unknown action"),
        (&w.alice, "deposit", USD, 80, "attach at least 75 TGas"),
        (
            &w.alice,
            "stake:0:0:up:1",
            50_000,
            SEND_TGAS,
            "the stake is below the minimum",
        ),
        (&w.alice, "stake:0:0:up:1", USD, SEND_TGAS, "the round has not started"),
    ] {
        let tokens = ft_balance(&w, from.id()).await;
        let result = send(&w, from, &r, amount, msg, tgas).await?;
        assert!(result.is_success(), "{msg}: the token call itself completes");
        assert!(
            format!("{:?}", result.receipt_failures()).contains(why),
            "{msg} at {tgas} TGas: {:?}",
            result.receipt_failures()
        );
        assert_eq!(
            ft_balance(&w, from.id()).await,
            tokens,
            "{msg} at {tgas} TGas: the token came back"
        );
    }
    assert_eq!(ft_balance(&w, &id).await, 0);
    assert_eq!(intents_balance(&w, &id).await, held);
    assert_eq!(view_u128(&r, "total_owed", json!({})).await, owed);
    assert_eq!(balance(&r, w.alice.id()).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_token_stake_that_just_clears_the_floor_completes() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w).await?;
    register_on_token(&w, r.contract.id()).await?;
    register_in_near(&r, &w.alice).await?;
    skip_until(&w, r.start_of(0)).await;
    for tgas in 76..100 {
        let result = send(&w, &w.alice, &r, USD, "stake:0:0:up:1", tgas).await?;
        if format!("{:?}", result.receipt_failures()).contains("attach at least") {
            continue;
        }
        assert_clean(&r, &format!("stake by token at {tgas} TGas"), &result);
        assert_eq!(round_stake(&r, w.alice.id()).await["amount"], USD.to_string());
        assert_books_match(&w, &r).await;
        return Ok(());
    }
    panic!("the floor refused every gas amount tried");
}

#[tokio::test]
async fn a_token_stake_the_round_refuses_stays_a_balance() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w).await?;
    register_on_token(&w, r.contract.id()).await?;
    register_in_near(&r, &w.alice).await?;
    skip_until(&w, r.start_of(0)).await;
    let greedy = format!("stake:0:0:up:{}", 100 * USD);
    let result = send(&w, &w.alice, &r, 4 * USD, &greedy, SEND_TGAS).await?;
    assert!(
        format!("{:?}", result.receipt_failures()).contains("fewer shares than the minimum"),
        "{:?}",
        result.receipt_failures()
    );
    assert_eq!(balance(&r, w.alice.id()).await, 4 * USD);
    assert_eq!(round_stake(&r, w.alice.id()).await, Value::Null);
    assert_books_match(&w, &r).await;
    Ok(())
}

#[tokio::test]
async fn an_owner_funds_an_agent_that_never_holds_the_token() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w).await?;
    let id = r.contract.id().clone();
    register_on_token(&w, &id).await?;
    let (owner, agent) = (&w.dave, &w.alice);
    owner
        .call(&id, "storage_deposit")
        .args_json(json!({ "account_id": agent.id() }))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    let tokens = ft_balance(&w, agent.id()).await;
    let gift = format!("deposit_for:{}", agent.id());
    let result = send(&w, owner, &r, 15 * USD, &gift, SEND_TGAS).await?;
    assert_clean(&r, "deposit for the agent", &result);
    let from = format!("\"from\":\"{}\"", owner.id());
    assert!(
        result
            .logs()
            .iter()
            .any(|l| l.contains("\"event\":\"deposit\"") && l.contains(&from)),
        "the deposit names who paid: {:?}",
        result.logs()
    );
    assert_eq!(balance(&r, agent.id()).await, 15 * USD);
    assert_eq!(balance(&r, owner.id()).await, 0);
    assert_eq!(
        ft_balance(&w, agent.id()).await,
        tokens,
        "no token ever reaches the agent"
    );
    assert_books_match(&w, &r).await;

    skip_until(&w, r.start_of(0)).await;
    stake_from_balance(&r, agent, "up", 5 * USD).await?.into_result()?;
    assert_eq!(round_stake(&r, agent.id()).await["amount"], (5 * USD).to_string());
    let held = intents_balance(&w, agent.id()).await;
    agent
        .call(&id, "withdraw")
        .args_json(json!({ "amount": (10 * USD).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(intents_balance(&w, agent.id()).await, held + 10 * USD);
    assert_eq!(balance(&r, agent.id()).await, 0);
    assert_books_match(&w, &r).await;
    Ok(())
}

#[tokio::test]
async fn the_rounds_callbacks_refuse_outside_callers() -> anyhow::Result<()> {
    let w = setup().await?;
    let r = deploy(&w).await?;
    let me = w.dave.id();
    let order = json!({ "series_id": 0, "round": "0", "side": "up", "min_shares": "0" });
    for (method, args) in [
        (
            "on_forwarded",
            json!({ "sender_id": me, "amount": "1", "arrival": "deposit" }),
        ),
        ("stake_credited", json!({ "who": me, "order": order, "amount": "1" })),
        ("on_withdraw", json!({ "id": "1" })),
    ] {
        let result = w.dave.call(r.contract.id(), method).args_json(args).transact().await?;
        let reason = format!("{:?}", result.clone().into_result().err());
        assert!(result.is_failure() && reason.contains("private"), "{method}: {reason}");
    }
    assert_eq!(balance(&r, me).await, 0);
    Ok(())
}
