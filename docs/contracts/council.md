# council

Target decision, 2026-10-20: retain NFT staking, eligibility, jury duties and reward accounting.
The Council controls the 25% holder allocation with backing held in NEAR Intents; eligible
holders claim quarterly. The other 75% goes to the Trezu treasury. Trezu/SputnikDAO replaces custom
governance as the administration target; treasury votes do not replace juries. See
[the architecture](../intents-architecture.md).

Status, 2026-10-21, quarterly claims built (R-05): revenue is booked to the UTC calendar quarter it
arrives in, a seat's share of a quarter is the time it was staked inside the quarter over all the
seat time of the quarter, a quarter can be finalized once its grace period after the quarter's end has
passed (7 days to start, the owner can move it between 1 and 30 days), and each seat claims each
quarter once with `claim_quarter`. The 30-day stream, `claim` and `pending_reward` are gone, and
`unstake` returns the NFT and pays nothing. A silent juror loses the seat time of the case instead of
revenue. Neither the NFT collection nor the market is written in the code or taken by `new`: the owner
sets them with `set_nft_contract` and `set_market`, and staking, revenue and claims refuse until it
has. State version 2. Revenue arrives through the NEAR Intents verifier as `mt_on_transfer` with the
message `revenue:<sweep id>`, only from the market, and claims are paid out of the Council's own
account in it with `mt_transfer` of 1 yocto, with no signed intent and no key registered in the
verifier. The DAO voting period is the only delay before an owner action (decided 2026-10-21, R-07).

Source: `council/src/lib.rs`, with the shared upgrade helpers in `upgrade/src/lib.rs`. Written
2026-10-18 from the code as it stands, upgrade path added 2026-10-19, the per-collection allowlist
and the upgrade mark added 2026-10-20. The code describes current behaviour. The accepted spec defines the target; differences
are implementation work, not reasons to drop a requirement.

---

## Required changes for the product target

