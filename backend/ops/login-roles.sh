#!/bin/sh
# Runs once per `compose up`, after migrations and as the database owner: applies ops/roles.sql, then gives each service a login
# of its own with only its group's rights. Passwords come from the environment; changing one and running this again rotates it.
set -eu
psql -v ON_ERROR_STOP=1 -f /roles.sql
psql -v ON_ERROR_STOP=1 -v api_pw="$API_DB_PASSWORD" -v indexer_pw="$INDEXER_DB_PASSWORD" -v worker_pw="$WORKER_DB_PASSWORD" -v publisher_pw="$PUBLISHER_DB_PASSWORD" -v agent_pw="$AGENT_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE dm_api', 'dm_api_login', :'api_pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dm_api_login') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'dm_api_login', :'api_pw') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE dm_indexer', 'dm_indexer_login', :'indexer_pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dm_indexer_login') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'dm_indexer_login', :'indexer_pw') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE dm_worker', 'dm_worker_login', :'worker_pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dm_worker_login') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'dm_worker_login', :'worker_pw') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE dm_publisher', 'dm_publisher_login', :'publisher_pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dm_publisher_login') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'dm_publisher_login', :'publisher_pw') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE dm_agent', 'dm_agent_login', :'agent_pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dm_agent_login') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'dm_agent_login', :'agent_pw') \gexec
SQL
