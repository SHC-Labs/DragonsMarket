# pm-market

Source: `pm-market/src/lib.rs` (the contract) and `pm-market/src/curve.rs` (the pricing maths). Written 2026-10-18 from the code as it stands, including everything added that day. When this file and the code disagree, the code is right.

## What it is

pm-market is the trading contract. It holds the money, lists the markets, prices every trade, and pays people out after a market resolves.

A market is one yes or no question. People buy Yes shares or No shares. When the question is answered, each winning share pays exactly one unit of the collateral token and each losing share pays nothing. If the question cannot be answered, the market is Void and each share pays the market's closing price instead (see "Void").

It does not decide outcomes. A separate contract, pm-oracle, does that, and pm-market only accepts an outcome from it.

## Where it sits among the other contracts

| Contract | Relationship to pm-market |
|---|---|
| pm-oracle | Registers every new market with it, and is the only account allowed to set an outcome. |
| pm-council | Receives 25% of the trading fees as revenue for its staked NFT seats. |
| pm-governance | Intended owner. It holds the owner role so that dangerous changes need a vote. |
| The collateral token (a NEP-141 token, in tests `mock-ft`) | The only money the contract handles. Everything is denominated in it. |

Money enters pm-market by `ft_transfer_call` from the collateral token, and leaves by `ft_transfer`. NEAR itself is only used for the 0.05 NEAR storage deposit.

## Roles: who can do what

There are four kinds of caller. The first three are stored accounts, the fourth is anyone.

| Role | Set by | Can do |
|---|---|---|
| Owner | `new`, then `propose_owner` and `accept_owner` | Everything the operator can, plus `set_operator`, `propose_owner`, `set_fee_recipients`, `set_fee_rate_bps`, `set_create_fee`. In a real deployment this is the pm-governance contract, so each of these needs a member vote and a timelock. |
| Operator | `new`, then `set_operator` (owner only) | Routine running: `create_market`, `retry_register`, `halt`, `resume`, `set_paused`, `claim_residual`, and seeding a market. Cannot move fees, change owner, change the operator, or touch user money. |
| Oracle | `new` (fixed, no setter) | Only `set_outcome`. |
| Anyone | n/a | Trade, deposit, withdraw, redeem, register for storage, `void_if_unresolved`, `sweep_fees`, and every view. |

The operator is meant to be a fast key held by a person or a bot, so that day to day work does not wait on a governance vote. If it is stolen, the damage is limited: the thief can halt markets and pause the contract, but cannot take money, redirect fees, or keep the key, because the owner can replace it. Users can still withdraw and redeem while the contract is paused or a market is halted.

Two accounts are not roles but matter: `revenue_pool` (the pm-council contract, receives 25% of fees) and `business_wallet` (receives 75% of fees and the leftover of resolved markets). Only the owner can change them.

## Starting it up: `new`

Called once, at deploy. It cannot be called again (the contract refuses a second initialisation).

| Argument | Meaning |
|---|---|
| `owner_id` | The owner. Normally the pm-governance contract. |
| `operator_id` | The operator. |
| `oracle_id` | The pm-oracle contract. |
| `collateral_token` | The NEP-141 token everything is paid in. |
| `revenue_pool` | Where 25% of fees go. Normally pm-council. |
| `business_wallet` | Where 75% of fees and resolved-market leftovers go. |

Starting values: trade fee rate 200 basis points (2%), creation fee 1,000,000 units, not paused, no markets.

Deploy and initialise in one batch, and check afterwards that the owner is yours, because `new` can be called by anyone on a freshly deployed contract that has not been initialised yet.

## Units and conventions

| Thing | Convention |
|---|---|
| Collateral amounts | Raw integer units of the token. The code assumes a 6-decimal token, so 1,000,000 units is 1 token. |
| Shares | Integers. One share of the winning outcome redeems for exactly 1 raw unit. |
| Prices | Integers in millionths. 1,000,000 means 1.00 and 500,000 means 50 cents. Yes price plus No price is always 1,000,000. |
| Times | Nanoseconds since the Unix epoch, as the chain reports them. Passed in JSON as strings (`U64`). |
| Big numbers in JSON | `U64` and `U128` travel as strings, for example `"1000000"`. |
| Fee rates | Basis points. 200 is 2%. |

## A market's life

