-- Every processed block, including blocks without relevant events, anchors replay.
CREATE TABLE indexed_blocks (
    deployment_id text NOT NULL REFERENCES deployments(id),
    block_height numeric(20,0) NOT NULL CHECK (block_height BETWEEN 0 AND 18446744073709551615),
    block_hash text NOT NULL CHECK (length(block_hash) > 0),
    prev_hash text NOT NULL CHECK (length(prev_hash) > 0),
    block_timestamp_ns numeric(20,0) NOT NULL CHECK (block_timestamp_ns BETWEEN 0 AND 18446744073709551615),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    event_count integer NOT NULL CHECK (event_count >= 0),
    keeper_payload jsonb NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (deployment_id, block_height),
    UNIQUE (deployment_id, block_hash)
);

CREATE TABLE indexer_status (
    deployment_id text PRIMARY KEY REFERENCES deployments(id),
    source_id text NOT NULL,
    source_mode text NOT NULL CHECK (source_mode IN ('fixture', 'live')),
    state text NOT NULL CHECK (state IN ('running', 'replay_complete', 'error')),
    blocks_committed bigint NOT NULL DEFAULT 0 CHECK (blocks_committed >= 0),
    events_committed bigint NOT NULL DEFAULT 0 CHECK (events_committed >= 0),
    last_error_code text,
    last_error_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);
