// Governance for the pitch test. Up to five members own market, oracle and council in place of a
// single key. A member proposes an action, members vote, and an approved action waits out a timelock before
// anyone can execute it, so every change is public on-chain before it takes effect. Changes to the members
// and to these settings go through the same path as any other action. So does code: the other three contracts are
// upgraded by a call to their upgrade method, and this contract by its own UpgradeSelf action. The timelock is the
// users' exit window, since withdrawing and redeeming never pause.

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, PublicKey,
};

const MAX_MEMBERS: usize = 5;
// Records are paid for out of this contract's own balance, so they must be bounded. 4,096 bytes covers
// create_market at its own text limits. 256 is the protocol's own limit on a method name.
const MAX_ARGS: usize = 4096;
const MAX_METHOD_NAME: usize = 256;
// Measured in the sandbox at the args cap with five votes: propose burns 4.3 TGas, a vote up to 2.2, a
// settings change 1.7 when executed, and a call 3.0 plus 2.0 in on_executed. Executing a call needs its own gas
// plus 14 TGas attached (a 20 TGas call failed at 33 and worked at 34).
const GAS_ON_EXECUTED: Gas = Gas::from_tgas(10);
const GAS_EXECUTE_OVERHEAD: Gas = Gas::from_tgas(14);
// The gas a proposed call may carry. Below the least it cannot do anything useful and would fail in the target after the
// vote and the timelock were spent. Above the most, an execute could never attach it, since a transaction carries 300.
const MIN_CALL_GAS: Gas = Gas::from_tgas(5);
const MAX_CALL_GAS: Gas = Gas::from_tgas(250);
// Executing an upgrade runs the deploy and migrate batch of upgrade and then on_executed, so it needs what an upgrade
// call needs plus the callback.
const GAS_EXECUTE_UPGRADE: Gas = Gas::from_gas(upgrade::GAS_UPGRADE.as_gas() + GAS_ON_EXECUTED.as_gas());
// The layout of the state below. migrate reads exactly this one and refuses any other.
const STATE_VERSION: u16 = 1;

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Proposals,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    FunctionCall {
        receiver_id: AccountId,
        method_name: String,
        args: Base64VecU8,
        deposit: U128,
        gas: U64,
    },
    AddMember {
        account: AccountId,
    },
    RemoveMember {
        account: AccountId,
    },
    SetThreshold {
        threshold: u32,
    },
    SetVotingPeriod {
        voting_period_ns: U64,
    },
    SetTimelock {
        timelock_ns: U64,
    },
    SetExecutionWindow {
        execution_window_ns: U64,
    },
    // Replaces this contract's code with the staged wasm that has this sha256, then runs its migrate.
    UpgradeSelf {
        code_hash: Base58CryptoHash,
    },
    // Deletes an access key of this account. Refused until an upgrade has gone through migrate.
    Seal {
        public_key: PublicKey,
    },
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Open,
    Approved,
    Expired,
    // The call has been sent and its result has not come back yet.
    Executing,
    Executed,
    ExecutionFailed,
    // Stopped by enough members during its timelock. Never executes.
    Cancelled,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Vote {
    member: AccountId,
    approve: bool,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Proposal {
    id: U64,
    proposer: AccountId,
    created_at: U64,
    voting_ends_at: U64,
    action: Action,
    votes: Vec<Vote>,
    // Set once, the moment the yes votes reach the threshold. Nothing after that changes it.
    approved_at: Option<U64>,
    // Members who have voted to cancel it once approved. As with yes votes, only current members count.
    cancel_votes: Vec<AccountId>,
    stage: Stage,
}

// A proposal as the views show it: the stored record, and the gas an execute must carry. That is the call's own gas plus
// the overhead for a call, and what an upgrade needs for one. The other actions run inside execute, which asks for no more
// than a plain call does, so they show none.
#[near(serializers=[json])]
pub struct ProposalView {
    #[serde(flatten)]
    proposal: Proposal,
    execute_gas: Option<U64>,
}

#[near(contract_state, contract_metadata(standard(standard = "nep297", version = "1.0.0")))]
#[derive(PanicOnDefault)]
pub struct GovernanceContract {
    // First, so migrate can read it before it trusts the rest of the layout.
    state_version: u16,
    // Set by migrate, so it is true only once an upgrade has gone through. seal refuses until then.
    upgrade_proven: bool,
    members: Vec<AccountId>,
    threshold: u32,
    voting_period_ns: u64,
    timelock_ns: u64,
    // How long after its timelock ends an approved proposal can still be executed. Without it an old approval stays
    // armed for ever, and since anyone can execute, it could be fired months later at a bad moment.
    execution_window_ns: u64,
    proposals: LookupMap<u64, Proposal>,
    next_proposal_id: u64,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "governance", "version": "1.0.0", "event": event, "data": data })
    ));
}

fn valid_threshold(threshold: u32, members: usize) -> bool {
    threshold >= 1 && threshold as usize <= members
}

#[near]
impl GovernanceContract {
    // Only this account can run it, so a deploy and init batch signed by it is the one way in.
    #[private]
    #[init]
    pub fn new(
        members: Vec<AccountId>,
        threshold: u32,
        voting_period_ns: U64,
        timelock_ns: U64,
        execution_window_ns: U64,
    ) -> Self {
        require!(
            !members.is_empty() && members.len() <= MAX_MEMBERS,
            "there must be 1 to 5 members"
        );
        let mut distinct = members.clone();
        distinct.sort();
        distinct.dedup();
        require!(distinct.len() == members.len(), "members must be different accounts");
        require!(
            valid_threshold(threshold, members.len()),
            "threshold must be between 1 and the number of members"
        );
        require!(
            voting_period_ns.0 > 0 && timelock_ns.0 > 0 && execution_window_ns.0 > 0,
            "periods must be positive"
        );
        Self {
            state_version: STATE_VERSION,
            upgrade_proven: false,
            members,
            threshold,
            voting_period_ns: voting_period_ns.0,
            timelock_ns: timelock_ns.0,
            execution_window_ns: execution_window_ns.0,
            proposals: LookupMap::new(Key::Proposals),
            next_proposal_id: 0,
        }
    }

