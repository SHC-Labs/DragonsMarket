# council

Target decision, 2026-10-20: retain NFT staking, eligibility, jury duties and reward accounting.
The Council controls the 25% holder allocation with backing held in NEAR Intents; eligible
holders claim by quarter. The other 75% goes to the Trezu treasury. Trezu/SputnikDAO replaces custom
governance as the administration target; treasury votes do not replace juries. See
[the architecture](../intents-architecture.md).

Status, state version 6 ("pay by arrival, claim by quarter"): each revenue sweep is split equally
among the seats that are earning when it arrives. A seat staked on UTC day D starts earning on day
D+1. What a seat earned in a finished UTC calendar quarter is claimable once the quarter closes, with
`claim`, and never expires. The earnings of the quarter still running cannot be claimed. A seat that
asks to leave before its quarter ends gives up half of that quarter's earnings. `unstake` returns the
NFT and pays nothing. A silent juror forfeits what its seat earned while serving, and the other earning
seats share it. Version 6 replaced the version 5 model, which booked seat time by quarter and needed
`finalize_quarter`, `advance_quarters`, `book_seat_time` and `claim_quarter`; those methods and the
grace period (`close_grace_ns`) no longer exist. Neither the NFT collection nor the market is written
in the code or taken by `new`: the owner sets the collection with `set_nft_contract` and the markets
with `allow_market`, and staking, revenue and claims refuse until it has. Revenue arrives through the
NEAR Intents verifier as `mt_on_transfer` with the message `revenue:<sweep id>`, only from an allowed
market account, and claims are paid out of the Council's own account in it with `mt_transfer` of 1
yocto, with no signed intent and no key registered in the verifier. The DAO voting period is the only
delay before an owner action (decided 2026-10-21).

Source: `council/src/lib.rs`, with the shared upgrade helpers in `upgrade/src/lib.rs`. Checked
against the source on 2026-10-31. The code describes current behaviour. The accepted spec defines the
target; differences are implementation work, not reasons to drop a requirement. The design behind
version 6 is in [specs/council.md](specs/council.md).

---

## Required changes for the product target

