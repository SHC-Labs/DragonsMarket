# The Council

A binary-outcome prediction market on NEAR. Read `pitch.md` first (what it is, why it's different from Kalshi/Polymarket), then `spec.md` (the full design), then `stack.md` (the technology choices and their evidence). `contracts/AUDIT.md` is the running, dated log of what's actually been built and independently verified, section by section, and is the most current document in this repo.

## Status, 2026-10-18

Four real contracts exist, are tested, and have been independently re-verified (not just built and trusted on the builder's word): `pm-market` (the market itself, buy/sell on a pricing curve, fees), `pm-oracle` (optimistic resolution: propose, challenge, random jury draw, commit-reveal votes), `pm-council` (NFT staking, jury eligibility, revenue-share accumulator), `pm-governance` (a 5-member propose/vote/timelock/execute contract that owns the other three, replacing a single owner key). Plus two test-only token contracts, `mock-ft` and `mock-nft`.

This is **not** the six-contract, order-book architecture spec.md describes in section 7 (Registry, Vault, Exchange, Shares, Oracle, Admin). spec.md calls the single-curve design "test mode... thrown away when the live design replaces it" (section 4). That throwaway design is what actually got built and is the real system today; the order-book/matching-service design in spec.md sections 7-11 is still just a plan. Read spec.md as the long-term design, and `contracts/AUDIT.md` plus `nft-council-research.md` as what's real right now.

A full Next.js frontend exists under `web/` (markets, council, membership, watchlist, portfolio, partnerships, and a market-detail page), currently wired to a local NEAR sandbox for testing, not a live chain.

Also built since: a signed-price path for price markets in pm-oracle, juror pay and a forfeit for silent jurors, a Void that pays the closing price, governance cancel and execution window, capped fee settings, seeding at a chosen opening price, and a keeper script (`contracts/keeper`) that sends the calls that only happen when someone calls them.

Not done: the publisher service that signs prices, an outside security audit (named as still-open throughout AUDIT.md), mainnet deployment, the legal/licensing route (spec.md section 18), and the live order-book mode.

## Build and test the contracts

```bash
cd contracts
./build.sh                        # builds all six wasm files
cargo test -p pm_market            # 63 unit tests
cargo test -p pm_oracle            # 40 unit tests
cargo test -p pm_council           # 43 unit tests
cargo test -p pm_governance        # 31 unit tests
cargo test -p pm-tests             # sandbox integration tests (near-workspaces), 82 tests, 18 of them attacks
node --test keeper/keeper.test.mjs # the keeper's decision logic
```

## Run the website

```bash
cd web
npm run dev                       # local dev server against whatever chain NEXT_PUBLIC_* points to
npm run build:dev                 # static export against a running local dev chain (see contracts/pm-tests/tests/dev_chain.rs)
npm run serve                     # serve the static export
npm run e2e                       # Playwright end-to-end tests
```

## Reading order for a first look

1. `pitch.md`: the one-page pitch and what the small first test proves.
2. `spec.md`: the full design. Anything marked PROPOSED can change; anything marked OPEN needs a decision.
3. `stack.md`: the technology choices (oracle, server, indexer) and the evidence behind each.
4. `nft-council-research.md`: how the Council NFT ties into the contracts, with a dated build-order log.
5. `contracts/AUDIT.md`: what's actually built, tested, and independently re-verified, in build order. The most current document here.
