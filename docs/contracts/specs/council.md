# Dragons Market: council contract implementation spec, version 6 accounting

**The complete function set the Council needs for NFT seats, juries and holder revenue, with the version 6 accounting ("pay by arrival, claim by quarter") that replaced the version 5 quarter books.**

| Field | Value |
| --- | --- |
| Date | 2026-10-31 |
| Status | Describes state version 6, built in `contracts/council/src/lib.rs`. Checked against the source on 2026-10-31 (working tree, uncommitted) |
| Scope | `contracts/council/src/lib.rs` |
| Replaces | The version 5 model: seat-time quarter books, `finalize_quarter`, `advance_quarters`, `book_seat_time`, `claim_quarter` and the claim grace period. All were removed in version 6 |
| Index | [README.md](README.md) |

---

## Contents

1. [Summary](#1-summary)
2. [Purpose and roles](#2-purpose-and-roles)
3. [Money flows in Intents terms](#3-money-flows-in-intents-terms)
4. [State](#4-state)
5. [Message grammar](#5-message-grammar)
6. [The version 6 accounting](#6-the-version-6-accounting)
7. [Methods](#7-methods)
8. [Views the website and keeper need](#8-views-the-website-and-keeper-need)
9. [Events](#9-events)
10. [Invariants](#10-invariants)
11. [Errors](#11-errors)
12. [Test evidence](#12-test-evidence)

---

## 1. Summary

The Council holds staked NFT seats, draws juries, locks a drawn seat until its case is final, and keeps its reward backing in its own Intents account. Revenue arrives by `mt_on_transfer` and payouts leave by `mt_transfer`.

Section 6 is the accounting. In one paragraph: a seat staked on UTC day D starts earning at the start of day D+1. Each revenue sweep is split equally among the seats earning when it arrives, so a seat never shares a sweep that came before it started. Quarters are UTC calendar quarters. What a seat earned in a finished quarter is claimable once the quarter closes, with `claim`, and never expires. The quarter still running cannot be claimed. A seat that asks to leave before its quarter ends gives up 50% of that running quarter's earnings only: the cut half goes to a pool shared at quarter close among the seats earning then, and the kept half is paid at quarter close. A silent juror forfeits its earnings while serving, and the other earning seats share them. The cut is fixed (`LEAVER_CUT_BPS` is 5000) and not configurable.

| Change in version 6 | Section |
| --- | --- |
| Revenue index and day cursor replace quarter books and seat weights | 4, 6 |
| `claim(token_ids)` replaces `claim_quarter`; `request_unstake` takes `accepts_cut` | 6.5, 6.6, 7 |
| Anyone can call `advance_days`; every money call walks the days first | 6.2, 7 |
| `finalize_quarter`, `advance_quarters`, `book_seat_time`, `set_close_grace_ns` removed | 7 |
| Views for earnings, claimable and in-progress amounts, quarter calendar and snapshots | 8 |

---

## 2. Purpose and roles

| Role | Set by | Powers |
| --- | --- | --- |
| Owner | `new`, `propose_owner` and `accept_owner`. DECIDED: the DAO | `upgrade`, `seal`, `remove_verifier_key`, `propose_owner`, `set_cooldown_ns`, `set_max_seats_per_account`, `set_nft_contract` (only with nothing staked), `allow_tokens`, `set_token_range`, `clear_token_range`, `set_allowlist_enabled`, `allow_market`, `disallow_market`, `set_reconcile_wait_ns`, `reconcile_claim` |
| Oracle | `new`, no setter | `draw` and `unlock_case` only |
| Seat owner | Staking | `request_unstake`, `unstake`, and `claim` |
| NFT contract | `set_nft_contract` | `nft_on_transfer` only |
| Verifier | `new`, no setter | `mt_on_transfer` only |
| Market | `allow_market` | The only accounts whose revenue the Council accepts |
| Anyone | none | `stage_code`, `advance_days`, every view |

Eligibility rules stay as built: only a staked NFT of the configured collection that passes the allowlist earns or enters a jury draw. Treasury membership grants no holder reward. A seat belongs to the previous owner of the token, not to the account that relayed it.

---

## 3. Money flows in Intents terms

The Council has its own Intents account `C`, with no key registered in the verifier and predecessor authentication on. `C` holds only reward backing. Dispute bonds and juror pay live in the oracle's account and the market's backing lives in the market's account.

| Money | Path | Verifier call |
| --- | --- | --- |
| 25% of earned fees | Market `M` to `C` | The market calls `mt_transfer_call(receiver_id=C, token_id, amount, null, null, msg="revenue:<sweep_id>")`. The verifier credits `C`, then calls `C.mt_on_transfer` |
| A holder's payout | `C` to the holder's own Intents account | The Council calls `mt_transfer(receiver_id=owner, token_id, amount, null, null)` with 1 yocto |
| NFT return on unstake | NFT contract | `nft_transfer`, no collateral involved |

Surplus: a plain deposit into `C` credits `C` and calls nothing. It is never counted and no method credits it (Reported in `INTENTS-PROOF.md`, tested in `intents_verifier.rs`).

The reconciliation identity for `C`, with no claim in flight: `mt_balance_of(C, token) >= total_received - total_paid`. Equality means no surplus.

---

## 4. State

`state_version` is 6. The fields below are the ones that matter to accounting. The upgrade, allowlist, owner and counterparty fields are unchanged from earlier versions.

| Field | Type | Meaning |
| --- | --- | --- |
| `allowed_markets` | `Vec<AccountId>` | The accounts that may send revenue. The last one cannot be removed |
| `reconcile_wait_ns` | `u64` | How long a claim must be pending before `reconcile_claim`. Default 1 hour, owner range 10 minutes to 7 days |
| `received` | `LookupMap<(AccountId, u64), VersionedReceived>` | Revenue by market account and sweep id. `Received` is `{amount, at}` (version 5 also held the quarter) |
| `total_received`, `total_paid`, `pending_claims_total` | `u128` | Everything taken in, everything paid, and claims in flight |
| `acc` | `u128` | The revenue index: the units credited to one earning seat so far, times `ACC_SCALE` (10^18). It only grows |
| `carry_scaled` | `u128` | The scaled remainder of the last split, added to the next |
| `carry` | `u128` | Revenue waiting for the next split: a sweep that came while no seat was earning, and what silent jurors lost with no other seat earning |
| `cut_pool` | `u128` | The cut halves of seats that left in the running quarter |
| `active` | `u32` | Seats earning now |
| `joins_on` | `LookupMap<u64, u32>` | Seats staked and not yet earning, counted by the UTC day they start |
| `last_day` | `u64` | The last UTC day folded into `active`. Money calls need it to be today |
| `day_acc` | `LookupMap<u64, u128>` | The index at the start of each day on which seats started |
| `quarter_acc` | `LookupMap<u32, u128>` | The index at the moment each quarter closed, after the cut pool was shared |
| `last_closed_quarter` | `u32` | The latest quarter with a snapshot |
| `accrued`, `accrued_total` | `LookupMap<AccountId, u128>`, `u128` | Earnings settled to an account and claimable now, and their sum |
| `pending`, `pending_total_slots` | `LookupMap<AccountId, Pending>`, `u128` | The kept half of a leaver's running-quarter earnings, one slot for each account, and their sum |
| `next_claim_id`, `claims` | `u64`, `LookupMap<u64, Claim>` | Claims in flight |
| `unstakes_in_flight` | `u32` | Seats taken out of `staked` whose NFT transfer has not been answered. They count against the 1,000 seat cap |

```text
Stake    { owner, staked_at, unlock_requested_at, serving, earn_from_day,
           settled_acc, forfeited, serving_acc, index }
Pending  { quarter: u32, amount: u128 }
Claim    { account, amount: u128, tokens: Vec<TokenId>, requested_at: u64 }
Received { amount: u128, at: u64 }
```

`settled_acc`, `forfeited`, `serving_acc` and `index` are hidden from JSON. Every map record is stored behind a one-byte version tag, read through `into_current` and always written current.

The version 5 maps (quarter books, seat weights, forfeits, quarter claims) stay in storage under prefixes 5 to 8, unread, and no new map may use those prefixes.

Storage grows with the days on which seats started, the closed quarters, and the accounts holding a balance or a pending slot. Sizes were not measured for version 6.

---

## 5. Message grammar

| Message | Sender | Effect |
| --- | --- | --- |
| `revenue:<sweep_id>` | an allowed market only | Walks the days (at most 30), splits the amount among the seats earning, records `received[(market, sweep_id)]`, adds to `total_received` |

`<sweep_id>` is a `u64` decimal. The checks:

1. The caller must be the verifier, the money must come from the sender's own balance, with exactly one token and one amount, and the token id must equal `collateral_token_id`.
2. `sender_id` must be on the allow-list (`revenue comes from an allowed market only`). A different sender panics and the verifier refunds it in full.
3. A `sweep_id` already in `received` for that market panics (`that sweep was already received`) and the verifier refunds it. This makes a repeated send harmless.
4. Any other text panics (`unknown action`).

Staking uses NEP-171 `nft_transfer_call` to the Council. `msg` is ignored. The website sends an empty string.

---

## 6. The version 6 accounting

This section is built. Every sentence here was checked against the source.

### 6.1 Quarter boundaries

A quarter is a UTC calendar quarter: January to March, April to June, July to September, October to December. The quarter starts at 00:00:00 UTC on the first day of its first month and ends, exclusive, where the next quarter starts. A timestamp exactly on a boundary belongs to the new quarter.

The quarter id is `year * 4 + (quarter - 1)` as a `u32`, so 2026 Q4 is 8107.

| Quarter | Id | Starts (UTC) | Starts (ns) | Days |
| --- | --- | --- | --- | --- |
| 2026 Q4 | 8107 | 2026-10-01 | 1790812800000000000 | 92 |
| 2027 Q1 | 8108 | 2027-01-01 | 1798761600000000000 | 90 |
| 2027 Q2 | 8109 | 2027-04-01 | 1806537600000000000 | 91 |
| 2027 Q3 | 8110 | 2027-07-01 | 1814400000000000000 | 92 |
| 2027 Q4 | 8111 | 2027-10-01 | 1822348800000000000 | 92 |
| 2028 Q1 | 8112 | 2028-01-01 | 1830297600000000000 | 91 (leap year) |

Test vectors: `1798761599999999999` (2026-12-31T23:59:59.999999999Z) is in 8107. `1798761600000000000` is in 8108. `1835438400000000000` (2028-02-29T12:00:00Z) is in 8112.

The contract needs no date library. It converts days since 1970-01-01 to a civil year and month with the standard integer algorithm, then derives the quarter. The function is pure and is tested at every month boundary from 1970 to 2100.

### 6.2 The day cursor

`advance_days(max_steps)` is permissionless and walks `last_day + 1` up to today, at most `MAX_DAY_STEPS` (100) days a call. For each day, in this order:

1. If the day is the first day of a new quarter, close the previous quarter. With seats earning, share the cut pool and then the carry like a sweep. With none, move the cut pool to the carry. Then store the index as that quarter's snapshot, set `last_closed_quarter` and emit `quarter_closed`.
2. Start the seats whose first earning day it is: add their count to `active` and store the index in `day_acc` for that day.

The order matters. A seat that starts on the first day of a quarter starts after the pool was shared, so it does not share the pool.

A walk emits one `seats_started` at its end (only if a seat started) and one `quarter_closed` for each quarter it closed, so it never writes the 100 logs a call is allowed.

Every call that changes the index, the seat count, a seat or a balance first walks the days itself and then requires `last_day` to be today, panicking with `call advance_days first` if it is too far behind. `request_unstake` and `claim` walk up to 100 days, because the holder can attach the gas. The revenue receipt and `unlock_case` (with a silent juror) walk up to `MAX_RECEIPT_CATCH_UP_DAYS` (30) and refuse beyond it. `draw` walks up to 30 first and does not refuse. Sweeps come at least daily, so the cap is reached only when the keeper and every holder have been idle for a month. The keeper job is a convenience, not a dependency, and the keeper calls only `advance_days`.

### 6.3 Sharing a sweep

A sweep of `R` units with `active > 0` raises the index by `(R + carry) * ACC_SCALE / active`, rounded down, with the scaled remainder kept in `carry_scaled` for the next split. The carry is spent. With `active == 0` the sweep goes to `carry` and waits for the next sweep or the next quarter close, whichever comes first. Total credited therefore never exceeds total received.

A seat's earnings are the rise of the index from its start (the index stored for its first earning day, or the index where it was last settled if higher) divided by `ACC_SCALE`, rounded down. A sweep that arrived before the seat started is never part of that rise.

The index only grows, so its `u128` bounds the whole life of the council, not one sweep: it is full once the units shared per earning seat reach about 3.4 * 10^20.

### 6.4 Settling finished quarters

`settle_closed` moves a seat's earnings up to the last closed quarter's snapshot into its owner's `accrued` balance and sets the seat's `settled_acc` to that snapshot. Earnings after the snapshot stay unsettled and cannot be claimed. For a seat that is serving, the bound is the lower of the snapshot and the index at the draw, so a juror cannot claim what its seat earns while serving before its case is released. Money earned before the draw stays claimable. The units a silent juror lost (`forfeited`) come off the running quarter's earnings first, so finished quarters are paid in full whenever the running quarter can absorb the forfeit.

### 6.5 Leaving

`request_unstake(token_id, accepts_cut: bool)` requires exactly 1 yoctoNEAR before changing any state and refuses unless `accepts_cut` is true (`leaving before the quarter ends costs 50% of this quarter's earnings: pass accepts_cut true`). Both are required on every request. Restricted FunctionCall keys cannot attach the deposit. After the days are walked:

1. Settle finished quarters and move a pending slot whose quarter has closed into `accrued`. Earnings of earlier quarters are never cut.
2. The running-quarter earnings `E` are the seat's earnings since its start or last settlement, less what is still to come off for a forfeit. They are zero if the seat has not started.
3. `cut = E * LEAVER_CUT_BPS / BPS_DENOMINATOR` (5000 over 10000, rounded down) and `kept = E - cut`. The cut joins `cut_pool`. The kept half joins the owner's `pending` slot for the running quarter (a second leave in the same quarter adds to the same slot).
4. The seat stops earning: `active` goes down by one, or the seat is taken off `joins_on` if it has not started. `unlock_requested_at` is set to now and `settled_acc` to the current index.
5. Events `seat_cut` and `unstake_requested`.

The leave date is the request date. The numbers are fixed at the call, so a late snapshot cannot change them. A seat serving on an open case cannot request. A seat that requested is not drawn.

The cut half is shared among the seats earning when the quarter closes. The kept half becomes claimable when the quarter closes. Unstakes are never blocked.

### 6.6 Claiming

`claim(token_ids)` is payable (exactly 1 yocto) with a gas floor of 33 TGas, and takes at most `MAX_CLAIM_TOKENS` (10) tokens, every one staked by the caller. After the days are walked it moves a closed pending slot into `accrued`, settles each listed seat, and pays `accrued[caller]` in full with one `mt_transfer`. An empty list pays what is already in `accrued`, which is how a holder who has left collects.

| Step | State change | Failure |
| --- | --- | --- |
| 1 | Check every listed token is staked by the caller. Walk the days. Settle | `not staked`, `not your seat`, `at most 10 tokens in one claim`, `call advance_days first` |
| 2 | Remove `accrued[caller]`. Refuse zero | `nothing to claim` |
| 3 | Subtract the amount from `accrued_total`, add it to `pending_claims_total`. Write `claims[id] = {account, amount, tokens, requested_at}`. Emit `claim_requested` | none |
| 4 | Send `mt_transfer(caller, token_id, amount)` from `C`, then `on_claim_paid(id)` | The verifier receipt fails (paused, locked, out of gas) |
| 5a | Success: remove the record, `pending_claims_total -= amount`, `total_paid += amount`. Emit `claim_paid` | |
| 5b | Failure: remove the record, `pending_claims_total -= amount`, credit `accrued` and `accrued_total`. Emit `claim_failed` | |

A callback that runs again or late finds no record and changes nothing. `reconcile_claim(id, paid)` (owner only, after `reconcile_wait_ns`) decides a claim whose callback never came, through the same closing step. Claims never expire.

The record is debited before the transfer is sent, the same pattern the rounds contract uses for withdrawals. `mt_transfer` returns nothing and is one verifier receipt, so an error means nothing moved. There is no other path: `unstake` pays nothing, so a holder can never draw the same earnings twice.

### 6.7 Silent jurors

`draw` walks the days first, then stores `serving_acc` (the index) on each drawn seat. `unlock_case(case_key, delinquent)` forfeits, for a delinquent owner, what the seat earned from `max(serving_acc, start)` to now, capped at what it has not settled. The other earning seats share that at once and only they: with `others = active - 1 > 0` the index rises by `lost * ACC_SCALE / others`, and the seat is docked its own share of that rise (rounded up), so it keeps nothing of what it lost. With no other seat earning, the units go to `carry` and the seat is docked `lost`. The units come off the seat's next settlements. A voter forfeits nothing, and settled money is never touched. Event `seat_earnings_forfeited`. A second call for the same case does nothing.

### 6.8 Periods with no seats

Revenue that arrives while no seat is earning goes to `carry` and is shared at the next sweep or at the next quarter close, whichever comes first. A cut pool at a quarter close with no seat earning moves to `carry` too. Nothing leaves `C`.

### 6.9 Worked examples

All amounts are in the six-decimal collateral unit.

**Example 1: arrival.** Seats 1 and 2 are earning. Seat 3 is staked on 20 November, so it starts earning on 21 November. A sweep of 600,000 arrives on 20 November and is shared by two seats: 300,000 each. A sweep of 900,000 arrives on 21 November and is shared by three: 300,000 each. Seat 3 has earned 300,000.

**Example 2: leaving.** Seat 1 has earned 100,001 in the running quarter and 800,000 in earlier quarters. It requests to leave with `accepts_cut` true. The 800,000 is settled to its balance in full. The cut is `floor(100,001 * 5000 / 10000)` = 50,000 and the kept half is 50,001. When the quarter closes, four seats are earning and share the cut pool: 12,500 each. The 50,001 becomes claimable at the same moment.

**Example 3: nobody claims.** A quarter closes and nobody claims. Two quarters later the earnings are still claimable, with the same amounts.

**Example 4: a silent juror.** Seat 1 is drawn, then the case is released with seat 1 on the delinquent list. Seat 1 earned 40,000 since the draw. Three other seats are earning, so they share the 40,000, and seat 1 is docked those 40,000 plus its own rounded-up share of the rise. Seat 1 keeps nothing of them.

### 6.10 The 75/25 split and its legs

The split happens in the market, before the Council sees any money. The Council only receives the 25% leg.

Rounding rule, exact: `council = floor(total * 2500 / 10000)`, `treasury = floor(total * 7500 / 10000)`, and the remainder `total - council - treasury` (0 or 1 unit) goes to neither leg. It stays in the market's `fees` bucket and joins the next sweep. Full specification and a table of examples are in [market.md section 7.2](market.md#72-sweep-ledger-and-independent-legs-r-03).

The two legs are independent. The Council leg is a transfer call whose result the market reads. The treasury leg is a plain transfer. A refusal of either leg returns that amount to its own due bucket and changes nothing in the other. With sweep ids, a lost Council result is settled by asking the Council's `received_of(sweep_id)`, so the amount can be neither dropped nor paid twice.

### 6.11 Constants and gas

| Item | Value |
| --- | --- |
| `LEAVER_CUT_BPS` | 5000 of 10000 |
| `MAX_DAY_STEPS` | 100 (public `advance_days`, `claim`, `request_unstake`) |
| `MAX_RECEIPT_CATCH_UP_DAYS` | 30 (revenue receipt, `unlock_case`, `draw`) |
| `MAX_CLAIM_TOKENS` | 10 |
| `MAX_SNAPSHOT_PAGE` | 50 |
| `ACC_SCALE` | 10^18 |
| `claim` floor | 33 TGas (15 transfer, 10 callback, 8 own work). Own burn 5.3, 6.2 and 7.4 for 1, 5 and 10 tokens. The first claim after about 100 idle days burns about 65 in all, so attach 100 |
| `unstake` floor | 33 TGas (15 NFT transfer, 10 callback, 8 own work) |
| Stake (`nft_on_transfer`) floor | 38 TGas (10 ownership view, 20 callback, 8 own work) |
| `request_unstake` | 2.6 to 4.7 TGas, no floor |
| Revenue receipt | 2.0 to 11.7 TGas, up to 30 days behind. |
| `draw` at 1,000 seats | About 172 TGas. The oracle reserves 250, so `resolve_draw` needs about 275 attached |
| `unlock_case`, 21 silent jurors after a 30 day gap | 20.2 TGas. The oracle reserves 25 |

---

## 7. Methods

Gas floors are enforced with `upgrade::require_gas`.

| Method | Caller | Args | Returns | Yocto | Gas | Behaviour and refusals | Events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `new` | The account itself | `owner_id`, `oracle_id`, `verifier_id: AccountId`, `collateral_token_id: String`, `cooldown_ns: U64`, `max_seats_per_account: u32`, `allowlist_enabled: Option<bool>` | contract | none | n/a | Refuses a zero cooldown, a zero seat cap, an id without `nep141:`. The allowlist defaults to on. Takes neither the collection nor a market | none |
| `stage_code`, `upgrade`, `migrate`, `seal`, `remove_verifier_key`, `propose_owner`, `accept_owner` | as the market | | | | 100 TGas for `upgrade` | as the market. `migrate` accepts state versions 5 and 6 | `code_staged`, `upgrade_sent`, `upgrade_failed`, `migrated`, `seal_sent`, `verifier_key_removal_sent`, `owner_proposed`, `owner_changed` |
| `set_cooldown_ns` | Owner | `cooldown_ns: U64` | none | none | none | Above zero, at most a year. Applies to requests already made | `cooldown_set` |
| `set_max_seats_per_account` | Owner | `u32` | none | none | none | Refuses zero. Does not remove seats already held | `max_seats_per_account_set` |
| `set_nft_contract` | Owner | `nft_contract: AccountId` | none | none | none | Refuses while any seat is staked | `nft_contract_set` |
| `allow_tokens` | Owner | `token_ids: Vec<String>` | none | none | none | 1 to 100 ids | `tokens_allowed` |
| `set_token_range`, `clear_token_range` | Owner | `first: U64`, `last: U64` | none | none | none | Plain decimal ids only | `token_range_set`, `token_range_cleared` |
| `set_allowlist_enabled` | Owner | `enabled: bool` | none | none | none | Does not unstake anything | `allowlist_set` |
| `allow_market`, `disallow_market` | Owner | `market: AccountId` | none | none | none | Adds or removes a revenue sender. What a removed market sent stays. The last one cannot be removed | `market_allowed`, `market_disallowed` |
| `set_reconcile_wait_ns` | Owner | `reconcile_wait_ns: U64` | none | none | none | 10 minutes to 7 days. Live. `reconcile_claim` reads it | `reconcile_wait_set` |
| `draw` | Oracle | `case_key: U64`, `n: u32`, `exclude: Vec<AccountId>` | `Vec<AccountId>` | none | 250 TGas reserved by the oracle | Reads the block seed itself. A repeat returns the cached jury. Walks up to 30 days. Skips seats that serve, are leaving, or are excluded, and sets aside seats staked within the last cooldown unless the older seats cannot make a jury of distinct accounts. Marks the jury serving and records the index | `jury_drawn` |
| `unlock_case` | Oracle | `case_key: U64`, `delinquent: Vec<AccountId>` | none | none | 25 TGas reserved by the oracle | Releases the seats. With a silent juror it walks up to 30 days first and forfeits that seat's earnings (6.7) | `jury_released`, `seat_earnings_forfeited` |
| `request_unstake` | Seat owner | `token_id: String`, `accepts_cut: bool` | none | exactly 1 | none | 6.5. Refuses a missing `accepts_cut`, a seat that serves, or one that already asked | `seat_cut`, `unstake_requested` |
| `unstake` | Seat owner | `token_id: String` | `Promise` | exactly 1 | 33 TGas floor | Removes the stake and returns the NFT, no payout. Refuses before the cooldown has passed | `unstaked`, `unstake_failed` |
| `on_unstaked` | The account itself | | | | 10 TGas | Restores the stake when a transfer fails | |
| `claim` | Seat owner | `token_ids: Vec<TokenId>` (at most 10) | `Promise` | exactly 1 | 33 TGas floor, attach 100 | 6.6 | `claim_requested`, `claim_paid`, `claim_failed` |
| `on_claim_paid` | The account itself | `id: U64` | none | none | 10 TGas | Closes the claim record. A repeat or late callback changes nothing | `claim_paid`, `claim_failed` |
| `reconcile_claim` | Owner | `id: U64`, `paid: bool` | none | none | none | Decides a claim whose payout callback never arrived, after `reconcile_wait_ns`. A late callback changes nothing | `claim_reconciled` |
| `advance_days` | Anyone | `max_steps: Option<u32>` (at most 100) | `u32` days moved | none | none | 6.2 | `seats_started`, `quarter_closed` |
| `mt_on_transfer` | The verifier | `sender_id`, `previous_owner_ids: Vec<AccountId>`, `token_ids: Vec<String>`, `amounts: Vec<U128>`, `msg: String` | `Vec<U128>`, always `["0"]` | none | attached gas minus about 20.5 | Section 5 | `revenue` |
| `nft_on_transfer` | The NFT contract | `sender_id`, `previous_owner_id: AccountId`, `token_id: String`, `msg: String` | `PromiseOrValue<bool>` | none (the user attaches 1 yocto to `nft_transfer_call` on the NFT contract) | 38 TGas floor | Checks the collection, the allowlist, the seat limits, then asks the collection who owns the token. `on_stake_checked` records the seat for `previous_owner_id` and its start day | `staked`, `stake_refused` |

Removed in version 6: `claim_quarter`, `finalize_quarter`, `advance_quarters`, `book_seat_time`, `set_close_grace_ns`, `get_quarter`, `list_quarters`, `get_entitlement`, `entitlements_of`, `entitlements_page_quarters`, `current_quarter`, `quarter_of`.

Every owner row is a plain `AccountId` check. No row names or calls a governance contract.

---

## 8. Views the website and keeper need

| Quantity | View | Returns |
| --- | --- | --- |
| What a claim would pay now | `claimable_of(account_id)` | `U128`: the settled balance, a pending slot whose quarter is closed, and the finished-quarter earnings of the account's seats. It does not walk the days |
| What is earning but not claimable | `in_progress_of(account_id)` | `U128`: the running-quarter earnings of the account's earning seats plus a pending slot that is not yet closed |
| One seat | `seat_earnings(token_id)` | `Option<SeatEarnings>` |
| The running quarter | `quarter_info()` | `{quarter, starts_at: U64, ends_at: U64, last_closed_quarter, last_day: U64}` |
| Open claims by quarter | `quarter_snapshots(from: Option<u32>, limit: Option<u32>)` | `Vec<{quarter, acc: U128}>`, oldest first, at most 50 |
| An account's staked seats | `seats_of(account_id)` | `Vec<TokenId>` |
| Revenue by sweep | `received_of(market: AccountId, sweep_id: U64)` | `Option<{amount: U128, at: U64}>` |
| Totals for reconciliation | `reward_totals()` | `{total_received, total_paid, pending_claims, carry, cut_pool, accrued_total, pending_total_slots}`, all `U128` |
| Stake record | `stake_of(token_id)` | `Option<Stake>` with `earn_from_day` |
| Case jury | `jury_of(case_key)` | `Vec<TokenId>` |

```text
SeatEarnings { owner: AccountId, state: "waiting" | "earning" | "leaving" | "serving",
               earning_from: U64 (ns), earned_closed: U128, earned_in_progress: U128,
               start_acc: U128, settled_acc: U128 }
```

| UI label | Source |
| --- | --- |
| Claimable | `claimable_of` |
| In progress | `in_progress_of`, and `seat_earnings.earned_in_progress` for one seat |
| Paid | `claim_paid` events and `reward_totals.total_paid` |
| Quarter | `quarter_info`, and `quarter_snapshots` for the quarters already closed |

`claimable_of` shows a finished quarter only once something has walked the days past its end. Before that, the same earnings show as in progress.

---

## 9. Events

Envelope: `EVENT_JSON:{"standard":"council","version":"1.0.0","event":"<name>","data":{...}}`.

| Event | Data |
| --- | --- |
| `staked` | `token_id`, `owner` |
| `stake_refused` | `token_id`, `owner`, `owned` |
| `unstake_requested` | `token_id`, `owner`, `unlock_at` (string ns) |
| `unstaked`, `unstake_failed` | `token_id`, `owner` |
| `seat_cut` | `token_id`, `owner`, `quarter`, `earned`, `cut`, `kept` |
| `revenue` | `from`, `market` (the same account), `amount`, `sweep_id`, `seats`, `per_seat`, `carried` |
| `seats_started` | `from_day`, `to_day`, `start_days`, `count` (one for each walk) |
| `quarter_closed` | `quarter`, `acc`, `cut_shared`, `carried` |
| `claim_requested`, `claim_paid`, `claim_failed` | `id`, `account`, `amount`, `tokens`, `requested_at` |
| `claim_reconciled` | as above, plus `paid` |
| `seat_earnings_forfeited` | `token_id`, `owner`, `case_key`, `amount` |
| `jury_drawn` | `case_key`, `tokens`, `owners` |
| `jury_released` | `case_key`, `delinquent` |
| `market_allowed`, `market_disallowed` | `market` |
| `nft_contract_set` | `nft_contract` |
| `reconcile_wait_set` | `reconcile_wait_ns` |
| `cooldown_set`, `max_seats_per_account_set`, `tokens_allowed`, `token_range_set`, `token_range_cleared`, `allowlist_set` | the changed value |
| `owner_proposed`, `owner_changed`, `code_staged`, `upgrade_sent`, `upgrade_failed`, `migrated`, `seal_sent`, `verifier_key_removal_sent` | as the market |

---

## 10. Invariants

| Invariant | Statement | Test status |
| --- | --- | --- |
| I-C1 revenue conservation | `total_paid + pending_claims_total + accrued_total + pending_total_slots + cut_pool + carry + (earnings of live seats) <= total_received`, with equality up to rounding dust that stays in the contract. `mt_balance_of(C) >= total_received - total_paid` with no claim in flight | Property test over random stakes, leaves, sweeps, draws, releases and claims, and `with_round_numbers_every_unit_is_in_exactly_one_place` |
| I-C2 no early share | A seat never earns from a sweep that arrived before its start day | `a_payment_that_came_before_a_seat_started_is_never_shared_with_it` |
| I-C3 single use | A claim record is closed once. A failed transfer credits the balance back, and a late or repeated callback changes nothing | `a_claim_pays_once_and_a_failed_transfer_puts_the_balance_back` |
| I-C4 no second path | No method other than `claim` sends reward money to a holder. `unstake` pays nothing | Source: `mt_transfer` is sent only by the claim payout |
| I-C5 one receipt per sweep | `received` holds each `(market, sweep id)` at most once, and a repeat is refused so the verifier refunds it | `a_sweep_id_is_taken_once_and_the_repeat_is_refused` |
| I-C6 calendar | The quarter function matches the vectors in 6.1 and is monotonic | `the_quarter_table_holds`, `every_month_boundary_from_1970_to_2100_falls_in_the_right_quarter` |
| I-C7 jury integrity | A drawn seat cannot leave until its case is final, and a seat that asked to leave is not drawn | `a_seat_that_asked_to_unstake_is_never_drawn` |
| I-C8 separation | `C` never holds bonds or market backing. `O` and `M` never hold holder revenue | Reconciliation test over all three accounts is still to write |

---

## 11. Errors

Exact panic strings as built (checked in source: `council/src/lib.rs`).

| Group | Strings |
| --- | --- |
| Access | `owner only`, `oracle only`, `not the proposed owner`, `not your seat`, `not staked`, `wrong NFT contract`, `only the verifier can deliver money` |
| Delivery | `the money must come from the sender's own balance`, `exactly one token and amount`, `wrong token`, `unknown action`, `revenue comes from an allowed market only`, `that sweep was already received` |
| Staking | `that token is not on the allowlist`, `already staked`, `the council is full`, `that account already holds the most seats allowed`, `attach at least 38 TGas: a stake checks the token's owner and then records the seat` |
| Leaving and claiming | `leaving before the quarter ends costs 50% of this quarter's earnings: pass accepts_cut true`, `unstake already requested`, `this seat is serving on an open case`, `request an unstake first`, `the cooldown has not passed`, `at most 10 tokens in one claim`, `nothing to claim`, `no claim is pending with that id`, and the gas refusals `attach at least 33 TGas: an unstake returns the NFT and then settles it` and `attach at least 33 TGas: a claim sends the payout and then settles it` |
| Days | `call advance_days first` |
| Markets | `already an allowed market`, `not an allowed market`, `keep at least one allowed market`, `the Council is not configured, the owner must call allow_market`, `the NFT collection is not set, the owner must call set_nft_contract` |
| Settings | `the cooldown must be positive`, `the cooldown must be positive and at most a year`, `an account must be allowed at least one seat`, `unstake every seat before changing the NFT contract`, `name at least one token`, `at most 100 tokens in one call`, `the first id must not be above the last`, `the reconcile wait must be between 10 minutes and 7 days`, `the collateral token id must look like nep141:<token>` |
| Draw | `not enough seat holders to draw a jury: {} eligible, {} needed` |
| Upgrade | `there is no state to migrate`, `unsupported state version`, `migrate runs only inside an upgrade`, `prove the upgrade path before deleting keys`, `a stored record has a newer version than this code can read` |
| Version 5 to 6 migration | `a finished quarter is not finalized yet, finalize it and let its holders claim before upgrading`, `a claim is still pending, settle it before upgrading`, `a finalized quarter still has money to claim, claim it before upgrading`, `an unstake is still waiting for its NFT transfer` |

---

## 12. Test evidence

The version 6 rules are covered by unit tests in `contracts/council/src/lib.rs` with controlled block times.

| Requirement | Evidence |
| --- | --- |
| Earning by arrival | `a_seat_staked_on_a_day_earns_nothing_from_that_day_and_its_full_share_from_the_next`, `two_payments_are_split_by_whoever_is_earning_at_each`, `a_payment_with_no_earning_seat_is_carried_and_shared_at_the_next`, `rounding_leaves_the_remainder_in_the_contract_and_the_next_split_uses_it` |
| Quarter close | `advance_days_closes_a_quarter_and_stores_its_snapshot`, `a_seat_starting_on_the_first_day_of_a_quarter_does_not_share_the_closing_cut_pool`, `the_cut_pool_is_split_among_the_seats_earning_at_the_boundary`, `the_cut_pool_is_carried_when_nobody_is_earning_at_the_boundary`, `a_quarter_nobody_claims_stays_claimable_two_quarters_later` |
| Leaving | `a_request_to_leave_is_refused_without_accepts_cut_and_for_a_seat_that_is_not_the_callers`, `a_leaver_loses_half_of_the_running_quarter_and_nothing_from_earlier_ones`, `the_kept_half_of_a_leaver_cannot_be_claimed_until_the_quarter_closes`, `a_leavers_amounts_are_the_same_whether_the_snapshot_is_taken_on_time_or_days_late` |
| Self-healing and caps | `revenue_request_unstake_and_claim_run_the_overdue_snapshot_themselves`, `a_receipt_and_a_release_walk_at_most_thirty_days_and_a_claim_or_an_unstake_a_hundred`, `advance_days_walks_at_most_a_hundred_days_a_call_and_as_many_as_it_is_asked` |
| Claims | `a_claim_pays_once_and_a_failed_transfer_puts_the_balance_back`, `nobody_claims_for_a_seat_they_do_not_hold`, `one_claim_settles_ten_seats_into_one_payout`, `only_the_owner_decides_a_stuck_claim_and_not_before_the_wait` |
| Juries | `a_silent_juror_loses_what_its_seat_earned_while_serving_and_only_the_others_share_it`, `a_claim_while_serving_pays_only_what_came_before_the_draw_and_the_rest_waits_for_the_release`, `a_forfeit_comes_off_the_running_quarter_first_so_the_finished_one_is_paid_in_full`, `jurors_who_voted_lose_nothing` |
| Migration | `migrate_moves_version_five_to_six_keeps_the_seats_and_carries_the_open_revenue`, `migrate_refuses_while_a_finalized_quarter_has_money_to_claim`, `migrate_refuses_while_a_finished_quarter_is_not_finalized`, `migrate_allows_a_rounding_leftover_for_each_finalized_quarter` |
| Owner is a DAO account | Owner fixture only. A real SputnikDAO calling `allow_tokens` and `upgrade` is still required |
| Sandbox | Real contracts on the sandbox chain, with the day ledger edited to end a quarter: `quarter_claims.rs` (claims, leaving, reconcile), `pay_by_arrival.rs` (earning by arrival, carry, refused payout), `juror_pay.rs` (silent jurors, claim while serving), `council_migration.rs` (version 5 to 6), `council_gas.rs` and `gas_floors.rs` (gas), `staking.rs`, `revenue.rs` and `upgrade.rs` |

The build rule from the previous spec applies: break each new rule on purpose and confirm its test fails.