1. The operator calls `create_market`. The market exists but cannot trade. The contract asks pm-oracle to register it.
2. The oracle's answer comes back in a callback, and the market is marked `registered`. If the oracle refused or the call failed, the market stays shut and `retry_register` can send it again.
3. The operator (or owner) seeds it by sending collateral with the message `seed:<id>`. This opens the market for trading.
4. People trade until `close_at`. At the exact moment of close trading stops.
5. After close, someone proposes an outcome through pm-oracle. Once the oracle has a final answer it calls `set_outcome`. If nobody gets an answer applied by `resolve_by`, anyone can call `void_if_unresolved`.
6. Holders call `redeem` to turn shares into balance, and `withdraw` to take the balance out as tokens. The operator or owner calls `claim_residual` to move whatever the pool still holds to the business wallet.

The `status` shown by the views is, in this order of precedence: `resolved` if an outcome is set, otherwise `halted` if halted, otherwise `closed` if the time has passed `close_at`, otherwise `open`. A market that is created but not yet registered or seeded shows `open` before its close time even though it cannot trade; check `registered` and the pool size to tell.

## What a market stores

| Field | Meaning |
|---|---|
| `title`, `rule_text`, `resolution_source`, `void_policy` | The question and its rules, in words. Required, non-empty, with length limits below. |
| `category`, `subcategory` | Short lowercase slugs such as `crypto` and `bitcoin`. |
| `rule_hash` | A fingerprint of the rules, fixed at creation. See "The rule hash". |
| `price_rule` | Optional. Makes this a price market. See "Price markets". |
| `close_at` | When trading stops. |
| `resolve_by` | The deadline for an answer. After it, anyone can void the market. |
| `halted` | Set by `halt`. Stops trading. |
| `registered` | True once the oracle has accepted the market. |
| `seeded` | True once opening liquidity exists. |
| `outcome` | Empty until resolved, then Yes, No or Void. |
| `void_price_yes` | Set only when the outcome is Void. See "Void". |
| `pool_yes`, `pool_no` | The two sides of the pricing pool. |
| `locked` | All collateral held for this market. |
| `user_yes`, `user_no` | Total shares held by users (and the seeder), per side. |
| `residual_claimed` | True once `claim_residual` has run. |
| `history` | The last 120 prices, one per seed, buy and sell, for drawing a chart. Chart only. |
| `twap` | A running time-weighted price used for Void. Not shown by any view. |

### Limits

| Limit | Value |
|---|---|
| Title | 200 bytes |
| Rule text | 2,000 bytes |
| Resolution source | 300 bytes |
| Void policy | 500 bytes |
| Category and subcategory | 1 to 32 characters, lowercase letters, digits and hyphens only |
| Shares entries per account | 20 (each market and side an account holds counts as one) |
| Price history per market | 120 points |
| `list_markets` page | at most 50 per call |
| Pool size | each side at most 1,000,000,000,000,000 units (10^15) |

## Every method

### Setup and accounts

| Method | Who | What it does |
|---|---|---|
| `new(...)` | Deployer, once | Initialises the contract. |
| `storage_deposit()` (payable) | Anyone | Registers the caller. Needs at least 0.05 NEAR attached. The 0.05 NEAR is kept to pay for the caller's storage, anything above it is refunded, and if the caller was already registered the whole deposit is refunded. Registration is required to deposit, buy and sell. It cannot be undone and the 0.05 NEAR is not returned. |
| `is_registered(account_id)` (view) | Anyone | Whether an account has registered. |

### Owner and operator management

| Method | Who | What it does |
|---|---|---|
| `propose_owner(new_owner)` | Owner | Names a new owner. Nothing changes yet. |
| `accept_owner()` | The proposed account | Completes the handover. Two steps so a mistyped account cannot lock everyone out. Until it is accepted, the old owner keeps full power. |
| `set_operator(operator_id)` | Owner | Replaces the operator, effective at once. |
| `set_fee_recipients(revenue_pool, business_wallet)` | Owner | Changes where fees go. Takes effect for the next sweep and also for any amount still owed to the old recipients, which is sent to whoever is set at sweep time. |
| `set_fee_rate_bps(fee_rate_bps)` | Owner | Sets the trade fee rate. Refused above 500 (5%). Zero is allowed. Applies from the next trade. |
| `set_create_fee(create_fee)` | Owner | Sets the fee taken from each market's seed. Refused above 10,000,000 units (10 tokens). Zero is allowed. Applies from the next seed. |

The ceilings (5% and 10 units) are written into the code, so even a captured governance cannot set a fee above them.

### Running markets

