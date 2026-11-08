# Native Railway restore drill

Status: native Railway restore completed successfully on 7 November 2026 at 22:40 UTC, inside the owner's approved window. The rollback volume swap remains unexercised. Logical dump/restore recovery is tested separately.

This drill is for the current PostgreSQL 18 hosting foundation with chain and agent execution disabled. It changes the production volume and interrupts API/MCP access. Reserve a 30-minute maintenance window with the project owner present; decide whether to roll back by minute 15. These are planning budgets, not measured recovery guarantees. Confirm the window before stopping services or requesting a restore.

## Prepare before the window

Use project `489b02ad-fd74-4413-ab91-835da8b86542`, production environment `dfda2a3a-a864-4e86-ab25-2299069f7729`, Postgres service `130e30b5-c8b3-4a63-ae2f-2cc1e0901fc0`. Confirm `railway status` shows that exact project/environment. The evidence command pins all three IDs and uses Railway SSH; no public database port or copied database credential is needed.

Record in a private incident note:

- Operator, window start/end, agreed rollback deadline and a second contact.
- Reviewed source SHA and current Postgres/server/MCP deployment IDs and image digests.
- Current Postgres volume ID, volume-instance ID, mount path, size and region. Never substitute a volume-instance ID where a command expects a volume ID.
- Current schedules and latest successful backup timestamp. Run the protected **Backup audit** when available; otherwise inspect the current mount's Backups tab directly.
- The exact service restart/redeploy actions available for the recorded deployments. Check their retention and availability before removing any deployment. No source, image, variable, migration or credential change belongs in this drill.

The initial volume was `af6b6da7-aefe-4a86-a836-f6db7d1efa45`, mounted at `/var/lib/postgresql/data`. Re-read the current mount before use; the identifier changes after restores. Keep both the original and restored volumes until the owner accepts the result.

Store evidence outside Git in an owner-only directory on encrypted local storage. The command creates each file with mode `0600` and refuses overwrite. Evidence contains counts, hashes and schema object names, not raw rows or password hashes; still treat it as private operational information. Test read-only capture before the window to verify SSH access, but do not use that capture as the frozen baseline.

## Freeze writes and take the drill snapshot

1. Announce the window through the team's normal channel. Prevent new releases and migrations. Confirm no queued/in-progress Railway deployment, release workflow, manual SQL session or external database writer remains.
2. Record the active service list. Stop MCP and server using their deployment actions. Keep `database-release`, `agent-worker`, `indexer`, `reconcile`, `verify-chain` and `prices` inactive. Do not stop Postgres yet. The API writes sessions and performs cleanup every ten minutes even without chain activation; an idle website is not a write freeze.
3. Verify those processes have stopped and inspect Postgres activity. There must be no application connections or open transactions from other operators. Do not kill an unexplained session; identify its owner first. The static web can remain available, but login and data access will be unavailable during the drill.
4. From the reviewed checkout, capture the frozen baseline:

   ```sh
   node deploy/railway/recovery-evidence.mjs capture /private/drill/before.jsonl
   ```

   Replace `/private/drill` with the prepared private directory. The command only reads. It hashes all public-table values inside PostgreSQL, captures sequence counters and definitions (type, start, increment, bounds, cache, cycle and owned column), and fingerprints schema definitions, owners, grants, service-role attributes and memberships. It fails on incomplete evidence or more than 100,000 rows in a table. Larger datasets require a separately reviewed method; do not remove the limit during an incident.

   Use evidence format 3 for both captures. It also fingerprints global default grants, row security policies, view definitions and role/database settings. Formats 1 and 2 omit parts of this evidence and are rejected; capture a fresh baseline with the reviewed script before creating the drill snapshot. Never relabel an old evidence file to make it pass. The completed window below used format 2 and does not retroactively prove the additional format 3 fields.
