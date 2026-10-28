-- A bounded capture of real sandbox receipts is distinct from synthetic fixtures or a live follower.
ALTER TABLE indexer_status DROP CONSTRAINT indexer_status_source_mode_check;
ALTER TABLE indexer_status ADD CONSTRAINT indexer_status_source_mode_check
    CHECK (source_mode IN ('fixture', 'local_capture', 'live'));
