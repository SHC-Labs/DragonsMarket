# council

Target decision, 2026-10-20: retain NFT staking, eligibility, jury duties and reward accounting.
The Council controls the 25% holder allocation with backing held in NEAR Intents; eligible
holders claim quarterly. The other 75% goes to the Trezu treasury. The 30-day stream and current
claim method below are existing-code behaviour, not an implemented quarterly claim schedule.
Define quarter boundaries and single-use Intents payout settlement before enabling it.
Trezu/SputnikDAO replaces custom governance as the administration target; treasury votes do not
replace juries. See [the architecture](../intents-architecture.md).

Status, 2026-10-20, phase I2 of the Intents migration: revenue now arrives through the NEAR Intents
verifier and claims and unstakes are paid out of the Council's own account in it. The Council
receives revenue as `mt_on_transfer` (caller the verifier, token id the configured one, message
`revenue`) and pays with `mt_transfer` of 1 yocto from this contract, with no signed intent and no
key registered in the verifier. NFT staking (NEP-171), eligibility and reward-liability accounting
are unchanged. The quarterly claim gate, the 75/25 allocation with the Trezu treasury and the
owner delay for upgrades (R-07) are not built here. A quarterly claim gate is not implied by the
current streamed accrual.

Source: `council/src/lib.rs`, with the shared upgrade helpers in `upgrade/src/lib.rs`. Written
2026-10-18 from the code as it stands, upgrade path added 2026-10-19, the per-collection allowlist
and the upgrade mark added 2026-10-20. The code describes current behaviour. The accepted spec defines the target; differences
are implementation work, not reasons to drop a requirement.

---

## Required changes for the product target

