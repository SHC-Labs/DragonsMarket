# Architecture: prediction market on NEAR

Written 2026-10-08. Inputs: recon.md, features.csv, fixes.md, requirements.md, and the product spec in ../spec.md and stack tools in ../stack.md. This file is the build plan. Where spec.md says what the product is, this says what we build first and in what order.

The pack's default template assumes a web app with Supabase and Stripe. This product is mostly smart contracts, so the defaults for database, auth and payments are replaced. Choices that came from reading current docs are marked (docs).

## The two builds

Build T, the pitch test. Two contracts (market, oracle), one mock token on testnet, one website. No server, no database. The website reads the chain directly and sends transactions through the user's wallet. Prices come from a built-in curve, so there is always a price with no order book.

Build L, the live product. Everything in spec.md: vault, exchange with signed orders, matching service, Postgres, indexer, Intents deposits and withdrawals. Not started until T is done and the legal gate in pitch.md and requirements.md is passed. Section "Live build" at the end lists what T leaves behind and what L adds.

## Stack

Contracts: Rust with near-sdk. State and methods use `#[near(contract_state)]` and `#[near]` (docs). Why: it is the standard NEAR language, and every NEAR tool assumes it.

Contract tests: near-workspaces / NEAR sandbox, run with `cargo test`. Tests run locally with no network and no cost, and can fast-forward time (docs). Why: challenge windows are hours in production, so tests must skip time.

Collateral: any NEP-141 token set at contract init. On testnet a mock token we mint, on mainnet the real stablecoin id chosen then. Why: no code change between the two.

Share accounting: balances kept inside the market contract in build T. A NEP-245 multi-token wrapper is added in L so shares can be moved between accounts (NEP-245 is the multi-token standard with `mt_transfer`, `mt_balance_of` and `mt_batch_transfer` (docs)).

Website: Next.js (App Router) and TypeScript, TailwindCSS. Why: the default stack, Node 22 is already installed here. Static export is enough for T because everything is client-side.

Wallet: `@hot-labs/near-connect`, the connector underneath near-connect-hooks, used directly (docs show `connector.wallet().signAndSendTransaction`). It avoids pulling near-api-js into the bundle. Reads go straight to JSON-RPC from `lib/rpc.ts`, so browsing needs no wallet. The earlier version of ../spec.md said "NEAR wallet selector" from my memory. The current NEAR docs show near-connect-hooks, so spec.md was corrected.

Chain reads: view calls through `viewFunction`, over the free FastNEAR testnet endpoint. No indexer in T.

Database: none in T. Postgres 17 in L. Postgres client is already installed here. The throwaway container in this session ran schema.sql cleanly.

Auth: none in T, the wallet is the identity. In L, a signed message from the wallet (NEP-413 style) opens a short session. No Supabase, no Auth.js.

Payments, email: none. Money moves on-chain. Notifications are an L decision.

Jobs: none in T. In L, separate worker processes run as systemd services (the box already runs systemd units): deposit watcher, settler, oracle watcher, reconciliation.

Hosting: T runs on this machine. For friends on mainnet, serve the static export from the Caddy already on this box (MACHINE_MAP lists vhosts). L needs the redundant setup in ../stack.md.

## Build T: contracts

Two contracts plus a mock token. Kept separate on purpose: the oracle holds bonds and decides outcomes, so it is the part to read and audit alone.

### Market contract (`pm-market`)

State:
- owner, oracle account, collateral token id, paused flag
- markets: map from market id (u64) to Market
- balances: map from account to free collateral (u128, micro-units)
- shares: map from (market id, account, outcome) to u128
- registered accounts, for storage

Market: title, rule_text, resolution_source, void_policy, rule_hash (sha256 of those fields plus close_at), close_at and resolve_by (nanoseconds), state, pool_yes, pool_no, collateral_locked, outcome, total_yes, total_no.