| Method | Who | What it does | Refused when |
|---|---|---|---|
| `create_market(title, rule_text, resolution_source, void_policy, category, subcategory, close_at, resolve_by, price_rule)` | Operator or owner | Creates a market, returns its id, and asks the oracle to register it. `price_rule` is optional. | Not operator or owner; contract paused; any of the four text fields empty; text over its limit; bad category slugs; `close_at` not in the future; `resolve_by` not after `close_at`; for a price rule: observation time before `close_at` or not before `resolve_by`, strike zero, or more than 18 decimals. |
| `retry_register(market_id)` | Operator or owner | Sends the oracle registration again. | Already registered. |
| `halt(market_id, reason)` | Operator or owner | Stops trading in one market, with a recorded reason. Redemption after resolution still works. | Not operator or owner; market already resolved. |
| `resume(market_id)` | Operator or owner | Lifts a halt. | Not operator or owner. |
| `set_paused(paused)` | Operator or owner | Stops all new trades, deposits and seeding in every market. Withdrawals and redemptions keep working. | Not operator or owner. |
| `claim_residual(market_id)` | Operator or owner | After resolution, moves what the pool holds beyond what holders are owed into the business wallet's balance inside this contract. Can be done once per market, before or after holders redeem. | Not resolved; already claimed. |

The business wallet then takes the money out like any user, with `withdraw`.

### The oracle's methods

| Method | Who | What it does | Refused when |
|---|---|---|---|
| `set_outcome(market_id, outcome)` | Oracle only | Records the final outcome (`yes`, `no` or `void`). Calling it again with the same outcome does nothing. | Caller is not the oracle; the market has not closed; the market is already resolved differently. |
| `on_registered(market_id)` | The contract itself | Callback after registration. Marks the market registered if the oracle accepted it. | Anyone else (private). |

### Anyone

| Method | What it does |
|---|---|
| `void_if_unresolved(market_id)` | If `resolve_by` has passed and no outcome was ever applied, sets the outcome to Void. This is the safety net that guarantees money is never stuck. Refused if already resolved or if the deadline has not passed. |
| `buy(market_id, side, amount, min_shares)` | Buys using balance already held in the contract. `side` is `"yes"` or `"no"`. |
| `sell(market_id, side, collateral_out, max_shares_in)` | Sells shares back to the pool. You name how much collateral you want out, and the contract works out how many shares that costs. |
| `redeem(market_id)` | After resolution, converts all the caller's shares in that market into balance. No deadline. |
| `withdraw(amount)` (payable, 1 yocto) | Sends `amount` of the caller's balance out as tokens. The balance is reduced first and restored if the token transfer fails. Needs exactly 1 yoctoNEAR attached. |
| `sweep_fees()` | Splits collected fees 25% and 75% and sends them. See "Fees". |

`buy` and `sell` and the token-message trades all use the same rules, below.

### Money in: `ft_on_transfer`

Tokens arrive when someone calls `ft_transfer_call` on the collateral token with this contract as the receiver. The `msg` text says what to do. Only the collateral token may call it; a call from anywhere else is refused with "wrong token". If anything is wrong, the contract panics and the token automatically sends the money back, so a bad message never loses funds.

| `msg` | Who | What it does |
|---|---|---|
| `deposit` | Registered account | Adds the amount to the sender's balance. Refused if paused or not registered. Extra text after `deposit` is ignored. |
| `buy:<market>:<side>:<min shares>` | Registered account | Buys directly with the tokens sent. `side` is `yes` or `no`. `min shares` is a slippage floor and must be above zero. Extra text after the fourth part is ignored. |
| `seed:<market>` | Operator or owner | Opens the market at one half. |
| `seed:<market>:<yes price>` | Operator or owner | Opens the market at a chosen starting Yes price, in millionths, from 10,000 to 990,000 (1% to 99%). |

Also refused for any message: an amount of zero, an unknown action, or a market id that is not a number.

## How trading works

The pricing is a constant-product pool, the same shape as Uniswap. Each market has a Yes pool and a No pool of shares. The price of an outcome is the other pool divided by the total of both, so buying Yes shrinks the Yes pool, grows the No pool, and raises the Yes price. A fresh market seeded at one half has equal pools.

All rounding goes in favour of the pool, so the pool's product never shrinks and repeated tiny trades cannot make money. The tests confirm that no sequence of buys and sells by one trader ends in profit.

### Buying

You send `amount` of collateral and a minimum number of shares. The contract:

