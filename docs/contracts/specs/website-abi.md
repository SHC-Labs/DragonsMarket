# Dragons Market: website ABI handoff

**The views, events, messages, gas, error strings and status enums the website needs from each contract, written so web types can be generated from it, with the places where `web/lib` differs today.**

| Field | Value |
| --- | --- |
| Date | 2026-10-21 |
| Status | Draft. Items marked EXISTING are checked in source. Items marked NEW are PROPOSED and are not an ABI until the contract phase that adds them lands. On 2026-10-21 the Council views and calls of section 7 and the market's `get_sweep`, `list_sweeps`, `settle_leg`, `treasury` and `treasury_due` of section 4 were BUILT as written, with `SweepView.council.to` and `SweepView.treasury.to` added; `config` of both contracts lists the new settings (null recipients until set) |
| Scope | `web/lib/market.ts`, `config.ts`, `settlement.ts`, `errors.ts`, `hooks.ts`, `rpc.ts` and the components that call or display contract data |
| Source | Contract working tree on top of commit `6cad02e`, read 2026-10-21. Website files as of the same day |
| Index | [README.md](README.md) |

---

## Contents

1. [Conventions](#1-conventions)
2. [Configuration the site needs](#2-configuration-the-site-needs)
3. [Verifier](#3-verifier)
4. [Market views](#4-market-views)
5. [Market calls and messages](#5-market-calls-and-messages)
6. [Oracle](#6-oracle)
7. [Council](#7-council)
8. [Gas table](#8-gas-table)
9. [Events the site reads](#9-events-the-site-reads)
10. [Error strings](#10-error-strings)
11. [Status enums and operation states](#11-status-enums-and-operation-states)
12. [Where web/lib differs today](#12-where-weblib-differs-today)

---

## 1. Conventions

| Rule | Detail |
| --- | --- |
| Integers | `u64` and `u128` are decimal strings in JSON, in arguments and in results. `u32`, `u16` and `u8` are numbers. Types in this file: `U64 = string`, `U128 = string` |
| Time | Block time in nanoseconds since the epoch, as `U64`. The site converts with `nsToMs` (`web/lib/format.ts:33`) |
| Amounts | Collateral base units, six decimals. 1 USDC is `"1000000"` |
| Prices | Millionths of one collateral unit as `U128`. `"620000"` is 62 cents. `price_yes + price_no` is `"1000000"` |
| Enums | `Outcome` is lowercase `"yes" \| "no" \| "void"`. `Side` is `"yes" \| "no"`. The oracle's `Stage` is snake case |
| Absent values | `null`, never a missing key, for every `Option` in a view |
| Accounts | NEAR account id strings. A user's Intents account id is the same string |
| Calls | One function call per transaction from the wallet adapter. A wallet batch can hold several actions for one receiver only |
| Views | `query` with `request_type: "call_function"` and `finality: "final"`, as `web/lib/rpc.ts:25-36` does |

Every interface below can be generated into TypeScript. The blocks are the contract.

---

## 2. Configuration the site needs

`web/lib/config.ts:15-25` knows `marketId`, `oracleId` and `tokenId`. It needs five more values. Without them the site cannot fund, read the right balance or reach the Council.

| Setting | Environment variable (PROPOSED) | Value |
| --- | --- | --- |
| Market account | `NEXT_PUBLIC_MARKET_ID` | EXISTING |
| Oracle account | `NEXT_PUBLIC_ORACLE_ID` | EXISTING |
| Council account | `NEXT_PUBLIC_COUNCIL_ID` | NEW |
| Verifier account | `NEXT_PUBLIC_VERIFIER_ID` | NEW. `intents.near` on mainnet. The sandbox deploys its own |
| Collateral token id | `NEXT_PUBLIC_COLLATERAL_TOKEN_ID` | NEW. The exact string `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` on mainnet |
| NFT collection account | `NEXT_PUBLIC_NFT_ID` | NEW |
| Decimals and symbol | none | `tokenDecimals` 6 and `tokenSymbol` `USDC` on mainnet (EXISTING, `config.ts:23-24`) |

`NEXT_PUBLIC_TOKEN_ID` today names the NEP-141 contract. After the Intents change the site never calls that contract, except the test faucet. The collateral token id is read from each contract's `config` and compared with the setting at startup.

---

## 3. Verifier

The verifier holds all collateral. The site reads it and calls two methods on it. It never calls an admin method.

| Method | Kind | Args | Returns | Use |
| --- | --- | --- | --- | --- |
| `mt_balance_of` | view | `account_id: AccountId`, `token_id: string` | `U128` | Free funds of the user. Replaces `ft_balance_of` in `tokenBalance` |
| `mt_batch_balance_of` | view | `account_id`, `token_ids: string[]` | `U128[]` | Optional |
| `mt_transfer_call` | call, 1 yocto | `receiver_id`, `token_id`, `amount: U128`, `msg: string`, optional `approval`, `memo` | `U128[]` (amounts kept) | Fund the market, post a bond. See sections 5 and 6 |
| `mt_transfer` | call, 1 yocto | `receiver_id`, `token_id`, `amount: U128`, optional `approval`, `memo` | none | Move free funds between Intents accounts. Not used by the first release |

A `mt_transfer_call` whose message the receiver refuses still succeeds as a transaction. The verifier returns `["0"]` and refunds the sender, so the site must read the effect (a changed market balance or position), never only the transaction status (`web/lib/hooks.ts:62-97` already does). A refusal text appears in the receipt of the receiver, which `txPanics` finds because it walks the whole transaction result (`web/lib/rpc.ts:46-54`).

Exit to another chain is a signed Intents withdrawal or a 1Click swap from the user's Intents account. It is outside the contracts and is not specified here. UNVERIFIED on mainnet.

---

## 4. Market views

### 4.1 Types

```ts
type U64 = string; type U128 = string; type AccountId = string;
type Outcome = "yes" | "no" | "void";
type Side = "yes" | "no";

interface PriceRule { observation_time: U64; strike: U128; decimals: number; above: boolean }

type MarketStatus = "resolved" | "halted" | "closed" | "unregistered" | "unseeded" | "open";

interface MarketView {                       // market.get_market, market.list_markets   EXISTING
  id: U64; title: string; rule_text: string; resolution_source: string; void_policy: string;
  category: string; subcategory: string; rule_hash: string; price_rule: PriceRule | null;
  close_at: U64; resolve_by: U64; status: MarketStatus; registered: boolean; seeded: boolean;
  outcome: Outcome | null; void_price_yes: U128 | null;
  price_yes: U128; price_no: U128; locked: U128;
}
interface PricePoint { at: U64; price_yes: number }            // price_yes is a u32 number
interface BuyQuote  { shares_out: U128; fee: U128 }
interface SellQuote { collateral_out: U128; shares_in: U128; fee: U128 }
```

`status` is evaluated in this order (`market/src/lib.rs:1510-1522` in the 09:22 copy): `resolved`, `halted`, `closed`, then `unregistered` while the oracle has not confirmed, `unseeded` while there is no liquidity, otherwise `open`.

PROPOSED additions:

```ts
interface AccountView  { registered: boolean; available: U128; pending_withdrawals: U128; positions: number }
interface PositionView { market_id: U64; yes: U128; no: U128; status: MarketStatus;
                         outcome: Outcome | null; redeemable: U128 }
type LegStatus = "pending" | "settled" | "refused" | "unresolved";
interface SweepView { id: U64; at: U64; total: U128; carried_council: U128; carried_treasury: U128;
                      council: { amount: U128; status: LegStatus };
                      treasury: { amount: U128; status: LegStatus } }
interface InFlightView { withdrawals: U128; withdrawal_count: number; legs: U128; leg_count: number }
interface OwedView { balances: U128; locked: U128; fees: U128; revenue_due: U128; treasury_due: U128;
                     unresolved: U128; pending_withdrawals: U128; total: U128 }
```

### 4.2 Views

| View | Args | Returns | Status |
| --- | --- | --- | --- |
| `get_market` | `{market_id: U64}` | `MarketView \| null` | EXISTING |
| `list_markets` | `{from_index: U64, limit: U64}`, at most 50 | `MarketView[]` | EXISTING |
| `get_history` | `{market_id: U64}` | `PricePoint[]`, at most 120, oldest first | EXISTING |
| `quote_buy` | `{market_id: U64, side: Side, amount: U128}` | `BuyQuote`, zeros when impossible | EXISTING |
| `quote_sell` | `{market_id: U64, side: Side, shares: U128}` | `SellQuote`, zeros when impossible | EXISTING |
| `get_balance` | `{account_id}` | `U128` | EXISTING |
| `get_shares` | `{market_id: U64, account_id}` | `[U128, U128]` yes then no | EXISTING |
| `is_registered` | `{account_id}` | `boolean` | EXISTING |
| `storage_balance_of` | `{account_id}` | `{total: string, available: string} \| null` | EXISTING |
| `storage_balance_bounds` | `{}` | `{min: string, max: string}` | EXISTING |
| `get_fees` | `{}` | `{collected, revenue_due, business_due, revenue_unresolved}`, all `U128` | EXISTING |
| `total_owed` | `{}` | `U128` | EXISTING |
| `config` | `{}` | See below | EXISTING |
| `check_invariant` | `{market_id: U64}` | `boolean` | EXISTING |
| `get_account` | `{account_id}` | `AccountView` | NEW |
| `get_positions` | `{account_id}` | `PositionView[]`, at most 20 | NEW |
| `get_sweep`, `list_sweeps` | `{sweep_id: U64}`, `{from_index: U64, limit: U64}` | `SweepView \| null`, `SweepView[]` | NEW |
| `in_flight`, `owed_breakdown` | `{}` | `InFlightView`, `OwedView` | NEW |

`config` (EXISTING): `state_version: number`, `upgrade_proven: boolean`, `upgrade_in_flight: boolean`, `owner`, `pending_owner: string | null`, `operator`, `oracle`, `verifier`, `collateral_token_id: string`, `paused: boolean`, `markets: U64`, `storage_deposit: U128` (yocto), `max_positions: number`, `fee_rate_bps: number`, `create_fee: U128`, `revenue_pool`, `business_wallet` (NEW name `treasury`), `revenue_unresolved: U128`.

---

## 5. Market calls and messages

### 5.1 Call builders

Each row is one `FunctionCall` for the wallet (`web/lib/market.ts:114-120`). Deposit is in yoctoNEAR.

| Action | Receiver | Method | Args | Deposit | Gas | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Register once | market | `storage_deposit` | `{}` | `50000000000000000000000` (0.05 NEAR) | 30 TGas | EXISTING, correct (`market.ts:134-140`) |
| Deposit to market | verifier | `mt_transfer_call` | `{receiver_id: market, token_id, amount, msg: "deposit"}` | `1` | 100 TGas | NEW builder |
| Buy with funds in the verifier | verifier | `mt_transfer_call` | `{receiver_id: market, token_id, amount, msg: "buy:<id>:<side>:<min_shares>"}` | `1` | 100 TGas | NEW builder. Replaces `buyCall` |
| Buy from the market balance | market | `buy` | `{market_id, side, amount, min_shares}` | `1` | 100 TGas | EXISTING contract, no builder yet |
| Sell | market | `sell` | `{market_id, side, collateral_out, max_shares_in}` | `1` | 100 TGas | EXISTING (`market.ts:145-151`) |
| Redeem | market | `redeem` | `{market_id}` | `0` | 100 TGas | EXISTING (`market.ts:153-159`) |
| Withdraw to the user's Intents account | market | `withdraw` | `{amount}` | `1` | 100 TGas | EXISTING (`market.ts:161-167`) |
| Unregister | market | `storage_unregister` | `{force: false}` | `1` | 30 TGas | EXISTING contract, no builder |

### 5.2 Message grammar

For `mt_transfer_call` to the market. Split on `:`. Extra trailing parts are ignored.

```text
deposit
buy:<market_id>:<yes|no>:<min_shares>        min_shares is a decimal above zero
seed:<market_id>[:<yes_price_micro>]         operator or owner only, 10000 to 990000
```

A refusal makes the verifier refund the sender and return `["0"]`. Compute `min_shares` from `quote_buy` with `minSharesWithSlippage` (`web/lib/format.ts:59-63`). For sells compute `max_shares_in` with `maxSharesWithSlippage`.

### 5.3 Funding states

The site tracks these states. The contract-sourced ones are in the third column.

| State | Meaning | Source |
| --- | --- | --- |
| `quote` | A route and fees are shown | 1Click, not a contract |
| `awaiting_origin` | The user has not yet paid the deposit address | 1Click |
| `converting` | The provider is swapping | 1Click status. Not proof of credit |
| `credited` | `verifier.mt_balance_of(user, token)` rose by the expected amount | Verifier view |
| `deposit_sent` | The `mt_transfer_call` transaction was sent | Wallet |
| `in_market` | `market.get_balance` rose, or a position appeared | Market view, `deposit` or `buy` event |
| `refunded` | The transaction succeeded, the verifier balance is unchanged and the market balance did not rise | Receipt text from `txPanics` |

---

## 6. Oracle

### 6.1 Types

```ts
type Stage = "proposed" | "disputed" | "final";
interface Vote   { juror: AccountId; outcome: Outcome; reason: string }
interface Commit { juror: AccountId; commitment: string }
interface Case {                               // oracle.get_case   EXISTING
  stage: Stage; proposer: AccountId; proposed: Outcome; bond: U128; evidence: string;
  window_ends_at: U64; challenger: AccountId | null; challenger_answer: Outcome | null;
  round: number; jury_size: number; draw_by: U64; draw_after_height: U64;
  commit_ends_at: U64; panel_deadline: U64; panel: AccountId[]; first_panel: AccountId[];
  commits: Commit[]; votes: Vote[]; final_outcome: Outcome | null; applied: boolean;
  challenged_at: U64; delinquent: AccountId[];
}
interface OracleMarketInfo { close_at: U64; resolve_by: U64; rule_hash: string; price_rule: PriceRule | null;
                             window_ns: U64; panel_deadline_ns: U64; draw_window_ns: U64 }
```

PROPOSED:

```ts
interface CaseSummary { market_id: U64; stage: Stage; proposed: Outcome; challenger_answer: Outcome | null;
                        round: number; final_outcome: Outcome | null; applied: boolean; votes: number;
                        window_ends_at: U64; draw_by: U64; panel_deadline: U64 }
interface BondTotals { bonds_held: U128; claimable: U128; pending_payouts: U128; total: U128 }
```

### 6.2 Views

| View | Args | Returns | Status |
| --- | --- | --- | --- |
| `get_case` | `{market_id: U64}` | `Case \| null` | EXISTING |
| `get_market_info` | `{market_id: U64}` | `OracleMarketInfo \| null` | EXISTING |
| `claimable_of` | `{account_id}` | `U128` | EXISTING |
| `config` | `{}` | See below | EXISTING |
| `list_cases` | `{from_market_id: U64, limit: number}` | `CaseSummary[]` | NEW |
| `bond_totals`, `total_owed` | `{}` | `BondTotals`, `U128` | NEW |

`config` (EXISTING): `state_version`, `upgrade_proven`, `upgrade_in_flight`, `owner`, `pending_owner`, `market`, `bond_token` (NEW: `verifier`, `collateral_token_id`), `bond: U128`, `window_ns`, `panel_deadline_ns`, `draw_window_ns`, `min_proposal_ns`, `min_resolve_gap_ns` (all `U64`), `council`, `jury_size: number`, `draw_delay_blocks: U64`, `operator`, `network: string`, `publishers: string[]`, `price_threshold: number`, `no_decision_recipient`.

### 6.3 Calls and messages

| Action | Receiver | Method | Args | Deposit | Gas | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Propose | verifier (NEW). Token contract today | `mt_transfer_call` (NEW). `ft_transfer_call` today | `{receiver_id: oracle, token_id, amount: bond, msg: "propose:<id>:<outcome>:<evidence>"}` | `1` | 100 TGas | CHANGED |
| Challenge | same | same | `msg: "challenge:<id>:<answer>"` | `1` | 100 TGas | CHANGED. See section 12 |
| Commit | oracle | `commit_vote` | `{market_id, commitment}` | `1` | 100 TGas | EXISTING contract, no builder |
| Reveal | oracle | `reveal_vote` | `{market_id, outcome, salt, reason}` | `1` | 100 TGas, floor 80 | EXISTING contract, no builder |
| Finalize | oracle | `finalize` | `{market_id}` | `0` | 100 TGas, floor 80 | EXISTING (`market.ts:177-183`) |
| Retry apply | oracle | `retry_apply` | `{market_id}` | `0` | 100 TGas | EXISTING (`market.ts:185-191`) |
| Draw a jury | oracle | `resolve_draw` | `{market_id}` | `0` | 300 TGas, floor 275 | EXISTING contract, no builder |
| Withdraw bond | oracle | `withdraw_bond` | `{}` | `1` | 100 TGas | EXISTING (`market.ts:193-199`) |
| Push a payout | oracle | `payout_bond` | `{account_id}` | `0` | 100 TGas | NEW |

`commitment` is `hex(sha256("<juror account>:<yes|no|void>:<salt>"))`, 64 lowercase hex characters. The salt must be random and stored durably before the commit is sent, because a lost salt makes the reveal impossible (`oracle/src/lib.rs:279-284`; the site's own note at `market.ts:174-175`). A juror may vote only for the proposed answer or the challenger's answer (`Case.proposed`, `Case.challenger_answer`).

### 6.4 Case timeline fields

| Field | Use |
| --- | --- |
| `window_ends_at` | End of the challenge window. Before it `stage` is `proposed` and a challenge is open |
| `draw_after_height`, `draw_by` | The jury can be drawn from that block height until that time |
| `commit_ends_at` | End of the commit phase, start of the reveal phase |
| `panel_deadline` | Last moment to reveal |
| `round` | 0 for the first jury, 1 for the one larger second jury |
| `panel`, `first_panel` | Current jury, and the earlier jury after a second round started |

---

## 7. Council

### 7.1 Types

```ts
interface Stake { owner: AccountId; staked_at: U64; unlock_requested_at: U64 | null; serving: U64 | null }
// NEW: booked_to: U64
```

PROPOSED:

```ts
type QuarterState = "open" | "closing" | "final";
interface QuarterView { quarter: number; label: string; starts_at: U64; ends_at: U64; claimable_from: U64;
                        state: QuarterState; revenue_in: U128; carry_in: U128; pool: U128; seat_ns: U128;
                        forfeit_ns: U128; paid: U128; pending: U128; rolled_to: number | null }
type EntitlementStatus = "accruing" | "closing" | "claimable" | "pending" | "paid";
interface EntitlementView { quarter: number; token_id: string; owner: AccountId; weight_ns: U128; amount: U128;
                            estimated: boolean; status: EntitlementStatus;
                            requested_at: U64 | null; paid_at: U64 | null }
interface RewardTotals { total_received: U128; total_paid: U128; pending_claims: U128;
                         open_pool: U128; final_unclaimed: U128; rolled: U128 }
```

### 7.2 Views

| View | Args | Returns | Status |
| --- | --- | --- | --- |
| `seat_count` | `{}` | `number` | EXISTING |
| `is_seat` | `{account_id}` | `boolean` | EXISTING |
| `is_allowed` | `{token_id}` | `boolean` | EXISTING |
| `staked_tokens` | `{from_index: number, limit: number}` | `string[]` | EXISTING |
| `stake_of` | `{token_id}` | `Stake \| null` | EXISTING |
| `jury_of` | `{case_key: U64}` | `string[]` | EXISTING |
| `total_received` | `{}` | `U128` | EXISTING |
| `pending_reward` | `{token_id}` | `U128` | EXISTING, REMOVED by the quarterly change |
| `config` | `{}` | See below | EXISTING |
| `seats_of` | `{account_id}` | `string[]` | NEW |
| `current_quarter` | `{}` | `QuarterView` | NEW |
| `get_quarter`, `list_quarters` | `{quarter: number}`, `{from_quarter: number, limit: number}` | `QuarterView \| null`, `QuarterView[]` | NEW |
| `quarter_of` | `{at: U64}` | `{quarter: number, label: string, starts_at: U64, ends_at: U64}` | NEW |
| `get_entitlement` | `{quarter: number, token_id, account_id}` | `EntitlementView \| null` | NEW |
| `entitlements_of` | `{account_id, from_quarter: number, limit: number}` | `EntitlementView[]` | NEW |
| `received_of` | `{sweep_id: U64}` | `{amount: U128, quarter: number, at: U64} \| null` | NEW |
| `reward_totals` | `{}` | `RewardTotals` | NEW |

`config` (EXISTING): `state_version`, `upgrade_proven`, `upgrade_in_flight`, `owner`, `pending_owner`, `oracle`, `nft_contract`, `verifier`, `collateral_token_id`, `cooldown_ns: U64`, `max_seats_per_account: number`, `allowlist_enabled: boolean`, `allowed_range: {first: U64, last: U64} \| null`, `total_received: U128`, `stream_ns`, `stream_remaining`, `stream_ends_at`. The three `stream_*` fields are REMOVED. NEW: `market`, `close_grace_ns`, `next_to_finalize`, `last_tick`.

### 7.3 Calls

| Action | Receiver | Method | Args | Deposit | Gas | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Stake a seat | NFT contract | `nft_transfer_call` | `{receiver_id: council, token_id, msg: ""}` | `1` | 100 TGas | EXISTING contract, no builder. Check `is_allowed` first |
| Ask to unstake | council | `request_unstake` | `{token_id}` | `0` | 30 TGas | EXISTING contract, no builder |
| Unstake | council | `unstake` | `{token_id}` | `1` | 100 TGas, floor 58 today, 33 after the change | EXISTING contract, no builder |
| Claim a quarter | council | `claim_quarter` | `{quarter, token_id}` | `1` | 100 TGas, floor 33 | NEW |
| Claim today (30-day stream) | council | `claim` | `{token_id}` | `1` | 100 TGas, floor 33 | EXISTING, REMOVED by the quarterly change |

Revenue is never sent from the site. It arrives from the market's sweep.

---

## 8. Gas table

TGas. A floor is a refusal the contract enforces with a message that names the amount. The site attaches 100 TGas to every call (`web/lib/market.ts:122`), which clears every floor except `resolve_draw`.

| Call | Floor enforced | Attach |
| --- | --- | --- |
| `storage_deposit` | none | 30 |
| `mt_transfer_call` to the market or oracle | The verifier gives the receiver nothing below 21 | 100 |
| `buy`, `sell`, `redeem`, `withdraw` | none. `withdraw` reserves 25 | 100 |
| `sweep_fees` | 87 | 100 (keeper) |
| `commit_vote` | none | 100 |
| `reveal_vote`, `finalize`, `resolve_by_deadline` | 80 | 100 |
| `resolve_draw` | 275 | 300 |
| `retry_apply` | none | 100 |
| `retry_unlock` | 35 | 100 |
| `withdraw_bond` | none, reserves 25 | 100 |
| `unstake` | 58 today, 33 NEW | 100 |
| `claim` today, `claim_quarter` NEW | 33 | 100 |
| `upgrade` | 100 | 100 to 250 |
| `stage_code` | none | 100 for 250 KB |

Sources: `market/src/lib.rs:64-66`, `oracle/src/lib.rs:26-43`, `council/src/lib.rs:35-44`, `INTENTS-PROOF.md` gas tables. The refusal text has the form `attach at least N TGas: <reason>`.

---

## 9. Events the site reads

The site does not parse events today. When it does, the envelope is `EVENT_JSON:{"standard":"<market|oracle|council>","version":"1.0.0","event":"<name>","data":{...}}` in a receipt log. Full tables: [market.md section 9](market.md#9-events), [oracle.md section 10](oracle.md#10-events), [council.md section 9](council.md#9-events). The ones that carry user-visible state:

| Contract | Event | Data | Meaning |
| --- | --- | --- | --- |
| market | `registered` | `account`, `paid_by` | Storage deposit paid |
| market | `deposit` | `account`, `amount` | Funds credited to the market balance |
| market | `buy`, `sell` | `market_id`, `account`, `side`, `shares`, `collateral`, `fee` | Trade done |
| market | `redeemed` | `market_id`, `account`, `amount` | Winnings credited to the market balance |
| market | `withdraw` | `account`, `amount` (NEW `id`) | Requested. It is emitted before the transfer, so it is not a payout |
| market | `withdraw_confirmed` NEW | `account`, `amount`, `id` | The verifier moved the money |
| market | `withdraw_failed` | `account`, `amount` (NEW `id`) | The verifier refused, the balance came back |
| market | `outcome_set` | `market_id`, `outcome` | Market resolved |
| oracle | `proposed`, `challenged`, `jury_drawn`, `draw_failed`, `vote_committed`, `vote_revealed`, `escalated`, `final`, `outcome_applied` | see oracle.md | Case progress |
| oracle | `bond_received`, `bond_paid`, `bond_payout_failed` NEW | `account`, `amount` | Bond custody |
| council | `staked`, `unstake_requested`, `unstaked`, `unstake_failed` | `token_id`, `owner` | Seat progress |
| council | `quarter_finalized` NEW | `quarter`, `pool`, `weight_ns`, `rolled_to` | A quarter became claimable |
| council | `claim_requested`, `claim_paid`, `claim_failed` NEW | `quarter`, `token_id`, `owner`, `amount` | Claim progress |

`withdraw` and today's `revenue_claimed` are emitted before their transfer is known to have worked. Read them as requests.

---

## 10. Error strings

The site shows a sentence from `web/lib/errors.ts`. It matches the panic text with regular expressions (`errors.ts:2-16`). The panic text comes from the transaction result (`rpc.ts:39-56`). Full lists of exact strings per contract: [market.md section 11](market.md#11-errors), [oracle.md section 12](oracle.md#12-errors), [council.md section 11](council.md#11-errors).

| Pattern the site matches today | Contract strings it catches |
| --- | --- |
| `has not closed` | market `market has not closed`, oracle `the market has not closed yet` |
| `market is closed`, `market is resolved`, `market is halted`, `paused` | market |
| `too many positions`, `min shares must be above zero`, `price moved`, `not enough balance`, `not enough shares` | market |
| `storage deposit` | market `do the storage deposit first` |
| `wrong token` | market, oracle, council |
| `not registered with the oracle` | market |
| `no liquidity`, `no such market`, `cannot buy`, `cannot sell` | market |

Strings with no site copy today, grouped by what the user was doing:

| Action | Strings the site should explain |
| --- | --- |
| Fund or buy by transfer | `the money must come from the sender's own balance`, `exactly one token and amount`, `bad min shares`, `unknown action`, `only the verifier can deliver money` |
| Propose, challenge | `send exactly the bond`, `an answer was already proposed`, `too late to propose, the market will be voided at its deadline`, `the market has not closed yet`, `the challenge window closed`, `you cannot challenge your own answer`, `a challenge must name a different answer than the proposal`, `outcome must be yes, no or void`, `nothing to challenge` |
| Commit, reveal | `not on the panel for this case`, `the commit phase is over`, `the commit phase is still open`, `the panel deadline passed`, `already committed`, `already revealed`, `the vote does not match the commitment`, `vote for the proposed answer or the challenger's answer`, `a reason is required`, `commitment must be 64 lowercase hex characters` |
| Stake, unstake | `that token is not on the allowlist`, `already staked`, `the council is full`, `that account already holds the most seats allowed`, `this seat is serving on an open case`, `the cooldown has not passed`, `request an unstake first` |
| Claim | `nothing to claim`, NEW `already claimed`, `claim is already pending`, `that quarter is not final` |
| Gas | `attach at least N TGas`. The site should read N and retry with it |

A transaction that succeeds while the receiver refuses (`mt_transfer_call`) has its panic text in a receipt, not in the top-level status. `txPanics` finds it. The site must still call it a refund, not a failure of the wallet.

---

## 11. Status enums and operation states

| Enum | Values | Where |
| --- | --- | --- |
| `MarketStatus` | `resolved`, `halted`, `closed`, `unregistered`, `unseeded`, `open` | `MarketView.status` |
| `Outcome` | `yes`, `no`, `void` | everywhere |
| `Stage` | `proposed`, `disputed`, `final` | `Case.stage` |
| `Ruling` | `unchallenged`, `decided`, `no_decision` | `final` event |
| `LegStatus` NEW | `pending`, `settled`, `refused`, `unresolved` | `SweepView` |
| `QuarterState` NEW | `open`, `closing`, `final` | `QuarterView.state` |
| `EntitlementStatus` NEW | `accruing`, `closing`, `claimable`, `pending`, `paid` | `EntitlementView.status` |

Money states the interface must keep apart (R-08), with their source:

| Label | Source |
| --- | --- |
| Free in your Intents account | `verifier.mt_balance_of` |
| Available in the market | `market.get_account.available` |
| Committed in positions | `market.get_positions` (shares, and `redeemable` when resolved). The backing of a market is `MarketView.locked` |
| Pending withdrawal | `market.get_account.pending_withdrawals` |
| Bond held, claimable bond | `oracle.claimable_of`, `Case.bond` |
| Accrued reward | `council.get_entitlement` with `estimated = true` |
| Claimable reward | `council.get_entitlement` with status `claimable` |
| Paid reward | `claim_paid` events, `EntitlementView.paid_at` |

---

## 12. Where web/lib differs today

| Item | Evidence | Difference | Fix |
| --- | --- | --- | --- |
| Buy sends a token transfer | `web/lib/market.ts:126-132`, `:142-143` | `ft_transfer_call` to the NEP-141 token with the market as receiver. The market has no `ft_on_transfer`, only `mt_on_transfer` (`market/src/lib.rs:715`), so the call cannot work | Verifier `mt_transfer_call` builder, section 5 |
| Challenge message lacks the answer | `market.ts:172` sends `challenge:<id>` | The oracle requires `challenge:<id>:<yes\|no\|void>` and panics `outcome must be yes, no or void` (`oracle/src/lib.rs:674`, `:357-363`) | Add the answer |
| Propose and challenge use the NEP-141 route | `market.ts:169-172` | Correct for the oracle today. Wrong after oracle phase I3 | Switch with the oracle change |
| Free funds read from the token | `market.ts:100` | `ft_balance_of` on the NEP-141 contract. Free funds are the verifier's `mt_balance_of` | Section 3 |
| Portfolio label | `web/app/portfolio/page.tsx:77` | "In your wallet" shows the NEP-141 balance. After the change it is the Intents balance | Rename to the Intents account |
| Market status union | `market.ts:18` | Lacks `unregistered` and `unseeded`. `isMarketListed` already treats `seeded === false` as unlisted | Add the two values |
| `MarketView` fields | `market.ts:7-26` | Lacks `price_rule`. `seeded` is optional but always present | Add `price_rule`, make `seeded` required |
| `Case` fields | `market.ts:34-51` | Lacks `bond`, `challenger_answer`, `round`, `jury_size`, `draw_by`, `first_panel`. `panel_deadline` is required but `0` before a jury is drawn | Section 6.1 |
| `OracleConfig` | `market.ts:58-65` | Partial | Section 6.2 |
| Configuration | `web/lib/config.ts:15-27` | No verifier, council, collateral token id or NFT account. `isConfigured` needs `tokenId` | Section 2 |
| Positions | `web/app/portfolio/page.tsx:36-43` | One `get_shares` call per market | `get_positions` |
| Council list | `web/app/council/view.tsx:13-18` | `listMarkets`, then `getCase` per market | `list_cases` |
| Error copy | `web/lib/errors.ts:2-16` | Covers the market only | Section 10 |
| Council calls | `web/lib/market.ts` | No stake, unstake or claim builder | Section 7.3 |
| Voting | `web/lib/market.ts:174-175` | No commit or reveal builder, by design until the final ABI | Section 6.3 |
| Redeem and withdraw | `market.ts:153-167` | Builders exist. The portfolio disables them (`portfolio/page.tsx:91`, `:124`) | Enable after the market change |
| Trade ticket | `web/components/TradeTicket.tsx:9-12` | Local only. No quotes and no send | Wire `quote_buy`, `quote_sell` and the builders |
| Wallet batching | `web/components/WalletProvider.tsx:116-134` | One function call per `signAndSendTransaction` | A first buy needs two transactions: `storage_deposit` on the market, then `mt_transfer_call` on the verifier. They have different receivers, so they cannot share one batch |
| Void payout | `web/lib/settlement.ts:2-7` | Matches the contract formula `(yes * p + no * (1000000 - p)) / 1000000` (`market/src/lib.rs:325-327`) | none |
| Storage deposit and gas constants | `market.ts:122-124` | 0.05 NEAR and 100 TGas match the contract and clear every floor except `resolve_draw` | none |
| Decimals | `format.ts:1-20`, `config.ts:24` | Six decimals everywhere. Matches USDC | none |
