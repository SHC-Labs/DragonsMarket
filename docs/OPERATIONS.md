# Dragons Market operating handoff

Current coordination is in PENDING.md. The 10 November source check confirms public PR 4 merged at `152384a`; private main remains `8878898` after PR 22. The last live API check was on 9 November and reported foundation readiness with no configured deployment. Source merges and historical observations below do not establish that pending work is live.

## Verified live on 7 November 2026

- `https://dragons.market`: static web app, valid HTTPS, deployed API/MCP origins verified in a fresh browser.
- `https://api.dragons.market`: database/schema ready; browser session request and allowed-origin preflight work; untrusted origins are refused.
- `https://mcp.dragons.market`: liveness and public skill available; tools require a live agent token.
- Postgres is private, with its persistent volume and separate application roles. The migration owner is not on public services.
- `deploymentConfigured:false`. Chain workers and agent execution remain off. No real-contract account or retiring Agent API credential has been added.

Private PR #19 and its public sync PR #3 have merged. Public PR #4 subsequently merged on 10 November at `152384a98e5a51df66d77019dc099c273a01f1c4`. Hardening from private PR #21 and keeper/CI changes from PR #22 are merged privately at `8878898`; verify the selected public release's content and checks before deployment. Additional agent authorization and EVM authentication changes remain local work under review. Do not describe a PR, passing CI or a healthy website as live trading.

## Finish the hosting setup

