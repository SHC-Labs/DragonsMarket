# rounds

A contract for the short crypto markets (5-minute
BTC, ETH and NEAR). A round takes stakes while it runs, until `close_before` ahead of its end, and prices each stake by
dynamic parimutuel: a stake buys shares of its side at the price the round has reached, and the side that was right
shares the pool less a fee. There is no seed and the treasury is never the counterparty. Prices come from publishers
signing the price at fixed moments, checked k of n, with no bond, challenge or jury. State version 3. It is in the
reproducible build and the release list.

Source: `rounds/src/lib.rs`. The pricing maths is the `dpm` crate (`dpm/src/lib.rs`), the same one the market prices
with. The publisher signature check is `price-signatures/src/lib.rs`, the same check the oracle makes on a signed price.
The upgrade path is the shared `upgrade/src/lib.rs`.

## What it is

A **series** is one asset cut into rounds of one interval: `asset` (a short lowercase name such as `btc-usd`),
`decimals` of the price, `first_start`, `interval`, `price_window` and `close_before`, all fixed when it is added. Round
`r` starts at `first_start + r * interval` and ends where round `r + 1` starts. The interval is at least five minutes.
`close_before` is at least half the interval and less than the whole interval (so a round always has a staking window),
and each series sets its own. The floor exists because a staker who sees the price move late in a round wins too often:
about 75% when stakes close half an interval before the end, 85% to 96% with a 60 second cutoff on a 5-minute or longer
interval. Both limits are checked in `add_series`, the only place a series is made; a series is never edited.

- **Stakes.** Round `r` takes stakes from its start until `close_before` ahead of its end, so stakes come in while the
  price moves and stop before the last seconds decide it. Between that close and the end no round of the series takes
  stakes. A stake is refused once the round's start price is neither recorded nor still recordable. An account backs one
  side of a round; a second stake on the same side adds to the first. The least stake is 0.1 of the 6-decimal
  collateral.
- **Pricing.** Each round prices like a market: the cost of the shares outstanding is `C = sqrt(up^2 + down^2)`, and a
  stake of `a` grows its side until `C` has grown by `a`. The first stake in a round buys a share a unit; after that a
  side costs more the more of it is held, `up^2 / (up^2 + down^2)` for Up, and a share never costs more than a unit.
  Every stake names the fewest shares it takes, and `quote_stake` says how many an amount buys now.
- **Prices.** The price at the start of round `r` is the start price of `r` and the end price of `r - 1`, so one signed
  price serves two rounds and is stored once. It can be recorded from that moment until `price_window` later, by
  anyone, with signatures from at least `price_threshold` publishers (2 on the deployed contract), while one of the two
  rounds holds open stakes. The first quorum recorded is final. When the round before had no stakes, a round's start price can be recorded only after
  its first stake, inside the same window.
- **Outcome.** Up if the end price is above the start price, Down if below. A tie, a round with an empty side when its
  stakes close, or a round whose start or end price was not recorded inside its window is a Refund: every stake comes
  back in full and no fee is taken.
- **Payout.** A winning stake gets `shares * (pool - fee) / winning shares`, rounded down, where the pool is everything
  staked in the round. A losing stake gets nothing. The fee is `fee_bps` of what the losing side paid, but never so much
  that the pool keeps less than a unit for each winning share, so a winner never gets back less than the stake.

## Roles

| Role | Can |
| --- | --- |
| Owner (the DAO) | Everything below, plus the upgrade, `seal`, `remove_verifier_key`, ownership handover, the operator, `set_fee_bps`, `set_registration_fee`, `set_treasury`, `add_publisher`, `set_price_threshold`, `reconcile_withdrawal` |
| Operator | `add_series`, `set_paused`, `remove_publisher` (cutting off a leaked key needs no vote) |
| The verifier | `mt_on_transfer` (money in) and `on_auth` (signed actions) |
| The collateral token | `ft_on_transfer` (money in by `ft_transfer_call`) |
| Anyone | `record_price` with valid signatures, `settle_round`, `claim` for any account, `storage_deposit` for any account, `sweep_fees`, the views |

