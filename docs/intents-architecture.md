# Dragons Market: custody and settlement architecture

NEAR Intents holds fungible funds while application contracts enforce their permitted use.

| Field | Value |
| --- | --- |
| Updated | 21 October 2026 |
| Decisions | Intents holding layer; Trezu/Sputnik administration; 75/25 revenue; quarterly Council claims |
| Status | Market and Council use Intents in current source; remaining integration is incomplete |
| Product authority | [Product specification](spec.md) |
| Contract work | Claude |

## Contents

1. [Boundaries](#boundaries)
2. [Target flow](#target-flow)
3. [Accounting rules](#accounting-rules)
4. [Trezu administration](#trezu-administration)
5. [Council, bonds, and revenue](#council-bonds-and-revenue)
6. [Current implementation and gaps](#current-implementation-and-gaps)
7. [Implementation gates](#implementation-gates)

---

## Boundaries

| Layer | Responsibility |
| --- | --- |
| Intents verifier | Hold asset balances and execute authorised movement |
| Market | Fund positions, maintain backing, price trades, settle outcomes and allocate fees |
| Oracle | Resolve cases and account for dispute bonds/juror payments |
| Council | Stake eligible NFTs, enforce case duties and control holder reward entitlements |
| Trezu/Sputnik | Treasury membership, approvals and project administration. Its voting period is the only delay |
| Backend/keeper/indexer | Route requests, observe operations, persist recovery state and reconcile |
| Website | Show verifiable state and prepare reviewed user actions |

Account ownership and signing authority must be explicit. User-controlled free funds and
contract-controlled backing are different balances. Neither the treasury nor an operator may
spend backing outside market settlement rules. NFT custody and storage/gas funding remain
separate from the fungible holding layer.

---

## Target flow

```text
Supported origin wallet
  -> verified funding route / USDC conversion
  -> confirmed user funds in Intents
  -> authorised commitment to market-controlled Intents backing
  -> funded position
  -> sale or final redemption releases eligible funds
  -> available user balance in Intents
  -> authorised external exit and destination confirmation
```

A plain verifier balance observation cannot reserve money for a position. A transfer callback must
be authenticated and bound to its beneficiary, token, amount and operation. Publishing an intent
or receiving a provider response does not prove its settlement.

Current market and Council source use their own Intents accounts and verifier calls for the
implemented paths. The complete external-wallet identity, funding route, frontend and recovery
journey still needs integration evidence. The accepted collateral identifiers are in
[spec section 6](spec.md#6-collateral-and-custody).

---

## Accounting rules

- Separate available user funds, market backing, pending transfers, earned fees, bonds and rewards.
- Reconcile positions and remaining payout liabilities against controlled verifier balances.
- Keep each payment reserved until success or failure is established; an API timeout is unresolved.
- Complete each operation once, using receipt/event identity, beneficiary, token and network.
- Use integer base units, explicit decimals and measured fees. Record transfer-leg state independently.
- Keep the database as a projection and operation journal; it cannot create spendable credit.
- Provide a reviewed recovery path for backend outages and failed asynchronous calls.

A legacy transfer out of Intents into a token-holding market vault does not satisfy the selected
holding model. A new settlement adapter must preserve these boundaries rather than silently
introducing a different custody arrangement.

---

## Trezu administration

Trezu/Sputnik replaces the custom governance contract. The treasury has not been created or
configured. Actual membership, thresholds, account IDs, permissions and ownership handover need
verification before use.

DECIDED (owner, 21 October 2026): sensitive administrative changes use Trezu/Sputnik member
approvals, and the DAO voting period is the only delay. No post-approval delay or delay component
will be built. SputnikDAO executes a proposal in the same call as the approval that reaches the
threshold (`proposals.rs` lines 638 to 643 at revision `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`).
The voting period therefore makes a proposal public while approvals arrive, and the proposal
expires unexecuted if the threshold is not reached in time. It is not an exit window after a decision.

User protection rests on facts that need no delay: `withdraw` and `redeem` never pause, upgrades
deploy only publicly staged code, and access keys are sealed only after a proven upgrade. The
PROPOSED DAO policy (four of five for function calls, unanimity for membership and policy) is in
[the owner model](contracts/specs/owner-and-keeper.md#7-recommended-dao-policy). Claude must prove
that direct calls, deployment keys and upgrades cannot bypass DAO ownership.

The [treasury handoff](contracts/governance.md) describes the proposal-preparation helper and
pending work. It does not sign or submit transactions. Treasury voting and Council case voting
remain separate responsibilities.

---

## Council, bonds, and revenue

| Allocation | Recipient/control |
| --- | --- |
| 75% of earned platform fees | Verified Trezu treasury |
| 25% of earned platform fees | Council-controlled reward backing in Intents |
| Holder distributions | Quarterly claims through Council-authorised settlement |
| Juror compensation | Separate oracle case-work entitlement |

Fees are not position backing or bonds. The market's `treasury` setting names the 75% recipient;
it is not set at deploy and a sweep refuses until the owner has set it to the verified treasury
through the reviewed administration path, together with `revenue_pool`, the Council recipient. The
split is a share in basis points the owner can move (2,500 to the Council to start). Code field names
do not imply that a treasury account has already been selected.

The Council books revenue by UTC calendar quarter. A seat earns for the time it was staked inside the
quarter, a quarter is claimable once its grace period has passed, no-seat quarters roll their pool
into the next quarter, unclaimed shares never expire and late-arriving fees belong to the quarter they
arrive in. A reward cannot be paid through two different claim paths.

Oracle bonds and juror payments still need their own Intents migration. Moving those liabilities
must preserve the case rules and must not take money from holder allocations.

---

## Current implementation and gaps

Source inspection on 21 October 2026; no contract build or test was run for this cleanup.

| Component | Current source | Gap |
| --- | --- | --- |
| Market | Verifier-backed transfers, internal positions and a recorded fee sweep with independent legs | Complete user identity/funding/exit journey and verified recipient configuration |
| Council | Intents revenue receipt, NFT staking, quarterly entitlements and single-use claims | A run against real funds and a real DAO |
| Oracle | NEP-141 bond and payment paths | Intents bond/juror settlement |
| Treasury | Allow-list proposal and vote helpers, not yet run against a real DAO; custom governance removed | Real DAO and policy, ownership handover and integration tests |
| Frontend | Read-oriented adapters, disabled financial writes | Final DTOs, quote/sign/receipt/recovery integration |

See [market](contracts/market.md), [Council](contracts/council.md), [oracle](contracts/oracle.md)
and the dated [audit record](contracts/AUDIT.md). Those manuals and tests describe their recorded
builds; a complete release requires joint evidence for the new boundary.

---

## Implementation gates

For [R-01 through R-08](spec.md#requirements-to-implementation-map), deliver:

1. Account/control diagrams, exact verifier/token/network configuration and a reviewed ABI.
2. Proof of funded positions, protected backing and beneficiary/replay checks.
3. Sell, redeem, bond, fee and reward settlement with failed-operation recovery.
4. Reconciliation across verifier funds, positions and liabilities, including backend outages.
5. Quarterly Council accounting and single-use claims with boundary and stake-change tests.
6. Verified treasury membership and policy, and the proven DAO ownership path.
7. A migration or fresh-deployment plan for each changed state layout and liability.
8. Frontend integration and a demonstrated funding-to-exit journey using the selected build.

Official integration material is collected in [NEAR-RESEARCH.md](../NEAR-RESEARCH.md). Live routes,
API schemas and deployments must be checked when implementing them.

---

## Historical funding reference

The 19 October investigation of the supplied Degen Arena transaction documented this sequence:

| Record | Observation from that investigation |
| --- | --- |
| [Original deposit](https://nearblocks.io/txns/FR9f9g7ENMxwVPYszmzc6vVwUSE9CE317q6rpTmi37E3) | The user's external funding transaction |
| [Forwarding](https://nearblocks.io/txns/4RknQUhdMxxqoVVHZkLtzSHgjZ5n1dDfkicB6DXaftrE) | Funds forwarded through `bridge-mng.near` |
| [Verifier credit](https://nearblocks.io/txns/E1uTdXRwMJx4s3sDKeDKS5RwyzQRKPFKuV3cxfK5rki1) | Wrapped NEAR credited inside `intents.near` |
| [Subsequent transfer](https://nearblocks.io/txns/CN46tUncKTJRjB2XwSFk5TmyqYPqoocsDTokYNQra9rP) | A signed internal transfer, rather than evidence of game rules or outcome enforcement |

This historical trace helped choose the holding-layer direction. It did not establish a separate
Degen Arena game contract, its internal key ownership, prediction-market escrow or use of 1Click.
The records were not re-fetched during this cleanup. Our own settlement requirements still apply.
