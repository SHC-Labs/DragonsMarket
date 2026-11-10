CREATE TABLE keeper_status (
 deployment_id text PRIMARY KEY REFERENCES deployments(id),
 mode text NOT NULL CHECK(mode IN ('prepare','check','sign')),
 state text NOT NULL CHECK(state IN ('running','ready','catching_up','failed')),
 height numeric(20,0), started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz, last_success_at timestamptz
);
