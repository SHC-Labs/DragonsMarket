# Contract authority before deployment

Initial authorization review on 8 November 2026 used source revision
`6602a4b63942da799546ce93e10fe4079f6d6cee`. This is an authorization-focused source review,
not a complete economic audit, deployed-code approval or completed DAO handover.
The intended deployment parent is `dragonsmarket.near` and the proposed owner is
`dragonsmarket.sputnik-dao.near`; final child accounts, treasury and publisher identities
still require the team's release manifest. At finalized block 223711328 the proposed DAO
had no account keys, but its Approver role allowed one of five members to approve calls
and transfers. That policy is not approved for ownership handover. Admin thresholds do
not override another role's call permissions.

## Caller map

The four financial contracts compare `predecessor_account_id()` with stored roles.
Set `owner_id` to the actual DAO account. A DAO member signing directly, the deployment
parent and a fee recipient do not inherit owner authority. Ownership can later move through
`propose_owner` and `accept_owner`; no hardcoded account replacement is required.

| Caller | Intended operations | Current boundary |
| --- | --- | --- |
| DAO owner | Upgrade/seal, ownership transfer, fees/destinations, publisher additions/quorum, configuration and reconciliation | Stored owner must be the immediate predecessor. DAO policy executes outside these contracts. |
| Operator | Market creation, intake pause, caps, registration retry and residual handling; publisher removal; rounds series/pause | Owner-or-operator checks. Market `set_paused` and rounds pause permit both pause and unpause. Market `resume` and sells pause are owner-only. |
| User wallet | Own trades, redemption, withdrawals, Council staking/rewards and rounds positions | Predecessor ownership; financial transaction methods generally require one yoctoNEAR. Market redemption credits the caller; rounds claim may be triggered by anyone but credits the stake owner. See the unstake finding below. |
| Publisher | Authorize observed prices | Configured distinct Ed25519 signatures meeting a threshold. These are message-signing keys, separate from transaction access keys. |
| Relayer / keeper | Relay prices or advance already-authorized settlement | Price relay still needs publisher signatures. Maintenance uses state/time checks, not DAO authority. Oracle price proposals additionally spend the submitter's bond. |
| Verifier / token / NFT | Deliver authenticated funds, user intents or NFTs | Exact configured predecessor, asset and ownership checks. These hooks must not become DAO-only. |
| Contract callback | Apply asynchronous outcomes | Private self-call plus operation-specific state/results. Contract-account keys are privileged because they can satisfy a self-call guard. |

Sources: [market](../contracts/market/src/lib.rs), [oracle](../contracts/oracle/src/lib.rs),
[Council](../contracts/council/src/lib.rs), [rounds](../contracts/rounds/src/lib.rs).
The table describes the implemented split; it does not approve the final DAO's policy.
In particular, decide whether operator unpause is intended before changing that behavior.

## Initializer manifest

All four `new` methods are both private and one-time. Initialization must execute as the
contract account itself. A parent-created child followed by a parent-predecessor call to
`new` does not satisfy that guard. Verify the deploy-and-initialize transaction shape in
the deployment tooling before using it on mainnet.

| Contract | Exact initializer fields |
| --- | --- |
| Market | `owner_id`, `operator_id`, `oracle_id`, `verifier_id`, `collateral_token_id` |
| Oracle | `owner_id`, `market_contract`, `verifier_id`, `collateral_token_id`, `bond`, `window_ms`, `panel_deadline_ms`, `draw_window_ms`, `council`, `jury_size`, `draw_delay_blocks`, `min_proposal_ms`, `operator_id`, `network`, `price_threshold`, `no_decision_recipient` |
| Council | `owner_id`, `oracle_id`, `verifier_id`, `collateral_token_id`, `cooldown_ns`, `max_seats_per_account`, `allowlist_enabled` |
| Rounds | `owner_id`, `operator_id`, `verifier_id`, `collateral_token_id`, `network`, `price_threshold` |

Serialize `U64`/`U128` values as decimal strings; account IDs and `network` are strings,
`u32` values are numbers, and `allowlist_enabled` is an optional boolean. Use the exact
`nep141:<token-account>` collateral identifier consistently. Approve the oracle's dispute
timings and recipients as well as addresses. Read back every value after initialization.

Initialization is not complete configuration: Market starts without fee recipients,
Council without a collection or allowed markets/tokens, and Rounds without a treasury.
Council's token allowlist defaults to enabled. Follow the configuration order in
[deployment gates](contracts/DEPLOY.md). The branch changes below close the identified tooling gaps;
the deployment and handover still need their own evidence.

## Branch fixes and remaining decisions

1. **Council unstake consent.** The reviewed revision accepted zero deposit for
   `request_unstake(token_id, accepts_cut)`. A compromised user FunctionCall key already permitted to
   invoke that method can cut half the seat's running-quarter earnings and stop earning.
   It cannot act for an unrelated owner or return the NFT. No affected live user keys were
   established. This branch adds `#[payable]` and `assert_one_yocto` before any mutation,
   and updates wallet calls and current-contract fixtures. Regression tests cover unchanged
   rewards on refusal, restricted-key rejection and full-access wallet success. Deploy the
   contract before the updated browser: the old nonpayable method rejects the new deposit.
   Historical v5 migration calls remain unchanged.
2. **Rounds DAO tooling.** `contracts/keeper/treasury.mjs` now validates proposals for
   all four financial contracts, including Rounds treasury, series, publishers and upgrades.
   Rounds stays optional for a human-only profile, but its calls require an explicit ID.
   Proposal and stored-vote validation share the argument/deposit/gas schema; source-coverage
   tests scan all four contracts. Oracle bounds now match its minimum jury of 5, minimum bond
   of 5 USDC, dispute windows of 1 hour to 365 days and maximum draw delay of 100,000 blocks.
   The helper prepares unsigned wallet calls; it does not
   replace contract authorization. The combined [DAO/keeper integration test](../backend/test/dao-chain.test.ts)
   now submits these exact wallet requests through checksum-pinned Sputnik WASM on a sandbox,
   including publisher replacement, upgrades and key removal. Final DAO policy and deployed
   custody still require their own acceptance evidence.
