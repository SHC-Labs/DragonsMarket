import type pg from 'pg';

/**
 * A request event only says a contract started something. The money has moved, or come back, when its terminal event lands, so
 * a client must pair them. These are the pairs whose request, terminal events and key fields were read from the contracts;
 * other flows are not classified until their events are final.
 */
const PAIRS = [
  { kind: 'withdrawal', standard: 'market', request: ['withdraw'], terminal: ['withdraw_confirmed', 'withdraw_failed', 'withdrawal_reconciled'], key: ['id'] },
  { kind: 'claim', standard: 'council', request: ['claim_requested'], terminal: ['claim_paid', 'claim_failed', 'claim_reconciled'], key: ['quarter', 'token_id', 'owner'] },
] as const;

export interface Settlement { kind: string; phase: 'request' | 'terminal' }
export const SETTLEMENT_NOTE = 'A request event is not settlement. Pair it with its terminal event, or list unpaired requests at /v1/settlements/pending.';

export function settlementOf(standard: string, event: string): Settlement | null {
  for (const pair of PAIRS) {
    if (pair.standard !== standard) continue;
    if ((pair.request as readonly string[]).includes(event)) return { kind: pair.kind, phase: 'request' };
    if ((pair.terminal as readonly string[]).includes(event)) return { kind: pair.kind, phase: 'terminal' };
  }
  return null;
}

/** Requests with no later terminal event for the same key, up to the snapshot height. Oldest first. */
export async function pendingSettlements(client: Pick<pg.PoolClient, 'query'>, deploymentId: string, height: string, limit: number) {
  const branches = PAIRS.map((pair, i) => {
    const base = i * 3;
    const sameKey = pair.key.map(field => `t.payload->>'${field}' = r.payload->>'${field}'`).join(' AND ');
    return `(SELECT r.block_height, r.receipt_id, r.log_index, r.data_index, r.receiver_id, r.event, r.payload, '${pair.kind}' AS kind
      FROM raw_events r WHERE r.deployment_id = $1 AND r.standard = $${base + 3} AND r.event = ANY($${base + 4}) AND r.block_height <= $2
      AND NOT EXISTS (SELECT 1 FROM raw_events t WHERE t.deployment_id = r.deployment_id AND t.receiver_id = r.receiver_id AND t.standard = r.standard
        AND t.event = ANY($${base + 5}) AND t.block_height >= r.block_height AND t.block_height <= $2 AND ${sameKey}))`;
  });
  const params: unknown[] = [deploymentId, height];
  PAIRS.forEach(pair => params.push(pair.standard, [...pair.request], [...pair.terminal]));
  const { rows } = await client.query(
    `SELECT block_height::text, receipt_id, receiver_id, event, kind, payload FROM (${branches.join(' UNION ALL ')}) p ORDER BY block_height, receipt_id COLLATE "C", log_index, data_index LIMIT $${params.length + 1}`,
    [...params, limit + 1],
  );
  return { data: rows.slice(0, limit), truncated: rows.length > limit };
}
