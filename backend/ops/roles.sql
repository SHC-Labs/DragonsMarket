-- DBA provisioning template. NOLOGIN group roles; create separate credentialed users outside this file.
-- Run after migrations in the intended database. Do not use the migration owner for the public API.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_api') THEN CREATE ROLE dm_api NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_indexer') THEN CREATE ROLE dm_indexer NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_worker') THEN CREATE ROLE dm_worker NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_backup') THEN CREATE ROLE dm_backup NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO dm_api,dm_indexer,dm_worker,dm_backup;
GRANT SELECT ON schema_migrations,deployments,indexer_checkpoints,indexed_blocks,indexed_receipts,raw_events,indexer_status,source_heads TO dm_api,dm_indexer,dm_worker;
GRANT INSERT,UPDATE ON indexed_blocks,indexed_receipts,raw_events,indexer_checkpoints,indexer_status,source_heads TO dm_indexer;
-- Registration remains an explicit migration-owner/administrator action.
GRANT SELECT,INSERT,UPDATE,DELETE ON wallet_challenges,wallet_sessions,wallet_watchlist,policy_acknowledgements TO dm_api;
GRANT SELECT ON user_operations,backend_jobs,reconciliation_reports TO dm_api;
GRANT SELECT,INSERT,UPDATE ON backend_jobs,user_operations,price_evidence,signing_decisions,feed_exports,reconciliation_reports TO dm_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dm_backup;
