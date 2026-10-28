ALTER TABLE indexed_receipts ADD COLUMN transaction_hash text;
ALTER TABLE indexed_receipts ADD COLUMN child_receipt_ids jsonb CHECK(child_receipt_ids IS NULL OR jsonb_typeof(child_receipt_ids)='array');
CREATE INDEX indexed_receipts_transaction ON indexed_receipts(deployment_id,transaction_hash,block_height,receipt_id COLLATE "C") WHERE transaction_hash IS NOT NULL;
CREATE TABLE source_heads (
 deployment_id text PRIMARY KEY REFERENCES deployments(id), height numeric(20,0) NOT NULL,
 hash text NOT NULL, timestamp_ns numeric(20,0) NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
 heartbeat_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE feed_exports (
 deployment_id text NOT NULL REFERENCES deployments(id), destination_hash text NOT NULL,
 height numeric(20,0), byte_offset bigint NOT NULL DEFAULT 0 CHECK(byte_offset>=0),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(deployment_id,destination_hash)
);
CREATE TABLE backend_jobs (
 id uuid PRIMARY KEY, deployment_id text NOT NULL REFERENCES deployments(id), kind text NOT NULL,
 work_key text NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','done','reconcile','dead')),
 due_at timestamptz NOT NULL, deadline timestamptz, attempts integer NOT NULL DEFAULT 0,
 lease_token uuid, leased_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(deployment_id,kind,work_key)
);
CREATE INDEX backend_jobs_due ON backend_jobs(state,due_at);
CREATE TABLE user_operations (
 id uuid PRIMARY KEY, deployment_id text NOT NULL REFERENCES deployments(id), account_id text NOT NULL,
 kind text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL, request jsonb NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','awaiting_signature','submitted','unknown','confirmed','failed','reconcile')),
 transaction_hash text, evidence jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(deployment_id,account_id,idempotency_key)
);
CREATE TABLE price_evidence (
 id uuid PRIMARY KEY, asset text NOT NULL, source text NOT NULL, quote text NOT NULL,
 boundary_ns numeric(20,0) NOT NULL, source_time_ns numeric(20,0) NOT NULL, retrieved_at timestamptz NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
 price text, raw_response text NOT NULL, response_hash text NOT NULL, accepted boolean NOT NULL,
 reason text, UNIQUE(asset,source,boundary_ns,response_hash)
);
CREATE TABLE signing_decisions (
 deployment_id text NOT NULL REFERENCES deployments(id), publisher_key text NOT NULL, boundary_key text NOT NULL,
 payload text NOT NULL, payload_hash text NOT NULL, signature text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(deployment_id,publisher_key,boundary_key)
);

CREATE TABLE reconciliation_reports (
 deployment_id text NOT NULL REFERENCES deployments(id), block_hash text NOT NULL, report jsonb NOT NULL,
 solvent boolean NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(deployment_id,block_hash)
);
