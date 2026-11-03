CREATE TABLE agent_accounts (
 id uuid PRIMARY KEY, deployment_id text NOT NULL REFERENCES deployments(id), owner_account_id text NOT NULL,
 name text NOT NULL, agent_id text UNIQUE CHECK(agent_id ~ '^[0-9a-f]{64}$'), near_account_id text,
 state text NOT NULL DEFAULT 'creating' CHECK(state IN ('creating','pending','active','abandoned')),
 frozen boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(state IN ('creating','abandoned') OR agent_id IS NOT NULL),
 CHECK(state<>'active' OR near_account_id IS NOT NULL)
);
CREATE INDEX agent_accounts_owner ON agent_accounts(deployment_id,owner_account_id,created_at);
CREATE TABLE agent_grants (
 id uuid PRIMARY KEY, agent_account uuid NOT NULL REFERENCES agent_accounts(id),
 commitment text NOT NULL UNIQUE CHECK(commitment ~ '^[0-9a-f]{64}$'), sealed_token bytea,
 label text NOT NULL, api_grant_id text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','live','failed','revoked')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(state<>'live' OR api_grant_id IS NOT NULL),
 CHECK((state='revoked')=(sealed_token IS NULL))
);
CREATE INDEX agent_grants_agent ON agent_grants(agent_account,state,expires_at);
CREATE TABLE agent_intents (
 correlation_id text PRIMARY KEY, agent_account uuid NOT NULL REFERENCES agent_accounts(id),
 type text NOT NULL CHECK(type IN ('agent_create','grant_issue','grant_revoke','agent_freeze','agent_unfreeze')),
 agent_grant uuid REFERENCES agent_grants(id),
 intent jsonb NOT NULL, status text NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((type IN ('grant_issue','grant_revoke'))=(agent_grant IS NOT NULL))
);
CREATE INDEX agent_intents_agent ON agent_intents(agent_account,created_at);
ALTER TABLE user_operations ADD COLUMN lease_token uuid, ADD COLUMN leased_until timestamptz;
CREATE UNIQUE INDEX user_operations_transaction ON user_operations(deployment_id,transaction_hash)
 WHERE transaction_hash IS NOT NULL;
