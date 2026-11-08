# Human and agent launch readiness

The requested scope includes human wallet trading, Council NFTs, and agent access with real USDC. Human wallet transactions do not require Agent API keys. Agent activation awaits Defuse's key portal; retired keys must not be reused. Hosting is online, but financial activation is still blocked. Do not describe the current URL as a live trading market until the acceptance evidence below exists.

## Six workstreams

| Work | Engineering result | Remaining dependency |
| --- | --- | --- |
| Market rules | Two providers agree that open market 7 resolves before its stated observation. The unsigned containment packet is prepared. | Contract owner signs the selected containment, preserves two existing holders, and approves a separate usable market. |
| Contract trust | Accounts, live hashes, links, original deployment boundary and ABI evidence are recorded. | Maintainer supplies the actual source/build artifact or performs a reviewed upgrade; Council NFT suitability and custody must be resolved. |
| Release | All retained work is on `fix/mcp-admission-and-browser-csp`, reviewed through private draft PR 21. The separate [activation workflow](ACTIVATED-RELEASE.md) prepares chain services, gates signing and publishes the verified browser build last. | Team review/private merge/public sync, approved configuration and the first protected production execution remain. No assistant merge or public write is authorized. |
| Chain operations | Reader handles the observed archive redirect, supports bounded prefetch and authenticated pacing, and preserves ordered checkpoint validation. | Approved archive quota and measured catch-up; manifest registration; scoped keeper credentials; supervised reconciliation. |
| Human journey | Portfolio cash-out sends an exact amount to the connected NEAR account. It verifies the final payout and retains ambiguous requests across reloads. Real verifier sandbox proves payment and refund behavior. | A real wallet, exact USDC/NEAR test budget, and an approved market for the complete funded lifecycle. |
| Recovery and alerts | Native restore passed previously. Encrypted dump creation/recovery tests and specific alert/retention instructions exist. | Independent storage and recovery custodians; actual offsite restore; Railway UI monitor creation and confirmed notification receipt. |

## Market 7 and a replacement

market-7-containment.json is an unsigned proposal. At block **223586651**, FastNEAR and dRPC agreed that the only open market has **1.15 USDC locked across two holders**. Its observation is 30 November at 23:59 UTC; it closes on 25 November at 19:36:55 UTC and must resolve by 26 November at 05:36:55 UTC. It has no structured `price_rule`, so starting the price collector cannot settle it automatically.

The reviewed source offers a global intake pause that preserves exits, or a narrower market halt that expires after 24 hours. Neither repairs the wording or deadlines. Do not delete positions, move the indexing boundary, silently reinterpret the question, or enable a keeper to resolve this question without an owner-reviewed disposition.

The replacement needs an observation during the hackathon and enough time afterwards for proposals, disputes, two jury rounds and callbacks. The observed oracle config at block 223586963 has a one-hour proposal/challenge window, two-hour panel deadline, one-hour draw window and `min_resolve_gap_ns=28830000000000` (8 hours and 30 seconds). Re-read these immediately before creating a market. Define the exact observation source and what happens when evidence is unavailable; do not silently shorten safeguards for the deadline.

## Contract owner handoff

The intended final deployment parent is `dragonsmarket.near`. The [contract authority handoff](CONTRACT-AUTHORITY.md) maps the current source's DAO, operator, user, publisher, keeper and callback permissions. Resolve its findings and exact initializer values before deployment. A parent account name does not identify the owner DAO or treasury. The rehearsal observations below remain evidence about those older accounts, not approval of a replacement release.

Send no private keys. The useful deliverables are the source commit, Cargo.lock, exact build command/image, the matching WASM hashes, and which humans operate the owner/operator, treasury and Council seats. Chain data already supplied the accounts and deployment receipts; there is no need to ask for those again.