See [requirements R-04, R-05 and R-08](../spec.md#requirements-to-implementation-map).

- Retain eligible NFT staking, earning rules, case locks and jury duties.
- Add quarter accounting that records each eligible holder's entitlement and its backing inside
  Intents. Define how continuous earnings, vesting and quarter availability relate; do not assume
  the existing 30-day stream answers that question.
- Add or adapt the claim path so a quarterly entitlement is reserved once, paid through
  Council-authorised settlement, and confirmed or recovered without a second spendable claim.
- Define quarter boundaries, late-arriving fees, no-seat periods, rounding and unclaimed balances.
  Changing eligibility must not award an entire quarter to a last-minute stake.
- Expose quarter identity/timing, accrued entitlement, claimable entitlement, pending payments and
  confirmed payments. These are required data fields, not approved method names.
- Migrate administrative authority to the reviewed Trezu/Sputnik execution path.

The contract handoff must include the proposed functions, permissions, state changes, events,
migration and tests. Quarterly claims are a build requirement, not optional because the present
claim method lacks a calendar gate. Keep jury work compensation separate from holder revenue.

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
2. It shares revenue. A quarter of all trading fees is sent here and released to the staked seats at
   a steady rate over 30 days, divided equally among the seats staked at each moment, and each
   seat's holder can claim what their seat has earned.

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
| market                                            | Sends 25% of trading fees here as revenue, with an `mt_transfer_call` through the verifier.                                                   |
| The NFT collection (NEP-171, in tests `mock-nft`) | The only collection that can be staked.                                                                                                       |
| The NEAR Intents verifier                         | Holds the Council's revenue in the Council's own account. Revenue arrives through it and claims and unstakes are paid out of it.              |
| The owner (the DAO)                               | Trezu/SputnikDAO. It holds the owner role.                                                                                                    |

---

## Roles: who can do what

| Role                 | Set by                                         | Can do                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                | `new`, then `propose_owner` and `accept_owner` | `set_cooldown_ns`, `set_max_seats_per_account`, `set_nft_contract`, `allow_tokens`, `set_token_range`, `clear_token_range`, `set_allowlist_enabled`, `propose_owner`, `upgrade` and `seal`. Normally the DAO. |
| Oracle               | `new` (fixed)                                  | `draw` and `unlock_case`.                                                                                                                                                                                                     |
| Seat holder          | Stakes an NFT                                  | `request_unstake`, `unstake` and `claim` for their own seats.                                                                                                                                                                 |
| The verifier         | `new` (fixed)                                  | Only `mt_on_transfer`, which is how revenue arrives.                                                                                                                                                                          |
| The NFT collection   | `new`, changeable only while nothing is staked | Only `nft_on_transfer`, which is how seats are staked.                                                                                                                                                                        |
| Anyone               | n/a                                            | Send revenue (it is just a donation to the seats), `stage_code` (paying for the storage), and every view.                                                                                                                     |

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
| `nft_contract`          | The one NFT collection whose tokens can be staked.                                                                                |
| `verifier_id`           | The Intents verifier that holds the revenue, `intents.near` on mainnet.                                                           |
| `collateral_token_id`   | The revenue token's exact id in the verifier, `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` on mainnet. Must start with `nep141:`. |
| `cooldown_ns`           | How long a seat must wait between asking to unstake and leaving, in nanoseconds. Must be above zero.                              |
| `max_seats_per_account` | The most seats one account can hold. Must be at least 1.                                                                          |
| `allowlist_enabled`     | Optional. Left out, it is on. See "The allowlist". Passing `false` is for tests and for a collection that is safe without a list. |

There is also a fixed cap of 1,000 seats in the whole council, written into the code.

---

## Units and conventions

| Thing                      | Convention                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token ids                  | Strings, as the NFT collection uses them.                                                                                                                                |
| Times                      | Nanoseconds since the Unix epoch.                                                                                                                                        |
| Big numbers in JSON        | `U64` and `U128` travel as strings.                                                                                                                                      |
| Revenue amounts            | Raw units of the collateral token.                                                                                                                                       |
| Internal revenue precision | Revenue per seat is stored in units of one trillionth of a token unit, so splitting a small amount across many seats loses almost nothing. This never appears in a view. |
| The stream length          | 30 days, a constant in the code.                                                                                                                                         |

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

Three more fields exist internally and are not shown in views: where the token sits in the staked
list, the revenue already accounted to it, and the revenue level when it was drawn.

### Leaving: unstaking

It takes two steps and a wait.

1. `request_unstake(token_id)`. The holder asks to leave. Refused if the seat is serving on an open
   case or a request is already pending. From now on the seat is not available to be drawn.
2. After the cooldown has passed, `unstake(token_id)` with 1 yoctoNEAR attached. The seat is removed
   first, then what it earned is paid into the holder's Intents account, then the NFT is returned. The NFT
   leaves carrying no revenue, so an NFT sold after unstaking carries nothing with it.

If the revenue transfer fails, the seat is restored exactly as it was, with what it had earned. If
the NFT transfer fails (for example the collection is broken), the seat is restored too, and it can
be unstaked again without waiting a new cooldown. The recipient needs no registration anywhere, because the verifier credits any account. The
payout goes only to the seat's owner on record. The revenue transfer fails when the verifier is
paused or the Council's account is locked there, and the seat is restored.

Between the request and the unstake the seat still counts when revenue arrives, but it cannot claim
(unstaking pays instead) and cannot be drawn.

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
someone sends the collateral with `mt_transfer_call` and the message `revenue`. The money is already
in the Council's Intents account when the hook runs. In practice market does this when `sweep_fees`
is called. Anyone may send revenue; it is a donation to the seats. The hook refuses a caller that is
not the verifier (`only the verifier can deliver money`), more than one token or amount (`exactly one
token and amount`), a token id other than the configured one (`wrong token`) and any message other
than `revenue` (`unknown action`). A refusal makes the verifier return the money to the sender. The
answer is the amounts to hand back, and the Council always answers `[0]`, which keeps everything.

Tokens sent to the Council's Intents account any other way, a plain deposit for example, never reach
the hook. They are not counted in `total_received` and are not streamed to anyone. They sit in the
Council's account as unattributed surplus.

### How it is released

Every revenue arrival goes into a stream, together with whatever is still left in it. The stream
releases at a steady rate and finishes about 30 days after the arrival. What is released at any
moment is divided equally among the seats staked at that moment, whatever each seat's age. A running
figure, revenue released per seat since the start, goes up by that share. Each seat remembers the
figure when it was staked, so a seat only ever earns from what is released after it joined. What a
seat is owed at any time is the difference between the current figure and its own.
`pending_reward(token_id)` shows it, and it counts what has been released up to this moment,
including the part the stored figure has not caught up with yet.

The stored figure is brought up to date at the start of every method that changes the seat count or
pays a seat: staking, a request to leave, claiming, unstaking, a failed unstake coming back, drawing
a jury and releasing one.

When more revenue arrives while some is still streaming, the end moves to the average of the old end
and a full 30 days from now, weighted by how much each part holds. A tiny arrival therefore moves
the end by a tiny amount, and cannot be used to keep slowing what is already streaming. A large
arrival moves it most of the way to 30 days.

If no seat is staked, nothing is released and the end of the stream moves out by the same time, so
revenue that arrives with no seats, or while seats are away, is not lost. It starts to release when
a seat exists.

Rounding: the division rounds down, and what does not divide evenly among the seats stays in the
stream. Over the randomized tests, no unit of revenue was created or lost beyond about one unit of
dust per seat.

### Claiming

`claim(token_id)` with 1 yoctoNEAR attached pays the seat everything it is owed, into its
holder's Intents account. The seat is marked paid before the transfer and the mark is taken back if the transfer
fails. Two claims sent at once pay once. A claim is refused if:

| Refusal message                                                    | Cause                                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `this seat is serving on an open case, claim after it is final`    | The seat is drawn on a case. Claims are blocked while serving so a juror cannot take the revenue out before a forfeit. |
| `an unstake is requested, and unstaking pays what the seat earned` | An unstake is pending.                                                                                                 |
| `nothing to claim`                                                 | The seat is owed nothing yet.                                                                                          |
| `not your seat` / `not staked`                                     | Not the holder, or not a seat.                                                                                         |

### Staking just before a sweep

Revenue used to go to the seats staked at the moment it arrived, and anyone can trigger the sweep
that sends it. Someone who staked many NFTs a moment before a sweep took a share of everything
gathered since the last sweep, then left after the cooldown: in a test, ten NFTs staked for one
block took two thirds of a month of fees. With the stream, a seat earns only for the time it was
staked. In the same test, ten seats staked for one block before the arrival earned about one second
of 30 days. The cost of the attack is now the cost of holding the seats for as long as the payout
takes to be worth it. The seat cap still limits how much of the stream one wallet can hold.

---

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
revenue the seat earned while serving is taken from it and added to the stream for all the seats,
and then the seat stops serving. A second call for the same case does nothing, so nobody is
penalised twice. If the call fails, anyone can retry it through the oracle's `retry_unlock`, and
`jury_of(case_key)` shows whether seats are still held.

### What a silent juror loses

The revenue their seat earned during the case, between the draw and the release. It goes back into
the stream and is released to all seats with the rest. Jurors also lose their share of juror pay,
which is handled in oracle. A juror who committed but had no chance to reveal because the case
settled early on a majority is not on the list. The penalty is small when revenue is small, so on
its own it is a weak deterrent.

---

## Every method

| Method                                                                                                             | Who                       | What it does                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new(...)`                                                                                                         | Deployer, once            | Initialises.                                                                                                                                                                                                        |
| `propose_owner(new_owner)`                                                                                         | Owner                     | Starts a handover.                                                                                                                                                                                                  |
| `accept_owner()`                                                                                                   | The proposed account      | Completes it. Two steps so a typo cannot lock the contract.                                                                                                                                                         |
| `set_cooldown_ns(cooldown_ns)`                                                                                     | Owner                     | Changes the unstake wait. Above zero.                                                                                                                                                                               |
| `set_max_seats_per_account(n)`                                                                                     | Owner                     | Changes the per-account cap. At least 1.                                                                                                                                                                            |
| `set_nft_contract(nft_contract)`                                                                                   | Owner                     | Changes the collection. Only while nothing is staked. The allowlist stays stored and applies to the old collection only. Logs no event.                                                                             |
| `allow_tokens(token_ids)`, `set_token_range(first, last)`, `clear_token_range()`, `set_allowlist_enabled(enabled)` | Owner                     | The allowlist, above.                                                                                                                                                                                               |
| `stage_code()` (payable)                                                                                           | Anyone                    | The call input is a wasm. It is stored under its own sha256, which is returned. The deposit pays for the storage (1 NEAR per 100 KB) and the surplus is refunded. Attach 100 TGas, because 250 KB burns about 31.   |
| `upgrade(code_hash)`                                                                                               | Owner                     | Deploys the staged wasm with that sha256 and runs its `migrate`, in one batch. Needs at least 100 TGas attached.                                                                                                    |
| `migrate()`                                                                                                        | The contract itself       | Runs in the new code in the same batch as the deploy. Refuses unless `upgrade` marked the upgrade in flight. Reads the state as the one layout it knows, clears the mark, sets `upgrade_proven`, returns the state. |
| `seal(public_key)`                                                                                                 | Owner                     | Deletes that access key from this account. Refused until an upgrade has gone through `migrate`.                                                                                                                     |
| `nft_on_transfer(sender_id, previous_owner_id, token_id, msg)`                                                     | The NFT collection only   | Stakes a seat.                                                                                                                                                                                                      |
| `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)`                                           | The verifier only         | Receives revenue (`msg` must be `revenue`) and answers `[0]`.                                                                                                                                                       |
| `request_unstake(token_id)`                                                                                        | The seat's holder         | Starts the cooldown.                                                                                                                                                                                                |
| `unstake(token_id)` (payable, 1 yocto)                                                                             | The seat's holder         | Pays out what the seat earned, returns the NFT.                                                                                                                                                                     |
| `claim(token_id)` (payable, 1 yocto)                                                                               | The seat's holder         | Pays out what the seat earned, keeping it staked.                                                                                                                                                                   |
| `draw(case_key, n, exclude)`                                                                                       | Oracle only               | Draws a jury.                                                                                                                                                                                                       |
| `unlock_case(case_key, delinquent)`                                                                                | Oracle only               | Releases a jury and takes the forfeit.                                                                                                                                                                              |
| `on_unstake_paid`, `on_unstaked`, `on_claimed`                                                                     | The contract itself       | Callbacks.                                                                                                                                                                                                          |

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
`state_version: u16`, 1 today. `migrate` reads the first two bytes of the stored state and refuses
anything but 1 (`migrate expects version 1`), then reads the version 1 struct. It never guesses a
layout from bytes. A version 2 build keeps the version 1 struct as `StateV1`, reads that, builds its
state and writes `state_version: 2`.

SputnikDAO runs a passed proposal at once, so no delay is enforced between approval and an upgrade yet
(requirement R-07, not built). This contract has no pause, so
`request_unstake`, `unstake` and `claim` work at all times except for a seat serving on an open
case, and an upgrade does not touch them. The staked seats and their revenue accounting are in the
state that `migrate` reads, and the sandbox test checks that a seat's record and the seat count are
identical after an upgrade.

Measured in the sandbox for a 249 KB build: `upgrade` burns 30 TGas in all, 17 of them the deploy
and migrate batch, and `seal` burns 2. The accepted deployment controls are in
[DEPLOY.md](DEPLOY.md#3-administration-and-upgrades). Trezu/Sputnik execution and the required
delay still need their own integration evidence.

---

## Views

| View                               | Returns                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seat_count()`                     | How many seats are staked.                                                                                                                                                                                                                                                                                                    |
| `is_seat(account_id)`              | Whether the account holds at least one seat.                                                                                                                                                                                                                                                                                  |
| `staked_tokens(from_index, limit)` | A page of staked token ids.                                                                                                                                                                                                                                                                                                   |
| `stake_of(token_id)`               | A seat's record (owner, staked time, unstake request time, serving case), or nothing.                                                                                                                                                                                                                                         |
| `pending_reward(token_id)`         | What `claim` would pay now, counting what the stream has released up to this moment.                                                                                                                                                                                                                                          |
| `total_received()`                 | Every revenue token this contract has taken in since the start, whether the stream has released it yet or not. Forfeits are not counted. market's owner compares it with what the market sent when a transfer's result was lost.                                                                                              |
| `is_allowed(token_id)`             | Whether the token could be staked now.                                                                                                                                                                                                                                                                                        |
| `jury_of(case_key)`                | The tokens still held for a case. Empty once released.                                                                                                                                                                                                                                                                        |
| `is_staged(code_hash)`             | Whether a wasm with that sha256 is staged.                                                                                                                                                                                                                                                                                    |
| `config()`                         | state version, upgrade proven, upgrade in flight, owner, pending owner, oracle, NFT collection, verifier, collateral token id, cooldown, seat cap, allowlist on or off, the allowed range, `total_received`, `stream_ns` (30 days), `stream_remaining` (the revenue still to be released, in token units, as of now) and `stream_ends_at`. |

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
| `staked`                          | A seat is staked                            | token_id, owner                    |
| `unstake_requested`               | `request_unstake`                           | token_id, owner, unlock_at         |
| `revenue`                         | Revenue arrives                             | from, amount, seats                |
| `revenue_claimed`                 | A claim, or the payout inside an unstake    | token_id, owner, amount            |
| `claim_failed`                    | The claim transfer failed and was undone    | token_id, owner, amount            |
| `revenue_forfeited`               | A silent juror's revenue was taken          | token_id, owner, amount, case      |
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
| `only the verifier can deliver money` / `exactly one token and amount` / `wrong token` / `unknown action`                                                    | Revenue from a caller that is not the verifier, a batch, another token id, or a message other than `revenue`. |
| `the collateral token id must look like nep141:<token>`                                                                                                      | `new` with a token id in the wrong form.                         |
| `wrong NFT contract` / `that token is not on the allowlist` / `already staked` / `the council is full` / `that account already holds the most seats allowed` | A refused stake.                                                 |
| `name at least one token` / `at most 100 tokens in one call` / `the first id must not be above the last`                                                     | A refused allowlist change.                                      |
| `attach at least 58 TGas: ...` / `attach at least 33 TGas: ...`                                                                                              | `unstake` or `claim` with less than its gas floor.               |
| `not staked` / `not your seat`                                                                                                                               | Acting on a seat you do not hold.                                |
| `unstake already requested` / `request an unstake first` / `the cooldown has not passed`                                                                     | Wrong unstake order or timing.                                   |
| `this seat is serving on an open case` / `this seat is serving on an open case, claim after it is final`                                                     | A seat held for a case.                                          |
| `an unstake is requested, and unstaking pays what the seat earned` / `nothing to claim`                                                                      | A refused claim.                                                 |
| `not enough seat holders to draw a jury: N eligible, M needed`                                                                                               | Too few different holders.                                       |
| `unstake every seat before changing the NFT contract`                                                                                                        | `set_nft_contract` while seats exist.                            |
| `the cooldown must be positive` / `an account must be allowed at least one seat`                                                                             | Bad settings.                                                    |
| `Requires attached deposit of exactly 1 yoctoNEAR`                                                                                                           | `claim` or `unstake` without the 1 yocto.                        |
| `attach at least 100 TGas to upgrade`                                                                                                                        | `upgrade` with less gas than the deploy and migrate need.        |
| `no code is staged under that hash`                                                                                                                          | `upgrade` for a hash nobody staged, or one already used.         |
| `attach at least <amount> to pay for the storage` / `the wasm goes in the call input`                                                                        | `stage_code` with too little deposit or no input.                |
| `prove the upgrade path before deleting keys`                                                                                                                | `seal` before an upgrade has gone through `migrate`.             |
| `migrate expects version 1`                                                                                                                                  | `migrate` found state written by another version.                |
| `migrate runs only inside an upgrade`                                                                                                                        | `migrate` called without `upgrade` having sent the batch.        |
| `Method <name> is private`                                                                                                                                   | A callback called from outside.                                  |

