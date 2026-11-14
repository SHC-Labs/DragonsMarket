ALTER TABLE agent_accounts ADD COLUMN policy_observation bigint NOT NULL DEFAULT 0
 CHECK(policy_observation >= 0);
