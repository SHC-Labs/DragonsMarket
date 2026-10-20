# governance

Custody decision, 2026-10-19: the accepted target in [intents-architecture.md](../intents-architecture.md) keeps platform tokens in Intents. This manual remains a description of current governance methods. Authority over future settlement accounts, escrow and delegated signing must be specified and reviewed; existing owner/timelock controls alone do not establish those Intents permissions.

Source: `governance/src/lib.rs`, with the shared upgrade helpers in `upgrade/src/lib.rs`. Written 2026-10-18 from the code as it stands, upgrade path added 2026-10-19. When this file and the code disagree, the code is right.

## What it is

governance is a small multisig with a public delay. Up to five named accounts (the members) share the owner role of market, oracle and council, so no single key can change a fee, a bond, a wallet or an operator.

A change goes through four steps: a member proposes it, members vote, an approved change waits out a timelock so everyone can see it coming on-chain, and then anyone can execute it. During the timelock, members can cancel it.

It holds no market money. Its only job is to be the owner account of the other contracts and to call them when its members agree. That includes their code: a new build of market, oracle or council is deployed by a vote and its timelock, and so is a new build of this contract.

## Where it sits among the other contracts

| Contract | Relationship to governance |
|---|---|
| market | Set as `owner_id`. Every owner-only method is reached by a `FunctionCall` proposal here. |
| oracle | Same. |
| council | Same. |
| Itself | Members, threshold and the three periods change only through proposals here (see "Changing governance itself"). Its own code changes through the `upgrade_self` action (see "Upgrading code"). |

governance does not need to be the owner of all three, but the design assumes it is. Whether a deployed contract really has this account as owner is a deployment fact to check on-chain with each contract's `config` view, not something this code can promise.

## Roles: who can do what

| Role | Who | Can do |
|---|---|---|
| Member | 1 to 5 accounts, set in `new`, later changed by proposals | `propose`, `vote`, `cancel` |
| Anyone | Any account | `execute` (once the timelock has passed), `stage_code` (paying for the storage), and every view |
| The contract itself | n/a | `on_executed` and `migrate` (both refuse everyone else) |

There is no owner, no admin and no operator in this contract. Nobody can change a setting except through an approved proposal.

## Starting it up: `new`

Called once, at deploy. Only the contract's own account can call it: `new` is `#[private]`, so a deploy and init batch signed by that account is the one way in, and anyone else gets `Method new is private`.

| Argument | Meaning | Refused when |
|---|---|---|
| `members` | The member accounts | Empty, more than 5, or any account listed twice (`there must be 1 to 5 members`, `members must be different accounts`) |
| `threshold` | How many yes votes approve a proposal, and how many cancel votes cancel one | Below 1 or above the number of members (`threshold must be between 1 and the number of members`) |
| `voting_period_ns` | How long a proposal is open for votes, in nanoseconds | Zero (`periods must be positive`) |
| `timelock_ns` | The wait between approval and the first moment it can be executed | Zero |
| `execution_window_ns` | How long after the timelock ends it can still be executed | Zero |

The periods are chosen at deploy and are not set in the code. Times are nanoseconds since the Unix epoch, and `U64` and `U128` travel as strings in JSON.

## Limits written into the code

| Limit | Value | Why |
|---|---|---|
| Members | 5 | Keeps votes cheap and the member list short. |
| Call arguments | 4,096 bytes | Each proposal is stored and paid for from this contract's own balance, so a record needs a ceiling. 4,096 bytes is enough for `create_market` at its own text limits. |
| Method name | 256 bytes | The protocol's own limit on a method name. |
| Proposals returned by `list_proposals` | 50 per call | Page size. |

Proposals are never deleted. Each one stays in storage, paid from this contract's balance, and there is no cap on how many members can create. Five members could fill it, so the balance has to cover storage over time.

## The life of a proposal

