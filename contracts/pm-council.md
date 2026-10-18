# pm-council

Source: `pm-council/src/lib.rs`. Written 2026-10-18 from the code as it stands. When this file and the code disagree, the code is right.

## What it is

pm-council is the registry of Council seats. A seat is an NFT from one specific collection, locked into this contract ("staked"). The contract does two jobs with the seats:

1. It supplies the jury. When pm-oracle needs a jury for a dispute, it asks this contract to draw jurors at random from the staked seats.
2. It shares revenue. A quarter of all trading fees is sent here and divided equally among the staked seats, and each seat's holder can claim their share.

Only staked NFTs earn and only staked NFTs can be drawn. Holding the NFT without staking it does nothing.

It does not decide anything about markets. The Council is a funding and revenue-share mechanism plus a jury pool. It has no control over the contracts that hold the money or decide outcomes; that belongs to pm-governance, a separate body of up to five named people.

## Where it sits among the other contracts

| Contract | Relationship to pm-council |
|---|---|
| pm-oracle | The only caller of `draw` and `unlock_case`. It asks for juries and releases them when a case is final. |
| pm-market | Sends 25% of trading fees here as revenue, through the collateral token. |
| The NFT collection (NEP-171, in tests `mock-nft`) | The only collection that can be staked. |
| The collateral token (NEP-141) | What revenue is paid in and claimed in. |
| pm-governance | Intended owner. |

## Roles: who can do what

| Role | Set by | Can do |
|---|---|---|
| Owner | `new`, then `propose_owner` and `accept_owner` | `set_cooldown_ns`, `set_max_seats_per_account`, `set_nft_contract`, `propose_owner`. Normally the pm-governance contract. |
| Oracle | `new` (fixed) | `draw` and `unlock_case`. |
| Seat holder | Stakes an NFT | `request_unstake`, `unstake` and `claim` for their own seats. |
| The collateral token | `new` (fixed) | Only `ft_on_transfer`, which is how revenue arrives. |
| The NFT collection | `new`, changeable only while nothing is staked | Only `nft_on_transfer`, which is how seats are staked. |
| Anyone | n/a | Send revenue (it is just a donation to the seats), and every view. |

There is no operator role in this contract.

## Starting it up: `new`

Called once, at deploy. It cannot be called again.

| Argument | Meaning |
|---|---|
| `owner_id` | The owner. Normally pm-governance. |
| `oracle_id` | The pm-oracle contract. |
| `nft_contract` | The one NFT collection whose tokens can be staked. |
| `collateral_token` | The token revenue is paid in. |
| `cooldown_ns` | How long a seat must wait between asking to unstake and leaving, in nanoseconds. Must be above zero. |
| `max_seats_per_account` | The most seats one account can hold. Must be at least 1. |

There is also a fixed cap of 1,000 seats in the whole council, written into the code.

## Units and conventions

| Thing | Convention |
|---|---|
| Token ids | Strings, as the NFT collection uses them. |
| Times | Nanoseconds since the Unix epoch. |
| Big numbers in JSON | `U64` and `U128` travel as strings. |
| Revenue amounts | Raw units of the collateral token. |
| Internal revenue precision | Revenue per seat is stored in units of one trillionth of a token unit, so splitting a small amount across many seats loses almost nothing. This never appears in a view. |

## Seats

### Staking a seat

A holder calls `nft_transfer_call` on the NFT collection, naming this contract as the receiver. The collection calls `nft_on_transfer` here. The message text is ignored. The contract checks, and refuses (so the NFT goes straight back) unless:

| Check | Refusal message |
|---|---|
| The call comes from the configured collection | `wrong NFT contract` |
| The token is not already staked | `already staked` |
| The council has fewer than 1,000 seats | `the council is full` |
| The holder has fewer than `max_seats_per_account` seats | `that account already holds the most seats allowed` |

If it accepts, the seat belongs to `previous_owner_id`, the account that owned the token, and not to `sender_id`, which can be an approved marketplace or relayer. This matters: crediting the sender would let a relayer claim someone else's seat. The seat starts with no revenue owed to it (it only earns from revenue that arrives after it is staked).

The NFT is now held by this contract. It does not show in the holder's wallet and cannot be listed on a marketplace until it is unstaked.

### A seat's record

