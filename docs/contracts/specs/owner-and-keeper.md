# Dragons Market: owner model, DAO proposals and keeper spec

**How the DAO owns the three contracts, which methods it may call and how a proposal must be built, which Sputnik proposal kinds must be guarded, and what the keeper must do.**

| Field | Value |
| --- | --- |
| Date | 2026-10-21 |
| Status | Draft. Section 2 is DECIDED by the owner. Sections 5, 7 and 9 are PROPOSED |
| Scope | Owner and operator methods of `market`, `oracle` and `council`, `contracts/keeper/treasury.mjs`, `contracts/keeper/keeper.mjs` |
| Source | Working tree on top of commit `6cad02e`, SputnikDAO source at revision `5434a59dec23ee0c49df8c8c4350c208a7e75b0b` (version 2.3.1), read 2026-10-21 |
| Index | [README.md](README.md) |

---

## Contents

1. [Summary](#1-summary)
2. [The owner model](#2-the-owner-model)
3. [Owner and operator methods](#3-owner-and-operator-methods)
4. [Building a DAO proposal](#4-building-a-dao-proposal)
5. [The allow-list that replaces the deny-list](#5-the-allow-list-that-replaces-the-deny-list)
6. [Sputnik proposal kinds that need a guard](#6-sputnik-proposal-kinds-that-need-a-guard)
7. [Recommended DAO policy](#7-recommended-dao-policy)
8. [Handover checklist](#8-handover-checklist)
9. [The keeper](#9-the-keeper)
10. [Review notes on the existing code](#10-review-notes-on-the-existing-code)
11. [Test evidence required](#11-test-evidence-required)

---

## 1. Summary

The three contracts treat their owner as a plain account. Nothing in them depends on a DAO, and a source guard fails the build if any contract names a governance contract. That part is done.

Two things are not done. First, `treasury.mjs` protects the DAO with a deny-list of five method names. A run against it in this task showed that it prepares proposals for `set_operator`, `set_fee_rate_bps`, `set_nft_contract`, `add_publisher` and `set_no_decision_recipient`, and its vote helper blocks only three of the 17 Sputnik proposal kinds (`ChangePolicy`, `UpgradeSelf`, `UpgradeRemote`), so it lets a member approve every membership change and every other policy change without a check. It also refuses `upgrade`, so no code upgrade can be prepared at all. Section 5 replaces it with an allow-list. Second, the keeper has no reconciliation, no verifier health check and no DAO watch (section 9).

SputnikDAO executes a proposal in the same call as the approval that reaches the threshold. The voting period is a deadline and a window for public visibility. It is not a delay between approval and execution. Section 2 says what that means and what to do about it.

---

## 2. The owner model

### 2.1 What the contracts assume (DECIDED)

The market, oracle and council each store an `owner: AccountId`. The owner is the Trezu or SputnikDAO account. Handover is two steps: the current owner calls `propose_owner(dao)` and the DAO then runs `accept_owner` as a function call proposal. Until the DAO accepts, the old owner keeps full power (Checked in source: `market/src/lib.rs:446-458`, `oracle/src/lib.rs:517-529`, `council/src/lib.rs:350-362`).

No contract may call, depend on or name a governance contract. The custom governance contract is retired. The guard tests are `guards.rs:151` (no governance crate in any manifest or the lock file) and `guards.rs:179` (no code string names governance). Tests exist and were not run in this task.

### 2.2 What SputnikDAO does at the pinned revision

All of this was read in `sputnikdao2/src/proposals.rs` and `policy.rs` at revision `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`. Line numbers are those of the fetched files.

| Fact | Where | Consequence |
| --- | --- | --- |
| `add_proposal` needs an attached deposit exactly equal to `policy.proposal_bond` | `proposals.rs:540-544` | The helper must read the bond from `get_policy`, not accept it from the caller |
| `act_proposal(id, action, proposal, memo)` takes the proposal kind as a required argument and refuses a kind that differs from the stored one (`ERR_WRONG_KIND`) | `proposals.rs:594-616` | A vote binds to the exact proposal content |
| A vote that makes the status `Approved` executes the proposal in the same call | `proposals.rs:638-643` | There is no delay after approval |
| A proposal expires when `submission_time + proposal_period < block_timestamp`. A vote after that stores `Expired` and executes nothing | `policy.rs:393-396` | The voting period is a deadline |
| An execution that fails marks the proposal `Failed`. `Finalize` re-evaluates it and re-executes it if it is still approved and not expired | `proposals.rs:473-498`, `:665-685` | A failed admin call can be retried by a member with `Finalize` permission |
| A threshold of `Ratio(n, d)` over `total` votes is `floor(n * total / d) + 1`, capped at `total`. A threshold of `Weight(w)` is `min(w, total)`. The needed count is the larger of the threshold and the quorum | `policy.rs:96-106`, `:415-418` | With 5 members `Ratio(1, 2)` needs 3, `Ratio(3, 5)` needs 4, `Ratio(1, 1)` needs 5 |
| Permissions are strings `<kind label>:<action>` with `*` wildcards. A role can have its own vote policy per kind label, otherwise the default applies | `policy.rs:335-359`, `:399-402` | The policy can tell kinds apart, but it cannot tell two methods of one `FunctionCall` apart. All function calls share the label `call` |
| The default policy gives the `all` role `*:AddProposal`, so any account can add a proposal if it pays the bond | `policy.rs:191` | Spam is limited only by the bond |

`ActionCall.gas` is a `near_gas::NearGas`. In the current `near-gas` source it serializes as a string and deserializes from a string or a number (`near-gas/src/trait_impls/serde.rs`). The version the DAO is built with was not checked, so a wrong format is UNVERIFIED until a harmless proposal is tried on the selected DAO.

### 2.3 What the voting period is, honestly

The product documents say sensitive changes need an enforced delay after approval. The instruction for this task records a different owner decision: the contracts' owner is the DAO and its only delay is the voting period. Given the facts above, that means:

1. A proposal is public from the moment it is submitted, because it is a stored record of the DAO that anyone can read with `get_proposal`.
2. The members can approve it at any time before the period ends. A majority that agrees can approve it in the next block. Nothing forces any wait.
3. After the period ends, the proposal can no longer be approved. A forgotten proposal therefore cannot be approved months later.
4. So the voting period gives visibility and a deadline. It gives users no time to leave after a decision, because there is no decision that can be seen before it executes.

Documents that still require a minimum 72-hour delay after approval, and permit a focused delay component: `docs/spec.md:175-178`, `docs/intents-architecture.md:91-93`, `docs/contracts/DEPLOY.md:55-56`, `docs/contracts/governance.md:27-29`, `README.md:44-45`, `PITCH.md:126-127`. The two positions cannot both stand. This section follows the task instruction. The owner decides (README OD-01), and the losing documents are rewritten. This task does not edit them.

### 2.4 What reduces the risk (PROPOSED)

A DAO majority that is captured can upgrade a contract and drain it in one transaction. These steps shrink the exposure without adding a timelock contract:

| Step | Effect |
| --- | --- |
| Exits never pause: the market's `withdraw` and `redeem` ignore `paused`, and the Council has no pause at all | A user can leave any time the code still allows it. A malicious upgrade could remove that, so this is only partial |
| Public staging: `stage_code` is open to anyone and `is_staged(hash)` is a view | Anyone can read the exact wasm before a vote. The keeper can flag a proposal whose hash was staged less than 24 hours before submission |
| Policy design (section 7): unanimity for membership, policy and upgrade kinds, four of five for every function call | A single compromised member cannot act alone |
| The DAO watcher in the keeper (section 9) | An alert when any proposal touches a contract, and a page when its kind or arguments are not on the allow-list |
| Launch caps: a limit on market size and total value locked, raised in steps (the owner sets initial exposure, DEPLOY.md:88) | Bounds the loss. The caps are an operating control today, not code (AUDIT note I-04) |
| OPEN: a minimal timelock account as the owner, between the DAO and the contracts | Would add a real delay. It would be a contract the owner account points at, so it is allowed by the "no governance contract" rule, but it is the kind of component the owner chose to retire. Recommended default: not built for testnet or the hackathon. Decide again before caps are lifted |

---

## 3. Owner and operator methods

Tier meaning: Tier 1 changes a bounded setting and another proposal can reverse it. Tier 2 changes who receives money, who may act, or who may earn. Tier 3 can change the code or the owner.

### 3.1 market

| Method | Caller | Args | Deposit | Gas | Tier | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `set_fee_rate_bps` | Owner | `fee_rate_bps: u32` | 0 | 30 TGas | 1 | Refused above 500 |
| `set_create_fee` | Owner | `create_fee: U128` | 0 | 30 TGas | 1 | Refused above 10,000,000 |
| NEW `set_min_sweep` | Owner | `min_sweep: U128` | 0 | 30 TGas | 1 | At most 100,000,000 |
| `set_paused` | Operator or owner | `paused: bool` | 0 | 30 TGas | 1 | Emergency stop for new trades. Exits stay open |
| `halt`, `resume` | Operator or owner | `market_id: U64`, `reason: String` | 0 | 30 TGas | 1 | The operator cannot halt in the last 24 hours before close |
| `create_market`, `retry_register`, `claim_residual` | Operator or owner | as in market.md | 0 | 100 TGas for `create_market` | 1 | Routine. The operator normally calls them |
| `set_operator` | Owner | `operator_id: AccountId` | 0 | 30 TGas | 2 | Changes who can seed, halt and pause |
| `set_fee_recipients` | Owner | `revenue_pool: AccountId`, `business_wallet: AccountId` (NEW name `treasury`) | 0 | 30 TGas | 2 | Redirects fees. `revenue_pool` must equal the Council. The treasury must be the verified Trezu account |
| `reconcile_revenue` | Owner | `amount: U128`, `arrived: bool` | 0 | 30 TGas | 2 | Needs evidence from the Council's `total_received` |
| NEW `reconcile_leg` | Owner | `sweep_id: U64`, `arrived: bool` | 0 | 30 TGas | 2 | Treasury leg fallback |
| `upgrade` | Owner | `code_hash: Base58CryptoHash` | 0 | at least 100 TGas, 250 maximum | 3 | The hash must be staged. A panicking `migrate` reverts |
| `seal` | Owner | `public_key: PublicKey` | 0 | 30 TGas | 3 | Refused until `upgrade_proven`. Deletes an access key |
| `propose_owner` | Owner | `new_owner: AccountId` | 0 | 30 TGas | 3 | |
| `accept_owner` | The proposed owner, which is the DAO after handover | none | 0 | 30 TGas | 3 | |

### 3.2 oracle

| Method | Caller | Args | Deposit | Gas | Tier | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `set_bond` | Owner | `bond: U128` | 0 | 30 TGas | 1 | Applies to new cases only |
| `set_window_ms`, `set_panel_deadline_ms`, `set_min_proposal_ms`, `set_draw_window_ms` | Owner | `U64` milliseconds | 0 | 30 TGas | 1 | Apply to markets registered afterwards. The Council cooldown must stay at least the window plus the panel deadline |
| `set_draw_delay_blocks` | Owner | `U64` | 0 | 30 TGas | 1 | |
| `set_jury_size` | Owner | `jury_size: u32` | 0 | 30 TGas | 1 | Odd, at most 21 |
| `remove_publisher` | Operator or owner | `key: PublicKey` | 0 | 30 TGas | 1 | Only removes power |
| `set_operator` | Owner | `operator_id: AccountId` | 0 | 30 TGas | 2 | |
| `set_no_decision_recipient` | Owner | `recipient: AccountId` | 0 | 30 TGas | 2 | Receives the jurors' half when nobody revealed. Should be the treasury |
| `add_publisher` | Owner | `key: PublicKey` | 0 | 30 TGas | 2 | Grants power over prices |
| `set_price_threshold` | Owner | `threshold: u32` | 0 | 30 TGas | 2 | |
| `upgrade`, `seal`, `propose_owner`, `accept_owner` | as the market | | 0 | as the market | 3 | |

### 3.3 council

| Method | Caller | Args | Deposit | Gas | Tier | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `set_cooldown_ns` | Owner | `cooldown_ns: U64` | 0 | 30 TGas | 1 | Must be at least the oracle's window plus panel deadline. Affects requests already made |
| `set_max_seats_per_account` | Owner | `u32` | 0 | 30 TGas | 1 | |
| NEW `set_close_grace_ns` | Owner | `close_grace_ns: U64` | 0 | 30 TGas | 1 | 1 to 30 days |
| `clear_token_range` | Owner | none | 0 | 30 TGas | 1 | |
| `allow_tokens` | Owner | `token_ids: Vec<String>` | 0 | 30 TGas | 2 | Decides who can earn and serve. At most 100 ids. The arguments of a Sputnik call stay small, so a long list needs several proposals |
| `set_token_range` | Owner | `first: U64`, `last: U64` | 0 | 30 TGas | 2 | |
| `set_allowlist_enabled` | Owner | `enabled: bool` | 0 | 30 TGas | 2 | Off lets any token of the collection stake |
| `set_nft_contract` | Owner | `nft_contract: AccountId` | 0 | 30 TGas | 2 | Only while nothing is staked |
| NEW `set_market` | Owner | `market: AccountId` | 0 | 30 TGas | 2 | Changes the only revenue sender |
| `upgrade`, `seal`, `propose_owner`, `accept_owner` | as the market | | 0 | as the market | 3 | |

### 3.4 Methods the DAO may need for its own money

| Method | Contract | Why | Better design |
| --- | --- | --- | --- |
| `withdraw(amount)` with 1 yocto | market | Collects the residual credited to the treasury's internal balance | market.md section 7.3 moves the residual onto the treasury leg, so no proposal is needed |
| `withdraw_bond()` with 1 yocto | oracle | Collects the no-decision share | oracle.md section 8.2 adds `payout_bond(account_id)` so a keeper pushes it |

The DAO's own Intents balance is moved by Trezu's treasury flows, which are outside the application allow-list.

---

## 4. Building a DAO proposal

Every administrative action is one `FunctionCall` proposal with exactly one action.

| Step | Who | Action |
| --- | --- | --- |
| 1 | Preparer | Read `get_policy` on the DAO. Record `proposal_bond`, `proposal_period` and the roles that may add and vote |
| 2 | Preparer | Look the method up in the allow-list (section 5). Refuse if absent. Validate `args` against its schema. Set `deposit` and `gas` from the entry |
| 3 | Preparer | For `upgrade`, confirm `is_staged(hash)` on the target and record the staging time from the `code_staged` event |
| 4 | Proposer | Call `add_proposal` on the DAO with the proposal below, an attached deposit equal to `proposal_bond`, and at most 300 TGas |
| 5 | Members | Read the stored proposal with `get_proposal(id)`. The reviewer, not the author, re-derives the allow-list check from the stored `kind` |
| 6 | Members | Each approver calls `act_proposal` with `action: "VoteApprove"`, the stored `kind` unchanged and enough gas for the action plus the DAO's own work. The last approval executes the action |
| 7 | Anyone | Read `get_proposal(id).status`. `Approved` means the call succeeded. `Failed` means it ran and failed. A member with `Finalize` permission can retry before the period ends |
| 8 | Anyone | Confirm the effect with the contract's own view, for example `config.owner` or `config.fee_rate_bps` |

```json
{
  "proposal": {
    "description": "market.set_fee_rate_bps 200 to 150. Reason and link.",
    "kind": {
      "FunctionCall": {
        "receiver_id": "<market account>",
        "actions": [
          { "method_name": "set_fee_rate_bps",
            "args": "<base64 of {\"fee_rate_bps\":150}>",
            "deposit": "0",
            "gas": "30000000000000" }
        ]
      }
    }
  }
}
```

Facts that matter for building it:

| Item | Detail |
| --- | --- |
| `deposit` in an action | Yocto string. `0` for every owner method. 1 yocto only for `withdraw` or `withdraw_bond` |
| `gas` in an action | At least 100 TGas for `upgrade` (the contract refuses less, `upgrade/src/lib.rs:20`, `:69-74`). 30 TGas covers a setter |
| Staging an upgrade | Anyone calls `stage_code` on the target with the wasm as the call input and pays about 1 NEAR per 100 KB. The market wasm was 307,235 bytes at the last audit, so about 3.1 NEAR (Reported in AUDIT.md, second review fixes) |
| Description | Name the contract, method, old and new value and a link to the reason. The description is public |

---

## 5. The allow-list that replaces the deny-list

### 5.1 Why the deny-list fails

`contracts/keeper/treasury.mjs:4` defines `SENSITIVE` as `upgrade`, `seal`, `propose_owner`, `accept_owner`, `set_fee_recipients`. Run in this task (probe in the session scratchpad, imports the real module):

| Input | Result |
| --- | --- |
| `market.set_operator`, `market.set_fee_rate_bps`, `market.stage_code`, `market.withdraw` | Prepared |
| `council.set_nft_contract`, `oracle.add_publisher`, `oracle.set_no_decision_recipient` | Prepared |
| `market.upgrade` | Refused, as the unfinished delay route |
| Vote approve on `AddMemberToRole`, `RemoveMemberFromRole`, `ChangeConfig`, `ChangePolicyUpdateDefaultVotePolicy`, `ChangePolicyAddOrUpdateRole`, `Transfer`, `FactoryInfoUpdate` | Allowed. By reading the code, `SetStakingContract`, `AddBounty`, `BountyDone`, `ChangePolicyRemoveRole`, `ChangePolicyUpdateParameters` and `Vote` are allowed too |
| Vote approve on a `FunctionCall` to `intents.near` with `mt_transfer` | Allowed |
| Vote approve on `UpgradeSelf`, `ChangePolicy` | Refused. `UpgradeRemote` is refused too, by reading the code |

A deny-list lets through everything its author did not think of, including every method added later. It also blocks the one upgrade the product needs.

### 5.2 The allow-list

PROPOSED. The helper refuses everything not listed. An entry names the target contract, the method, the tier, the exact deposit, the gas bounds and a schema for the arguments. There are no wildcards.

```js
export const ALLOWED = {
  market: {
    set_fee_rate_bps:   { tier: 1, deposit: "0", gas: [5, 30],   args: { fee_rate_bps: int(0, 500) } },
    set_create_fee:     { tier: 1, deposit: "0", gas: [5, 30],   args: { create_fee: units(0n, 10_000_000n) } },
    set_min_sweep:      { tier: 1, deposit: "0", gas: [5, 30],   args: { min_sweep: units(0n, 100_000_000n) } },
    set_paused:         { tier: 1, deposit: "0", gas: [5, 30],   args: { paused: bool() } },
    set_operator:       { tier: 2, deposit: "0", gas: [5, 30],   args: { operator_id: account() } },
    set_fee_recipients: { tier: 2, deposit: "0", gas: [5, 30],   args: { revenue_pool: equals("council"), treasury: equals("treasury") } },
    upgrade:            { tier: 3, deposit: "0", gas: [100, 250], args: { code_hash: hash32() }, needs: ["staged"] },
    seal:               { tier: 3, deposit: "0", gas: [5, 30],   args: { public_key: ed25519() }, needs: ["upgrade_proven"] },
    propose_owner:      { tier: 3, deposit: "0", gas: [5, 30],   args: { new_owner: account() } },
    accept_owner:       { tier: 3, deposit: "0", gas: [5, 30],   args: {} },
  },
  // oracle and council follow section 3 the same way
};
```

Rules the helper enforces when it prepares a proposal and when it prepares a vote:

1. The proposal kind must be `FunctionCall` with exactly one action. Any other kind is refused for approval (see section 6) unless the member records an out-of-band review for that kind.
2. `receiver_id` must be one of the three configured contract ids. It can never be the DAO itself or any other account.
3. The method must be a key of `ALLOWED[target]`.
4. `args` must contain exactly the schema's keys and each value must pass its check. An unknown key refuses the proposal.
5. `deposit` must equal the entry. Only `withdraw` and `withdraw_bond` entries, if added, may be `"1"`.
6. `gas` must be inside the entry's bounds.
7. `needs` conditions are checked against live views: `staged` means `is_staged(code_hash)` is true on the target, `upgrade_proven` means `config.upgrade_proven` is true.
8. `equals("treasury")` means the value must equal the treasury account id recorded in the helper's configuration, which the owner verifies out of band. The helper has no default treasury.
9. The proposal bond is read from `get_policy`, never taken from the caller.
10. The vote helper rebuilds every check from the stored proposal (`get_proposal`), not from the `kind` the caller supplies.

### 5.3 What this cannot do

A script cannot stop a member who approves through another wallet. The allow-list prevents preparing a harmful proposal with the project's tools and gives the keeper a definition of normal. The controls that actually bind are the DAO policy (section 7) and the review each member does. State this in the runbook.

### 5.4 Tests the helper needs

| Test | Expected |
| --- | --- |
| Every entry with valid arguments | A proposal is prepared |
| Every entry with a missing key, an extra key, a wrong type or a value past its bound | Refused |
| A method not in the list, for each contract | Refused |
| A receiver that is not one of the three contracts, or the DAO | Refused |
| Each of the 17 proposal kinds as a vote | Only `FunctionCall` that passes, and `Vote`, can be approved by the helper |
| `upgrade` for a hash that is not staged | Refused |
| `set_fee_recipients` with a treasury that differs from the configured one | Refused |
| A bond that differs from the DAO's `proposal_bond` | The helper uses the DAO's value |

---

## 6. Sputnik proposal kinds that need a guard

All 17 variants of `ProposalKind` at the pinned revision (`proposals.rs:67-121`). The policy label is the first half of the permission string. Execution lines are in `proposals.rs`.

| Variant | Policy label | Effect on execution | Risk | Rule |
| --- | --- | --- | --- | --- |
| `FunctionCall` | `call` | Calls the receiver with the listed actions, using the DAO as caller (`:379-393`) | Any contract call, including `upgrade` | Allow-list only. Four of five approvals (section 7) |
| `AddMemberToRole` | `add_member_to_role` | Adds an account to a group role (`:367-372`) | Changes who votes | Helper refuses. Unanimous in the policy |
| `RemoveMemberFromRole` | `remove_member_from_role` | Removes one (`:373-378`) | Changes who votes | Same |
| `ChangePolicy` | `policy` | Replaces the whole policy (`:363-366`) | Total control of the DAO | Same |
| `ChangePolicyAddOrUpdateRole` | `policy_add_or_update_role` | Adds or replaces a role with any permissions (`:436-441`) | Total control | Same |
| `ChangePolicyRemoveRole` | `policy_remove_role` | Removes a role (`:442-447`) | Locks members out or weakens a vote | Same |
| `ChangePolicyUpdateDefaultVotePolicy` | `policy_update_default_vote_policy` | Replaces the default threshold and quorum (`:448-453`) | A threshold of 1 hands the DAO to one member | Same |
| `ChangePolicyUpdateParameters` | `policy_update_parameters` | Changes the proposal bond, period and bounty settings (`:454-459`) | A very long period keeps stale proposals approvable | Same |
| `ChangeConfig` | `config` | Replaces the DAO's name, purpose and metadata (`:359-362`) | Low, but it can mislead members | Same |
| `UpgradeSelf` | `upgrade_self` | Upgrades the DAO code from the factory (`:394-397`) | Total control | Same |
| `UpgradeRemote` | `upgrade_remote` | Calls a method on another contract with code from the DAO's blob store (`:398-405`) | Replaces a contract's code | Helper refuses. Our contracts use `stage_code` and `upgrade`, not the blob store |
| `FactoryInfoUpdate` | `factory_info_update` | Changes the auto-update settings (`:432-435`) | Lets the factory replace DAO code | Same as `UpgradeSelf` |
| `Transfer` | `transfer` | Pays NEAR or a token to a receiver (`:406-417`) | Moves treasury funds | Not application administration. Trezu's finance role handles it. The helper refuses to approve it |
| `AddBounty` | `add_bounty` | Creates a bounty paid from the treasury (`:423-426`) | Moves treasury funds | No role should hold `add_bounty:*` |
| `BountyDone` | `bounty_done` | Pays a bounty (`:427-430`) | Moves treasury funds | No role should hold `bounty_done:*` |
| `SetStakingContract` | `set_vote_token` | Sets the staking contract once, enabling token-weighted votes (`:418-422`) | Changes the voting model | No role should hold `set_vote_token:*` |
| `Vote` | `vote` | Nothing (`:431`) | None | May be approved as a signal |

---

## 7. Recommended DAO policy

PROPOSED. The numbers follow the threshold rule in 2.2 for a role of five members. Verify against the deployed DAO's `get_policy`: Trezu may create its own roles and defaults. Whether Trezu's interface can create the custom function calls above is UNVERIFIED and must be checked before the handover (NEAR-RESEARCH section on Trezu).

| Setting | Value | Reason |
| --- | --- | --- |
| Approver role | One group role of 5 accounts held by different people, 3 at the least | One compromised account must not be enough |
| Default vote policy | `RoleWeight`, quorum 3, threshold `Ratio(1, 2)` | Needs 3 of 5 |
| Vote policy for `call` | `RoleWeight`, quorum 4, threshold `Ratio(3, 5)` | Needs 4 of 5, because every administrative action is a function call, including `upgrade` |
| Vote policy for `policy`, `policy_add_or_update_role`, `policy_remove_role`, `policy_update_default_vote_policy`, `policy_update_parameters`, `add_member_to_role`, `remove_member_from_role`, `config`, `upgrade_self`, `upgrade_remote`, `factory_info_update` | `RoleWeight`, quorum 5, threshold `Ratio(1, 1)` | Needs 5 of 5. These change who decides or what code runs the DAO |
| Permissions | No role holds `*:*`, `*:RemoveProposal` or `*:MoveToHub`. No role holds `add_bounty`, `bounty_done` or `set_vote_token`. `transfer` belongs to the finance role | Narrow the surface |
| `Finalize` | Held by the approver role | Retry a failed call, expire a stale proposal, recover the bond |
| `proposal_period` | 72 hours (259,200,000,000,000 ns) | The only deadline. Short enough that approvals are collected together, long enough for members in different time zones. Sputnik's default is 7 days |
| `proposal_bond` | 1 NEAR or more | Limits spam if any role can still add proposals |
| `Everyone` role | Remove `*:AddProposal` if the interface allows it | Only members propose |
| Recompute on membership change | Each time a member is added or removed, recompute every `Ratio` | `Ratio(3, 5)` needs 4 of 5 members and still only 4 of 6, so the share of members who must approve falls as the role grows |

---

## 8. Handover checklist

| Step | Check |
| --- | --- |
| 1 | The treasury account exists, is verified and its code hash is a published Sputnik build. Its `get_policy` matches section 7 |
| 2 | Deploy each contract with a deploy and init batch so `new` runs as the contract itself. Initialise with the deployer as owner and the keeper-held account as operator |
| 3 | Read each `config`: `verifier` is `intents.near`, `collateral_token_id` is the exact `nep141:` string, character by character |
| 4 | In the verifier, `public_keys_of(<account>)` is empty and `is_auth_by_predecessor_id_enabled(<account>)` is true for the market, oracle and council. Neither is locked, and the `mt_transfer` feature is not paused |
| 5 | The deployer calls `propose_owner(<dao>)` on each contract. The DAO runs `accept_owner` on each. Read `config.owner` and `config.pending_owner` |
| 6 | The DAO runs `set_fee_recipients(<council>, <treasury>)`. Send a small sweep and read both Intents balances |
| 7 | Prove the upgrade path on each contract: stage code, DAO `upgrade`, read `upgrade_proven` and `state_version` |
| 8 | The DAO runs `seal` for each remaining access key. `view_access_keys` for each contract is empty |
| 9 | Run `keeper check` with the new checks in section 9 and expect no problem |
| 10 | Record the code hashes, account ids, DAO policy hash and the date |

---

## 9. The keeper

### 9.1 What it does today

Checked in source: `contracts/keeper/keeper.mjs`. 18 keeper tests and 5 treasury tests passed in this task (`node --test keeper/keeper.test.mjs keeper/treasury.test.mjs`, 23 passed). Four sandbox tests run the script against the real contracts (`tests/tests/keeper.rs`, not run).

| Duty | Call or check | Gas | Source |
| --- | --- | --- | --- |
| Finalize an unchallenged case after its window, or a round that is over | `oracle.finalize` | 100 TGas | `keeper.mjs:75-81` |
| Draw a jury | `oracle.resolve_draw` | 300 TGas | `:77-78` |
| Resend a final answer to the market | `oracle.retry_apply` | 100 TGas | `:82` |
| Release the seats of a settled dispute | `oracle.retry_unlock` | 100 TGas | `:83` |
| Answer a market past `resolve_by` | `oracle.resolve_by_deadline` | 100 TGas | `:84-86` |
| Sweep fees once `collected + revenue_due + business_due` reaches 10 USDC | `market.sweep_fees` | 100 TGas | `:88-90` |
| Check that the Council can seat a jury and a second jury | `check` | none | `:287-299` |
| Check publisher count against the threshold | `check` | none | `:340` |
| Check NEAR left after storage for each contract and an optional treasury | `check` | none | `:313-328`, `:343-352` |

### 9.2 What it must do

PROPOSED. `run` sends calls and `check` only reads. Every check below is a `check` item. A problem makes `check` exit 1 and writes a status file the website reads to stop advertising deposits (INTENTS-PROOF.md:182-184 says the keeper should do this, and the code does not).

| Check | How | Level | Source of truth |
| --- | --- | --- | --- |
| Market reconciliation | `market.total_owed()` equals `verifier.mt_balance_of(M, T)`, both read with the same `block_id`, with `market.in_flight()` zero on two reads one block apart | Surplus is a warning. A deficit is a page | market.md section 7.5 |
| Oracle reconciliation | `oracle.total_owed()` against `mt_balance_of(O, T)` | Same | oracle.md section 8.3 |
| Council reconciliation | `council.reward_totals()`: `total_received - total_paid` against `mt_balance_of(C, T)`, with `pending_claims` zero | Same | council.md section 3 |
| Market to Council consistency | Sum of settled Council legs in `market.list_sweeps` equals `council.total_received` | Page on a difference | market.md section 7.2 |
| No key registered | `verifier.public_keys_of(a)` is an empty list for M, O and C | Page | INTENTS-PROOF.md claim e |
| Predecessor authentication on | `verifier.is_auth_by_predecessor_id_enabled(a)` is true for M, O and C | Page | INTENTS-PROOF.md claim e |
| Not locked | `verifier.is_account_locked(a)` is false. Read in source only, never run (INTENTS-PROOF.md:182-184) | Page, and stop advertising deposits | INTENTS-PROOF.md section 5 |
| Verifier feature not paused | The verifier's pause view for `mt_transfer`. The earlier deployment checklist named it `pa_is_paused` (`git show 6cad02e:contracts/DEPLOY.md`). Signature not verified | Page | INTENTS-PROOF.md section 5 |
| Access keys | `view_access_keys` for M, O and C is empty after `seal` | Page | DEPLOY.md:62 |
| Code hash | `view_code` hash of each contract equals the published list. `config.upgrade_in_flight` is false | Page on a difference | DEPLOY.md:25 |
| Ownership | `config.owner` equals the configured DAO, `pending_owner` is null, `operator` is the expected account | Page | contracts |
| Treasury and recipients | `market.config.treasury` equals the verified treasury. `oracle.config.no_decision_recipient` equals it | Page | README OD-09 |
| DAO policy | Hash of `get_policy` equals the audited baseline. Member count and thresholds match section 7 | Page on a change | Sputnik |
| DAO proposals | Poll `get_proposals` for `InProgress` and `Failed` proposals. Classify each with the allow-list (section 5). Alert on any proposal that names M, O or C. Page on any proposal whose kind or arguments are not allow-listed, and on an `upgrade` whose hash was staged less than 24 hours earlier | Alert or page | Sputnik |
| Revenue unresolved | `market.get_fees().revenue_unresolved` above zero for more than 10 minutes | Warn, then call `settle_leg` | market.md |
| Storage margins | Existing check for M, O, C and the keeper account | Warn | existing |
| Jury readiness | Existing check | Warn | existing |
| Publisher count | Existing check | Warn | existing |

| Call | When | Receiver and method | Key |
| --- | --- | --- | --- |
| Existing oracle calls | As in 9.1 | `oracle.*` | Oracle key |
| Sweep | Fees reach `min_sweep`, and once shortly before each quarter boundary (about one hour before `ends_at`) so fees earned in a quarter are received in it | `market.sweep_fees` | Market key |
| Settle a lost Council result | A Council leg is `unresolved` for more than 10 minutes | `market.settle_leg(sweep_id)` | Market key |
| Move seat time forward | `current_quarter` is behind now by more than a day, or just after a boundary | `council.advance_quarters` | Council key |
| Finalize a quarter | `now >= claimable_from` of `next_to_finalize` | `council.finalize_quarter(q)` | Council key |
| Push a bond payout | `claimable_of(account) > 0` for more than 7 days | `oracle.payout_bond(account)` | Oracle key |
| Price answers | A price market passes its observation time | `oracle` through a publisher service | Not built |

Every call above attaches no deposit, so a function call access key scoped to one receiver and the methods it uses is enough. Scoped methods: oracle `finalize,resolve_draw,retry_apply,retry_unlock,resolve_by_deadline,payout_bond`; market `sweep_fees,settle_leg`; council `advance_quarters,finalize_quarter,book_seat_time`.

Cadence (PROPOSED): `run` every minute, `check` every five minutes, the quarter boundary sweep scheduled from the quarter table. Keep the allowance of each key under 1 NEAR and alert at half.

### 9.3 Reconciliation procedure

1. Read the finalized block hash once.
2. Read `in_flight()` on the market and `pending_payouts` on the oracle and `pending_claims` on the Council at that block. If any is non-zero, wait two blocks and read again. After three tries, warn.
3. Read each contract's owed figure and the verifier's `mt_balance_of` at the same `block_id`.
4. `held > owed`: surplus nobody is credited for, for example a plain deposit. Warn and show the amount. It is never credited automatically.
5. `held < owed`: incident. Stop advertising deposits, page, and do not run `sweep_fees` until a person has looked.

---

## 10. Review notes on the existing code

| Item | Evidence | Note |
| --- | --- | --- |
| Stale sweep floor | `keeper.mjs:56` says `sweep_fees` refuses less than 95 TGas. The code floor is 87 (`market lib.rs:64-66`) and the sandbox test asserts 87 (`gas_floors.rs:296-306`) | The attached 100 TGas is still enough. Fix the comment |
| `check` does not look at the verifier | `keeper.mjs:330-357` | No reconciliation, key, lock or pause check. The verifier proof says the keeper should stop advertising funding while the market is locked (INTENTS-PROOF.md:182-184). It does not |
| One `final` read per view | `keeper.mjs:141-151` | Two views can come from different blocks. Reconciliation needs one `block_id` for all reads |
| Exit code | `keeper.mjs:259-278`, `:395-397` | A failed call is printed as `FAILED` and the process still exits 0, so a timer cannot alert on it. Exit non-zero if any call failed |
| Transaction send | `keeper.mjs:275` | Uses `broadcast_tx_commit`, which newer nearcore deprecates (noted in AUDIT.md) |
| Cost per run | `keeper.mjs:153-178` | One `get_case` per market after the cursor, plus up to two `jury_of` calls per settled dispute. `oracle.list_cases` (oracle.md section 8.4) replaces them with pages |
| Holder count | `keeper.mjs:334-338` | One `stake_of` call per staked token. At 1,000 seats this is 1,000 calls. A `holders` figure in `council.config` would cost nothing |
| No lock between runs | `keeper.mjs` main | Two overlapping runs both send. The contracts make every call idempotent, but each failed call burns allowance. A lock file or a single timer fixes it |
| Scoped key list in the header | `keeper.mjs:26-32` | Missing the methods in section 9.2 |
| `treasury.mjs` bond | `treasury.mjs:22`, `:59` | The caller supplies `proposalBond`. The DAO requires exact equality with its policy (`proposals.rs:540-544`), so the helper should read it |
| `treasury.mjs` gas default | `treasury.mjs:24` | 30 TGas is too little for `upgrade`, which needs 100 |
| `treasury.mjs` vote check | `treasury.mjs:66-89` | The check runs on the kind the caller passes. The DAO refuses a kind that differs from the stored one, so this is safe, but a reviewer should still re-derive the check from `get_proposal` |
| Sandbox owner fixture | `tests/tests/common/mod.rs:882-889` | `setup_admin_owned` is an ordinary account. The file says it does not simulate Sputnik |

---

## 11. Test evidence required

| Requirement | Evidence that exists | Evidence still required |
| --- | --- | --- |
| R-07 restricted methods refuse strangers | `attacks.rs:26` (every restricted method, with an owner fixture) | The same list with the NEW methods added: `set_min_sweep`, `reconcile_leg`, `set_close_grace_ns`, `set_market`, `settle_leg`, `payout_bond` |
| R-07 handover | `upgrade.rs:130` (upgrade through the owner fixture) | A sandbox with a real SputnikDAO build at the pinned revision: `propose_owner`, `accept_owner`, one call per allow-list entry, a `Failed` proposal retried with `Finalize`, an expired proposal, a vote with a wrong kind |
| R-07 policy | none | A test that builds the section 7 policy and checks the approval counts for 5 members, and again after adding a sixth |
| Allow-list | `treasury.test.mjs` (5 tests on the deny-list) | The tests in 5.4 |
| Keeper | `keeper.test.mjs` (18 pure function tests) and `keeper.rs` | Unit tests for the reconciliation decision, the verifier health decisions and the quarter calls. Sandbox tests: a key registered in the verifier, a locked account, a paused feature, a plain deposit surplus, a deficit |
