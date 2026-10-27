# Dragons Market: finalized event indexer

| Field | Value |
| --- | --- |
| Date | 2026-10-23 |
| Status | Design only. Owner and hosting are unassigned; implementation waits for that decision. |
| Scope | Read model and keeper scheduling feed for our configured market, oracle and Council accounts. No signing or settlement authority. |

## Ingestion and replay

Read every finalized block from an explicit deployment start block, using a source that exposes receipt execution outcomes. Filter outcomes by the exact receiver account and expected event standard. A log from a failed receipt is never evidence. Follow actual predecessor hashes, because NEAR can skip numeric heights. Stop on an unexplained gap or changed finalized hash; fetch and reconcile the missing block sequence before advancing.

In one database transaction per block, insert successful events, update materialized records and scheduling jobs, and advance `{height, hash}`. Use `(chain, receipt_id, log_index, data_index)` as the event uniqueness key. Entity keys always include the market account and market ID; payout keys include their operation IDs. Replaying a block changes nothing. Keep raw successful event data and the published market text/rule hash before contracts prune it.

## Read model and reconciliation

Serve bounded pages for markets, filters, price history, account positions and disputes. Chain contract views remain authoritative for balances and actions. Track metadata, price-after-trade events, case UID/round, draw windows, application results, jury releases and unresolved fee legs. Never infer success from a send/request event: withdrawals, sweep legs, bond payouts and quarterly claims remain pending until their confirmed, failed or reconciled terminal event. A Council revenue receipt alone proves acceptance, not completion of every market callback.

A periodic reconciliation job compares scheduled/open entities against finalized `get_market`, `get_case`, `juries`, sweep and payout views in bounded pages. Backfill discovered gaps through the same replay-safe transaction path. Track the oldest pending record and provider errors; repair from chain evidence instead of silently dropping a job. Retain receipt/claim/sweep evidence beyond pruning.

## Keeper feed contract

Export append-only JSONL from committed database blocks in contiguous predecessor order, including empty blocks. Each line has this shape; `receipts` includes only selected receiver outcomes, with their real statuses and logs:

```json
{
  "finalized": true,
  "header": {"height": "123", "hash": "BLOCK_HASH", "prev_hash": "PREVIOUS_BLOCK_HASH", "timestamp_nanosec": "1700000000000000000"},
  "receipts": [{"receipt_id": "RECEIPT_ID", "receiver_id": "market.example.testnet", "status": {"SuccessValue": ""}, "logs": []}]
}
```

`finalized: true` is an assertion made by the trusted producer, not a finality proof verified by the consumer. The keeper scopes the feed to its configured contracts, deduplicates events, saves jobs and cursor atomically, and rereads finalized contract state before dispatch. Keep the feed append-only and access restricted. Rotation requires an explicit cursor/offset handoff; truncation is an error. Large blocks need producer sizing and consumer-limit review. Unmapped Council case events are repaired through oracle events and bounded reconciliation.

## Ownership and acceptance

The named operator must own provider credentials, database backups, replay/backfill, feed publication, monitoring and recovery. Monitor final-block lag, queue age, deadline slack, RPC errors and unresolved payout age. Acceptance requires failed-receipt filtering, duplicate replay, crashes before/after block commit, a missing-block repair, callback failures, and a keeper restart with unfinished work. Load-test before adding any second market instance because the Intents verifier remains shared. No indexer service has been built or assigned by this document.
