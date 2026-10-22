# Dragons Market: market contract implementation spec

**The complete function set the market contract needs for the accepted end-to-end product, with every existing method checked against the code and every missing method specified.**

| Field | Value |
| --- | --- |
| Date | 2026-10-21 |
| Status | Draft. Existing rows are checked in source. Rows marked NEW or CHANGED are PROPOSED |
| Scope | `contracts/market/src/lib.rs` and `contracts/market/src/curve.rs` |
| Source | Working tree on top of commit `6cad02e`, read 2026-10-21 09:06 to 09:38 |
| Revision checked | `market/src/lib.rs` sha256 prefix `6bed015aa459a237` (4122 lines, copied at 09:22 and compared again at 09:38). Phase I2 is editing this file, see [README section 2](README.md#2-how-to-read-these-specs) |
| Index | [README.md](README.md) |

**Build status, 2026-10-21.** BUILT in `contracts/market/src/lib.rs` (state version 2): sections 7.2, 7.3, 7.5's `locked_total`, and 7.6. Everything else in this file is unchanged and still PROPOSED. The owner's instruction that nothing the owner still has to choose may be written in the code changed three things against this text, noted where they apply.

| Item | Built as | Tests |
| --- | --- | --- |
| Rounding rule, both legs down, carry stays in `fees` (7.2) | `split_fees`, with the Council's share a setting | unit `the_split_rounds_both_parts_down_and_leaves_the_remainder_collected`, proptest `the_two_parts_and_the_remainder_always_add_up_to_the_total` (I-M7), sandbox `a_sweep_sends_25_percent_to_the_council_and_75_to_the_treasury_once` |
| Sweep ids and records, both legs written before either transfer (7.2) | `sweep_fees` returns `Option<U64>`, `Sweep` with `Leg { to, amount, status }` | unit `a_sweep_records_both_legs_before_it_sends_either_and_takes_the_next_id`, `a_sweep_below_the_minimum_does_nothing_and_takes_no_id`, `a_leg_with_nothing_in_it_is_settled_and_sends_nothing` |
| Independent leg status, no duplicate on retry (I-M4, I-M8) | `on_revenue_sent(sweep_id)`, `on_treasury_sent(sweep_id)`, each acting only on a `pending` leg | unit `a_leg_ends_once_whatever_the_callback_does_next`, proptest `fee_money_is_in_exactly_one_place_whatever_the_transfers_report`, sandbox `a_council_leg_that_fails_leaves_the_treasury_leg_alone_and_is_retried_once`, `a_council_that_refuses_the_revenue_gets_it_back_as_due_and_is_not_paid_twice` |
| `settle_leg` from the Council's `received_of` (7.2) | `settle_leg`, `on_council_checked` | unit `a_leg_whose_result_was_lost_is_settled_when_the_council_recorded_the_sweep`, `a_leg_whose_result_was_lost_is_due_again_when_the_council_has_no_record`, sandbox `a_revenue_transfer_the_verifier_refused_is_parked_and_not_paid_a_second_time` |
| `reconcile_leg` (7.2, OD-13) | Owner only, both legs, a pending or unresolved leg an hour after the sweep. It takes a `leg` argument and REPLACES `reconcile_revenue`, which would double-account a leg that `settle_leg` also settles and has no amount to act on in a deployment that never had sweeps without ids | unit `the_owner_returns_an_amount_that_never_arrived_to_due_and_the_next_sweep_sends_it_once`, `a_pending_leg_whose_callback_never_came_is_decided_by_the_owner_after_an_hour`, sandbox `settling_an_unresolved_amount_as_arrived_when_it_did_not_shows_up_as_surplus` |
| `claim_residual` onto the treasury leg (7.3) | `treasury_due`, no split | unit `the_residual_is_due_to_the_treasury_and_not_credited_to_the_owner`, sandbox `flow.rs` |
| `treasury` rename (7.6, OD-11) | `business_wallet` and `business_due` are `treasury` and `treasury_due` in code, config, events, docs and tests | source guard `no_contract_names_an_account_the_owner_has_still_to_choose` |
| `locked_total` (7.5) | `total_owed` is a constant-size sum | unit `assert_conserved` in the random trading proptest |
| `get_sweep`, `list_sweeps` (7.2) | views | sandbox `a_sweep_sends_25_percent_to_the_council_and_75_to_the_treasury_once` |

Not built (still PROPOSED): 7.1 pending withdrawals, 7.4 positions and `get_account`, `owed_breakdown` and `in_flight` from 7.5, the 7.7 gas floors for `retry_apply`, `withdraw` and `retry_register`.

Changes against the text above:

| Item | Spec | Built |
| --- | --- | --- |
| Fee recipients | `new` takes `revenue_pool` and `business_wallet` | `new` takes neither. They are `None` until the owner calls `set_fee_recipients(revenue_pool, treasury)`, and `sweep_fees` refuses until then. The two must differ |
| The split | Constants 2,500 and 7,500 | `revenue_share_bps`, 2,500 to start, owner-settable from 1,000 to 5,000 (`set_revenue_share_bps`). The treasury gets the rest, so the whole fee is always accounted for |
| Minimum sweep and first id | `set_min_sweep` only | Also `set_next_sweep_id`, which can only move up. `min_sweep` is 1 to 100,000,000 and starts at 1,000,000 |
| Settle and reconcile waits | 10 minutes and one hour | Stored, 10 and 60 minutes to start, owner-settable with `set_sweep_timing` within hard ranges (reconcile never under settle) |

---

## Contents

1. [Summary](#1-summary)
2. [Purpose and roles](#2-purpose-and-roles)
3. [Money flows in Intents terms](#3-money-flows-in-intents-terms)
4. [State](#4-state)
5. [Message grammar](#5-message-grammar)
6. [Methods that exist today](#6-methods-that-exist-today)
7. [Methods and changes required](#7-methods-and-changes-required)
8. [Views the website and keeper need](#8-views-the-website-and-keeper-need)
9. [Events](#9-events)
10. [Invariants](#10-invariants)
11. [Errors](#11-errors)
12. [Test evidence required](#12-test-evidence-required)

---

## 1. Summary

The market already runs on NEAR Intents. Money arrives through the verifier's `mt_transfer_call`, leaves through `mt_transfer` and `mt_transfer_call` from the market's own Intents account, and the contract registers no key in the verifier (Checked in source: `market/src/lib.rs:715`, `:872`, `:913`). The 25% and 75% fee split, the rounding rule and the independent transfer legs exist and have unit and sandbox tests. These parts are BUILT.

What the accepted product still needs from this contract:

| Gap | Why it matters | Section |
| --- | --- | --- |
| No record of pending withdrawals, fee legs or sweeps | R-02, R-03 and R-08 ask for recoverable, visible operation state. Today a debited withdrawal has no trace until its callback runs | 7.1, 7.2 |
| Council leg can only be reconciled by the owner | A wrong `arrived` answer pays the Council share twice out of user backing | 7.2 |
| `claim_residual` credits an internal balance of the treasury | A DAO treasury must then pass a function call proposal to move it. The money should take the same leg as the treasury share | 7.3 |
| No per-account position list and no aggregate account view | The website calls `get_shares` once per market | 7.4 |
| `total_owed` walks every market | A view that grows with market count is a risk for the keeper's reconciliation | 7.5 |
| The treasury is still called `business_wallet` | The accepted decision names a Trezu treasury | 7.6 |

The rest of this document lists every method, grammar, event, error and invariant so the team can build the whole contract and connect the website.

---

## 2. Purpose and roles

The market lists binary questions, prices every trade on a constant-product curve, holds all backing in its own Intents account, and pays holders after the oracle sets an outcome. It does not decide outcomes.

| Role | Set by | Powers |
| --- | --- | --- |
| Owner | `new`, then `propose_owner` and `accept_owner` | `upgrade`, `seal`, `propose_owner`, `set_operator`, `set_fee_recipients`, `set_fee_rate_bps`, `set_create_fee`, `set_void_rules`, `set_sweep_timing`, `set_open_price_bounds`, `set_max_positions`, `set_fee_limits`, `reconcile_revenue`, and everything the operator can do. DECIDED: the owner is the Trezu or SputnikDAO account, which the contract treats as a plain `AccountId` |
| Operator | `set_operator`, owner only | `create_market`, `retry_register`, `halt` (not in the last 24 hours before close), `resume`, `set_paused`, `claim_residual`, and seeding through the verifier |
| Oracle | `new`, no setter | `set_outcome` only |
| Verifier | `new`, no setter | `mt_on_transfer` only |
| Anyone | none | Trade from a registered account, `redeem`, `withdraw`, `sweep_fees`, `void_if_unresolved` after the grace period, `stage_code`, NEP-145 registration for any account, every view |

Checked in source: `market/src/lib.rs:260-306` (state), `:446-465` (owner and operator), `:587-669` (operator methods), `:674-708` (oracle and deadline). No contract may call, depend on or name a governance contract. The source guard test `contracts/tests/tests/guards.rs:151-191` enforces this (test exists, not run in this task).

---

## 3. Money flows in Intents terms

Every unit of collateral is the verifier balance `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (DECIDED, six decimals). The market keeps its funds in its own Intents account `M`. Other accounts in the table are Intents accounts too.

| Money | Where it sits | Counted by |
| --- | --- | --- |
| A user's free funds before funding | The user's own Intents account `U` | Nobody here. The user spends them |
| Funds the user deposited into the market but has not traded | `M`, counted in `balances[user]` | `balances_total` |
| Backing of open and unresolved markets | `M`, counted in `Market.locked` | sum of `locked` |
| Collected trade and creation fees | `M`, counted in `fees` | `fees` |
| Council share not yet sent or refused | `M`, counted in `revenue_due` | `revenue_due` |
| Treasury share not yet sent or refused | `M`, counted in `business_due` (NEW name `treasury_due`) | `business_due` |
| Council share whose result was lost | `M`, counted in `revenue_unresolved` | `revenue_unresolved` |
| Withdrawal in flight | `M` until the verifier moves it, then `U` | NEW `pending_withdrawals` |
| Surplus from a plain deposit | `M`, credited to nobody | difference between `mt_balance_of` and `total_owed` |

The verifier calls the market makes, all as itself with 1 yoctoNEAR and no signed intent:

| Purpose | Verifier call | Receiver | Source |
| --- | --- | --- | --- |
| Withdrawal | `mt_transfer(receiver_id=caller, token_id, amount, approval=null, memo=null)` | The caller's own Intents account | `lib.rs:872-891` |
| Council leg of a sweep | `mt_transfer_call(receiver_id=revenue_pool, token_id, amount, null, null, msg="revenue")` | The Council, which runs `mt_on_transfer` | `lib.rs:933-952` |
| Treasury leg of a sweep | `mt_transfer(receiver_id=business_wallet, token_id, amount, null, null)` | The treasury account | `lib.rs:952-970` |

Facts from the verifier proof that the design depends on (Reported in `INTENTS-PROOF.md`, tests exist in `intents_verifier.rs`, not run in this task):

- A plain deposit never notifies the receiver. It credits `M` and nothing else, so the market treats it as surplus.
- `mt_transfer_call` calls `mt_on_transfer` with the true sender. A panic or a malformed answer refunds the sender in full. The verifier call then returns `["0"]`.
- A contract with no access keys and predecessor authentication on pays out of its own balance by a cross-contract call. `public_keys_of(M)` must stay empty and `is_auth_by_predecessor_id_enabled(M)` must stay true.
- The verifier does not check that a receiver account exists. Payouts go only to accounts the market's own records name.
- A pause of the `mt_transfer` feature or a lock of `M` stops payouts. A locked `M` still receives.

Exit to another chain is not a market method. After `withdraw` the money is in `U`. The user then signs an Intents withdrawal or a 1Click swap from `U` and pays its fee (DECIDED: the user bears the withdrawal and swap fee). That step is outside every contract here and is UNVERIFIED on mainnet.

---

## 4. State

### 4.1 Contract fields

All EXISTING (`lib.rs:260-306`) except where marked.

| Field | Type | Meaning |
| --- | --- | --- |
| `state_version` | `u16` | First field. `migrate` reads exactly this layout (currently 1) |
| `upgrade_proven` | `bool` | Set by `migrate`. `seal` refuses until true |
| `upgrade_in_flight` | `bool` | Set by `upgrade`, cleared by `migrate` |
| `owner` | `AccountId` | The DAO |
| `pending_owner` | `Option<AccountId>` | Set by `propose_owner` |
| `operator` | `AccountId` | Fast key for routine work |
| `oracle` | `AccountId` | Only caller of `set_outcome` |
| `verifier` | `AccountId` | Only caller of `mt_on_transfer` |
| `collateral_token_id` | `String` | Exact `nep141:<contract>` string |
| `paused` | `bool` | Stops deposits, buys, seeds, new markets. Never stops `sell`, `withdraw` or `redeem` |
| `sells_paused` | `bool` | Owner only (`set_sells_paused`, event `sells_paused`). Stops `sell` (`sells are paused`). Added 2026-10-22 |
| `last_sweep_at` | `Option<u64>` | When the last sweep ran. `sweep_fees` refuses within `MIN_SWEEP_INTERVAL_NS` (1 hour) of it: `wait an hour since the last sweep`. Added 2026-10-22 |
| `fee_rate_bps` | `u128` | Trade fee rate, at most 500 |
| `create_fee` | `u128` | Creation fee taken from the seed, at most 10,000,000 |
| `next_market_id` | `u64` | Next id |
| `markets` | `LookupMap<u64, Market>` | One record per market |
| `balances` | `LookupMap<AccountId, u128>` | Deposited, untraded collateral |
| `balances_total` | `u128` | Sum of `balances` |
| `accounts` | `LookupMap<AccountId, u32>` | Presence means the NEP-145 deposit was paid. The number counts held positions |
| `shares` | `LookupMap<(u64, AccountId, u8), u128>` | Shares by market, account and side |
| `revenue_pool` | `AccountId` | The Council. Receives the 25% leg |
| `business_wallet` | `AccountId` | Receives the 75% leg. NEW name `treasury` |
| `fees` | `u128` | Collected fees not yet split |
| `revenue_due` | `u128` | Council share waiting to be sent |
| `business_due` | `u128` | Treasury share waiting to be sent |
| `revenue_unresolved` | `u128` | Council share whose result was lost |

### 4.2 Market record

`Market` (`lib.rs:143-171`): `title`, `rule_text`, `resolution_source`, `void_policy`, `category`, `subcategory`, `rule_hash`, `price_rule: Option<PriceRule>`, `close_at`, `resolve_by`, `halted`, `registered`, `seeded`, `outcome: Option<Outcome>`, `void_price_yes: Option<u128>`, `pool_yes`, `pool_no`, `locked`, `user_yes`, `user_no`, `residual_claimed`, `history: Vec<(u64, u32)>` (at most 120 points) and `twap: Option<Twap>`.

### 4.3 New fields (PROPOSED)

| Field | Type | Meaning |
| --- | --- | --- |
| `treasury` | `AccountId` | Rename of `business_wallet` |
| `treasury_due` | `u128` | Rename of `business_due` |
| `locked_total` | `u128` | Sum of every `Market.locked`, kept incrementally so `total_owed` is O(1) |
| `pending_withdrawals` | `LookupMap<AccountId, u128>` | Debited but not yet confirmed by the verifier |
| `pending_withdrawals_total` | `u128` | Sum of the map |
| `next_withdrawal_id` | `u64` | Counter used in the transfer memo `wd:<id>` |
| `positions` | `LookupMap<AccountId, Vec<u64>>` | Market ids in which the account holds shares, at most 20 entries |
| `min_sweep` | `u128` | Least total a sweep may act on. Default 1,000,000 (1 USDC). Owner setter, at most 100,000,000 |
| `next_sweep_id` | `u64` | Counter, first id 1 |
| `sweeps` | `LookupMap<u64, Sweep>` | One record per sweep, see below |

```text
Sweep { id: u64, at: u64, total: u128,
        carried_council: u128, carried_treasury: u128,
        council:  Leg { amount: u128, status: LegStatus },
        treasury: Leg { amount: u128, status: LegStatus } }
LegStatus = pending | settled | refused | unresolved
```

`total` is the part of `fees` this sweep split. `carried_council` and `carried_treasury` are amounts that earlier legs left in the due buckets after a refusal. A leg's `amount` is its share of `total` plus what was carried, so the two leg amounts can add up to more than `total`.

A leg is `pending` from the moment its transfer is sent until its callback runs. `settled` means the verifier reported the money kept by the Council, or reported no error for a plain transfer. `refused` means the verifier returned the money to the market and the amount went back to its due bucket. `unresolved` means the result was lost and nobody can tell where the money is. Only the Council leg can be `unresolved`, because only that leg uses `mt_transfer_call`.

---

## 5. Message grammar

`mt_on_transfer` splits `msg` on `:`. Extra parts after the last expected part are ignored (Checked in source: `lib.rs:738-779`).

```text
deposit
buy:<market_id>:<side>:<min_shares>
seed:<market_id>
seed:<market_id>:<yes_price_micro>
```

| Part | Type | Rule | Refusal text |
| --- | --- | --- | --- |
| `market_id` | `u64` decimal | Must parse | `bad market id` |
| `side` | `yes` or `no` | Lowercase | `side must be yes or no` |
| `min_shares` | `u128` decimal | Must parse and be above zero | `bad min shares`, `min shares must be above zero` |
| `yes_price_micro` | `u128` decimal | 10,000 to 990,000, millionths of one collateral unit | `bad starting price`, `the starting price must be between 1% and 99%` |
| other first part | any | Not one of the three actions | `unknown action` |

The first five checks run before the message is read, in this order (`lib.rs:723-737`): caller is the verifier, exactly one token and one amount, the token id is `collateral_token_id`, `previous_owner_ids == [sender_id]`, the amount is above zero. A refusal is a panic, so the verifier refunds the sender in full.

`seed` is allowed only when `sender_id` is the owner or the operator. `deposit` and `buy` need a registered sender (`do the storage deposit first`). `deposit`, `buy` and `seed` refuse while `paused`.

No new message is needed. A future `fund:<account>` form is OPEN and not recommended: it would let a sender credit another account, which breaks the single identity rule (the credited account is always `sender_id`).

---

## 6. Methods that exist today

Gas floors are the attached gas the contract itself refuses to run below. Where none is listed, the contract has no floor and the figure in the Gas column is the least that worked in the sandbox or the reserve the code attaches to its own calls. Line numbers are for the 09:22 copy.

### 6.1 Setup, ownership and code

| Method | Caller | Args | Returns | Yocto | Gas | Behaviour and refusals | Events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `new` (`:356`) | The account itself, in a deploy and init batch | `owner_id`, `operator_id`, `oracle_id`, `verifier_id: AccountId`, `collateral_token_id: String`, `revenue_pool`, `business_wallet: AccountId` | contract | none | n/a | Refuses an id that does not start with `nep141:`. Private and init | none |
| `stage_code` (`:401`) | Anyone | wasm bytes as call input | `Base58CryptoHash` | payable, storage cost | 100 TGas for 250 KB | Stores the wasm under its own sha256. Refuses an empty call or too small a deposit | `code_staged` |
| `upgrade` (`:414`) | Owner | `code_hash: Base58CryptoHash` | `Promise` | none | 100 TGas floor | Deploys the staged code and calls `migrate` in one batch. A panicking `migrate` reverts the deploy. Refuses a hash nobody staged | `upgrade_sent` |
| `migrate` (`:427`) | The account itself | none | contract | none | 30 TGas reserved | Reads exactly `state_version` 1. Refuses unless `upgrade` set the mark | `migrated` |
| `seal` (`:438`) | Owner | `public_key: PublicKey` | `Promise` | none | none | Deletes one access key. Refused until `upgrade_proven` | `seal_sent` |
| `propose_owner` (`:446`) | Owner | `new_owner: AccountId` | none | none | none | Names the next owner. Nothing changes until acceptance | `owner_proposed` |
| `accept_owner` (`:452`) | The proposed account | none | none | none | none | Completes the handover | `owner_changed` |
| `set_operator` (`:461`) | Owner | `operator_id: AccountId` | none | none | none | Replaces the operator at once | `operator_set` |

### 6.2 Running markets

| Method | Caller | Args | Returns | Yocto | Gas | Behaviour and refusals | Events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `create_market` (`:467`) | Operator or owner | `title`, `rule_text`, `resolution_source`, `void_policy`, `category`, `subcategory: String`, `close_at`, `resolve_by: U64`, `price_rule: Option<PriceRule>` | `U64` market id | none | 100 TGas used by tests (20 reserved for the oracle call, 10 for the callback) | Hashes the rule, stores the market unregistered and asks the oracle to register it. Refuses while paused, empty or oversized text, bad slugs, a `close_at` in the past, `resolve_by` not after `close_at`, a price rule observed before close or at or after `resolve_by`, strike zero, more than 18 decimals | `market_created` |
| `retry_register` (`:568`) | Operator or owner | `market_id: U64` | none | none | 30 TGas | Sends the oracle registration again. Refuses an already registered market | none |
| `on_registered` (`:576`) | The account itself | `market_id: U64` | none | none | 10 TGas | Marks the market registered when the oracle accepted it | `market_registered` |
| `halt` (`:587`) | Operator or owner | `market_id: U64`, `reason: String` | none | none | none | Stops trading. The operator cannot halt in the last 24 hours before close, or after close. Refuses a resolved market | `market_halted` |
| `resume` (`:605`) | Operator or owner | `market_id: U64` | none | none | none | Lifts a halt. Refuses a resolved market | `market_resumed` |
| `set_paused` (`:616`) | Operator or owner | `paused: bool` | none | none | none | Stops deposits, buys, seeds and market creation. Not `sell` | `paused` |
| `claim_residual` (`:651`) | Operator or owner | `market_id: U64` | none | none | none | After resolution, moves what the pool holds beyond what holders are owed into the internal balance of `business_wallet`. Once per market. Refuses an unresolved market and a second claim | `residual_claimed` |
| `set_outcome` (`:674`) | Oracle | `market_id: U64`, `outcome: Outcome` | none | none | 20 TGas reserved by the oracle | Records `yes`, `no` or `void`. Repeating the same answer does nothing. Refuses before close and a different answer | `outcome_set` |
| `void_if_unresolved` (`:695`) | Anyone | `market_id: U64` | none | none | none | Voids a market 7 days after `resolve_by` when the oracle never answered. Void pays the closing price | `outcome_set` with `by: "deadline"` |

### 6.3 Money in, trading and money out

| Method | Caller | Args | Returns | Yocto | Gas | Behaviour and refusals | Events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mt_on_transfer` (`:715`) | The verifier | `sender_id: AccountId`, `previous_owner_ids: Vec<AccountId>`, `token_ids: Vec<String>`, `amounts: Vec<U128>`, `msg: String` | `Vec<U128>`, always `["0"]` | none | The receiver gets the attached gas minus about 20.5 TGas | Section 5. A panic refunds the sender in full | `deposit`, `buy`, `market_seeded` |
| `buy` (`:787`) | A registered account | `market_id: U64`, `side: String`, `amount: U128`, `min_shares: U128` | none | exactly 1 | 100 TGas used by the website | Spends balance held here. Debit and trade are one receipt, so a refusal restores the balance | `buy` |
| `sell` (`:796`) | A registered account | `market_id: U64`, `side: String`, `collateral_out: U128`, `max_shares_in: U128` | none | exactly 1 | 100 TGas used by the website | Takes `collateral_out` from the pool, keeps the fee and credits the rest to the seller's balance. Refuses `price moved, would need more shares than your maximum` | `sell` |
| `redeem` (`:839`) | Anyone with shares | `market_id: U64` | `U128` payout | none | none | After resolution turns all of the caller's shares in that market into balance. No deadline. Never pauses | `redeemed` |
| `withdraw` (`:872`) | Anyone with a balance | `amount: U128` | `Promise` | exactly 1 | 25 TGas reserved plus own work, 100 used by tests | Debits first, then `mt_transfer` to the caller's own Intents account. Never pauses. Refuses zero and `not enough balance` | `withdraw`, then `withdraw_failed` if the verifier refused |
| `on_withdraw` (`:893`) | The account itself | `account: AccountId`, `amount: U128` | none | none | 10 TGas | An error means the verifier receipt failed and nothing moved. Credits the balance back | `withdraw_failed` |

### 6.4 Fees

| Method | Caller | Args | Returns | Yocto | Gas | Behaviour and refusals | Events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sweep_fees` (`:913`) | Anyone | none | none | none | 87 TGas floor (`:64-66`) | Splits `fees` into `floor(fees * 2500 / 10000)` for the Council and `floor(fees * 7500 / 10000)` for the treasury, adds each to its due bucket, keeps the remainder in `fees`, zeroes each due bucket and sends it. With nothing due it does nothing | `fees_swept` |
| `on_revenue_sent` (`:977`) | The account itself | `amount: U128` | none | none | 10 TGas | `[kept]` returns `amount - kept` to `revenue_due`. A list that is not one entry, or an error, parks the whole amount in `revenue_unresolved` | `fee_transfer_failed`, `fee_transfer_unresolved` |
| `reconcile_revenue` (`:1002`) | Owner | `amount: U128`, `arrived: bool` | none | none | none | Settles parked revenue in parts. `arrived` true drops it, false makes it due again. Refuses zero and more than is unresolved | `revenue_reconciled` |
| `on_business_sent` (`:1017`) | The account itself | `amount: U128` | none | none | 10 TGas | An error restores the amount to `business_due` | `fee_transfer_failed` |
| `set_fee_recipients` (`:622`) | Owner | `revenue_pool: AccountId`, `business_wallet: AccountId` | none | none | none | Takes effect for the next sweep and for amounts still owed | `fee_recipients_set` |
| `set_fee_rate_bps` (`:632`) | Owner | `fee_rate_bps: u32` | none | none | none | Refuses above 500 | `fee_rate_set` |
| `set_create_fee` (`:642`) | Owner | `create_fee: U128` | none | none | none | Refuses above 10,000,000 | `create_fee_set` |

The sweep floor in the code is 87 TGas (42 for the Council transfer call, 15 and 10 for the treasury transfer and its callback, 10 for the Council callback and 10 for the call itself). The comment at `lib.rs:910` still says 95, and `keeper/keeper.mjs:56` repeats it. The sandbox test asserts 87 (`gas_floors.rs:296-306`). The code is right and the comments are stale.

### 6.5 Views and NEP-145

| Method | Args | Returns | Notes |
| --- | --- | --- | --- |
| `config` (`:1034`) | none | JSON object | `state_version`, `upgrade_proven`, `upgrade_in_flight`, `owner`, `pending_owner`, `operator`, `oracle`, `verifier`, `collateral_token_id`, `paused`, `markets` (string), `storage_deposit` (string yocto), `max_positions`, `fee_rate_bps` (number), `create_fee` (string), `revenue_pool`, `business_wallet`, `revenue_unresolved` (string) |
| `get_fees` (`:1044`) | none | JSON object | `collected`, `revenue_due`, `business_due`, `revenue_unresolved`, all strings |
| `total_owed` (`:1056`) | none | `U128` | `balances_total + sum(locked) + fees + revenue_due + business_due + revenue_unresolved`. Walks every market |
| `is_registered` (`:1049`) | `account_id` | `bool` | NEP-145 registered |
| `get_balance` (`:1064`) | `account_id` | `U128` | Deposited, untraded balance |
| `get_shares` (`:1068`) | `market_id: U64`, `account_id` | `(U128, U128)` | Yes and No shares |
| `get_market` (`:1078`) | `market_id: U64` | `Option<MarketView>` | See [website-abi.md](website-abi.md#4-market-views) |
| `list_markets` (`:1082`) | `from_index: U64`, `limit: U64` | `Vec<MarketView>` | At most 50 per call |
| `get_history` (`:1090`) | `market_id: U64` | `Vec<PricePoint>` | At most 120 points, oldest first |
| `quote_buy` (`:1106`) | `market_id: U64`, `side`, `amount: U128` | `{shares_out, fee}` | Zeros when impossible |
| `quote_sell` (`:1129`) | `market_id: U64`, `side`, `shares: U128` | `{collateral_out, shares_in, fee}` | Zeros when impossible |
| `check_invariant` (`:1156`) | `market_id: U64` | `bool` | Locked equals shares outstanding while trading, covers payouts after resolution |
| `is_staged` (`:1030`) | `code_hash` | `bool` | Whether that wasm is staged |
| `storage_deposit` (`:1175`) | `account_id: Option<AccountId>`, `registration_only: Option<bool>` | `StorageBalance` | Payable, at least 0.05 NEAR for a new account, surplus returns to the payer. The body must be a JSON object, send `{}` for neither argument |
| `storage_withdraw` (`:1196`) | `amount: Option<NearToken>` | `StorageBalance` | 1 yocto. Refuses any amount above zero |
| `storage_unregister` (`:1212`) | `force: Option<bool>` | `bool` | 1 yocto. Refuses `force: true`, held shares and a balance |
| `storage_balance_bounds` (`:1234`) | none | `StorageBalanceBounds` | `min` and `max` both 0.05 NEAR |
| `storage_balance_of` (`:1241`) | `account_id` | `Option<StorageBalance>` | `{total: 0.05 NEAR, available: 0}` or null |

### 6.6 Behaviour that Phase I2 may still change

| Item | Observed | Action |
| --- | --- | --- |
| The `mt_on_transfer` one token and one amount check | Added at `lib.rs:727-730` at 09:11, after the first copy | The 09:22 and 09:38 copies have it |
| The halt refusal text | At 09:21 `lib.rs:594` said `a halt in the last day before close is a governance action`, which the unit tests (`lib.rs:2972`, `:2981`), `attacks.rs:1400`, the manual and the source guard (`guards.rs:179-191`, which forbids the word in code strings) all contradict. At 09:37 the line read `an owner action` again | The file moved while it was being read. I2 to confirm the final text before the build is frozen |

---

## 7. Methods and changes required

### 7.1 Pending withdrawals (R-02, R-08)

PROPOSED. Today `withdraw` debits the balance and its callback restores it on error. Between the two there is no record, so the user cannot tell a debit in flight from a loss, and `total_owed` drops before the verifier balance does.

| Item | Specification |
| --- | --- |
| `withdraw(amount: U128)` CHANGED | Before sending, adds `amount` to `pending_withdrawals[caller]` and `pending_withdrawals_total`, takes `id = next_withdrawal_id`, and sends `mt_transfer` with `memo: Some("wd:<id>")`. The memo appears in the verifier's transfer event, so an indexer can match the confirmation to the request. Emits `withdraw {account, amount, id}` |
| `on_withdraw(account, amount, id)` CHANGED | Subtracts from the pending map first. On error restores the balance and emits `withdraw_failed {account, amount, id}`. On success emits `withdraw_confirmed {account, amount, id}` |
| `get_account(account_id) returns AccountView` NEW | `{registered: bool, available: U128, pending_withdrawals: U128, positions: u32}` |

`total_owed` includes `pending_withdrawals_total`. This keeps `total_owed` equal to the verifier balance until the verifier receipt lands, and the keeper compares only when `in_flight()` reports zero (section 7.5).

The callback has 10 TGas reserved. A lost callback is not a realistic state: `mt_transfer` returns nothing and either completes or fails inside one verifier receipt, so the callback sees a definite answer. The pending entry would stay only if the callback itself ran out of gas. The floor for `withdraw` becomes 25 TGas plus the contract's own work. OPEN: an owner method to clear an entry that stays pending beyond one hour, after the keeper has matched the memo in the verifier event log. Recommended default: not built in the first release.

### 7.2 Sweep ledger and independent legs (R-03)

PROPOSED. The current sweep already records both allocations before it sends either, keeps the legs in separate due buckets, and never lets one leg's failure change the other. What it lacks is an identity for each sweep, a visible status for each leg, and a way to settle a lost Council result without trusting the owner.

**Rounding rule (PROPOSED, matches the built code).** For a sweep over `total` units of the six-decimal collateral:

```text
council  = floor(total * 2500 / 10000)
treasury = floor(total * 7500 / 10000)
carry    = total - council - treasury        // 0 or 1 unit, stays in `fees`
```

Both legs round down. The carry is at most one unit and goes to neither leg. It stays in `fees` and joins the next sweep, so it is never lost and never paid early. The sandbox test shows it: a bucket of 1,095,193 units gave 273,798 to the Council, 821,394 to the treasury and left 1 in `fees` (`gas_floors.rs:296-318`).

| Total | Council | Treasury | Carry |
| --- | --- | --- | --- |
| 1,095,193 | 273,798 | 821,394 | 1 |
| 100 | 25 | 75 | 0 |
| 7 | 1 | 5 | 1 |
| 3 | 0 | 2 | 1 |

Alternative considered: give the carry to the treasury leg so `fees` always empties. Rejected as the default because it changes tested behaviour for at most 3 units a sweep and gains nothing.

**Sweep records.**

| Item | Specification |
| --- | --- |
| `sweep_fees()` CHANGED | Returns `Option<U64>`. When `fees + revenue_due + treasury_due` is below `min_sweep` it returns `None` and changes nothing. Otherwise it takes `id = next_sweep_id`, splits `fees` as above, adds each part to its due bucket, stores `Sweep {id, at, total, council, treasury}` with both legs `pending`, zeroes each due bucket and sends. The Council leg uses `msg = "revenue:<id>"`. Emits `fees_swept {id, total, revenue_pool, council, treasury_account, treasury}`. The gas floor stays 87 TGas |
| `on_revenue_sent(id, amount)` CHANGED | Same report rules as today. `[kept]` equal to the amount sets the leg `settled`. A partial or zero report sets it `refused` and returns the rest to `revenue_due`. An error or a malformed list sets it `unresolved` and parks the amount in `revenue_unresolved` |
| `on_treasury_sent(id, amount)` CHANGED | Replaces `on_business_sent`. An error sets the leg `refused` and restores `treasury_due`. Otherwise `settled` |
| `settle_leg(sweep_id: U64)` NEW | Anyone. Refuses unless the Council leg is `unresolved` and `now >= sweep.at + 10 minutes`. Sends the Council a call to `received_of(sweep_id)`. The callback reads the answer: a record with the same amount sets the leg `settled` and removes the amount from `revenue_unresolved`. No record sets it `refused` and returns the amount to `revenue_due`. Gas 30 TGas |
| `reconcile_revenue(amount, arrived)` | Stays as the owner fallback for amounts that predate sweep ids. After this change no new amount can enter `revenue_unresolved` that `settle_leg` cannot settle |
| `get_sweep(sweep_id: U64)` NEW | `Option<SweepView>` |
| `list_sweeps(from_index: U64, limit: U64)` NEW | At most 50, oldest first |
| `set_min_sweep(min_sweep: U128)` NEW | Owner only, at most 100,000,000 |

**Why this removes the double payment.** The Council records each `sweep_id` it takes in and refuses a repeat. A retry of a refused amount joins a later sweep with a new id, so no amount is ever sent under two ids while one of them might have arrived, because an unresolved amount waits until `settle_leg` has read the Council's own record. Without a sweep id, a wrong `arrived: false` from the owner makes the next sweep pay the Council twice out of user backing. This is the failure that finding C-13 described, now closed without trusting a person.

**What is not covered.** The treasury leg has no receiver to ask. A plain `mt_transfer` either completes or fails as one verifier receipt, so its callback answer is definite. If the callback itself never runs, the leg stays `pending`. The keeper matches the verifier event and the owner can set it with `reconcile_leg(sweep_id, arrived)` (NEW, owner only, refused unless the leg is `pending` and older than one hour). OPEN whether to build it in the first release. Recommended default: build it, it is about 20 lines.

**Cost.** One record per sweep, about 120 bytes at 1 NEAR per 100 KB. The `min_sweep` floor bounds the record count by the fees collected divided by 1 USDC. A prune method is not needed before about 10,000 sweeps.

### 7.3 Residual and treasury payments (R-03)

PROPOSED. `claim_residual` today credits `balances[business_wallet]` (`lib.rs:651-669`). The treasury is a DAO account, so it would have to submit a function call proposal to `withdraw` its own money, with 1 yocto attached. That makes routine revenue depend on a vote.

| Item | Specification |
| --- | --- |
| `claim_residual(market_id)` CHANGED | Moves the residual from `Market.locked` into `treasury_due` instead of `balances`. The next sweep pays it on the treasury leg. The residual is not split 75/25 |
| Policy for the owner | The residual is the seed's leftover plus the pool's profit after resolution. OPEN whether it counts as earned platform revenue. Recommended default: treasury only, no split, because the seed came from the operator and is returned capital plus liquidity provider profit |

### 7.4 Positions and account views (R-08)

PROPOSED. The website calls `get_shares` for every market to find a user's positions (`web/app/portfolio/page.tsx:38-43`). The account holds at most 20 positions, so an on-chain index is cheap.

| Item | Specification |
| --- | --- |
| `positions` map | Updated in `add_shares` and `take_shares` when an account first holds or fully leaves a market. At most 20 market ids, which fits the flat 0.05 NEAR deposit |
| `get_positions(account_id: AccountId)` BUILT | `Vec<PositionView>`, each `{market_id: U64, yes: U128, no: U128, status: String, outcome: Option<Outcome>, redeemable: U128}`. `redeemable` is the exact payout when `outcome` is set, otherwise `"0"`. No mark to market value is computed on chain |
| `get_account(account_id)` NEW | `AccountView` as in 7.1 |

### 7.5 Reconciliation views (R-08)

PROPOSED. The keeper must compare `total_owed` with the verifier balance read at the same finalized block. Two problems today: `total_owed` walks every market (`lib.rs:1056-1062`) and nothing says whether a transfer is in flight.

| Item | Specification |
| --- | --- |
| `locked_total` | Updated wherever `Market.locked` changes: seed, buy, sell, redeem, `claim_residual`. `total_owed` becomes a constant-size sum |
| `owed_breakdown()` NEW | `{balances, locked, fees, revenue_due, treasury_due, unresolved, pending_withdrawals, total}`, all `U128` |
| `in_flight()` NEW | `{withdrawals: U128, withdrawal_count: u32, legs: U128, leg_count: u32}`. A leg counts while its status is `pending` |

The comparison rule: when `in_flight()` is zero on two reads one block apart, `mt_balance_of(market, collateral)` must equal `total_owed()`. More in the verifier is surplus that nobody is credited for. Less is an incident.

View gas: the 200 TGas view limit and the cost of each market read were not measured (UNVERIFIED). The O(1) counter removes the question.

### 7.6 Treasury naming (R-03)

PROPOSED. Nothing is deployed, so a state layout change needs no migration. Rename `business_wallet` to `treasury` in `new`, `set_fee_recipients(revenue_pool, treasury)`, `config`, `get_fees` (`treasury_due`), the events and the manual. The accepted decision names a Trezu treasury, and the current word invites the reading of a payout wallet, which the decision rejects. The treasury account id is not known yet and must not be guessed (DECIDED: configured by the owner after the DAO exists and is verified).

### 7.7 Smaller items

| Item | Status | Specification |
| --- | --- | --- |
| `retry_apply`, `withdraw`, `retry_register` gas floors | PROPOSED | The audit left these without a floor. Add `upgrade::require_gas` with 25, 25 and 30 TGas |
| Event for `set_paused` reasons | OPEN | Not needed |
| Market size cap on chain | OPEN, see README OD-14 | Operating control today |

---

## 8. Views the website and keeper need

R-08 asks the interface to separate available, committed, pending, accrued, claimable and paid amounts. The market contributes these:

| Quantity | Source | Status |
| --- | --- | --- |
| Free funds in the user's own Intents account | Verifier `mt_balance_of(account, token_id)` | EXISTING (verifier) |
| Available in the market (deposited, untraded) | `get_balance`, `get_account.available` | EXISTING, NEW |
| Committed backing of a market | `MarketView.locked` | EXISTING |
| A user's positions and redeemable amount | `get_positions` | BUILT |
| Pending withdrawal | `get_account.pending_withdrawals`, events `withdraw`, `withdraw_confirmed`, `withdraw_failed` | NEW |
| Fees collected, split, in flight | `get_fees`, `get_sweep`, `list_sweeps`, `in_flight` | EXISTING, NEW |
| Reconciliation state | `owed_breakdown`, `total_owed`, `in_flight` | NEW |
| Operation states | `LegStatus` in `SweepView`, the events in section 9 | NEW |

Quarter, accrued, claimable and paid reward amounts belong to the Council, see [council.md](council.md#8-views-the-website-and-keeper-need).

---

## 9. Events

Envelope: `EVENT_JSON:{"standard":"market","version":"1.0.0","event":"<name>","data":{...}}`. Every number in `data` is a decimal string unless noted. Checked in source: `emit` at `lib.rs:329-334`.

| Event | Data | Status |
| --- | --- | --- |
| `code_staged` | `code_hash`, `bytes`, `by` | EXISTING |
| `upgrade_sent` | `code_hash` | EXISTING |
| `migrated` | `state_version` (number) | EXISTING |
| `seal_sent` | `public_key` | EXISTING |
| `owner_proposed` | `owner`, `proposed` | EXISTING |
| `owner_changed` | `from`, `to` | EXISTING |
| `operator_set` | `operator` | EXISTING |
| `market_created` | `market_id`, `rule_hash` | EXISTING |
| `market_registered` | `market_id` | EXISTING |
| `market_halted` | `market_id`, `reason` | EXISTING |
| `market_resumed` | `market_id` | EXISTING |
| `paused` | `paused` (boolean) | EXISTING |
| `fee_recipients_set` | `revenue_pool`, `business_wallet` (NEW name `treasury`) | EXISTING, CHANGED |
| `fee_rate_set` | `fee_rate_bps` (number) | EXISTING |
| `create_fee_set` | `create_fee` | EXISTING |
| `min_sweep_set` | `min_sweep` | NEW |
| `residual_claimed` | `market_id`, `amount`, `to` | EXISTING |
| `outcome_set` | `market_id`, `outcome`, optional `by` | EXISTING |
| `deposit` | `account`, `amount` | EXISTING |
| `buy` | `market_id`, `account`, `side`, `shares`, `collateral`, `fee` | EXISTING |
| `sell` | `market_id`, `account`, `side`, `shares`, `collateral`, `fee` | EXISTING |
| `redeemed` | `market_id`, `account`, `amount` | EXISTING |
| `withdraw` | `account`, `amount`, NEW `id` | EXISTING, CHANGED. Emitted before the transfer, so it means requested |
| `withdraw_confirmed` | `account`, `amount`, `id` | NEW |
| `withdraw_failed` | `account`, `amount`, NEW `id` | EXISTING, CHANGED |
| `fees_swept` | `revenue_pool`, `revenue`, `business_wallet`, `business` today. NEW: `id`, `total`, `council`, `treasury`, `treasury_account` | EXISTING, CHANGED |
| `fee_transfer_failed` | `to`, `amount`, NEW `id`, `leg` | EXISTING, CHANGED |
| `fee_transfer_unresolved` | `to`, `amount`, NEW `id` | EXISTING, CHANGED |
| `fee_leg_settled` | `id`, `leg`, `amount` | NEW |
| `revenue_reconciled` | `amount`, `arrived` (boolean), `unresolved` | EXISTING |
| `market_seeded` | `market_id`, `amount`, `fee`, `yes_price`, `seeder` | EXISTING |
| `registered` | `account`, `paid_by` | EXISTING |
| `unregistered` | `account` | EXISTING |

An indexer must treat `withdraw` as a request, not as a payout. The existing event name says otherwise. Proposed rename is not needed if `withdraw_confirmed` exists.

---

## 10. Invariants

| Invariant | Statement | Test status |
| --- | --- | --- |
| I-M1 conservation of backing | For each open market, `locked == pool_yes + user_yes == pool_no + user_no`. After resolution `locked >= owed` | `check_invariant`, proptest `lib.rs:1767`, sandbox `flow.rs:7` (tests exist, not run) |
| I-M2 reconciliation | With nothing in flight, `mt_balance_of(M, token) >= total_owed`. Equality means no surplus. Less is an incident | `intents_market.rs:54` (test exists, not run). Needs the NEW `in_flight` rule |
| I-M3 one unit, one place | Each unit of a fee is in exactly one of `fees`, `revenue_due`, `treasury_due`, `revenue_unresolved`, a pending leg, or gone | proptest `lib.rs:3631` (test exists, not run) |
| I-M4 independent legs | A failed or unresolved leg changes only its own bucket | `hardening.rs:500`, `:606` (tests exist, not run) |
| I-M5 no spending by others | `public_keys_of(M)` is empty and `is_auth_by_predecessor_id_enabled(M)` is true | `intents_market.rs:54` asserts it once. The keeper must assert it on every run |
| I-M6 exits stay open | `withdraw` and `redeem` work while paused or halted | `intents_market.rs:480`, `upgrade.rs:275` (tests exist, not run) |
| I-M7 split rule | `council + treasury + carry == total`, `carry <= 1` | NEW proptest |
| I-M8 sweep ids | Sweep ids are unique and each leg ends in `settled` or `refused` | NEW test |

---

## 11. Errors

Exact panic strings (Checked in source: `require!` and `panic_str` in `market/src/lib.rs`). The website maps them in `web/lib/errors.ts`.

| Group | Strings |
| --- | --- |
| Access | `owner only`, `operator or owner only`, `oracle only`, `not the proposed owner`, `only the verifier can deliver money`, `a halt in the last day before close is an owner action` (see 6.6) |
| Verifier delivery | `exactly one token and amount`, `wrong token`, `the money must come from the sender's own balance`, `amount must be positive`, `unknown action`, `bad market id`, `bad min shares`, `bad starting price` |
| Registration | `do the storage deposit first`, `attach at least 0.05 NEAR`, `the account is not registered`, `nothing above the 0.05 NEAR deposit to withdraw`, `force is not supported, redeem your shares and withdraw your balance first`, `redeem or sell your positions first`, `withdraw your balance first` |
| Market state | `no such market`, `market is not registered with the oracle yet`, `market has no liquidity yet`, `market is halted`, `market is resolved`, `market is closed`, `market has not closed`, `already resolved`, `not resolved`, `not resolved yet`, `already registered`, `already seeded`, `already claimed`, `paused` |
| Trading | `side must be yes or no`, `min shares must be above zero`, `cannot buy that amount`, `cannot sell that amount`, `price moved, you would get fewer shares than your minimum`, `price moved, would need more shares than your maximum`, `not enough balance`, `not enough shares`, `nothing to redeem`, `too many positions, redeem or sell one first` |
| Creation and seed | `title is required` and the three like it, `text is too long`, `category and subcategory must be lowercase slugs of up to 32 characters`, `close_at must be in the future`, `resolve_by must be after close_at`, `observation_time must not be before close_at`, `observation_time must be before resolve_by`, `a price rule needs a strike above zero and at most 18 decimals`, `the seed must be more than the creation fee`, `seed too large`, `the starting price must be between 1% and 99%`, `the seed is too small to open at that price` |
| Fees | `the fee rate is capped at 500 basis points`, `the creation fee is capped at 10 units`, `that is more than is unresolved`, and the gas refusal `attach at least 87 TGas: a sweep sends the Council its part and the business wallet its part` |
| Upgrade | `there is no state to migrate`, `migrate runs only inside an upgrade`, `prove the upgrade path before deleting keys`, `no code is staged under that hash`, `attach at least 100 TGas to upgrade` |
| Internal | `invariant broken`, `hash failed`, `a voided market has no closing price` |

New strings (PROPOSED): `no sweep to settle`, `the leg is not unresolved`, `wait 10 minutes after the sweep before settling`, `the leg is not pending`, `the sweep total is below the minimum`.

---

## 12. Test evidence required

Existing tests listed here were not run in this task. A requirement becomes complete only when its tests run on the exact build.

| Requirement | Evidence that exists | Evidence still required |
| --- | --- | --- |
| R-01 funding bound to the sender | `intents_market.rs:150` (refused message refunded), `:189` (other token refused), `:270` (hook checks delivery), `:382` (plain deposit is surplus); unit tests `lib.rs:3193-3303` | A run with the real USDC contract, not `mock-ft`. A keeper test that fails when `public_keys_of(M)` is not empty |
| R-02 buy, sell, redeem, withdraw reconcile | `intents_market.rs:54`, `:436` (refused withdrawal restores balance), `:480`; `attacks.rs:646` (two withdrawals cannot spend one balance) | Pending withdrawal records: a withdrawal refused by a paused verifier shows `pending`, then `failed`. A callback gas starvation test. A `total_owed` equals verifier test using `in_flight` |
| R-03 split, rounding, legs | `revenue.rs:95`, `:154`; `hardening.rs:500`, `:581`, `:606`; `attacks.rs:672` (two sweeps pay once); unit `lib.rs:1858`, `:3427-3603` | Sweep ids and leg statuses; `settle_leg` against a Council that did and did not record the id; Council dedupe refusing a repeated id; a proptest that `council + treasury + carry == total` for random totals; treasury account verified before `set_fee_recipients` |
| R-08 views | `config`, `get_fees`, `total_owed` tests | `get_positions`, `get_account`, `owed_breakdown`, `in_flight`, `list_sweeps` with exact JSON shape tests |
| R-07 owner is a DAO account | `upgrade.rs` owner fixture (not a DAO) | A sandbox with a real SputnikDAO build calling `upgrade`, `set_fee_recipients` and `accept_owner`. Not possible against the verifier on testnet (the verifier has no testnet) |

Break-the-code checks the team already uses apply: break each new rule on purpose and confirm the named test fails (the build rule in section 20 of the previous spec).