---

## Gas

| Step                                | Gas                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A jury draw                         | About 190 to 210 TGas at the 1,000 seat cap (reserved by the oracle at 250)                                                                                            |
| `unlock_case` for a 21 juror case   | At most about 8.9 TGas when every juror forfeits                                                                                                                       |
| A `claim`                           | Must attach at least 33 TGas: 15 for the verifier's `mt_transfer`, 10 for its callback and 8 for the call itself (about 2.6 burned in the Council, 3.8 in the verifier; 29 was the least that worked with the token) |
| An `unstake`                        | Must attach at least 58 TGas: 15 for the verifier's `mt_transfer`, 35 for the callback that returns the NFT and 8 for the call itself (about 3.1 burned; 55 was the least that worked) |
| Each verifier or NFT transfer reserved | 15 TGas; callbacks 10 TGas; the unstake payout callback 35 TGas                                                                                                     |
| Revenue receipt `mt_on_transfer`    | Burns about 1.6 TGas. The verifier gives the receiver what is attached to its `mt_transfer_call` less about 20.5 TGas, and the Council took revenue with 22 attached. Market attaches 42. |
| `allow_tokens`                      | 13 TGas for 100 ids of 63 bytes                                                                                                                                        |
| `migrate` in the upgrade batch      | 30 TGas reserved (the batch of deploy and migrate burned 17 for a 249 KB build)                                                                                        |
| `upgrade`                           | At least 100 TGas attached; 30 burned in all for a 249 KB build                                                                                                        |

