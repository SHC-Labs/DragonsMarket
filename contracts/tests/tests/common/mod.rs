#![allow(dead_code)]
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::str::FromStr;

pub const USD: u128 = 1_000_000; // mock token has 6 decimals
pub const BOND: u128 = 5 * USD;
pub const WINDOW_MS: u64 = 3_600_000;
pub const PANEL_MS: u64 = 7_200_000;
pub const DRAW_WINDOW_MS: u64 = 3_600_000;
pub const JURY: u32 = 5;
pub const SECOND_JURY: usize = 11;
// Reveals that settle a first-round case early.
pub const MAJORITY: usize = JURY as usize / 2 + 1;
pub const SECOND_MAJORITY: usize = SECOND_JURY / 2 + 1;
// What each juror of a first-round majority is paid: a quarter of the loser's bond, shared and rounded down.
pub const JUROR_PAY: u128 = BOND / 4 / MAJORITY as u128;
// The oracle refuses any window under an hour, so the world runs on the hour floor.
pub const PAST_WINDOW_SECS: u64 = WINDOW_MS / 1000 + 10;
pub const DRAW_DELAY_BLOCKS: u64 = 2;
// With the hour window, two rounds of an hour to draw and two hours of panel, an hour to propose, and the oracle's 30s apply
// buffer, a market needs 28,830s between close and resolve_by.
pub const MIN_PROPOSAL_MS: u64 = 3_600_000;
pub const MIN_RESOLVE_GAP_SECS: u64 = 28_830;
pub const MARKET_GAP_SECS: u64 = 36_000;
const BLOCK_MS: u64 = 300;
pub const NETWORK: &str = "sandbox";
pub const PRICE_THRESHOLD: u32 = 2;
pub const MAX_SEATS_PER_ACCOUNT: u32 = 10;
pub const NS_PER_DAY: u64 = 86_400_000_000_000;
pub const COOLDOWN_SECS: u64 = 60;
// A buy whose 2% fee, 1,000,001, is just over the default minimum sweep. A sweep of it pays the Council 250,000 and the
// treasury 750,000, both rounded down, and leaves one unit collected.
pub const SWEEP_BUY: u128 = 50 * USD + 50;
pub const SWEEP_FEE: u128 = 1_000_001;
pub const COUNCIL_SHARE: u128 = 250_000;
pub const TREASURY_SHARE: u128 = 750_000;
pub const FAR_DEADLINE: &str = "2100-01-01T00:00:00Z";
const NEP413_PREFIX_TAG: u32 = 2_147_484_061;
const SECOND_ROUND_KEY: u64 = 1 << 63;

pub struct World {
    pub worker: Worker<Sandbox>,
    // The real NEAR Intents verifier. The market, the oracle and the council keep their money in their own accounts in it.
    pub verifier: Contract,
    pub ft: Contract,
    pub market: Contract,
    pub oracle: Contract,
    pub council: Contract,
    pub nft: Contract,
    pub owner: Account,
    pub alice: Account,
    pub bob: Account,
    pub carol: Account,
    pub dave: Account,
    // Receives 75% of the fees.
    pub treasury: Account,
    // Each holds one staked NFT whose token id is their account id. A case's panel is drawn from them.
    pub jurors: Vec<Account>,
}

impl World {
    // The same world with another Council, for a test that runs a second one beside the world's own.
    pub fn with_council(&self, council: Contract) -> World {
        World {
            worker: self.worker.clone(),
            verifier: self.verifier.clone(),
            ft: self.ft.clone(),
            market: self.market.clone(),
            oracle: self.oracle.clone(),
            council,
            nft: self.nft.clone(),
            owner: self.owner.clone(),
            alice: self.alice.clone(),
            bob: self.bob.clone(),
            carol: self.carol.clone(),
            dave: self.dave.clone(),
            treasury: self.treasury.clone(),
            jurors: self.jurors.clone(),
        }
    }
}

// The newest modification time of any .rs file under `dir`.
fn newest_source(dir: &std::path::Path) -> Option<std::time::SystemTime> {
    let mut newest = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let time = if path.is_dir() {
            newest_source(&path)
        } else if path.extension().is_some_and(|e| e == "rs") {
            entry.metadata().ok()?.modified().ok()
        } else {
            None
        };
        newest = newest.max(time);
    }
    newest
}

// A wasm built before the last edit to its source makes a sandbox failure look like a code bug. It has happened twice, so a stale
// wasm stops the test here with the fix instead.
pub fn wasm(name: &str) -> Vec<u8> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let p = root.join(format!("target/near/{0}/{0}.wasm", name));
    let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("run contracts/build.sh first ({p:?}): {e}"));
    let built = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
    let own = root.join(name.replace('_', "-")).join("src");
    let shared = root.join("upgrade/src");
    let uses_upgrade = ["council", "market", "oracle", "rounds"].contains(&name);
    let uses_price_signatures = ["oracle", "rounds"].contains(&name);
    let source = [
        Some(own),
        uses_upgrade.then_some(shared),
        uses_price_signatures.then(|| root.join("price-signatures/src")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|d| newest_source(&d))
    .max();
    if let (Some(built), Some(source)) = (built, source) {
        assert!(
            built >= source,
            "the {name} wasm is older than its source: run contracts/build.sh before the sandbox tests ({p:?})"
        );
    }
    bytes
}

// The verifier is built outside the repository from the pinned source (contracts/INTENTS-PROOF.md). A missing file fails the
// test with the recipe: a silent skip would hide every test that needs it. CI must build it before it runs the sandbox tests.
pub const VERIFIER_RECIPE: &str =
    "the NEAR Intents verifier wasm is missing. These tests need the real contract, so CI must build it \
before running them. Build it with:\n\
  SCRATCH=$(mktemp -d)\n\
  git clone https://github.com/near/intents $SCRATCH/intents-src\n\
  git -C $SCRATCH/intents-src checkout 16d04f6ec4401263f8914638710260da50bb46b0\n\
  cd $SCRATCH/intents-src/contracts/defuse\n\
  cargo near build reproducible-wasm --out-dir $SCRATCH/intents-repro   (needs docker and cargo-near 0.22.0)\n\
  mkdir -p contracts/target/intents && cp $SCRATCH/intents-repro/defuse.wasm contracts/target/intents/defuse.wasm\n\
The sha256 must be a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547 (the code hash of intents.near). \
Details are in contracts/INTENTS-PROOF.md.";

// The version 5 Council is built outside the working tree from the commit this version was made from, so the upgrade test has the
// code that is deployed today. A missing file fails the test with the recipe.
pub const V5_RECIPE: &str = "the version 5 Council wasm is missing. The upgrade test needs the code that is deployed today. Build it with:\n\
  SCRATCH=$(mktemp -d)\n\
  git -C <the Dragons Market checkout> archive fd188d0 contracts | tar -x -C $SCRATCH\n\
  cd $SCRATCH/contracts/council && cargo near build non-reproducible-wasm --locked --out-dir $SCRATCH/out\n\
  mkdir -p contracts/target/near/council_v5 && cp $SCRATCH/out/council.wasm contracts/target/near/council_v5/council_v5.wasm";