The owner may also call `set_publishers(publishers: Vec<PublicKey>, threshold: u32)` with zero
deposit and 30 TGas. It atomically replaces the publisher set and quorum, including 1-of-1
rotation or expansion. The complete set must contain 1 to 25 distinct Ed25519 keys, with a
threshold strictly above half and no greater than its size. It emits `publishers_set`.
Removed keys cannot authorize new submissions; already-recorded prices are unchanged.

## Starting it up: `new`

`new(owner_id, operator_id, verifier_id, collateral_token_id, network, price_threshold)`, callable only by the contract
account. `collateral_token_id` must be `nep141:<token>`, `network` a short lowercase word (it is part of every signed
message), and `price_threshold` at least 1. Publishers are added after, by the owner, and series by the operator with
`add_series(asset, decimals, first_start, interval, price_window, close_before)`. `price_window` is between 1 minute and
1 day. The deployed series use 120 seconds (series 1) and 290 seconds (series 2 and 3).

## Money in: `mt_on_transfer`

The verifier calls it after a transfer to this contract with a message. A panic makes the verifier refund the sender.
On every path a message carries exactly the parts its action takes, and one with more is refused, so a signed stake
sent with its money cannot be read as a stake with a different minimum.

| Message | Does |
| --- | --- |
| `register` | Registers the sender. The registration fee (0.25 to start) goes to fees and the rest to the balance |
| `deposit` | Credits the balance of a registered account |
| `stake:<series>:<round>:<up\|down>:<min shares>` | Stakes the whole amount, refused if it buys fewer than `min shares` |

## Money in by token: `ft_on_transfer`

For an account that holds the collateral token itself and nothing in Intents. It registers in NEAR first (below), then
calls `ft_transfer_call(receiver_id: <this contract>, amount, msg)` on the token with 1 yocto and 300 TGas. The token
goes whole into this contract's own Intents account, and the callback credits what the verifier took and hands back the
rest. Every refusal comes before the forward, so a refused transfer comes back whole. At least 75 TGas must reach the
hook (`attach at least 75 TGas`): 50 for the forward, 20 for the callback, which may start a stake, and 5 for its own
work. Measured in the sandbox, 84 TGas on the token call is the least that clears it, and a stake by token burns about
7.4 TGas in this contract. That holds for a token that passes all its unused gas on; one built on an older
`near-contract-standards` keeps a fixed 30 TGas for itself, so 100 TGas leaves it short.

| Message | Does |
| --- | --- |
| `deposit` | Credits the balance |
| `deposit_for:<account>` | Credits the balance of another registered account, at least the minimum stake. The deposit event names the sender as `from`, and a refusal before the forward still refunds the sender |
| `stake:<series>:<round>:<up\|down>:<min shares>` | Credits the balance, then stakes the whole amount through `stake_credited`, a private method, in its own receipt with 10 TGas. A stake the round refuses by then, or one that would buy fewer than `min shares`, stays in the balance |

`register` is not a message here: an account that pays by token registers in NEAR.

## Registering in NEAR: NEP-145

`storage_deposit(account_id)` with 0.05 NEAR registers `account_id`, or the caller, and takes no registration fee.
Anyone can pay for another account. Whatever is attached above 0.05 goes back to the payer, all of it for an account
that is already registered. The contract records who paid; a deposit the verifier relays counts as paid by the account
it was for, so nothing is ever sent to the verifier. `storage_balance_bounds` is 0.05 both ways, so nothing is ever
available to `storage_withdraw`.

`storage_unregister` with exactly 1 yocto closes an account with no open stakes, no balance and no withdrawal in flight.
The 0.05 NEAR goes back to the recorded payer. An account with no recorded payer, one that registered with the fee or
before version 3, gets only its yocto: the fee is never returned. `force` is refused. A pause refuses `storage_deposit`
like every other way in.

## Signed actions: `on_auth`

An Intents `auth_call` signed by the account. The verifier checks the signature, nonce and deadline before it calls.

| Message | Does |
| --- | --- |
| `stake:<series>:<round>:<up\|down>:<amount>:<min shares>` | Stakes out of the balance |
| `withdraw:<amount>` | Pays the balance to the signer's own Intents account |