    // Anyone can stage a wasm: the call input is the code, the deposit pays for its storage and the answer is its hash.
    // Members can read a staged build before they vote to deploy it with UpgradeSelf.
    #[payable]
    pub fn stage_code(&mut self) -> Base58CryptoHash {
        let staged = upgrade::stage_code();
        emit(
            "code_staged",
            json!({ "code_hash": staged.code_hash, "bytes": staged.bytes.to_string(), "by": staged.by }),
        );
        staged.code_hash
    }

    // Runs in the new code, in the same batch as the deploy, so a panic here puts the old code back. It reads the one
    // layout it was written for. A later version keeps a copy of this struct as StateV1, reads that, builds its own
    // state from it and bumps state_version.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        upgrade::require_state_version(STATE_VERSION);
        let mut state: Self = env::state_read().unwrap_or_else(|| env::panic_str("there is no state to migrate"));
        state.upgrade_proven = true;
        emit("migrated", json!({ "state_version": state.state_version }));
        state
    }

    // The proposer's own vote is not cast for them.
    pub fn propose(&mut self, action: Action) -> U64 {
        let proposer = self.only_member();
        self.check(&action);
        let id = self.next_proposal_id;
        self.next_proposal_id += 1;
        let now = env::block_timestamp();
        let voting_ends_at = U64(now + self.voting_period_ns);
        emit(
            "proposed",
            json!({ "proposal_id": id.to_string(), "proposer": proposer, "action": action,
                    "voting_ends_at": voting_ends_at.0.to_string() }),
        );
        self.proposals.insert(
            id,
            Proposal {
                id: U64(id),
                proposer,
                created_at: U64(now),
                voting_ends_at,
                action,
                votes: vec![],
                approved_at: None,
                cancel_votes: vec![],
                stage: Stage::Open,
            },
        );
        U64(id)
    }

    // Votes are taken until the window ends, also after approval, so the record shows every member who voted.
    // Only the yes votes of current members count, so a removed member's earlier vote no longer does.
    pub fn vote(&mut self, proposal_id: U64, approve: bool) {
        let member = self.only_member();
        let mut p = self.proposal(proposal_id.0);
        let now = env::block_timestamp();
        require!(p.stage != Stage::Cancelled, "this proposal was cancelled");
        require!(matches!(p.stage, Stage::Open | Stage::Approved), "already executed");
        require!(now < p.voting_ends_at.0, "voting has ended");
        require!(!p.votes.iter().any(|v| v.member == member), "already voted");
        p.votes.push(Vote {
            member: member.clone(),
            approve,
        });
        emit(
            "voted",
            json!({ "proposal_id": proposal_id.0.to_string(), "member": member, "approve": approve }),
        );
        let yes = p
            .votes
            .iter()
            .filter(|v| v.approve && self.members.contains(&v.member))
            .count();
        if p.stage == Stage::Open && yes >= self.threshold as usize {
            p.stage = Stage::Approved;
            p.approved_at = Some(U64(now));
            emit(
                "approved",
                json!({ "proposal_id": proposal_id.0.to_string(), "executable_at": (now + self.timelock_ns).to_string(),
                        "expires_at": self.executable_until(now).to_string() }),
            );
        }
        self.proposals.insert(proposal_id.0, p);
    }

    // The timelock gives everyone a window to see a change coming. This is what the members can do with it: once
    // as many current members as the threshold have called it, an approved proposal that has not been executed is
    // cancelled for good. It is a defence against a mistake or a change that turned out to be wrong, not against a
    // captured majority: members who approved something bad will not cancel it.
    pub fn cancel(&mut self, proposal_id: U64) {
        let member = self.only_member();
        let mut p = self.proposal(proposal_id.0);
        require!(p.stage == Stage::Approved, "only an approved proposal can be cancelled");
        require!(!p.cancel_votes.contains(&member), "already voted to cancel");
        p.cancel_votes.push(member.clone());
        emit(
            "cancel_voted",
            json!({ "proposal_id": proposal_id.0.to_string(), "member": member }),
        );
        let votes = p.cancel_votes.iter().filter(|m| self.members.contains(m)).count();
        if votes >= self.threshold as usize {
            p.stage = Stage::Cancelled;
            emit("cancelled", json!({ "proposal_id": proposal_id.0.to_string() }));
        }
        self.proposals.insert(proposal_id.0, p);
    }

    // Anyone can call this once an approved proposal's timelock has passed and until its execution window ends. It
    // runs at most once: a call that fails stays failed, and the proposal must be made again from scratch.
    pub fn execute(&mut self, proposal_id: U64) -> PromiseOrValue<()> {
        let mut p = self.proposal(proposal_id.0);
        match p.stage {
            Stage::Approved => {}
            Stage::Cancelled => env::panic_str("this proposal was cancelled"),
            Stage::Open | Stage::Expired => env::panic_str("not approved"),
            Stage::Executing | Stage::Executed | Stage::ExecutionFailed => env::panic_str("already executed"),
        }
        let approved_at = p.approved_at.unwrap_or_else(|| env::panic_str("not approved"));
        let now = env::block_timestamp();
        require!(now >= approved_at.0 + self.timelock_ns, "the timelock has not passed");
        require!(
            now <= self.executable_until(approved_at.0),
            "the execution window has passed"
        );
        self.check(&p.action);
        if let Action::FunctionCall { gas, .. } = &p.action {
            let needed = Gas::from_gas(gas.0).saturating_add(GAS_EXECUTE_OVERHEAD);
            require!(
                env::prepaid_gas() >= needed,
                format!("attach at least {} TGas to execute this call", needed.as_tgas())
            );
        }
        let id = proposal_id.0.to_string();
        match p.action.clone() {
            Action::FunctionCall {
                receiver_id,
                method_name,
                args,
                deposit,
                gas,
            } => {
                // Marked before the call goes out, so a second execute is refused while this one is in flight.
                p.stage = Stage::Executing;
                self.proposals.insert(proposal_id.0, p);
                emit(
                    "call_sent",
                    json!({ "proposal_id": id, "receiver_id": receiver_id, "method_name": method_name }),
                );
                PromiseOrValue::Promise(
                    Promise::new(receiver_id)
                        .function_call(
                            method_name,
                            args.0,
                            NearToken::from_yoctonear(deposit.0),
                            Gas::from_gas(gas.0),
                        )
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(GAS_ON_EXECUTED)
                                .on_executed(proposal_id),
                        ),
                )
            }
            Action::UpgradeSelf { code_hash } => {
                require!(
                    env::prepaid_gas() >= GAS_EXECUTE_UPGRADE,
                    format!(
                        "attach at least {} TGas to execute an upgrade",
                        GAS_EXECUTE_UPGRADE.as_tgas()
                    )
                );
                let code = upgrade::take_staged(code_hash);
                p.stage = Stage::Executing;
                self.proposals.insert(proposal_id.0, p);
                emit("upgrade_sent", json!({ "proposal_id": id, "code_hash": code_hash }));
                // The deploy and migrate are one batch, so a migrate that panics puts the old code back and the callback,
                // which then runs in the old code, records ExecutionFailed. After a good deploy the callback runs in the new
                // code, which must still have on_executed and read the proposals as they are stored now.
                PromiseOrValue::Promise(
                    upgrade::deploy_and_migrate(code).then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_ON_EXECUTED)
                            .on_executed(proposal_id),
                    ),
                )
            }
            Action::Seal { public_key } => {
                p.stage = Stage::Executing;
                self.proposals.insert(proposal_id.0, p);
                emit("seal_sent", json!({ "proposal_id": id, "public_key": public_key }));
                PromiseOrValue::Promise(
                    upgrade::delete_key(public_key).then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_ON_EXECUTED)
                            .on_executed(proposal_id),
                    ),
                )
            }
            Action::AddMember { account } => {
                emit("member_added", json!({ "proposal_id": id, "account": account }));
                self.members.push(account);
                self.mark_executed(p)
            }
            Action::RemoveMember { account } => {
                emit("member_removed", json!({ "proposal_id": id, "account": account }));
                self.members.retain(|m| *m != account);
                self.mark_executed(p)
            }
            Action::SetThreshold { threshold } => {
                emit(
                    "threshold_changed",
                    json!({ "proposal_id": id, "threshold": threshold }),
                );
                self.threshold = threshold;
                self.mark_executed(p)
            }
            Action::SetVotingPeriod { voting_period_ns } => {
                emit(
                    "voting_period_changed",
                    json!({ "proposal_id": id, "voting_period_ns": voting_period_ns }),
                );
                self.voting_period_ns = voting_period_ns.0;
                self.mark_executed(p)
            }
            Action::SetTimelock { timelock_ns } => {
                emit(
                    "timelock_changed",
                    json!({ "proposal_id": id, "timelock_ns": timelock_ns }),
                );
                self.timelock_ns = timelock_ns.0;
                self.mark_executed(p)
            }
            Action::SetExecutionWindow { execution_window_ns } => {
                emit(
                    "execution_window_changed",
                    json!({ "proposal_id": id, "execution_window_ns": execution_window_ns }),
                );
                self.execution_window_ns = execution_window_ns.0;
                self.mark_executed(p)
            }
        }
    }

    // A failed call is recorded, not undone: the vote and the timelock already happened.
    #[private]
    pub fn on_executed(&mut self, proposal_id: U64) {
        let mut p = self.proposal(proposal_id.0);
        require!(p.stage == Stage::Executing, "no call in flight for this proposal");
        // The target's return value is not needed, only whether it succeeded, so none of it is read.
        let failed = matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        p.stage = if failed {
            Stage::ExecutionFailed
        } else {
            Stage::Executed
        };
        self.proposals.insert(proposal_id.0, p);
        emit(
            if failed { "execution_failed" } else { "executed" },
            json!({ "proposal_id": proposal_id.0.to_string() }),
        );
    }

    // ---- views ----------------------------------------------------------------------------

    pub fn get_proposal(&self, proposal_id: U64) -> Option<ProposalView> {
        self.proposals.get(&proposal_id.0).map(|p| self.view(p))
    }

    pub fn list_proposals(&self, from_index: U64, limit: U64) -> Vec<ProposalView> {
        let end = self.next_proposal_id.min(from_index.0.saturating_add(limit.0.min(50)));
        (from_index.0..end)
            .filter_map(|id| self.proposals.get(&id).map(|p| self.view(p)))
            .collect()
    }

    pub fn get_members(&self) -> Vec<AccountId> {
        self.members.clone()
    }

    // Whether a wasm with this sha256 is staged here, for the members to check before they vote to deploy it.
    pub fn is_staged(&self, code_hash: Base58CryptoHash) -> bool {
        upgrade::is_staged(code_hash)
    }

    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "state_version": self.state_version, "upgrade_proven": self.upgrade_proven,
                "threshold": self.threshold, "voting_period_ns": self.voting_period_ns.to_string(),
                "timelock_ns": self.timelock_ns.to_string(), "execution_window_ns": self.execution_window_ns.to_string(),
                "members": self.members.len(),
                "proposals": self.next_proposal_id.to_string() })
    }
}