The curve. Constant product, as in the Gnosis and Polymarket-style automated markets: pools Y and N hold shares, k = Y x N, price of Yes = N / (Y + N). To buy Yes with collateral a: add a to both pools (the contract mints a complete set per unit), then take Yes out of the pool until Y x N is back to k. Shares out = Y + a - k / (N + a). Selling is the reverse. The owner seeds equal Y and N at creation, so the opening price is 50 cents. All maths in u128 with checked operations, rounding in the pool's favour. The numbers stay under u128 as long as pools stay under about 1e19 micro-units, which the contract enforces with a cap per market.

Change methods:
- `create_market(...)`: owner only. Stores the fields, computes rule_hash, then promises a call to the oracle's `register_market`. Seed liquidity arrives by `ft_transfer_call` with message `seed:<market id>`.
- `ft_on_transfer(sender, amount, msg)`: called by the collateral token. msg `deposit` credits balance, msg `buy:<market>:<yes|no>:<min_shares>` buys in one transaction. Returns any unused amount, which the token refunds.
- `buy(market, outcome, amount, min_shares)`: from internal balance.
- `sell(market, outcome, shares, min_collateral)`: credits internal balance.
- `withdraw(amount)`: calls `ft_transfer` on the token, then on the callback restores the balance if the transfer failed.
- `set_outcome(market, outcome)`: oracle account only. Moves the market to final (or void). Idempotent: a second call with the same value changes nothing.
- `redeem(market)`: after final. Pays 1.00 per winning share, 0.50 on every share if void.
- `close(market)`: anyone, after close_at, moves open to closed. Buy and sell also check the time themselves.
- `halt(market)` and `resume(market)`: owner or guardian, reason logged in an event.

View methods: `get_market`, `list_markets(from, limit)`, `get_balance`, `get_shares`, `get_price`, `quote_buy`, `quote_sell` (so the fee-free cost is shown before confirming).

Events (NEP-297): market_created, buy, sell, deposit, withdraw, state_changed, outcome_set, redeemed.

Invariant, asserted in tests and by a view `check_invariant(market)`: for every market, total Yes shares in existence equals total No shares equals collateral locked in it.

### Oracle contract (`pm-oracle`)

State: market contract id, panel (a list of accounts), bond token and bond amount, window length, panel deadline, per-market resolution record.

Methods:
- `register_market(market, close_at, resolve_by, rule_hash)`: market contract only.
- `ft_on_transfer` with message `propose:<market>:<yes|no|void>:<evidence url>`: needs the bond. Only after close_at. One open proposal per market. Starts the challenge window.
- `ft_on_transfer` with message `challenge:<market>`: needs an equal bond, only inside the window. Moves to disputed.
- `panel_vote(market, outcome, reason)`: panel members only, one vote each, reason required. Majority of the panel finalises.
- `finalize(market)`: anyone. If the window passed with no challenge, finalises the proposal. If disputed and past the panel deadline with no majority, finalises Void.
- Finalising calls `set_outcome` on the market contract, then pays bonds back: undisputed returns the proposer's bond. Disputed: the side the panel agreed with gets both bonds minus a panel share.

The oracle call into the market is asynchronous and can fail. A failed `set_outcome` leaves the resolution as "final, not applied" and `finalize` can be called again. The market side ignores duplicates.

Test windows are set at init. Tests use seconds and fast-forward. The live testnet demo uses minutes.

### Mock token (`mock-usdc`)

A plain NEP-141 token, 6 decimals, with an owner-only `mint`. Testnet only.

## Build T: website

Screens, using the IDs from recon.md:
- S01 market list: title, price, state, close time.
- S02 market page: question, the plain rules (rule text, deciding source, void policy, rule hash), price, price history if cheap, dispute history.
- S03 trade ticket: buy or sell, amount, shares you would get, minimum accepted. Shows the exact outcome from `quote_buy` before confirming. Errors for each reason the contract can return.
- S05 portfolio: balance, shares, redeem button once final.
- S09 resolution view: proposed outcome, evidence link, countdown, challenge button with the bond, panel votes and reasons.