1. Works out how many shares the whole amount would buy, and from that the average price of the trade.
2. Charges the fee on that trade (see "Fees"), taken out of `amount`.
3. Buys shares with what is left.
4. Refuses if fewer shares than `min_shares` result ("price moved, you would get fewer shares than your minimum").

The collateral less the fee is added to the market's `locked`. The fee goes to the fee bucket.

### Selling

You name `collateral_out`, the amount you want to receive from the pool, and `max_shares_in`, the most shares you will give up. The contract works out the shares needed, charges the fee on `collateral_out`, and credits you `collateral_out` minus the fee. `quote_sell` tells you the largest `collateral_out` that `shares` can fetch. A sale so small that its fee would eat all of it is refused ("cannot sell that amount").

### The market must be open

A buy or sell is refused unless the market is registered, seeded, not halted, not resolved, and strictly before `close_at`. Trading at the exact close instant is refused. The contract must also not be paused.

### Slippage and sandwiching

Every buy needs a minimum and every sell needs a maximum, so a trader is never filled at a price they did not accept. The minimum cannot be zero, so there is no way to opt out of the protection. This protects the trader but not the pool: someone who buys ahead of a large order still profits from the price that order moves, and that profit comes out of the pool, meaning the seeder. This is true of every constant-product market. See `AUDIT.md`, "Attack testing", for the measured numbers.

## Fees

| Fee | Rate | Who pays | Where it goes |
|---|---|---|---|
| Trade fee | `rate × shares × p × (1 − p)`, where `p` is the trade's average price. At the starting 2%, about 1% of a 50 cent trade and almost nothing near 1 cent or 99 cents. | The buyer or seller, on each trade | The fee bucket |
| Creation fee | A flat amount, 1,000,000 units to start | The seeder, taken out of the seed | The fee bucket |
| Redeem, withdraw, deposit | None | n/a | n/a |

The fee is rounded up. The price you are quoted by `quote_buy` and `quote_sell` is produced by the same function that charges the trade, so what is quoted is what is charged.

Fees sit in a bucket outside every market's collateral, so they never touch the rule that collateral must equal shares outstanding.

### Sweeping

Anyone can call `sweep_fees`. It splits the bucket 25% to the revenue pool (pm-council) and 75% to the business wallet, both rounded down so any remainder stays in the bucket. It then sends both amounts through the token. If a transfer fails, that amount goes back to be owed to the same recipient, so one broken recipient never moves money to the other. Calling it twice at once pays out once. The 25% and 75% are constants in the code; changing them needs a new deployment. Measured: it needs at least 91 TGas attached and burns about 15 TGas.

## Void

A market becomes Void when the oracle says so, or when `void_if_unresolved` is called after `resolve_by`.

A Void pays each Yes share the market's closing Yes price and each No share the rest, so a pair of one Yes and one No share always pays exactly 1. The closing price is the Yes price averaged over time across the last 24 hours before `close_at`, or since the market opened if that was later. It is fixed at the moment the market becomes Void.

The average is kept in a running time-weighted accumulator, not read from the 120-point chart log, so no number of trades can change how long a price held. An earlier version averaged the log and could be flooded; that was fixed after an attack test showed it.

This replaced a flat 0.50 per share, which paid a holder of the cheap side several times what their shares were worth. A known remaining risk: pumping the price and then forcing a Void pays the pumper from the pool, because shares bought on the way up cost less than the price they are paid at. It needs a Void that one party cannot force alone. See `AUDIT.md`.

## Seeding at a chosen price

Collateral must equal the shares outstanding of each outcome. So a market opened away from one half needs its smaller pool made up: the seeder holds the difference. At 30% Yes, the Yes pool is the whole seed, the No pool is smaller, and the seeder holds the No shares the pool does not. The seeder is then an ordinary holder with those shares and must be registered (`storage_deposit`). Those shares count toward the seeder's 20 position limit until redeemed. Because the owner is the governance contract, the operator should be the one to seed.

A seed of exactly one half leaves the seeder holding nothing. A seed too small to give either pool anything at its price is refused.

## Price markets

A market created with a `price_rule` is answered by signed prices, not by someone pointing at a web page. The rule is:

| Field | Meaning |
|---|---|
| `observation_time` | The moment whose price decides the market. Must be at or after `close_at` (so traders cannot know the answer while trading) and before `resolve_by`. |
| `strike` | The threshold price, an integer scaled by 10 to the power `decimals`. Must be above zero. |
| `decimals` | How many decimal places the price and strike carry. At most 18. |
| `above` | If true, Yes when the price is at or above the strike. If false, Yes when the price is below it. |

