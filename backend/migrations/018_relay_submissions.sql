CREATE TABLE relay_keys (
 scope text PRIMARY KEY,
 nonce numeric(20,0) NOT NULL CHECK (nonce >= 0)
);
CREATE TABLE relay_submissions (
 scope text NOT NULL REFERENCES relay_keys(scope),
 payload_hash text NOT NULL,
 record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (scope,payload_hash)
);
