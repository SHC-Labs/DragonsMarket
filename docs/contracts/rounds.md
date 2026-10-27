# rounds

**Up and Down rounds, 2026-10-26.** A new contract for the short crypto markets (5-minute BTC, ETH and NEAR). It is
parimutuel: the side that was right shares the other side's pool less a fee, so there is no seed and the treasury is
never the counterparty. Prices come from publishers signing the price at fixed moments, checked k of n, with no bond,
challenge or jury. State version 1. Not yet in the reproducible build or the release; see "Not built yet".

Source: `rounds/src/lib.rs`. The publisher signature check is `price-signatures/src/lib.rs`, the same check the oracle
makes on a signed price. The upgrade path is the shared `upgrade/src/lib.rs`.

## What it is

A **series** is one asset cut into rounds of one interval: `asset` (a short lowercase name such as `btc-usd`),
`decimals` of the price, `first_start`, `interval` and `price_window`, all fixed when it is added. Round `r` starts at
`first_start + r * interval` and ends where round `r + 1` starts.

- **Stakes.** Round `r` takes stakes while round `r - 1` runs, from its `start - interval` up to its start, so exactly
  one round of a series takes stakes at a time and nobody stakes knowing either price. An account backs one side of a
  round; a second stake on the same side adds to the first. The least stake is 0.1 of the 6-decimal collateral.
- **Prices.** The price at the start of round `r` is the start price of `r` and the end price of `r - 1`, so one signed
  price serves two rounds. It can be recorded from that moment until `price_window` later, by anyone, with signatures
  from at least `price_threshold` publishers. The first quorum recorded is final.
- **Outcome.** Up if the end price is above the start price, Down if below. A tie, a round with an empty side, or a
  round whose start or end price was not recorded inside its window is a Refund: every stake comes back in full and no
  fee is taken.
- **Payout.** A winning stake gets `stake + stake * (losing pool - fee) / winning pool`, rounded down. A losing stake
  gets nothing. The fee is `fee_bps` of the losing pool only, so a winner never gets back less than the stake.

## Roles

| Role | Can |
| --- | --- |
| Owner (the DAO) | Everything below, plus the upgrade, `seal`, ownership handover, the operator, `set_fee_bps`, `set_registration_fee`, `add_publisher`, `set_price_threshold`, `reconcile_withdrawal` |
| Operator | `add_series`, `set_paused`, `remove_publisher` (cutting off a leaked key needs no vote) |
| The verifier | `mt_on_transfer` (money in) and `on_auth` (signed actions) |
| Anyone | `record_price` with valid signatures, `settle_round`, `claim` for any account, the views |

## Starting it up: `new`

`new(owner_id, operator_id, verifier_id, collateral_token_id, network, price_threshold)`, callable only by the contract
account. `collateral_token_id` must be `nep141:<token>`, `network` a short lowercase word (it is part of every signed
message), and `price_threshold` at least 1. Publishers are added after, by the owner.

## Money in: `mt_on_transfer`

The verifier calls it after a transfer to this contract with a message. A panic makes the verifier refund the sender.

| Message | Does |
| --- | --- |
| `register` | Registers the sender. The registration fee (0.25 to start) goes to fees and the rest to the balance |
| `deposit` | Credits the balance of a registered account |
| `stake:<series>:<round>:<up\|down>` | Stakes the whole amount |

## Signed actions: `on_auth`

An Intents `auth_call` signed by the account. The verifier checks the signature, nonce and deadline before it calls.

| Message | Does |
| --- | --- |
| `stake:<series>:<round>:<up\|down>:<amount>` | Stakes out of the balance |
| `withdraw:<amount>` | Pays the balance to the signer's own Intents account |

An account with a NEAR key can do the same with `stake(series_id, round, side, amount)` and `withdraw(amount)`, each
with exactly 1 yocto. `claim(series_id, round, account_id)` needs no signature: it only ever moves a payout into the
stake's own balance, so a relayer or keeper can claim for everyone.

## Prices: `record_price`

`record_price(series_id, round, price, signatures)` records the price at the start of `round`. `signatures` lists
`<publisher key>.<signature in hex>` entries, comma separated, each an ed25519 signature over exactly:

    round-price:v1:<this contract>:<network>:<asset>:<moment in ns>:<price>:<decimals>

