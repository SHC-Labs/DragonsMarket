import type pg from 'pg';

/** Advisory lock classes. Each is taken together with a hash of the deployment id (or the exporter's destination), so one lock never blocks another deployment. */
export const LOCK = { migrate: 704346941, ingest: 704346942, follow: 704346943, feed: 704346944, wallet: 704346945, agents: 704346946, roles: 704346947 } as const;

export const agentLock = (c: pg.PoolClient, key: string) => c.query(`SELECT pg_advisory_xact_lock(${LOCK.agents},hashtext($1))`, [key]);
