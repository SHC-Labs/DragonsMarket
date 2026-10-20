# Dragons Market: NEAR Hackathon Plan

Prepared: 2026-10-19. Updated the same day for the accepted Intents custody decision. Delivery schedule is proposed; implementation and deployment are not approved by this document. [intents-architecture.md](intents-architecture.md) is the custody source of truth.

Build a working prediction-market journey: fund through NEAR Intents, buy a position, resolve a disputed outcome through Dragon NFT jurors, redeem, and withdraw to a supported chain. Keep the professional minimal studio design already chosen for the website.

## Event and track strategy

The live [HACKATHON.md](https://nearhackathon.com/HACKATHON.md) was fetched on 2026-10-19 and matched the supplied local guide. Refresh it before submitting.

| Milestone | UTC | El Salvador |
| --- | --- | --- |
| Development/submissions open | 2026-11-01T00:00:00Z | October 31, 18:00 |
| Development/submissions close | 2026-11-14T23:59:00Z | November 14, 17:59 |
| Judging begins | November 16, 00:00 | November 15, 18:00 |
| Results announced by | November 18, 23:59 | November 18, 17:59 |

Submit one project, selecting the tracks the delivered work can demonstrate:

| Track | Priority | Evidence we need |
| --- | --- | --- |
| `defi`: Unstoppable DeFi | Core target | A real supported cross-chain funding route through Intents, contract-backed prediction positions, redemption, and a verified exit. Explain the trust model and any operator dependency. |
| `nfts`: NFTs That Do Something | Core target | A Dragon NFT staked as a jury credential, actual dispute participation, and fee-revenue accrual attributable to eligible seats. Artwork alone is insufficient. |
| `agents`: Agent Economy | Conditional extension | An agent actually pays for a useful evidence service and produces a cited market-resolution brief. A chatbot or unpaid summarizer is not enough for our proposed track claim. |

Organizer technology hints are suggestions, not mandatory integrations. Do not add Chain Signatures, autonomous agents, or NFT-owned wallets just to list another technology.

**Eligibility dependency:** the project predates November 1. The supplied guide does not establish whether existing projects qualify or what new work must fall inside the event. The product owner should obtain clarification before relying on eligibility. Preserve the existing history and identify the work delivered during the event; do not describe the whole project as newly built in November.

## Starting point

This is the baseline observed in the checkout on 2026-10-19, not a new audit certification:

- A Next.js website exists with Markets, combined Council membership/disputes, Watchlist, Partnerships, Portfolio, and market detail. The current visual system uses purple venue surfaces and a complete mint/forest Council palette, with light and dark themes. All pages share sans-serif typography and the Dragons Market dragon crest. Council and membership share `/council`; `/membership` is a compatibility link to its membership section.
- `market`, `oracle`, `council`, and `governance` exist alongside sandbox token fixtures. Current market execution uses a pricing curve, not the future order-book design described in parts of `spec.md`.
- `market` accepts one configured NEP-141 collateral token. Its `ft_on_transfer` credits `sender_id`; it does not currently map a separate Intents identity to a trading account.
- The contracts cover trading, optimistic resolution, NFT staking, jury selection, commit/reveal, and fee distribution. Contract review fixes are still being developed. `contracts/AUDIT.md` has dated entries; earlier entries can be superseded by later ones.
- The latest review entry describes streamed Council rewards. Quarterly distribution is a product policy still needing an explicit implementation decision, not proof that a quarterly claim restriction exists.
- Frontend financial writes are deliberately unwired while contract interfaces settle. Voting, storage registration, quotes, gas budgets, withdrawal completion, and receipt handling remain integration tasks in `web/WEBSITE-REVIEW-RESPONSE.md`.
- No complete cross-chain funding-to-prediction journey has been demonstrated here. The current source and review notes do not establish mainnet readiness.

## Scope

### Required demo

1. Connect a wallet and establish the identity that owns balances, positions, and any juror seat.
2. Select a supported origin chain/asset, see an actual quote and minimum, deposit through Intents, and follow the deposit to confirmed credit.
3. Commit collateral to controlled market backing inside Intents through authenticated settlement. Tokens stay in the verifier. Distinguish free funds, backing, pending transfers and position claims without double counting.
4. Buy Yes or No with a real quote, explicit fee/slippage information, and a confirmed position. Support selling before close where the market permits it.
5. Stake an NFT from the configured Dragon collection and show eligibility, obligations, and accrued rewards.
6. Close a short event market, propose an answer, challenge it, draw a jury, commit and reveal votes, and finalize the result.
7. Redeem the position and verify that trading fees reach the configured Council and business destinations without using market backing.
8. Withdraw available collateral through a supported Intents route to an external-chain address, showing completion only after the final destination transfer is confirmed.

Target at least one completed non-NEAR origin route and one non-NEAR destination route. Prefer two distinct external chains if supported routes, funding, and testing permit it. Publish only the routes actually exercised; do not promise every chain or asset.

### Preserve the product direction

- Dragons are the collection and brand identity. Keep the professional visual direction and plain language.
- Staked NFTs provide Council participation and revenue eligibility. Do not reintroduce a blanket claim that every unstaked holder earns.
- Preserve the intended quarterly payout story, but distinguish earnings accrual, fee sweeps, and claim timing. The contract owner must settle the actual cadence before enabling claims or publishing payout dates.
- Keep compact outcome rows in market-grid cards and Visx charts in featured/detail views. Use actual price history rather than fabricated activity.
- Keep the collection's four supplied artworks as a selection from a larger collection. Four images do not imply a four-token supply.
- Keep watchlists tied to the connected identity, responsive layouts, keyboard access, and persistent theme selection.

### Deferred

Perpetuals, Ondo integrations, a new order-book exchange, permissionless market creation, an automated final AI judge, a production NFT fundraising sale, and a broad visual redesign are outside this hackathon slice. The optional evidence agent must not delay the funding and settlement journey.

## What Degen Arena teaches us

Public investigation on 2026-10-19 found:

| Evidence | Observation |
| --- | --- |
| [Original deposit](https://nearblocks.io/txns/FR9f9g7ENMxwVPYszmzc6vVwUSE9CE317q6rpTmi37E3) | A 5 NEAR transfer to a generated implicit deposit address. |
| [Forwarding](https://nearblocks.io/txns/4RknQUhdMxxqoVVHZkLtzSHgjZ5n1dDfkicB6DXaftrE) | The address forwards 4.999505 NEAR to `bridge-mng.near`. That account had no deployed contract code when checked. The difference is not an established platform fee. |
| [Matching Intents credit](https://nearblocks.io/txns/E1uTdXRwMJx4s3sDKeDKS5RwyzQRKPFKuV3cxfK5rki1) | Seconds later, `bridge-mng.near` wraps 5 NEAR and deposits it into `intents.near`, minting `nep141:wrap.near` balance to internal account `fcacf38954b3533d9d2be04832dda8623723cdc0a4efd2e59db402def1f7fdad`. Amount/timing and subsequent activity support the link; the bridge's internal mapping was not obtained. |
| [First subsequent transfer](https://nearblocks.io/txns/CN46tUncKTJRjB2XwSFk5TmyqYPqoocsDTokYNQra9rP) | A NEP-413 signed `transfer` intent sends 1 wNEAR to the same recipient seen in five such transfers. It contains an amount and recipient, not blackjack rules or an independently verified result. |
| [Public application bundle](https://degenarena.gg/assets/index-CAObp4Tw.js) | Gameplay calls use backend API endpoints such as `/games/play` and `/games/blackjack/action`. No separate Degen Arena game contract was established by this investigation. |

The verifier's reported source metadata, queried at the first transfer's block and at the time of inspection, points to version 0.4.5 at [this source revision](https://github.com/near/intents/tree/16d04f6ec4401263f8914638710260da50bb46b0/contracts/defuse). Its engine checks signatures, recipient contract, deadlines, authorized public keys, and nonce reuse. This was source/receipt analysis, not an independently reproduced build or a complete security audit.

Adopt the convenient funding experience. Do not infer that Intents supplies prediction-market rules, adjudication, or payout enforcement. Backend-mediated requests also do not establish who holds the user's internal signing key.

## Intents architecture

### Accepted custody flow

```text
Supported origin wallet
  -> Intents deposit / conversion
  -> confirmed user balance inside Intents
  -> controlled market escrow inside Intents
  -> funded Dragons Market position and resolution
  -> eligible payout released inside Intents
  -> available user balance inside Intents
  -> supported external withdrawal and destination confirmation
```

The owner has decided where tokens are held. This is not an undecided choice between an Intents balance and a separate NEP-141 market vault. The settlement mechanism, account control and identity model still need implementation.

### First implementation decision: enforce backing inside Intents

Accountable owner: Claude for the contract proposal. The product owner decides signing/delegation/recovery policy and collateral; Codex integrates reviewed interfaces.

Before enabling financial actions:

1. Specify the owner and authority of free-user, escrow, bond, fee, reward and business balances inside Intents. Establish how external-wallet authorization binds to the account that owns positions and juror rights.
2. Select one collateral token with verified Intents ID, issuer, decimals and provider routes. Funding assets may be converted; sandbox mUSD is not an assumed live token.
3. Prove a supported transfer/authorization sequence that removes free spendability before issuing a position, maintains controlled backing, and releases it only under the market rules. A backend lock or `mt_balance_of` read is insufficient.
4. Make payment/position issuance atomic where supported, or implement an authenticated, single-use, recoverable sequence with a defined refund path. Cover selling, redemption, bonds, fees and rewards as well as buying.
5. Specify storage, gas, wallet prompts, delegation limits, key recovery and backend-down exits. Do not assume a function-call key can replace existing methods requiring 1 yoctoNEAR.
6. Define the state migration or fresh deployment. Existing NEP-141 balances cannot be relabeled as verifier funds, and prior tests do not certify the new custody boundary.

The current market's `ft_on_transfer` credits `sender_id`. A direct token transfer from the verifier would identify `intents.near`, not the user, and move funds outside verifier custody. The old plan's Intents -> NEAR wallet -> market route is superseded as the product target. A deadline does not automatically authorize that fallback.

November 5 gate: demonstrate a funded position with controlled backing remaining inside Intents and a working release/recovery path. If that fails, narrow the demonstrated scope and state the missing integration; do not present the legacy route as completion of the custody decision.

### Routing and reconciliation

- Compare the documented bridge/internal-balance route with 1Click's supported input/output balance modes. The Degen trace does not prove it uses 1Click. Choose the provider path from current official documentation and a small proof of the chosen route.
- Never send native NEAR straight to `intents.near`; the observed NEAR route wraps it first.
- Bind each deposit quote to its authenticated beneficiary, origin chain/asset, expected destination token, expiry, amount constraints, and refund address. Do not accept a browser-supplied success claim as credit evidence.
- Persist a resumable operation record with provider reference, transaction hashes, receipt/event identifiers, amounts, chain IDs, state, and timestamps. Make processing idempotent at the event/receipt level; one transaction can contain multiple events.
- Treat bridge completion, verifier credit, controlled backing assignment, position issuance, payout release, and external withdrawal as separate confirmation steps. Persist transitions across refreshes and worker restarts.
- Retry observation safely; do not blindly resubmit a money-moving action after a timeout. Reconcile its known reference first.
- Track pending outgoing amounts so an in-progress withdrawal cannot also be traded or withdrawn again. Restore funds only after the failed leg's outcome is established.
- Use integer amounts and token decimals throughout. Document provider fees, slippage, minimums, and any residual balance instead of describing all differences as fees.

## Delivery schedule

Dates below are targets, not reports of completed work. Roles retain existing responsibilities: Claude owns contracts; Codex owns frontend integration; the product owner owns product decisions, funds, publication, and submission. No tasks or messages have been sent to another agent by creating this plan.

### Preparation, October 20-31

| ID | Dates | Accountable owner | Work and definition of done |
| --- | --- | --- | --- |
| P1 | Oct 20-22 | Product owner | Clarify existing-project eligibility and record the organizer's answer. Agree two core tracks and the demo scope. |
| P2 | Oct 20-23 | Claude | Propose the Intents account/control model, collateral, escrow/position settlement, recovery behavior, and ABI changes. Produce a concrete sequence and explain who can move funds at each step. |
| P3 | Oct 24-27 | Codex | Inventory final frontend/contract DTO differences against the review response. Produce an integration checklist for quotes, storage, commit/reveal, gas, and receipts without enabling unfinished writes. |
| P4 | Oct 28-31 | Product owner | Settle architecture, demo funding/network choice, quarterly claim policy, collection configuration, and responsibility for infrastructure. Preserve a dated pre-event baseline and unresolved contract findings. |

Preparation should stay within the organizer's clarified rules for existing work. Keep new event work identifiable from November 1 onward.

### Week 1, November 1-7: prove money movement, then trade

| ID | Dates | Accountable owner | Depends on | Work and definition of done |
| --- | --- | --- | --- | --- |
| H1 | Nov 1-3 | Claude | P2, P4 | Build Intents-held escrow/position settlement with authenticated identity binding. Demonstrate controlled backing, rejected unauthorized settlement, replay handling, and recovery. Freeze a versioned interface for frontend work. |
| H2 | Nov 1-3 | Codex | P3, P4 | Build deposit/status UI against explicit operation states; match final types as H1 lands. Show loading, expiry, failure, refund, and resume states with no invented success. |
| H3 | Nov 4-5 | Claude | H1 | Complete one origin-chain -> Intents -> funded position -> released Intents balance -> external exit experiment. Record amounts, controlled backing, receipts, fees, timings and failures. Fail the custody gate if trade backing leaves the verifier or remains freely spendable. |
| H4 | Nov 4-7 | Codex | H1, H2; H3 for live sign-off | Connect quote/buy/sell/portfolio flows with storage registration, fee/slippage display, pending receipts, rejection handling, and refresh recovery. Done when a real position follows confirmed funded credit and is reflected correctly after reload. |
| H5 | Nov 6-7 | Claude | H3 | Validate keeper behavior, settlement invariants, paused-market exits, and current review fixes on the selected demo build. Provide exact contract IDs, versions, methods, gas measurements, and remaining limitations. |

### Week 2, November 8-14: Council, exit, and judge-ready evidence

| ID | Dates | Accountable owner | Depends on | Work and definition of done |
| --- | --- | --- | --- | --- |
| H6 | Nov 8-10 | Codex | H4, H5 | Connect stake, juror case states, commit/reveal, finalization display, and rewards. Persist the reveal secret safely before commit and verify recovery. Run a complete challenge with enough distinct jurors; show the actual result and token receipts. |
| H7 | Nov 8-10 | Claude | H3, H5 | Finish outbound settlement/refund handling and verify the fee/reward path. A completed exit is proven at the destination; a failed leg cannot erase a user's claim or create a duplicate payment. |
| H8 | Nov 9-11 | Codex | H4, H6, H7 | Integrate redemption and withdrawal states. Exercise the whole journey on desktop and mobile in both themes. Show supported networks, actual minimums, and honest in-transit balances. |
| H9 | Nov 11-12 | Claude | H6, H7, H8 | Run the agreed contract, integration, and adversarial checks. Record failures and fixes against the exact demo build. Separate any real routing experiment from sandbox simulations. |
| H10 | Nov 12-13 | Codex | H8, H9 | Prepare the judge README, architecture/trust diagram, replayable setup, evidence links, and demo script. Freeze features by Nov 12; use Nov 13 for fixes and recording support. |
| H11 | Nov 13-14 | Product owner | H10 | Review public-repository readiness, record and publish the demo post, approve the exact submission fields and consent, then submit once before the deadline. Target completion at least two hours early. |

Critical path: eligibility/settlement design -> controlled Intents backing -> funded trade -> dispute/redeem -> confirmed exit -> evidence -> submission. If it slips, cut the optional agent before reducing checks on money movement.

### Optional agent, only after a working core

Decision gate: November 9. Proceed only if funding/trading already works and Council/exit work is on schedule, with a separately available implementation owner. Do not assign it to the occupied contract/frontend critical path by default.

The agent gathers sources for a market question, pays for a useful data/API request, and publishes a brief with timestamps, links, uncertainty, and the payment reference. A juror decides what to accept; the agent cannot finalize outcomes or spend unrestricted user balances. If payment or useful output is not demonstrated, omit the `agents` track rather than stretch the claim.

## Acceptance checks

| Area | Evidence required before claiming completion |
| --- | --- |
| Funding | A supported external-chain deposit reaches the correct beneficiary inside Intents. A trade assigns controlled backing there and issues one funded position; exact decimals and every confirmation step are recorded. |
| Authorization | A different wallet cannot claim, spend, or withdraw the deposit. Expired/replayed instructions and changed recipients/chain IDs are rejected where applicable. |
| Reconciliation | Repeated provider events, refreshes, delayed receipts, and worker restarts produce one credit/payment. Available, locked, pending, fees, and backing reconcile without double counting. |
| Trading | Quotes and charges agree; tiny amounts and slippage boundaries are handled; failed/rejected transactions do not fabricate a position. |
| NFT utility | The configured collection alone can supply seats. A stake creates eligibility, serving locks are respected, and an unstaked NFT is not shown as earning or eligible. |
| Disputes | Real propose/challenge/draw/commit/reveal/finalize flow works. Missing reveals, draw failure, escalation, and deadline settlement follow the latest contracts. Losing the browser session does not silently destroy the reveal path. |
| Rewards | Actual fee/reward balances remain inside Intents and follow the configured split and latest streaming/accounting rules. Quarterly policy is documented separately. Demonstrate accounting in an accelerated local environment where needed; do not imply three calendar months elapsed. |
| Redemption | Yes, No, and Void payouts use the final contract rules. Voids use the contract's published price/weight data, not an assumed 50/50 payout. |
| Exit | Only free balance is withdrawn. Interrupted and failed legs recover correctly. Completion includes evidence from the final destination chain. |
| UX | At 320/390 px and desktop widths, both themes show usable forms, no obstructed dialogs or horizontal page overflow, readable status text, and keyboard-operable actions. Respect reduced-motion preferences. |
| Reproducibility | A clean environment can follow the README. Distinguish mocks, local sandbox, testnet, and any authorized mainnet route evidence. Never present mocked provider calls as real Intents execution. |

Use the repository's contract suites, keeper tests, frontend unit checks, lint/type checks, token contrast checks, and focused browser tests as appropriate to the delivered changes. Add adapter/reconciliation tests for the new boundary. Passing existing suites alone does not prove the Intents integration.

## Demo script and artifacts

Aim for a focused 3-5 minute recording:

1. Explain the question, the two outcomes, and how a position pays out.
2. Show a supported external-chain deposit, the Intents receipt, and confirmed Intents balance and controlled backing for the trade. Use a clearly identified earlier real transfer if bridge latency makes waiting impractical.
3. Buy a position and show the receipt and portfolio change.
4. Show a Dragon NFT becoming a juror credential, a challenged outcome, and a completed commit/reveal decision. Short demo windows must be labeled as demo configuration.
5. Show redemption, fee/reward attribution, and a completed withdrawal to the destination chain.
6. State which parts are deployed, which were simulated locally, and what remains before public launch.

Prepare a public-facing README with runnable steps, a deployment/network table, the chosen identity/custody model, trust boundaries, track evidence, contract/source versions, supported routes, and limitations. Keep API keys, private keys, signing secrets, local account files, personal submission data, and unredacted logs out of publication.

## Submission

- Re-read the live guide and record the actual feature/evidence status before choosing tracks.
- The product owner must confirm eligibility, the final project-name availability, team lead, email, team-size category, mainnet prize account, public repository URL, demo-post URL, description, and contact consent. Do not invent missing values.
- The repository must be public by **2026-11-14T23:59:00Z**. Publishing it, pushing, posting on X, spending tokens, signing transactions, or deploying to mainnet is not authorized by this planning document.
- The human publishes the required public X demo post saying the project was built at NEAR HACKATHON, with video or screenshots. Describe the pre-existing foundation and event additions honestly.
- Prepare exactly the payload required by the live guide, show the complete payload to the human, and wait for explicit confirmation before sending. Do not include a `website` field. Keep personal data outside the repository.
- Submit once through the form or API. Keep one request ID for any permitted retry; do not submit again after confirmed success. Follow the guide's status-specific retry rules.

## Decisions and blockers to close

| Decision | Owner | Needed by |
| --- | --- | --- |
| Existing-project eligibility and allowed event scope | Product owner | Oct 22 |
| Intents account control, escrow settlement, identity and recovery | Product owner, informed by Claude's proposal | Oct 31 |
| Collateral token, provider route support, network, and bounded demo funding | Product owner | Oct 31 |
| Final contract fixes, ABI, storage/gas requirements, and deployment version | Claude | Nov 3 interface gate; Nov 7 validation gate |
| NFT issuer/collection and demo mint vs existing-token setup | Product owner | Oct 31 |
| Quarterly claim behavior vs continuous streamed accrual | Product owner | Oct 31 |
| Backend/worker hosting, operation store, and recovery ownership | Product owner | Oct 31 |
| Optional paid evidence agent and available owner | Product owner | Nov 9 |
| Team/contact/prize/publication details and exact submission approval | Product owner | Nov 13 |

Writing this file does not resolve these decisions, enable transactions, modify contracts, or submit the project.

## References

- [Official hackathon guide](https://nearhackathon.com/HACKATHON.md), refreshed 2026-10-19; local supplied copy: `/home/nameless/Downloads/HACKATHON.md`.
- [NEAR Intents deposits](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits).
- [NEAR Intents withdrawals](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/withdrawals).
- [NEAR Intents balances](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/balances).
- [1Click API overview](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api). Verify current request schemas and supported routes before implementation.
- [Observed verifier source revision](https://github.com/near/intents/tree/16d04f6ec4401263f8914638710260da50bb46b0/contracts/defuse); metadata/source pointer, not an independently reproduced binary match.
- Local implementation/review sources: `README.md`, `spec.md`, `contracts/market/src/lib.rs`, latest dated entries in `contracts/AUDIT.md`, and `web/WEBSITE-REVIEW-RESPONSE.md`. Reconcile stale research notes with the current code before using them as requirements.
