# Dragons Market backend

The backend foundation provides PostgreSQL, versioned SQL migrations and a small HTTP API. Everything for this service lives here. The website and contracts keep their own build processes.

A finalized-event ingestion engine supports sandbox fixture replay, bounded actual sandbox receipt capture, immutable deployment registration, atomic checkpoints and status reporting. Mainnet follower code and supervised worker profiles are available, but no Dragons Market deployment is configured. Trading, funding and price submission remain disabled pending final contracts and source policy. Trading projections will follow the team's contract decisions. The [root checklist](../PENDING.md) tracks remaining work; the [delivery plan](../docs/hackathon-plan.md) contains the specifications.

## Run locally

Docker Engine and Docker Compose are enough:

```sh
cd backend
npm run up
```

The command builds the API, waits for PostgreSQL, applies migrations and starts the API at `http://localhost:3500`. You can also run `docker compose up --build -d --wait` directly without a host Node installation. PostgreSQL listens on `127.0.0.1:55432`. Both published ports are loopback-only.

Defaults are for local development. To customize them, copy `.env.example` to `.env` and edit it before starting. The default database password is public development configuration, not a deployment secret. Use URL-safe values for Compose's interpolated database credentials. The API uses `HOST` inside the container as `0.0.0.0`; its host port remains loopback-only. `PORT` changes the host port, while the container continues to listen on 3500.

```sh
curl http://localhost:3500/health/live
curl http://localhost:3500/health/ready
curl http://localhost:3500/v1/config
npm run logs
npm run down
```

`down` keeps the named database volume. Restarting or rebuilding also preserves data. Removing the volume deletes local data; it is never part of the normal startup command.

## API

| Endpoint | Behavior |
| --- | --- |
| `GET /health/live` | Process responds, even when PostgreSQL is unavailable |
| `GET /health/ready` | Checks database access, migration checksums and configured deployment identity; returns 503 on failure |
| `GET /v1/config` | Public network/deployment configuration and explicitly disabled capabilities |
| `GET /v1/indexer/status` | Last reported ingestion state, source mode, checkpoint, counts and sanitized error; no claim of live synchronization |
| `GET /v1/deployments` | The one configured deployment, or an empty list if none is selected; does not expose other registered deployments |
| `GET /v1/blocks` | Indexed block headers, including blocks without events |
| `GET /v1/events` | Successful receipt events, with exact payload values and receipt/log/data identities |
| `GET /v1/receipts` | Indexed receipt outcomes, including failed executions |
| `GET /v1/transactions/:transactionHash/receipts` | Configured-contract receipts carrying that originating transaction hash, with the same pagination and receipt filters |
| `GET /v1/health/services` | `{"status":"ok"}` or `{"status":"degraded"}` (any alert is active); 503 when the database cannot be read. No detail |
| `GET /v1/operator/services` | Indexer status, job/operation state counts, latest reconciliation and alert codes. Needs `Authorization: Bearer <OPERATOR_TOKEN>`; answers 404 for a missing or wrong token, or when `OPERATOR_TOKEN` is unset |
| `GET /v1/receipts/:receiptId` | One configured-contract receipt's actual outcome, or 404 if it was not captured |

Evidence reads require current migrations and an exactly matching registered deployment. With no deployment selected, `/v1/deployments` returns an empty list and evidence routes return 503. Empty indexed lists are valid when a registered deployment has no committed blocks. These routes make no provider calls.

Lists return `{data, nextCursor, network, deploymentId, asOf, indexing}`. Receipt detail returns a single `data` object without a cursor. Database field names inside `data` use snake case. Heights, nanosecond timestamps and monetary payload strings remain exact decimal strings. Events include `receipt_id`, `log_index`, `data_index`, `standard`, `version`, `event` and `payload`. Blocks omit the internal feed journal. Receipt `outcome` preserves `SuccessValue`, `SuccessReceiptId` or `Failure`; `SuccessReceiptId` does not establish that later callbacks or payments succeeded.

`asOf` contains the page walk's fixed `{height, hash, timestampNs}`. `indexing.latestCheckpoint` may advance while following its cursor. Metadata also exposes source ID/mode, last reported state/error, checkpoint commit time, `live` based on an expiring source heartbeat and state. A mainnet follower reports its sampled head and height difference; that difference includes skipped slots and is not a count of missing produced blocks. Fixture/local-capture lag remains unknown. The `running` state is a persisted report, not a heartbeat.

Blocks, events and receipts accept `limit` (default 50, maximum 100), `cursor`, `fromBlock` and `toBlock` (inclusive decimal u64 strings). Events additionally accept `receiver`, `standard`, `event` and `receiptId`; receipts accept `receiver`. Unknown or repeated parameters, invalid values and mismatched cursors return 400. Deployment/detail routes accept no query parameters. Database failures return a sanitized 503. Missing receipt detail returns 404 within the selected capture, not a claim that the receipt does not exist on-chain.