The rule is part of the rule hash, so it cannot change. pm-market passes it to pm-oracle at registration, and the oracle checks signed prices against it. How prices are signed and checked is described in `pm-oracle.md`.

## The rule hash

At creation the contract computes a SHA-256 of the title, rule text, resolution source, void policy, `close_at` and price rule, written as 64 hex characters. It is stored, shown in the views, and sent to the oracle. It lets anyone prove the question was not reworded after money went in. Category, subcategory and `resolve_by` are not part of it.

## Winning and getting paid

After resolution:

| Outcome | A Yes share pays | A No share pays |
|---|---|---|
| Yes | 1 unit | 0 |
| No | 0 | 1 unit |
| Void | the closing Yes price | the rest, so one minus that price |

`redeem` pays all of the caller's shares in a market at once into their balance, rounding Void payouts down per holder (up to one unit of dust per holder can stay in the market, which `claim_residual` later collects). Redeeming has no deadline and works while paused or halted.

## The invariant

While a market is open, collateral held must equal shares outstanding on each side: `locked = pool_yes + user_yes = pool_no + user_no`. After resolution, `locked` must be at least what is owed. `check_invariant(market_id)` returns whether this holds. It is checked after every step of the randomized tests, which run sequences of up to 60 random trades across two markets (one opened at 30%), resolve each as Yes, No or Void, and redeem and claim the residual in both orders.

## Views (free to call)

| View | Returns |
|---|---|
| `config()` | owner, pending owner, operator, oracle, collateral token, paused, number of markets, storage deposit, position cap, fee rate, creation fee, revenue pool, business wallet |
| `get_market(market_id)` | One market: id, title, rule text, source, void policy, category, subcategory, rule hash, price rule, close and resolve times, status, registered, outcome, void price, Yes and No price, locked |
| `list_markets(from_index, limit)` | A page of markets (limit capped at 50) |
| `get_history(market_id)` | The price log: time and Yes price for each point |
| `get_balance(account_id)` | An account's withdrawable balance |
| `get_shares(market_id, account_id)` | The account's Yes shares and No shares in that market |
| `quote_buy(market_id, side, amount)` | Shares you would get and the fee, or zeros if the trade cannot happen |
| `quote_sell(market_id, side, shares)` | The most collateral those shares can fetch, the shares actually needed, and the fee |
| `get_fees()` | Collected, owed to the revenue pool, owed to the business wallet |
| `is_registered(account_id)` | Whether the account registered |
| `check_invariant(market_id)` | Whether the collateral rule holds |

## Events

Every state change logs one line starting `EVENT_JSON:` followed by JSON of the form `{"standard":"pm-market","version":"1.0.0","event":"<name>","data":{...}}`.

| Event | When | Data |
|---|---|---|
| `owner_proposed` | `propose_owner` | owner, proposed |
| `owner_changed` | `accept_owner` | from, to |
| `operator_set` | `set_operator` | operator |
| `market_created` | `create_market` | market_id, rule_hash |
| `market_registered` | oracle accepted it | market_id |
| `market_halted` | `halt` | market_id, reason |
| `market_resumed` | `resume` | market_id |
| `paused` | `set_paused` | paused |
| `fee_recipients_set` | `set_fee_recipients` | revenue_pool, business_wallet |
| `fee_rate_set` | `set_fee_rate_bps` | fee_rate_bps |
| `create_fee_set` | `set_create_fee` | create_fee |
| `residual_claimed` | `claim_residual` | market_id, amount, to |
| `outcome_set` | `set_outcome`, or `void_if_unresolved` (which adds `"by":"deadline"`) | market_id, outcome |
| `deposit` | a deposit | account, amount |
| `market_seeded` | a seed | market_id, amount, fee, yes_price, seeder |
| `buy` | a buy | market_id, account, side, shares, collateral, fee |
| `sell` | a sell | market_id, account, side, shares, collateral, fee |
| `redeemed` | `redeem` | market_id, account, amount |
| `withdraw` | `withdraw` | account, amount |
| `withdraw_failed` | the token refused the transfer, balance restored | account, amount |
| `fees_swept` | `sweep_fees` | revenue_pool, revenue, business_wallet, business |
| `fee_transfer_failed` | a fee transfer failed, amount owed again | to, amount |

All big numbers in event data are strings.