5. Create a new manual snapshot in **Postgres > Backups**, wait for completion, and record its ID and timestamp. It must be created after the writer freeze. Do not use an older retained snapshot for this drill: comparing it against today's baseline could either fail legitimately or discard intervening user activity.
6. Run the comparison while writers are still stopped:

   ```sh
   node deploy/railway/recovery-evidence.mjs compare /private/drill/before.jsonl
   ```

   A mismatch means the freeze is not established. Stop the drill, investigate and take a new baseline/snapshot only after resolving the writer. A match supports the recorded freeze but does not replace verifying stopped processes and blocked releases.

## Restore and verify before reopening

Select **Restore** on that exact snapshot. Railway stages a replacement volume and retains the original unmounted volume. Review **Details**: only the intended Postgres volume replacement at the original mount path should be staged. Record the replacement volume and instance IDs. Apply **Deploy** only inside the agreed window; this redeploys Postgres. [Railway backup behavior](https://docs.railway.com/volumes/backups).

Wait for Postgres readiness and inspect startup logs for recovery completion and errors. Confirm the running Postgres deployment mounts the replacement volume, then run:

```sh
node deploy/railway/recovery-evidence.mjs compare /private/drill/before.jsonl
```

Require exact equality before running a migration, role provisioning or application deployment. Repairing the database first would conceal a failed restore. Any mismatch, missing evidence, unexpected deployment/configuration change or recovery error keeps writers stopped and starts the rollback decision.

After the comparison passes, resume only the previously active server and MCP deployments using the recorded code/configuration, server first. Railway supports deployment removal and restart/redeploy actions; confirm the selected action references the recorded deployment rather than the latest source commit. [Deployment actions](https://docs.railway.com/deployments/deployment-actions).

Require server database/schema readiness, MCP-to-API readiness on versions that provide it, and the normal release/domain smoke checks. Check a fresh browser session and allowed/denied CORS origins. Runtime startup checks the API's restricted database role. The evidence checks preserve other roles' grants and attributes, but do not prove every unused login's password works; keep deferred workers off.

Recheck backup schedules and freshness on the replacement mount. Record completion time, downtime, evidence result, health results and retained rollback volume. Resume releases only after the owner accepts the result. Reopening writers ends the zero-data-loss rollback window.

## Rollback

Before applying staged changes, discard the restore's staged change if the target or window is wrong. Confirm the original mount is still active before resuming services.

After the replacement has been applied, keep application writers stopped. Stop Postgres before changing its mount. Confirm the original volume is still present and detached, with the original mount path. The recovery path is to detach the replacement and reattach the original to the same Postgres service/environment, then restart the recorded Postgres image/configuration. Railway exposes both operations in its volume CLI. [Volume commands](https://docs.railway.com/cli/volume).

The following are maintenance-window operations, not preparation commands. Set the two IDs from the live incident record, inspect the selected project, and keep interactive confirmations enabled:

```sh
railway status
railway volume --environment dfda2a3a-a864-4e86-ab25-2299069f7729 \
  --service 130e30b5-c8b3-4a63-ae2f-2cc1e0901fc0 detach --volume "$RESTORED_VOLUME_ID"
railway volume --environment dfda2a3a-a864-4e86-ab25-2299069f7729 \
  --service 130e30b5-c8b3-4a63-ae2f-2cc1e0901fc0 attach --volume "$ORIGINAL_VOLUME_ID"
```

Review and apply only the intended mount change, verify the original volume is mounted at `/var/lib/postgresql/data`, then start Postgres. Never delete/wipe either volume, create an empty replacement, upgrade Postgres or run initialization SQL as a recovery shortcut. If the original volume cannot be attached, preserve both volumes and escalate to Railway support while writers remain stopped. CLI availability is verified; this production rollback sequence has not yet been exercised.

Repeat the frozen-baseline comparison and readiness checks before resuming server/MCP. If any writes were accepted after the restored database reopened, this simple volume swap is no longer lossless: stop, preserve both states and reconcile the new writes under a separate incident plan.

## Evidence limits and offsite follow-up

The SQL uses one read-only repeatable-read transaction, a two-minute transaction limit and bounded rows. Sequence state is not transactional, so the writer freeze is essential. Hashing preserves large numeric values without conversion through JavaScript numbers. The catalog comparison covers this application's public schema and `dm_*` roles; it is not a full cluster security audit or a proof of external provider/chain state. Keep the same PostgreSQL image and collation libraries throughout the drill.

Native snapshots remain inside the Railway account/project. Before substantial durable user activity, choose an independent storage account and recovery custodian. Plan a daily logical dump encrypted before upload, a write-only uploader scoped to its destination, retention protected from that uploader, and a separate offline recovery key. Store credentials outside source and avoid plaintext dump staging on unencrypted storage. Test download, decryption, checksum verification and restore from a clean environment, then measure recovery time and oldest recoverable data. Destination, encryption/key custody, retention and notification delivery must be agreed before enabling that job; no offsite job is configured by this slice.

## Completed window, 7 November 2026

Skylar approved the window in chat. API and MCP were stopped, all other workers remained inactive, and PostgreSQL reported zero other client connections. Evidence format 2 was captured before the fresh snapshot and matched again before and after the restore, before any migration or regrant. All 23 public-table digests, one sequence's state and definition, and 12 catalog sections matched exactly.

The window lasted 272 seconds; the API unavailable interval was at most 223 seconds. PostgreSQL completed WAL recovery and accepted connections. PostgreSQL, API, MCP and web image digests were unchanged. HTTPS routes, API database/schema readiness, MCP liveness, a fresh unauthenticated session and allowed/denied CORS origins passed. A fresh graphical-browser test was unavailable in this session; this drill verified those boundaries over HTTP. The current images still predate this branch's new MCP readiness route and nonce CSP.

| Item | Last verified value |
| --- | --- |
| Original volume, retained detached | `af6b6da7-aefe-4a86-a836-f6db7d1efa45` |
| Restored mounted volume | `d1e7bf1c-325c-4bc9-99d0-8342956f64f9` |
| Mounted volume instance | `16607f26-b88f-46b7-b2ce-b1b2986d33fb` |
| Postgres deployment | `a9c07eb3-4a0d-47aa-a752-01bb8a24553a`, running |
| Server deployment | `f7beb00d-ce43-44d6-ab4d-749378466e85`, running |
| MCP deployment | `747f1844-d9bc-404c-8a0c-61380f52ae67`, running |
| Web deployment | `c145f41a-7bd5-43e0-bcc1-761a6ae7bb4b`, running |
| Database release | `c627b1c5-e870-4d9b-853c-78152ae56787`, finished/stopped |
| Chain/agent services | No deployment on indexer, reconcile, verify-chain, prices or agent-worker |
| Retention | Daily 518400 seconds; weekly 2332800 seconds |
| Drill snapshot on original volume | `b4d1f365-8ac4-4a90-8534-f0c37deb5fe6`, `2026-11-07T22:36:32.318Z` |
| Drill snapshot copied to restored volume | `9a1345f1-8e28-4f87-a5c4-111932c799f9`, same timestamp |
| Live readiness | Database OK, schema current, `deploymentConfigured:false`; MCP liveness OK |

Daily/six-day and weekly/27-day retention were verified on the new mount. Both manual snapshots were copied; the first scheduled backup has not yet been observed. Private evidence and execution records are retained outside Git in the operator's owner-only encrypted-home directory. No database values or credentials were copied into this runbook.

The actual staged-change query exposed obsolete `database-release` build/start commands even though `unmergedChangesCount` was null. That patch was archived privately and removed from staging before the restore; it was never applied. Only the restored Postgres volume replacement was committed. The branch's release gate now checks the actual staged patch. Railway required deployment when committing the volume replacement; `skipDeploys:true` was rejected without changing the mount.

The original volume remains available for a separately planned rollback exercise or retention decision. Writers have resumed: reverting to it now requires reconciling any writes since reopening, rather than treating the swap as lossless. No offsite restore or signer recovery was performed.
