Prediction market on NEAR: product spec

Written 2026-10-08. Purpose: so that if this goes ahead we do not start from nothing. It describes the whole product, from the first test to a live venue with real money.

Status note, added 2026-10-16: four contracts, a governance layer and a website now exist (see contracts/AUDIT.md, the current, dated source of truth for what's built). What got built is the single-curve "test mode" contract this section calls throwaway (section 4), not the six-contract order-book design in sections 7-11, which is still unbuilt. Read the rest of this file as the long-term design, not as a description of the current system.

How to read it. Anything marked PROPOSED is my design choice and can change. Anything marked OPEN needs a decision from you or from a lawyer. Facts about Polymarket, Kalshi and NEAR come from the research files in this folder (replica/recon.md, replica/requirements.md, stack.md) and carry the same caveats there. Nothing here is built.

1. Product

A binary-outcome market venue. A market is one question with two outcomes, Yes and No. Users hold shares. At resolution each winning share redeems for exactly one unit of collateral and each losing share for zero. Before resolution users can buy and sell shares at prices from 0.01 to 0.99 in steps of 0.01.

Users deposit from any chain through NEAR Intents, trade, and withdraw to any chain. One account, one balance.

Our difference from Kalshi and Polymarket, which every design choice below must serve:
- Withdrawals that arrive in minutes with a published promise.
- Resolution rules and sources fixed on-chain before trading opens, and a dispute process run by a small named panel barred from trading that market.
- The full cost of a trade shown before confirmation.

Not in version 1: perpetuals, multi-outcome markets, combos, comments and social features, a mobile app, a public API for builders. Each is listed in section 17 as a later phase.

2. Core rules

Shares and collateral.
- One complete set is one Yes share plus one No share. A complete set is always backed by exactly one unit of collateral held in the contract.
- Invariant, checked continuously: for every market, Yes supply equals No supply equals collateral locked in that market.
- Prices are in collateral units per share, between 0.01 and 0.99, tick 0.01. Yes price plus No price on a matched trade equals 1.00.
- Collateral is a stablecoin with 6 decimals (see section 6, OPEN). Share quantity is an integer count of micro-shares, 1,000,000 micro-shares equal one share. Minimum order size is 1 share (PROPOSED).

How a trade creates or destroys shares.
- A buyer of Yes at 0.62 and a buyer of No at 0.38 match. The contract takes 0.62 and 0.38 from each side, mints one complete set per share, and gives each side their outcome. This is minting.
- A seller of Yes and a seller of No at prices summing to 1.00 match the other way. The contract burns the pair and returns collateral. This is merging.
- A buyer and a seller of the same outcome at the same price swap shares with no mint or burn.
- Any user can also split collateral into a set, or merge a set back, directly through the contract.

Resolution outcomes.
- Yes, No, or Void. Yes pays 1.00 per Yes share. No pays 1.00 per No share. Void pays each Yes share the market's closing Yes price and each No share the rest, so a pair always pays 1.00. The closing price is the Yes price averaged over time across the last 24 hours before close, fixed when the market becomes Void (BUILT 2026-10-18). An earlier draft paid a flat 0.50 on every share, as Polymarket does; that paid a holder of the cheap side several times what the shares were worth, so anyone who could force a Void profited.
- After resolution trading stops, and shares can be redeemed at any time with no deadline.

3. Market lifecycle

States and the only allowed moves:

draft -> review -> open -> closed -> proposed -> final
                                       |
                                       v
                                   disputed -> final
open or closed -> halted -> open or closed
review -> rejected
any state before final -> void (by the resolution process only)

draft: created by an operator, editable.
review: rule text, source, close time and resolution deadline are complete. A second admin must approve. On a regulated route this step is the listing review (section 14).
open: trading allowed. Rule hash and source are now written on-chain and cannot change.
closed: close time reached, trading stopped, awaiting an outcome.
proposed: an outcome has been proposed with a bond, challenge window running.
disputed: someone challenged, the panel is deciding.
final: outcome fixed. Redemption open.
halted: trading paused by an admin or the guardian, with a recorded reason.
void: resolved as Void.

A market must not move backwards out of proposed or final.

Built today (2026-10-18): none of the draft, review or rejected states exist. pm-market has no status field; the operator or owner calls create_market and the market is open for trading once seeded. Closed, proposed, disputed and final are tracked by time and by the oracle's case, not by a market state. The second-admin review is still the design for a regulated route, it is just not in code.

Required fields at creation: title, plain-language rule text, named resolution source (a specific URL or data source, not "reliable news"), close time, resolution deadline, category, tick size, fee category, and an explicit statement of what counts as Void.

4. Trading model

Two modes, because the first test has to be cheap.

Test mode (PROPOSED): no order book and no server. Each market has a built-in pricing curve held in the contract (a constant-product or logarithmic scoring curve, the choice is OPEN). A user buys or sells against the curve. This gives a price from the first second and needs no market makers. The contract owner funds a small starting liquidity per market.

Live mode (PROPOSED): a central limit order book. Matching runs off-chain on our own service and settles on-chain, as Polymarket does. Orders are signed by the user and verified on-chain, so the service cannot invent trades.

Order fields: market id, outcome, side (buy or sell), price, size, expiry time, nonce, fee rate cap, signer key, signature.

Order types: limit good-till-cancelled, good-till-date, fill-or-kill, fill-and-kill, and post-only (rejected if it would match at once). Market orders are fill-and-kill with a protective price.

Matching rules:
- Price-time priority.
- Self-trade prevention: an order that would match another from the same account is cancelled, the resting order is kept (PROPOSED).
- Partial fills allowed except fill-or-kill.
- No artificial matching delay in version 1 (Polymarket uses 250 ms on some markets, the reason is not needed here).

Trade keys (PROPOSED). The user does not sign orders with their main NEAR key. They register a trading key through one transaction. The contract accepts order signatures from registered keys only and the user can revoke a key at any time. Keys have an expiry.

Fees.
- Taker fee per trade: rate x shares x p x (1 - p), where p is the price. Same shape as Polymarket and Kalshi, which peaks at p = 0.5.
- Maker fee: zero. A rebate pool for makers is added in the live phase and is OPEN.
- Rate by fee category. Starting values are OPEN. For reference Polymarket uses rates from 0 to 0.07 (V) and Kalshi uses 0.07 with makers at a quarter of that (S).
- The fee shown to the user before they confirm is the exact fee charged.
- Owner decision 2026-10-15: every trade pays this p x (1 - p) fee, with p the average price of the trade, and a market pays a creation fee. A starting rate of 0.02 costs about 1% of a 50 cent trade. Rate and creation fee amount are OPEN. Redeem and withdraw carry no fee. Where the fees go is in section 9.
- Fees are taken from the taker's vault balance at settlement and credited to the fee account in the same transaction.

5. Money flow

The user holds a balance inside the vault contract. Trading moves that balance, not tokens on the user's wallet, so there are no per-trade approvals.

Deposit: user picks a chain and an asset, we request a quote from the Intents 1Click API with the vault as the recipient, the user sends to the deposit address given, Intents converts to the collateral token and delivers it. The deposit watcher credits the user's vault balance after the transfer is final. Edge cases to handle: quote expires, deposit below the minimum, wrong chain, funds arrive late, refund path (Intents refunds to the address given at quote time).

Withdraw: user asks to withdraw an amount to a chain and address. The vault checks the free balance (balance minus locked in open orders and positions), debits it, and issues an Intents withdrawal. The state of each withdrawal is shown: requested, sent, confirmed, failed. A failed withdrawal returns the balance.

Promise: a published maximum time for a withdrawal to leave the vault. The number is OPEN and must be measured on real Intents transfers first (stack.md next steps).

Escape hatch (PROPOSED). If the matching service is down, a user can still call the vault directly to withdraw their free balance and can still redeem shares after resolution. Open orders carry expiry times so they cannot stay live forever. This limits what a dead or dishonest operator can do.

6. Collateral and custody (OPEN)

Collateral token. Candidate: USDC bridged through Intents. Which exact token id, who issues it, and the issuer risk are not checked. Alternative: a NEAR-native stablecoin. OPEN.

Custody model. The first schema decision, and the one a licence route can change:
- Option A: self-custody by contract. The vault contract holds the funds, the operator can only move them by the rules in code. This is the design in this spec.
- Option B: custody by a regulated intermediary. Funds sit with a licensed broker or clearing firm, and our contracts mirror balances.
Everything is written behind one CustodyProvider interface (section 7) so B can replace A without touching market logic. OPEN until the legal gate.

Whether a regulated exchange can hold this collateral at all is not answered by any source found (requirements.md).

7. Contract architecture (NEAR, Rust, near-sdk)

Six contracts. Each is small on purpose, because each one holds money or decides outcomes and must be audited.

Registry (market factory). Creates markets, stores each market's rule hash, source, close time, deadline, fee category, state. Only the market's state machine from section 3 can move it.

Vault. Holds collateral. Tracks per-user free balance. Implements CustodyProvider:
  deposit_credit(user, amount, ref)
  lock(user, amount, market_id)
  unlock(user, amount, market_id)
  withdraw(user, amount, destination)
  Only the Exchange and the Registry can call lock and unlock. Only the Vault itself calls the Intents verifier.

Exchange. Settles trades.
  register_trade_key(key, expiry)
  revoke_trade_key(key)
  settle(batch of {order_a, order_b, fill_size, fill_price})
    For each pair: check the signatures against registered trade keys, check expiry and nonce, check price crossing, check the fee cap, check free balance, then mint, burn or swap shares as in section 2, and take the fee.
  cancel(order_id)
  The batch size is limited by NEAR gas per call. The limit is measured in testing, not guessed.

Shares. NEP-245 multi-token contract. Token id is market id plus outcome. Supports transfer so a user can move shares between their own accounts.

Oracle. Resolution process in section 9.

Admin. As built (2026-10-18): the owner of pm-market, pm-oracle and pm-council is pm-governance, a contract of up to 5 members who propose, vote, wait out a timelock, then execute. It is not a multisig. pm-market also has a separate operator key that can create and seed markets, halt and resume them, pause the contract and claim residuals, so routine work does not wait on a vote. The operator cannot redirect fees, change ownership or appoint a new operator; only governance can. There is no pause-only guardian key; the operator holds pause along with the routine powers.

Rules for all contracts:
- Emit NEP-297 events for every state change: market created, state changed, trade settled, deposit credited, withdrawal requested, withdrawal sent, outcome proposed, outcome challenged, outcome finalised.
- No unbounded loops over user data. Anything per-user is keyed and read one at a time.
- All amounts as unsigned integers, no floating point anywhere.
- Storage cost is paid by the user where a record is theirs (NEAR charges 1 NEAR per 100 KB of stored data, V). Orders are not stored on-chain in live mode, only nonces and balances.
- Upgrades only through the Admin timelock, and the old and new code hashes are published. Not true yet: governance controls calls made as the owner, not who can redeploy the code. Whoever holds a full-access key on a contract account can still replace the code outright. Before mainnet, delete those keys or hand them to governance (contracts/AUDIT.md, risk 2).

Safety rules added after the contract review (contracts/AUDIT.md): anyone can void a market that has no applied answer once its resolve_by time has passed (holders redeem at the market's closing price, section 2), the oracle refuses proposals that cannot finish before resolve_by, the jurors of a dispute are fixed on the case once drawn, and all text fields have length limits. Each market also keeps a bounded price log (the last 120 prices, one per seed, buy and sell) that the get_history view returns, so the website can draw a chart without an indexer. Test mode adds a single contract that combines Registry, Vault and a curve-based Exchange for markets with no order book. It is thrown away when the live design replaces it. It exists so the pitch test needs one deploy. As of 2026-10-18 that contract (pm-market, constant-product curve) is the real system; Shares is not a separate NEP-245 token, positions are balances inside pm-market and cannot be transferred.

8. Matching service (live mode)

One process, written in a language the team knows well (OPEN, Rust or TypeScript). Inputs: signed orders over an authenticated HTTP and WebSocket interface. State: the order book per market, held in memory and written to Postgres before any acknowledgement, so a crash cannot lose an accepted order.

Sequence for each order: verify signature and expiry and nonce, check free balance against what is already locked by this user's resting orders (read from the Vault through the indexer, with a safety margin), place or match, append to the log, acknowledge. Matched pairs go into a settlement queue. A settler sends the queue to the Exchange in batches.

Rules:
- The service holds no user funds and has no key that can move them. Its only privilege is to submit batches. A batch that breaks a rule fails on-chain.
- Every accepted order and every trade is signed into a public log with a hash chain, so anyone can check we did not reorder or drop orders (PROPOSED).
- Recovery: on restart rebuild the book from the log, reconcile against chain state, then reopen.
- Targets (estimates, to be measured): accept an order in under 50 ms, settle on-chain within about 2 seconds of matching (NEAR finality about 1.2 s per the Defiant report, S; NEAR's own exchange docs still said about 2 s when checked 2026-10-18, so measure it).

The service is the part of this system the user and any regulator will question most. A second signer or a trusted execution environment could reduce that trust. Neither is researched. OPEN.

9. Resolution and oracle

Two kinds of market.

Event markets (most of them). Resolved by the process below.

Price markets (crypto or finance questions that resolve on a number). Resolved from a price feed at a set time. Pyth Core no longer supports NEAR (V, Pyth docs). RedStone has NEAR connectors, not verified live (S). Decision 2026-10-17: build our own rather than wait on RedStone, in RedStone's own shape (a pull oracle, not a push feed). Design below. A price market still passes through the same challenge window as an event market; this only changes what "evidence" looks like.

Price feed, pull oracle (BUILT 2026-10-18 in pm-oracle and pm-market, except the publisher service, see the end of this block). Scoped to our own contracts reading our own feed. It is not a service offered to other NEAR projects: that would be a different and much bigger commitment (uptime promises, liability for someone else's loss) that this project does not need in order to resolve its own price markets.

How push and pull differ. A push oracle (classic Chainlink price feeds) needs a service writing fresh prices on-chain all the time, whether a contract needs them or not, which costs gas to keep data fresh that nobody may read. A pull oracle signs a price off-chain and only touches the chain when a contract needs it. That is RedStone's shape, and the one we build. We also copy RedStone's second idea: several independent signers must agree, not one.

1. The market names its exact answer rule. At creation a price market carries a price rule: an observation time, a strike, the decimals the price is scaled by, and a direction (Yes if the price is at or above the strike, or Yes if it is below). The rule text still states the exact source in words, for example "Binance BTCUSDT 1-minute candle close at 2026-12-31 00:00:00 UTC", or a named set of exchanges plus "median of their 1-minute closes". The rule is part of the hash locked when the market opens, so none of it can change. The observation time cannot be before close_at, because traders would then know the answer, and must be before resolve_by. A candle close is used rather than a single instant price because it is harder to move on a thin exchange.
2. Publishers compute exactly that, or refuse. Two or three publisher processes (three proposed) run on separate machines with separate keys. Each reads the sources the rule names. A publisher refuses to sign if fewer than the minimum number of sources answer, or if they disagree by more than a set percentage (both OPEN). Exchanges keep historical candles, so a publisher that was down at the observation time can still sign that price later. NOT BUILT: this off-chain service is the one part of the feed that does not exist yet.
3. The signed payload is bound to one market and one moment. The text a publisher signs is "pm-price:v1:<oracle contract id>:<network>:<market id>:<observation time>:<price>:<decimals>". Everything except the price is fixed by the market and the deployment, so one signature is good for exactly one price of one market, on one network and one contract. A trader cannot collect signatures at several moments around the deadline and submit the one that favours them, and a testnet signature is no use on mainnet. The network is a deploy setting, because a contract cannot read it.
4. A threshold of signers must agree. The contract accepts a price only when at least k of the configured publishers (2 of 3 proposed, at most 10 publishers) signed the same price for the same market, checked on chain with ed25519. A submission lists each signer's key and signature. A malformed entry, a key that is not a publisher, a repeat, or a signature that does not verify refuses the whole submission. One leaked key alone cannot set a price. A submission with all 10 signing burns 4.5 TGas and works with 30 attached.
5. Anyone can submit it, with a bond. CHANGED from the first draft of this section, which said no bond. A bond is needed because jurors are paid from the losing side's bond (event resolution, step 6): with no bond from the submitter, a correctly overturned bad price would leave nothing to pay the jury, and the game between submitter and challenger would no longer be the same one every other answer plays. The bond is returned when the window passes unchallenged, so a keeper that runs the submissions only has its capital held for the window. The signed price becomes the proposed outcome of the normal process. A plain proposal is refused on a price market, so the signatures cannot be skipped.
6. The challenge window and the panel still apply, unchanged. A correctly signed price still sits through the window before it is final. This is the backstop if k publishers are ever compromised together or all read the same wrong source data: a challenge escalates to the jury exactly as a disputed event outcome does. The window for price markets can be shorter than for event markets (length OPEN). No new dispute machinery: the existing propose, challenge and panel path is reused. There is no staleness limit to set: each signature covers exactly one observation time, so age does not matter.
7. Fast to revoke, slow to trust. Adding a publisher key, and changing how many must sign, are owner actions, so a governance vote and its timelock. Removing a publisher key is an operator action that takes effect at once, so a leaked key can be cut off in one call. This is the split pm-market already has. Removing a key can never leave fewer than k keys, which the contract refuses. A price market also cannot be registered until at least k publishers exist, so no market is created that nobody could answer, and its answer window is measured from its observation time.


Open: how many publishers and how many must sign at deploy, the minimum source count and the agreement percentage the publisher service uses, which exchanges are allowed as sources, and the price-market challenge window. Decided: the feed lives in pm-oracle, which already holds the propose, challenge and panel logic it reuses. Not yet built: the publisher service, and a keeper that submits signed prices.

Event resolution process (PROPOSED):
1. At creation the rule text and the resolution source are hashed and the hash is stored on-chain. The text is public. It cannot change after the market opens.
2. After close time, anyone can propose an outcome (Yes, No or Void) with a link to evidence and a bond. Bond size is OPEN. For reference Polymarket's proposal bond is typically $750 in pUSD, not a fixed amount (docs.polymarket.com, checked 2026-10-18).
3. Challenge window. Default 2 hours (same as Polymarket, checked 2026-10-18). Test markets use minutes. If nobody challenges, the proposal becomes final and the proposer gets the bond back. A reward from fees on top was planned and is not built, and with the proposer bond returned in full it is not needed to make a proposal worth submitting.
4. If challenged, the challenger posts an equal bond and the market moves to disputed.
5. A jury decides. As built: after a short block delay anyone calls resolve_draw, and pm-council draws the jury at random from staked NFT seats, excluding the proposer and the challenger. Jury size is set at deploy, odd, at most 21. Jurors commit a hash of their vote in the first half of the panel deadline and reveal it in the second half; majority of revealed votes wins. Jurors post no money bond, and a juror who never reveals simply is not counted. Deadline length is a deploy setting (48 hours PROPOSED for mainnet). A statement of no position in the market is still the design; it is not in code, and nothing on-chain can prove it.
6. The jury can choose Yes, No or Void. When a majority decides, the side whose answer the jury rejected is the loser, whichever outcome the jury chose, Void included. The loser's bond is split: a quarter goes equally to the jurors who revealed and sat with the final outcome, and the rest goes to the winner with the winner's own bond (BUILT 2026-10-18). If the jury does not decide, each side gets its own bond back and nobody is paid.
7. If the jury misses the deadline, or too few votes are revealed to form a majority, anyone can call finalize and the market goes Void.

Closed 2026-10-18: steps 5 to 7 used to combine badly with a flat Void payout. A quiet jury ended in Void, which paid a holder of the cheap side a windfall, and jurors lost nothing for staying silent. Void now pays the closing price (section 2), jurors are paid from the loser's bond, and a juror who never votes forfeits the revenue their seat earned while serving, which goes back to the pool (contracts/AUDIT.md, 2026-10-18). Two things follow from it. A juror who committed but had no chance to reveal because a majority settled the case first is not penalised. And the forfeit is small when revenue is small, so it is a weak stick on its own.

Every dispute, vote and reason is public.

The honest limit: a jury is a trust assumption. We are replacing token whales with seat holders drawn at random. It is better only if seats are spread widely enough that no one controls a jury. How jurors are paid is OPEN.

Council as an NFT collection (the owner's plan; nothing is minted or sold now). Revised 2026-10-09 after the owner's decision: the seats are also how the build is funded, and holders get a quarterly share of platform revenue. The council has human seats and AI agent seats. Everything below is PROPOSED unless marked built.

What is built today (2026-10-18, contracts/AUDIT.md): pm-council holds staked NFTs as seats, draws a random jury per case from them, locks a drawn seat until its case is final, and pays revenue to staked seats. pm-oracle runs commit-reveal votes. Also built: juror pay from the loser's bond and a forfeit of the revenue a silent juror's seat earned while serving. Not built: a money bond from jurors, a cap on seats per account, the conflict declaration, a market size cap, AI agent seats as a separate path, a two-stage vote, the evidence snapshot, and any enclave.

Funding and the law. Seats are sold to fund the build, and holders get a quarterly share of platform revenue. Buyers who pay money for a cut of someone else's profit is the shape most securities laws treat as an investment contract, so selling seats needs counsel before anything is minted (OPEN, same legal gate as section 17 phase 3). Until counsel says otherwise, no sale to US persons. The revenue share and the dispute pay are two separate things and stay separate in the contracts and in the marketing.

The honest limit of the revenue share. It does not stop a holder from betting on a market they judge, because a bet can come from another wallet and nothing on-chain links the two. It only aligns a holder if the quarterly cut is worth more than what rigging one market would win, and fees are capped by volume while one big market can hold more money than a seat earns in a quarter. So it is partial alignment, and the controls below carry the real weight.

Human seats, the controls against a bought verdict:
- Membership is custody, not an ownership check. An NFT becomes a seat by being sent into pm-council with nft_transfer_call (NEP-171). The seat belongs to the previous owner of the token, not to whoever relayed it. Built.
- Random jury per dispute, drawn after a challenge from staked seats, per seat so splitting seats across wallets does not raise anyone's odds. A holder cannot know ahead of time that they will judge a market, and has to hold a large share of all seats to control a jury. Built. The seed is NEAR's on-chain random seed read a few blocks after the request. NEAR's own docs say a block producer can see that seed early and can choose not to include an unfavourable resolve_draw, so the delay narrows this and does not remove it (contracts/AUDIT.md, council slice 1).
- Commit-reveal voting: each juror submits a hash of their account, vote and a salt, then reveals in a second window. Jurors cannot copy each other or reuse another juror's commitment. Built. A juror who does not reveal is not counted and forfeits the revenue their seat earned while serving. A money bond from jurors is not built.
- A drawn seat cannot unstake until its case is final, so the NFT cannot be sold or moved to buy a vote mid-dispute. Built. Unstaking also needs a request and a cooldown (60 seconds in tests, real length OPEN).
- Conflict declaration: a juror states they hold no position in the market and loses the bond and the seat if shown otherwise. This catches careless cases only, since linking wallets is hard.
- Cap on market size at launch, set so that the most anyone could win by rigging the largest allowed market stays below the cost of controlling a panel. This is the control that makes the attack uneconomic, and it needs the seat price, the bond and the market cap to be set together (OPEN).
- Jurors are paid per case from the loser's bond, shared among jurors who revealed and sat with the final majority. This is pay for work, apart from the revenue share. BUILT 2026-10-18.
- One person with many wallets is not solved by any of this. It needs an identity check or a cap per buyer, and that is OPEN.

AI agent seats. An agent is just an account on the panel list, so the current oracle accepts one with no contract change. The split between agents and humans is OPEN. The leading option is agents vote first, three on different models, and a split or a challenge of their verdict goes to a human draw; that needs a two-stage vote in the oracle, which is a contract change. The controls:
- The agents run in a trusted execution environment so the operator cannot read their keys. NEAR's Shade Agent Framework was the candidate, but NEAR's docs now say it is no longer maintained as standalone tooling after 19 April 2026 and name no successor, so the enclave route is OPEN (checked 2026-10-15, see nft-council-research.md). Without an enclave the operator holds the keys and is the weakest point of the whole council.
- Frozen evidence. When a case is challenged, the evidence link is fetched once, stripped to plain text, and its hash written on-chain. Agents read only that snapshot, never the live link, and every agent vote publishes the hash it read.
- Agents have no tools except casting a vote, so a successful injection can change a vote and do nothing else.
- At least three agents on different models, each voting without seeing the others, so one model's blind spot does not decide a case.
- Every agent vote is public with its reason text.
- Hidden or rotating wallets are not a defence. The panel is public the moment a case is challenged and every vote is a signed transaction, so the accounts cannot stay secret, and prompt injection works through the evidence text, not the wallet. A monthly rotation is optional hygiene only. Hiding the panel would need a private draw and a redesign of the oracle (OPEN).

Revenue split (owner decision 2026-10-15). Fees collect in a bucket that is not part of any market's collateral. A sweep, callable by anyone, sends 25% to the revenue-share pool and 75% to the business wallet (providers, domains and similar). The 25/75 split is a constant in pm-market's code, so changing it means redeploying the contract. Which accounts receive the two shares is set by set_fee_recipients, which only governance can call (vote plus timelock). Only staked NFTs earn and only staked NFTs can be drawn for disputes. Unstaked NFTs earn nothing. Every staked seat has the same weight. Staking is by nft_transfer_call into the Council registry (see nft-council-research.md). Open: how often sweeps run, whether claims open each quarter or at any time, the unstake cooldown, and what a staked juror loses for not voting. Accrual stays continuous even if payout is quarterly, so staking just before a quarter closes does not capture the whole quarter.

Say what members do and what they earn before any mint, in plain words, with the revenue share and its risks stated.

The venue stays sober (the ledger look in replica/design) because the product sells trust in the referee. The Council gets its own look inside the product: muted violet, a serif face, a seal and juror cards (see replica/design/components.md). The art set the owner showed on 2026-10-09 mixes dark council pieces with bright meme-style ones; the dark ones fit the Council page. Some pieces carry Zcash branding (a jersey, a medallion), so confirm who owns the art and whether that branding can be sold before it appears in anything public.

Under a regulated venue the exchange's own rulebook resolves contracts (requirements.md). In that case this process would be how the rulebook decides, and not a second authority. That depends on the licence route.

10. Data model (off-chain database, Postgres)

users: id, near_account, kyc_status, region, created_at
trade_keys: user_id, public_key, expiry, revoked_at
events: id, slug, title, category, created_at
markets: id, event_id, question, rule_text, rule_hash, source, state, close_at, resolve_by, tick_size, fee_category, outcome
orders: id, market_id, user_id, outcome, side, type, price, size, filled, status, nonce, expiry, signature, created_at
trades: id, market_id, taker_order_id, maker_order_id, price, size, fee, status, tx_hash, settled_at
positions: user_id, market_id, outcome, balance
balances: user_id, free, locked, updated_at
deposits: id, user_id, origin_chain, origin_asset, quote_id, deposit_address, amount_in, amount_credited, status, created_at, credited_at
withdrawals: id, user_id, dest_chain, dest_address, amount, status, intents_ref, created_at, sent_at, confirmed_at
resolutions: market_id, proposer, evidence_url, proposed_outcome, bond, window_ends_at, challenger, challenge_bond, panel_votes, final_outcome, finalised_at
admin_log: id, admin, action, target, reason, created_at (append only)
alerts: id, market_id, user_id, rule, status, notes (for surveillance, section 14)

The chain is the source of truth for balances, positions and outcomes. The database is a fast copy. A reconciliation job compares the two every few minutes and raises an alert on any difference.

11. Interfaces

Public HTTP (read): list markets with filters, market detail including rule text, hash, source, state and dispute history, order book depth, trade history, price history, user portfolio, user open orders, fee preview for a proposed order, deposit quote, withdrawal status, withdrawal promise and measured recent times.

Public HTTP (write, authenticated by a signed message): place order, cancel order, register trade key, request deposit quote, request withdrawal.

WebSocket: price and book updates per market, user order and fill updates, resolution state changes.

Errors are explicit and listed in the interface, covering at least: invalid signature, expired order, bad tick size, insufficient free balance, market not open, region blocked, verification required, rate limited.

12. Website

Screens, in build order. The home page is market-first, like the incumbents: search and filter tabs, a featured market with a chart beside a trending list, and a grid of cards with the chance of Yes and Yes/No buy buttons. The whole site scales by screen width (phone to 4K TV) through a fluid root size and auto-fitting grids; see replica/design/components.md.

Screens, in build order:
1. Market list: category filter, search, price chips, state labels.
2. Market page: question, plain rule text, source, close time, price chart, order book (live mode), trade ticket, dispute history, resolution status.
3. Trade ticket: buy or sell, limit or market, size, fee shown before confirming, error states for each reason in section 11.
4. Portfolio: positions, open orders, history, redeem button after final.
5. Deposit and withdraw: chain and asset picker, quote, status stepper, the published promise and recent measured times.
6. Resolution view: proposed outcome, evidence, countdown, challenge button with the bond, panel and votes.
7. Account: trade keys, verification status when required, region, limits.
8. Admin: create market, review queue, halt, propose and finalise, audit log.

Wallet connection through @hot-labs/near-connect (the connector behind the library the current NEAR docs show). Every state from recon.md (empty, loading, filled, error, blocked) is built, not skipped. The test version has only screens 1, 2, 3, 4 and 6, with curve pricing and no deposit from other chains.

13. Operations

Roles: operator (runs the matching service, no fund access), market admin (creates and approves markets, two people for approval), resolver (proposes outcomes), guardian (pause only), owner (multisig, upgrades). As built, the owner is pm-governance (vote plus timelock) and pm-market's operator key covers both the guardian's pause and routine market work; see section 7, Admin.

Market process: draft, a second person reviews, publish. Every step goes to the admin log with the person and reason.

Monitoring and alerts: settlement lag, challenge windows about to close with no proposal, operator gas balance, indexer delay, reconciliation mismatch, and the invariant from section 2 per market.

Incident response: a written runbook for halting trading, pausing withdrawals, and communicating. Reconciliation mismatch or an invariant breach pauses the affected market automatically.

14. Compliance hooks (built in, switched on by the licence route)

These exist as interfaces from the start so a licence route does not mean a rewrite. Which ones are required depends on the route chosen in the legal gate (requirements.md).

- Verification gate: a user state that blocks trading until verified.
- Region gate: geoblocking at the edge and a per-account region.
- Limits: per-user position and deposit limits.
- Sanctions screening hook on every deposit and withdrawal address.
- Listing review: a required second approval before a market opens.
- Surveillance feed: every order, trade, cancel, deposit and withdrawal as an event stream to a monitoring tool. A DCM must monitor trading in real time (V, requirements.md).
- Audit export and record retention.
- Self-exclusion and responsible-use limits (state regulators are the pressure point, V).

Confidential Intents (private trading) conflicts with surveillance and is left out.

15. Security

Threats to design against: operator reorders or drops orders, operator tries to move funds, replayed signatures, stolen trade key, malicious market text, front-running of the outcome proposal, panel collusion, oracle feed failure, drained fee account, deposit credited twice, reentrancy-style callback bugs in cross-contract calls, gas exhaustion in batch settlement, storage exhaustion by spam accounts.

Controls: signed orders with nonces and expiry, registered and expirable trade keys, no funds-moving key on the operator, governance vote plus timelock on owner actions (upgrades still need the full-access keys removed, section 7), operator pause, caps on per-market and per-user exposure at launch, idempotent deposit crediting keyed on the Intents reference, invariant checks and reconciliation, a published hash-chained trade log.

Testing: unit tests per contract, sandbox integration tests including time travel for challenge windows, property tests on the invariant under random trade sequences, a testnet soak with scripted users, then an external audit before any mainnet funds. Audit cost estimate $50K to $200K is a guess.

Launch limits: mainnet starts with a hard cap on total value locked and per-user deposits, raised in steps.

16. Infrastructure

See stack.md. Test: this machine, NEAR sandbox and testnet, free public RPC, local Postgres, mock oracle, local website. Live: redundant matcher, managed Postgres, paid RPC with a fallback, hosted indexer, keys in a hardware module, monitoring, CDN, audit.

17. Phases and what proves each is done

T. Pitch test. One combined contract, the small oracle with minute-long windows, a basic website, NEAR testnet then a few NEAR on mainnet with a few friends. Done when: create a market, trade it, resolve it through an unchallenged proposal, resolve another through a challenge and the panel, and redeem, all from the website, and the invariant holds throughout.

1. Full build on play money. Registry, Vault, Exchange, Shares, Oracle, matching service, indexer, full website, admin. Fake collateral. Done when: a scripted test of at least 100 users and 10,000 orders passes with the invariant intact and the reconciliation job clean, an unplugged matching service does not lose any accepted order, and the escape hatch works on testnet.

2. Intents leg. Real deposits and withdrawals measured on small funds. Done when: a deposit and a withdrawal on at least three different chains complete, the measured times are recorded, and the published promise is set from them.

3. Legal gate. Choose a licence route with counsel, set the compliance hooks accordingly, decide custody option A or B. Nothing real-money happens before this.

4. Limited live. Hard caps, selected users, audit complete, bug bounty open.

5. Open launch. Caps raised in stages.

Later, in order of my preference: multi-outcome markets, maker rebates and liquidity rewards, a public API for builders, perps (a separate regulated product, not started), mobile.

18. Open decisions

- Custody model, section 6. First schema decision.
- Collateral token, section 6.
- Curve for test mode, section 4. Decided: constant-product (pm-market/src/curve.rs).
- Fee rates and maker rebate, section 4. Fee shape decided (rate x shares x p x (1 - p), rate 2%, flat creation fee). The final rate, the creation fee amount and any maker rebate are open.
- Bond sizes and window lengths, section 9. Jury selection is decided: random draw from staked seats.
- Juror pay and the Void payout: decided and built 2026-10-18, see sections 2 and 9.
- Price oracle for price markets, section 9. Decided: our own pull feed. n, k, sources and the price-market window are open.
- Matching service language and any second signer or trusted execution environment, section 8.
- Licence route and the countries served. Needs counsel.
- Council NFT design, section 9: legal route for the seat sale and revenue share, seat price versus bond versus market cap, identity or cap per buyer, agent and human split, enclave choice, and when (if ever) to mint.
- Which categories to list first. Sports contracts carry the most regulatory exposure (V, MoFo). A narrow start such as crypto and economics questions is my lean.
- Languages for the website.
- Product name and brand.

19. What was not verified when this was written

Any primary-source licence cost. Whether RedStone is live on NEAR: its NEAR connector exists on GitHub and is pull-model, but its NEAR docs page returned 404 and no release date was found (checked 2026-10-18); moot now that we build our own feed. Chainlink: no NEAR network in Chainlink's data feed docs (checked 2026-10-18); the 2020 NEAR blog post was a TestNet announcement. Real Intents payout times and limits. Pricing for Neardata and Goldsky. Whether another prediction market exists on NEAR: answered 2026-10-15, yes, Noa Market (replica/competitor-noa-market.md). The June 2026 CFTC proposed rule text. Every cost estimate here is a guess unless marked otherwise.

20. Contract change plan

Written 2026-10-18 from a full read of pm-market, pm-oracle, pm-council and pm-governance against this spec. This is the work list for the build pass. STATUS 2026-10-18: R1 to R6 and D1 to D7 are built and verified, see contracts/AUDIT.md for what was built, how each was checked and what changed from this plan. D8 is not built, waiting on the planned collection size. Deviations from the plan: the submitter of a signed price posts the usual bond (D2); a jury that decides Void by majority now makes the proposer of another answer the loser, and a timeout no longer pays a proposer who proposed Void (D1); pm-council gained a read-only jury_of view for the keeper (R6). Still not built anywhere: the publisher service that signs prices, a keeper that submits them, an outside audit, and everything in sections 7 to 11 beyond the single-curve contract. Each item names the contract, the change, why, and the test that proves it. READY means it can be built as written. DECIDE means the owner has to choose first; the recommendation is given. Rules for whoever builds it: one item at a time, unit test plus sandbox test for each, break the change on purpose and confirm the test catches it, rerun the full suite and clippy, and add a dated section to contracts/AUDIT.md. No mainnet deploy is part of this plan.

READY

R1. pm-oracle: refuse markets whose deadlines can never be met. Today create_market only checks resolve_by > close_at. If the gap is shorter than the challenge window plus the panel deadline plus APPLY_BUFFER_NS, propose() refuses every answer and the market can only end in Void at its deadline. A careless or hostile operator could create markets that are sure to Void, which pays the cheap side a windfall (section 9, known gap). Change: register_market panics unless resolve_by - close_at >= window + panel deadline + APPLY_BUFFER_NS + a minimum proposal period (new deploy setting). pm-market already keeps a market untradable until registration succeeds, so a refused registration means the market never opens. Test: a market created with too short a gap never registers and cannot be traded; one at exactly the minimum registers.

R2. pm-oracle: let anyone retry releasing a jury. settle() calls council.unlock_case once and nothing retries it if it fails, so those seats stay locked forever (contracts/AUDIT.md, slice 2). Change: add retry_unlock(market_id), callable by anyone, only for a Final case that was disputed. unlock_case is already safe to call twice. Test: after a dispute settles, retry_unlock works and leaves seats unstakable; on a case that is not final it is refused.

R3. pm-council: a seat that asked to unstake cannot be drawn. Today draw() only skips seats already serving, so someone on their way out can still judge a case. Change: skip stakes with unlock_requested_at set. Test: request an unstake, draw, the seat is never picked; a draw with too few remaining seats fails as it does today.

R4. pm-council: the unstake cooldown becomes a deploy setting. Today it is a 60 second constant. Change: cooldown_ns is a constructor argument, and the owner (governance) can change it later. It must be at least the oracle's challenge window plus panel deadline, so a seat cannot be staked, drawn and gone inside one case; document that in the comment, the council does not know the oracle's settings. Test: unstake before the configured cooldown is refused, after it works.

R5. pm-governance: approved proposals expire if nobody executes them. Today an approved proposal stays executable forever, and execute() is open to anyone, so an old approval can be fired months later at a bad moment. Change: new setting execution_window_ns (constructor argument, changeable through its own action like the timelock). After approved_at + timelock + execution_window the proposal reads as Expired and execute() refuses it. Test: execute inside the window works, one nanosecond after it is refused.

R6. Operations, no contract change: a keeper. resolve_draw, finalize and retry_apply all depend on someone calling them in time. If nobody calls resolve_draw before the commit phase ends, the dispute goes Void. Build a small script that watches open cases and calls each one when due. Also check at deploy that the council has at least jury_size different seat holders; with fewer, every draw fails and every dispute ends Void.

DECIDE

D1. The Void and juror gap (section 9, under step 7). This is the most important open item before real money. Three changes, each buildable on its own:
- D1a pm-market: Void pays a closing price, not a flat half. Recommended: the time-weighted average of the market's last price points before close (the history is already stored), not the single last price, because the last price can be pushed by one large buy just before close. A Yes share pays p, a No share 1 - p, and a full pair still pays exactly 1, so the books stay solvent (owed = locked - 2 x pool_yes x pool_no / (pool_yes + pool_no) for the last-price version, which is never more than locked). Choose: last price or average, and over how many points.
- D1b pm-oracle: pay jurors. Recommended: the loser's bond is split, a share to the jurors who revealed and sat with the majority, the rest to the winner. Choose the share (25% proposed).
- D1c pm-council plus pm-oracle: a drawn juror who never reveals loses something. Recommended: the revenue that seat earned while serving on that case goes back to the pool for the other seats. No money bond is needed for this. Choose this or a ban from the next draws.

D2. pm-oracle: the pull price feed in section 9. Choose where it lives. Recommended: new methods on pm-oracle, because it reuses the propose, challenge and panel code as it is. pm-oracle then also needs an operator account for the fast revoke, the same pattern as pm-market. n, k, the staleness rules and the price-market window can be deploy settings, so they do not block the build.

D3. pm-market: where the leftover goes after a market resolves. claim_residual credits the owner, which is now pm-governance, a contract with no easy way to spend a token balance held inside pm-market. The seed money came from the operator. Recommended: credit the business wallet.

D4. pm-market: fees governance can change, with hard caps. The 2% rate and the creation fee are constants. Recommended: setters that only governance can call, with a ceiling written in code (for example 5% and a fixed maximum creation fee) so even a captured governance cannot set a confiscatory fee. Choose the caps.

D5. pm-council: a cap on seats per account. seats_of already counts them, so the check is one line in nft_on_transfer. Choose the number. It does not stop one person with many wallets (section 9), it only raises the cost.

D6. pm-governance: a way to cancel an approved proposal during its timelock. Today the timelock only lets outsiders see a change coming; the members cannot stop it. Recommended: a cancel that needs threshold member votes. Honest limit: if the members who approved it are the problem, they will not cancel it; this is for mistakes, not for a captured majority.

D7. pm-market: seed at a chosen starting price. Every market opens at 50% because the seed is split evenly. For a lopsided question, early traders take money from the seed until the price is right, and that loss falls on whoever seeded. Recommended: create or seed takes a starting probability. Lower priority than D1 to D6.

D8 (NOT BUILT, waiting on an answer). pm-council: more than 1,000 seats. The draw reads every seat, which costs about 190 to 210 TGas at 1,000 and is why MAX_SEATS is 1,000. If the collection will be bigger, the draw has to pick random positions directly instead of reading every seat. Only needed if the collection is over 1,000; say the planned size.

Order once decided: R1 to R5 first (small, no decisions), then D1, then D2, then the rest.
