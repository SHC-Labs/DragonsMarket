# Dragons Market: owner model, DAO proposals and keeper spec

**How the DAO owns the three contracts, which methods it may call and how a proposal must be built, which Sputnik proposal kinds must be guarded, and what the keeper must do.**

| Field | Value |
| --- | --- |
| Date | 2026-10-21 |
| Status | Draft. Section 2 is DECIDED by the owner (voting period as the only delay, 2026-10-21). Section 5 is BUILT (2026-10-21). Section 9 is BUILT for the reconciliation, verifier and DAO checks and PROPOSED for the rest. Section 7 is PROPOSED |
| Scope | Owner and operator methods of `market`, `oracle` and `council`, `contracts/keeper/treasury.mjs`, `contracts/keeper/keeper.mjs` |
| Source | Working tree on top of commit `6cad02e`, SputnikDAO source at revision `5434a59dec23ee0c49df8c8c4350c208a7e75b0b` (version 2.3.1), read 2026-10-21 |
| Index | [README.md](README.md) |

**Build status, 2026-10-21.** The new owner methods are in the allow-list of `contracts/keeper/treasury.mjs` with their argument checks: market `set_revenue_share_bps`, `set_min_sweep`, `set_next_sweep_id` (it must not be below the market's `next_sweep_id`), `reconcile_leg` and `reconcile_withdrawal`; oracle `set_reconcile_wait_ns` and `reconcile_bond_payout`; Council `set_close_grace_ns`; oracle and Council `allow_market` and `disallow_market` (the Council's `set_market` is gone). `reconcile_revenue` is removed (see market.md). `set_fee_recipients` now takes `revenue_pool` and `treasury`. The Council reconciliation of section 9.2 uses `reward_totals`: the floor is total received less total paid less the claims in flight. `settle_leg` and `payout_bond` are still not prepared (anyone calls them). The keeper sends `advance_quarters`, `finalize_quarter` and `settle_leg` (section 9.1), and holds back `sweep_fees` for an hour after the last sweep. Tests: `treasury.test.mjs` (`the next sweep id can only move up from where the market is`, `the grace period bounds are the ones in the Council's source`, the sample table, the limits) and `keeper.test.mjs` (`the Council's floor is what it took in less what it paid and less the claims on their way`).


### Current operations, 2026-10-23

The keeper now uses `due-queue.mjs`, not the oldest-unfinished cursor. Signing runs require `--state-file`; `--events-file` supplies normalized finalized blocks as documented in [the indexer design](../indexer.md). A run consumes at most 32 blocks or 1 MiB, bootstraps one 50-ID market window and one 50-ID sweep window, then processes at most `--job-batch` jobs (default 50, maximum 500). `--workers` defaults to 2 and accepts 1 to 8. Requests time out after 30 seconds. Keep one queue per RPC and contract tuple; one process holds its lock.

The event cursor and jobs are saved together through an fsynced atomic rename before dispatch. Replay does not double-enqueue; a block hash gap stops ingestion. Each action rechecks contract state; retries use exponential backoff from one second to 15 minutes, persist failures and serialize calls sharing a signing key. A crash can repeat dispatch: contract idempotence and fresh reads protect it, not an exactly-once promise. Restore or reconcile a corrupt/truncated feed before restarting; do not delete payout evidence. With no event feed, bounded bootstrap and rotating reconciliation still run, but discovery latency grows with catalog size. That fallback is not adequate for live deadline guarantees. The local queue is one JSON file rewritten per batch, not per action; measure file I/O and job-selection time at the intended active catalog size. Database-backed scheduling belongs to the separately owned indexer service.

`market.set_storage_policy` and `market.set_registration_fee` are allowlisted with the same hard bounds as the contract. Creation proposals read the current native storage deposit. Fee-sweep timing may not fall below one hour. `prepareStorageTopUp({treasuryId, contracts, target, amount, description, view})` prepares a native Treasury transfer proposal to the configured oracle or Council only; members still review and vote. Generic transfer approvals still require explicit acknowledgment. No funds are automatically sent.

`check --runway-config budget.json` uses explicit planning budgets and current balances. Without that flag, it prints that the runway model is not configured. Example configuration:

```json
{
  "marketsPerDay": 100,
  "alarmDays": 30,
  "oracle": { "bytesPerMarket": 1000, "fixedBytesPerDay": 10000, "reserve": "1000000000000000000000000" },
  "council": { "bytesPerMarket": 2000, "fixedBytesPerDay": 20000, "reserve": "1000000000000000000000000" }
}
```

These are illustrative budgets, not measured production consumption. Set them from observed creation rate, dispute mix, claims, sweeps and quarter growth before operating. Available NEAR is balance minus locked storage minus reserve. Daily cost is `(marketsPerDay * bytesPerMarket + fixedBytesPerDay) * 10^19` yoctoNEAR. A margin below `alarmDays` of that budget exits with a problem. Zero budgeted growth reports no finite estimate; an exhausted reserve always alarms. Round down reported days. Top up for gas separately.

The queue needs successful market creation/registration/outcome events; oracle proposal/challenge/escalation/draw/final/apply events; market sweep and leg-result events; and Council draw/release/revenue events. They are present in the current contract sources. Unit tests cover replay, gaps, partial lines, receipt scope, backoff, locks and same-key nonce serialization. The sandbox exercises real contract actions without an indexer.

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

The two gaps the first reading found are closed in code on 2026-10-21. `treasury.mjs` is an allow-list builder that prepares every owner method of the three contracts, including `upgrade`, `seal`, `propose_owner`, `accept_owner` and `set_fee_recipients`, and its vote helper judges all 17 Sputnik proposal kinds (section 5). `keeper.mjs check` reconciles the market, the oracle and the Council against the verifier, reads what the verifier says about each of them and can list the DAO's open proposals that name them (section 9). What remains: nothing ran against a real SputnikDAO, the DAO policy of section 7 is not checked by the keeper, and the status file of section 9.2 is not built. Section 5.1 keeps the finding about the old deny-list, which prepared proposals for `set_operator`, `set_fee_rate_bps`, `set_nft_contract`, `add_publisher` and `set_no_decision_recipient`, blocked only three of the 17 kinds on the vote side, and refused `upgrade`, `seal` and the owner handover for a delay route that will not be built.

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

