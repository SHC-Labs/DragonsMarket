# market

**Dynamic parimutuel pricing, 2026-10-27.** The constant-product pool and its seed are gone. Every market now prices by a dynamic parimutuel cost function (`dpm/src/lib.rs`, see "How trading works"). A registered market opens empty at even odds and anyone can make the first trade: there is no `seed:` message, no creation fee and no opening price. A winning share is paid its part of the pool, never less than it cost, and a Void, or an answer nobody holds, pays each holder back what they put in (see "Void"). `sell` takes the shares to sell and the least collateral to accept. A version-5 root migrates only while it has created no market, because a constant-product pool cannot be turned into parimutuel shares, so a deployment that has markets is replaced, not upgraded. The largest market record is now 4,775 bytes and a new market's storage deposit 0.04775 NEAR.

**Token deposits, 2026-10-27.** An account that holds the collateral as a NEAR token and nothing in the verifier can now pay the market with the token's `ft_transfer_call` and the message `deposit` or `buy`, after registering with `storage_deposit` in NEAR. The market moves the money into its own Intents account and credits the sender only once it is there (see "Money in by token"). A `buy` is then bought in a receipt of its own, so a buy the price outran stays a balance.

**Signed actions and collateral registration, 2026-10-26.** A signed Intents intent can buy, sell, redeem and withdraw for its signer through `on_auth` (see "Signed actions"). An account with no NEAR registers by sending the registration fee in collateral with the message `register` (see "Money in"). A deposit paid by someone else for an account now goes back to that payer when the account leaves.

**Storage and position update, 2026-10-23.** New market records use tag 1; tag 0 remains readable. Sweep and withdrawal tags do not change.

| Change | Current behavior |
| --- | --- |
| Creation payer | `create_market` is payable and requires `config.market_storage_deposit`. Starting amount and hard minimum: **0.04775 NEAR**, measured from the complete 4,775-byte maximum record, including history, price rule and key overhead. Hard maximum: 0.5 NEAR. Surplus deposit is refunded. This is separate from user registration. |
| Reserve | `set_storage_policy(market_storage_deposit: U128, reserve: U128)`, owner only. Starting reserve 1 NEAR; hard range 0.1 to 100 NEAR. New market/share/sweep records and entry-side market updates must leave this margin after locked storage and refunds. Existing redemptions, withdrawals and callbacks can spend it. Top-ups remain necessary; this is a buffer, not an unlimited exit guarantee. |
| Exempt accounts | Current owner and operator, and accounts previously made exempt, do not extend the position index. Shares remain authoritative. `get_positions` scans a window for these accounts, default 50 and maximum 100 IDs. Ordinary accounts retain their bounded sorted index. Only the current owner/operator bypass the share-entry cap. |
| Holders | `MarketView.holders` counts accounts holding either side once. |
| Pruning | Anyone can call `prune_market(market_id: U64)` after resolution and redemption of both winning and losing shares. Clears title, rules, source, Void text and history; keeps rule hash, category, result and money. Returns false on a repeat. Indexers retain published metadata. Never deletes sweep records, receipts or payout evidence. |
| Legacy positions | Migration never scans a large old owner/operator index. Their total position count is null while old shares remain; bounded windows still return holdings. Legacy records become provably empty when both aggregate share totals reach zero, then can be pruned. Old index bytes remain reserved but are no longer extended or used for paging. |
| Sweep floor | `set_sweep_timing` now enforces 60 to 1,440 minutes. Migration raises any shorter interval to 60 minutes. Hourly records still cost an estimated 143 NEAR over five years across market and Council, excluding gas and other state. |
| New events | `storage_policy_set {market_storage_deposit, reserve}` and `market_pruned {market_id, rule_hash}`. |



Target decision, 2026-10-20: Trezu/SputnikDAO replaces custom governance. Earned platform fees
allocate 75% to the Trezu treasury and 25% to Council-controlled NFT rewards backed in Intents.
See [the architecture](../intents-architecture.md).

Status, 2026-10-21, fee split built (R-03): a sweep records both legs under a sweep id before it
sends either, each leg has its own status, the Council takes each sweep id once, and a lost Council
result is settled from the Council's own record. The treasury and the Council's account are not
written in the code and are not arguments of `new`: the owner sets them with `set_fee_recipients`,
and a sweep refuses until it has. The 75/25 split is a share in basis points the owner can move
(2,500 to start). `business_wallet` is now `treasury`. See "Fees".

Status, 2026-10-20, phase I2 of the Intents migration: the money path in this manual is the NEAR
Intents path. The market keeps all its backing in its own account inside the Intents verifier. Money
arrives through the verifier's `mt_transfer_call`, which calls `mt_on_transfer` here, and leaves
through `mt_transfer` and `mt_transfer_call` from this contract, with no signed intent and no key
registered in the verifier. The DAO voting period is the only delay before an owner action
(decided 2026-10-21, R-07). The oracle takes bonds through the same verifier (`mt_on_transfer`, messages `propose:` and `challenge:`).