```
propose ──> Open ──(yes votes reach threshold)──> Approved ──(timelock passes)──> execute ──> Executed
              │                                      │   │                                  └─> ExecutionFailed
              │                                      │   └──(threshold members cancel)──> Cancelled
              └─(voting window ends first)──> Expired      └─(execution window ends first)──> Expired
```

| Stage | Meaning |
|---|---|
| Open | Voting is running. |
| Approved | Enough yes votes arrived. Waiting out the timelock, then executable until the window closes. |
| Executing | A function call, a code upgrade or a key deletion has been sent and its result has not come back yet. |
| Executed | Done. |
| ExecutionFailed | The call was sent and the target contract rejected it, or the deploy and migrate batch of an upgrade failed. The proposal is final. |
| Cancelled | Enough members cancelled it during its timelock. It never runs. |
| Expired | Shown by the views, never stored. An Open proposal whose voting window ended, or an Approved one that missed its execution window. |

### Timeline and what moves it

| Moment | Rule |
|---|---|
| Created | `voting_ends_at` = now + `voting_period_ns` at the time of proposing. A later change to the voting period does not touch proposals already open. |
| Approved | The instant a yes vote brings the count of yes votes from current members to the threshold. `approved_at` is set once and never moves. |
| Executable | From `approved_at + timelock_ns` until `approved_at + timelock_ns + execution_window_ns`. These two periods are read at execution time, so a timelock or window change that executes in between applies to proposals already approved. |
| Expired | After that, it can never be executed. A new proposal is needed. |

Votes keep being accepted after approval until `voting_ends_at`, so the record shows everyone who voted. Voting after approval does nothing to the outcome.

## Every method

| Method | Who | What it does |
|---|---|---|
| `new(members, threshold, voting_period_ns, timelock_ns, execution_window_ns)` | Deployer, once | Initialises. |
| `propose(action)` | A member | Creates a proposal and returns its id. The proposer's own vote is not cast for them. |
| `vote(proposal_id, approve)` | A member | Records a yes or a no. Approves the proposal if this brings it to the threshold. |
| `cancel(proposal_id)` | A member | Adds a cancel vote to an Approved proposal. Cancels it for good once the cancel votes reach the threshold. |
| `execute(proposal_id)` | Anyone | Runs an Approved proposal whose timelock has passed and whose window has not closed. |
| `on_executed(proposal_id)` | The contract itself | Callback after a function call, an upgrade or a key deletion. Marks it Executed or ExecutionFailed. |
| `stage_code()` | Anyone, payable | Stores the call input as a wasm under its own sha256 and returns the hash. The deposit pays for the storage and the surplus is refunded. |
| `migrate()` | The contract itself | Runs in the new code in the same batch as the deploy. Reads the one state layout it knows, sets `upgrade_proven`, returns the state. |
| `is_staged(code_hash)` | Anyone, view | Whether a wasm with that sha256 is staged here. |

### Refusals

| Method | Message | Cause |
|---|---|---|
| `propose`, `vote`, `cancel` | `members only` | The caller is not a current member. |
| `propose`, `execute` | the action checks below | The action is invalid now. |
| `vote`, `execute`, `cancel`, `on_executed` | `no such proposal` | Unknown id. |
| `vote` | `this proposal was cancelled` | Cancelled. |
| `vote` | `already executed` | The proposal is Executing, Executed or ExecutionFailed. |
| `vote` | `voting has ended` | The window closed. |
| `vote` | `already voted` | A member votes once and cannot change the vote. |
| `cancel` | `only an approved proposal can be cancelled` | Open, Cancelled, or already running. |
| `cancel` | `already voted to cancel` | Once per member. |
| `execute` | `not approved` | Open or not approved. |
| `execute` | `this proposal was cancelled` | Cancelled. |
| `execute` | `already executed` | Executing, Executed or ExecutionFailed. A second execute while the call is in flight is refused. |
| `execute` | `the timelock has not passed` | Too early. |
| `execute` | `the execution window has passed` | Too late. |
| `execute` | `attach at least <call gas plus 14> TGas to execute this call` | A `function_call` execution with less than its own gas plus the 14 TGas the execute and its callback need. The proposal stays Approved. |
| `execute` | `attach at least 110 TGas to execute an upgrade` | An `upgrade_self` execution with less gas than the deploy, migrate and callback need. The proposal stays Approved and the staged code stays. |
| `execute` | `no code is staged under that hash` | An `upgrade_self` whose staged copy is gone, for example used by an earlier proposal for the same hash. |
| `stage_code` | `attach at least <amount> to pay for the storage` | The deposit is below the storage cost of the wasm. |
| `stage_code` | `the wasm goes in the call input` | The call carried no input. |
| `migrate` | `migrate expects version 1` | The stored state starts with another version number. |
| `on_executed` | `no call in flight for this proposal` | Nothing is Executing. |
| `on_executed` | `Method on_executed is private` | Called from outside. |

