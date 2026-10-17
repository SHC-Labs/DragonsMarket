# Stack on NEAR: oracle, servers, indexer, contracts

Date: 2026-10-08. Companion to `pitch.md`. This is a technology map for the Phase 1 build on testnet, not an architecture. `/replica-architect` turns it into a design.

Evidence key: V = read this session. S = search summary only. M = from memory or local notes, not re-checked. E = my estimate, no source.

## Short answers

| question | answer |
| --- | --- |
| Which oracle? | Two separate jobs, and no off-the-shelf answer for the hard one. Price feeds: Pyth Core dropped NEAR, RedStone has a NEAR connector to verify. Event outcomes (the trust layer): nothing found on NEAR, so we write an optimistic oracle contract ourselves |
| Do we need a server? | Yes, one. Matching has to be off-chain, the same as Polymarket. It is also the part a regulator and a user will question most |
| Minimum server spec? | Play-money phase: 4 vCPU, 8 GB RAM, 100 GB SSD (E). A NEAR RPC node we do not need to run; if we did, the official minimum is 16 GB RAM and 2.5 TB SSD (V) |
| Do we need an indexer? | A small one. The matcher already records orders and trades. We only need to watch the chain for deposits, withdrawals and settlement. Hosted indexer, not self-run. NEAR Lake is dead, so avoid anything that says "Lake" |

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

Matching must be off-chain. Polymarket matches off-chain and settles on-chain, with a 250 ms delay on crypto and finance markets (V). On NEAR, every resting order on-chain would cost storage: 1E19 yoctoNEAR per byte, so 100 KB per NEAR staked (V). Orderly Network does run an on-chain orderbook on NEAR (S), so the other design is possible, but I have no data on its cost at our scale.

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

Recommendation: start with the matcher's own database as the source of truth, and use Neardata or Goldsky for the on-chain events (deposits, withdrawals, settlement). We do not need our own archive of the chain.

## Contracts and chain facts

| item | detail | evidence |
| --- | --- | --- |
| Block time and finality | 600 ms blocks, 1.2 s finality | S |
| Fee per transaction | about $0.001 | S |
| Storage | 100 KB per NEAR staked; a new account gets 770 bytes free | V |
| Language | Rust with near-sdk; testing with the NEAR sandbox | M |
| Collateral | USDC bridged through Intents (`nep141:...` token ids); which exact token and its issuer risk is not checked | M |
| Share tokens | NEP-245 multi-token for Yes/No positions is the natural fit; not verified | M, E |
| Deposit and withdrawal | 1Click API quotes and the verifier contract `intents.near`; the `referral` field and app fees are the only fee lever I know of for Intents | M |
| Cross-chain custody | Chain Signatures: an MPC network of about 8 independent nodes, threshold signing | S |
| Private trading | Confidential Intents launched Feb or Mar 2026 (sources differ) | S |

Contracts to write: market factory, collateral vault, position tokens, settlement and redemption, fee collector, oracle. Plus a security audit before any real money; I estimated $50K to $200K in `pitch.md` (E).

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

- **Intents deposit and withdrawal.** The sandbox has no Intents. My local notes list `intents.testnet`, but I have not verified it is live. The cheap way is one tiny real mainnet deposit and withdrawal (a few dollars) to time them. That is the only step in Phase 1 that touches real money.
- **Free RPC under load.** Public endpoints rate-limit, so this stack proves the logic, not the scale.
- **Another thing running on this box.** About 36 of 60 GB RAM is already in use. A play-money matcher is small, but watch it.

Setup is one step: install Rust and the wasm target (free, about 10 minutes, E). After that, nothing here costs money until real funds are involved.

## Risks specific to this stack

1. **The server is the weak point.** An off-chain matcher is a single operator. Users and regulators will ask what stops it reordering trades or halting withdrawals. A TEE or a second-party signer could reduce this; I have not researched either.
2. **No battle-tested oracle for our hardest job.** We write a contract that holds user money and decides outcomes. It is the most audit-heavy part.
3. **The oracle market is shifting.** Pyth left NEAR in August and Switchboard shut down in September 2026. Anything we pick can disappear within months.
4. **Intents is a dependency.** It is the deposit and withdrawal path, and the withdrawal-speed pain point depends on it. I have not tested its real payout times.
5. **Custody is still open.** Who holds the money decides the vault design (`requirements.md`).

## What I could not verify

- Whether RedStone on NEAR is live and what it costs.
- Whether Pyth Pro supports NEAR.
- Pricing and rate limits for Neardata and Goldsky.
- Whether the old Pulse Markets or Flux are still running.
- Actual Intents payout times and 1Click limits.
- Any hosting price.

## Next steps, in order

1. Check RedStone on NEAR (docs, last release, any price). About 1 hour.
2. Test Neardata and Goldsky against a testnet contract to see which is simpler. About half a day.
3. Pick the oracle design parameters (bond size, challenge window, panel size) with `/replica-architect`.
4. Time a real Intents deposit and withdrawal on small funds. About 1 hour.
