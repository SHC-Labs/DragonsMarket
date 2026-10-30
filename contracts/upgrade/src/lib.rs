// The upgrade path market, oracle and council share, and the gas floor check they all use. Each
// contract keeps its own methods (stage_code, upgrade, migrate, seal) and its own events and owner check, and calls these
// for the storage, gas and promise work. An upgrade is two steps so the code can be read before it runs: anyone stages a
// wasm, and only the owner can then deploy it by its hash.

use near_sdk::json_types::Base58CryptoHash;
use near_sdk::{env, require, AccountId, CryptoHash, Gas, NearToken, Promise, PublicKey};

const STAGED_PREFIX: &[u8] = b"staged_code:";
const STATE_KEY: &[u8] = b"STATE";
// Every contract's state struct starts with a u16, which Borsh writes as the first two bytes, little endian.
const VERSION_LEN: usize = 2;
const MIGRATE_METHOD: &str = "migrate";

// Gas given to migrate in the deploy batch. The version 1 migrate reads the state and writes it back, which burned
// about 3 TGas in the sandbox. A later migrate that rewrites more raises this in the same release.
pub const GAS_MIGRATE: Gas = Gas::from_tgas(30);
// What upgrade needs attached: the deploy of a wasm of the size the contracts build to (the market is about 340 KB), the
// migrate gas above and a margin. The sandbox upgrade test deploys each contract's real build at exactly this amount, so a
// larger build that no longer fits fails that test. See contracts/AUDIT.md.
pub const GAS_UPGRADE: Gas = Gas::from_tgas(100);
// The callback that clears `upgrade_in_flight` when the deploy batch fails.
pub const GAS_UPGRADE_DONE: Gas = Gas::from_tgas(5);

pub struct Staged {
    pub code_hash: Base58CryptoHash,
    pub bytes: u64,
    pub by: AccountId,
}

fn staged_key(code_hash: &CryptoHash) -> Vec<u8> {
    [STAGED_PREFIX, code_hash.as_slice()].concat()
}

// Stores the call's raw input under its own sha256, so staging can never overwrite different code. The caller pays for
// the storage out of the attached deposit and gets the rest back. Staging the same wasm twice costs nothing.
pub fn stage_code() -> Staged {
    let code = env::input().unwrap_or_default();
    require!(!code.is_empty(), "the wasm goes in the call input");
    let hash = env::sha256_array(&code);
    let before = env::storage_usage();
    env::storage_write(&staged_key(&hash), &code);
    let cost = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage().saturating_sub(before)));
    let paid = env::attached_deposit();
    require!(paid >= cost, format!("attach at least {cost} to pay for the storage"));
    let by = env::predecessor_account_id();
    let refund = paid.saturating_sub(cost);
    if !refund.is_zero() {
        let _ = Promise::new(by.clone()).transfer(refund);
    }
    Staged {
        code_hash: hash.into(),
        bytes: code.len() as u64,
        by,
    }
}

pub fn is_staged(code_hash: Base58CryptoHash) -> bool {
    env::storage_has_key(&staged_key(&code_hash.into()))
}

// The fail-fast check for a method that sends calls of its own: its floor is what it reserves for them plus what it burns
// itself, and the message says how much to attach and why. A call with less fails anyway, part way through, with a host
// error that names no amount.
pub fn require_gas(floor: Gas, reason: &str) {
    require!(
        env::prepaid_gas() >= floor,
        format!("attach at least {} TGas: {reason}", floor.as_tgas())
    );
}

pub fn require_upgrade_gas() {
    require!(
        env::prepaid_gas() >= GAS_UPGRADE,
        format!("attach at least {} TGas to upgrade", GAS_UPGRADE.as_tgas())
    );
}

// Reads the staged code and removes it. The removal is kept even when the deploy batch later fails, so a failed upgrade
// has to stage its code again.
pub fn take_staged(code_hash: Base58CryptoHash) -> Vec<u8> {
    let key = staged_key(&code_hash.into());
    let code = env::storage_read(&key).unwrap_or_else(|| env::panic_str("no code is staged under that hash"));
    env::storage_remove(&key);
    code
}

// One batch on this account: if migrate panics, the deploy is reverted with it and the old code stays.
pub fn deploy_and_migrate(code: Vec<u8>) -> Promise {
    Promise::new(env::current_account_id())
        .deploy_contract(code)
        .function_call(
            MIGRATE_METHOD.to_string(),
            vec![],
            NearToken::from_yoctonear(0),
            GAS_MIGRATE,
        )
}

pub fn delete_key(public_key: PublicKey) -> Promise {
    Promise::new(env::current_account_id()).delete_key(public_key)
}

