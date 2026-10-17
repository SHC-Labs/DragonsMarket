Build log

2026-10-08, contracts (Build T, milestones 0 to 2). The website is not built yet.

M0 Toolchain. Done. Rust 1.99.0, wasm target, cargo-near 0.22.0. A tracer test deployed the mock token to the NEAR sandbox, called it and read it back. Harder than expected: the macro `impl_fungible_token_storage!` in near-contract-standards 5.29.1 does not compile (it declares storage_withdraw with U128 where the trait wants NearToken), so mock-ft implements storage management by hand. Plain `cargo check` is blocked by near-sdk, which is on purpose; use `cargo near build` or enable the unit-testing feature for native tests.

M1 pm-market. Done, 222 KB wasm. Create market, storage deposit, deposit and buy through ft_transfer_call, sell, withdraw with refund-on-failure callback, redeem with no deadline, claim_residual, halt and pause, views and quotes. Pricing is a constant-product curve in curve.rs: 7 unit and property tests (the pool product never shrinks, a round trip never profits, a sell quote never needs more shares than offered).

M2 pm-oracle. Done, 186 KB wasm. Register market, propose with bond, challenge, panel vote with majority, finalize, timeout to Void with both bonds returned, retry_apply, bond withdrawal with refund-on-failure callback.

Integration tests in pm-tests (build first with contracts/build.sh): 5 flow tests, about 40 s. They cover trading and the invariant, refused requests with refunds (no storage deposit, price moved, early proposal, empty void policy), the unchallenged path to payout, the challenged path decided by panel majority, and the timeout to Void with half-dollar redemptions.

Checked by breaking things: planting "sell does not lower locked collateral" failed the trading test. Planting "anyone may call set_outcome" first survived, because an earlier check hid it; a post-close test was added and now catches it.

Not tested, and what that means
- The failure path of withdraw and withdraw_bond (the token refusing the transfer, so the balance is restored). The code is written, no test forces it.
- Gas under load, and the storage cost per account at the 20-position cap.
- Anything on testnet or mainnet. Sandbox only.
- Challenge window and panel behaviour with real wall-clock time.

Ceilings (marked `ponytail` in the code)
- The panel is picked by the owner. Swap for the random Council draw before anyone other than us is on it.
- The winner takes both bonds and jurors earn nothing yet.
- No fees in the curve, owner is the only liquidity provider, one owner key (no guardian role).
- Positions are capped at 20 per account to bound storage.

Open: the website (S01, S02, S03, S05, S09), then testnet deploy and a scripted run, then the mainnet test with a few NEAR (the two wasm files total 408 KB, about 4 NEAR of storage by the 1 NEAR per 100 KB rule).

2026-10-08 (later), website (Build T). Done on a local chain, not on testnet.

Built in web/ (Next.js 16.4 static export, Tailwind 4 with the dark tokens from replica/design, @hot-labs/near-connect for signing, reads straight from JSON-RPC): S01 market list, S02 market page with the rules block, resolution and trade ticket (S03), S05 portfolio, S09 resolution view with the Council (juror cards, votes, verdict, seal). Every transaction waits for the chain to show its effect and, if it never does, reads the transaction back and explains the panic in words with a short reference.

Checked: tsc and eslint clean, 10 unit tests (formatting, parsing, slippage, error wording), and 22 browser tests (11 at 1440 px, 11 at 390 px) against a real local chain with six markets in different states (contracts/pm-tests/tests/dev_chain.rs): list, open market with a real quote from the chain, proposed answer (challenge hidden from the proposer), Council dispute, Council verdict, closed with no answer, portfolio, missing market, axe accessibility (no serious or critical violations), keyboard-only ticket entry, no sideways scroll, no console errors. Screenshots are in replica/clone-screens/.

Found by the browser run and fixed: mobile pages scrolled sideways by 119 px (a long URL widened an unnamed grid column, fix is `grid-cols-1`), a definition list with a button outside its term and value, finished markets still showing live-looking prices (now show the result). Broke it on purpose once more: offering Challenge to the proposer fails the test.

