# Dragons Market operating handoff

Current coordination is in PENDING.md. On 9 November the owner merged private PR 21 as `7bedd50`; public main remains `714877c`, and the last live API check reports foundation readiness with no configured deployment. The historical observations and procedures below do not establish that pending work is live.

## Verified live on 7 November 2026

- `https://dragons.market`: static web app, valid HTTPS, deployed API/MCP origins verified in a fresh browser.
- `https://api.dragons.market`: database/schema ready; browser session request and allowed-origin preflight work; untrusted origins are refused.
- `https://mcp.dragons.market`: liveness and public skill available; tools require a live agent token.
- Postgres is private, with its persistent volume and separate application roles. The migration owner is not on public services.
- `deploymentConfigured:false`. Chain workers and agent execution remain off. No real-contract account or retiring Agent API credential has been added.

Private PR #19 and its public sync PR #3 have merged. Public `main` is `714877cca3394f89cccc122e32da515b2de0718d`. Hardening from private PR #21 is merged privately but still needs the team to sync it publicly and complete a public-main release. Follow-up keeper/CI changes need review and are not deployed. Do not describe a PR, passing CI or a healthy website as live trading.

## Finish the hosting setup

Already configured on 7 November: the team's Railway workspace is on **Railway Pro**; Postgres has daily/six-day and weekly/27-day retention; the first manual backup is listed at `2026-11-07T17:45:41.680Z`. The scoped `github-actions-production` token exists and the public repository's protected `production` environment contains `RAILWAY_TOKEN`. The [protected configuration check](https://github.com/SHC-Labs/DragonsMarket/actions/runs/42414325926) passed against public commit `714877c`, authenticating the stored token and checking its scope, service settings and recent backups. No token belongs in chat, source files or a repository-wide secret.

The [first deployment run](https://github.com/SHC-Labs/DragonsMarket/actions/runs/42414553711) stopped in application CI before any Railway upload. Both attempts failed in Next's Google Fonts URL parser during `pnpm build`; the deployment job was skipped. The private branch now bundles the same font families and has passed a build without outbound networking, browser font checks and the CSP/wallet fixture. Review and sync that fix before another public release. The native restore drill subsequently resumed the same API/MCP images under new deployment IDs; see [RESTORE.md](RESTORE.md). Scheduled production smoke remains disabled.

1. Complete private PR review when the branch is ready. Nameless copies the selected changes into a fresh public branch/commit and opens a PR to public `main`. Do not merge or cherry-pick private history if contributor identities must stay private. Public `main` requires one independent review and the `agents` and `contract-checks` checks.
2. After that PR merges, run **Deploy Railway** on public `main`, action **check**. Review and approve the production environment job. This checks token scope, service configuration, minimum backup retention and an unexpired backup less than 36 hours old without uploading code. The HTTP smoke steps run on action **deploy**, after the new MCP readiness route exists.
3. Run action **deploy** for the selected reviewed public commit. Release order is migration job, API, MCP, web; no chain/agent worker is started. Require the final Railway-URL and custom-domain smoke checks to pass.
4. Run **Production smoke** manually once. After it passes, set public repository **Actions variable** `PRODUCTION_MONITOR_ENABLED=true` (currently false). Keep the production environment variable `CUSTOM_DOMAINS_READY=true`.

Railway deployments are deliberate/manual. Ordinary pushes run checks, not production builds. Keep direct Railway GitHub autodeploy disabled. Resource ceilings and one replica per service remain unchanged.

## Alerts and response

The public smoke workflow checks HTTPS/routes, database/schema health, browser CORS/session behavior, operator-route isolation, background-service status and MCP-to-API readiness. It needs no secret, dependency installation or build. GitHub schedules can be delayed; this is a baseline external check, not a guaranteed 15-minute paging SLA. The operator must enable failed-workflow notifications and confirm receipt during the first manual run.

The Railway Observability dashboard has 12 widgets and, on the latest 7 November read, zero monitors. Resource alerts and receipt verification remain outstanding. [ALERTS.md](ALERTS.md) gives the exact chart values, current-volume filtering and a delivery exercise that does not stress production. Creating those monitors needs the UI; browser access is unavailable in this engineering session, and the exposed API has no creation mutation.

For an alert: check Railway deployment state/logs, then API `/health/ready`, MCP `/health/ready`, and `/v1/health/services`. Operator detail remains behind the bearer-protected route. Check whether a release or platform incident explains the change. Inspect the recorded deployment IDs before retrying a failed or canceled workflow; a queued Railway build may continue after GitHub stops. Never retry an uncertain wallet operation as an incident shortcut.

The chain status checker already exposes stale indexing, integrity and reconciliation alerts when a deployment is registered. Its alert thresholds and the agent/provider checks need an end-to-end exercise when those integrations are activated later.

## Backups, restore and updates

The earlier live logical restore drill passed all 13 migration checksums, 23 table counts, indexes, constraints and restricted-role checks. On 7 November at 22:40 UTC, the approved native Railway restore drill also passed: all 23 table digests, sequence state/definitions and 12 schema/permission catalog sections matched before reopening. The API unavailable interval was at most 223 seconds. The original volume remains detached for recovery; the restored mount retains daily and weekly backups.

After this branch reaches public `main`, run **Actions > Backup audit > Run workflow > main**, then approve the `production` environment job. This performs only metadata reads: exact token/project/environment, the currently mounted Postgres volume, daily/weekly retention of at least six/27 days and an unexpired backup within 36 hours. It records the latest qualifying timestamp in the job summary. It installs no dependencies, builds nothing and does not create, restore, delete or deploy anything. Run it between releases and after changing backup configuration; failure needs operator attention. It uses its own concurrency group so a read-only audit cannot replace a pending release.

This audit is manual because the available token can deploy and remains behind production approval. Unattended backup-failure alerting is not configured; do not weaken that approval gate or copy the deployment token into an unprotected scheduled workflow. The secret-free scheduled smoke check does not inspect backup metadata.

CI automatically exercises the actual logical backup script against PostgreSQL 18 fixture data. It restores into a fresh database, compares every public-table value, index, constraint and sequence, reapplies the release grants and checks restricted runtime access. It tests failed dumps, retention, concurrent-run refusal and checksum corruption. No production credentials or dumps enter CI, and no fixture archive is uploaded. This verifies the logical recovery procedure, not a Railway snapshot or an offsite copy.

The [native restore drill](RESTORE.md) records the completed writer freeze, fresh snapshot, exact before/after evidence, unchanged image digests and HTTP recovery checks. The evidence command also detects changed fixture data and unauthorized grants. The retained-volume rollback swap has not been exercised; it needs a new window and reconciliation of writes accepted after reopening.

Native snapshots are in the same Railway project and region; deleting/wiping the volume can delete its backups. They do not protect against project/account loss. A separate encrypted offsite backup and tested key recovery are additional disaster-recovery work before substantial durable user activity. Never commit dumps, database URLs, sealed grants or backup keys.

[OFFSITE-BACKUPS.md](OFFSITE-BACKUPS.md) specifies the independent account, restricted uploader, retention, recovery custodians and missing-backup alert. `backup.sh --encrypt` streams to an encrypted archive and has a tested recovery path through the read-only backup role. The bucket, upload job and recovery-key custody are not configured; local encryption tests are not offsite recovery evidence.

For runtime patches, review upstream release notes and scan the candidate image, retain the current digest, verify a recent backup, test database restore/collation compatibility if its image changes, and release once through the normal gate. Roll back application images only when compatible with the current schema; migrations remain append-only. Image advisories and their reachability limits are recorded in [RAILWAY.md](RAILWAY.md).

## Deliberately deferred

- The owner selected the five supplied mainnet accounts for the hackathon. Deployment registration, code provenance, preflight/indexer/settlement validation and signing operations remain separate gates. CHAIN-ACTIVATION.md records the retrieved chain evidence and exact configuration names. No chain settings were applied to running services.
- Fresh Agent API endpoint/credentials after the upstream migration; no retiring keys.
- Real-wallet/agent actions and financial readiness testing.

Those deferrals do not prevent the website, API/database foundation and MCP hosting from being verified independently.

Sources: [Railway pricing](https://railway.com/pricing), [volume backups](https://docs.railway.com/volumes/backups), [resource monitors](https://docs.railway.com/observability#monitors).
