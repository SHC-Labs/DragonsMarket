CREATE TABLE agent_access_tokens (
 id uuid PRIMARY KEY, agent_account uuid NOT NULL REFERENCES agent_accounts(id),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'), label text NOT NULL,
 max_stake numeric(39,0) NOT NULL CHECK(max_stake>0),
 daily_limit numeric(39,0) NOT NULL CHECK(daily_limit>=max_stake),
 expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_access_tokens_agent ON agent_access_tokens(agent_account,created_at);
CREATE TABLE agent_access_stakes (
 token uuid NOT NULL REFERENCES agent_access_tokens(id), idempotency_key text NOT NULL,
 amount numeric(39,0) NOT NULL CHECK(amount>0), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(token,idempotency_key)
);
CREATE INDEX agent_access_stakes_window ON agent_access_stakes(token,created_at);
