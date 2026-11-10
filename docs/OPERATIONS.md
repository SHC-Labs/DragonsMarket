# Dragons Market operating handoff

## Verified live on 7 November 2026

- `https://dragons.market`: static web app, valid HTTPS, deployed API/MCP origins verified in a fresh browser.
- `https://api.dragons.market`: database/schema ready; browser session request and allowed-origin preflight work; untrusted origins are refused.
- `https://mcp.dragons.market`: liveness and public skill available; tools require a live agent token.
- Postgres is private, with its persistent volume and separate application roles. The migration owner is not on public services.
- `deploymentConfigured:false`. Chain workers and agent execution remain off. No real-contract account or retiring Agent API credential has been added.

Private PR #18 contains the next hardening release. These code additions are not live until Nameless syncs them and a public-main release succeeds. Do not describe a PR, passing CI or a healthy website as live trading.

## Finish the hosting setup

1. Upgrade the team's Railway workspace to **Railway Pro**, currently a $20 monthly minimum including $20 usage. Native volume backups and resource monitors require Pro. No upgrade has been performed by this work.
2. On **Postgres > Backups**, enable **Daily** and **Weekly**, then create the first manual backup and wait for it to appear. Daily copies retain six days and weekly copies 27 days. The release preflight requires both schedules and an unexpired backup less than 36 hours old. A newly created schedule alone is insufficient.
3. In Railway project **Settings > Tokens**, create `github-actions-production` scoped to `production`. Paste it directly into the **public** repository's **Settings > Environments > production > Environment secrets** as `RAILWAY_TOKEN`. No personal-account token, repository-wide secret or chat paste.
4. Complete private PR review. Nameless copies the selected changes into a fresh public branch/commit and opens a PR to public `main`. Do not merge or cherry-pick private history if contributor identities must stay private. Public `main` requires one independent review and the `agents` and `contract-checks` checks. These workflow changes must be part of the first sync.
5. After that PR merges, run **Deploy Railway** on public `main`, action **check**. Review and approve the production environment job. This checks token scope, service configuration and recent backups without uploading code. The HTTP smoke steps run on action **deploy**, after the new MCP readiness route exists; configuration checking does not pretend that the candidate code is already live.
6. Run action **deploy** for the selected reviewed public commit. Release order is migration job, API, MCP, web; no chain/agent worker is started. Require the final Railway-URL and custom-domain smoke checks to pass.
7. Run **Production smoke** manually once. After it passes, set public repository **Actions variable** `PRODUCTION_MONITOR_ENABLED=true`. Keep the existing production environment variable `CUSTOM_DOMAINS_READY=true`.

Railway deployments are deliberate/manual. Ordinary pushes run checks, not production builds. Keep direct Railway GitHub autodeploy disabled. Resource ceilings and one replica per service remain unchanged.

## Alerts and response

The public smoke workflow checks HTTPS/routes, database/schema health, browser CORS/session behavior, operator-route isolation, background-service status and MCP-to-API readiness. It needs no secret, dependency installation or build. GitHub schedules can be delayed; this is a baseline external check, not a guaranteed 15-minute paging SLA. The operator must enable failed-workflow notifications and confirm receipt during the first manual run.

On Railway Pro, create resource monitors in **Observability** for the three public services and Postgres. Start with memory above 80% of each service's configured ceiling, sustained CPU above 80%, and Postgres volume usage above 70% (warning) and 85% (urgent). Deliver alerts to the project owner through Railway's configured email/in-app notifications; verify delivery. These monitors are not yet configured on the Hobby workspace.

For an alert: check Railway deployment state/logs, then API `/health/ready`, MCP `/health/ready`, and `/v1/health/services`. Operator detail remains behind the bearer-protected route. Check whether a release or platform incident explains the change. Inspect the recorded deployment IDs before retrying a failed or canceled workflow; a queued Railway build may continue after GitHub stops. Never retry an uncertain wallet operation as an incident shortcut.

The chain status checker already exposes stale indexing, integrity and reconciliation alerts when a deployment is registered. Its alert thresholds and the agent/provider checks need an end-to-end exercise when those integrations are activated later.

## Backups, restore and updates

The last logical restore drill passed all 13 migration checksums, 23 table counts, indexes, constraints and restricted-role checks. There is currently no retained Railway backup, so recovery from the real backup destination is **not verified**.

After native backups are enabled, schedule a controlled restore drill while chain services remain disabled. Railway restores stage a replacement volume for the same service/environment and retain the old volume. Record the current volume/deployment IDs, inspect the staged replacement, and arrange the short database restart before applying it. Verify schema/checksums, table counts, restricted logins and all domain smoke checks afterwards. Retain the old volume until the restored service is verified. Never restore over later user activity without a reviewed recovery plan.

Native snapshots are in the same Railway project and region; deleting/wiping the volume can delete its backups. They do not protect against project/account loss. A separate encrypted offsite backup and tested key recovery are additional disaster-recovery work before substantial durable user activity. Never commit dumps, database URLs, sealed grants or backup keys.

For runtime patches, review upstream release notes and scan the candidate image, retain the current digest, verify a recent backup, test database restore/collation compatibility if its image changes, and release once through the normal gate. Roll back application images only when compatible with the current schema; migrations remain append-only. Image advisories and their reachability limits are recorded in [RAILWAY.md](RAILWAY.md).

## Deliberately deferred

- Real contract account/network manifest and deployment registration, then preflight/indexer/settlement validation.
- Fresh Agent API endpoint/credentials after the upstream migration; no retiring keys.
- Real-wallet/agent actions and financial readiness testing.

Those deferrals do not prevent the website, API/database foundation and MCP hosting from being verified independently.

Sources: [Railway pricing](https://railway.com/pricing), [volume backups](https://docs.railway.com/volumes/backups), [resource monitors](https://docs.railway.com/observability#monitors).
