# Reviewed chain activation

This procedure is implemented on the private hardening branch. It has not activated production. It does not approve the rehearsal contracts, repair market 7, create a public NFT mint, provision credentials, fund accounts or prove partner API acceptance. Close the findings in [HUMAN-LAUNCH.md](HUMAN-LAUNCH.md) before admitting real users.

The intended replacement deployment is under `dragonsmarket.near`. Its child accounts, owner DAO and treasury are separate configuration values. Complete the [contract authority handoff](CONTRACT-AUTHORITY.md) before building the final approval packet. The automated checks below verify current key inventories and custody at a finalized block; the handoff must separately prove the actual DAO policy, upgrade execution and recovery.

The existing **Deploy Railway** workflow remains for the inactive hosting foundation. **Activate Railway** is a separate manual workflow with two stages and a default `check` action. Both workflows share the `railway-production` concurrency group and the protected public `production` environment. Only `SHC-Labs/DragonsMarket` public `main` can run either release. Private CI never receives production secrets. Application checks must pass again; contract checks remain a required public merge gate. Activation compares live contract hashes with the approved packet but does not rerun the contract build, deploy WASM or establish source equivalence itself.

## Review packet

After the team syncs the reviewed code publicly, prepare a JSON document with these fields. Store its exact UTF-8 bytes as the public repository's **production environment variable** `ACTIVATION_JSON`, and their lowercase SHA-256 as `ACTIVATION_SHA256`. Preserve bytes, including whitespace, when calculating the digest. Maximum packet size is 48 KiB. This packet contains public configuration and review links, never private keys, provider tokens or database passwords.