Not verified
- Signing with a real wallet. The local chain has no wallet; on it the site can pretend to be an account with ?as=<account id> and refuses to send. This is the main open item and needs testnet.
- The write paths in the browser (buy, sell, propose, challenge, vote, redeem, withdraw). Their contract side is tested in the sandbox; the site builds the calls and waits for results, but no real signed transaction has gone through it.
- The faucet button against a deployed token, and the storage-deposit step.
- Intents deposits and withdrawals (not built).

Ceilings and notes
- Prices refresh by polling every 5 s, not a websocket.
- npm audit reports 5 high issues, all in the dev-only lint chain (braces via eslint-config-next); nothing shipped to the browser. Not force-fixed.
- The static export reads contract ids at build time (NEXT_PUBLIC_MARKET_ID, _ORACLE_ID, _TOKEN_ID, _NETWORK, _RPC_URL); web/scripts/build-dev.sh builds against the local chain.
- Nothing is committed and the folder is not a git repo.

Next: testnet deploy (needs a funded testnet account from you), a scripted run, then a real wallet pass, then the few-NEAR mainnet test.

2026-10-08 (later still), redesign. The first website pass was a bare test front end and read as a text page, not a prediction market. Rebuilt the front end market-first and made it fluid.

Changed: the home page now leads with search and filter tabs, a featured market with a price chart and Yes/No buttons, a trending list, and a grid of market cards (small sigil, chance-of-Yes gauge, Yes/No buttons, state, amount in play). Every market has a generated sigil drawn from its rule fingerprint. The market page has a big probability, a step chart with hover readout and a data table, and the rules above the ticket. Portfolio uses cards. Dark look kept, with softer corners, a serif for numerals and headlines (Instrument Serif), film grain and soft glows. All entrances run once and stop.

Contract: markets now keep a bounded price log (120 points) and a get_history view. Tested in the sandbox (the log's last point equals the shown price, a unit test checks the cap).

Scaling: all sizes are rem; the root size is clamp(16px, 0.5vw + 11px, 34px); the grid is auto-fill with a 18.5rem minimum card width; gutters and page width are fluid; touch targets are 44 px on touch screens; safe-area insets are respected. The browser suite now runs every test at five sizes (phone 390, tablet 820, laptop 1440, 1080p 1920, 4K 3840): 70 tests pass, including a new test that checks the column count, the root size and no sideways scroll at each size. Breaking it on purpose (pinning the root size to 16 px) fails it at laptop, 1080p and 4K.

Found and fixed by the checks: single-column grids sized to their content, so the featured card ran off a phone screen (every such grid now has grid-cols-1); a global link colour rule beat Tailwind's layered colours and blanked the primary link button (moved into the base layer); the sigil glow showed a square edge; account-derived sigils all looked the same (weak hash, now cyrb53); no level-one heading on the new home page.

Still not verified: signing with a real wallet and anything on testnet (unchanged). The design preview.html is out of date; the running site is the reference. replica/clone-screens/ still holds older screenshots named -desktop and -mobile next to the new ones named by size; they were not deleted.

2026-10-08 (night), contract review. Full write-up in contracts/AUDIT.md. Found and fixed four problems, each with a test that fails when the fix is removed: money stuck forever in an unanswered market (now anyone can void it after its deadline, and the oracle refuses proposals that cannot finish before then); the owner able to change the jury of an open dispute (now frozen per case); unbounded text (now limited); and the missing contract-level random-sequence test (added, and checked by planting a bug in sell and a rounding bug in the Void payout). 24 contract tests pass (13 unit, 5 flow, 4 safety, faucet, tracer) and clippy is clean. Not changed, needs a decision: Void pays a flat half per share, which rewards cheap-side holders if a market can be forced to Void; recommended fix is to pay Void at the closing price. Contract interface changes are additive only (void_if_unresolved on the market, a panel field on the oracle case), so the website keeps working.
