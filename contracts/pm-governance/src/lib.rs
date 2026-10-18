// Governance for the pitch test. Up to five members own pm-market, pm-oracle and pm-council in place of a
// single key. A member proposes an action, members vote, and an approved action waits out a timelock before
// anyone can execute it, so every change is public on-chain before it takes effect. Changes to the members
// and to these settings go through the same path as any other action.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
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

#[near(serializers=[borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Proposals,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    FunctionCall { receiver_id: AccountId, method_name: String, args: Base64VecU8, deposit: U128, gas: U64 },
    AddMember { account: AccountId },
    RemoveMember { account: AccountId },
    SetThreshold { threshold: u32 },
    SetVotingPeriod { voting_period_ns: U64 },
    SetTimelock { timelock_ns: U64 },
    SetExecutionWindow { execution_window_ns: U64 },
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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PmGovernance {
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
        json!({ "standard": "pm-governance", "version": "1.0.0", "event": event, "data": data })
    ));
}

fn valid_threshold(threshold: u32, members: usize) -> bool {
    threshold >= 1 && threshold as usize <= members
}

#[near]
impl PmGovernance {
    #[init]
    pub fn new(
        members: Vec<AccountId>,
        threshold: u32,
        voting_period_ns: U64,
        timelock_ns: U64,
        execution_window_ns: U64,
    ) -> Self {
        require!(!members.is_empty() && members.len() <= MAX_MEMBERS, "there must be 1 to 5 members");
        let mut distinct = members.clone();
        distinct.sort();
        distinct.dedup();
        require!(distinct.len() == members.len(), "members must be different accounts");
        require!(valid_threshold(threshold, members.len()), "threshold must be between 1 and the number of members");
        require!(
            voting_period_ns.0 > 0 && timelock_ns.0 > 0 && execution_window_ns.0 > 0,
            "periods must be positive"
        );
        Self {
            members,
            threshold,
            voting_period_ns: voting_period_ns.0,
            timelock_ns: timelock_ns.0,
            execution_window_ns: execution_window_ns.0,
            proposals: LookupMap::new(Key::Proposals),
            next_proposal_id: 0,
        }
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
        p.votes.push(Vote { member: member.clone(), approve });
        emit("voted", json!({ "proposal_id": proposal_id.0.to_string(), "member": member, "approve": approve }));
        let yes = p.votes.iter().filter(|v| v.approve && self.members.contains(&v.member)).count();
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
        emit("cancel_voted", json!({ "proposal_id": proposal_id.0.to_string(), "member": member }));
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
        require!(now <= self.executable_until(approved_at.0), "the execution window has passed");
        self.check(&p.action);
        let id = proposal_id.0.to_string();
        match p.action.clone() {
            Action::FunctionCall { receiver_id, method_name, args, deposit, gas } => {
                // Marked before the call goes out, so a second execute is refused while this one is in flight.
                p.stage = Stage::Executing;
                self.proposals.insert(proposal_id.0, p);
                emit("call_sent", json!({ "proposal_id": id, "receiver_id": receiver_id, "method_name": method_name }));
                PromiseOrValue::Promise(
                    Promise::new(receiver_id)
                        .function_call(method_name, args.0, NearToken::from_yoctonear(deposit.0), Gas::from_gas(gas.0))
                        .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_EXECUTED).on_executed(proposal_id)),
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
                emit("threshold_changed", json!({ "proposal_id": id, "threshold": threshold }));
                self.threshold = threshold;
                self.mark_executed(p)
            }
            Action::SetVotingPeriod { voting_period_ns } => {
                emit("voting_period_changed", json!({ "proposal_id": id, "voting_period_ns": voting_period_ns }));
                self.voting_period_ns = voting_period_ns.0;
                self.mark_executed(p)
            }
            Action::SetTimelock { timelock_ns } => {
                emit("timelock_changed", json!({ "proposal_id": id, "timelock_ns": timelock_ns }));
                self.timelock_ns = timelock_ns.0;
                self.mark_executed(p)
            }
            Action::SetExecutionWindow { execution_window_ns } => {
                emit("execution_window_changed", json!({ "proposal_id": id, "execution_window_ns": execution_window_ns }));
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
        p.stage = if failed { Stage::ExecutionFailed } else { Stage::Executed };
        self.proposals.insert(proposal_id.0, p);
        emit(if failed { "execution_failed" } else { "executed" }, json!({ "proposal_id": proposal_id.0.to_string() }));
    }

    // ---- views ----------------------------------------------------------------------------

    pub fn get_proposal(&self, proposal_id: U64) -> Option<Proposal> {
        self.proposals.get(&proposal_id.0).map(|p| self.view(p))
    }

    pub fn list_proposals(&self, from_index: U64, limit: U64) -> Vec<Proposal> {
        let end = self.next_proposal_id.min(from_index.0.saturating_add(limit.0.min(50)));
        (from_index.0..end).filter_map(|id| self.proposals.get(&id).map(|p| self.view(p))).collect()
    }

    pub fn get_members(&self) -> Vec<AccountId> {
        self.members.clone()
    }

    pub fn config(&self) -> near_sdk::serde_json::Value {
        json!({ "threshold": self.threshold, "voting_period_ns": self.voting_period_ns.to_string(),
                "timelock_ns": self.timelock_ns.to_string(), "execution_window_ns": self.execution_window_ns.to_string(),
                "members": self.members.len(),
                "proposals": self.next_proposal_id.to_string() })
    }
}

// ---- private helpers ----------------------------------------------------------------------

impl PmGovernance {
    fn only_member(&self) -> AccountId {
        let who = env::predecessor_account_id();
        require!(self.members.contains(&who), "members only");
        who
    }

