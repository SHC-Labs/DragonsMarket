# Dragons Market

A binary-outcome prediction market on NEAR. Read `pitch.md` first (what it is, why it's different from Kalshi/Polymarket), then `spec.md` (the full design), then `stack.md` (the technology choices and their evidence). `contracts/AUDIT.md` is the running, dated log of what's actually been built and independently verified, section by section, and is the most current document in this repo.

## Token custody decision, 2026-10-19

NEAR Intents will hold the platform's fungible tokens. Users fund a balance inside Intents; trading commits collateral to controlled backing inside Intents; selling/redemption releases eligible funds there; withdrawals leave through supported routes. Dragons Market still enforces positions, disputes, fees, and payouts. The concrete escrow/authorization integration is pending, and Intents alone does not supply those rules.

Read [intents-architecture.md](intents-architecture.md) for the accepted custody decision, implementation boundaries, and migration gates, and [hackathon-plan.md](hackathon-plan.md) for delivery milestones. Older separate-vault designs are superseded. The current NEP-141 contracts described below remain the implemented prototype, not an Intents integration.

## Status, 2026-10-18

Four real contracts exist, are tested, and have been independently re-verified (not just built and trusted on the builder's word): `market` (the market itself, buy/sell on a pricing curve, fees), `oracle` (optimistic resolution: propose, challenge, random jury draw, commit-reveal votes), `council` (NFT staking, jury eligibility, revenue-share accumulator), `governance` (a 5-member propose/vote/timelock/execute contract that owns the other three, replacing a single owner key). Plus two test-only token contracts, `mock-ft` and `mock-nft`.

The implemented system is the combined curve-based market plus oracle, Council and governance, not the future modular order-book design in `spec.md`. The hackathon keeps curve pricing while migrating custody and settlement to Intents. A separate token-holding Vault is superseded; the proposed settlement adapter and later order book are not implemented. Use current code, contract manuals and the latest dated audit entries for implementation status, and `intents-architecture.md` for the accepted target.

A full Next.js frontend exists under `web/` (markets, combined Council membership/disputes, watchlist, portfolio, partnerships, and a market-detail page), currently wired to a local NEAR sandbox for testing, not a live chain.

Also built since: a signed-price path for price markets in oracle, juror pay and a forfeit for silent jurors, a Void that pays the closing price, governance cancel and execution window, capped fee settings, seeding at a chosen opening price, a keeper script (`contracts/keeper`) that sends the calls that only happen when someone calls them, sweeps fees, signs with scoped keys and checks storage margins, and an upgrade path for all four contracts: anyone stages a build, governance votes to deploy it by its hash and runs its `migrate`, and a `seal` deletes the deploy key once one upgrade has gone through.

Not done: the Intents-held custody/settlement migration and final frontend financial integration, the publisher service that signs prices, an outside security audit (named as still-open throughout AUDIT.md), mainnet deployment, the legal/licensing route (spec.md section 18), and the live order-book mode.

## Build and test the contracts

```bash
cd contracts
./build.sh                        # builds all six wasm files with the pinned toolchain (rust-toolchain.toml)
./build.sh --reproducible         # the four deployed contracts in the pinned docker image; needs docker and a clean commit; writes target/near/HASHES.txt
cargo test -p market            # 128 unit tests
cargo test -p oracle            # 103 unit tests
cargo test -p council           # 79 unit tests
cargo test -p governance        # 60 unit tests
cargo test -p upgrade           # 11 unit tests of the shared upgrade and gas floor helpers
cargo test -p tests             # sandbox integration tests (near-workspaces), 129 tests plus 1 ignored long run
node --test keeper/keeper.test.mjs # the keeper's decision, key and cursor logic, 17 tests
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

`.github/workflows/ci.yml` runs the same on every push and pull request to `main`: formatting, clippy with warnings as errors (wasm target and all targets), the unit suites, `./build.sh` with the sandbox suite, and the keeper tests, and it uploads the sha256 of each wasm. It has not run on GitHub yet; each command in it was run locally.

## Documents for the contracts

`contracts/DEPLOY.md` is the mainnet deployment checklist, with the starting parameters and the publisher key rules. `contracts/market.md`, `oracle.md`, `council.md` and `governance.md` are the manual of each contract, each ending in a "Things to know" table. `contracts/AUDIT.md` is the dated log of what was built and checked, with the table that maps each finding of the 2026-10-19 outside review to its fix at the end. `spec.md` section 21 is the plan those fixes followed.

## Run the website

```bash
cd web
npm run dev                       # local dev server against whatever chain NEXT_PUBLIC_* points to
npm run build:dev                 # static export against a running local dev chain (see contracts/tests/tests/dev_chain.rs)
npm run serve                     # serve the static export
npm run e2e                       # Playwright end-to-end tests
```

## Reading order for a first look

1. `pitch.md`: the one-page pitch and what the small first test proves.
2. `spec.md`: the full design. Anything marked PROPOSED can change; anything marked OPEN needs a decision.
3. `stack.md`: the technology choices (oracle, server, indexer) and the evidence behind each.
4. `nft-council-research.md`: how the Council NFT ties into the contracts, with a dated build-order log.
5. `contracts/AUDIT.md`: what's actually built, tested, and independently re-verified, in build order. The most current document here.
6. `intents-architecture.md`: accepted token-custody direction and the gap from today's contracts. Dated audit entries describe implementation, not completion of this target.
7. `hackathon-plan.md`: scope, track evidence, owners, milestones, acceptance checks, and submission requirements.
