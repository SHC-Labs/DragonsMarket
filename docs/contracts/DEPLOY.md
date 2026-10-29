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
6. [Release and verification](#release-and-verification)
7. [View cost at scale](#view-cost-at-scale)

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
- [ ] Register the market account with the collateral token (`storage_deposit` on the token, once)
      and send a small token `deposit`. Until then the token refuses `ft_transfer_call` to the market,
      so only the Intents path can fund it, and `keeper.mjs check` reports it.
- [ ] Show committed backing remains controlled inside Intents and reconciles with positions.
- [ ] Verify buy, sell, Yes/No/Void redemption and available-balance withdrawal.
- [ ] Complete the oracle bond/juror-payment migration to Intents.
- [ ] Run at least `price_threshold` publishers (`keeper/publisher.mjs`), each on its own host with its own key, and
      have the DAO add each key with `add_publisher`. Run `keeper/resolver.mjs run` on a schedule from an account that
      holds only the bond float in Intents, and answer event markets with `resolver.mjs propose` (see "Publishing and
      submitting prices" in [oracle.md](oracle.md)). Without them every market Voids at its `resolve_by`.
- [ ] Verify earned-fee allocation: 75% treasury and 25% Council-controlled rewards, with the real
      treasury account (see the configuration order below).
- [x] Quarterly entitlement and claim rules, with repeat and cross-path claims refused (built
      2026-10-21, sandbox and unit tests in [AUDIT.md](AUDIT.md#fee-split-and-quarterly-claims-2026-10-21)).
      A run against the real USDC contract and a real DAO is still open.
- [ ] Run a testnet load test before adding any second market instance: parallel signers sending buys,
      recording the transactions included per block and the rejections, over the complete deposit,
      trade, callback, settlement and fee-sweep paths.
- [ ] Test interrupted callbacks, uncertain transfers, retries, restarts and backend-down recovery.
- [ ] Verify selected provider fees, slippage, refund behaviour and destination confirmation.

### Configuration order

Nothing the owner still has to choose is written in the contracts or taken by `new`. The market and
the Council deploy with no fee recipient and no NFT collection, and the Council deploys with no market
on its allow-list. They refuse to sweep, take revenue, stake or pay a claim until the owner has set them.
The oracle's `new` takes the market account, which becomes the first entry of its allow-list. Each step below is an owner call, a DAO
proposal once the DAO owns the contract, and the helper in `contracts/keeper` prepares each one.

| Step | Contract | Call | Notes |
| ---- | -------- | ---- | ----- |
| 1 | council | `set_nft_contract(nft_contract)` | Only while nothing is staked. The collection must have a fixed supply with minting closed first. |
| 2 | council | `allow_tokens(token_ids)` or `set_token_range(first, last)` | The allowlist starts on with nothing allowed. |
| 3 | council | `allow_market(market)` | The market contract. Revenue and claims refuse until a market is on the list. The last entry cannot be removed, so add a new market before `disallow_market` on the old one. |
| 4 | council | `set_close_grace_ns(close_grace_ns)` | Optional. 7 days to start, 1 to 30 days allowed. This is the wait after a quarter ends before it can be finalized and claimed. |
| 5 | market | `set_fee_recipients(revenue_pool, treasury)` | The Council contract and the verified Trezu treasury. A sweep refuses until it is set. Read the treasury account back from the DAO before the proposal. |
| 6 | market | `set_revenue_share_bps(revenue_share_bps)` | Optional. 2,500 (25% to the Council, 75% to the treasury) to start, 1,000 to 5,000 allowed. |
| 7 | market | `set_min_sweep(min_sweep)` | Optional. 1,000,000 units to start, 1 to 100,000,000 allowed. |
| 8 | market | `set_next_sweep_id(next_sweep_id)` | Only when this market replaces an older one that already sent sweeps to the same Council. The Council refuses a sweep id it has taken, so start above the highest. It can only move up. |

Send a small sweep after step 5 and read both Intents balances, the sweep record (`get_sweep`) and
the Council's `received_of`. The keeper sweeps when fees reach its own threshold (10 units to start),
which is above the contract's minimum, and never within an hour of the last sweep. The keeper also calls the market's `settle_leg`
and the Council's `advance_quarters` and `finalize_quarter`; its function call keys need those methods (see the header of `keeper.mjs`).

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
- [ ] Create markets from a dedicated operator account, not the DAO owner account.
- [ ] Market state version 6 (dynamic parimutuel pricing) upgrades a version-5 market only while it
  has created no market. A version-5 deployment that has markets is not upgraded: deploy version 6
  fresh, stop creating markets on the old one, and let its markets resolve and pay out there.

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

Do not open the venue until `keeper.mjs check` shows enough drawable seat holders (jury size
+ second jury + 2; a seat that is serving or asked to leave does not count). After the contracts
are sealed, `keeper.mjs check --expect-sealed` is the release gate.

Launch only against evidence for [R-01 through R-08](../spec.md#requirements-to-implementation-map),
with the implemented limitations disclosed. Publishing, deployment and real-money testing need
explicit authorisation. This document records requirements and does not perform those actions.

## Release and verification

The wasm hashes of a release are what lets the DAO and the keeper agree on what runs. Do these in
order.

1. Build reproducibly. From `contracts/`, with every change committed and docker running, run
   `./release.sh`. It runs `./build.sh --reproducible`, checks the three wasm files and prints the
   release message on stdout: `Release hashes`, a blank line, one `<contract> sha256:<hex>` line each
   for market, oracle and council, then `commit <hash>` and `toolchain <version>`. Build on a second
   machine and compare the hashes before going on.
2. Run the build check. `node verify-build.mjs target/near/market/market.wasm
   target/near/oracle/oracle.wasm target/near/council/council.wasm` (`release.sh` already does this).
   It reads the source metadata embedded in each wasm and prints the crate, the wasm sha256, the
   commit and the image digest.
3. Publish the hash list in the message of an annotated git tag (`git tag -a <tag name>`, with the
   release message as its message), made by a person. Never commit the hashes to a file: the commit
   is baked into the wasm, so a commit that holds its own hashes changes them. No script here
   creates the tag.
4. Stage the wasm and let the DAO vote on the code hash. Members compare the hash in the proposal
   with the tag message before approving.
5. After an upgrade, run the keeper check against the tag (it also confirms the market is on the oracle's and the Council's allow-list). Save the tag message
   (`git tag -l --format='%(contents)' <tag name>`) and pass it with `--release <file>`, or `-` for
   stdin, as in `node keeper/keeper.mjs check --rpc <url> --market <id> --oracle <id> --council <id> --rounds <id> --release <file>`. Without `--rounds` the check reports a problem, because the rounds contract's stakes, fees and keys would go unchecked. A match prints `release: live code matches the release hash list`. Any contract whose live code hash differs from the tag is reported and the check exits 1.
6. Refuse to deploy a build whose embedded build info is empty. A wasm from `./build.sh` has
   `build_info` null and `verify-build.mjs` rejects it. Only a build from `./build.sh --reproducible`
   passes.

---

## View cost at scale

Measured 2026-10-22, and again after the account index and the `entitlements_of` cap, in the NEAR sandbox with `contracts/tests/tests/scale.rs`. Each view method was
also sent as an ordinary transaction with 300 TGas attached, and the gas burnt is the figure below.
It includes a fixed transaction cost of about 1.7 TGas (what `total_owed`, which only reads a
counter, burns). A public RPC limits a view call to about 200 TGas. The sandbox does not enforce
that limit on views, so only the gas column shows whether a view fits.

World at N = 300: 50 cases with a proposal each (3 of them challenged), the newest 50 markets
seeded and traded, the newest 20 holding positions for one account, one market with a full
120-point price history, and 105 staked Council seats.

| View | N markets | Gas (TGas of 200) | ms |
| --- | --- | --- | --- |
| market `total_owed`, `in_flight`, `owed_breakdown`, `list_sweeps` | 300 | 1.7 to 1.8 | 0 to 1 |
| market `list_markets` (50, bare markets / traded markets) | 300 | 9.3 / 9.7 | 11 / 9 |
| market `get_history` (120 points) | 300 | 2.6 | 2 |
| market `get_positions` (20 held) | 300 / 600 / 1,200 | 7.1 / 7.1 / 7.1 | 2 / 3 / 3 |
| market `get_account` (20 held) | 300 / 600 / 1,200 | 7.1 / 7.1 / 7.1 | 2 / 1 / 1 |
| market `get_positions` (1 held, newest market) | 300 / 600 / 1,200 | 2.2 / 2.1 / 2.1 | 1 / 1 / 1 |
| market `get_account` (1 held, newest market) | 300 / 600 / 1,200 | 2.4 / 2.3 / 2.3 | 1 / 1 / 0 |
| oracle `list_cases` (50, 50 cases) | 300 | 7.3 | 5 |
| oracle `bond_totals`, `total_owed` | 300 | 1.7 | 1 |
| council `list_quarters` (50) | 300 | 6.7 | 4 |
| council `reward_totals` | 300 | 1.7 | 0 |
| council `entitlements_of` (25 quarters, account with 10 seats) | 300 | 56.9 | 6 |
| council `entitlements_of` (50 asked, clamped to 25, 10 seats) | 300 | 56.9 | 5 |
| council `staked_tokens` (105 seats) | 300 | 9.6 | 3 |

Before and after, in TGas:

| View | Before | After |
| --- | --- | --- |
| `get_positions` and `get_account`, 20 held | 72.4 at N = 300 | 7.1 at N = 300, 600 and 1,200 |
| `get_positions`, 1 held in the newest market | 142.0 at N = 600, 282.4 at N = 1,200 | 2.1 at N = 600 and 1,200 |
| `get_account`, 1 held in the newest market | same as `get_positions` | 2.3 at N = 600 and 1,200 |
| `entitlements_of`, 10 seats, 50 quarters asked | 111.6 | 56.9 (clamped to 25 quarters) |

The market keeps, for each account, the sorted list of market ids in which it holds shares, updated
only where a share entry is created or removed. `get_positions` reads that list instead of scanning
market ids from 0, so its cost follows the number of positions (about 0.27 TGas each) and not the
number of markets. `get_account` calls it and costs the same. Writing the list costs a trade a
read and a write of one record of 8 bytes per market the account holds. An ordinary account holds
at most 20; the operator and the owner, who are not held to that cap, can hold one per market, and
a record of 1,000 markets is 8 KB. `entitlements_of` walks at most 25 quarters, and each quarter costs a
lookup for every token the account has ever staked, so its gas also grows with the number of
seats; only an account with 10 seats was measured.

`create_market` burns 7.3 TGas in all (the oracle registration included), but needs at least 40
TGas attached (30 ran out of gas; sizes above 40 were not tried, and nothing between 30 and 40). Six calls of 45 TGas fit in one 300 TGas transaction.

Rerun (about 12 minutes):

```
cd contracts && SCALE_MARKETS=300 cargo test -p tests --test scale -- --ignored --nocapture --test-threads=1
```

For launch: `get_positions` and `get_account` burned under 8 TGas at 300, 600 and 1,200 markets
and did not grow with the number of markets. `entitlements_of` burned 56.9 TGas for an account
with 10 seats and is capped at 25 quarters per call. Every other view measured stays under 10 TGas.
Not measured: an account with more than 10 seats on `entitlements_of`, an operator holding a position
in hundreds of markets on `get_positions`, a Council with revenue in many quarters, and views with
more than 120 history points (the cap).
