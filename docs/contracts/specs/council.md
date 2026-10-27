# Dragons Market: council contract implementation spec and quarterly accounting proposal

**The complete function set the Council needs for NFT seats, juries and quarterly holder rewards, with a concrete accounting proposal that replaces the 30-day stream.**

| Field | Value |
| --- | --- |
| Date | 2026-10-21 |
| Status | The quarterly model in section 6 is built. Rows marked NEW or CHANGED describe what was built, and the error and field tables were checked against the source on 2026-10-22 |
| Scope | `contracts/council/src/lib.rs` |
| Source | Working tree on top of commit `6cad02e`, read 2026-10-21 09:00 to 09:22 |
| Revision checked | `council/src/lib.rs` sha256 prefix `cc840f4fdbe5caf9` (2510 lines, unchanged between copies, 267 lines differ from `HEAD`) |
| Index | [README.md](README.md) |

**Build status, 2026-10-21.** BUILT in `contracts/council/src/lib.rs` (state version 3; version 3 added the market allow-list, sweeps keyed by market account and version-tagged records, 2026-10-23): sections 4.2, 5, 6, 7.2, 8 and 9, with the changes below. Sections 2, 3, 10 and 11 hold as written.

| Item | Built as | Tests |
| --- | --- | --- |
| Calendar (6.1, I-C7) | `quarter_containing`, `quarter_start`, `quarter_end`, pure | `the_quarter_table_of_the_spec_holds`, `every_month_boundary_from_1970_to_2100_falls_in_the_right_quarter`, `later_times_never_fall_in_earlier_quarters` |
| Revenue by sweep id from the market only (5) | `mt_on_transfer` with `revenue:<sweep id>`, `received_of` | `a_sweep_id_is_taken_once_and_the_repeat_is_refused`, `only_the_market_sends_revenue`, `a_message_that_is_not_a_sweep_is_unknown`, sandbox `a_sweep_id_is_taken_once_and_only_the_market_sends_revenue_and_the_verifier_gives_back_the_rest` (I-C6) |
| Worked examples 1 to 6 (6.11) | unit tests with the real calendar | `example_one_the_baseline_quarter`, `example_two_a_sweep_after_the_boundary_belongs_to_the_next_quarter`, `example_three_a_seat_staked_at_noon_on_the_last_day_earns_a_sliver`, `example_four_a_silent_juror_loses_the_seat_time_of_the_case`, `example_five_a_quarter_with_no_seats_rolls_its_pool_into_the_next`, `example_six_a_failed_claim_can_be_made_again_and_a_paid_one_cannot`. Example 7 is the market's: sandbox `a_council_leg_that_fails_leaves_the_treasury_leg_alone_and_is_retried_once` |
| Seat weights, stake changes (6.4) | `advance_quarters`, `book_seat_time`, lazy per-seat booking | `a_share_is_the_staked_time_over_all_staked_time`, `two_spans_of_one_token_by_one_owner_in_a_quarter_add_up_to_one_claim`, `the_token_restaked_by_someone_else_starts_a_span_of_its_own`, `idle_time_is_moved_forward_in_steps_by_anyone`, `a_failed_unstake_restores_the_seat_and_it_counts_again_from_the_restore` |
| Forfeits as removed weight (6.5) | `unlock_case`, with the forfeit kept in its own map | `a_forfeit_after_the_quarter_is_final_is_skipped_and_says_so`, `a_forfeit_that_crosses_a_boundary_is_split_between_the_quarters_it_touched`, `a_juror_is_penalised_once_and_naming_an_outsider_changes_nothing` |
| Finalization and the claim window (6.7) | `finalize_quarter`, in order, after the grace period | `a_quarter_is_final_only_after_the_grace_period_and_in_order`, `a_claim_before_the_quarter_is_final_is_refused`, `unclaimed_amounts_stay_claimable_for_good` |
| Single-use claim record (6.8, I-C4, I-C5) | `claim_quarter`, `on_claim_paid` | `a_callback_that_runs_again_or_late_changes_nothing`, `nobody_claims_for_a_seat_they_did_not_hold`, guard `the_council_pays_reward_money_only_in_a_quarter_claim`, sandbox `a_payout_the_verifier_refuses_leaves_the_claim_open_and_a_paid_claim_cannot_be_made_again`, `fees_go_from_a_sweep_to_a_quarter_to_one_claim_per_seat_and_a_late_claim_is_still_paid` |
| Conservation, entitlement bound, weight conservation (I-C1 to I-C3) | proptests | `quarters_conserve_every_unit_and_never_pay_a_claim_twice`, `shares_never_exceed_the_pool_and_leave_under_a_unit_a_seat` |
| Views (8) and events (9) | all of section 8 | `the_quarter_views_show_state_pool_dates_and_what_was_paid`, `an_entitlement_goes_from_accruing_to_closing_to_claimable_to_pending_to_paid`, `an_account_lists_its_entitlements_over_current_and_past_seats`, `reward_totals_track_received_open_final_paid_and_rolled` |

Changes against the text above:

| Item | Spec | Built |
| --- | --- | --- |
| `new` | Adds `market_id` and `close_grace_ns`, keeps `nft_contract` | `new` takes none of the three. The collection is `None` and the market allow-list is empty until `set_nft_contract` and `allow_market`; staking, revenue and claims refuse until then. The grace period starts at 7 days (`set_close_grace_ns`, 1 to 30 days) |
| Revenue receipt | Ticks seat time and refuses more than 8 quarters of backlog | It only books the revenue to the quarter of receipt. Seat time is moved by stakes, unstakes, `finalize_quarter` and `advance_quarters`, so a late sweep is never refused for idle time |
| First quarter | `first_quarter` and gap-free books | `next_to_finalize` starts at the quarter of `new`; a quarter nobody touched has no entry and reads as empty, so there are no gaps to keep |
| Forfeit storage | Subtract from `seat_weight` | A separate `forfeits` map, so releasing a case never needs the seat's whole history counted first and cannot fail |
| `unstake` | Refuses when more than 8 quarters need booking | The same, `book this seat first`. The gas floor is 33 TGas |
| `entitlements_of` | Over the account's seats and past seats | Over a list of every token the account has staked (`tokens_of`) |
| Silent juror | "Goes to the next quarter's pool" in the build brief | The spec text is built: the seat time leaves the quarter's weights, so the other seats' shares in that quarter rise. A quarter already final is not changed |

