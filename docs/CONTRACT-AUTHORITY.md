# Contract authority before deployment

Reviewed the current private branch on 8 November 2026, source revision
`6602a4b63942da799546ce93e10fe4079f6d6cee`. This is an authorization-focused source review,
not a complete economic audit, deployed-code approval or completed DAO handover.
The intended deployment parent is `dragonsmarket.near`; final child accounts, DAO owner,
treasury and publisher identities are not yet specified.

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
[deployment gates](contracts/DEPLOY.md), subject to the tooling gap below.

## Findings to close before the final build

1. **Council unstake consent.** `request_unstake(token_id, accepts_cut)` at Council line
   1104 accepts zero deposit. A compromised user FunctionCall key already permitted to
   invoke that method can cut half the seat's running-quarter earnings and stop earning.
   It cannot act for an unrelated owner or return the NFT. No affected live user keys were
   established. Make it payable with `assert_one_yocto`, update the web call and every
   test/caller, then prove restricted-key rejection and normal wallet success. This review
   has not changed the Rust method or frontend deposit.
2. **Rounds DAO tooling.** `contracts/keeper/treasury.mjs` validates proposals only for
   Market, Oracle and Council. Rounds owner methods, including `set_treasury`, need the
   same reviewed argument/deposit/gas schema and proposal/vote tests. Existing tests scan
   only those three targets. The helper prepares unsigned wallet calls; it does not
   replace contract authorization or prove real DAO execution.
3. **Publisher bootstrap and rotation.** At 1-of-1, adding a second publisher violates
   strict majority, raising the threshold violates the current count, and removing the
   only publisher violates availability. It cannot grow or rotate using normal setters.
   Choose the quorum first. For an approved 2-of-3 design, initialize threshold 2, then
   add the three independent keys before accepting price-based markets. An atomic
   publisher-set replacement would be a separate reviewed contract change.
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

The maintenance keeper uses its own account and three finite-allowance FunctionCall keys:

| Receiver | Allowed methods |
| --- | --- |
| Oracle | `finalize`, `resolve_draw`, `retry_apply`, `retry_unlock`, `resolve_by_deadline` |
| Market | `sweep_fees`, `settle_leg` |
| Council | `advance_days` |

Require scoped-key mode. The maintenance keeper does not publish prices or operate
Rounds. The Railway `prices` collector is not a substitute for publishers or a resolver.

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

The current activation approval checks hashes, owners and contract links; it does not
inventory either key namespace. The standalone keeper's `check --expect-sealed` checks
Market, Oracle, Council and NFT, but not Rounds. `verify-chain` verifies indexed database
history, not access-key removal. Complete and record the missing Rounds/keyless checks
before launch; a green activation check alone does not establish keyless custody.

Required handoff: final account/initializer manifest, approved source/build/WASM hashes,
actual DAO policy and execution receipts, publisher quorum/custodians, production NFT
policy, complete key inventories and removal receipts, funded acceptance, and a plan for
the rehearsal deployment's existing positions. Do not overwrite its deployment record.
