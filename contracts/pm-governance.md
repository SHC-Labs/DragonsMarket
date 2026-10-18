# pm-governance

Source: `pm-governance/src/lib.rs`. Written 2026-10-18 from the code as it stands. When this file and the code disagree, the code is right.

## What it is

pm-governance is a small multisig with a public delay. Up to five named accounts (the members) share the owner role of pm-market, pm-oracle and pm-council, so no single key can change a fee, a bond, a wallet or an operator.

A change goes through four steps: a member proposes it, members vote, an approved change waits out a timelock so everyone can see it coming on-chain, and then anyone can execute it. During the timelock, members can cancel it.

It holds no market money. Its only job is to be the owner account of the other contracts and to call them when its members agree.

## Where it sits among the other contracts

| Contract | Relationship to pm-governance |
|---|---|
| pm-market | Set as `owner_id`. Every owner-only method is reached by a `FunctionCall` proposal here. |
| pm-oracle | Same. |
| pm-council | Same. |
| Itself | Members, threshold and the three periods change only through proposals here (see "Changing governance itself"). |

pm-governance does not need to be the owner of all three, but the design assumes it is. Whether a deployed contract really has this account as owner is a deployment fact to check on-chain with each contract's `config` view, not something this code can promise.

## Roles: who can do what

| Role | Who | Can do |
|---|---|---|
| Member | 1 to 5 accounts, set in `new`, later changed by proposals | `propose`, `vote`, `cancel` |
| Anyone | Any account | `execute` (once the timelock has passed), and every view |
| The contract itself | n/a | `on_executed` (a callback, refuses everyone else) |

There is no owner, no admin and no operator in this contract. Nobody can change a setting except through an approved proposal.

## Starting it up: `new`

Called once, at deploy.

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
| Executing | A function call has been sent and its result has not come back yet. |
| Executed | Done. |
| ExecutionFailed | The call was sent and the target contract rejected it. The proposal is final. |
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
| `on_executed(proposal_id)` | The contract itself | Callback after a function call. Marks it Executed or ExecutionFailed. |

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

An action is one of seven kinds. JSON uses snake_case names.

| Action | Fields | Effect when executed |
|---|---|---|
| `function_call` | `receiver_id`, `method_name`, `args` (base64 bytes), `deposit` (yoctoNEAR), `gas` | Sends a function call from this contract to `receiver_id`. This is how owner-only methods on pm-market, pm-oracle and pm-council are used. |
| `add_member` | `account` | Appends a member. |
| `remove_member` | `account` | Removes a member. |
| `set_threshold` | `threshold` | Changes the approval and cancel threshold. |
| `set_voting_period` | `voting_period_ns` | Changes how long new proposals stay open. |
| `set_timelock` | `timelock_ns` | Changes the delay between approval and execution. |
| `set_execution_window` | `execution_window_ns` | Changes how long an approved proposal stays executable. |

### Checks on each action

The checks run when a proposal is created, and again at execution, because members or the threshold may have changed in between. A check that fails at execution reverts that call and leaves the proposal Approved until its window closes.

| Action | Check | Message |
|---|---|---|
| `function_call` | Receiver is not this contract | `governance changes itself only through its own actions` |
| `function_call` | Method name at most 256 bytes and args at most 4,096 bytes | `the call is too long` |
| `add_member` | Not already a member | `already a member` |
| `add_member` | Fewer than 5 members | `there can be at most 5 members` |
| `remove_member` | Is a member | `not a member` |
| `remove_member` | More members than the threshold | `removing a member would leave fewer members than the threshold` |
| `set_threshold` | Between 1 and the number of members | `threshold must be between 1 and the number of members` |
| the three period actions | Above zero | `periods must be positive` |

### Function calls in detail

The call goes out in the `execute` transaction. The `deposit` is taken from this contract's own balance, so the account must hold at least that much beyond what storage requires. The `gas` field is what the target receives. Gas rules:

| Item | Amount |
|---|---|
| Reserved for the callback | 10 TGas (measured use about 2 TGas) |
| Needed attached to `execute` | The call's own gas plus about 14 TGas. A 20 TGas call failed with 33 attached and worked with 34. |
| Measured use at the args cap with five votes | propose 4.3 TGas, a vote up to 2.2, a settings change 1.7, a call 3.0 plus 2.0 in the callback |

Once the call has gone out the stage is Executing, so a second `execute` is refused. When the target returns, the callback records Executed, or ExecutionFailed if the target contract failed. A failed call is recorded and not undone, because the vote and the timelock already happened. It does not run again. A new proposal is needed.

If the callback itself ever fails to run, the proposal stays in Executing. No method in this code moves it out of that stage. The 10 TGas reserved is five times the measured use, which is the protection.

### Changing governance itself

Members, threshold and the three periods change only through the five non-call actions. A `function_call` aimed at this contract is refused, so there is no second route around the checks above. A removal cannot leave fewer members than the threshold. A threshold change cannot exceed the member count. Every settings change goes through the same vote and timelock as any other.

## Views

| View | Returns |
|---|---|
| `get_proposal(proposal_id)` | One proposal, or nothing. Shows `Expired` where it applies. |
| `list_proposals(from_index, limit)` | Up to 50 proposals starting at an id. |
| `get_members()` | The member accounts. |
| `config()` | threshold, voting_period_ns, timelock_ns, execution_window_ns, number of members, number of proposals. |

A proposal record holds: id, proposer, created_at, voting_ends_at, the action, every vote (member and yes or no), approved_at, the cancel votes, and the stage.

## Events

Each logs `EVENT_JSON:` and JSON of the form `{"standard":"pm-governance","version":"1.0.0","event":"<name>","data":{...}}`.

| Event | When | Data |
|---|---|---|
| `proposed` | A proposal is created | proposal_id, proposer, action, voting_ends_at |
| `voted` | A vote is cast | proposal_id, member, approve |
| `approved` | Yes votes reach the threshold | proposal_id, executable_at, expires_at |
| `cancel_voted` | A cancel vote | proposal_id, member |
| `cancelled` | Cancel votes reach the threshold | proposal_id |
| `call_sent` | A function call goes out | proposal_id, receiver_id, method_name |
| `executed` | The call succeeded | proposal_id |
| `execution_failed` | The target rejected the call | proposal_id |
| `member_added`, `member_removed` | Membership action executed | proposal_id, account |
| `threshold_changed` | Threshold action executed | proposal_id, threshold |
| `voting_period_changed`, `timelock_changed`, `execution_window_changed` | Period action executed | proposal_id, the new value |

## Security properties checked by tests

Only members can propose, vote or cancel; a stranger can execute but only an approved proposal past its timelock; nothing runs twice, including a second `execute` while the first call is in flight; the callback refuses a direct call; a removed member's earlier yes vote stops counting; a proposal approved by the threshold cannot be executed early or after its window; cancelling needs the threshold and only current members count; every action's checks run again at execution; settings changes and member changes are only reachable through proposals. See `AUDIT.md` for the measured attack runs.

## Things to know

| Topic | Detail |
|---|---|
| No veto | One yes vote short of the threshold is all that stands between a proposal and approval. Members who disagree must cancel during the timelock, and that needs the threshold's worth of them. |
| The timelock is only as useful as someone watching | A bad change is public on-chain for `timelock_ns`. Nothing alerts anyone. A watcher on the `approved` event is a deployment task. |
| Timelock and window changes reach old proposals | They are read at execution time. A change that executes while another proposal waits applies to that one too. |
| Failed calls are final | A target that rejects the call (wrong argument, wrong state) leaves ExecutionFailed. Re-propose. |
| Deposit comes from here | A call that attaches NEAR draws on this contract's own balance. |
| Whole-system trust | Everything the owner can do on pm-market, pm-oracle and pm-council is controlled by whoever holds a threshold of member keys. The member count and threshold are the real security setting. |
| Access keys are a deployment matter | If the governance account kept a full-access key, that key would bypass every rule here. Check the deployed account's keys. |
| No outside audit | The only review is the self-review in `AUDIT.md`. |
