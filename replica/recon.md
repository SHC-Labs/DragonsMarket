# Recon map: Polymarket + Kalshi (web, API-first)

Scope: a binary event-contract market (buy Yes/No shares, redeem $1 or $0 at resolution), deposits from any chain via NEAR Intents, settlement on NEAR. Reference venues: Polymarket (crypto, Polygon) and Kalshi (CFTC DCM).
For: the user's own possible business, to be run fully legal. This is a feasibility recon, not a build order.
Date: 2026-10-08

Confidence key: V = read this session from the cited source. M = from memory, not checked. I = inferred.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | Polymarket docs index | https://docs.polymarket.com/llms.txt | full page list read, 6 core pages read (V) |
| 2 | Polymarket order lifecycle | https://docs.polymarket.com/concepts/order-lifecycle.md | V |
| 3 | Polymarket resolution | https://docs.polymarket.com/concepts/resolution.md | V |
| 4 | Polymarket positions and tokens | https://docs.polymarket.com/concepts/positions-tokens.md | V |
| 5 | Polymarket fees | https://docs.polymarket.com/trading/fees.md | V |
| 6 | Polymarket builder program | https://docs.polymarket.com/programs/builders/overview.md | V, tier details not read |
| 7 | Polymarket bridge assets | https://docs.polymarket.com/trading/bridge/supported-assets.md | V |
| 8 | Kalshi API docs | https://docs.kalshi.com/welcome | V, overview only. REST, WebSocket, FIX, demo env, Developer Agreement |
| 9 | Kalshi GitHub org | https://github.com/Kalshi | V. 3 repos: starter code (Python), notebooks, stable.co. No product code |
| 10 | Kalshi rulebook | https://kalshi.com/regulatory/rulebook | NOT READ, returned HTTP 429 |
| 11 | WilmerHale: CFTC event contract entry paths | https://www.wilmerhale.com/en/insights/client-alerts/20260415-want-to-get-into-cftc-regulated-event-contract-markets-heres-how-it-works | V. No dollar figures in it |
| 12 | MoFo: CFTC advisory + ANPRM | https://www.mofo.com/resources/insights/260316-cftc-issues-notable-prediction-markets-advisory | V |
| 13 | CFTC NPRM June 2026 (Rule 40.11) | https://www.federalregister.gov/documents/2026/06/12/2026-11854/prediction-markets-public-interest-determinations | seen in search only, NOT READ |
| 14 | NEAR Intents docs | https://docs.near-intents.org | via local RAR notes, not re-fetched |
| 15 | Kalshi help center, app store, pricing | | NOT DONE. No screenshots captured, screens below are inferred |

Not used: either venue's user account. No logins, no scraping.

## Core loop

A user deposits money, buys Yes or No shares on a question at a price between 0 and 1, and each winning share redeems for $1 when the question resolves.

## Screens (inferred from docs and API shape, no screenshots)

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Market discovery | / | browse and search events by category | category tabs, event cards, price chips, search | empty search, loading |
| S02 | Event page | /event/:slug | one event, one or many markets | chart, outcome list, order book, trade ticket, rules text, comments | resolved, closed, halted, live |
| S03 | Trade ticket | panel on S02 | buy or sell Yes/No, market or limit | side toggle, price, size, fee preview, submit | insufficient funds, tick-size error, geoblocked |
| S04 | Order book | tab on S02 | depth and spread | bid and ask ladder | thin book |
| S05 | Portfolio | /portfolio | open positions, P&L, open orders, history | position rows, cancel button | empty, filled |
| S06 | Deposit | modal | fund from any chain | chain picker, asset picker, quote, address or QR, status | pending, failed, below minimum |
| S07 | Withdraw | modal | send out to any chain | chain, address, amount, fee | pending, failed |
| S08 | Account and compliance | /settings | identity check, limits, region, notifications | KYC form, status badge | unverified, verified, restricted |
| S09 | Market resolution view | on S02 | proposal, dispute window, outcome | status stepper, evidence links | proposed, disputed, final |
| S10 | Leaderboard and profile | /profile/:id | public activity | stats, positions | private |
| S11 | Liquidity and maker view | /rewards | maker rebates and rewards | rewards table | none |
| S12 | Admin: market creation and resolution | internal | list, edit, halt, resolve | forms, audit log | draft, live |
| S13 | Surveillance console | internal | manipulation and insider alerts | alert queue, case notes | clear, flagged |
| S14 | Builder or API keys | /api | keys, rate limits | key list | none |

Confidence: S01 to S08 M/I (standard for the category), S09 V (resolution docs), S12 and S13 I (required by core principles, not seen).

## Flows

