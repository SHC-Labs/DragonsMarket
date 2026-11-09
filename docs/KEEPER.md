# Keeper on Railway

The `keeper` service defaults to a preparation job. This branch also implements guarded signing, but no live keeper service, signing approval or signing keys have been installed. It builds from the same backend image and runs `node dist/src/keeper-runner.js` every five minutes. It has no public domain or listening port. The foundation release workflow does not deploy it; the separate [activation workflow](ACTIVATED-RELEASE.md) includes keyless preparation and approved signing stages. Create it only as part of the reviewed chain configuration; adding an empty service does not activate trading.

## Configuration

Use the same registered `NETWORK=mainnet`, `DEPLOYMENT_ID`, `DEPLOYMENT_START_BLOCK`, market/oracle/Council/verifier accounts, collateral and RPC configuration as the indexer. Optional RPC bearer tokens stay server-side, are bound to the exact configured HTTPS endpoint, and are never forwarded through redirects. Requests use `RPC_INTERVAL_MS`, default 1000, and bounded response bodies.

Generate a dedicated 32-byte random lowercase-hex `KEEPER_DB_PASSWORD` in the database release service. Its next reviewed release creates `dm_keeper_login` with the `dm_keeper` grants. Set the keeper's `DATABASE_URL` to that login through Railway private networking. Do not use the migration owner, API login or agent login. Optional `BACKUP_DB_PASSWORD` similarly provisions the existing read-only backup group for a later offsite job; this does not configure offsite storage.

`KEEPER_MODE=prepare` exports up to 5,000 indexed blocks, then advances the queue by at most 5,000 blocks/8 MiB. `KEEPER_MODE=check` additionally computes due actions in dry-run mode once the feed is current. Both reject signing-key environment variables. Preparation/check have a three-minute deadline; signing has a ten-minute deadline. All modes hold one database advisory lock per deployment. Loss of the lock connection terminates the process. Do not run a separate exporter or keeper CLI against its files.

`KEEPER_MODE=sign` requires the [reviewed approval packet](KEEPER-APPROVAL.md), two independent HTTPS RPC providers, an approved scoped key per active receiver and current successful reconciliation/integrity reports. It processes one queued entity at a time, with explicit per-run action/gas limits. Code hashes, DAO policy and contract controls are rechecked through both providers at a common finalized block before every submission. The feed is checked again afterwards, so a long approval check cannot authorize stale decisions. Keys may call only keeper methods with a finite allowance; full-access and shared default keys are refused. This runner uses its durable, finality-checked sender. The standalone historical keeper CLI is not the production signing entrypoint.

Migration 014 adds one `keeper_status` row per deployment. Only the keeper writes it; API and workers can read it. `/v1/operator/services` includes mode, state, height and timestamps. Public `/v1/health/services` remains coarse. A market deployment raises alerts for missing/stale successful passes (15 minutes), disabled signing, failed passes or a stale feed. Wire these conditions to the existing service-health monitor and prove delivery; recording a row alone does not notify anyone.

## Maintenance payouts

When Rounds is configured, the runner reads its fees and treasury balance at the same finalized
block and calls `sweep_fees` with its own receiver-scoped key once the configured keeper minimum
is met. A failed transfer restores the treasury balance, so the next pass includes that balance
even when newly collected fees are zero. Market and Rounds retries are independent.

The Oracle emits `bond_claimable` whenever it credits a positive amount. Successful Oracle
receipts in the indexed feed create a durable payee job. After seven days, the runner rechecks
`claimable_of` and calls `payout_bond(account_id)` with zero deposit. The contract chooses the
amount and pays only that account's Intents balance. Existing `withdraw_bond` remains available
immediately with one yocto. Failed transfers restore the claim; lost callbacks remain pending
for owner reconciliation. Another credit cannot postpone an existing job's deadline.

Deploy the reviewed Oracle before installing its expanded scoped key or enabling this runner.
Historical claims created before the new event remain withdrawable, but cannot be discovered
from a nonexistent event: recover their beneficiary list from the old finalization evidence and
settle them through reviewed calls. Never move the indexing start block to skip that evidence.
Fresh deployments index from creation. Changing optional Rounds changes the queue scope and
requires controlled reconstruction of queue state while preserving the transaction journal.

Signing uses three keys for Market/Oracle/Council, and a fourth only when Rounds is configured.
The release gate requires each active key to be sealed on the keeper service, rejects keys in
preparation, and refuses an unused Rounds key on a deployment without Rounds.