// migrate calls this before it reads the state as the one shape it knows, so a layout it was not written for is refused
// instead of guessed from bytes.
pub fn require_state_version(expected: u16) {
    let state = env::storage_read(STATE_KEY).unwrap_or_else(|| env::panic_str("there is no state to migrate"));
    let found = state.get(..VERSION_LEN).map(|b| u16::from_le_bytes([b[0], b[1]]));
    require!(found == Some(expected), format!("migrate expects version {expected}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn call_with(input: &[u8], deposit: NearToken) {
        let mut builder = VMContextBuilder::new();
        builder
            .predecessor_account_id("anyone.near".parse().unwrap())
            .attached_deposit(deposit);
        builder.context.input = input.to_vec().into();
        testing_env!(builder.build());
    }

    fn start(input: &[u8], deposit: NearToken) {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        call_with(input, deposit);
    }

    fn cost_of(code: &[u8]) -> NearToken {
        start(code, NearToken::from_near(10));
        let before = env::storage_usage();
        stage_code();
        NearToken::from_yoctonear(env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage() - before))
    }

    #[test]
    fn the_code_is_stored_under_its_own_sha256_and_read_back_once() {
        let code = vec![7u8; 1000];
        start(&code, NearToken::from_near(1));
        let staged = stage_code();
        assert_eq!(staged.code_hash, Base58CryptoHash::from(env::sha256_array(&code)));
        assert_eq!((staged.bytes, staged.by.as_str()), (1000, "anyone.near"));
        assert!(is_staged(staged.code_hash));
        assert_eq!(take_staged(staged.code_hash), code);
        assert!(!is_staged(staged.code_hash), "taking it removes it");
    }

    #[test]
    fn different_code_is_stored_beside_it_and_never_replaces_it() {
        start(&[1, 2, 3], NearToken::from_near(1));
        let a = stage_code().code_hash;
        call_with(&[4, 5, 6], NearToken::from_near(1));
        let b = stage_code().code_hash;
        assert_ne!(a, b);
        assert_eq!((take_staged(a), take_staged(b)), (vec![1, 2, 3], vec![4, 5, 6]));
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn a_deposit_one_yocto_short_of_the_storage_cost_is_refused() {
        let code = vec![9u8; 500];
        let cost = cost_of(&code);
        start(&code, NearToken::from_yoctonear(cost.as_yoctonear() - 1));
        stage_code();
    }

    #[test]
    fn the_exact_cost_is_accepted_and_the_rest_goes_back() {
        let code = vec![9u8; 500];
        let cost = cost_of(&code);
        start(&code, cost);
        stage_code();
        assert!(get_created_receipts().is_empty(), "nothing to refund");
        start(&code, NearToken::from_yoctonear(cost.as_yoctonear() + 5));
        stage_code();
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id.as_str(), "anyone.near");
    }

    #[test]
    fn staging_the_same_wasm_again_costs_nothing() {
        let code = vec![3u8; 400];
        start(&code, NearToken::from_near(1));
        stage_code();
        call_with(&code, NearToken::from_yoctonear(0));
        stage_code();
    }

    #[test]
    #[should_panic(expected = "the wasm goes in the call input")]
    fn an_empty_call_is_refused() {
        start(&[], NearToken::from_near(1));
        stage_code();
    }

    #[test]
    #[should_panic(expected = "no code is staged under that hash")]
    fn a_hash_nobody_staged_is_refused() {
        start(&[1], NearToken::from_near(1));
        take_staged(Base58CryptoHash::from([0u8; 32]));
    }

    #[test]
    #[should_panic(expected = "attach at least 100 TGas to upgrade")]
    fn too_little_gas_is_refused_with_the_amount_to_attach() {
        testing_env!(VMContextBuilder::new().prepaid_gas(Gas::from_tgas(99)).build());
        require_upgrade_gas();
    }

    #[test]
    fn a_floor_refuses_less_gas_and_says_how_much_and_why() {
        testing_env!(VMContextBuilder::new().prepaid_gas(Gas::from_tgas(54)).build());
        let err =
            std::panic::catch_unwind(|| require_gas(Gas::from_tgas(55), "an unstake sends two calls")).unwrap_err();
        let message = err.downcast_ref::<String>().cloned().unwrap_or_default();
        assert_eq!(message, "attach at least 55 TGas: an unstake sends two calls");
    }

    #[test]
    fn a_floor_accepts_exactly_that_much_gas_or_more() {
        for attached in [55, 56, 300] {
            testing_env!(VMContextBuilder::new().prepaid_gas(Gas::from_tgas(attached)).build());
            require_gas(Gas::from_tgas(55), "an unstake sends two calls");
        }
    }

    #[test]
    fn the_version_is_read_from_the_first_two_bytes_of_the_state() {
        start(&[1], NearToken::from_near(1));
        env::storage_write(STATE_KEY, &[1, 0, 9, 9, 9]);
        require_state_version(1);
        env::storage_write(STATE_KEY, &[2, 0, 9, 9, 9]);
        assert!(std::panic::catch_unwind(|| require_state_version(1)).is_err());
    }
}
