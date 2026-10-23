# Dragons Market: scale readiness proposal

**What breaks first if the product reaches hundreds of thousands of users and markets, what we measured, what we propose to change, and the design questions we want decided before launch.**

| Field | Value |
| --- | --- |
| Date | 2026-10-22 |
| Comparable-venue review | 2026-10-23. Section 5 updated; measurements were not rerun |
| Status | Proposal for review. Implemented so far: the account-to-markets index, the reward page cap and lookup budget, the position cap of 30 and the keeper's sweep timing read from config (section 2) |
| Scope | `contracts/market`, `contracts/oracle`, `contracts/council`, the keeper (`contracts/keeper`) and the website library (`web/lib`) |
| Target | Hundreds of thousands of markets and users, with trading, fee sweeps, quarterly rewards and disputes running continuously for five years |
| Measured with | The NEAR sandbox, nearcore 2.13.4, protocol version 86. Gas is read from the outcome of a transaction, since the sandbox does not enforce the public view limit |
| Reproduce | Section 8 |

---

## Contents

1. [Summary](#1-summary)
2. [Already fixed](#2-already-fixed)
3. [What we measured](#3-what-we-measured)
4. [Issues and proposed fixes](#4-issues-and-proposed-fixes)
5. [How comparable venues scale](#5-how-comparable-venues-scale)
6. [Decisions we ask you to make](#6-decisions-we-ask-you-to-make)
7. [Not measured, and why](#7-not-measured-and-why)
8. [Reproducing the numbers](#8-reproducing-the-numbers)

---

## 1. Summary

The contracts themselves hold up well. Trades cost about 2.5 to 3 TGas on the market account whatever the market count, the money totals are constant-cost reads, and a jury draw at the 1,000-seat cap costs about 163 TGas. What fails at the target is mostly around the contracts: the website and the keeper both walk every market, and a few views and a design limit have a size at which they stop working.

Ordered by how soon each one bites:

| # | Issue | Where it breaks | Fix in one line |
| --- | --- | --- | --- |
| 1 | The website loads every market on every poll | Already slow at a few thousand markets. About 102,000 calls per portfolio poll at 100,000 | Use the index views; add an off-chain indexer for lists |
| 2 | The keeper scans every market after the oldest unfinished one | About 100,000 sequential calls per run at the target; misses draw and deadline windows | Drive it from events or a due-queue |
| 3 | The operator's and owner's own position views | `get_positions` passes 200 TGas at about 750 held markets (measured) | Keep exempt accounts out of the index and page their view |
| 4 | `entitlements_of` for an account with many tokens | The 250-lookup page budget holds up to 250 tokens; one quarter alone passes 200 TGas at about 767 tokens | Page by token as well, or bound the token history |
| 5 | Dispute capacity | About 333 disputes can run at once at a jury of 3, and about 100 if every case escalates (10 seats each), since a serving seat cannot be drawn again | Design decision (section 6) |
| 6 | Storage with no payer | About 1,900 to 4,800 NEAR per 100,000 markets, paid from the contract balance | Design decision (section 6) |
| 7 | One market contract is one hot account | Unknown ceiling; the code cannot run several market instances | Design decision (section 6) |

---

## 2. Already fixed

- **Positions index.** An account's positions are read from a sorted list of its market ids, kept where a share entry is created or removed. `get_positions` for an ordinary account now costs 2.1 TGas for one position and 7.1 TGas for twenty, the same at 300, 600 and 1,200 markets. Before the index it cost 0.234 TGas per market scanned and passed 200 TGas at about 850 markets.
- **Reward page cap and budget.** `entitlements_of` clamps its page to 25 quarters and to 250 lookups, so a page covers at most `max(1, 250 / tokens)` quarters, about 67 TGas. `entitlements_page_quarters` returns the page length so a caller never computes it. Section 4, issue 4 lists what is still open.
- **Position cap.** The hard maximum is 30, the most the 0.05 NEAR deposit pays for with a 64-character id. The unit test `the_deposit_pays_for_an_account_at_the_hard_position_cap_with_the_longest_id` measures it.
- **Keeper sweep timing.** The keeper reads the sweep interval and the settle wait from the market's config instead of hardcoding them.

---

## 3. What we measured

All gas below is TGas burnt, read from a transaction outcome. "Market receipt" is the work done on the market account only. A call through the Intents verifier also costs about 8.3 TGas on the verifier account.

### 3.1 Trades and the verifier path

| Operation | Market receipt | Whole transaction |
| --- | --- | --- |
| Buy from balance, new position | 2.77 to 2.88 | 3.08 to 3.19 |
| Buy from balance, held market | 2.45 to 2.51 | 2.76 to 2.82 |
| Buy through `mt_transfer_call` | 2.29 to 2.71 | 10.5 to 11.0 |
| Sell, partial | 2.45 to 2.52 | 2.77 to 2.83 |
| Sell everything (entry closes) | 2.92 to 3.06 | 3.24 to 3.38 |
| Redeem | 2.76 to 2.88 | 3.07 to 3.19 |

- The cost is flat in account id length (20 and 64 characters differ by about 0.03 TGas) and in positions held (0.01 to 0.02 TGas per 20 positions).
- A buy through `mt_transfer_call` lands with as little as 24 TGas attached. The verifier leaves the receiver the attached gas minus 20.56 TGas.
- Rewriting one market record with maximum text and a full history costs 2.42 TGas as a whole call, about 0.74 above a call that writes no record. That is 124 to 409 rewrites per 300 TGas transaction, so a layout change over 100,000 markets would take roughly 250 to 800 transactions.

### 3.2 The operator and owner

These two accounts are exempt from the position cap and hold a share entry in each market they seed away from the middle.

| Held markets | Seed (market receipt) | Redeem (market receipt) | `get_positions` | `get_account` |
| --- | --- | --- | --- | --- |
| 250 | 2.91 | 3.03 | 67.8 | 64.4 |
| 1,000 | 3.72 | 3.86 | 266.0 | 252.0 |
| 2,500 | 5.35 | 5.47 | out of gas at 300 | out of gas at 300 |

Fitted lines (three points for seed and redeem, two for the views): seed 2.637 + 0.001085 N, redeem 2.765 + 0.001083 N, `get_positions` 1.456 + 0.2643 N.

- Extrapolated, not measured: a seed costs 13.5 TGas at 10,000 held markets and 111 TGas at 100,000, and passes 300 TGas at about 274,000. The operator's list reaches the 4 MiB value limit at about 524,000.
- The views are the problem: `get_positions` passes 200 TGas at about 750 held markets and 300 TGas at about 1,130.

### 3.3 Council

| Measurement | Result |
| --- | --- |
| Jury draw of 11 or 21, 300 seats | 51 to 53 TGas |
| Jury draw, 600 seats | 98 to 100 TGas |
| Jury draw, 1,000 seats (the cap) | 163 to 164 TGas |
| Draw with 20% or 50% of seats asking to leave | The same cost as with none leaving |
| `entitlements_of`, 25 quarters, 10 tokens | 67.1 TGas |
| `entitlements_of`, 25 quarters, 25 tokens | 163.5 TGas |
| `entitlements_of`, 25 quarters, 40 tokens | 260.3 TGas |
| `entitlements_of`, 25 quarters, 50 tokens | out of gas at 300 |

- Draw: 2.77 + 0.1597 per seat. Extrapolated, it passes the oracle's 250 TGas allowance at about 1,548 seats. The 1,000-seat cap leaves about 35% headroom.
- `entitlements_of`: 2.76 + 6.431 per token at 25 quarters, about 0.257 TGas per token per quarter. Before the lookup budget it passed 200 TGas at about 31 tokens. The finalized quarters and seat weights were written into state directly for this test, because the sandbox cannot reach 25 real finalized quarters. It is therefore the worst case, where every token earns in every quarter.

### 3.4 Storage

1 NEAR locks 100,000 bytes, confirmed from the protocol config.

| Record | Bytes | NEAR per 100,000 records | Who pays today |
| --- | --- | --- | --- |
| Market, minimum text | 271 | 271 | Market contract balance |
| Market, typical text after 120 trades | about 1,900 | about 1,900 | Market contract balance |
| Market, maximum text after 120 trades | about 4,830 | about 4,830 | Market contract balance |
| Oracle market registration | 166 | 166 | Oracle contract balance |
| Undisputed case, short / 512-byte evidence | 236 / 716 | 236 / 716 | Oracle contract balance |
| Sweep (market side) plus Council record | 249 + 77 | about 326 | Contract balances |
| Council claim | 173 | n/a | Council contract balance |
| User with 20 positions, 20-char / 64-char id | 2,179 / 3,191 | n/a | The 0.05 NEAR deposit |
| User with 100 positions, 20-char / 64-char id | 10,019 / 14,551 | n/a | The 0.05 NEAR deposit |

- The deposit buys 5,000 bytes. It covers about 45 positions for a 20-character id and 31 for a 64-character id. The hard maximum for the position cap is now 30, so every account fits inside its deposit. The 100-position row is the measurement that set it; `scale_storage` now measures up to 30.
- A sweep every hour for five years is 43,800 records, about 143 NEAR across the market and the Council. One an hour is the default; the DAO can lower the interval to one minute, which would multiply this by up to 60.

### 3.5 Protocol constants

Read from the sandbox node (nearcore 2.13.4, protocol 86) and checked against mainnet's protocol config on 2026-10-23, which is also protocol 86 with the same values.

- `max_total_prepaid_gas` and `max_gas_burnt` are both 1,000 TGas. We had assumed 300 TGas per transaction. Every "out of gas at 300" in this document is a limit of our test, which attached 300, and not of the protocol. The website library attaches at most 300 TGas, so 300 stays the working limit for the calls it builds.
- `max_length_storage_value` is 4,194,304 bytes. Logs are limited to 100 per receipt and 16,384 bytes in total.
- Storage read costs 56.4 Ggas plus 5.6 Mgas per value byte; storage write costs 64.2 Ggas plus 31.0 Mgas per value byte plus 32.1 Mgas per overwritten byte. These match the figures we had used.
- The public RPC view gas limit is a node setting that the protocol config does not expose. We still assume about 200 TGas.

---

## 4. Issues and proposed fixes

### Issue 1. The website loads every market

`listMarkets()` walks every page of 50, and three pages poll it: home every 30 seconds, the Council page every 30 seconds with one `getCase` per closed market, and the portfolio every 6 seconds with one `getShares` per market. The portfolio does not use `get_positions`, which exists for this. The poll helper starts a new run every interval without waiting for the last one, so slow loads stack.

- At 100,000 markets: 2,000 sequential calls per list, 120 to 330 MB of JSON, and about 102,000 calls per portfolio poll.
- **Fix, near term:** the portfolio reads `get_positions` and one balance. The poll helper waits for a run to finish before scheduling the next and aborts a stale one.
- **Fix, structural:** lists, search, sort, filters and charts come from an off-chain indexer reading the contracts' events. The contracts keep answering single-record reads. Section 6, decision 1.
- Events the indexer would need and the contracts do not emit: the market's price after a trade (buy, sell and seed carry shares and collateral but no price or pool), failed oracle registration, failed apply, the Council's draw and release of a jury, and `set_jury_size`.

### Issue 2. The keeper scans every market

Its cursor advances only over an unbroken run of finished markets, so one long-dated market pins it. Every run then reads every market after that point, one case call each. It also looks back only 20 sweeps for unresolved legs and sends actions one at a time.

- At the target: about 100,000 sequential calls per run, hours at 50 to 200 ms each. A run that long misses draw windows and resolve-by deadlines.
- **Fix:** the keeper works from a due-queue built from events, or from an on-chain index of markets that need action, and tracks unresolved legs from events instead of a fixed look-back.

### Issue 3. The operator's and owner's position views

The index fixed ordinary accounts. The operator and owner are exempt from the position cap and hold one entry per seeded market, so their list grows with the market count. The seed itself stays affordable (111 TGas at 100,000 held, extrapolated). Their views do not: section 3.2.

- **Fix:** do not index exempt accounts. Record the seeder's holding on the market itself, and give the operator a paged `get_positions(account, from_market, limit)` that scans a bounded window. Their own position list is operational, not a user flow.
- This also removes the one list that is rewritten whole on every seed and redeem.

### Issue 4. `entitlements_of` for large holders

Each quarter does one lookup per token the account has ever staked, and `tokens_of` is an append-only history that is never shrunk, so an account that stakes and unstakes many different tokens over the years grows without bound. Measured: 163.5 TGas at 25 tokens over 25 quarters.

- **Fixed in part:** a page now stays within 250 lookups, `max(1, 250 / tokens)` quarters, about 67 TGas, and `entitlements_page_quarters` returns the page length.
- **Still open:** one quarter costs 2.76 + 0.257 TGas per token, so it passes 200 TGas at about 767 tokens. Page by token as well, or bound or compact `tokens_of`, before one account can have staked most of the collection.

### Issue 5. Dispute capacity

A jury draw is affordable up to the seat cap (163 TGas at 1,000 seats, extrapolated limit near 1,550). The limit that matters is concurrency. A seat serving on an open case cannot be drawn again, so at most seats divided by seats held per case disputes can be open at once: about 333 at a jury of 3, and about 100 when every case escalates to a second jury of 7 (10 seats per case). A draw that cannot find enough free seats fails. If no jury is ever seated, the case returns both bonds and an event market is Void; if the first jury sat and the second cannot be drawn, it ends with no decision and the challenger loses half a bond.

- The draw reads every seat, whether or not it is serving or leaving, so the cap cannot rise much without changing it.
- **Options:** (a) keep the cap and accept the concurrency ceiling, and size the collection to the dispute rate we expect; (b) change the draw to sample candidates instead of reading every seat, which lifts the cap; (c) add a queue that holds a case until enough seats are free. Section 6, decision 3.

### Issue 6. Storage with no payer

The market, oracle and Council pay for their records out of their own NEAR balance. A market record is about 1.9 to 4.8 KB, so 100,000 markets lock about 1,900 to 4,800 NEAR, with another 166 to 716 NEAR for the oracle's records. Users pay only through the 0.05 NEAR deposit, which covers their positions up to the cap of 30. The keeper's storage alarm has a 5 NEAR margin, which covers only about 100 to 260 new markets, depending on record size.

- If a contract's balance runs out, every call that adds state fails.
- **Options:** (a) a NEAR deposit with each market creation, returned or kept; (b) prune market text and history after a market is resolved and fully redeemed; (c) the DAO treasury tops up the contracts on a schedule, with the alarm set from the creation rate. Raising the deposit, or charging per position, would let the cap rise above 30. Section 6, decision 4.

### Issue 7. One market contract is one hot account

Every trade, seed, redeem and withdraw is a receipt on the market account. Each call also touches a few global fields (fee totals, the next market id, the in-flight totals), which orders receipts but does not conflict. Our measurements say each trade is about 2.5 to 3 TGas of work on that account. We do not know the real ceiling: the chunk gas limit, the congestion-control behaviour, and the verifier's own capacity are not something the sandbox can show.

- Running several market instances is not possible as written. The oracle trusts one market account and keys its records by a bare market id; the Council accepts revenue from one market and keys received sweeps by a bare sweep id; the keeper and the website take a single market.
- **What a split needs:** key the oracle and Council records by (market account, id), keep an allow-list of market accounts, make the keeper and site walk several instances, and decide how users register once across instances.
- Section 6, decision 5. We would rather decide this before launch than change the keys afterwards.

### Smaller items

- **Record layout.** No record carries a version tag, so a layout change would rewrite every record (250 to 800 transactions at 100,000 markets). Tagging now and migrating on read and write costs a byte per record.
- **Owner-only reconciliation is one record per call.** A lost callback costs the DAO one proposal each.
- **Growing records:** sweeps, received-sweep markers, paid claims and per-seat quarter weights are never pruned. Sweeps and their Council markers come to about 143 NEAR over five years at the default of one sweep an hour (section 3.4), and up to 60 times that if the DAO lowers the interval to its one-minute floor. Paid claims and seat weights add to it.
- **Constant cost, no action:** `total_owed`, `owed_breakdown`, `in_flight`, `bond_totals`, `reward_totals`, `get_history`, `list_markets` (9 to 10 TGas per page of 50), `list_cases`, `list_quarters`, the upgrade and `migrate` path.

---

## 5. How comparable venues scale

Reviewed against public documentation and published code on 2026-10-23. These sources explain how the venues divide the work. They do not establish their maximum throughput, private infrastructure or the capacity Dragons Market would achieve by following the same approach.

### 5.1 Trueo: separate markets, shared infrastructure

Trueo deploys individual market contracts as clones on Base, with separate Yes and No tokens. Its published integration guide distinguishes minting, burning and redemption from trading through Uniswap pools. Its newer V2 markets trade through Uniswap V4's PoolManager, which is a single contract for every V4 pool. Separate market contracts therefore isolate market state, but they still depend on shared execution and settlement infrastructure. Sources: [deployment documentation](https://docs.trueo.com/deployments), [integration guide at the reviewed revision](https://github.com/trueo-protocol/trueo-contracts/blob/a00730bff098cbdece9b9edcd06f5e9e1147be41/doc/integration-guide.md) and [Uniswap V4 PoolManager](https://developers.uniswap.org/docs/protocols/v4/concepts/poolmanager).

DefiLlama's public adapter discovers markets through the manager and reads swap logs and fee events to calculate activity. That shows how a separate data service can derive useful information from contracts. It does not reveal how Trueo's private backend or DefiLlama's partner-page frontend is built. See the [published adapter](https://github.com/DefiLlama/dimension-adapters/blob/5710ba6f10002d89bdf6c5698e5d7c9d50e4d1d9/dexs/truemarkets.ts). Deployed bytecode and role holders were not independently verified.

**Correction to the earlier proposal:** one contract per market on Base does not spread markets across shards automatically. Base orders transactions into shared block capacity. More contract addresses alone do not add execution capacity. [Base transaction-ordering specification](https://docs.base.org/specifications/transactions/transaction-ordering).

**Lesson for us:** keep each operation bounded and make market discovery independent of trading. Deploying thousands of contracts would not, by itself, solve our throughput problem.

### 5.2 Polymarket: separate discovery, matching and settlement

Polymarket documents orders that are created and signed off chain, matched by an operator through its central limit order book and settled on Polygon. A trade moves from matched to mined to confirmed, and only confirmed is final, so a matched order is not evidence that its on-chain settlement has completed. Sources: [trading overview](https://docs.polymarket.com/trading/overview), [order lifecycle](https://docs.polymarket.com/concepts/order-lifecycle) and [trade statuses](https://docs.polymarket.com/developers/CLOB/trades/trades-overview).

Its market-data interfaces let clients discover events and markets, then request the particular outcomes they need. Real-time feeds deliver subscribed order-book and price updates without repeatedly fetching the entire catalog. Sources: [market-data overview](https://docs.polymarket.com/market-data/overview) and [real-time data](https://docs.polymarket.com/market-data/realtime-data).

**Lesson for us:** the website should browse an indexed catalog and subscribe to relevant updates. Trading balances and final settlement must still come from the authoritative contracts. This does not require replacing our planned market mechanism with an order book. The public documentation does not disclose enough to reproduce Polymarket's private database layout or infer a safe trades-per-second figure for Dragons Market.

### 5.3 Kalshi: bounded requests and incremental updates

Kalshi exposes cursor-paginated market discovery. Its order-book stream sends an initial snapshot followed by deltas for subscribed markets. A sequence number lets clients detect missed messages, and a `get_snapshot` request returns a fresh snapshot to re-sync from. Sources: [pagination](https://docs.kalshi.com/getting_started/pagination) and [order-book updates](https://docs.kalshi.com/websockets/orderbook-updates).

**Lesson for us:** a browser should load a page of results, then receive changes for the markets it is displaying. Reconnection must restore a correct snapshot before applying later changes. These API patterns are observable; Kalshi's private matching-engine capacity and database architecture are not established by these sources.

### 5.4 Applying the lessons to Dragons Market

The common pattern in these public interfaces is to separate discovery and updates from execution. Our proposed implementation is:

```text
Contract events -> durable indexer -> database/cache -> paginated website API
                                  -> persistent keeper due-queue
Wallet actions  -> contracts       -> confirmed results and reconciliation
```

This is a recommendation for Dragons Market, not a claim that all three venues use this exact backend.

| Area | Proposed behavior | Why it matters |
| --- | --- | --- |
| Website | Query indexed lists, filters, history and account positions; stream relevant changes | Work scales with the page being viewed rather than the entire catalog |
| Indexer | Store checkpoints, deduplicate events, replay history and reconcile against final contract state | Restarts, retries and missed messages must not lose or duplicate activity |
| Keeper | Store scheduled work in a due-queue; use bounded workers, retry backoff and duplicate-safe execution | Closing, draws and settlement deadlines must not wait behind a catalog scan |
| User feedback | Distinguish submitted, pending and confirmed actions; expose stale-data or indexing lag | A fast API response must not look like completed settlement |
| History | Archive resolved market data separately while preserving required contract records and unclaimed rights | Five years of activity must not make every current read more expensive |

The indexer is a read model and scheduler. It does not become the authority for balances, payouts or dispute results. The missing events listed in section 4 must be addressed before relying on event-driven operations.

Multiple NEAR market accounts remain an option once a single account becomes the measured bottleneck. Prepare `(market_account, market_id)` identifiers and routing first. More instances can distribute some market work, but the Intents verifier, oracle, Council and RPC services remain shared dependencies. Benchmark the complete deposit, trade, callback, settlement and fee-sweep paths before claiming a scaling factor.

### 5.5 What we still need to prove

A large catalog, many registered wallets, simultaneous visitors, trades per second and concurrent disputes are different workloads. A test with 100,000 stored markets proves none of the other four.

Before setting a production capacity target, measure browser/API latency, RPC volume, indexing and keeper lag, confirmed trade throughput and dispute completion under competing load. Include outages, replay and reconnection. Preserve the bounded position and reward work proposed above, and measure shared services as well as the market account. The gas measurements in section 3 remain useful operation costs; they are not a production throughput benchmark.

---

## 6. Decisions we ask you to make

| # | Decision | Our recommendation |
| --- | --- | --- |
| 1 | Add an off-chain indexer over contract events for lists, search, charts and the keeper's work queue. Who owns it, and which missing events do we add first? | Yes. Add price-after-trade and the missing events first; keep contracts answering single-record reads only |
| 2 | Exempt accounts: do not index them, record the seeder's holding on the market, page their view | Yes |
| 3 | Dispute capacity: keep the 1,000-seat cap, sample candidates in the draw, or queue cases? | Keep the cap and the current draw for launch; revisit when concurrent disputes approach 100, since the ceiling is about 333 at a jury of 3 |
| 4 | Who pays for state: a NEAR deposit per market, pruning after resolution, or treasury top-ups with a runway alarm? | Treasury top-ups with an alarm set from the creation rate, plus pruning market text and history once a market is resolved and redeemed |
| 5 | Single market instance, or key the oracle and Council by (market account, id) now so instances can be added? | Key by (market account, id) now. It is cheap before launch and expensive after |
| 6 | Version-tag every stored record now? | Yes |
| 7 | Page `entitlements_of` by token, or bound `tokens_of`? The tokens-times-quarters budget and a hard position cap of 30 are now in place | Decide before one account can have staked a few hundred tokens |

### Answers received, and the order of work

Answers received on 2026-10-23:

1. **Indexer: yes.** Read finalized blocks for our contract accounts only, save the events and the cursor for each block in one transaction, use replay-safe keys, and run a reconcile job for gaps. Index only receipts that succeeded, and treat withdraw, sweep and claim events as pending until their confirmed or failed event lands.
2. **Exempt accounts: yes.** Keep their share entries, leave them out of the index, and page their view. Seed from a dedicated operator account, not the DAO.
3. **Dispute capacity: keep it for launch.** The ceiling is below 333, because an escalated case holds 10 seats (3 plus 7), so concurrent disputes sit between about 100 (all escalated) and 333 (none escalated). Revisit when open disputes approach 100.
4. **Storage: changed.** Because a withdrawal now writes a record, a market contract that runs out of NEAR stops users withdrawing. So `create_market` pays for its own storage (as `stage_code` does), the oracle and Council get top-ups and an alarm, and resolved markets are pruned, but never received sweep ids, paid claims or unsettled sweeps.
5. **Key by (market account, id): yes**, with an allow-list of one at launch. The Intents verifier is shared, so load test on testnet before adding any second instance.
6. **Version tags: yes, as soon as possible.** An earlier change altered stored layouts without a state version bump.
7. **Done:** the lookup budget and the position cap of 30. Paging by token matters only past a few hundred tokens.

Order: decisions 5 and 6 and the new events in one layout pass with a state version bump before testnet. Then decisions 1, 2 and 4 before mainnet. Decision 3 and the rest of decision 7 after launch.

**Status of that order, 2026-10-23.** The layout pass is built and tested in the contracts, keeper, sandbox tests and website library: records carry a version tag, the oracle and Council keep an allow-list of market accounts and key their records by market account and id, each case has an oracle-assigned id that the Council uses as its jury key, and the events an indexer needs are added. State versions are market 3, oracle 2 and Council 3. The signed price message now names the market account (`price:v2`), because a signature over only the market id could be replayed on the same id of another market. Decisions 1, 2 and 4 are still to do.

---

## 7. Not measured, and why

| Item | Why not | What would settle it |
| --- | --- | --- |
| Shard throughput and congestion control for one account under load | The sandbox is one node with no competing traffic | A testnet run with 10, 50 and 200 parallel signers sending buys, recording included transactions per block and rejections |
| Real RPC rate limits and the public view gas limit | Provider and node settings | The provider's published limits, or a probe against the production endpoint |
| Keeper run time against a live provider | Needs a live RPC and 100,000 markets | A dry run against testnet with a pinned cursor and N markets, counting calls and wall time |
| Website load behaviour at 500, 5,000 and 50,000 markets | Needs a browser run against a populated chain | Load home, Council and portfolio and record calls, bytes, first render and loads in flight |
| Operator reads past 2,500 held markets | The test attached 300 TGas, while the protocol allows 1,000 | Re-run with higher attached gas to confirm the extrapolated lines |
| Two-round disputed case with 11 and 21 jurors, and a Council with revenue in many real quarters | Needs 21 or more staked seats and long time skips; the seat weights in the reward test were written into state | A longer sandbox run, or a testnet |

Two measurements are partial. The operator test ran the 2,500-market step in an earlier version of the final read-back, and was re-run only up to 1,000 held markets after the fix. The operator list's bytes are computed from the encoding, not read from storage, because the sandbox refuses to dump that much state.

---

## 8. Reproducing the numbers

From `contracts/`, after `./build.sh`. Every test is ignored by default and takes minutes to an hour; run one at a time.

```
cargo test -p tests --test scale -- --ignored --nocapture --test-threads=1
cargo test -p tests --test scale_ops -- --ignored --nocapture --test-threads=1
cargo test -p tests --test scale_storage -- --ignored --nocapture --test-threads=1
cargo test -p tests --test scale_council -- --ignored --nocapture --test-threads=1
```

- `scale` measures every read view by gas at 300, 600 and 1,200 markets and `get_positions` for ordinary accounts.
- `scale_ops` holds the protocol constants, the operator index, trade gas, the verifier gas floors and the cost of rewriting one market record. `SCALE_OPS_MAX` caps the operator sizes.
- `scale_storage` measures bytes per record, with positions up to the cap of 30.
- `scale_council` measures `entitlements_of` by token count and the jury draw by seat count.
