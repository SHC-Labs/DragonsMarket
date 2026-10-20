# Stack on NEAR: oracle, servers, indexer, contracts

Original research: 2026-10-08. Custody update: 2026-10-19. [intents-architecture.md](intents-architecture.md) defines the accepted target: platform tokens remain in NEAR Intents, including controlled market backing. The NEP-141 contracts are the existing prototype; the Intents settlement migration is pending. Vendor facts and resource/cost estimates below retain their original dates and are not refreshed by this documentation edit.

Evidence key: V = read this session. S = search summary only. M = from memory or local notes, not re-checked. E = my estimate, no source.

## Short answers

| question | answer |
| --- | --- |
| Which oracle? | Two separate jobs, and no off-the-shelf answer for the hard one. Price feeds: Pyth Core dropped NEAR, RedStone has a NEAR connector to verify. Event outcomes (the trust layer): nothing found on NEAR, so we write an optimistic oracle contract ourselves |
| Do we need a server? | The curve-market hackathon slice needs routing/status, relay and reconciliation services, not an order-book matcher. The later order-book design adds matching. Backend state must not create spendable credit. |
| Minimum server spec? | Play-money phase: 4 vCPU, 8 GB RAM, 100 GB SSD (E). A NEAR RPC node we do not need to run; if we did, the official minimum is 16 GB RAM and 2.5 TB SSD (V) |
| Do we need an indexer? | Yes: observe verifier token balances/transfers and Dragons Market positions, liabilities and outcomes. Reconcile both authorities using verified receipts/events; the database is a projection. Re-evaluate hosted options before selecting one. |

## Two setups: test and full product

The test setup is the $0 section further down ("Cheapest test stack"): everything on this machine, the NEAR sandbox and testnet, a mock oracle, a local website. It proves the contracts and the flow.

The full product with real money adds the following. Costs are my estimates, not quotes.

- Matching service: a primary and a hot standby, each about 8 vCPU and 16 to 32 GB RAM, in different locations.
- Postgres: managed, with point-in-time backups and a replica.
- NEAR RPC: a paid provider plus a second provider as fallback. Own node only if both fail us (official minimum 16 GB RAM, 2.5 TB SSD).
- Indexer: a hosted stream (Neardata or Goldsky) plus a reconciliation job that checks the chain against our database every few minutes.
- Keys: the operator key in a hardware module or cloud key service, the admin account as a multisig with a timelock, and a separate guardian key that can only pause.
- Monitoring: alerts on settlement lag, on oracle windows about to close, on the gas balance of the operator account, and on the main invariant (collateral held equals shares outstanding).
- Website: behind a CDN, with geoblocking at the edge if the licence route needs it.
- Vendors we have not priced: identity verification, sanctions screening, trade surveillance.
- Security: an audit of every contract before mainnet funds ($50K to $200K, my guess) and a bug bounty after launch.
- Infrastructure only, without staff or vendors: roughly $500 to $2,000 a month (guess).

## Oracle layer

### Job 1: price feeds (crypto and finance markets that resolve on a price)

| option | status on NEAR | evidence |
| --- | --- | --- |
| Pyth Core | Dropped. The contract-address page says "Pyth Core no longer supports ... NEAR" after the 26 Aug 2026 upgrade | V |
| Pyth Pro | Unknown for NEAR | not checked |
| RedStone | Has NEAR connectors: a JS package and a Rust crate. Whether it is maintained and priced for production is not verified | S |
| Chainlink | No NEAR data feeds found | S, absence only |
| Switchboard | Shut down. Announced 19 Sep 2026, support ended 25 Sep | S |
| Flux | Powered the old Pulse Markets on NEAR. Current status unknown | S, stale |

Warning on a conflicting source: one search summary still lists Pyth as available on NEAR. The Pyth docs page I read says the opposite, and the docs are newer, so I believe the docs. Also, Pyth had a multi-hour outage in May 2026 (S), so any single feed needs a fallback.

Recommendation for price markets: verify RedStone on NEAR first. If it does not hold up, resolve price markets from our own signed feed, taking the median of several exchange APIs and recording the sources on-chain.

### Job 2: event outcomes, the trust layer

