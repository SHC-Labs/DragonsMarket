# Dragons Market: token custody and NEAR Intents

Date: 2026-10-19. **Decision: accepted. Implementation: pending.**

The owner has chosen NEAR Intents to hold the platform's fungible tokens. Intents is the custody and transfer layer for the target product, not merely a bridge that delivers funds into a separate Dragons Market token vault. This decision supersedes conflicting custody descriptions in earlier designs and the first version of `hackathon-plan.md`.

This document records the accepted direction and the contract work it requires. It does not claim that the current contracts implement it. Claude retains contract implementation ownership; frontend integration waits for the reviewed interfaces.

## Boundaries

| Layer | Responsibility |
| --- | --- |
| NEAR Intents verifier | Holds supported assets and records balances under Intents account IDs and token IDs. Executes authorized transfers/swaps and withdrawals. On mainnet the observed verifier is `intents.near`; other environments need explicitly verified configuration. |
| Dragons Market settlement contracts | Enforce payment before a position is issued, market backing, trade pricing, positions, settlement, fees, and redemption. Their accounting must be tied to controlled balances inside Intents. |
| Oracle and Council | Establish outcomes, administer disputes and juror obligations, account for bonds and rewards, and authorize their defined transfers. |
| Governance | Controls the specified upgrades and platform parameters, within the documented custody and authorization boundaries. Intents custody alone does not prevent an unsafe upgrade or signing key from moving funds. |
| Backend and indexer | Request routes, relay authorized operations, persist progress, observe receipts, and reconcile contract state. A database row or provider status alone cannot create withdrawable money. |
| Website | Shows available, committed, pending, and reward balances, their status, quotes, positions, and transaction evidence. It does not manufacture credit or finality. |

Supported fungible assets use the verifier's NEP-245 internal balances. For example, `nep141:wrap.near` identifies wrapped NEAR inside Intents. Native NEAR must be wrapped or routed through a supported bridge before verifier credit. An Intents token balance is not a Yes/No prediction position; our contracts still implement those positions.

Holding funds inside Intents does not settle who controls them. Free balances, committed backing, fees, bonds, and earned rewards need explicit owners and authorization rules. User signing, account recovery, and any delegated authority remain implementation decisions. Do not describe the system as noncustodial just because it uses Intents.

Dragon NFTs can continue to be staked in the Council's NEP-171 custody contract. Native NEAR used for contract storage and transaction gas is operational funding, not trading collateral. This decision does not move NFTs or gas deposits into Intents by implication.

## Target flow

```text
Supported origin wallet
  -> supported bridge / Intents route
  -> confirmed user balance inside Intents
  -> authorized transfer into controlled market escrow inside Intents
  -> funded position recorded by Dragons Market
  -> sell or final redemption releases eligible funds inside Intents
  -> available user balance inside Intents
  -> user-authorized external withdrawal / swap route
  -> confirmed destination-chain payment
```

"Market escrow" is a required property of the settlement design, not a feature automatically provided by the verifier. The contract owner must specify and prove how one or more Intents accounts enforce that control. Whether escrow is per market or shared with isolated accounting remains open. Do not expose a future adapter name as an already deployed contract or method.

Free user funds must cease to be freely spendable before they count as backing. An internal transfer between Intents accounts can keep tokens in the verifier while changing their ownership/control. A UI lock or database reservation over a user's otherwise freely spendable balance cannot back an issued prediction position.

Trade payment and position issuance must either be enforced as one supported atomic operation or use a recoverable sequence with authenticated confirmation, an operation ID, single-use completion, and a defined refund path. Do not assume separate asynchronous calls are atomic. The same requirement applies to selling, redemption, fee distribution, and bond/reward settlement.

## Accounting rules

- Choose one collateral token for the first market implementation, with its exact Intents token ID, issuer, and decimals verified. Funding may accept other supported assets and convert them into that collateral. Multi-asset deposits do not make market backing multi-collateral.
- Separate free user balances, market backing, pending transfers, fees, bonds, accrued rewards, and business revenue. These may be separate controlled Intents accounts or demonstrably isolated accounting domains; the contract design must say which.
- Each open complete set of Yes and No shares is backed by one collateral unit under market control inside Intents. Preserve the existing position/pricing invariants as applicable, including pool/seeder positions and post-resolution payout obligations. Released fees cannot remain counted as backing.
- One amount cannot simultaneously be available to its user, backing a position, and pending withdrawal. Intents balance reads alone are insufficient to determine a position's state; reconcile them with the settlement contract's liabilities.
- An outbound transfer is committed once, stays pending until reconciled, and completes only on verified settlement. Restore funds after an established failure, not after an API timeout.
- Observe deposits and transfers idempotently by verified receipt/event plus account/token/network and operation reference. A transaction hash alone may identify several relevant events.
- Use integer base units and explicit token decimals. Match actual receipts against signed limits, beneficiary, token, network, amount, expiry, and replay protection.
- The database is a projection and operation journal. Verifier records establish token custody; Dragons Market contracts establish positions, liabilities, and outcomes. No backend-only credit bypasses those authorities.