## What can go wrong, and the message you will see

| Message | Cause |
|---|---|
| `owner only` | A method reserved for the owner was called by someone else. |
| `operator or owner only` | A routine method was called by someone who is neither. |
| `oracle only` | `set_outcome` called by anyone but the oracle. |
| `not the proposed owner` | `accept_owner` from the wrong account. |
| `wrong token` | `ft_on_transfer` called by something other than the collateral token. |
| `paused` | The contract is paused. |
| `do the storage deposit first` | The account has not registered (also for a seeder who would hold shares). |
| `market is not registered with the oracle yet` | Trading or seeding before the oracle accepted it. |
| `market has no liquidity yet` | Trading before it was seeded. |
| `market is halted` / `market is resolved` / `market is closed` | The market is not open for trading. |
| `price moved, you would get fewer shares than your minimum` | A buy would fill below the buyer's floor. |
| `price moved, would need more shares than your maximum` | A sell would cost more shares than the seller's ceiling. |
| `cannot buy that amount` / `cannot sell that amount` | Zero, too large for the pool, or too small to cover the fee. |
| `min shares must be above zero` | A buy with a floor of zero. |
| `not enough balance` / `not enough shares` | Spending more than you hold. |
| `too many positions, redeem or sell one first` | Over 20 share entries. |
| `already seeded` / `already registered` / `already resolved` / `already claimed` | A step done twice. |
| `the seed must be more than the creation fee` / `seed too large` / `the seed is too small to open at that price` | Bad seed size. |
| `the starting price must be between 1% and 99%` / `bad starting price` | Bad opening price. |
| `the fee rate is capped at 500 basis points` / `the creation fee is capped at 10 units` | Fee ceilings. |
| `market has not closed` | The oracle tried to resolve early. |
| `market already resolved differently` | A second, conflicting outcome. |
| `the answer deadline has not passed` | `void_if_unresolved` too early. |
| `not resolved` / `not resolved yet` / `nothing to redeem` | Claiming or redeeming too soon, or with nothing held. |
| `text is too long` / `<field> is required` / `category and subcategory must be lowercase slugs of up to 32 characters` | Bad market text. |
| `close_at must be in the future` / `resolve_by must be after close_at` | Bad market times. |
| `observation_time must not be before close_at` / `observation_time must be before resolve_by` / `a price rule needs a strike above zero and at most 18 decimals` | Bad price rule. |
| `attach at least 0.05 NEAR` | Storage deposit too small. |
| `Requires attached deposit of exactly 1 yoctoNEAR` | `withdraw` without the 1 yocto. |
| `Method <name> is private` | An internal callback was called from outside. |

## Gas the contract reserves for its own calls

| Call | Gas |
|---|---|
| Token `ft_transfer` (withdraw, business fee) | 15 TGas |
| Token `ft_transfer_call` (revenue to pm-council) | 50 TGas |
| Oracle registration | 20 TGas |
| Each callback | 10 TGas |

A caller of `sweep_fees` should attach at least 91 TGas.

## Security properties checked by tests

Every restricted method refuses a stranger; every callback refuses a direct call; `ft_on_transfer` refuses any token but the collateral; malformed messages bounce with the money back; a second withdrawal, sweep or redeem sent while the first is in flight pays once; starving a transfer of gas never loses the sender's tokens; trading stops at the exact moment of close; the operator key cannot take money; random trade sequences never break the invariant or create money. Details and the measured economic attacks are in `AUDIT.md`.

## Things to know

| Topic | Detail |
|---|---|
| One token | The contract handles a single collateral token chosen at deploy, and assumes it is a plain NEP-141 token with no transfer fee. A stablecoin issuer that freezes the contract's account would freeze every user. |
| Storage deposit | 0.05 NEAR per account, permanent. Chosen to cover a balance entry plus 20 share entries. |
| Operator and the owner's seed money | Seeds are sent from the operator account, and leftovers go to the business wallet, so the business wallet has to refill the operator to keep seeding. |
| A seeder holds shares | When a market is opened away from one half. See "Seeding at a chosen price". |
| Halting is a grievance risk | A stolen operator key can halt trading before close. Users are not locked in after close, and the owner can replace the operator. |
| Website | The website still tells users a Void pays half in three places (the Council page FAQ and the portfolio payout calculation and its comment). The contract now pays the closing price. |
| No outside audit | The only review is the self-review in `AUDIT.md`. One is required before mainnet money beyond a small capped test. |