Ordering is ascending block height, then receipt ID with bytewise collation, then log/data index for events. It is deterministic pagination, not execution ordering across shards. A cursor fixes the upper indexed block and binds route, deployment, network and filters; keep those filters when following `nextCursor`. Page size may change. New blocks appear on a fresh walk. Cursors are navigation tokens, not authorization credentials. Requests use read-only repeatable-read transactions and parameterized SQL. Query timeouts and page limits bound reads; public deployment still requires rate limiting and restricted database roles.

```sh
curl 'http://localhost:3500/v1/blocks?limit=20'
curl 'http://localhost:3500/v1/events?standard=rounds&event=fee_set&limit=20'
curl 'http://localhost:3500/v1/receipts?receiver=rounds.sandbox'
```

Transaction-hash lookup returns observed receipts for configured contracts only, plus generated child receipt IDs. It explicitly does not infer complete transaction success. A child or root transaction outside that scope/window may be unobserved. Historical receipts captured before migration 005 have unknown provenance; hashes are never invented. Market/round/position/pricing routes also remain pending the contract model and product projections. No financial state is inferred from generic events.

Readiness means this foundation can serve requests. It does not prove that an indexer is synchronized, a contract exists, or trading is available. The response labels that scope. An unconfigured deployment is reported as `null`; the API never invents contract IDs. CORS allows only the configured website origin. Database connection strings are never returned.

## Configuration

The deployment can be entirely unset while developing the foundation. Partial deployments are rejected. Configuring one requires `DEPLOYMENT_ID`, `DEPLOYMENT_START_BLOCK`, collateral token ID, verifier ID and at least one market/rounds contract ID. Other contract IDs are optional. Amounts and chain-sized integers use decimal strings.

The public manifest uses an allowlist of fields. Provider URLs and credentials stay server-side. Keep private provider credentials out of `RPC_URL`; credential-bearing query strings/userinfo are rejected. Network labels and obvious account suffix mismatches are validated. The API does not make live chain checks during startup; use the explicit RPC diagnostic below before connecting a deployment.

A configured deployment must already have an exact matching row in `deployments` for readiness to pass. Register it explicitly with the CLI below. Registration checks the configured values and refuses to overwrite an existing identity. It does not verify that those contracts are deployed on-chain or start a live follower. No deployments are seeded automatically.

## Free RPC providers for testing

Provider defaults follow `NETWORK`. Selecting an RPC URL alone does not create or activate a contract deployment.

| Network | Primary RPC | Archival RPC for explicit checks/recovery |
| --- | --- | --- |
| `sandbox` | `http://127.0.0.1:3030` | None |
| `testnet` | `https://test.rpc.fastnear.com` | `https://archival-rpc.testnet.near.org` |
| `mainnet` | `https://free.rpc.fastnear.com` | `https://archival-rpc.mainnet.near.org` |

The API still defaults to sandbox with financial actions disabled. Inside Docker, set `RPC_URL` to an address that can reach the development chain; container loopback is not the host. The new diagnostic can be run from the host without a database or contract deployment:

```sh
NETWORK=testnet npm run rpc:check
# Or check the public mainnet sources with read-only requests:
NETWORK=mainnet npm run rpc:check
```

The diagnostic sends at most three requests per configured endpoint: chain identity, latest finalized block, and `EXPERIMENTAL_indexer_block` for that exact block hash. It does not scan history or send transactions. Requests are serialized per client with a one-second minimum spacing and a timeout. It does not retry or automatically transfer normal traffic to the severely limited archival service. A normal read succeeds even if the optional indexer method is unsupported; the report states both results separately.

`RPC_URL` and `RPC_ARCHIVAL_URL` override the defaults. For a future paid primary endpoint, set `RPC_URL` and, if its documented authentication uses Bearer headers, `RPC_PRIMARY_BEARER_TOKEN`. This token is sent only to the primary endpoint over HTTPS; archive requests and `/v1/config` never receive it. Redirects are refused to avoid forwarding credentials. Provider errors are sanitized.

These are RPC providers, not an established finalized-event ingestion source. An indexer-method response still needs schema/shard/finality checks and historical coverage validation. `indexing` remains disabled. We have not assumed that archival mode alone exposes complete receipt execution outcomes.