An account with a NEAR key can do the same with `stake(series_id, round, side, amount, min_shares)` and
`withdraw(amount)`, each with exactly 1 yocto. `claim(series_id, round, account_id)` needs no signature: it only ever
moves a payout into the stake's own balance, so a relayer or keeper can claim for everyone.

## Prices: `record_price`

`record_price(series_id, round, price, signatures)` records the price at the start of `round`. `signatures` lists
`<publisher key>.<signature in hex>` entries, comma separated, each an ed25519 signature over exactly:

    round-price:v1:<this contract>:<network>:<asset>:<moment in ns>:<price>:<decimals>

so a signature is good for one price of one asset at one moment on one contract and network. The call is refused:

| When | Refusal |
| --- | --- |
| Before its moment | "that moment has not come" |
| After its window | "too late to record that price" |
| That moment already has a price | "that price is already recorded" |
| Neither its round nor the round before holds open stakes | "no open round needs that price" |
| Fewer valid signatures than the threshold | "not enough valid publisher signatures" |
| A key that is not a publisher | "not a publisher" |
| One publisher listed twice | "a publisher signed twice" |
| A signature over any other message | "a signature does not match" |

Any bad entry refuses the whole submission. Two rounds that use the same moment always get the same price, because it is
stored once.

## Settling and claiming

`settle_round` fixes the outcome the first time it can be decided, never before the round's stakes close, and moves the
fee out of the round. `claim` settles first if needed, pays the stake and deletes its record, which frees one of the
account's open-stake slots. A settled outcome never changes. Because a price is accepted only inside its window, whether
a round refunds for a missing price is decided by the deadline itself and never by who calls first after it.

## Fees

`fee_bps` starts at 300 (3% of what the losing side paid) and the owner can set 0 to 1,000. A round pays the rate in
force when it took its first stake. Registration fees and round fees collect in `fees`, counted in `total_owed`.

The owner names a treasury with `set_treasury`. `sweep_fees` is open to anyone and needs at least 60 TGas attached. It
moves all fees to the treasury's balance and pays them out as an ordinary withdrawal. It is refused with "the owner has
not named a treasury" before one is set and with "no fees to sweep" when the treasury has nothing to send. If the
transfer fails, the money stays on the treasury's balance for the next sweep.

## Upgrading

`stage_code` takes the wasm as its call input and holds about 1 NEAR per 100 KB of code in the contract. The deposit is
not refunded when the upgrade runs. `upgrade` is owner only and needs at least 100 TGas attached. A failed or rolled-back upgrade consumes the staged
code, so stage it again. `migrate` accepts state versions 1, 2 and 3 and runs only inside an upgrade. Version 1 had no
treasury. It refuses while the price threshold is not more than half of the publishers. `seal` needs a proven upgrade.

## Storage

Measured by `measure_an_account_at_its_open_stake_limit`, keys and record overhead included:

| Record | Bytes | NEAR at 1e19 per byte |
| --- | --- | --- |
| A registration with the fee, account and balance, at the longest account id | 238 | 0.00238 |
| A registration in NEAR, with who paid and its balance, at the longest account ids | 415 | 0.00415 |
| A stake at the longest account id | 154 | 0.00154 |
| A round at its largest | 140 | 0.0014 |
| A price | 69 | 0.00069 |

An account holds at most 20 open stakes. One that registered with the fee costs the contract at most 3,318 bytes (about
0.033 NEAR), which the registration fee is set to cover. One that registered in NEAR takes at most 3,495 bytes (about
0.035 NEAR), inside its 0.05 NEAR deposit; the test checks that it fits. Rounds are stored only once someone stakes,
and a price only while a round with stakes needs it. Every new record must leave a 1 NEAR reserve after storage; the
operator tops the account up.

## Views

