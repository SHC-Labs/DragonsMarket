-- DBA provisioning template. NOLOGIN group roles; create separate credentialed users outside this file.
-- Run after migrations in the intended database. Do not use the migration owner for the public API.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_api') THEN CREATE ROLE dm_api NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_indexer') THEN CREATE ROLE dm_indexer NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_worker') THEN CREATE ROLE dm_worker NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_publisher') THEN CREATE ROLE dm_publisher NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_backup') THEN CREATE ROLE dm_backup NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_agent') THEN CREATE ROLE dm_agent NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dm_keeper') THEN CREATE ROLE dm_keeper NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO dm_api,dm_indexer,dm_worker,dm_publisher,dm_backup,dm_agent;
GRANT USAGE ON SCHEMA public TO dm_keeper;
GRANT SELECT ON schema_migrations,deployments,indexed_blocks,indexer_checkpoints TO dm_keeper;
GRANT SELECT ON reconciliation_reports,chain_integrity_reports TO dm_keeper;
GRANT SELECT,INSERT,UPDATE ON keeper_status TO dm_keeper;
GRANT SELECT ON keeper_status TO dm_api,dm_worker;
GRANT SELECT,INSERT,UPDATE ON feed_exports TO dm_keeper;
GRANT SELECT ON schema_migrations,deployments,indexer_checkpoints,indexed_blocks,indexed_receipts,raw_events,indexer_status,source_heads TO dm_api,dm_indexer,dm_worker;
GRANT INSERT,UPDATE ON indexed_blocks,indexed_receipts,raw_events,indexer_checkpoints,indexer_status,source_heads TO dm_indexer;
-- Registration remains an explicit migration-owner/administrator action.
GRANT SELECT,INSERT,UPDATE,DELETE ON wallet_challenges,wallet_sessions,wallet_watchlist TO dm_api;
-- Legal acknowledgements are retained, so the API can add and read them but never change or remove one.
GRANT SELECT,INSERT ON policy_acknowledgements TO dm_api;
GRANT SELECT ON backend_jobs,reconciliation_reports,chain_integrity_reports,signing_decisions TO dm_api;
REVOKE ALL ON user_operations,agent_accounts,agent_grants,agent_intents,agent_access_tokens FROM dm_api,dm_worker;
GRANT SELECT ON user_operations TO dm_api,dm_worker;
GRANT SELECT ON schema_migrations,deployments TO dm_agent;
GRANT SELECT,INSERT,UPDATE ON user_operations,agent_accounts,agent_grants,agent_intents,agent_access_tokens TO dm_agent;
GRANT SELECT,INSERT,UPDATE ON backend_jobs,price_evidence,feed_exports,reconciliation_reports,chain_integrity_reports TO dm_worker;
GRANT USAGE ON SEQUENCE chain_integrity_reports_id_seq TO dm_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dm_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO dm_backup;
-- Tables added by later migrations (run by the role that runs this file) are readable by the backup role too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dm_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO dm_backup;
-- The price publisher has a login of its own, the only one that can write a signing decision. A signed decision is also
-- write-once in the database itself (migration 010).
GRANT SELECT ON schema_migrations,deployments TO dm_publisher;
GRANT SELECT,INSERT,UPDATE ON signing_decisions TO dm_publisher;
GRANT SELECT,INSERT ON price_evidence TO dm_publisher;