## Votes and counting

A proposal is approved when the number of yes votes cast by current members reaches the threshold. Three points that matter:

| Rule | Consequence |
|---|---|
| Only yes votes count toward approval. | A no vote cannot block. If the threshold of yes votes arrives, the proposal passes however many members voted no. There is no veto. |
| Only current members count. | If a member is removed, their earlier yes vote stops counting. The record still shows it. A removed member who is later re-added has that vote counted again. |
| The count is checked when a vote is cast. | Lowering the threshold does not approve an Open proposal by itself. The next vote on it does the check. |

A proposal that never reaches the threshold simply expires. There is no explicit reject.

Cancelling follows the same shape: it needs the threshold's worth of cancel votes from current members, and each member votes once. The members who approved a bad change will not cancel it, so cancelling protects against mistakes and changes that turn out wrong, not against a captured majority.

## What a proposal can do: the actions

An action is one of nine kinds. JSON uses snake_case names.

| Action | Fields | Effect when executed |
|---|---|---|
| `function_call` | `receiver_id`, `method_name`, `args` (base64 bytes), `deposit` (yoctoNEAR), `gas` | Sends a function call from this contract to `receiver_id`. This is how owner-only methods on market, oracle and council are used. |
| `add_member` | `account` | Appends a member. |
| `remove_member` | `account` | Removes a member. |
| `set_threshold` | `threshold` | Changes the approval and cancel threshold. |
| `set_voting_period` | `voting_period_ns` | Changes how long new proposals stay open. |
| `set_timelock` | `timelock_ns` | Changes the delay between approval and execution. |
| `set_execution_window` | `execution_window_ns` | Changes how long an approved proposal stays executable. |
| `upgrade_self` | `code_hash` (base58 sha256) | Deploys the staged wasm with that hash on this account and runs its `migrate` in the same batch. |
| `seal` | `public_key` | Deletes that access key from this account. Refused until an upgrade has gone through `migrate`. |

### Checks on each action

The checks run when a proposal is created, and again at execution, because members or the threshold may have changed in between. A check that fails at execution reverts that call and leaves the proposal Approved until its window closes.

| Action | Check | Message |
|---|---|---|
| `function_call` | Receiver is not this contract | `governance changes itself only through its own actions` |
| `function_call` | Method name at most 256 bytes and args at most 4,096 bytes | `the call is too long` |
| `function_call` | `gas` from 5 to 250 TGas, both included | `the call's gas must be between 5 and 250 TGas` |
| `add_member` | Not already a member | `already a member` |
| `add_member` | Fewer than 5 members | `there can be at most 5 members` |
| `remove_member` | Is a member | `not a member` |
| `remove_member` | More members than the threshold | `removing a member would leave fewer members than the threshold` |
| `set_threshold` | Between 1 and the number of members | `threshold must be between 1 and the number of members` |
| the three period actions | Above zero | `periods must be positive` |
| `upgrade_self` | The wasm is staged here now | `stage the code first, nothing is staged under that hash` |
| `seal` | `upgrade_proven` is true | `prove the upgrade path before deleting keys` |