Already configured on 7 November: the team's Railway workspace is on **Railway Pro**; Postgres has daily/six-day and weekly/27-day retention; the first manual backup is listed at `2026-11-07T17:45:41.680Z`. The scoped `github-actions-production` token exists and the public repository's protected `production` environment contains `RAILWAY_TOKEN`. The [protected configuration check](https://github.com/SHC-Labs/DragonsMarket/actions/runs/42414325926) passed against public commit `714877c`, authenticating the stored token and checking its scope, service settings and recent backups. No token belongs in chat, source files or a repository-wide secret.

The [first deployment run](https://github.com/SHC-Labs/DragonsMarket/actions/runs/42414553711) stopped in application CI before any Railway upload. Both attempts failed in Next's Google Fonts URL parser during `pnpm build`; the deployment job was skipped. The private branch now bundles the same font families and has passed a build without outbound networking, browser font checks and the CSP/wallet fixture. Review and sync that fix before another public release. The native restore drill subsequently resumed the same API/MCP images under new deployment IDs; see [RESTORE.md](RESTORE.md). Scheduled production smoke remains disabled.

1. Complete private PR review when the branch is ready. Nameless copies the selected changes into a fresh public branch/commit and opens a PR to public `main`. Do not merge or cherry-pick private history if contributor identities must stay private. Public `main` requires one independent review and the `agents` and `contract-checks` checks.
2. After that PR merges, run **Deploy Railway** on public `main`, action **check**. Review and approve the production environment job. This checks token scope, service configuration, minimum backup retention and an unexpired backup less than 36 hours old without uploading code. The HTTP smoke steps run on action **deploy**, after the new MCP readiness route exists.
3. Run action **deploy** for the selected reviewed public commit. Release order is migration job, API, MCP, web; no chain/agent worker is started. Require the final Railway-URL and custom-domain smoke checks to pass.
4. Run **Production smoke** manually once. After it passes, set public repository **Actions variable** `PRODUCTION_MONITOR_ENABLED=true` (currently false). Keep the production environment variable `CUSTOM_DOMAINS_READY=true`.

Railway deployments are deliberate/manual. Ordinary pushes run checks, not production builds. Keep direct Railway GitHub autodeploy disabled. Resource ceilings and one replica per service remain unchanged.

The local EVM authentication change includes additive migration 015. Its session boundaries, browser integration
contract and rollback requirements are in [WALLET-IDENTITY.md](WALLET-IDENTITY.md). It does not activate EVM trading,
agent custody or cash-out and needs no new signing key or Railway service.
The subsequent session-to-worker change permits EVM inspection and revocation only. Release its compatible
worker before the API; NEAR's transport is unchanged and an older worker refuses the EVM descriptor. New EVM
authority and execution remain blocked in the API, worker and final execution authorizer.

## Alerts and response

The public smoke workflow checks HTTPS/routes, database/schema health, browser CORS/session behavior, operator-route isolation, background-service status and MCP-to-API readiness. It needs no secret, dependency installation or build. GitHub schedules can be delayed; this is a baseline external check, not a guaranteed 15-minute paging SLA. The operator must enable failed-workflow notifications and confirm receipt during the first manual run.

The Railway Observability dashboard has 12 widgets and, on the latest 7 November read, zero monitors. Resource alerts and receipt verification remain outstanding. [ALERTS.md](ALERTS.md) gives the exact chart values, current-volume filtering and a delivery exercise that does not stress production. Creating those monitors needs the UI; browser access is unavailable in this engineering session, and the exposed API has no creation mutation.

For an alert: check Railway deployment state/logs, then API `/health/ready`, MCP `/health/ready`, and `/v1/health/services`. Operator detail remains behind the bearer-protected route. Check whether a release or platform incident explains the change. Inspect the recorded deployment IDs before retrying a failed or canceled workflow; a queued Railway build may continue after GitHub stops. Never retry an uncertain wallet operation as an incident shortcut.

The chain status checker already exposes stale indexing, integrity and reconciliation alerts when a deployment is registered. Its alert thresholds and the agent/provider checks need an end-to-end exercise when those integrations are activated later.

### Agent authorization and uncertain payments

The agent-worker pre-deploy command now checks the authenticated Agent API key and the advertised network, wallet
contract and NEAR owner support, in addition to the restricted database login and deployment. It makes no transaction
or account creation. Confirm the key's tenant in the Defuse portal; a successful authentication does not prove that the
operator selected the intended tenant or that real custody execution works.

Worker `/health/ready` repeats those provider checks with a 2.5-second deadline, shares concurrent probes and caches
both success and failure for 30 seconds. Database checks remain uncached. A failed probe returns only `not_ready`;
`/health` and authenticated reconciliation remain available. Never restart the worker repeatedly to handle a provider
outage. The sweep retains its work and emits fixed messages without raw exception details.
[Railway health checks](https://docs.railway.com/deployments/healthchecks) gate deployment only; they do not provide
continuous monitoring. Ongoing provider alert delivery remains an activation requirement.

Policy signing now requires a locally constructed approval for both NEAR and EVM. Before enabling NEAR account
creation, confirm the provider's public storage sponsor account and set `AGENT_API_POLICY_SPONSOR` on the worker;
leave it blank only for unsponsored storage. Pin the same value (account or explicit `null`) in the agent activation
packet. The API's network/identity endpoints do not advertise this beneficiary, so authentication alone cannot
verify it. A different refund account in a generated request is refused before the owner's wallet opens.

Release the matching worker/API and browser builds together, with the worker first. Old unsigned NEAR policy
requests without approval context must expire and be regenerated. Previously submitted requests remain observable;
do not re-sign an uncertain transaction. This signing change needs no database migration or additional service.
Freeze/unfreeze requires an applied policy snapshot. If the newest revision failed, the worker checks up to 100
history entries against that same latest snapshot and restates the most recent applied rules, retaining the local
execution hold until confirmation. Pending revisions, history gaps, changed snapshots or missing applied rules
refuse new signing; reconcile the existing provider operation before retrying. Never reset revisions or copy failed
policy rules into an approval to bypass the refusal.

Owner-intent status and effects commit together under a row lock. A stale competing observation returns a retryable
service failure instead of undoing the newer result or reapplying an old freeze. Observe the same correlation again;
if the provider contradicts a recorded final result, preserve both pieces of evidence for investigation. Do not ask
the owner to sign a replacement to get past it.

Migration 016 adds `agent_accounts.policy_observation`, an ordering counter for local policy reads. Freeze and
unfreeze observations use the Agent API's current applied, synchronized policy instead of inferring current state
from an older intent's outcome. A response captured before another observation committed cannot overwrite it:
the counter update and intent status commit atomically, or both roll back. Provider reads happen outside database
transactions. Retry the existing correlation after `owner_policy_observation_stale`; the HTTP boundary exposes only
the generic service failure. Signed, failed, missing or unsynchronized policies keep the local execution hold.
A reported successful transition remains retryable until an applied policy can be read. Policy outages preserve
the stored status and hold, and the sweep continues reconciliation when the provider recovers. This is a provider
policy snapshot, not an independent live custody-state attestation; dispatch still checks policy and authority.

Before releasing 016, stop and drain old agent workers, apply the migration with the release job, then start the
matching worker and API builds. Do not overlap old freeze writers with the new worker: old code does not advance
the observation counter. The migration preserves accounts, grants and intents and needs no new service, credential
or Railway setting. For rollback, keep 016 and use a reviewed compatible build retaining its observation protocol;
older binaries fail the exact migration-checksum readiness check. Never delete the migration or reset the counter
to make an older worker start. Reconcile pending owner intents after restart before reopening agent execution.

`policy_not_ready` and `provider_policy_mismatch` block dispatch, including recovery resends. Inspect the Agent API's
applied revision, synchronization status and actual policy against the reviewed deployment. Do not disable the check
or broaden destinations to make an operation pass. `agent_authorization_stale` and `access_token_invalid` require the
owner to review the grant/connection, account state and expiry. Fresh owner consent is required to replace access.

Keep the original operation ID, request, correlation and receipt evidence when diagnosing an uncertain payment.
Revocation/freeze prevents new admissions; transactions already admitted may still settle. Receipt reconciliation
continues without issuing a new transaction. Pending, unknown and review-needed buys/stakes retain their reservation
regardless of age. Confirmation starts the 24-hour spending window; only proof of failure frees a reservation early.

`operation_plan_changed` means recovery would construct a different transaction from the one recorded before the
incident. Reconcile the original transaction against its original deployment and provider history. Keep it in review
until final evidence establishes success or non-execution. Never clear the reservation, change the recorded send,
delete an idempotency record or create a replacement request merely to get past the block. Returning to an older
compatible application may help inspect the original operation, but is not proof that no money moved.

## Backups, restore and updates

The earlier live logical restore drill passed all 13 migration checksums, 23 table counts, indexes, constraints and restricted-role checks. On 7 November at 22:40 UTC, the approved native Railway restore drill also passed: all 23 table digests, sequence state/definitions and 12 schema/permission catalog sections matched before reopening. The API unavailable interval was at most 223 seconds. The original volume remains detached for recovery; the restored mount retains daily and weekly backups.

After this branch reaches public `main`, run **Actions > Backup audit > Run workflow > main**, then approve the `production` environment job. This performs only metadata reads: exact token/project/environment, the currently mounted Postgres volume, daily/weekly retention of at least six/27 days and an unexpired backup within 36 hours. It records the latest qualifying timestamp in the job summary. It installs no dependencies, builds nothing and does not create, restore, delete or deploy anything. Run it between releases and after changing backup configuration; failure needs operator attention. It uses its own concurrency group so a read-only audit cannot replace a pending release.

This audit is manual because the available token can deploy and remains behind production approval. Unattended backup-failure alerting is not configured; do not weaken that approval gate or copy the deployment token into an unprotected scheduled workflow. The secret-free scheduled smoke check does not inspect backup metadata.

CI automatically exercises the actual logical backup script against PostgreSQL 18 fixture data. It restores into a fresh database, compares every public-table value, index, constraint and sequence, reapplies the release grants and checks restricted runtime access. It tests failed dumps, retention, concurrent-run refusal and checksum corruption. No production credentials or dumps enter CI, and no fixture archive is uploaded. This verifies the logical recovery procedure, not a Railway snapshot or an offsite copy.

The [native restore drill](RESTORE.md) records the completed writer freeze, fresh snapshot, exact before/after evidence, unchanged image digests and HTTP recovery checks. The evidence command also detects changed fixture data and unauthorized grants. The retained-volume rollback swap has not been exercised; it needs a new window and reconciliation of writes accepted after reopening.

Native snapshots are in the same Railway project and region; deleting/wiping the volume can delete its backups. They do not protect against project/account loss. A separate encrypted offsite backup and tested key recovery are additional disaster-recovery work before substantial durable user activity. Never commit dumps, database URLs, sealed grants or backup keys.

[OFFSITE-BACKUPS.md](OFFSITE-BACKUPS.md) specifies the independent account, restricted uploader, retention, recovery custodians and missing-backup alert. `backup.sh --encrypt` streams to an encrypted archive and has a tested recovery path through the read-only backup role. The bucket, upload job and recovery-key custody are not configured; local encryption tests are not offsite recovery evidence.

For runtime patches, review upstream release notes and scan the candidate image, retain the current digest, verify a recent backup, test database restore/collation compatibility if its image changes, and release once through the normal gate. Roll back application images only when compatible with the current schema; migrations remain append-only. Image advisories and their reachability limits are recorded in [RAILWAY.md](RAILWAY.md).

## Intents relay

The API stores access-key nonces and exact signed transactions in Postgres (`relay_keys`, `relay_submissions`). A database advisory lock serializes every process using the same network, verifier, relayer and public key. The transaction is committed to the journal before either simulation or broadcasting exposes its signed payload. Retries and rolling overlaps reuse those exact bytes; losing the database connection prevents further sends. All instances sharing a key must use this database. One replica remains the default for cost and bounded admission limits; the journal also protects deployment overlap. Mainnet refuses an in-memory-only journal.

The relay key is a FunctionCall key for the configured verifier's `execute_intents` only, with a finite allowance of at most 5 NEAR on mainnet. It spends that allowance separately from the account balance; gas top-ups cannot replenish it. Both RPC providers must agree on the key at the same finalized block. Below `RELAY_KEY_ALLOWANCE_ALERT_NEAR` (default 1), the API logs `relay_key_allowance_low`, `/health/ready` exposes `relay.keyAllowanceLow`, and the operator endpoint exposes `relay.keyAllowance`. Configure an alert before allowing traffic. Rotation requires draining and resolving every pending submission first, adding the new scoped key, updating both `RELAYER_KEY` and the approved public key, then revoking the old key. Preserve the old journal for recovery and audit; never reset its nonce or restore a stale journal into an active relayer.

An unexpected advance beyond the durable nonce stops new work with `relay_key_shared`; investigate other signers and restored databases. The nonce never rewinds automatically. An unknown transaction remains reserved. "Check again" retains the original signature and hash instead of requesting a new payment. Browser recovery holds the request across reloads and tabs. It clears only after proving every action's receipt outcome, or after both providers prove its nonce unused at a finalized block more than two minutes past the signed deadline. A partially completed registration and buy are evaluated separately; a fee can have been paid even if a later contract callback failed.

A signed payload is never sent with less than 20 seconds of life left, and a stalled `send_tx` is abandoned after 10 seconds in favour of reading the transaction status. A signer is paused for an hour after one execution the verifier refuses, or after three refunded actions in an hour. One signer can have one request in flight and one client network (an IPv4 address or an IPv6 /48) two. A client network that has had two requests in a minute end unfunded (`insufficient_balance`) or turned away `relay_busy` gets `rate_limited` until the minute is over, since fresh signing keys are free and each costs a paced balance read. Up to 16 balance reads wait at once, one a second.

Not mitigated: an attacker can drain a signer's balance between our simulation and our send, so our execute fails on our gas. It repeats with a fresh signer each round, so the signer pause does not bound it. It is not profitable: the attacker's own drain costs about 1.38 times what the relayer loses (measured in `backend/test/relay-payload-chain.test.ts`).

## Relay gas top-up

The Intents relay pays NEAR gas for EVM and Solana users and collects USDC fees. `npm run relay:topup` converts those fees back into gas. It is an optional separate Railway job scheduled every ten minutes, with no public domain, using its own database login and secrets. Its environment file is `.env.relay-topup` only; supply the common network and RPC configuration there too. It starts in `RELAY_TOPUP_MODE=dry-run`, which quotes and logs without signing. Mainnet execution still requires funded acceptance evidence in the activation plan.

Each run takes a Postgres advisory lock, so two runs never overlap, on any host. Its journal is a row of `relay_topup_journal` in the same database, written on the connection that holds the lock, so every host sees the same pending step. A relayer with no row is refused in execute mode (`topup_journal_missing`); a dry-run creates the empty row. The run first settles whatever the journal holds, withdraws any wNEAR above 0.1 NEAR sitting in the relayer's Intents account (smaller dust is left alone), and checks the balances. If spendable NEAR is below `RELAY_TOPUP_BELOW_NEAR` and the USDC balance is at least `RELAY_TOPUP_MIN_USDC`, it asks 1Click for a quote of up to `RELAY_TOPUP_MAX_USDC` USDC into wNEAR, from and to the relayer's own Intents account (`depositType`, `recipientType` and `refundType` all `INTENTS`). Deposits of the last 24 hours, from every run on every host, count against `RELAY_TOPUP_MAX_USDC_PER_DAY`; once less than `RELAY_TOPUP_MIN_USDC` is left the run ends with `daily_cap_reached`. Before quoting, the job reads `ft_metadata` of the collateral token and refuses to run if `COLLATERAL_DECIMALS` differs (`collateral_decimals_mismatch`), since a wrong value would switch the price check off. A quote whose minimum output prices NEAR more than `RELAY_TOPUP_MAX_SLIPPAGE_BPS` above the exchange median is refused. Otherwise the job signs a transfer to the quote's deposit address, waits for 1Click to report `SUCCESS` and the wNEAR to arrive, then signs a `native_withdraw` of the wNEAR to the relayer. Both intents are journalled first, then simulated, then sent through `execute_intents` with the job's own `RELAY_TOPUP_SUBMIT_KEY` (never `RELAYER_KEY`, so the API relay's key nonce is untouched). No RPC sees a signed payload before the journal holds it. After a crash the next run asks the chain whether that intent's nonce was spent. A spent deposit nonce counts as the deposit, even when someone else's transaction carried our payload. A spent withdraw nonce is not enough on its own: intents.near takes the wNEAR in the receipt that spends the nonce, but the NEAR arrives in later receipts that can fail. So when our own withdraw transaction failed while the nonce is spent, the withdraw counts only if the relayer's spendable NEAR rose by the amount, less up to 0.05 NEAR for gas, since the withdraw was signed. An unspent one is written off only when the chain's final block time, not the host clock, is two minutes past its deadline. It never sends the same payload twice. A `REFUNDED` status from 1Click clears the journal only when the relayer's USDC balance is back to at least what it was before the deposit.

In execute mode every run checks that the relayer's Intents key set (`public_keys_of`) is exactly the treasury key (`intents_key_set_unexpected` otherwise), and that the submit key is a FunctionCall key for `execute_intents` only, with an allowance of at most 5 NEAR (`submit_key_invalid` otherwise).

### One-time setup

1. Make a new key pair for the treasury. From `backend/`: `node --input-type=module -e "import { KeyPair } from 'near-api-js'; const k = KeyPair.fromRandom('ed25519'); console.log(k.toString()); console.log(k.getPublicKey().toString())"`. The first line is the secret, the second the public key.
2. Register the public key in intents.near for the relayer account. This needs a full-access key of `RELAYER_ACCOUNT_ID`, because the call carries 1 yoctoNEAR:

   ```sh
   near contract call-function as-transaction intents.near add_public_key \
     json-args '{"public_key":"ed25519:<TREASURY_PUBLIC_KEY>"}' \
     prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' \
     sign-as <RELAYER_ACCOUNT_ID> network-config mainnet sign-with-keychain send
   ```

   Check it with `near contract call-function as-read-only intents.near has_public_key json-args '{"account_id":"<RELAYER_ACCOUNT_ID>","public_key":"ed25519:<TREASURY_PUBLIC_KEY>"}' network-config mainnet now`.
3. Make a second key pair the same way for sending transactions, and add its public key to the relayer as a FunctionCall key limited to `execute_intents` on intents.near, like `RELAYER_KEY`. The allowance caps the NEAR the job can spend on gas:

   The job refuses a submit key with no allowance, or more than 5 NEAR.

   ```sh
   near account add-key <RELAYER_ACCOUNT_ID> \
     grant-function-call-access --allowance '1 NEAR' --contract-account-id intents.near --function-names execute_intents \
     use-manually-provided-public-key ed25519:<SUBMIT_PUBLIC_KEY> \
     network-config mainnet sign-with-keychain send
   ```

4. Put both secrets in `backend/.env.relay-topup`, chmod 600: `RELAY_TREASURY_KEY` and `RELAY_TOPUP_SUBMIT_KEY`. Set their approved public keys and the API's `RELAYER_PUBLIC_KEY` too. The job refuses the API's signing secret and requires three distinct keys. The API refuses either top-up secret. The treasury key can move the relayer's entire Intents balance, so protect it as a wallet key. To revoke it, enumerate `public_keys_of` for the relayer and remove every unauthorized key: a leaked treasury key can add keys of its own.
5. Generate a distinct `RELAY_TOPUP_DB_PASSWORD` and set it on the database release job. Its next run creates `dm_relay_topup_login` in the `dm_relay_topup` group, which can read and write its journal and append to its deposit record. Use that login's `DATABASE_URL` in the top-up service; it cannot access the API relay journal or user sessions.
6. Run once in dry-run and read the `balances` and `quote` log lines. This also creates the journal row. Then set `RELAY_TOPUP_MODE=execute`.

What the job cannot protect, by design:

- The treasury key has no limit on chain. `RELAY_TOPUP_MAX_USDC`, the daily cap and the slippage check live only in this code. Anyone holding the key, or running code on the job's host, can move the relayer's whole Intents balance. Keep that balance small: move fee income above what a few days of gas need to a cold account by hand.
- A `REFUNDED` is accepted once the collateral balance is back to where it was before the deposit. Relay fees land in the same account, so if fees earned during one swap reach the deposit, a refund that never came would pass. Nobody profits from forcing this (the fees would have to be paid by the attacker), and the daily cap bounds it, but a `refunded` run during heavy traffic is worth a look at the deposit address.
- A withdraw that someone else landed is accepted on the relayer's balance alone. NEAR sent to the relayer by hand between the signing and the check counts too, so a failed withdraw could pass unnoticed. Don't top the relayer up by hand while the journal holds a withdraw step.

### When it stops or something looks wrong

The job exits non-zero with a code in its last log line. These repeat on every run until a person looks, and no new swap starts meanwhile:

- `swap_needs_operator`: 1Click said `FAILED` or `INCOMPLETE_DEPOSIT`, or said `REFUNDED` while the USDC is not back (`reason: refund_missing`).
- `withdraw_failed`: the wNEAR was taken but no NEAR arrived. If someone else landed our withdraw first and our own transaction failed, the job checks the relayer's balance instead. Heavy relay traffic in the same minute can still hide the arrival, so compare the balance with the journalled `nativeBefore` and the amount before treating it as lost.
- `swap_output_missing`: 1Click said `SUCCESS` but the wNEAR is not in the Intents account.
- `topup_journal_missing`: no journal row. On a relayer that has run in execute mode before, the row was lost; read the last `deposit_sent` and `swap_status` log lines and check those deposit addresses before running a dry-run, which recreates the row.
- `intents_key_set_unexpected`: a key other than the treasury key is registered for the relayer in intents.near. Treat the treasury key as leaked: revoke every key (setup step 4) and make a new one.
- `collateral_decimals_mismatch` or `submit_key_invalid`: fix the configuration or the key.

`transaction_not_final` and `rpc_disagreement` mean an RPC could not prove an outcome; they usually clear on the next run.

1. Keep the relay running by sending NEAR to `RELAYER_ACCOUNT_ID` from an operator wallet: `near tokens <FUNDER> send-near <RELAYER_ACCOUNT_ID> '5 NEAR' network-config mainnet sign-with-keychain send`.
2. Read the journal: `SELECT pending, updated_at FROM relay_topup_journal WHERE relayer = '<RELAYER_ACCOUNT_ID>'`. For a swap step, check `curl "https://1click.chaindefuser.com/v0/status?depositAddress=<depositAddress>"` and the deposit address on the NEAR Intents explorer. For a deposit or withdraw step, check `is_nonce_used` on intents.near with the journalled nonce and the transaction hash on an explorer.
3. When the outcome is understood, record the row (paste it into the incident notes), then clear it as the database owner: `UPDATE relay_topup_journal SET pending = NULL, updated_at = now() WHERE relayer = '<RELAYER_ACCOUNT_ID>'`. The next run starts clean and first withdraws any wNEAR left in the Intents account. Leave `relay_topup_deposits` alone: it is the daily cap's record.
4. A refund from 1Click lands back in the relayer's Intents account as USDC, and the job clears the journal itself once it sees it.

## Deliberately deferred

- The owner selected the five supplied mainnet accounts for the hackathon. Deployment registration, code provenance, preflight/indexer/settlement validation and signing operations remain separate gates. CHAIN-ACTIVATION.md records the retrieved chain evidence and exact configuration names. No chain settings were applied to running services.
- Fresh Agent API endpoint/credentials after the upstream migration; no retiring keys.
- Real-wallet/agent actions and financial readiness testing.

Those deferrals do not prevent the website, API/database foundation and MCP hosting from being verified independently.

Sources: [Railway pricing](https://railway.com/pricing), [volume backups](https://docs.railway.com/volumes/backups), [resource monitors](https://docs.railway.com/observability#monitors).
