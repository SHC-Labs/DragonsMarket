# Keeper preparation on Railway

The `keeper` service is a preparation job, not an active signer. It builds from the same backend image and runs `node dist/src/keeper-runner.js` every five minutes. It has no public domain or listening port. The foundation release workflow does not deploy it. Create it only as part of the reviewed chain configuration; adding an empty service does not activate trading.

## Configuration

Use the same registered `NETWORK=mainnet`, `DEPLOYMENT_ID`, `DEPLOYMENT_START_BLOCK`, market/oracle/Council/verifier accounts, collateral and RPC configuration as the indexer. Optional RPC bearer tokens stay server-side, are bound to the exact configured HTTPS endpoint, and are never forwarded through redirects. Requests use `RPC_INTERVAL_MS`, default 1000, and bounded response bodies.

Generate a dedicated 32-byte random lowercase-hex `KEEPER_DB_PASSWORD` in the database release service. Its next reviewed release creates `dm_keeper_login` with the `dm_keeper` grants. Set the keeper's `DATABASE_URL` to that login through Railway private networking. Do not use the migration owner, API login or agent login. Optional `BACKUP_DB_PASSWORD` similarly provisions the existing read-only backup group for a later offsite job; this does not configure offsite storage.

`KEEPER_MODE=prepare` exports up to 5,000 indexed blocks, then advances the queue by at most 5,000 blocks/8 MiB. `KEEPER_MODE=check` additionally computes due actions in dry-run mode once the feed is current. Both reject signing-key environment variables. `KEEPER_MODE=sign` is refused. The process has a three-minute deadline and one database advisory lock per deployment. Loss of the lock connection terminates it. Do not run a separate exporter or keeper CLI against its files.

## Persistent volume

Attach a dedicated volume at `/app/.local/feeds`. Files are named after the deployment ID. Keep both the JSONL feed and queue; losing either requires controlled reconstruction, never moving the approved indexing boundary. The exporter refuses truncated or changed acknowledged content. Changing the deployment uses separate files. Changing RPC/contract scope requires an explicit queue reconciliation.

[Railway volumes](https://docs.railway.com/volumes) mount owned by root and are absent during pre-deploy checks. Initialization must therefore be a one-time start command before the normal job, not a Docker build or pre-deploy step. With the cron disabled and no keeper signing keys present, an operator can temporarily run a narrowly scoped Node command as UID 0 to verify the mount is a real directory, set that directory's ownership to 65532:65532 and its permissions to 0700. Do not recursively change unrelated paths. Remove `RAILWAY_RUN_UID=0` and restore the committed keeper command before starting the job; the runner itself refuses root. Verify UID 65532 can write and fsync the mounted directory, then enable the schedule. This initialization has not yet been performed or proved on the live service.

[Railway cron](https://docs.railway.com/cron-jobs) has a five-minute minimum interval and can start late. A signing deployment must account for that delay against approved contract deadlines; preparation cron is not a precision settlement guarantee.

## Acceptance and activation

1. With no signing keys, run preparation and record its JSON report: mode, exported count, current flag and processed height.
2. Restart the container. The next pass must resume without duplicate feed lines or a reset queue. Simultaneous runs must refuse the second lock holder. Verify a stale feed reports `current:false` and sends nothing.
3. Restore the volume alongside the corresponding database checkpoint during recovery; test truncation refusal and rebuild only through a reviewed recovery procedure. Include volume growth and keeper failure/lag in operational alerts.
4. Before implementing/enabling the signing mode, close the contradictory market deadline, approve the reproducible contract release and custody, provision three receiver/method-scoped keys with finite allowances, fund the operator's gas, and run the approved dry-run plan. The existing keeper CLI's scoped-key/current-feed guards remain mandatory. Preparation success alone does not approve signing.