`config`, `get_series(series_id)`, `next_round(series_id)` (the round taking stakes now, or the next to open),
`open_rounds(from_index, limit)` (that round for each series, with the asset and the moments it opens and closes),
`get_round(series_id, round)` (shares, what each side paid, and the outcome once a call has settled it),
`round_outcome(series_id, round)` (the outcome a claim would settle now, or null, and it settles nothing),
`get_price(series_id, round)` (the price at its start),
`quote_stake(series_id, round, side, amount)` (the shares that amount buys now), `get_stake(series_id, round,
account_id)`, `get_account(account_id)`, `get_balance(account_id)`, `is_registered(account_id)`, `total_owed`,
`owed_breakdown`, `is_staged(code_hash)`, `storage_balance_of(account_id)`, `storage_balance_bounds`. `config` includes
the registration fee and the storage deposit.

`total_owed` is balances plus what every round has left plus fees plus withdrawals waiting on their callback. The keeper
compares it with the verifier's `mt_balance_of` for this account; more there is surplus, less is an incident.

## Events

Standard `rounds`, version 1.0.0: `registered` (with `fee` for a registration with the fee, `paid_by` for one in NEAR),
`unregistered` (with `deposit_to`), `deposit`, `staked` (with the shares bought and both sides' shares
after it), `price_recorded` (with the signers), `round_settled` (outcome, reason `price`, `tie`, `one_sided` or
`no_price`, and fee), `claimed` (with the stake's shares), `withdraw`, `withdraw_confirmed`, `withdraw_failed`,
`withdrawal_reconciled`, `series_added`, `publisher_added`, `publisher_removed`, `price_threshold_set`, `fee_set`,
`registration_fee_set`, `treasury_set`, `fees_swept`, `paused_set`, `operator_set`, `owner_proposed`, `owner_changed`,
`code_staged`, `upgrade_sent`, `upgrade_failed`, `migrated`, `seal_sent`, `verifier_key_removal_sent`.

## Operator note: one-sided rounds

A round with an empty side when its stakes close refunds everyone. A 0.1 USDC ticket on the thin side turns a lopsided
round into a coin flip: the thin side now exists, so the round pays out instead of refunding, and the ticket's owner
holds a cheap stake on whichever side is likely to lose. Operators should seed the thin side of a series themselves or
accept that risk. The contract does nothing about it.

## Security properties checked by tests

- No round pays out more than it took, every unit is in a balance, a round, the fees or a pending withdrawal, and a
  winner never gets back less than the stake (property test over random stakes and every ending, and a round whose
  losing side paid almost nothing, where the fee cap is what holds it).
- A stake before its round starts, at or after its close, or whose start price can no longer be recorded is refused,
  and so is one that would buy fewer shares than it names.
- A signature over another asset, decimals, moment, contract, network or price records nothing.
- One signature short of the threshold, a repeated publisher or a key that is not a publisher records nothing, and the
  first quorum for a moment is final.
- Only the verifier can bring money in or act for a signer, and a signed stake cannot spend more than the balance.
- Only the collateral token can bring money in by token, never on the verifier's behalf and only with gas for the
  forward. A transfer from an account that is not registered, or with a stake the round would refuse, is refused before
  the forward. The contract owes exactly what the verifier took (property test over every report the verifier can give),
  and an account that leaves while its token is on the way keeps that money.
- An account leaves only with no open stake, balance or withdrawal in flight, and the NEAR deposit goes back to whoever
  paid it.
- Against the real verifier: accounts with no NEAR register, stake inside the round, win and withdraw by signed
  intents, a replayed withdrawal is refused, stakes before the start and at the close are refused, and the contract's
  books equal its verifier balance at every step.
- Against the real verifier and token: an account with nothing in Intents registers in NEAR, deposits and stakes by
  token, wins, withdraws and leaves with its deposit back; a refused transfer comes back whole; a stake by token with
  just enough gas completes; a stake the round refuses stays a balance; and the callbacks that credit and spend
  balances refuse outside callers.
- The source guard allows one verifier interface, `mt_transfer`, called once, from the withdrawal to the account whose
  balance it came from, and one token call, the forward of the whole amount to the verifier for this contract's own
  account.

## Not built yet

- **Selling.** A stake is held to the end of its round.
- **Pruning.** Settled rounds and their prices stay stored after every stake is claimed, and a losing stake stays until
  someone claims it (paying nothing). A keeper can clear losers with `claim`; deleting empty rounds is not built.
- **A per-series stop.** The operator's pause stops every series at once.