pub fn v5_wasm() -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/near/council_v5/council_v5.wasm");
    std::fs::read(&p).unwrap_or_else(|e| panic!("{V5_RECIPE}\n(looked at {p:?}: {e})"))
}

pub fn verifier_wasm() -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/intents/defuse.wasm");
    std::fs::read(&p).unwrap_or_else(|e| panic!("{VERIFIER_RECIPE}\n(looked at {p:?}: {e})"))
}

// The id of the collateral inside the verifier.
pub fn token_id(w: &World) -> String {
    format!("nep141:{}", w.ft.id())
}

pub async fn now(worker: &Worker<Sandbox>) -> u64 {
    worker.view_block().await.unwrap().timestamp()
}

// Moves chain time forward by at least this many seconds. A block is about 0.3 s in the sandbox, but the average drifts, which
// matters once a test skips hours, so the jump is repeated until the chain clock has passed the target.
pub async fn skip_secs(worker: &Worker<Sandbox>, secs: u64) {
    skip_to(worker, now(worker).await + secs * 1_000_000_000).await;
}

async fn skip_to(worker: &Worker<Sandbox>, t_ns: u64) {
    loop {
        let t = now(worker).await;
        if t >= t_ns {
            return;
        }
        worker
            .fast_forward((t_ns - t) / 1_000_000 / BLOCK_MS + 5)
            .await
            .unwrap();
    }
}

pub async fn setup() -> anyhow::Result<World> {
    setup_with(WINDOW_MS, PANEL_MS, DRAW_DELAY_BLOCKS).await
}

pub async fn setup_with(window_ms: u64, panel_ms: u64, draw_delay_blocks: u64) -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    build(worker, window_ms, panel_ms, draw_delay_blocks, None, true).await
}

// As deployed, before the owner has said where fees go: the market has no fee recipients and the Council has no market. The
// NFT collection is set, because the five jurors are staked.
pub async fn setup_unconfigured() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    build(worker, WINDOW_MS, PANEL_MS, DRAW_DELAY_BLOCKS, None, false).await
}

// The market, the oracle and the council are owned by `admin` when given, by w.owner otherwise. `configured` has the owner set
// the market's fee recipients and the Council's market, which the contracts leave unset.
async fn build(
    worker: Worker<Sandbox>,
    window_ms: u64,
    panel_ms: u64,
    draw_delay_blocks: u64,
    admin: Option<Account>,
    configured: bool,
) -> anyhow::Result<World> {
    let verifier = worker.dev_deploy(&verifier_wasm()).await?;
    let ft = worker.dev_deploy(&wasm("mock_ft")).await?;
    let market = worker.dev_deploy(&wasm("market")).await?;
    let oracle = worker.dev_deploy(&wasm("oracle")).await?;
    let council = worker.dev_deploy(&wasm("council")).await?;
    let nft = worker.dev_deploy(&wasm("mock_nft")).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dave = worker.dev_create_account().await?;
    let treasury = worker.dev_create_account().await?;
    let mut jurors = vec![];
    for _ in 0..5 {
        jurors.push(worker.dev_create_account().await?);
    }
    let admin = admin.unwrap_or_else(|| owner.clone());
    let owner_id = admin.id().clone();

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
    ft.call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    let collateral_token_id = format!("nep141:{}", ft.id());
    market
        .call("new")
        .args_json(json!({
            "owner_id": owner_id, "operator_id": owner.id(), "oracle_id": oracle.id(), "verifier_id": verifier.id(),
            "collateral_token_id": collateral_token_id
        }))
        .transact()
        .await?
        .into_result()?;
    nft.call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    council
        .call("new")
        .args_json(json!({
            "owner_id": owner_id, "oracle_id": oracle.id(), "verifier_id": verifier.id(),
            "collateral_token_id": collateral_token_id, "cooldown_ns": (COOLDOWN_SECS * 1_000_000_000).to_string(), "max_seats_per_account": MAX_SEATS_PER_ACCOUNT,
            "allowlist_enabled": false
        }))
        .transact()
        .await?
        .into_result()?;
    oracle
        .call("new")
        .args_json(json!({
            "owner_id": owner_id, "market_contract": market.id(), "verifier_id": verifier.id(),
            "collateral_token_id": collateral_token_id, "bond": BOND.to_string(), "window_ms": window_ms.to_string(), "panel_deadline_ms": panel_ms.to_string(),
            "draw_window_ms": DRAW_WINDOW_MS.to_string(), "council": council.id(), "jury_size": JURY, "draw_delay_blocks": draw_delay_blocks.to_string(),
            "min_proposal_ms": MIN_PROPOSAL_MS.to_string(), "operator_id": owner.id(), "network": NETWORK,
            "price_threshold": PRICE_THRESHOLD, "no_decision_recipient": treasury.id()
        }))
        .transact()
        .await?
        .into_result()?;

    // The token needs to know these accounts before they can receive transfers. The market, the oracle and the council are not
    // among them: the verifier holds their money. Only the market is ever sent the token itself, and the tests that do so
    // register it.
    for c in [verifier.id(), treasury.id()] {
        owner
            .call(ft.id(), "storage_deposit")
            .args_json(json!({ "account_id": c, "registration_only": true }))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await?
            .into_result()?;
    }
    for who in [&owner, &alice, &bob] {
        who.call(market.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(50))
            .transact()
            .await?
            .into_result()?;
    }
    for (who, amount) in [
        (&owner, 1000 * USD),
        (&alice, 200 * USD),
        (&bob, 200 * USD),
        (&carol, 50 * USD),
        (&dave, 50 * USD),
    ] {
        owner
            .call(ft.id(), "mint")
            .args_json(json!({ "account_id": who.id(), "amount": amount.to_string() }))
            .transact()
            .await?
            .into_result()?;
    }
    admin
        .call(council.id(), "set_nft_contract")
        .args_json(json!({ "nft_contract": nft.id() }))
        .transact()
        .await?
        .into_result()?;
    if configured {
        admin
            .call(market.id(), "set_fee_recipients")
            .args_json(json!({ "revenue_pool": council.id(), "treasury": treasury.id() }))
            .transact()
            .await?
            .into_result()?;
        admin
            .call(council.id(), "allow_market")
            .args_json(json!({ "market": market.id() }))
            .transact()
            .await?
            .into_result()?;
    }
    let w = World {
        worker,
        verifier,
        ft,
        market,
        oracle,
        council,
        nft,
        owner,
        alice,
        bob,
        carol,
        dave,
        treasury,
        jurors,
    };
    for j in &w.jurors {
        mint_nft(&w, j, j.id().as_str()).await?;
        stake(&w, j, j.id().as_str()).await?;
    }
    Ok(w)
}