### Function calls in detail

The call goes out in the `execute` transaction. The `deposit` is taken from this contract's own balance, so the account must hold at least that much beyond what storage requires. The `gas` field is what the target receives. Gas rules:

| Item | Amount |
|---|---|
| Reserved for the callback | 10 TGas (measured use about 2 TGas) |
| Range of the call's `gas` | 5 to 250 TGas, checked when proposed and again when executed. Below 5 the call could not do anything useful and would fail in the target after the vote and the timelock were spent. Above 250 an `execute` could never attach it, since a transaction carries 300. |
| Needed attached to `execute` | The call's own gas plus 14 TGas, and `execute` refuses less (`attach at least 34 TGas to execute this call` for a 20 TGas call). A 20 TGas call failed with 33 attached and worked with 34, and the sandbox test attaches exactly those two numbers. The proposal views show the sum as `execute_gas`. |
| A call to `upgrade` on another contract | Set the call's `gas` to 100 TGas or more. The target refuses with `attach at least 100 TGas to upgrade` otherwise. Measured in the sandbox, the whole upgrade burns 30 to 34 TGas for a 249 to 289 KB build, so 100 leaves room for a larger build and a heavier migrate. The 5 to 250 TGas bounds on the call gas allow it. |
| Measured use at the args cap with five votes | propose 4.3 TGas, a vote up to 2.2, a settings change 1.7, a call 3.0 plus 2.0 in the callback |

Once the call has gone out the stage is Executing, so a second `execute` is refused. When the target returns, the callback records Executed, or ExecutionFailed if the target contract failed. A failed call is recorded and not undone, because the vote and the timelock already happened. It does not run again. A new proposal is needed.

If the callback itself ever fails to run, the proposal stays in Executing. No method in this code moves it out of that stage. The 10 TGas reserved is five times the measured use, which is the protection.

### Upgrading code

Every contract has the same three steps. Anyone stages a build with `stage_code`, the members vote to deploy it by its hash, and after the timelock anyone executes. The vote is on the 32 byte hash, not on the wasm, which is why the 4,096 byte limit on call arguments does not matter. Members check the staged build before voting: `is_staged(code_hash)` says it is there, and each member builds the same source and compares the sha256 with the proposed hash.

| Contract being upgraded | Proposal | What runs |
|---|---|---|
| market, oracle, council | `function_call` to its `upgrade` method with `{"code_hash": "<base58>"}`, deposit 0, gas 100 TGas or more | `upgrade` takes the staged wasm out of storage and sends one batch to its own account: deploy the wasm, then call `migrate`. A `migrate` that panics reverts the deploy, and the old code stays. |
| This contract | `upgrade_self` with the same hash | `execute` takes the staged wasm out of storage and sends the same batch, then `on_executed`. Executing it needs 110 TGas attached to `execute`. |
| Key deletion on any of the four | `function_call` to `seal` on the other three, the `seal` action here | Deletes one access key. Refused until `upgrade_proven` is true. |

Stage costs: the caller pays 1 NEAR per 100 KB (a 250 KB build is about 2.5 NEAR). The deposit sits in the target contract. The staged copy is removed when the upgrade starts, so a failed upgrade needs the code staged again, and the NEAR stays in the contract. Staging with 250 KB burns about 31 TGas, so attach 100 TGas or more.

How a failed self-upgrade is recorded. `execute` marks the proposal Executing, removes the staged copy, and sends the deploy and migrate batch followed by `on_executed`. There are three outcomes.