| Field | Meaning |
|---|---|
| `owner` | The account that staked it and will get it back. |
| `staked_at` | When it was staked. |
| `unlock_requested_at` | When unstaking was requested, if it was. |
| `serving` | The case the seat is currently drawn for, if any. |

Three more fields exist internally and are not shown in views: where the token sits in the staked list, the revenue already accounted to it, and the revenue level when it was drawn.

### Leaving: unstaking

It takes two steps and a wait.

1. `request_unstake(token_id)`. The holder asks to leave. Refused if the seat is serving on an open case or a request is already pending. From now on the seat is not available to be drawn.
2. After the cooldown has passed, `unstake(token_id)` with 1 yoctoNEAR attached. The seat is removed first, then what it earned is paid to the holder as tokens, then the NFT is returned. The NFT leaves carrying no revenue, so an NFT sold after unstaking carries nothing with it.

If the revenue transfer fails, the seat is restored exactly as it was, with what it had earned. If the NFT transfer fails (for example the collection is broken), the seat is restored too, and it can be unstaked again without waiting a new cooldown. The recipient must be registered with the collateral token, or the revenue transfer fails.

Between the request and the unstake the seat still counts when revenue arrives, but it cannot claim (unstaking pays instead) and cannot be drawn.

A seat cannot leave while serving on a case, and a seat that has asked to leave cannot be drawn, so no seat is ever both.

### The cooldown

The cooldown is a deploy setting and the owner can change it with `set_cooldown_ns`. A change applies to every unstake from then on, including requests already made, which wait out the new length. It must be at least as long as the oracle's challenge window plus panel deadline, which this contract cannot check. It also needs to be long enough that staking just to catch a revenue sweep and then leaving is not worth the wait (see "Staking just before a sweep").

### The seat cap

`max_seats_per_account` limits how many seats one account can hold, so one wallet cannot gather a large share of the jury draw and the revenue. It does not stop one person using many wallets. Lowering it does not remove seats an account already holds. The owner changes it with `set_max_seats_per_account`.

### Changing the collection

`set_nft_contract` is refused unless no seat is staked ("unstake every seat before changing the NFT contract"), because stakes are tracked by token id alone and two collections could reuse an id.

## Revenue

### How it arrives

The collateral token calls `ft_on_transfer` here when someone sends tokens with the message `revenue`. In practice pm-market does this when `sweep_fees` is called. Anyone may send revenue; it is a donation to the seats. Any other message is refused ("unknown action"), and a call from anything but the collateral token is refused ("wrong token"). A refusal returns the money to the sender.

### How it is divided

The amount, plus anything waiting, is divided equally among the seats staked at that moment, whatever each seat's age. A running figure, revenue per seat since the start, goes up by that share. Each seat remembers the figure when it was staked, so a seat only ever earns from revenue that arrived after it joined. What a seat is owed at any time is the difference between the current figure and its own, which `pending_reward(token_id)` shows.

If no seat is staked when revenue arrives, the amount waits and is added to the next revenue that arrives while seats exist.

Rounding: the division rounds down, leaving at most a tiny fraction of a token unit per seat per revenue event, which stays in the contract. Over the randomized tests, no unit of revenue was created or lost beyond about one unit of dust per seat.

### Claiming

`claim(token_id)` with 1 yoctoNEAR attached pays the seat everything it is owed, as tokens, to its holder. The seat is marked paid before the transfer and the mark is taken back if the transfer fails. Two claims sent at once pay once. A claim is refused if:

| Refusal message | Cause |
|---|---|
| `this seat is serving on an open case, claim after it is final` | The seat is drawn on a case. Claims are blocked while serving so a juror cannot take the revenue out before a forfeit. |
| `an unstake is requested, and unstaking pays what the seat earned` | An unstake is pending. |
| `nothing to claim` | The seat is owed nothing yet. |
| `not your seat` / `not staked` | Not the holder, or not a seat. |

### Staking just before a sweep (a known weakness)

Revenue goes to the seats staked at the moment it arrives, and anyone can trigger the sweep that sends it. So someone who stakes many NFTs a moment before a sweep takes a share of everything gathered since the last sweep, then leaves after the cooldown. In a test, ten NFTs staked for one block before a sweep took two thirds of a month of fees. The controls are the cooldown length, the seat cap, and sweeping often so the gathered amount is small. A rule that a seat earns only after a minimum time staked would close it; that is not built. See `AUDIT.md`.

## Juries

### Drawing

