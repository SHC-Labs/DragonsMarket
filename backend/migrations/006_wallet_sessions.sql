CREATE TABLE wallet_challenges (
 id uuid PRIMARY KEY, account_id text NOT NULL, network text NOT NULL, origin text NOT NULL,
 nonce text NOT NULL UNIQUE, browser_hash text NOT NULL, message text NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX wallet_challenges_expiry ON wallet_challenges(expires_at);
CREATE TABLE wallet_sessions (
 token_hash text PRIMARY KEY, account_id text NOT NULL, network text NOT NULL, public_key text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallet_watchlist (
 deployment_id text NOT NULL REFERENCES deployments(id), account_id text NOT NULL,
 item text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(deployment_id,account_id,item)
);
CREATE TABLE policy_acknowledgements (
 account_id text NOT NULL, network text NOT NULL, terms_hash text NOT NULL, privacy_hash text NOT NULL,
 method text NOT NULL CHECK(method='authenticated_session'), acknowledged_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,network,terms_hash,privacy_hash)
);
