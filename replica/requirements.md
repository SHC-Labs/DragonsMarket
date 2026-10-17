# What a fully legal prediction market on NEAR needs

Date: 2026-10-08. This is a map, not legal advice. Every row says whether it was read this session (V), is from memory (M), or is inferred (I). The first job of a real engagement is a securities/derivatives lawyer confirming every I and M row.

## The shape of the problem

Offering Yes/No event contracts to the public is offering a derivative. In the US the CFTC treats it as a swap or futures contract. That means a registered exchange, and the registration is the product, not a feature of it (V, WilmerHale, MoFo).

Three facts decide everything else:

1. Incumbents hold the licence. Kalshi is a CFTC designated contract market (DCM). Polymarket bought one: QCEX for $112M in July 2025, now QCX LLC (M, press via search). Polymarket's main offshore exchange has barred US users since a 2022 settlement, and filed in April 2026 to let US users onto it (M). A new CFTC investigation was reported in June 2026 (M).
2. The rules are moving. The CFTC published a proposed rule in June 2026 on which event contracts are against public policy (Rule 40.11, M, not read). Sports and gaming-type contracts are the contested edge.
3. States are fighting it. The CFTC claims exclusive jurisdiction. State gambling regulators disagree, and the MoFo piece says so directly (V).

## Paths to market, ranked by what a small team can actually do

| path | what it means | verified facts | verdict |
| --- | --- | --- | --- |
| A. Build on top of a licensed venue | Front end, analytics or routing on Kalshi or Polymarket US. You never run the exchange. | Kalshi has a public API and a Developer Agreement (V). Polymarket has a Builder Program with order attribution and gasless relaying (V). Kalshi already accepts NEAR deposits (M, search). | Only path that is legal today without a licence. Fee share and terms not read. |
| B. Introducing broker (IB) | Register with the NFA, refer customers to a DCM or FCM. Does not hold funds or execute trades. | NFA registration, Form 7-R, associated persons need swap proficiency (V). No cost figures in the source. | Plausible. Needs a DCM willing to take you as an introducing party. Not checked. |
| C. Futures commission merchant (FCM) | Hold customer funds and clear trades. | NFA registration, segregated funds, net capital rules (V). Amounts not in the source. | Heavy. Capital requirement unknown. |
| D. Own DCM (plus DCO) | Your own regulated exchange. | Form DCM, 23 core principles, 180-day review starting only once the file is "materially complete" (V). Often paired with a clearing registration (V). | The real answer for "own the venue". Dollar cost, staffing and surveillance spend: not in any source I read. |
| E. Swap execution facility | Cheaper registration, 15 core principles. | Trading limited to eligible contract participants, so no retail (V). | Kills the retail model. |
| F. Buy a DCM | What Polymarket did. | $112M (M). | Out of reach without capital, but it sets the price of the shortcut. |
| G. Offshore, no US users | Skip the CFTC, geoblock the US. | Polymarket did exactly this from 2022 (M). | Not "fully legal". It is legal only where each country allows it, and each country is its own licence question. Not researched. |

## What path D actually requires (the "own exchange" case)

Read this as the checklist the licence lawyer would start from. Items marked V come from the sources above. Everything about NEAR is inferred.

- Form DCM filing and a rulebook that satisfies the 23 core principles (V).
- Real-time monitoring of all trading for manipulation and disruption (V).
- Only list contracts not readily susceptible to manipulation (V).
- For sports contracts, information-sharing arrangements with integrity monitors (V).
- Clearing: a registered clearing organisation, either yours or a partner (V that it is usually paired).
- Customer funds: segregation rules apply to FCMs (V). Whether USDC or a NEAR-native stablecoin can be held as collateral at a DCM or DCO is a question I could not answer from these sources (I).
- Compliance officer, surveillance staff, default and disaster recovery plans. These are core-principle duties (M).
- Money transmission: taking deposits from 35+ chains and sending value out is likely money transmission, with FinCEN MSB registration and state licences if US persons are involved (M, I).
- AML and KYC on every user. The Intents leg makes this harder, because a deposit address does not tell you who sent the funds (I).
- Sanctions screening on every deposit and withdrawal (M).

## NEAR-specific design questions the licence forces

These are the places where "on NEAR" and "legal" pull against each other. I would not resolve any of them without counsel.

1. **Custody.** Polymarket is non-custodial in the sense that the user signs EIP-712 orders and a contract settles (V). A US DCM generally needs customer money held by a regulated intermediary. Those two models do not obviously fit together. Decide this first.
2. **Intents as the funding rail.** NEAR Intents covers 35+ chains and about $6B in all-time volume as of early 2026 (RAR notes, M). But Polymarket's bridge already accepts Ethereum, Polygon, Arbitrum, Base, Optimism, BNB, Solana, Bitcoin, Tron and more (V). Kalshi takes NEAR (M). So multi-chain deposit is table stakes in 2026, not a differentiator.
3. **Settlement asset.** Polymarket uses its own pUSD on Polygon (V). A NEAR venue needs a collateral token and an answer to who issues and redeems it. A stablecoin issuer has its own licensing question (I).
4. **Resolution.** Polymarket resolves through the UMA optimistic oracle with a 2 hour window and a $750 bond (V). A DCM resolves under its own rulebook (V, core principles). You cannot use a decentralised oracle and also be a regulated exchange without the rulebook saying so (I).
5. **Order matching.** Polymarket matches off-chain and settles on-chain, with a 250 ms delay on crypto and finance markets (V). On NEAR, matching stays off-chain regardless. The trust surface is the operator, which is exactly what a regulator inspects.

## The honest business questions (devil's advocate)

- **Cold start.** An empty book has no price, and no price means no users. Polymarket pays maker rebates of 20 to 25% and runs liquidity rewards (V). A new venue has to fund that before it earns anything.
- **Fee ceiling.** Polymarket's taker fee is `C × rate × p × (1 − p)` with rates from 0.07 (crypto) down to zero (geopolitics), makers pay nothing, and part of the fee is rebated (V). At p = 0.5 and rate 0.05 that is 1.25 cents on a dollar share. Volume has to be very large to carry a compliance team.
- **The customer is the competitor.** Any user can already deposit from Solana or Bitcoin into Polymarket, or from NEAR into Kalshi. "Join from any chain" does not give them a reason to leave.
- **Pattern.** This is the 4th idea whose real version is a regulated entity (Basalt, NEAR distributor, neartrade, now this). The cheap, legal slice is path A. The expensive, defensible one is path D. There is no cheap version of D.

## What I could not find

- Any dollar figure for a DCM, DCO, FCM or IB (registration fees, capital, staffing, legal spend). The WilmerHale piece says so explicitly.
- Kalshi's rulebook (HTTP 429) and its Developer Agreement text, so whether a front end or a competing venue can use Kalshi's data is unknown.
- Polymarket's builder tiers and any fee share for builders.
- Which countries allow a non-US crypto venue and on what licence.
- The June 2026 CFTC proposed rule's text.
- Whether the user's jurisdiction (El Salvador was noted for the office business, not for this one) offers a path.

## Suggested order of work

1. Read Kalshi's Developer Agreement and Polymarket's builder tiers (about 1 hour). This decides whether path A is a real business or a hobby.
2. Pay for 1 hour with a derivatives lawyer to rank paths B, D and G for your entity's home jurisdiction. Cost not researched.
3. Run `/replica-entrepreneur` on both venues' public reviews to find a gap worth building for.
4. Only then `/replica-architect`. A build before steps 1 to 3 has no answer to custody, which is the first schema decision.