See the requirements map in [spec.md](../spec.md#requirements-to-implementation-map).

- Done: eligible NFT staking, earning rules, case locks and jury duties are kept.
- Done: each holder's earnings are tracked per seat from a revenue index, with the backing inside
  Intents. A payout is reserved once, paid through Council-authorised settlement, and confirmed or
  recovered without a second spendable claim.
- Done: quarter boundaries (UTC calendar), late-arriving fees (a sweep is shared by the seats earning
  when it arrives), no-seat periods (the money waits and is shared at the next sweep or quarter
  close), rounding (down, the remainder stays in the Council) and unclaimed balances (they stay
  claimable for good).
- Done: earnings, claimable and in-progress amounts, and the quarter calendar are views (see "Views").
- Open: administrative authority runs through the reviewed Trezu/Sputnik execution path, which still
  needs a run against a real DAO.

Jury work compensation stays separate from holder revenue.

---

## Contents

1. [What it is](#what-it-is)
2. [Where it sits among the other contracts](#where-it-sits-among-the-other-contracts)
3. [Roles: who can do what](#roles-who-can-do-what)
4. [Starting it up: `new`](#starting-it-up-new)
5. [Units and conventions](#units-and-conventions)
6. [Seats](#seats)
7. [Revenue](#revenue)
8. [Juries](#juries)
9. [Every method](#every-method)
10. [Upgrading this contract](#upgrading-this-contract)
11. [Views](#views)
12. [Events](#events)
13. [What can go wrong, and the message you will see](#what-can-go-wrong-and-the-message-you-will-see)
14. [Gas](#gas)
15. [Security properties checked by tests](#security-properties-checked-by-tests)
16. [Things to know](#things-to-know)

---

## What it is

council is the registry of Council seats. A seat is an NFT from one specific collection, locked into
this contract ("staked"). The contract does two jobs with the seats:

1. It supplies the jury. When oracle needs a jury for a dispute, it asks this contract to draw
   jurors at random from the staked seats.
2. It shares revenue. The Council's share of trading fees (25% to start) is sent here by the market.
   Each sweep is split equally among the seats earning at that moment, and a seat's holder claims
   what it earned in a finished quarter.

Only staked NFTs earn and only staked NFTs can be drawn. Holding the NFT without staking it does
nothing.

It does not decide anything about markets. The Council is a funding and revenue-share mechanism plus
a jury pool. It has no control over the contracts that hold the money or decide outcomes; that
belongs to the owner (the DAO).

---

## Where it sits among the other contracts

| Contract                                          | Relationship to council                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| oracle                                            | The only caller of `draw` and `unlock_case`. It asks for juries, one or two for each disputed case, and releases them when the case is final. |
| market                                            | Sends the Council's share of trading fees here as revenue, with an `mt_transfer_call` through the verifier. The only sender the Council accepts. |
| The NFT collection (NEP-171, in tests `mock-nft`) | The only collection that can be staked.                                                                                                       |
| The NEAR Intents verifier                         | Holds the Council's revenue in the Council's own account. Revenue arrives through it and claims are paid out of it.                           |
| The owner (the DAO)                               | Trezu/SputnikDAO. It holds the owner role.                                                                                                    |

---

## Roles: who can do what

| Role                 | Set by                                         | Can do                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                | `new`, then `propose_owner` and `accept_owner` | `set_cooldown_ns`, `set_max_seats_per_account`, `set_nft_contract`, `allow_market`, `disallow_market`, `set_reconcile_wait_ns`, `reconcile_claim`, `allow_tokens`, `set_token_range`, `clear_token_range`, `set_allowlist_enabled`, `propose_owner`, `upgrade`, `seal` and `remove_verifier_key`. Normally the DAO. |
| Oracle               | `new` (fixed)                                  | `draw` and `unlock_case`.                                                                                                                                                                                                     |
| Seat holder          | Stakes an NFT                                  | `request_unstake` and `unstake` for their own seats, and `claim` for the account's earnings. A holder who has fully left calls `claim` with an empty list.                                                                      |
| The verifier         | `new` (fixed)                                  | Only `mt_on_transfer`, which is how revenue arrives.                                                                                                                                                                          |
| The NFT collection   | `set_nft_contract`, changeable only while nothing is staked | Only `nft_on_transfer`, which is how seats are staked.                                                                                                                                                           |
| The markets          | `allow_market` and `disallow_market`           | The accounts whose `revenue:<sweep id>` message counts as revenue. There can be several.                                                                                                                                                        |
| Anyone               | n/a                                            | `advance_days`, `stage_code` (paying for the storage), and every view.                                                                                                                                                        |

There is no operator role in this contract.

---

## Starting it up: `new`

Called once, at deploy. It cannot be called again. Only the contract's own account can call it:
`new` is `#[private]`, so a deploy and init batch signed by that account is the one way in, and
anyone else gets `Method new is private`.

| Argument                | Meaning                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `owner_id`              | The owner. Normally the DAO.                                                                                                      |
| `oracle_id`             | The oracle contract.                                                                                                              |
| `verifier_id`           | The Intents verifier that holds the revenue, `intents.near` on mainnet.                                                           |
| `collateral_token_id`   | The revenue token's exact id in the verifier, `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` on mainnet. Must start with `nep141:`. |
| `cooldown_ns`           | How long a seat must wait between asking to unstake and leaving, in nanoseconds. Must be above zero.                              |
| `max_seats_per_account` | The most seats one account can hold. Must be at least 1.                                                                          |
| `allowlist_enabled`     | Optional. Left out, it is on. See "The allowlist". Passing `false` is for tests and for a collection that is safe without a list. |

There is also a fixed cap of 1,000 seats in the whole council, written into the code.

`new` takes neither the NFT collection nor the market, because neither may be guessed at deploy time.
The owner sets them afterwards with `set_nft_contract` and `allow_market`. Until the collection is set
nothing can be staked and no token can be allowed (`the NFT collection is not set, the owner must
call set_nft_contract`). Until a market is allowed no revenue is taken and no claim is paid (`the
Council is not configured, the owner must call allow_market`). The quarter before the one the contract
was created in starts as the last closed quarter, with an index of 0.

---

## Units and conventions

| Thing                      | Convention                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token ids                  | Strings, as the NFT collection uses them.                                                                                                                                |
| Times                      | Nanoseconds since the Unix epoch.                                                                                                                                        |
| Days                       | A UTC day is the time divided by 86,400 seconds, rounded down. Seats start earning, and quarters close, on a day boundary.                                              |
| Big numbers in JSON        | `U64` and `U128` travel as strings.                                                                                                                                      |
| Revenue amounts            | Raw units of the collateral token.                                                                                                                                       |
| Quarters                   | UTC calendar quarters. The id is `year * 4 + (quarter - 1)`, so 2026 Q4 is 8107. A quarter starts at 00:00 UTC on the first day of its first month and ends where the next one starts. A time exactly on a boundary belongs to the new quarter. |
| Revenue index              | A running count of the units credited to one earning seat so far, times 10^18. A seat's earnings are the rise of the index since it started (or was last settled), divided by 10^18, rounded down. |
| Rounding                   | A split keeps its remainder and adds it to the next split, so the units credited never pass the units received. What is left after a seat's last settlement is under one unit a seat and stays in the Council. |

---

## Seats

### Staking a seat

A holder calls `nft_transfer_call` on the NFT collection, naming this contract as the receiver. The
collection calls `nft_on_transfer` here. The message text is ignored. The contract checks, and
refuses (so the NFT goes straight back) unless:

| Check                                                   | Refusal message                                     |
| ------------------------------------------------------- | --------------------------------------------------- |
| The call comes from the configured collection           | `wrong NFT contract`                                |
| The allowlist is off, or the token is on it             | `that token is not on the allowlist`                |
| The token is not already staked                         | `already staked`                                    |
| The council has fewer than 1,000 seats (seats whose NFT return is still in flight count)  | `the council is full`                               |
| The holder has fewer than `max_seats_per_account` seats | `that account already holds the most seats allowed` |
| The call carries at least 38 TGas (10 for the ownership view, 20 for its callback, 8 for the call itself) | `attach at least 38 TGas: a stake checks the token's owner and then records the seat` |

If it accepts, the seat belongs to `previous_owner_id`, the account that owned the token, and not to
`sender_id`, which can be an approved marketplace or relayer. Crediting the sender
would let a relayer claim someone else's seat. The seat is confirmed in a second step, when the
collection says this contract owns the token; if that check fails the token goes back and nothing is
recorded (event `stake_refused`).

A seat staked on UTC day D earns nothing from a sweep that arrives on day D. It starts earning at the
start of day D+1 and shares every sweep that arrives from then on. It never shares a sweep that came
before it started.

The NFT is now held by this contract. It does not show in the holder's wallet and cannot be listed
on a marketplace until it is unstaked.

### A seat's record

| Field                 | Meaning                                           |
| --------------------- | ------------------------------------------------- |
| `owner`               | The account that staked it and will get it back.  |
| `staked_at`           | When it was staked.                               |
| `unlock_requested_at` | When unstaking was requested, if it was.          |
| `serving`             | The case the seat is currently drawn for, if any. |
| `earn_from_day`       | The UTC day the seat starts earning: the day after it was staked. |

Other fields exist internally and are not shown in `stake_of`: where the token sits in the staked
list, the revenue index the seat is settled up to, the units a silent juror lost that are still to
come off, and the index when the seat was drawn. `seat_earnings` shows the settled index and the
index at the seat's start.

### Claims and leaving

Earnings of a finished quarter are claimable the moment the quarter closes, and they never expire.
The earnings of the quarter that is still running cannot be claimed.

A holder who asks to leave before the quarter ends gives up half of the earnings of that running
quarter only. Earlier quarters are paid in full. The rest works like this:

- Every `request_unstake` must pass `accepts_cut: true`, or it is refused. The flag is required each
  time, so every request on chain shows the holder was told. A website pop-up shows the warning before
  the wallet asks for a signature.
- The cut is a fixed 50% (`LEAVER_CUT_BPS` is 5000). It is not configurable.
- The seat stops earning at the request, and the request date is the leave date.
- The cut half goes into a pool. When the quarter closes, the pool is shared equally among the seats
  that are earning at that moment. A seat that starts on the first day of the next quarter starts
  after the pool is shared and gets none of it. When no seat is earning, the pool waits and is shared
  at the next sweep or quarter close.
- The kept half is held in the owner's pending slot and is paid with the next claim after the quarter
  closes. There is one slot for each account, and a second leave in the same quarter adds to it.
- A seat that has not started earning yet loses nothing, earns nothing, and is taken off the count of
  seats starting on its day.
- Unstakes are never blocked by this rule. A holder can leave at any time, at the price above.

### Leaving: unstaking

It takes two steps and a wait.

1. `request_unstake(token_id, accepts_cut)` with exactly 1 yoctoNEAR attached. The holder asks to leave. Refused if the seat is serving
   on an open case or a request is already pending. The call settles the earnings of finished quarters
   to the holder's balance, applies the cut to the running quarter, and stops the seat earning. From
   now on the seat is not available to be drawn.
2. After the cooldown has passed, `unstake(token_id)` with 1 yoctoNEAR attached. The seat is removed
   and the NFT is returned. Unstaking pays no money, so it never touches reward backing. What the seat
   earned stays in the owner's balance and is claimed with `claim`, whoever holds the NFT afterwards,
   and an NFT sold after unstaking carries nothing with it.

If the NFT transfer fails (for example the collection is broken), the seat is restored, and it can
be unstaked again without waiting a new cooldown. It keeps its request, so it does not earn again.

Between the request and the unstake the seat earns nothing and cannot be drawn.

A seat cannot leave while serving on a case, and a seat that has asked to leave cannot be drawn, so
no seat is ever both.

### The cooldown

The cooldown is a deploy setting and the owner can change it with `set_cooldown_ns`, up to one year.
A change applies to every unstake from then on, including requests already made, which wait out the
new length. It must be at least as long as the oracle's challenge window plus panel deadline, which
this contract cannot check.

### The seat cap

`max_seats_per_account` limits how many seats one account can hold, so one wallet cannot gather a
large share of the jury draw and the revenue. It does not stop one person using many wallets.
Lowering it does not remove seats an account already holds. The owner changes it with
`set_max_seats_per_account`.

### The allowlist

Anyone who can mint a token of the collection could otherwise stake it and take a seat, so the
council only takes tokens the owner has named. The list is on when the council is made unless the
deployer passes `allowlist_enabled: false`, so by default nothing stakes until the owner has allowed
tokens. A token is allowed when it is named, or when its id is a whole number inside the allowed
range. Every name and the range belong to the collection that was current when the owner made them,
so they never carry over to another collection. A refused token goes back to its holder through the
collection's own resolve step, like any other refusal.

| Method                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow_tokens(token_ids)`        | Names tokens of the current collection. At most 100 ids in a call, and at least one (`at most 100 tokens in one call`, `name at least one token`). Naming a token twice changes nothing. Event `tokens_allowed` with the collection and the ids. A call with 100 ids of 63 bytes burned 13 TGas. When the owner is governance the ids ride in the proposal's arguments, which governance caps at 4,096 bytes, so a batch of long ids is smaller than 100 there. |
| `set_token_range(first, last)`   | For a collection whose ids are decimal numbers. Allows every id from `first` to `last`, both included, in the current collection, and replaces any earlier range. Refused if `first` is above `last`. Event `token_range_set` with the collection.                                                                                                                                                                                                              |
| `clear_token_range()`            | Removes the range. Event `token_range_cleared`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `set_allowlist_enabled(enabled)` | Off lets any token of the collection stake. On again unstakes nobody. Event `allowlist_set`.                                                                                                                                                                                                                                                                                                                                                                    |
| `reconcile_claim(id, paid)`      | Owner only, and not before `reconcile_wait_ns` (an hour at the start) after the claim. Decides a claim whose payout callback never arrived, which would otherwise stay pending. The owner checks the verifier's events first. `paid` true books the payout as made, false credits the amount back to the account's balance so it can claim again. A callback that arrives later changes nothing. Event `claim_reconciled`. Refuses with `no claim is pending with that id` and `wait <n> minutes after the claim before reconciling` (60 at the start). |
| `is_allowed(token_id)` (view)    | Whether the token could be staked now.                                                                                                                                                                                                                                                                                                                                                                                                                          |

An id counts as a number only in its plain decimal form. `007`, `+7`, a space, or a number past the
largest 64 bit value are not in any range, so a collection that mints such ids cannot use the range
to sneak a token in.

Deployment requirement: the collection must have a fixed supply, with minting closed and its code
hash published, before staking opens. The list names which tokens may stake, and it cannot tell a
real seat from one minted afterwards. With minting open, the owner who allows a range or a name
allows whatever anyone later mints under it. The checklist is to close minting, publish the code
hash of the collection, set the range or name the tokens, and only then tell holders they can stake.
Changing the collection with `set_nft_contract` leaves the old names and range stored, but they
apply only to the collection they were made for, so nothing the old list allowed (ids 1 to 1,000
under a range, for example) is allowed for the new collection.

Name the new collection's tokens again. Changing back brings the old collection's names and range
back into force. `config` shows the range only while it belongs to the current collection.

### Changing the collection

`set_nft_contract` is refused unless no seat is staked ("unstake every seat before changing the NFT
contract"), because stakes are tracked by token id alone and two collections could reuse an id.

---

## Revenue

### How it arrives

The verifier calls `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)` here when
the market sends its sweep with `mt_transfer_call` and the message `revenue:<sweep id>`. The money is
already in the Council's Intents account when the hook runs. The hook refuses:

| Refusal                                                        | Cause                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `only the verifier can deliver money`                          | The caller is not the verifier.                                    |
| `the money must come from the sender's own balance`            | The transfer did not come from the sender's own balance.           |
| `exactly one token and amount` / `wrong token`                 | A batch, or a token id other than the configured one.              |
| `the Council is not configured, the owner must call allow_market` | The owner has not allowed a market yet.                            |
| `unknown action`                                               | A message that is not `revenue:` and a whole number. A bare `revenue` is refused. |
| `revenue comes from an allowed market only`                    | The sender is not on the allow-list.                               |
| `that sweep was already received`                              | The sweep id was taken before.                                     |
| `call advance_days first`                                      | The Council is more than 30 days behind, see below.                |

A refusal makes the verifier return the money to the sender. The answer is the amounts to hand back,
and the Council always answers `[0]`, which keeps everything. The Council records each sweep id with
its amount and time, under the market account and the sweep id (`received_of(market, sweep_id)`),
so two markets can use the same sweep id, a repeated send is harmless and the market can ask what arrived when a transfer's result was lost.

Tokens sent to the Council's Intents account any other way, a plain deposit for example, never reach
the hook. They are not counted in `total_received` and are not shared with anyone. They sit in the
Council's account as unattributed surplus.

### How a sweep is shared

When a sweep arrives, the Council first walks the days up to today (see "Days and quarters" below).
Then it splits the sweep, plus anything carried from earlier, equally among the seats earning at that
moment. The split rounds down per seat, and the remainder joins the next split. If no seat is earning,
the whole sweep is carried and shared at the next sweep or at the next quarter close, whichever comes
first. The `revenue` event shows the seats that shared it, the units each got and whether it was
carried.

Because a sweep goes to whoever is earning when it arrives, fees earned in December and swept on
2 January belong to the seats earning on 2 January. The Council cannot know when fees were earned,
because the market sends one lump, and a late sweep is never back-dated. A seat that starts earning
after a sweep has arrived gets nothing from that sweep.

### Days and quarters

The Council keeps a day cursor (`last_day`). `advance_days(max_steps)` is open to anyone and walks the
cursor forward to today, at most 100 days (`MAX_DAY_STEPS`) a call. For each day it does two things,
in this order:

1. If the day is the first day of a new quarter, it closes the quarter before it. The cut pool and
   the carry are shared among the seats earning, or carried when there are none. The revenue index at
   that moment is stored as the quarter's snapshot, which is what makes the quarter claimable. The
   event is `quarter_closed`.
2. It starts the seats whose first earning day it is. A seat that starts on the first day of a quarter
   starts after the pool was shared.

A walk logs one `seats_started` line for all the seats it started and one `quarter_closed` for each
quarter it closed, so a long walk stays under the log limit.

Every call that moves money walks the days first, so the keeper is a convenience and not a
dependency. A claim and an unstake request walk up to 100 days, because the holder can attach the gas.
The revenue receipt, `draw` and `unlock_case` (when it names a silent juror) walk up to 30 days
(`MAX_RECEIPT_CATCH_UP_DAYS`) because they run on gas their caller fixed. Past its cap each of them
except `draw` refuses with `call advance_days first`; `draw` walks as far as the cap allows and goes
on. Sweeps come at least daily, so the 30 day cap is reached only after a month in which the keeper
and every holder were idle. The keeper calls `advance_days` and nothing else.

### Claiming

`claim(token_ids)` with 1 yoctoNEAR attached pays the caller everything it is owed in one transfer to
the caller's Intents account. The list holds at most 10 tokens, and every one must be the caller's
seat. The call:

1. Walks the days, then moves the kept half of a finished quarter out of the caller's pending slot.
2. Settles each listed seat: what it earned up to the last closed quarter goes to the caller's balance.
3. Pays the whole balance. An empty list pays what is already settled, which is how a holder who has
   left collects.

The claim record is written and the balance debited before the payout is sent. The callback then
closes the record: a paid payout is booked in `total_paid` (event `claim_paid`), a failed one credits
the balance back (event `claim_failed`). A repeated or late callback finds no record and changes
nothing. If the callback never arrives, the owner decides the claim with `reconcile_claim`. A claim is
refused if:

| Refusal message                                           | Cause                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `the Council is not configured, the owner must call allow_market` | The owner has not allowed a market.                                                       |
| `at most 10 tokens in one claim`                          | More than 10 tokens in the list.                                                                 |
| `not staked` / `not your seat`                            | A listed token that is not staked, or is held by someone else.                                   |
| `call advance_days first`                                 | The Council is more than 100 days behind.                                                        |
| `nothing to claim`                                        | The caller's balance is zero after settling.                                                     |

The earnings of the running quarter are not paid, whatever the list holds. A seat that is serving on a
case is settled only up to the revenue index at the draw, so a juror cannot claim what it earns while
serving before its case is released. Claims never expire: a quarter nobody claims stays claimable.

### Staking just before a sweep

A seat earns from the sweeps that arrive after it started. Five seats staked a moment before a large
sweep earn nothing from it, and the same seats staked a day earlier share it. The seat cap still
limits how much of a sweep one wallet can hold.

## Juries

### Drawing

Only oracle can call `draw(case_key, n, exclude)`. The case key is the market id for a case's first
jury, and the market id with its highest bit set for the second jury, which a case gets if the first
does not decide. The two keys keep the two juries apart, so releasing or drawing one never touches
the other. The draw takes no seed: the contract reads the block seed of the receipt that runs the
call.

1. If a jury was already drawn for this case, the same jury is returned. A retry after a failed
   callback cannot reroll it.
2. The days are walked, up to 30, so the revenue index a juror serves from already includes a quarter
   close that was due.
3. The candidates are every staked seat that is not serving on another case, has not asked to leave,
   and does not belong to an excluded account (the oracle excludes the proposer and the challenger).
   Seats staked within the last cooldown are set aside, so nobody can load the pool after seeing a
   challenge. When the older seats cannot make a jury of `n` different accounts, all candidates are
   drawn from.
4. A jury is picked one seat at a time. Each round hashes the block seed, the case key and the round
   number, and the first 8 bytes choose a candidate. If that candidate's owner is already on the
   jury, that seat is set aside and another is picked. So the jury is `n` different accounts.
5. If there are not enough different holders, the draw is refused with
   `not enough seat holders to draw a jury: <found> eligible, <n> needed`, and the oracle logs
   `draw_failed`.
6. Every drawn seat is marked as serving that case and remembers the revenue index at the draw.

The draw is per seat, so an account holding more seats is proportionally more likely to be picked,
but it can only appear once. Chance of an attacker holding a majority of a jury, with seats held 10
to a wallet, from the tests: with 9% of all seats, 3% for a jury of 3 and 0% for 11 or 21; with 23%,
14%, 2% and 0%; with 33%, 28%, 12% and 3%. A larger jury protects far more than a larger council.

A draw reads every staked seat, so its cost grows with the council. At the 1,000 seat cap it costs
about 172 TGas, and the oracle reserves 250. Raising the cap means raising that reservation to match
and measuring again.

The randomness is the block seed of the block in which the council runs `draw`, and it was not an
input to the call. The oracle used to pass a seed it read itself, which whoever sent `resolve_draw`
could see when they chose to send it. Now the seed is unknown until the seat list is fixed in the
same receipt. A block producer can still see it early and could choose not to include an
unfavourable draw. That is a documented limit of NEAR's randomness; the delay narrows it and the
jury size and seat cap are what protect against it.

### Releasing

When a disputed case is final, the oracle calls `unlock_case(case_key, delinquent)` with the list of
jurors who never voted. For every seat of that jury: if its owner is on the delinquent list, the
seat forfeits its earnings from the serving span, and then the seat stops serving. A second call for
the same case does nothing, so nobody is penalised twice. A case with no silent juror is always
released. A case with a silent juror walks the days first (up to 30), and refuses with
`call advance_days first` if the Council is further behind than that. The call logs `jury_released`
with the delinquent list, once. If it fails, anyone can retry it through the oracle's `retry_unlock`,
and `jury_of(case_key)` shows whether seats are still held.

### What a silent juror loses

What the seat earned from the draw to the release (or from its start, if it started later) that no
claim has settled yet. The other earning seats share it at once: the revenue index rises for every
earning seat, and the juror's own share of that rise comes off the seat too, so nothing of the
forfeit comes back to it. That share is rounded up, so the seat never keeps more than it lost. When no
other seat is earning, the units wait in the carry. The units come off the seat's next settlements,
from the running quarter first, so finished quarters are paid in full whenever the running quarter can
absorb the forfeit. A leaver's cut is taken on what remains after the forfeit. Money already settled
to the balance is never touched, and a juror who voted loses nothing (event
`seat_earnings_forfeited`). Jurors also lose their share of juror pay, which is handled in oracle. A
juror who committed but had no chance to reveal because the case settled early on a majority is not
on the list. The penalty is small when the case is short, so on its own it is a weak deterrent.

---

## Every method

| Method                                                                                                             | Who                       | What it does                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new(...)`                                                                                                         | Deployer, once            | Initialises.                                                                                                                                                                                                        |
| `propose_owner(new_owner)`                                                                                         | Owner                     | Starts a handover.                                                                                                                                                                                                  |
| `accept_owner()`                                                                                                   | The proposed account      | Completes it. Two steps so a typo cannot lock the contract.                                                                                                                                                         |
| `set_cooldown_ns(cooldown_ns)`                                                                                     | Owner                     | Changes the unstake wait. Above zero and at most a year.                                                                                                                                                            |
| `set_max_seats_per_account(n)`                                                                                     | Owner                     | Changes the per-account cap. At least 1.                                                                                                                                                                            |
| `set_nft_contract(nft_contract)`                                                                                   | Owner                     | Sets or changes the collection. Only while nothing is staked. The allowlist stays stored and applies to the old collection only. Event `nft_contract_set`.                                                           |
| `allow_market(market)`                                                                                             | Owner                     | Adds an account whose sweeps count as revenue. Refused if already on the list. Event `market_allowed`.                                                                                                              |
| `disallow_market(market)`                                                                                          | Owner                     | Takes an account off the list, so its sweeps are refused from then on. What it already sent stays. The last one cannot be removed (`keep at least one allowed market`), so claims keep working. Event `market_disallowed`. |
| `set_reconcile_wait_ns(reconcile_wait_ns)`                                                                         | Owner                     | Sets how long a claim must be pending before `reconcile_claim` can decide it, from 10 minutes to 7 days. Live: it applies to every claim from now on. Event `reconcile_wait_set`.                                    |
| `reconcile_claim(id, paid)`                                                                                        | Owner                     | Decides a claim whose payout callback never arrived. See the allowlist table above.                                                                                                                                 |
| `allow_tokens(token_ids)`, `set_token_range(first, last)`, `clear_token_range()`, `set_allowlist_enabled(enabled)` | Owner                     | The allowlist, above.                                                                                                                                                                                               |
| `stage_code()` (payable)                                                                                           | Anyone                    | The call input is a wasm. It is stored under its own sha256, which is returned. The deposit pays for the storage (1 NEAR per 100 KB) and the surplus is refunded. Attach 100 TGas, because 250 KB burns about 31.   |
| `upgrade(code_hash)`                                                                                               | Owner                     | Deploys the staged wasm with that sha256 and runs its `migrate`, in one batch. Needs at least 100 TGas attached.                                                                                                    |
| `migrate()`                                                                                                        | The contract itself       | Runs in the new code in the same batch as the deploy. Refuses unless `upgrade` marked the upgrade in flight. Reads the state as one of the two layouts it knows, clears the mark, sets `upgrade_proven`, returns the state. |
| `seal(public_key)`                                                                                                 | Owner                     | Deletes that access key from this account. Refused until an upgrade has gone through `migrate`.                                                                                                                     |
| `remove_verifier_key(public_key)`                                                                                  | Owner                     | Removes a key registered for this account in the Intents verifier, as this account. `seal` deletes NEAR access keys only. Event `verifier_key_removal_sent`.                                                         |
| `nft_on_transfer(sender_id, previous_owner_id, token_id, msg)`                                                     | The NFT collection only   | Stakes a seat.                                                                                                                                                                                                      |
| `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)`                                           | The verifier only         | Receives revenue (`msg` must be `revenue:<sweep id>`, from the market) and answers `[0]`.                                                                                                                           |
| `request_unstake(token_id, accepts_cut)` (payable, 1 yocto)                                                          | The seat's holder         | Settles finished quarters, applies the 50% cut to the running quarter, stops the seat earning and starts the cooldown. `accepts_cut` must be true.                                                                  |
| `unstake(token_id)` (payable, 1 yocto)                                                                             | The seat's holder         | Removes the seat and returns the NFT. Pays nothing.                                                                                                                                                                 |
| `claim(token_ids)` (payable, 1 yocto)                                                                              | The seat's holder         | Pays the caller's whole balance: settled earnings, the kept half of a finished quarter, and the finished-quarter earnings of up to 10 listed seats.                                                                 |
| `advance_days(max_steps)`                                                                                          | Anyone                    | Walks the day cursor to today, at most 100 days a call, closing quarters and starting seats. Returns the days it moved across.                                                                                     |
| `draw(case_key, n, exclude)`                                                                                       | Oracle only               | Draws a jury.                                                                                                                                                                                                       |
| `unlock_case(case_key, delinquent)`                                                                                | Oracle only               | Releases a jury and takes the forfeit.                                                                                                                                                                              |
| `on_unstaked`, `on_claim_paid`, `on_stake_checked`, `on_upgrade_done`                                              | The contract itself       | Callbacks.                                                                                                                                                                                                          |

The removed version 5 methods (`claim_quarter`, `finalize_quarter`, `advance_quarters`,
`book_seat_time`, `set_close_grace_ns`) do not exist in version 6.

The cooldown, the seat cap per account and the reconcile wait are the owner's to change, each within a hard range
where one applies. The seat limit, the leaver cut, the day step limits, the claim token limit, the view page size and the allowlist batch size stay constants,
because they bound gas or storage, and so do the `nep141:` prefix and the state version.

---

## Upgrading this contract

No access key can replace this code outside an owner call, and no deleted key can freeze it. The owner
(the DAO) calls `upgrade` with the hash of a build that anyone staged with `stage_code`. The call
needs at least 100 TGas (`attach at least 100 TGas to upgrade`), takes the staged wasm out of
storage and sends one batch to this account: deploy, then `migrate`. A `migrate` that panics reverts
the deploy and the old code stays. The staged copy is gone either way, so a failed upgrade stages
the code again, and the staging deposit (about 1 NEAR per 100 KB) stays in the contract.

`upgrade` sets `upgrade_in_flight` just before it sends the batch. `migrate` refuses to run without
it (`migrate runs only inside an upgrade`), clears it and sets `upgrade_proven`, so a hand-called
`migrate` proves nothing. When the batch fails, `on_upgrade_done` clears the mark (event
`upgrade_failed`), and the next `upgrade` sets it again. Both flags are shown in `config` next to
`state_version`. `seal` is refused until `upgrade_proven` is true (`prove the upgrade path before
deleting keys`). The state struct starts with `state_version: u16`, 6 today. `migrate` reads the first
two bytes of the stored state and accepts 6 (the current layout) and 5, and refuses anything else
(`unsupported state version`). It never guesses a layout from bytes. A later build keeps the version 6
struct as `StateV6`, reads that, builds its state and writes the next version.

The upgrade from version 5 to 6 refuses unless all of these hold, and each refusal reverts the deploy:

| Condition | Refusal message |
| --- | --- |
| Every quarter that has ended is finalized | `a finished quarter is not finalized yet, finalize it and let its holders claim before upgrading` |
| No claim is pending | `a claim is still pending, settle it before upgrading` |
| Finalized money is claimed, with up to 1,000 units of rounding for each finalized quarter | `a finalized quarter still has money to claim, claim it before upgrading` |
| No unstake is waiting for its NFT transfer | `an unstake is still waiting for its NFT transfer` |

When it goes through, the revenue of quarters not finalized yet and the rounding left in finalized
ones wait in the carry for the next sweep. Every seat that had not asked to leave starts earning on the
UTC day after the migration. A seat that had asked to leave never earns again. The quarter before the
running one is the last closed quarter with an index of 0, so nothing is claimable until the running
quarter ends. The version 5 quarter books, seat time, forfeits and claims stay in storage unread.

Every record in the maps (stake, claim, pending slot, received sweep) is stored behind a one-byte version tag,
0 or 1 depending on the record. A read goes through the stored enum's `into_current`, which is where an older layout is upgraded,
and a write always uses the current version. A tag this code does not know panics with `a stored record has
a newer version than this code can read`. Version 5 seat records are upgraded when they are read, using the day `migrate` ran. The case keys the oracle passes are opaque numbers to the Council:
the oracle builds them from a unique case number, so two market accounts never share a jury.

SputnikDAO runs a proposal in the same call as the approval that reaches its threshold. By owner
decision (2026-10-21) the voting period is the only delay, and no delay after approval will be
built. This contract has no pause, so
`request_unstake`, `unstake` and `claim` work at all times except for a seat serving on an
open case, and an upgrade does not touch them. The accepted deployment controls are in
[DEPLOY.md](DEPLOY.md#3-administration-and-upgrades). Trezu/Sputnik execution still needs its own
integration evidence.

---

## Views

| View                               | Returns                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seat_count()`                     | How many seats are staked.                                                                                                                                                                                                                                                                                                    |
| `is_seat(account_id)`              | Whether the account holds at least one seat.                                                                                                                                                                                                                                                                                  |
| `staked_tokens(from_index, limit)` | A page of staked token ids.                                                                                                                                                                                                                                                                                                   |
| `stake_of(token_id)`               | A seat's record (owner, staked time, unstake request time, serving case, first earning day), or nothing.                                                                                                                                                                                                                      |
| `seats_of(account_id)`             | The tokens the account has staked now.                                                                                                                                                                                                                                                                                         |
| `claimable_of(account_id)`         | What a `claim` naming every seat the account holds would pay now: the settled balance, the kept half of a finished quarter, and the finished-quarter earnings of its seats. It does not walk the days, so after a quarter ends it shows that quarter's earnings only once something has closed it.                              |
| `in_progress_of(account_id)`       | What the account's earning seats have made in the quarter still running, plus the kept half of a leaver's quarter that is not over yet. None of it can be claimed until the quarter closes.                                                                                                                                    |
| `seat_earnings(token_id)`          | Null for a token that is not staked. Otherwise the owner, the state (`waiting`, `earning`, `leaving` or `serving`), `earning_from` (ns), `earned_closed`, `earned_in_progress`, `start_acc` and `settled_acc`.                                                                                                                 |
| `quarter_info()`                   | The running quarter: id, `starts_at`, `ends_at`, `last_closed_quarter` and `last_day` (the day cursor).                                                                                                                                                                                                                       |
| `quarter_snapshots(from, limit)`   | The revenue index each finished quarter closed with, oldest first, as `{quarter, acc}`. At most 50 a call. With no `from`, the latest ones.                                                                                                                                                                                    |
| `received_of(market, sweep_id)`    | What a market account sent under a sweep id (amount, time), or null. The market calls it with its own account id to settle a transfer whose result was lost.                                                                                                                                                                  |
| `reward_totals()`                  | `total_received`, `total_paid`, `pending_claims` (claims in flight), `carry` (waiting for the next sweep), `cut_pool` (waiting for the quarter to close), `accrued_total` (settled balances) and `pending_total_slots` (kept halves of running quarters).                                                                       |
| `total_received()`                 | Every revenue token this contract has taken in since the start, whether claimed yet or not. Forfeits are not money and are not counted.                                                                                                                                                                                       |
| `is_allowed(token_id)`             | Whether the token could be staked now.                                                                                                                                                                                                                                                                                        |
| `jury_of(case_key)`                | The tokens still held for a case. Empty once released.                                                                                                                                                                                                                                                                        |
| `is_staged(code_hash)`             | Whether a wasm with that sha256 is staged.                                                                                                                                                                                                                                                                                    |
| `config()`                         | state version, upgrade proven, upgrade in flight, owner, pending owner, oracle, NFT collection (null until set), the allowed market accounts (`markets`, empty until one is allowed), verifier, collateral token id, cooldown, reconcile wait (`reconcile_wait_ns`), seat cap, allowlist on or off, the allowed range, `total_received`, `last_day`, `active_seats` and `last_closed_quarter`. |

---

## Events

Each logs `EVENT_JSON:` and JSON of the form
`{"standard":"council","version":"1.0.0","event":"<name>","data":{...}}`.

| Event                             | When                                        | Data                               |
| --------------------------------- | ------------------------------------------- | ---------------------------------- |
| `owner_proposed`, `owner_changed` | Handover                                    | owner and proposed, or from and to |
| `cooldown_set`                    | `set_cooldown_ns`                           | cooldown_ns                        |
| `max_seats_per_account_set`       | `set_max_seats_per_account`                 | max_seats_per_account              |
| `tokens_allowed`                  | `allow_tokens`                              | nft_contract, token_ids            |
| `token_range_set`                 | `set_token_range`                           | nft_contract, first, last          |
| `token_range_cleared`             | `clear_token_range`                         | none                               |
| `allowlist_set`                   | `set_allowlist_enabled`                     | enabled                            |
| `claim_reconciled`                | `reconcile_claim`                           | id, account, amount, tokens, requested_at, paid |
| `staked`                          | A seat is staked                            | token_id, owner                    |
| `stake_refused`                   | The collection did not confirm the seat, or a limit was reached while it checked | token_id, owner, owned |
| `unstake_requested`               | `request_unstake`                           | token_id, owner, unlock_at         |
| `seat_cut`                        | `request_unstake`                           | token_id, owner, quarter, earned, cut, kept |
| `nft_contract_set`                | `set_nft_contract`                          | nft_contract                       |
| `market_allowed`                  | `allow_market`                              | market                             |
| `market_disallowed`               | `disallow_market`                           | market                             |
| `jury_drawn`                      | `draw`, for a case not drawn before         | case_key, tokens, owners           |
| `jury_released`                   | `unlock_case`, for a jury still held        | case_key, delinquent               |
| `seats_started`                   | A day walk started seats                    | from_day, to_day, start_days, count |
| `quarter_closed`                  | A day walk closed a quarter                 | quarter, acc, cut_shared, carried  |
| `reconcile_wait_set`              | `set_reconcile_wait_ns`                     | reconcile_wait_ns                  |
| `revenue`                         | Revenue arrives                             | from, market (the same account), amount, sweep_id, seats, per_seat, carried |
| `claim_requested`                 | `claim`, before the payout is sent          | id, account, amount, tokens, requested_at |
| `claim_paid`                      | The payout went through                     | id, account, amount, tokens, requested_at |
| `claim_failed`                    | The payout failed and the balance was credited back | id, account, amount, tokens, requested_at |
| `seat_earnings_forfeited`         | A silent juror's earnings were taken        | token_id, owner, case_key, amount  |
| `unstaked`                        | The NFT was returned                        | token_id, owner                    |
| `unstake_failed`                  | A transfer failed and the seat was restored | token_id, owner                    |
| `code_staged`                     | `stage_code`                                | code_hash, bytes, by               |
| `upgrade_sent`                    | `upgrade`                                   | code_hash                          |
| `upgrade_failed`                  | The deploy and migrate batch failed         | none                               |
| `migrated`                        | `migrate`, in the new code                  | state_version                      |
| `seal_sent`                       | `seal`                                      | public_key                         |
| `verifier_key_removal_sent`       | `remove_verifier_key`                       | public_key                         |

---

## What can go wrong, and the message you will see

| Message                                                                                                                                                      | Cause                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `owner only` / `oracle only` / `not the proposed owner`                                                                                                      | Access refusals.                                                 |
| `only the verifier can deliver money` / `the money must come from the sender's own balance` / `exactly one token and amount` / `wrong token` / `unknown action` | Revenue from a caller that is not the verifier, from another account's balance, a batch, another token id, or a message other than `revenue:<sweep id>`. |
| `revenue comes from an allowed market only` / `that sweep was already received` / `the Council is not configured, the owner must call allow_market`                    | Revenue from an account not on the list, a repeated sweep id from the same market, or before the owner allowed a market.          |
| `already an allowed market` / `not an allowed market` / `keep at least one allowed market`                                                                  | `allow_market` for an account already on the list, `disallow_market` for one that is not, or for the last one. |
| `the NFT collection is not set, the owner must call set_nft_contract`                                                                                        | Staking or allowing a token before the owner set the collection.                                 |
| `the collateral token id must look like nep141:<token>`                                                                                                      | `new` with a token id in the wrong form.                         |
| `wrong NFT contract` / `that token is not on the allowlist` / `already staked` / `the council is full` / `that account already holds the most seats allowed` | A refused stake.                                                 |
| `name at least one token` / `at most 100 tokens in one call` / `the first id must not be above the last`                                                     | A refused allowlist change.                                      |
| `attach at least 33 TGas: ...` / `attach at least 38 TGas: ...`                                                                                               | `unstake` or `claim` (33), or a stake (38), with less than its gas floor. |
| `leaving before the quarter ends costs 50% of this quarter's earnings: pass accepts_cut true`                                                                | `request_unstake` without `accepts_cut` true.                    |
| `at most 10 tokens in one claim` / `nothing to claim` / `no claim is pending with that id`                                                                   | A refused claim, or `reconcile_claim` for an id with no record.  |
| `call advance_days first`                                                                                                                                    | The Council is more than 100 days behind a claim or an unstake request, or more than 30 days behind a revenue receipt or a release with a silent juror. |
| `the reconcile wait must be between 10 minutes and 7 days`                                                                                                   | `set_reconcile_wait_ns` out of its bounds.                       |
| `not staked` / `not your seat`                                                                                                                               | Acting on a seat you do not hold.                                |
| `unstake already requested` / `request an unstake first` / `the cooldown has not passed`                                                                     | Wrong unstake order or timing.                                   |
| `this seat is serving on an open case`                                                                                                                       | A seat held for a case.                                          |
| `not enough seat holders to draw a jury: N eligible, M needed`                                                                                               | Too few different holders.                                       |
| `unstake every seat before changing the NFT contract`                                                                                                        | `set_nft_contract` while seats exist.                            |
| `the cooldown must be positive` / `the cooldown must be positive and at most a year` / `an account must be allowed at least one seat`                        | Bad settings.                                                    |
| `Requires attached deposit of exactly 1 yoctoNEAR`                                                                                                           | `claim` or `unstake` without the 1 yocto.                        |
| `attach at least 100 TGas to upgrade`                                                                                                                        | `upgrade` with less gas than the deploy and migrate need.        |
| `no code is staged under that hash`                                                                                                                          | `upgrade` for a hash nobody staged, or one already used.         |
| `attach at least <amount> to pay for the storage` / `the wasm goes in the call input`                                                                        | `stage_code` with too little deposit or no input.                |
| `prove the upgrade path before deleting keys`                                                                                                                | `seal` before an upgrade has gone through `migrate`.             |
| `unsupported state version`                                                                                                                                  | `migrate` found state written by a version other than 5 or 6.    |
| `migrate runs only inside an upgrade`                                                                                                                        | `migrate` called without `upgrade` having sent the batch.        |
| `a finished quarter is not finalized yet, ...` / `a claim is still pending, ...` / `a finalized quarter still has money to claim, ...` / `an unstake is still waiting for its NFT transfer` | The version 5 to 6 migration refused, see "Upgrading this contract". |
| `Method <name> is private`                                                                                                                                   | A callback called from outside.                                  |

---

## Gas

Measured in TGas. "Own burn" is what the Council itself burns; "total" includes the verifier or NFT
receipts it starts.

| Step                                | Gas                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A jury draw                         | About 172 TGas at the 1,000 seat cap (reserved by the oracle at 250, so `resolve_draw` needs about 275 attached)                                                       |
| A stake                             | Must attach at least 38 TGas: 10 for the ownership view, 20 for its callback and 8 for the call itself.                                                                |
| `unlock_case` for a 21 juror case   | 20.2 TGas when every juror is silent and the Council is 30 days behind. The oracle reserves 25.                                                                        |
| A `claim`                           | Must attach at least 33 TGas: 15 for the verifier's `mt_transfer`, 10 for its callback and 8 for the call itself. Own burn for 1, 5 and 10 tokens: 5.3, 6.2 and 7.4. The first claim after about 100 idle days burns about 65 in all, because it walks the days, so attach 100. |
| A `request_unstake`                 | 2.6 to 4.7 TGas. No floor, and the days it walks add to it after a long idle stretch.                                                                                  |
| An `unstake`                        | Must attach at least 33 TGas: 15 for the NFT transfer, 10 for its callback and 8 for the call itself. No payout is sent.                                                |
| Each verifier or NFT transfer reserved | 15 TGas; callbacks 10 TGas                                                                                                                                          |
| Revenue receipt `mt_on_transfer`    | 2.0 TGas with the days current, up to 11.7 when the Council is 30 days behind. Refused beyond 30 days. The verifier gives the receiver what is attached to its `mt_transfer_call` less about 20.5 TGas. Market attaches 42. |
| `advance_days`                      | One map write per start day and one log for the walk, at most 100 days a call.                                                                                         |
| `allow_tokens`                      | 13 TGas for 100 ids of 63 bytes                                                                                                                                        |
| `migrate` in the upgrade batch      | 30 TGas reserved                                                                                                                                                       |
| `upgrade`                           | At least 100 TGas attached                                                                                                                                             |

---

## Security properties checked by tests

Every restricted method refuses a stranger and every callback refuses a direct call; a stranger
cannot initialise a deployed council; with the allowlist on, only named tokens and plain numbers
inside the range stake, and `007` and `+7` do not; names and a range made for one collection allow
nothing in the next; a hand-called `migrate` is refused; `unstake` and `claim` refuse less than
their gas floors; `total_received` counts every revenue arrival and no forfeit; a fake NFT
collection cannot stake seats and a call to `nft_on_transfer` made directly is refused; a fake token
cannot add revenue, whether it arrives through the verifier or is called directly; only an allowed market's
sweeps count as revenue and a sweep id is taken once; a seat staked by an approved relayer belongs to its real owner;
a seat that asked to leave is never drawn.

The version 6 rules are checked by unit tests with controlled block times in
`contracts/council/src/lib.rs`: a seat staked on a day earns nothing from that day and its full share
from the next; a sweep that came before a seat started is never shared with it; two sweeps are split
by whoever is earning at each; a sweep with no earning seat is carried and shared at the next; rounding
never pays out more than received; `advance_days` closes a quarter, stores the snapshot and starts
seats after the cut pool is shared; a seat that starts on the first day of a quarter gets none of the
closing cut pool; the cut pool is carried when nobody is earning; a quarter nobody claims is still
claimable two quarters later; a claim in the middle of a quarter pays finished quarters only; a leaver
loses exactly half of the running quarter and nothing from earlier ones, and its amounts are the same
whether the snapshot is taken on time or days late; `request_unstake` is refused without `accepts_cut`
true; a claim pays once, a failed payout puts the balance back, and a late or repeated callback
changes nothing; nobody claims a seat they do not hold; a claim takes at most ten tokens; a silent
juror's earnings go to the other earning seats and nothing comes back to the juror; a voter loses
nothing; a case is forfeited once; a claim while serving pays only what came before the draw; the
version 5 to 6 migration keeps the seats, carries the open revenue and refuses for each condition
listed above; and a property test over random stakes, unstake requests, sweeps, draws, releases and
claims shows that what was paid, what is in flight, what accounts are owed, the cut pool, the carry and
what live seats earned never add up to more than was received, and fall short only by rounding.

A stranger cannot upgrade or seal, an unknown hash and too little gas or deposit are refused, `seal`
waits for `upgrade_proven`, `migrate` refuses another state version, and the seats survive an
upgrade unchanged.

---

## Things to know

| Topic                                          | Detail                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legal                                          | Seats that earn a share of platform revenue are the shape most securities law treats as an investment. Nothing is minted or sold, and selling seats needs counsel first. The revenue share and juror pay are kept separate.                                                                 |
| The seat cap number is not chosen              | The tests use small values. A real deployment needs a number.                                                                                                                                                                                                                               |
| Revenue is paid by arrival                     | A seat earns from the sweeps that arrive after the day it was staked. A seat that leaves keeps the right to what it earned in every finished quarter, and gives up half of the running quarter. Claims open when a quarter closes and never expire.                                          |
| Leaving costs half of the running quarter      | The cut is fixed at 50% and the holder must accept it on every request. The cut half is shared among the seats earning when the quarter closes. Nothing stops holders from leaving, by design.                                                                                              |
| Rounding and unclaimed money                   | A split rounds down and the remainder joins the next split, so the Council never pays more than it received. What a seat never settles stays in the Council. A quarter nobody claims stays claimable.                                                                                       |
| Storage grows with start days, quarters and accounts | One entry for each day on which seats started, one for each closed quarter, and one for each account holding a balance or a pending slot. Sizes were not measured for version 6. The keeper's storage margin check covers the Council's NEAR balance.                                  |
| The revenue index only grows                   | It is a `u128`, full once the units shared per earning seat reach about 3.4 * 10^20. That is all the revenue the council will ever take in if one seat earned every sweep. Past that a split panics.                                                                                      |
| The sandbox cannot reach a quarter's end       | A quarter ends about two months of blocks away. The unit tests move the clock, and the sandbox tests edit the Council's day ledger so the contract's own code closes the quarter.                                                                                                           |
| More than 1,000 seats                          | The draw reads every seat, so a bigger collection needs a different draw. Not built; it depends on the planned collection size.                                                                                                                                                             |
| The seat cap limits revenue concentration only | A jury is made of distinct accounts, so the best setup for an attacker is one seat in each of many wallets, and a per-account cap does nothing against that. An account is not a person. Identity checks or a buyer cap at sale time are needed. `spec.md` section 9 says the same.         |
| Unstaked NFTs earn nothing                     | Only staked seats earn and can be drawn.                                                                                                                                                                                                                                                    |
| Keys                                           | Until `seal` has run, the deploy key can replace this code outside every vote. After it, only an owner upgrade can. A sealed contract with a broken upgrade path cannot be fixed, so prove one upgrade first.                                                                           |
| No outside review                              | The only review so far is internal.                                                                                                                                                                                                                                                         |
