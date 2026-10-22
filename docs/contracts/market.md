# market

Target decision, 2026-10-20: Trezu/SputnikDAO replaces custom governance. Earned platform fees
allocate 75% to the Trezu treasury and 25% to Council-controlled NFT rewards backed in Intents.
See [the architecture](../intents-architecture.md).

Status, 2026-10-21, fee split built (R-03): a sweep records both legs under a sweep id before it
sends either, each leg has its own status, the Council takes each sweep id once, and a lost Council
result is settled from the Council's own record. The treasury and the Council's account are not
written in the code and are not arguments of `new`: the owner sets them with `set_fee_recipients`,
and a sweep refuses until it has. The 75/25 split is a share in basis points the owner can move
(2,500 to start). `business_wallet` is now `treasury`. State version 2. See "Fees".

Status, 2026-10-20, phase I2 of the Intents migration: the money path in this manual is the NEAR
Intents path. The market keeps all its backing in its own account inside the Intents verifier. Money
arrives through the verifier's `mt_transfer_call`, which calls `mt_on_transfer` here, and leaves
through `mt_transfer` and `mt_transfer_call` from this contract, with no signed intent and no key
registered in the verifier. The DAO voting period is the only delay before an owner action
(decided 2026-10-21, R-07). Oracle bonds still use a NEP-141 token and are the next phase.

Source: `market/src/lib.rs` (the contract) and `market/src/curve.rs` (the pricing maths). Written
2026-10-18 from the code as it stands, including everything added that day. The upgrade path was
added 2026-10-19 and the shared helpers are in `upgrade/src/lib.rs`. The halt rule, the Void price
fallback, `seeded` and the new statuses, and the upgrade mark were added 2026-10-20. For current behaviour, follow the code. For required target behaviour, follow the accepted
spec and the implementation requirements below; differences are work to complete.

---

## Required changes for the product target

