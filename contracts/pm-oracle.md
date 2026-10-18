# pm-oracle

Source: `pm-oracle/src/lib.rs`. Written 2026-10-18 from the code as it stands. When this file and the code disagree, the code is right.

## What it is

pm-oracle decides how markets end. It is an optimistic oracle: someone proposes an answer and puts up a bond, and unless someone challenges it within a time window, the answer stands. If someone does challenge, a jury of NFT holders votes in secret, then reveals, and a majority decides. The final answer is written to pm-market, which trusts only this contract for outcomes.

It handles two kinds of market:

| Kind | How it is answered |
|---|---|
| Event market (most markets) | Someone proposes Yes, No or Void with a link to evidence, and puts up a bond. |
| Price market | Someone submits a price that enough independent publishers have signed. The contract checks the signatures, works out Yes or No from the price, and the answer goes through the same bond, window and jury as any other. |

It also holds the bonds, and pays them out, together with the jurors' pay, when a case ends.

## Where it sits among the other contracts

| Contract | Relationship to pm-oracle |
|---|---|
| pm-market | Registers each new market here, and receives the final outcome from here. Only pm-market may register markets. |
| pm-council | Supplies the jury. pm-oracle asks it to draw jurors from staked NFT seats, and tells it to release them and which jurors never voted. |
| pm-governance | Intended owner, so changes need a member vote and a timelock. |
| The bond token (NEP-141, in tests `mock-ft`) | What bonds and juror pay are paid in. Normally the same token the market uses. |

## Roles: who can do what

| Role | Set by | Can do |
|---|---|---|
| Owner | `new`, then `propose_owner` and `accept_owner` | `set_jury_size`, `set_operator`, `add_publisher`, `set_price_threshold`, `propose_owner`, and everything the operator can do. Normally the pm-governance contract. |
| Operator | `new`, then `set_operator` (owner only) | Only `remove_publisher`. It exists so a leaked price-signing key can be cut off in one call instead of waiting out a vote. |
| Market contract | `new` (fixed) | Only `register_market`. |
| Bond token | `new` (fixed) | Only `ft_on_transfer`, which is how bonds arrive. |
| Jurors | Drawn per case by pm-council | `commit_vote` and `reveal_vote` on the case they were drawn for. |
| Anyone | n/a | Propose, challenge and answer prices (by sending a bond), `resolve_draw`, `finalize`, `retry_apply`, `retry_unlock`, `withdraw_bond` (their own), and every view. |

## Starting it up: `new`

Called once, at deploy. It cannot be called again.

| Argument | Meaning |
|---|---|
| `owner_id` | The owner. Normally pm-governance. |
| `market_contract` | The pm-market contract. |
| `bond_token` | The token bonds are paid in. |
| `bond` | The one bond amount, in raw token units. Every proposal, challenge and price submission must send exactly this. Must be above zero. |
| `window_ms` | How long the challenge window lasts after a proposal, in milliseconds. |
| `panel_deadline_ms` | How long a jury has after a challenge, in milliseconds. The first half is for committing votes, the second half for revealing them. |
| `council` | The pm-council contract. |
| `jury_size` | How many jurors, odd, at most 21. |
| `draw_delay_blocks` | How many blocks must pass after a challenge before the jury can be drawn. |
| `min_proposal_ms` | The least time a market must leave, after it closes, for someone to notice and propose, on top of the time a case needs. |
| `operator_id` | The operator. |
| `network` | A word naming the network, such as `mainnet`. Signed into every price so a testnet signature is useless on mainnet. Must not be empty or contain a colon. |
| `price_threshold` | How many publishers must sign the same price. At least 1. |

The window, the panel time and the bond are deploy settings with no setter, so changing them needs a new deployment. The tests use a 60 second window and a 120 second panel; the design proposes 2 hours and 48 hours for mainnet.

## Units and conventions

| Thing | Convention |
|---|---|
| Times | Nanoseconds since the Unix epoch in views and the case record. Settings are given in milliseconds at deploy and stored in nanoseconds. |
| Big numbers in JSON | `U64` and `U128` travel as strings. |
| Outcomes | The words `yes`, `no` or `void`. |
| Prices in a price market | Integers scaled by 10 to the power `decimals`, as set in the market's price rule. |

## The life of a case

A case exists for a market once someone has proposed an answer. A market gets at most one case, ever.

```
(nothing) --propose or price--> Proposed --window ends, finalize--> Final
                                   |
                                   +--challenge--> Disputed --majority reveals--> Final
                                                      |
                                                      +--panel deadline passes, finalize--> Final (Void)
```

Stages are `proposed`, `disputed` and `final`.

