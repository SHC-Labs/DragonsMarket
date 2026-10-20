Dragons Market: product spec

Written 2026-10-08. Purpose: so that if this goes ahead we do not start from nothing. It describes the whole product, from the first test to a live venue with real money.

Owner decision, 2026-10-19: NEAR Intents holds the platform's fungible tokens, including committed market backing in controlled Intents accounts. A separate Dragons Market token-holding vault is no longer the target. [intents-architecture.md](intents-architecture.md) is the accepted custody decision and migration boundary; `hackathon-plan.md` is the delivery plan. Settlement authorization, escrow enforcement, identity binding, and recovery still need implementation. Current NEP-141 prototype behavior and dated review fixes below are preserved as implementation history.

Status note, added 2026-10-16: four contracts, a governance layer and a website now exist (see contracts/AUDIT.md, the current, dated source of truth for what's built). What got built is the single-curve "test mode" contract this section calls throwaway (section 4), not the six-contract order-book design in sections 7-11, which is still unbuilt. Read the rest of this file as the long-term design, not as a description of the current system.

How to read it. Anything marked PROPOSED can change. Anything marked OPEN needs a decision. Some contracts and the website are built; the Intents custody migration and the full order-book design are not. Facts about Polymarket, Kalshi and NEAR come from the dated research files, which now live outside this repo (see the archive note in section 19), and retain their caveats. Code/manuals describe implementation; the accepted custody decision describes the target.

1. Product

A binary-outcome market venue. A market is one question with two outcomes, Yes and No. Users hold shares. At resolution each winning share redeems for exactly one unit of collateral and each losing share for zero. Before resolution users can buy and sell shares at prices from 0.01 to 0.99 in steps of 0.01.

Users fund from supported chains/assets into NEAR Intents, trade against controlled backing held there, and withdraw through supported routes. One account view shows available, committed, and pending funds; it must not conceal where authority or finality differs.

Our difference from Kalshi and Polymarket, which every design choice below must serve:
- Withdrawals with visible status, a recovery path, and published measured times; a minutes-based promise is not established yet.
- Resolution rules and sources fixed on-chain before trading opens, and a dispute process run by a small named panel barred from trading that market.
- The full cost of a trade shown before confirmation.

Not in version 1: perpetuals, multi-outcome markets, combos, comments and social features, a mobile app, a public API for builders. Each is listed in section 17 as a later phase.

2. Core rules

Shares and collateral.
- One complete set is one Yes share plus one No share. A complete set is backed by exactly one collateral unit under settlement-contract control inside Intents, rather than in a separate token vault.
- Invariant, checked continuously: for every open market, total Yes and No supplies, including pool/seeder positions, match the assigned controlled backing. Post-resolution accounting reconciles remaining payout obligations against remaining backing. A user's freely spendable verifier balance cannot simultaneously count as backing.
- Prices are in collateral units per share, between 0.01 and 0.99, tick 0.01. Yes price plus No price on a matched trade equals 1.00.
- Collateral is USDC and nothing else (decided 2026-10-19, section 6). A user may deposit any asset Intents supports and it is converted to USDC at the Intents edge, so the markets only ever hold USDC. The Intents token ID is in section 6. Withdrawals are in USDC, with the withdrawal fee and any swap fee paid by the user. Six-decimal micro-share sizing and a one-share minimum are proposed conventions, not permission to assume every supported token has six decimals.

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

Built today (2026-10-18): none of the draft, review or rejected states exist. market has no status field; the operator or owner calls create_market and the market is open for trading once seeded. Closed, proposed, disputed and final are tracked by time and by the oracle's case, not by a market state. The second-admin review is still the design for a regulated route, it is just not in code.

Required fields at creation: title, plain-language rule text, named resolution source (a specific URL or data source, not "reliable news"), close time, resolution deadline, category, tick size, fee category, and an explicit statement of what counts as Void.

4. Trading model

Two modes, because the first test has to be cheap.

Existing prototype: a constant-product pricing curve in market, with NEP-141 custody. The hackathon retains curve pricing and adapts settlement to controlled backing inside Intents. No order-book matcher is required for that slice; routing, transaction tracking and reconciliation still require services. Liquidity must be funded and confirmed before trading.

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
- Target fees are charged through authenticated settlement against funds inside Intents and assigned to the fee accounting domain there. They must be excluded from market backing. Atomicity or a recoverable multi-step sequence must be demonstrated; it is not assumed across asynchronous calls.

5. Money flow

NEAR Intents holds the tokens. Dragons Market records positions, liabilities, and settlement state tied to controlled balances inside the verifier. The concrete authorization mechanism is pending; the UI must not promise signature-free trading until the approved wallet/delegation flow exists.

Deposit: the user picks a supported chain/asset and sees a verified route, conversion if required, fees, minimums, expiry and refund destination. Tokens become available after confirmed verifier credit to the authenticated beneficiary. A provider API status or browser claim does not mint platform credit. 1Click is a routing candidate, subject to verifying its supported internal-balance modes; it is not assumed to be Degen Arena's provider. Native NEAR requires wrapping or a supported bridge path.

Trade: an authorized settlement operation commits funds to market-controlled escrow inside Intents before issuing the funded position. A read-only balance check or backend reservation cannot prevent the user from spending those funds elsewhere. Selling and final redemption release only the amounts owed, once, into available Intents funds.

Withdraw: the user authorizes a supported exit from available funds, never position backing or already-pending funds. Track requested, authorized, submitted, confirmed, failed, and refund/recovery states as applicable to the selected route. Destination-chain confirmation completes an external payout. A timeout is not proof of failure; reconcile before retrying or restoring a balance.

Promise: measured times for the supported Intents exit, distinguishing verifier release from external-chain arrival. A service-level maximum remains OPEN until measurements exist.

Escape hatch (required design, not yet demonstrated): specify user authorization and permissionless recovery so a dead backend cannot indefinitely block free-fund exits or finalized payouts. A free balance in a user-controlled Intents account and a claim on market escrow have different exit paths. Prove both, including expired orders if an order book is added later.

6. Collateral and custody

Collateral token (DECIDED 2026-10-19): native USDC issued by Circle on NEAR, contract 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1, 6 decimals. It is the only collateral. Chosen over USDT because, measured on 2026-10-19, DefiLlama shows 88.2M USDC against 39.4M USDT circulating on NEAR, and the Intents contract holds 4.53M USDC against 0.49M USDT. The USDT contract reports 525.9M total supply, which is unexplained and was not used. Users may deposit any asset Intents supports; it is converted to USDC at the Intents edge on deposit, and the contracts never see any other token. The Intents token ID for this USDC is nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 (6 decimals, blockchain near), read from the Intents 1Click token list on 2026-10-19. Fee rule (owner decision 2026-10-19): money always leaves as USDC, and the user pays the withdrawal fee and any swap fee. The user accepts this when they deposit or withdraw, and the platform shows it before they confirm. Still to verify, by measuring on mainnet: the real conversion cost and time, how a failed or partial conversion is refunded to the user, and whether Intents can withdraw straight into ft_transfer_call with the deposit message.

Custody location (ACCEPTED 2026-10-19): tokens remain in NEAR Intents across platform balances, market backing, bonds and fee/reward allocation until an authorized external exit. Dragons Market supplies the accounting and settlement rules. Staked Dragon NFTs and native NEAR for storage/gas remain separate.

Authorization and escrow (OPEN implementation): who controls each Intents account, which supported calls/signatures enforce escrow, how deposits bind to positions, and how failed operations recover. Intents custody is not itself a noncustodial guarantee. A regulated-intermediary route would require a separately approved change; it is not an interchangeable implemented provider today.

Whether a regulated exchange can hold this collateral at all is not answered by any source found (requirements.md).

7. Contract architecture (NEAR, Rust, near-sdk)

Logical modules for the long-term order-book design are below; the hackathon keeps the current four-contract/curve scope while changing settlement. A proposed module is not a deployed contract or finished ABI. The accepted custody requirements apply regardless of module packaging.

Registry (market factory). Creates markets, stores each market's rule hash, source, close time, deadline, fee category, state. Only the market's state machine from section 3 can move it.

Settlement/custody adapter (PROPOSED replacement for the separate Vault). Enforces authenticated transfers between free and market-controlled balances inside Intents, position issuance, backing allocation, payout release and operation recovery. No unrestricted backend `deposit_credit` method is assumed. Claude must specify account control, exact supported verifier calls, authorization, idempotency and callback/recovery rules before an ABI is published. A database lock is not verifier escrow.

Exchange. Settles trades.
  register_trade_key(key, expiry)
  revoke_trade_key(key)
  settle(batch of {order_a, order_b, fill_size, fill_price})
    For each pair: check the signatures against registered trade keys, check expiry and nonce, check price crossing, check the fee cap, check free balance, then mint, burn or swap shares as in section 2, and take the fee.
  cancel(order_id)
  The batch size is limited by NEAR gas per call. The limit is measured in testing, not guessed.

Shares (future order-book proposal). A separate transferable position token may be added later. The verifier's NEP-245 asset balances are not these Yes/No positions; current positions remain internal market accounting until deliberately changed.

Oracle. Resolution process in section 9.

Admin. As built (2026-10-18): the owner of market, oracle and council is governance, a contract of up to 5 members who propose, vote, wait out a timelock, then execute. It is not a multisig. market also has a separate operator key that can create and seed markets, halt and resume them, pause the contract and claim residuals, so routine work does not wait on a vote. The operator cannot redirect fees, change ownership or appoint a new operator; only governance can. There is no pause-only guardian key; the operator holds pause along with the routine powers.

Rules for all contracts:
- Emit NEP-297 events for every state change: market created, state changed, trade settled, deposit credited, withdrawal requested, withdrawal sent, outcome proposed, outcome challenged, outcome finalised.
- No unbounded loops over user data. Anything per-user is keyed and read one at a time.
- All amounts as unsigned integers, no floating point anywhere.
- Storage cost is paid by the user where a record is theirs (NEAR charges 1 NEAR per 100 KB of stored data, V). Orders are not stored on-chain in live mode, only nonces and balances.
- Upgrades only through the Admin timelock, and the old and new code hashes are published. Not true yet: governance controls calls made as the owner, not who can redeploy the code. Whoever holds a full-access key on a contract account can still replace the code outright. Before mainnet, delete those keys or hand them to governance (contracts/AUDIT.md, risk 2).

Existing implementation history: market combines market listing, NEP-141 custody, internal positions and a constant-product curve. Positions are not separate transferable NEP-245 tokens. Its bounded `get_history` log supports charts without a full indexer. The hackathon retains curve pricing while migrating token custody/settlement to Intents; it does not require throwing away the market for an order book. Safety rules and deadline behavior have changed through dated reviews, so use the latest contract code/manuals and `contracts/AUDIT.md` rather than assuming an earlier review summary is current.

8. Matching service (live mode)

One process, written in a language the team knows well (OPEN, Rust or TypeScript). Inputs: signed orders over an authenticated HTTP and WebSocket interface. State: the order book per market, held in memory and written to Postgres before any acknowledgement, so a crash cannot lose an accepted order.

Sequence for each future order: verify signature, expiry and nonce, reconcile free funds and contract-enforced Intents reservations, place or match, append to the log, acknowledge. Matched pairs enter the settlement queue. A cached balance or backend lock is not proof that the backing is reserved; actual settlement must enforce funding and single-use issuance.

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

Price feed, pull oracle (BUILT 2026-10-18 in oracle and market, except the publisher service, see the end of this block). Scoped to our own contracts reading our own feed. It is not a service offered to other NEAR projects: that would be a different and much bigger commitment (uptime promises, liability for someone else's loss) that this project does not need in order to resolve its own price markets.

How push and pull differ. A push oracle (classic Chainlink price feeds) needs a service writing fresh prices on-chain all the time, whether a contract needs them or not, which costs gas to keep data fresh that nobody may read. A pull oracle signs a price off-chain and only touches the chain when a contract needs it. That is RedStone's shape, and the one we build. We also copy RedStone's second idea: several independent signers must agree, not one.

1. The market names its exact answer rule. At creation a price market carries a price rule: an observation time, a strike, the decimals the price is scaled by, and a direction (Yes if the price is at or above the strike, or Yes if it is below). The rule text still states the exact source in words, for example "Binance BTCUSDT 1-minute candle close at 2026-12-31 00:00:00 UTC", or a named set of exchanges plus "median of their 1-minute closes". The rule is part of the hash locked when the market opens, so none of it can change. The observation time cannot be before close_at, because traders would then know the answer, and must be before resolve_by. A candle close is used rather than a single instant price because it is harder to move on a thin exchange.
2. Publishers compute exactly that, or refuse. Two or three publisher processes (three proposed) run on separate machines with separate keys. Each reads the sources the rule names. A publisher refuses to sign if fewer than the minimum number of sources answer, or if they disagree by more than a set percentage (both OPEN). Exchanges keep historical candles, so a publisher that was down at the observation time can still sign that price later. NOT BUILT: this off-chain service is the one part of the feed that does not exist yet.
3. The signed payload is bound to one market and one moment. The text a publisher signs is "price:v1:<oracle contract id>:<network>:<market id>:<observation time>:<price>:<decimals>". Everything except the price is fixed by the market and the deployment, so one signature is good for exactly one price of one market, on one network and one contract. A trader cannot collect signatures at several moments around the deadline and submit the one that favours them, and a testnet signature is no use on mainnet. The network is a deploy setting, because a contract cannot read it.
4. A threshold of signers must agree. The contract accepts a price only when at least k of the configured publishers (2 of 3 proposed, at most 10 publishers) signed the same price for the same market, checked on chain with ed25519. A submission lists each signer's key and signature. A malformed entry, a key that is not a publisher, a repeat, or a signature that does not verify refuses the whole submission. One leaked key alone cannot set a price. A submission with all 10 signing burns 4.5 TGas and works with 30 attached.
5. Anyone can submit it, with a bond. CHANGED from the first draft of this section, which said no bond. A bond is needed because jurors are paid from the losing side's bond (event resolution, step 6): with no bond from the submitter, a correctly overturned bad price would leave nothing to pay the jury, and the game between submitter and challenger would no longer be the same one every other answer plays. The bond is returned when the window passes unchallenged, so a keeper that runs the submissions only has its capital held for the window. The signed price becomes the proposed outcome of the normal process. A plain proposal is refused on a price market, so the signatures cannot be skipped.
6. The challenge window and the panel still apply, unchanged. A correctly signed price still sits through the window before it is final. This is the backstop if k publishers are ever compromised together or all read the same wrong source data: a challenge escalates to the jury exactly as a disputed event outcome does. The window for price markets can be shorter than for event markets (length OPEN). No new dispute machinery: the existing propose, challenge and panel path is reused. There is no staleness limit to set: each signature covers exactly one observation time, so age does not matter.
7. Fast to revoke, slow to trust. Adding a publisher key, and changing how many must sign, are owner actions, so a governance vote and its timelock. Removing a publisher key is an operator action that takes effect at once, so a leaked key can be cut off in one call. This is the split market already has. Removing a key can never leave fewer than k keys, which the contract refuses. A price market also cannot be registered until at least k publishers exist, so no market is created that nobody could answer, and its answer window is measured from its observation time.


Open: how many publishers and how many must sign at deploy, the minimum source count and the agreement percentage the publisher service uses, which exchanges are allowed as sources, and the price-market challenge window. Decided: the feed lives in oracle, which already holds the propose, challenge and panel logic it reuses. Not yet built: the publisher service, and a keeper that submits signed prices.

Event resolution process (PROPOSED):
1. At creation the rule text and the resolution source are hashed and the hash is stored on-chain. The text is public. It cannot change after the market opens.
2. After close time, anyone can propose an outcome (Yes, No or Void) with a link to evidence and a bond. Bond size is OPEN. For reference Polymarket's proposal bond is typically $750 in pUSD, not a fixed amount (docs.polymarket.com, checked 2026-10-18).
3. Challenge window. Default 2 hours (same as Polymarket, checked 2026-10-18). Test markets use minutes. If nobody challenges, the proposal becomes final and the proposer gets the bond back. A reward from fees on top was planned and is not built, and with the proposer bond returned in full it is not needed to make a proposal worth submitting.
4. If challenged, the challenger posts an equal bond and the market moves to disputed.
5. A jury decides. As built: after a short block delay anyone calls resolve_draw, and council draws the jury at random from staked NFT seats, excluding the proposer and the challenger. Jury size is set at deploy, odd, at most 21. Jurors commit a hash of their vote in the first half of the panel deadline and reveal it in the second half; majority of revealed votes wins. Jurors post no money bond, and a juror who never reveals simply is not counted. Deadline length is a deploy setting (48 hours PROPOSED for mainnet). A statement of no position in the market is still the design; it is not in code, and nothing on-chain can prove it.
6. The jury can choose Yes, No or Void. When a majority decides, the side whose answer the jury rejected is the loser, whichever outcome the jury chose, Void included. The loser's bond is split: a quarter goes equally to the jurors who revealed and sat with the final outcome, and the rest goes to the winner with the winner's own bond (BUILT 2026-10-18). If the jury does not decide, each side gets its own bond back and nobody is paid.
7. If the jury misses the deadline, or too few votes are revealed to form a majority, anyone can call finalize and the market goes Void.

Closed 2026-10-18: steps 5 to 7 used to combine badly with a flat Void payout. A quiet jury ended in Void, which paid a holder of the cheap side a windfall, and jurors lost nothing for staying silent. Void now pays the closing price (section 2), jurors are paid from the loser's bond, and a juror who never votes forfeits the revenue their seat earned while serving, which goes back to the pool (contracts/AUDIT.md, 2026-10-18). Two things follow from it. A juror who committed but had no chance to reveal because a majority settled the case first is not penalised. And the forfeit is small when revenue is small, so it is a weak stick on its own.

Every dispute, vote and reason is public.

The honest limit: a jury is a trust assumption. We are replacing token whales with seat holders drawn at random. It is better only if seats are spread widely enough that no one controls a jury. How jurors are paid is OPEN.

Council as an NFT collection (the owner's plan; nothing is minted or sold now). Revised 2026-10-09 after the owner's decision: the seats are also how the build is funded, and holders get a quarterly share of platform revenue. The council has human seats and AI agent seats. Everything below is PROPOSED unless marked built.

What is built today (2026-10-18, contracts/AUDIT.md): council holds staked NFTs as seats, draws a random jury per case from them, locks a drawn seat until its case is final, and pays revenue to staked seats. oracle runs commit-reveal votes. Also built: juror pay from the loser's bond and a forfeit of the revenue a silent juror's seat earned while serving. Not built: a money bond from jurors, a cap on seats per account, the conflict declaration, a market size cap, AI agent seats as a separate path, a two-stage vote, the evidence snapshot, and any enclave.

Funding and the law. Seats are sold to fund the build, and holders get a quarterly share of platform revenue. Buyers who pay money for a cut of someone else's profit is the shape most securities laws treat as an investment contract, so selling seats needs counsel before anything is minted (OPEN, same legal gate as section 17 phase 3). Until counsel says otherwise, no sale to US persons. The revenue share and the dispute pay are two separate things and stay separate in the contracts and in the marketing.

The honest limit of the revenue share. It does not stop a holder from betting on a market they judge, because a bet can come from another wallet and nothing on-chain links the two. It only aligns a holder if the quarterly cut is worth more than what rigging one market would win, and fees are capped by volume while one big market can hold more money than a seat earns in a quarter. So it is partial alignment, and the controls below carry the real weight.

Human seats, the controls against a bought verdict:
- Membership is custody, not an ownership check. An NFT becomes a seat by being sent into council with nft_transfer_call (NEP-171). The seat belongs to the previous owner of the token, not to whoever relayed it. Built.
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

Revenue split (owner decision 2026-10-15). Fees collect in a bucket that is not part of any market's collateral. A sweep, callable by anyone, sends 25% to the revenue-share pool and 75% to the business wallet (providers, domains and similar). The 25/75 split is a constant in market's code, so changing it means redeploying the contract. Which accounts receive the two shares is set by set_fee_recipients, which only governance can call (vote plus timelock). Only staked NFTs earn and only staked NFTs can be drawn for disputes. Unstaked NFTs earn nothing. Every staked seat has the same weight. Staking is by nft_transfer_call into the Council registry (see nft-council-research.md). Open: how often sweeps run, whether claims open each quarter or at any time, the unstake cooldown, and what a staked juror loses for not voting. Accrual stays continuous even if payout is quarterly, so staking just before a quarter closes does not capture the whole quarter.

Say what members do and what they earn before any mint, in plain words, with the revenue share and its risks stated.

Design decision, updated 2026-10-19: the venue uses the professional minimal studio direction, shared deep-purple surfaces in dark mode and a light counterpart. Council membership and public cases share one `/council` page, with mint accents in dark mode and forest green in light mode. The Council header, footer, backgrounds and controls use its complete green palette. Other routes retain the purple venue palette. `--brand` identifies generic venue controls, `--council` identifies membership/disputes/verdicts, and one labeled Yes/No pair is used across cards and charts. All headings, final verdicts and body copy use IBM Plex Sans consistently, with JetBrains Mono reserved for numeric details. The shared brand is Dragons Market, using the approved dragon shield crest in the header, footer and browser icon. The owner updated this direction after the review, superseding its serif and shared-purple-chassis recommendations. The canonical shipped palette is `web/design/palette.json`, generated into `web/app/palette.css` by `npm run tokens`. Earlier muted-violet, sage, cult and Zcash-art directions are superseded. The supplied technological Dragon artwork is a selection from the wider collection, not a supply declaration.

Under a regulated venue the exchange's own rulebook resolves contracts (requirements.md). In that case this process would be how the rulebook decides, and not a second authority. That depends on the licence route.

10. Data model (off-chain database, Postgres)

users: id, near_account (optional until identity design is fixed), kyc_status, region, created_at
wallet_links: user_id, wallet_chain, wallet_address, intents_account_id, verified_proof_ref, authorization_version, revoked_at
trade_keys: user_id, public_key, expiry, revoked_at
events: id, slug, title, category, created_at
markets: id, event_id, question, rule_text, rule_hash, source, state, close_at, resolve_by, tick_size, fee_category, outcome
orders: id, market_id, user_id, outcome, side, type, price, size, filled, status, nonce, expiry, signature, created_at
trades: id, market_id, taker_order_id, maker_order_id, price, size, fee, status, tx_hash, settled_at
positions: user_id, market_id, outcome, balance
balances (projection): intents_account_id, token_id, available, committed, pending_in, pending_out, observed_block, updated_at
backing (projection): market_id, escrow_account_id, token_id, confirmed_backing, outstanding_liability, settlement_ref, observed_block
operations: id, user_id, kind, provider_ref, idempotency_key, network, token_id, source_account, destination_account, amount, status, recovery_state, created_at, confirmed_at
operation_events: operation_id, network, tx_hash, receipt_id, event_index, account_id, token_id, observed_status (verified event identity unique)
deposits: operation_id, origin_chain, origin_asset, quote_id, deposit_address, expected_amount, received_amount, verifier_credit_ref, refund_address, expires_at
withdrawals: operation_id, dest_chain, dest_address, amount, route_ref, verifier_release_ref, destination_tx_hash, refund_ref
resolutions: market_id, proposer, evidence_url, proposed_outcome, bond, window_ends_at, challenger, challenge_bond, panel_votes, final_outcome, finalised_at
admin_log: id, admin, action, target, reason, created_at (append only)
alerts: id, market_id, user_id, rule, status, notes (for surveillance, section 14)

The verifier establishes token custody; Dragons Market contracts establish positions, backing obligations and outcomes. The database projects both and journals in-flight operations. Reconciliation compares each controlled balance to its liabilities without counting it twice. The schema above is a proposed migration; the early prototype SQL was moved out of this repo (see the archive note in section 19) and has not been migrated.

11. Interfaces

Public HTTP (read): list markets with filters, market detail including rule text, hash, source, state and dispute history, order book depth, trade history, price history, user portfolio, user open orders, fee preview for a proposed order, deposit quote, withdrawal status, withdrawal promise and measured recent times.

Public HTTP (write, authenticated by a signed message): place order, cancel order, register trade key, request deposit quote, request withdrawal.

WebSocket: price and book updates per market, user order and fill updates, resolution state changes.

Errors are explicit and listed in the interface, covering at least: invalid signature, expired order, bad tick size, insufficient free balance, market not open, region blocked, verification required, rate limited.

12. Website

Screens, in build order. The home page is market-first, like the incumbents: search and filter tabs, a featured market with a chart beside a trending list, and a grid of cards with the chance of Yes and Yes/No buy buttons. The whole site scales by screen width (phone to 4K TV) through a fluid root size and auto-fitting grids; see web/README.md and the canonical palette in web/design/palette.json.

Screens, in build order:
1. Market list: category filter, search, price chips, state labels.
2. Market page: question, plain rule text, source, close time, price chart, order book (live mode), trade ticket, dispute history, resolution status.
3. Trade ticket: buy or sell, limit or market, size, fee shown before confirming, error states for each reason in section 11.
4. Portfolio: positions, open orders, history, redeem button after final.
5. Deposit and withdraw: chain and asset picker, quote, status stepper, the published promise and recent measured times.
6. Resolution view: proposed outcome, evidence, countdown, challenge button with the bond, panel and votes.
7. Account: trade keys, verification status when required, region, limits.
8. Admin: create market, review queue, halt, propose and finalise, audit log.

The existing website uses @hot-labs/near-connect. The target also needs a verified link between connected wallet, Intents account and position owner; external-wallet support is pending that design. Every flow needs empty/loading/filled/error/blocked states. Local sandbox funding remains available for development, but it does not satisfy the hackathon's Intents funding/custody requirement.

13. Operations

Roles: operator (runs the matching service, no fund access), market admin (creates and approves markets, two people for approval), resolver (proposes outcomes), guardian (pause only), owner (multisig, upgrades). As built, the owner is governance (vote plus timelock) and market's operator key covers both the guardian's pause and routine market work; see section 7, Admin.

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

Target controls: authenticated funding/settlement bound to beneficiary, token, network, amount, expiry and operation identity; no unrestricted funds-moving operator key; governance timelock for approved changes; exposure caps; event-level idempotency; backing/liability reconciliation; and recoverable asynchronous transitions. Signed orders/trade keys and a public hash-chained order log remain future order-book work. Existing prototype upgrade/caller protections must be rechecked across the new Intents control boundary.

Testing: unit tests per contract, sandbox integration tests including time travel for challenge windows, property tests on the invariant under random trade sequences, a testnet soak with scripted users, then an external audit before any mainnet funds. Audit cost estimate $50K to $200K is a guess.

Launch limits: mainnet starts with a hard cap on total value locked and per-user deposits, raised in steps.

16. Infrastructure

See stack.md. Test: this machine, NEAR sandbox and testnet, free public RPC, local Postgres, mock oracle, local website. Live: redundant matcher, managed Postgres, paid RPC with a fallback, hosted indexer, keys in a hardware module, monitoring, CDN, audit.

17. Phases and what proves each is done

T. Pitch test. One combined contract, the small oracle with minute-long windows, a basic website, NEAR testnet then a few NEAR on mainnet with a few friends. Done when: create a market, trade it, resolve it through an unchallenged proposal, resolve another through a challenge and the panel, and redeem, all from the website, and the invariant holds throughout.

1. Future order-book build on play money, separately scoped after the current curve/Intents slice: Registry, settlement adapter, Exchange, Shares, Oracle, matching service, indexer, website and admin. Fake collateral. Done when: a scripted test of at least 100 users and 10,000 orders passes with the invariant intact and the reconciliation job clean, an unplugged matching service does not lose any accepted order, and the escape hatch works on testnet.

2. Intents custody migration (core current work, alongside the curve-market demo rather than after a new order book). Done when: supported cross-chain funding, controlled backing inside Intents, funded positions, resolution/redemption, fee/reward attribution and a verified external exit reconcile end to end. The initial hackathon target is at least one external origin and one external destination; broader three-chain coverage and latency promises follow measured routes. See `hackathon-plan.md`.

3. Legal gate. Choose a licence route with counsel and set the compliance hooks accordingly. Intents custody is the accepted technical target; any legally required replacement needs a new owner decision. This document does not approve a public real-money launch.

4. Limited live. Hard caps, selected users, audit complete, bug bounty open.

5. Open launch. Caps raised in stages.

Later, in order of my preference: multi-outcome markets, maker rebates and liquidity rewards, a public API for builders, perps (a separate regulated product, not started), mobile.

18. Open decisions

- Custody location decided 2026-10-19: NEAR Intents. Account control, escrow enforcement, identity mapping and migration remain open implementation work; see section 6 and intents-architecture.md.
- Collateral token decided 2026-10-19: native USDC, section 6. The deposit conversion path is still open work.
- Curve for test mode, section 4. Decided: constant-product (market/src/curve.rs).
- Fee rates and maker rebate, section 4. Fee shape decided (rate x shares x p x (1 - p), rate 2%, flat creation fee). The final rate, the creation fee amount and any maker rebate are open.
- Bond sizes and window lengths, section 9. Jury selection is decided: random draw from staked seats.
- Juror pay and the Void payout: decided and built 2026-10-18, see sections 2 and 9.
- Price oracle for price markets, section 9. Decided: our own pull feed. n, k, sources and the price-market window are open.
- Matching service language and any second signer or trusted execution environment, section 8.
- Licence route and the countries served. Needs counsel.
- Council NFT design, section 9: legal route for the seat sale and revenue share, seat price versus bond versus market cap, identity or cap per buyer, agent and human split, enclave choice, and when (if ever) to mint.
- Which categories to list first. Sports contracts carry the most regulatory exposure (V, MoFo). A narrow start such as crypto and economics questions is my lean.
- Languages for the website.
- Product name and brand decided: Dragons Market, professional minimal studio direction with light/dark themes.

19. What was not verified when this was written

Any primary-source licence cost. Whether RedStone is live on NEAR: its NEAR connector exists on GitHub and is pull-model, but its NEAR docs page returned 404 and no release date was found (checked 2026-10-18); moot now that we build our own feed. Chainlink: no NEAR network in Chainlink's data feed docs (checked 2026-10-18); the 2020 NEAR blog post was a TestNet announcement. Real Intents payout times and limits. Pricing for Neardata and Goldsky. Whether another prediction market exists on NEAR: answered 2026-10-15, yes, Noa Market (competitor-noa-market.md in the research archive). The June 2026 CFTC proposed rule text. Every cost estimate here is a guess unless marked otherwise.

Archive note (2026-10-19): the early research and prototype files (recon, requirements, feedback and reviews, competitor notes, the first schema and design tokens, and the palette mockups) were moved out of this repo to ~/Nameless/NEAR/PredictionMarket-archive. They are still in git history at commit 4c21fec on origin.

20. Contract change plan

Written 2026-10-18 from a full read of market, oracle, council and governance against this spec. This is the work list for the build pass. STATUS 2026-10-18: R1 to R6 and D1 to D7 are built and verified, see contracts/AUDIT.md for what was built, how each was checked and what changed from this plan. D8 is not built, waiting on the planned collection size. Deviations from the plan: the submitter of a signed price posts the usual bond (D2); a jury that decides Void by majority now makes the proposer of another answer the loser, and a timeout no longer pays a proposer who proposed Void (D1); council gained a read-only jury_of view for the keeper (R6). Still not built anywhere: the publisher service that signs prices, a keeper that submits them, an outside audit, and everything in sections 7 to 11 beyond the single-curve contract. Each item names the contract, the change, why, and the test that proves it. READY means it can be built as written. DECIDE means the owner has to choose first; the recommendation is given. Rules for whoever builds it: one item at a time, unit test plus sandbox test for each, break the change on purpose and confirm the test catches it, rerun the full suite and clippy, and add a dated section to contracts/AUDIT.md. No mainnet deploy is part of this plan.

READY

R1. oracle: refuse markets whose deadlines can never be met. Today create_market only checks resolve_by > close_at. If the gap is shorter than the challenge window plus the panel deadline plus APPLY_BUFFER_NS, propose() refuses every answer and the market can only end in Void at its deadline. A careless or hostile operator could create markets that are sure to Void, which pays the cheap side a windfall (section 9, known gap). Change: register_market panics unless resolve_by - close_at >= window + panel deadline + APPLY_BUFFER_NS + a minimum proposal period (new deploy setting). market already keeps a market untradable until registration succeeds, so a refused registration means the market never opens. Test: a market created with too short a gap never registers and cannot be traded; one at exactly the minimum registers.

R2. oracle: let anyone retry releasing a jury. settle() calls council.unlock_case once and nothing retries it if it fails, so those seats stay locked forever (contracts/AUDIT.md, slice 2). Change: add retry_unlock(market_id), callable by anyone, only for a Final case that was disputed. unlock_case is already safe to call twice. Test: after a dispute settles, retry_unlock works and leaves seats unstakable; on a case that is not final it is refused.

R3. council: a seat that asked to unstake cannot be drawn. Today draw() only skips seats already serving, so someone on their way out can still judge a case. Change: skip stakes with unlock_requested_at set. Test: request an unstake, draw, the seat is never picked; a draw with too few remaining seats fails as it does today.

R4. council: the unstake cooldown becomes a deploy setting. Today it is a 60 second constant. Change: cooldown_ns is a constructor argument, and the owner (governance) can change it later. It must be at least the oracle's challenge window plus panel deadline, so a seat cannot be staked, drawn and gone inside one case; document that in the comment, the council does not know the oracle's settings. Test: unstake before the configured cooldown is refused, after it works.

R5. governance: approved proposals expire if nobody executes them. Today an approved proposal stays executable forever, and execute() is open to anyone, so an old approval can be fired months later at a bad moment. Change: new setting execution_window_ns (constructor argument, changeable through its own action like the timelock). After approved_at + timelock + execution_window the proposal reads as Expired and execute() refuses it. Test: execute inside the window works, one nanosecond after it is refused.

R6. Operations, no contract change: a keeper. resolve_draw, finalize and retry_apply all depend on someone calling them in time. If nobody calls resolve_draw before the commit phase ends, the dispute goes Void. Build a small script that watches open cases and calls each one when due. Also check at deploy that the council has at least jury_size different seat holders; with fewer, every draw fails and every dispute ends Void.

DECIDE

D1. The Void and juror gap (section 9, under step 7). This is the most important open item before real money. Three changes, each buildable on its own:
- D1a market: Void pays a closing price, not a flat half. Recommended: the time-weighted average of the market's last price points before close (the history is already stored), not the single last price, because the last price can be pushed by one large buy just before close. A Yes share pays p, a No share 1 - p, and a full pair still pays exactly 1, so the books stay solvent (owed = locked - 2 x pool_yes x pool_no / (pool_yes + pool_no) for the last-price version, which is never more than locked). Choose: last price or average, and over how many points.
- D1b oracle: pay jurors. Recommended: the loser's bond is split, a share to the jurors who revealed and sat with the majority, the rest to the winner. Choose the share (25% proposed).
- D1c council plus oracle: a drawn juror who never reveals loses something. Recommended: the revenue that seat earned while serving on that case goes back to the pool for the other seats. No money bond is needed for this. Choose this or a ban from the next draws.

D2. oracle: the pull price feed in section 9. Choose where it lives. Recommended: new methods on oracle, because it reuses the propose, challenge and panel code as it is. oracle then also needs an operator account for the fast revoke, the same pattern as market. n, k, the staleness rules and the price-market window can be deploy settings, so they do not block the build.

D3. market: where the leftover goes after a market resolves. claim_residual credits the owner, which is now governance, a contract with no easy way to spend a token balance held inside market. The seed money came from the operator. Recommended: credit the business wallet.

D4. market: fees governance can change, with hard caps. The 2% rate and the creation fee are constants. Recommended: setters that only governance can call, with a ceiling written in code (for example 5% and a fixed maximum creation fee) so even a captured governance cannot set a confiscatory fee. Choose the caps.

D5. council: a cap on seats per account. seats_of already counts them, so the check is one line in nft_on_transfer. Choose the number. It does not stop one person with many wallets (section 9), it only raises the cost.

D6. governance: a way to cancel an approved proposal during its timelock. Today the timelock only lets outsiders see a change coming; the members cannot stop it. Recommended: a cancel that needs threshold member votes. Honest limit: if the members who approved it are the problem, they will not cancel it; this is for mistakes, not for a captured majority.

D7. market: seed at a chosen starting price. Every market opens at 50% because the seed is split evenly. For a lopsided question, early traders take money from the seed until the price is right, and that loss falls on whoever seeded. Recommended: create or seed takes a starting probability. Lower priority than D1 to D6.

D8 (NOT BUILT, waiting on an answer). council: more than 1,000 seats. The draw reads every seat, which costs about 190 to 210 TGas at 1,000 and is why MAX_SEATS is 1,000. If the collection will be bigger, the draw has to pick random positions directly instead of reading every seat. Only needed if the collection is over 1,000; say the planned size.

Order once decided: R1 to R5 first (small, no decisions), then D1, then D2, then the rest.

21. Contract fixes from the 2026-10-19 outside review

STATUS: Phase 1 built and verified, 2026-10-19. Phase 2 built and verified, 2026-10-19. Phase 3 built and verified, 2026-10-19. Phase 4 built and verified, 2026-10-19.

Written 2026-10-19. An outside review of commit 4c21fec (contract-and-website-review-2026-10-19.md) filed 21 contract findings, C-01 to C-21, and 9 notes, I-01 to I-09. The owner ordered every contract finding fixed. The website items W-01 to W-16 and the palette notes are separate work and are not in this section. The finding ids below are the review's. Nothing is deployed, so every state layout change is free now and none needs a migration. Rules for the build are the ones in section 20: one item at a time, a unit test plus a sandbox test for each, break the change on purpose and confirm the test fails, rerun every suite, and add a dated section to contracts/AUDIT.md. Where the review offered two options, the choice made here is named.

Phase 1. The oracle, the council and the market, which share one state layout (build together).

F1 (C-02, R1 to R4 of the review). Disputes always reach a decision, and a stalled jury is no longer free. The challenge names its answer: challenge:<market>:<yes|no|void>, which must differ from the proposal. Jurors may vote only for the proposed answer or the challenger's answer, so with an odd panel and full turnout a majority always exists. If the first panel does not decide by its deadline, one second round draws min(2n+1, 21) jurors, excluding the first panel, the proposer and the challenger, with fresh deadlines. If the second round also fails, the proposer's bond goes back and the challenger's bond goes half to the jurors who revealed (split equally) and half to the proposer. A price market whose dispute never decides keeps the signed price as its answer. An event market in that case resolves Void. Jurors who never voted forfeit as today. The minimum gap between close and resolve_by counts both rounds. Test: a challenge naming the proposed answer is refused; a vote for a third outcome is refused; a no-decision escalates exactly once to a larger, disjoint jury; a second no-decision pays as stated; a self-challenging pair of accounts ends down by at least the juror share whatever the jury does; a proptest shows a full binary ballot always settles.

F2 (C-06 and C-14). The juror clock starts at the draw, and the jury size is fixed per case. A challenge sets a draw_by deadline (a new setting, draw_window_ns). resolve_draw is allowed until draw_by. When the jury is seated, commit_ends_at and panel_deadline are set from that moment. A case never drawn by draw_by counts as a no-decision for F1. The case stores jury_size at challenge time, passes it to the council, and on_drawn compares against it, so a later set_jury_size touches only new cases. The minimum gap counts the draw window. Test: a jury drawn at the last allowed moment still gets the full commit period; no juror is marked delinquent for time they never had; a size change between draw and on_drawn does not strand the case.

F3 (C-05). council.draw reads the block seed itself and no longer takes a seed argument, so the seed is unknown until the seat list is fixed in the same receipt. The cached jury on retry stays. oracle stops passing a seed. Test: the draw depends only on the block seed, the seat set and the case key; two draws in flight still end with one jury.

F4 (C-03). The oracle owns the deadline answer. A new oracle method resolve_by_deadline(market_id), callable by anyone once resolve_by has passed, settles what is settleable (finalizes a proposed case whose window ended or a disputed case past its deadline, or re-applies a final unapplied case) and otherwise resolves the market Void. market.void_if_unresolved is kept as an emergency path for a dead oracle and is refused until resolve_by plus a 7 day grace period. The keeper calls resolve_by_deadline. Test: with a settleable unchallenged case after resolve_by, void_if_unresolved is refused and resolve_by_deadline applies Yes; with no case it voids; after the grace period the emergency path works.

F5 (C-07). Council revenue streams. Every revenue arrival and every juror forfeit tops up a stream that releases at a constant rate over 30 days (a constant), so a seat earns in proportion to the time it was staked and a one block stake earns a one block share. The waiting pool goes away. Time with no seats stretches the end of the stream instead of losing revenue. pending_reward includes the part not yet accrued. Test: a seat staked one block before a large arrival earns about one block of 30 days; equal time earns equally whatever the arrival time; the conservation proptest passes in the streamed model.

F6 (C-16). The closing price counts only trading time. The average keeps a weight accumulator beside the price accumulator and stops both while the market is halted. halt and resume advance the average to the present before flipping the flag. Test: halting right after a pump does not pin the average at the pumped price; a market with no trading time in the window falls back to the last price.

F7 (C-04, C-08, I-08, I-09). market buy and sell, and oracle commit_vote and reveal_vote, require exactly 1 yoctoNEAR. redeem stays open. The operator and the owner are exempt from the 20 position cap (option A of the review, the smaller change); the seeder's leftover shares of a skewed seed no longer fill the cap. resume refuses a market that already has an outcome. seed refuses a market past its close_at. Test: each of those calls refuses a call with no deposit and a function-call key cannot call them; 25 skewed seeds from the operator all succeed; a seed after close is refused.

Phase 2. Upgrade path (C-01).

F8. Every contract (market, oracle, council, governance) gets: state_version as the first field of its state struct; stage_code (anyone, pays for the storage, stores the wasm keyed by its own sha256); upgrade(code_hash) (owner only, reads the staged code and removes it, then deploys it and calls migrate in one batch so a panicking migrate reverts the deploy); migrate (private, ignore_state, reads exactly the prior state shape and panics on anything else, and sets upgrade_proven); seal(public_key) (owner only, refused until upgrade_proven, deletes that access key from the account). Governance gets an action upgrade_self(code_hash) through the same vote and timelock, and an upgrade proposal needs only the 32 byte hash so MAX_ARGS is no obstacle. oracle gets owner setters for bond, window_ns, panel_deadline_ns, min_proposal_ns, draw_window_ns and draw_delay_blocks. A market keeps the windows it was registered with (stored at registration, like its rule hash), so a longer window can never make an already registered market unanswerable. A new bond applies to new cases only. Governance already forbids a call to itself and keeps forbidding it. The upgrade timelock is the users' exit window, so withdraw and redeem stay unpausable. Test: a non-owner upgrade is refused; an unknown hash is refused; too little deposit on stage_code is refused; seal before upgrade_proven is refused; a sandbox upgrade to a staged build keeps all state; an upgrade to a wasm with no migrate leaves the old code in place; after seal the account has no access keys.

Phase 3. Hardening.

F9 (C-12). Every #[init] new is also #[private], so only the contract account (a deploy-and-init batch) can call it.

F10 (C-10). market implements NEP-145 (storage_deposit with account_id and registration_only, storage_withdraw, storage_unregister, storage_balance_bounds, storage_balance_of) on the flat 0.05 NEAR model. A third party can register a user. Unregister needs no positions and no balance and refunds the deposit to the account.

F11 (C-09). council accepts only token ids on an owner-set allowlist while the allowlist is on. Owner methods: allow_tokens(ids) in batches, set_allowlist_enabled(bool). The deployment checklist requires the collection to have a fixed supply, minting closed and a published code hash.

F12 (C-13). market on_revenue_sent treats a failed ft_transfer_call result as unknown, not as refunded. The amount moves to a revenue_unresolved counter that the owner reconciles, and council gets a total_received view to compare against. Test with a token whose ft_resolve_transfer fails.

F13 (C-15, C-18, C-20). governance refuses call gas outside 5 to 250 TGas at propose and at execute, and the proposal view shows the gas to attach (call gas plus 14 TGas). Methods with a known gas floor (reveal_vote and finalize 60 TGas, resolve_draw 270, sweep_fees 91, unstake 54, claim 29) refuse early with a message that names the amount to attach. verified_signers returns the signer keys and the proposed event for a price answer lists them.

F14 (C-17). keeper check reports, for each of the four accounts, balance minus the storage cost of its usage, and warns under a margin. The deployment checklist names the funding.

Phase 4. Tooling and records.

F15 (C-11, C-21). Every contract Cargo.toml gets repository and the NEP-330 reproducible build section with a pinned image; build.sh gains a reproducible mode; rust-toolchain.toml pins the toolchain; the contracts declare the standards they implement. The code is formatted once with rustfmt (rustfmt.toml, max_width 120). A GitHub workflow runs fmt, clippy with warnings as errors, the four unit suites, build.sh plus the sandbox suite, and the keeper tests.

F16 (C-19). The keeper reads its secret key from an environment variable or a file with mode 0600, never the command line; it supports function-call keys scoped per receiver; it skips markets already resolved and applied; it calls resolve_by_deadline and, once those exist, sweep_fees and signed price submission is left to the publisher service.

F17 (I-01 to I-07). Documented, not coded: the seat cap does not stop juror capture (wallets are not people), early settlement rewards early reveal, jurors need a strong random salt and a backup, a fixed bond cannot scale with market size (use the market cap instead), the seed is a subsidy, positions are not transferable. Each goes into the matching contracts/pm-*.md and contracts/AUDIT.md.

Parameters (not code, for the deployment): jury 11 at launch and 21 later, challenge window 2 hours for events and 30 to 60 minutes for prices, commit and reveal 24 hours each from the draw, draw window 2 hours, draw delay 3 to 5 blocks, code upgrade timelock at least 72 hours, governance threshold at least 3 of 5, seat cap 5 per account. These are starting values for the owner to argue with.

Order: Phase 1, then 2, then 3, then 4, with the full suites and a dated AUDIT.md section after each. Every contracts/pm-*.md is updated in the same change that changes the behaviour it describes.

Status, 2026-10-20: the findings of the second outside review (N-01 to N-10) are recorded with their fixes and open items in contracts/AUDIT.md, section "Second review fixes, 2026-10-20".
