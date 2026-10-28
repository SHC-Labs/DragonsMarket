# Dragons Market: product specification

The first release is a funded prediction-market journey with Dragon NFT juries and quarterly holder claims.

| Field | Value |
| --- | --- |
| Updated | 21 October 2026 |
| Status | Accepted direction; implementation incomplete |
| Contract implementation | Claude |
| Website and integration | Codex, against reviewed contract interfaces |
| Product decisions | Project owner |

## Contents

1. [Product goal](#1-product-goal)
2. [Release scope](#2-release-scope)
3. [Market lifecycle](#3-market-lifecycle)
4. [Trading and payouts](#4-trading-and-payouts)
5. [Money flow](#5-money-flow)
6. [Collateral and custody](#6-collateral-and-custody)
7. [Architecture and administration](#7-architecture-and-administration)
8. [Interfaces and recovery](#8-interfaces-and-recovery)
9. [Council and dispute resolution](#9-council-and-dispute-resolution)
10. [Revenue and quarterly claims](#10-revenue-and-quarterly-claims)
11. [Requirements to implementation map](#requirements-to-implementation-map)
12. [Current implementation](#12-current-implementation)
13. [Release gates and open details](#13-release-gates-and-open-details)
14. [Document authority](#14-document-authority)

---

## 1. Product goal

A user funds an account through a supported NEAR Intents route, buys a backed Yes or No position,
follows the published resolution process, redeems and withdraws. Eligible staked Dragon NFTs
provide Council seats for disputes and a share of earned platform fees.

The agreed direction is NEAR Intents for fungible funds, Trezu/SputnikDAO for administration,
75% of earned fees to the project treasury and 25% to Council-controlled rewards. Eligible
holders claim rewards quarterly through Council-authorised settlement.

Missing functions are implementation work. Extend or replace a method or module where needed to
meet these requirements. Product changes require an explicit owner decision. Existing code sets
the current behaviour; it does not limit the accepted product.

---

## 2. Release scope

| Included | Purpose |
| --- | --- |
| Binary prediction markets | One question, Yes/No positions and a published result source |
| Parimutuel trading | Buy and sell at any time while a market is open, priced by a dynamic parimutuel cost function. No seed and no market maker (decided by the team 2026-10-27, replacing the constant-product pool) |
| Intents-backed funding and settlement | Separate available funds, backing, pending transfers and payouts |
| Dragon Council | Eligible NFT staking, juror selection, case obligations and public decisions |
| Quarterly holder claims | Earnings attributed to eligible participation and claimed once |
| Trezu treasury | Team membership, approvals and the 75% revenue destination |
| Website | Markets, details, Council, Watchlist, Partnerships, Portfolio and legal pages |

Order books, perpetuals, multi-outcome markets, public trading APIs and autonomous AI resolution
are outside this release. A future addition needs its own scope and evidence. Optional research
agents must not delay the funded-trade and withdrawal journey.

The brand is Dragons Market. Its tagline is: "The world moves and every outcome has a market.
Take your position." The website uses the professional minimal studio design, shared deep-purple
surfaces, light/dark themes, the mint dragon crest, mint Yes buttons and deep-purple No buttons.
The four displayed Dragon portraits are a selection from a larger collection.

---

## 3. Market lifecycle

A market publishes its question, rule, source, closing time, resolution deadline and Void policy
before trading opens. Rules must be understandable without relying on a private support answer.
The contract's state machine controls trading, halts, proposals, challenges and final resolution.

Trading closes before an answer is final. A proposed result has a challenge window. A challenged
result follows the jury process. Unanswered questions, cancelled events and failed resolution
rounds must reach the documented fallback rather than leaving collateral locked indefinitely.

The website must show the actual status and deadline. A resolved market cannot accept new trades;
an unfinished challenge cannot be presented as a final result.

---

## 4. Trading and payouts

Every unit paid in stays in the market's pool. The winning shares split the pool, so a winning
share pays its part, never less than it cost; a losing share pays zero. Selling before close uses
the contract's quote, the applicable fee and the user's accepted minimum. Position amounts and
collateral use integer base units.

The pool must always hold at least the cost of the shares outstanding, and payouts and refunds
must reconcile with the controlled collateral. Released fees cannot also count as position
backing.

A Void, and an answer nobody holds a share of, pays each holder back what their position put in,
less what it has already taken out by selling. Fees are not refunded. Show the payout the contract
reports for a position (`get_positions`' `redeemable`), not one worked out in the browser. The
current implementation and edge cases are described in [the market manual](contracts/market.md).

The UI shows a real quote, estimated shares or proceeds, fees and slippage before confirmation.
Displayed probabilities and charts describe observed market state; decorative movement must not
be presented as additional trades or live activity.

---

## 5. Money flow

```text
Supported origin asset
  -> verified route and conversion to collateral
  -> confirmed user balance in Intents
  -> authorised commitment to market-controlled backing in Intents
  -> funded position
  -> sale or final redemption
  -> available user funds in Intents
  -> authorised withdrawal and destination confirmation
```

Deposits bind to the intended beneficiary, asset, network, amount, expiry and refund route. A
browser message, provider status or balance observation alone cannot issue platform credit.

Committed backing cannot remain freely spendable by the depositor. Exits use available funds;
a pending withdrawal cannot also fund a trade or another withdrawal. Release inside Intents and
arrival on an external chain are separate confirmation steps.

The application must recover after a worker restart, rejected signature, delayed receipt or
failed callback. An unknown outcome remains unresolved until reconciled. A timeout does not
justify paying again.

---

## 6. Collateral and custody

The selected market collateral is native USDC on NEAR, with six decimals:

| Identifier | Value |
| --- | --- |
| Token contract | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| Intents asset ID | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |

These are the accepted configuration identifiers from the prior collateral decision. Verify the
chosen deployment and provider route again before using real funds. Sandbox mUSD is test collateral.
Supported funding assets are converted to the selected collateral; market accounting remains
single-collateral. Withdrawals use USDC under the accepted policy, with withdrawal and any swap
costs shown to and paid by the user.

NEAR Intents holds the fungible backing, fee allocations and reward balances. The accepted target
also covers dispute bonds and juror payments. NFT staking remains NEP-171 custody, and native
NEAR for storage/gas is separate operational funding.

Holding location does not establish authorisation. The design must specify each Intents account,
its controller, permitted transfers, recovery and remaining operator powers. Do not advertise
custody guarantees that the actual keys, contracts and upgrade controls cannot support.
See [the custody architecture](intents-architecture.md).

---

## 7. Architecture and administration

| Component | Responsibility |
| --- | --- |
| Market | Questions, curve pricing, positions, backing, settlement, fees and redemption |
| Oracle | Outcome proposals, challenges, deadlines, price evidence and bond/juror liabilities |
| Council | NFT staking, eligibility, jury duties, reward entitlement and quarterly claims |
| Intents verifier | Fungible asset ledger and authorised asset movement |
| Trezu / SputnikDAO | Treasury membership, approvals and administration. Its voting period is the only delay |
| Backend / keeper / indexer | Request routes, relay permitted operations, observe receipts and reconcile state |
| Website | Explain state and prepare actions against reviewed interfaces |

The custom governance contract is retired. Trezu/Sputnik is the selected replacement, but the
treasury has not been created or configured. No live ownership handover is recorded.

DECIDED (owner, 21 October 2026): sensitive administrative changes use Trezu/Sputnik member
approvals, and the DAO voting period is the only delay. No enforced delay after approval and no
delay component will be built. This replaces the earlier 72-hour post-approval requirement.

What the voting period gives, stated precisely: SputnikDAO executes a proposal in the same call
as the approval that reaches the threshold (`proposals.rs` lines 638 to 643 at revision
`5434a59dec23ee0c49df8c8c4350c208a7e75b0b`). A proposal is public while approvals arrive, and it
expires unexecuted if the threshold is not reached before the period ends. So the period gives visibility and
a deadline. It does not give users time to leave after a decision is made.

The protections that do not depend on a delay:

- `withdraw` and `redeem` ignore the market's pause, so a pause never closes the exit.
- Upgrades deploy only staged code that anyone can read first, and `upgrade_in_flight` makes
  `migrate` run only inside an upgrade.
- `seal` deletes access keys only after an upgrade has been proven.
- PROPOSED DAO policy: four of five approvals for every function call, unanimity for membership,
  policy and DAO code changes, and a 72-hour voting period. The numbers are in
  [the owner model](contracts/specs/owner-and-keeper.md#7-recommended-dao-policy).

Claude must prove the restricted methods, the owner handover, upgrades and access-key bypass
checks against a real SputnikDAO build.

Treasury approvers cannot spend user backing or another holder's entitlement. Treasury membership
does not grant a Council seat. Routine operator powers remain bounded and separate from ownership.
The proposal-preparation helper is documented in [the treasury handoff](contracts/governance.md).

---

## 8. Interfaces and recovery

Contract handoffs must identify exact methods, argument/return types, permissions, events, storage
and gas needs, versioning and migration. Suggested data requirements are not an approved ABI.

The website needs distinguishable available, committed, pending, accrued, claimable and paid
amounts. Quarter identity and timing must accompany reward states. A connected wallet, an
application session and authority over an Intents account are different things.

The backend records operation references and verified transitions. Its database is a projection
and recovery journal, never a second spendable money ledger. Reconciliation uses verifier balances
and receipts alongside contract positions and liabilities. A single transaction may contain
several events, so a transaction hash alone may not be a sufficient deduplication key.

---

## 9. Council and dispute resolution

Only eligible staked Dragons earn or enter jury selection. A selected seat follows case locks,
commit/reveal deadlines and the published evidence rules. An unstaked NFT earns no Council share.
The collection supply and public mint terms remain separate from the four website portraits.

Disputed results use the oracle's bounded jury rounds and final fallback. The outcome, evidence,
deadlines and votes must be publicly understandable. Missed reveals and failed rounds follow
explicit contract rules. Wallet caps do not establish that each wallet represents a different person.

Juror compensation is payment for case work and remains separate from holder revenue. Bond
settlement must reconcile the winner, participating jurors and any no-decision allocation.
See [oracle](contracts/oracle.md) and [Council](contracts/council.md) for implementation details.

The existing price-market path uses signed observations bound to the market, time, oracle and
network, with configured publisher thresholds. Publisher services and operational source policy
need their own evidence. A signed observation still follows the applicable challenge process.

---

## 10. Revenue and quarterly claims

| Allocation | Destination | Purpose |
| --- | --- | --- |
| 75% of earned platform fees | Trezu treasury | Approved project spending |
| 25% of earned platform fees | Council-controlled reward backing in Intents | Quarterly claims by eligible holders |

The split applies to earned fees, never deposits, position backing, withdrawal liabilities or
bonds. Specify integer rounding and track both transfer legs independently. The configured
recipient must be verified before transfers are enabled.

Quarterly claims are decided product behaviour and are built in the Council (2026-10-21): UTC
calendar quarters, entitlement by time staked inside the quarter, a claim window that opens once a
quarter is final (7 days after it ends to start), no-seat quarters rolling their pool into the next,
unclaimed shares that never expire, and late-arriving fees booked to the quarter they arrive in. A
last-minute stake earns only the time it was staked.

Claims reserve an entitlement once and complete only after verified settlement. Interrupted
payouts remain recoverable without reopening an already-paid entitlement. Earnings vary with
actual fees and eligible participation; no fixed return or payment amount is promised.

---

## Requirements to implementation map

| ID | Required capability | Responsible component | Acceptance evidence |
| --- | --- | --- | --- |
| R-01 | Authenticate funding and commit backing inside Intents | Market / settlement | Wrong beneficiaries and replayed events cannot issue positions |
| R-02 | Buy, sell, redeem and recover interrupted payouts | Market / settlement | Liabilities reconcile and uncertain callbacks cannot pay twice |
| R-03 | Allocate earned fees 75% treasury / 25% Council | Market / settlement | Exact rounding, recipient verification and independent transfer-leg recovery. BUILT 2026-10-21 in the contract, treasury account not yet verified on a real DAO |
| R-04 | Enforce NFT eligibility and case obligations | Council / oracle | Ineligible seats cannot earn or vote; locks and stake changes follow the rules |
| R-05 | Account for quarters and settle claims once | Council / settlement | Boundary, late-fee, no-seat, repeated-claim and failed-transfer tests. BUILT 2026-10-21, sandbox runs of a finished quarter are accelerated |
| R-06 | Settle bonds and juror pay independently | Oracle / settlement | Every final or failed round reconciles without spending holder allocations |
| R-07 | Use Trezu/Sputnik member approvals for sensitive administration, with the DAO voting period as the only delay (decided 2026-10-21) | DAO integration | Restricted methods refuse other callers, owner handover, upgrades and key-bypass checks, all with a real SputnikDAO |
| R-08 | Expose reliable user, quarter and operation state | Views / events / services | UI distinguishes availability, commitments, accrual, claims and confirmed payments |

The contract implementer records current coverage, missing methods/state, permissions, ABI,
migration and tests for each requirement. Codex integrates the reviewed interface. Product
choices change only through the project owner.

---

## 12. Current implementation

Source inspection on 21 October 2026, without running or modifying contract code:

| Area | Observed state | Remaining work |
| --- | --- | --- |
| Market | Uses verifier-held balances and Intents transfer callbacks | End-to-end funding/identity/exit validation and production configuration |
| Council | Receives and pays through its Intents account | Quarterly entitlement and claim enforcement |
| Oracle | Outcome/jury logic exists; bonds and juror pay arrive through the verifier and are paid from the oracle's own Intents account (phase I3, 21 October 2026) | Real USDC and mainnet run, website bond message, a push payout for a DAO recipient |
| Administration | Custom governance removed from workspace; the proposal and vote helper is an allow-list (21 October 2026), not yet run against a real DAO | Create and verify treasury, run the helper against it and transfer ownership |
| Website | Pages and wallet connection exist; financial writes remain disabled | Reviewed DTOs, quotes, signing, receipts and recovery |
| Backend | Required operation and reconciliation responsibilities are defined | Choose and implement the actual service and persistence design |

Source presence is not a production-readiness claim. Dated tests and findings remain in
[the contract audit record](contracts/AUDIT.md) and [verifier proof](contracts/INTENTS-PROOF.md).
They apply to their recorded builds.

---

## 13. Release gates and open details

- [ ] Complete the Intents-backed funding, trade, dispute, redeem and exit journey.
- [x] Implement quarterly Council claims (built 2026-10-21).
- [ ] Publish participation terms before minting.
- [ ] Create/verify the treasury, set the DAO policy and prove ownership migration and upgrades.
- [ ] Validate supported routes, USDC configuration, fees and failure recovery with bounded funding.
- [ ] Review publisher sources, operational parameters, market exposure caps and incident handling.
- [ ] Complete frontend integration and durable operation/reconciliation storage.
- [ ] Obtain the required security and legal review before a public-money launch.
- [ ] Confirm hackathon eligibility and submission requirements against the organiser's current guide.

NFT supply, mint price, final quarter rules, deployment account IDs, launch jurisdictions and
service providers remain details to resolve. Perpetuals and an order book remain later product work.

---

## 14. Document authority

| Document | Role |
| --- | --- |
| This specification | Accepted product behaviour and requirements |
| [Intents architecture](intents-architecture.md) | Custody, control, accounting and recovery boundaries |
| [Hackathon plan](hackathon-plan.md) | Delivery scope and evidence needed for a submission |
| [Contract manuals](contracts/) | Current implementation and work for Claude |
| [Website guide](web/README.md) | Frontend status, development and integration responsibilities |
| [Pitch](../PITCH.md) | Product story and growth approach |
| [Ecosystem reference](../NEAR-RESEARCH.md) | Reusable partner data, outside the application's specification |
| Dated reviews, audits and policy copies | Historical evidence for the version reviewed or accepted |
