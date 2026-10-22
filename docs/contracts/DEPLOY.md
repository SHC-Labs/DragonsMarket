# Dragons Market: deployment gates

Release requirements for Intents-backed settlement and Trezu/Sputnik administration.

| Field | Value |
| --- | --- |
| Updated | 21 October 2026 |
| Status | Blocked on integration and review; not an executable deployment recipe |
| Contract work | Claude |
| Financial deployment approval | Project owner |
| Product authority | [Specification](../spec.md) |

## Contents

1. [Required deployment records](#1-required-deployment-records)
2. [Settlement and rewards](#2-settlement-and-rewards)
3. [Administration and upgrades](#3-administration-and-upgrades)
4. [Website and operations](#4-website-and-operations)
5. [Opening the venue](#5-opening-the-venue)

---

## 1. Required deployment records

- [ ] Identify the exact reviewed source revision, builds and code hashes.
- [ ] Record the network, market/oracle/Council accounts, verifier, collateral ID and decimals.
- [ ] Verify the Trezu treasury account, policy, membership and approved execution path.
- [ ] Record each controller, access key, operator and recovery authority.
- [ ] Choose fresh deployment or a reviewed state/liability migration for each changed component.

The custom governance contract is retired and must not be deployed. Development accounts,
example DAO names and sandbox keys are not production configuration.

---

## 2. Settlement and rewards

- [ ] Prove external funding reaches the correct authenticated beneficiary and collateral asset.
- [ ] Show committed backing remains controlled inside Intents and reconciles with positions.
- [ ] Verify buy, sell, Yes/No/Void redemption and available-balance withdrawal.
- [ ] Complete the oracle bond/juror-payment migration to Intents.
- [ ] Verify earned-fee allocation: 75% treasury and 25% Council-controlled rewards, with the real
      treasury account (see the configuration order below).
- [x] Quarterly entitlement and claim rules, with repeat and cross-path claims refused (built
      2026-10-21, sandbox and unit tests in [AUDIT.md](AUDIT.md#fee-split-and-quarterly-claims-2026-10-21)).
      A run against the real USDC contract and a real DAO is still open.
- [ ] Test interrupted callbacks, uncertain transfers, retries, restarts and backend-down recovery.
- [ ] Verify selected provider fees, slippage, refund behaviour and destination confirmation.

### Configuration order

Nothing the owner still has to choose is written in the contracts or taken by `new`. The market and
the Council deploy with no fee recipient, no market and no NFT collection, and refuse to sweep, take
revenue, stake or pay a claim until the owner has set them. Each step below is an owner call, a DAO
proposal once the DAO owns the contract, and the helper in `contracts/keeper` prepares each one.

| Step | Contract | Call | Notes |
| ---- | -------- | ---- | ----- |
| 1 | council | `set_nft_contract(nft_contract)` | Only while nothing is staked. The collection must have a fixed supply with minting closed first. |
| 2 | council | `allow_tokens(token_ids)` or `set_token_range(first, last)` | The allowlist starts on with nothing allowed. |
| 3 | council | `set_market(market)` | The market contract. Revenue and claims refuse until it is set. |
| 4 | council | `set_close_grace_ns(close_grace_ns)` | Optional. 7 days to start, 1 to 30 days allowed. This is the wait after a quarter ends before it can be finalized and claimed. |
| 5 | market | `set_fee_recipients(revenue_pool, treasury)` | The Council contract and the verified Trezu treasury. A sweep refuses until it is set. Read the treasury account back from the DAO before the proposal. |
| 6 | market | `set_revenue_share_bps(revenue_share_bps)` | Optional. 2,500 (25% to the Council, 75% to the treasury) to start, 1,000 to 5,000 allowed. |
| 7 | market | `set_min_sweep(min_sweep)` | Optional. 1,000,000 units to start, 1 to 100,000,000 allowed. |
| 8 | market | `set_next_sweep_id(next_sweep_id)` | Only when this market replaces an older one that already sent sweeps to the same Council. The Council refuses a sweep id it has taken, so start above the highest. It can only move up. |

Send a small sweep after step 5 and read both Intents balances, the sweep record (`get_sweep`) and
the Council's `received_of`. The keeper sweeps when fees reach its own threshold (10 units to start),
which is above the contract's minimum.

Existing market and Council Intents code is part of this work. Its presence does not establish
that the complete production journey has passed. The [verifier proof](INTENTS-PROOF.md) and
[audit record](AUDIT.md) retain their original test scope.

---

## 3. Administration and upgrades

DECIDED (owner, 21 October 2026): sensitive changes use Trezu/Sputnik member approvals, and the
DAO voting period is the only delay. SputnikDAO executes a proposal at the approval that reaches
the threshold, so there is no exit window after approval. Verify that the DAO is the owner of
every contract, that its policy matches the
[recommended policy](specs/owner-and-keeper.md#7-recommended-dao-policy) and every possible bypass.

- [ ] Test allowed and denied proposal/target calls through the selected deployment.
- [ ] Verify upgrade staging, deploy/migrate, failure recovery and published code hashes.
- [ ] Prove failed-proposal retry, proposal expiry and restrictions on ownership changes.
- [ ] Check owner handover on every application contract and reconcile pending-owner state.
- [ ] Prove the upgrade path before removing deployment keys; verify the resulting key list.
- [ ] Confirm routine operators cannot redirect fees or spend backing.

[The treasury handoff](governance.md) describes what remains unconfigured. Do not turn its
proposal-preparation helper into a production submitter without reviewing the chosen interfaces.

---

## 4. Website and operations

- [ ] Bind the frontend to the reviewed DTOs, selected network and exact deployment accounts.
- [ ] Verify quotes, fees, wallet prompts, rejected signatures and receipt/finality handling.
- [ ] Show available, committed, pending, accrued, claimable and paid amounts distinctly.
- [ ] Test phones, desktop, both themes, keyboard access and reduced-motion preferences.
- [ ] Configure bounded keeper authority, funding alerts and reconciliation monitoring.
- [ ] Establish durable operation records, recovery ownership and incident procedures.
- [ ] Replace footer placeholder links and verify public routes before publication.
- [ ] Agree and implement any required durable terms/privacy acceptance record.

Frontend transaction controls remain disabled until their integration is complete. Browser
clickwrap preferences alone do not provide a server-side acceptance audit trail.

---

## 5. Opening the venue

The project owner sets initial market exposure and user limits after security and legal review.
Publish mint participation terms, reward eligibility and claim rules before asking users to buy
an NFT. Earnings and returns must not be guaranteed.

Launch only against evidence for [R-01 through R-08](../spec.md#requirements-to-implementation-map),
with the implemented limitations disclosed. Publishing, deployment and real-money testing need
explicit authorisation. This document records requirements and does not perform those actions.
