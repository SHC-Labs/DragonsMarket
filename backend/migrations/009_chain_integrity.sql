-- Results of the indexed-history integrity check (see src/verify-chain.ts).
CREATE TABLE chain_integrity_reports (
 id bigserial PRIMARY KEY, deployment_id text NOT NULL REFERENCES deployments(id),
 checked_at timestamptz NOT NULL DEFAULT now(), ok boolean NOT NULL, report jsonb NOT NULL
);
CREATE INDEX chain_integrity_reports_latest ON chain_integrity_reports (deployment_id, checked_at DESC);
