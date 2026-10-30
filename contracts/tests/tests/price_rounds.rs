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
const INTERVAL_SECS: u64 = 120;
const WINDOW_SECS: u64 = 60;
const CLOSE_BEFORE_SECS: u64 = 60;

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