```
F01 Deposit from any chain
    S06 -> pick chain and asset -> quote -> send -> wait -> balance credited
    happy path clicks: 5
    edge: below minimum (Polymarket: $2 most chains, $7 Ethereum, $9 Bitcoin and Tron), wrong-chain send,
          quote expires, deposit arrives but credit lags, refund path

F02 Buy a position
    S01 -> S02 -> S03 -> confirm -> S05
    happy path clicks: 4
    edge: price moves, partial fill, order rests on book, geoblock, not verified, market closed mid-order

F03 Exit before resolution
    S05 -> S03 (sell) -> or merge a full Yes+No set back to collateral
    happy path clicks: 3
    edge: no bid depth, order rejected at tick size

F04 Market resolves and pays
    S09 -> proposal -> 2h challenge window -> final -> redeem in S05
    undisputed ~2h, disputed 4 to 6 days (Polymarket, V)
    edge: dispute, double dispute escalates to token vote, ambiguous question text, void or 50/50 split

F05 Withdraw to any chain
    S05 -> S07 -> chain, address -> confirm -> status
    happy path clicks: 5
    edge: unsupported chain, address-format mismatch, withdraw while positions are open

F06 Create and list a market (operator)
    S12 -> write question and rules -> set resolution source -> review -> publish
    edge: unlistable under regulator rules, duplicate market, bad source

F07 Surveillance case
    S13 -> alert -> review -> halt or refer
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Price chip (Yes 62c / No 38c) | compact, large | live, stale, halted | S01, S02, S05 |
| Probability chart | line, candles | loading, empty, resolved | S02 |
| Order book ladder | depth, flat | thin, crossed | S04 |
| Trade ticket | buy, sell, market, limit | disabled, error, submitting | S03 |
| Fee preview line | taker, maker | zero fee (Polymarket geopolitics) | S03 |
| Position row | open, resolved, redeemable | profit, loss | S05 |
| Chain and asset picker | list with min deposit | unsupported, below minimum | S06, S07 |
| Status stepper | deposit, resolution | pending, done, failed | S06, S09 |
| Geoblock and KYC gate | banner, full-page | blocked, pending, cleared | all trading |
| Rules text block | collapsible | final, amended | S02 |

## Inferred data model

```
Event       id, slug, title, category, status, close_at, rules_text, resolution_source
            evidence: Polymarket Markets and Events, Kalshi API   confidence: high

Market      id, event_id, question, outcomes[2], tick_size, status (open|closed|proposed|disputed|final|void),
            neg_risk_group_id nullable
            evidence: Polymarket negative-risk and positions pages   confidence: high

Order       id, market_id, user_id, side, type (GTC|GTD|FOK|FAK), price, size, status, signature, created_at
            evidence: Polymarket order lifecycle (V)   confidence: high

Trade       id, market_id, maker_order_id, taker_order_id, price, size, fee, status (MATCHED|MINED|CONFIRMED|FAILED)
            evidence: Polymarket order lifecycle (V)   confidence: high

Position    user_id, market_id, outcome, balance (ERC-1155 style on Polymarket)
            evidence: Polymarket positions and tokens (V)   confidence: high

Collateral  user_id, balance, currency (pUSD on Polymarket, USD on Kalshi)
            evidence: both docs   confidence: high

Resolution  market_id, proposer, bond (750 pUSD on Polymarket), proposed_outcome, challenge_ends_at,
            disputes[], final_outcome
            evidence: Polymarket resolution (V)   confidence: high

Deposit     id, user_id, origin_chain, origin_asset, quote_id, deposit_address, status, credited_at
Withdrawal  id, user_id, dest_chain, dest_address, status
            evidence: Polymarket bridge (V), NEAR Intents 1Click quote shape (RAR)   confidence: medium

KycRecord   user_id, status, region, limits   confidence: guess (regulated path requires it, shape unseen)
Alert       id, market_id, user_id, rule, status   confidence: guess (required by DCM core principles, I)
```

Relationships: Event 1-n Market, Market 1-n Order, Order 1-n Trade, User 1-n Position, Market 1-1 Resolution, User 1-n Deposit.

## Feature matrix

See `features.csv`.

## Out of scope (cannot or should not be cloned)

- The licence. Kalshi's DCM status and Polymarket's QCX DCM (bought for $112M per press, M) are the product. Code does not copy them.
- The liquidity. An empty order book is a dead product. Both incumbents have market makers under programs you would have to fund.
- The oracle network. UMA token-holder voting is a third-party dependency, not something to rebuild.
- Kalshi's contract catalogue, listings agreements with sports leagues and data licences.
- Perps (margin, funding, liquidations). A different regulated product, left out.

## Size

Screens 14, flows 7, entities 11. Hard parts: (1) the regulatory structure, (2) cold-start liquidity, (3) custody and settlement design on NEAR including the Intents deposit leg, (4) resolution and dispute policy, (5) surveillance. Engineering size: L for the product with fake money. XL once the licence path is included, and that part is not an engineering size at all. See `requirements.md`.