| Outcome | What happens |
|---|---|
| `migrate` panics, the wasm has no `migrate`, or the batch runs out of gas | The whole batch reverts, so the old code is still deployed. `on_executed` runs in the old code, sees the failure and records ExecutionFailed with an `execution_failed` event. Tested in the sandbox with a wasm that has no `migrate`, and with another contract's wasm whose `migrate` cannot read this state. |
| The batch succeeds | The new code is live. `on_executed` runs in the new code and records Executed. The new code must still export `on_executed`, and must still read `Proposal` and `Stage` as they are stored now. |
| The batch succeeds and the new code has no `on_executed`, or reads the proposals differently | The upgrade is done and the proposal stays Executing for ever. Nothing can move it out. The `migrated` event in the same transaction is the record that the deploy happened. |

The third row is why this contract's own state layout has to stay compatible across its own upgrade. A new version that changes the stored layout of `GovernanceContract`, `Proposal` or `Action` must read the old layout in `migrate`. Before voting for an `upgrade_self`, check that the wasm exports `migrate` and `on_executed`.

How `migrate` works. The state struct starts with `state_version: u16`, 1 today. `migrate` reads the first two bytes of the stored state and refuses anything other than 1 (`migrate expects version 1`), then reads the state as the version 1 struct, sets `upgrade_proven` and returns it. It never guesses a layout from bytes. A version 2 build keeps a frozen copy of the version 1 struct as `StateV1`, reads that, builds its own state from it, writes `state_version: 2` and sets `upgrade_proven`. The unit test `migrate_keeps_the_state_and_marks_the_upgrade_proven` shows the pattern. The version check does not tell contracts apart: another contract's wasm with the same version number gets past it and fails when it cannot read the state.

`upgrade_proven` is false at deploy and true after the first upgrade that went through `migrate`. It is the gate on `seal`, so keys are deleted only after the path has been shown to work on this chain. The first upgrade can deploy the same code again with a changed hash, which proves the path without changing behaviour.

#### How to upgrade a contract safely

1. Build the new wasm from the published source and note its sha256.
2. Stage it on the target (`stage_code`, input is the wasm, deposit at least its storage cost, 100 TGas) and confirm with `is_staged`.
3. A member proposes the `function_call` (or `upgrade_self`) with that hash. The staged hash and the proposal can be checked by every member and by anyone else.
4. Members vote. The timelock starts at approval. This wait is the users' exit window: `withdraw` and `redeem` on market, and `unstake` and `claim` on council, never pause and are not touched by an upgrade, so anyone who does not trust the new code can withdraw a balance and redeem a resolved position before it runs. An open position is still locked until its market resolves, or until it is sold while trading is open.
5. After the timelock anyone executes with at least the call gas plus 14 TGas attached (110 TGas for `upgrade_self`).
6. Check `config`: `upgrade_proven` is true, `state_version` is what the new code says, and the `migrated` event is in the transaction.
7. Only after one upgrade has gone through, delete the deploy key with `seal`. Until then keep it, and treat it as a way around every rule in this file.

### Changing governance itself

Members, threshold and the three periods change only through the five non-call actions. A `function_call` aimed at this contract is refused, so there is no second route around the checks above. A removal cannot leave fewer members than the threshold. A threshold change cannot exceed the member count. Every settings change goes through the same vote and timelock as any other.

## Views

| View | Returns |
|---|---|
| `get_proposal(proposal_id)` | One proposal, or nothing. Shows `Expired` where it applies. |
| `list_proposals(from_index, limit)` | Up to 50 proposals starting at an id. |

Both views return the stored record with one more field, `execute_gas`: the gas an `execute` must carry. For a `function_call` it is the call's gas plus 14 TGas, for an `upgrade_self` it is 110 TGas, and for the other actions it is `null`, since any gas that fits the transaction will do.
| `get_members()` | The member accounts. |
| `config()` | state_version, upgrade_proven, threshold, voting_period_ns, timelock_ns, execution_window_ns, number of members, number of proposals. |
| `is_staged(code_hash)` | Whether that wasm is staged here. |

A proposal record holds: id, proposer, created_at, voting_ends_at, the action, every vote (member and yes or no), approved_at, the cancel votes, and the stage, with `execute_gas` beside them.