    fn proposal(&self, id: u64) -> Proposal {
        self.proposals.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such proposal"))
    }

    // The last moment a proposal approved at `approved_at` can be executed.
    fn executable_until(&self, approved_at: u64) -> u64 {
        approved_at.saturating_add(self.timelock_ns).saturating_add(self.execution_window_ns)
    }

    // Expired is never stored: a proposal left open past its vote, or approved and not executed in time, reads as Expired.
    fn view(&self, p: &Proposal) -> Proposal {
        let mut p = p.clone();
        let now = env::block_timestamp();
        let unexecuted_too_long = p.stage == Stage::Approved && p.approved_at.is_some_and(|t| now > self.executable_until(t.0));
        if (p.stage == Stage::Open && now >= p.voting_ends_at.0) || unexecuted_too_long {
            p.stage = Stage::Expired;
        }
        p
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
            Action::FunctionCall { receiver_id, method_name, args, .. } => {
                // A call to this contract would be a second way to change it, around the checks below.
                require!(*receiver_id != env::current_account_id(), "governance changes itself only through its own actions");
                require!(method_name.len() <= MAX_METHOD_NAME && args.0.len() <= MAX_ARGS, "the call is too long");
            }
            Action::AddMember { account } => {
                require!(!self.members.contains(account), "already a member");
                require!(members < MAX_MEMBERS, "there can be at most 5 members");
            }
            Action::RemoveMember { account } => {
                require!(self.members.contains(account), "not a member");
                // Fewer members than the threshold could never approve anything again, this removal included.
                require!(members > self.threshold as usize, "removing a member would leave fewer members than the threshold");
            }
            Action::SetThreshold { threshold } => {
                require!(valid_threshold(*threshold, members), "threshold must be between 1 and the number of members");
            }
            Action::SetVotingPeriod { voting_period_ns: period }
            | Action::SetTimelock { timelock_ns: period }
            | Action::SetExecutionWindow { execution_window_ns: period } => {
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

    fn gov(members: usize, threshold: u32) -> PmGovernance {
        // The mock chain keeps its storage between cases; start each one empty.
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_at(MEMBERS[0], 0);
        PmGovernance::new(MEMBERS[..members].iter().map(|m| acct(m)).collect(), threshold, U64(VOTING), U64(TIMELOCK), U64(WINDOW))
    }

    fn propose(g: &mut PmGovernance, t: u64, action: Action) -> U64 {
        act_at(MEMBERS[0], t);
        g.propose(action)
    }

    fn vote(g: &mut PmGovernance, member: &str, t: u64, id: U64, approve: bool) {
        act_at(member, t);
        g.vote(id, approve);
    }

    // Proposed at t and approved at t by the first `threshold` members.
    fn approved(g: &mut PmGovernance, t: u64, action: Action) -> U64 {
        let id = propose(g, t, action);
        for m in &MEMBERS[..g.threshold as usize] {
            vote(g, m, t, id, true);
        }
        assert_eq!(g.proposal(id.0).stage, Stage::Approved);
        id
    }

    fn execute(g: &mut PmGovernance, t: u64, id: U64) {
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

    fn stage(g: &PmGovernance, id: U64) -> Stage {
        g.get_proposal(id).unwrap().stage
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
        assert_eq!((p.stage, p.approved_at, p.votes.len()), (Stage::Approved, Some(U64(20)), 5), "three no votes change nothing");
        act_at("anyone.near", VOTING + 1);
        assert_eq!(stage(&g, id), Stage::Approved, "the end of voting does not expire an approved proposal");
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
        let id = approved(&mut g, 0, Action::SetExecutionWindow { execution_window_ns: U64(50) });
        execute(&mut g, TIMELOCK, id);
        assert_eq!(g.config()["execution_window_ns"], "50");
        let late = approved(&mut g, 10_000, Action::SetThreshold { threshold: 3 });
        act_at("anyone.near", 10_000 + TIMELOCK + 51);
        assert_eq!(stage(&g, late), Stage::Expired, "the new, shorter window applies to proposals approved afterwards");
    }

    #[test]
    #[should_panic(expected = "periods must be positive")]
    fn a_window_of_zero_is_refused() {
        let mut g = gov(3, 2);
        propose(&mut g, 0, Action::SetExecutionWindow { execution_window_ns: U64(0) });
    }

    fn cancel(g: &mut PmGovernance, member: &str, t: u64, id: U64) {
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
        let remove = approved(&mut g, 102, Action::RemoveMember { account: acct(MEMBERS[3]) });
        execute(&mut g, 102 + TIMELOCK, remove);
        cancel(&mut g, MEMBERS[0], 103 + TIMELOCK, id);
        assert_eq!(stage(&g, id), Stage::Approved, "one current member voted to cancel, the threshold is two");
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
        propose(&mut g, 100_000, Action::AddMember { account: acct("sixth.near") });
    }

    // Both passed while there was room for one more. The second is checked again when it executes.
    #[test]
    #[should_panic(expected = "there can be at most 5 members")]
    fn a_sixth_member_approved_while_there_was_room_is_refused_at_execution() {
        let mut g = gov(4, 2);
        let a = approved(&mut g, 0, Action::AddMember { account: acct("fifth.near") });
        let b = approved(&mut g, 0, Action::AddMember { account: acct("sixth.near") });
        execute(&mut g, TIMELOCK, a);
        execute(&mut g, TIMELOCK, b);
    }

    #[test]
    #[should_panic(expected = "removing a member would leave fewer members than the threshold")]
    fn a_removal_that_would_leave_fewer_members_than_the_threshold_is_refused() {
        let mut g = gov(3, 2);
        let remove = approved(&mut g, 0, Action::RemoveMember { account: acct(MEMBERS[2]) });
        let raise = approved(&mut g, 0, Action::SetThreshold { threshold: 3 });
        execute(&mut g, TIMELOCK, raise);
        // Two members with a threshold of three could never approve anything again.
        execute(&mut g, TIMELOCK, remove);
    }

    #[test]
    #[should_panic(expected = "not a member")]
    fn removing_someone_who_is_not_a_member_is_refused() {
        let mut g = gov(3, 2);
        propose(&mut g, 0, Action::RemoveMember { account: acct("stranger.near") });
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
        let remove = approved(&mut g, 2, Action::RemoveMember { account: acct(MEMBERS[3]) });
        execute(&mut g, 2 + TIMELOCK, remove);
        vote(&mut g, MEMBERS[0], 3 + TIMELOCK, id, true);
        assert_eq!(g.proposal(id.0).approved_at, None, "one current member voted yes, the threshold is two");
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
        let Action::FunctionCall { method_name, args, deposit, gas, .. } = call() else { unreachable!() };
        propose(&mut g, 0, Action::FunctionCall { receiver_id: acct(SELF), method_name, args, deposit, gas });
    }

    #[test]
    #[should_panic(expected = "members must be different accounts")]
    fn members_must_be_distinct() {
        near_sdk::mock::with_mocked_blockchain(|b| {
            let _ = b.take_storage();
        });
        act_at(MEMBERS[0], 0);
        PmGovernance::new(vec![acct(MEMBERS[0]), acct(MEMBERS[0])], 1, U64(VOTING), U64(TIMELOCK), U64(WINDOW));
    }
}