The NFT ABI says `mock-nft`, and the repository's corresponding package explicitly says it is test-only. It lacks `nft_tokens_for_owner`; the Council page supports manual token lookup and checks the token's owner and Council eligibility. The deployed `nft_mint(token_id, receiver_id)` is owner-only and nonpayable. There is no approved public mint price or purchase interface to wire into a checkout. Public minting needs the maintainer's intended contract interface and price/storage policy, followed by wallet acceptance testing; changing an address alone cannot provide it. Review the deployed code and seat/custody policy, including migration for existing stakers. Accrued revenue remains claimable after the last seat leaves.

The local WASM hashes do not match the live financial contracts, whose source metadata has no commit/build information. An observed hash is not an approved release. Use the reproducible build procedure and `contracts/verify-build.mjs`; if replacing code, review state migration, account permissions and existing liabilities first. Hosting releases never deploy contract WASM.

Human Yes/No trading can be scoped independently of agent-managed rounds. The rounds v2 direct-token gap and missing USDC registration must stay explicitly deferred if taking that route. This does not defer the oracle, Council or NFT dependencies of human market resolution.

## Indexing and keeper

Keep start block **222353927** for the existing rehearsal deployment. A replacement deployment needs its own immutable manifest and a start block derived from its verified deployment receipts; retain the old history and liabilities. A finite live read recovered eight consecutive produced blocks from the rehearsal boundary through the real archive in 10.183 seconds, making 16 HTTP requests and receiving 967,782 decoded bytes. This proves archive access and ancestry validation, not adequate production throughput. The unauthenticated sample is too slow for the deadline, particularly while new blocks continue arriving.

`NEARDATA_CONCURRENCY` accepts 1-4 and defaults to 1. Requests share a single pacing schedule; parallel fetches never become parallel database commits. `NEARDATA_INTERVAL_MS` defaults to 400, with a hard lower bound of 100; faster than 400 requires `NEARDATA_BEARER_TOKEN`. Only the canonical host and the observed `a3.mainnet.neardata.xyz` archive are allowed. No arbitrary redirects, credential-bearing URLs or skipped history. The source still limits each cycle to 32 requests/128 MiB and each response to 32 MiB.

Get a dedicated provider key and approved archive quota before changing the interval. Benchmark the actual deployed worker, redirects, bytes and database writes. Required sustained throughput is the observed chain growth rate plus backlog divided by the allowed catch-up time. A nominal request limit is not achieved throughput. Stop on rate limits, gaps, changed hashes or memory pressure. The preflight's default-rate estimate remains a conservative planning baseline, not a claim about a paid provider.

Use the activation workflow's `prepare` stage to register the reviewed manifest with the migration owner, then start the indexer with its existing scoped login. Run reconciliation and verification before enabling transactions. Keep agent-worker off until the separately approved agent profile is ready. Do not treat `prices` as a keeper or an oracle publisher.

The keeper's `run` command completes one bounded pass. The packaged [keeper runner](KEEPER.md) exports the database feed and persists the queue in the same isolated job. A PostgreSQL advisory lock excludes overlapping runners and is released when the connection dies. The dedicated login can read indexed blocks/reports and update feed cursors/keeper status, but cannot read sessions or agent grants or fabricate reconciliation results. Preparation never loads signing keys. Restart and overlap tests exercise the real database, exporter and keeper queue. This branch now implements guarded signing with an expiring, digest-pinned [approval packet](KEEPER-APPROVAL.md), exact market allowlist, two-provider code/control checks, scoped keys, budgets and a durable transaction journal. A real local Council sandbox call and revoked-key refusal pass. Mainnet approval, Railway volume initialization, scoped keys/gas and actual deployed restart/acceptance remain uncompleted.