Governance caps the arguments of a call at 4,096 bytes. When the target takes a list, as council's `allow_tokens` does, a proposal carries fewer entries than the target would take in a direct call: about 4,096 divided by the length of an id plus 3.

## Events

Each logs `EVENT_JSON:` and JSON of the form `{"standard":"governance","version":"1.0.0","event":"<name>","data":{...}}`.

| Event | When | Data |
|---|---|---|
| `proposed` | A proposal is created | proposal_id, proposer, action, voting_ends_at |
| `voted` | A vote is cast | proposal_id, member, approve |
| `approved` | Yes votes reach the threshold | proposal_id, executable_at, expires_at |
| `cancel_voted` | A cancel vote | proposal_id, member |
| `cancelled` | Cancel votes reach the threshold | proposal_id |
| `call_sent` | A function call goes out | proposal_id, receiver_id, method_name |
| `executed` | The call, upgrade or key deletion succeeded | proposal_id |
| `execution_failed` | The target rejected the call, or the upgrade batch failed | proposal_id |
| `code_staged` | A wasm is staged | code_hash, bytes, by |
| `upgrade_sent` | An `upgrade_self` goes out | proposal_id, code_hash |
| `seal_sent` | A `seal` goes out | proposal_id, public_key |
| `migrated` | `migrate` ran in the new code | state_version |
| `member_added`, `member_removed` | Membership action executed | proposal_id, account |
| `threshold_changed` | Threshold action executed | proposal_id, threshold |
| `voting_period_changed`, `timelock_changed`, `execution_window_changed` | Period action executed | proposal_id, the new value |

## Security properties checked by tests

Only members can propose, vote or cancel; a stranger can execute but only an approved proposal past its timelock; nothing runs twice, including a second `execute` while the first call is in flight; the callback refuses a direct call; a removed member's earlier yes vote stops counting; a proposal approved by the threshold cannot be executed early or after its window; cancelling needs the threshold and only current members count; every action's checks run again at execution; a call's gas outside 5 to 250 TGas is refused when proposed, and when executed if the range ever changes; `execute` refuses less than a call's gas plus 14 TGas and works with exactly that; a stranger cannot initialise a deployed governance contract; settings changes and member changes are only reachable through proposals; an upgrade of this contract is recorded as failed when the batch fails and as executed when the new code answers; seal and upgrade are refused when they should be. See `AUDIT.md` for the measured attack runs.

## Things to know

| Topic | Detail |
|---|---|
| No veto | One yes vote short of the threshold is all that stands between a proposal and approval. Members who disagree must cancel during the timelock, and that needs the threshold's worth of them. |
| The timelock is only as useful as someone watching | A bad change is public on-chain for `timelock_ns`. Nothing alerts anyone. A watcher on the `approved` event is a deployment task. |
| Timelock and window changes reach old proposals | They are read at execution time. A change that executes while another proposal waits applies to that one too. |
| Failed calls are final | A target that rejects the call (wrong argument, wrong state) leaves ExecutionFailed. Re-propose. |
| Deposit comes from here | A call that attaches NEAR draws on this contract's own balance. |
| Whole-system trust | Everything the owner can do on market, oracle and council is controlled by whoever holds a threshold of member keys. The member count and threshold are the real security setting. |
| Access keys are a deployment matter | A full-access key on any of the four accounts bypasses every rule here, code upgrades included. Delete it with `seal` after the first upgrade has gone through, then check the account has no keys (`view_access_key_list` returns nothing). Until then the key is the weakest part of the system. |
| The order of the deployment steps | `DEPLOY.md` has the checklist: build and hashes, deploy and init in one batch, ownership handover, one proven upgrade on each account, then seal and a check that `view_access_key_list` is empty on all four. |
| A sealed account cannot be rescued | With no key and a buggy upgrade path, nothing but a governance upgrade can fix the code, so the first upgrade is proven before any key is deleted. |
| No outside audit | The only review is the self-review in `AUDIT.md`. |