// ---- private helpers ----------------------------------------------------------------------

impl GovernanceContract {
    fn only_member(&self) -> AccountId {
        let who = env::predecessor_account_id();
        require!(self.members.contains(&who), "members only");
        who
    }

    fn proposal(&self, id: u64) -> Proposal {
        self.proposals
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such proposal"))
    }

    // The last moment a proposal approved at `approved_at` can be executed.
    fn executable_until(&self, approved_at: u64) -> u64 {
        approved_at
            .saturating_add(self.timelock_ns)
            .saturating_add(self.execution_window_ns)
    }

    // Expired is never stored: a proposal left open past its vote, or approved and not executed in time, reads as Expired.
    fn view(&self, p: &Proposal) -> ProposalView {
        let execute_gas = match &p.action {
            Action::FunctionCall { gas, .. } => {
                Some(U64(Gas::from_gas(gas.0).saturating_add(GAS_EXECUTE_OVERHEAD).as_gas()))
            }
            Action::UpgradeSelf { .. } => Some(U64(GAS_EXECUTE_UPGRADE.as_gas())),
            _ => None,
        };
        let mut p = p.clone();
        let now = env::block_timestamp();
        let unexecuted_too_long =
            p.stage == Stage::Approved && p.approved_at.is_some_and(|t| now > self.executable_until(t.0));
        if (p.stage == Stage::Open && now >= p.voting_ends_at.0) || unexecuted_too_long {
            p.stage = Stage::Expired;
        }
        ProposalView {
            proposal: p,
            execute_gas,
        }
    }