// More staked seats for a case that reaches its second jury. Each is added to `w.jurors`.
pub async fn add_jurors(w: &mut World, count: usize) -> anyhow::Result<()> {
    for _ in 0..count {
        let juror = w.worker.dev_create_account().await?;
        mint_nft(w, &juror, juror.id().as_str()).await?;
        stake(w, &juror, juror.id().as_str()).await?;
        w.jurors.push(juror);
    }
    Ok(())
}

pub async fn mint_nft(w: &World, to: &Account, token_id: &str) -> anyhow::Result<()> {
    w.owner
        .call(w.nft.id(), "nft_mint")
        .args_json(json!({ "token_id": token_id, "receiver_id": to.id() }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// `who` sends the token to the Council. A refused stake does not fail the call: the token just comes back.
pub async fn stake(w: &World, who: &Account, token_id: &str) -> anyhow::Result<()> {
    let r = who
        .call(w.nft.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": w.council.id(), "token_id": token_id, "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    if !r.json::<bool>()? {
        anyhow::bail!("the Council sent the token back: {:?}", r.receipt_failures());
    }
    Ok(())
}

pub async fn request_unstake(w: &World, who: &Account, token_id: &str) -> anyhow::Result<()> {
    request_unstake_with(w, who, token_id, true).await?.into_result()?;
    Ok(())
}

// The request with the cut flag given, and the outcome left unchecked so a test can look at a refusal, the logs or the gas.
pub async fn request_unstake_with(
    w: &World,
    who: &Account,
    token_id: &str,
    accepts_cut: bool,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(who
        .call(w.council.id(), "request_unstake")
        .args_json(json!({ "token_id": token_id, "accepts_cut": accepts_cut }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?)
}

// Returns the logs of the whole call, the transfer and the callback included.
pub async fn unstake(w: &World, who: &Account, token_id: &str) -> anyhow::Result<Vec<String>> {
    let r = who
        .call(w.council.id(), "unstake")
        .args_json(json!({ "token_id": token_id }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

// Each account takes back the token named after it, after one shared cooldown.
pub async fn leave(w: &World, who: &[&Account]) -> anyhow::Result<()> {
    for a in who {
        request_unstake(w, a, a.id().as_str()).await?;
    }
    skip_secs(&w.worker, COOLDOWN_SECS + 1).await;
    for a in who {
        assert_eq!(
            event_names(&unstake(w, a, a.id().as_str()).await?),
            vec!["nft_transfer", "unstaked"]
        );
    }
    Ok(())
}

pub async fn nft_owner(w: &World, token_id: &str) -> String {
    let t: serde_json::Value = w
        .nft
        .view("nft_token")
        .args_json(json!({ "token_id": token_id }))
        .await
        .unwrap()
        .json()
        .unwrap();
    t["owner_id"].as_str().unwrap().to_string()
}

pub async fn stake_of(w: &World, token_id: &str) -> serde_json::Value {
    w.council
        .view("stake_of")
        .args_json(json!({ "token_id": token_id }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

pub async fn is_seat(w: &World, who: &AccountId) -> bool {
    w.council
        .view("is_seat")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

// Sends `amount` of the token to a contract with a message. The market, the oracle and the council take it through the
// verifier: the token goes into the sender's own Intents account first, then an mt_transfer_call moves it to the contract, so a
// refusal puts it back in the sender's Intents account.
pub async fn ft_call(w: &World, from: &Account, to: &AccountId, amount: u128, msg: &str) -> anyhow::Result<()> {
    deposit_to_intents(w, from, from.id(), amount).await?;
    intents_call(w, from, to, amount, msg).await?.into_result()?;
    Ok(())
}

// Moves tokens from `from`'s NEP-141 balance into `to`'s Intents account.
pub async fn deposit_to_intents(w: &World, from: &Account, to: &AccountId, amount: u128) -> anyhow::Result<()> {
    from.call(w.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": w.verifier.id(), "amount": amount.to_string(), "msg": to }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(200))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// The user's mt_transfer_call of collateral from their Intents account to a contract. The result is not unwrapped, so a test
// can look at refusals.
pub async fn intents_call(
    w: &World,
    from: &Account,
    to: &AccountId,
    amount: u128,
    msg: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(from
        .call(w.verifier.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": to, "token_id": token_id(w), "amount": amount.to_string(), "msg": msg
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
}

// What the verifier holds for an account.
pub async fn intents_balance(w: &World, who: &AccountId) -> u128 {
    let s: String = w
        .verifier
        .view("mt_balance_of")
        .args_json(json!({ "account_id": who, "token_id": token_id(w) }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

pub fn nep413_signed(key: &SigningKey, message: &str, nonce: [u8; 32], recipient: &str) -> serde_json::Value {
    let mut bytes = NEP413_PREFIX_TAG.to_le_bytes().to_vec();
    bytes.extend((message.len() as u32).to_le_bytes());
    bytes.extend(message.as_bytes());
    bytes.extend(nonce);
    bytes.extend((recipient.len() as u32).to_le_bytes());
    bytes.extend(recipient.as_bytes());
    bytes.push(0);
    let digest = Sha256::digest(&bytes);
    let signature = key.sign(&digest);
    json!({
        "standard": "nep413",
        "payload": {
            "message": message,
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
            "recipient": recipient,
        },
        "public_key": format!("ed25519:{}", bs58::encode(key.verifying_key().as_bytes()).into_string()),
        "signature": format!("ed25519:{}", bs58::encode(signature.to_bytes()).into_string()),
    })
}

pub fn implicit_id(key: &SigningKey) -> String {
    key.verifying_key()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// The verifier's emergency powers, held by w.owner in these tests. A paused feature stops every transfer, and a locked account
// cannot send anything while it can still receive.
async fn verifier_admin(w: &World, method: &str, args: serde_json::Value) -> anyhow::Result<()> {
    let yocto = if method.starts_with("force_") { 1 } else { 0 };
    w.owner
        .call(w.verifier.id(), method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(yocto))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn lock_account(w: &World, who: &AccountId) -> anyhow::Result<()> {
    verifier_admin(w, "force_lock_account", json!({ "account_id": who })).await
}

pub async fn unlock_account(w: &World, who: &AccountId) -> anyhow::Result<()> {
    verifier_admin(w, "force_unlock_account", json!({ "account_id": who })).await
}

pub async fn pause_transfers(w: &World) -> anyhow::Result<()> {
    verifier_admin(w, "pa_pause_feature", json!({ "key": "mt_transfer" })).await
}

pub async fn unpause_transfers(w: &World) -> anyhow::Result<()> {
    verifier_admin(w, "pa_unpause_feature", json!({ "key": "mt_transfer" })).await
}

// All the collateral an account has outside the market, the oracle and the council: its tokens plus its Intents balance. Every
// payout from the three lands in the Intents balance, and what a test starts with is tokens, so a test that follows one
// person's money across both reads this.
pub async fn holdings(w: &World, who: &AccountId) -> u128 {
    ft_balance(w, who).await + intents_balance(w, who).await
}

// The market's books must match what the verifier holds for it. Only valid while nothing is in flight.
pub async fn assert_reconciled(w: &World) {
    let owed: String = w.market.view("total_owed").await.unwrap().json().unwrap();
    assert_eq!(
        u128::from_str(&owed).unwrap(),
        intents_balance(w, w.market.id()).await,
        "the market's total_owed differs from its balance in the verifier"
    );
}

// The oracle's books must match what the verifier holds for it. Only valid while no payout is in flight.
pub async fn assert_oracle_reconciled(w: &World) {
    assert_eq!(
        oracle_total_owed(w).await,
        intents_balance(w, w.oracle.id()).await,
        "the oracle's total_owed differs from its balance in the verifier"
    );
}

pub async fn oracle_total_owed(w: &World) -> u128 {
    let owed: String = w.oracle.view("total_owed").await.unwrap().json().unwrap();
    u128::from_str(&owed).unwrap()
}

pub async fn ft_balance(w: &World, who: &AccountId) -> u128 {
    let s: String =
        w.ft.view("ft_balance_of")
            .args_json(json!({ "account_id": who }))
            .await
            .unwrap()
            .json()
            .unwrap();
    s.parse().unwrap()
}

pub async fn market_balance(w: &World, who: &AccountId) -> u128 {
    let s: String = w
        .market
        .view("get_balance")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

pub async fn shares(w: &World, id: u64, who: &AccountId) -> (u128, u128) {
    let (y, n): (String, String) = w
        .market
        .view("get_shares")
        .args_json(json!({ "market_id": id.to_string(), "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap();
    (y.parse().unwrap(), n.parse().unwrap())
}

pub async fn invariant(w: &World, id: u64) -> bool {
    w.market
        .view("check_invariant")
        .args_json(json!({ "market_id": id.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

pub async fn market_json(w: &World, id: u64) -> serde_json::Value {
    w.market
        .view("get_market")
        .args_json(json!({ "market_id": id.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

pub async fn case_json(w: &World, id: u64) -> serde_json::Value {
    w.oracle
        .view("get_case")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

// A market closing in `close_in_secs` with room after the close for a full case.
pub async fn new_market(w: &World, close_in_secs: u64) -> anyhow::Result<u64> {
    create_market(w, close_in_secs, MARKET_GAP_SECS).await
}

// Creates a market closing in `close_in_secs`, with resolve_by `gap_secs` after the close, and waits for the oracle
// registration. It is open for trading as soon as it is registered.
pub async fn create_market(w: &World, close_in_secs: u64, gap_secs: u64) -> anyhow::Result<u64> {
    let t = now(&w.worker).await;
    let close_at = t + close_in_secs * 1_000_000_000;
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .deposit(near_workspaces::types::NearToken::from_millinear(60))
        .args_json(json!({
            "title": "Will the test question resolve Yes?",
            "rule_text": "Resolves Yes if the test says so.",
            "resolution_source": "https://example.com/source",
            "void_policy": "Void if the test is cancelled.",
            "category": "world",
            "subcategory": "science",
            "close_at": close_at.to_string(),
            "resolve_by": (close_at + gap_secs * 1_000_000_000).to_string()
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    assert_eq!(
        market_json(w, id).await["registered"],
        true,
        "oracle registration callback should have landed"
    );
    Ok(id)
}

pub async fn buy(w: &World, who: &Account, id: u64, side: &str, amount: u128) -> anyhow::Result<()> {
    ft_call(w, who, w.market.id(), amount, &format!("buy:{id}:{side}:1")).await
}

pub async fn propose(w: &World, who: &Account, id: u64, outcome: &str) -> anyhow::Result<()> {
    ft_call(
        w,
        who,
        w.oracle.id(),
        BOND,
        &format!(
            "propose:{}:{id}:{outcome}:https://example.com/evidence?a=b",
            w.market.id()
        ),
    )
    .await
}

// Challenges naming the other one of Yes and No than the proposal.
pub async fn challenge(w: &World, who: &Account, id: u64) -> anyhow::Result<()> {
    let answer = if case_json(w, id).await["proposed"] == "yes" {
        "no"
    } else {
        "yes"
    };
    challenge_with(w, who, id, answer).await
}

pub async fn challenge_with(w: &World, who: &Account, id: u64, answer: &str) -> anyhow::Result<()> {
    ft_call(
        w,
        who,
        w.oracle.id(),
        BOND,
        &format!("challenge:{}:{id}:{answer}", w.market.id()),
    )
    .await
}

// Returns the logs of the whole call, the verifier's payout and the callback included.
pub async fn withdraw_bond(w: &World, who: &Account) -> anyhow::Result<Vec<String>> {
    let r = who
        .call(w.oracle.id(), "withdraw_bond")
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

pub async fn claimable(w: &World, who: &AccountId) -> u128 {
    let s: String = w
        .oracle
        .view("claimable_of")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

// Asserts the call failed with the contract's own message, not for some other reason.
pub fn refused<T: std::fmt::Debug, E: std::fmt::Debug>(r: Result<T, E>, why: &str) {
    match r {
        Ok(v) => panic!("expected a refusal ({why}), got {v:?}"),
        Err(e) => assert!(format!("{e:?}").contains(why), "expected a refusal ({why}), got {e:?}"),
    }
}

pub fn event_names(logs: &[String]) -> Vec<String> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| {
            serde_json::from_str::<serde_json::Value>(j).unwrap()["event"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .filter(|name| name != "seats_started")
        .collect()
}

fn case_u64(case: &serde_json::Value, field: &str) -> u64 {
    case[field].as_str().unwrap().parse().unwrap()
}

// Moves the chain past the case's draw delay.
pub async fn wait_for_draw(w: &World, id: u64) {
    let after = case_u64(&case_json(w, id).await, "draw_after_height");
    let height = w.worker.view_block().await.unwrap().height();
    if height < after {
        w.worker.fast_forward(after - height).await.unwrap();
    }
}

// Returns the logs of the whole call, the council's draw and the callback included.
pub async fn resolve_draw(w: &World, id: u64) -> anyhow::Result<Vec<String>> {
    let r = w
        .bob
        .call(w.oracle.id(), "resolve_draw")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

pub async fn panel(w: &World, id: u64) -> Vec<Account> {
    let known: Vec<&Account> = w
        .jurors
        .iter()
        .chain([&w.owner, &w.alice, &w.bob, &w.carol, &w.dave])
        .collect();
    case_json(w, id).await["panel"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| {
            (*known
                .iter()
                .find(|a| a.id().as_str() == j.as_str().unwrap())
                .expect("a panel member we created"))
            .clone()
        })
        .collect()
}

pub async fn draw_jury(w: &World, id: u64) -> anyhow::Result<Vec<Account>> {
    wait_for_draw(w, id).await;
    let logs = resolve_draw(w, id).await?;
    // The Council logs the draw, then the oracle logs the seated jury.
    assert_eq!(event_names(&logs), vec!["jury_drawn", "jury_drawn"]);
    Ok(panel(w, id).await)
}

pub fn commitment(juror: &AccountId, outcome: &str, salt: &str) -> String {
    Sha256::digest(format!("{juror}:{outcome}:{salt}"))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub async fn commit_vote(w: &World, juror: &Account, id: u64, commitment: &str) -> anyhow::Result<()> {
    juror
        .call(w.oracle.id(), "commit_vote")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string(), "commitment": commitment }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn commit(w: &World, juror: &Account, id: u64, outcome: &str, salt: &str) -> anyhow::Result<()> {
    commit_vote(w, juror, id, &commitment(juror.id(), outcome, salt)).await
}

pub async fn reveal(
    w: &World,
    juror: &Account,
    id: u64,
    outcome: &str,
    salt: &str,
    reason: &str,
) -> anyhow::Result<()> {
    reveal_logs(w, juror, id, outcome, salt, reason).await?;
    Ok(())
}

// Returns the logs of the whole call, the settlement and the release of the jury included.
pub async fn reveal_logs(
    w: &World,
    juror: &Account,
    id: u64,
    outcome: &str,
    salt: &str,
    reason: &str,
) -> anyhow::Result<Vec<String>> {
    let r = juror
        .call(w.oracle.id(), "reveal_vote")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string(), "outcome": outcome, "salt": salt, "reason": reason }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

// The data of each event with this name in `logs`.
pub fn events_named(logs: &[String], name: &str) -> Vec<serde_json::Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap())
        .filter(|e| e["event"] == name)
        .map(|e| e["data"].clone())
        .collect()
}

// What a claim paid, from its claim_paid event.
pub fn claimed_in(logs: &[String]) -> u128 {
    events_named(logs, "claim_paid").iter().map(|e| u(&e["amount"])).sum()
}

pub async fn mint(w: &World, to: &AccountId, amount: u128) -> anyhow::Result<()> {
    w.owner
        .call(w.ft.id(), "mint")
        .args_json(json!({ "account_id": to, "amount": amount.to_string() }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// Sweep ids the stand-in market below uses. They start far above the ids the real market takes, so a test can do both.
static STAND_IN_SWEEP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1_000_000);

// Revenue for the council's seats without a market sweep: for a moment the owner stands in for the market, which is the only
// account the Council takes revenue from, and sends `amount` as a sweep of its own. The market is put back after.
pub async fn send_revenue(w: &World, amount: u128) -> anyhow::Result<()> {
    set_council_market(w, w.owner.id()).await?;
    let id = STAND_IN_SWEEP_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    ft_call(w, &w.owner, w.council.id(), amount, &format!("revenue:{id}")).await?;
    set_council_market(w, w.market.id()).await
}

// Leaves `market` as the only allowed market on the Council: it is allowed first, then the others are removed.
pub async fn set_council_market(w: &World, market: &AccountId) -> anyhow::Result<()> {
    let markets: Vec<String> = serde_json::from_value(config(&w.council).await["markets"].clone())?;
    if !markets.iter().any(|m| m == market.as_str()) {
        council_owner_call(w, "allow_market", market).await?;
    }
    for other in markets.iter().filter(|m| m.as_str() != market.as_str()) {
        council_owner_call(w, "disallow_market", &other.parse()?).await?;
    }
    Ok(())
}

pub async fn council_owner_call(w: &World, method: &str, market: &AccountId) -> anyhow::Result<()> {
    w.owner
        .call(w.council.id(), method)
        .args_json(json!({ "market": market }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn skip_until(w: &World, t_ns: u64) {
    skip_to(&w.worker, t_ns).await;
}

// Moves chain time to the end of the commit phase, where reveals open.
pub async fn to_reveal_phase(w: &World, id: u64) {
    skip_until(w, case_u64(&case_json(w, id).await, "commit_ends_at")).await;
}

pub async fn finalize(w: &World, id: u64) -> anyhow::Result<()> {
    w.oracle
        .call("finalize")
        .args_json(json!({ "market": w.market.id(), "market_id": id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub fn u(v: &serde_json::Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

// (shares out, fee) for a buy of `amount`.
pub async fn quote_buy(w: &World, id: u64, side: &str, amount: u128) -> (u128, u128) {
    let q: serde_json::Value = w
        .market
        .view("quote_buy")
        .args_json(json!({ "market_id": id.to_string(), "side": side, "amount": amount.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap();
    (u(&q["shares_out"]), u(&q["fee"]))
}

// (collateral out, shares in, fee) for selling `shares`. The seller receives collateral out less the fee.
pub async fn quote_sell(w: &World, id: u64, side: &str, shares: u128) -> (u128, u128, u128) {
    let q: serde_json::Value = w
        .market
        .view("quote_sell")
        .args_json(json!({ "market_id": id.to_string(), "side": side, "shares": shares.to_string() }))
        .await
        .unwrap()
        .json()
        .unwrap();
    (u(&q["collateral_out"]), u(&q["shares_in"]), u(&q["fee"]))
}

pub async fn sell(
    w: &World,
    who: &Account,
    id: u64,
    side: &str,
    shares: u128,
    min_collateral: u128,
) -> anyhow::Result<()> {
    who.call(w.market.id(), "sell")
        .args_json(
            json!({ "market_id": id.to_string(), "side": side, "shares": shares.to_string(),
                           "min_collateral": min_collateral.to_string() }),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// (collected, revenue due, treasury due) in the market.
pub async fn fees(w: &World) -> (u128, u128, u128) {
    let f: serde_json::Value = w.market.view("get_fees").await.unwrap().json().unwrap();
    (u(&f["collected"]), u(&f["revenue_due"]), u(&f["treasury_due"]))
}

// The market refuses a second sweep within an hour of the last one.
pub async fn past_sweep_interval(w: &World) {
    let t = now(&w.worker).await;
    skip_until(w, t + 3_601 * 1_000_000_000).await;
}

pub async fn sweep(w: &World, who: &Account) -> anyhow::Result<near_workspaces::result::ExecutionSuccess> {
    Ok(who
        .call(w.market.id(), "sweep_fees")
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?)
}

pub async fn council_total_received(w: &World) -> u128 {
    let s: String = w.council.view("total_received").await.unwrap().json().unwrap();
    s.parse().unwrap()
}

pub async fn reward_totals(w: &World) -> serde_json::Value {
    w.council.view("reward_totals").await.unwrap().json().unwrap()
}

// What a claim of every seat `who` holds would pay now.
pub async fn claimable_of(w: &World, who: &AccountId) -> u128 {
    let s: String = w
        .council
        .view("claimable_of")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

pub async fn seat_earnings(w: &World, token_id: &str) -> serde_json::Value {
    w.council
        .view("seat_earnings")
        .args_json(json!({ "token_id": token_id }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

// The council's claim for the named seats. Returns the logs of the whole call, the payout and the callback included.
pub async fn claim(w: &World, who: &Account, token_ids: &[&str]) -> anyhow::Result<Vec<String>> {
    let r = claim_with_gas(w, who, token_ids, 100).await?.into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

// The same claim with the gas given, and the outcome left unchecked so a test can look at a refusal or the gas burnt.
pub async fn claim_with_gas(
    w: &World,
    who: &Account,
    token_ids: &[&str],
    tgas: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(who
        .call(w.council.id(), "claim")
        .args_json(json!({ "token_ids": token_ids }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

// Anyone walks the Council's days up to today. Returns the logs of the call.
pub async fn advance_days(w: &World) -> anyhow::Result<Vec<String>> {
    let r = w
        .bob
        .call(w.council.id(), "advance_days")
        .args_json(json!({ "max_steps": null }))
        .transact()
        .await?
        .into_result()?;
    Ok(r.logs().iter().map(|l| l.to_string()).collect())
}

// ---- the Council's day ledger ---------------------------------------------------------------------------------------
//
// ACCELERATED. A thousand sandbox blocks take about eight seconds and move the chain clock by about five minutes, so the
// next UTC midnight is a quarter of an hour away at best and the end of a quarter is a day or more. A test that needs a day
// to pass or a quarter to end edits the Council's day cursor (`last_day`), its running-quarter marker and its seats' start
// days instead. They are plain fields: the contract cannot tell an edited ledger from one it wrote on those days. Everything
// that follows is the contract's own code on real calls, the walk over the days, the splits, the quarter close and the
// claim, with real money in the verifier. The helpers check the state layout before they write, so a changed layout fails
// loudly instead of corrupting a test.
const STATE_KEY: &[u8] = b"STATE";
const STAKES_PREFIX: u8 = 1;
const DAY_ACC_PREFIX: u8 = 11;
const JOINS_ON_PREFIX: u8 = 15;
const ACCRUED_PREFIX: u8 = 12;
const CLAIMS_PREFIX: u8 = 13;
// Byte offsets counted back from the end of the Council's state: its last field is a 5-byte map prefix, and the fields
// before it are next_claim_id, pending_total_slots, pending, accrued_total, accrued, last_closed_quarter, quarter_acc,
// day_acc, last_day, joins_on, active, cut_pool, carry, carry_scaled and acc.
const ACCRUED_TOTAL_FROM_END: usize = 50;
const NEXT_CLAIM_ID_FROM_END: usize = 13;
const PENDING_CLAIMS_TOTAL_FROM_END: usize = 170;
const TOTAL_PAID_FROM_END: usize = 186;
const LAST_CLOSED_QUARTER_FROM_END: usize = 59;
const LAST_DAY_FROM_END: usize = 77;
const ACTIVE_FROM_END: usize = 86;
const ACC_FROM_END: usize = 150;

// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted_month = i64::from(if month > 2 { month - 3 } else { month + 9 });
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

// The UTC day a quarter starts on. A quarter id is year * 4 + (quarter - 1).
pub fn quarter_start_day(quarter: u32) -> u64 {
    days_from_civil(i64::from(quarter / 4), quarter % 4 * 3 + 1, 1) as u64
}

pub async fn quarter_info(w: &World) -> serde_json::Value {
    w.council.view("quarter_info").await.unwrap().json().unwrap()
}

// The quarter the chain is in.
pub async fn running_quarter(w: &World) -> u32 {
    quarter_info(w).await["quarter"].as_u64().unwrap() as u32
}

pub async fn quarter_snapshots(w: &World) -> Vec<(u32, u128)> {
    let snapshots: Vec<serde_json::Value> = w
        .council
        .view("quarter_snapshots")
        .args_json(json!({ "from": null, "limit": null }))
        .await
        .unwrap()
        .json()
        .unwrap();
    snapshots
        .iter()
        .map(|s| (s["quarter"].as_u64().unwrap() as u32, u(&s["acc"])))
        .collect()
}

pub async fn in_progress_of(w: &World, who: &AccountId) -> u128 {
    let s: String = w
        .council
        .view("in_progress_of")
        .args_json(json!({ "account_id": who }))
        .await
        .unwrap()
        .json()
        .unwrap();
    s.parse().unwrap()
}

async fn council_state(w: &World) -> std::collections::HashMap<Vec<u8>, Vec<u8>> {
    w.worker.view_state(w.council.id()).await.unwrap()
}

fn council_last_day(state: &std::collections::HashMap<Vec<u8>, Vec<u8>>) -> u64 {
    let main = &state[STATE_KEY];
    let at = main.len() - LAST_DAY_FROM_END;
    u64::from_le_bytes(main[at..at + 8].try_into().unwrap())
}

// Writes `value` over the bytes of the Council's main record that end `from_end` bytes before its end, after checking the
// record still has last_day where this file expects it.
async fn patch_council_main(w: &World, edits: &[(usize, Vec<u8>)]) -> anyhow::Result<()> {
    let state = council_state(w).await;
    let mut main = state[STATE_KEY].clone();
    let expected: u64 = config(&w.council).await["last_day"].as_str().unwrap().parse()?;
    assert_eq!(
        council_last_day(&state),
        expected,
        "last_day is not where this helper expects it: the Council's state layout changed"
    );
    for (from_end, value) in edits {
        let at = main.len() - from_end;
        main[at..at + value.len()].copy_from_slice(value);
    }
    w.worker.patch_state(w.council.id(), STATE_KEY, &main).await?;
    Ok(())
}

// Where a seat's earn_from_day sits in its record: version, owner, staked_at, the two options, then the day. Returns the offset
// and whether the seat asked to leave or is serving.
fn earn_from_day_at(stake: &[u8]) -> (usize, bool, bool) {
    let owner_len = u32::from_le_bytes(stake[1..5].try_into().unwrap()) as usize;
    let mut at = 1 + 4 + owner_len + 8;
    let leaving = stake[at] == 1;
    at += if leaving { 9 } else { 1 };
    let serving = stake[at] == 1;
    at += if serving { 9 } else { 1 };
    (at, leaving, serving)
}

fn day_key(prefix: u8, day: u64) -> Vec<u8> {
    [vec![prefix], day.to_le_bytes().to_vec()].concat()
}

// Every seat that has not started earning gets the start day `start`, in its record and in the books: the Council counts it as
// earning, with the revenue index as it stands now as its starting point, as a walk over that day would have done. The
// Council must have walked to today. Returns how many seats started.
async fn start_waiting_seats_on(w: &World, start: u64) -> anyhow::Result<usize> {
    let state = council_state(w).await;
    let walked = council_last_day(&state);
    assert_eq!(
        walked,
        now(&w.worker).await / NS_PER_DAY,
        "call advance_days first: the Council has not walked to today"
    );
    assert!(
        !state.contains_key(&day_key(DAY_ACC_PREFIX, start)),
        "the day {start} already has an index: seats can start there once"
    );
    let waiting = walked + 1;
    let tokens: Vec<String> = w
        .council
        .view("staked_tokens")
        .args_json(json!({ "from_index": 0, "limit": 1000 }))
        .await?
        .json()?;
    let mut moved = 0;
    for token in tokens {
        let key = [vec![STAKES_PREFIX], borsh_string(&token)].concat();
        let mut stake = state[&key].clone();
        let (at, leaving, serving) = earn_from_day_at(&stake);
        if leaving || serving || u64::from_le_bytes(stake[at..at + 8].try_into()?) != waiting {
            continue;
        }
        stake[at..at + 8].copy_from_slice(&start.to_le_bytes());
        w.worker.patch_state(w.council.id(), &key, &stake).await?;
        moved += 1;
    }
    let main = &state[STATE_KEY];
    let acc = &main[main.len() - ACC_FROM_END..main.len() - ACC_FROM_END + 16];
    let active = u32::from_le_bytes(main[main.len() - ACTIVE_FROM_END..][..4].try_into()?);
    w.worker
        .patch_state(w.council.id(), &day_key(DAY_ACC_PREFIX, start), acc)
        .await?;
    w.worker
        .patch_state(w.council.id(), &day_key(JOINS_ON_PREFIX, waiting), &0u32.to_le_bytes())
        .await?;
    patch_council_main(w, &[(ACTIVE_FROM_END, (active + moved as u32).to_le_bytes().to_vec())]).await?;
    Ok(moved)
}

// ACCELERATED. The seats staked so far have been earning since the first day of the quarter the Council still takes to be
// running, `quarters_back` quarters before the one the chain is in. The Council's last finished quarter is the one before
// that. With 0 the quarter is the chain's own and nothing is due to end. Meant for a fresh world: no revenue has arrived.
pub async fn back_date(w: &World, quarters_back: u32) -> anyhow::Result<()> {
    assert_eq!(
        council_total_received(w).await,
        0,
        "seats are back-dated before the first revenue arrives"
    );
    let running = running_quarter(w).await - quarters_back;
    start_waiting_seats_on(w, quarter_start_day(running)).await?;
    if quarters_back > 0 {
        patch_council_main(
            w,
            &[(LAST_CLOSED_QUARTER_FROM_END, (running - 1).to_le_bytes().to_vec())],
        )
        .await?;
    }
    Ok(())
}

// ACCELERATED. Puts the Council's day cursor back to the day before the quarter that follows the one `back_date` made it
// believe in. The next call that moves money walks the days from there, closes that quarter and folds in the seats that
// start on the way, as it does after a quarter ends. The walk takes as many days as have passed in the chain's own quarter,
// 1 to 92, plus a quarter for each step back past the first.
pub async fn end_quarters(w: &World, quarters_back: u32) -> anyhow::Result<()> {
    let first_after = quarter_start_day(running_quarter(w).await - quarters_back + 1);
    patch_council_main(w, &[(LAST_DAY_FROM_END, (first_after - 1).to_le_bytes().to_vec())]).await
}

// ACCELERATED. Lets one UTC midnight pass for the Council: the seats staked since the last one start earning, with the index
// as it is now as their starting point. The chain's own clock stays where it is. The start day is a day before today that no
// seat started on yet, which is only a label for the books.
pub async fn to_next_day(w: &World) -> anyhow::Result<()> {
    let state = council_state(w).await;
    let mut day = council_last_day(&state);
    while state.contains_key(&day_key(DAY_ACC_PREFIX, day)) {
        day -= 1;
    }
    start_waiting_seats_on(w, day).await?;
    Ok(())
}

// ACCELERATED. Nothing in the sandbox makes a payout callback fail to arrive, so this writes the books a Council would hold
// then. Right after one claim by `who` of `amount` over `tokens`, as claim number 0, the balance is debited and the amount is
// in flight, with nothing booked as paid or credited back: `reconcile_claim` is what decides it.
pub async fn leave_claim_in_flight(w: &World, who: &Account, amount: u128, tokens: &[&str]) -> anyhow::Result<()> {
    let totals = reward_totals(w).await;
    assert_eq!(
        u(&totals["total_paid"]) + u(&totals["accrued_total"]),
        amount,
        "exactly one claim has been made, and it is for the amount given"
    );
    assert_eq!(u(&totals["pending_claims"]), 0);
    let state = council_state(w).await;
    let main = &state[STATE_KEY];
    let total_paid_at = main.len() - TOTAL_PAID_FROM_END;
    assert_eq!(
        u128::from_le_bytes(main[total_paid_at..total_paid_at + 16].try_into()?),
        u(&totals["total_paid"]),
        "total_paid is not where this helper expects it: the Council's state layout changed"
    );
    let mut record = vec![0u8];
    record.extend(borsh_string(who.id().as_str()));
    record.extend(amount.to_le_bytes());
    record.extend((tokens.len() as u32).to_le_bytes());
    for token in tokens {
        record.extend(borsh_string(token));
    }
    record.extend(now(&w.worker).await.to_le_bytes());
    w.worker
        .patch_state(w.council.id(), &day_key(CLAIMS_PREFIX, 0), &record)
        .await?;
    let accrued_key = [vec![ACCRUED_PREFIX], borsh_string(who.id().as_str())].concat();
    w.worker
        .patch_state(w.council.id(), &accrued_key, &0u128.to_le_bytes())
        .await?;
    patch_council_main(
        w,
        &[
            (ACCRUED_TOTAL_FROM_END, 0u128.to_le_bytes().to_vec()),
            (TOTAL_PAID_FROM_END, 0u128.to_le_bytes().to_vec()),
            (PENDING_CLAIMS_TOTAL_FROM_END, amount.to_le_bytes().to_vec()),
            (NEXT_CLAIM_ID_FROM_END, 1u64.to_le_bytes().to_vec()),
        ],
    )
    .await
}

pub async fn reconcile_claim(
    w: &World,
    who: &Account,
    id: u64,
    paid: bool,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(who
        .call(w.council.id(), "reconcile_claim")
        .args_json(json!({ "id": id.to_string(), "paid": paid }))
        .transact()
        .await?)
}

// As `setup`, with the five jurors already earning in the quarter the chain is in.
pub async fn setup_earning() -> anyhow::Result<World> {
    let w = setup().await?;
    back_date(&w, 0).await?;
    Ok(w)
}

// ACCELERATED. The Council is `days` days behind: its day cursor goes back that far.
pub async fn rewind_days(w: &World, days: u64) -> anyhow::Result<()> {
    let today = council_last_day(&council_state(w).await);
    patch_council_main(w, &[(LAST_DAY_FROM_END, (today - days).to_le_bytes().to_vec())]).await
}

// ACCELERATED. As `rewind_days`, with one seat counted as starting on each of those days, so the walk that catches up has a day
// with joiners every step. Only the counts exist, no seat record, which is all the walk reads. Meant for gas measurements.
pub async fn fall_behind(w: &World, days: u64) -> anyhow::Result<()> {
    let today = council_last_day(&council_state(w).await);
    for day in today - days + 1..=today {
        w.worker
            .patch_state(w.council.id(), &day_key(JOINS_ON_PREFIX, day), &1u32.to_le_bytes())
            .await?;
    }
    rewind_days(w, days).await
}

// Lets `who` receive the collateral token.
pub async fn register_ft(w: &World, who: &AccountId) -> anyhow::Result<()> {
    w.owner
        .call(w.ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// Application owner fixture only. This does not simulate Trezu voting or its execution delay.
// Real Sputnik proposal/callback integration must be tested against the selected deployment separately.
pub async fn setup_admin_owned() -> anyhow::Result<(World, Account)> {
    let worker = near_workspaces::sandbox().await?;
    let admin = worker.dev_create_account().await?;
    let w = build(
        worker,
        WINDOW_MS,
        PANEL_MS,
        DRAW_DELAY_BLOCKS,
        Some(admin.clone()),
        true,
    )
    .await?;
    Ok((w, admin))
}

pub fn function_call(receiver: &AccountId, method: &str, args: serde_json::Value, tgas: u64) -> serde_json::Value {
    use base64::Engine;
    json!({ "function_call": {
        "receiver_id": receiver, "method_name": method,
        "args": base64::engine::general_purpose::STANDARD.encode(args.to_string()),
        "deposit": "0", "gas": Gas::from_tgas(tgas).as_gas().to_string()
    } })
}

pub async fn config(c: &Contract) -> serde_json::Value {
    c.view("config").await.unwrap().json().unwrap()
}

// borsh of a String: a u32 length, then the bytes.
pub fn borsh_string(s: &str) -> Vec<u8> {
    let mut v = (s.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(s.as_bytes());
    v
}

// The key the Council keeps a case's jury under: the oracle's case_uid, with the top bit set for the second round.
pub async fn council_key(w: &World, id: u64) -> String {
    let case = case_json(w, id).await;
    let uid = case_u64(&case, "case_uid");
    if case["round"] == 0 {
        uid
    } else {
        uid | SECOND_ROUND_KEY
    }
    .to_string()
}

// Puts a seat back in the state a failed unlock_case would have left it in: marked as serving `case`, and the case's
// jury list still holding it. Storage keys are the enum prefix (Stakes = 1, Juries = 3) then the borsh key.
pub async fn relock_seat(w: &World, token_id: &str, market_id: u64) -> anyhow::Result<()> {
    let case: u64 = council_key(w, market_id).await.parse()?;
    let state = w.worker.view_state(w.council.id()).await?;
    let stake_key = [vec![1u8], borsh_string(token_id)].concat();
    let old = state
        .get(&stake_key)
        .expect("the staked seat is stored under the key this test expects")
        .clone();
    // Stake = version: u8, owner: String, staked_at: u64, unlock_requested_at: Option<u64>, serving: Option<u64>, earn_from_day: u64,
    // settled_acc: u128, forfeited: u128, serving_acc: u128, index: u32
    let owner_len = u32::from_le_bytes(old[1..5].try_into()?) as usize;
    let mut at = 1 + 4 + owner_len + 8;
    let mut new = old[..at].to_vec();
    assert_eq!(old[at], 0, "the seat has not asked to unstake");
    new.push(0);
    at += 1;
    assert_eq!(old[at], 0, "the first unlock freed the seat");
    new.push(1);
    new.extend_from_slice(&case.to_le_bytes());
    new.extend_from_slice(&old[at + 1..]);
    w.worker.patch_state(w.council.id(), &stake_key, &new).await?;
    let jury_key = [vec![3u8], case.to_le_bytes().to_vec()].concat();
    let jury = [1u32.to_le_bytes().to_vec(), borsh_string(token_id)].concat();
    w.worker.patch_state(w.council.id(), &jury_key, &jury).await?;
    Ok(())
}

pub fn tg(g: Gas) -> f64 {
    g.as_gas() as f64 / 1e12
}

// Gas burnt by the receipts that ran on `who`, in TGas. A transaction's own total also holds the verifier and every other contract.
pub fn burnt_on(r: &near_workspaces::result::ExecutionFinalResult, who: &AccountId) -> f64 {
    r.receipt_outcomes()
        .iter()
        .filter(|o| &o.executor_id == who)
        .map(|o| tg(o.gas_burnt))
        .sum()
}

// The account's storage usage in bytes.
pub async fn storage_used(w: &World, who: &AccountId) -> anyhow::Result<u64> {
    Ok(w.worker.view_account(who).await?.storage_usage)
}

// Gives a contract account enough NEAR to hold a very large state.
pub async fn top_up(w: &World, who: &AccountId) -> anyhow::Result<()> {
    let details = w.worker.view_account(who).await?;
    w.worker
        .patch(who)
        .account(near_workspaces::AccountDetailsPatch::from(details).balance(NearToken::from_near(3_000)))
        .transact()
        .await?;
    Ok(())
}

// A funded sub-account of the sandbox root whose whole id is `id_len` characters long, named from `tag`.
pub async fn account_with_id_len(w: &World, id_len: usize, tag: &str) -> anyhow::Result<Account> {
    let name_len = id_len - ".test.near".len();
    let name = format!("{:a<name_len$}", tag);
    anyhow::ensure!(name.len() == name_len, "the tag is longer than the name");
    let account = w
        .worker
        .root_account()?
        .create_subaccount(&name)
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    anyhow::ensure!(
        account.id().as_str().len() == id_len,
        "wrong id length: {}",
        account.id()
    );
    Ok(account)
}

// Creates `count` markets that close in 30 days. Returns the id of the first. Creation goes four to a transaction at
// 70 TGas each.
pub async fn bulk_markets(w: &World, count: u64) -> anyhow::Result<u64> {
    use near_workspaces::operations::Function;
    const PER_CALL: u64 = 70;
    const BATCH: u64 = 4;
    let first: u64 = w.market.view("config").await?.json::<serde_json::Value>()?["markets"]
        .as_str()
        .map_or(0, |s| s.parse().unwrap_or(0));
    let mut made = 0;
    while made < count {
        let take = BATCH.min(count - made);
        let close_at = now(&w.worker).await + 30 * 24 * 3_600 * 1_000_000_000;
        let mut create = w.owner.batch(w.market.id());
        for i in 0..take {
            let id = first + made + i;
            create = create.call(
                Function::new("create_market")
                    .deposit(near_workspaces::types::NearToken::from_millinear(60))
                    .args_json(json!({
                        "title": format!("Bulk market number {id}"), "rule_text": "Resolves Yes if the test says so.",
                        "resolution_source": "https://example.com/source", "void_policy": "Void if the test is cancelled.",
                        "category": "world", "subcategory": "science",
                        "close_at": close_at.to_string(), "resolve_by": (close_at + MARKET_GAP_SECS * 1_000_000_000).to_string()
                    }))
                    .gas(Gas::from_tgas(PER_CALL)),
            );
        }
        create.transact().await?.into_result()?;
        made += take;
    }
    anyhow::ensure!(
        market_json(w, first + count - 1).await["registered"] == true,
        "the last bulk market was not registered"
    );
    Ok(first)
}