---

## Security properties checked by tests

Every restricted method refuses a stranger and every callback refuses a direct call; a stranger
cannot initialise a deployed council; with the allowlist on, only named tokens and plain numbers
inside the range stake, and `007` and `+7` do not; names and a range made for one collection allow
nothing in the next; a hand-called `migrate` is refused; `unstake` and `claim` refuse less than
their gas floors; `total_received` counts every revenue arrival and no forfeit; a fake NFT
collection cannot stake seats and a call to `nft_on_transfer` made directly is refused; a fake token
cannot add revenue, whether it arrives through the verifier or is called directly; a seat staked by an approved relayer belongs to its real owner; two claims or
two unstakes sent at once pay once; a failed NFT return restores the seat; a seat that asked to
leave is never drawn; a serving seat cannot leave or claim; a silent juror forfeits exactly what the
seat earned while serving and a juror who voted keeps everything; the draw depends only on the block
seed, the seat set and the case key; a seat staked one block before a large arrival earns about one
block of 30 days; equal time staked earns equally whatever the arrival time; a dust arrival cannot
slow a stream; a seat's earnings match an exact model of the stream over random sequences of
staking, claiming and time passing; and, over 60 random sequences of stakes, revenue, time, draws,
forfeits and claims, no unit of revenue is created or lost beyond dust.

