import type pg from 'pg';
import type { Config } from './config.js';
import { ingestionStatus } from './ingestion/store.js';
// The reconcile worker runs every minute and the follower is normally within a few blocks of the head.
const MAX_LAG_BLOCKS = 1000n;
const MAX_RECONCILIATION_AGE_MS = 15 * 60 * 1000;
const MAX_INTEGRITY_AGE_MS = 13 * 60 * 60 * 1000;
export async function backendStatus(pool: pg.Pool, config: Config) {
  const indexing = await ingestionStatus(pool, config);
  const jobs = config.deployment
    ? (await pool.query('SELECT state,count(*)::text AS count FROM backend_jobs WHERE deployment_id=$1 GROUP BY state', [config.deployment.id])).rows
    : [];
  const operations = config.deployment
    ? (await pool.query('SELECT state,count(*)::text AS count FROM user_operations WHERE deployment_id=$1 GROUP BY state', [config.deployment.id])).rows
    : [];
  const integrity = config.deployment
    ? ((await pool.query('SELECT ok,checked_at FROM chain_integrity_reports WHERE deployment_id=$1 ORDER BY checked_at DESC LIMIT 1', [config.deployment.id]))
        .rows[0] ?? null)
    : null;
  const reconciliation = config.deployment
    ? ((
        await pool.query('SELECT solvent,checked_at,block_hash FROM reconciliation_reports WHERE deployment_id=$1 ORDER BY checked_at DESC LIMIT 1', [
          config.deployment.id,
        ])
      ).rows[0] ?? null)
    : null;
  return {
    reconciliation,
    chainIntegrity: integrity,
    deploymentConfigured: config.deployment !== null,
    indexing,
    jobs,
    operations,
    execution: { trading: false, funding: false, priceSigning: false, reason: 'contracts_not_finalized_or_deployed' },
    alerts: [
      ...(integrity && !integrity.ok ? ['chain_integrity_failed'] : []),
      ...(config.deployment && (!integrity || Date.now() - new Date(integrity.checked_at).getTime() > MAX_INTEGRITY_AGE_MS) ? ['chain_integrity_stale'] : []),
      ...(reconciliation && !reconciliation.solvent ? ['liability_shortfall_needs_review'] : []),
      ...(config.deployment && (!reconciliation || Date.now() - new Date(reconciliation.checked_at).getTime() > MAX_RECONCILIATION_AGE_MS)
        ? ['reconciliation_stale']
        : []),
      ...(indexing.lagBlocks !== null && indexing.lagBlocks !== undefined && BigInt(indexing.lagBlocks) > MAX_LAG_BLOCKS ? ['indexer_lagging'] : []),
      ...(config.deployment && !indexing.live ? ['indexer_not_live'] : []),
      ...(jobs.some(r => r.state === 'reconcile' || r.state === 'dead') ? ['jobs_need_attention'] : []),
      ...(operations.some(r => r.state === 'unknown' || r.state === 'reconcile') ? ['operations_need_reconciliation'] : []),
    ],
  };
}
