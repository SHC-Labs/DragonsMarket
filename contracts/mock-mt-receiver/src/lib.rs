// Test-only NEP-245 receiver and payer for the Intents verifier proof. Never deploy this on mainnet.
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, Promise, PromiseOrValue};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const PAY_GAS: Gas = Gas::from_tgas(40);

#[ext_contract(ext_verifier)]
pub trait Verifier {
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
    fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Notification {
    pub predecessor: AccountId,
    pub sender_id: AccountId,
    pub previous_owner_ids: Vec<AccountId>,
    pub token_ids: Vec<String>,
    pub amounts: Vec<U128>,
    pub msg: String,
    pub prepaid_gas: u64,
}

#[near(contract_state)]
#[derive(Default)]
pub struct MockMtReceiver {
    notifications: Vec<Notification>,
}

#[near]
impl MockMtReceiver {
    // The msg picks the behaviour: "panic", "malformed", "wrong_len", "refund_all", "refund:<n>", anything else keeps everything.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Value {
        self.notifications.push(Notification {
            predecessor: env::predecessor_account_id(),
            sender_id,
            previous_owner_ids,
            token_ids,
            amounts: amounts.clone(),
            msg: msg.clone(),
            prepaid_gas: env::prepaid_gas().as_gas(),
        });
        match msg.as_str() {
            "panic" => env::panic_str("receiver refuses"),
            "malformed" => json!("not a list of amounts"),
            "wrong_len" => json!([]),
            "refund_all" => json!(amounts),
            other => match other.strip_prefix("refund:") {
                Some(n) => json!(amounts.iter().map(|_| n.to_string()).collect::<Vec<_>>()),
                None => json!(amounts.iter().map(|_| "0").collect::<Vec<_>>()),
            },
        }
    }

    pub fn notifications(&self) -> Vec<Notification> {
        self.notifications.clone()
    }

    pub fn pay(&self, verifier: AccountId, receiver_id: AccountId, token_id: String, amount: U128) -> Promise {
        ext_verifier::ext(verifier)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(PAY_GAS)
            .mt_transfer(receiver_id, token_id, amount, None, Some("pay".to_string()))
    }

    pub fn pay_call(
        &self,
        verifier: AccountId,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        msg: String,
    ) -> Promise {
        ext_verifier::ext(verifier)
            .with_attached_deposit(ONE_YOCTO)
            .with_unused_gas_weight(1)
            .mt_transfer_call(receiver_id, token_id, amount, None, Some("pay".to_string()), msg)
    }
}
