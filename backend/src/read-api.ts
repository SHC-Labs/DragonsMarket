import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Config } from './config.js';
import { ingestionStatus } from './ingestion/store.js';
import { verifyDatabase } from './database.js';
import { isAccount as account, isHash as hash, isUint as uint } from './validate.js';
import { pendingSettlements, settlementOf, SETTLEMENT_NOTE } from './settlement.js';

export class ReadError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export type ReadHandler = (url: URL) => Promise<unknown>;
const routes = new Set(['/v1/deployments', '/v1/blocks', '/v1/events', '/v1/receipts', '/v1/health/services', '/v1/settlements/pending']);
export function isReadRoute(path: string) { return routes.has(path) || path.startsWith('/v1/receipts/') || /^\/v1\/transactions\/[^/]+\/receipts$/.test(path); }
type Anchor = { height: string; hash: string; timestampNs: string };
type Cursor = { v: 1; scope: string; anchor: Anchor; key: (string | number)[] };
function invalid(): never { throw new ReadError(400, 'invalid_query'); }

/** Public chain evidence only. Each request and each cursor walk has a fixed upper block. */
export function createReadApi(pool: pg.Pool, config: Config): ReadHandler {
  return async url => {
    if (!isReadRoute(url.pathname) || url.pathname === '/v1/health/services') throw new ReadError(404, 'not_found');
    const transactionHash = /^\/v1\/transactions\/([^/]+)\/receipts$/.exec(url.pathname)?.[1];
    if (transactionHash && !hash(transactionHash)) invalid();
    const detail = url.pathname.startsWith('/v1/receipts/');
    const kind = detail || transactionHash ? '/v1/receipts' : url.pathname;
    const allowed = new Set(kind === '/v1/events'
      ? ['limit', 'cursor', 'receiver', 'event', 'standard', 'receiptId', 'fromBlock', 'toBlock']
      : kind === '/v1/deployments' || detail ? [] : kind === '/v1/settlements/pending' ? ['limit'] : ['limit', 'cursor', 'receiver', 'fromBlock', 'toBlock']);
    if (kind === '/v1/blocks') allowed.delete('receiver');
    for (const name of url.searchParams.keys()) {
      if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) invalid();
    }
    const q = Object.fromEntries(url.searchParams);
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (q.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(q.limit))) invalid();
    for (const key of ['fromBlock', 'toBlock'] as const) if (q[key] !== undefined && !uint(q[key])) invalid();
    if (q.fromBlock && q.toBlock && BigInt(q.fromBlock) > BigInt(q.toBlock)) invalid();
    if (q.receiver !== undefined && !account(q.receiver)) invalid();
    if (q.receiptId !== undefined && !hash(q.receiptId)) invalid();
    if (q.event !== undefined && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(q.event)) invalid();
    if (q.standard !== undefined && !['market', 'rounds', 'oracle', 'council'].includes(q.standard)) invalid();
    const receiptId = detail ? url.pathname.slice('/v1/receipts/'.length) : null;
    if (receiptId !== null && !hash(receiptId)) invalid();
    const filters = Object.entries(q).filter(([name]) => name !== 'cursor' && name !== 'limit').sort(([a], [b]) => a.localeCompare(b));
    const scope = createHash('sha256').update(JSON.stringify([config.network, config.deployment?.id, kind, transactionHash ?? null, filters])).digest('hex');
    let cursor: Cursor | undefined;
    if (q.cursor !== undefined) {
      try {
        if (q.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(q.cursor)) invalid();
        const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
        const keyLength = kind === '/v1/events' ? 4 : kind === '/v1/receipts' ? 2 : 1;
        if (c.v !== 1 || c.scope !== scope || !c.anchor || !uint(c.anchor.height) || !hash(c.anchor.hash) || !uint(c.anchor.timestampNs) || !Array.isArray(c.key) || c.key.length !== keyLength || typeof c.key[0] !== 'string' || !uint(c.key[0]) || BigInt(c.key[0]) > BigInt(c.anchor.height)) invalid();
        if (keyLength > 1 && !hash(c.key[1])) invalid();
        if (keyLength === 4 && c.key.slice(2).some((n: unknown) => !Number.isInteger(n) || Number(n) < 0 || Number(n) > 2147483647)) invalid();
        cursor = c;
      } catch { invalid(); }
    }
    await verifyDatabase(pool, config);
    if (!config.deployment && kind !== '/v1/deployments') throw new ReadError(503, 'deployment_not_configured');
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const id = config.deployment?.id;
      const { rows: deploymentRows } = await client.query(`SELECT id, network, start_block::text, contracts, collateral_token_id, collateral_decimals FROM deployments WHERE id=$1 AND network=$2`, [id ?? null, config.network]);
      if (id && !deploymentRows.length) throw new ReadError(503, 'deployment_not_registered');
      const { rows: stateRows } = await client.query(`SELECT s.source_id, s.source_mode, s.state, s.updated_at, s.last_error_code,
        c.block_height::text, c.block_hash, c.block_timestamp_ns::text, c.updated_at AS checkpoint_updated_at
        FROM deployments d LEFT JOIN indexer_status s ON s.deployment_id=d.id LEFT JOIN indexer_checkpoints c ON c.deployment_id=d.id WHERE d.id=$1`, [id ?? null]);
      const state = stateRows[0];
      const latest: Anchor | null = state?.block_height ? { height: state.block_height, hash: state.block_hash, timestampNs: state.block_timestamp_ns } : null;
      const anchor = cursor?.anchor ?? latest;
      if (cursor) {
        const { rows } = await client.query('SELECT block_hash, block_timestamp_ns::text FROM indexed_blocks WHERE deployment_id=$1 AND block_height=$2', [id, cursor.anchor.height]);
        if (!rows.length || rows[0].block_hash !== cursor.anchor.hash || rows[0].block_timestamp_ns !== cursor.anchor.timestampNs || !latest || BigInt(cursor.anchor.height) > BigInt(latest.height)) throw new ReadError(400, 'invalid_cursor');
      }
      const metadata = {
        network: config.network, deploymentId: id ?? null, asOf: anchor,
        indexing: { live: false, source: state?.source_id ? { id: state.source_id, mode: state.source_mode } : null,
          state: state?.state ?? (id ? 'not_started' : 'unconfigured'), latestCheckpoint: latest,
          checkpointCommittedAt: state?.checkpoint_updated_at ?? null, reportedAt: state?.updated_at ?? null,
          lastErrorCode: state?.last_error_code ?? null, lagBlocks: null },
      };
      const indexed = await ingestionStatus(client, config);
      Object.assign(metadata.indexing, { live: indexed.live, lagBlocks: indexed.lagBlocks, sourceHead: 'sourceHead' in indexed ? indexed.sourceHead : null });
      if (kind === '/v1/deployments') {
        await client.query('COMMIT');
        return { ...metadata, data: deploymentRows, nextCursor: null };
      }
      if (kind === '/v1/settlements/pending') {
        const pending = anchor ? await pendingSettlements(client, id!, anchor.height, limit) : { data: [], truncated: false };
        await client.query('COMMIT');
        return { ...metadata, note: SETTLEMENT_NOTE, ...pending };
      }
      const params: unknown[] = [id, anchor?.height ?? '0'];
      const where = ['deployment_id=$1', 'block_height <= $2'];
      const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
      if (q.fromBlock) where.push(`block_height >= ${bind(q.fromBlock)}`);
      if (q.toBlock) where.push(`block_height <= ${bind(q.toBlock)}`);
      if (q.receiver) where.push(`receiver_id=${bind(q.receiver)}`);
      if (q.event) where.push(`event=${bind(q.event)}`);
      if (q.standard) where.push(`standard=${bind(q.standard)}`);
      if (q.receiptId) where.push(`receipt_id=${bind(q.receiptId)}`);
      if (transactionHash) where.push(`transaction_hash=${bind(transactionHash)}`);
      if (receiptId) where.push(`receipt_id=${bind(receiptId)}`);
      const table = kind === '/v1/blocks' ? 'indexed_blocks' : kind === '/v1/events' ? 'raw_events' : 'indexed_receipts';
      const keys = kind === '/v1/blocks' ? ['t.block_height'] : kind === '/v1/events' ? ['t.block_height', 't.receipt_id COLLATE "C"', 't.log_index', 't.data_index'] : ['t.block_height', 't.receipt_id COLLATE "C"'];
      if (cursor) where.push(`(${keys.join(',')}) > (${cursor.key.map(bind).join(',')})`);
      const columns = kind === '/v1/blocks'
        ? 'block_height::text, block_hash, prev_hash, block_timestamp_ns::text, event_count, committed_at'
        : kind === '/v1/events'
          ? 'block_height::text, block_hash, block_timestamp_ns::text, receiver_id, receipt_id, log_index, data_index, standard, version, event, payload'
          : 'block_height::text, receipt_id, receiver_id, outcome, transaction_hash, child_receipt_ids';
      const { rows } = await client.query(`SELECT ${columns} FROM ${table} AS t WHERE ${where.join(' AND ')} ORDER BY ${keys.join(',')} LIMIT ${bind(detail ? 1 : limit + 1)}`, params);
      // An empty checkpoint means no committed evidence, including at height zero.
      const data = anchor ? rows.slice(0, detail ? 1 : limit) : [];
      if (detail && !data.length) throw new ReadError(404, 'receipt_not_found');
      const last = data.at(-1);
      let nextCursor: string | null = null;
      if (!detail && rows.length > limit && last && anchor) {
        const key = kind === '/v1/blocks' ? [last.block_height] : kind === '/v1/events'
          ? [last.block_height, last.receipt_id, last.log_index, last.data_index] : [last.block_height, last.receipt_id];
        nextCursor = Buffer.from(JSON.stringify({ v: 1, scope, anchor, key })).toString('base64url');
      }
      await client.query('COMMIT');
      return { ...metadata, ...(transactionHash ? { transactionHash, coverage: 'configured_contract_receipts_only', transactionCompletion: 'not_inferred' } : {}), data: detail ? data[0] : kind === '/v1/events' ? data.map(row => ({ ...row, settlement: settlementOf(row.standard, row.event) })) : data, ...(kind === '/v1/events' ? { note: SETTLEMENT_NOTE } : {}), ...(detail ? {} : { nextCursor }) };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
}