3. **Publisher bootstrap and rotation.** At 1-of-1, adding a second publisher violates
   strict majority, raising the threshold violates the current count, and removing the
   only publisher violates availability. It cannot grow or rotate using normal setters.
   The branch adds owner-only `set_publishers(publishers, threshold)` to Oracle and Rounds.
   It validates the entire nonempty, bounded, duplicate-free Ed25519 set and strict-majority
   threshold before replacing either field. Existing incremental setters remain available.
   The DAO proposal monitor flags replacement for manual review. No storage layout changes.
   Coordinate publishers before rotation: removed keys cannot authorize new submissions,
   including messages signed before rotation. Already-recorded observations stay intact.
4. **Production NFT.** `contracts/mock-nft` explicitly says test-only. It offers owner-only
   nonpayable minting, no public purchase interface and none of the financial contracts'
   upgrade/seal path. Supply, sale price/storage, mint authority and upgrade policy need
   the actual production implementation. Existing deployment guidance requires fixed
   supply with minting closed before Council configuration; reconcile that rule with the
   requested public mint before enabling staking and jury selection.

No outsider bypass of the reviewed DAO, verifier or callback guards was identified.
That is a bounded source result, not proof of complete security or live custody.

## Price and keeper schemas

Oracle signatures cover
`price:v2:<oracle>:<network>:<market>:<market_id>:<observation_time>:<price>:<decimals>`.
Rounds signatures cover
`round-price:v1:<rounds>:<network>:<asset>:<at>:<price>:<decimals>`.
Both require distinct approved signers; changing contract IDs or network changes the
signed message. Relayers cannot invent an authorized price merely by paying gas.

Oracle submission transfers the exact bond through the verifier. The current resolver
requires its own FullAccess transaction key because the transfer attaches one yoctoNEAR;
that account should hold only its approved gas/bond float. It must never use a contract,
DAO or treasury key. Rounds `record_price` is a zero-deposit signed-price relay.

The maintenance keeper uses its own account and separate finite-allowance FunctionCall keys:

| Receiver | Allowed methods |
| --- | --- |
| Oracle | `finalize`, `resolve_draw`, `retry_apply`, `retry_unlock`, `resolve_by_deadline`, `payout_bond` |
| Market | `sweep_fees`, `settle_leg` |
| Council | `advance_days` |
| Rounds, when configured | `sweep_fees` |

Require scoped-key mode. The maintenance keeper pays due Oracle bonds only to their owners
and sweeps Rounds fees only to the configured treasury. It does not publish prices or place
trades. The Railway `prices` collector is not a substitute for publishers or a resolver.

## Keyless handover evidence

Keyless financial contract accounts can still accept user and keeper calls and execute
DAO-authorized upgrades. Deleting access keys changes account permissions without a
WASM upgrade. Changing the coded authorization rules requires a reviewed code release.

Before deleting keys, prove the actual DAO can configure and upgrade each financial
contract, including a failed-call recovery. `seal(public_key)` requires a prior successful
upgrade and deletes one named NEAR key. Inventory all keys and read back the successful
deletion; do not infer success from submitting a transaction.

Verifier-registered public keys are a separate custody namespace. Inspect them and the
verifier's predecessor-authentication settings separately; `remove_verifier_key` removes
one such key and must also be verified. A retained verifier key can bypass an otherwise
keyless account's collateral custody. Never retain keeper keys on contract accounts.

The backend activation approval now checks both RPC providers at the same recent finalized
block. Market, Oracle, Council and optional Rounds must have no NEAR access keys.
The NFT follows its [explicit custody policy](NFT-CUSTODY.md); the accepted Cookon platform
key is pinned with its collection, stored owner and reviewed code instead of requiring removal.
Every financial contract must have proven its upgrade path, have no registered Intents keys,
have predecessor authentication enabled and be unlocked. The verifier must permit `mt_transfer`.
Missing, malformed or disagreeing responses fail closed. The approval also pins the owner's
DAO code and policy, requires a keyless DAO account, and checks every approving role against
the reviewed minimum vote count. The Oracle's no-decision recipient is pinned to the treasury.
This observes custody and policy; it does not remove keys or prove production execution history.

Ethereum-style implicit financial accounts (`0x` followed by 40 hex characters) are refused
by activation and the standalone custody check. In the pinned Intents implementation,
`public_keys_of` can return an empty list while `has_public_key` still accepts the implicit
secp256k1 key. Use named contract accounts for the planned deployment. The sandbox regression
`an_empty_intents_key_list_does_not_prove_an_eth_implicit_account_is_keyless` demonstrates
the distinction using read-only calls to the pinned verifier.

Correction to the original review: the standalone keeper's `check --expect-sealed` already
includes Rounds when `--rounds` is supplied. It also checks the Council's NFT collection;
pass `--nft-custody FILE` with the same reviewed policy used by the backend approval.
`verify-chain` verifies indexed database history, not access-key removal. Keep the reviewed
DAO policy, removal receipts and actual upgrade/recovery evidence alongside activation results.

Required handoff: final account/initializer manifest, approved source/build/WASM hashes,
actual DAO policy and execution receipts, publisher quorum/custodians, production NFT
policy, complete key inventories and removal receipts, funded acceptance, and a plan for
the rehearsal deployment's existing positions. Do not overwrite its deployment record.