    fn mark_executed(&mut self, mut p: Proposal) -> PromiseOrValue<()> {
        p.stage = Stage::Executed;
        self.proposals.insert(p.id.0, p);
        PromiseOrValue::Value(())
    }

    // Checked when proposed, and again when executed because the members or the threshold may have changed.
    fn check(&self, action: &Action) {
        let members = self.members.len();
        match action {
            Action::FunctionCall {
                receiver_id,
                method_name,
                args,
                gas,
                ..
            } => {
                // A call to this contract would be a second way to change it, around the checks below.
                require!(
                    *receiver_id != env::current_account_id(),
                    "governance changes itself only through its own actions"
                );
                require!(
                    method_name.len() <= MAX_METHOD_NAME && args.0.len() <= MAX_ARGS,
                    "the call is too long"
                );
                require!(
                    (MIN_CALL_GAS.as_gas()..=MAX_CALL_GAS.as_gas()).contains(&gas.0),
                    format!(
                        "the call's gas must be between {} and {} TGas",
                        MIN_CALL_GAS.as_tgas(),
                        MAX_CALL_GAS.as_tgas()
                    )
                );
            }
            Action::AddMember { account } => {
                require!(!self.members.contains(account), "already a member");
                require!(members < MAX_MEMBERS, "there can be at most 5 members");
            }
            Action::RemoveMember { account } => {
                require!(self.members.contains(account), "not a member");
                // Fewer members than the threshold could never approve anything again, this removal included.
                require!(
                    members > self.threshold as usize,
                    "removing a member would leave fewer members than the threshold"
                );
            }
            Action::SetThreshold { threshold } => {
                require!(
                    valid_threshold(*threshold, members),
                    "threshold must be between 1 and the number of members"
                );
            }
            Action::UpgradeSelf { code_hash } => {
                require!(
                    upgrade::is_staged(*code_hash),
                    "stage the code first, nothing is staged under that hash"
                );
            }
            Action::Seal { .. } => {
                require!(self.upgrade_proven, "prove the upgrade path before deleting keys");
            }
            Action::SetVotingPeriod {
                voting_period_ns: period,
            }
            | Action::SetTimelock { timelock_ns: period }
            | Action::SetExecutionWindow {
                execution_window_ns: period,
            } => {
                require!(period.0 > 0, "periods must be positive");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const SELF: &str = "gov.near";
    const VOTING: u64 = 1_000;
    const TIMELOCK: u64 = 500;
    const WINDOW: u64 = 2_000;
    const MEMBERS: [&str; 5] = ["m0.near", "m1.near", "m2.near", "m3.near", "m4.near"];

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn act_at(who: &str, t: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct(SELF))
            .predecessor_account_id(acct(who))
            .block_timestamp(t)
            .build());
    }

    fn gov(members: usize, threshold: u32) -> GovernanceContract {
        // The mock chain keeps its storage between cases; start each one empty.
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_at(MEMBERS[0], 0);
        GovernanceContract::new(
            MEMBERS[..members].iter().map(|m| acct(m)).collect(),
            threshold,
            U64(VOTING),
            U64(TIMELOCK),
            U64(WINDOW),
        )
    }

    fn propose(g: &mut GovernanceContract, t: u64, action: Action) -> U64 {
        act_at(MEMBERS[0], t);
        g.propose(action)
    }

    fn vote(g: &mut GovernanceContract, member: &str, t: u64, id: U64, approve: bool) {
        act_at(member, t);
        g.vote(id, approve);
    }

    // Proposed at t and approved at t by the first `threshold` members.
    fn approved(g: &mut GovernanceContract, t: u64, action: Action) -> U64 {
        let id = propose(g, t, action);
        for m in &MEMBERS[..g.threshold as usize] {
            vote(g, m, t, id, true);
        }
        assert_eq!(g.proposal(id.0).stage, Stage::Approved);
        id
    }

    fn execute(g: &mut GovernanceContract, t: u64, id: U64) {
        act_at("anyone.near", t);
        let _ = g.execute(id);
    }

    fn call() -> Action {
        Action::FunctionCall {
            receiver_id: acct("market.near"),
            method_name: "set_paused".into(),
            args: Base64VecU8(br#"{"paused":true}"#.to_vec()),
            deposit: U128(0),
            gas: U64(Gas::from_tgas(10).as_gas()),
        }
    }

    fn stage(g: &GovernanceContract, id: U64) -> Stage {
        g.get_proposal(id).unwrap().proposal.stage
    }

    #[test]
    fn reaching_the_threshold_locks_in_approval_whatever_votes_come_after() {
        let mut g = gov(5, 2);
        let id = propose(&mut g, 0, Action::SetTimelock { timelock_ns: U64(7) });
        vote(&mut g, MEMBERS[0], 10, id, true);
        assert_eq!(g.proposal(id.0).approved_at, None);
        vote(&mut g, MEMBERS[1], 20, id, true);
        assert_eq!(g.proposal(id.0).approved_at, Some(U64(20)));
        for (i, m) in MEMBERS[2..].iter().enumerate() {
            vote(&mut g, m, 30 + i as u64, id, false);
        }
        let p = g.proposal(id.0);
        assert_eq!(
            (p.stage, p.approved_at, p.votes.len()),
            (Stage::Approved, Some(U64(20)), 5),
            "three no votes change nothing"
        );
        act_at("anyone.near", VOTING + 1);
        assert_eq!(
            stage(&g, id),
            Stage::Approved,
            "the end of voting does not expire an approved proposal"
        );
        execute(&mut g, 20 + TIMELOCK, id);
        assert_eq!((stage(&g, id), g.timelock_ns), (Stage::Executed, 7));
    }

    #[test]
    #[should_panic(expected = "the timelock has not passed")]
    fn execute_is_refused_one_nanosecond_before_the_timelock_ends() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 100, Action::SetThreshold { threshold: 3 });
        execute(&mut g, 100 + TIMELOCK - 1, id);
    }