DECIDED (owner, 2026-10-21): the contracts' owner is the DAO, sensitive administration uses member approvals, and the DAO voting period is the only delay. No enforced delay after approval and no timelock contract will be built. Given the facts above, that means:

1. A proposal is public from the moment it is submitted, because it is a stored record of the DAO that anyone can read with `get_proposal`.
2. The members can approve it at any time before the period ends. A majority that agrees can approve it in the next block. Nothing forces any wait.
3. After the period ends, the proposal can no longer be approved. A forgotten proposal therefore cannot be approved months later.
4. So the voting period gives visibility and a deadline. It gives users no time to leave after a decision, because there is no decision that can be seen before it executes.

The product documents that required a minimum 72-hour delay after approval (finding F-02 in the [README](README.md#7-findings-from-comparing-docs-code-and-website)) were rewritten to this decision on 2026-10-21. OD-01 is closed.

### 2.4 What reduces the risk (PROPOSED)

A DAO majority that is captured can upgrade a contract and drain it in one transaction. With no delay after approval, these steps are what shrink the exposure. The first three are in the code today (Checked in source: `market/src/lib.rs:414-443`, unit test `withdraw_and_redeem_still_work_while_the_market_is_paused`). The rest are PROPOSED:

| Step | Effect |
| --- | --- |
| Exits stay open under the operator: the market's `withdraw` and `redeem` ignore both pause flags, `sell` stops only when the owner sets `sells_paused`, and the Council has no pause at all | A user can leave any time the code still allows it. A malicious upgrade could remove that, so this is only partial |
| Public staging: `stage_code` is open to anyone and `is_staged(hash)` is a view. `upgrade` deploys only staged code and sets `upgrade_in_flight`, and `migrate` refuses to run without it | Anyone can read the exact wasm before a vote. A hand-called `migrate` proves nothing. The keeper can flag a proposal whose hash was staged less than 24 hours before submission |
| Keys sealed only after a proven upgrade: `seal` is refused until `upgrade_proven` | A deploy key cannot be removed before one upgrade has worked through the DAO, so a broken upgrade path is found while the key can still fix it |
| Policy design (section 7): unanimity for membership, policy and upgrade kinds, four of five for every function call | A single compromised member cannot act alone |
| The DAO watcher in the keeper (section 9) | An alert when any proposal touches a contract, and a page when its kind or arguments are not on the allow-list |
| Launch caps: a limit on market size and total value locked, raised in steps (the owner sets initial exposure, DEPLOY.md:88) | Bounds the loss. The caps are an operating control today, not code (AUDIT note I-04) |
| DECIDED 2026-10-21: no timelock account between the DAO and the contracts | Not built. The owner chose the voting period as the only delay. Users who distrust a pending proposal can still withdraw a balance and redeem a resolved position while it is public, but nothing holds a decision back after the last approval |

---

## 3. Owner and operator methods

Tier meaning: Tier 1 changes a bounded setting and another proposal can reverse it. Tier 2 changes who receives money, who may act, or who may earn. Tier 3 can change the code or the owner.

### 3.1 market

| Method | Caller | Args | Deposit | Gas | Tier | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `set_fee_rate_bps` | Owner | `fee_rate_bps: u32` | 0 | 30 TGas | 1 | Refused above 500 |
| `set_create_fee` | Owner | `create_fee: U128` | 0 | 30 TGas | 1 | Refused above 10,000,000 |
| NEW `set_min_sweep` | Owner | `min_sweep: U128` | 0 | 30 TGas | 1 | At most 100,000,000 |
| `set_paused` | Operator or owner | `paused: bool` | 0 | 30 TGas | 1 | Emergency stop for buys, deposits and seeds. Sells and exits stay open |
| `set_sells_paused` | Owner | `sells_paused: bool` | 0 | 30 TGas | 1 | Stops `sell`. Withdraw and redeem stay open |
| `set_void_rules` | Owner | `price_window_ns: U64`, `grace_ns: U64` | 0 | 30 TGas | 1 | Void price window 1 hour to 7 days, void grace 1 to 60 days. Applies to markets created afterwards |
| `set_sweep_timing` | Owner | `settle_wait_minutes`, `reconcile_wait_minutes`, `min_interval_minutes` (u32) | 0 | 30 TGas | 1 | Settle wait 1 to 1440, reconcile wait 10 to 10080 and not below the settle wait, sweep interval 1 to 1440. Live |
| `set_open_price_bounds` | Owner | `min: U128`, `max: U128` | 0 | 30 TGas | 1 | Opening price range within 1000 to 999000 millionths, min below max. Live |
| `set_max_positions` | Owner | `max_positions: u32` | 0 | 30 TGas | 1 | 5 to 30, the most the 0.05 NEAR deposit pays for with a 64-character id. Positions already held stay |
| `set_registration_fee` | Owner | `registration_fee: U128` | 0 | 30 TGas | 1 | 10,000 to 2,000,000 collateral units (0.01 to 2 of a 6-decimal token). What a `register` transfer pays to register an account with no NEAR, due to the treasury |
| `set_fee_limits` | Owner | `max_fee_rate_bps`, `max_create_fee`, `min_revenue_share_bps`, `max_revenue_share_bps`, `max_min_sweep` | 0 | 30 TGas | 1 | The ceilings and floors the fee setters check against, each inside a hard range. Refused if it would leave a current value outside |
| `halt`, `resume` | Operator or owner | `market_id: U64`, `reason: String` | 0 | 30 TGas | 1 | The operator cannot halt in the last 24 hours before close |
| `create_market`, `retry_register`, `claim_residual` | Operator or owner | as in market.md | 0 | 100 TGas for `create_market` | 1 | Routine. The operator normally calls them |
| `set_operator` | Owner | `operator_id: AccountId` | 0 | 30 TGas | 2 | Changes who can seed, halt and pause |
| `set_fee_recipients` | Owner | `revenue_pool: AccountId`, `business_wallet: AccountId` (NEW name `treasury`) | 0 | 30 TGas | 2 | Redirects fees. `revenue_pool` must equal the Council. The treasury must be the verified Trezu account |
| `reconcile_revenue` | Owner | `amount: U128`, `arrived: bool` | 0 | 30 TGas | 2 | Needs evidence from the Council's `total_received` |
| NEW `reconcile_leg` | Owner | `sweep_id: U64`, `arrived: bool` | 0 | 30 TGas | 2 | Treasury leg fallback |
| NEW `reconcile_withdrawal` | Owner | `id: U64`, `paid: bool` | 0 | 30 TGas | 2 | Decides a withdrawal whose callback never arrived, after the market's reconcile wait. The owner checks the verifier's events first |
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
| `set_juror_shares` | Owner | `decided_bps: u32`, `no_decision_bps: u32` | 0 | 30 TGas | 1 | 500 to 5000 and 1000 to 10000. Applies to cases proposed afterwards |
| `set_apply_buffer_ms` | Owner | `apply_buffer_ms: U64` | 0 | 30 TGas | 1 | 5 seconds to 5 minutes. Applies to markets registered afterwards |
| `set_max_publishers` | Owner | `max_publishers: u32` | 0 | 30 TGas | 1 | 1 to 25, not below the price threshold. Removes no one |
| `remove_publisher` | Operator or owner | `key: PublicKey` | 0 | 30 TGas | 1 | Only removes power |
| `set_operator` | Owner | `operator_id: AccountId` | 0 | 30 TGas | 2 | |
| `allow_market`, `disallow_market` | Owner | `market: AccountId` | 0 | 30 TGas | 2 | Edit the list of market accounts that may register markets and take proposals and challenges. `new` makes its market the first entry. A market taken off the list keeps its open cases |
| `set_no_decision_recipient` | Owner | `recipient: AccountId` | 0 | 30 TGas | 2 | Receives the jurors' half when nobody revealed. Should be the treasury |
| `add_publisher` | Owner | `key: PublicKey` | 0 | 30 TGas | 2 | Grants power over prices |
| `set_price_threshold` | Owner | `threshold: u32` | 0 | 30 TGas | 2 | |
| NEW `set_reconcile_wait_ns` | Owner | `reconcile_wait_ns: U64` | 0 | 30 TGas | 2 | 10 minutes to 7 days, 1 hour to start. Live |
| NEW `reconcile_bond_payout` | Owner | `id: U64`, `paid: bool` | 0 | 30 TGas | 2 | Decides a payout whose callback never arrived, after the reconcile wait. The owner checks the verifier's events first |
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
| `reconcile_claim` | Owner | `quarter: u32`, `token_id`, `owner`, `paid: bool` | 0 | 30 TGas | 2 | Decides a claim whose payout callback never arrived, an hour after the claim. The owner checks the verifier's events first |
| `set_reconcile_wait_ns` | Owner | `reconcile_wait_ns: U64` | 0 | 30 TGas | 2 | 10 minutes to 7 days. Live |
| `set_nft_contract` | Owner | `nft_contract: AccountId` | 0 | 30 TGas | 2 | Only while nothing is staked |
| `allow_market`, `disallow_market` | Owner | `market: AccountId` | 0 | 30 TGas | 2 | Edit the list of market accounts that may send revenue. The last entry cannot be removed, so add the new market first. A new Council has an empty list until `allow_market` is called |
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

Status: BUILT on 2026-10-21 in `contracts/keeper/treasury.mjs` (with `chain.mjs` for the reads). Evidence: 25 tests in `contracts/keeper/treasury.test.mjs`, named in 5.4, and 109 mutations of the node code and the contract sources, all caught (AUDIT.md, "Keeper and treasury helper rewrite, 2026-10-21"). Nothing was run against a real SputnikDAO.

### 5.1 Why the deny-list failed

This is what `treasury.mjs` did before the rewrite. It defined `SENSITIVE` as `upgrade`, `seal`, `propose_owner`, `accept_owner`, `set_fee_recipients`. A probe run in the first reading, importing the real module:

| Input | Result |
| --- | --- |
| `market.set_operator`, `market.set_fee_rate_bps`, `market.stage_code`, `market.withdraw` | Prepared |
| `council.set_nft_contract`, `oracle.add_publisher`, `oracle.set_no_decision_recipient` | Prepared |
| `market.upgrade` | Refused. The error waited for an execution-delay route that will not be built (owner decision, 2026-10-21) |
| Vote approve on `AddMemberToRole`, `RemoveMemberFromRole`, `ChangeConfig`, `ChangePolicyUpdateDefaultVotePolicy`, `ChangePolicyAddOrUpdateRole`, `Transfer`, `FactoryInfoUpdate` | Allowed. By reading the code, `SetStakingContract`, `AddBounty`, `BountyDone`, `ChangePolicyRemoveRole`, `ChangePolicyUpdateParameters` and `Vote` were allowed too |
| Vote approve on a `FunctionCall` to `intents.near` with `mt_transfer` | Allowed |
| Vote approve on `UpgradeSelf`, `ChangePolicy` | Refused. `UpgradeRemote` was refused too, by reading the code |

A deny-list lets through everything its author did not think of, including every method added later. It also blocked the upgrade, the key seal and the owner handover that the product needs, and those blocks served only a delay route the owner decided not to build.

### 5.2 The allow-list

The helper refuses everything not listed. `ALLOWED` in `treasury.mjs` holds one entry per method: the target contract, the exact deposit, the gas the call takes (least, what a prepared proposal attaches, most), a check for every argument, and the on-chain condition that must hold. There are no wildcards. The table was written from the current contract source, and the owner-method scan in `treasury.test.mjs` fails if a contract gains an owner method that is neither in the table nor excluded with a reason.

| Contract | Method | Arguments and limits | Deposit | Gas in TGas |
| --- | --- | --- | --- | --- |
| all three | `upgrade` | `code_hash`: base58 of 32 bytes. The code must be staged on that contract | 0 | 100 to 250, 150 attached |
| all three | `seal` | `public_key`: an ed25519 or secp256k1 key. The contract must have `upgrade_proven` | 0 | 5 to 30, 30 attached |
| all three | `propose_owner` | `new_owner`: account id | 0 | 5 to 30 |
| all three | `accept_owner` | none. The DAO must be the proposed owner | 0 | 5 to 30 |
| market, oracle | `set_operator` | `operator_id`: account id | 0 | 5 to 30 |
| market | `set_fee_recipients` | `revenue_pool` must be the Council, `business_wallet` must be the treasury | 0 | 5 to 30 |
| market | `set_fee_rate_bps` | `fee_rate_bps`: integer 0 to 500 | 0 | 5 to 30 |
| market | `set_create_fee` | `create_fee`: U128 0 to 10,000,000 | 0 | 5 to 30 |
| market | `reconcile_revenue` | `amount`: U128 above 0, `arrived`: boolean | 0 | 5 to 30 |
| market | `set_paused` | `paused`: boolean | 0 | 5 to 30 |
| market | `set_sells_paused` | `sells_paused`: boolean | 0 | 5 to 30 |
| market | `set_void_rules` | `price_window_ns`, `grace_ns`: decimal strings in range | 0 | 5 to 30 |
| market | `set_sweep_timing` | three integers in range, settle wait not above reconcile wait | 0 | 5 to 30 |
| market | `reconcile_withdrawal` | `id`: decimal string from 1, `paid`: boolean | 0 | 5 to 30 |
| market | `set_open_price_bounds` | `min`, `max`: decimal strings in range, min not above max | 0 | 5 to 30 |
| market | `set_max_positions` | integer 5 to 30 | 0 | 5 to 30 |
| market | `set_registration_fee` | `registration_fee`: decimal string 10000 to 2000000 | 0 | 5 to 30 |
| market | `set_fee_limits` | five values in range, share floor not above ceiling | 0 | 5 to 30 |
| market | `halt` | `market_id`: U64, `reason`: non-blank text up to 500 bytes | 0 | 5 to 30 |
| market | `resume`, `claim_residual` | `market_id`: U64 | 0 | 5 to 30 |
| market | `retry_register` | `market_id`: U64 | 0 | 50 to 150, 100 attached |
| market | `create_market` | the nine arguments with the contract's own limits: text of 200, 2,000, 300 and 500 bytes, slugs of up to 32 characters, `resolve_by` after `close_at`, and an optional `price_rule` with `observation_time` from `close_at` up to `resolve_by`, `strike` above 0 and at most 18 `decimals` | 0 | 50 to 150, 100 attached |
| market | `withdraw` | `amount`: U128 above 0. The DAO's own balance, not an owner method | 1 | 50 to 150, 100 attached |
| oracle | `set_bond` | `bond`: U128 above 0 | 0 | 5 to 30 |
| oracle | `set_window_ms`, `set_panel_deadline_ms`, `set_min_proposal_ms`, `set_draw_window_ms` | U64 from 1 to 18,446,744,073,709, the most whose product with 1,000,000 fits a U64 | 0 | 5 to 30 |
| oracle | `set_draw_delay_blocks` | U64 | 0 | 5 to 30 |
| oracle | `set_jury_size` | odd integer 1 to 21 | 0 | 5 to 30 |
| oracle | `set_juror_shares` | `decided_bps` 500 to 5000, `no_decision_bps` 1000 to 10000 | 0 | 5 to 30 |
| oracle | `set_apply_buffer_ms` | decimal string 5000 to 300000 | 0 | 5 to 30 |
| oracle | `set_max_publishers` | integer 1 to 25 | 0 | 5 to 30 |
| oracle | `set_no_decision_recipient` | `recipient` must be the treasury | 0 | 5 to 30 |
| oracle | `add_publisher`, `remove_publisher` | `key`: an ed25519 key | 0 | 5 to 30 |
| oracle | `set_price_threshold` | integer 1 to 10 | 0 | 5 to 30 |
| oracle | `set_reconcile_wait_ns` | decimal string 600e9 to 604800e9 | 0 | 5 to 30 |
| oracle | `reconcile_bond_payout` | `id`: decimal string from 1, `paid`: boolean | 0 | 5 to 30 |
| oracle | `withdraw_bond` | none. The DAO's own claimable balance, not an owner method | 1 | 50 to 150, 100 attached |
| council | `set_cooldown_ns` | U64 above 0 | 0 | 5 to 30 |
| oracle, council | `allow_market`, `disallow_market` | `market`: a NEAR account id | 0 | 5 to 30 |
| council | `set_max_seats_per_account` | integer 1 to 4,294,967,295 | 0 | 5 to 30 |
| council | `set_nft_contract` | account id | 0 | 5 to 30 |
| council | `allow_tokens` | 1 to 100 token ids, each non-blank text of up to 128 bytes | 0 | 5 to 30 |
| council | `set_token_range` | `first` and `last`: U64, `first` not above `last` | 0 | 5 to 30 |
| council | `clear_token_range` | none | 0 | 5 to 30 |
| council | `set_allowlist_enabled` | `enabled`: boolean | 0 | 5 to 30 |
| council | `reconcile_claim` | `quarter`: integer, `token_id`: text, `owner`: account, `paid`: boolean | 0 | 5 to 30 |
| council | `set_reconcile_wait_ns` | decimal string 600e9 to 604800e9 | 0 | 5 to 30 |

The ceilings in the table (500, 10,000,000, the text limits, 21, 10 and 100) are copied from constants in the contract source, and the 100 TGas floor of `upgrade` from `upgrade::GAS_UPGRADE`. A test reads the source and fails when one of them differs.

The owner methods come from a scan of `contracts/market/src/lib.rs`, `oracle/src/lib.rs`, `council/src/lib.rs` (every `pub fn` whose body calls `only_owner`, `only_operator_or_owner`, compares the caller with `self.owner` or checks `pending_owner`, or uses the upgrade module). Not prepared, each with its reason:

| Method | Reason |
| --- | --- |
| `stage_code` (all three) | Open to anyone, and it takes the wasm as its raw call input. A stager sends it (below), and the proposal carries only the hash. `prepareAdministrationProposal` answers a request for it with that instruction |
| `migrate` (all three) | Private. It runs inside the batch that `upgrade` sends, in the new code |
| `mt_on_transfer` (market) | Only the verifier calls it. Its `seed` message compares the sender with the owner and operator, and the DAO would send that through `intents.near`, which is not one of the three contracts |
| `set_min_sweep`, `reconcile_leg`, `set_close_grace_ns`, `settle_leg`, `payout_bond` | Listed as NEW in section 3 and not in the source. They are refused until a contract has them and the table does |

Rules the helper enforces when it prepares a proposal and when it prepares a vote:

1. The proposal kind must be `FunctionCall` with exactly one action. A `Vote` kind, which does nothing, can be approved. Every other kind is refused for approval unless the caller names it in `acknowledge` (section 6). A `FunctionCall` the allow-list refuses cannot be named.
2. `receiver_id` must be one of the three configured contract ids. It can never be the DAO itself, `intents.near` or any other account.
3. The method must be a key of `ALLOWED[target]`.
4. The arguments must hold exactly the schema's keys and each value must pass its check. An unknown or missing key refuses the proposal. A stored proposal's arguments must also be canonical JSON (no repeated key, no spacing, no other spelling of a number) and canonical base64, so the text that was checked is the text the contract reads.
5. `deposit` must equal the entry: `1` only for `withdraw` and `withdraw_bond`, `0` for the rest.
6. `gas` must be inside the entry's bounds.
7. The `needs` condition holds on the chain at the time: `is_staged(code_hash)` on the target for `upgrade`, `config.upgrade_proven` for `seal`.
8. `revenue_pool` must be the configured Council. The two recipients of money the contracts push out, `business_wallet` and the oracle's `no_decision_recipient`, must be the treasury account the helper was given, because the verifier does not check that a receiver exists and a typo loses the money. This is the choice README OD-09 recommends (one verified Trezu account for both). A different recipient needs a change to the table and a review.
9. The proposal bond is the one in `get_policy` on the DAO, read at preparation. A bond passed by the caller is ignored.
10. The vote helper reads the stored proposal with `get_proposal` and builds `act_proposal` from the kind the DAO holds. The caller supplies only the proposal id, the decision and, for a guarded kind, the acknowledgement. Approval needs status `InProgress`. Rejection needs no review.

The treasury account and the three contract ids are required inputs of every call, must be four different valid account ids, and have no default.

Staging. A stager calls `prepareStageCode({ contracts, target, wasm })`. The result is a request to `stage_code` on that contract whose `args` are the raw wasm bytes (not JSON, so the signer must send raw input; near-cli-rs has `file-args`), 300 TGas, and a deposit of 10^19 yoctoNEAR per stored byte for the wasm plus 84 bytes (a 44 byte key and 40 bytes the network adds, measured with the contract's own unit test), plus 0.1 NEAR that the contract refunds. The result also carries `codeHash`, the sha256 of the wasm in base58, which is the value `upgrade` takes. The `upgrade` proposal then carries 32 bytes of hash and nothing else.

### 5.3 What this cannot do

A script cannot stop a member who approves through another wallet. The allow-list prevents preparing a harmful proposal with the project's tools and gives the keeper a definition of normal. The controls that actually bind are the DAO policy (section 7) and the review each member does. State this in the runbook.

### 5.4 Tests

Every row is `contracts/keeper/treasury.test.mjs`.

| Required | Test |
| --- | --- |
| Every entry with valid arguments is prepared, with its deposit, its gas and the bond from the policy | `every allow-list entry has a sample, so a new entry cannot go untested`, `each entry prepares one FunctionCall proposal to the DAO with its own deposit and gas and the bond from the DAO's policy` |
| A missing key, an extra key, a wrong type or a value past its bound is refused | `arguments the contract would refuse, or that it does not take, are refused before a proposal exists`, `a value past what the contract allows is refused, and the value at the limit is not`, `a new market is checked the way the contract checks it` |
| A method not in the list is refused for each contract | `a method that is not on the list is refused for every contract, whatever its name` |
| A receiver that is not one of the three contracts, or is the DAO, is refused; the DAO and contracts are required inputs | `a function call is approved only when its receiver is a configured contract and its one action is on the allow-list`, `the DAO and the three contracts are always inputs, four different accounts, and a view is needed to read them` |
| Each of the 17 proposal kinds as a vote | `the guard table covers all 17 Sputnik proposal kinds`, `approving any kind except an allow-listed call or a signalling Vote is refused until the caller names that kind`, `rejecting is allowed for every kind, and a kind or a name the table does not know is refused`, `only a proposal still in progress can be approved` |
| A vote binds to the stored kind | `a vote binds to the kind the DAO stores, whatever the caller passes, and builds act_proposal` |
| `upgrade` for a hash that is not staged, `seal` before the upgrade is proven | `upgrade is prepared only for code staged on that contract, and seal only once the upgrade path is proven` |
| `set_fee_recipients` with a treasury that differs from the configured one | `a value past what the contract allows is refused, and the value at the limit is not` |
| A bond that differs from the DAO's `proposal_bond` | `the bond is read from the DAO's policy and a caller cannot supply one` |
| Gas bounds, and 100 TGas or more for `upgrade` | `the gas of an action stays inside what its method takes, and an upgrade attaches at least the 100 TGas the contract needs` |
| Staging and the hash | `an upgrade proposal carries only the hash, and staging a wasm builds a raw request that costs its storage`, `the code hash is the sha256 in base58, which is how upgrade::stage_code files the wasm` |
| A new owner method cannot be missing | `the scan finds owner-checked and upgrade-path methods in source text`, `every owner or upgrade-path method in the contract sources is prepared by the helper or deliberately excluded with a reason`, `the methods the DAO calls for itself, and not as the owner, are the two that take 1 yocto`, `the limits and the gas floor the helper enforces are the ones in the contract source` |

---

## 6. Sputnik proposal kinds that need a guard

All 17 variants of `ProposalKind` at the pinned revision (`proposals.rs:67-121`). The policy label is the first half of the permission string. Execution lines are in `proposals.rs`.

BUILT (2026-10-21): the vote helper in `treasury.mjs` applies this table. `GUARDED_KINDS` holds the 15 kinds other than `FunctionCall` and `Vote`. "Helper refuses" in the Rule column means it refuses to prepare an approval unless the caller names the kind in `acknowledge`, knowing it is not application administration. It always prepares a rejection. A kind it does not know is refused with no way to name it. A `FunctionCall` is judged by the allow-list (section 5) and cannot be named.

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
| `proposal_period` | 72 hours (259,200,000,000,000 ns) | The only delay and the only deadline (owner decision, 2026-10-21). It bounds how long a proposal stays public and approvable, not how long anyone waits after approval. Short enough that approvals are collected together, long enough for members in different time zones. Sputnik's default is 7 days |
| `proposal_bond` | 1 NEAR or more | Limits spam if any role can still add proposals |
| `Everyone` role | Remove `*:AddProposal` if the interface allows it | Only members propose |
| Recompute on membership change | Each time a member is added or removed, recompute every `Ratio` | `Ratio(3, 5)` needs 4 of 5 members and still only 4 of 6, so the share of members who must approve falls as the role grows |
| Majority floor | No vote policy may need fewer than a majority of the approver role, and the role never has one member | Review finding N-01 put this floor in the retired governance contract's code ([AUDIT.md](../AUDIT.md#every-finding-and-where-it-went)). Sputnik does not enforce it, so it is a policy rule here, and the proposed keeper DAO policy check (section 9.2) pages when it is broken. The retired contract's 72-hour timelock floor has no successor |

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

Every oracle call below carries `market` (the keeper's `--market` account) before `market_id`, cases are read with `get_case(market, market_id)`, and the Council's jury is looked up under the case's `case_uid`.

Checked in source and by run on 2026-10-21: `contracts/keeper/keeper.mjs`, with its reads in `chain.mjs`. `node --test keeper/keeper.test.mjs keeper/treasury.test.mjs` passes 67 tests (42 keeper, 25 treasury). The release tooling adds 7 tests (`keeper/release-check.test.mjs`) and 10 (`verify-build.test.mjs`, one skipped when no built wasm is present). Seven sandbox tests in `tests/tests/keeper.rs` run the script against the real contracts and the real verifier, and all passed.

| Duty | Call or check | Gas | Source |
| --- | --- | --- | --- |
| Finalize an unchallenged case after its window, or a round that is over | `oracle.finalize` | 100 TGas | `dueActions` |
| Draw a jury | `oracle.resolve_draw` | 300 TGas | `dueActions` |
| Resend a final answer to the market | `oracle.retry_apply` | 100 TGas | `dueActions` |
| Release the seats of a settled dispute | `oracle.retry_unlock` | 100 TGas | `dueActions` |
| Answer a market past `resolve_by` | `oracle.resolve_by_deadline` | 100 TGas | `dueActions` |
| Sweep fees once `collected + revenue_due + business_due` reaches 10 USDC, and not within an hour of the last sweep (read from `list_sweeps`) | `market.sweep_fees` | 100 TGas (floor 87) | `dueActions` |
| Settle a Council fee leg left `unresolved`, 10 minutes after its sweep, among the newest 20 sweeps | `market.settle_leg(sweep_id)` | 50 TGas (floor 30) | `dueActions` |
| Move seat time forward when the quarter of now is not the quarter of `last_tick` | `council.advance_quarters` | 50 TGas | `councilActions` |
| Finalize `next_to_finalize` once its end plus `close_grace_ns` has passed and one advance can reach that end. The contract refuses while a jury drawn in the quarter is open, and the keeper reports that as waiting | `council.finalize_quarter(quarter)` | 50 TGas (30 measured clean) | `councilActions`, `describeOutcome` |
| Check that the Council can seat a jury and a second jury | `check` | none | `juryProblems` |
| Check publisher count against the threshold | `check` | none | `check` |
| Check that the `--market` account is in the `markets` allow-list of the oracle and of the Council | `check` | none | `check` |
| Compare the live code hash of the three contracts with a release hash list, with `--release <file or ->` | `check` | none | `releaseReport`, `parseReleaseHashes` |
| Check NEAR left after storage for each contract and an optional treasury | `check` | none | `marginReport` |
| Reconcile the market, the oracle and the Council with the verifier | `check` | none | `reconciliation`, `reconcile`, `councilBooks` |
| Read what the verifier says about each of the three: keys, predecessor authentication, lock, paused transfers | `check` | none | `verifierProblems`, `check` |
| Check that the collateral token has the market and the verifier registered, so a deposit or buy by `ft_transfer_call` can arrive | `check` | none | `tokenProblems` |
| Count NEAR access keys, and fail on any with `--expect-sealed` | `check` | none | `accessKeyReport` |
| List open DAO proposals that name the contracts, and flag any the allow-list refuses, with `--watch-dao --treasury ID` | `check` | none | `daoReport`, `openProposals` |

### 9.2 What it must do

`run` sends calls and `check` only reads. Every check below is a `check` item. A problem makes `check` exit 1. Writing a status file that the website reads, to stop advertising deposits (INTENTS-PROOF.md:182-184 says the keeper should do this), is NOT BUILT. Status is as of 2026-10-21.

| Check | How | Level | Status |
| --- | --- | --- | --- |
| Market reconciliation | `market.total_owed()` against `verifier.mt_balance_of(M, T)`, both read at one `block_id`, less `in_flight().withdrawals` | Surplus is reported. The verifier must hold at least owed less what is in flight. A shortfall below that seen on three reads, 3 blocks apart, is a problem | BUILT. Sandbox: `the_deploy_check_reconciles_all_three_contracts_and_reads_what_the_verifier_says_about_each`, `the_deploy_check_reports_money_missing_from_the_verifier_only_after_reading_again` |
| Oracle reconciliation | `oracle.total_owed()` against `mt_balance_of(O, T)`, less `bond_totals().pending_payouts` | Same | BUILT. Sandbox: `the_deploy_check_reconciles_the_oracle_with_what_the_verifier_holds_for_it` |
| Council reconciliation | The Council has no `reward_totals` or total owed yet. The keeper adds `config.stream_remaining` and the `pending_reward` of every staked token at one block, a floor that is at most what the Council owes, and compares it with `mt_balance_of(C, T)` | Shortfall is a problem. More than the floor is normal (rounding stays in the stream) | BUILT as a floor. The exact check with `reward_totals` waits for the quarterly change, which removes `pending_reward` |
| Market to Council consistency | Sum of settled Council legs in `market.list_sweeps` equals `council.total_received` | Page on a difference | NOT BUILT. `list_sweeps` does not exist |
| No key registered | `verifier.public_keys_of(a)` is an empty list for M, O and C | Problem | BUILT. Sandbox test above, with a key added under the Council's account |
| Predecessor authentication on | `verifier.is_auth_by_predecessor_id_enabled(a)` is true for M, O and C | Problem | BUILT. Read against the real verifier in every sandbox `check`. The false case is only a unit test, because only the account itself can turn it off |
| Not locked | `verifier.is_account_locked(a)` is false | Problem, and stop advertising deposits | BUILT (the problem). Sandbox: the market locked and unlocked with `force_lock_account` |
| Verifier feature not paused | `verifier.pa_is_paused({ key: "mt_transfer" })`, the near-plugins `Pausable` view the verifier derives. `mt_transfer` is the key its `mt_transfer` and `mt_transfer_call` check, and `pa_is_paused` is also true when `ALL` is paused | Problem | BUILT. Sandbox: transfers paused and unpaused with `pa_pause_feature` |
| Access keys | `view_access_key_list` for M, O and C. The count is always printed. With `--expect-sealed` any key is a problem | Problem with the flag | BUILT. The flag is for use after `seal` |
| Code hash | The code hash of each contract equals the release hash list (the tag message), passed with `--release`. `config.upgrade_in_flight` is false | Problem on a difference | PARTLY BUILT. The `--release` comparison is built and tested with a fake RPC; the `upgrade_in_flight` read is not |
| Ownership | `config.owner` equals the configured DAO, `pending_owner` is null, `operator` is the expected account | Page | NOT BUILT |
| Treasury and recipients | `market.config.business_wallet` (NEW name `treasury`) equals the verified treasury. `oracle.config.no_decision_recipient` equals it | Page | NOT BUILT |
| DAO policy | Hash of `get_policy` equals the audited baseline. Member count and thresholds match section 7 | Page on a change | NOT BUILT |
| DAO proposals | Read the DAO's open proposals (`InProgress` or `Failed`, inside the voting period). List each that names M, O or C, and make it a problem when `reviewKind` refuses it. Count the others by kind. An `upgrade` whose hash is not staged is refused by the same review | Problem or listing. It never votes | BUILT (`--watch-dao --treasury ID`). The paging and the report are not run against a real DAO, and the staging time of a hash (24 hours) is not checked |
| Revenue unresolved | `market.get_fees().revenue_unresolved` above zero for more than 10 minutes | Warn, then call `settle_leg` | NOT BUILT. `settle_leg` does not exist |
| Storage margins | Existing check for M, O, C and the keeper account | Warn | BUILT |
| Jury readiness | Existing check | Warn | BUILT |
| Publisher count | Existing check | Warn | BUILT |

| Call | When | Receiver and method | Key |
| --- | --- | --- | --- |
| Existing oracle calls | As in 9.1 | `oracle.*` | Oracle key |
| Sweep | Fees reach `min_sweep`, and once shortly before each quarter boundary (about one hour before `ends_at`) so fees earned in a quarter are received in it | `market.sweep_fees` | Market key |
| Settle a lost Council result | A Council leg is `unresolved` for more than 10 minutes | `market.settle_leg(sweep_id)` | Market key |
| Move seat time forward | `current_quarter` is behind now by more than a day, or just after a boundary | `council.advance_quarters` | Council key |
| Finalize a quarter | `now >= claimable_from` of `next_to_finalize` | `council.finalize_quarter(q)` | Council key |
| Push a bond payout | `claimable_of(account) > 0` for more than 7 days | `oracle.payout_bond(account)` | Oracle key |
| Price answers | A price market passes its observation time | `oracle` through a publisher service | Not built |

Of the calls above the existing oracle calls, the threshold sweep (not within an hour of the last), `settle_leg`, `advance_quarters` and `finalize_quarter` are built, with the triggers listed in 9.1; the rest wait for the contract methods they call. The Council calls use the default key or `--council-key-file` / `KEEPER_COUNCIL_KEY`. Every call above attaches no deposit, so a function call access key scoped to one receiver and the methods it uses is enough. Scoped methods: oracle `finalize,resolve_draw,retry_apply,retry_unlock,resolve_by_deadline,payout_bond`; market `sweep_fees,settle_leg`; council `advance_quarters,finalize_quarter,book_seat_time`.

Cadence (PROPOSED): `run` every minute, `check` every five minutes, the quarter boundary sweep scheduled from the quarter table. Keep the allowance of each key under 1 NEAR and alert at half.

### 9.3 Reconciliation procedure

BUILT as follows. A payout leaves the verifier before the contract's callback books it, and the contract keeps it in `total_owed` until then, so while it is in flight the verifier holds that much less than is owed. The keeper reads the amount in flight in the same block: the market's `in_flight().withdrawals` and the oracle's `bond_totals().pending_payouts`. The Council has no such view: its floor (`reward_totals`) already takes off the claims in flight. A deposit shows as a surplus until its hook has run.

1. Read the finalized height. Read each contract's owed figure and the verifier's `mt_balance_of` for it at that `block_id`. The three contracts are read one after another, each at the final height current when its turn comes.
2. `held > owed`: surplus nobody is credited for, for example a plain deposit. Show the amount and do not call it a problem. It is never credited automatically.
3. `held < owed` less the amount in flight: read both again at the then final height, after the final height has moved 3 blocks (it gives up waiting after 30 seconds), up to two more times. Report a problem only if the last read still shows the shortfall, with the amount from that read.
4. NOT BUILT: stopping the advertisement of deposits, paging a person, and not running `sweep_fees` until a person has looked. `check` exits 1 and prints the problem, and that is all it does.

---

## 10. Review notes on the existing code

Status is as of 2026-10-21. The evidence column quotes the code as it was when the notes were written.

| Item | Evidence | Note | Status |
| --- | --- | --- | --- |
| Stale sweep floor | `keeper.mjs:56` said `sweep_fees` refuses less than 95 TGas. The code floor is 87 (`market lib.rs:64-66`) and the sandbox test asserts 87 (`gas_floors.rs:296-306`) | The attached 100 TGas is still enough | Fixed in phase I3. The comment and `keeper.test.mjs` say 87 |
| `check` did not look at the verifier | `keeper.mjs:330-357` | No reconciliation, key, lock or pause check | Fixed (section 9.2). The status file and the stop on advertising deposits are not built |
| One `final` read per view | `keeper.mjs:141-151` | Two views can come from different blocks | Fixed for `check`: its reads use one `block_id`. `run` still reads each view at the final block of its own call, which only makes it act later |
| Exit code | `keeper.mjs:259-278`, `:395-397` | A failed call is printed as `FAILED` and the process still exits 0, so a timer cannot alert on it. Exit non-zero if any call failed | Open. Not changed in the rewrite |
| Transaction send | `keeper.mjs:275` | Uses `broadcast_tx_commit`, which newer nearcore deprecates (noted in AUDIT.md) | Open |
| Cost per run | `keeper.mjs:153-178` | One `get_case` per market after the cursor, plus up to two `jury_of` calls per settled dispute. `oracle.list_cases` (oracle.md section 8.4) replaces them with pages | Open |
| Holder count | `keeper.mjs:334-338` | One `stake_of` call per staked token. At 1,000 seats this is 1,000 calls. A `holders` figure in `council.config` would cost nothing | Open, and `check` now makes a second call per token (`pending_reward`) for the Council floor, so 2,000 calls at 1,000 seats |
| No lock between runs | `keeper.mjs` main | Two overlapping runs both send. The contracts make every call idempotent, but each failed call burns allowance. A lock file or a single timer fixes it | Open |
| Scoped key list in the header | `keeper.mjs:26-32` | Missing the methods in section 9.2 | Fixed. The header lists `settle_leg` for the market and `advance_quarters,finalize_quarter` for the Council |
| `treasury.mjs` bond | `treasury.mjs:22`, `:59` | The caller supplied `proposalBond`. The DAO requires exact equality with its policy (`proposals.rs:540-544`), so the helper should read it | Fixed. It reads `get_policy` and ignores a caller's bond |
| `treasury.mjs` gas default | `treasury.mjs:24` | 30 TGas is too little for `upgrade`, which needs 100 | Fixed. `upgrade` attaches 150 by default and refuses less than 100 |
| `treasury.mjs` vote check | `treasury.mjs:66-89` | The check ran on the kind the caller passed | Fixed. The helper reads the stored proposal and builds the vote from that kind |
| Sandbox owner fixture | `tests/tests/common/mod.rs:882-889` | `setup_admin_owned` is an ordinary account. The file says it does not simulate Sputnik | Open |

---

## 11. Test evidence required

| Requirement | Evidence that exists | Evidence still required |
| --- | --- | --- |
| R-07 restricted methods refuse strangers | `attacks.rs:26` (every restricted method, with an owner fixture) | The same list with the NEW methods added: `set_min_sweep`, `reconcile_leg`, `set_close_grace_ns`, `set_market`, `settle_leg`, `payout_bond` |
| R-07 handover | `upgrade.rs:130` (upgrade through the owner fixture) | A sandbox with a real SputnikDAO build at the pinned revision: `propose_owner`, `accept_owner`, one call per allow-list entry, a `Failed` proposal retried with `Finalize`, an expired proposal, a vote with a wrong kind |
| R-07 policy | none | A test that builds the section 7 policy and checks the approval counts for 5 members, and again after adding a sixth |
| Allow-list | `treasury.test.mjs`, 25 tests, listed in 5.4. All 109 mutations of the node code and the contract sources were caught | Run against a real SputnikDAO: the argument format the DAO accepts for `gas` (a string is assumed) and for `deposit`, and a `get_proposal` of a `FunctionCall` as the helper reads it |
| Keeper | `keeper.test.mjs` (42 tests) and `keeper.rs` (7 tests). The new checks have unit tests for the reconciliation decision, the re-read, the verifier decisions, the access key report, the DAO report and the flags, and sandbox tests for a key registered in the verifier, a locked account, a paused feature, a plain deposit surplus, a deficit and the access key flag | The DAO watch against a real DAO. A sandbox test with `is_auth_by_predecessor_id_enabled` off |


## Testnet workload measurements

`node contracts/keeper/load-test.mjs workload.json` validates a plan without reading keys or contacting RPC. `--execute` first checks `status.chain_id == "testnet"`; every actor and application/verifier target must be a distinct configured `.testnet` account. Use dedicated funded testnet accounts and the tested verifier deployment. The runner permits workload methods only, caps attached deposit at 1 NEAR per call, serializes each actor's nonces, and uses 1 to 8 concurrent workers. Repeated calls from one actor do not create concurrent signing capacity.

A minimal plan for a pre-created, registered and seeded market, with the actor already funded in the market balance:

```json
{
  "rpc": "https://rpc.testnet.near.org",
  "workers": 2,
  "contracts": {"market":"YOUR-MARKET.testnet", "oracle":"YOUR-ORACLE.testnet", "council":"YOUR-COUNCIL.testnet", "verifier":"YOUR-VERIFIER.testnet"},
  "actors": [{"id":"YOUR-TRADER.testnet", "keyFile":"/absolute/path/to/owner-only-raw-ed25519-key"}],
  "calls": [{"actor":"YOUR-TRADER.testnet", "target":"market", "method":"buy", "args":{"market_id":"0", "side":"yes", "amount":"1000000", "min_shares":"1"}, "deposit":"1", "gasTgas":100, "expect":{"receiver":"market", "event":"buy", "data":{"market_id":"0"}}}],
  "caseIds": ["0"],
  "keeperStateFile": "/absolute/path/to/testnet-keeper.json"
}
```

Replace uppercase placeholders with valid accounts; the validator deliberately rejects the example as written. Keys are raw `ed25519:...` strings in files readable by the owner only, not NEAR CLI JSON files. Never put a key in the plan or command line. Add proposal/challenge notifications through verifier `mt_transfer_call` and `commit_vote`/`reveal_vote` calls in separate phases around real deadlines; prepare commitments with the existing contract grammar. Include normal buys, sells and verifier `mt_transfer_call` notifications competing with keeper work. A single phased plan does not manufacture a resolved dispute.

The runner waits for `FINAL` and requires a successful own-contract receipt with the expected event/entity before counting a confirmation. Refunded or failed trades do not count. On an RPC send timeout, it queries the known transaction hash; it never automatically resends an uncertain transfer. Inspect any unconfirmed hash before repeating a plan. Output includes confirmed trade/call rate, p50/p95 confirmation latency, receipt failures, RPC method counts, selected case completion/application/unlock status, and keeper cursor lag if a state file is supplied. [NEAR's transaction RPC documentation](https://docs.near.org/api/rpc/transactions) defines `FINAL` and status lookup.

Record deployment hashes, protocol config, token, provider, signer count, concurrent worker count, workload mix, deposits and balances before and after. Run several sustained windows at increasing rates and record provider throttling, event lag, oldest due-job age, minimum deadline slack and end-to-end dispute completion times. Repeat through keeper restart, delayed callback and provider outage. The script's lag snapshot is not a time series or an API/browser benchmark. Add external monitoring for those measurements. No live capacity claim is supported until these runs are completed; a second market account still shares the verifier and other services.