Home is market-first (search, filters, featured market and trending list, card grid with Yes/No buttons). The contract keeps a 120-point price log per market (`get_history`) for the charts. Layout is fluid from phone to 4K by a rem-based scale.

Not in T: order book (S04), deposit and withdraw from other chains (S06, S07), account and compliance (S08), leaderboard (S10), maker view (S11), admin and surveillance (S12, S13), API keys (S14). Market creation and proposing/challenging in T are done from the website's admin page or the command line, whichever is quicker.

Flows covered: F01 deposit (collateral only, no Intents), F02 buy, F03 sell, F04 resolution and payout. Not covered: F05 withdraw to another chain, F06 create via admin console, F07 surveillance.

## Build T: how it is tested

Contract tests (sandbox, `cargo test`):
- Buy and sell round trip returns no more than was put in, rounding always favours the pool.
- Property test: random sequences of buys, sells and redeems never break the invariant.
- Time: cannot propose before close, cannot challenge after the window, windows pass when time is fast-forwarded.
- Oracle: undisputed path, disputed path with panel majority, panel timeout giving Void, a failed `set_outcome` retried.
- Authorisation: only the oracle calls `set_outcome`, only the market registers markets, only the owner creates markets.
- Token edge cases: a failed `ft_transfer` on withdraw restores the balance, refund of unused amount in `ft_on_transfer`.

Website tests: a scripted run against testnet creates a market, trades from two accounts, resolves by proposal, resolves a second market through challenge and panel, redeems.

Done for T when: the full run above works from the website alone on testnet, the invariant view returns true after every step, and `cargo test` passes. Then the same two contracts go to mainnet with a few NEAR for storage (the pitch estimates a few NEAR for a contract of a few hundred KB, at about 1 NEAR per 100 KB staked) and friends trade a market with a few dollars each.

## Build T: the parts that bite

- Async calls are not atomic. Oracle to market and market to token both cross contracts, so each needs a callback that handles failure and each state change happens before the promise is sent (reentrancy).
- Token transfers need a 1 yoctoNEAR attached deposit and the receiver must be registered on the token. Withdraw to an unregistered account fails and must restore the balance.
- `ft_on_transfer` runs on the token's call, so the contract must check that the caller is the configured collateral token, or anyone could fake a deposit.
- Storage costs staking: 1 NEAR per 100 KB. Every new account entry costs the contract storage, so users pay a small storage deposit on first use (a new account gets 770 bytes free (docs)).
- Time is block time in nanoseconds, not wall-clock exact. Windows should not be shorter than a few blocks.
- Gas: 300 TGas per transaction is the ceiling. Keep every method to a handful of storage reads.
- Rounding in the curve. Round in the pool's favour and test the edges (very small and very large buys).
- Mainnet token decimals and the registered ids differ from the mock. Never hard-code them.
- Anyone can propose first. The bond is what stops spam, so test with a bond far larger than gas.
- Panel keys: in T the panel is test accounts we hold. In L panel members are outside people, which is a different trust problem that no code solves.

## API

T has no HTTP API. Everything is contract methods, listed above.

L adds an HTTP API and WebSocket from spec.md section 11. Routes, who can call them, and the flow they belong to:

- GET /markets, GET /markets/:id, GET /markets/:id/book, GET /markets/:id/trades, GET /markets/:id/history: public, read-only. F01, F02.
- POST /orders (signed order), DELETE /orders/:id: wallet signature checked against a registered trade key. F02, F03.
- POST /trade-keys, DELETE /trade-keys/:id: a signature from the account's main key. F02.
- GET /me/portfolio, GET /me/orders: session. F02, F03.
- POST /deposits/quote, GET /deposits/:id: session. F01.
- POST /withdrawals, GET /withdrawals/:id: session. F05.
- GET /withdrawal-times: public. The published promise.
- POST /admin/markets, POST /admin/markets/:id/approve, /halt, /resume: admin roles, every call written to admin_log. F06.
- WebSocket: book and price updates per market, own orders and fills, resolution state.

