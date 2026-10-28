-- Public receipt evidence, including failures without events. No transaction mapping is inferred.
CREATE TABLE indexed_receipts (
    deployment_id text NOT NULL,
    receipt_id text NOT NULL,
    block_height numeric(20,0) NOT NULL,
    receiver_id text NOT NULL,
    outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object'),
    PRIMARY KEY (deployment_id, receipt_id),
    FOREIGN KEY (deployment_id, block_height) REFERENCES indexed_blocks(deployment_id, block_height)
);
CREATE INDEX indexed_receipts_page ON indexed_receipts(deployment_id, block_height, receipt_id COLLATE "C");
CREATE INDEX raw_events_read_page ON raw_events(deployment_id, block_height, receipt_id COLLATE "C", log_index, data_index);

-- Upgrade existing journals in the same migration transaction. Conflicts fail visibly.
INSERT INTO indexed_receipts (deployment_id, receipt_id, block_height, receiver_id, outcome)
SELECT b.deployment_id, r->>'receipt_id', b.block_height, r->>'receiver_id', r->'status'
FROM indexed_blocks b CROSS JOIN LATERAL jsonb_array_elements(b.keeper_payload->'receipts') r;