so a signature is good for one price of one asset at one moment on one contract and network. It is refused before its
moment, after its window, with fewer than the threshold of valid signatures, with any malformed, repeated or unknown
entry, or when no round with stakes still needs it. Two rounds that use the same moment always get the same price,
because one call writes both.

## Settling and claiming

`settle_round` fixes the outcome the first time it can be decided and moves the fee out of the round. `claim` settles
first if needed, pays the stake and deletes its record, which frees one of the account's open-stake slots. A settled
outcome never changes. Because a price is accepted only inside its window, whether a round refunds for a missing price
is decided by the deadline itself and never by who calls first after it.

## Fees

`fee_bps` starts at 300 (3% of the losing pool) and the owner can set 0 to 1,000. A round pays the rate in force when it
took its first stake. Registration fees and round fees collect in `fees`, counted in `total_owed`.

## Storage

Measured by `measure_an_account_at_its_open_stake_limit`, keys and record overhead included:

| Record | Bytes | NEAR at 1e19 per byte |
| --- | --- | --- |
| A registration, account and balance, at the longest account id | 238 | 0.00238 |
| A stake at the longest account id | 138 | 0.00138 |
| A round at its largest | 142 | 0.00142 |

An account holds at most 20 open stakes, so one account costs the contract at most 2,998 bytes (about 0.03 NEAR), which
the registration fee is set to cover. Rounds are stored only once someone stakes. Every new record must leave a 1 NEAR reserve
after storage; the operator tops the account up.

## Views

`config`, `get_series(series_id)`, `next_round(series_id)` (the round taking stakes now), `get_round(series_id, round)`,
`get_stake(series_id, round, account_id)`, `get_account(account_id)`, `get_balance(account_id)`,
`is_registered(account_id)`, `total_owed`, `owed_breakdown`, `is_staged(code_hash)`.

`total_owed` is balances plus what every round has left plus fees plus withdrawals waiting on their callback. The keeper
compares it with the verifier's `mt_balance_of` for this account; more there is surplus, less is an incident.

## Events

Standard `rounds`, version 1.0.0: `registered`, `deposit`, `staked`, `price_recorded` (with the signers),
`round_settled` (outcome, reason `price`, `tie`, `one_sided` or `no_price`, and fee), `claimed`, `withdraw`,
`withdraw_confirmed`, `withdraw_failed`, `withdrawal_reconciled`, `series_added`, `publisher_added`,
`publisher_removed`, `price_threshold_set`, `fee_set`, `registration_fee_set`, `paused_set`, `operator_set`,
`owner_proposed`, `owner_changed`, `code_staged`, `upgrade_sent`, `migrated`, `seal_sent`.

## Security properties checked by tests

- No round pays out more than it took, every unit is in a balance, a round, the fees or a pending withdrawal, and a
  winner never gets back less than the stake (property test over random stakes and every ending).
- A signature over another asset, decimals, moment, contract, network or price records nothing.
- One signature short of the threshold, a repeated publisher or a key that is not a publisher records nothing, and the
  first quorum for a moment is final.
- Only the verifier can bring money in or act for a signer, and a signed stake cannot spend more than the balance.
- Against the real verifier: accounts with no NEAR register, stake, win and withdraw by signed intents, a replayed
  withdrawal is refused, and the contract's books equal its verifier balance at every step.
- The source guard allows one verifier interface, `mt_transfer`, called once, from the withdrawal to the account whose
  balance it came from.

## Not built yet

- **The fee sweep.** Fees collect and are counted, but nothing sends them to the Council and the treasury yet. That
  is why this contract is not in the reproducible build or the release.
- **The publisher service.** The tests sign fixed prices with fixture keys. The real service signs the median of
  Binance, Coinbase and Kraken at each moment.
- **Pruning.** Settled rounds stay stored after every stake is claimed, and a losing stake stays until someone claims
  it (paying nothing). A keeper can clear losers with `claim`; deleting empty rounds is not built.
- **Leaving.** There is no unregister. The registration fee is not refunded in any case.
- **A per-series stop.** The operator's pause stops every series at once.