### 1. A market is registered

When pm-market creates a market it calls `register_market` here. The oracle refuses a market if there is not enough room between close and the answer deadline for a case to finish (see "The minimum gap"), and refuses a price market until enough publishers exist. A refused registration leaves the market unable to trade.

### 2. Someone proposes

After the market closes, anyone can send exactly the bond to this contract with a message naming the answer (see "Messages"). The case opens as `proposed` and the challenge window starts.

A proposal is refused unless: the market is registered and has closed; the evidence text is at most 512 bytes; there is still time for a full challenge window, a full panel deadline and a 30 second buffer before the market's `resolve_by`; and no answer was proposed before. If any rule fails the bond goes straight back to the sender.

### 3. Nobody challenges

Once the window has passed, anyone calls `finalize`. The proposal becomes final, the proposer's bond goes back to them to withdraw, and the answer is written to pm-market.

### 4. Someone challenges

Within the window, a different account sends exactly the bond with the message `challenge:<market>`. The case becomes `disputed`. It records the time, a panel deadline (challenge time plus `panel_deadline`), the end of the commit phase (halfway to the deadline), and the block height from which a jury may be drawn (the challenge height plus `draw_delay_blocks`). The proposer cannot challenge their own answer.

### 5. The jury is drawn

Anyone calls `resolve_draw(market_id)` once the draw height has passed and while the commit phase is still open. The oracle passes a random seed (the current block's `env::random_seed()`), the jury size, and the proposer and challenger (who are excluded) to pm-council, which picks the jurors. When pm-council answers, `on_drawn` records the jury on the case, but only if the case is still disputed, still has no jury, and the jury has exactly the configured size and no repeated account. If anything is off it logs `draw_failed` and the draw can be retried. Two draws in flight at once end with one jury, because the first to land wins.

The seed comes from a block after the challenge, so nobody knows the jury when they challenge. A block producer can still see the seed before it is public and could choose not to include an unfavourable draw; the delay narrows this and does not remove it.

If nobody calls `resolve_draw` before the commit phase ends, no jury is ever drawn and the case ends Void at the panel deadline. A keeper (see `keeper/keeper.mjs`) exists to make that call on time.

### 6. Jurors commit, then reveal

In the first half of the panel deadline, each juror on the panel calls `commit_vote(market_id, commitment)` once. The commitment is the 64-character lowercase hex of SHA-256 over the text `<juror account>:<yes|no|void>:<salt>`. Including the juror's own account means a copied commitment cannot be revealed by anyone else.

In the second half, each juror who committed calls `reveal_vote(market_id, outcome, salt, reason)`. The contract checks the vote and salt hash to the juror's commitment. A reason is required (at most 1,000 bytes) and the salt can be at most 64 bytes. The reveal is public, with its reason.

The moment any outcome has votes from a majority of the jury (more than half), the case settles at once, without waiting for the rest.

Important for juror software: the contract never checks how strong a salt is. Because there are only three outcomes, a guessable salt such as `s` lets anyone work out the vote from the public commitment, and a copier can then commit the same vote under their own name. The voting client must generate a random salt of at least 128 bits.

### 7. The panel does not decide

If the panel deadline passes without a majority, anyone calls `finalize` and the case settles as Void with both bonds returned.

### 8. Settling

Whenever a case settles, in this order: the stage becomes final, who is delinquent is worked out, bonds are allocated, an event is logged, the outcome is sent to pm-market, and for a disputed case pm-council is told to release the jury.

## Who gets paid what

Let B be the bond.

| Case ends as | Proposer | Challenger | Jurors |
|---|---|---|---|
| Unchallenged and final | B back | n/a | n/a |
| Disputed, a majority decided, the proposal was upheld (the jury's outcome equals the proposed one) | 2B minus the jurors' share | nothing | The jurors' share |
| Disputed, a majority decided, the proposal was rejected (any other outcome, Void included) | nothing | 2B minus the jurors' share | The jurors' share |
| Disputed, nobody decided (timeout, or too few votes revealed) | B back | B back | nothing |

The jurors' share is 25% of one bond, split equally among the jurors who revealed and sat with the final outcome. It is rounded down per juror and the winner keeps the remainder, so exactly two bonds are paid out. A juror who revealed with the minority, or did not reveal, gets nothing.

Money is credited to a per-account balance (`claimable_of`) and taken out with `withdraw_bond`, which sends it as tokens. The balance is zeroed before the transfer and restored if the transfer fails. The recipient must be registered with the token.

Two behaviours worth knowing. If a proposer proposes Void and the jury never decides, the timeout resolves Void, but nobody wins: both bonds go back. And when a jury decides Void by majority over a proposed Yes or No, the proposer loses their bond like any other rejected answer, so honest Void votes are paid like any other.

### Who is delinquent

A drawn juror is delinquent if they never voted. That means: they never committed, or, once the reveal window is over, they committed and never revealed. A juror who committed but had no chance to reveal because a majority settled the case early is not delinquent. The list is stored on the case and sent to pm-council, which takes from each delinquent juror's seat the revenue it earned while serving. See `pm-council.md`.

## Writing the answer to the market, and releasing the jury

Both happen in calls after the case is settled, and both can fail without losing the result:

| Step | Call | If it fails |
|---|---|---|
| The market receives the outcome | `apply` sends `set_outcome` to pm-market. `on_applied` marks the case `applied`. | Anyone can call `retry_apply(market_id)`. |
| The jury is released | `unlock_case` is sent to pm-council with the delinquent list. | Anyone can call `retry_unlock(market_id)`, which uses whatever gas the caller attaches. Repeating it is harmless. |

If nothing applies an answer by the market's `resolve_by`, anyone can void the market directly on pm-market. The oracle refuses proposals that could not finish in time, plus a 30 second buffer for the apply step to land, so a running case cannot be overtaken by that void.

## The minimum gap

When a market is registered, the oracle requires `resolve_by` to be at least this far after the moment the answer is first possible:

`min_proposal + challenge window + panel deadline + 30 seconds`

For an event market the moment is `close_at`. For a price market it is the observation time. Markets with less room are refused, because no case could ever finish in them and the only ending would be a Void at the deadline. `config()` shows the figure as `min_resolve_gap_ns`.

## Price markets and signed prices

A price market carries a price rule (observation time, strike, decimals, direction), set by pm-market and locked into the market's rule hash. Here is how its answer is produced.

1. At or after the observation time, anyone can submit a price with `ft_transfer_call` (message below) and the usual bond.
2. The contract rebuilds what a publisher would have signed: the text `pm-price:v1:<this contract>:<network>:<market id>:<observation time>:<price>:<decimals>`. Everything except the price is fixed by the market and the deployment, so one signature is good for one price of one market on one network and one contract. It cannot be replayed on another market, network or contract, and a signature for a different moment is useless.
3. It checks each listed signature with ed25519 against the configured publisher keys. A malformed entry, a key that is not a publisher, a repeated key, or a signature that fails makes the whole submission fail and the bond come back.
4. At least `price_threshold` different publishers must have signed. One leaked key alone cannot set a price.
5. The answer is Yes if the price is at or above the strike (when the rule's direction is "above") and No otherwise, or the reverse for "below".
6. The case then opens exactly as for any proposal, with evidence reading `signed price <price> by <n> publishers`. The submitter's bond is the proposer's bond. It can be challenged and go to a jury like any other, which is the backstop if enough publishers signed a wrong price.

There is no staleness limit: each signature covers one observation time, so a publisher that was down at that moment can sign the price later. A plain `propose` is refused on a price market, so the signatures cannot be skipped.

Anyone holding a valid signed price can submit it first and take the proposer's place, and with it the winner's share if the price is later challenged and upheld, so the party that submits prices should do so promptly.

### Managing publishers

| Method | Who | Notes |
|---|---|---|
| `add_publisher(key)` | Owner | An ed25519 public key in NEAR format (`ed25519:...`). At most 10. No duplicates. |
| `remove_publisher(key)` | Operator or owner | Immediate. Refused if it would leave fewer publishers than `price_threshold`. |
| `set_price_threshold(threshold)` | Owner | Between 1 and the number of publishers. |

Adding a key or changing the threshold grants or changes power over prices, so it is the owner's. Removing a key only takes power away, so the faster operator may do it.

A submission with all 10 signing burned about 4.5 TGas here (9.4 in all) and worked with 30 TGas attached.

The off-chain publisher service that reads exchange prices and signs them is not built; until it exists price markets can be created and answered by hand, but nothing produces the signatures.

## Messages: how bonds arrive

Everything that needs a bond is a `ft_transfer_call` of exactly `bond` tokens to this contract. The `msg` says what to do. Only the bond token may call `ft_on_transfer`; anything else is refused with "wrong token". Any problem makes the call panic and the token returns the money.

| `msg` | What it does |
|---|---|
| `propose:<market>:<yes\|no\|void>:<evidence>` | Proposes an answer for an event market. The evidence is free text, normally a link, up to 512 bytes. It may contain colons. |
| `challenge:<market>` | Challenges the open proposal. |
| `price:<market>:<price>:<key>.<signature>,<key>.<signature>,...` | Answers a price market. Each entry is a publisher key in `ed25519:...` form, a dot, and the 128-character hex signature. |

## Every method

| Method | Who | What it does |
|---|---|---|
| `new(...)` | Deployer, once | Initialises. |
| `propose_owner(new_owner)` | Owner | Starts a handover. |
| `accept_owner()` | The proposed account | Completes it. Two steps so a typo cannot lock the contract. |
| `set_jury_size(jury_size)` | Owner | Odd, at most 21. Applies to juries drawn afterwards. A draw already in flight when it changes will fail the size check and can be retried. Logs no event. |
| `set_operator(operator_id)` | Owner | Replaces the operator. |
| `add_publisher(key)` | Owner | See above. |
| `remove_publisher(key)` | Operator or owner | See above. |
| `set_price_threshold(threshold)` | Owner | See above. |
| `register_market(market_id, close_at, resolve_by, rule_hash, price_rule)` | Market contract only | Records a market. Calling it twice for the same market changes nothing. |
| `ft_on_transfer(sender_id, amount, msg)` | Bond token only | Receives bonds. |
| `resolve_draw(market_id)` | Anyone | Asks pm-council to draw the jury. Needs the case disputed, no jury yet, the draw height reached, and the commit phase still open. Reserves 250 TGas for the draw, so it needs about 270 TGas attached. |
| `commit_vote(market_id, commitment)` | A juror on that case | Commits a hidden vote, once, during the commit phase. |
| `reveal_vote(market_id, outcome, salt, reason)` | A juror who committed | Reveals the vote during the reveal phase. May settle the case. |
| `finalize(market_id)` | Anyone | Settles an unchallenged proposal after its window, or a disputed case after its panel deadline (as Void). |
| `retry_apply(market_id)` | Anyone | Sends the final outcome to the market again. |
| `retry_unlock(market_id)` | Anyone | Tells pm-council to release the jury again. |
| `withdraw_bond()` (payable, 1 yocto) | Anyone, for their own balance | Sends the caller's whole claimable balance as tokens. |
| `on_drawn`, `on_applied`, `on_bond_withdrawn` | The contract itself | Callbacks. |

## Views

| View | Returns |
|---|---|
| `get_case(market_id)` | The case, or nothing. Fields below. |
| `get_market_info(market_id)` | What was registered: close, resolve_by, rule hash, price rule. |
| `claimable_of(account_id)` | An account's withdrawable bonds and juror pay. |
| `config()` | owner, pending owner, market, bond token, bond, window, panel deadline, council, jury size, draw delay, minimum proposal time, minimum gap, operator, network, the publisher keys, and the threshold. |

### The case record

| Field | Meaning |
|---|---|
| `stage` | `proposed`, `disputed` or `final`. |
| `proposer`, `proposed`, `evidence` | Who answered, what they said, and their evidence text. |
| `window_ends_at` | End of the challenge window. |
| `challenger` | The challenging account, if any. |
| `challenged_at`, `panel_deadline` | When it was challenged and when the jury runs out of time. |
| `draw_after_height` | The block height from which the jury may be drawn. |
| `commit_ends_at` | The end of the commit phase and the start of the reveal phase. |
| `panel` | The drawn jurors. Empty until drawn. |
| `commits` | Each committing juror and their commitment. |
| `votes` | Each revealed vote with its reason. |
| `final_outcome` | The result once final. |
| `applied` | Whether pm-market has received it. |
| `delinquent` | Jurors who never voted, set when a disputed case settles. |

## Events

Each logs `EVENT_JSON:` and JSON of the form `{"standard":"pm-oracle","version":"1.0.0","event":"<name>","data":{...}}`.

| Event | When | Data |
|---|---|---|
| `owner_proposed`, `owner_changed` | Handover | owner and proposed, or from and to |
| `operator_set` | `set_operator` | operator |
| `publisher_added` | `add_publisher` | key |
| `publisher_removed` | `remove_publisher` | key, by |
| `price_threshold_set` | `set_price_threshold` | threshold |
| `market_registered` | `register_market` | market_id |
| `proposed` | A proposal or price | market_id, proposer, outcome, evidence, window_ends_at |
| `challenged` | A challenge | market_id, challenger, panel_deadline |
| `jury_drawn` | A jury recorded | market_id, panel |
| `draw_failed` | A draw was refused or failed | market_id |
| `vote_committed` | A commitment | market_id, juror, commitment |
| `vote_revealed` | A reveal | market_id, juror, outcome, reason |
| `final` | A case settled | market_id, outcome, juror_pay_each, paid_jurors, delinquent |
| `outcome_applied` | The market received the outcome | market_id |

## What can go wrong, and the message you will see

| Message | Cause |
|---|---|
| `owner only` / `operator or owner only` / `market contract only` / `not the proposed owner` | Access refusals. |
| `wrong token` | `ft_on_transfer` from something other than the bond token. |
| `send exactly the bond` | The wrong amount. |
| `bad market id` / `bad price` / `unknown action` / `outcome must be yes, no or void` | A malformed message. |
| `market is not registered` | The market was never registered here. |
| `the market has not closed yet` | A proposal before close. |
| `evidence link is too long` | Over 512 bytes. |
| `too late to propose, the market will be voided at its deadline` | Not enough time left for a full case. |
| `an answer was already proposed` | A market gets one case. |
| `nothing to challenge` / `the challenge window closed` / `you cannot challenge your own answer` | Bad challenge. |
| `no case for that market` / `no open dispute` | There is nothing to act on. |
| `the jury is already drawn` / `too early to draw the jury` / `too late to draw a jury` | Bad draw timing. |
| `not on the panel for this case` / `the commit phase is over` / `already committed` / `commitment must be 64 lowercase hex characters` | Bad commit. |
| `no commitment to reveal` / `the commit phase is still open` / `the panel deadline passed` / `already revealed` / `the vote does not match the commitment` | Bad reveal. |
| `a reason is required` / `reason is too long` / `salt is too long` | Bad reveal text. |
| `challenge window is still open` / `the panel still has time` / `already final` | `finalize` at the wrong moment. |
| `nothing to apply` / `no settled dispute to unlock` | Retrying something not needed. |
| `nothing to withdraw` | No balance. |
| `resolve_by is too soon after close_at for a case to finish` | A market refused at registration. |
| `not enough price publishers are configured` | A price market with too few publishers. |
| `a price market is answered with a signed price` / `not a price market` | Wrong submission type. |
| `the observation time has not come` | A price submitted too early. |
| `not enough valid publisher signatures` / `a publisher signed twice` / `not a publisher` / `a signature does not match` / `bad publisher key` / `a signature is <publisher key>.<hex>` / `a signature is 128 hex characters` / `a signature is hex` | A bad price submission. |
| `publishers use ed25519 keys` / `already a publisher` / `there can be at most 10 publishers` | Bad `add_publisher`. |
| `that would leave fewer publishers than must sign` | `remove_publisher` below the threshold. |
| `the threshold must be between 1 and the number of publishers` | Bad threshold. |
| `jury size must be odd and at most 21` | Bad jury size. |
| `Requires attached deposit of exactly 1 yoctoNEAR` | `withdraw_bond` without the 1 yocto. |
| `Method <name> is private` | A callback called from outside. |

## Gas

| Step | Gas |
|---|---|
| Jury draw reserved in `resolve_draw` | 250 TGas (so the call needs about 270 attached) |
| `on_drawn` | 15 TGas |
| Writing the outcome to pm-market | 20 TGas, plus a 10 TGas callback |
| Releasing the jury (`unlock_case`) | 15 TGas. Measured at most 8.9 TGas for a 21-juror case where every juror forfeits. |
| Bond withdrawal transfer | 15 TGas, plus a 10 TGas callback |

A call that settles a case, the last reveal or a finalize, burns about 18 TGas at the largest jury (21) and needs about 55 TGas attached: 50 fails, 55 works. The 30 TGas common as a wallet default is not enough.

## Security properties checked by tests

Every restricted method refuses a stranger; every callback refuses a direct call; a token other than the bond token cannot bond; malformed messages bounce with the money back; a copied commitment cannot be revealed by the copier; a bogus challenge costs the attacker the whole bond; starving the settling call of gas cannot half-settle a case; a settled dispute always pays out exactly two bonds (randomized over 400 cases) and only to jurors who sat with a decided majority; and a signature is good for exactly one price of one market, network and contract, with each field of the signed text checked by changing it. See `AUDIT.md`.

## Things to know

| Topic | Detail |
|---|---|
| Optimistic limit | An unchallenged wrong answer becomes final. The window length and the bond are the real protection, so someone must be watching. |
| One case per market | After a case is final nobody can propose again for that market. |
| Jury size and capture | A jury of 3 is captured far more easily than 11 or 21. With a third of all seats an attacker holds a majority of a jury of 3 about 28% of the time, 11 about 12%, 21 about 3%. Use 11 or 21 for real money. |
| The oracle pays its own storage | Cases, votes and balances are stored at the oracle's expense, about a quarter of a NEAR for a case with 21 maximum-length reasons. Its account must be funded. |
| No outside audit | The only review is the self-review in `AUDIT.md`. |