Webhooks in: Intents deposit status from the quote reference. Webhooks out: none. Official public APIs only. We use NEAR Intents' documented quote API with our own key, and none of Kalshi's or Polymarket's private endpoints.

Jobs (L): deposit watcher (every few seconds), settler (continuous, batches to the exchange contract), oracle watcher (windows about to close with no proposal), reconciliation (every few minutes, chain against database), withdrawal tracker.

## Schema

schema.sql holds the L database: 17 tables and one view (`withdrawal_times`). It was applied to an empty Postgres 17 in a throwaway container and loaded without errors, and its append-only trigger blocked an update on the admin log. Not yet tested: the indexes under load, and any query the matching service will run.

Choices: ids are uuids; times are timestamptz; money is integer micro-units in bigint; statuses are check constraints; every foreign key has an index and an explicit delete rule (`restrict` on anything money-related); access control is in the API layer with two Postgres roles; `admin_log` and `ledger_entries` are append-only by trigger; `orders` has a unique (user, nonce) to stop replays; `chain_events` has a unique (receipt, index) so the indexer can be replayed safely.

Hard constraints the recon found:
- A signed order cannot be replayed: the nonce is unique per user.
- Over-filling is a database problem, not a UI problem: `filled_micro <= size_micro` is a check.
- Two outcomes for one market cannot exist: `outcome` is only set when the state is final or void.
- A deposit cannot be credited twice: `intents_ref` is unique and the credit is one transaction that also writes the ledger.

## Build order

Milestone 0, setup (about 1 hour): install Rust and the wasm target, create the repo, build an empty contract, run `cargo test`.

Milestone 1, market contract: create, deposit, buy, sell, withdraw, redeem, invariant view, curve maths with property tests. Tables: none. Screens: none.

Milestone 2, oracle contract: register, propose, challenge, panel vote, finalize, bonds, cross-contract `set_outcome` with retry. Tests with fast-forwarded time.

Milestone 3, website: S01, S02, S03, S05, S09 on testnet, with the plain rules block and the void policy shown (from the fixes: rules clear before betting).

Milestone 4, testnet run: deploy, script two traders and two resolutions, record anything confusing.

Milestone 5, mainnet run: deploy the same contracts, a few NEAR for storage, friends with a few dollars each.

After T, if it works and the legal gate is passed:

Must-haves in features.csv, by area, in this order: trading and order book (limit and market orders, cancel, order book depth); funding (deposit and withdraw through Intents, plus the withdrawal status tracker from the fixes); portfolio; real-time prices; resolution at full scale (dispute escalation, a public dispute record); compliance hooks (verification, region gate, surveillance, listing review, audit log).

Should-haves: split and merge of full sets, maker rebates and liquidity rewards, show when funds become withdrawable and why, public API and SDK, fill-or-kill and fill-and-kill orders, stated void policy on every market in the admin flow, responsible limits.

Could-haves: social features, leaderboard, mobile app, builder attribution.

Skipped by design: perpetuals, sports data licences, matching the incumbents' liquidity, a licence.

Support (fixes item 2) is staffing, not code, so it has no build step. It needs a decision in the legal and operations plan.

## Riskiest parts

1. The oracle contract. It holds bonds and decides money outcomes, it is asynchronous, and nothing off the shelf exists on NEAR to copy. The panel is also a trust assumption no code removes.
2. The off-chain matcher in L. It is a single operator the whole design leans on, and the escape hatch (withdraw and redeem without the operator) is untested anywhere.
3. Curve and share accounting under rounding. A small error breaks the invariant, and the invariant is the only thing guaranteeing every winner can be paid. Property tests are the control.

Also open and not a build risk: whether Intents pays out as fast as the pitch claims. That is measured in Phase 2.

## Next

`/replica-design` for the look of the site. Before coding contracts, install Rust and the NEAR sandbox tooling (Milestone 0), which has not been done on this machine.