Only pm-oracle can call `draw(case_key, seed, n, exclude)`. The case key is the market id.

1. If a jury was already drawn for this case, the same jury is returned. A retry after a failed callback cannot reroll it.
2. The candidates are every staked seat that is not serving on another case, has not asked to leave, and does not belong to an excluded account (the oracle excludes the proposer and the challenger).
3. A jury is picked one seat at a time. Each round hashes the seed, the case key and the round number, and the first 8 bytes choose a candidate. If that candidate's owner is already on the jury, that seat is set aside and another is picked. So the jury is `n` different accounts.
4. If there are not enough different holders, the draw is refused with `not enough seat holders to draw a jury: <found> eligible, <n> needed`, and the oracle logs `draw_failed`.
5. Every drawn seat is marked as serving that case.

The draw is per seat, so an account holding more seats is proportionally more likely to be picked, but it can only appear once. Chance of an attacker holding a majority of a jury, with seats held 10 to a wallet, from the tests: with 9% of all seats, 3% for a jury of 3 and 0% for 11 or 21; with 23%, 14%, 2% and 0%; with 33%, 28%, 12% and 3%. A larger jury protects far more than a larger council.

A draw reads every staked seat, so its cost grows with the council. At the 1,000 seat cap it costs 190 to 210 TGas, which is why the oracle reserves 250 and the cap is 1,000. Raising the cap means raising that reservation to match and measuring again.

The randomness comes from the block when the oracle's `resolve_draw` runs, at least a set number of blocks after the challenge. A block producer can see it early and could choose not to include an unfavourable draw. That is a documented limit of NEAR's randomness; the delay narrows it and the jury size and seat cap are what protect against it.

### Releasing

When a disputed case is final, the oracle calls `unlock_case(case_key, delinquent)` with the list of jurors who never voted. For every seat of that jury: if its owner is on the delinquent list, the revenue the seat earned while serving is taken from it and added to the waiting pool, and then the seat stops serving. A second call for the same case does nothing, so nobody is penalised twice. If the call fails, anyone can retry it through the oracle's `retry_unlock`, and `jury_of(case_key)` shows whether seats are still held.

### What a silent juror loses

The revenue their seat earned during the case, between the draw and the release. It goes into the waiting pool and is shared by all seats with the next revenue. Jurors also lose their share of juror pay, which is handled in pm-oracle. A juror who committed but had no chance to reveal because the case settled early on a majority is not on the list. The penalty is small when revenue is small, so on its own it is a weak deterrent.

## Every method

| Method | Who | What it does |
|---|---|---|
| `new(...)` | Deployer, once | Initialises. |
| `propose_owner(new_owner)` | Owner | Starts a handover. |
| `accept_owner()` | The proposed account | Completes it. Two steps so a typo cannot lock the contract. |
| `set_cooldown_ns(cooldown_ns)` | Owner | Changes the unstake wait. Above zero. |
| `set_max_seats_per_account(n)` | Owner | Changes the per-account cap. At least 1. |
| `set_nft_contract(nft_contract)` | Owner | Changes the collection. Only while nothing is staked. Logs no event. |
| `nft_on_transfer(sender_id, previous_owner_id, token_id, msg)` | The NFT collection only | Stakes a seat. |
| `ft_on_transfer(sender_id, amount, msg)` | The collateral token only | Receives revenue (`msg` must be `revenue`). |
| `request_unstake(token_id)` | The seat's holder | Starts the cooldown. |
| `unstake(token_id)` (payable, 1 yocto) | The seat's holder | Pays out what the seat earned, returns the NFT. |
| `claim(token_id)` (payable, 1 yocto) | The seat's holder | Pays out what the seat earned, keeping it staked. |
| `draw(case_key, seed, n, exclude)` | Oracle only | Draws a jury. |
| `unlock_case(case_key, delinquent)` | Oracle only | Releases a jury and takes the forfeit. |
| `on_unstake_paid`, `on_unstaked`, `on_claimed` | The contract itself | Callbacks. |

## Views

| View | Returns |
|---|---|
| `seat_count()` | How many seats are staked. |
| `is_seat(account_id)` | Whether the account holds at least one seat. |
| `staked_tokens(from_index, limit)` | A page of staked token ids. |
| `stake_of(token_id)` | A seat's record (owner, staked time, unstake request time, serving case), or nothing. |
| `pending_reward(token_id)` | What `claim` would pay now. |
| `jury_of(case_key)` | The tokens still held for a case. Empty once released. |
| `config()` | owner, pending owner, oracle, NFT collection, collateral token, cooldown, seat cap, and the amount waiting. |