## Council, bonds, and revenue

The chosen fee split remains 25% to eligible staked Council seats and 75% to the business destination, subject to the existing contract rules. The custody migration does not change the economics or permit distributing backing as revenue.

Target fees, dispute bonds, juror compensation, reward balances, and business revenue remain in Intents until their authorized recipient withdraws. Existing `ft_transfer`/`ft_transfer_call` paths in the market, oracle, and Council therefore need an explicit migration. A token-balance read must not replace the Council's accrual or juror eligibility accounting.

Quarterly payout is the intended product cadence. Continuous accrual/streaming, fee allocation, claim eligibility, and actual transfers are different events. The latest contract review describes streamed accrual; any quarterly claim gate needs a separate implemented policy. Keep that distinction in the UI and submission materials.

## Existing prototype and migration gap

| Component | Existing behavior | Work needed for the accepted target |
| --- | --- | --- |
| `market` | Holds one NEP-141 collateral token; `ft_on_transfer` credits `sender_id`; `withdraw` sends tokens out. | Enforce Intents-held backing, identity binding, confirmed payment/position transitions, and Intents-based exits without keeping a second spendable balance. |
| `oracle` | Receives and settles fungible dispute bonds through its current token interface. | Retain case/vote rules while implementing authenticated, recoverable Intents-held bond and juror-payment settlement. |
| `council` | Holds staked NFTs and accounts for token rewards received through its current token interface. | Keep NFT staking and eligibility. Tie streamed/accrued reward liabilities and claims to the designated balances inside Intents. |
| `governance` | Owns platform contracts and executes approved calls after a timelock. | Specify its powers over settlement accounts/authorization and upgrades, and demonstrate that routine operator access cannot seize backing. |
| Frontend | Current view adapters and deliberately disabled financial writes target the existing contracts. | Add Intents identity, per-token balances, controlled-backing state, resumable funding/withdrawal status, and final-ABI transaction flows. |

The current `sender_id` credit rule is an explicit integration trap. Sending a NEP-141 `ft_transfer_call` from the verifier to the existing market identifies `intents.near`, not automatically the original depositor. Such a transfer also removes the asset from verifier custody. It is not the accepted target route.

The previous plan's Intents -> linked NEAR wallet -> NEP-141 market route is a legacy compatibility experiment only. It does not satisfy this custody decision and is not an automatic deadline fallback. If Intents-held escrow cannot be demonstrated safely, narrow the demo and report that limitation rather than silently changing custody.

## Implementation gates

Before enabling financial writes, the contract owner must deliver:

1. A concrete account/control diagram: free funds, escrow, bonds, fees, rewards, business funds, signing keys, delegation/revocation, and recovery.
2. A supported verifier authorization and transfer mechanism with versioned DTOs/ABI. Signature formats, contract IDs, gas, storage, and supported chains must be checked in current official docs and the selected deployment.
3. A proof that users cannot withdraw backing, that operators cannot substitute a beneficiary, and that replayed or unauthenticated confirmations cannot mint positions or pay twice.
4. Tested interrupted/failed operations in both directions, including callback failure, fee/reward transfers, and user exits when the backend is down. Define who can finish recovery and what evidence they need.
5. Reconciliation of controlled verifier balances against market liabilities and reward/bond obligations, with receipts and measurements from the exact tested build.
6. A migration or fresh-deployment decision for existing NEP-141 state. Do not silently treat old balances as new Intents credit or assume existing upgrade tests cover this new state model.

This is a contract change, not a frontend-only balance-provider swap. No contract code, deployment, or financial action is authorized or completed by this documentation edit.

## Evidence and sources

The public Degen Arena trace in [hackathon-plan.md](hackathon-plan.md#what-degen-arena-teaches-us) shows verifier-held token credit and signed internal transfers. It does not prove Degen Arena implements prediction-market escrow or establish who owns its internal signing key. Use it as an experience/reference flow, not a complete security design.

Official pages read on 2026-10-19:

- [Verifier balances and token IDs](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/balances): NEP-245 internal balances, `mt_balance_of`, and `mt_batch_balance_of`.
- [Deposits](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits): verifier credit and token ownership on deposit.
- [Withdrawals](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/withdrawals): exit methods and different failure/refund behavior when transfer-call messages are used. Verify the exact chosen method/schema before integrating.
- [1Click overview](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api): optional routing API. Its supported balance modes and routes must be verified for this design; its use by Degen Arena was not established.

The custody decision here takes precedence over older target designs. Contract manuals and dated audit entries continue to describe the code they reviewed; they are not evidence that this migration is already implemented.