---

## Contents

1. [Summary](#1-summary)
2. [Purpose and roles](#2-purpose-and-roles)
3. [Money flows in Intents terms](#3-money-flows-in-intents-terms)
4. [State](#4-state)
5. [Message grammar](#5-message-grammar)
6. [The quarterly accounting proposal](#6-the-quarterly-accounting-proposal)
7. [Methods](#7-methods)
8. [Views the website and keeper need](#8-views-the-website-and-keeper-need)
9. [Events](#9-events)
10. [Invariants](#10-invariants)
11. [Errors](#11-errors)
12. [Test evidence required](#12-test-evidence-required)

---

## 1. Summary

The Council already holds staked NFT seats, draws juries, locks a drawn seat until its case is final, and keeps its reward backing in its own Intents account. Revenue arrives by `mt_on_transfer` and payouts leave by `mt_transfer` (Checked in source: `council/src/lib.rs:633-660`, `:835-840`).

It does not implement quarterly claims. Rewards stream to staked seats over 30 days and a seat may claim at any time (`:26-29`, `:93-160`, `:576-605`). The accepted decision says eligible holders claim quarterly, each entitlement once, through Council-authorised Intents settlement, and that the same allocation must never be claimable through two paths. R-05 is therefore MISSING.

Section 6 is the concrete proposal. In one paragraph: quarters are UTC calendar quarters. Every revenue arrival is attributed to the quarter in which the Council receives it. A seat's share of a quarter is the time it was staked inside that quarter divided by the total seat time of that quarter, so staking just before the quarter ends earns a sliver and not the whole pool. A quarter becomes claimable seven days after it ends. Each seat claims each quarter once. Unclaimed amounts stay claimable with no expiry. A quarter with no seats rolls its pool forward. The 30-day stream and the old `claim` method are removed.

| Change | Section |
| --- | --- |
| Quarter books, seat weights, forfeits as removed weight, claim records, sweep id dedupe | 6, 7.2 |
| Revenue accepted only from the market | 5, 7.2 |
| `unstake` no longer pays, so unstaking never touches reward money | 7.2 |
| Views for quarters, entitlements, seats of an account, reward totals | 8 |

---

## 2. Purpose and roles

| Role | Set by | Powers |
| --- | --- | --- |
| Owner | `new`, `propose_owner` and `accept_owner`. DECIDED: the DAO | `upgrade`, `seal`, `propose_owner`, `set_cooldown_ns`, `set_max_seats_per_account`, `set_nft_contract` (only with nothing staked), `allow_tokens`, `set_token_range`, `clear_token_range`, `set_allowlist_enabled`. NEW: `set_close_grace_ns`, `allow_market`, `disallow_market`, `set_reconcile_wait_ns` |
| Oracle | `new`, no setter | `draw` and `unlock_case` only |
| Seat owner | Staking | `request_unstake`, `unstake`, and the claim of their own seats |
| NFT contract | `new`, `set_nft_contract` | `nft_on_transfer` only |
| Verifier | `new`, no setter | `mt_on_transfer` only |
| Market | NEW `new` argument | The only account whose revenue the Council accepts |
| Anyone | none | `stage_code`, NEW `advance_quarters`, `finalize_quarter`, `book_seat_time`, every view |

Eligibility rules stay as built: only a staked NFT of the configured collection that passes the allowlist earns or enters a jury draw. Treasury membership grants no holder reward (`spec.md:180-181`, `:204-205`). A seat belongs to the previous owner of the token, not to the account that relayed it (`:733-766`).

---

## 3. Money flows in Intents terms

The Council has its own Intents account `C`, with no key registered in the verifier and predecessor authentication on. `C` holds only reward backing. Dispute bonds and juror pay live in the oracle's account and the market's backing lives in the market's account.

| Money | Path | Verifier call |
| --- | --- | --- |
| 25% of earned fees | Market `M` to `C` | The market calls `mt_transfer_call(receiver_id=C, token_id, amount, null, null, msg="revenue:<sweep_id>")`. The verifier credits `C`, then calls `C.mt_on_transfer` |
| A holder's quarterly payout | `C` to the holder's own Intents account | The Council calls `mt_transfer(receiver_id=owner, token_id, amount, null, null)` with 1 yocto |
| NFT return on unstake | NFT contract | `nft_transfer`, no collateral involved |

Surplus: a plain deposit into `C` credits `C` and calls nothing. It is never counted and no method credits it (Reported in `INTENTS-PROOF.md`, tested in `intents_verifier.rs`).

The reconciliation identity for `C`, with no claim in flight: `mt_balance_of(C, token) >= total_received - total_paid`. Equality means no surplus.

---

## 4. State

### 4.1 Fields today

EXISTING (`council/src/lib.rs:169-213`).

| Field | Type | Meaning |
| --- | --- | --- |
| `state_version`, `upgrade_proven`, `upgrade_in_flight` | `u16`, `bool`, `bool` | Upgrade path marks |
| `owner`, `pending_owner` | `AccountId`, `Option<AccountId>` | The DAO and a pending handover |
| `oracle`, `nft_contract`, `verifier` | `AccountId` | Counterparties |
| `collateral_token_id` | `String` | Exact `nep141:<contract>` string |
| `cooldown_ns` | `u64` | Wait between `request_unstake` and `unstake`. Must be at least the oracle's challenge window plus panel deadline |
| `max_seats_per_account` | `u32` | Seat cap per account |
| `allowlist_enabled`, `allowed_tokens`, `allowed_range` | `bool`, set, optional range | Per collection token allowlist |
| `staked` | `Vector<TokenId>` | Every staked token, stable order, at most 1,000 |
| `stakes` | `LookupMap<TokenId, Stake>` | One record per staked token |
| `seats_of` | `LookupMap<AccountId, u32>` | Seat count per account |
| `juries` | `LookupMap<u64, Vec<TokenId>>` | Seats held for each open case |
| `acc_per_seat`, `stream` | `u128`, `Stream` | The 30-day stream. REMOVED by this proposal |
| `total_received` | `u128` | Every unit of revenue taken in |

`Stake` as built: `owner`, `staked_at`, `unlock_requested_at`, `serving`, `booked_to`, and two fields hidden from JSON, `serving_from` and `index`. Before the quarterly change it held `serving_since_acc` and `reward_debt` instead of `booked_to` and `serving_from`.

### 4.2 Fields after the change (PROPOSED)

`state_version` becomes 2, and 3 with the market allow-list and the version tags. Nothing is deployed, so no migration is needed.

| Field | Type | Meaning |
| --- | --- | --- |
| `allowed_markets` | `Vec<AccountId>` | BUILT. The accounts that may send revenue. Replaces the single `market`. The last one cannot be removed |
| `close_grace_ns` | `u64` | NEW. Wait after a quarter ends before it can be finalized. Default 7 days, bounds 1 to 30 days |
| `reconcile_wait_ns` | `u64` | NEW. How long a claim must be pending before `reconcile_claim`. Default 1 hour, owner range 10 minutes to 7 days |
| `last_tick` | `u64` | NEW. Nanosecond time up to which seat time has been added to the quarter books |
| `first_quarter`, `next_to_finalize` | `u32` | NEW. Oldest quarter with a book and the next one to finalize |
| `quarters` | `LookupMap<u32, QuarterBook>` | NEW. One book per quarter from `first_quarter` to the current one, with no gaps |
| `seat_weight` | `LookupMap<(u32, TokenId, AccountId), u64>` | NEW. Booked nanoseconds of one staking span of one token by one owner inside one quarter |
| `claims` | `LookupMap<(u32, TokenId, AccountId), Claim>` | NEW. The single-use claim record |
| `received` | `LookupMap<(AccountId, u64), VersionedReceived>` | BUILT. Revenue by market account and sweep id. Every map record (`Stake`, `QuarterBook`, `Claim`, `Received`) is stored behind a one-byte version tag, 0 today, read through `into_current` and always written current |
| `seats_by_owner` | `LookupMap<AccountId, Vec<TokenId>>` | NEW. Replaces the bare count, at most `max_seats_per_account` entries |
| `total_paid` | `u128` | NEW. Sum of confirmed claim payouts |
| `acc_per_seat`, `stream`, `Stake.reward_debt`, `Stake.serving_since_acc` | | REMOVED |
| `Stake.booked_to` | `u64` | NEW. Time up to which this stake's weight is booked. Starts at `staked_at` |
| `Stake.serving_from` | `Option<u64>` | NEW. Time the seat was drawn |

```text
QuarterBook { revenue_in: u128, carry_in: u128, seat_ns: u128, forfeit_ns: u128,
              finalized: bool, pool: u128, weight_total: u128,
              rolled_to: Option<u32>, paid: u128, pending: u128 }
Claim       { amount: u128, status: Pending | Paid, requested_at: u64, paid_at: Option<u64> }
Received    { amount: u128, quarter: u32, at: u64 }
```

Storage grows with seats times quarters touched. Each `seat_weight` entry is about 100 bytes and each `claims` entry about 120 bytes. A full council of 1,000 seats over a year is under 4,000 entries of each, near 0.9 MB, so about 9 NEAR paid from the Council's NEAR balance. The keeper's storage margin check covers it.

---

## 5. Message grammar

| Message | Sender | Effect |
| --- | --- | --- |
| `revenue` | any (today) | Adds the amount to the stream. Accepted from anyone (`:633-660`). CHANGED, see below |
| `revenue:<sweep_id>` | the market only | NEW. Attributes the amount to the quarter of the receipt, records `received[(market, sweep_id)]`, adds to `total_received` |

`<sweep_id>` is a `u64` decimal. After the change:

1. The caller must be the verifier, with exactly one token and one amount, and the token id must equal `collateral_token_id` (existing checks).
2. `sender_id` must be on the allow-list (`revenue comes from an allowed market only`). A different sender panics and the verifier refunds it in full.
3. A `sweep_id` already in `received` panics (`that sweep was already received`) and the verifier refunds it. This makes a repeated send harmless.
4. Any other text panics (`unknown action`).

Staking uses NEP-171 `nft_transfer_call` to the Council. `msg` is ignored (`:735-766`). The website sends an empty string.

---

## 6. The quarterly accounting proposal

PROPOSED throughout this section. It uses the accepted decisions only: quarterly claims, each entitlement claimable once, Council-authorised Intents settlement, the 25% leg held in Intents, juror pay and bonds separate, and no second payout path. The numbers in the examples are computed and the arithmetic was checked.

### 6.1 Quarter boundaries

A quarter is a UTC calendar quarter: January to March, April to June, July to September, October to December. The quarter starts at 00:00:00.000000000 UTC on the first day of its first month and ends, exclusive, where the next quarter starts. A timestamp exactly on a boundary belongs to the new quarter.

The quarter id is `year * 4 + (quarter - 1)` as a `u32`, so 2026 Q4 is 8107. Views also return the label `"2026Q4"`.

| Quarter | Id | Starts (UTC) | Starts (ns) | Days |
| --- | --- | --- | --- | --- |
| 2026 Q4 | 8107 | 2026-10-01 | 1790812800000000000 | 92 |
| 2027 Q1 | 8108 | 2027-01-01 | 1798761600000000000 | 90 |
| 2027 Q2 | 8109 | 2027-04-01 | 1806537600000000000 | 91 |
| 2027 Q3 | 8110 | 2027-07-01 | 1814400000000000000 | 92 |
| 2027 Q4 | 8111 | 2027-10-01 | 1822348800000000000 | 92 |
| 2028 Q1 | 8112 | 2028-01-01 | 1830297600000000000 | 91 (leap year) |

Test vectors: `1798761599999999999` (2026-12-31T23:59:59.999999999Z) is in 8107. `1798761600000000000` is in 8108. `1835438400000000000` (2028-02-29T12:00:00Z) is in 8112.

The contract needs no date library. It converts days since 1970-01-01 to a civil year and month with the standard integer algorithm, then derives the quarter. The function is pure and gets a unit test over the vectors above and over every month boundary from 2026 to 2100.

### 6.2 Accrual, vesting and claimability

| Term | Meaning | Visible as |
| --- | --- | --- |
| Accruing | The quarter is still running. A seat has a provisional share that moves with later revenue and later seat time | `EntitlementView.status = "accruing"`, `estimated = true`. Display only, never promised |
| Closing | The quarter ended but `close_grace_ns` has not passed. Forfeits can still change weights | `"closing"` |
| Claimable | The quarter is finalized. The pool and total weight are fixed. The seat's amount is `floor(pool * weight / total weight)` | `"claimable"` |
| Pending | A claim was requested and the verifier transfer has not reported | `"pending"` |
| Paid | The verifier transfer succeeded | `"paid"` |

There is no vesting schedule across quarters and no cliff. A seat that was staked for part of a quarter earns for exactly that part, and keeps the right to claim it after unstaking. "Vesting" here is only the moment the quarter finalizes.

### 6.3 How revenue is attributed

Every `revenue:<sweep_id>` arrival is credited to the quarter that contains the block time of the Council's receipt. Fees earned in December but swept on 2 January belong to the new quarter. The Council cannot know when fees were earned, because the market sends one lump. A keeper that sweeps shortly before a boundary keeps the attribution close to the earning period (README section 4, journey J7). This is the late-arrival rule: late fees are attributed to the current quarter, never back-dated.

Juror forfeits are not money. They remove weight (6.5), so they need no attribution.

### 6.4 Weights and stake changes

A seat's weight in a quarter is the number of nanoseconds, inside that quarter, that the stake existed. Staking, unstaking and re-staking only change which spans exist. The weight does not depend on when revenue arrived. This is what stops a late staker from taking a full share, which the 30-day stream existed to prevent (finding C-07).

Rules:

1. A seat counts from the block it is staked until the block it is unstaked. It keeps counting while it serves on a case. It stops counting at `request_unstake`, so a seat waiting out the cooldown, or one that asked to leave and stayed, earns nothing after the request (README OD-03, reversed 2026-10-22).
2. A new stake of the same token by another owner starts a new span with its own weights. The weights are keyed by quarter, token and owner, so both owners can claim their own spans.
3. Total weight of a quarter, `seat_ns`, is the integral of the staked seat count over the quarter. The contract adds `earning_count * (to - last_tick)` to the right quarter at every stake, unstake and revenue arrival, and once per quarter boundary crossed. `advance_quarters` lets anyone move it forward.
4. Per seat weights are booked lazily from `Stake.booked_to`. `unstake`, `claim_quarter`, forfeits and `book_seat_time` book the span up to a point, splitting it across the quarters it covers. A single call books at most 8 quarters, so one span longer than two years needs `book_seat_time` first.
5. The sum of booked weights of a quarter equals `seat_ns - forfeit_ns` once every seat is booked.

### 6.5 Juror forfeits

Today a juror who never votes forfeits the revenue the seat earned while serving, and that money goes back into the stream (`:472-491`). In the quarterly model the seat loses the weight of the serving span instead.

When the oracle calls `unlock_case` with a delinquent juror, the Council books the seat up to now. For each quarter that overlaps `[serving_from, now)` and is not finalized, it subtracts that overlap from `seat_weight` and adds it to `QuarterBook.forfeit_ns`. Total weight shrinks by the same amount, so every other seat's share rises. A quarter that is already finalized is not changed, and the Council emits `forfeit_skipped`.

`close_grace_ns` exists for this. A case lasts at most a few days plus keeper retries, so finalizing seven days after the boundary lets almost every case that crossed the boundary settle first.

A juror who committed but had no chance to reveal because a majority settled first is not delinquent. That rule lives in the oracle and is unchanged.

### 6.6 Periods with no seats

Seat time with zero seats adds zero weight. The pool is not tied to time slices, so revenue that arrived while no seat was staked is still shared among the seats that were staked at any point in the quarter.

If total weight of a quarter is zero at finalization, the whole pool rolls into the next quarter: `quarters[q + 1].carry_in += pool`, `rolled_to = q + 1`. The money never leaves `C`. A rolled quarter has nothing to claim.

### 6.7 Finalization, claim window and unclaimed amounts

`finalize_quarter(q)` is public. It needs `now >= ends_at + close_grace_ns`, `q == next_to_finalize`, and it fixes `pool = revenue_in + carry_in` and `weight_total = seat_ns - forfeit_ns`. Quarters finalize in order, so a roll always lands in a quarter that is not final yet.

A claim opens when its quarter is finalized. There is no deadline. An unclaimed amount stays claimable indefinitely (PROPOSED default, README OD-04). The alternatives and their cost:

| Alternative | Effect | Why not the default |
| --- | --- | --- |
| Expiry after N quarters, unclaimed returns to a later pool | Bounds liabilities and dormant accounts | Takes money a holder is owed. Needs notice, a legal view and a keeper reminder. Not in the accepted decision |
| Expiry to the treasury | Same, but money leaves the holder allocation | Changes the 75/25 meaning |

Rounding: each seat gets `floor(pool * weight / weight_total)`. The sum is at most the pool, and the leftover is under one unit per seat. The leftover stays in `C` as unallocated backing. No method moves it in the first release (OPEN, README OD-07). It is at most 1,000 units, so at most 0.001 USDC per quarter.

### 6.8 The single-use claim record

`claim_quarter(quarter, token_id)` needs exactly 1 yocto and at least 33 TGas.

| Step | State change | Failure |
| --- | --- | --- |
| 1 | Refuse unless the quarter is finalized. Book the caller's span if the caller owns the staked token. Read `seat_weight[(q, token, caller)]` | `nothing to claim` when the weight is zero. `claim is already pending` or `already claimed` when a record exists |
| 2 | Compute `amount = floor(pool * weight / weight_total)`. Refuse zero. Write `claims[key] = Pending {amount}`. Add `amount` to `QuarterBook.pending` | none |
| 3 | Send `mt_transfer(caller, token_id, amount)` from `C`, then `on_claim_paid` | The verifier receipt fails (paused, locked, out of gas) |
| 4a | Success: `status = Paid`, `paid_at = now`, `pending -= amount`, `paid += amount`, `total_paid += amount`. Emit `claim_paid` | |
| 4b | Failure: delete the record, `pending -= amount`. Emit `claim_failed`. The seat can claim again | |

The key is quarter, token and caller. A different caller has a different key, so another account cannot claim or block this one. The record is never deleted once `Paid`, which is what makes the claim single use. `mt_transfer` returns nothing and is one verifier receipt, so an error means nothing moved. This is the same reasoning the market uses for `withdraw`. The event `claim_requested` is emitted at step 2 and replaces today's `revenue_claimed`, which is emitted before the transfer succeeds and so reads as a payment (`:596-599`).

There is no second path. The old `claim(token_id)` and the payout inside `unstake` are removed, so a holder can never draw the same allocation twice.

### 6.9 How the 30-day stream maps onto this

It does not map. It is replaced.

| Old element | Fate |
| --- | --- |
| `Stream`, `STREAM_NS`, `top_up`, `advanced`, `acc_per_seat` | Removed |
| `Stake.reward_debt`, `serving_since_acc` | Removed |
| `claim(token_id)` | Removed. `claim_quarter` replaces it |
| `unstake` paying earned revenue | Removed. Unstake returns the NFT only. Earnings stay claimable by quarter |
| `pending_reward(token_id)` | Removed. `get_entitlement` replaces it |
| `config.stream_remaining`, `stream_ends_at`, `stream_ns` | Removed |
| `total_received` | Kept, now also counted per quarter |
| Forfeit adds to the stream | Replaced by removed weight (6.5) |

C-07 asked that a one-block stake not earn a full share of a large arrival. With time weighting over the whole quarter, a seat staked one second before the quarter ends in a 92-day quarter has a weight of 1 second out of 7,948,800 seconds per seat, which is 0.0000126% of one full-quarter seat.

### 6.10 The 75/25 split and its legs

The split happens in the market, before the Council sees any money. The Council only receives the 25% leg.

Rounding rule, exact: `council = floor(total * 2500 / 10000)`, `treasury = floor(total * 7500 / 10000)`, and the remainder `total - council - treasury` (0 or 1 unit) goes to neither leg. It stays in the market's `fees` bucket and joins the next sweep. Full specification and a table of examples are in [market.md section 7.2](market.md#72-sweep-ledger-and-independent-legs-r-03).

The two legs are independent. The Council leg is a transfer call whose result the market reads. The treasury leg is a plain transfer. A refusal of either leg returns that amount to its own due bucket and changes nothing in the other. With sweep ids, a lost Council result is settled by asking the Council's `received_of(sweep_id)`, so the amount can be neither dropped nor paid twice.

### 6.11 Worked examples

All amounts are in the six-decimal collateral unit. Weights below are in days because only ratios matter. The contract uses nanoseconds.

**Example 1: baseline.** 2026 Q4 has 92 days. Seat 1 is staked all quarter (92 days). Seat 2 stakes on 15 November and stays (47 days). Seat 3 stakes on 1 October and unstakes on 31 October (30 days). Total weight is 169. The quarter receives 600,000 on 20 October and 1,000,000 on 30 December, so the pool is 1,600,000.

| Seat | Weight | Exact share | Entitlement |
| --- | --- | --- | --- |
| 1 | 92 | 871,005.917 | 871,005 |
| 2 | 47 | 444,970.414 | 444,970 |
| 3 | 30 | 284,023.669 | 284,023 |
| Total | 169 | | 1,599,998 |

Two units stay in `C` as unallocated backing.

**Example 2: late arrival.** A sweep of 400,000 reaches the Council on 3 January 2027. It is credited to 2027 Q1, not to 2026 Q4. The 2026 Q4 entitlements above do not change.

**Example 3: staking just before the end.** A fourth seat stakes at noon on 31 December and stays 0.5 day. In half days the weights are 184, 94, 60 and 1, total 339.

| Seat | Entitlement |
| --- | --- |
| 1 | 868,436 |
| 2 | 443,657 |
| 3 | 283,185 |
| 4 | 4,719 |

Seat 4 earns 4,719 of 1,600,000, not a quarter of it. Dust is 3.

**Example 4: a silent juror.** Seat 1 is drawn on 10 December and the case is released on 14 December. The juror never voted. Four days are removed from seat 1, so its weight is 88 and total weight is 165.

| Seat | Entitlement |
| --- | --- |
| 1 | 853,333 |
| 2 | 455,757 |
| 3 | 290,909 |

The sum is 1,599,999 and dust is 1. Seats 2 and 3 each earn more than in Example 1.

**Example 5: a quarter with no seats.** In 2027 Q1 every seat has unstaked and 500,000 arrives. At finalization total weight is zero, so 500,000 rolls into 2027 Q2 as `carry_in`. In 2027 Q2 one seat is staked all 91 days and 300,000 arrives. The pool is 800,000 and that seat claims 800,000.

**Example 6: a failed claim.** Seat 1 calls `claim_quarter(8107, "1")`. The Council records `Pending` with 871,005 and sends the transfer. The verifier's `mt_transfer` feature is paused, so the receipt fails. `on_claim_paid` deletes the record and emits `claim_failed`. After the verifier is unpaused the seat claims again and is paid. A third call is refused with `already claimed`.

**Example 7: a refused Council leg.** The market holds 1,095,193 in `fees`. Sweep 41 splits it into 273,798 for the Council and 821,394 for the treasury, with 1 unit left in `fees`. The treasury transfer succeeds. The Council refuses (for example because its account is locked). The verifier refunds the market. Sweep 41 shows the Council leg `refused` and the treasury leg `settled`. The 273,798 returns to `revenue_due`. The next sweep, id 42, finds 500,001 in `fees`, splits it into 125,000 and 375,000 with 1 left over, adds the 273,798 carried, and sends 398,798 to the Council and 375,000 to the treasury. The treasury was paid once and the Council once.

### 6.12 Constants and gas

| Item | Value | Status |
| --- | --- | --- |
| `close_grace_ns` | 7 days, owner may set 1 to 30 days | PROPOSED |
| Quarters advanced or booked per call | 8 | PROPOSED |
| `claim_quarter` floor | 33 TGas (15 transfer, 10 callback, 8 own work), same as today's `claim` | PROPOSED. The tests assert 33 for `claim` (`gas_floors.rs:287`) |
| `unstake` floor | 33 TGas (15 NFT transfer, 10 callback, 8 own work), down from 58 because no payout is sent | PROPOSED |
| Gas the market reserves for the Council receipt | 20 TGas today (`market lib.rs:57`). The receipt now ticks up to 8 quarters and writes a `received` record | OPEN. Measure in the sandbox. Estimate 30 TGas. UNVERIFIED |
| `finalize_quarter` | no floor. One storage write per quarter and no transfer. About 10 TGas. UNVERIFIED | PROPOSED |

---

## 7. Methods

### 7.1 Methods that exist today

Gas floors are enforced with `upgrade::require_gas` (`council/src/lib.rs:35-44`).

| Method | Caller | Args | Returns | Yocto | Gas | Behaviour and refusals | Events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `new` (`:256`) | The account itself | `owner_id`, `oracle_id`, `nft_contract`, `verifier_id: AccountId`, `collateral_token_id: String`, `cooldown_ns: U64`, `max_seats_per_account: u32`, `allowlist_enabled: Option<bool>` | contract | none | n/a | Refuses a zero cooldown, a zero seat cap, an id without `nep141:`. The allowlist defaults to on. CHANGED: add `market_id: AccountId`, `close_grace_ns: U64` | none |
| `stage_code` (`:306`), `upgrade` (`:318`), `migrate` (`:331`), `seal` (`:342`), `propose_owner` (`:350`), `accept_owner` (`:356`) | as the market | | | | 100 TGas for `upgrade` | as the market | `code_staged`, `upgrade_sent`, `migrated`, `seal_sent`, `owner_proposed`, `owner_changed` |
| `set_cooldown_ns` (`:365`) | Owner | `cooldown_ns: U64` | none | none | none | Refuses zero. Applies to requests already made | `cooldown_set` |
| `set_max_seats_per_account` (`:372`) | Owner | `u32` | none | none | none | Refuses zero. Does not remove seats already held | `max_seats_per_account_set` |
| `set_nft_contract` (`:387`) | Owner | `nft_contract: AccountId` | none | none | none | Refuses while any seat is staked | none. NEW event `nft_contract_set` |
| `allow_tokens` (`:398`) | Owner | `token_ids: Vec<String>` | none | none | none | 1 to 100 ids | `tokens_allowed` |
| `set_token_range` (`:414`), `clear_token_range` (`:424`) | Owner | `first: U64`, `last: U64` | none | none | none | Plain decimal ids only | `token_range_set`, `token_range_cleared` |
| `set_allowlist_enabled` (`:431`) | Owner | `enabled: bool` | none | none | none | Does not unstake anything | `allowlist_set` |
| `draw` (`:440`) | Oracle | `case_key: U64`, `n: u32`, `exclude: Vec<AccountId>` | `Vec<AccountId>` | none | 250 TGas reserved by the oracle | Reads the block seed itself. A repeat returns the cached jury. Skips seats that serve, are leaving, or are excluded. Marks the jury serving | none |
| `unlock_case` (`:472`) | Oracle | `case_key: U64`, `delinquent: Vec<AccountId>` | none | none | 15 TGas reserved | Releases the seats. CHANGED: forfeits weight instead of stream revenue (6.5) | `revenue_forfeited` today, NEW `seat_time_forfeited` |
| `request_unstake` (`:493`) | Seat owner | `token_id: String` | none | none | none | Refuses a seat that serves or already asked | `unstake_requested` |
| `unstake` (`:507`) | Seat owner | `token_id: String` | `Promise` | exactly 1 | 58 TGas floor | Today pays the earned revenue, then returns the NFT. CHANGED: returns the NFT only, books the span, 33 TGas floor | `revenue_claimed`, `unstaked`, `unstake_failed` |
| `on_unstake_paid` (`:539`), `on_unstaked` (`:559`) | The account itself | | | | 35 and 10 TGas | Restore the stake when a transfer fails. CHANGED: `on_unstake_paid` removed | |
| `claim` (`:577`) | Seat owner | `token_id: String` | `Promise` | exactly 1 | 33 TGas floor | Pays `(acc - reward_debt) / PRECISION`. REMOVED by this proposal | `revenue_claimed`, `claim_failed` |
| `on_claimed` (`:608`) | The account itself | | | none | 10 TGas | REMOVED | |
| `mt_on_transfer` (`:633`) | The verifier | `sender_id`, `previous_owner_ids: Vec<AccountId>`, `token_ids: Vec<String>`, `amounts: Vec<U128>`, `msg: String` | `Vec<U128>`, always `["0"]` | none | attached gas minus about 20.5 | CHANGED, section 5 | `revenue` |
| `nft_on_transfer` (`:735`) | The NFT contract | `sender_id`, `previous_owner_id: AccountId`, `token_id: String`, `msg: String` | `PromiseOrValue<bool>`, always false | none (the user attaches 1 yocto to `nft_transfer_call` on the NFT contract) | n/a | Stakes the seat for `previous_owner_id`. Refuses a wrong contract, a token off the allowlist, a staked token, a full council, a capped account | `staked` |

Views today: `total_received` (`:665`), `seat_count` (`:669`), `jury_of(case_key)` (`:675`), `is_allowed(token_id)` (`:680`), `is_seat(account_id)` (`:684`), `staked_tokens(from_index, limit)` (`:688`), `stake_of(token_id)` (`:697`), `pending_reward(token_id)` (`:703`), `is_staged(code_hash)` (`:714`), `config()` (`:719`).

### 7.2 Methods and changes required

| Method | Caller | Args | Returns | Yocto | Gas | Behaviour and refusals | Events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mt_on_transfer` CHANGED | The verifier | as above | `["0"]` | none | 30 TGas estimate | Section 5. Ticks seat time to now, creates quarter books as needed, credits the quarter of the receipt, records `received[(market, sweep_id)]`. Refuses another sender, a repeated sweep id, more than 8 quarters of backlog (`call advance_quarters first`) | `revenue` with `sweep_id`, `quarter` |
| `advance_quarters(max_steps: Option<u32>)` NEW | Anyone | steps up to 8 | `u32` quarters advanced | none | 30 TGas | Moves `last_tick` towards now, adding seat time and creating empty books. Does nothing when current | none |
| `finalize_quarter(quarter: u32)` NEW | Anyone | quarter id | none | none | none | Ticks seat time to the end of the quarter first. Refuses before `ends_at + close_grace_ns`, a quarter that is not `next_to_finalize`, and one already final. Fixes pool and weight, rolls an empty quarter forward | `quarter_finalized` |
| `claim_quarter(quarter: u32, token_id: TokenId)` NEW | Seat owner | quarter id, token | `Promise` | exactly 1 | 33 TGas floor | Section 6.8 | `claim_requested`, `claim_paid`, `claim_failed` |
| `reconcile_claim(quarter: u32, token_id: TokenId, owner: AccountId, paid: bool)` NEW | Owner | quarter id, token, claim owner, whether the payout was made | none | none | none | Decides a claim whose payout callback never arrived, an hour after the claim. A late callback changes nothing | `claim_reconciled` |
| `on_claim_paid(quarter, token_id, owner, requested_at)` NEW | The account itself | | none | none | 10 TGas | Settles the claim record written at `requested_at`. A callback for an earlier record under the same key, one `reconcile_claim` deleted, changes nothing | `claim_paid`, `claim_failed` |
| `book_seat_time(token_id: TokenId, max_quarters: Option<u32>)` NEW | Anyone | token, steps up to 8 | `u32` quarters booked | none | 30 TGas | Books the span of a staked token up to the last finished quarter. Needed only for spans longer than 8 quarters | none |
| `unstake` CHANGED | Seat owner | `token_id` | `Promise` | exactly 1 | 33 TGas floor | Books the span, removes the stake, returns the NFT, no payout. Refuses `book this seat first` when the span exceeds 8 quarters | `unstaked`, `unstake_failed` |
| `unlock_case` CHANGED | Oracle | as above | none | none | 15 TGas | Forfeits weight (6.5) | `seat_time_forfeited`, `forfeit_skipped` |
| `set_close_grace_ns(close_grace_ns: U64)` NEW | Owner | nanoseconds | none | none | none | Between 1 day and 30 days | `close_grace_set` |
| `set_reconcile_wait_ns(reconcile_wait_ns: U64)` NEW | Owner | nanoseconds | none | none | none | Between 10 minutes and 7 days. Live. `reconcile_claim` reads it | `reconcile_wait_set` |
| `allow_market(market: AccountId)` BUILT | Owner | account | none | none | none | Adds a revenue sender. Refused if present | `market_allowed` |
| `disallow_market(market: AccountId)` BUILT | Owner | account | none | none | none | Removes a revenue sender; what it sent stays. Refused for the last one | `market_disallowed` |

Every owner row is a plain `AccountId` check. No row names or calls a governance contract (guard test `guards.rs:179-191`).

---

## 8. Views the website and keeper need

R-08 asks for accrued, claimable and paid amounts, operation states and quarters. All new views are PROPOSED.

| Quantity | View | Returns |
| --- | --- | --- |
| Quarter now and its bounds | `current_quarter()` | `QuarterView` |
| Any quarter | `get_quarter(quarter: u32)`, `list_quarters(from_quarter: u32, limit: u32)` | `Option<QuarterView>`, `Vec<QuarterView>` (limit at most 50) |
| Which quarter a time belongs to | `quarter_of(at: U64)` | `{quarter: u32, label: String, starts_at: U64, ends_at: U64}` |
| A seat's entitlement | `get_entitlement(quarter: u32, token_id: String, account_id: AccountId)` | `Option<EntitlementView>` |
| All of an account's entitlements | `entitlements_of(account_id: AccountId, from_quarter: u32, limit: u32)` | `Vec<EntitlementView>` over the account's seats and past seats, `min(limit, entitlements_page_quarters)` quarters a page |
| An account's page length | `entitlements_page_quarters(account_id: AccountId)` | `u32`, at most 25, fewer so a page stays within 250 lookups, at least 1 |
| An account's staked seats | `seats_of(account_id: AccountId)` | `Vec<TokenId>` |
| Revenue by sweep | `received_of(market: AccountId, sweep_id: U64)` | `Option<{amount: U128, quarter: u32, at: U64}>` |
| Totals for reconciliation | `reward_totals()` | `{total_received, total_paid, pending_claims, open_pool, final_unclaimed, rolled: U128}` |
| Stake record | `stake_of(token_id)` EXISTING | `Option<Stake>` with NEW `booked_to` |
| Case jury | `jury_of(case_key)` EXISTING | `Vec<TokenId>` |

```text
QuarterView      { quarter: u32, label: String, starts_at: U64, ends_at: U64, claimable_from: U64,
                   state: "open" | "closing" | "final",
                   revenue_in: U128, carry_in: U128, pool: U128, seat_ns: U128, forfeit_ns: U128,
                   paid: U128, pending: U128, rolled_to: Option<u32> }
EntitlementView  { quarter: u32, token_id: String, owner: AccountId, weight_ns: U128, amount: U128,
                   estimated: bool,
                   status: "accruing" | "closing" | "claimable" | "pending" | "paid",
                   requested_at: Option<U64>, paid_at: Option<U64> }
```

| UI label (README R-08) | Source |
| --- | --- |
| Accrued | `EntitlementView.amount` with `estimated = true`, status `accruing` or `closing` |
| Claimable | Status `claimable`, sum of `amount` |
| Pending | Status `pending` |
| Paid | Status `paid` and the `claim_paid` events |
| Quarters | `QuarterView.state`, `claimable_from` |

The `amount` of an open quarter uses `floor((revenue_in + carry_in) * weight_so_far / seat_ns_so_far)` and is a guess, because later revenue and later seat time both change it. The view says so with `estimated`.

---

## 9. Events

Envelope: `EVENT_JSON:{"standard":"council","version":"1.0.0","event":"<name>","data":{...}}` (Checked in source: `council/src/lib.rs:215-220`).

| Event | Data | Status |
| --- | --- | --- |
| `staked` | `token_id`, `owner` | EXISTING |
| `unstake_requested` | `token_id`, `owner`, `unlock_at` (string ns) | EXISTING |
| `unstaked` | `token_id`, `owner` | EXISTING |
| `unstake_failed` | `token_id`, `owner` | EXISTING |
| `revenue` | `from`, `amount`, `seats` today. NEW `sweep_id`, `quarter`, `market` (the sender) | EXISTING, CHANGED |
| `revenue_forfeited` | `token_id`, `owner`, `amount`, `case` | EXISTING. Replaced by `seat_time_forfeited` |
| `revenue_claimed` | `token_id`, `owner`, `amount` | EXISTING. Replaced by `claim_requested` and `claim_paid`. It is emitted before the transfer succeeds today |
| `claim_failed` | `token_id`, `owner`, `amount` | EXISTING, CHANGED: add `quarter` |
| `seat_time_forfeited` | `token_id`, `owner`, `case`, `quarter`, `forfeited_ns` | NEW |
| `forfeit_skipped` | `token_id`, `owner`, `case`, `quarter` | NEW |
| `quarter_finalized` | `quarter`, `pool`, `weight_ns`, `rolled_to` (null or id) | NEW |
| `claim_requested` | `quarter`, `token_id`, `owner`, `amount` | NEW |
| `claim_paid` | `quarter`, `token_id`, `owner`, `amount` | NEW |
| `close_grace_set`, `nft_contract_set` | the new value | NEW |
| `market_allowed`, `market_disallowed` | `market` | BUILT |
| `jury_drawn` | `case_key`, `tokens`, `owners` | BUILT |
| `jury_released` | `case_key`, `delinquent` | BUILT |
| `quarters_advanced` | `steps` | BUILT |
| `seat_time_booked` | `token_id`, `quarters` | BUILT |
| `reconcile_wait_set` | `reconcile_wait_ns` | NEW |
| `cooldown_set`, `max_seats_per_account_set`, `tokens_allowed`, `token_range_set`, `token_range_cleared`, `allowlist_set` | the changed value | EXISTING |
| `owner_proposed`, `owner_changed`, `code_staged`, `upgrade_sent`, `migrated`, `seal_sent` | as the market | EXISTING |

---

## 10. Invariants

| Invariant | Statement | Test status |
| --- | --- | --- |
| I-C1 revenue conservation | Everything received is in `total_received`. Everything paid is in `total_paid`. `mt_balance_of(C) >= total_received - total_paid` with no claim in flight | Today's stream version: proptest `council lib.rs:1333` (not run). NEW test for the quarterly version |
| I-C2 entitlement bound | For a final quarter, the sum of all possible entitlements is at most `pool` and the leftover is under one unit per seat | NEW proptest |
| I-C3 weight conservation | After booking every seat, the sum of `seat_weight` of a quarter equals `seat_ns - forfeit_ns` | NEW proptest with random stake, unstake and forfeit sequences |
| I-C4 single use | A claim record is `Paid` at most once per quarter, token and owner, and a failed transfer leaves the seat able to claim again | NEW. Sandbox `claim_failed` path |
| I-C5 no second path | No method other than `claim_quarter` sends reward money to a holder | NEW source guard: `mt_transfer` appears only in the claim payout |
| I-C6 one receipt per sweep | `received` holds each sweep id at most once, and a repeat is refused so the verifier refunds it | NEW sandbox test with the real verifier |
| I-C7 calendar | `quarter_of` matches the vectors in 6.1 and is monotonic | NEW unit test over every month to 2100 |
| I-C8 jury integrity | A drawn seat cannot leave until its case is final, and a seat that asked to leave is not drawn | `staking.rs:187`, `:227`, unit `council lib.rs:1493-1527` (exist, not run) |
| I-C9 separation | `C` never holds bonds or market backing. `O` and `M` never hold holder revenue | NEW reconciliation test over all three accounts |

---

## 11. Errors

Exact panic strings as built (checked in source: `council/src/lib.rs`).

| Group | Strings |
| --- | --- |
| Access | `owner only`, `oracle only`, `not the proposed owner`, `not your seat`, `not staked`, `wrong NFT contract`, `only the verifier can deliver money` |
| Delivery | `exactly one token and amount`, `wrong token`, `unknown action` |
| Staking | `that token is not on the allowlist`, `already staked`, `the council is full`, `that account already holds the most seats allowed` |
| Unstake and claim | `unstake already requested`, `this seat is serving on an open case`, `request an unstake first`, `the cooldown has not passed`, `nothing to claim`, and the gas refusals `attach at least 33 TGas: an unstake returns the NFT and then settles it` and `attach at least 33 TGas: a claim sends the payout and then settles it` |
| Settings | `the cooldown must be positive`, `an account must be allowed at least one seat`, `unstake every seat before changing the NFT contract`, `name at least one token`, `at most 100 tokens in one call`, `the first id must not be above the last`, `the collateral token id must look like nep141:<token>` |
| Draw | `not enough seat holders to draw a jury: {} eligible, {} needed` |
| Upgrade | `there is no state to migrate`, `migrate runs only inside an upgrade`, `prove the upgrade path before deleting keys` |

Strings added with the quarterly model: `revenue comes from an allowed market only`, `already an allowed market`, `not an allowed market`, `keep at least one allowed market`, `a stored record has a newer version than this code can read`, `that sweep was already received`, `call advance_quarters first`, `that quarter is not final`, `the quarter cannot be finalized yet`, `finalize the earlier quarter first`, `claim is already pending`, `already claimed`, `book this seat first`, `the grace period must be between 1 and 30 days`, `a jury drawn in this quarter is still open`.

---

## 12. Test evidence required

Existing tests were not run in this task.

| Requirement | Evidence that exists | Evidence still required |
| --- | --- | --- |
| R-04 eligibility, jury, case locks | `staking.rs`, `council.rs`, `hardening.rs:267-433` (allowlist), unit tests `council lib.rs:1016-1530` | Seat weight keeps counting while a seat serves and stops at its unstake request (OD-03 reversed) |
| R-05 quarterly accounting | None. The stream tests (`revenue.rs:188`, `:253`, `attacks.rs:1341`, unit `council lib.rs:1216`, `:1603-1700`) test behaviour that is removed | Every example in 6.11 as a unit test with controlled block times. Boundary vectors in 6.1. Proptests for I-C2 and I-C3. Late arrival, no-seat roll, forfeit before and after finalization, `finalize_quarter` ordering, claim states including a refused transfer with a paused verifier (`pause_transfers` helper exists in `common/mod.rs:414`). Sweep id dedupe against the real verifier. Reconciliation of `C` after a full quarter |
| R-05 timing in the sandbox | none | A real boundary is about 72 days away and the sandbox cannot skip that far (the audit measured a 72 hour skip as too slow). Use unit tests with controlled timestamps for the calendar, and patch stored timestamps in the sandbox as `relock_seat` does for the money path. Label such runs accelerated. Do not add a test-only constant to the shipped wasm: the audit rejected that |
| R-03 Council receipt | `revenue.rs:95`, `hardening.rs:606` | A repeated sweep id is refused and refunded. A sender other than the market is refused and refunded |
| R-08 views | `config`, `stake_of`, `pending_reward` tests | Every view in section 8 with exact JSON shapes |
| R-07 owner is a DAO account | owner fixture only | A real SputnikDAO calling `allow_tokens`, `set_close_grace_ns` and `upgrade` |

The build rule from the previous spec (section 20) applies: break each new rule on purpose and confirm its test fails.