The 1RPC endpoint is not enabled: earlier probes from this machine returned HTTP 403, and its documented public quota is unsuitable for continuous block ingestion. Free-provider limits can change. Use these endpoints for bounded development checks; do not load-test them. References: [NEAR provider list](https://docs.near.org/api/rpc/providers), [NEAR indexer client requirements](https://github.com/near/near-indexer-client).

## Ingestion engine

The engine accepts normalized blocks through a replaceable `BlockSource` interface. The available sources are finite synthetic sandbox JSONL fixtures and bounded captures of explicitly known local sandbox transactions. Neither source is a public-network follower; both are restricted to sandbox deployments. These restrictions keep test events out of public-network histories.

A block supplies `network`, `finalized: true`, a header with decimal-string height/nanosecond timestamp plus hash/predecessor, and receipt IDs, receiver IDs, execution statuses and original logs. See `test/fixtures/blocks.jsonl`. Future live connectors must establish finality, complete receipt coverage and history access before producing this format. The `finalized` flag itself is an assertion, not a cryptographic proof.

For a local replay, use an explicit sandbox deployment. These are fixture names, not deployed contracts. Run from `backend/` after `npm ci`, `npm run build`, starting local PostgreSQL and applying `npm run migrate` with the same database URL:

```sh
export DATABASE_URL=postgresql://dragons:dragons_local_only@127.0.0.1:55432/dragons_market
export NETWORK=sandbox
export DEPLOYMENT_ID=fixture-replay
export DEPLOYMENT_START_BLOCK=100
export ROUNDS_CONTRACT_ID=rounds.fixture.near
export VERIFIER_CONTRACT_ID=verifier.fixture.near
export COLLATERAL_TOKEN_ID=nep141:usdc.fixture.near
# Other contract IDs must be unset for this fixture deployment.
npm run indexer -- register
npm run indexer -- replay test/fixtures/blocks.jsonl
npm run indexer -- status
# Repeating replay reports zero new blocks and three replayed blocks.
```

Use a separate shell/environment from any real deployment. The default API stays unconfigured; it does not automatically switch to this fixture deployment. To inspect that deployment through `/v1/indexer/status`, start an API instance with the matching deployment environment. CLI status can inspect it without changing the running API.

For each block, the engine:

1. Checks network, finality assertion, header/receipt shape and size limits. Heights and timestamps remain exact strings; unsafe unquoted JSON integers are rejected.
2. Selects the configured market/rounds/oracle/Council receivers and their matching event standards. Verifier funds projection is deferred. Failed receipt logs never create events; incomplete outcomes stop ingestion.
3. Accepts the currently implemented `1.0.0` event envelopes, preserving original logs and splitting nonempty data arrays by data index. New event names are retained without inventing financial meaning. Unsupported relevant versions stop progress.
4. Checks predecessor continuity. Numeric height gaps are valid when the predecessor hash matches. The first block must match the inclusive configured start height.
5. Commits raw events, a block journal entry, counters and checkpoint in one database transaction, including blocks without events.

A session advisory lock permits one worker per deployment. Replayed blocks are compared against stored scoped-content fingerprints; changed hashes or relevant receipts fail rather than being silently skipped. Restart replay begins at the fixture's beginning and safely skips matching committed blocks. A future live connector can use the durable checkpoint to fetch only missing history.

`indexed_blocks.keeper_payload` retains committed scoped receipts in the keeper's expected block shape. A durable feed exporter, scheduling jobs, contract reconciliation, market/position projections and history API remain separate work. No keeper actions are dispatched by this engine.

Status reports `replay_complete`, `running` or `error`, source mode (`fixture`, `local_capture` or `live`), counts, checkpoint and sanitized errors. `running` is a persisted report, not process liveness. Mainnet source metadata has an expiring heartbeat and sampled-head height difference; fixture/local-capture runs retain `live: false` and unknown lag. Public configuration indicates whether indexing is configured, not whether the worker is synchronized. Database failures return HTTP 503 rather than fabricated progress.

The fixture importer caps a line/normalized block at 8 MiB, receipts at 10,000 and a log at 64 KiB. Large real blocks require a source/limit review before live operation. Source read errors, block gaps and SQL failures leave the last committed checkpoint intact. To recover, fix the cause and replay; never edit checkpoints to skip a missing block.

## Real local-chain integration

```sh
# From backend/, with local Postgres running and the repository Node runtime selected:
TEST_DATABASE_URL=postgresql://dragons:dragons_local_only@127.0.0.1:55432/dragons_market npm run test:local-chain
```

This command compiles the existing rounds contract using the pinned Rust toolchain and `cargo-near`, then starts an isolated NEAR sandbox (version 2.13.4). It deploys the actual WASM, initializes it through the contract account and executes three successful configuration calls and two rejected calls. No contract source is changed. No funded prediction, verifier transfer, dispute or payout is exercised by this test.

The capture reader checks a loopback-only RPC endpoint and refuses mainnet/testnet chain identities. It retrieves `FINAL` results for the five known transactions, preserving both successful and failed receipt outcomes. It follows actual parent hashes backward from a finalized head to the pre-test anchor, then presents the entire bounded interval in forward order, including empty blocks. Nanosecond timestamps come from the exact string field, never the RPC's numeric timestamp.

The test verifies receipt IDs, event payloads and final contract settings against PostgreSQL, serves the actual events and both rejected receipt outcomes through HTTP, reopens its database pool mid-ingestion and replays the interval without duplicate events. It removes its temporary database schema and tears down its sandbox. The existing website chain descriptor and running chain are untouched.

`LocalSandboxReader` and `captureLocalTransactions` live in `src/ingestion/local-source.ts`. The source is labelled `local_capture`, not `fixture` or `live`. The third migration adds that status label. Migration 004 indexes receipt outcomes and backfills committed journals. Migrations 005 and 006 add source heads, transaction provenance, jobs, operations, price/signing evidence, reconciliation reports and wallet sessions. Migration 007 enforces append-only deployment identities so service users do not need deployment-update privileges. It captures only the known calls controlled by this isolated harness. It cannot discover arbitrary users' transactions and must never be presented as complete network ingestion.

Prerequisites are the repository Rust toolchain, WebAssembly target, `cargo-near`, Node 24.21.0+ in the 24.x line and local PostgreSQL. The official `near-sandbox` and `near-api-js` packages are test-only dependencies. The first sandbox run downloads its pinned binary. Build output, binary cache and sandbox temporary files stay under ignored `backend/.local/`; that folder is excluded from Docker builds. The test prints the WASM SHA-256 and receipt/event counts for its actual run.

A mutation check also confirmed that incorrectly marking rejected receipts as successful makes this integration fail. The correct adapter was restored afterward. The separate public-RPC capability checks still do not establish a complete live receipt stream.

## Bounded mainnet source verification

```sh
# Explicit external-network check; from backend/ with local development PostgreSQL running:
TEST_DATABASE_URL=postgresql://dragons:dragons_local_only@127.0.0.1:55432/dragons_market npm run test:mainnet-capture

# Optional: inspect this specific public account over ten produced blocks instead:
CAPTURE_RECEIVER=intents.near CAPTURE_BLOCKS=10 TEST_DATABASE_URL=postgresql://dragons:dragons_local_only@127.0.0.1:55432/dragons_market npm run test:mainnet-capture
```

This is a finite mainnet observation check, not the live follower. It sends read-only requests to `https://mainnet.neardata.xyz` and `https://free.rpc.fastnear.com`, without keys or transactions. Normal unit/database tests never contact mainnet. The default captures five produced blocks, with a hard limit of twenty. It follows the sampled finalized head backward through `prev_height` and verifies parent hashes, timestamps and complete reported shard coverage. Skipped numeric heights are handled through ancestry rather than silently accepting missing responses.

The reader accepts only finalized paths on the fixed mainnet host. It spaces requests by at least one second, allows at most 32 HTTP requests including redirects, caps each response at 32 MiB and the run at 128 MiB, and stops on malformed data, rate limits or unavailable history. Redirects to other archive hosts are refused until explicitly reviewed. Provider errors leave the check failed; this tool does not implement continuous retries. See the [NEAR Data source](https://github.com/fastnear/neardata-server) and [provider documentation](https://docs.fastnear.com/neardata).

The sampled head hash/timestamp is checked through the mainnet RPC after verifying its chain identity. Both interfaces belong to FASTNEAR; this is an interface consistency check, not independent consensus or proof verification. The reader trusts the provider's finalized-block assertion.

Unless `CAPTURE_RECEIVER` is provided, the harness selects the sampled account with the most successful `EVENT_JSON` logs, with a deterministic account-name tie break. A quiet sample fails rather than manufacturing events. No observed account is registered as a Dragons Market contract. Only its selected receipts/logs are persisted; other accounts are inspected in memory for coverage and selection.

### Capture field mapping

All capture tables live in a unique temporary `capture_<uuid>` schema. The schema records `mainnet`, `source_verification`, the receiver and starting height. It is removed after the test, including on failure. No app migration, deployment row, website configuration or production checkpoint changes.

| NEAR Data field | Capture database field | Future application mapping |
| --- | --- | --- |
| `block.header.height/hash/prev_hash/timestamp_nanosec` | `captured_blocks` with exact decimal height/time, source shard IDs and scoped digest | Existing `indexed_blocks` |
| `receipt_execution_outcomes[].execution_outcome.id` | `captured_receipts.receipt_id` | Existing `indexed_receipts.receipt_id` |
| `execution_outcome.outcome.executor_id` | `receiver_id`, checked against receipt receiver when supplied | Existing receipt receiver |
| `receipt_execution_outcomes[].tx_hash` | `transaction_hash`, indexed for lookup | Add transaction provenance to app schema |
| `execution_outcome.outcome.receipt_ids` | `child_receipt_ids` JSONB | Add receipt graph edges to app schema |
| `execution_outcome.outcome.status/logs` | Exact outcome/logs JSONB, retaining failures | Existing outcome and raw-log journal |
| Successful `EVENT_JSON` log | `captured_events`: receipt/log index, original log, whole parsed envelope, malformed flag | App event parser must validate the selected contract standard/version and expand data indices |
| Last committed block | `capture_checkpoint` | Existing deployment checkpoint |

Large integer JSON lexemes are preserved as strings before JavaScript can round them. Token strings remain strings; no balance, price or payout calculation is performed. Unknown event standards remain uninterpreted evidence. Malformed event logs are flagged and retained; failed-execution logs never enter the capture event table. One captured event row is one log envelope, while app `raw_events` expands envelope data items into separate rows.

The test compares persisted receipts, originating transaction hashes, generated receipt IDs, outcomes, logs, event envelopes and exact block timestamps against the captured source. It reconnects halfway, resumes, then replays the entire capture without duplicates. Conflicting replay, partial SQL failure, account mismatch and ancestry gaps have separate database tests. A receipt can originate from a transaction outside the sample; retained hashes/edges do not establish a complete execution tree or transaction success.

On 2026-10-27 the final verified run captured blocks `221887552`–`221887556`, selected `intents.near`, and stored eight receipts, ten event logs and six distinct originating transaction hashes. One selected execution failed; its actual outcome was retained and its logs were excluded from events. The sampled head matched mainnet RPC by hash and timestamp. Reconnect and duplicate replay passed; the temporary schema was removed. Counts vary with actual mainnet activity.

Source normalization is in `src/ingestion/neardata.ts`; verification persistence is in `src/ingestion/capture-store.ts`. The verification store stays separate from app deployment data. The app ingestion path now also stores transaction provenance and has a continuous follower. Actual Dragons Market deployment activation and financial integration remain pending. See [PENDING.md](../PENDING.md).

## Remaining backend services

Contracts are **not deployed** and their trading interfaces are still being finalized. Keep deployment fields empty. The following commands provide tested infrastructure; they do not enable financial execution.

### Round price publisher

`src/round-publisher.ts` (a `publisher` Compose service in the `publishing` profile) signs the start price of each round of every rounds series it can price: assets named `btc-usd`, `eth-usd` or `near-usd`, with the first start and interval on five-minute boundaries. For a round whose moment has settled (20 seconds after the boundary, up to 30 seconds before its price window closes) it reads the closed one-minute USD candle ending at the boundary from Coinbase, Kraken and Bitstamp, keeps every response as evidence, takes the median at the series' decimals only if all three answer and agree within the spread, so that every publisher signs the same price, and signs `round-price:v1:<rounds>:<network>:<asset>:<moment ns>:<price>:<decimals>`. It records the decision before signing, so a second, different price for a signed round is refused even after a restart. An unsigned reservation (a crash between the two steps) is replaced.

It refuses to start unless `PUBLISH_ROUND_PRICES=approved` and `PRICE_MAX_DEVIATION_BPS` are set (the source rules are the owner's decision, so there is no default spread), the key file is readable only by its owner, and its key is a publisher on the rounds contract. `GET /v1/price-signatures?seriesId=N&round=R` serves the signatures it holds, each with the message it signed. Signed decisions are write-once in the database (migration 010), and the publisher has a login of its own (`dm_publisher_login`) that no other service shares.

Recording is open to anyone: `node contracts/keeper/round-prices.mjs run --rpc URL --rounds ID --account ID --publishers URL,URL --key-file PATH` fetches the entries from each publisher's backend, keeps only signatures from keys the contract lists over one agreed price, and calls `record_price` when at least `price_threshold` agree (`--dry-run` only reports). A test deploys the unchanged rounds WASM in a sandbox and shows it accepts a price signed by this publisher key and rejects the same signature over another price.

### Running against mainnet

Nothing runs until the contracts are deployed. When they are:

1. Put the real values in `.env`: `NETWORK=mainnet`, `DEPLOYMENT_ID`, `DEPLOYMENT_START_BLOCK` (the block of the earliest contract deployment), the `MARKET_`, `ROUNDS_`, `ORACLE_`, `COUNCIL_` and `VERIFIER_CONTRACT_ID` accounts, `COLLATERAL_TOKEN_ID` (native USDC is `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`), `RPC_URL` and its bearer token, `WEB_ORIGIN`, and `TRUSTED_PROXY_HOPS`/`TRUSTED_PROXY_ADDRESSES` if a proxy fronts the API.
2. `docker compose up -d postgres migrate roles`, then register the deployment as the database owner: `docker compose run --rm -e DATABASE_URL=postgresql://dragons:<owner password>@postgres:5432/dragons_market api node dist/src/ingestion/cli.js register`.
3. `npm run preflight`. It reads the chain and writes nothing, and checks that the RPC is on mainnet and fresh, NEAR Data matches the RPC head, every configured account has code, each contract's verifier and collateral match the configuration, none is paused or mid-upgrade, the oracle, Council and market allow-lists name each other, the books are solvent at one finalized block, the database is current and the deployment matches, and the start block is behind the head (with a warning if catching up will take more than a day). It exits 1 if anything fails. Do not start the workers until it prints `ready`.
4. `docker compose --profile indexing up --build -d`, then watch `GET /v1/operator/services`. `indexer_lagging` is expected while catching up. `reconciliation_stale` and `chain_integrity_stale` clear after the first pass of each worker. Any other alert, or `chain_integrity_failed`, means stop and read the worker logs.
5. To stop, `docker compose --profile indexing down`. The checkpoint is in Postgres, so a restart continues from the last committed block.

### Mainnet follower and keeper feed

```sh
# After receiving and registering the real complete mainnet deployment manifest:
npm run indexer:follow
npm run keeper:feed -- --follow
# Or opt in to supervised containers:
docker compose --profile indexing up --build -d
```

The indexer samples a finalized NEAR Data head, reads forward from the database checkpoint and commits at most twenty height slots per cycle. Null slots are not committed; the next produced block must directly reference the previous committed hash/height. Missing history, conflicting ancestry and unsupported relevant events stop processing. Transport/rate-limit failures retry with exponential backoff up to sixty seconds; no checkpoint advances for an uncommitted block. Budgets reset per batch while preserving a 400 ms request spacing (at most 150 requests/minute for this reader). Success cycles pause 200 ms. The bounded inspection command retains its slower one-second spacing. These settings allow catch-up on the observed roughly two-block-per-second chain; operator monitoring must still check sustained throughput and provider limits. A separate lock prevents competing follower processes. Network identity is checked via RPC on startup. Finality and shard coverage remain provider assertions with structural checks, not independently verified consensus.

All configured receivers, including the verifier, retain receipt outcomes and available transaction/child links. Verifier logs stay uninterpreted until its event projection is reviewed. Existing app standards remain validated by role/version. Adding provenance to previously indexed historical blocks changes the scoped fingerprint; use a reviewed new deployment/backfill strategy rather than silently changing committed evidence.

`live` expires after thirty seconds without a fresh head/heartbeat; it reports recent observation rather than proving a process is still alive. The API retains last indexed data during source outages. Readiness checks database/schema/deployment consistency; use `/v1/indexer/status` and `/v1/operator/services` for indexing and recovery health.

The feed exporter writes committed JSONL under `backend/.local/feeds`, syncing bytes before acknowledging their offset in PostgreSQL. On restart it compares unacknowledged bytes against the committed journal, completing a matching partial line or acknowledging an already-complete append without duplicating it. Truncation, changed content and missing checkpoint evidence fail visibly. It checks the last acknowledged line; archive integrity still belongs in backup verification. Symlink destinations are refused. A stable relative-path lock coordinates host/container exporters sharing the same database and feed mount. Do not edit feed files manually or share a destination across unrelated databases. The existing contract-team keeper consumes this file through its `--events-file` option. Starting its signing process and giving it restricted operational keys is a separate deployment step.

### BTC, ETH and NEAR observations

```sh
npm run prices:collect
npm run prices:collect -- --follow
# Optional supervised price observation service, independent of a Dragons deployment:
docker compose --profile prices up --build -d
```

Binance uses `data-api.binance.vision` with BTCUSDC, ETHUSDC and NEARUSDC. It requests the closed one-minute candle ending at a five-minute boundary and verifies the opening/closing interval and nonzero trade count. This is a proposed candle-close method, not an approved trade-tick oracle policy. CoinGecko uses its USD `simple/price` response with `last_updated_at`; it is display-only and is never substituted for the historical boundary. Both provider routes worked publicly for all three assets on 2026-10-27. A future CoinGecko demo key goes in `COINGECKO_DEMO_API_KEY` and is sent only in its header.

Coinbase (`BTC-USD`, `ETH-USD`, `NEAR-USD`), Kraken (`XXBTZUSD`, `XETHZUSD`, `NEARUSD`) and Bitstamp (`btcusd`, `ethusd`, `nearusd`) supply the same closed one-minute candle in USD, one public request per asset each cycle. The adapter checks that the candle opens one minute before the boundary and has trades: Coinbase leaves out a minute without trades, Kraken and Bitstamp return it with zero count or volume, and Kraken frames after `last` are still open. All nine requests answered at 03:20 UTC on 2026-10-28; BTC and ETH closed on all three venues, and none of them traded NEAR in that minute. [Coinbase candles](https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles), [Kraken OHLC](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data), [Bitstamp API](https://www.bitstamp.net/api/).

CoinMarketCap adds batched USD latest quotes for BTC (ID 1), ETH (1027) and NEAR (6535) through `/v3/cryptocurrency/quotes/latest`. Set `COINMARKETCAP_MODE=keyed` with `COINMARKETCAP_API_KEY` in the ignored server-side `.env`, or `keyless` to use the documented `/public-api` prefix without authentication. `off` disables it. The key is sent only in `X-CMC_PRO_API_KEY`, never in a URL or to the public route. Compose passes it only to the price worker. Both modes count as the same provider; no automatic route switching on rate limits. One batch runs per five-minute cycle, rather than one call per asset. Failed observations wait until the next cycle in follow mode.

The keyed adapter returned all three assets successfully on 2026-10-27. The keyless route returned HTTP 429, so its parsing is covered by tests but a successful public response has not yet been verified here. Prices retain their source timestamps and exact decimal strings; missing assets, incorrect IDs/quotes and observations older than 120 seconds are refused. Latest prices are display evidence only. CoinMarketCap's historical quote endpoint selects the nearest available quote and is not implemented as an exact-boundary settlement source. [Keyless API documentation](https://coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api/), [quote endpoint and historical timing](https://coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency/).

Raw evidence, response hash, source/retrieval time, quote, boundary and quality reason are persisted. Large decimal prices stay exact strings and scale with BigInt. The signed price follows the keeper publisher (`contracts/keeper/prices.mjs`): closes are read to twelve digits (further digits cut), an even count averages the middle pair rounded down, and the result is rounded half up to the series' decimals. `test/fixtures/price-vectors.json` pins these cases and runs through both implementations. The collector stores source observations; it does not write a price to a contract. In follow mode it runs at five-minute boundaries and shuts down on SIGTERM/SIGINT.

USD, USDC and USDT are not interchangeable. USDT is not requested. Multiple Binance hosts are one provider. Binance-USDC boundary data plus CoinGecko/CoinMarketCap-USD latest data cannot form an exact independent quorum; the candidate validator rejects it. The three USD candles can, and are recorded as not yet approved for signing. Approval of semantics, quorum/deviation/precision and missing-data handling is still required. [Binance docs](https://developers.binance.com/en/docs/products/spot/rest-api), [CoinGecko docs](https://docs.coingecko.com/reference/simple-price).

### NEAR wallet sessions and private records

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/auth/challenge` | JSON `{accountId}`; browser-bound five-minute challenge and HttpOnly challenge cookie |
| `POST /v1/auth/verify` | JSON `{id,publicKey,signature}`; verifies NEP-413 Ed25519 signature and that its key is FullAccess at the configured network's finalized state |
| `GET /v1/auth/session` | Current account/network/expiry or null |
| `POST /v1/auth/logout` | Revokes session and clears cookie |
| `POST /v1/auth/logout-all` | Deletes every session the signed-in account has, on every device, and clears the cookie |
| `GET /v1/watchlist` | Up to 200 items for the authenticated account and selected deployment |
| `PUT` / `DELETE /v1/watchlist` | JSON `{item}`; account-scoped save/remove |
| `POST /v1/policies/acknowledge` | JSON `{termsHash,privacyHash}` matching configured published policy hashes |
| `GET /v1/operations/:id` | Authenticated owner's operation state/evidence; another account gets 404 |

Wallets must pass the challenge's exact `message`, base64-decoded 32-byte `nonce`, `recipient` and `callbackUrl` to NEP-413 signing. POST back the returned public key and base64 signature with the same browser cookie. The message binds account, network, origin, challenge ID and expiry. Challenges are single-use even under concurrent verification. A session ends 7 days after sign-in (`SESSION_ABSOLUTE_SECONDS`, 604800) or after 12 hours without use (`SESSION_IDLE_SECONDS`, 43200), whichever comes first; the idle clock is written at most every five minutes. Both are between 300 seconds and 30 days, and idle cannot exceed absolute. Only token hashes are stored. Set `OPERATOR_TOKEN` (at least 32 characters) to enable `/v1/operator/services`. This is compatible NEAR-wallet authentication, not proof that every wallet's UI flow has been integrated. [NEP-413 specification](https://github.com/near/NEPs/blob/master/neps/nep-0413.md).

The browser must use `credentials: 'include'`. Cookies are HttpOnly and SameSite=Strict, and Secure for HTTPS origins. Mutations require the exact configured Origin and bounded JSON bodies; CORS allows credentials only for that origin. Keep web/API deployments same-site or explicitly review cookie strategy. Direct socket IP rate limits do not trust forwarded headers; production reverse-proxy policy needs explicit configuration. Request limits are 120/minute/IP and challenge issuance 5/minute/IP per process. Do not treat these as distributed production rate limiting.

Set `POLICY_TERMS_HASH` and `POLICY_PRIVACY_HASH` to SHA-256 values for the actual published policies before enabling acknowledgement. Its recorded method is `authenticated_session`, not a wallet signature over the legal text and not age verification. Website policy/session integration is still pending. The API runs bounded hourly cleanup of up to 1,000 challenges and 1,000 sessions expired for more than 24 hours. Active sessions, legal acknowledgements and signing decisions are not deleted. Approve broader private-data retention before public deployment.

### Reconciliation, roles and backups

```sh
npm run reconcile
npm run reconcile -- --follow
# pg_dump uses standard PGHOST/PGPORT/PGDATABASE/PGUSER and protected credentials:
npm run backup
TEST_DATABASE_URL=postgresql://dragons:dragons_local_only@127.0.0.1:55432/dragons_market npm run test:backup
```

Reconciliation reads current contract liabilities and verifier holdings at one finalized block. It reports shortfall/surplus, preserves a report and never credits surplus or invokes an administrative action. Council's current floor is received minus paid minus pending claims. A reported deficit needs review/repeated evidence, especially while cross-contract operations are in flight. Actual deployed-interface and funded reconciliation tests remain pending; fixture tests establish the reader/accounting behavior only.

`ops/roles.sql` is a DBA provisioning template for NOLOGIN API/indexer/worker/backup groups. Use separate credentialed users and a migration owner; no credentials are embedded. A rollback-only isolated permission test checks API/indexer boundaries and removes its test roles. These roles are not automatically provisioned or verified as a production deployment. Grant templates must be reviewed after future migrations. The local Compose database uses public development credentials and is bound to loopback.

Reconciliation subtracts what a contract has already sent out but not yet booked (market `in_flight().withdrawals`, rounds `owed_breakdown().pending_withdrawals`, oracle `bond_totals().pending_payouts`) before it compares with what the verifier holds, so a pending withdrawal is not a shortfall. The report carries `inFlight` per contract.

`GET /v1/operator/services` raises `indexer_lagging` when the follower is more than 1,000 blocks behind the source head and `reconciliation_stale` when no solvency report is newer than 15 minutes.

`GET /v1/events` rows carry `settlement` (`{kind, phase: request|terminal}`) for market and rounds withdrawals, oracle bond payouts and Council claims, the pairs whose events are final, and `GET /v1/settlements/pending` lists requests with no later terminal event for the same key. A request event is never settlement; other flows are not classified until their events are final.

`npm run verify:chain` (a `verify-chain` Compose service, every 6 hours) checks the stored history against itself: each block names the previous stored block as its parent, the checkpoint is the last block, and the events kept equal the events the blocks declare. Results go to `chain_integrity_reports`; `/v1/operator/services` raises `chain_integrity_failed` or `chain_integrity_stale`. Entity-level gap repair waits for the financial read model.

Compose gives each service its own database login (`dm_api_login`, `dm_indexer_login`, `dm_worker_login`) with only the rights in `ops/roles.sql`. A `roles` service applies the file after migrations and sets the passwords from `API_DB_PASSWORD`, `INDEXER_DB_PASSWORD` and `WORKER_DB_PASSWORD`; running it again rotates them. Migrations and deployment registration still use the database owner.

Behind a reverse proxy set `TRUSTED_PROXY_HOPS` to the number of proxies and `TRUSTED_PROXY_ADDRESSES` to the addresses (or CIDR ranges) they connect from. `X-Forwarded-For` is read only from those addresses, and only the entry the nearest proxy appended. Without both, every client is limited by its socket address, which behind a proxy means one shared limit. IPv6 clients are limited per /64.

`npm run backup` needs `PGHOST`, `PGPORT`, `PGDATABASE` and `PGUSER` set explicitly (it refuses to guess a local default server) and keeps the newest `BACKUP_KEEP` archives (default 14).

The backup command writes a custom-format pg_dump archive with a SHA-256 file under ignored `.local/backups` and checks that pg_restore can list it. Never copy the live PostgreSQL data directory. `test:backup` dumps/restores an isolated full backend schema, verifies migration checksums/deployment identity, indexed events/checkpoint, unknown operation state and exact amounts. Production restore drills with the actual deployment and feed files, off-host backup storage, retention, alert routing and operational ownership remain deployment work. The website/contracts are not changed by these backend commands.

## Host development and checks

Use Node 24.21.0 or a newer 24.x release and npm; the NEAR Intents Agent API SDK needs Node 24. Dependencies are locked in `package-lock.json`: TypeScript, the `pg` PostgreSQL driver, the official `@near-intents-agent-api/sdk`, and type declarations. HTTP and tests use Node's standard library.

```sh
npm ci
npm run check
npm test
```

For an API running on the host:

```sh
cp .env.example .env
docker compose up -d postgres --wait
npm run build
npm run migrate
npm start
```

If the containerized API is already running, stop it first or select another host port. `npm run dev` builds once and watches the generated JavaScript for restarts; after TypeScript edits, run `npm run build` again, or run `npx tsc --watch` in another terminal.

Database integration tests require an explicit URL. They create a randomly named schema and remove only that schema. Use a local development database whose user can create schemas:

```sh
TEST_DATABASE_URL=postgresql://dragons:dragons_local_only@127.0.0.1:55432/dragons_market npm run test:database
```

Tests cover migration replay/checksums, event deduplication, integer precision, rollback of event/checkpoint writes, deployment mismatch and persistence across reconnection. Service/container restart persistence should also be checked during deployment validation.

## Database and migrations

The first migration creates `deployments`, `raw_events` and `indexer_checkpoints`. The second adds `indexed_blocks` and `indexer_status`; the third allows the separate `local_capture` source mode. Applied migrations are never rewritten. The migration runner records SHA-256 checksums, takes a transaction-scoped advisory lock and commits pending migrations together. Changed or missing applied migrations are refused. Add a new SQL migration to change the schema; do not edit a migration that has been applied.

Raw event uniqueness is `(network, receipt_id, log_index, data_index)`. Deployment/network foreign keys prevent cross-network associations. Numeric columns retain unsigned 64-bit values exactly. The engine writes events/checkpoints atomically and filters failed receipts. A future live source must verify finality and complete execution coverage; stored fixtures alone do not establish chain truth.

The Compose database uses one local development role. A production deployment still needs separate migration/runtime roles, secrets, TLS, backup/restore, monitoring and resource limits. This phase does not deploy a production service or implement a money ledger.

Implementation references: [node-postgres transactions](https://node-postgres.com/features/transactions), [official PostgreSQL container](https://hub.docker.com/_/postgres), [Compose startup dependencies](https://docs.docker.com/compose/how-tos/startup-order/).