See [requirements R-01, R-02, R-03 and R-08](../spec.md#requirements-to-implementation-map).
These are required capabilities, not claims that new methods already exist.

- Done in I2: position issuance and release are backed by the market's own Intents account, funded
  by `mt_transfer_call` and paid by `mt_transfer`. Still open: single-use operation references and
  authenticated settlement for signed intents, which this contract does not accept.
- Done 2026-10-21 (R-03): earned fees are separate from backing, the 75% treasury / 25% Council
  allocation is recorded per sweep, and each transfer leg moves through pending, settled, refused or
  unresolved without duplication. Not built here: verifying the treasury account on chain (the owner
  and the helper in `contracts/keeper` check it before `set_fee_recipients`).
- Expose position backing, user availability, fee liabilities and operation status through reviewed
  views/events. Existing NEP-141 balance reads must not stand in for verifier-held funds.
- Migrate owner-authorised settings and upgrades to the verified Trezu/Sputnik execution path. The
  owner is just an account here, so nothing in the contract is specific to a DAO. DECIDED
  2026-10-21: no delay between approval and execution will be built. The DAO voting period is the
  only delay (R-07).

The handoff must specify the exact ABI, state layout, permissions, events, migration and failure
recovery. Existing method signatures can change if needed to meet the target; retain regression
coverage for the pricing and payout rules that are kept.

---

## Contents

1. [What it is](#what-it-is)
2. [Where it sits among the other contracts](#where-it-sits-among-the-other-contracts)
3. [Roles: who can do what](#roles-who-can-do-what)
4. [Starting it up: `new`](#starting-it-up-new)
5. [Units and conventions](#units-and-conventions)
6. [A market's life](#a-markets-life)
7. [What a market stores](#what-a-market-stores)
8. [Every method](#every-method)
9. [Upgrading this contract](#upgrading-this-contract)
10. [How trading works](#how-trading-works)
11. [Fees](#fees)
12. [Void](#void)
13. [Seeding at a chosen price](#seeding-at-a-chosen-price)
14. [Price markets](#price-markets)
15. [The rule hash](#the-rule-hash)
16. [Winning and getting paid](#winning-and-getting-paid)
17. [The invariant](#the-invariant)
18. [Views (free to call)](#views-free-to-call)
19. [Events](#events)
20. [What can go wrong, and the message you will see](#what-can-go-wrong-and-the-message-you-will-see)
21. [Gas the contract reserves for its own calls](#gas-the-contract-reserves-for-its-own-calls)
22. [Security properties checked by tests](#security-properties-checked-by-tests)
23. [Things to know](#things-to-know)

---

## What it is

market is the trading contract. It holds the money, lists the markets, prices every trade, and pays
people out after a market resolves.

A market is one yes or no question. People buy Yes shares or No shares. When the question is
answered, each winning share pays exactly one unit of the collateral token and each losing share
pays nothing. If the question cannot be answered, the market is Void and each share pays the
market's closing price instead (see "Void").

It does not decide outcomes. A separate contract, oracle, does that, and market only accepts an
outcome from it.

---

## Where it sits among the other contracts

| Contract                                                   | Relationship to market                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| oracle                                                     | Registers every new market with it, and is the only account allowed to set an outcome. |
| council                                                    | Receives 25% of the trading fees as revenue for its staked NFT seats.                  |
| The owner (the DAO)                                        | Trezu/SputnikDAO. It holds the owner role. SputnikDAO executes a proposal at the approval that reaches its threshold, and its voting period is the only delay (decided 2026-10-21). |
| The NEAR Intents verifier (in tests the real `defuse` build) | Holds every unit of backing in this contract's own account. The collateral is `nep141:<token>` inside it, in tests the `mock-ft` token. |

Money enters market when a user calls `mt_transfer_call` on the verifier with this contract as the
receiver, and leaves by `mt_transfer` and `mt_transfer_call` that this contract sends to the verifier
as itself. NEAR itself is only used for the 0.05 NEAR storage deposit, which this phase leaves as it
was.

---

## Roles: who can do what

There are four kinds of caller. The first three are stored accounts, the fourth is anyone.

| Role     | Set by                                         | Can do                                                                                                                                                                                                                                                                               |
| -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner    | `new`, then `propose_owner` and `accept_owner` | Everything the operator can, plus `set_operator`, `propose_owner`, `set_fee_recipients`, `set_revenue_share_bps`, `set_min_sweep`, `set_next_sweep_id`, `set_fee_rate_bps`, `set_create_fee`, `reconcile_leg`, `upgrade` and `seal`. In a real deployment this is the DAO, so each of these needs a DAO proposal. SputnikDAO executes a proposal at the approval that reaches its threshold. Its voting period is the only delay, by owner decision (R-07). |
| Operator | `new`, then `set_operator` (owner only)        | Routine running: `create_market`, `retry_register`, `halt` (but not in the last 24 hours before a market closes, see "Void"), `resume`, `set_paused`, `claim_residual`, and seeding a market. Cannot move fees, change owner, change the operator, or touch user money.              |
| Oracle   | `new` (fixed, no setter)                       | Only `set_outcome`.                                                                                                                                                                                                                                                                  |
| Anyone   | n/a                                            | Trade, deposit, withdraw, redeem, register for storage (for themselves or for someone else) and unregister, `void_if_unresolved` (a grace period after `resolve_by`), `sweep_fees`, `stage_code` (paying for the storage), and every view.                                           |

The operator is meant to be a fast key held by a person or a bot, so that day to day work does not
wait on a DAO proposal. If it is stolen, the damage is limited: the thief can halt markets and
pause the contract, but cannot take money, redirect fees, or keep the key, because the owner can
replace it. Users can still withdraw and redeem while the contract is paused or a market is halted.

Two accounts are not roles but matter: `revenue_pool` (the council contract, receives the Council's
share of fees, 25% to start) and `treasury` (receives the rest of the fees and the leftover of
resolved markets). Neither is set at deploy. Only the owner sets and changes them, and a sweep refuses
until it has.

---

## Starting it up: `new`

Called once, at deploy. It cannot be called again (the contract refuses a second initialisation).
Only the contract's own account can call it: `new` is `#[private]`, so a deploy and init batch
signed by that account is the one way in, and anyone else gets `Method new is private`, whoever
deployed the contract.

| Argument           | Meaning                                             |
| ------------------ | --------------------------------------------------- |
| `owner_id`         | The owner. Normally the DAO.                        |
| `operator_id`      | The operator.                                       |
| `oracle_id`        | The oracle contract.                                |
| `verifier_id`      | The Intents verifier that holds the backing, `intents.near` on mainnet. |
| `collateral_token_id` | The collateral's exact id in the verifier, `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (native USDC) on mainnet. Must start with `nep141:` (`the collateral token id must look like nep141:<token>`). The bare contract id and other spellings have no balance in the verifier. |

`new` takes no fee recipient. The treasury is the Trezu account, which does not exist when the
contract is deployed, so the owner sets both recipients afterwards with `set_fee_recipients`.

Starting values: trade fee rate 200 basis points (2%), creation fee 1,000,000 units, Council share
of a sweep 2,500 basis points (25%), minimum sweep 1,000,000 units, first sweep id 1, not paused, no
markets, no fee recipients.

Deploy and initialise in one batch signed by the contract account, and check afterwards that the
owner is yours. A deploy with no init in the batch leaves nothing open to a stranger, but it leaves
the contract unusable until its own account calls `new`.

---

## Units and conventions

| Thing               | Convention                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Collateral amounts  | Raw integer units of the token. The code assumes a 6-decimal token, so 1,000,000 units is 1 token.                    |
| Shares              | Integers. One share of the winning outcome redeems for exactly 1 raw unit.                                            |
| Prices              | Integers in millionths. 1,000,000 means 1.00 and 500,000 means 50 cents. Yes price plus No price is always 1,000,000. |
| Times               | Nanoseconds since the Unix epoch, as the chain reports them. Passed in JSON as strings (`U64`).                       |
| Big numbers in JSON | `U64` and `U128` travel as strings, for example `"1000000"`.                                                          |
| Fee rates           | Basis points. 200 is 2%.                                                                                              |

---

## A market's life

1. The operator calls `create_market`. The market exists but cannot trade. The contract asks oracle
   to register it.
2. The oracle's answer comes back in a callback, and the market is marked `registered`. If the
   oracle refused or the call failed, the market stays shut and `retry_register` can send it again.
3. The operator (or owner) seeds it by sending collateral with the message `seed:<id>`. This opens
   the market for trading.
4. People trade until `close_at`. At the exact moment of close trading stops.
5. After close, someone proposes an outcome through oracle. Once the oracle has a final answer it
   calls `set_outcome`. If nothing has resolved the market by `resolve_by`, anyone asks the oracle
   for its deadline answer (`resolve_by_deadline`), which settles what can be settled and voids the
   rest. `void_if_unresolved` on this contract opens 7 days after `resolve_by`, for an oracle that
   is gone.
6. Holders call `redeem` to turn shares into balance, and `withdraw` to take the balance out as
   tokens. The operator or owner calls `claim_residual` to move whatever the pool still holds to the
   business wallet.

The `status` shown by the views is, in this order of precedence: `resolved` if an outcome is set,
otherwise `halted` if halted, otherwise `closed` if the time has passed `close_at`, otherwise
`unregistered` if the oracle has not confirmed the market, otherwise `unseeded` if it has no
liquidity, otherwise `open`. Only `open` can trade. `registered` and `seeded` are in the view as
well.

---

## What a market stores

| Field                                                    | Meaning                                                                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`, `rule_text`, `resolution_source`, `void_policy` | The question and its rules, in words. Required, non-empty, with length limits below.                                                                                                   |
| `category`, `subcategory`                                | Short lowercase slugs such as `crypto` and `bitcoin`.                                                                                                                                  |
| `rule_hash`                                              | A fingerprint of the rules, fixed at creation. See "The rule hash".                                                                                                                    |
| `price_rule`                                             | Optional. Makes this a price market. See "Price markets".                                                                                                                              |
| `close_at`                                               | When trading stops.                                                                                                                                                                    |
| `resolve_by`                                             | The deadline for an answer. After it, anyone can ask the oracle for the deadline answer, and 7 days later anyone can void the market here.                                             |
| `halted`                                                 | Set by `halt`. Stops trading.                                                                                                                                                          |
| `registered`                                             | True once the oracle has accepted the market.                                                                                                                                          |
| `seeded`                                                 | True once opening liquidity exists.                                                                                                                                                    |
| `outcome`                                                | Empty until resolved, then Yes, No or Void.                                                                                                                                            |
| `void_price_yes`                                         | Set only when the outcome is Void. See "Void".                                                                                                                                         |
| `pool_yes`, `pool_no`                                    | The two sides of the pricing pool.                                                                                                                                                     |
| `locked`                                                 | All collateral held for this market.                                                                                                                                                   |
| `user_yes`, `user_no`                                    | Total shares held by users (and the seeder), per side.                                                                                                                                 |
| `residual_claimed`                                       | True once `claim_residual` has run.                                                                                                                                                    |
| `history`                                                | The last 120 prices, one per seed, buy and sell, for drawing a chart. Chart only.                                                                                                      |
| `twap`                                                   | A running time-weighted price used for Void, kept as a sum of price times trading time and the trading time. It does not count time while the market is halted. Not shown by any view. |

### Limits

| Limit                      | Value                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Title                      | 200 bytes                                                                                                |
| Rule text                  | 2,000 bytes                                                                                              |
| Resolution source          | 300 bytes                                                                                                |
| Void policy                | 500 bytes                                                                                                |
| Category and subcategory   | 1 to 32 characters, lowercase letters, digits and hyphens only                                           |
| Shares entries per account | 20 (each market and side an account holds counts as one). The operator and the owner are not held to it. |
| Price history per market   | 120 points                                                                                               |
| `list_markets` page        | at most 50 per call                                                                                      |
| Pool size                  | each side at most 1,000,000,000,000,000 units (10^15)                                                    |

---

## Every method

### Setup and accounts

| Method                                                     | Who                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new(...)`                                                 | Deployer, once     | Initialises the contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `storage_deposit(account_id, registration_only)` (payable) | Anyone             | NEP-145. Registers `account_id`, or the caller when it is left out, and returns its `StorageBalance`. Needs at least 0.05 NEAR attached when the account is new. The 0.05 NEAR is kept to pay for the account's storage and anything above it goes back to the caller, who may be someone paying for another account. For an account that is already registered the whole deposit goes back. `registration_only` changes nothing, because the most an account can hold is the least it must. Registration is required to deposit, buy and sell. Both arguments are optional, but the call body must still be a JSON object, so send `{}` when passing neither. |
| `storage_withdraw(amount)` (payable, 1 yocto)              | Registered account | NEP-145. There is nothing above the flat deposit, so this returns the balance and refuses any amount above zero (`nothing above the 0.05 NEAR deposit to withdraw`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `storage_unregister(force)` (payable, 1 yocto)             | Anyone             | NEP-145. Closes the caller's account and sends back the 0.05 NEAR with the attached yocto. Returns `false` if the caller was not registered. Refused while the caller holds any share (`redeem or sell your positions first`) or any balance (`withdraw your balance first`). `force: true` is refused, because it would burn what the account holds. Selling everything can leave a share or two of rounding dust, so the way out for a finished position is to redeem it.                                                                                                                                                                                    |
| `storage_balance_bounds()` (view)                          | Anyone             | `min` and `max` are both 0.05 NEAR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `storage_balance_of(account_id)` (view)                    | Anyone             | `{total: 0.05 NEAR, available: 0}` for a registered account, `null` for any other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `is_registered(account_id)` (view)                         | Anyone             | Whether an account has registered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Owner and operator management

| Method                                              | Who                  | What it does                                                                                                                                                    |
| --------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propose_owner(new_owner)`                          | Owner                | Names a new owner. Nothing changes yet.                                                                                                                         |
| `accept_owner()`                                    | The proposed account | Completes the handover. Two steps so a mistyped account cannot lock everyone out. Until it is accepted, the old owner keeps full power.                         |
| `set_operator(operator_id)`                         | Owner                | Replaces the operator, effective at once.                                                                                                                       |
| `set_fee_recipients(revenue_pool, treasury)`        | Owner                | Sets where fees go: the Council and the treasury, which must be different accounts. A sweep refuses until it is called. Takes effect for the next sweep and also for any amount still owed to the old recipients, which is sent to whoever is set at sweep time. |
| `set_revenue_share_bps(revenue_share_bps)`          | Owner                | Sets the Council's share of every later sweep, from 1,000 to 5,000 basis points. The treasury gets the rest, so the whole of every fee is always accounted for. A sweep already made keeps its split. |
| `set_min_sweep(min_sweep)`                          | Owner                | Sets the least a sweep acts on, from 1 to 100,000,000 units. |
| `set_next_sweep_id(next_sweep_id)`                  | Owner                | Moves the id of the next sweep up, never down. A sweep id is used once and the Council refuses a repeat, so a market that replaces an old one starts above the ids the Council has taken. |
| `set_fee_rate_bps(fee_rate_bps)`                    | Owner                | Sets the trade fee rate. Refused above 500 (5%). Zero is allowed. Applies from the next trade.                                                                  |
| `set_create_fee(create_fee)`                        | Owner                | Sets the fee taken from each market's seed. Refused above 10,000,000 units (10 tokens). Zero is allowed. Applies from the next seed.                            |
| `reconcile_leg(sweep_id, leg, arrived)`             | Owner                | Decides a fee leg (`council` or `treasury`) that is still pending or unresolved an hour after its sweep. See "Revenue whose result was lost". |
| `upgrade(code_hash)`                                | Owner                | Deploys the staged wasm with that sha256 and runs its `migrate`, in one batch. Needs at least 100 TGas attached. See "Upgrading this contract".                 |
| `seal(public_key)`                                  | Owner                | Deletes that access key from this account. Refused until an upgrade has gone through `migrate`.                                                                 |

The ceilings (5% and 10 units) are written into the code, so even a captured owner cannot set a
fee above them. The bounds of the Council's share (10% to 50%) and of the minimum sweep are written
there too.

### Code

| Method                        | Who                 | What it does                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage_code()` (payable)      | Anyone              | The call input is a wasm. It is stored under its own sha256, which is returned. The deposit pays for the storage (1 NEAR per 100 KB) and the surplus is refunded. Staging code someone else staged costs nothing and changes nothing. Attach 100 TGas, because 250 KB burns about 31. |
| `migrate()`                   | The contract itself | Runs in the new code in the same batch as the deploy. Refuses unless `upgrade` marked the upgrade in flight. Reads the state as the one layout it knows, clears the mark, sets `upgrade_proven`, returns the state.                                                                   |
| `is_staged(code_hash)` (view) | Anyone              | Whether a wasm with that sha256 is staged.                                                                                                                                                                                                                                            |

### Running markets

| Method                                                                                                                     | Who               | What it does                                                                                                                                                                                   | Refused when                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_market(title, rule_text, resolution_source, void_policy, category, subcategory, close_at, resolve_by, price_rule)` | Operator or owner | Creates a market, returns its id, and asks the oracle to register it. `price_rule` is optional.                                                                                                | Not operator or owner; contract paused; any of the four text fields empty; text over its limit; bad category slugs; `close_at` not in the future; `resolve_by` not after `close_at`; for a price rule: observation time before `close_at` or not before `resolve_by`, strike zero, or more than 18 decimals. |
| `retry_register(market_id)`                                                                                                | Operator or owner | Sends the oracle registration again.                                                                                                                                                           | Already registered.                                                                                                                                                                                                                                                                                          |
| `halt(market_id, reason)`                                                                                                  | Operator or owner | Stops trading in one market, with a recorded reason. Redemption after resolution still works. Brings the closing-price average up to date before halting.                                      | Not operator or owner; market already resolved; the caller is the operator and the market closes within 24 hours or has closed (`a halt in the last day before close is an owner action`). The owner can halt at any time.                                                                               |
| `resume(market_id)`                                                                                                        | Operator or owner | Lifts a halt. Brings the closing-price average up to date first, so the halted time counts for nothing.                                                                                        | Not operator or owner; market already resolved.                                                                                                                                                                                                                                                              |
| `set_sells_paused(sells_paused)`                                                                                           | Owner             | Stops `sell` (`sells are paused`). Kept apart from `set_paused` so the operator cannot take away the exit from an open position. Logs `sells_paused`. | Not owner. |
| `set_paused(paused)`                                                                                                       | Operator or owner | Stops buys, deposits, seeding and new markets. Sells, withdrawals and redemptions keep working.                                                                                                 | Not operator or owner.                                                                                                                                                                                                                                                                                       |
| `claim_residual(market_id)`                                                                                                | Operator or owner | After resolution, moves what the pool holds beyond what holders are owed into the treasury's due bucket (`treasury_due`). The next sweep pays it on the treasury leg, whole and not split with the Council. Can be done once per market, before or after holders redeem. | Not resolved; already claimed.                                                                                                                                                                                                                                                                               |

The treasury needs no proposal to collect it: the next sweep sends it.

### The oracle's methods

| Method                            | Who                 | What it does                                                                                            | Refused when                                                                                     |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `set_outcome(market_id, outcome)` | Oracle only         | Records the final outcome (`yes`, `no` or `void`). Calling it again with the same outcome does nothing. | Caller is not the oracle; the market has not closed; the market is already resolved differently. |
| `on_registered(market_id)`        | The contract itself | Callback after registration. Marks the market registered if the oracle accepted it.                     | Anyone else (private).                                                                           |

### Anyone

| Method                                                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `void_if_unresolved(market_id)`                                           | The way out if the oracle is gone. If `resolve_by` plus a 7 day grace period has passed and no outcome was ever applied, sets the outcome to Void. Refused if already resolved or before the grace period is over. While the oracle is working it answers the market itself at `resolve_by` through `resolve_by_deadline`, and a proposal that was nearly final is applied, not voided over. |
| `buy(market_id, side, amount, min_shares)` (payable, 1 yocto)             | Buys using balance already held in the contract. `side` is `"yes"` or `"no"`. Needs exactly 1 yoctoNEAR attached, so a limited-access key cannot spend a balance.                                                                                                                                                                                                                            |
| `sell(market_id, side, collateral_out, max_shares_in)` (payable, 1 yocto) | Sells shares back to the pool. You name how much collateral you want out, and the contract works out how many shares that costs. Needs exactly 1 yoctoNEAR.                                                                                                                                                                                                                                  |
| `redeem(market_id)`                                                       | After resolution, converts all the caller's shares in that market into balance. No deadline.                                                                                                                                                                                                                                                                                                 |
| `withdraw(amount)` (payable, 1 yocto)                                     | Pays `amount` of the caller's balance into the caller's own Intents account with an `mt_transfer` of 1 yocto from this contract. The balance is reduced first and restored if the verifier's transfer fails (event `withdraw_failed`). Needs exactly 1 yoctoNEAR attached. It pays only the caller, so a mistyped target cannot lose money.                                                                                                                                                                                                                             |
| `sweep_fees()`                                                            | Splits collected fees between the Council and the treasury, records both legs under a sweep id, and sends them through the verifier. Returns the sweep id, or null when there was too little to act on. See "Fees".                                                                                                                                                                                                                                |
| `settle_leg(sweep_id)`                                                    | Asks the Council what it recorded under a sweep id, for a Council leg whose result was lost, ten minutes or more after the sweep. A record settles the leg and no record makes the amount due again. See "Revenue whose result was lost".                                                                                                                                                                                                                                |
| `get_sweep(sweep_id)`, `list_sweeps(from_index, limit)` (views)           | One sweep record, or a page of them by id, oldest first, at most 50.                                                                                                                                                                                                                                                                                                                                |

`buy` and `sell` and the token-message trades all use the same rules, below.

### Money in: `mt_on_transfer`

Money arrives when a user calls `mt_transfer_call` on the verifier with this contract as the
receiver and the collateral token id. The verifier moves the amount into this contract's Intents
account, then calls `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)` here.
The answer is the list of amounts to hand back, so `[0]` keeps everything. A panic here makes the
verifier refund the sender in full, so a bad message never loses funds. The same call works from a
signed transfer with a notification, where `sender_id` is the signer.

The hook checks, in this order: the caller is the verifier (`only the verifier can deliver money`),
there is exactly one token and one amount (`exactly one token and amount`), the token id is the
configured one (`wrong token`), `previous_owner_ids` is exactly `[sender_id]` (`the money must come
from the sender's own balance`), and the amount is above zero (`amount must be positive`). Then the
message decides what to do. The message grammar is the one the NEP-141 hook had.

| `msg`                              | Who                | What it does                                                                                                                                                       |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deposit`                          | Registered account | Adds the amount to the sender's balance. Refused if paused or not registered. Extra text after `deposit` is ignored.                                               |
| `buy:<market>:<side>:<min shares>` | Registered account | Buys directly with the money sent. `side` is `yes` or `no`. `min shares` is a slippage floor and must be above zero. Extra text after the fourth part is ignored. |
| `seed:<market>`                    | Operator or owner  | Opens the market at one half. Refused at or after the market's `close_at`.                                                                                         |
| `seed:<market>:<yes price>`        | Operator or owner  | Opens the market at a chosen starting Yes price, in millionths, from 10,000 to 990,000 (1% to 99%).                                                                |

Also refused for any message: an amount of zero, an unknown action, or a market id that is not a
number.

A plain deposit is not a funded position. Depositing tokens into the verifier with the market's
account as the recipient, in any message form, credits the market's Intents account and never calls
this contract, so nothing is credited to the sender. The old notify form
(`{"receiver_id":"<market>","msg":"deposit","min_gas":...}`) is no different: the verifier ignores the
fields it does not know. That money is surplus. It shows up as the verifier holding more than
`total_owed`, it is never credited automatically, and no method of this contract credits it. Clients
must fund the market only through `mt_transfer_call`.

---

## Upgrading this contract

No access key can replace this code outside a vote, and no deleted key can freeze it, because the
code path is part of the contract. The owner (the DAO) calls `upgrade` with the hash of a staged
build.

| Step    | What happens                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage   | Anyone calls `stage_code` with the wasm as the input. The contract answers with the sha256. Different code cannot overwrite it because the key is the hash.                                                                                                                                                                                                                                     |
| Propose | The DAO proposes a `function_call` to `upgrade` with `{"code_hash":"<base58>"}`. The proposal is public while members vote. SputnikDAO runs it in the same call as the approval that reaches the threshold, and it fails if the threshold is not reached before the voting period ends. There is no delay after approval, by owner decision (R-07).                                                                                                                                                                                                                                          |
| Execute | `upgrade` checks the caller is the owner and that 100 TGas are attached (`attach at least 100 TGas to upgrade`), takes the staged wasm out of storage, sets `upgrade_in_flight`, and sends one batch to this account: deploy, then `migrate`. A `migrate` that panics reverts the deploy and the old code stays. The staged copy is gone either way, so a failed upgrade stages the code again. |
| Prove   | `migrate` refuses to run unless `upgrade_in_flight` is set (`migrate runs only inside an upgrade`), then clears it and sets `upgrade_proven`. A hand-called `migrate` therefore proves nothing. When the batch fails, the old code keeps the mark set and the next `upgrade` sets it again. `config` shows both flags with `state_version`.                                                     |
| Seal    | `seal(public_key)` deletes an access key. It is refused until `upgrade_proven` is true (`prove the upgrade path before deleting keys`), so keys are deleted only after one upgrade has worked on this chain.                                                                                                                                                                                    |

The state struct starts with `state_version: u16`, 1 today. `migrate` reads the first two bytes of
the stored state and refuses anything but 1 (`migrate expects version 2`), then reads the version 1
struct. It never guesses a layout from bytes. A version 2 build keeps the version 1 struct as
`StateV1`, reads that, builds its state and writes `state_version: 2`.

Withdraw and redeem stay unpausable: `set_paused` does not touch them, an upgrade does not touch
them, and neither does `halt`. `set_paused` does not stop `sell` either: only the owner's `set_sells_paused`
does. A market the operator has halted takes no sells. A user who does not trust a pending upgrade can withdraw a balance
and redeem a resolved position at any time, so that exit does not depend on any delay. Open positions stay in the market until it
resolves or they are sold while trading is open. The unit test
`withdraw_and_redeem_still_work_while_the_market_is_paused` checks both calls on a paused contract.

Measured in the sandbox for a 289 KB build: `upgrade` burns 34 TGas in all, 20 of them the deploy
and migrate batch, and `seal` burns 2. The accepted deployment controls are in
[DEPLOY.md](DEPLOY.md#3-administration-and-upgrades). Trezu/Sputnik execution still needs its own
integration evidence.

---

## How trading works

The pricing is a constant-product pool, the same shape as Uniswap. Each market has a Yes pool and a
No pool of shares. The price of an outcome is the other pool divided by the total of both, so buying
Yes shrinks the Yes pool, grows the No pool, and raises the Yes price. A fresh market seeded at one
half has equal pools.

All rounding goes in favour of the pool, so the pool's product never shrinks and repeated tiny
trades cannot make money. The tests confirm that no sequence of buys and sells by one trader ends in
profit.

### Buying

You send `amount` of collateral and a minimum number of shares. The contract:

1. Works out how many shares the whole amount would buy, and from that the average price of the
   trade.
2. Charges the fee on that trade (see "Fees"), taken out of `amount`.
3. Buys shares with what is left.
4. Refuses if fewer shares than `min_shares` result ("price moved, you would get fewer shares than
   your minimum").

The collateral less the fee is added to the market's `locked`. The fee goes to the fee bucket.

### Selling

You name `collateral_out`, the amount you want to receive from the pool, and `max_shares_in`, the
most shares you will give up. The contract works out the shares needed, charges the fee on
`collateral_out`, and credits you `collateral_out` minus the fee. `quote_sell` tells you the largest
`collateral_out` that `shares` can fetch. A sale so small that its fee would eat all of it is
refused ("cannot sell that amount").

### The market must be open

A buy or sell is refused unless the market is registered, seeded, not halted, not resolved, and
strictly before `close_at`. Trading at the exact close instant is refused. The contract must also
not be paused.

### Slippage and sandwiching

Every buy needs a minimum and every sell needs a maximum, so a trader is never filled at a price
they did not accept. The minimum cannot be zero, so there is no way to opt out of the protection.
This protects the trader but not the pool: someone who buys ahead of a large order still profits
from the price that order moves, and that profit comes out of the pool, meaning the seeder. This is
true of every constant-product market. See `AUDIT.md`, "Attack testing", for the measured numbers.

---

## Fees

| Fee                       | Rate                                                                                                                                                               | Who pays                           | Where it goes  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | -------------- |
| Trade fee                 | `rate × shares × p × (1 − p)`, where `p` is the trade's average price. At the starting 2%, about 1% of a 50 cent trade and almost nothing near 1 cent or 99 cents. | The buyer or seller, on each trade | The fee bucket |
| Creation fee              | A flat amount, 1,000,000 units to start                                                                                                                            | The seeder, taken out of the seed  | The fee bucket |
| Redeem, withdraw, deposit | None                                                                                                                                                               | n/a                                | n/a            |

The fee is rounded up. The price you are quoted by `quote_buy` and `quote_sell` is produced by the
same function that charges the trade, so what is quoted is what is charged.

Fees sit in a bucket outside every market's collateral, so they never touch the rule that collateral
must equal shares outstanding.

### Sweeping

Anyone can call `sweep_fees`. It refuses until the owner has set the recipients
(`the fee recipients are not set, the owner must call set_fee_recipients before a sweep`). It does
nothing, and takes no id, when `fees` plus `revenue_due` plus `treasury_due` is below `min_sweep`
(1,000,000 units to start), or when both legs would be empty. A sweep that would act refuses
within `MIN_SWEEP_INTERVAL_NS` (one hour) of the previous one (`wait an hour since the last sweep`), so a
refused due cannot be re-swept at will and the records stay at 24 a day at most.

Otherwise it splits the bucket by the Council's share in basis points, rounding both parts down:

```text
council  = fees * revenue_share_bps / 10000       (rounded down)
treasury = fees * (10000 - revenue_share_bps) / 10000
carry    = fees - council - treasury               (0 or 1 unit, stays in fees)
```

The carry is at most one unit and goes to neither leg. It stays in `fees` and joins the next sweep.
Each leg then adds what earlier refused legs left in its due bucket. At the starting 2,500: 1,095,193
units give 273,798 to the Council, 821,394 to the treasury and 1 left in `fees`; 7 give 1, 5 and 1;
3 give 0, 2 and 1.

The sweep takes the next sweep id, writes the record (the account, amount and status of both legs,
and what was carried) and zeroes both due buckets, all before either transfer is sent. A transfer
that fails changes only its own leg and its own bucket. The Council's leg is an `mt_transfer_call`
with the message `revenue:<sweep id>`, so the Council counts it once. The treasury's leg is a plain
`mt_transfer`. Calling `sweep_fees` twice at once pays out once. Payouts go only to the accounts the
owner set: the verifier does not check that a receiver exists, so a mistyped recipient would lose the
money.

| Leg status   | Meaning                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `pending`    | The transfer is sent and its callback has not run.                                           |
| `settled`    | The recipient has the money. A leg with nothing in it starts here.                           |
| `refused`    | The verifier gave the money back. The amount is in its due bucket for the next sweep.        |
| `unresolved` | No usable report came and nobody can tell where the money is. Only the Council leg can be.  |

A callback acts on a leg only while it is `pending`, so a callback that runs twice, or after the owner
has decided the leg, changes nothing.

The sweep refuses less than 87 TGas (`attach at least 87 TGas: a sweep sends the Council its part and
the treasury its part`). That is 42 for the Council's transfer call (22 for the verifier's own part
and 20 for the Council's receipt), 15 and 10 for the treasury's transfer and its callback, 10 for the
Council's callback and 10 for the call itself. Measured in the sandbox: the verifier needs about 21 TGas attached to `mt_transfer_call` before the receiver gets any, and the Council took revenue with 22 and burned 2.0 TGas in its quarterly receipt. The sweep itself burns 3.4 TGas in the market and 22 in all, at the 87 TGas floor, with both legs arriving.

What the verifier reports back is the amount the receiver kept, one entry for the one token. The
callback reads it like this:

| Report | Meaning | What the market does |
| --- | --- | --- |
| `[amount]` | The Council kept all of it. | The leg is `settled` (event `fee_leg_settled`). |
| `[kept]` below the amount | The Council returned part. The verifier refunded that part here. | The difference goes back to `revenue_due` and the leg is `refused` (event `fee_transfer_failed`). |
| `[0]` | The Council panicked or has no contract, or returned a malformed answer. The verifier refunded all of it here. | The whole amount goes back to `revenue_due` and the leg is `refused` (event `fee_transfer_failed`). |
| An error, or a list that is not one entry | The verifier's own receipt failed (paused, locked, out of gas) or its resolve step did, so the market cannot tell where the money is. | The amount goes to `revenue_unresolved` and the leg is `unresolved` (event `fee_transfer_unresolved`). |

The treasury's `mt_transfer` returns nothing, so an error there means the verifier refused and
nothing moved: the leg is `refused` and the amount is back in `treasury_due` (event
`fee_transfer_failed`). Otherwise it is `settled`.

### Revenue whose result was lost

When the verifier's own receipt fails, the caller sees an error although the verifier may or may
not have moved the money. Crediting the amount back to `revenue_due` could then pay it twice, the
second time out of users' collateral. So `on_revenue_sent` treats a result that never came back as
unknown. The leg is `unresolved`, the amount moves to `revenue_unresolved` and the next sweep does
not send it. Every unit is in exactly one of collected, due, unresolved, on its way (a pending leg),
or gone.

Anyone settles it with `settle_leg(sweep_id)` ten minutes after the sweep. The market asks the
Council for `received_of(sweep_id)`. The Council takes each sweep id once, so its answer cannot change
afterwards. A record means the money arrived: the leg is `settled`. No record means it did not: the
leg is `refused` and the amount is due again, so the next sweep sends it under a new id. If the
Council cannot answer, the leg stays unresolved and anyone can ask again.

The owner decides by hand with `reconcile_leg(sweep_id, leg, arrived)`, for a pending or unresolved
leg of either kind, an hour after the sweep. It is for the case where the Council cannot be asked,
and the owner must have checked the verifier's events and the recipient's balance first. `arrived:
true` settles the leg. `arrived: false` makes the amount due again. The event `fee_leg_reconciled`
records each call. Against the real verifier the usual cause of an unresolved leg is a paused
feature or a locked account, where nothing moved, so "no record" is the normal answer. Telling the
market a transfer arrived when it did not drops it from `total_owed` while the verifier still holds
it, and the reconciliation shows that as a surplus.

### Reconciling with the verifier

`total_owed()` adds every balance, the collateral locked in every market, the fee bucket,
`revenue_due`, `treasury_due` and `revenue_unresolved`. A pending leg is out of the books because its
money is already on its way, so a transfer that has not finished shows as surplus, never as a
shortfall. The verifier's `mt_balance_of(<market>, <collateral token id>)` read at the same finalized
block must equal it.
More in the verifier is surplus that nobody is credited for, and it is never credited automatically,
not by the operator and not by the owner: there is no credit path. Less in the verifier is an
incident. A call in flight shows as a difference of one block, so compare again a few blocks later
before raising anything. The view adds a running total of locked collateral (`locked_total`), so its
cost does not grow with the number of markets.

---

## Void

A market becomes Void when the oracle says so, including through `resolve_by_deadline`, or when
`void_if_unresolved` is called 7 days after `resolve_by`.

A Void pays each Yes share the market's closing Yes price and each No share the rest, so a pair of
one Yes and one No share always pays exactly 1. The closing price is the Yes price averaged over
trading time across the last 24 hours before `close_at`, or since the market opened if that was
later. Time while the market is halted does not count, in the price or in the time it is divided by,
so halting a market right after a pump does not leave the pumped price holding the average. A market
with no trading time in that window, for example one halted for its whole last day, pays the average
over all its trading time instead, so a pump followed by a halt that is held to close cannot make
the Void pay the pumped price.

Only a market that never traded at all pays its last price. The operator cannot halt in the last 24
hours before close (`a halt in the last day before close is an owner action`), only the owner
can, so the window itself cannot be emptied by the fast key. It is fixed at the moment the market
becomes Void.

The average is kept in a running time-weighted accumulator, not read from the 120-point chart log,
so no number of trades can change how long a price held. An earlier version averaged the log and
could be flooded; that was fixed after an attack test showed it.

This replaced a flat 0.50 per share, which paid a holder of the cheap side several times what their
shares were worth. A known remaining risk: pumping the price and then forcing a Void pays the pumper
from the pool, because shares bought on the way up cost less than the price they are paid at. It
needs a Void that one party cannot force alone, and halting the market after the pump no longer
helps, because the halted time does not count. See `AUDIT.md`.

---

## Seeding at a chosen price

Collateral must equal the shares outstanding of each outcome. So a market opened away from one half
needs its smaller pool made up: the seeder holds the difference. At 30% Yes, the Yes pool is the
whole seed, the No pool is smaller, and the seeder holds the No shares the pool does not. The seeder
is then an ordinary holder with those shares and must be registered (`storage_deposit`). Those
shares are positions until redeemed, but the operator and the owner are not held to the 20 position
limit, so seeding many markets away from one half does not fill it. Because the owner is the
DAO, the operator should be the one to seed. A market cannot be seeded at or after
its close.

A seed of exactly one half leaves the seeder holding nothing. A seed too small to give either pool
anything at its price is refused.

---

## Price markets

A market created with a `price_rule` is answered by signed prices, not by someone pointing at a web
page. The rule is:

| Field              | Meaning                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observation_time` | The moment whose price decides the market. Must be at or after `close_at` (so traders cannot know the answer while trading) and before `resolve_by`. |
| `strike`           | The threshold price, an integer scaled by 10 to the power `decimals`. Must be above zero.                                                            |
| `decimals`         | How many decimal places the price and strike carry. At most 18.                                                                                      |
| `above`            | If true, Yes when the price is at or above the strike. If false, Yes when the price is below it.                                                     |

The rule is part of the rule hash, so it cannot change. market passes it to oracle at registration,
and the oracle checks signed prices against it. How prices are signed and checked is described in
`oracle.md`.

---

## The rule hash

At creation the contract computes a SHA-256 of the title, rule text, resolution source, void policy,
`close_at` and price rule, written as 64 hex characters. It is stored, shown in the views, and sent
to the oracle. It lets anyone prove the question was not reworded after money went in. Category,
subcategory and `resolve_by` are not part of it.

---

## Winning and getting paid

After resolution:

| Outcome | A Yes share pays      | A No share pays                   |
| ------- | --------------------- | --------------------------------- |
| Yes     | 1 unit                | 0                                 |
| No      | 0                     | 1 unit                            |
| Void    | the closing Yes price | the rest, so one minus that price |

`redeem` pays all of the caller's shares in a market at once into their balance, rounding Void
payouts down per holder (up to one unit of dust per holder can stay in the market, which
`claim_residual` later collects). Redeeming has no deadline and works while paused or halted.

---

## The invariant

While a market is open, collateral held must equal shares outstanding on each side:
`locked = pool_yes + user_yes = pool_no + user_no`. After resolution, `locked` must be at least what
is owed. `check_invariant(market_id)` returns whether this holds. It is checked after every step of
the randomized tests, which run sequences of up to 60 random trades across two markets (one opened
at 30%), resolve each as Yes, No or Void, and redeem and claim the residual in both orders.

---

## Views (free to call)

| View                                                         | Returns                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config()`                                                   | state version, upgrade proven, upgrade in flight, owner, pending owner, operator, oracle, verifier, collateral token id, paused, sells paused, number of markets, storage deposit, position cap, fee rate, creation fee, revenue pool and treasury (null until set), the Council's and the treasury's share in basis points, minimum sweep, next sweep id, revenue unresolved |
| `get_market(market_id)`                                      | One market: id, title, rule text, source, void policy, category, subcategory, rule hash, price rule, close and resolve times, status, registered, seeded, outcome, void price, Yes and No price, locked                                         |
| `list_markets(from_index, limit)`                            | A page of markets (limit capped at 50)                                                                                                                                                                                                          |
| `get_history(market_id)`                                     | The price log: time and Yes price for each point                                                                                                                                                                                                |
| `total_owed()`                                               | Everything the contract owes in collateral units: balances, locked collateral, fees, both dues and revenue unresolved. Compare with the verifier's `mt_balance_of` for this account. A constant-size sum |
| `get_balance(account_id)`                                    | An account's withdrawable balance                                                                                                                                                                                                               |
| `get_shares(market_id, account_id)`                          | The account's Yes shares and No shares in that market                                                                                                                                                                                           |
| `quote_buy(market_id, side, amount)`                         | Shares you would get and the fee, or zeros if the trade cannot happen                                                                                                                                                                           |
| `quote_sell(market_id, side, shares)`                        | The most collateral those shares can fetch, the shares actually needed, and the fee                                                                                                                                                             |
| `get_fees()`                                                 | Collected, owed to the revenue pool (`revenue_due`), owed to the treasury (`treasury_due`), revenue unresolved                                                                                                                                  |
| `get_sweep(sweep_id)`, `list_sweeps(from_index, limit)`      | A sweep record: id, time, the part of the fees it split, what each leg carried, and each leg's account, amount and status. A page is at most 50, oldest first                                                                                   |
| `storage_balance_bounds()`, `storage_balance_of(account_id)` | NEP-145 views, under "Setup and accounts"                                                                                                                                                                                                       |
| `is_registered(account_id)`                                  | Whether the account registered                                                                                                                                                                                                                  |
| `is_staged(code_hash)`                                       | Whether a wasm with that sha256 is staged                                                                                                                                                                                                       |
| `check_invariant(market_id)`                                 | Whether the collateral rule holds                                                                                                                                                                                                               |

---

## Events

Every state change logs one line starting `EVENT_JSON:` followed by JSON of the form
`{"standard":"market","version":"1.0.0","event":"<name>","data":{...}}`.

| Event                     | When                                                                  | Data                                              |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `owner_proposed`          | `propose_owner`                                                       | owner, proposed                                   |
| `owner_changed`           | `accept_owner`                                                        | from, to                                          |
| `operator_set`            | `set_operator`                                                        | operator                                          |
| `market_created`          | `create_market`                                                       | market_id, rule_hash                              |
| `market_registered`       | oracle accepted it                                                    | market_id                                         |
| `market_halted`           | `halt`                                                                | market_id, reason                                 |
| `market_resumed`          | `resume`                                                              | market_id                                         |
| `paused`                  | `set_paused`                                                          | paused                                            |
| `sells_paused`            | `set_sells_paused`                                                    | sells_paused                                      |
| `fee_recipients_set`      | `set_fee_recipients`                                                  | revenue_pool, treasury                            |
| `revenue_share_set`       | `set_revenue_share_bps`                                               | revenue_share_bps, treasury_share_bps             |
| `min_sweep_set`           | `set_min_sweep`                                                       | min_sweep                                         |
| `next_sweep_id_set`       | `set_next_sweep_id`                                                   | next_sweep_id                                     |
| `fee_rate_set`            | `set_fee_rate_bps`                                                    | fee_rate_bps                                      |
| `create_fee_set`          | `set_create_fee`                                                      | create_fee                                        |
| `residual_claimed`        | `claim_residual`                                                      | market_id, amount, to                             |
| `outcome_set`             | `set_outcome`, or `void_if_unresolved` (which adds `"by":"deadline"`) | market_id, outcome                                |
| `deposit`                 | a deposit                                                             | account, amount                                   |
| `market_seeded`           | a seed                                                                | market_id, amount, fee, yes_price, seeder         |
| `buy`                     | a buy                                                                 | market_id, account, side, shares, collateral, fee |
| `sell`                    | a sell                                                                | market_id, account, side, shares, collateral, fee |
| `redeemed`                | `redeem`                                                              | market_id, account, amount                        |
| `withdraw`                | `withdraw`                                                            | account, amount                                   |
| `withdraw_failed`         | the verifier refused the transfer, balance restored                     | account, amount                                   |
| `fees_swept`              | `sweep_fees`                                                          | id, total, revenue_pool, council (leg amount), treasury_account, treasury (leg amount) |
| `fee_leg_settled`         | a leg ended with the recipient holding the money                      | id, leg, amount                                   |
| `fee_transfer_failed`     | a fee transfer failed, amount owed again                              | id, leg, to, amount                               |
| `fee_transfer_unresolved` | a revenue transfer returned no report, amount parked                  | id, to, amount                                    |
| `fee_leg_reconciled`      | `reconcile_leg`                                                       | id, leg, amount, arrived                          |
| `registered`              | `storage_deposit` registered an account                               | account, paid_by                                  |
| `unregistered`            | `storage_unregister`                                                  | account                                           |
| `code_staged`             | `stage_code`                                                          | code_hash, bytes, by                              |
| `upgrade_sent`            | `upgrade`                                                             | code_hash                                         |
| `migrated`                | `migrate`, in the new code                                            | state_version                                     |
| `seal_sent`               | `seal`                                                                | public_key                                        |

All big numbers in event data are strings.

---

## What can go wrong, and the message you will see

| Message                                                                                                                                                          | Cause                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `owner only`                                                                                                                                                     | A method reserved for the owner was called by someone else.                                            |
| `operator or owner only`                                                                                                                                         | A routine method was called by someone who is neither.                                                 |
| `oracle only`                                                                                                                                                    | `set_outcome` called by anyone but the oracle.                                                         |
| `not the proposed owner`                                                                                                                                         | `accept_owner` from the wrong account.                                                                 |
| `only the verifier can deliver money`                                                                                                                            | `mt_on_transfer` called by anything but the verifier.                                                  |
| `wrong token`                                                                                                                                                    | `mt_on_transfer` with a token id that is not the configured collateral id.                             |
| `exactly one token and amount`                                                                                                                                   | `mt_on_transfer` with a batch.                                                                         |
| `the money must come from the sender's own balance`                                                                                                              | `mt_on_transfer` whose `previous_owner_ids` is not exactly the sender.                                 |
| `the collateral token id must look like nep141:<token>`                                                                                                          | `new` with a token id in the wrong form.                                                               |
| `paused`                                                                                                                                                         | The contract is paused.                                                                                |
| `sells are paused`                                                                                                                                               | `sell` while the owner has set `set_sells_paused(true)`.                                               |
| `wait an hour since the last sweep`                                                                                                                              | `sweep_fees` within `MIN_SWEEP_INTERVAL_NS` of the previous sweep.                                     |
| `do the storage deposit first`                                                                                                                                   | The account has not registered (also for a seeder who would hold shares).                              |
| `market is not registered with the oracle yet`                                                                                                                   | Trading or seeding before the oracle accepted it.                                                      |
| `market has no liquidity yet`                                                                                                                                    | Trading before it was seeded.                                                                          |
| `market is halted` / `market is resolved` / `market is closed`                                                                                                   | The market is not open for trading, or, for `market is closed`, a seed arrived at or after `close_at`. |
| `price moved, you would get fewer shares than your minimum`                                                                                                      | A buy would fill below the buyer's floor.                                                              |
| `price moved, would need more shares than your maximum`                                                                                                          | A sell would cost more shares than the seller's ceiling.                                               |
| `cannot buy that amount` / `cannot sell that amount`                                                                                                             | Zero, too large for the pool, or too small to cover the fee.                                           |
| `min shares must be above zero`                                                                                                                                  | A buy with a floor of zero.                                                                            |
| `not enough balance` / `not enough shares`                                                                                                                       | Spending more than you hold.                                                                           |
| `too many positions, redeem or sell one first`                                                                                                                   | Over 20 share entries, for an account that is neither operator nor owner.                              |
| `already seeded` / `already registered` / `already resolved` / `already claimed`                                                                                 | A step done twice. `resume` of a market that has an outcome says `already resolved` too.               |
| `the seed must be more than the creation fee` / `seed too large` / `the seed is too small to open at that price`                                                 | Bad seed size.                                                                                         |
| `the starting price must be between 1% and 99%` / `bad starting price`                                                                                           | Bad opening price.                                                                                     |
| `the fee rate is capped at 500 basis points` / `the creation fee is capped at 10 units`                                                                          | Fee ceilings.                                                                                          |
| `market has not closed`                                                                                                                                          | The oracle tried to resolve early.                                                                     |
| `market already resolved differently`                                                                                                                            | A second, conflicting outcome.                                                                         |
| `the answer deadline and the 7 day grace period have not passed`                                                                                                 | `void_if_unresolved` too early.                                                                        |
| `not resolved` / `not resolved yet` / `nothing to redeem`                                                                                                        | Claiming or redeeming too soon, or with nothing held.                                                  |
| `text is too long` / `<field> is required` / `category and subcategory must be lowercase slugs of up to 32 characters`                                           | Bad market text.                                                                                       |
| `close_at must be in the future` / `resolve_by must be after close_at`                                                                                           | Bad market times.                                                                                      |
| `observation_time must not be before close_at` / `observation_time must be before resolve_by` / `a price rule needs a strike above zero and at most 18 decimals` | Bad price rule.                                                                                        |
| `attach at least 0.05 NEAR`                                                                                                                                      | Storage deposit too small for a new account.                                                           |
| `nothing above the 0.05 NEAR deposit to withdraw`                                                                                                                | `storage_withdraw` with an amount above zero.                                                          |
| `the account is not registered`                                                                                                                                  | `storage_withdraw` by an account that never registered.                                                |
| `redeem or sell your positions first` / `withdraw your balance first`                                                                                            | `storage_unregister` while the account still holds shares or a balance.                                |
| `force is not supported, redeem your shares and withdraw your balance first`                                                                                     | `storage_unregister` with `force: true`.                                                               |
| `the fee recipients are not set, the owner must call set_fee_recipients before a sweep`                                                                          | `sweep_fees` before the owner has set where fees go.                                                   |
| `the Council and the treasury must be different accounts`                                                                                                        | `set_fee_recipients` with one account twice.                                                           |
| `the Council share must be between 1000 and 5000 basis points` / `the sweep minimum must be between 1 and 100000000` / `the next sweep id can only move up`      | The bounds of the owner's settings.                                                                    |
| `no sweep to settle` / `the leg is not unresolved` / `wait 10 minutes after the sweep before settling`                                                           | `settle_leg` for a sweep that does not exist, a leg that is not unresolved, or too early.              |
| `the leg is neither pending nor unresolved` / `wait 60 minutes after the sweep before reconciling`                                                               | `reconcile_leg` for a leg that already ended, or too early.                                            |
| `attach at least 87 TGas: ...` / `attach at least 30 TGas: ...`                                                                                                  | `sweep_fees` or `settle_leg` with less than its floor.                                                 |
| `Requires attached deposit of exactly 1 yoctoNEAR`                                                                                                               | `withdraw`, `buy` or `sell` without the 1 yocto.                                                       |
| `attach at least 100 TGas to upgrade`                                                                                                                            | `upgrade` with less gas than the deploy and migrate need.                                              |
| `no code is staged under that hash`                                                                                                                              | `upgrade` for a hash nobody staged, or one already used.                                               |
| `attach at least <amount> to pay for the storage` / `the wasm goes in the call input`                                                                            | `stage_code` with too little deposit or no input.                                                      |
| `prove the upgrade path before deleting keys`                                                                                                                    | `seal` before an upgrade has gone through `migrate`.                                                   |
| `migrate expects version 2`                                                                                                                                      | `migrate` found state written by another version.                                                      |
| `migrate runs only inside an upgrade`                                                                                                                            | `migrate` called without `upgrade` having sent the batch.                                              |
| `a halt in the last day before close is an owner action`                                                                                                         | The operator tried to halt a market that closes within 24 hours, or has closed.                        |
| `Method <name> is private`                                                                                                                                       | An internal callback, or `new`, was called by anyone but the contract's own account.                   |

---

## Gas the contract reserves for its own calls

| Call                                          | Gas                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Verifier `mt_transfer` (withdraw, treasury fee) | 15 TGas (the verifier burned 3.8 measured) |
| Verifier `mt_transfer_call` (revenue to the Council) | 42 TGas: 22 for the verifier's own part, 20 for the Council's `mt_on_transfer` |
| Oracle registration                           | 20 TGas                                                                                 |
| Each callback                                 | 10 TGas                                                                                 |
| `sweep_fees` in all                           | 77 TGas reserved: 42 for the Council's part, 15 and 10 for the treasury's, 10 for the Council's callback |
| `settle_leg` in all                           | 20 TGas reserved: 10 for the Council's `received_of`, 10 for the callback. It refuses less than 30 TGas. Measured at the floor: 2.4 TGas burned in the market and 6 in all |
| `migrate` in the upgrade batch                | 30 TGas (the batch of deploy and migrate burned 20 for a 289 KB build)                  |

A caller of `sweep_fees` must attach at least 87 TGas: the 77 it reserves plus 10 for its own work
(about 3 measured), checked first thing. `upgrade` needs at least 100 TGas attached, and a DAO call
to it should carry that as its `gas`.

---

## Security properties checked by tests

Every restricted method refuses a stranger; every callback refuses a direct call; `mt_on_transfer`
refuses any caller but the verifier, any token id but the collateral's, a batch, and money that was
not the sender's own; malformed messages and a panicking receiver are refunded in full by the verifier; a second
withdrawal, sweep or redeem sent while the first is in flight pays once; starving a transfer of gas
never loses the sender's money; trading stops at the exact moment of close; buy and sell refuse a
call with no deposit; a halt cannot pin the void price at a pumped price, not even one held through
the whole last day (the second review's proof of concept), the operator cannot halt in the last day
and the owner can, and a resume counts trading time again from the resume; a hand-called `migrate`
is refused; a market reports `unregistered`, `unseeded` and `open` in turn; the emergency void stays
shut for 7 days after the deadline; 25 skewed seeds by the operator all succeed while an ordinary
trader stops at 20 positions; a seed after close is refused; a stranger and the operator cannot
upgrade or seal, an unknown hash and too little gas or deposit are refused, seal waits for
`upgrade_proven`, and `migrate` refuses another state version; withdraw and redeem work on a paused
contract; a stranger cannot initialise a deployed contract; storage registers for a third party,
refunds the surplus to the payer, and unregisters only an empty account; a revenue transfer with no
report is parked and not paid again, a Council that refuses is refunded to due while the treasury
leg is paid once, a locked or paused verifier restores every payout, `total_owed` equals the
verifier's balance after a whole journey, a plain deposit is surplus with no callback, no contract
source names a governance crate or a verifier admin method or writes an account id, a sweep refuses
until the recipients are set, the split adds up to the total for every share the owner may set, and a
parked leg is settled from the Council's record or by the owner, with the books adding up under random
sequences of sweeps, reports, settlements and reconciliations; `sweep_fees` refuses less than its gas
floor; the operator key
cannot take money; random trade sequences never break the invariant or create money.

Details and the measured economic attacks are in `AUDIT.md`.

---

## Things to know

| Topic                                       | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One token                                   | The contract handles a single collateral token id chosen at deploy, and assumes the token behind it is a plain NEP-141 token with no transfer fee. The planned token is native USDC, `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (spec.md section 6). The sandbox runs `mock-ft`; the literal USDC id was not run. A stablecoin issuer that freezes the verifier's account would freeze every user. |
| Pause and lock in the verifier              | The verifier's pause manager can stop every `mt_transfer` and `mt_transfer_call` with one call, and a locker can freeze this contract's account. Either makes every payout fail and restore (`withdraw_failed`, `fee_transfer_failed`, `fee_transfer_unresolved`). A pause also makes transfer calls into the market fail, so no deposit is taken. A locked account still receives, so the market can keep taking money it cannot pay out: the keeper should read `is_account_locked` and stop advertising deposits. Redeeming and selling work inside the market meanwhile. |
| Surplus                                     | Money sent to the market's Intents account without `mt_transfer_call` is never credited. See "Money in" and "Reconciling with the verifier". |
| Payout targets                              | The verifier does not check that a receiver exists. Payouts go only to the caller of `withdraw`, to `revenue_pool` and to `treasury`. Check what you pass to `set_fee_recipients`: a mistyped account takes the money. |
| No keys in the verifier                     | The contract never calls `add_public_key`, `disable_auth_by_predecessor_id`, `auth_call`, `execute_intents` or any verifier admin method. Its balance moves only by `mt_transfer` and `mt_transfer_call` from this contract. A source test keeps it that way. |
| Storage deposit                             | 0.05 NEAR per account. Chosen to cover a balance entry plus 20 share entries. It comes back through `storage_unregister` once the account holds nothing. An unregister while a `withdraw` is still in flight can leave a balance entry behind if the token then refuses that withdraw; the balance is credited back and still withdrawable, and the account registers again to trade.                                                                                                                       |
| Operator and the owner's seed money         | Seeds are sent from the operator account, and leftovers go to the treasury, so the treasury has to refill the operator to keep seeding.                                                                                                                                                                                                                                                                                                                                                       |
| A seeder holds shares                       | When a market is opened away from one half. See "Seeding at a chosen price".                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The seed is a subsidy                       | A constant-product seeder loses to informed traders by design. The pool's winning-side shares go to the treasury at resolution, but that does not make the seed back. Budget the seed as a cost of opening the market, not as an investment.                                                                                                                                                                                                                                                         |
| Positions are not transferable              | There is no NEP-245 multi-token interface, so a position cannot be sent, lent or used as collateral, and there is no secondary market. The 20-position cap binds ordinary accounts for that reason.                                                                                                                                                                                                                                                                                                         |
| Nothing caps a market                       | Apart from the size of a pool, no code limits how much a market can hold. The most one market can hold is set by what the operator seeds and by the deposit limits at launch. That is the lever against the cost of corrupting a market (see "One bond cannot scale with market size" in `oracle.md`).                                                                                                                                                                                                      |
| Halting is a grievance risk                 | A stolen operator key can halt trading until 24 hours before close, and only the owner can halt after that. Users are not locked in after close, and the owner can replace the operator.                                                                                                                                                                                                                                                                                                                    |
| Selling during an upgrade is not guaranteed | `withdraw` and `redeem` never pause, so a balance and a resolved position can always leave while the verifier allows payouts. A holder of an open position can leave at a fair price only by `sell`ing. The operator's `set_paused` no longer stops that, but the owner's `set_sells_paused` and a `halt` of the market (the operator can halt except in the last day) do. The market does not know an upgrade is pending and nothing holds `sell` open while a proposal waits. This is a known limitation, left for the owner to decide.                                                                                                    |
| Website, 2026-10-20                         | `get_market` and `list_markets` now return `seeded`, and `status` can be `unregistered` or `unseeded` before `open`. In `web/lib/market.ts` the `status` type admits `open`, `closed`, `halted` and `resolved` only, so it needs the two new values, and so does any code that switches on `status`. `isMarketListed` already reads `seeded !== false`, which passed every market while the field was never sent. It now drops unseeded markets, as that line intends. `config` gained `upgrade_in_flight`. |
| Website                                     | The website still tells users a Void pays half in three places (the Council page FAQ and the portfolio payout calculation and its comment). The contract now pays the closing price. The website also has to attach 1 yoctoNEAR to `buy` and `sell`, and the keeper-facing void now goes through the oracle's `resolve_by_deadline`.                                                                                                                                                                        |
| Keys                                        | Until `seal` has run, the deploy key can replace this code outside every DAO proposal. After it, only an owner upgrade can. A sealed contract with a broken upgrade path cannot be fixed, so prove one upgrade first.                                                                                                                                                                                                                                                                                           |
| Keeper                                      | The keeper script sweeps fees: when `collected` plus `revenue_due` plus `treasury_due` reaches its minimum (`--min-sweep`, 10 tokens at 6 decimals by default) it calls `sweep_fees` with 100 TGas, over the 87 TGas floor. It needs only a function-call key limited to this contract and that one method.                                                                                                                                                                                                 |
| Website and keeper                          | Nothing changes for them from the upgrade path. `config` gained `state_version` and `upgrade_proven`, and now `revenue_unresolved`. `storage_deposit` now returns a `StorageBalance` and takes two optional arguments; the body must be a JSON object, so `{}` still works and an empty body no longer does. The website already sends `{}`.                                                                                                                                                                |
| No outside audit                            | The only review is the self-review in `AUDIT.md`. One is required before mainnet money beyond a small capped test.                                                                                                                                                                                                                                                                                                                                                                                          |
