-- Values from the chain are exact integers. NUMERIC avoids truncating u64/u128 values.
CREATE TABLE deployments (
    id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    network text NOT NULL CHECK (network IN ('sandbox', 'testnet', 'mainnet')),
    start_block numeric(20,0) NOT NULL CHECK (start_block BETWEEN 0 AND 18446744073709551615),
    contracts jsonb NOT NULL CHECK (jsonb_typeof(contracts) = 'object' AND contracts <> '{}'::jsonb),
    collateral_token_id text NOT NULL CHECK (length(collateral_token_id) > 0),
    collateral_decimals smallint NOT NULL CHECK (collateral_decimals BETWEEN 0 AND 38),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, network)
);

CREATE TABLE indexer_checkpoints (
    deployment_id text PRIMARY KEY REFERENCES deployments(id),
    block_height numeric(20,0) NOT NULL CHECK (block_height BETWEEN 0 AND 18446744073709551615),
    block_hash text NOT NULL CHECK (length(block_hash) > 0),
    block_timestamp_ns numeric(20,0) NOT NULL CHECK (block_timestamp_ns BETWEEN 0 AND 18446744073709551615),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE raw_events (
    network text NOT NULL CHECK (network IN ('sandbox', 'testnet', 'mainnet')),
    receipt_id text NOT NULL CHECK (length(receipt_id) > 0),
    log_index integer NOT NULL CHECK (log_index >= 0),
    data_index integer NOT NULL CHECK (data_index >= 0),
    deployment_id text NOT NULL,
    receiver_id text NOT NULL CHECK (length(receiver_id) BETWEEN 2 AND 64),
    block_height numeric(20,0) NOT NULL CHECK (block_height BETWEEN 0 AND 18446744073709551615),
    block_hash text NOT NULL CHECK (length(block_hash) > 0),
    block_timestamp_ns numeric(20,0) NOT NULL CHECK (block_timestamp_ns BETWEEN 0 AND 18446744073709551615),
    standard text NOT NULL CHECK (length(standard) > 0),
    version text NOT NULL CHECK (length(version) > 0),
    event text NOT NULL CHECK (length(event) > 0),
    raw_log text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (network, receipt_id, log_index, data_index),
    FOREIGN KEY (deployment_id, network) REFERENCES deployments(id, network)
);
CREATE INDEX raw_events_deployment_order ON raw_events (deployment_id, block_height, receipt_id, log_index, data_index);
CREATE INDEX raw_events_receiver_event ON raw_events (deployment_id, receiver_id, event, block_height);
