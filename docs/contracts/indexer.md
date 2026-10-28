# Dragons Market: finalized event indexer

| Field | Value |
| --- | --- |
| Updated | 2026-10-27 |
| Status | App ingestion/read API tested locally. Bounded mainnet NEAR Data capture, isolated persistence and replay verified. Mainnet app follower, transaction links, heartbeat/height difference and keeper exporter are implemented; actual deployment activation, hosting and ownership remain open. |
| Scope | Raw finalized-receipt ingestion for configured market, rounds, oracle and Council accounts. Financial read models remain pending; keeper export and mainnet follower are available but not activated without a deployment. No signing or settlement authority. |

## Implemented engine

Source: [`backend/src/ingestion`](../../backend/src/ingestion/engine.ts). Commands and normalized fixture format are documented in the [backend README](../../backend/README.md#ingestion-engine).

Implemented: immutable deployment registration; bounded sandbox JSONL source; exact integer/header validation; receiver/standard/version filtering; failed-receipt event exclusion with outcome retention; original logs and array data indices; single-worker advisory lock; atomic receipt/raw-event/block-journal/checkpoint/counter writes; matching-block replay; changed-block and ancestry-gap refusal; persisted sanitized errors; CLI and `GET /v1/indexer/status`.

Fixture replay and bounded local transaction capture are sandbox-only. The source interface is replaceable, but no public-network live connector is enabled. The finalized flag is trusted input, not a finality proof. Status distinguishes fixture/local capture from mainnet live mode. Fixture/local-capture runs retain `live: false` and unknown lag; live mode uses an expiring source-head heartbeat. A last-reported running state can survive an abrupt worker termination, so supervision is still required.

The engine accepts existing contract event envelopes without applying trading or payout projections. This allows ingestion work to continue while the owner confirms the rounds payout model. Verifier transfer indexing requires its own reviewed event mapping and is not included yet.

Implemented since source validation: bounded mainnet following/backfill with retries, app transaction provenance, expiring head/heartbeat metadata, durable JSONL export and a read-only finalized-block liability checker. Still pending: activation on the real deployment, typed financial/product projections, actual scheduling/Intents handlers, final source policy and operational ownership. Committed `indexed_blocks.keeper_payload` entries retain the feed-shaped data, and a file exporter is available once a real deployment is configured.

## Local-chain evidence

`backend/test/local-chain.test.ts` compiles and deploys the unchanged rounds WASM on NEAR Sandbox 2.13.4. Three successful configuration calls and two rejected calls produce real receipt outcomes. The test checks exact stored receipt IDs/payloads, exclusion of rejected execution logs from events, HTTP reads of actual successful events and rejected receipt outcomes, final contract settings, checkpoint progression and replay after reopening the database pool. It cleans up its own chain and database schema.

The bounded `local_capture` source verifies loopback RPC, rejects public chain IDs, requires finalized transaction results and walks block ancestry from a finalized head to the explicit pre-test anchor. It uses only known harness transactions. This proves the actual contract-event boundary, not arbitrary activity discovery, full block receipt coverage, funding, payouts or production operation. The live follower and keeper exporter remain unbuilt.

## Mainnet source verification

The owner selected mainnet for source validation. `backend/test/mainnet-capture.test.ts` reads a bounded finalized NEAR Data range, validates shard IDs and ancestry, and checks its sampled head against a mainnet RPC header. It selects an actual active receiver (or an explicit account) and stores its receipts, transaction hashes, generated receipt links and successful event envelopes in a temporary, verification-only schema. No external contract is assigned a Dragons Market role.

The final verified run covered `221887552`–`221887556`: eight `intents.near` receipts, ten event envelopes and six originating transaction hashes, including one actual failed execution. Its outcome was retained while failed logs were excluded from events. Reconnect and full duplicate replay passed; the schema was removed afterward. Rollback and conflict cases are separately tested with synthetic inputs. Raw amounts and timestamps remain exact. Unknown standards are retained without product interpretation.

This verifies the provider-to-database mapping, not a continuously running service, independent finality verification, a full transaction tree or app deployment ingestion. The app engine now accepts the reviewed mainnet source class; arbitrary live sources remain refused. See the [command, limits and field mapping](../../backend/README.md#bounded-mainnet-source-verification). Migration 005 adds app transaction provenance, source heads and backend service records. Previously captured receipts have unknown transaction links rather than invented values.

## Ingestion and replay

Read every finalized block from an explicit deployment start block, using a source that exposes receipt execution outcomes. Filter outcomes by the exact receiver account and expected event standard. A log from a failed receipt is never evidence. Follow actual predecessor hashes, because NEAR can skip numeric heights. Stop on an unexplained gap or changed finalized hash; fetch and reconcile the missing block sequence before advancing.

In one database transaction per block, insert receipt outcomes, successful events and the block journal, update ingestion counters, and advance `{height, hash}`. Use `(chain, receipt_id, log_index, data_index)` as the event uniqueness key. Entity keys always include the market account and market ID; payout keys include their operation IDs. Replaying a block changes nothing. Keep raw successful event data before contracts prune it. Typed market text/rule projections and scheduling jobs must be added to this same commit boundary when implemented.

## Evidence read API

The evidence read API serves only the configured deployment: block headers, paginated successful events and receipt outcomes (including failures). Receipt rows are committed atomically with the block and checkpoint. Migration 004 backfills prior journals. Requests and cursor walks use fixed indexed checkpoints; source labels remain explicit and live coverage is not claimed. Transaction-hash receipt lookup is implemented for configured contracts only; complete execution-tree tracing and financial projections remain open. See the [backend API contract](../../backend/README.md#api) and [remaining work](../../PENDING.md).

## Read model and reconciliation

Planned: serve bounded pages for markets, filters, price history, account positions and disputes. Chain contract views remain authoritative for balances and actions. Track metadata, price-after-trade events, case UID/round, draw windows, application results, jury releases and unresolved fee legs. Never infer success from a send/request event: withdrawals, sweep legs, bond payouts and quarterly claims remain pending until their confirmed, failed or reconciled terminal event. A Council revenue receipt alone proves acceptance, not completion of every market callback.

Planned: a periodic reconciliation job compares scheduled/open entities against finalized `get_market`, `get_case`, `juries`, sweep and payout views in bounded pages. Backfill discovered gaps through the same replay-safe transaction path. Track the oldest pending record and provider errors; repair from chain evidence instead of silently dropping a job. Retain receipt/claim/sweep evidence beyond pruning.

## Keeper feed contract

Planned: export append-only JSONL from committed database blocks in contiguous predecessor order, including empty blocks. Each line has this shape; `receipts` includes only selected receiver outcomes, with their real statuses and logs:

```json
{
  "finalized": true,
  "header": {"height": "123", "hash": "BLOCK_HASH", "prev_hash": "PREVIOUS_BLOCK_HASH", "timestamp_nanosec": "1700000000000000000"},
  "receipts": [{"receipt_id": "RECEIPT_ID", "receiver_id": "market.example.testnet", "status": {"SuccessValue": ""}, "logs": []}]
}
```

`finalized: true` is an assertion made by the trusted producer, not a finality proof verified by the consumer. The keeper scopes the feed to its configured contracts, deduplicates events, saves jobs and cursor atomically, and rereads finalized contract state before dispatch. Keep the feed append-only and access restricted. Rotation requires an explicit cursor/offset handoff; truncation is an error. Large blocks need producer sizing and consumer-limit review. Unmapped Council case events are repaired through oracle events and bounded reconciliation.

## Ownership and acceptance

The named operator must own provider credentials, database backups, replay/backfill, feed publication, monitoring and recovery. Monitor final-block lag, queue age, deadline slack, RPC errors and unresolved payout age. Acceptance requires failed-receipt filtering, duplicate replay, crashes before/after block commit, a missing-block repair, callback failures, and a keeper restart with unfinished work. Load-test before adding any second market instance because the Intents verifier remains shared. The engine has fixture, PostgreSQL recovery and bounded real-sandbox tests; complete provider/live operation and keeper-export acceptance remain unverified. Ownership and hosting are not assigned by this document.