## Persistent volume

Attach a dedicated volume at `/app/.local/feeds`. Files are named after the deployment ID. Keep the JSONL feed, queue and `.submission.json` transaction journal. Losing any requires controlled reconstruction, never moving the approved indexing boundary. The exporter refuses truncated or changed acknowledged content. Changing the deployment uses separate files. Changing RPC/contract scope requires an explicit queue reconciliation.

[Railway volumes](https://docs.railway.com/volumes) mount owned by root and are absent during pre-deploy checks. Initialization must therefore be a one-time start command before the normal job, not a Docker build or pre-deploy step. With the cron disabled and no keeper signing keys present, an operator can temporarily run a narrowly scoped Node command as UID 0 to verify the mount is a real directory, set that directory's ownership to 65532:65532 and its permissions to 0700. Do not recursively change unrelated paths. Remove `RAILWAY_RUN_UID=0` and restore the committed keeper command before starting the job; the runner itself refuses root. Verify UID 65532 can write and fsync the mounted directory, then enable the schedule. This initialization has not yet been performed or proved on the live service.

[Railway cron](https://docs.railway.com/cron-jobs) has a five-minute minimum interval and can start late. A signing deployment must account for that delay against approved contract deadlines; preparation cron is not a precision settlement guarantee.

## Acceptance and activation

1. With no signing keys, run preparation and record its JSON report: mode, exported count, current flag and processed height.
2. Restart the container. The next pass must resume without duplicate feed lines or a reset queue. Simultaneous runs must refuse the second lock holder. Verify a stale feed reports `current:false` and sends nothing.
3. Restore the volume alongside the corresponding database checkpoint during recovery; test truncation refusal and rebuild only through a reviewed recovery procedure. Include volume growth and keeper failure/lag in operational alerts.
4. Before enabling signing, close the contradictory market deadline, approve the reproducible contract release, DAO policy and custody, provision the receiver/method-scoped keys with finite allowances, fund the keeper's gas, and run the approved dry-run plan. Approval explicitly lists the market IDs the keeper may advance; an unapproved due market blocks the pass. Preparation success alone does not approve signing.

## Submission recovery

Before broadcasting, the signer writes and fsyncs the transaction hash, exact call and signer scope to the owner-only journal, atomically renames it, then fsyncs the directory. It never stores the private key there. A lost response leaves this record pending. The next attempt or process must recover that hash using both providers; it cannot create another transaction while the result is unknown. `FINAL`, the exact signer/receiver/call and the complete receipt graph are required. A proved failed call is recorded as failed and can be reconsidered from fresh chain state. A crash after journal creation but before broadcast intentionally requires investigation; unknown does not mean failed.

For an unresolved journal, stop the cron and remove its signing keys from the service before inspection. Query the recorded hash with the recorded account through both providers and the archival provider. Preserve the journal and incident evidence. If it remains absent, prove the old transaction can no longer execute (including nonce/block-hash validity), reconcile the contract state, and obtain an operator recovery decision before clearing anything. Do not delete the journal merely to make the job green. Application rollback must preserve the queue and journal. Database/volume rollback cannot undo an on-chain call.

The automated signer test executes the actual Council WASM on a local NEAR sandbox, verifies final receipts, reloads the journal and proves revoked-key refusal. It does not supply mainnet custody, funded acceptance or independent live-provider evidence.

`pnpm --filter dragons-market-backend test:agent-chain` also runs a combined DAO/keeper integration test. It verifies a checksum-pinned upstream Sputnik WASM, deploys the four financial contracts and the real Intents verifier, and submits the production treasury helper's proposals through a two-of-three DAO. It covers outsider rejection, insufficient votes, publisher rotation, jury settings, upgrades and key removal, then executes the production keeper approval and signing paths at the default one-second RPC pace. A subsequent DAO pause or unsafe policy prevents further signing without creating a new journal entry. The policy case includes a Requestor role with no approval permission whose zero threshold permits execution when it votes to reject; copying its policy hash into an approval must still be refused. The test uses synthetic keys, a local mock token/NFT and two client queues connected to one sandbox node; it does not approve production artifacts, the final DAO policy or independent provider operation.

CI runs these Node chain tests once on sandbox shard 0 using the existing compiled artifacts. Backend-only changes run one integration worker and skip the eight Rust integration shards. The required `contract-checks` gate fails if that worker fails, is cancelled or is skipped unexpectedly.
