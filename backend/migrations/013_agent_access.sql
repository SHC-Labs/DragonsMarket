CREATE TABLE agent_access_tokens (
 id uuid PRIMARY KEY, agent_account uuid NOT NULL REFERENCES agent_accounts(id),
 token_hash text UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'), label text NOT NULL,
 max_spend numeric(39,0) NOT NULL CHECK(max_spend>0),
 daily_limit numeric(39,0) NOT NULL CHECK(daily_limit>=max_spend),
 message text NOT NULL, nonce text NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_access_tokens_agent ON agent_access_tokens(agent_account,created_at);
