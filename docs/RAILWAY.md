# Railway deployment

Dragons Market uses one pnpm workspace, one Railway project and separately deployed services. This follows the live Agent API and TLA layout inspected on 6 November 2026: root build/start commands, builds from the repository root, service-specific watch paths, private PostgreSQL references, and a deployment gate for database changes. Existing `backend/`, `web/` and `mcp/` paths remain intact; the Rust contracts are deployed to NEAR separately.

Project: [dragons-market](https://railway.com/project/489b02ad-fd74-4413-ab91-835da8b86542), Filmer's Projects, `production` environment. A Railway environment named production does not select a NEAR network.

## Services

| Service | Build from repo root | Start | Database login | Network |
| --- | --- | --- | --- | --- |
| `web` | `web/Dockerfile` | Caddy serves `web/out` | none | `dragons.market`, port 8080 |
| `server` | `backend/Dockerfile` | `node dist/src/main.js` | `dm_api_login` | `api.dragons.market`, port 3500 |
| `mcp` | `mcp/Dockerfile` | `node dist/src/server.js` | none | `mcp.dragons.market`, port 3700 |
| `Postgres` | official Railway PostgreSQL 18 SSL image | image default | admin stays here and in release job | private only, persistent volume |
| `database-release` | `backend/Dockerfile` | `node dist/src/release.js` | migration owner | private, exits after completion |
| `agent-worker` | `backend/Dockerfile` | `node dist/src/agent-worker.js` | `dm_agent_login` | private only, port 3510 |
| `indexer` | `backend/Dockerfile` | `node dist/src/ingestion/follow.js` | `dm_indexer_login` | private only |
| `reconcile` | `backend/Dockerfile` | `node dist/src/reconcile.js --follow` | `dm_worker_login` | private only |
| `verify-chain` | `backend/Dockerfile` | `node dist/src/verify-chain.js` | `dm_worker_login` | private, cron every six hours |
| `prices` | `backend/Dockerfile` | `node dist/src/prices.js --follow` | `dm_worker_login` | private only |

The agent worker owns partner credentials and sealed grants. The server cannot read those grants or write agent operations. MCP calls the server over Railway's private network. No Redis service is needed by the current implementation.

`indexer` copies finalized contract events into Postgres so the API can answer quickly. `reconcile` compares indexed liabilities with on-chain collateral and records discrepancies; it does not silently credit unexplained funds. `verify-chain` checks the database's stored block links, event counts and checkpoint consistency. `prices` collects external price evidence for settlement. Separate processes give each job its own failure lifecycle and database privileges. Only the indexer owns ingestion writes; price and reconciliation jobs cannot alter wallet sessions or agent grants.

`database-release` is a one-time maintenance job for each release, not a permanently running server. `verify-chain` uses `0 */6 * * *` and exits after each check rather than retaining an idle Node process. The other workers run loops because their work needs continuous ingestion or more precise timing than Railway cron provides. An undeployed worker consumes no runtime compute.

`prices` collects evidence; it does not publish signed prices or run the contract keeper. A signed price publisher and keeper need their own reviewed configuration, scoped credentials and persistent feed storage before enabling the full rounds lifecycle. The database release provisions the separate publisher role for that purpose.

## Toolchain and service settings

Use Node **24.22.2** and pnpm **10.33.0**. Install from the repository root with `pnpm install --frozen-lockfile`. The three application packages share `pnpm-lock.yaml`.

[deploy/railway/services.json](../deploy/railway/services.json) records build, start, healthcheck, watch and restart settings. After creating the named services and linking the CLI to the intended environment, apply them from a terminal:

```sh
railway link --project 489b02ad-fd74-4413-ab91-835da8b86542 --environment production
node deploy/railway/configure.mjs 489b02ad-fd74-4413-ab91-835da8b86542 dfda2a3a-a864-4e86-ab25-2299069f7729
```

The script verifies both the project and environment before applying settings, then reads the result back. It does not create services, install secrets, modify PostgreSQL, connect GitHub or change domains. These settings use Railway's service configuration mechanism. An empty build command clears the old Railpack command; CLI JSON null did not clear it during the November deployment.

All application services use multi-stage Docker builds from the repository root. Dependency manifests are copied before source so ordinary edits can reuse the dependency layer. Backend and MCP use a digest-pinned Google Distroless Node 24 runtime (24.22.2, UID 65532) containing production package dependencies, without a shell, npm, pnpm or Yarn. Application files are root-owned and readable by the runtime user. Web exports Next at build time and runs digest-pinned Caddy 2.11.9 as UID 1000; Node and frontend build dependencies are absent from its runtime image. Conditional local publisher/feed mounts must grant UID 65532 the intended access. Shell-based debugging is unavailable in the Distroless images; use startup logs, health/operator routes and a separately controlled debug environment.

Backend and MCP Dockerfiles declare no build arguments for credentials. The web Dockerfile declares only public `NEXT_PUBLIC_*` configuration. Each build asserts that database, partner, grant and operator credentials are absent from its build environment. `.dockerignore` excludes local environment files, keys and runtime state. Do not add secret `ARG` or `ENV` declarations to these build stages. Railway's [Docker documentation](https://docs.railway.com/builds/dockerfiles) describes this argument boundary.

All services use one replica in US West. Runtime ceilings configured in Railway are 0.5 GB RAM and 0.5 vCPU for web/MCP; 0.5 GB and 1 vCPU for server, release, agent worker, reconcile, verify-chain and prices; 1 GB and 1 vCPU for Postgres/indexer. These are ceilings, not reserved resource charges. Raise a limit only with workload evidence; inspect memory, CPU, database pool saturation and job lag before increasing replicas. Current per-client limits are process-local, so replica changes need a rate-limit review. Independent backend services can still trigger separate builds; targeted watch paths and Docker layer reuse reduce that work without adding an image-promotion pipeline.

## Database credentials and release order

Postgres uses Railway's official image and a volume at `/var/lib/postgresql/data`. Keep it private. The migration owner URL is referenced only by `database-release` as `${{Postgres.DATABASE_URL}}`.

The release service holds five independent, randomly generated passwords: `API_DB_PASSWORD`, `INDEXER_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `PUBLISHER_DB_PASSWORD`, `AGENT_DB_PASSWORD`. Each is 32 random bytes encoded as 64 lowercase hexadecimal characters. Preserve these values across releases; changing one rotates that login's password.

Runtime services reference their own login. For example, server `DATABASE_URL` is:

```text
postgresql://dm_api_login:${{database-release.API_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
```

Use `dm_indexer_login`, `dm_worker_login` or `dm_agent_login` and the corresponding password reference on other services. Never place the owner URL on a public service.

Release in this order:

1. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, database integration tests and `pnpm build`. `pnpm test:release` requires a disposable PostgreSQL cluster without existing `dm_*` roles.
2. Deploy `database-release` from the candidate source. Its logs must report migrations applied and service roles ready. It uses checksum verification, advisory locks and transactional role grants; rerunning the same release applies zero migrations. Restart policy is `NEVER` because successful exit is expected.
3. Deploy `server`. Its pre-deploy command `node dist/src/check-database.js` rejects schema drift and owner/superuser runtime credentials. Railway checks `/health/ready` before routing traffic.
4. Deploy `mcp` and `web`. MCP checks `/health`; web checks `/health/live`.
5. Only after the chain gates below pass, deploy the private workers. Indexer, reconcile, verify-chain and prices have `node dist/src/preflight.js` pre-deploy gates.

After deployment, run `node deploy/railway/smoke.mjs <web-origin> <server-origin> <mcp-origin>` to check exported routes, genuine 404s, static asset caching, database readiness and MCP liveness. This does not perform wallet or trading actions.

For a local-source deployment, run `railway up --detach --service <name>` from the repo root. Always specify the service; CLI link state can otherwise target Postgres or another service. The initial deployment uses CLI uploads. Keep Railway's direct GitHub autodeploy connection disabled: the release workflow below owns deployment order and cadence. Build checks must never run migrations against the live database.

## GitHub CI and deliberate releases

Develop and review these changes in private `SHC-Labs/Dragons-Market`. Nameless publishes the selected changes to public `SHC-Labs/DragonsMarket`; the release workflow intentionally accepts only that public repository's `main`. The private repository runs application CI but cannot deploy through this workflow. Keep production credentials in the public repository's protected environment, not in the private repository. A public sync that must omit private contributor identities needs a fresh commit from copied changes; merging or cherry-picking preserves author metadata.

[.github/workflows/agents.yml](../.github/workflows/agents.yml) runs application checks for relevant changes on pull requests to `main` and pushes to `main`, `agent-accounts` or `deploy/railway`. It is also reusable by the release workflow. It installs the locked workspace, checks the deployment script, runs typechecking, lint, application tests, PostgreSQL 18 integration/release tests, and builds all three applications. Tests use a disposable PostgreSQL service with local-only test credentials. No production secret or environment is passed to this job. The existing Rust contract workflow remains separate; this application release does not deploy or certify contracts.

[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) has only a manual `workflow_dispatch` trigger. Once the changes reach public `main`, open **Actions > Deploy Railway > Run workflow**, select **main**, and leave the action as **check** for the first run. That validates the credential, configuration and existing public services without uploading code. Select **deploy** when releasing the checked commit. Both actions run the application checks against the selected commit. When they pass, an authorized reviewer must review that commit and approve the `production` environment job. The environment allows only the `main` branch, requires a configured reviewer and disallows administrator bypass. Self-review is allowed so the account owner can operate this personal project without another reviewer.

The deploy job checks out the same immutable commit with Git credentials disabled. It installs pinned Railway CLI 4.36.1 before exposing the environment's `RAILWAY_TOKEN` to the release step. Supply a fresh project token scoped to Dragons Market's production environment, not a personal or workspace token. It can deploy services in that environment, so protect it as a production credential. Database passwords, partner keys and grant keys stay in Railway.

Credential setup is still pending as of 7 November: Railway rejected token creation through the CLI login, and the public repository's GitHub environment contains no deployment secret. In Railway, open this project's **Settings > Tokens**, create `github-actions-production` for `production`, then save the value directly under the public repository's GitHub **Settings > Environments > production > Environment secrets** as `RAILWAY_TOKEN`. Do not put it in chat, source files or a repository-wide secret. Run the workflow with **check** before the first deployment. A token-authenticated release has not been verified yet.

The public repository's `main` branch is currently unprotected. The production environment approval controls releases, not merges. Before routine production operation, require pull-request review and the application check on `main`; choose the required check from its first completed GitHub run so the rule matches its actual name. Review workflow and release-script changes as production-credential changes. Repository administrators can still edit protection settings, so their account access remains part of the trust boundary.

[deploy/railway/release.mjs](../deploy/railway/release.mjs) rejects other repositories/branches/events, modified source, a mismatched token scope, staged configuration changes and service-setting drift. It uploads the checked source to `database-release`, `server`, `mcp`, then `web`, serially. Each upload returns a specific deployment ID; the script verifies its project, environment and service rather than polling whichever deployment happens to be latest. The database job must finish successfully, stop, and emit its migration/role completion message before the API upload starts. App deployments must reach Railway's health-gated success state and remain running. Postgres, contract deployment, chain workers and agent activation are excluded.

Release concurrency is one with `cancel-in-progress: false`; a newer release cannot cancel migrations or replace a running release job. Routine pushes do not deploy anything. Batch ordinary releases as needed, roughly once daily or less; urgent fixes can use the same manual path immediately. Railway's [pricing documentation](https://docs.railway.com/pricing/plans#resource-usage-pricing) lists service builds as free. Runtime resources, storage and egress determine hosting usage, so release batching is operational discipline rather than a per-build billing requirement. The current workspace remains on Hobby.

Every release ends with HTTP smoke checks on the existing Railway URLs, including MCP liveness. After Mich's DNS records and Railway certificates are verified, set the GitHub `production` environment variable `CUSTOM_DOMAINS_READY=true` to additionally require checks on all three custom domains. Until then, that second check is deliberately disabled; a successful foundation release does not claim DNS or chain readiness.

Deployment IDs are written to the GitHub job summary as each service starts. If an API query, upload, deployment or smoke check fails, the job stops without automatically rolling back migrations or retrying uploads. A canceled or timed-out GitHub job does not necessarily cancel a Railway build already queued: inspect the recorded deployment IDs before retrying. Apply only forward-compatible migrations while the previous API version is still serving; incompatible schema changes need a separately planned maintenance release. To validate only the credential scope and service settings, run `node deploy/railway/release.mjs --check` with the project token supplied securely through the environment.

Rollback app code only to a version compatible with the current schema. Migrations are append-only. Do not delete the volume or roll back migration rows as part of an app rollback. Configure Railway volume backups and perform a restore drill before relying on this project for durable production data.

On 6 November, Railway rejected native backup scheduling because this personal workspace requires a Pro upgrade for that feature. No billing change was made. A logical dump/restore into a separately created temporary database matched all 13 migration checksums, 23 public-table row counts, indexes, constraints and API/agent grant isolation. This proves restoration of the current foundation database, not durable backup retention or recovery of future trading history. Before launch, choose native daily/weekly backups on Pro or encrypted backups to separate storage, verify retention and perform a restore from that actual destination.

## Runtime configuration

- Server: `HOST=::`, `PORT=3500`, `WEB_ORIGIN=https://dragons.market`, scoped `DATABASE_URL` and the agreed chain variables. Set `OPERATOR_TOKEN` separately if the private operator route is needed.
- MCP: `HOST=::`, `PORT=3700`, `DRAGONS_API_URL=http://${{server.RAILWAY_PRIVATE_DOMAIN}}:3500`, `MCP_PUBLIC_URL=https://mcp.dragons.market`.
- Web build: `NEXT_PUBLIC_BACKEND_URL=https://api.dragons.market`, `NEXT_PUBLIC_MCP_URL=https://mcp.dragons.market` (origin only), plus the matching `NEXT_PUBLIC_NETWORK`, RPC, contract and collateral IDs from `web/lib/config.ts`. These values are compiled into the static export; changing them requires rebuilding web.
- Agent worker: `AGENT_WORKER_HOST=::`, `AGENT_WORKER_PORT=3510`, its database login, `AGENT_API_URL`, `AGENT_API_KEY`, `AGENT_API_WALLET_CONTRACT`, `AGENT_GRANT_KEY` (32 random bytes in base64), and `AGENT_WORKER_TOKEN`. The server gets only the worker's private origin and the shared worker token after the worker is ready. Never put `AGENT_API_KEY` or `AGENT_GRANT_KEY` on server, MCP or web.
- Price evidence: add the providers and policy required by `backend/src/prices.ts` and the backend runbook before starting collection.

### Ingress and monitoring

Railway overwrites `X-Real-IP` on its public HTTP edge. Live probes verified that forged `X-Real-IP` and `X-Forwarded-For` values were replaced. Its socket peer addresses and X-Forwarded-For hop count are not a stable contract. Server uses `TRUSTED_PROXY_HEADER=x-real-ip`, `TRUSTED_PROXY_HOPS=1` and `TRUSTED_PROXY_ADDRESSES=0.0.0.0/0,::/0` for this Railway environment. This deliberately trusts forwarding headers from every peer in the environment for rate-limit identity only; it is not proof of an authenticated edge connection. Other services in the same project/environment can reach this listener directly. Keep every service here trusted, add no public TCP proxy, and isolate any future untrusted workload in a different environment/project. Wallet signatures, sessions, ownership and worker authentication remain mandatory regardless of claimed client IP. See Railway's [published trust-boundary discussion](https://station.railway.com/questions/supported-client-ip-trust-boundary-for-f-0e4c52d9).

For deployments with a stable proxy allowlist, use the actual proxy addresses instead. The default trusts no forwarded headers. `/v1/operator/ingress` returns sanitized peer/client identity details only with the operator bearer token; it exists to detect ingress drift without logging credentials. Never put that token in URLs or browser bundles.

Health GET/HEAD requests bypass user request allowances. Readiness coalesces concurrent database checks and caches the outcome for two seconds. Login challenge allowances apply only to POST requests from the configured Origin. These controls are covered by API tests. Railway's health check gates deployments; it is not continuous uptime monitoring. Before serving users, configure continuous HTTPS/worker freshness alerts and an operator response path. An API 200 alone does not detect stalled indexing, reconciliation or price evidence.

### Security verification and open image advisories

The deployment-focused source review found a shared-proxy rate-limit denial of service. The corrected API identifies public clients using Railway's overwritten header, keeps health checks outside user quotas and rejects invalid challenge methods/origins before charging the login allowance. Tests cover these behaviors and live public-edge probes rejected forged client headers. The review covered the deployment and application boundaries; it was not an exhaustive financial-contract audit.

On 6 November, Node 24.22.2 passed typechecking, lint, 264 application tests and all three application builds. Another 47 database integration tests and one release test passed against an isolated local PostgreSQL 16 cluster; Railway's PostgreSQL 18.6 separately passed the live release, restricted-login and logical-restore checks. This is application validation, not a claim that the legacy Rust contract workflow is green. A production dependency audit reported zero known advisories for the 159 installed production packages. That result does not include operating-system or bundled native-code vulnerabilities.

The hardened release completed as `c627b1c5-e870-4d9b-853c-78152ae56787`, API as `10c372bd-a110-4dd3-8010-e91aeea50ef6`, MCP as `58209db1-1f39-4a73-9f4f-f225cbc021d3` and web as `c145f41a-7bd5-43e0-bcc1-761a6ae7bb4b`. Railway reports all four successful. API/MCP startup logs report Node 24.22.2 and UID 65532. Public probes passed exported routes, real 404s, cache behavior, method restrictions, foundation readiness, MCP liveness and rejection of forged forwarding identities. At the 7 November handoff, chain readiness remains false and the three custom domains still await DNS verification. The source changes are prepared on the private repository's `deploy/railway` branch for review and a separate public sync.

Trivy 0.69.3 scanned the public runtime base images with its 7 November database. These are package/advisory rows, not counts of remotely exploitable application paths. The scans are not attestations of the final private Railway application images.

| Runtime base | High | Critical | Assessment |
| --- | ---: | ---: | --- |
| Previous Node 24.21.0 Bookworm image | 50 | 4 | Replaced by the smaller Distroless runtime; package managers and development tooling are absent from runtime. |
| Pinned Distroless Node 24 Debian 13 | 2 | 0 | Both concern zlib gzip-file writing; no such application call was found in backend or MCP source. Native-library reachability is not exhaustively proven. |
| Previous Caddy 2.11.7 image | 10 | 1 | Replaced by Caddy 2.11.9. |
| Pinned Caddy 2.11.9 Alpine image | 2 | 0 | Bundled JWK and HTML parsers; the configured static-file server accepts neither JWK input nor HTML for parsing. No reachable public attack path was established. |
| Railway PostgreSQL 18 SSL image | 95 | 2 | 51 unique advisory IDs across OS packages and bundled tools; further triage is required. No PostgreSQL-core advisory was reported by this scan. |

The remaining Distroless advisories are [CVE-2026-76844](https://security-tracker.debian.org/tracker/CVE-2026-76844) and [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091). The Caddy dependencies are affected by [go-jose RSA JWK parsing](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q) and [Go HTML parsing](https://pkg.go.dev/vuln/GO-2026-6860). Retain these findings and re-scan when upstream runtime updates are available; do not suppress them merely to obtain a zero count.

The running database reports PostgreSQL 18.6, with only `plpgsql` enabled. All five runtime login roles lack superuser, database creation, role creation and row-security bypass privileges. The scanned template digest is `sha256:4fc833b43d2aaf6ecc9b18615f5533602b723a32d0e2efe2dae8ca0f7217c863`; equivalence to the already-running Railway deployment digest has not been established. Keep the database private. Do not swap the existing Debian volume to an Alpine image solely to change scanner counts: restore compatibility, collation behavior and the backup plan must be verified first. Image-advisory triage and a repeatable patch/restore procedure remain launch work.

## Real-chain activation gates

The contracts are deployed according to their owner; the account manifest has not yet been supplied to this Railway project. Web and server are explicitly configured as testnet while awaiting that manifest. Source defaults differ: direct backend defaults to sandbox and Compose to mainnet, so always set NETWORK explicitly. No mock server or fake balances are deployed.

Before enabling chain services, supply the agreed network, immutable `DEPLOYMENT_ID`, `DEPLOYMENT_START_BLOCK`, actual market/rounds/oracle/council/verifier accounts, `COLLATERAL_TOKEN_ID` and `COLLATERAL_DECIMALS`. Register that exact deployment using the migration owner with `pnpm chain:register` and the manifest variables. Runtime roles deliberately cannot change the deployment registry.

The current live NEAR Data follower enforces **mainnet**. Preflight only warns on other networks and skips the NEAR Data check, so a successful testnet preflight does not prove follower support. A testnet deployment needs a supported, validated ingestion source before enabling indexing.

Run `pnpm chain:preflight` with the registered manifest and scoped runtime connection. It verifies chain identity, contract code/configuration, dependency allowlists, balances and source head. Mainnet agent signing also requires two independent RPC providers. Verify agent partner/wallet settings and run an end-to-end owner-authorized test before enabling agent routes. Configure backend policy hashes from the actual published policies when enabling policy acknowledgement; the current static legal manifest and frontend version labels need reconciliation first.

Agent API integration is intentionally deferred until the API migration next week. No retiring keys were copied. Keep the worker and server worker-link variables disabled until the new credential set and partner endpoint are ready. MCP health and its public skill can be available while authenticated tools remain unavailable. Review MCP fresh-token admission before activation: its current global new-token allowance can be exhausted independently of already-known token budgets.

`/health/ready` reports **foundation** readiness. Even a 200 response with a current database can have `deploymentConfigured:false`. Do not treat that as verified indexing, trading, funding or settlement. Observe indexer checkpoints, reconciliation and actual transaction receipts before calling the real-chain demo ready.

See [CLOUDFLARE.md](CLOUDFLARE.md) for exact DNS records and the domain handoff.