| Field | Value |
| --- | --- |
| `version` | `1` |
| `sourceCommit` | Exact 40-character public application commit to release. A sync commit can differ from the private commit. |
| `profile` | `human`, or `agents` only after the actual Defuse credentials and complete agent acceptance are available. |
| `keeperServiceId` | Dedicated Railway keeper service UUID after its approved creation. It must not reuse another service. |
| `publishersServiceId` | Optional. Dedicated Railway `publishers` service UUID; see [Price publishers](#price-publishers). |
| `publicRpcUrl` | Plain HTTPS origin usable by the browser, without credentials, query strings or fragments. |
| `keeperApproval` | The complete [keeper approval packet](KEEPER-APPROVAL.md), including the registered manifest, approved builds, custody, market allowlist and gas limits. |
| `launchEvidence` | HTTPS review record for funded human acceptance, market disposition, alerts, recovery and operating ownership. Required for `launch`. |
| `agent` | Omit for `human`. For `agents`, include plain HTTPS `apiUrl`, approved `walletContract` and HTTPS `acceptanceEvidence`. |

The keeper packet expires after at most 30 days. Generate `KEEPER_APPROVAL_JSON` with `JSON.stringify(packet.keeperApproval)` and `KEEPER_APPROVAL_SHA256` from those exact serialized bytes. Install the identical pair on `database-release` and `keeper`. Both digests detect configuration mismatch; neither is a reviewer signature. Reviewers must inspect the evidence themselves: these scripts validate link syntax but do not fetch or attest to the linked documents. People able to change protected configuration or deployed code control these gates.

Agent evidence must cover every exposed financial tool, including rounds funding and settlement if the approved manifest includes rounds. The current rehearsal rounds compatibility and publisher findings remain blockers for that profile. This workflow keeps the local `prices` service disabled. Round prices are signed only by the optional `publishers` service described below. It cannot be inferred from a valid Agent API key.

## Price publishers

Set `publishersServiceId` in the packet to the dedicated Railway `publishers` service to sign round prices. Without it, no service may set `PUBLISH_ROUND_PRICES`. It requires Rounds in the deployment. The service runs `dist/src/round-publisher.js` with the `dm_publisher_login` database role, deploys right after the keeper in both stages, and signs in both, because the funded acceptance needs settled rounds.

| Variable | Value |
| --- | --- |
| `PUBLISH_ROUND_PRICES` | `approved`; refused on every other service |
| `PUBLISHER_KEY` | Sealed. Every publisher secret this service signs with, comma separated. Their public keys must be registered on Rounds with `set_publishers`. |
| `PRICE_MAX_DEVIATION_BPS` | Largest spread between Coinbase, Kraken and Bitstamp; `PRICE_MAX_DEVIATION_BPS_BTC`, `_ETH` or `_NEAR` overrides it per asset |
| `ROUND_PRICES_KEY` | Sealed. A function-call key on the operator account limited to Rounds `record_price` |
| `ROUND_PRICES_ACCOUNT` | The approved operator |
| `ROUND_PRICES_RPC` | A plain HTTPS RPC origin |
| `PRICE_SIGNATURES_URL` | `http://server.railway.internal:3500` |

Recording carries no price authority: the contract checks the publishers' signatures itself, and `claim` settles a round. Keys held by one service are one operator's trust, whatever the threshold; move keys to independent holders before relying on the threshold.

## Before preparation

Deploy the approved Council consent update before the corresponding website build: its
`request_unstake` call now attaches exactly one yoctoNEAR, which older nonpayable code rejects.
Oracle/Rounds publisher replacement also needs the new approved contract build. Contract
storage layouts are unchanged by these methods; normal upgrade proof and code-hash approval
remain required.

The live approval check now requires empty NEAR access-key lists on all selected financial
contracts, the NFT's approved code hash, and a proven upgrade path on every financial contract. At the same
finalized block, both providers must confirm no Intents keys on the financial accounts,
predecessor authentication enabled, accounts unlocked and verifier `mt_transfer` unpaused.
Missing or malformed responses stop preparation. This check only reads; it does not seal
accounts, change custody or establish the real DAO's policy and execution evidence.

1. Release the reviewed inactive foundation first, including the new `/deployment.json` browser build record. Verify HTTPS, wallet connection and sessions. Keep the old deployment IDs for recovery.
2. Create the dedicated keeper service with one replica and an isolated volume at `/app/.local/feeds`. Initialize ownership and fsync access as described in [KEEPER.md](KEEPER.md). No signing keys during initialization. Use the committed `services.json` configuration for every service, no direct GitHub source/autodeploy connection, and no public domains or TCP proxies on workers. The normal keeper image runs as UID 65532. The workflow checks the mount, replica count, command, schedule and network exposure; the running job checks actual file access.
3. Add `KEEPER_DB_PASSWORD` to `database-release` without rotating the other service passwords. All service passwords must be distinct 32-byte lowercase-hex values, and each runtime URL must reference its matching password. Set `REGISTER_DEPLOYMENT=true` there. The release job verifies the packet before migrations, provisions roles, then registers the immutable manifest. Repeating an identical registration is safe; changing an existing manifest fails. A failed registration can follow successful migrations/role grants, so do not assume the whole release rolled back.
4. Set the same explicit `NETWORK=mainnet`, deployment ID/start block, contract IDs, collateral ID/decimals and two independent HTTPS RPC providers on the release job, server, indexer, reconciliation, verification and keeper. Preserve the recovered indexing boundary for an existing deployment; derive a new deployment's boundary from its verified deployment receipts. Use each service's restricted database login through `postgres.railway.internal:5432`; only the release job has the owner login. Provider bearer tokens belong only on the services that use them. The browser receives a public RPC origin, never a provider secret.
5. Keep `KEEPER_MODE=prepare` and all signing keys absent. Keep `agent-worker` and `prices` stopped. Clear the server's agent-worker link and credentials. Keep all browser contract, collateral and agent settings empty. The workflow checks both Railway variables and the actual published browser record, because changing build variables does not update an already-built website.
6. Obtain the archive quota and configure the bounded indexer pacing. Confirm daily/weekly backup retention and an unexpired backup within 36 hours. Arrange the monitored preparation window; the foundation-only scheduled smoke profile will correctly fail once the API is activated. Temporarily pause that schedule while the operator supervises preparation, then switch profiles and resume it after launch.

Configuration changes themselves can cause deployments in Railway. Provision and apply them only in the approved window, with signing keys absent and the relevant jobs stopped. Do not leave staged changes for the workflow to apply implicitly. Installing signing mode/keys is a consequential operating action even before pressing Run workflow; follow the custodian's controlled acceptance and schedule procedure.

## Prepare and catch up

Open public **Actions > Activate Railway > Run workflow**, select **main**, `stage=prepare`, `action=check`. Review and approve the protected environment job. This validates configuration, backups and live contract/code/control agreement through both providers, including the approved keeper account's gas reserve. It uploads nothing. It does not contact a signing or broadcast RPC method.

After a passing check, run `stage=prepare`, `action=deploy` for the same public commit. Upload order is:

`database-release -> indexer -> reconcile -> verify-chain -> keeper -> server -> mcp`

Every upload is awaited by its returned deployment ID, with matching project/environment/service identity. Jobs must stop successfully and emit their expected success result. Long-running services must reach running success. The website and agent worker are not rebuilt. Preparation may complete while indexing and keeper history are still catching up; that is not a launch result. Inspect private operator status, archive throughput, gas and storage growth. The keeper's five-minute cron remains keyless while it advances the persistent queue.

## Launch the reviewed profile

Before switching to signing, complete the controlled funded acceptance with the approved wallet and exact budget. Use the reviewed candidate application in that controlled test; a public launch is not a prerequisite for testing it. Keep final transaction receipts and balance changes with the review record. Resolve market 7, contract release/custody and NFT dependency findings; public minting additionally needs its actual contract interface and economics. Prove alert delivery and offsite recovery, and name the operator who can stop signing and handle incidents.

Install the approved scoped Market, Oracle and Council keys only on the keeper, plus a Rounds key exactly when Rounds is configured. Seal each variable in Railway and set `KEEPER_MODE=sign` under the approved operating procedure. The release gate first checks variable metadata: each key must exist exactly once, be sealed and belong to the keeper. It then requires Railway's null sealed-value markers; it never reads these private-key values. The keeper process derives their public keys and checks the approved identities, receiver/method permissions, finite allowances, current reports and finality before execution. The Oracle scope includes `payout_bond`; Rounds allows only `sweep_fees`. Never install an owner/treasury key or unscoped `KEEPER_KEY`.

For `agents`, configure only `agent-worker` with the current partner key, grant-encryption key, worker token, private IPv6 listener and approved wallet contract. Seal `AGENT_API_KEY` and `AGENT_GRANT_KEY`; the release checks their service placement and sealed metadata before requesting any variable values. Set the server's matching token and private link `http://agent-worker.railway.internal:3510`. Human-only launch rejects these credentials and keeps the agent worker stopped. Agent readiness does not prove the external key works; the reviewed partner acceptance must do that.

Railway [sealed variables](https://docs.railway.com/variables) remain available inside the deployed service but their values cannot be retrieved through the API. Sealing is irreversible for that variable value; keep recovery material under the custodian's existing secure procedure. Database credentials, RPC tokens and internal operator/worker tokens are still read transiently by the protected release job to verify service configuration and probe readiness. They are not copied into GitHub secrets, output or the public review packet. Do not describe the deployment token as unable to access all service secrets.

Set the web's `NEXT_PUBLIC_*` contract/network/RPC/backend/MCP values to the packet's exact values and `NEXT_PUBLIC_RELEASE_COMMIT` to `sourceCommit`. Its collateral must have six decimals. `NEXT_PUBLIC_TOKEN_ID` is the collateral account without `nep141:`. For agents, set the approved signing wallet contract and Agent API hostname; leave both empty for human-only. API/MCP origins remain `https://api.dragons.market` and `https://mcp.dragons.market`.

Run `stage=launch`, `action=check` first. It requires live indexing within 100 heights and a checkpoint at most 60 seconds old, solvent reconciliation within 15 minutes, successful integrity verification within 13 hours, and a current keeper preparation/check/signing pass. Missing, future-dated or failed evidence blocks the release. The only pre-signing alert allowed is `keeper_signing_disabled`.

A keeper pass currently marked `running` also blocks this gate. Wait for a successful completed pass and rerun the check; do not bypass it or treat an older successful timestamp as proof that the current run finished.

Then run `stage=launch`, `action=deploy` for the approved commit. It redeploys the same ordered services, the agent worker when selected, and the website last. Before each upload, it rechecks service configuration, credential metadata and live contract identity. Application-variable drift or changed variable IDs/timestamps/sealing stops the run, including rotation of a sealed key. Changing deployment status alone does not. Before uploading the website it requires a current successful **signing** pass and no operational alerts. It then checks the published commit/configuration record, API manifest, health, session/CORS isolation and MCP-to-API connection.

The job summary supplies the exact public `SMOKE_DEPLOYMENT_JSON` value. Set it as a **repository variable** for the secret-free **Production smoke** workflow, run that workflow manually, prove delivery, then re-enable `PRODUCTION_MONITOR_ENABLED=true`. Environment variables in `production` are not visible to that monitoring job, which intentionally has no environment approval or deployment credential. Keep the smoke expectation synchronized with every approved activated release.

## Failure and recovery

The workflow stops at the first failed gate. It does not retry uploads, undo migrations, cancel already-queued Railway builds, change on-chain state back, or erase a keeper journal. Keep deployment IDs and inspect them before rerunning. A successful keeper pass may have already submitted transactions even if a later API or web deployment fails; reconcile their final receipts. Never delete an ambiguous submission record to make the release pass.

If activation fails before the web deployment, the previous website remains. Stop new signing through the reviewed keeper operating procedure when required, preserve its volume and database, and retain safe user exits. Rolling back frontend code does not undo chain transactions. Use only an application revision compatible with the current schema and approved contracts. Restoring an old database after new chain transactions requires chain reconciliation and replay; it is not an automatic application rollback.

After deploying the Council consent fix, a rollback website must retain the one-yocto unstake call. An older zero-deposit client will be refused. Do not remove the contract guard to accommodate that client; recover with a compatible reviewed website build. Publisher rollback requires another reviewed owner replacement with a valid complete quorum, coordinated with the publishers.

Repointing to replacement contracts requires new build/custody approval and an explicit migration plan for existing positions, sessions, balances, keeper state and indexing history. Do not edit the existing deployment row or discard the original volume to fit a new address.

Railway's [cron lifecycle](https://docs.railway.com/cron-jobs) expects jobs to exit; the [pre-deploy command](https://docs.railway.com/deployments/pre-deploy-command) cannot initialize an attached volume. The workflow's completion and volume checks preserve those boundaries. This procedure has local failure-path and database tests, but its first approved production execution and funded acceptance remain outstanding.