Use `--prepare-feed` to advance and persist the queue without loading signing keys or submitting transactions. Preparation and `--require-live-feed` consume at most 5,000 blocks/8 MiB per pass. The preparation service uses Railway's five-minute minimum cron interval. `--require-live-feed` retains catch-up progress and sends nothing until the feed is within 100 heights and 60 seconds of the finalized RPC head, which itself must be recent. An old queue without a timestamp stays blocked until it consumes a new block. Production signing also needs `--require-scoped-keys`, which refuses full-access keys, unlimited allowances and permissions outside the keeper's method set. These flags do not approve contract code or custody and do not replace the deployment checks.

## Agent activation

The private agent worker alone receives the partner key and grant-encryption key. Its pre-deploy check requires a mainnet manifest matching the database, a valid configuration and `dm_agent_login`; runtime readiness checks the schema and registered deployment. That check does not prove that an external partner key is valid. Configure the public API's private worker URL/token and browser signing destinations only when the actual Defuse portal credentials are available and verified.

Market and round operations now require `FINAL` transaction status, the requested signer/hash, a complete nonduplicated receipt graph, and the existing exact-call/event proof. Incomplete evidence stays unresolved; it cannot be promoted to successful settlement. The local agent-chain sandbox exercises the actual market, rounds and verifier against a local fungible-token fixture. It does not validate the deployed partner API or mainnet contracts. Agent cash-out's partner-operation proof and the full real-key lifecycle remain acceptance gates.

## Funded acceptance and release order

1. Owner resolves the contract and market findings. Record approved source hashes, account custody and a replacement-market decision.
2. Team syncs private changes publicly. Check public main CI, deploy the reviewed public revision through the protected workflow, and retain deployment IDs for rollback. Run the foundation smoke check before changing chain configuration.
3. Follow [ACTIVATED-RELEASE.md](ACTIVATED-RELEASE.md): prepare the approved manifest and chain services, finish historical/keeper catch-up, and prove current reconciliation/integrity. Complete controlled acceptance before the `launch` stage publishes the matching browser build. Never place provider server keys in `NEXT_PUBLIC_*` variables.
4. In a real wallet, confirm the exact network/account and test budget. Connect, accept the policies, sign the login challenge, register token/market storage if needed, fund Intents, buy a small position, sell part, resolve through the actual approved oracle process, redeem, withdraw the market balance to Intents, then cash out an explicit amount to the wallet.
5. Record transaction hashes, final receipt outcomes, token debit/credit and fee amounts. Test rejection, insufficient funds, expired quotes, account switching, provider outage and recovery of an uncertain submission. Reloading must not resend a transaction. Browser fixtures and sandbox balances are not funded acceptance evidence.
6. Confirm resource and application alerts arrive, run offsite download/decryption/restore with the recovery custodian, and record the on-call operator and rollback revision. Then admit wider users.

The cash-out test uses the repository-pinned real verifier, with a local mock fungible token. It proves the verifier's withdrawal and refund semantics at 100 Tgas; native-USDC behavior and the user's selected wallet still require the funded test. The UI intentionally blocks another cash-out while an earlier request is ambiguous. Clearing that notice requires checking wallet history and does not cancel a transaction.

## Recovery and alerts handoff

Use [ALERTS.md](ALERTS.md) for the ten monitor conditions and delivery drill. The exposed Railway schema has dashboard/chart mutations but no monitor creation mutation or monitor input in chart configuration; the available browser connection fails before opening the dashboard. No alert-delivery claim can be made from a chart alone.

[OFFSITE-BACKUPS.md](OFFSITE-BACKUPS.md) is the storage review packet: separate account, private bucket, retention protected from the uploader, public `age` recipients on the job, private recovery identities held separately, daily encrypted exports and a missing-backup alert after 36 hours. The Agent API backup implementation follows the same encrypt-before-upload and independently verified restore pattern; its TEE/key derivation is not needed for this Railway application. Do not reuse another project's storage credentials or recovery identities.

No independent destination or approved recipients have been supplied. Once selected, provision a dedicated read-only database login and restricted uploader, test a disposable protected object, wire the daily job, then prove restore from the actual retained encrypted object. Local encryption tests and Railway's native restore do not replace that test.
