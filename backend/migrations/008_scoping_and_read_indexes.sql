-- Two deployments on one network can see the same receipt (a shared verifier, or a new deployment id over the same
-- contracts), so an event is identified inside its deployment.
ALTER TABLE raw_events DROP CONSTRAINT IF EXISTS raw_events_pkey;
ALTER TABLE raw_events ADD PRIMARY KEY (deployment_id, network, receipt_id, log_index, data_index);
DROP INDEX IF EXISTS raw_events_deployment_order;

-- Filters the read API accepts without a receiver had no index and scanned a deployment's whole history.
CREATE INDEX IF NOT EXISTS raw_events_by_event ON raw_events (deployment_id, event, block_height, receipt_id COLLATE "C", log_index, data_index);
CREATE INDEX IF NOT EXISTS raw_events_by_standard ON raw_events (deployment_id, standard, block_height, receipt_id COLLATE "C", log_index, data_index);
CREATE INDEX IF NOT EXISTS indexed_receipts_by_receiver ON indexed_receipts (deployment_id, receiver_id, block_height, receipt_id COLLATE "C");

ALTER TABLE indexer_checkpoints DROP CONSTRAINT IF EXISTS indexer_checkpoints_block_fk;
ALTER TABLE indexer_checkpoints ADD CONSTRAINT indexer_checkpoints_block_fk FOREIGN KEY (deployment_id, block_height) REFERENCES indexed_blocks (deployment_id, block_height);

ALTER TABLE wallet_challenges DROP CONSTRAINT IF EXISTS wallet_challenges_network_check;
ALTER TABLE wallet_challenges ADD CONSTRAINT wallet_challenges_network_check CHECK (network IN ('sandbox', 'testnet', 'mainnet'));
ALTER TABLE wallet_sessions DROP CONSTRAINT IF EXISTS wallet_sessions_network_check;
ALTER TABLE wallet_sessions ADD CONSTRAINT wallet_sessions_network_check CHECK (network IN ('sandbox', 'testnet', 'mainnet'));
ALTER TABLE policy_acknowledgements DROP CONSTRAINT IF EXISTS policy_acknowledgements_network_check;
ALTER TABLE policy_acknowledgements ADD CONSTRAINT policy_acknowledgements_network_check CHECK (network IN ('sandbox', 'testnet', 'mainnet'));
ALTER TABLE backend_jobs DROP CONSTRAINT IF EXISTS backend_jobs_kind_check;
ALTER TABLE backend_jobs ADD CONSTRAINT backend_jobs_kind_check CHECK (length(kind) BETWEEN 1 AND 64);
ALTER TABLE user_operations DROP CONSTRAINT IF EXISTS user_operations_kind_check;
ALTER TABLE user_operations ADD CONSTRAINT user_operations_kind_check CHECK (length(kind) BETWEEN 1 AND 64);
CREATE INDEX IF NOT EXISTS wallet_sessions_account ON wallet_sessions (account_id);