This is the pain point that matters (Polymarket's UMA disputes). UMA's optimistic oracle is the incumbent for subjective questions, and Polymarket uses it with a $750 bond and a 2 hour challenge window (V). I found no UMA deployment on NEAR (S, absence only). So there is nothing to plug in.

What we would write ourselves, as a NEAR contract:

1. Before a market opens, store a hash of the exact rule text and the named resolution source on-chain. Nobody can change the question afterwards.
2. After the event, anyone posts an outcome with a bond.
3. A challenge window follows. No challenge, the outcome stands.
4. A challenge escalates to a small panel, not a token vote. Panel members are bonded, named in advance, and barred from trading that market. This directly targets the reported problem that over 60% of UMA voters also trade on Polymarket (S).
5. Hard time limits on every step, and a published dispute record per market.

Honest limits:

- A panel is a trust assumption. We are replacing "whales vote" with "people we pick", which is only better if the panel is visibly independent.
- Under a regulated venue the exchange's rulebook resolves contracts (V, core principles in `requirements.md`). An on-chain oracle would then be the mechanism our rulebook points to, not the final authority. That is a Phase 2 legal question.
- Bond sizes, window lengths and panel size are design choices I have no data for.

## Server layer

For the future order-book proposal, matching is planned off-chain with contract-enforced settlement. The hackathon retains curve pricing. Its services request supported Intents routes, relay authorized operations, observe final receipts, and reconcile controlled verifier balances against market liabilities. Persist in-flight operations and recovery state across restarts; do not use the backend as a second money ledger. The infrastructure sizes below are historical estimates for the earlier order-book plan, not measured requirements for this slice.

| component | what it does | spec for play-money phase (E) | spec for real launch (E) |
| --- | --- | --- | --- |
| Matching engine and API | takes signed orders, matches, streams prices over WebSocket | 4 vCPU, 8 GB RAM | 8 vCPU, 16 to 32 GB, plus a hot standby |
| Postgres | orders, trades, positions, users | on the same box, 100 GB SSD | managed, replicated |
| Indexer worker | watches deposits, withdrawals, settlement | tiny, same box | small VM |
| Oracle and resolver bot | posts outcomes, tracks challenge windows | tiny, same box | small VM, separate keys |
| Frontend | the website | static hosting | CDN |
| NEAR RPC | read the chain, submit transactions | use a hosted provider | use a paid provider with a fallback |

If we ever run our own mainnet RPC node, the official minimum is 8 cores, 16 GB DDR4, 2.5 TB SATA SSD with at least 15k IOPS; recommended is 32 GB and 4 TB NVMe (V). Testnet minimum is 8 GB and 1 TB (V). Bandwidth is not stated. I would not run one in Phase 1.

Cost: I have no vendor price. My rough guess is $50 to $150 a month for the play-money phase and several hundred a month for a redundant launch setup (E).

Whether the existing homelab could host the play-money phase is plausible but unchecked.

## Indexer

| option | status | note |
| --- | --- | --- |
| NEAR Lake and Lake Framework | Deprecated; S3 buckets stopped indexing new blocks on 24 Mar 2026 | V |
| Neardata | The documented direct replacement: a hosted stream of blocks | V that it exists; pricing and latency not stated |
| Goldsky | Hosted: Mirror (real-time replication) and Turbo (sub-second streaming) | V that it exists; pricing not stated |
| Nearcore Indexer framework | Run it ourselves on a full node | V; needs the RPC-class server above |
| The Graph, SubQuery, Indexer.xyz, BigQuery | Listed as active | V as listed; none evaluated |
| QueryAPI | Not in the current docs listing | V, absence |

Warning: my own local NEAR notes (RAR) still describe NEAR Lake and QueryAPI as the way to index. That note is stale. Do not build from it.

Recommendation: use verifier records as the token-custody authority and Dragons Market contracts as the positions/liabilities/outcomes authority. A hosted stream or RPC-backed observer feeds the operation journal and read projections. Provider webhooks and the matching database are not independent proof of final settlement. Test indexing options before choosing one.

## Contracts and chain facts

| item | detail | evidence |
| --- | --- | --- |
| Block time and finality | 600 ms blocks, 1.2 s finality | S |
| Fee per transaction | about $0.001 | S |
| Storage | 100 KB per NEAR staked; a new account gets 770 bytes free | V |
| Language | Rust with near-sdk; testing with the NEAR sandbox | M |
| Collateral | Target one supported stable asset held inside Intents; verify exact token ID, underlying issuer/contract, decimals and supported routes before selecting it | decision 2026-10-19; token OPEN |
| Position accounting | Existing Yes/No positions are internal to market. Intents uses NEP-245 for deposited asset balances; this does not automatically provide prediction-share tokens | current code and official verifier docs checked 2026-10-19 |
| Deposit and withdrawal | Verifier-held balance plus supported bridge/routing paths. 1Click is a candidate whose supported balance modes and schemas require verification; not an established provider choice | target; provider OPEN |
| Token custody | NEAR Intents verifier holds tokens. Account control, escrow enforcement, signing/delegation and recovery require a concrete settlement design; Chain Signatures is not assumed necessary | accepted 2026-10-19; integration pending |
| Private trading | Confidential Intents launched Feb or Mar 2026 (sources differ) | S |

Current contracts: market, oracle, council and governance. Required migration: authenticated Intents-held backing, positions/payout settlement, bonds, fees and rewards, plus failure recovery and reconciliation. A separate token-holding collateral vault is superseded. The longer-term order-book modules remain proposed; earlier audit cost figures are unverified estimates.

## Cheapest test stack: $0 cash

Everything for Phase 1 can run on the machine you already have. Checked just now: 24 cores, 60 GB RAM (about 24 GB free), 492 GB free on `/`, plus Node, Postgres and Docker already installed. The Rust toolchain is not installed (`cargo` and `rustc` not found), so that is the one setup step.

| layer | cheapest choice | cost | evidence |
| --- | --- | --- | --- |
| Contracts | Rust with near-sdk, tested in the local NEAR sandbox via `cargo test`. No network, no fees, and you can fast-forward time to test challenge windows | $0 | V (NEAR docs) |
| Chain for shared demos | NEAR testnet. Free tokens from the faucet, small amounts per request, wait a few hours between requests, can run dry | $0 | V, S |
| RPC | Free public endpoints: FastNEAR `test.rpc.fastnear.com`, Intear `testnet-rpc.intea.rs`, dRPC testnet. The official NEAR endpoints are "severely rate limited" | $0 | V |
| Matcher, API, WebSocket | A process on this machine | $0 | V (hardware) |
| Database | The Postgres already running here, in its own database | $0 | V |
| Indexer | None at first. Poll the free RPC for our contract's events. Add Neardata or Goldsky only when polling hurts | $0 | E |
| Oracle | A mock oracle contract you control, with the same propose, challenge and finalise functions as the real design. Real price feeds wait until RedStone is checked | $0 | E |
| Frontend | Local dev server | $0 | E |
| Collateral | A fake NEP-141 token minted in the sandbox | $0 | E |

What this cannot test:

- **Intents custody and settlement.** Local fixtures can test logic but are not evidence of a real bridge/verifier integration. Verify the selected environment and provider routes rather than assuming `intents.testnet` exists. Any real routing experiment needs explicit funding/deployment authorization and recorded minimums, fees and receipts. Prove backing remains controlled inside Intents through trade and payout, not merely deposit/withdraw timing.
- **Free RPC under load.** Public endpoints rate-limit, so this stack proves the logic, not the scale.
- **Another thing running on this box.** About 36 of 60 GB RAM is already in use. A play-money matcher is small, but watch it.

Setup is one step: install Rust and the wasm target (free, about 10 minutes, E). After that, nothing here costs money until real funds are involved.

## Risks specific to this stack

1. **The server is the weak point.** An off-chain matcher is a single operator. Users and regulators will ask what stops it reordering trades or halting withdrawals. A TEE or a second-party signer could reduce this; I have not researched either.
2. **No battle-tested oracle for our hardest job.** We write a contract that holds user money and decides outcomes. It is the most audit-heavy part.
3. **The oracle market is shifting.** Pyth left NEAR in August and Switchboard shut down in September 2026. Anything we pick can disappear within months.
4. **Intents is a core dependency.** It holds platform tokens and supports funding/exits. Account authorization, controlled backing, callback/recovery behavior, provider availability and measured payout times all matter.
5. **Custody location is decided; enforcement is pending.** Tokens remain in Intents. Prove how the settlement account prevents withdrawal of backing, how position issuance follows funded settlement, and how operators are restricted. See `intents-architecture.md`.

## What I could not verify

- Whether RedStone on NEAR is live and what it costs.
- Whether Pyth Pro supports NEAR.
- Pricing and rate limits for Neardata and Goldsky.
- Whether the old Pulse Markets or Flux are still running.
- Actual Intents payout times and 1Click limits.
- Any hosting price.

## Next steps, in order

1. Specify Intents account control, wallet identity binding, collateral and supported provider routes. Token custody in Intents is already accepted; the concrete mechanism is not implemented.
2. Claude defines the settlement interface and proves controlled backing, funded position issuance, refunds/recovery, and isolation of bonds/fees/rewards inside Intents.
3. Adapt the observer and operation store for event-level idempotency, final receipt verification, restart recovery and reconciliation of backing against liabilities.
4. Codex integrates the reviewed ABI into deposit, trade, Council, redemption and withdrawal flows. Keep unfinished writes disabled until the relevant checks pass.
5. Complete the funded-position-to-exit experiment and record actual amounts, network/provider limitations, receipts and timings. Broader oracle/vendor and order-book choices remain separately scoped work.