## Events

Each logs `EVENT_JSON:` and JSON of the form `{"standard":"pm-council","version":"1.0.0","event":"<name>","data":{...}}`.

| Event | When | Data |
|---|---|---|
| `owner_proposed`, `owner_changed` | Handover | owner and proposed, or from and to |
| `cooldown_set` | `set_cooldown_ns` | cooldown_ns |
| `max_seats_per_account_set` | `set_max_seats_per_account` | max_seats_per_account |
| `staked` | A seat is staked | token_id, owner |
| `unstake_requested` | `request_unstake` | token_id, owner, unlock_at |
| `revenue` | Revenue arrives | from, amount, seats |
| `revenue_claimed` | A claim, or the payout inside an unstake | token_id, owner, amount |
| `claim_failed` | The claim transfer failed and was undone | token_id, owner, amount |
| `revenue_forfeited` | A silent juror's revenue was taken | token_id, owner, amount, case |
| `unstaked` | The NFT was returned | token_id, owner |
| `unstake_failed` | A transfer failed and the seat was restored | token_id, owner |

## What can go wrong, and the message you will see

| Message | Cause |
|---|---|
| `owner only` / `oracle only` / `not the proposed owner` | Access refusals. |
| `wrong token` / `unknown action` | Revenue from the wrong token, or a message other than `revenue`. |
| `wrong NFT contract` / `already staked` / `the council is full` / `that account already holds the most seats allowed` | A refused stake. |
| `not staked` / `not your seat` | Acting on a seat you do not hold. |
| `unstake already requested` / `request an unstake first` / `the cooldown has not passed` | Wrong unstake order or timing. |
| `this seat is serving on an open case` / `this seat is serving on an open case, claim after it is final` | A seat held for a case. |
| `an unstake is requested, and unstaking pays what the seat earned` / `nothing to claim` | A refused claim. |
| `not enough seat holders to draw a jury: N eligible, M needed` | Too few different holders. |
| `unstake every seat before changing the NFT contract` | `set_nft_contract` while seats exist. |
| `the cooldown must be positive` / `an account must be allowed at least one seat` | Bad settings. |
| `Requires attached deposit of exactly 1 yoctoNEAR` | `claim` or `unstake` without the 1 yocto. |
| `Method <name> is private` | A callback called from outside. |

## Gas

| Step | Gas |
|---|---|
| A jury draw | About 190 to 210 TGas at the 1,000 seat cap (reserved by the oracle at 250) |
| `unlock_case` for a 21 juror case | At most about 8.9 TGas when every juror forfeits |
| A `claim` | At least 29 TGas attached with 1,000 seats |
| An `unstake` that pays out | At least 54 TGas attached with 1,000 seats |
| Each token or NFT transfer reserved | 15 TGas; callbacks 10 TGas; the unstake payout callback 35 TGas |

## Security properties checked by tests

Every restricted method refuses a stranger and every callback refuses a direct call; a fake NFT collection cannot stake seats and a call to `nft_on_transfer` made directly is refused; a fake token cannot add revenue; a seat staked by an approved relayer belongs to its real owner; two claims or two unstakes sent at once pay once; a failed NFT return restores the seat; a seat that asked to leave is never drawn; a serving seat cannot leave or claim; a silent juror forfeits exactly what the seat earned while serving and a juror who voted keeps everything; and, over 60 random sequences of stakes, revenue, draws, forfeits and claims, no unit of revenue is created or lost beyond dust. See `AUDIT.md`.

## Things to know

| Topic | Detail |
|---|---|
| Legal | Seats that earn a share of platform revenue are the shape most securities law treats as an investment. Nothing is minted or sold, and selling seats needs counsel first. The revenue share and juror pay are kept separate. |
| The seat cap number is not chosen | The tests use small values. A real deployment needs a number. |
| More than 1,000 seats | The draw reads every seat, so a bigger collection needs a different draw. Not built; it depends on the planned collection size. |
| An account is not a person | The cap does not stop one person using many wallets. |
| Unstaked NFTs earn nothing | Only staked seats earn and can be drawn. |
| No outside audit | The only review is the self-review in `AUDIT.md`. |