A stranger cannot upgrade or seal, an unknown hash and too little gas or deposit are refused, `seal`
waits for `upgrade_proven`, `migrate` refuses another state version, and the seats survive an
upgrade unchanged. See `AUDIT.md`.

---

## Things to know

| Topic                                          | Detail                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legal                                          | Seats that earn a share of platform revenue are the shape most securities law treats as an investment. Nothing is minted or sold, and selling seats needs counsel first. The revenue share and juror pay are kept separate.                                                                 |
| The seat cap number is not chosen              | The tests use small values. A real deployment needs a number.                                                                                                                                                                                                                               |
| Revenue takes 30 days to arrive                | A seat that leaves takes only what it has earned so far. The rest stays in the stream for the seats that are staked. A holder who stakes for a day gets a day's share.                                                                                                                      |
| More than 1,000 seats                          | The draw reads every seat, so a bigger collection needs a different draw. Not built; it depends on the planned collection size.                                                                                                                                                             |
| The seat cap limits revenue concentration only | A jury is made of distinct accounts, so the best setup for an attacker is one seat in each of many wallets, and a per-account cap does nothing against that. An account is not a person. Identity checks or a buyer cap at sale time are needed. `spec.md` section 9 says the same.         |
| Unstaked NFTs earn nothing                     | Only staked seats earn and can be drawn.                                                                                                                                                                                                                                                    |
| Keys                                           | Until `seal` has run, the deploy key can replace this code outside every vote. After it, only an owner upgrade can. A sealed contract with a broken upgrade path cannot be fixed, so prove one upgrade first.                                                                           |
| No outside audit                               | The only review is the self-review in `AUDIT.md`.                                                                                                                                                                                                                                           |
