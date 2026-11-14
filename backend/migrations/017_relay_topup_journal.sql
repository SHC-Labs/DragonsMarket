CREATE TABLE relay_topup_journal (
 relayer text PRIMARY KEY,
 verifier text NOT NULL,
 pending jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE relay_topup_deposits (
 relayer text NOT NULL REFERENCES relay_topup_journal(relayer),
 amount numeric(78,0) NOT NULL CHECK(amount > 0),
 sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relay_topup_deposits_recent ON relay_topup_deposits(relayer, sent_at);
