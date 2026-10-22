# oracle

Status, 2026-10-21, Intents migration phase I3: dispute bonds and juror pay are held in the oracle's own account
inside the [NEAR Intents](../intents-architecture.md) verifier. Bonds arrive through the verifier's
`mt_transfer_call` and leave through its `mt_transfer`. The oracle holds no token of its own and never calls a
NEP-141 contract. The owner is an account id, the DAO (Trezu and SputnikDAO), and the DAO's voting period is the
only delay: nothing in this contract waits between an approval and its execution. Bonds and juror pay stay
separate from the 75% treasury and 25% holder-reward split of platform fees, which the market sends and the
Council holds.

Source: `oracle/src/lib.rs`, with the shared upgrade helpers in `upgrade/src/lib.rs`. Written 2026-10-18 from the
code as it stood, upgrade path and owner settings added 2026-10-19, the no-decision recipient, the deadline
refusal and the upgrade mark added 2026-10-20, the Intents money path added 2026-10-21. For current behaviour,
follow the code. For required behaviour, follow the accepted spec.

---

## Requirements met and not built

See [requirements R-04, R-06, R-07 and R-08](../spec.md#requirements-to-implementation-map).

| Requirement | State |
| --- | --- |
| R-04, the propose, challenge, jury, commit and reveal rules | Unchanged by the migration and still tested |
| R-06, bonds and juror pay settle separately from holder revenue, inside Intents | Built. Bonds arrive by `mt_on_transfer` and are paid by `mt_transfer` from the oracle's own Intents account. A source guard fails if the oracle code names holder revenue |
| R-07, the owner is a DAO account | The owner is an `AccountId` and no custom governance exists. No test runs a real SputnikDAO |
| R-08, views for the website and keeper | `total_owed` is built. A case list, bond totals and a pending payout view are not |

Specified in [the oracle spec](specs/oracle.md) and not built: `payout_bond(account)`, which would let a keeper pay a
DAO recipient without a proposal, `list_cases`, `bond_totals`, and a `bond_received` event.

---

## Contents

1. [What it is](#what-it-is)
2. [Where it sits among the other contracts](#where-it-sits-among-the-other-contracts)
3. [Roles: who can do what](#roles-who-can-do-what)
4. [Starting it up: `new`](#starting-it-up-new)
5. [Units and conventions](#units-and-conventions)
6. [The life of a case](#the-life-of-a-case)
7. [Who gets paid what](#who-gets-paid-what)
8. [Writing the answer to the market, and releasing the jury](#writing-the-answer-to-the-market-and-releasing-the-jury)
9. [The minimum gap](#the-minimum-gap)
10. [Price markets and signed prices](#price-markets-and-signed-prices)
11. [Messages: how bonds arrive](#messages-how-bonds-arrive)
12. [Every method](#every-method)
13. [The owner's settings](#the-owners-settings)
14. [Upgrading this contract](#upgrading-this-contract)
15. [Views](#views)
16. [Events](#events)
17. [What can go wrong, and the message you will see](#what-can-go-wrong-and-the-message-you-will-see)
18. [Gas](#gas)
19. [Security properties checked by tests](#security-properties-checked-by-tests)
20. [Things to know](#things-to-know)

---

## What it is

oracle decides how markets end. It is an optimistic oracle: someone proposes an answer and puts up a
bond, and unless someone challenges it within a time window, the answer stands. If someone does
challenge, they name the answer they say is right, and a jury of NFT holders votes in secret, then
reveals, and a majority decides between the two answers. If that jury does not decide in time, one
larger jury of other accounts is drawn, and if that one does not decide either, the challenger loses
half their bond. The final answer is written to market, which trusts only this contract for
outcomes.

It handles two kinds of market:

| Kind                        | How it is answered                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Event market (most markets) | Someone proposes Yes, No or Void with a link to evidence, and puts up a bond.                                                                                                                                            |
| Price market                | Someone submits a price that enough independent publishers have signed. The contract checks the signatures, works out Yes or No from the price, and the answer goes through the same bond, window and jury as any other. |

It also holds the bonds, and pays them out, together with the jurors' pay, when a case ends.

---

## Where it sits among the other contracts

| Contract                                     | Relationship to oracle                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| market                                       | Registers each new market here, and receives the final outcome from here. Only market may register markets.                        |
| council                                      | Supplies the jury. oracle asks it to draw jurors from staked NFT seats, and tells it to release them and which jurors never voted. |
| The owner (the DAO)                          | An account id, normally a SputnikDAO. Its voting period is the only delay before a setting or an upgrade takes effect.   |
| The Intents verifier                         | Holds every bond in this contract's own Intents account. Calls `mt_on_transfer` to deliver a bond and pays one out when this contract calls its `mt_transfer`. The collateral is one token id, the one the market uses (in tests `mock-ft`). |

---

## Roles: who can do what

| Role            | Set by                                         | Can do                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner           | `new`, then `propose_owner` and `accept_owner` | `set_jury_size`, `set_bond`, `set_window_ms`, `set_panel_deadline_ms`, `set_min_proposal_ms`, `set_draw_window_ms`, `set_draw_delay_blocks`, `set_operator`, `set_no_decision_recipient`, `add_publisher`, `set_price_threshold`, `propose_owner`, `upgrade`, `seal`, and everything the operator can do. Normally the DAO. |
| Operator        | `new`, then `set_operator` (owner only)        | Only `remove_publisher`. It exists so a leaked price-signing key can be cut off in one call instead of waiting out a vote.                                                                                                                                                                                                                  |
| Market contract | `new` (fixed)                                  | Only `register_market`.                                                                                                                                                                                                                                                                                                                     |
| Verifier        | `new` (fixed)                                  | Only `mt_on_transfer`, which is how bonds arrive.                                                                                                                                                                                                                                                                                           |
| Jurors          | Drawn per case by council                      | `commit_vote` and `reveal_vote` on the case they were drawn for.                                                                                                                                                                                                                                                                            |
| Anyone          | n/a                                            | Propose, challenge and answer prices (by sending a bond), `resolve_draw`, `finalize`, `resolve_by_deadline`, `retry_apply`, `retry_unlock`, `withdraw_bond` (their own), `stage_code` (paying for the storage), and every view.                                                                                                             |

---

## Starting it up: `new`

Called once, at deploy. It cannot be called again. Only the contract's own account can call it:
`new` is `#[private]`, so a deploy and init batch signed by that account is the one way in, and
anyone else gets `Method new is private`.

| Argument                | Meaning                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner_id`              | The owner, normally the DAO account.                                                                                                                                                                                                                                                                     |
| `market_contract`       | The market contract.                                                                                                                                                                                                                                                                                     |
| `verifier_id`           | The Intents verifier account. Only it may deliver a bond, and every bond and payout is held there.                                                                                                                                                                                                       |
| `collateral_token_id`   | The exact id of the collateral in the verifier, `nep141:<token contract>`. A value that does not start with `nep141:` is refused, because no other form has a balance. USDC on mainnet is `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`. |
| `bond`                  | The bond amount, in collateral units (six decimals for USDC). Every proposal and price submission must send exactly the current bond, and a challenge must send the bond its case was proposed with. Must be above zero.                                                                                                          |
| `window_ms`             | How long the challenge window lasts after a proposal, in milliseconds.                                                                                                                                                                                                                                   |
| `panel_deadline_ms`     | How long a jury has once it is seated, in milliseconds. The first half is for committing votes, the second half for revealing them.                                                                                                                                                                      |
| `draw_window_ms`        | How long after a challenge, or after a jury fails to decide, a jury can still be drawn, in milliseconds. Must be above zero.                                                                                                                                                                             |
| `council`               | The council contract.                                                                                                                                                                                                                                                                                    |
| `jury_size`             | How many jurors, odd, at most 21.                                                                                                                                                                                                                                                                        |
| `draw_delay_blocks`     | How many blocks must pass after a challenge before the jury can be drawn.                                                                                                                                                                                                                                |
| `min_proposal_ms`       | The least time a market must leave, after it closes, for someone to notice and propose, on top of the time a case needs.                                                                                                                                                                                 |
| `operator_id`           | The operator.                                                                                                                                                                                                                                                                                            |
| `network`               | A word naming the network, such as `mainnet`. Signed into every price so a testnet signature is useless on mainnet. Must not be empty or contain a colon.                                                                                                                                                |
| `price_threshold`       | How many publishers must sign the same price. At least 1.                                                                                                                                                                                                                                                |
| `no_decision_recipient` | The account credited with the challenger's half bond when neither jury decided and no juror revealed. Normally the Trezu treasury, which can differ from the owner. The owner changes it with `set_no_decision_recipient`. It needs no registration anywhere: its share is paid into its own Intents account when it calls `withdraw_bond`. |

The bond, the windows and the draw delay are set here and changed later by the owner (see "The
owner's settings"). The tests use a 60 second window, a 60 second draw window and a 120 second
panel; the design proposes 2 hours, 2 hours and 48 hours for mainnet.

---

## Units and conventions

| Thing                    | Convention                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Times                    | Nanoseconds since the Unix epoch in views and the case record. Settings are given in milliseconds at deploy and stored in nanoseconds. |
| Big numbers in JSON      | `U64` and `U128` travel as strings.                                                                                                    |
| Outcomes                 | The words `yes`, `no` or `void`.                                                                                                       |
| Prices in a price market | Integers scaled by 10 to the power `decimals`, as set in the market's price rule.                                                      |

---

## The life of a case

A case exists for a market once someone has proposed an answer. A market gets at most one case,
ever.

```
(nothing) --propose or price--> Proposed --window ends, finalize--> Final
                                   |
                                   +--challenge--> Disputed, round 0 --majority reveals--> Final
                                                      |
                                                      +--round over, finalize--> Disputed, round 1 --majority reveals--> Final
                                                                                      |
                                                                                      +--round over, finalize--> Final (no decision)
```

Stages are `proposed`, `disputed` and `final`. A disputed case has a `round`, 0 for the first jury
and 1 for the second.

### 1. A market is registered

When market creates a market it calls `register_market` here. The oracle stores the challenge
window, the panel deadline and the draw window in force at that moment with the market, and every
case of that market runs on those, whatever the settings become later. The oracle refuses a market
if there is not enough room between close and the answer deadline for a case to finish (see "The
minimum gap"), and refuses a price market until enough publishers exist. A refused registration
leaves the market unable to trade.

### 2. Someone proposes

After the market closes, anyone can move exactly the bond from their own Intents balance to this contract
with the verifier's `mt_transfer_call` and a message naming the answer (see "Messages"). The case opens as
`proposed` and the challenge window starts.

A proposal is refused unless: it carries exactly the current bond; the market is registered and has
closed; the evidence text is at most 512 bytes; there is still time for a full challenge window, two
jury rounds (each a draw window and a full panel deadline) and a 30 second buffer before the
market's `resolve_by`; and no answer was proposed before. If any rule fails the verifier
returns the whole bond to the sender's Intents balance.

### 3. Nobody challenges

Once the window has passed, anyone calls `finalize`. The proposal becomes final, the proposer's bond
goes back to them to withdraw, and the answer is written to market.

### 4. Someone challenges

Within the window, a different account moves exactly the bond to this contract through the verifier with the
message `challenge:<market>:<yes|no|void>`. The answer must differ from the proposed one, so a challenge
always names a second answer. The case becomes `disputed` in round 0. It records the challenger's
answer, the jury size as the setting is at that moment, the last moment a jury can be drawn
(`draw_by`, the challenge time plus the draw window), and the block height from which a jury may be
drawn (the challenge height plus `draw_delay_blocks`). The proposer cannot challenge their own
answer. The jurors' clock has not started: `commit_ends_at` and `panel_deadline` are 0 until a jury
is seated.

### 5. The jury is drawn

Anyone calls `resolve_draw(market_id)` once the draw height has passed and up to and including
`draw_by`. The oracle passes the case's key, the jury size stored on the case, and the accounts to
leave out (the proposer and the challenger, and in round 1 the first jury as well) to council, which
picks the jurors with the block seed of its own receipt. No seed is passed. When council answers,
`on_drawn` records the jury on the case, but only if the case is still disputed in the same round,
still has no jury, and the jury has exactly the size stored on the case and no repeated account. The
size is the one the case was challenged with, so a later `set_jury_size` cannot strand an open case.
If anything is off it logs `draw_failed` and the draw can be retried. Two draws in flight at once
end with one jury, because the first to land wins.

When the jury is recorded, its clock starts: `commit_ends_at` is half the panel deadline from that
moment and `panel_deadline` the full panel deadline. A jury drawn at the last allowed moment
therefore still has all its time, and no juror is blamed for time they never had.

The seed is the council's, so nobody knows the jury when they challenge or when they send
`resolve_draw`. A block producer can still see the seed before it is public and could choose not to
include an unfavourable draw; the delay narrows this and does not remove it.

A case nobody draws a jury for by `draw_by` has not been decided: see step 8. A keeper (see
`keeper/keeper.mjs`) exists to make these calls on time.

### 6. Jurors commit, then reveal

In the first half of its panel deadline, each juror on the panel calls
`commit_vote(market_id, commitment)` once, with 1 yoctoNEAR attached. The commitment is the
64-character lowercase hex of SHA-256 over the text `<juror account>:<yes|no|void>:<salt>`.
Including the juror's own account means a copied commitment cannot be revealed by anyone else.

In the second half, each juror who committed calls `reveal_vote(market_id, outcome, salt, reason)`,
also with 1 yoctoNEAR. The contract checks the vote and salt hash to the juror's commitment. A
reason is required (at most 1,000 bytes) and the salt can be at most 64 bytes. The reveal is public,
with its reason. The vote must be for the proposed answer or for the challenger's answer: a vote for
the third outcome is refused, so a juror must commit only to one of the two. Only a juror of the
jury that is currently sitting can reveal, so a juror of a replaced first jury cannot reveal during
the second round.

The moment either answer has votes from a majority of the sitting jury (more than half), the case
settles at once, without waiting for the rest. With an odd jury and every juror voting, one of the
two answers always has a majority.

Important for juror software: the contract never checks how strong a salt is. Because there are only
two outcomes a juror may choose, a guessable salt such as `s` lets anyone work out the vote from the
public commitment, and a copier can then commit the same vote under their own name. The voting
client must generate a random salt of at least 128 bits.

### 7. The jury does not decide

If a round is over with no majority (its panel deadline has passed, or no jury was seated by
`draw_by`), anyone calls `finalize`. For the first round that calls for one second jury: its size is
twice the first size plus one, at most 21, it excludes the first jury, the proposer and the
challenger, and it gets a fresh draw window and fresh clocks. The first jury's seats stay held until
the case is final. The case moves to round 1 once, and only once.

If the second round also ends with no majority, or the first round ends too late for a second to
finish before the market's `resolve_by` (the oracle checks that a draw window, a panel deadline and
the 30 second buffer still fit), the case settles with no decision.

### 8. No decision

A case in which no jury was ever seated, because the draw failed or never ran in both rounds, settles as `no_jury`.
It resolves like a no decision, but each party gets their own bond back and nobody else is paid: a draw that
cannot happen is the system failing, not the challenger losing. A jury that was seated and never revealed is
not this case: the case keeps a `seated` flag, set when any round seats a jury, and a seated case settles as
below.

A case that settles with no decision resolves a price market to the answer its publishers signed,
and an event market to Void. The bonds are paid as in "Who gets paid what": the proposer gets their
bond back, and half the challenger's bond goes to the jurors who revealed, in either round, split
equally, and half to the proposer. With no juror having revealed, the jurors' half goes to the
no-decision recipient, set in `new` and changed by the owner. The owner is never paid. A recipient that is a
DAO collects with a proposal that calls `withdraw_bond` with 1 yocto and at least 33 TGas.

### 9. Settling

Whenever a case settles, in this order: the stage becomes final, who is delinquent is worked out,
bonds are allocated, an event is logged, the outcome is sent to market, and for a disputed case
council is told to release the jury, or both juries if there was a second round.

---

## Who gets paid what

Let B be the bond.

| Case ends as                                                                                       | Proposer                              | Challenger                 | Jurors                                            | No-decision recipient |
| -------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------- | ------------------------------------------------- | --------- |
| Unchallenged and final                                                                             | B back                                | n/a                        | n/a                                               | n/a       |
| Disputed, a majority decided, the proposal was upheld (the jury's outcome equals the proposed one) | 2B minus the jurors' share            | nothing                    | The jurors' share                                 | nothing   |
| Disputed, a majority decided, the proposal was rejected (the challenger's answer won)              | nothing                               | 2B minus the jurors' share | The jurors' share                                 | nothing   |
| Disputed, neither jury decided, some juror revealed                                                | B back, plus half of B, plus rounding | nothing                    | Half of B, split equally among those who revealed | nothing   |
| Disputed, neither jury decided, no juror revealed                                                  | B back, plus half of B                | nothing                    | n/a                                               | Half of B |
| Disputed, no jury could be drawn in either round (`no_jury`)                                       | B back                                | B back                     | n/a                                               | nothing   |

In a decided dispute the jurors' share is 25% of one bond, split equally among the jurors who
revealed and sat with the final outcome, in either round. It is rounded down per juror and the
winner keeps the remainder, so exactly two bonds are paid out. A juror who revealed with the
minority, or did not reveal, gets nothing.

When nobody decided, the challenger's half-bond split among the jurors who revealed is rounded down
per juror and the proposer keeps the remainder. All jurors of both rounds who revealed share it,
whichever answer they voted for, because they all did the work. The no-decision recipient holds the
jurors' half when no one revealed so that it leaves the two parties whatever the juries do: two
accounts that propose and challenge each other to stall a market end down by at least the jurors'
share, a quarter of a bond when a jury decides and half a bond when none does.

Money is credited to a per-account balance (`claimable_of`) and taken out with `withdraw_bond`. It
stays in the oracle's own Intents account until then. `withdraw_bond` zeroes the caller's balance,
then has the oracle send an `mt_transfer` of 1 yocto through the verifier to the caller's own Intents
account. The account is always the one that owns the claim: nobody can name another receiver. If the
verifier refuses (its pause or an account lock), the callback gives the balance back and logs
`bond_payout_failed`. The receiver needs no registration anywhere.

Two behaviours worth knowing. If a proposer proposes Void and nobody decides, the case resolves
Void, which is the answer they proposed, but they do not win both bonds: the jurors' half still
leaves them. And when a jury decides Void by majority over a proposed Yes or No, the proposer loses
their bond like any other rejected answer, so honest Void votes are paid like any other, provided
the challenger named Void.

### Who is delinquent

A drawn juror is delinquent if they never voted. For the first jury once a second one has been
called for, that is everyone who never revealed, because its time is over. For the sitting jury it
means: they never committed, or, once the reveal window is over, they committed and never revealed.
A juror who committed but had no chance to reveal because a majority settled the case early is not
delinquent. The list covers both rounds, is stored on the case and sent to council, which takes from
each delinquent juror's seat the revenue it earned while serving. See `council.md`.

---

## Writing the answer to the market, and releasing the jury

Both happen in calls after the case is settled, and both can fail without losing the result:

| Step                            | Call                                                                                                                                                         | If it fails                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The market receives the outcome | `apply` sends `set_outcome` to market. `on_applied` marks the case `applied`.                                                                                | Anyone can call `retry_apply(market_id)`.                                                                                                                    |
| The juries are released         | `unlock_case` is sent to council with the delinquent list, once for the first jury and, after a second round, once more for the second, one after the other. | Anyone can call `retry_unlock(market_id)`, which uses whatever gas the caller attaches, refuses less than 35 TGas, and sends both. Repeating it is harmless. |

A draw that is in flight when its round ends can land after the oracle has released the jury, and
then its seats stay held. `retry_unlock` releases them, and the keeper checks for this.

### The deadline answer

If nothing has resolved a market by its `resolve_by`, anyone calls `resolve_by_deadline(market_id)`
on this contract. It settles whatever is settleable: an unchallenged proposal whose window ended, a
dispute whose round is over (settled with no decision, with no second round because there is no time
left), or a final answer that was never applied, which it sends again. If there is no case, it tells
the market to resolve Void. If there is a case that still has time, a proposal whose window is open
or a jury still inside its deadline, it refuses
(`the case still has time; finalize it when its round is over`) instead of voiding the market under
it.

The timing rules leave no such case at `resolve_by`: a proposal must fit the window, two rounds and
a 30 second buffer before it, and a second round only starts if it fits. A randomized test over
windows, proposal times, challenge times, seating times (up to 10 seconds after the last allowed
block) and finalize times checks that no registered market reaches `resolve_by` with a case that is
not settleable. The market's own `void_if_unresolved` is only for an oracle that is gone: it stays
shut for 7 days after `resolve_by`. This closes the race where a permissionless void landed on a
market whose proposal was a moment from final.

---

## The minimum gap

When a market is registered, the oracle requires `resolve_by` to be at least this far after the
moment the answer is first possible:

`min_proposal + challenge window + 2 x (draw window + panel deadline) + 30 seconds`

For an event market the moment is `close_at`. For a price market it is the observation time. The 2
counts both jury rounds, each with its own draw window. Markets with less room are refused, because
no case could ever finish in them and the only ending would be a Void at the deadline. `config()`
shows the figure as `min_resolve_gap_ns`. The proposal guard uses the market's own stored windows
from the moment of the proposal, so a market always has time for the longest case, even after the
owner has lengthened the settings. `min_resolve_gap_ns` in `config()` is the figure for markets
registered now.

---

## Price markets and signed prices

A price market carries a price rule (observation time, strike, decimals, direction), set by market
and locked into the market's rule hash. Here is how its answer is produced.

1. At or after the observation time, anyone can submit a price with the verifier's `mt_transfer_call`
   (message below) and the usual bond.
2. The contract rebuilds what a publisher would have signed: the text
   `price:v1:<this contract>:<network>:<market id>:<observation time>:<price>:<decimals>`.
   Everything except the price is fixed by the market and the deployment, so one signature is good
   for one price of one market on one network and one contract. It cannot be replayed on another
   market, network or contract, and a signature for a different moment is useless.
3. It checks each listed signature with ed25519 against the configured publisher keys. A malformed
   entry, a key that is not a publisher, a repeated key, or a signature that fails makes the whole
   submission fail and the bond come back.
4. At least `price_threshold` different publishers must have signed. One leaked key alone cannot set
   a price.
5. The answer is Yes if the price is at or above the strike (when the rule's direction is "above")
   and No otherwise, or the reverse for "below".
6. The case then opens exactly as for any proposal, with evidence reading
   `signed price <price> by <n> publishers`, and the `proposed` event carries `signers`, the public
   keys of the publishers whose signatures counted, in the order they were submitted, so the record
   shows who signed without anyone reading the transaction. A proposal that is not a price answer
   logs an empty `signers`. The submitter's bond is the proposer's bond. It can be challenged and go
   to a jury like any other, which is the backstop if enough publishers signed a wrong price.

There is no staleness limit: each signature covers one observation time, so a publisher that was
down at that moment can sign the price later. A plain `propose` is refused on a price market, so the
signatures cannot be skipped.

Anyone holding a valid signed price can submit it first and take the proposer's place, and with it
the winner's share if the price is later challenged and upheld, so the party that submits prices
should do so promptly.

### Managing publishers

| Method                           | Who               | Notes                                                                            |
| -------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `add_publisher(key)`             | Owner             | An ed25519 public key in NEAR format (`ed25519:...`). At most 10. No duplicates. |
| `remove_publisher(key)`          | Operator or owner | Immediate. Refused if it would leave fewer publishers than `price_threshold`.    |
| `set_price_threshold(threshold)` | Owner             | Between 1 and the number of publishers.                                          |

Adding a key or changing the threshold grants or changes power over prices, so it is the owner's.
Removing a key only takes power away, so the faster operator may do it.

A submission with all 10 signing burned about 4.5 TGas here (9.4 in all) and worked with 30 TGas
attached to a direct call. Through the verifier, which keeps about 21 TGas of what is attached, a wallet's
100 TGas leaves the oracle's receipt about 79.

The off-chain publisher service that reads exchange prices and signs them is not built; until it
exists price markets can be created and answered by hand, but nothing produces the signatures.

---

## Messages: how bonds arrive

Everything that needs a bond is a `mt_transfer_call` on the verifier, sent by the person who holds the money, with
this contract as the receiver, exactly `bond` units of the collateral token id and 1 yocto attached. The verifier
moves the amount from the sender's Intents balance to this contract's and then calls `mt_on_transfer`. The `msg`
says what to do. The hook runs these checks in this order, and any failure panics, which makes the verifier return
the whole amount to the sender:

| Check | Refusal |
| --- | --- |
| The caller is the verifier this contract was started with | `only the verifier can deliver money` |
| One token id and one amount | `exactly one token and amount` |
| The token id is the configured collateral id | `wrong token` |
| `previous_owner_ids` is exactly the sender, so the money was the sender's own | `the money must come from the sender's own balance` |
| The amount is above zero | `amount must be positive` |
| The amount is the bond (the case's own bond for a challenge) | `send exactly the bond` |

The sender the hook credits is the one the verifier reports, so a bond can only be posted from the account that owns
the money. The hook answers `["0"]`, which keeps the whole amount. A plain deposit never reaches the hook, in any
message form: the verifier credits the oracle's account and tells nobody, so that money is surplus no one is
credited for (see "Things to know"). A direct NEP-141 transfer to this contract bounces, because it has no
`ft_on_transfer`.

| `msg`                                                            | What it does                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `propose:<market>:<yes\|no\|void>:<evidence>`                    | Proposes an answer for an event market. The evidence is free text, normally a link, up to 512 bytes. It may contain colons. |
| `challenge:<market>:<yes\|no\|void>`                             | Challenges the open proposal, naming the answer the challenger says is right. It must differ from the proposed answer.      |
| `price:<market>:<price>:<key>.<signature>,<key>.<signature>,...` | Answers a price market. Each entry is a publisher key in `ed25519:...` form, a dot, and the 128-character hex signature.    |

---

## Every method

| Method                                                                                | Who                                  | What it does                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new(...)`                                                                            | Deployer, once                       | Initialises.                                                                                                                                                                                                                                                                                      |
| `propose_owner(new_owner)`                                                            | Owner                                | Starts a handover.                                                                                                                                                                                                                                                                                |
| `accept_owner()`                                                                      | The proposed account                 | Completes it. Two steps so a typo cannot lock the contract.                                                                                                                                                                                                                                       |
| `set_jury_size(jury_size)`                                                            | Owner                                | Odd, at most 21. Applies to juries drawn afterwards. A draw already in flight when it changes will fail the size check and can be retried. Logs no event.                                                                                                                                         |
| `set_bond(bond)`                                                                      | Owner                                | Above zero. Applies to cases proposed afterwards.                                                                                                                                                                                                                                                 |
| `set_window_ms`, `set_panel_deadline_ms`, `set_draw_window_ms`, `set_min_proposal_ms` | Owner                                | Each above zero. Apply to markets registered afterwards.                                                                                                                                                                                                                                          |
| `set_draw_delay_blocks(blocks)`                                                       | Owner                                | Applies to challenges and second rounds from now on. Zero is allowed, as in `new`.                                                                                                                                                                                                                |
| `stage_code()` (payable)                                                              | Anyone                               | The call input is a wasm. It is stored under its own sha256, which is returned. The deposit pays for the storage (1 NEAR per 100 KB) and the surplus is refunded. Attach 100 TGas, because 250 KB burns about 31.                                                                                 |
| `upgrade(code_hash)`                                                                  | Owner                                | Deploys the staged wasm with that sha256 and runs its `migrate`, in one batch. Needs at least 100 TGas attached.                                                                                                                                                                                  |
| `migrate()`                                                                           | The contract itself                  | Runs in the new code in the same batch as the deploy. Refuses unless `upgrade` marked the upgrade in flight. Reads the state as the one layout it knows, clears the mark, sets `upgrade_proven`, returns the state.                                                                               |
| `seal(public_key)`                                                                    | Owner                                | Deletes that access key from this account. Refused until an upgrade has gone through `migrate`.                                                                                                                                                                                                   |
| `set_operator(operator_id)`                                                           | Owner                                | Replaces the operator.                                                                                                                                                                                                                                                                            |
| `add_publisher(key)`                                                                  | Owner                                | See above.                                                                                                                                                                                                                                                                                        |
| `remove_publisher(key)`                                                               | Operator or owner                    | See above.                                                                                                                                                                                                                                                                                        |
| `set_price_threshold(threshold)`                                                      | Owner                                | See above.                                                                                                                                                                                                                                                                                        |
| `register_market(market_id, close_at, resolve_by, rule_hash, price_rule)`             | Market contract only                 | Records a market. Calling it twice for the same market changes nothing.                                                                                                                                                                                                                           |
| `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)`               | The verifier only                    | Receives bonds. Checks as in "Messages", answers `["0"]`.                                                                                                                                                                                                                                         |
| `resolve_draw(market_id)`                                                             | Anyone                               | Asks council to draw the jury for the case's current round. Needs the case disputed, no jury yet, the draw height reached, and the time not past `draw_by`. Reserves 250 TGas for the draw, so it refuses less than 275 TGas (`attach at least 275 TGas: the jury draw reads every staked seat`). |
| `commit_vote(market_id, commitment)` (payable, 1 yocto)                               | A juror on that case                 | Commits a hidden vote, once, during the commit phase.                                                                                                                                                                                                                                             |
| `reveal_vote(market_id, outcome, salt, reason)` (payable, 1 yocto)                    | A juror who committed                | Reveals the vote during the reveal phase, for the proposed answer or the challenger's. May settle the case, so it refuses less than 80 TGas at the top, even for a reveal that will not settle.                                                                                                   |
| `finalize(market_id)`                                                                 | Anyone                               | Settles an unchallenged proposal after its window. For a disputed case whose round is over, calls for the second jury, or settles with no decision. Refuses less than 80 TGas.                                                                                                                    |
| `resolve_by_deadline(market_id)`                                                      | Anyone, once `resolve_by` has passed | Settles whatever is settleable, or has the market resolve Void when there is no case. Refuses a case that still has time. Refuses less than 80 TGas.                                                                                                                                              |
| `retry_apply(market_id)`                                                              | Anyone                               | Sends the final outcome to the market again.                                                                                                                                                                                                                                                      |
| `retry_unlock(market_id)`                                                             | Anyone                               | Tells council to release the juries again. Refuses less than 35 TGas.                                                                                                                                                                                                                             |
| `withdraw_bond()` (payable, 1 yocto)                                                  | Anyone, for their own balance        | Sends the caller's whole claimable balance to the caller's own Intents account by `mt_transfer`. Refuses less than 33 TGas.                                                                                                                                                                       |
| `on_drawn`, `on_applied`, `on_bond_withdrawn`                                         | The contract itself                  | Callbacks.                                                                                                                                                                                                                                                                                        |

---

## The owner's settings

Six settings can be changed by the owner, which in a real deployment means a DAO proposal. Its voting period is the
only delay. Each has the same check as `new` (above zero) and each logs an event. A seventh,
`set_no_decision_recipient(recipient)`, takes an account, applies to cases that settle from then on,
and logs `no_decision_recipient_set`.

| Setting               | Method                                     | Event                | Reaches                                                                                                                                        |
| --------------------- | ------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Bond                  | `set_bond(bond)`                           | `bond_set`           | Cases proposed afterwards. A case keeps the bond it was proposed with: the challenge must send that amount, and the case pays that amount out. |
| Challenge window      | `set_window_ms(window_ms)`                 | `window_set`         | Markets registered afterwards.                                                                                                                 |
| Panel deadline        | `set_panel_deadline_ms(panel_deadline_ms)` | `panel_deadline_set` | Markets registered afterwards.                                                                                                                 |
| Draw window           | `set_draw_window_ms(draw_window_ms)`       | `draw_window_set`    | Markets registered afterwards.                                                                                                                 |
| Minimum proposal time | `set_min_proposal_ms(min_proposal_ms)`     | `min_proposal_set`   | Markets registered afterwards. It only counts at registration.                                                                                 |
| Draw delay            | `set_draw_delay_blocks(draw_delay_blocks)` | `draw_delay_set`     | Challenges and second rounds from now on.                                                                                                      |

A market keeps the windows it was registered with. They are stored in its registration record
(`get_market_info` shows `window_ns`, `panel_deadline_ns` and `draw_window_ns`), and the minimum gap
check at registration, the proposal guard, the challenge window, every `draw_by` and every jury
deadline of that market use them. So a longer setting cannot make a registered market unanswerable,
and a shorter one does not hurry a market that was given more time. The draw delay is the one
setting that is not stored per market, and it has no upper bound, as in `new`: a very large value
would make every jury draw impossible before its `draw_by`, and the case would end with no decision.
The owner should not set it near the draw window.

---

## Upgrading this contract

No access key can replace this code outside a vote, and no deleted key can freeze it. The owner
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
layout from bytes.

A version 2 build keeps the version 1 struct as `StateV1`, reads that, builds its state and writes
`state_version: 2`. A new stored field, such as the per-market windows and the per-case bond added
here, is a layout change and so needs a version bump and a `StateV1` once anything is deployed.

Open cases and registered markets are part of the state `migrate` reads, so they survive an upgrade
unchanged. The sandbox test checks that a case is identical before and after. Bonds waiting in
`claimable` stay withdrawable: `withdraw_bond` is not paused by anything in this contract and is not
touched by an upgrade. The upgrade does not move money: the bonds stay in this contract's Intents
account, and the books that describe them (`claimable`, `claimable_total` and `bonds_held`) are part of
the state `migrate` reads.

Measured in the sandbox for a 281 KB build: `upgrade` burns 33 TGas in all, 19 of them the deploy
and migrate batch, and `seal` burns 2. The accepted deployment controls are in
[DEPLOY.md](DEPLOY.md#3-administration-and-upgrades). Trezu/Sputnik execution still needs its own
integration evidence.

---

## Views

| View                         | Returns                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `is_staged(code_hash)`       | Whether a wasm with that sha256 is staged.                                                                                                                                                                                                                                                      |
| `get_case(market_id)`        | The case, or nothing. Fields below.                                                                                                                                                                                                                                                             |
| `get_market_info(market_id)` | What was registered: close, resolve_by, rule hash, price rule, and the three windows the market was registered with.                                                                                                                                                                            |
| `claimable_of(account_id)`   | An account's withdrawable bonds and juror pay.                                                                                                                                                                                                                                                    |
| `total_owed()`               | Everything this contract owes, in collateral units: the bonds sitting in cases that are not final plus everything claimable. At rest it equals `mt_balance_of(this contract, collateral token id)` in the verifier. A payout in flight makes the verifier's figure the larger for a block. A smaller one is an incident. |
| `config()`                   | state version, upgrade proven, upgrade in flight, owner, pending owner, market, verifier, collateral token id, bond, window, panel deadline, draw window, council, jury size, draw delay, minimum proposal time, minimum gap, operator, network, the publisher keys, the threshold, and the no-decision recipient. |

### The case record

| Field                              | Meaning                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage`                            | `proposed`, `disputed` or `final`.                                                                                                                    |
| `proposer`, `proposed`, `evidence` | Who answered, what they said, and their evidence text.                                                                                                |
| `bond`                             | The bond this case was proposed with. A challenge sends exactly this, and the case pays it out.                                                       |
| `window_ends_at`                   | End of the challenge window.                                                                                                                          |
| `challenger`, `challenger_answer`  | The challenging account and the answer they named, if any.                                                                                            |
| `round`                            | 0 for the first jury, 1 for the second.                                                                                                               |
| `jury_size`                        | How many jurors the current round draws. Fixed when the round starts.                                                                                 |
| `challenged_at`                    | When it was challenged.                                                                                                                               |
| `draw_by`                          | The last moment the current round's jury can be drawn.                                                                                                |
| `draw_after_height`                | The block height from which the jury may be drawn.                                                                                                    |
| `commit_ends_at`, `panel_deadline` | The end of the commit phase and the end of the reveal phase of the sitting jury. Both are 0 until a jury is seated, and count from the moment it was. |
| `panel`                            | The sitting jury. Empty until drawn.                                                                                                                  |
| `first_panel`                      | The first jury once a second one has been called for.                                                                                                 |
| `commits`                          | Each committing juror and their commitment.                                                                                                           |
| `votes`                            | Each revealed vote with its reason, from both rounds.                                                                                                 |
| `final_outcome`                    | The result once final.                                                                                                                                |
| `applied`                          | Whether market has received it.                                                                                                                       |
| `delinquent`                       | Jurors of either round who never voted, set when a disputed case settles.                                                                             |

---

## Events

Each logs `EVENT_JSON:` and JSON of the form
`{"standard":"oracle","version":"1.0.0","event":"<name>","data":{...}}`.

| Event                             | When                                                                                            | Data                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `owner_proposed`, `owner_changed` | Handover                                                                                        | owner and proposed, or from and to                                                                                               |
| `operator_set`                    | `set_operator`                                                                                  | operator                                                                                                                         |
| `publisher_added`                 | `add_publisher`                                                                                 | key                                                                                                                              |
| `publisher_removed`               | `remove_publisher`                                                                              | key, by                                                                                                                          |
| `price_threshold_set`             | `set_price_threshold`                                                                           | threshold                                                                                                                        |
| `bond_set`                        | `set_bond`                                                                                      | bond                                                                                                                             |
| `window_set`                      | `set_window_ms`                                                                                 | window_ms                                                                                                                        |
| `panel_deadline_set`              | `set_panel_deadline_ms`                                                                         | panel_deadline_ms                                                                                                                |
| `min_proposal_set`                | `set_min_proposal_ms`                                                                           | min_proposal_ms                                                                                                                  |
| `draw_window_set`                 | `set_draw_window_ms`                                                                            | draw_window_ms                                                                                                                   |
| `draw_delay_set`                  | `set_draw_delay_blocks`                                                                         | draw_delay_blocks                                                                                                                |
| `code_staged`                     | `stage_code`                                                                                    | code_hash, bytes, by                                                                                                             |
| `upgrade_sent`                    | `upgrade`                                                                                       | code_hash                                                                                                                        |
| `migrated`                        | `migrate`, in the new code                                                                      | state_version                                                                                                                    |
| `no_decision_recipient_set`       | `set_no_decision_recipient`                                                                     | recipient                                                                                                                        |
| `seal_sent`                       | `seal`                                                                                          | public_key                                                                                                                       |
| `market_registered`               | `register_market`                                                                               | market_id                                                                                                                        |
| `proposed`                        | A proposal or price                                                                             | market_id, proposer, outcome, evidence, window_ends_at, signers (the verified publisher keys of a price answer, otherwise empty) |
| `challenged`                      | A challenge                                                                                     | market_id, challenger, answer, draw_by                                                                                           |
| `jury_drawn`                      | A jury recorded                                                                                 | market_id, round, panel                                                                                                          |
| `escalated`                       | The first jury did not decide and a second was called for                                       | market_id, jury_size, draw_by                                                                                                    |
| `draw_failed`                     | A draw was refused or failed                                                                    | market_id, round                                                                                                                 |
| `vote_committed`                  | A commitment                                                                                    | market_id, juror, commitment                                                                                                     |
| `vote_revealed`                   | A reveal                                                                                        | market_id, juror, outcome, reason                                                                                                |
| `final`                           | A case settled                                                                                  | market_id, outcome, ruling (`unchallenged`, `decided`, `no_decision` or `no_jury`), juror_pay_each, paid_jurors, delinquent                 |
| `deadline_void`                   | `resolve_by_deadline` had the market resolve Void, which it does only for a market with no case | market_id                                                                                                                        |
| `outcome_applied`                 | The market received the outcome                                                                 | market_id                                                                                                                        |
| `bond_paid`                       | The verifier paid a `withdraw_bond` out, seen by the callback                                    | account, amount                                                                                                                  |
| `bond_payout_failed`              | The verifier refused the payout and the callback gave the balance back                          | account, amount                                                                                                                  |

---

## What can go wrong, and the message you will see

| Message                                                                                                                                                                                                                                             | Cause                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `owner only` / `operator or owner only` / `market contract only` / `not the proposed owner`                                                                                                                                                         | Access refusals.                                                                                                     |
| `only the verifier can deliver money` / `exactly one token and amount` / `wrong token` / `the money must come from the sender's own balance` / `amount must be positive` | A delivery to `mt_on_transfer` that is not one bond of the collateral token from the sender's own balance, or that did not come from the verifier. |
| `send exactly the bond`                                                                                                                                                                                                                             | The wrong amount.                                                                                                    |
| `bad market id` / `bad price` / `unknown action` / `outcome must be yes, no or void`                                                                                                                                                                | A malformed message. A challenge with no answer is one.                                                              |
| `market is not registered`                                                                                                                                                                                                                          | The market was never registered here.                                                                                |
| `the market has not closed yet`                                                                                                                                                                                                                     | A proposal before close.                                                                                             |
| `evidence link is too long`                                                                                                                                                                                                                         | Over 512 bytes.                                                                                                      |
| `too late to propose, the market will be voided at its deadline`                                                                                                                                                                                    | Not enough time left for a full case.                                                                                |
| `an answer was already proposed`                                                                                                                                                                                                                    | A market gets one case.                                                                                              |
| `nothing to challenge` / `the challenge window closed` / `you cannot challenge your own answer` / `a challenge must name a different answer than the proposal`                                                                                      | Bad challenge.                                                                                                       |
| `no case for that market` / `no open dispute`                                                                                                                                                                                                       | There is nothing to act on.                                                                                          |
| `the jury is already drawn` / `too early to draw the jury` / `too late to draw a jury`                                                                                                                                                              | Bad draw timing. Too late means past `draw_by`.                                                                      |
| `not on the panel for this case` / `the commit phase is over` / `already committed` / `commitment must be 64 lowercase hex characters`                                                                                                              | Bad commit.                                                                                                          |
| `no commitment to reveal` / `the commit phase is still open` / `the panel deadline passed` / `already revealed` / `the vote does not match the commitment` / `vote for the proposed answer or the challenger's answer`                              | Bad reveal.                                                                                                          |
| `a reason is required` / `reason is too long` / `salt is too long`                                                                                                                                                                                  | Bad reveal text.                                                                                                     |
| `challenge window is still open` / `the panel still has time` / `already final`                                                                                                                                                                     | `finalize` at the wrong moment.                                                                                      |
| `the answer deadline has not passed` / `already resolved`                                                                                                                                                                                           | `resolve_by_deadline` too early, or for a market whose final answer the market already has.                          |
| `nothing to apply` / `no settled dispute to unlock`                                                                                                                                                                                                 | Retrying something not needed.                                                                                       |
| `nothing to withdraw`                                                                                                                                                                                                                                | No balance.                                                                                                          |
| `resolve_by is too soon after close_at for a case to finish`                                                                                                                                                                                        | A market refused at registration.                                                                                    |
| `not enough price publishers are configured`                                                                                                                                                                                                        | A price market with too few publishers.                                                                              |
| `a price market is answered with a signed price` / `not a price market`                                                                                                                                                                             | Wrong submission type.                                                                                               |
| `the observation time has not come`                                                                                                                                                                                                                 | A price submitted too early.                                                                                         |
| `not enough valid publisher signatures` / `a publisher signed twice` / `not a publisher` / `a signature does not match` / `bad publisher key` / `a signature is <publisher key>.<hex>` / `a signature is 128 hex characters` / `a signature is hex` | A bad price submission.                                                                                              |
| `publishers use ed25519 keys` / `already a publisher` / `there can be at most 10 publishers`                                                                                                                                                        | Bad `add_publisher`.                                                                                                 |
| `that would leave fewer publishers than must sign`                                                                                                                                                                                                  | `remove_publisher` below the threshold.                                                                              |
| `the threshold must be between 1 and the number of publishers`                                                                                                                                                                                      | Bad threshold.                                                                                                       |
| `jury size must be odd and at most 21`                                                                                                                                                                                                              | Bad jury size.                                                                                                       |
| `Requires attached deposit of exactly 1 yoctoNEAR`                                                                                                                                                                                                  | `withdraw_bond`, `commit_vote` or `reveal_vote` without the 1 yocto.                                                 |
| `bond must be positive` / `windows must be positive`                                                                                                                                                                                                | An owner setting of zero.                                                                                            |
| `attach at least 100 TGas to upgrade`                                                                                                                                                                                                               | `upgrade` with less gas than the deploy and migrate need.                                                            |
| `no code is staged under that hash`                                                                                                                                                                                                                 | `upgrade` for a hash nobody staged, or one already used.                                                             |
| `attach at least <amount> to pay for the storage` / `the wasm goes in the call input`                                                                                                                                                               | `stage_code` with too little deposit or no input.                                                                    |
| `prove the upgrade path before deleting keys`                                                                                                                                                                                                       | `seal` before an upgrade has gone through `migrate`.                                                                 |
| `migrate expects version 1`                                                                                                                                                                                                                         | `migrate` found state written by another version.                                                                    |
| `migrate runs only inside an upgrade`                                                                                                                                                                                                               | `migrate` called without `upgrade` having sent the batch.                                                            |
| `the case still has time; finalize it when its round is over`                                                                                                                                                                                       | `resolve_by_deadline` for a case whose window is open or whose round is not over. The timing rules leave none today. |
| `Method <name> is private`                                                                                                                                                                                                                          | A callback, or `new`, called by anyone but the contract's own account.                                               |
| `attach at least 80 TGas: a call that settles a case sends the answer to the market and releases the juries`                                                                                                                                        | `reveal_vote`, `finalize` or `resolve_by_deadline` with less than the settling floor.                                |
| `attach at least 275 TGas: the jury draw reads every staked seat`                                                                                                                                                                                   | `resolve_draw` with less than the draw floor.                                                                        |
| `attach at least 35 TGas: each jury's release gets an equal share of what is attached` | `retry_unlock` with less than its floor. |
| `attach at least 33 TGas: a withdrawal sends the payout and then settles it` | `withdraw_bond` with less than its floor. |
| `the collateral token id must look like nep141:<token>` | `new` with a collateral id that is not in the exact `nep141:` form. |

---

## Gas

| Step                                 | Gas                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Jury draw reserved in `resolve_draw` | 250 TGas, plus 15 for `on_drawn`. The call refuses less than 275 (270 was the least that worked)                                    |
| `on_drawn`                           | 15 TGas                                                                                                                             |
| Writing the outcome to market        | 20 TGas, plus a 10 TGas callback                                                                                                    |
| Releasing a jury (`unlock_case`)     | 15 TGas for each jury, so two calls after a second round. Measured at most 8.9 TGas for a 21-juror case where every juror forfeits. |
| A bond through the verifier          | The verifier keeps about 21 TGas of what is attached and the oracle's receipt gets the rest. Proposing or challenging opened the case with 22 TGas attached and did not with 21, and the receipt burns 1.9 TGas. A wallet attaches 100. The oracle enforces no floor here: a call that runs short fails in the oracle and the verifier refunds the sender. |
| Bond withdrawal transfer             | 15 TGas for the verifier's `mt_transfer`, which burned 3.9, plus a 10 TGas callback                                                |
| `migrate` in the upgrade batch       | 30 TGas reserved (the batch of deploy and migrate burned 19 for a 281 KB build)                                                     |
| `upgrade`                            | At least 100 TGas attached; 33 burned in all for a 281 KB build                                                                     |

The gas floors, each from what the method reserves plus a margin over what it burns. The least that
worked is the lowest whole number of TGas that settled the case cleanly in the sandbox, tried in
steps of 2 where a number is given.

| Method                     | Floor | Reserved by the method                                     | Burned by the method itself, worst case                              | Least that worked                                                                     |
| -------------------------- | ----- | ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `reveal_vote` that settles | 80    | 60: apply 20, its callback 10, two releases of 15          | 8.4 (11th of 21 jurors in a second round, 1,000 byte reasons)        | 72                                                                                    |
| `finalize` that settles    | 80    | 60, as above                                               | 8.2 (a second round of 21, 10 revealed, 22 jurors at fault)          | 72                                                                                    |
| `resolve_by_deadline`      | 80    | 60, as above                                               | the same code path as `finalize`; the void path was run at the floor | not searched                                                                          |
| `resolve_draw`             | 275   | 265: the draw 250 and `on_drawn` 15                        | 2.3 here, 14 in all with 34 seats staked                             | 270                                                                                   |
| `retry_unlock`             | 35    | none fixed: the caller's gas is shared by the two releases | 3.0                                                                  | not searched; each release gets 15 at the floor, and the largest release measured 6.1 |
| `withdraw_bond`            | 33    | 25: the payout 15 and its callback 10                      | 2.4 in the oracle's largest receipt, 3.9 in the verifier, 8 in all                     | 29 (28 and less failed whole, with the claimable untouched)                                                                        |

A reveal that does not settle burns about 4 TGas and still has to meet the 80 floor, because the
call cannot know at the top whether it will settle. The 30 TGas common as a wallet default is not
enough for any of these, so a juror's client has to attach 100 TGas. `retry_unlock` used to fail
after a second round with `Returning joint promise is currently prohibited`, because it returned the
two releases joined into one promise. They now run one after the other, and the fix is checked in
the sandbox at the floor.

---

## Security properties checked by tests

Every restricted method refuses a stranger; every callback refuses a direct call; the verifier hook refuses
every caller but the verifier, another token id, a batch, a zero amount and money that was not the sender's
own, and a direct call to it opens no case; a plain deposit to the oracle's account is surplus and credits
nobody; malformed messages bounce with the money back from the verifier; a copied commitment
cannot be revealed by the copier; a challenge that names the proposed answer is refused and a vote
for a third outcome is refused; a bogus challenge costs the attacker the whole bond; a no-decision
with no juror revealing pays the recipient and never the owner; a market never reaches its deadline
with a case that still has time (randomized); the deadline call refuses a case that still has time
and does not void its market; a hand-called `migrate` is refused; a no-decision escalates exactly
once to a larger, disjoint jury and a second no-decision pays as stated; two accounts that stall a
case end down by at least the jurors' share whatever the juries do; a full binary ballot always
settles (randomized); starving the settling call of gas cannot half-settle a case; a settled dispute
always pays out exactly two bonds (randomized over 400 cases) and only to jurors who earned it; a
jury drawn at the last allowed moment still gets its full time; a limited-access key cannot commit
or reveal; and a signature is good for exactly one price of one market, network and contract, with
each field of the signed text checked by changing it.

After every finished step of a full dispute, and of a dispute nobody decided, `total_owed` equals what the
verifier holds for the oracle, through every payee withdrawing; a payout the verifier refuses (an account
lock or a paused transfer) gives the balance back and the books stay equal; juror pay and the
no-decision share come out of the oracle's own account and leave the Council's balance and its revenue
count unchanged; the oracle registers no key in the verifier and keeps predecessor authentication on; and
source guards fail if the oracle code names a NEP-141 call, a transfer call, any verifier admin method or
holder revenue.

Every owner setting refuses a stranger, the operator and a zero; a market registered before a
setting change keeps its windows for the proposal, the draw and the panel deadline, including the
second round; a new bond reaches only new cases, and a settled case pays the bond it was proposed
with; a stranger and the operator cannot upgrade or seal, `seal` waits for `upgrade_proven`, and
`migrate` refuses another state version; a stranger cannot initialise a deployed oracle; the
`proposed` event of a price answer names the publishers in submission order; every method with a gas
floor refuses one TGas less and works at the floor, in the largest case the suite can build. See
`AUDIT.md`.

---

## Things to know

| Topic                                                                 | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optimistic limit                                                      | An unchallenged wrong answer becomes final. Protection depends on the bond, window length and someone watching for wrong answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| One case per market                                                   | After a case is final nobody can propose again for that market.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Jury size and capture                                                 | A jury of 3 is captured far more easily than 11 or 21. With a third of all seats an attacker holds a majority of a jury of 3 about 28% of the time, 11 about 12%, 21 about 3%. Use 11 or 21 for real money. The per-account seat cap in council does not lower these odds: juries are distinct accounts, so spreading seats across wallets is the attacker's best setup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Early settlement rewards early reveals                                | A case settles the moment a majority of the jury has revealed. Jurors who committed but had not yet revealed are neither paid nor penalized, so revealing in the first block of the reveal phase is what pays. A voting interface should tell jurors so and should open the reveal for them as soon as the phase starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The salt is the juror's to keep                                       | The voting client must generate a random salt of at least 128 bits for each vote, keep it, and offer the juror a backup. A lost salt means the juror cannot reveal and is marked delinquent. The oracle accepts any salt up to 64 bytes and cannot tell a weak one from a strong one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| One bond cannot scale with market size                                | The bond is one number for every market, but what an unchallenged wrong answer is worth grows with the money at stake. The code has no per-market bond. The lever is the size of the markets: the most any one market is allowed to hold should be set so that corrupting it costs more than it pays, and the bond should be at least a floor and sized to that cap. The contracts do not enforce a market size, so it is an operating control (what the operator seeds, and the deposit limits at launch).                                                                                                                                                                                                                                                                                                                                                                                  |
| The oracle pays its own storage                                       | Cases, votes and balances are stored at the oracle's expense, about a quarter of a NEAR for a case with 21 maximum-length reasons. Its account must be funded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A keeper outage is tested for two cases                               | Nobody calls anything from a proposal to a second past `resolve_by`. An unchallenged proposal is then applied as the answer by the first `resolve_by_deadline`, the proposer's bond is back, winners redeem, and the market's own void stays shut. A dispute nobody drew a jury for ends in a Void at the same call, with the bonds split as a no-decision splits them. Other outages are not tested: for example a jury that is seated and silent when the deadline passes.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| What the tests do not cover                                           | The sandbox is a single shard, so receipt ordering across shards, cross-shard latency and gas under congestion are untested. There has been no testnet soak.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Where the money is | Every bond sits in this contract's own account in the Intents verifier, and nowhere else. The verifier's pause and account-lock roles can stop every payout. A locked oracle account keeps receiving bonds it cannot pay out, so the keeper watches `is_account_locked` and the deployment should not advertise proposing while the account is locked. A payout the verifier refuses is given back to the claimable and logged as `bond_payout_failed`. |
| Surplus | A plain deposit to the oracle's account, in any message form including the old notify form, is credited to the oracle by the verifier and tells the oracle nothing. No method credits it to anyone and `total_owed` leaves it out, so the verifier balance minus `total_owed` is the surplus. Nothing spends it either. |
| Reconciling | `total_owed` is the bonds in cases that are not final plus everything claimable. At rest it equals `mt_balance_of(oracle, collateral token id)`. A payout in flight, or a bond whose hook has not run yet, makes the verifier's figure larger for a block. A smaller figure is an incident. The keeper's `check` compares the two at one finalized block. |
| No unresolved payout state | `mt_transfer` returns nothing and runs as one verifier receipt, so an error means nothing moved and the callback gives the claimable back. The oracle never uses `mt_transfer_call`, the call whose result can be lost, so it has no counterpart of the market's `revenue_unresolved`. If the callback itself ran out of gas (it gets 10 TGas and the oracle burns under 3) the claimable would stay at zero with the money still in the account. That shows as surplus, and nothing can pay it twice. |
| Who can collect a payout | Only the account that owns a claim, by calling `withdraw_bond` with 1 yocto. There is no push payout, so a DAO that is the no-decision recipient needs a proposal for each collection. |
| The verifier is trusted | Bond custody depends on the verifier's own roles and code, which the oracle cannot change. The sandbox tests run the verifier bytes whose hash `intents.near` had when [INTENTS-PROOF.md](INTENTS-PROOF.md) was written. The real USDC token and mainnet behaviour were not run. |
| Keys                                                                  | Until `seal` has run, the deploy key can replace this code outside every vote. After it, only a DAO upgrade can. A sealed contract with a broken upgrade path cannot be fixed, so prove one upgrade first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A challenged price market keeps the signed price when no jury decides | After two rounds without a majority an event market resolves Void, and a price market resolves to the price the publishers signed, because a signed price from `price_threshold` publishers is objective evidence. The consequence: if `price_threshold` publishers are compromised together and sign a wrong price, an honest challenger needs an active jury majority to overturn it. Juror apathy is enough for the wrong price to stand, where before it produced a Void. The assumption is a design choice. Keep it explicit and watch it: put it in the Terms' risk section, alert on every `challenged` event of a price market, and keep `price_threshold` at 2 or more with the publishers on different operators and infrastructure. Making a price market Void in that case is a one-line change in `close_round`, at the cost of bringing back the cheap Void for price markets. |
| Website                                                               | A challenge has to send the case's own `bond`, not the bond in `config()`, once the owner has changed it. A bond is a `mt_transfer_call` on the verifier with 1 yocto attached and the token id from `config()`, never a transfer to a token contract: a NEP-141 transfer to the oracle bounces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| No outside audit                                                      | The only review is the self-review in `AUDIT.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
