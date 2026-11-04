# Dragons Market: deployment gates

Release requirements for Intents-backed settlement and Trezu/Sputnik administration.

| Field | Value |
| --- | --- |
| Updated | 1 November 2026 |
| Status | Integration is built. Open gates: the real treasury and DAO handover, a run against real USDC, the live funding and withdrawal flow and the owner's financial approval. Not an executable deployment recipe |
| Contract work | Contract team |
| Financial deployment approval | Project owner |
| Product authority | [Specification](../spec.md) |

## Contents

1. [Required deployment records](#1-required-deployment-records)
2. [Settlement and rewards](#2-settlement-and-rewards)
3. [Administration and upgrades](#3-administration-and-upgrades)
4. [Website and operations](#4-website-and-operations)
5. [Opening the venue](#5-opening-the-venue)
6. [External trust](#external-trust)
7. [Pre-launch monitoring](#pre-launch-monitoring)
8. [Known limits and sizing](#known-limits-and-sizing)
9. [Release and verification](#release-and-verification)
10. [View cost at scale](#view-cost-at-scale)

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
      so only the Intents path can fund it and an agent cannot be funded to trade, and `keeper.mjs check` reports it.
- [ ] Register the rounds account with the collateral token the same way, and send a small token `deposit`. Until then
      every `deposit` and `deposit_for` by token is refused, so an agent cannot be funded. `keeper.mjs check --rounds <id>`
      reports it.
- [ ] Show committed backing remains controlled inside Intents and reconciles with positions.
- [ ] Verify buy, sell, Yes/No/Void redemption and available-balance withdrawal.
- [ ] Prove oracle bonds and juror pay end to end through Intents (`mt_on_transfer` with `propose:` and `challenge:`).
- [ ] Deploy rounds and the oracle with `price_threshold` of at least 2. `add_publisher` keeps the threshold above half
      of the publishers and `set_price_threshold` cannot go above how many there are, so a contract started at 1 stays
      on one publisher until an upgrade. Start at 2, which takes up to 3 publishers, and raise it as more join.
- [ ] Build the site with `NEXT_PUBLIC_AGENT_WALLET_CONTRACT` set to the worker's `AGENT_API_WALLET_CONTRACT` and
      `NEXT_PUBLIC_AGENT_API_HOST` set to the host of its `AGENT_API_URL`. Without them the site refuses every agent
      request before the wallet, so nobody can open an agent.
- [ ] Run at least `price_threshold` publishers (`keeper/publisher.mjs`), each on its own host with its own key, and
      have the DAO add each key with `add_publisher`. Run `keeper/resolver.mjs run` on a schedule from an account that
      holds only the bond float in Intents, and answer event markets with `resolver.mjs propose` (see "Publishing and
      submitting prices" in [oracle.md](oracle.md)). Without them every market Voids at its `resolve_by`.
- [ ] Verify earned-fee allocation: 75% treasury and 25% Council-controlled rewards, with the real
      treasury account (see the configuration order below).
- [x] Revenue share rules, with repeat and cross-path claims refused (Council state version 6, "pay by arrival,
      claim by quarter", unit tests).
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
| 4 | market | `set_fee_recipients(revenue_pool, treasury)` | The Council contract and the verified Trezu treasury. A sweep refuses until it is set. Read the treasury account back from the DAO before the proposal. |
| 5 | market | `set_revenue_share_bps(revenue_share_bps)` | Optional. 2,500 (25% to the Council, 75% to the treasury) to start, 1,000 to 5,000 allowed. |
| 6 | market | `set_min_sweep(min_sweep)` | Optional. 1,000,000 units to start, 1 to 100,000,000 allowed. |
| 7 | market | `set_next_sweep_id(next_sweep_id)` | Only when this market replaces an older one that already sent sweeps to the same Council. The Council refuses a sweep id it has taken, so start above the highest. It can only move up. |
| 8 | rounds | `set_treasury(treasury)` | The verified Trezu treasury. `sweep_fees` refuses until it is set. |

Send a small sweep after step 4 and read both Intents balances, the sweep record (`get_sweep`) and
the Council's `received_of`. The keeper sweeps when fees reach its own threshold (10,000,000 units to start),
which is above the contract's minimum, and never within the sweep interval of the last sweep (60 minutes at the least). The keeper also calls the market's `settle_leg`
and the Council's `advance_days`, which closes quarters and starts seats that are due; its function call keys need those methods (see the header of `keeper.mjs`). The keeper has no finalize or quarter job: a quarter becomes claimable when any call walks the days past its end, and every claim does that itself.

Existing market and Council Intents code is part of this work. Its presence does not establish
that the complete production journey has passed. The [verifier proof](INTENTS-PROOF.md) retains its original test scope.

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
- [ ] Council deploy: `new` takes no collection and no market. Then run the configuration order above
  (`set_nft_contract`, the allowlist, `allow_market`) before announcing staking. A seat staked on UTC day D
  starts earning on day D+1.
- [ ] Upgrade each contract in this order: `stage_code` with the new wasm (the deposit is about 1 NEAR per 100 KB of
  code, stays in the contract and is not refunded when the upgrade runs), have the DAO vote on the code hash, then
  `upgrade` with at least 100 TGas (exactly 100 works). A failed or rolled-back upgrade consumes the staged code, so
  stage it and pay the deposit again before the next attempt. Upgrading to identical code works and leaves the code
  hash unchanged.
- [ ] Check the state version each `migrate` reads. A version it does not know refuses and the whole upgrade reverts.

  | Contract | State version | `migrate` accepts |
  | --- | --- | --- |
  | market | 8 | 5, 6, 7, 8 |
  | oracle | 3 | 2, 3 |
  | council | 6 | 5, 6 |
  | rounds | 3 | 1, 2, 3 |

- [ ] Council version 5 to 6. `migrate` refuses, and the whole upgrade reverts, unless every quarter that has ended
  is finalized, no claim is pending, no unstake is waiting for its NFT transfer, and the money of finalized quarters
  is claimed (up to 1,000 units of rounding for each finalized quarter is allowed). Finalize and let holders claim
  before staging. Open revenue and the rounding left behind wait in the carry and are shared at the next sweep.
  Existing seats that had not asked to leave start earning the next UTC day, and nothing is claimable until the
  running quarter ends. After the upgrade, read `config` (`state_version` 6) and `quarter_info`, and check that
  `seat_count` is unchanged.
- [ ] Market. A version-5 market (constant-product pricing) upgrades only while it has created no market. A version-5
  deployment that has markets is not upgraded: deploy the current version fresh, stop creating markets on the old one,
  and let its markets resolve and pay out there. A version-5 or version-6 market gets the pool ceiling of 100,000
  tokens it was running with, so set `set_max_market_locked` after the upgrade. A market halted before version 8
  stays halted until the owner calls `resume`.
- [ ] Oracle version 2 to 3. `migrate` refuses while the price threshold is not more than half of the publishers, or
  while the bond, a window or the jury size is below its floor. Fix the setting in the old code first.
- [ ] Rounds version 1 to 2. State version 1 had no treasury; `migrate` leaves it unset. It refuses while the price
  threshold is not more than half of the publishers.

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

Set the market caps against the oracle bond before opening the venue: `set_max_market_locked` (owner) is the most any market can hold, and `set_market_cap` (operator or owner) lowers it for one market. A wrong answer costs the bond, so a market should not hold much more than that bond can answer for. Rounds series set their own `close_before` (from half the interval up to just under a whole interval) when they are added.

Two checks before an owner call that settles something by hand. `reconcile_leg` with `arrived=false` on a Council leg puts the amount back into `revenue_due` without asking the Council, so read the Council's `received_of` for that sweep first: if it holds a record, the money arrived. Do not upgrade the Council while an unstake is waiting for its NFT transfer, because the new version starts its in-flight count at zero. The version 5 to 6 migration refuses in that case.

Do not open the venue until `keeper.mjs check` shows enough drawable seat holders (jury size
+ second jury + 2; a seat that is serving or asked to leave does not count). After the contracts
are sealed, `keeper.mjs check --expect-sealed` is the release gate.

The number is not arbitrary. A first jury of 5 that stays silent escalates to a second jury of 11, and the first 5 seats stay
serving until the case ends, so 16 distinct holders must be free, plus the proposer and the challenger if they hold seats.
With fewer, the draw is refused and the case ends with no decision at `draw_by`: an event market is voided and both bonds go
back, so a challenge costs almost nothing and someone who expects to lose can challenge a correct answer to cancel the market.
A price market keeps its signed price and is not affected. Run `keeper.mjs check` from a scheduler at least hourly and alert on
a non-zero exit. While it reports too few drawable holders, the operator and the owner (who alone create markets) open no new
event markets. Markets already open keep running.

Launch only against evidence for [R-01 through R-08](../spec.md#requirements-to-implementation-map),
with the implemented limitations disclosed. Publishing, deployment and real-money testing need
explicit authorisation. This document records requirements and does not perform those actions.

## External trust

Funds held in the Intents verifier (`intents.near`) depend on two parties outside this project:

- The verifier has admin roles, such as `force_transfer`, that the DAO of the verifier controls.
  That DAO can move balances out of any account inside the verifier, including the market,
  oracle, Council and rounds contracts.
- The USDC issuer can freeze balances of the token. A frozen balance cannot be withdrawn from
  the verifier or paid out by the contracts.

Neither is under our control and neither is visible in this repository. Users must be told
before they deposit, in the terms and next to the deposit button. The keeper check lists open
proposals that name the verifier (`--watch-dao`), which covers our own DAO only, not the
verifier's.

---

## Pre-launch monitoring

Set these up and see each alert fire in a test before opening the venue. Each row is a check
and the condition that must page a person.

| Check | How | Alert when |
| --- | --- | --- |
| DAO proposals on the owner account | `keeper.mjs check --treasury <dao> --watch-dao` | Any problem line: a proposal that changes control, money or dispute settings, names the verifier or the NFT collection, or is not on the allow-list |
| Ownership and destination drift | `keeper.mjs check --treasury <dao> --operator <id>` | An owner, pending owner, treasury, fee recipient or no-decision recipient that is not the DAO, or an operator that is not the expected one |
| Fee settings drift | `keeper.mjs check --expect-fee-rate-bps N --expect-max-fee-rate-bps N --expect-revenue-share-bps N` | The market's fee rate, fee rate ceiling or revenue share differs from what the DAO announced. Pin the ceiling to the intended rate, so the owner must raise the ceiling in a separate step before it can raise the fee. Each option is compared only when given |
| Verifier keys | `keeper.mjs check` reads `public_keys_of` in the verifier for market, oracle, council and rounds | Any registered key for any of the four contracts, predecessor authentication off, account locked, or `mt_transfer` paused |
| Access keys | `keeper.mjs check --expect-sealed` | Any access key left on a contract after sealing, or any new key on the NFT collection |
| Code hash | `keeper.mjs check --release <file> --rounds <id> --treasury <dao>` | A live hash that differs from the release list, or an upgrade proposal whose hash is not in it |
| Council seat ownership | `keeper.mjs check` (drawable seat holders against jury size) | Fewer drawable holders than jury size + second jury + 2 (why, and what to do: section 5), or the NFT collection's code differs from `--collection-code-hash` |
| Keeper health | The keeper's state file and events file, and `keeper.mjs check` margins | The keeper's last finished run is older than twice the market's `min_sweep_interval_minutes` (the hard floor is 60 minutes, so 120 minutes at the floor), a job failing repeatedly, or an account below `--min-margin` |
| Liveness of price publishing | `GET /price?market=<id>&id=<market id>` on every publisher for an open price market whose observation time passed more than two minutes ago | Fewer publishers answering than the oracle's price threshold, or a publisher key that is not in the oracle's publisher list |

Each publisher keeps the one price it signed per market in a JSON file (`--price-file` or `PUBLISHER_PRICE_FILE`, default `publisher-prices.json` in its working directory). Back it up and keep it across restarts; a corrupt file stops the publisher from starting.

Publishers: the operator can remove publishers down to the threshold. The owner should watch
publisher changes (`add_publisher`, `remove_publisher`, `set_price_threshold`) and compare the
oracle's `publishers` list with the expected keys on a schedule. A publisher list shortened to
the threshold lets fewer keys decide every price market.

---

## Known limits and sizing

- `market.buy_for` is a private method and is not bound to a recorded id. It is reachable only
  by the market contract's own key, and the market has no access keys after `seal`. Before
  seal that key can call it. This is accepted for the launch, which is why sealing is a launch
  gate.
- Market cap. The cap (`set_max_market_locked`) is 100 times the oracle bond. Recommended launch
  values: bond 100 USDC (`100000000` units) and cap 10,000 USDC (`10000000000` units). The code
  floors are a bond of at least 5 USDC, a jury size of at least 5 and every window at least 1
  hour. The floors are enforced by the oracle and the owner cannot go below them. The keeper
  check prints a warning when the cap is more than 100 times the bond.
- Rounds. The interval is at least 5 minutes, and stakes close at least half the interval
  before the end of a round.
- Gas floors, in TGas. Oracle: settle (`finalize`, `resolve_by_deadline`) 100, `retry_unlock` 55, the jury draw about
  275 (`resolve_draw`). Council: `claim` and `unstake` 33 (attach 100 from the website), `request_unstake` none.
  Market: `sweep_fees` 87. Rounds: `sweep_fees` 60. A call below its floor is refused with the amount in the
  message.

---

## Release and verification

The wasm hashes of a release are what lets the DAO and the keeper agree on what runs. Do these in
order.

1. Build reproducibly. From `contracts/`, with every change committed and docker running, run
   `./release.sh`. It runs `./build.sh --reproducible`, checks the four wasm files and prints the
   release message on stdout: `Release hashes`, a blank line, one `<contract> sha256:<hex>` line each
   for market, oracle, council and rounds, then `commit <hash>` and `toolchain <version>`.
   Build on a second machine and compare the hashes before going on.
2. Run the build check. `node verify-build.mjs target/near/market/market.wasm
   target/near/oracle/oracle.wasm target/near/council/council.wasm target/near/rounds/rounds.wasm`
   (`release.sh` already does this).
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
   stdin, as in `node keeper/keeper.mjs check --rpc <url> --market <id> --oracle <id> --council <id> --rounds <id> --release <file>`. Without `--rounds` the check prints that rounds was not checked, so always pass it for a deployment that includes rounds. A match prints `release: live code matches the release hash list`. Any contract whose live code hash differs from the tag is reported and the check exits 1.
6. Refuse to deploy a build whose embedded build info is empty. A wasm from `./build.sh` has
   `build_info` null and `verify-build.mjs` rejects it. Only a build from `./build.sh --reproducible`
   passes.

---

## View cost at scale

Measured 2026-10-22, and again after the account index, in the NEAR sandbox with `contracts/tests/tests/scale.rs`. Each view method was
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
| council `reward_totals` | 300 | 1.7 | 0 |
| council `staked_tokens` (105 seats) | 300 | 9.6 | 3 |

Before and after, in TGas:

| View | Before | After |
| --- | --- | --- |
| `get_positions` and `get_account`, 20 held | 72.4 at N = 300 | 7.1 at N = 300, 600 and 1,200 |
| `get_positions`, 1 held in the newest market | 142.0 at N = 600, 282.4 at N = 1,200 | 2.1 at N = 600 and 1,200 |
| `get_account`, 1 held in the newest market | same as `get_positions` | 2.3 at N = 600 and 1,200 |

The market keeps, for each account, the sorted list of market ids in which it holds shares, updated
only where a share entry is created or removed. `get_positions` reads that list instead of scanning
market ids from 0, so its cost follows the number of positions (about 0.27 TGas each) and not the
number of markets. `get_account` calls it and costs the same. Writing the list costs a trade a
read and a write of one record of 8 bytes per market the account holds. An ordinary account holds
at most 20; the operator and the owner, who are not held to that cap, can hold one per market, and
a record of 1,000 markets is 8 KB.

`create_market` burns 7.3 TGas in all (the oracle registration included), but needs at least 40
TGas attached (30 ran out of gas; sizes above 40 were not tried, and nothing between 30 and 40). Six calls of 45 TGas fit in one 300 TGas transaction.

Rerun (about 12 minutes):

```
cd contracts && SCALE_MARKETS=300 cargo test -p tests --test scale -- --ignored --nocapture --test-threads=1
```

For launch: `get_positions` and `get_account` burned under 8 TGas at 300, 600 and 1,200 markets
and did not grow with the number of markets. Every other view measured stays under 10 TGas.
Not measured: the Council views of state version 6 (`claimable_of`, `in_progress_of`, `seat_earnings`,
`quarter_snapshots`), an operator holding a position
in hundreds of markets on `get_positions`, and views with
more than 120 history points (the cap).
