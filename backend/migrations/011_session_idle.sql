-- Sessions end at their absolute expires_at, or after sitting unused longer than the idle limit, whichever comes first.
ALTER TABLE wallet_sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS wallet_sessions_account ON wallet_sessions (account_id);