Source: `market/src/lib.rs` (the contract) and `dpm/src/lib.rs` (the pricing maths). Written
2026-10-18 from the code as it stands, including everything added that day. The upgrade path was
added 2026-10-19 and the shared helpers are in `upgrade/src/lib.rs`. The upgrade mark was added
2026-10-20, and dynamic parimutuel pricing replaced the constant-product pool on 2026-10-27. For current behaviour, follow the code. For required target behaviour, follow the accepted
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
13. [The residual](#the-residual)
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

A market is one yes or no question. People buy Yes shares or No shares, and every unit they pay in
stays in the market's pool. When the question is answered, the winning shares split the whole pool
between them, so each is paid its part, never less than it cost, and each losing share pays nothing.
If the question cannot be answered, the market is Void and each holder gets back what they put in
(see "Void").

It does not decide outcomes. A separate contract, oracle, does that, and market only accepts an
outcome from it.

---

## Where it sits among the other contracts

| Contract                                                   | Relationship to market                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| oracle                                                     | Registers every new market with it, and is the only account allowed to set an outcome. |
| council                                                    | Receives 25% of the trading fees (to start) as revenue, shared equally among the seats earning when it arrives. |
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
| Owner    | `new`, then `propose_owner` and `accept_owner` | Everything the operator can, plus `set_operator`, `propose_owner`, `set_fee_recipients`, `set_revenue_share_bps`, `set_min_sweep`, `set_next_sweep_id`, `set_fee_rate_bps`, `set_void_grace`, `set_sweep_timing`, `set_max_positions`, `set_max_market_locked`, `set_fee_limits`, `set_storage_policy`, `set_registration_fee`, `set_sells_paused`, `resume`, `reconcile_leg`, `reconcile_withdrawal`, `remove_verifier_key`, `upgrade` and `seal`. In a real deployment this is the DAO, so each of these needs a DAO proposal. SputnikDAO executes a proposal at the approval that reaches its threshold. Its voting period is the only delay, by owner decision (R-07). |
| Operator | `new`, then `set_operator` (owner only)        | Routine running: `create_market`, `retry_register`, `halt` (once per market), `set_market_cap`, `set_paused` and `claim_residual`. Cannot lift a halt, move fees, change owner, change the operator, or touch user money.              |
| Oracle   | `new` (fixed, no setter)                       | Only `set_outcome`.                                                                                                                                                                                                                                                                  |
| Anyone   | n/a                                            | Trade, deposit, withdraw, redeem (also by signed intent), register for storage (for themselves or for someone else) and unregister, `void_if_unresolved` (a grace period after `resolve_by`), `sweep_fees`, `prune_market`, `stage_code` (paying for the storage), and every view.                   |

The operator is meant to be a fast key held by a person or a bot, so that day to day work does not
wait on a DAO proposal. If it is stolen, the damage is limited: the thief can halt markets and
pause the contract, but cannot take money, redirect fees, lift a halt, or keep the key, because the owner can
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

Starting values: trade fee rate 200 basis points (2%), Council share of a sweep 2,500 basis points
(25%), minimum sweep 1,000,000 units, first sweep id 1, not paused, no markets, no fee recipients.
The other policy values start at the numbers shown under "Owner and operator management": Void grace
7 days, sweep waits 10, 60 and 60 minutes, 20 position entries, and fee limits 500, 1,000, 5,000 and
100,000,000.

Deploy and initialise in one batch signed by the contract account, and check afterwards that the
owner is yours. A deploy with no init in the batch leaves nothing open to a stranger, but it leaves
the contract unusable until its own account calls `new`.

---

## Units and conventions

| Thing               | Convention                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Collateral amounts  | Raw integer units of the token. The code assumes a 6-decimal token, so 1,000,000 units is 1 token.                    |
| Shares              | Integers. A winning share redeems for its part of the pool, which is at least 1 raw unit.                             |
| Prices              | Integers in millionths: the chance the pool implies. 500,000 means 50%. Yes price plus No price is always 1,000,000. |
| Times               | Nanoseconds since the Unix epoch, as the chain reports them. Passed in JSON as strings (`U64`).                       |
| Big numbers in JSON | `U64` and `U128` travel as strings, for example `"1000000"`.                                                          |
| Fee rates           | Basis points. 200 is 2%.                                                                                              |

---

## A market's life

1. The operator calls `create_market`. The market exists but cannot trade. The contract asks oracle
   to register it.
2. The oracle's answer comes back in a callback, and the market is marked `registered`. If the
   oracle refused or the call failed, the market stays shut and `retry_register` can send it again.
   A registered market is open for trading at once, empty, at even odds.
3. People trade until `close_at`. At the exact moment of close trading stops.
4. After close, someone proposes an outcome through oracle. Once the oracle has a final answer it
   calls `set_outcome`. If nothing has resolved the market by `resolve_by`, anyone asks the oracle
   for its deadline answer (`resolve_by_deadline`), which settles what can be settled and voids the
   rest. `void_if_unresolved` on this contract opens a grace period after `resolve_by` (7 days to start), for an
   oracle that is gone.
5. Holders call `redeem` to turn shares into balance, and `withdraw` to take the balance out as
   tokens. Once nobody is owed anything more, the operator or owner calls `claim_residual` to move
   whatever the pool still holds to the treasury (see "The residual").

The `status` shown by the views is, in this order of precedence: `resolved` if an outcome is set,
otherwise `halted` if halted, otherwise `closed` if the time has passed `close_at`, otherwise
`unregistered` if the oracle has not confirmed the market, otherwise `open`. Only `open` can trade.
`registered` is in the view as well.

---

## What a market stores

| Field                                                    | Meaning                                                                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`, `rule_text`, `resolution_source`, `void_policy` | The question and its rules, in words. Required, non-empty, with length limits below. A price market's `resolution_source` must name exactly one pair the publishers price, such as `BTC-USD` (see "Publishing and submitting prices" in [oracle.md](oracle.md)). |
| `category`, `subcategory`                                | Short lowercase slugs such as `crypto` and `bitcoin`.                                                                                                                                  |
| `rule_hash`                                              | A fingerprint of the rules, fixed at creation. See "The rule hash".                                                                                                                    |
| `price_rule`                                             | Optional. Makes this a price market. See "Price markets".                                                                                                                              |
| `close_at`                                               | When trading stops.                                                                                                                                                                    |
| `resolve_by`                                             | The deadline for an answer. After it, anyone can ask the oracle for the deadline answer, and 7 days later anyone can void the market here.                                             |
| `halted`                                                 | Set by `halt`. Stops trading.                                                                                                                                                          |
| `registered`                                             | True once the oracle has accepted the market.                                                                                                                                          |
| `outcome`                                                | Empty until resolved, then Yes, No or Void.                                                                                                                                            |
| `refunds`                                                | Set at resolution: true for a Void and for an answer nobody holds a share of, when each holder is paid back what they put in. See "Void".                                             |
| `locked`                                                 | The pool: every unit paid in less what sales and redemptions paid out. Never less than the cost of the shares outstanding while the market is open.                                  |
| `user_yes`, `user_no`                                    | Total shares outstanding, per side. They set the price (see "How trading works").                                                                                                    |
| `claims`                                                 | The sum, over positions that still hold shares, of what each has put in less what it has taken out, a position that has taken out more counting as zero. Refunds are shared by it.  |
| `holders`                                                | How many accounts hold a share of either side.                                                                                                                                         |
| `history`                                                | The last 120 prices, one per buy and sell, for drawing a chart. Chart only.                                                                                                            |

Next to the markets the contract keeps one cost record per position, `(market, account)`: what that
position has paid in less what it has taken out by selling. It is what a refund pays back. It is
removed when the position no longer holds a share, so a position that has sold everything is out of
any later refund.

### Limits

| Limit                      | Value                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Title                      | 200 bytes                                                                                                |
| Rule text                  | 2,000 bytes                                                                                              |
| Resolution source          | 300 bytes                                                                                                |
| Void policy                | 500 bytes                                                                                                |
| Category and subcategory   | 1 to 32 characters, lowercase letters, digits and hyphens only                                           |
| Entries per account        | 20 to start, owner-settable from 5 to 30. Each side an account holds in a market counts as one, and so does the market's cost record, so a position on one side takes two and 20 entries hold 10 single-sided markets. 30 is the most the 0.05 NEAR deposit pays for with the longest account id. The operator and the owner are not held to it. |
| Price history per market   | 120 points                                                                                               |
| `list_markets` page        | at most 50 per call                                                                                      |
| Pool size                  | at most 10^12 units (a million tokens at 6 decimals) per market by the pricing maths, and at most `config.max_market_locked` (10,000 tokens to start on a new deployment) by policy. The operator or owner can set a lower cap on one market with `set_market_cap` |

Policy values the owner can change (the DAO, by proposal) are listed under "Owner and operator management", each with a hard
range so a bad vote cannot brick the contract. Everything else here stays a compile-time constant: the gas floors, the text
length caps, the storage deposit, the pool size, the price history length, the `nep141:` prefix, the state version and the
10,000 basis point denominator. Gas floors are what the calls measurably burn, the length caps and history length bound what
a trade rewrites, the deposit and pool size bound storage and overflow, and the others are part of the data layout, so
none is a policy choice.

---

## Every method

### Setup and accounts

| Method                                                     | Who                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new(...)`                                                 | Deployer, once     | Initialises the contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `storage_deposit(account_id, registration_only)` (payable) | Anyone             | NEP-145. Registers `account_id`, or the caller when it is left out, and returns its `StorageBalance`. Needs at least 0.05 NEAR attached when the account is new. The 0.05 NEAR is kept to pay for the account's storage and anything above it goes back to the caller, who may be someone paying for another account. A payer other than the account and the verifier is recorded, and `storage_unregister` sends the 0.05 NEAR back to it; a deposit the verifier pays, from an Intents `storage_deposit` intent, goes back to the account. For an account that is already registered the whole deposit goes back. `registration_only` changes nothing, because the most an account can hold is the least it must. Registration is required to deposit, buy and sell. Both arguments are optional, but the call body must still be a JSON object, so send `{}` when passing neither. |
| `storage_withdraw(amount)` (payable, 1 yocto)              | Registered account | NEP-145. There is nothing above the flat deposit, so this returns the balance and refuses any amount above zero (`nothing above the 0.05 NEAR deposit to withdraw`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `storage_unregister(force)` (payable, 1 yocto)             | Anyone             | NEP-145. Closes the caller's account. The 0.05 NEAR goes back to whoever paid it, the account itself or its recorded sponsor, and the attached yocto to the account. An account that registered with `register` gets only the yocto back. Returns `false` if the caller was not registered. Refused while the caller holds any share (`redeem or sell your positions first`) any balance (`withdraw your balance first`) or a withdrawal still in flight (`a withdrawal is still pending`). `force: true` is refused, because it would burn what the account holds. Selling everything can leave a share or two of rounding dust, so the way out for a finished position is to redeem it.                                                                                                                                                                                    |
| `storage_balance_bounds()` (view)                          | Anyone             | `min` and `max` are both 0.05 NEAR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `storage_balance_of(account_id)` (view)                    | Anyone             | `{total: 0.05 NEAR, available: 0}` for a registered account, `null` for any other. An account that registered with `register` shows the same, although it holds no NEAR here, so a client reading "not null" as registered is right for both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `is_registered(account_id)` (view)                         | Anyone             | Whether an account has registered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Owner and operator management

| Method                                              | Who                  | What it does                                                                                                                                                    |
| --------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propose_owner(new_owner)`                          | Owner                | Names a new owner. Nothing changes yet.                                                                                                                         |
| `accept_owner()`                                    | The proposed account | Completes the handover. Two steps so a mistyped account cannot lock everyone out. Until it is accepted, the old owner keeps full power.                         |
| `set_operator(operator_id)`                         | Owner                | Replaces the operator, effective at once.                                                                                                                       |
| `set_fee_recipients(revenue_pool, treasury)`        | Owner                | Sets where fees go: the Council and the treasury, which must be different accounts. A sweep refuses until it is called. Takes effect for the next sweep and also for any amount still owed to the old recipients, which is sent to whoever is set at sweep time. |
| `set_revenue_share_bps(revenue_share_bps)`          | Owner                | Sets the Council's share of every later sweep, between the stored floor and ceiling (1,000 to 5,000 basis points to start). The treasury gets the rest, so the whole of every fee is always accounted for. A sweep already made keeps its split. |
| `set_min_sweep(min_sweep)`                          | Owner                | Sets the least a sweep acts on, from 1 to the stored ceiling (100,000,000 units to start). |
| `set_next_sweep_id(next_sweep_id)`                  | Owner                | Moves the id of the next sweep up, never down. A sweep id is used once and the Council refuses a repeat, so a market that replaces an old one starts above the ids the Council has taken. |
| `set_fee_rate_bps(fee_rate_bps)`                    | Owner                | Sets the trade fee rate. Only the owner can call it (`owner only`; the operator cannot). Refused above the stored ceiling, 500 basis points (5%) to start (`the fee rate is capped at <n> basis points`). Zero is allowed. Applies from the next trade. The ceiling itself moves only through `set_fee_limits`, which is owner only and never lets it past 2,000.                                                                  |
| `set_void_grace(grace_ns)`                          | Owner                | Sets the Void grace after `resolve_by` (1 to 60 days, 7 days to start), for markets created after the call. A market keeps the grace it was created with (event `void_grace_set`). |
| `set_sweep_timing(settle_wait_minutes, reconcile_wait_minutes, min_interval_minutes)` | Owner | Sets the wait before `settle_leg` (1 to 1,440 minutes, 10 to start), the wait before `reconcile_leg` (10 to 10,080 minutes, 60 to start, never under the settle wait) and the least time between two sweeps (60 to 1,440 minutes, 60 to start). Applies to every sweep, including those already made. |
| `set_max_positions(max_positions)`                  | Owner                | Sets how many entries an ordinary account can hold, from 5 to 30 (20 to start): each side it holds and each market's cost record count one. Positions already held stay. The operator and owner are still exempt. |
| `set_max_market_locked(max_market_locked)`          | Owner                | Sets the most one market's pool can hold, from 1,000,000 units to 10^12 (10,000 tokens to start on a new deployment; a deployment migrated from version 5 or 6 starts at 100,000; one migrated from version 7 keeps its stored value). A market already over a lowered ceiling takes no more buys and keeps everything else working. Event `max_market_locked_set`. |
| `remove_verifier_key(public_key)`                   | Owner                | Removes a public key registered for this account in the Intents verifier, by a 1 yocto call from this account (15 TGas). `seal` deletes NEAR access keys only, so this is how the owner closes a verifier key. Event `verifier_key_removal_sent`. |
| `set_registration_fee(registration_fee)`            | Owner                | Sets the fee, in collateral units, that a `register` transfer pays to register an account with no NEAR. 250,000 (0.25 of the 6-decimal collateral) to start, from 10,000 to 2,000,000 (0.01 to 2). Applies to registrations from then on (event `registration_fee_set`). |
| `set_fee_limits(max_fee_rate_bps, min_revenue_share_bps, max_revenue_share_bps, max_min_sweep)` | Owner | Sets the ceilings and floors the fee setters check against. Hard ranges: fee rate ceiling at most 2,000 basis points, Council share floor at least 500 and ceiling at most 9,000 with the floor below the ceiling, sweep minimum ceiling from 1 to 1,000,000,000. Starts at 500, 1,000, 5,000 and 100,000,000. Refused when the current fee rate, Council share or sweep minimum would fall outside the new limit, so the value is moved first. |
| `reconcile_leg(sweep_id, leg, arrived)`             | Owner                | Decides a fee leg (`council` or `treasury`) that is still pending or unresolved an hour after its sweep. See "Revenue whose result was lost". |
| `reconcile_withdrawal(id, paid)`                    | Owner                | Decides a withdrawal whose callback never arrived, once the reconcile wait (60 minutes to start, `set_sweep_timing`) has passed since the withdrawal. `paid: true` drops the record and the amount from the pending total, so it is no longer owed. `paid: false` drops the record and credits the balance back. The owner checks the verifier's events first. A callback that comes later finds no record and changes nothing. |
| `upgrade(code_hash)`                                | Owner                | Deploys the staged wasm with that sha256 and runs its `migrate`, in one batch. Needs at least 100 TGas attached, and exactly 100 works. See "Upgrading this contract".                 |
| `seal(public_key)`                                  | Owner                | Deletes that access key from this account. Refused until an upgrade has gone through `migrate`.                                                                 |

The fee rate ceiling's hard limit (20%) is written into the code, so even a captured owner cannot
set a fee above it. The hard bounds of the Council's share (5% to 90%) and of the minimum sweep are
written there too.

### Code

| Method                        | Who                 | What it does                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage_code()` (payable)      | Anyone              | The call input is a wasm. It is stored under its own sha256, which is returned. The deposit pays for the storage (about 1 NEAR per 100 KB). The contract keeps what the storage costs and does not refund it when the upgrade runs; only the surplus above the cost is refunded. Staging code someone else staged costs nothing and changes nothing. Attach 100 TGas, because 250 KB burns about 31. |
| `migrate()`                   | The contract itself | Runs in the new code in the same batch as the deploy. Refuses unless `upgrade` marked the upgrade in flight. Reads the state as the layout its version byte names (5, 6, 7 or the current 8), clears the mark, sets `upgrade_proven`, returns the state.                                                                   |
| `is_staged(code_hash)` (view) | Anyone              | Whether a wasm with that sha256 is staged.                                                                                                                                                                                                                                            |

### Running markets

| Method                                                                                                                     | Who               | What it does                                                                                                                                                                                   | Refused when                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_market(title, rule_text, resolution_source, void_policy, category, subcategory, close_at, resolve_by, price_rule)` | Operator or owner | Payable: requires `market_storage_deposit` (`attach the market storage deposit`), refunds excess, creates a market and asks the oracle to register it. `price_rule` is optional. New state must leave `storage_reserve`.                                                                                                | Not operator or owner; contract paused; any of the four text fields empty; text over its limit; bad category slugs; `close_at` not in the future (`close_at must be in the future`); `resolve_by` not after `close_at` (`resolve_by must be after close_at`); for a price rule: observation time before `close_at` or not before `resolve_by`, strike zero, or more than 18 decimals. |
| `retry_register(market_id)`                                                                                                | Operator or owner | Sends the oracle registration again.                                                                                                                                                           | Already registered.                                                                                                                                                                                                                                                                                          |
| `halt(market_id, reason)`                                                                                                  | Operator or owner | Stops new buys in one market for 24 hours, with a recorded reason. Sells, redemption after resolution and withdrawals keep working. The operator can halt a market once; after that only the owner can halt it again, which extends the halt by another 24 hours. A halt changes no payout, so it can come at any time before resolution. | Not operator or owner; market already resolved; the operator halting a market a second time (`the operator halts a market once, the owner halts it again`).                                                                                                                                                                                                                                                              |
| `resume(market_id)`                                                                                                        | Owner             | Lifts a halt and clears the record of it, so the operator can halt that market once more. A halt the owner set cannot be lifted by the operator key.                                           | Not owner; market already resolved.                                                                                                                                                                                                                                                              |
| `set_sells_paused(sells_paused)`                                                                                           | Owner             | Stops `sell` (`sells are paused`). Kept apart from `set_paused` so the operator cannot take away the exit from an open position. Logs `sells_paused`. | Not owner. |
| `set_paused(paused)`                                                                                                       | Operator or owner | Stops buys, deposits and new markets. Sells, withdrawals and redemptions keep working.                                                                                                         | Not operator or owner.                                                                                                                                                                                                                                                                                       |
| `set_market_cap(market_id, cap)`                                                                                           | Operator or owner | Sets a lower pool cap for one market, from 1,000,000 units up to the ceiling set by `set_max_market_locked`, so a market with a thin bond can carry less than the rest. A buy that would take the pool past it is refused. Event `market_cap_set`. `market_cap(market_id)` is the view. | Not operator or owner; no such market (`no such market`); a cap outside its range (`the cap must be between the hard minimum and the ceiling`). |
| `claim_residual(market_id)`                                                                                                | Operator or owner | After resolution, once every holder who is owed a payout has redeemed, moves what the pool still holds into the treasury's due bucket (`treasury_due`). The next sweep pays it on the treasury leg, whole and not split with the Council. See "The residual". | Not resolved (`not resolved`); a holder is still owed a payout (`holders are still owed their payouts`); nothing is left (`nothing is left over`), which is also the answer to a second call.                                                                                                              |

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
| `sell(market_id, side, shares, min_collateral)` (payable, 1 yocto)        | Sells `shares` back to the pool for what they are worth now, and refuses if that, less the fee, is under `min_collateral`. Needs exactly 1 yoctoNEAR.                                                                                                                                                                                                                                        |
| `redeem(market_id)`                                                       | After resolution, converts all the caller's shares in that market into balance. No deadline.                                                                                                                                                                                                                                                                                                 |
| `withdraw(amount)` (payable, 1 yocto)                                     | Pays `amount` of the caller's balance into the caller's own Intents account with an `mt_transfer` of 1 yocto from this contract. The balance is reduced first and the withdrawal is recorded under a new id (a counter that starts at 1 and only goes up) with its account, amount and time, before the transfer is sent (event `withdraw`). The callback `on_withdraw(id)` takes the amount and account from that record: success removes it (event `withdraw_confirmed`), failure removes it and restores the balance (event `withdraw_failed`). A callback for an id with no record changes nothing. A callback that never reports leaves the amount in the pending total, visible and still owed, and it is not credited back until the owner decides it with `reconcile_withdrawal`. Needs exactly 1 yoctoNEAR attached. It pays only the caller, so a mistyped target cannot lose money.                                                                                                                                                                                                                             |
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
| `register`                         | Not yet registered | Registers the sender for the registration fee (`config.registration_fee`), which is due to the treasury whole, and credits the rest to the sender's balance. The market's own NEAR carries the account's storage, inside the storage reserve. Refused if paused, if the sender is registered already (`already registered`) or if the amount is short of the fee (`send at least the registration fee`). Extra text after `register` is ignored. |
| `buy:<market>:<side>:<min shares>` | Registered account | Buys directly with the money sent. `side` is `yes` or `no`. `min shares` is a slippage floor and must be above zero. Extra text after the fourth part is ignored. |

Also refused for any message: an amount of zero, an unknown action, or a market id that is not a
number.

The website attaches 100 TGas to this `mt_transfer_call`, for a deposit and for a buy, and both work with it. The verifier keeps about 20.6 TGas of what is attached and gives this contract the rest; a buy landed with as little as 24 TGas attached in the sandbox.

A plain deposit is not a funded position. Depositing tokens into the verifier with the market's
account as the recipient, in any message form, credits the market's Intents account and never calls
this contract, so nothing is credited to the sender. The old notify form
(`{"receiver_id":"<market>","msg":"deposit","min_gas":...}`) is no different: the verifier ignores the
fields it does not know. That money is surplus. It shows up as the verifier holding more than
`total_owed`, it is never credited automatically, and no method of this contract credits it. Clients
must fund the market through `mt_transfer_call`, or with the token itself as below.

### Money in by token: `ft_on_transfer`

An account that holds the collateral as a NEAR token can pay the market directly. It registers
first with `storage_deposit` and 0.05 NEAR, paid by itself or by anyone for it, then calls
`ft_transfer_call(receiver_id: <market>, amount, msg)` on the token with 1 yocto and 100 TGas. The
token moves the amount to the market and calls `ft_on_transfer(sender_id, amount, msg)` here, the
standard NEP-141 receiver (`FungibleTokenReceiver` from `near-contract-standards`). The market keeps
none of it as a token: it sends the whole amount on with the token's
`ft_transfer_call(receiver_id: <verifier>, amount, msg: <this contract>)`, which credits the market's
own Intents account, and credits the sender only in the callback `on_forwarded`, once the verifier
has the money. The books therefore never count money the verifier does not hold. The market's
account must be registered with the token first, a one-time `storage_deposit` on the token; until
then the token refuses the transfer.

The hook checks, in this order: the caller is the collateral token (`only the collateral token can
deliver money`); the sender is not the verifier (`send from your own account, not out of the
verifier`), because an Intents withdrawal with a message arrives from the verifier and does not say
whose money it is; the amount is above zero; and at least 75 TGas reached the hook (`attach at least
75 TGas`): 50 for the forward, 20 for the callback, which may start a buy, and 5 for its own work.
Then:

| `msg`                              | Who                | What it does |
| ---------------------------------- | ------------------ | ------------ |
| `deposit`                          | Registered account | Credits the amount to the sender's balance once the verifier has it. Refused if paused or not registered. Extra text after `deposit` is ignored. |
| `buy:<market>:<side>:<min shares>` | Registered account | Credits the amount once the verifier has it, then buys `side` with it as `buy` does from a balance. Refused if paused, not registered, the market is not open, the side is not `yes` or `no`, or the minimum is zero. A buy that fails after the credit, because the price moved or the market closed in between, leaves the money in the balance. |

Any other message is refused (`unknown action`), `register` included: an account with no
NEAR registers through the verifier instead (see "Money in"). Every refusal comes before the
forward, so the token hands the whole amount back to the sender.

`on_forwarded` reads how much the verifier took from the token's answer. That much is credited and
the rest goes back to the sender: when the forward failed or the verifier refused it, nothing is
credited and the token returns everything. An account that unregisters while its money is on its
way is credited it all the same and takes it out with `withdraw`, which needs no registration; the
storage deposit it got back on leaving is not paid twice. The callback never refuses, because what
it is told about is already in the verifier. For a `buy` it credits what the verifier took and
starts `buy_for`, a private method, with that amount and 10 TGas. A `buy_for` that fails reverts
only itself, so the money stays credited. The events are the ones the verifier path emits:
`deposit`, then `buy` after a token buy. A token whose own refund step fails can leave a transfer in
the verifier with nobody credited; that shows as surplus, never as money owed and missing.

### Signed actions: `on_auth`

A holder can also trade and exit without a NEAR transaction of their own. They sign an `auth_call`
intent that names this contract and a message, anyone relays it to the verifier's `execute_intents`,
and the verifier calls `on_auth(signer_id, msg)` here. By then the verifier has checked the signature,
the nonce and the deadline, so `signer_id` carries the same trust as the `sender_id` of a signed
transfer above. Only a full-access transaction from a named account can add a signing key for it in
the verifier, and an implicit account (ed25519 hex, or a 0x address from a secp256k1 or passkey key) is
its own key, so an account that holds nothing but collateral in the verifier can use every action below.

The hook refuses any caller but the verifier (`only the verifier can act for a signer`). Each action
runs the same code as the direct method, for `signer_id` in place of the caller, so the pauses, checks,
events and payout target are the same. It takes no deposit: the verifier's signature check does the
work the 1 yocto does on a direct call. An intent that sets `attached_deposit` is refused, and the
verifier's own documentation says that wNEAR is not refunded, so clients leave it unset.

| `msg`                                                   | Runs as                                           |
| ------------------------------------------------------- | ------------------------------------------------- |
| `buy:<market>:<side>:<amount>:<min shares>`             | `buy`, out of the signer's balance                |
| `sell:<market>:<side>:<shares>:<min collateral>`        | `sell`                                            |
| `redeem:<market>`                                       | `redeem`                                          |
| `withdraw:<amount>`                                     | `withdraw`, into the signer's own Intents account |

Also refused: an unknown action (`unknown action`) and a part that is not a number (`bad market id`,
`bad amount`, `bad min shares`, `bad shares`, `bad min collateral`). Extra text after the last
part is ignored, as above.

The verifier starts `on_auth` without waiting for it, so `execute_intents` succeeds even when this
contract refuses the action. The refusal shows as a failed receipt on this contract, nothing moves,
and the intent's nonce is spent. `on_auth` gets the intent's `min_gas` (10 TGas when it is left out)
plus an even share of the gas the relayer attached. A withdrawal reserves 25 TGas of it for the
verifier's `mt_transfer` and the callback. Measured in the sandbox with `min_gas` at 50 TGas and 300
TGas attached by the relayer: a signed buy, sell or redeem burns 2.6 to 3.1 TGas in the market and
7.2 to 7.7 TGas in all, and a signed withdrawal 5.2 TGas in the market, callback included, and 14.1
TGas in all.

A signer with no NEAR registers with a signed transfer whose message is `register` (see "Money in"),
or anyone can pay the 0.05 NEAR for it with `storage_deposit(account_id)`.
`contracts/tests/tests/intents_auth.rs` runs both paths against the real verifier with a signer that has
no NEAR account.

---

## Upgrading this contract

No access key can replace this code outside a vote, and no deleted key can freeze it, because the
code path is part of the contract. The owner (the DAO) calls `upgrade` with the hash of a staged
build.

| Step    | What happens                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage   | Anyone calls `stage_code` with the wasm as the input. The contract answers with the sha256. Different code cannot overwrite it because the key is the hash.                                                                                                                                                                                                                                     |
| Propose | The DAO proposes a `function_call` to `upgrade` with `{"code_hash":"<base58>"}`. The proposal is public while members vote. SputnikDAO runs it in the same call as the approval that reaches the threshold, and it fails if the threshold is not reached before the voting period ends. There is no delay after approval, by owner decision (R-07).                                                                                                                                                                                                                                          |
| Execute | `upgrade` checks the caller is the owner and that 100 TGas are attached (`attach at least 100 TGas to upgrade`), takes the staged wasm out of storage, sets `upgrade_in_flight`, and sends one batch to this account: deploy, then `migrate`. A `migrate` that panics reverts the deploy and the old code stays. The staged copy is gone either way, so a failed or rolled-back upgrade stages the code again and pays the storage deposit again. Upgrading to code identical to what runs works and leaves the code hash unchanged. |
| Prove   | `migrate` refuses to run unless `upgrade_in_flight` is set (`migrate runs only inside an upgrade`), then clears it and sets `upgrade_proven`. A hand-called `migrate` therefore proves nothing. When the batch fails, `on_upgrade_done` clears the mark (event `upgrade_failed`) and the next `upgrade` sets it again. `config` shows both flags with `state_version`.                                                     |
| Seal    | `seal(public_key)` deletes an access key. It is refused until `upgrade_proven` is true (`prove the upgrade path before deleting keys`), so keys are deleted only after one upgrade has worked on this chain.                                                                                                                                                                                    |

The state struct starts with `state_version: u16`, 8 today. `migrate` reads those two bytes and accepts only the exact roots of versions 5, 6 and 7 (`StateV5`, `StateV6`, `StateV7`) or the current version-8 root. Other versions fail with `unsupported state version`; there is no trial decoding. Version 7 gains the halt record (`halt_until`, empty; a market halted before the record existed stays halted until the owner calls `resume`), and version 6 also gains the market caps with the ceiling set to 100,000 tokens, the value that deployment was running with. Version 5 converts only while it has created no market (`a version 5 market that has created markets cannot move to dynamic parimutuel pricing; deploy this version fresh`): balances, registrations, fees, sweeps and withdrawals carry over, the creation fee, opening price bounds and Void price window are dropped, and an empty cost-record map is added. A constant-product pool has no record of what each holder paid, so its markets cannot become parimutuel ones; a version-5 deployment that has markets is wound down and this version deployed fresh beside it.

Every market, sweep and withdrawal is stored inside a one-byte version tag (an enum such as
`VersionedMarket::V1(Market)`, tag 0). Reads go through `into_current`, which turns an older variant into
the current record, and every write stores the newest variant. A tag no build has written fails to decode
(`Cannot deserialize element`) instead of being misread. A later layout of a record adds a variant and a
conversion, and old records upgrade as they are read, with no pass over the map. The market tag restarts at 0
with version 6: a migration from version 5 only ever finds an empty market map, so no constant-product record is read.

Withdraw and redeem stay unpausable: `set_paused` does not touch them, an upgrade does not touch
them, and neither does `halt`. `set_paused` does not stop `sell` either: only the owner's `set_sells_paused`
does. A halted market takes no new buys but still takes sells. A user who does not trust a pending upgrade can withdraw a balance
and redeem a resolved position at any time, so that exit does not depend on any delay. Open positions stay in the market until it
resolves or they are sold while trading is open. The unit test
`withdraw_and_redeem_still_work_while_the_market_is_paused` checks both calls on a paused contract.

Measured in the sandbox for a 289 KB build: `upgrade` burns 34 TGas in all, 20 of them the deploy
and migrate batch, and `seal` burns 2. The accepted deployment controls are in
[DEPLOY.md](DEPLOY.md#3-administration-and-upgrades). Trezu/Sputnik execution still needs its own
integration evidence.

---

## How trading works

The pricing is a dynamic parimutuel market (Pennock, 2004). There is no pool of shares to trade
against and nobody has to put money in first. The market keeps the two totals of shares outstanding,
`user_yes` and `user_no`, and the cost of a market with those totals is the length of that pair:

```text
C(yes, no) = sqrt(yes^2 + no^2)
```

The pool, `locked`, never holds less than `C` rounded up. A buy adds to the pool and grows its side's
total until the cost has grown by exactly what was paid in; a sale shrinks its side's total and pays
out what the cost falls by:

```text
buy  amount on a side:  grown  = floor(sqrt((ceil(C) + amount)^2 - other^2)), shares = grown - side
sell shares on a side:  refund = floor(C(side, other)) - ceil(C(side - shares, other))
```

Every rounding goes the pool's way, so a round trip returns at most what it paid, and repeated tiny
trades cannot make money. The tests confirm that no sequence of buys and sells by one trader ends in
profit, and that the pool always holds at least its cost.

The Yes price is the chance the totals imply, `yes^2 / (yes^2 + no^2)` in millionths, and the No price
is the rest. An empty market shows 500,000. The first buyer of an empty market gets a share for every
unit, and a share never costs more than one unit, so a winning share, which is paid
`shares * locked / winning shares`, always pays back at least what it cost.

An example without fees. Alice puts 100 tokens on Yes in an empty market and gets 100 shares. Bob puts
100 on No and gets 173.2, because No was the side with fewer shares. A third trader then puts 100 on
Yes and gets 144.9. If Yes wins, the 300 in the pool is split over the 244.9 Yes shares: Alice gets 122.5
and the third trader 177.5. Both get back more than they put in, and Bob loses his 100. The unit test
`early_winners_are_diluted_by_late_money_but_never_below_what_they_paid` in `dpm/src/lib.rs` runs these numbers.

### Buying

You send `amount` of collateral and a minimum number of shares. The contract:

1. Takes the fee, 2% of `amount` rounded up (see "Fees").
2. Buys shares with the rest.
3. Refuses if fewer shares than `min_shares` result (`price moved, you would get fewer shares than
   your minimum`), or if the buy would take the pool past 10^12 units (`cannot buy that amount`).

The amount less the fee goes into the market's `locked` and onto the position's cost record. The fee
goes to the fee bucket.

### Selling

You name `shares`, how many to sell, and `min_collateral`, the least you will accept after the fee.
The contract works out what those shares fetch now, takes the fee, 2% of that rounded up, and credits
you the rest. `quote_sell(market_id, side, shares)` returns the same numbers. A sale that would fetch
nothing, or no more than its fee, is refused (`cannot sell that many shares`), and so is one that would
pay less than the minimum (`price moved, you would get less than your minimum`). What the sale fetches
comes off the position's cost record. A position sold to its last share is closed: the record is
removed, and the position takes no part in a later refund, so an exit is final.

A share is worth less to sell after money has gone onto the other side, and more after money has gone
onto its own. A trader who bought Yes and then sees No buyers arrive sells at a loss, as in any market.

### The market must be open

A buy or sell is refused unless the market is registered, not resolved, and strictly before
`close_at`. Trading at the exact close instant is refused. A buy also needs the market not to be halted
and the contract not to be paused. A sell works in a halted market, and stops only for the owner's
`set_sells_paused`.

### Slippage and sandwiching

Every buy needs a minimum number of shares and every sell a minimum amount, so a trader is never
filled at a price they did not accept. The minimum cannot be zero, so there is no way to opt out of
the protection. It protects the trader, not the other holders: someone who buys ahead of a large order
and sells after it is paid by the price that order moves, and that comes out of the pool the other
holders share. The fee on both legs makes a small sandwich a loss. The unit tests
`a_buyers_minimum_bounds_what_a_sandwich_can_take_from_the_buyer` and
`when_the_victims_minimum_refuses_the_trade_the_attacker_is_left_with_a_loss` measure it.

---

## Fees

| Fee                       | Rate                                                                                                                                                               | Who pays                           | Where it goes  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | -------------- |
| Trade fee                 | `rate` of what the trade moves: of the amount a buy pays in, and of the amount a sale fetches. 2% to start. | The buyer or seller, on each trade | The fee bucket |
| Redeem, withdraw, deposit | None                                                                                                         | n/a                                | n/a            |

The fee is rounded up. The price you are quoted by `quote_buy` and `quote_sell` is produced by the
same function that charges the trade, so what is quoted is what is charged. Opening a market costs no
fee; its storage deposit is NEAR and goes to storage, not to the fee bucket.

Fees sit in a bucket outside every market's pool, so they never count toward what a market pays out.

### Sweeping

Anyone can call `sweep_fees`. It refuses until the owner has set the recipients
(`the fee recipients are not set, the owner must call set_fee_recipients before a sweep`). It does
nothing, and takes no id, when `fees` plus `revenue_due` plus `treasury_due` is below `min_sweep`
(1,000,000 units to start), or when both legs would be empty. So a second `sweep_fees` call inside the
sweep interval that finds nothing new to act on is accepted and creates nothing: it returns null, takes no
id and moves no money. A sweep that would act refuses within the sweep interval of the previous one (60
minutes to start and at least; `wait an hour since the last sweep`, or `wait <n> minutes since the last
sweep` for any other interval), so a refused due cannot be re-swept at will and the records stay at 24 a
day at most.

Otherwise it splits the bucket by the Council's share in basis points, rounding both parts down:

```text
council  = fees * revenue_share_bps / 10000       (rounded down)
treasury = fees * (10000 - revenue_share_bps) / 10000
carry    = fees - council - treasury               (0 or 1 unit, stays in fees)
```

The carry is at most one unit and goes to neither leg. It stays in `fees` and joins the next sweep.
Each leg then adds what earlier refused legs left in its due bucket. At the starting 2,500: 1,000,001
units give 250,000 to the Council, 750,000 to the treasury and 1 left in `fees`; 7 give 1, 5 and 1;
3 give 0, 2 and 1.

The sweep takes the next sweep id, writes the record (the account, amount and status of both legs,
and what was carried) and zeroes both due buckets, all before either transfer is sent. A transfer
that fails changes only its own leg and its own bucket. The Council's leg is an `mt_transfer_call`
with the message `revenue:<sweep id>`, so the Council counts it once, under the sweep id and this market's
account. The Council splits what it receives equally among the seats earning when it arrives: a seat
staked on UTC day D earns from day D+1, and an amount that arrives with no seat earning waits in the
Council's carry for the next sweep (see [council.md](council.md)). The treasury's leg is a plain `mt_transfer`. Calling `sweep_fees` twice at once pays out once. Payouts go only to the accounts the
owner set: the verifier does not check that a receiver exists, so a mistyped recipient would lose the
money.

| Leg status   | Meaning                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `pending`    | The transfer is sent and its callback has not run.                                           |
| `settled`    | The recipient has the money. A leg with nothing in it starts here.                           |
| `refused`    | The verifier gave the money back. The amount is in its due bucket for the next sweep.        |
| `unresolved` | No usable report came and nobody can tell where the money is. Only the Council leg can be.  |

Each leg settles by its own callback, so the treasury's leg can be `settled` while the Council's is still
`pending`. A callback acts on a leg only while it is `pending`, so a callback that runs twice, or after the
owner has decided the leg, changes nothing.

The sweep refuses less than 87 TGas (`attach at least 87 TGas: a sweep sends the Council its part and
the treasury its part`). That is 42 for the Council's transfer call (22 for the verifier's own part
and 20 for the Council's receipt), 15 and 10 for the treasury's transfer and its callback, 10 for the
Council's callback and 10 for the call itself. Measured in the sandbox: the verifier needs about 21 TGas attached to `mt_transfer_call` before the receiver gets any, and the Council's revenue receipt burns 2.0 to 11.7 TGas, depending on how many days behind it is (up to 30; a receipt more than 30 days behind is refused with `call advance_days first`, see [council.md](council.md)). The sweep itself burns 3.4 TGas in the market, and about 20 to 22 in all at the 87 TGas floor, with both legs arriving.

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

Anyone settles it with `settle_leg(sweep_id)` once the settle wait has passed since the sweep (10 minutes to start). It works only on a Council leg that is `unresolved`: a leg that is `pending`, `settled` or `refused` is refused with `the leg is not unresolved`, so a second call on an already settled leg changes nothing. The market asks the
Council for `received_of(market, sweep_id)`, passing this contract's own account as `market`, because the
Council keeps its records per market. The Council takes each sweep id once, so its answer cannot change
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
`revenue_due`, `treasury_due`, `revenue_unresolved` and the withdrawals in flight. A withdrawal is owed until the
verifier confirms it, so the verifier's balance covers `total_owed()` at every moment. A pending leg is out of the books because its
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
`void_if_unresolved` is called after the grace period past `resolve_by` (7 days to start).

A Void pays each holder back what their position put in, less what it has already taken out by
selling: its cost record. The price at close plays no part, so pumping one side before a Void, or
halting a market to hold a price, gains nothing (the unit test
`pumping_one_side_before_a_void_returns_the_pumper_only_what_they_put_in` and the sandbox test
`a_pump_held_by_a_halt_until_a_void_pays_each_holder_back_what_they_put_in`).

The same refund applies when a market resolves Yes or No and nobody holds a share of that answer:
there is no winner to pay, so everyone still in is paid back (`an_answer_nobody_holds_pays_everyone_back_like_a_void`).
The `refunds` field and the `refunds` flag of the `outcome_set` event say which kind of payout a
resolved market makes.

The fees are not refunded: they were the price of trading. A position's refund is

```text
refund = claim * min(locked, claims) / claims
```

where `claim` is the position's cost record (never below zero) and `claims` their sum over every
position still holding shares. The pool normally holds exactly the claims, so each holder gets their
claim back in full. A holder who sold at a profit before the Void has taken out more than they put in,
and that profit came from the pool, so the pool is short of the claims. The shortfall is then shared
by everyone still in, in proportion to what each put in
(`a_void_after_a_profit_taker_left_scales_every_refund_down_alike`). A holder who sold at a loss left
the loss in the pool: it is more than the claims, and the surplus is the residual.

---

## The residual

What a resolved market's pool still holds once every holder who is owed a payout has redeemed is the
residual. It comes from rounding, a unit or two per payout, and from refund markets where holders who
sold at a loss left that loss in the pool. `claim_residual` moves it to `treasury_due`, and the next
sweep pays it to the treasury. It is refused while anyone is still owed a payout, so it can never take
a holder's money: a market resolved Yes or No waits for the winners, a refund market for everyone with
a claim. Losing shares are owed nothing and do not hold it up, though `prune_market` still waits for
them.

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

| Outcome                          | A position is paid                                                          |
| -------------------------------- | --------------------------------------------------------------------------- |
| Yes, with Yes holders            | its Yes shares times `locked`, divided by all the Yes shares outstanding    |
| No, with No holders              | its No shares times `locked`, divided by all the No shares outstanding      |
| Void, or an answer nobody holds  | its refund (see "Void")                                                     |

Losing shares pay nothing. `redeem` pays all of the caller's shares in a market at once into their
balance, rounded down (a unit or so of dust per holder can stay in the market, which
`claim_residual` later collects), and returns the amount. As winners redeem, the pool and the winning
shares shrink together, so the order in which they redeem does not change what each gets beyond rounding. Redeeming
has no deadline and works while paused or halted.

---

## The invariant

While a market is open, the pool must hold at least the cost of the shares outstanding:
`locked >= ceil(sqrt(user_yes^2 + user_no^2))`. Once it resolves to an answer that has holders, the
pool must hold at least the winning shares outstanding, which is what makes every winning share worth
at least one unit; a refund market only needs what it pays out, which the formula keeps within
`locked`. `check_invariant(market_id)` returns whether this holds. It is checked after every step of
the randomized tests, which run sequences of up to 60 random trades across two markets, resolve each
as Yes, No or Void, and redeem in random order, ending with the pool empty and no claims left. The
pricing module has its own property tests: the pool holds its cost after any sequence of trades,
winning payouts together never exceed the pool, and a winning share pays back at least what it cost.

---

## Views (free to call)

| View                                                         | Returns                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config()`                                                   | state version, upgrade proven, upgrade in flight, owner, pending owner, operator, oracle, verifier, collateral token id, paused, sells paused, number of markets, storage deposit, registration fee, position cap, market pool ceiling (`max_market_locked`), fee rate, revenue pool and treasury (null until set), the Council's and the treasury's share in basis points, minimum sweep, next sweep id, revenue unresolved, Void grace (ns), settle wait, reconcile wait and sweep interval (minutes), and the fee limits (fee rate ceiling, Council share floor and ceiling, sweep minimum ceiling) |
| `get_market(market_id)`                                      | One market: id, title, rule text, source, void policy, category, subcategory, rule hash, price rule, close and resolve times, status, registered, outcome, refunds, Yes and No price, Yes and No shares outstanding, locked, holders, pruned |
| `list_markets(from_index, limit)`                            | A page of markets (limit capped at 50)                                                                                                                                                                                                          |
| `get_history(market_id)`                                     | The price log: time and Yes price for each point                                                                                                                                                                                                |
| `total_owed()`                                               | Everything the contract owes in collateral units: balances, locked collateral, fees, both dues, revenue unresolved and withdrawals in flight. Compare with the verifier's `mt_balance_of` for this account. A constant-size sum |
| `owed_breakdown()`                                           | `{balances, locked, fees, revenue_due, treasury_due, unresolved, pending_withdrawals, total}`, all `U128`. The parts are the buckets `total_owed` adds and `total` equals it |
| `get_account(account_id)`                                    | `{registered, available, pending_withdrawals, positions}`: `available` is `get_balance`, `pending_withdrawals` is the account's withdrawals in flight, `positions` is the total held-market count, or null for legacy exempt accounts whose total is not known. An unknown account gives `false` and zeros |
| `in_flight()`                                                | `{withdrawals, withdrawal_count, legs, leg_count}`: withdrawals sent and not yet reported, and the fee legs that are pending or unresolved (amounts `U128`, counts `u32`). Both are running totals |
| `get_balance(account_id)`                                    | An account's withdrawable balance                                                                                                                                                                                                               |
| `get_shares(market_id, account_id)`                          | The account's Yes shares and No shares in that market                                                                                                                                                                                           |
| `get_positions(account_id, from_market?, limit?)`                                  | One bounded page where the account holds shares, by market id: Yes and No shares, status, outcome (null until resolved) and the amount `redeem` would credit now (0 until resolved). Ordinary accounts read their small index; exempt accounts scan at most 100 consecutive IDs. Advance the cursor by the window even when no holdings match                                                                 |
| `quote_buy(market_id, side, amount)`                         | Shares you would get and the fee, or zeros if the trade cannot happen                                                                                                                                                                           |
| `quote_sell(market_id, side, shares)`                        | What those shares fetch before the fee, the shares (the number asked), and the fee, or zeros if the sale cannot happen                                                                                                                         |
| `get_fees()`                                                 | Collected, owed to the revenue pool (`revenue_due`), owed to the treasury (`treasury_due`), revenue unresolved                                                                                                                                  |
| `get_sweep(sweep_id)`, `list_sweeps(from_index, limit)`      | A sweep record: id, time, the part of the fees it split, what each leg carried, and each leg's account, amount and status. A page is at most 50, oldest first                                                                                   |
| `storage_balance_bounds()`, `storage_balance_of(account_id)` | NEP-145 views, under "Setup and accounts"                                                                                                                                                                                                       |
| `is_registered(account_id)`                                  | Whether the account registered                                                                                                                                                                                                                  |
| `is_staged(code_hash)`                                       | Whether a wasm with that sha256 is staged                                                                                                                                                                                                       |
| `check_invariant(market_id)`                                 | Whether the pool rule holds (see "The invariant")                                                                                                                                                                                               |
| `market_cap(market_id)`                                      | The most that market's pool can hold: its own cap, or the ceiling when it has none or the ceiling is lower                                                                                                                                      |

---

## Events

Every state change logs one line starting `EVENT_JSON:` followed by JSON of the form
`{"standard":"market","version":"1.0.0","event":"<name>","data":{...}}`.

| Event                     | When                                                                  | Data                                              |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `owner_proposed`          | `propose_owner`                                                       | owner, proposed                                   |
| `owner_changed`           | `accept_owner`                                                        | from, to                                          |
| `operator_set`            | `set_operator`                                                        | operator                                          |
| `market_created`          | `create_market`                                                       | market_id, rule_hash, title, category, subcategory, close_at, resolve_by |
| `market_registered`       | oracle accepted it                                                    | market_id                                         |
| `market_registration_failed` | the oracle call failed (`on_registered`)                           | market_id                                         |
| `market_registration_retried` | `retry_register`                                                  | market_id                                         |
| `market_halted`           | `halt`                                                                | market_id, reason, until (when the halt lapses)   |
| `market_resumed`          | `resume`                                                              | market_id                                         |
| `paused`                  | `set_paused`                                                          | paused                                            |
| `sells_paused`            | `set_sells_paused`                                                    | sells_paused                                      |
| `fee_recipients_set`      | `set_fee_recipients`                                                  | revenue_pool, treasury                            |
| `revenue_share_set`       | `set_revenue_share_bps`                                               | revenue_share_bps, treasury_share_bps             |
| `min_sweep_set`           | `set_min_sweep`                                                       | min_sweep                                         |
| `next_sweep_id_set`       | `set_next_sweep_id`                                                   | next_sweep_id                                     |
| `fee_rate_set`            | `set_fee_rate_bps`                                                    | fee_rate_bps                                      |
| `void_grace_set`          | `set_void_grace`                                                      | grace_ns                                          |
| `sweep_timing_set`        | `set_sweep_timing`                                                    | settle_wait_minutes, reconcile_wait_minutes, min_interval_minutes |
| `max_positions_set`       | `set_max_positions`                                                   | max_positions                                     |
| `max_market_locked_set`   | `set_max_market_locked`                                               | max_market_locked                                 |
| `market_cap_set`          | `set_market_cap`                                                      | market_id, cap                                    |
| `storage_policy_set`      | `set_storage_policy`                                                  | market_storage_deposit, reserve                   |
| `market_pruned`           | `prune_market`                                                        | market_id, rule_hash                              |
| `fee_limits_set`          | `set_fee_limits`                                                      | max_fee_rate_bps, min_revenue_share_bps, max_revenue_share_bps, max_min_sweep |
| `residual_claimed`        | `claim_residual`                                                      | market_id, amount, to                             |
| `outcome_set`             | `set_outcome`, or `void_if_unresolved` (which adds `"by":"deadline"`) | market_id, outcome, refunds                       |
| `deposit`                 | a deposit                                                             | account, amount                                   |
| `buy`                     | a buy                                                                 | market_id, account, side, shares, collateral (paid in, fee included), fee, price_yes, price_no, yes_shares, no_shares (after the trade) |
| `sell`                    | a sell                                                                | market_id, account, side, shares, collateral (fetched, before the fee), fee, price_yes, price_no, yes_shares, no_shares (after the trade) |
| `redeemed`                | `redeem`                                                              | market_id, account, amount, yes_shares, no_shares (burned) |
| `withdraw`                | `withdraw`, before the transfer is sent                               | account, amount, id                               |
| `withdraw_confirmed`      | the verifier moved the money                                          | account, amount, id                               |
| `withdraw_failed`         | the verifier refused the transfer, balance restored                     | account, amount, id                               |
| `fees_swept`              | `sweep_fees`                                                          | id, total, revenue_pool, council (leg amount), treasury_account, treasury (leg amount) |
| `fee_leg_settled`         | a leg ended with the recipient holding the money                      | id, leg, to, amount                               |
| `fee_transfer_failed`     | a fee transfer failed, amount owed again                              | id, leg, to, amount                               |
| `fee_transfer_unresolved` | a revenue transfer returned no report, amount parked                  | id, leg, to, amount                               |
| `fee_leg_reconciled`      | `reconcile_leg`                                                       | id, leg, to, amount, arrived                      |
| `withdrawal_reconciled`    | `reconcile_withdrawal`                                                | account, amount, id, paid                         |
| `registered`              | `storage_deposit` or `register` registered an account                 | account, paid_by, fee (a `register` only)         |
| `unregistered`            | `storage_unregister`                                                  | account, deposit_to (null for an account that registered with `register`) |
| `registration_fee_set`    | `set_registration_fee`                                                | registration_fee                                  |
| `code_staged`             | `stage_code`                                                          | code_hash, bytes, by                              |
| `upgrade_sent`            | `upgrade`                                                             | code_hash                                         |
| `upgrade_failed`          | the deploy and migrate batch failed (`on_upgrade_done`)               | none                                              |
| `migrated`                | `migrate`, in the new code                                            | state_version                                     |
| `seal_sent`               | `seal`                                                                | public_key                                        |
| `verifier_key_removal_sent` | `remove_verifier_key`                                               | public_key                                        |

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
| `only the verifier can act for a signer`                                                                                                                         | `on_auth` called by anything but the verifier.                                                         |
| `unknown action`                                                                                                                                                 | A message whose first part is not an action the hook takes, in `mt_on_transfer`, `ft_on_transfer` or `on_auth`. |
| `only the collateral token can deliver money`                                                                                                                    | `ft_on_transfer` called by anything but the collateral token.                                          |
| `send from your own account, not out of the verifier`                                                                                                            | A token transfer whose sender is the verifier, such as an Intents withdrawal with a message.           |
| `attach at least 75 TGas: the market moves the money into its Intents account before crediting it`                                                               | A token transfer that left the hook less than the forward and its callback need.                       |
| `bad market id`, `bad amount`, `bad min shares`, `bad shares`, `bad min collateral`                                                                                | A message part that is not a number.                                                                   |
| `already registered`                                                                                                                                             | `register` from an account that is registered already.                                                 |
| `send at least the registration fee`                                                                                                                             | A `register` transfer smaller than `config.registration_fee`.                                          |
| `registration fee outside hard range`                                                                                                                            | `set_registration_fee` below 10,000 or above 2,000,000.                                                |
| `wrong token`                                                                                                                                                    | `mt_on_transfer` with a token id that is not the configured collateral id.                             |
| `exactly one token and amount`                                                                                                                                   | `mt_on_transfer` with a batch.                                                                         |
| `the money must come from the sender's own balance`                                                                                                              | `mt_on_transfer` whose `previous_owner_ids` is not exactly the sender.                                 |
| `the collateral token id must look like nep141:<token>`                                                                                                          | `new` with a token id in the wrong form.                                                               |
| `paused`                                                                                                                                                         | The contract is paused.                                                                                |
| `sells are paused`                                                                                                                                               | `sell` while the owner has set `set_sells_paused(true)`.                                               |
| `wait an hour since the last sweep` / `wait <n> minutes since the last sweep`                                                                                    | `sweep_fees` within the sweep interval of the previous sweep (the first form while the interval is 60 minutes). |
| `do the storage deposit first`                                                                                                                                   | The account has not registered.                                                                        |
| `market is not registered with the oracle yet`                                                                                                                   | Trading before the oracle accepted it.                                                                 |
| `market is halted` / `market is resolved` / `market is closed`                                                                                                   | The market is not open for trading (`market is halted` stops buys only).                                                                    |
| `price moved, you would get fewer shares than your minimum`                                                                                                      | A buy would fill below the buyer's floor.                                                              |
| `price moved, you would get less than your minimum`                                                                                                              | A sell would fetch less, after the fee, than the seller's floor.                                       |
| `cannot buy that amount` / `cannot sell that many shares`                                                                                                        | Zero, more shares than the side has, a buy that would take the pool past 10^12 units, or a trade too small to cover the fee. |
| `min shares must be above zero`                                                                                                                                  | A buy with a floor of zero.                                                                            |
| `not enough balance` / `not enough shares`                                                                                                                       | Spending more than you hold.                                                                           |
| `too many positions, redeem or sell one first`                                                                                                                   | At the entry cap (20 to start, two for a position on one side), for an account that is neither operator nor owner. |
| `already registered` / `already resolved`                                                                                                                        | A step done twice. `halt` or `resume` of a market that has an outcome says `already resolved` too.     |
| `the operator halts a market once, the owner halts it again`                                                                                                     | `halt` by the operator on a market that has been halted before.                                        |
| `this market has reached its cap`                                                                                                                                | A buy that would take the pool past the market's cap (`set_market_cap`, or the ceiling from `set_max_market_locked`). |
| `the market cap is outside its hard range` / `the cap must be between the hard minimum and the ceiling` / `attach the market storage deposit`                    | `set_max_market_locked`, `set_market_cap` out of range, or `create_market` without the storage deposit. |
| `the fee rate is capped at <n> basis points`                                                                                                                     | Fee ceiling (500 to start).                                                                            |
| `the void grace period must be between 1 day and 60 days`                                                                                                        | `set_void_grace` out of range.                                                                         |
| `the settle wait must be between 1 and 1440 minutes` / `the reconcile wait must be between 10 and 10080 minutes` / `the reconcile wait cannot be shorter than the settle wait` / `the sweep interval must be between 60 and 1440 minutes` | `set_sweep_timing` out of range.        |
| `the position cap must be between 5 and 30`                                                                                                                      | `set_max_positions` out of range.                                                                      |
| `the fee rate ceiling cannot be over 2000 basis points` / `the Council share floor cannot be under 500 basis points` / `the Council share ceiling cannot be over 9000 basis points` / `the Council share floor must be below its ceiling` / `the sweep minimum ceiling must be between 1 and 1000000000` | `set_fee_limits` out of its hard range. |
| `the current fee rate is above that ceiling, lower the fee rate first` / `the current Council share is outside those limits, move the share first` / `the current sweep minimum is above that ceiling, lower the sweep minimum first` | `set_fee_limits` that would leave a current value outside the new limit. |
| `market has not closed`                                                                                                                                          | The oracle tried to resolve early.                                                                     |
| `market already resolved differently`                                                                                                                            | A second, conflicting outcome.                                                                         |
| `the answer deadline and the <n> day grace period have not passed`                                                                                               | `void_if_unresolved` too early (7 days to start).                                                      |
| `not resolved` / `not resolved yet` / `nothing to redeem`                                                                                                        | Claiming or redeeming too soon, or with nothing held.                                                  |
| `holders are still owed their payouts` / `nothing is left over`                                                                                                  | `claim_residual` before every holder owed a payout has redeemed, or with nothing in the pool.          |
| `text is too long` / `<field> is required` / `category and subcategory must be lowercase slugs of up to 32 characters`                                           | Bad market text.                                                                                       |
| `close_at must be in the future` / `resolve_by must be after close_at`                                                                                           | Bad market times.                                                                                      |
| `observation_time must not be before close_at` / `observation_time must be before resolve_by` / `a price rule needs a strike above zero and at most 18 decimals` | Bad price rule.                                                                                        |
| `attach at least 0.05 NEAR`                                                                                                                                      | Storage deposit too small for a new account.                                                           |
| `nothing above the 0.05 NEAR deposit to withdraw`                                                                                                                | `storage_withdraw` with an amount above zero.                                                          |
| `the account is not registered`                                                                                                                                  | `storage_withdraw` by an account that never registered.                                                |
| `redeem or sell your positions first` / `withdraw your balance first`                                                                                            | `storage_unregister` while the account still holds shares or a balance.                                |
| `a withdrawal is still pending`                                                                                                                                  | `storage_unregister` while the account has a withdrawal in flight.                                     |
| `force is not supported, redeem your shares and withdraw your balance first`                                                                                     | `storage_unregister` with `force: true`.                                                               |
| `the fee recipients are not set, the owner must call set_fee_recipients before a sweep`                                                                          | `sweep_fees` before the owner has set where fees go.                                                   |
| `the Council and the treasury must be different accounts`                                                                                                        | `set_fee_recipients` with one account twice.                                                           |
| `the Council share must be between 1000 and 5000 basis points` / `the sweep minimum must be between 1 and 100000000` / `the next sweep id can only move up`      | The bounds of the owner's settings.                                                                    |
| `no sweep to settle` / `the leg is not unresolved` / `wait 10 minutes after the sweep before settling`                                                           | `settle_leg` for a sweep that does not exist, a leg that is not unresolved, or too early.              |
| `the leg is neither pending nor unresolved` / `wait 60 minutes after the sweep before reconciling`                                                               | `reconcile_leg` for a leg that already ended, or too early.                                            |
| `no withdrawal is pending with that id` / `wait 60 minutes after the withdrawal before reconciling` | `reconcile_withdrawal` for an id with no record, or too early.                                         |
| `attach at least 87 TGas: ...` / `attach at least 30 TGas: ...`                                                                                                  | `sweep_fees` or `settle_leg` with less than its floor.                                                 |
| `Requires attached deposit of exactly 1 yoctoNEAR`                                                                                                               | `withdraw`, `buy` or `sell` without the 1 yocto.                                                       |
| `attach at least 100 TGas to upgrade`                                                                                                                            | `upgrade` with less gas than the deploy and migrate need.                                              |
| `no code is staged under that hash`                                                                                                                              | `upgrade` for a hash nobody staged, or one already used.                                               |
| `attach at least <amount> to pay for the storage` / `the wasm goes in the call input`                                                                            | `stage_code` with too little deposit or no input.                                                      |
| `prove the upgrade path before deleting keys`                                                                                                                    | `seal` before an upgrade has gone through `migrate`.                                                   |
| `unsupported state version`                                                                                                                                      | `migrate` found state written by a version other than 5, 6, 7 or 8.                                          |
| `a version 5 market that has created markets cannot move to dynamic parimutuel pricing; deploy this version fresh`                                              | An upgrade of a version-5 deployment that has markets. The batch reverts and the old code stays.       |
| `migrate runs only inside an upgrade`                                                                                                                            | `migrate` called without `upgrade` having sent the batch.                                              |
| `Method <name> is private`                                                                                                                                       | An internal callback, `buy_for`, or `new`, was called by anyone but the contract's own account.        |

---

## Gas the contract reserves for its own calls

| Call                                          | Gas                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Verifier `mt_transfer` (withdraw, treasury fee) | 15 TGas (the verifier burned 3.8 measured) |
| Verifier `mt_transfer_call` (revenue to the Council) | 42 TGas: 22 for the verifier's own part, 20 for the Council's `mt_on_transfer` |
| Token `ft_transfer_call` (a token deposit on to the verifier) | 50 TGas. A whole token deposit burned 17.5 TGas measured, 4.6 of it in the market |
| `buy_for` (the buy after a token buy)         | 10 TGas, out of the 20 its callback gets. A whole token buy burned 21.1 TGas measured, 8.2 of it in the market |
| Oracle registration                           | 20 TGas                                                                                 |
| Verifier `remove_public_key` (`remove_verifier_key`) | 15 TGas                                                                          |
| Each callback                                 | 10 TGas                                                                                 |
| `sweep_fees` in all                           | 77 TGas reserved: 42 for the Council's part, 15 and 10 for the treasury's, 10 for the Council's callback |
| `settle_leg` in all                           | 20 TGas reserved: 10 for the Council's `received_of`, 10 for the callback. It refuses less than 30 TGas. Measured at the floor: 2.6 TGas burned in the market and 6 in all |
| `migrate` in the upgrade batch                | 30 TGas (the batch of deploy and migrate burned 20 for a 289 KB build)                  |

A caller of `sweep_fees` must attach at least 87 TGas: the 77 it reserves plus 10 for its own work
(about 3 measured), checked first thing. `upgrade` needs at least 100 TGas attached, and a DAO call
to it should carry that as its `gas`.

---

## Security properties checked by tests

Every restricted method refuses a stranger; every callback refuses a direct call; `mt_on_transfer`
refuses any caller but the verifier, any token id but the collateral's, a batch, and money that was
not the sender's own; `on_auth` refuses any caller but the verifier, a forged or replayed signature moves
nothing, a stranger's signature acts only for the stranger, and a signed action obeys the same pauses as
a direct call; malformed messages and a panicking receiver are refunded in full by the verifier; a second
withdrawal, sweep or redeem sent while the first is in flight pays once; starving a transfer of gas
never loses the sender's money; trading stops at the exact moment of close; buy and sell refuse a
call with no deposit; a pump held by a halt until a Void pays each holder back only what they put
in, a profit taken before a Void scales every later refund down alike, and an answer nobody holds
refunds everyone; a winning share pays back at least what it cost and the winners' payouts never
exceed the pool; a hand-called `migrate` is refused; a market reports `unregistered` until the oracle
confirms it and `open` after; the emergency void stays shut for 7 days after the deadline; the
operator holds positions in 25 markets while an ordinary trader stops at its entry cap; a market takes
no money after it closes; a stranger and the operator cannot
upgrade or seal, an unknown hash and too little gas or deposit are refused, seal waits for
`upgrade_proven`, and `migrate` refuses another state version; withdraw and redeem work on a paused
contract; a stranger cannot initialise a deployed contract; storage registers for a third party,
refunds the surplus to the payer, unregisters only an empty account and sends a sponsored deposit back
to its sponsor; a `register` transfer takes the fee once, for the treasury, and is refused when short,
repeated or paused; a version-5 root with no markets keeps every balance and registration and one
with markets is refused; a revenue transfer with no
report is parked and not paid again, a Council that refuses is refunded to due while the treasury
leg is paid once, a locked or paused verifier restores every payout, `total_owed` equals the
verifier's balance after a whole journey, a plain deposit is surplus with no callback,
`ft_on_transfer` refuses any caller but the collateral token and a sender that is the verifier, every
refused token transfer comes back whole, the market sends the token only to the verifier for its own
account and keeps none of it, it credits exactly what the verifier took whatever the forward reports,
a token buy credits before it buys so a buy the price outran stays a balance,
an account that leaves while its token deposit is on its way keeps it and is refunded once, no contract
source names a governance crate or a verifier admin method or writes an account id, a sweep refuses
until the recipients are set, the split adds up to the total for every share the owner may set, and a
parked leg is settled from the Council's record or by the owner, with the books adding up under random
sequences of sweeps, reports, settlements and reconciliations; `sweep_fees` refuses less than its gas
floor; the operator key
cannot take money; random trade sequences never break the invariant or create money.



---

## Things to know

| Topic                                       | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One token                                   | The contract handles a single collateral token id chosen at deploy, and assumes the token behind it is a plain NEP-141 token with no transfer fee. The planned token is native USDC, `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (spec.md section 6). The sandbox runs `mock-ft`; the literal USDC id was not run. A stablecoin issuer that freezes the verifier's account would freeze every user. |
| Pause and lock in the verifier              | The verifier's pause manager can stop every `mt_transfer` and `mt_transfer_call` with one call, and a locker can freeze this contract's account. Either makes every payout fail and restore (`withdraw_failed`, `fee_transfer_failed`, `fee_transfer_unresolved`). A pause also makes transfer calls into the market fail, so no deposit is taken. A locked account still receives, so the market can keep taking money it cannot pay out: the keeper should read `is_account_locked` and stop advertising deposits. Redeeming and selling work inside the market meanwhile. |
| Surplus                                     | Money sent to the market's Intents account without `mt_transfer_call` is never credited. See "Money in" and "Reconciling with the verifier". |
| Payout targets                              | The verifier does not check that a receiver exists. Payouts go only to the caller of `withdraw`, to `revenue_pool` and to `treasury`. Check what you pass to `set_fee_recipients`: a mistyped account takes the money. |
| No keys in the verifier                     | The contract never calls `add_public_key`, `disable_auth_by_predecessor_id`, `auth_call`, `execute_intents` or any verifier admin method. Its balance moves only by `mt_transfer` and `mt_transfer_call` from this contract. A source test keeps it that way. |
| Storage deposit                             | 0.05 NEAR per account. Chosen to cover a balance entry plus 20 entries; a cost record is about the size of a share entry, so counting it as one keeps that true. It comes back through `storage_unregister`, to whoever paid it, once the account holds nothing. An account registered before version 5 has no record of who paid, so its deposit comes back to the account. An account with no NEAR registers with a `register` transfer instead: it pays the registration fee in collateral to the treasury, and the market's own NEAR carries its storage, so the treasury keeps the storage reserve topped up. `storage_unregister` is refused while a `withdraw` is still in flight, so a failed withdraw can never credit a balance to an account that has left.                                                                                                                       |
| Nobody funds a market                       | There is no seed and no market maker. A market opens empty, and its very first buyer pays a unit a share. Until both sides have money the price says little, so the website should show a new market's volume beside its price. |
| Late money and early money                  | A share's price depends on where the market stands when it is bought, and every winning share is paid the same at the end. Early winners are therefore diluted by later money on their side, though never below what they paid; buying the side with fewer shares is cheaper. This is the parimutuel trade-off the team chose on 2026-10-27, over a constant-product pool that needed a seed. |
| An exit is final                            | A holder who sells everything is out of the market: if it is later voided, they keep what the sale paid and take no part in the refund. Selling at a profit before a Void lowers everyone else's refund, in proportion; selling at a loss leaves the loss as the residual. |
| Positions are not transferable              | There is no NEP-245 multi-token interface, so a position cannot be sent, lent or used as collateral, and there is no secondary market. The entry cap binds ordinary accounts for that reason.                                                                                                                                                                                                                                                                                                               |
| The pool cap is the lever on market size    | A market's pool stops at `config.max_market_locked` (10,000 tokens to start on a new deployment, at most 10^12 units, a million tokens at 6 decimals, which keeps the pricing arithmetic inside 128 bits), or at its own cap from `set_market_cap` when that is lower. A buy past it is refused with `this market has reached its cap`. That is the lever against the cost of corrupting a market (see "One bond cannot scale with market size" in `oracle.md`).                                                                                                                                                            |
| Halting is a grievance risk                 | A stolen operator key can halt new buys, once per market, for 24 hours. Holders can still sell, users are not locked in after close, and the owner can replace the operator and lift a halt with `resume`. A halt cannot change any payout.                                                                                                                                                                                                                                                                                                                                                      |
| Selling during an upgrade is not guaranteed | `withdraw` and `redeem` never pause, so a balance and a resolved position can always leave while the verifier allows payouts. A holder of an open position can leave before resolution only by `sell`ing. Neither the operator's `set_paused` nor a `halt` of the market stops that. Only the owner's `set_sells_paused` does. The market does not know an upgrade is pending and nothing holds `sell` open while a proposal waits. This is a known limitation, left for the owner to decide.                                                                                                    |
| Website, 2026-10-20                         | `get_market` and `list_markets` returned `seeded`, and `status` could be `unregistered` or `unseeded` before `open`. Superseded on 2026-10-27: see the next row. |
| Website, 2026-10-27                         | `seeded`, `void_price_yes` and `seeder` are gone from `MarketView` and `unseeded` from `status`; `refunds`, `yes_shares` and `no_shares` are new and `holders` is always a number. `isMarketListed` reads `registered` alone. `sell` takes `shares` and `min_collateral`. The portfolio shows `get_positions`' `redeemable`, the contract's own payout, instead of working one out, because a winner's share of the pool and a Void refund need data only the contract has. `config` lost `create_fee`, `void_price_window_ns`, `min_open_price`, `max_open_price` and `max_create_fee`. |
| Keys                                        | Until `seal` has run, the deploy key can replace this code outside every DAO proposal. After it, only an owner upgrade can. A sealed contract with a broken upgrade path cannot be fixed, so prove one upgrade first.                                                                                                                                                                                                                                                                                           |
| Keeper                                      | The keeper script sweeps fees: when `collected` plus `revenue_due` plus `treasury_due` reaches its minimum (`--min-sweep`, 10 tokens at 6 decimals by default) it calls `sweep_fees` with 100 TGas, over the 87 TGas floor. It needs only a function-call key limited to this contract and that one method.                                                                                                                                                                                                 |
| Website and keeper                          | The current ABI adds paged exempt positions, storage policy, the holder count and pruning. Creation requires a native deposit. Earlier upgrade additions to `config` included `state_version` and `upgrade_proven`, and now `revenue_unresolved`. `storage_deposit` now returns a `StorageBalance` and takes two optional arguments; the body must be a JSON object, so `{}` still works and an empty body no longer does. The website already sends `{}`.                                                                                                                                                                |
| No outside review                           | The only review so far is internal. One is required before mainnet money beyond a small capped test.                                                                                                                                                                                                                                                                                                                                                                                          |