    #[test]
    fn execute_works_for_anyone_the_moment_the_timelock_ends() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 100, Action::SetThreshold { threshold: 3 });
        execute(&mut g, 100 + TIMELOCK, id);
        assert_eq!((stage(&g, id), g.threshold), (Stage::Executed, 3));
    }

    #[test]
    fn execute_still_works_in_the_last_nanosecond_of_the_window() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 100, Action::SetThreshold { threshold: 3 });
        act_at("anyone.near", 100 + TIMELOCK + WINDOW);
        assert_eq!(stage(&g, id), Stage::Approved);
        execute(&mut g, 100 + TIMELOCK + WINDOW, id);
        assert_eq!((stage(&g, id), g.threshold), (Stage::Executed, 3));
    }

    #[test]
    #[should_panic(expected = "the execution window has passed")]
    fn execute_is_refused_one_nanosecond_after_the_window() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 100, Action::SetThreshold { threshold: 3 });
        execute(&mut g, 100 + TIMELOCK + WINDOW + 1, id);
    }

    #[test]
    fn an_approved_proposal_nobody_executed_in_time_reads_as_expired_and_changes_nothing() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 100, Action::SetThreshold { threshold: 3 });
        act_at("anyone.near", 100 + TIMELOCK + WINDOW + 1);
        assert_eq!(stage(&g, id), Stage::Expired);
        assert_eq!(g.threshold, 2);
    }

    #[test]
    fn the_window_is_changed_by_a_vote_like_any_other_setting() {
        let mut g = gov(3, 2);
        let id = approved(
            &mut g,
            0,
            Action::SetExecutionWindow {
                execution_window_ns: U64(50),
            },
        );
        execute(&mut g, TIMELOCK, id);
        assert_eq!(g.config()["execution_window_ns"], "50");
        let late = approved(&mut g, 10_000, Action::SetThreshold { threshold: 3 });
        act_at("anyone.near", 10_000 + TIMELOCK + 51);
        assert_eq!(
            stage(&g, late),
            Stage::Expired,
            "the new, shorter window applies to proposals approved afterwards"
        );
    }

    #[test]
    #[should_panic(expected = "periods must be positive")]
    fn a_window_of_zero_is_refused() {
        let mut g = gov(3, 2);
        propose(
            &mut g,
            0,
            Action::SetExecutionWindow {
                execution_window_ns: U64(0),
            },
        );
    }

    fn cancel(g: &mut GovernanceContract, member: &str, t: u64, id: U64) {
        act_at(member, t);
        g.cancel(id);
    }

    #[test]
    #[should_panic(expected = "this proposal was cancelled")]
    fn as_many_members_as_the_threshold_cancel_an_approved_proposal_and_it_never_executes() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 100, Action::SetThreshold { threshold: 3 });
        cancel(&mut g, MEMBERS[0], 200, id);
        assert_eq!(stage(&g, id), Stage::Approved, "one member is short of the threshold");
        cancel(&mut g, MEMBERS[1], 201, id);
        assert_eq!(stage(&g, id), Stage::Cancelled);
        assert_eq!(g.threshold, 2, "nothing changed");
        execute(&mut g, 100 + TIMELOCK, id);
    }

    #[test]
    fn a_cancelled_proposal_leaves_others_alone() {
        let mut g = gov(3, 2);
        let doomed = approved(&mut g, 100, Action::SetThreshold { threshold: 3 });
        let fine = approved(&mut g, 100, Action::SetTimelock { timelock_ns: U64(7) });
        cancel(&mut g, MEMBERS[0], 200, doomed);
        cancel(&mut g, MEMBERS[1], 200, doomed);
        execute(&mut g, 100 + TIMELOCK, fine);
        assert_eq!((stage(&g, fine), g.timelock_ns, g.threshold), (Stage::Executed, 7, 2));
    }

    #[test]
    #[should_panic(expected = "only an approved proposal can be cancelled")]
    fn a_proposal_still_being_voted_on_cannot_be_cancelled() {
        let mut g = gov(3, 2);
        let id = propose(&mut g, 0, call());
        cancel(&mut g, MEMBERS[0], 1, id);
    }

    #[test]
    #[should_panic(expected = "only an approved proposal can be cancelled")]
    fn an_executed_proposal_cannot_be_cancelled() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 100, Action::SetThreshold { threshold: 3 });
        execute(&mut g, 100 + TIMELOCK, id);
        cancel(&mut g, MEMBERS[0], 100 + TIMELOCK + 1, id);
    }

    #[test]
    #[should_panic(expected = "members only")]
    fn a_non_member_cannot_cancel() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 100, call());
        cancel(&mut g, "stranger.near", 200, id);
    }

    #[test]
    #[should_panic(expected = "already voted to cancel")]
    fn a_member_cannot_cancel_twice_to_reach_the_threshold_alone() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 100, call());
        cancel(&mut g, MEMBERS[0], 200, id);
        cancel(&mut g, MEMBERS[0], 201, id);
    }

    #[test]
    fn a_removed_members_earlier_cancel_vote_no_longer_counts() {
        let mut g = gov(4, 2);
        let id = approved(&mut g, 100, call());
        cancel(&mut g, MEMBERS[3], 101, id);
        let remove = approved(
            &mut g,
            102,
            Action::RemoveMember {
                account: acct(MEMBERS[3]),
            },
        );
        execute(&mut g, 102 + TIMELOCK, remove);
        cancel(&mut g, MEMBERS[0], 103 + TIMELOCK, id);
        assert_eq!(
            stage(&g, id),
            Stage::Approved,
            "one current member voted to cancel, the threshold is two"
        );
        cancel(&mut g, MEMBERS[1], 104 + TIMELOCK, id);
        assert_eq!(stage(&g, id), Stage::Cancelled);
    }

    #[test]
    #[should_panic(expected = "this proposal was cancelled")]
    fn nobody_can_vote_on_a_cancelled_proposal() {
        let mut g = gov(5, 2);
        let id = approved(&mut g, 100, call());
        cancel(&mut g, MEMBERS[0], 200, id);
        cancel(&mut g, MEMBERS[1], 200, id);
        vote(&mut g, MEMBERS[2], 300, id, true);
    }

    #[test]
    #[should_panic(expected = "not approved")]
    fn a_proposal_short_of_the_threshold_expires_and_never_executes() {
        let mut g = gov(5, 3);
        let id = propose(&mut g, 0, Action::SetThreshold { threshold: 1 });
        vote(&mut g, MEMBERS[0], 1, id, true);
        vote(&mut g, MEMBERS[1], 2, id, true);
        vote(&mut g, MEMBERS[2], 3, id, false);
        act_at("anyone.near", VOTING - 1);
        assert_eq!(stage(&g, id), Stage::Open);
        act_at("anyone.near", VOTING);
        assert_eq!(stage(&g, id), Stage::Expired);
        execute(&mut g, u64::MAX / 2, id);
    }

    #[test]
    #[should_panic(expected = "voting has ended")]
    fn nobody_can_vote_an_expired_proposal_into_approval() {
        let mut g = gov(5, 3);
        let id = propose(&mut g, 0, Action::SetThreshold { threshold: 1 });
        vote(&mut g, MEMBERS[0], 1, id, true);
        vote(&mut g, MEMBERS[1], 2, id, true);
        vote(&mut g, MEMBERS[2], VOTING, id, true);
    }

    #[test]
    #[should_panic(expected = "members only")]
    fn a_non_member_cannot_propose() {
        let mut g = gov(3, 2);
        act_at("stranger.near", 0);
        g.propose(call());
    }

    #[test]
    #[should_panic(expected = "members only")]
    fn a_non_member_cannot_vote() {
        let mut g = gov(3, 2);
        let id = propose(&mut g, 0, call());
        vote(&mut g, "stranger.near", 1, id, true);
    }

    #[test]
    #[should_panic(expected = "already voted")]
    fn a_member_votes_once() {
        let mut g = gov(3, 2);
        let id = propose(&mut g, 0, call());
        vote(&mut g, MEMBERS[0], 1, id, false);
        vote(&mut g, MEMBERS[0], 2, id, true);
    }

    #[test]
    #[should_panic(expected = "there can be at most 5 members")]
    fn members_can_be_added_up_to_five_and_no_more() {
        let mut g = gov(2, 2);
        for (i, m) in MEMBERS[2..].iter().enumerate() {
            let t = i as u64 * 10_000;
            let id = approved(&mut g, t, Action::AddMember { account: acct(m) });
            execute(&mut g, t + TIMELOCK, id);
        }
        assert_eq!(g.get_members(), MEMBERS.iter().map(|m| acct(m)).collect::<Vec<_>>());
        propose(
            &mut g,
            100_000,
            Action::AddMember {
                account: acct("sixth.near"),
            },
        );
    }

    // Both passed while there was room for one more. The second is checked again when it executes.
    #[test]
    #[should_panic(expected = "there can be at most 5 members")]
    fn a_sixth_member_approved_while_there_was_room_is_refused_at_execution() {
        let mut g = gov(4, 2);
        let a = approved(
            &mut g,
            0,
            Action::AddMember {
                account: acct("fifth.near"),
            },
        );
        let b = approved(
            &mut g,
            0,
            Action::AddMember {
                account: acct("sixth.near"),
            },
        );
        execute(&mut g, TIMELOCK, a);
        execute(&mut g, TIMELOCK, b);
    }

    #[test]
    #[should_panic(expected = "removing a member would leave fewer members than the threshold")]
    fn a_removal_that_would_leave_fewer_members_than_the_threshold_is_refused() {
        let mut g = gov(3, 2);
        let remove = approved(
            &mut g,
            0,
            Action::RemoveMember {
                account: acct(MEMBERS[2]),
            },
        );
        let raise = approved(&mut g, 0, Action::SetThreshold { threshold: 3 });
        execute(&mut g, TIMELOCK, raise);
        // Two members with a threshold of three could never approve anything again.
        execute(&mut g, TIMELOCK, remove);
    }

    #[test]
    #[should_panic(expected = "not a member")]
    fn removing_someone_who_is_not_a_member_is_refused() {
        let mut g = gov(3, 2);
        propose(
            &mut g,
            0,
            Action::RemoveMember {
                account: acct("stranger.near"),
            },
        );
    }

    #[test]
    #[should_panic(expected = "threshold must be between 1 and the number of members")]
    fn a_threshold_of_zero_is_refused() {
        let mut g = gov(3, 2);
        propose(&mut g, 0, Action::SetThreshold { threshold: 0 });
    }

    #[test]
    #[should_panic(expected = "threshold must be between 1 and the number of members")]
    fn a_threshold_above_the_member_count_is_refused() {
        let mut g = gov(3, 2);
        propose(&mut g, 0, Action::SetThreshold { threshold: 4 });
    }

    #[test]
    fn a_removed_members_earlier_yes_vote_no_longer_counts() {
        let mut g = gov(4, 2);
        let id = propose(&mut g, 0, call());
        vote(&mut g, MEMBERS[3], 1, id, true);
        let remove = approved(
            &mut g,
            2,
            Action::RemoveMember {
                account: acct(MEMBERS[3]),
            },
        );
        execute(&mut g, 2 + TIMELOCK, remove);
        vote(&mut g, MEMBERS[0], 3 + TIMELOCK, id, true);
        assert_eq!(
            g.proposal(id.0).approved_at,
            None,
            "one current member voted yes, the threshold is two"
        );
        vote(&mut g, MEMBERS[1], 4 + TIMELOCK, id, true);
        assert_eq!(g.proposal(id.0).approved_at, Some(U64(4 + TIMELOCK)));
    }

    #[test]
    #[should_panic(expected = "already executed")]
    fn a_second_execute_is_refused_while_the_first_call_is_in_flight() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 0, call());
        execute(&mut g, TIMELOCK, id);
        assert_eq!(stage(&g, id), Stage::Executing);
        execute(&mut g, TIMELOCK, id);
    }

    #[test]
    #[should_panic(expected = "governance changes itself only through its own actions")]
    fn a_call_to_this_contract_is_refused() {
        let mut g = gov(3, 2);
        let Action::FunctionCall {
            method_name,
            args,
            deposit,
            gas,
            ..
        } = call()
        else {
            unreachable!()
        };
        propose(
            &mut g,
            0,
            Action::FunctionCall {
                receiver_id: acct(SELF),
                method_name,
                args,
                deposit,
                gas,
            },
        );
    }

    // ---- the gas a call carries ------------------------------------------------------------------------

    fn call_with_gas(gas: u64) -> Action {
        let Action::FunctionCall {
            receiver_id,
            method_name,
            args,
            deposit,
            ..
        } = call()
        else {
            unreachable!()
        };
        Action::FunctionCall {
            receiver_id,
            method_name,
            args,
            deposit,
            gas: U64(gas),
        }
    }

    fn tgas(n: u64) -> u64 {
        Gas::from_tgas(n).as_gas()
    }

    #[test]
    fn a_call_may_carry_from_five_to_two_hundred_fifty_tgas() {
        let mut g = gov(3, 2);
        for ok in [tgas(5), tgas(100), tgas(250)] {
            propose(&mut g, 0, call_with_gas(ok));
        }
    }

    #[test]
    fn a_call_outside_that_range_is_refused_at_propose() {
        for bad in [0, 1, tgas(5) - 1, tgas(250) + 1, u64::MAX] {
            let mut g = gov(3, 2);
            let caught =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| propose(&mut g, 0, call_with_gas(bad))));
            assert!(caught.is_err(), "{bad} gas must be refused");
        }
    }

    #[test]
    #[should_panic(expected = "the call's gas must be between 5 and 250 TGas")]
    fn the_refusal_names_the_range() {
        let mut g = gov(3, 2);
        propose(&mut g, 0, call_with_gas(0));
    }

    // A later version could narrow the range, so a proposal that passed when it was made is checked again.
    #[test]
    #[should_panic(expected = "the call's gas must be between 5 and 250 TGas")]
    fn the_range_is_checked_again_when_the_call_is_executed() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 0, call());
        let mut p = g.proposal(id.0);
        p.action = call_with_gas(tgas(251));
        g.proposals.insert(id.0, p);
        execute(&mut g, TIMELOCK, id);
    }

    #[test]
    fn the_view_shows_the_gas_an_execute_must_carry() {
        let mut g = gov(3, 2);
        let hash = stage_wasm(&mut g, WASM);
        let ids = [
            propose(&mut g, 0, call_with_gas(tgas(20))),
            propose(&mut g, 0, upgrade_action(hash)),
            propose(&mut g, 0, Action::SetThreshold { threshold: 3 }),
        ];
        act_at("anyone.near", 1);
        let shown =
            |id: U64| near_sdk::serde_json::to_value(g.get_proposal(id).unwrap()).unwrap()["execute_gas"].clone();
        assert_eq!(
            shown(ids[0]),
            near_sdk::serde_json::json!(tgas(34).to_string()),
            "the call's 20 TGas plus 14"
        );
        assert_eq!(
            shown(ids[1]),
            near_sdk::serde_json::json!(GAS_EXECUTE_UPGRADE.as_gas().to_string())
        );
        assert_eq!(shown(ids[2]), near_sdk::serde_json::Value::Null);
        let listed = near_sdk::serde_json::to_value(g.list_proposals(U64(0), U64(10))).unwrap();
        assert_eq!(listed[0]["execute_gas"], shown(ids[0]));
        assert_eq!(
            listed[0]["stage"], "open",
            "the stored record's own fields are still there"
        );
    }

    #[test]
    #[should_panic(expected = "attach at least 24 TGas to execute this call")]
    fn executing_a_call_with_less_than_its_gas_plus_the_overhead_is_refused_and_says_how_much() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 0, call());
        call_with_input(
            "anyone.near",
            TIMELOCK,
            &[],
            NearToken::from_yoctonear(0),
            Gas::from_tgas(23),
        );
        let _ = g.execute(id);
    }

    // The mocked chain meters gas by its own fee table, so the exact least that works is measured in the sandbox instead.
    #[test]
    fn executing_a_call_with_more_than_its_gas_plus_the_overhead_goes_out() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 0, call());
        call_with_input(
            "anyone.near",
            TIMELOCK,
            &[],
            NearToken::from_yoctonear(0),
            Gas::from_tgas(40),
        );
        let _ = g.execute(id);
        assert_eq!(stage(&g, id), Stage::Executing);
    }

    // ---- code: staging, UpgradeSelf, migrate and seal ----------------------------------------------------

    const WASM: &[u8] = &[0, 97, 115, 109, 1, 0, 0, 0, 9, 9, 9];

    fn call_with_input(who: &str, t: u64, input: &[u8], deposit: NearToken, gas: Gas) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(acct(SELF))
            .predecessor_account_id(acct(who))
            .block_timestamp(t)
            .attached_deposit(deposit)
            .prepaid_gas(gas);
        builder.context.input = input.to_vec().into();
        testing_env!(builder.build());
    }

    fn stage_wasm(g: &mut GovernanceContract, code: &[u8]) -> Base58CryptoHash {
        call_with_input("anyone.near", 0, code, NearToken::from_near(5), Gas::from_tgas(300));
        g.stage_code()
    }

    fn upgrade_action(hash: Base58CryptoHash) -> Action {
        Action::UpgradeSelf { code_hash: hash }
    }

    fn receipts() -> Vec<near_sdk::mock::Receipt> {
        near_sdk::test_utils::get_created_receipts()
    }

    fn promise_failed(failed: bool) {
        let result = if failed {
            near_sdk::PromiseResult::Failed
        } else {
            near_sdk::PromiseResult::Successful(vec![])
        };
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acct(SELF))
                .predecessor_account_id(acct(SELF))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn staging_with_too_little_deposit_is_refused() {
        let mut g = gov(3, 2);
        call_with_input(
            "anyone.near",
            0,
            WASM,
            NearToken::from_yoctonear(1),
            Gas::from_tgas(300),
        );
        g.stage_code();
    }

    #[test]
    fn anyone_can_stage_code_and_gets_its_hash_back() {
        let mut g = gov(3, 2);
        let hash = stage_wasm(&mut g, WASM);
        assert_eq!(hash, Base58CryptoHash::from(env::sha256_array(WASM)));
        assert!(upgrade::is_staged(hash));
    }

    #[test]
    #[should_panic(expected = "stage the code first")]
    fn an_upgrade_of_code_nobody_staged_cannot_be_proposed() {
        let mut g = gov(3, 2);
        propose(&mut g, 0, upgrade_action(Base58CryptoHash::from([1u8; 32])));
    }

    #[test]
    fn an_approved_upgrade_deploys_the_staged_code_and_migrates_in_one_batch_then_calls_back() {
        let mut g = gov(3, 2);
        let hash = stage_wasm(&mut g, WASM);
        let id = approved(&mut g, 0, upgrade_action(hash));
        assert!(g.is_staged(hash));
        execute(&mut g, TIMELOCK, id);
        assert_eq!(stage(&g, id), Stage::Executing, "the batch has not come back yet");
        assert!(!g.is_staged(hash), "the staged copy is gone");
        let receipts = receipts();
        let batch = &receipts[0];
        assert_eq!(batch.receiver_id.as_str(), SELF);
        assert!(matches!(&batch.actions[0], near_sdk::mock::MockAction::DeployContract { code, .. } if code == WASM));
        assert!(
            matches!(&batch.actions[1], near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } if method_name == b"migrate")
        );
        assert!(
            matches!(&receipts[1].actions[0], near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } if method_name == b"on_executed")
        );
    }

    #[test]
    #[should_panic(expected = "attach at least 110 TGas to execute an upgrade")]
    fn executing_an_upgrade_with_too_little_gas_is_refused_and_says_how_much() {
        let mut g = gov(3, 2);
        let hash = stage_wasm(&mut g, WASM);
        let id = approved(&mut g, 0, upgrade_action(hash));
        call_with_input(
            "anyone.near",
            TIMELOCK,
            &[],
            NearToken::from_yoctonear(0),
            Gas::from_tgas(109),
        );
        let _ = g.execute(id);
    }

    #[test]
    fn a_refused_execution_leaves_the_proposal_approved_and_the_code_staged() {
        let mut g = gov(3, 2);
        let hash = stage_wasm(&mut g, WASM);
        let id = approved(&mut g, 0, upgrade_action(hash));
        call_with_input(
            "anyone.near",
            TIMELOCK,
            &[],
            NearToken::from_yoctonear(0),
            Gas::from_tgas(109),
        );
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.execute(id)));
        assert!(refused.is_err());
        assert_eq!((stage(&g, id), upgrade::is_staged(hash)), (Stage::Approved, true));
    }

    #[test]
    fn a_failed_self_upgrade_is_recorded_as_execution_failed_and_a_good_one_as_executed() {
        let mut g = gov(3, 2);
        let (bad_hash, good_hash) = (stage_wasm(&mut g, WASM), stage_wasm(&mut g, &[1, 2, 3]));
        let bad = approved(&mut g, 0, upgrade_action(bad_hash));
        let good = approved(&mut g, 0, upgrade_action(good_hash));
        execute(&mut g, TIMELOCK, bad);
        promise_failed(true);
        g.on_executed(bad);
        execute(&mut g, TIMELOCK, good);
        promise_failed(false);
        g.on_executed(good);
        assert_eq!(
            (stage(&g, bad), stage(&g, good)),
            (Stage::ExecutionFailed, Stage::Executed)
        );
    }

    #[test]
    #[should_panic(expected = "prove the upgrade path before deleting keys")]
    fn a_seal_cannot_be_proposed_before_an_upgrade_has_gone_through() {
        let mut g = gov(3, 2);
        propose(
            &mut g,
            0,
            Action::Seal {
                public_key: KEY.parse().unwrap(),
            },
        );
    }

    const KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

    #[test]
    fn once_the_upgrade_is_proven_a_seal_deletes_the_key_through_a_vote() {
        let mut g = gov(3, 2);
        g.upgrade_proven = true;
        let id = approved(
            &mut g,
            0,
            Action::Seal {
                public_key: KEY.parse().unwrap(),
            },
        );
        execute(&mut g, TIMELOCK, id);
        assert_eq!(stage(&g, id), Stage::Executing);
        let receipts = receipts();
        assert_eq!(receipts[0].receiver_id.as_str(), SELF);
        assert!(
            matches!(&receipts[0].actions[0], near_sdk::mock::MockAction::DeleteKey { public_key, .. } if public_key.to_string() == KEY)
        );
    }

    #[test]
    fn migrate_keeps_the_state_and_marks_the_upgrade_proven() {
        let mut g = gov(3, 2);
        let id = approved(&mut g, 0, Action::SetTimelock { timelock_ns: U64(7) });
        execute(&mut g, TIMELOCK, id);
        assert!(!g.upgrade_proven);
        env::state_write(&g);
        drop(g);
        act_at(SELF, TIMELOCK + 1);
        let migrated = GovernanceContract::migrate();
        assert_eq!(
            (
                migrated.upgrade_proven,
                migrated.state_version,
                migrated.timelock_ns,
                migrated.members.len()
            ),
            (true, 1, 7, 3)
        );
        assert_eq!(stage(&migrated, id), Stage::Executed, "the proposals are still there");
        assert_eq!(migrated.config()["upgrade_proven"], true);
    }

    #[test]
    #[should_panic(expected = "migrate expects version 1")]
    fn migrate_refuses_state_written_by_another_version() {
        let mut g = gov(3, 2);
        g.state_version = 2;
        env::state_write(&g);
        drop(g);
        act_at(SELF, 1);
        GovernanceContract::migrate();
    }

    #[test]
    #[should_panic(expected = "members must be different accounts")]
    fn members_must_be_distinct() {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_at(MEMBERS[0], 0);
        GovernanceContract::new(
            vec![acct(MEMBERS[0]), acct(MEMBERS[0])],
            1,
            U64(VOTING),
            U64(TIMELOCK),
            U64(WINDOW),
        );
    }
}