See [requirements R-04, R-05 and R-08](../spec.md#requirements-to-implementation-map).

- Done: eligible NFT staking, earning rules, case locks and jury duties are kept.
- Done 2026-10-21 (R-05): quarter accounting records each eligible holder's entitlement, with its
  backing inside Intents. Each quarterly entitlement is reserved once, paid through Council-authorised
  settlement, and confirmed or recovered without a second spendable claim.
- Done: quarter boundaries (UTC calendar), late-arriving fees (they belong to the quarter they arrive
  in), no-seat periods (the pool moves to the next quarter), rounding (down, the dust stays in the
  Council) and unclaimed balances (they stay claimable for good). A seat staked at the end of a quarter
  earns for the time it was staked, not for the whole quarter.
- Done: quarter identity and timing, accrued, claimable, pending and paid entitlements are views
  (see "Views").
- Open: administrative authority runs through the reviewed Trezu/Sputnik execution path, which still
  needs a run against a real DAO. Quarter calls from the keeper (`advance_quarters`,
  `finalize_quarter`) are not built.

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
   Each calendar quarter's revenue is shared among the seats by how long each was staked inside the
   quarter, and a seat's holder claims the share once the quarter is final.

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
| Owner                | `new`, then `propose_owner` and `accept_owner` | `set_cooldown_ns`, `set_max_seats_per_account`, `set_nft_contract`, `set_market`, `set_close_grace_ns`, `allow_tokens`, `set_token_range`, `clear_token_range`, `set_allowlist_enabled`, `propose_owner`, `upgrade` and `seal`. Normally the DAO. |
| Oracle               | `new` (fixed)                                  | `draw` and `unlock_case`.                                                                                                                                                                                                     |
| Seat holder          | Stakes an NFT                                  | `request_unstake`, `unstake` for their own seats, and `claim_quarter` for a seat they staked, including one they have since unstaked.                                                                                         |
| The verifier         | `new` (fixed)                                  | Only `mt_on_transfer`, which is how revenue arrives.                                                                                                                                                                          |
| The NFT collection   | `set_nft_contract`, changeable only while nothing is staked | Only `nft_on_transfer`, which is how seats are staked.                                                                                                                                                           |
| The market           | `set_market`                                   | The only account whose `revenue:<sweep id>` message counts as revenue.                                                                                                                                                        |
| Anyone               | n/a                                            | `finalize_quarter`, `advance_quarters`, `book_seat_time`, `stage_code` (paying for the storage), and every view.                                                                                                              |

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
The owner sets them afterwards with `set_nft_contract` and `set_market`. Until the collection is set
nothing can be staked and no token can be allowed (`the NFT collection is not set, the owner must
call set_nft_contract`). Until the market is set no revenue is taken and no claim is paid (`the
Council is not configured, the owner must call set_market`). The starting grace period is 7 days.
The first quarter to finalize is the one the contract was created in.

---

## Units and conventions

| Thing                      | Convention                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token ids                  | Strings, as the NFT collection uses them.                                                                                                                                |
| Times                      | Nanoseconds since the Unix epoch.                                                                                                                                        |
| Big numbers in JSON        | `U64` and `U128` travel as strings.                                                                                                                                      |
| Revenue amounts            | Raw units of the collateral token.                                                                                                                                       |
| Quarters                   | UTC calendar quarters. The id is `year * 4 + (quarter - 1)`, so 2026 Q4 is 8107. A quarter starts at 00:00 UTC on the first day of its first month and ends where the next one starts. A time exactly on a boundary belongs to the new quarter. |
| Seat time                  | Nanoseconds a seat was staked, inside a quarter. The seat counts from the block it is staked until the block it is unstaked, and it keeps counting through a case. It stops at the request to unstake. |
| Rounding                   | Each seat's share is the quarter's pool times its seat time over the quarter's total seat time, rounded down. The dust stays in the Council as unallocated backing and is at most one unit per seat. |

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
| The council has fewer than 1,000 seats                  | `the council is full`                               |
| The holder has fewer than `max_seats_per_account` seats | `that account already holds the most seats allowed` |

If it accepts, the seat belongs to `previous_owner_id`, the account that owned the token, and not to
`sender_id`, which can be an approved marketplace or relayer. Crediting the sender
would let a relayer claim someone else's seat. The seat starts with no revenue owed to it. It earns
from the moment it is staked, in proportion to the time it stays staked.

The NFT is now held by this contract. It does not show in the holder's wallet and cannot be listed
on a marketplace until it is unstaked.

### A seat's record

| Field                 | Meaning                                           |
| --------------------- | ------------------------------------------------- |
| `owner`               | The account that staked it and will get it back.  |
| `staked_at`           | When it was staked.                               |
| `unlock_requested_at` | When unstaking was requested, if it was.          |
| `serving`             | The case the seat is currently drawn for, if any. |
| `booked_to`           | The time up to which the seat's staked time is already counted in the quarters it covered. |

Two more fields exist internally and are not shown in views: where the token sits in the staked list,
and when the seat was drawn.

### Leaving: unstaking

It takes two steps and a wait.

1. `request_unstake(token_id)`. The holder asks to leave. Refused if the seat is serving on an open
   case or a request is already pending. From now on the seat is not available to be drawn and
   earns nothing more. Its time so far is counted by this call, which can need `advance_quarters` or
   `book_seat_time` first after a long idle stretch.
2. After the cooldown has passed, `unstake(token_id)` with 1 yoctoNEAR attached. The seat's staked
   time was counted at the request, the seat is removed, and the NFT is returned. Unstaking pays no money,
   so it never touches reward backing. What the seat earned stays claimable by quarter, whoever holds
   the NFT afterwards, and an NFT sold after unstaking carries nothing with it.

If the NFT transfer fails (for example the collection is broken), the seat is restored, and it can
be unstaked again without waiting a new cooldown. It keeps its request, so it does not earn again.

Between the request and the unstake the seat earns nothing and cannot be drawn.

A seat cannot leave while serving on a case, and a seat that has asked to leave cannot be drawn, so
no seat is ever both.

### The cooldown

The cooldown is a deploy setting and the owner can change it with `set_cooldown_ns`. A change
applies to every unstake from then on, including requests already made, which wait out the new
length. It must be at least as long as the oracle's challenge window plus panel deadline, which this
contract cannot check.

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
| `reconcile_claim(quarter, token_id, owner, paid)` | Owner only, and not before an hour after the claim. Decides a claim whose payout callback never arrived, which would otherwise stay pending and refuse every retry. The owner checks the verifier's events first. `paid` true books the payout as made, false deletes the record so the seat can claim again. A callback that arrives later changes nothing. Event `claim_reconciled`. Refuses with `no claim is pending for that seat` and `wait 60 minutes after the claim before reconciling`. |
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
| `exactly one token and amount` / `wrong token`                 | A batch, or a token id other than the configured one.              |
| `the Council is not configured, the owner must call set_market` | The owner has not set the market yet.                              |
| `unknown action`                                               | A message that is not `revenue:` and a whole number. A bare `revenue` is refused. |
| `revenue comes from the market only`                           | The sender is not the account the owner set as the market.         |
| `that sweep was already received`                              | The sweep id was taken before.                                     |

A refusal makes the verifier return the money to the sender. The answer is the amounts to hand back,
and the Council always answers `[0]`, which keeps everything. The Council records each sweep id with
its amount, quarter and time (`received_of(sweep_id)`), so a repeated send is harmless and the market
can ask what arrived when a transfer's result was lost.

Tokens sent to the Council's Intents account any other way, a plain deposit for example, never reach
the hook. They are not counted in `total_received` and are not shared with anyone. They sit in the
Council's account as unattributed surplus.

### Which quarter it belongs to

Revenue belongs to the UTC calendar quarter that contains the block time of its receipt. Fees earned
in December and swept on 2 January are the new quarter's: the Council cannot know when fees were
earned, because the market sends one lump, and a late sweep is never back-dated. A keeper that sweeps
shortly before a boundary keeps the attribution close to the earning period.

### Seat time and shares

A seat's weight in a quarter is the number of nanoseconds, inside that quarter, that the stake
existed. Staking, unstaking and staking again only change which spans exist. The weight does not
depend on when the revenue arrived, which is what stops a late staker taking a full share: a seat
staked one second before a 92 day quarter ends has one second of 7,948,800 per seat.

The quarter's total is the sum over the quarter of the number of staked seats, counted in seat
nanoseconds. It moves when the seat count changes (a stake, an unstake, a failed unstake coming back)
and when anyone calls `advance_quarters`. A call moves it across at most eight quarters, so after
more than two idle years `advance_quarters` must be called first (`call advance_quarters first`).
A seat's own weight is counted lazily, when the seat is unstaked, when its quarter is claimed, when a
silent juror is penalised and when anyone calls `book_seat_time`. A seat held for more than eight
quarters without any of those needs `book_seat_time` first (`book this seat first`).

A seat's weight is kept by quarter, token and owner. A token another account stakes later starts a
span of its own for that account, and both accounts claim their own. Two spans of one token by one
owner in the same quarter add up to one claim.

### Finalizing a quarter

`finalize_quarter(quarter)` is open to anyone. It needs the grace period after the quarter's end to
have passed, and quarters finalize in order. It fixes the pool (the quarter's revenue plus anything
rolled in) and the total seat time less what silent jurors lost, and opens the quarter's claims. A
quarter with no seat time moves its whole pool into the next quarter, where it joins that pool, and
has nothing to claim. The money never leaves the Council.

It also refuses while any jury drawn before the quarter's end is still open (`a jury drawn in this
quarter is still open`), so a silent juror cannot finalize the quarter first and keep seat time the
forfeit would take. If a release is lost, the quarter can be finalized anyway 30 days after its end.

| State     | Meaning                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| `open`    | The quarter is running. A seat's share is a guess that later revenue and seat time still move. |
| `closing` | The quarter ended and the grace period has not passed. A forfeit can still change the weights. |
| `final`   | The pool and the total seat time are fixed. Claims are open and have no deadline.             |

### Claiming

`claim_quarter(quarter, token_id)` with 1 yoctoNEAR attached pays the caller's share of a final
quarter for that token, into the caller's Intents account. The claim record is written before the
payout is sent and kept for good once paid, so a quarter can be claimed once per seat. A failed
payout deletes the record (event `claim_failed`) and the seat can claim again. The record's key is the
quarter, the token and the caller, so nobody else can claim or block a seat's share. A claim is
refused if:

| Refusal message                                           | Cause                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `the Council is not configured, the owner must call set_market` | The owner has not set the market.                                                          |
| `that quarter is not final`                               | The quarter is still running, closing, or has not started.                                       |
| `claim is already pending` / `already claimed`            | A record exists for this quarter, token and caller.                                              |
| `book this seat first`                                    | The caller's seat needs more than eight quarters counted. Call `book_seat_time` first.           |
| `nothing to claim`                                        | The caller has no seat time for this token in the quarter, or the share rounds to nothing.       |

There is no other path. The old `claim` and the payout inside `unstake` are gone, so an allocation
cannot be drawn twice. A seat does not have to be staked to claim: a holder who unstaked keeps the
right to every quarter they earned in.

### Staking just before a quarter ends

A seat earns for exactly the time it was staked. Five seats staked a moment before a large arrival
earn a sliver of that quarter, and the same seats staked for the whole quarter earn their full share.
The seat cap still limits how much of a quarter one wallet can hold.

## Juries

### Drawing

Only oracle can call `draw(case_key, n, exclude)`. The case key is the market id for a case's first
jury, and the market id with its highest bit set for the second jury, which a case gets if the first
does not decide. The two keys keep the two juries apart, so releasing or drawing one never touches
the other. The draw takes no seed: the contract reads the block seed of the receipt that runs the
call.

1. If a jury was already drawn for this case, the same jury is returned. A retry after a failed
   callback cannot reroll it.
2. The candidates are every staked seat that is not serving on another case, has not asked to leave,
   and does not belong to an excluded account (the oracle excludes the proposer and the challenger).
3. A jury is picked one seat at a time. Each round hashes the block seed, the case key and the round
   number, and the first 8 bytes choose a candidate. If that candidate's owner is already on the
   jury, that seat is set aside and another is picked. So the jury is `n` different accounts.
4. If there are not enough different holders, the draw is refused with
   `not enough seat holders to draw a jury: <found> eligible, <n> needed`, and the oracle logs
   `draw_failed`.
5. Every drawn seat is marked as serving that case.

The draw is per seat, so an account holding more seats is proportionally more likely to be picked,
but it can only appear once. Chance of an attacker holding a majority of a jury, with seats held 10
to a wallet, from the tests: with 9% of all seats, 3% for a jury of 3 and 0% for 11 or 21; with 23%,
14%, 2% and 0%; with 33%, 28%, 12% and 3%. A larger jury protects far more than a larger council.

A draw reads every staked seat, so its cost grows with the council. At the 1,000 seat cap it costs
190 to 210 TGas, which is why the oracle reserves 250 and the cap is 1,000. Raising the cap means
raising that reservation to match and measuring again.

The randomness is the block seed of the block in which the council runs `draw`, and it was not an
input to the call. The oracle used to pass a seed it read itself, which whoever sent `resolve_draw`
could see when they chose to send it. Now the seed is unknown until the seat list is fixed in the
same receipt. A block producer can still see it early and could choose not to include an
unfavourable draw. That is a documented limit of NEAR's randomness; the delay narrows it and the
jury size and seat cap are what protect against it.

### Releasing

When a disputed case is final, the oracle calls `unlock_case(case_key, delinquent)` with the list of
jurors who never voted. For every seat of that jury: if its owner is on the delinquent list, the
seat loses the seat time of the case, and then the seat stops serving. A second call for the same
case does nothing, so nobody is penalised twice. The call cannot fail for want of work to do, so a
case is always released. If it fails for another reason, anyone can retry it through the oracle's
`retry_unlock`, and `jury_of(case_key)` shows whether seats are still held.

### What a silent juror loses

The seat time between the draw and the release, in every quarter that touches that span and is not
final yet. It leaves the seat's weight and the quarter's total (events `seat_time_forfeited`), so the
other seats' shares rise. A quarter already final is left alone (event `forfeit_skipped`), which is
what the grace period before finalizing is for: a case lasts a few days, so almost every case that
crosses a quarter's end settles before the quarter is final. A span is looked at across at most eight
quarters. Jurors also lose their share of juror pay, which is handled in oracle. A juror who
committed but had no chance to reveal because the case settled early on a majority is not on the list.
The penalty is small when the case is short, so on its own it is a weak deterrent.

---

## Every method

| Method                                                                                                             | Who                       | What it does                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new(...)`                                                                                                         | Deployer, once            | Initialises.                                                                                                                                                                                                        |
| `propose_owner(new_owner)`                                                                                         | Owner                     | Starts a handover.                                                                                                                                                                                                  |
| `accept_owner()`                                                                                                   | The proposed account      | Completes it. Two steps so a typo cannot lock the contract.                                                                                                                                                         |
| `set_cooldown_ns(cooldown_ns)`                                                                                     | Owner                     | Changes the unstake wait. Above zero.                                                                                                                                                                               |
| `set_max_seats_per_account(n)`                                                                                     | Owner                     | Changes the per-account cap. At least 1.                                                                                                                                                                            |
| `set_nft_contract(nft_contract)`                                                                                   | Owner                     | Sets or changes the collection. Only while nothing is staked. The allowlist stays stored and applies to the old collection only. Event `nft_contract_set`.                                                           |
| `set_market(market)`                                                                                               | Owner                     | Sets the only account whose sweeps count as revenue. Event `market_set`.                                                                                                                                            |
| `set_close_grace_ns(close_grace_ns)`                                                                               | Owner                     | Sets the wait after a quarter's end before it can be finalized and claimed, from 1 to 30 days. Applies to every quarter not final yet. Event `close_grace_set`.                                                      |
| `allow_tokens(token_ids)`, `set_token_range(first, last)`, `clear_token_range()`, `set_allowlist_enabled(enabled)` | Owner                     | The allowlist, above.                                                                                                                                                                                               |
| `stage_code()` (payable)                                                                                           | Anyone                    | The call input is a wasm. It is stored under its own sha256, which is returned. The deposit pays for the storage (1 NEAR per 100 KB) and the surplus is refunded. Attach 100 TGas, because 250 KB burns about 31.   |
| `upgrade(code_hash)`                                                                                               | Owner                     | Deploys the staged wasm with that sha256 and runs its `migrate`, in one batch. Needs at least 100 TGas attached.                                                                                                    |
| `migrate()`                                                                                                        | The contract itself       | Runs in the new code in the same batch as the deploy. Refuses unless `upgrade` marked the upgrade in flight. Reads the state as the one layout it knows, clears the mark, sets `upgrade_proven`, returns the state. |
| `seal(public_key)`                                                                                                 | Owner                     | Deletes that access key from this account. Refused until an upgrade has gone through `migrate`.                                                                                                                     |
| `nft_on_transfer(sender_id, previous_owner_id, token_id, msg)`                                                     | The NFT collection only   | Stakes a seat.                                                                                                                                                                                                      |
| `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)`                                           | The verifier only         | Receives revenue (`msg` must be `revenue:<sweep id>`, from the market) and answers `[0]`.                                                                                                                           |
| `request_unstake(token_id)`                                                                                        | The seat's holder         | Starts the cooldown.                                                                                                                                                                                                |
| `unstake(token_id)` (payable, 1 yocto)                                                                             | The seat's holder         | Counts the seat's time and returns the NFT. Pays nothing.                                                                                                                                                           |
| `claim_quarter(quarter, token_id)` (payable, 1 yocto)                                                              | The seat's holder         | Pays the caller's share of a final quarter, once.                                                                                                                                                                   |
| `finalize_quarter(quarter)`                                                                                        | Anyone                    | Fixes a quarter's pool and total seat time once its grace period has passed. In order.                                                                                                                              |
| `advance_quarters(max_steps)`                                                                                      | Anyone                    | Moves seat time forward across at most eight quarters. Returns how many it crossed.                                                                                                                                 |
| `book_seat_time(token_id, max_quarters)`                                                                           | Anyone                    | Counts a staked seat's time up to now across at most eight quarters. Needed only after a very long idle stretch.                                                                                                    |
| `draw(case_key, n, exclude)`                                                                                       | Oracle only               | Draws a jury.                                                                                                                                                                                                       |
| `unlock_case(case_key, delinquent)`                                                                                | Oracle only               | Releases a jury and takes the forfeit.                                                                                                                                                                              |
| `on_unstaked`, `on_claim_paid`                                                                                     | The contract itself       | Callbacks.                                                                                                                                                                                                          |

---

## Upgrading this contract

No access key can replace this code outside an owner call, and no deleted key can freeze it. The owner
(the DAO) calls `upgrade` with the hash of a build that anyone staged with `stage_code`. The call
needs at least 100 TGas (`attach at least 100 TGas to upgrade`), takes the staged wasm out of
storage and sends one batch to this account: deploy, then `migrate`. A `migrate` that panics reverts
the deploy and the old code stays. The staged copy is gone either way, so a failed upgrade stages
the code again.

`upgrade` sets `upgrade_in_flight` just before it sends the batch. `migrate` refuses to run without
it (`migrate runs only inside an upgrade`), clears it and sets `upgrade_proven`, so a hand-called
`migrate` proves nothing. When the batch fails, the old code keeps the mark and the next `upgrade`
sets it again. Both flags are shown in `config` next to `state_version`. `seal` is refused until it
is true (`prove the upgrade path before deleting keys`). The state struct starts with
`state_version: u16`, 2 today (version 2 is the quarterly books). `migrate` reads the first two bytes
of the stored state and refuses anything but 2 (`migrate expects version 2`), then reads the version 2
struct. It never guesses a layout from bytes. A version 3 build keeps the version 2 struct as
`StateV2`, reads that, builds its state and writes `state_version: 3`. A state written by version 1
(the 30-day stream) is refused, so an upgrade from it reverts instead of reading it wrongly.

SputnikDAO runs a proposal in the same call as the approval that reaches its threshold. By owner
decision (2026-10-21, R-07) the voting period is the only delay, and no delay after approval will be
built. This contract has no pause, so
`request_unstake`, `unstake` and `claim_quarter` work at all times except for a seat serving on an
open case, and an upgrade does not touch them. The staked seats and the quarterly books are in the
state that `migrate` reads, and the sandbox test checks that a seat's record and the seat count are
identical after an upgrade.

Measured in the sandbox for a 249 KB build: `upgrade` burns 30 TGas in all, 17 of them the deploy
and migrate batch, and `seal` burns 2. The accepted deployment controls are in
[DEPLOY.md](DEPLOY.md#3-administration-and-upgrades). Trezu/Sputnik execution still needs its own
integration evidence.

---

## Views

| View                               | Returns                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seat_count()`                     | How many seats are staked.                                                                                                                                                                                                                                                                                                    |
| `is_seat(account_id)`              | Whether the account holds at least one seat.                                                                                                                                                                                                                                                                                  |
| `staked_tokens(from_index, limit)` | A page of staked token ids.                                                                                                                                                                                                                                                                                                   |
| `stake_of(token_id)`               | A seat's record (owner, staked time, unstake request time, serving case, time counted up to), or nothing.                                                                                                                                                                                                                      |
| `seats_of(account_id)`             | The tokens the account has staked now.                                                                                                                                                                                                                                                                                         |
| `current_quarter()`, `get_quarter(quarter)`, `list_quarters(from_quarter, limit)` | A quarter: id and label (`2026Q4`), start, end, when its claims open (`claimable_from`), state (`open`, `closing`, `final`), revenue in, rolled in, pool, seat time, forfeited seat time, paid, pending and where its pool rolled to. A quarter with no activity shows empty. A list is at most 50 quarters. `get_quarter` is null for a quarter that has not started. |
| `quarter_of(at)`                   | The quarter a time falls in: id, label, start and end.                                                                                                                                                                                                                                                                         |
| `get_entitlement(quarter, token_id, account_id)` | What one token earned for one owner in one quarter: seat time, amount, `estimated`, status (`accruing`, `closing`, `claimable`, `pending`, `paid`) and the times of the request and the payment. While the quarter is not final the amount is a guess. Null when the owner earned nothing there.                |
| `entitlements_of(account_id, from_quarter, limit)` | The entitlements of every token the account has ever staked, for `limit` quarters from `from_quarter` (at most 50), oldest first. Tokens and quarters with nothing earned are left out.                                                                                                                         |
| `received_of(sweep_id)`            | What the market sent under a sweep id (amount, quarter, time), or null. The market reads it to settle a transfer whose result was lost.                                                                                                                                                                                       |
| `reward_totals()`                  | Total received, total paid, claims in flight, money in quarters still open, money in final quarters not yet claimed (the dust included), and the total rolled forward.                                                                                                                                                         |
| `total_received()`                 | Every revenue token this contract has taken in since the start, whether claimed yet or not. Forfeits are not money and are not counted.                                                                                                                                                                                       |
| `is_allowed(token_id)`             | Whether the token could be staked now.                                                                                                                                                                                                                                                                                        |
| `jury_of(case_key)`                | The tokens still held for a case. Empty once released.                                                                                                                                                                                                                                                                        |
| `is_staged(code_hash)`             | Whether a wasm with that sha256 is staged.                                                                                                                                                                                                                                                                                    |
| `config()`                         | state version, upgrade proven, upgrade in flight, owner, pending owner, oracle, NFT collection and market (null until set), verifier, collateral token id, cooldown, grace period (`close_grace_ns`), seat cap, allowlist on or off, the allowed range, `total_received`, the next quarter to finalize and the time seat time is counted up to. |

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
| `claim_reconciled`                | `reconcile_claim`                           | quarter, token_id, owner, amount, paid |
| `staked`                          | A seat is staked                            | token_id, owner                    |
| `unstake_requested`               | `request_unstake`                           | token_id, owner, unlock_at         |
| `nft_contract_set`                | `set_nft_contract`                          | nft_contract                       |
| `market_set`                      | `set_market`                                | market                             |
| `close_grace_set`                 | `set_close_grace_ns`                        | close_grace_ns                     |
| `revenue`                         | Revenue arrives                             | from, amount, sweep_id, quarter, seats |
| `quarter_finalized`               | `finalize_quarter`                          | quarter, pool, weight_ns, rolled_to (null or the next quarter) |
| `claim_requested`                 | `claim_quarter`, before the payout is sent  | quarter, token_id, owner, amount   |
| `claim_paid`                      | The payout went through                     | quarter, token_id, owner, amount   |
| `claim_failed`                    | The payout failed and the claim was undone  | quarter, token_id, owner, amount   |
| `seat_time_forfeited`             | A silent juror's seat time was taken        | token_id, owner, case, quarter, forfeited_ns |
| `forfeit_skipped`                 | The quarter was already final               | token_id, owner, case, quarter     |
| `unstaked`                        | The NFT was returned                        | token_id, owner                    |
| `unstake_failed`                  | A transfer failed and the seat was restored | token_id, owner                    |
| `code_staged`                     | `stage_code`                                | code_hash, bytes, by               |
| `upgrade_sent`                    | `upgrade`                                   | code_hash                          |
| `migrated`                        | `migrate`, in the new code                  | state_version                      |
| `seal_sent`                       | `seal`                                      | public_key                         |

---

## What can go wrong, and the message you will see

| Message                                                                                                                                                      | Cause                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `owner only` / `oracle only` / `not the proposed owner`                                                                                                      | Access refusals.                                                 |
| `only the verifier can deliver money` / `exactly one token and amount` / `wrong token` / `unknown action`                                                    | Revenue from a caller that is not the verifier, a batch, another token id, or a message other than `revenue:<sweep id>`. |
| `revenue comes from the market only` / `that sweep was already received` / `the Council is not configured, the owner must call set_market`                    | Revenue from any other sender, a repeated sweep id, or before the owner set the market.          |
| `the NFT collection is not set, the owner must call set_nft_contract`                                                                                        | Staking or allowing a token before the owner set the collection.                                 |
| `the collateral token id must look like nep141:<token>`                                                                                                      | `new` with a token id in the wrong form.                         |
| `wrong NFT contract` / `that token is not on the allowlist` / `already staked` / `the council is full` / `that account already holds the most seats allowed` | A refused stake.                                                 |
| `name at least one token` / `at most 100 tokens in one call` / `the first id must not be above the last`                                                     | A refused allowlist change.                                      |
| `attach at least 33 TGas: ...`                                                                                                                               | `unstake` or `claim_quarter` with less than its gas floor.       |
| `that quarter is not final` / `the quarter cannot be finalized yet` / `finalize the earlier quarter first` / `that quarter is already final`                 | A claim before the quarter is final, or a finalize that is too early, out of order or repeated. |
| `claim is already pending` / `already claimed` / `nothing to claim`                                                                                          | A refused claim.                                                 |
| `call advance_quarters first` / `book this seat first`                                                                                                       | More than eight idle quarters of seat time or of one seat's time to count. |
| `the grace period must be between 1 and 30 days`                                                                                                             | `set_close_grace_ns` out of its bounds.                          |
| `not staked` / `not your seat`                                                                                                                               | Acting on a seat you do not hold.                                |
| `unstake already requested` / `request an unstake first` / `the cooldown has not passed`                                                                     | Wrong unstake order or timing.                                   |
| `a jury drawn in this quarter is still open` / `book this seat first` | `finalize_quarter` while an earlier jury is open (until 30 days after the quarter ends). `book this seat first` on a request or claim after a long idle stretch. |
| `this seat is serving on an open case`                                                                                                                       | A seat held for a case.                                          |
| `not enough seat holders to draw a jury: N eligible, M needed`                                                                                               | Too few different holders.                                       |
| `unstake every seat before changing the NFT contract`                                                                                                        | `set_nft_contract` while seats exist.                            |
| `the cooldown must be positive` / `an account must be allowed at least one seat`                                                                             | Bad settings.                                                    |
| `Requires attached deposit of exactly 1 yoctoNEAR`                                                                                                           | `claim_quarter` or `unstake` without the 1 yocto.                |
| `attach at least 100 TGas to upgrade`                                                                                                                        | `upgrade` with less gas than the deploy and migrate need.        |
| `no code is staged under that hash`                                                                                                                          | `upgrade` for a hash nobody staged, or one already used.         |
| `attach at least <amount> to pay for the storage` / `the wasm goes in the call input`                                                                        | `stage_code` with too little deposit or no input.                |
| `prove the upgrade path before deleting keys`                                                                                                                | `seal` before an upgrade has gone through `migrate`.             |
| `migrate expects version 2`                                                                                                                                  | `migrate` found state written by another version.                |
| `migrate runs only inside an upgrade`                                                                                                                        | `migrate` called without `upgrade` having sent the batch.        |
| `Method <name> is private`                                                                                                                                   | A callback called from outside.                                  |

---

## Gas

| Step                                | Gas                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A jury draw                         | About 190 to 210 TGas at the 1,000 seat cap (reserved by the oracle at 250)                                                                                            |
| `unlock_case` for a 21 juror case   | Measured before the quarterly change at most about 8.9 TGas when every juror forfeits. A forfeit now writes the same few entries per quarter touched, at most eight quarters. |
| A `claim_quarter`                   | Must attach at least 33 TGas: 15 for the verifier's `mt_transfer`, 10 for its callback and 8 for the call itself. Measured at the floor: 3.1 TGas burned in the Council and 9 TGas in all, both legs of the claim finishing. |
| An `unstake`                        | Must attach at least 33 TGas: 15 for the NFT transfer, 10 for its callback and 8 for the call itself, down from 58 because no payout is sent. Measured at the floor: 3.7 TGas burned in the Council and 7 TGas in all. |
| Each verifier or NFT transfer reserved | 15 TGas; callbacks 10 TGas                                                                                                                                          |
| Revenue receipt `mt_on_transfer`    | Burns 2.0 TGas (1.6 before the quarterly books), and the Council took revenue with 22 TGas attached to the verifier call. The verifier gives the receiver what is attached to its `mt_transfer_call` less about 20.5 TGas. Market attaches 42. |
| `finalize_quarter`                  | One book write and no transfer. Measured: 1.8 TGas burned, 2 in all, with 30 attached. |
| `allow_tokens`                      | 13 TGas for 100 ids of 63 bytes                                                                                                                                        |
| `migrate` in the upgrade batch      | 30 TGas reserved (the batch of deploy and migrate burned 17 for a 249 KB build)                                                                                        |
| `upgrade`                           | At least 100 TGas attached; 30 burned in all for a 249 KB build                                                                                                        |

---

## Security properties checked by tests

Every restricted method refuses a stranger and every callback refuses a direct call; a stranger
cannot initialise a deployed council; with the allowlist on, only named tokens and plain numbers
inside the range stake, and `007` and `+7` do not; names and a range made for one collection allow
nothing in the next; a hand-called `migrate` is refused; `unstake` and `claim_quarter` refuse less than
their gas floors; `total_received` counts every revenue arrival and no forfeit; a fake NFT
collection cannot stake seats and a call to `nft_on_transfer` made directly is refused; a fake token
cannot add revenue, whether it arrives through the verifier or is called directly; only the market's
sweeps count as revenue and a sweep id is taken once, including against the real verifier, which gives
a refused send back; a seat staked by an approved relayer belongs to its real owner; two claims or
two unstakes sent at once pay once; a failed NFT return restores the seat; a seat that asked to
leave is never drawn; a silent juror loses exactly the seat time of the case and a juror who voted
keeps everything; the draw depends only on the block seed, the seat set and the case key; the
calendar function agrees with an independent count at every month boundary from 1970 to 2100; the
worked examples of the spec (the baseline quarter, a late sweep, a seat staked at noon on the last
day, a silent juror, a quarter with no seats, a failed claim) give their figures to the unit; a seat
staked one block before a large arrival earns less than the seats that were there all along; a share
is the staked time over all staked time, rounded down, and the shares plus the dust are the pool; a
claim is paid once, a failed payout can be claimed again, and an unclaimed share is still there
later; and, over random sequences of stakes, unstakes, sweeps, draws with forfeits, finalizations and
claims across several quarters, every unit received is in an open or a final pool, nothing is paid
twice, and the weights of a finished quarter add up to its seat time less its forfeits.

A stranger cannot upgrade or seal, an unknown hash and too little gas or deposit are refused, `seal`
waits for `upgrade_proven`, `migrate` refuses another state version, and the seats survive an
upgrade unchanged. See `AUDIT.md`.

---

## Things to know

| Topic                                          | Detail                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legal                                          | Seats that earn a share of platform revenue are the shape most securities law treats as an investment. Nothing is minted or sold, and selling seats needs counsel first. The revenue share and juror pay are kept separate.                                                                 |
| The seat cap number is not chosen              | The tests use small values. A real deployment needs a number.                                                                                                                                                                                                                               |
| Revenue is paid by quarter                     | A seat that leaves keeps the right to what it earned in every finished quarter, and earns nothing after it leaves. A holder who stakes for a day gets a day's share of that quarter. Claims open once a quarter is final, 7 days after it ends to start. Unclaimed shares never expire. |
| Rounding dust and quarters nobody can claim    | A share rounds down, so up to one unit per seat stays in the Council as unallocated backing, and no method moves it. A quarter with revenue and no seat time moves its pool into the next quarter. A pool whose seats never claim stays in the Council. |
| Storage grows with seats and quarters          | Each seat and quarter it touched adds about 100 bytes, and each claim about 120, paid from the Council's NEAR balance. A full council of 1,000 seats over a year is under 4,000 entries of each, near 0.9 MB or about 9 NEAR. The keeper's storage margin check covers it. Every token an account has staked is also kept in a list so its entitlements can be listed after the seat is gone. |
| The sandbox cannot reach a quarter's end       | A quarter ends about two months of blocks away. The unit tests move the clock. The sandbox tests of a finished quarter file the books of the running quarter under an earlier one (`age_current_quarter` in `contracts/tests/tests/common/mod.rs`) and say so. |
| More than 1,000 seats                          | The draw reads every seat, so a bigger collection needs a different draw. Not built; it depends on the planned collection size.                                                                                                                                                             |
| The seat cap limits revenue concentration only | A jury is made of distinct accounts, so the best setup for an attacker is one seat in each of many wallets, and a per-account cap does nothing against that. An account is not a person. Identity checks or a buyer cap at sale time are needed. `spec.md` section 9 says the same.         |
| Unstaked NFTs earn nothing                     | Only staked seats earn and can be drawn.                                                                                                                                                                                                                                                    |
| Keys                                           | Until `seal` has run, the deploy key can replace this code outside every vote. After it, only an owner upgrade can. A sealed contract with a broken upgrade path cannot be fixed, so prove one upgrade first.                                                                           |
| No outside audit                               | The only review is the self-review in `AUDIT.md`.                                                                                                                                                                                                                                           |
