// Test-only NEP-141 token. Owner can mint. Never deploy this on mainnet.
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    owner: AccountId,
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    // Test switch: while on, ft_transfer_call moves the tokens and then its resolve step panics, so the caller sees a
    // failure although the tokens are with the receiver.
    fail_resolve: bool,
}

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Token,
    Metadata,
}

#[near]
impl MockFt {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Mock USD".to_string(),
            symbol: "mUSD".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        };
        Self {
            owner: owner_id,
            token: FungibleToken::new(StorageKey::Token),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            fail_resolve: false,
        }
    }

    // Public test money so friends can try the app. Testnet only, never deploy this token on mainnet.
    // ponytail: 100 per call, refused above 1000 held; the mock's own balance pays the storage.
    pub fn faucet(&mut self) {
        let who = env::predecessor_account_id();
        let have = self.token.accounts.get(&who).unwrap_or(0);
        require!(have < 1_000_000_000, "you already have enough test money");
        if !self.token.accounts.contains_key(&who) {
            self.token.internal_register_account(&who);
        }
        self.token.internal_deposit(&who, 100_000_000);
    }

    pub fn set_fail_resolve(&mut self, fail: bool) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.fail_resolve = fail;
    }

    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.into());
    }
}

#[near]
impl FungibleTokenCore for MockFt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockFt {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        require!(!self.fail_resolve, "the resolve step is set to fail");
        self.token
            .internal_ft_resolve_transfer(&sender_id, receiver_id, amount)
            .0
            .into()
    }
}

// The impl_fungible_token_storage! macro in near-contract-standards 5.29.1 declares storage_withdraw
// with U128 where the trait wants NearToken, so it does not compile. Delegate by hand.
#[near]
impl StorageManagement for MockFt {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockFt {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}
