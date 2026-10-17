// Test-only NEP-171 collection with approvals. Owner mints. Never deploy this on mainnet.
use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::borsh::BorshSerialize;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, Promise, PromiseOrValue};
use std::collections::HashMap;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockNft {
    tokens: NonFungibleToken,
}

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Owners,
    Approvals,
}

#[near]
impl MockNft {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::Owners,
                owner_id,
                None::<StorageKey>,
                None::<StorageKey>,
                Some(StorageKey::Approvals),
            ),
        }
    }

    // The mock's own balance pays the storage.
    pub fn nft_mint(&mut self, token_id: TokenId, receiver_id: AccountId) -> Token {
        require!(env::predecessor_account_id() == self.tokens.owner_id, "owner only");
        self.tokens.internal_mint_with_refund(token_id, receiver_id, None, None)
    }

    #[payable]
    pub fn nft_approve(&mut self, token_id: TokenId, account_id: AccountId, msg: Option<String>) -> Option<Promise> {
        self.tokens.nft_approve(token_id, account_id, msg)
    }
}

#[near]
impl NonFungibleTokenCore for MockNft {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for MockNft {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}
